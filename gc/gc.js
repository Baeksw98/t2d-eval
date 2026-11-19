/* 가이드라인 부합도 검증 (Guideline Concordance · Physician Validation) — app
 * 분과전문의가 AI 감사가 표시한(△/✗) AI 채점 판정만 확인합니다. 계약: docs/GC_CONTRACT.md
 * 패턴(보관함·재전송·자동 저장·탭 보호·시간 측정)은 루트 app.js(임상 수용성 평가)와 같습니다. */
(function () {
  'use strict';

  var CFG = window.GC_CONFIG;
  var G = window.GC_DATA;
  var DATA = window.T2D_DATA;
  var STORE_KEY = 'gc:state:v1';
  var DRAFT_KEY = 'gc:draft:v1';     // 다른 Part 이어서 하기 시작 화면(세션 시작 전)만 보관
  var IDLE_MS = 180000;              // 3분 이상 조작이 없으면 idle 로 분류
  var START_TIMEOUT_MS = 15000;      // 순서 배정 요청 대기 한도 (Apps Script 첫 호출 지연 고려)
  var POST_TIMEOUT_MS = 30000;
  var NAV_LOCK_MS = 450;             // 화면 전환 직후 연속 탭으로 판정을 건너뛰지 않도록

  var params = new URLSearchParams(location.search);
  var URL_TEST = params.get('test') === '1';
  if (params.get('reset') === '1') {
    try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    var keep = new URLSearchParams(location.search); keep.delete('reset');   // src·site·wave·test·part 는 유지
    history.replaceState(null, '', location.pathname + (keep.toString() ? '?' + keep.toString() : ''));
  }

  // ---------------------------------------------------------------------------
  // Study definitions
  // ---------------------------------------------------------------------------
  var PARTS = CFG.PARTS;
  var VERDICTS = CFG.VERDICTS;
  var PROFILE = CFG.PROFILE_FIELDS || [];
  var END_ITEMS = CFG.END_ITEMS || [];
  var ELIG = CFG.ELIGIBILITY;
  var Q_LABEL = {
    '1.1': '의뢰 판단', '1.2': '환자 평가',
    '2.1': '효능', '2.2': '안전성', '2.3': '실행 가능성',
    '3.1': '동반질환 기반 선택', '3.2': '체중 및 BMI', '3.3': 'HbA1c 목표', '3.4': '용량', '3.5': '금기 및 주의사항',
    '3.6': '복약 순응도', '3.7': '비용 및 급여', '3.8': '비당뇨 약물 및 상호작용',
    '4.1': '추적 시기', '4.2': '평가 항목', '4.3': '이상반응 모니터링',
    '5.1': '자가 혈당 측정', '5.2': '합병증 관리', '5.3': '약물 및 주사 교육', '5.4': '생활습관 및 응급 대응'
  };
  var PHASE_GROUPS = [
    ['Phase 2 · 약물 조합 추천 요약', ['2.1', '2.2', '2.3']],
    ['Phase 3 · 약물 선택 시 고려사항', ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8']],
    ['Phase 4 · 추적관찰 및 모니터링', ['4.1', '4.2', '4.3']],
    ['Phase 5 · 환자 교육', ['5.1', '5.2', '5.3', '5.4']]
  ];
  var ALL_Q = ['2.1', '2.2', '2.3', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '5.4'];
  var END_BY_ID = {}; END_ITEMS.forEach(function (f) { END_BY_ID[f.id] = f; });
  var PROFILE_BY_ID = {}; PROFILE.forEach(function (f) { PROFILE_BY_ID[f.id] = f; });

  function partById(id) { for (var i = 0; i < PARTS.length; i++) if (PARTS[i].id === id) return PARTS[i]; return null; }
  function verdictById(id) { for (var i = 0; i < VERDICTS.length; i++) if (VERDICTS[i].id === id) return VERDICTS[i]; return null; }
  function vLabel(id) { var v = verdictById(id); return v ? v.label : String(id || ''); }
  function unitItems(k) { return (G.units[k] && G.units[k].items) || []; }
  function partItemCount(p) { return p.sequences[0].reduce(function (a, k) { return a + unitItems(k).length; }, 0); }
  // 판정 수 × 1건당 예상 시간 → '약 20–25분' 같은 5분 단위 범위
  function minutesRange(n) {
    var m = n * (Number(CFG.MINUTES_PER_ITEM) || 1);
    if (m <= 5) return '약 5분';
    var lo = Math.floor(m / 5) * 5;
    return '약 ' + lo + '–' + (lo + 5) + '분';
  }
  var URL_PART = partById(String(params.get('part') || '').toUpperCase()) ? String(params.get('part')).toUpperCase() : '';

  // 접속 경로(QR·카카오톡·링크)와 기관·차수 코드 — 개인정보 없음
  function safeParam(k) { return String(params.get(k) || '').replace(/[^0-9A-Za-z_\-]/g, '').slice(0, 32); }
  var UA = navigator.userAgent || '';
  var IN_APP = /KAKAOTALK/i.test(UA) ? 'KAKAOTALK' : /NAVER/.test(UA) ? 'NAVER' : /\bLine\//.test(UA) ? 'LINE' :
    /Instagram/i.test(UA) ? 'INSTAGRAM' : /FBAN|FBAV/.test(UA) ? 'FACEBOOK' : /; wv\)/.test(UA) ? 'WEBVIEW' : '';
  var REF_ORIGIN = (function () {
    try { var o = document.referrer ? new URL(document.referrer).origin : ''; return o === location.origin ? '' : o; } catch (_) { return ''; }
  })();
  var ENTRY = {
    src: safeParam('src') || 'direct', site: safeParam('site'), wave: safeParam('wave') || CFG.STUDY_WAVE || 'main',
    part_preselected: !!URL_PART, in_app: IN_APP, referrer_origin: REF_ORIGIN
  };
  // 기기 ID 는 임상 수용성 평가와 같은 키를 씀 (같은 기기에서 두 트랙 참여 여부 분석용, 개인정보 아님)
  var DEVICE_ID = (function () {
    var k = 't2d-ca:device';
    try { var v = localStorage.getItem(k); if (!v) { v = uuid(); localStorage.setItem(k, v); } return v; } catch (_) { return uuid(); }
  })();
  var VISIT_ID = uuid();
  function fieldCode(f, raw) {
    if (!f || f.type !== 'choice') return '';
    var i = f.options.indexOf(raw);
    return i >= 0 ? i + 1 : '';
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  var elMain = $('main'), elDock = $('dock'), elLayout = $('layout');
  var elTopProg = $('topbarProgress'), elFill = $('progressFill'), elPatientBtn = $('patientBtn');
  var elDrawer = $('drawer'), elDrawerBody = $('drawerBody'), elBackdrop = $('drawerBackdrop');
  var elToast = $('toast'), elTestBanner = $('testBanner');

  // ---------------------------------------------------------------------------
  // Utils
  // ---------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function nowIso() { return new Date().toISOString(); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randInt(n) {
    var a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n;
  }
  function fmtMin(ms) {
    var m = Math.round(ms / 60000);
    if (m < 1) return '1분 미만';
    if (m < 60) return m + '분';
    return Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  }
  function fmtCost(v) {
    var raw = String(v == null ? '' : v).trim();
    var t = raw.replace(/원/g, '').trim();
    if (!t || /^[-–—]$/.test(t)) return '—';
    var parts = t.split(/\s*[–—-]\s*/);
    var NUM = /^(\d{1,3}(,\d{3})+|\d+)$/;
    if (parts.length > 2 || !parts.every(function (x) { return NUM.test(x); })) return esc(raw);
    var nums = parts.map(function (x) { return Number(x.replace(/,/g, '')); });
    if (nums.length === 2 && nums[0] === nums[1]) nums = [nums[0]];
    return nums.map(function (n) { return n.toLocaleString('ko-KR'); }).join('–') + '원';
  }
  var toastTimer = null;
  function toast(msg, ms) {
    elToast.textContent = msg; elToast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.hidden = true; }, ms || 2600);
  }
  function reduceMotion() { return !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches); }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  function emptyBucket() { return { active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0 }; }

  function deviceInfo() {
    var vw = window.innerWidth, vh = window.innerHeight;
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) {}
    return {
      ua: navigator.userAgent, vw: vw, vh: vh,
      sw: (screen && screen.width) || null, sh: (screen && screen.height) || null,
      dpr: window.devicePixelRatio || 1,
      touch: navigator.maxTouchPoints || 0,
      coarse: !!(window.matchMedia && matchMedia('(pointer: coarse)').matches),
      lang: navigator.language || '', tz: tz,
      form_factor: vw < 768 ? 'mobile' : (vw < 1024 ? 'tablet' : 'desktop')
    };
  }

  function newState(evaluator, part, linkedSession) {
    return {
      v: 1,
      study_id: CFG.STUDY_ID,
      app_version: CFG.APP_VERSION,
      data_version: G.data_version,
      session_id: uuid(),
      is_test: URL_TEST || !CFG.ENDPOINT,
      evaluator: evaluator,
      part: part,
      linked_session_id: linkedSession || null,
      created_at: nowIso(),
      started_at: null, finished_at: null,
      screen: 'starting',               // starting → eval → final → done
      seq_index: null, seq_source: null, order: null,
      stepIdx: 0, review: false,
      judgments: {},
      end_items: {}, overall_comment: '',
      metrics: {
        intro: emptyBucket(), final: emptyBucket(), units: [emptyBucket(), emptyBucket()],
        active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0, resumes: 0, interruptions: 0, send_failures: 0
      },
      device: deviceInfo(),
      outbox: [],
      net: { status: 'idle', last_error: '', last_ok: null }
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || s.v !== 1 || !partById(s.part)) return null;
      if (s.order && s.order.some(function (k) { return !G.units[k] || !DATA.outputs[k]; })) return null;
      return s;
    } catch (_) { return null; }
  }
  // --- 여러 탭 보호: 같은 세션을 두 탭에서 열면 마지막으로 진행한 탭만 저장하고, 다른 탭은 멈춘다 ---
  var TAB_ID = uuid();
  var staleTab = false;
  var lastRev = 0;
  var saveTimer = null;
  function readStored() {
    try { var raw = localStorage.getItem(STORE_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function mergeOutbox(target, items) {
    if (!items || !items.length) return;
    var have = {};
    (target.outbox || []).forEach(function (x) { have[x.msg_id] = 1; });
    (target.sent_ids || []).forEach(function (id) { have[id] = 1; });
    items.forEach(function (x) { if (x && x.msg_id && !have[x.msg_id]) { target.outbox.push(x); have[x.msg_id] = 1; } });
  }
  function save() {
    if (!S || staleTab) return;
    try {
      var stored = readStored();
      var same = stored && stored.session_id === S.session_id;
      if (same && stored.writer && stored.writer !== TAB_ID && (stored.rev || 0) > lastRev) {
        // 다른 탭이 이 세션을 더 진행함 → 그 상태를 유지하고, 이 탭의 미전송 응답만 넘겨준 뒤 이 탭은 멈춘다
        mergeOutbox(stored, S.outbox);
        localStorage.setItem(STORE_KEY, JSON.stringify(stored));
        becomeStale();
        return;
      }
      if (same) mergeOutbox(S, stored.outbox);
      S.rev = Math.max(S.rev || 0, same ? (stored.rev || 0) : 0) + 1;
      S.writer = TAB_ID;
      localStorage.setItem(STORE_KEY, JSON.stringify(S));
      lastRev = S.rev;
    } catch (_) {}
  }
  function becomeStale() {
    if (staleTab) return;
    staleTab = true;
    closeDrawer();
    render();
  }
  window.addEventListener('storage', function (e) {
    if (e.key !== STORE_KEY || staleTab || !S) return;
    if (e.newValue === null) { becomeStale(); return; }
    try {
      var o = JSON.parse(e.newValue);
      if (!o || !o.writer || o.writer === TAB_ID) return;
      // 이미 읽었거나 덮어쓴 이전 기록에 대한 늦은 이벤트(새로고침·새 탭 직후)는 무시
      if (o.session_id === S.session_id && (o.rev || 0) <= lastRev) return;
      var cur = readStored();
      if (cur && cur.writer === TAB_ID) return;
      becomeStale();
    } catch (_) {}
  });
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }

  // Intro draft (before a session exists)
  function emptyDraft() {
    return {
      eligible: '', name: '', fields: {}, part: URL_PART, consent: false, consent_at: null, consent_inherited: false,
      linked: null, done_parts: [], evaluator_id: null, prev_patients: [], pending: [], introBucket: emptyBucket()
    };
  }
  function loadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d || !d.linked) return null;
      var base = emptyDraft();
      Object.keys(base).forEach(function (k) { if (d[k] === undefined) d[k] = base[k]; });
      d.introBucket = emptyBucket();
      if (!partById(d.part) || d.done_parts.indexOf(d.part) >= 0) d.part = '';
      return d;
    } catch (_) { return null; }
  }
  function saveDraft() {
    if (S || !draft.linked) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) {}
  }
  var draft = emptyDraft();

  function buildEvaluator() {
    var fields = {}, codes = {};
    PROFILE.forEach(function (f) {
      var v = String(draft.fields[f.id] || '').trim();
      fields[f.id] = v;
      var cd = fieldCode(f, v);
      if (cd !== '') codes[f.id] = cd;
    });
    return { name: draft.name.trim(), role: 'endo', eligible: true, fields: fields, codes: codes };
  }
  // 첫 번째로 비어 있는 필수 항목: [오류 문구, 포커스할 요소 선택자]
  function draftError() {
    if (draft.eligible !== 'yes') return ['참여 자격 문항에 답해 주세요.', '#eligCard'];
    if (!draft.name.trim()) return ['성명을 입력해 주세요.', '#evName'];
    for (var i = 0; i < PROFILE.length; i++) {
      var f = PROFILE[i];
      if (f.required && !String(draft.fields[f.id] || '').trim()) return ['검증자 정보 문항에 모두 답해 주세요.', '[data-field="' + f.id + '"]'];
    }
    if (!partById(draft.part) || draft.done_parts.indexOf(draft.part) >= 0) return ['검증할 Part를 선택해 주세요.', '.part-grid'];
    if (!draft.consent) return ['연구 참여 동의에 체크해 주세요.', '#evConsent'];
    return null;
  }

  var S = load();
  var STEPS = [];   // [{u, i}] — i = -1 은 답변(unit) 안내 화면
  function buildSteps() {
    STEPS = [];
    if (!S || !S.order) return;
    S.order.forEach(function (k, u) {
      STEPS.push({ u: u, i: -1 });
      unitItems(k).forEach(function (_, i) { STEPS.push({ u: u, i: i }); });
    });
  }
  if (S) { lastRev = S.rev || 0; buildSteps(); }

  function curStep() { return STEPS[S.stepIdx] || STEPS[0]; }
  function curItem() { var st = curStep(); return (st && st.i >= 0) ? unitItems(S.order[st.u])[st.i] : null; }
  function onItem() { return !!(S && S.screen === 'eval' && !staleTab && curItem()); }
  function itemOrder(u, i) {
    var n = 0;
    for (var k = 0; k < u; k++) n += unitItems(S.order[k]).length;
    return n + i + 1;
  }
  function totalItems() { return (S.order || []).reduce(function (a, k) { return a + unitItems(k).length; }, 0); }
  function nUnits() { return (S && S.order) ? S.order.length : 2; }
  function partSeqs() { var p = partById(S && S.part); return p ? p.sequences : PARTS[0].sequences; }

  // 판정 1건의 응답·측정값 (item.id 기준)
  function jm(item) {
    var j = S.judgments[item.id];
    if (!j) {
      j = S.judgments[item.id] = {
        agree: null, alt_verdict: null, comment: '', answered_at: null,
        active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0, ttfd_ms: null, changes: 0, visits: 0, history: [],
        opened: { criterion: false, full_answer: false, basis: false, patient: false },
        first_enter: null, sent_sig: null
      };
    }
    return j;
  }
  function jComplete(j) { return !!j && (j.agree === true || (j.agree === false && !!j.alt_verdict)); }
  function physVerdict(item, j) { return j.agree === true ? item.final : (j.agree === false ? (j.alt_verdict || '') : ''); }
  function jSig(j) { return j.agree === true ? 'agree' : ('disagree|' + (j.alt_verdict || '') + '|' + String(j.comment || '').trim()); }

  function currentBucket() {
    if (!S) return draft.introBucket;
    if (S.screen === 'starting') return S.metrics.intro;
    if (S.screen === 'eval' && S.order) {
      var st = curStep();
      return st.i >= 0 ? jm(curItem()) : S.metrics.units[st.u];
    }
    if (S.screen === 'final') return S.metrics.final;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Timing (visible + interacted = active; visible w/o interaction ≥3 min = idle; tab hidden = hidden)
  // ---------------------------------------------------------------------------
  var T = { last: performance.now(), visible: !document.hidden, lastInteract: performance.now(), drawerOpen: false };

  function tick() {
    var now = performance.now();
    var dt = now - T.last;
    T.last = now;
    var wasVisible = T.visible;
    T.visible = !document.hidden;
    if (dt <= 0 || dt > 6 * 3600 * 1000 || staleTab) return;
    var b = currentBucket();
    if (!b) return;
    var kind;
    if (!wasVisible) kind = 'hidden_ms';
    else if (now - T.lastInteract > IDLE_MS) kind = 'idle_ms';
    else kind = 'active_ms';
    b[kind] += dt; b.wall_ms += dt;
    if (S && S.screen !== 'done') {
      S.metrics[kind] += dt; S.metrics.wall_ms += dt;
    }
  }
  function markInteract() {
    var now = performance.now();
    if (now - T.lastInteract > IDLE_MS) { tick(); }   // close the idle gap first
    T.lastInteract = now;
  }
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input', 'scroll'].forEach(function (ev) {
    window.addEventListener(ev, markInteract, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', function () {
    tick();
    if (document.hidden) {
      if (S && S.screen === 'eval' && !staleTab && S.order) S.metrics.interruptions = (S.metrics.interruptions || 0) + 1;
      sendProgress();
    } else {
      T.lastInteract = performance.now();
      flush();
    }
    save();
  });
  var unloading = false;
  window.addEventListener('pagehide', function () { unloading = true; tick(); sendProgress(); save(); });
  window.addEventListener('pageshow', function () { unloading = false; });
  setInterval(function () { tick(); saveSoon(); }, 1000);

  // ---------------------------------------------------------------------------
  // Network: outbox with idempotent upserts on the server
  // ---------------------------------------------------------------------------
  function postJSON(payload, timeoutMs) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || POST_TIMEOUT_MS);
    return fetch(CFG.ENDPOINT, {
      method: 'POST', body: JSON.stringify(payload), redirect: 'follow', signal: ctrl.signal
    }).then(function (res) { return res.text(); })
      .then(function (txt) {
        var j;
        try { j = JSON.parse(txt); } catch (_) { throw new Error('서버 응답 형식 오류'); }
        if (!j || !j.ok) throw new Error((j && j.error) || '서버 오류');
        return j;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function basePayload(action) {
    return {
      action: action, msg_id: uuid(), client_time: nowIso(),
      study_id: S.study_id, app_version: S.app_version, data_version: S.data_version,
      instrument_version: CFG.INSTRUMENT_VERSION || '',
      session_id: S.session_id, is_test: S.is_test,
      evaluator: S.evaluator, evaluator_id: S.evaluator_id,
      device_id: S.device_id || DEVICE_ID, visit_id: S.visit_id || VISIT_ID,
      session_ordinal: S.session_ordinal || 1, linked_session_id: S.linked_session_id,
      part: S.part, sequence_index: S.seq_index, seq_source: S.seq_source, order: S.order,
      n_sequences: partSeqs().length,
      entry: S.entry || ENTRY, consent: S.consent || {}, incentive: CFG.INCENTIVE || ''
    };
  }

  // fire-and-forget 신호 (응답 보관함과 별개): 이탈 지점(gc_progress)과 첫 화면 방문(view)
  function beacon(p) {
    if (!CFG.ENDPOINT) return;
    var body = JSON.stringify(p);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(CFG.ENDPOINT, new Blob([body], { type: 'text/plain;charset=utf-8' }))) return;
    } catch (_) {}
    try { fetch(CFG.ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }).catch(function () {}); } catch (_) {}
  }
  function itemsDone() {
    if (!S || !S.order) return 0;
    var n = 0;
    S.order.forEach(function (k) { unitItems(k).forEach(function (it) { if (jComplete(S.judgments[it.id]) && S.judgments[it.id].sent_sig) n++; }); });
    return n;
  }
  var lastProgressAt = 0;
  function sendProgress() {
    if (!S || staleTab || !S.order || S.screen === 'done' || S.screen === 'starting') return;
    var now = Date.now();
    if (now - lastProgressAt < 10000) return;
    lastProgressAt = now;
    var p = basePayload('gc_progress');
    var f = S.furthest || {};
    p.progress = { furthest_unit: f.unit || 1, furthest_item: f.item || 0, items_done: itemsDone(), last_activity_at: nowIso() };
    beacon(p);
  }
  var viewSent = false;
  function sendView() {
    if (viewSent || !CFG.ENDPOINT) return;
    viewSent = true;
    var en = {};
    Object.keys(ENTRY).forEach(function (k) { en[k] = ENTRY[k]; });
    en.type_param = URL_PART;   // 방문 기록(Visits.TypeParam)에 링크의 ?part= 값
    beacon({
      action: 'view', msg_id: uuid(), client_time: nowIso(), study_id: CFG.STUDY_ID, app_version: CFG.APP_VERSION,
      is_test: URL_TEST, visit_id: VISIT_ID, device_id: DEVICE_ID, entry: en, form_factor: deviceInfo().form_factor
    });
  }

  function enqueue(payload) {
    S.outbox.push(payload);
    save();
    flush();
  }

  var flushing = false;
  function flush() {
    var sess = S;
    if (flushing || staleTab || !sess || !CFG.ENDPOINT || !sess.outbox || !sess.outbox.length) return Promise.resolve();
    flushing = true;
    sess.net.status = 'sending';
    if (sess.screen === 'done') render();
    var loop = function () {
      if (!sess.outbox.length) return Promise.resolve();
      var item = sess.outbox[0];
      return postJSON(item).then(function () {
        var k = sess.outbox.indexOf(item);
        if (k >= 0) sess.outbox.splice(k, 1);
        sess.sent_ids = (sess.sent_ids || []).concat([item.msg_id]).slice(-300);
        if (sess === S) save();
        return loop();
      });
    };
    return loop().then(function () {
      sess.net.status = 'ok'; sess.net.last_ok = nowIso(); sess.net.last_error = '';
    }, function (e) {
      sess.net.status = 'fail'; sess.net.last_error = String(e && e.message || e);
      sess.metrics.send_failures = (sess.metrics.send_failures || 0) + 1;
    }).then(function () {
      if (sess !== S) return;   // '새 검증 시작'으로 대체된 세션: 플래그는 이미 초기화됨
      flushing = false;
      save();
      if (S.screen === 'done') render();
    });
  }
  window.addEventListener('online', function () { flush(); });
  setInterval(function () { if (S && S.outbox && S.outbox.length && !document.hidden) flush(); }, 30000);

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------
  function buildJudgment(u, i) {
    var item = unitItems(S.order[u])[i], j = jm(item);
    var o = j.opened || {};
    return {
      item_id: item.id, unit: item.unit, unit_order: u + 1, item_order: itemOrder(u, i),
      patient: item.patient, combo: item.combo, question: item.question, element: item.element, target_key: item.target_key,
      audit_mark: item.audit.mark, audit_category: item.audit.category,
      rater_verdict: item.rater.verdict, audit_corrected: item.audit.corrected, ai_final: item.final,
      agree: j.agree === true, phys_verdict: physVerdict(item, j),
      comment: j.agree === false ? String(j.comment || '').trim() : '',
      answered_at: j.answered_at,
      item_ms: Math.round(j.active_ms + j.idle_ms), active_ms: Math.round(j.active_ms),
      ttfd_ms: j.ttfd_ms, changes: j.changes, visits: j.visits,
      opened: { criterion: !!o.criterion, full_answer: !!o.full_answer, basis: !!o.basis, patient: !!o.patient }
    };
  }
  function allJudgments() {
    var out = [];
    S.order.forEach(function (k, u) {
      unitItems(k).forEach(function (it, i) { if (jComplete(S.judgments[it.id])) out.push(buildJudgment(u, i)); });
    });
    return out;
  }
  function counts() {
    var a = 0, d = 0;
    (S.order || []).forEach(function (k) {
      unitItems(k).forEach(function (it) {
        var j = S.judgments[it.id];
        if (!jComplete(j)) return;
        if (j.agree) a++; else d++;
      });
    });
    return { agree: a, disagree: d, done: a + d, total: totalItems() };
  }
  function sessionSummary() {
    var m = S.metrics;
    return {
      started_at: S.started_at, finished_at: S.finished_at,
      total_active_ms: Math.round(m.active_ms), total_idle_ms: Math.round(m.idle_ms),
      total_hidden_ms: Math.round(m.hidden_ms), total_wall_ms: Math.round(m.wall_ms),
      intro_ms: Math.round(m.intro.active_ms + m.intro.idle_ms),
      final_ms: Math.round(m.final.active_ms + m.final.idle_ms),
      resumes: m.resumes, interruptions: m.interruptions || 0, send_failures: m.send_failures || 0,
      items_done: counts().done
    };
  }

  // ---------------------------------------------------------------------------
  // Flow control
  // ---------------------------------------------------------------------------
  var navLockUntil = 0;
  var ui = { critOpen: false };   // 화면 안에서만 쓰는 펼침 상태 (판정을 옮기면 초기화)
  function markFurthest(rank, unitNo, itemNo) {
    if (!S.furthest || rank > (S.furthest.rank || 0)) S.furthest = { rank: rank, unit: unitNo, item: itemNo };
  }
  function focusTop() {
    var h = elMain.querySelector('h1');
    try {
      if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
      else elMain.focus({ preventScroll: true });
    } catch (_) {}
  }
  function enterStep() {
    elToast.hidden = true;
    closeDrawer();
    ui.critOpen = false;
    navLockUntil = performance.now() + NAV_LOCK_MS;
    var st = curStep();
    markFurthest(S.stepIdx + 1, st.u + 1, st.i >= 0 ? itemOrder(st.u, st.i) : 0);
    if (st.i >= 0) {
      var j = jm(curItem());
      j.visits += 1;
      if (!j.first_enter) j.first_enter = nowIso();
    }
    T.lastInteract = performance.now();
    save();
    render();
    window.scrollTo(0, 0);
    focusTop();
  }

  var starting = false;
  function startSession() {
    if (starting) return;
    var err = draftError();
    if (err) {
      toast(err[0]);
      var t = elMain.querySelector(err[1]);
      if (t) {
        t.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
        var f = t.matches('input, button') ? t : t.querySelector('button:not([disabled]), input');
        if (f) try { f.focus({ preventScroll: true }); } catch (_) {}
      }
      return;
    }
    tick();
    starting = true;
    S = newState(buildEvaluator(), draft.part, draft.linked);
    S.done_parts = (draft.done_parts || []).slice();
    S.evaluator_id = draft.evaluator_id || uuid();
    S.device_id = DEVICE_ID; S.visit_id = VISIT_ID; S.entry = ENTRY;
    S.consent = { version: CFG.CONSENT_VERSION || '', at: draft.consent_at || nowIso(), inherited: !!draft.consent_inherited };
    S.session_ordinal = S.done_parts.length + 1;
    S.prev_patients = (draft.prev_patients || []).slice();
    S.outbox = (draft.pending || []).slice();   // 앞 Part 에서 아직 못 보낸 응답은 이어서 보냄
    S.metrics.intro = draft.introBucket;
    S.metrics.active_ms += draft.introBucket.active_ms;
    S.metrics.idle_ms += draft.introBucket.idle_ms;
    S.metrics.hidden_ms += draft.introBucket.hidden_ms;
    S.metrics.wall_ms += draft.introBucket.wall_ms;
    S.started_at = nowIso();
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
    render();

    var finish = function (seq, source) {
      S.seq_index = seq;
      S.seq_source = source;
      S.order = partSeqs()[seq].slice();
      buildSteps();
      S.screen = 'eval'; S.stepIdx = 0;
      starting = false;
      if (source === 'local' && CFG.ENDPOINT) {
        var sp = basePayload('gc_start');
        sp.device = S.device;
        enqueue(sp);
      }
      enterStep();
    };

    if (!CFG.ENDPOINT) { finish(randInt(partSeqs().length), 'local'); return; }

    var p = basePayload('gc_start');
    p.device = S.device;
    var settled = false;
    var to = setTimeout(function () {
      if (settled || unloading) return; settled = true;
      finish(randInt(partSeqs().length), 'local');
    }, START_TIMEOUT_MS);
    postJSON(p, START_TIMEOUT_MS).then(function (j) {
      if (settled) return; settled = true; clearTimeout(to);
      var seq = Number(j.seq_index);
      if (!(seq >= 0 && seq < partSeqs().length)) seq = randInt(partSeqs().length);
      S.net.status = 'ok'; S.net.last_ok = nowIso();
      finish(seq, 'server');
    }).catch(function (e) {
      if (settled || unloading) return; settled = true; clearTimeout(to);
      S.net.last_error = String(e && e.message || e);
      finish(randInt(partSeqs().length), 'local');
    });
  }

  // 판정을 서버로 보냄: 처음 완료했을 때와, 이후 응답을 고쳤을 때만 (같은 내용은 다시 보내지 않음)
  function commitCurrent() {
    var st = curStep(), item = curItem();
    if (!item) return;
    var j = jm(item);
    if (!jComplete(j)) return;
    var sig = jSig(j);
    if (j.sent_sig === sig) return;
    j.answered_at = nowIso();
    j.sent_sig = sig;
    var p = basePayload('gc_judgment');
    p.judgment = buildJudgment(st.u, st.i);
    enqueue(p);
  }

  function goFinal() {
    S.screen = 'final';
    S.review = false;
    markFurthest(STEPS.length + 1, nUnits(), totalItems());
    navLockUntil = performance.now() + NAV_LOCK_MS;
    closeDrawer();
    save(); render(); window.scrollTo(0, 0); focusTop();
  }

  function goNext() {
    if (!S) { startSession(); return; }
    if (staleTab || performance.now() < navLockUntil) return;
    tick();
    if (S.screen === 'eval') {
      var item = curItem();
      if (item) {
        var j = jm(item);
        if (!jComplete(j)) {
          toast(j.agree === false ? '올바른 판정을 선택해 주세요.' : '동의 또는 비동의를 선택해 주세요.');
          return;
        }
        commitCurrent();
        if (S.review) { goFinal(); return; }
      }
      if (S.stepIdx < STEPS.length - 1) { S.stepIdx += 1; enterStep(); return; }
      goFinal();
      return;
    }
    if (S.screen === 'final') {
      var missing = END_ITEMS.filter(function (f) { return f.required && !(S.end_items[f.id] && S.end_items[f.id].value); });
      if (missing.length) {
        toast('마무리 문항에 모두 답해 주세요.');
        var seg = elMain.querySelector('[data-field="' + missing[0].id + '"]');
        if (seg) { seg.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); var b = seg.querySelector('button'); if (b) b.focus({ preventScroll: true }); }
        return;
      }
      var incomplete = counts();
      if (incomplete.done < incomplete.total) { toast('아직 확인하지 않은 판정이 있습니다.'); return; }
      S.finished_at = nowIso();
      S.screen = 'done';
      var fp = basePayload('gc_finish');
      fp.judgments = allJudgments();
      fp.end_items = S.end_items || {};
      fp.overall_comment = String(S.overall_comment || '').trim();
      fp.session = sessionSummary();
      fp.device = S.device;
      // 완료 후에는 같은 판정을 다시 보낼 필요가 없음 (finish 가 전체를 담음)
      S.order.forEach(function (k) { unitItems(k).forEach(function (it) { var jj = S.judgments[it.id]; if (jj) jj.sent_sig = jSig(jj); }); });
      save(); render(); window.scrollTo(0, 0); focusTop();
      enqueue(fp);
    }
  }

  function goBack() {
    if (!S || S.screen !== 'eval' || S.stepIdx === 0 || staleTab || S.review) return;
    if (performance.now() < navLockUntil) return;
    tick();
    commitCurrent();   // 고친 판정은 [이전]으로 나가도 저장
    S.stepIdx -= 1;
    enterStep();
  }

  function editFromFinal(idx) {
    if (!S || S.screen !== 'final' || staleTab) return;
    if (!(idx >= 0 && idx < STEPS.length) || STEPS[idx].i < 0) return;
    tick();
    S.screen = 'eval'; S.stepIdx = idx; S.review = true;
    enterStep();
  }

  function decisionTime(j) { return Math.round(j.active_ms + j.idle_ms); }
  function setAgree(v) {
    if (!onItem()) return;
    tick();
    var j = jm(curItem());
    if (j.agree === v) return;
    if (j.ttfd_ms == null) j.ttfd_ms = decisionTime(j);
    else if (j.agree !== null) j.changes += 1;
    j.history.push([v ? 'agree' : 'disagree', decisionTime(j)]);
    j.agree = v;
    save();
    redrawDock('[data-agree="' + (v ? '1' : '0') + '"]');
  }
  function setAlt(id) {
    if (!onItem()) return;
    tick();
    var item = curItem(), j = jm(item);
    if (j.agree !== false || id === item.final || !verdictById(id) || j.alt_verdict === id) return;
    if (j.alt_verdict) j.changes += 1;
    j.history.push(['verdict:' + id, decisionTime(j)]);
    j.alt_verdict = id;
    save();
    redrawDock('[data-alt="' + id + '"]');
  }
  function redrawDock(focusSel) {
    var hadFocus = elDock.contains(document.activeElement);
    renderDock();
    if (hadFocus && focusSel) { var b = elDock.querySelector(focusSel); if (b) b.focus(); }
  }

  // ---------------------------------------------------------------------------
  // Drawer (patient info)
  // ---------------------------------------------------------------------------
  var lastFocus = null;
  function openDrawer() {
    if (!S || S.screen !== 'eval' || staleTab || !S.order) return;
    tick();
    var out = DATA.outputs[S.order[curStep().u]];
    elDrawerBody.innerHTML = patientHTML(DATA.patients[out.patient], true);
    $('drawerTitle').textContent = '환자 정보 · ' + out.patient;
    lastFocus = document.activeElement;
    elDrawer.hidden = false; elBackdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    elLayout.inert = true; $('topbar').inert = true;
    T.drawerOpen = true;
    var it = curItem();
    if (it) jm(it).opened.patient = true;
    else S.metrics.unit_drawer_opens = (S.metrics.unit_drawer_opens || 0) + 1;
    save();
    elDrawerBody.scrollTop = 0;
    $('drawerClose').focus();
  }
  function closeDrawer() {
    if (elDrawer.hidden) return;
    tick();
    T.drawerOpen = false;
    elDrawer.hidden = true; elBackdrop.hidden = true;
    document.body.style.overflow = '';
    elLayout.inert = false; $('topbar').inert = false;
    if (lastFocus && lastFocus.focus && document.body.contains(lastFocus)) lastFocus.focus();
    save();
  }
  elPatientBtn.addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  elBackdrop.addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDrawer(); return; }
    if (!elDrawer.hidden && e.key === 'Tab') {
      var f = [$('drawerClose'), elDrawerBody];
      var at = f.indexOf(document.activeElement);
      e.preventDefault();
      f[(at + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
    }
  });

  // ---------------------------------------------------------------------------
  // Render helpers — patient record and prescriptions (same rendering as the CA site, app.js)
  // ---------------------------------------------------------------------------
  function splitUnit(v) {
    var m = String(v).match(/^([<>]?\s*-?[\d.,]+)\s*(.*)$/);
    return m ? { num: m[1].replace(/\s+/g, ''), unit: m[2] } : { num: String(v), unit: null };
  }

  function patientHTML(p) {
    var h = [];
    var sym = (p.symptoms || []).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    h.push(
      '<section class="card">' +
        '<div class="pt-head"><span class="pt-id">' + esc(p.id) + '</span>' +
        '<span class="pt-demo">' + esc(p.demographics) + '</span>' +
        '<span class="pill">' + esc(p.visit_type) + '</span></div>' +
        '<p class="small muted" style="margin-top:4px">합성(가상) 환자 자료이며 실제 환자 정보가 아닙니다.</p>' +
        '<dl class="kv" style="margin-top:12px">' +
          '<dt>내원 이유</dt><dd>' + esc(p.visit_reason) + '</dd>' +
          '<dt>진단 경위</dt><dd>' + esc(p.diagnosis_history) + '</dd>' +
          '<dt>현재 증상</dt><dd><ul class="clean">' + sym + '</ul></dd>' +
        '</dl>' +
      '</section>'
    );

    var hl = function (t) { return /\((No)\)|:\s*Normal|Category:\s*Normal/i.test(t) ? '' : ' hl'; };
    var tags = function (arr, highlight) {
      return '<div class="tags">' + arr.map(function (t) {
        return '<span class="tag' + (highlight ? hl(t) : '') + '">' + esc(t) + '</span>';
      }).join('') + '</div>';
    };
    h.push(
      '<section class="card">' +
        '<h3 class="section-title">병력</h3>' +
        '<dl class="kv">' +
          '<dt>기타 질환</dt><dd>' + tags(p.history.other_conditions, true) + '</dd>' +
          '<dt>당뇨 관련<br>동반질환</dt><dd>' + tags(p.history.dm_comorbidities, true) + '</dd>' +
          '<dt>가족력</dt><dd>' + esc(p.history.family) + '</dd>' +
          '<dt>사회력</dt><dd><ul class="clean">' + p.history.social.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></dd>' +
        '</dl>' +
      '</section>'
    );

    h.push(
      '<section class="card">' +
        '<h3 class="section-title">현재 복용약</h3>' +
        '<ul class="clean">' + p.medications.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>' +
        '<h3 class="section-title" style="margin-top:14px">신체검사 (현재)</h3>' + tags(p.exam, false) +
      '</section>'
    );

    var th = function (lg, sm) { return '<span class="lg">' + lg + '</span><span class="sm">' + sm + '</span>'; };
    var head = '<tr><th class="name">항목</th><th>' + th('-12개월', '-12m') + '</th><th>' + th('-9개월', '-9m') + '</th><th>' +
      th('-6개월', '-6m') + '</th><th>' + th('-3개월', '-3m') + '</th><th class="now">현재</th></tr>';
    var rows = [], lastGroup = null;
    p.labs.forEach(function (lab) {
      if (lab.group !== lastGroup) {
        rows.push('<tr class="grp"><td colspan="6">' + esc(lab.group) + '</td></tr>');
        lastGroup = lab.group;
      }
      var parts = lab.values.map(splitUnit);
      var units = parts.map(function (x) { return x.unit; });
      var same = units.every(function (u) { return u === units[0]; }) && units[0] != null;
      var cells = parts.map(function (x, i) {
        var val = same ? x.num : lab.values[i];
        return '<td' + (i === parts.length - 1 ? ' class="now"' : '') + '>' + esc(val) + '</td>';
      }).join('');
      rows.push('<tr><td class="name">' + esc(lab.name) + (same && units[0] ? '<small>' + esc(units[0]) + '</small>' : '') + '</td>' + cells + '</tr>');
    });
    h.push(
      '<section class="card">' +
        '<h3 class="section-title">검사 수치 (12개월 추이)</h3>' +
        '<div class="lab-wrap"><table class="lab-table"><thead>' + head + '</thead><tbody>' + rows.join('') + '</tbody></table></div>' +
        '<p class="lab-caption">3개월 간격 측정 · 주황색 배경의 <b>현재</b> 열이 이번 방문 값입니다.</p>' +
        '<h3 class="section-title" style="margin-top:14px">추가 검사</h3>' +
        '<ul class="clean">' + p.extra_tests.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      '</section>'
    );

    h.push(
      '<section class="card">' +
        '<h3 class="section-title">개별 치료 결정 요소</h3>' +
        '<p class="small" style="font-weight:700;color:var(--navy)">현재까지의 치료 순응도</p>' +
        '<ul class="clean" style="margin-top:4px">' + p.adherence.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
        '<p class="small" style="font-weight:700;color:var(--navy);margin-top:12px">경제적 여건</p>' +
        '<p style="margin-top:4px">' + esc(p.economics) + '</p>' +
      '</section>'
    );
    return h.join('');
  }

  var DECISION_CLASS = { '신규': 'new', '유지': 'keep', '중단': 'stop', '감량': 'reduce' };
  function rxHTML(rx) {
    var cls = DECISION_CLASS[rx.decision] || 'keep';
    var cov = rx.reimbursement === '급여' ? 'cov' : 'nocov';
    return '<div class="rx' + (cls === 'stop' ? ' stopped' : '') + '">' +
      '<div class="rx-top"><span class="badge ' + cls + '">' + esc(rx.decision) + '</span>' +
      '<span class="rx-drug">' + esc(rx.drug) + '</span><span class="rx-class">' + esc(rx.class) + '</span></div>' +
      '<div class="rx-dose">' + esc(rx.dose) + ' · ' + esc(rx.frequency) + '</div>' +
      '<dl class="rx-meta">' +
        '<dt>용량 조절</dt><dd>' + esc(rx.titration || '—') + '</dd>' +
        '<dt>급여·비용</dt><dd><span class="badge ' + cov + '">' + esc(rx.reimbursement) + '</span> 월 ' + fmtCost(rx.monthly_cost_krw) + '</dd>' +
        (rx.alternatives ? '<dt>대체 약제</dt><dd>' + esc(rx.alternatives) + '</dd>' : '') +
      '</dl></div>';
  }
  function rxListHTML(list) { return '<div class="rx-list">' + list.map(rxHTML).join('') + '</div>'; }
  // 조합은 AI가 붙인 이름 대신 '조합 N' + 약물 구성으로 표시 (CA 와 같음)
  function drugChipsHTML(cb) {
    return '<div class="cc-drugs">' + cb.prescription.map(function (rx) {
      var cls = DECISION_CLASS[rx.decision] || 'keep';
      return '<span class="drug ' + cls + '"><b>' + esc(rx.drug) + '</b><em>' + esc(rx.decision) + '</em></span>';
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Render helpers — GC
  // ---------------------------------------------------------------------------
  function vdHTML(id, extra) {
    return '<span class="vd v-' + esc(id) + (extra ? ' ' + extra : '') + '">' + esc(vLabel(id)) +
      (extra && extra.indexOf('struck') >= 0 ? '<span class="sr-only"> (보정 전)</span>' : '') + '</span>';
  }
  function mkHTML(mark, short) {
    var major = mark === 'major';
    return '<span class="mk ' + (major ? 'major' : 'minor') + '"><span aria-hidden="true">' + (major ? '✗' : '△') + '</span> ' +
      (short ? (major ? '보정' : '유지') : (major ? '중대한 오류' : '미세한 오류')) + '</span>';
  }
  function answerParts(out, combo, q) {
    if (!combo) {
      var p1 = out.phase_1 || {};
      if (q === '1.1') { var a1 = p1['1.1'] || {}; return { callout: a1.referral ? { label: '의뢰', text: a1.referral } : null, text: a1.answer || '' }; }
      return { callout: null, text: typeof p1[q] === 'string' ? p1[q] : '' };
    }
    var a = out.combinations[combo - 1].answers[q];
    if (a && typeof a === 'object') return { callout: a.next_visit ? { label: '다음 방문', text: a.next_visit } : null, text: a.answer || '' };
    return { callout: null, text: a == null ? '' : String(a) };
  }
  function partsContain(ap, q) { return ap.text.indexOf(q) >= 0 || (ap.callout && ap.callout.text.indexOf(q) >= 0); }
  // AI 채점 인용문이 답변 어디에 있는지: 'here'(이 판정의 답) / 다른 답 번호 / ''(찾지 못함)
  function findQuote(out, item, q) {
    q = String(q || '').trim();
    if (q.length < 2) return '';
    if (partsContain(answerParts(out, item.combo, item.question), q)) return 'here';
    var qs = item.combo ? ALL_Q : ['1.1', '1.2'];
    for (var i = 0; i < qs.length; i++) {
      if (qs[i] !== item.question && partsContain(answerParts(out, item.combo, qs[i]), q)) return qs[i];
    }
    return '';
  }
  // AI 감사 근거 인용문의 위치: findQuote 와 같고, 이 조합에 없으면 다른 조합에서 찾는다 → { combo, q } (못 찾으면 null)
  function findQuoteAnyCombo(out, item, q) {
    var loc = findQuote(out, item, q);
    if (loc) return { combo: item.combo, q: loc };
    if (!item.combo) return null;
    q = String(q || '').trim();
    if (q.length < 4) return null;
    for (var c = 1; c <= out.combinations.length; c++) {
      if (c === item.combo) continue;
      for (var i = 0; i < ALL_Q.length; i++) {
        if (partsContain(answerParts(out, c, ALL_Q[i]), q)) return { combo: c, q: ALL_Q[i] };
      }
    }
    return null;
  }
  function parseEvidence(e) {
    var m = String(e).match(/^([^“]*?)\s*:\s*“([\s\S]*)”\s*$/);
    return m ? { label: m[1], quote: m[2] } : { label: '', quote: '' };
  }
  function evidenceQuotes(item) {
    return item.audit.evidence.map(parseEvidence).filter(function (x) { return x.quote; }).map(function (x) { return x.quote; });
  }
  // 답변 문장 중 AI 채점 인용(r)·AI 감사 근거(a)와 글자 그대로 일치하는 부분을 표시
  function markHTML(text, rq, aq) {
    text = String(text || '');
    var n = text.length;
    if (!n) return '';
    var fr = [], fa = [];
    var paint = function (qs, arr) {
      (qs || []).forEach(function (q) {
        q = String(q || '').trim();
        if (q.length < 4) return;
        var from = 0, k;
        while ((k = text.indexOf(q, from)) >= 0) { for (var x = k; x < k + q.length; x++) arr[x] = 1; from = k + q.length; }
      });
    };
    paint(rq, fr); paint(aq, fa);
    var wrap = function (c, s) {
      if (!s) return '';
      if (!c) return esc(s);
      return '<mark class="gc-hl ' + (c === 'ra' ? 'r a' : c) + '">' + esc(s) + '</mark>';
    };
    var html = '', cur = '', buf = '';
    for (var i = 0; i < n; i++) {
      var cls = (fr[i] ? 'r' : '') + (fa[i] ? 'a' : '');
      if (cls !== cur) { html += wrap(cur, buf); buf = ''; cur = cls; }
      buf += text.charAt(i);
    }
    return html + wrap(cur, buf);
  }
  function hasMark(ap, qs) {
    return (qs || []).some(function (q) { q = String(q || '').trim(); return q.length >= 4 && partsContain(ap, q); });
  }
  function answerBodyHTML(ap, rq, aq) {
    return (ap.callout ? '<span class="callout"><small>' + esc(ap.callout.label) + '</small>' + markHTML(ap.callout.text, rq, aq) + '</span>' : '') +
      '<p>' + (ap.text ? markHTML(ap.text, rq, aq) : '<span class="muted">(답변 없음)</span>') + '</p>';
  }

  function pathHTML(item) {
    var changed = item.audit.mark === 'major' && item.audit.corrected && item.audit.corrected !== item.rater.verdict;
    return '<div class="gc-path' + (changed ? ' changed' : '') + '" role="group" aria-label="판정 경과">' +
      '<div class="gp-step"><small>AI 채점</small>' + vdHTML(item.rater.verdict, changed ? 'struck' : '') + '</div>' +
      '<span class="gp-arrow" aria-hidden="true">→</span>' +
      '<div class="gp-step"><small>AI 감사</small>' + mkHTML(item.audit.mark, true) + '</div>' +
      '<span class="gp-arrow" aria-hidden="true">→</span>' +
      '<div class="gp-step gp-final"><small>AI 최종 판정</small>' + vdHTML(item.final) + '</div>' +
    '</div>';
  }
  function criterionHTML(item) {
    return '<section class="card gc-crit"><h2 class="section-title">감점 기준</h2>' +
      '<div class="gc-clamp' + (ui.critOpen ? ' open' : '') + '" id="gcCrit">' + esc(item.criterion) + '</div>' +
      '<button type="button" class="gc-more-btn" data-act="crit" aria-expanded="' + ui.critOpen + '" aria-controls="gcCrit">' +
        (ui.critOpen ? '접기' : '전체 보기') + '</button></section>';
  }
  function fullAnswerHTML(item, out, cb, rq, aq) {
    var row = function (q) {
      var cur = q === item.question;
      return '<div class="gc-full-row' + (cur ? ' cur' : '') + '"><div class="gc-full-q"><b>' + esc(q) + '</b> ' + esc(Q_LABEL[q] || '') +
        (cur ? ' <span class="pill orange">이 판정의 답</span>' : '') + '</div>' +
        answerBodyHTML(answerParts(out, item.combo, q), rq, aq) + '</div>';
    };
    if (!cb) return '<div class="gc-full"><h3 class="mini">Phase 1 · 환자 분류 및 의뢰</h3>' + ['1.1', '1.2'].map(row).join('') + '</div>';
    return '<div class="gc-full"><h3 class="mini">처방 (조합 ' + item.combo + ')</h3>' + rxListHTML(cb.prescription) +
      PHASE_GROUPS.map(function (g) { return '<h3 class="mini">' + esc(g[0]) + '</h3>' + g[1].map(row).join(''); }).join('') + '</div>';
  }
  function answerCardHTML(item, out, cb) {
    var rq = item.rater.quotes, aq = evidenceQuotes(item);
    var ap = answerParts(out, item.combo, item.question);
    var hasR = hasMark(ap, rq), hasA = hasMark(ap, aq);
    var where = item.combo ? '조합 ' + item.combo : 'Phase 1';
    return '<section class="card gc-answer">' +
      '<div class="gc-ans-head"><span class="ai-label">CDSS 답변</span>' +
        '<span class="gc-ans-where">' + esc(where) + ' · 답 ' + esc(item.question) + ' ' + esc(Q_LABEL[item.question] || '') + '</span></div>' +
      (item.question_text ? '<p class="gc-qtext"><span class="gc-qtext-k">채점표에서 이 답을 보는 관점</span>' + esc(item.question_text) + '</p>' : '') +
      (cb ? drugChipsHTML(cb) : '') +
      '<div class="gc-ans-body">' + answerBodyHTML(ap, rq, aq) + '</div>' +
      ((hasR || hasA) ? '<p class="gc-hl-legend">' +
        (hasR ? '<span><mark class="gc-hl r">노란 표시</mark> = AI 채점이 인용한 부분</span>' : '') +
        (hasA ? '<span><mark class="gc-hl a">초록 점선</mark> = AI 감사가 근거로 든 부분</span>' : '') + '</p>' : '') +
      '<details class="gc-more" data-track="full_answer"><summary>' + (cb ? '이 조합 전체 답변·처방 보기' : 'Phase 1 전체 답변 보기') + '</summary>' +
        fullAnswerHTML(item, out, cb, rq, aq) + '</details>' +
    '</section>';
  }
  function raterCardHTML(item, out) {
    var r = item.rater;
    var quotes = r.quotes.length ? '<ul class="gc-quotes">' + r.quotes.map(function (q) {
      var loc = findQuote(out, item, q);
      var note = loc === 'here' ? '위 답변에 표시' : loc ? '답 ' + loc + '에 있음 · 전체 답변에서 표시' : '답변 원문에서 그대로 찾을 수 없음';
      return '<li><q>' + esc(q) + '</q><span class="qloc' + (loc ? '' : ' miss') + '">' + esc(note) + '</span></li>';
    }).join('') + '</ul>' : '<p class="small muted">인용한 답변 문장 없음</p>';
    return '<section class="card gc-rater">' +
      '<div class="gc-card-head"><h2 class="gc-who">AI 채점 <small>AI Rater</small></h2>' + vdHTML(r.verdict) + '</div>' +
      (r.verdict === 'deducted' && r.type ? '<p class="gc-cat"><span>감점 유형</span>' + esc(r.type) + '</p>' : '') +
      '<h3 class="mini">인용한 답변</h3>' + quotes +
      '<h3 class="mini">판정 사유</h3><p class="gc-text">' + esc(r.reason || '—') + '</p>' +
    '</section>';
  }
  function auditCardHTML(item, out) {
    var a = item.audit, major = a.mark === 'major';
    var row = (major && a.corrected) ?
      '<div class="gc-compare" role="group" aria-label="AI 감사의 판정 보정">' +
        '<div class="cmp-from"><small>AI 채점</small>' + vdHTML(item.rater.verdict, a.corrected !== item.rater.verdict ? 'struck' : '') + '</div>' +
        '<span class="cmp-arrow" aria-hidden="true">→</span>' +
        '<div class="cmp-to"><small>보정 판정</small>' + vdHTML(a.corrected) + '</div></div>' :
      '<p class="gc-keep">' + vdHTML(item.rater.verdict) + '<span>판정은 그대로 유지합니다. 인용이나 사유에 결함이 있다는 표시입니다.</span></p>';
    var ev = a.evidence.length ? '<h3 class="mini">감사 근거</h3><ul class="gc-evidence">' + a.evidence.map(function (e) {
      var p = parseEvidence(e);
      if (!p.quote) return '<li>' + esc(e) + '</li>';
      var loc = out ? findQuoteAnyCombo(out, item, p.quote) : null;
      var note = !loc ? '' : loc.combo !== item.combo ? '조합 ' + loc.combo + '의 답 ' + loc.q + '에 있는 문장 · 이 화면(조합 ' + item.combo + ')의 답변에는 없음'
        : loc.q === 'here' ? '위 답변에 표시' : '답 ' + loc.q + '에 있음 · 전체 답변에서 표시';
      return '<li>' + (p.label ? '<span class="ev-src">' + esc(p.label) + '</span>' : '') + '<q>' + esc(p.quote) + '</q>' +
        (note ? '<span class="qloc' + (loc.combo !== item.combo ? ' other' : '') + '">' + esc(note) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    return '<section class="card gc-audit ' + (major ? 'major' : 'minor') + '">' +
      '<div class="gc-card-head"><h2 class="gc-who">AI 감사</h2>' + mkHTML(a.mark) + '</div>' +
      row +
      (a.category ? '<p class="gc-cat"><span>오류 유형</span>' + esc(a.category) + '</p>' : '') +
      '<h3 class="mini">감사 의견</h3><p class="gc-text">' + esc(a.explanation || '—') + '</p>' + ev +
    '</section>';
  }
  function finalLineHTML(item) {
    var a = item.audit;
    var why = (a.mark === 'major' && a.corrected && a.corrected !== item.rater.verdict)
      ? 'AI 감사가 AI 채점의 「' + vLabel(item.rater.verdict) + '」을 「' + vLabel(a.corrected) + '」으로 보정했습니다.'
      : 'AI 채점의 판정을 AI 감사가 그대로 유지했습니다.';
    return '<section class="gc-final v-' + esc(item.final) + '" aria-label="AI 최종 판정">' +
      '<span class="gc-final-k">AI 최종 판정</span>' + vdHTML(item.final, 'big') +
      (verdictById(item.final) && verdictById(item.final).hint ? '<span class="gc-final-def">= ' + esc(verdictById(item.final).hint) + '</span>' : '') +
      '<span class="gc-final-why">' + esc(why) + '</span></section>';
  }
  function basisHTML(item) {
    if (!item.basis) return '';
    var notes = [];
    var main = String(item.basis).replace(/〔([^〕]*)〕/g, function (_, t) { notes.push(t); return ''; }).trim();
    var lines = main.split(/\s+\/\s+/).filter(function (x) { return x.trim(); });
    return '<details class="card gc-basis" data-track="basis"><summary>채점표 적용 근거</summary><div class="gc-basis-body">' +
      '<p class="small muted">이 환자·조합에 이 채점 요소를 어떻게 적용했는지에 대한 채점표의 설명입니다.</p>' +
      lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
      notes.map(function (n) { return '<p class="gc-note"><span>채점표 감사 메모</span>' + esc(n) + '</p>'; }).join('') +
    '</div></details>';
  }
  function patientLine(p) {
    var a1c = null;
    (p.labs || []).forEach(function (l) { if (!a1c && /HbA1c/i.test(l.name)) a1c = l; });
    return esc(p.demographics) + ' · ' + esc(p.visit_type) +
      (a1c ? ' · 현재 HbA1c <b>' + esc(a1c.values[a1c.values.length - 1]) + '</b>' : '');
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function segHTML(items, current) {
    return items.map(function (it, k) {
      var on = current === it.value;
      var tab = (on || (!current && k === 0)) ? 0 : -1;
      return '<button type="button" role="radio" tabindex="' + tab + '" data-value="' + esc(it.value) + '" aria-checked="' + on + '">' + esc(it.label) + '</button>';
    }).join('');
  }
  // 선택형 문항 (검증자 정보·마무리 문항 공통)
  function fieldHTML(f, cur, prefix) {
    var id = esc((prefix || '') + f.id);
    var lab = '<span class="label" id="lbl_' + id + '">' + esc(f.label) + (f.required ? '<span class="req">*</span>' : '') + '</span>';
    if (f.type === 'choice') {
      var opts = f.options.map(function (o) { return { value: o, label: o }; });
      var list = f.layout === 'list';
      return '<div class="field">' + lab + '<div class="seg' + (list ? ' list' : ' gc-seg') + '" role="radiogroup" aria-labelledby="lbl_' + id + '" data-field="' + esc(f.id) + '"' +
        (list ? '' : ' style="--n:' + opts.length + '"') + '>' + segHTML(opts, cur) + '</div></div>';
    }
    return '<div class="field">' + lab.replace('<span class="label"', '<label class="label" for="fld_' + id + '"').replace(/<\/span>$/, '</label>') +
      '<input class="input" type="text" maxlength="60" id="fld_' + id + '" data-field-text="' + esc(f.id) + '" value="' + esc(cur || '') + '"></div>';
  }

  function eligibilityHTML() {
    return '<section class="card" id="eligCard">' +
      '<h2 class="section-title">참여 자격</h2>' +
      '<p class="gc-q" id="eligQ">' + esc(ELIG.label) + '<span class="req">*</span></p>' +
      '<div class="gc-choice gc-elig" role="group" aria-labelledby="eligQ">' +
        '<button type="button" class="ch" data-elig="yes" aria-pressed="' + (draft.eligible === 'yes') + '">' + esc(ELIG.yes) + '</button>' +
        '<button type="button" class="ch" data-elig="no" aria-pressed="false">' + esc(ELIG.no) + '</button>' +
      '</div>' +
      '<p class="small muted" style="margin-top:8px">자기 보고로 확인합니다.</p>' +
    '</section>';
  }
  function partPickerHTML() {
    return '<div class="field gc-parts-field"><span class="label" id="partLabel">검증할 Part<span class="req">*</span></span>' +
      '<p class="small muted">하나를 골라 주세요. 각 Part는 가상 환자 2명에 대한 서로 다른 CDSS 답변 2건이며, 마친 뒤 다른 Part도 이어서 검증하실 수 있습니다.</p>' +
      '<div class="part-grid" role="group" aria-labelledby="partLabel">' +
      PARTS.map(function (p) {
        var done = draft.done_parts.indexOf(p.id) >= 0, n = partItemCount(p);
        return '<button type="button" class="part-card" data-part="' + esc(p.id) + '" aria-pressed="' + (!done && draft.part === p.id) + '"' + (done ? ' disabled' : '') + '>' +
          '<span class="pc-top"><b>' + esc(p.label) + '</b>' + (done ? '<span class="pc-done">완료</span>' : '<span class="radio-dot" aria-hidden="true"></span>') + '</span>' +
          '<span class="pc-n">판정 <b>' + n + '</b>건</span>' +
          '<span class="pc-sub">' + esc(minutesRange(n)) + ' · CDSS 답변 2건</span>' +
        '</button>';
      }).join('') + '</div></div>';
  }
  function consentHTML() {
    if (draft.consent_inherited) {
      return '<p class="notice" style="margin-top:18px">연구 참여 동의는 처음 검증 때 하신 동의를 그대로 사용합니다.</p>';
    }
    return '<div class="field" style="margin-top:18px"><label class="check"><input type="checkbox" id="evConsent"' + (draft.consent ? ' checked' : '') + '>' +
      '<span>본 검증의 목적을 이해했으며, 다음 정보가 연구 목적으로 수집·분석되는 데 동의합니다: 성명, 분과전문의 경력·근무 기관·진료 환자 수, ' +
      '판정과 의견, 응답 과정 정보(판정별 소요 시간, 접속 경로, 기기 종류). 분석과 발표에는 성명 대신 가명 코드를 사용합니다.' +
      (CFG.IRB_NO ? ' (IRB 승인번호: ' + esc(CFG.IRB_NO) + ')' : '') + '</span></label></div>';
  }
  function startBtnHTML() {
    return '<button type="button" class="btn btn-accent btn-block" id="startBtn" data-act="start" style="margin-top:18px">' +
      (starting ? '검증 준비 중…' : '검증 시작') + '</button>';
  }
  function evaluatorCardHTML() {
    return '<section class="card" id="evaluatorCard">' +
      '<h2 class="section-title">검증자 정보</h2>' +
      '<div class="field"><label for="evName">성명<span class="req">*</span></label>' +
        '<input class="input" id="evName" type="text" autocomplete="name" maxlength="40" placeholder="예: 홍길동" value="' + esc(draft.name) + '"></div>' +
      '<div id="profileFields">' + PROFILE.map(function (f) { return fieldHTML(f, draft.fields[f.id] || '', 'pf_'); }).join('') + '</div>' +
      partPickerHTML() + consentHTML() + startBtnHTML() +
    '</section>';
  }
  function continuationCardHTML() {
    var rows = PROFILE.map(function (f) {
      return '<li><span class="muted">' + esc(f.label) + '</span> — <b>' + esc(draft.fields[f.id] || '—') + '</b></li>';
    }).join('');
    return '<section class="card" id="evaluatorCard">' +
      '<h2 class="section-title">검증자 정보</h2>' +
      '<p><b>' + esc(draft.name) + '</b> 선생님</p>' +
      '<ul class="clean small gc-prof">' + rows + '</ul>' +
      '<p class="small muted" style="margin-top:6px">처음 검증 때 입력하신 정보를 그대로 사용합니다.</p>' +
      partPickerHTML() + consentHTML() + startBtnHTML() +
    '</section>';
  }

  function renderIntro() {
    var linked = !!draft.linked;
    var lp = partById(draft.part);
    elMain.innerHTML =
      '<section class="card hero">' +
        '<span class="eyebrow">AI 기반 T2D 임상 의사결정 지원 시스템</span>' +
        '<h1>가이드라인 부합도 검증</h1>' +
        '<p class="sub">Guideline Concordance · Physician Validation</p>' +
        '<p class="desc">AI가 CDSS 답변을 가이드라인 기준으로 채점한 결과 중, 다시 확인이 필요한 판정만 골라 분과전문의 선생님의 확인을 부탁드립니다.</p>' +
      '</section>' +
      (linked ? '<p class="notice info">이전 검증에 이어 ' + (lp ? '<b>' + esc(lp.label) + '</b>를 ' : '다른 Part를 ') +
        '검증합니다. 선생님 정보와 동의는 처음 응답을 그대로 사용합니다.</p>' : '') +
      '<section class="card">' +
        '<h2 class="section-title">어떻게 채점했나요</h2>' +
        '<ol class="flow">' +
          '<li><span><b>AI 채점</b> — AI 채점자(AI Rater)가 CDSS 답변을 가이드라인 기반 채점표의 요소마다 <b>충족</b> 또는 <b>감점</b>으로 판정했습니다. ' +
            '<b>충족</b> = 감점 사유 없음(감점 기준에 해당하지 않음), <b>감점</b> = 감점 기준에 해당함. 채점 요소의 제목은 대개 “… 누락”처럼 감점 사유를 적은 것입니다.</span></li>' +
          '<li><span><b>AI 감사</b> — 별도의 AI 감사가 모든 판정을 하나씩 다시 확인했습니다.</span></li>' +
          '<li><span><b>선별</b> — AI 감사가 <b>△ 미세한 오류</b> 또는 <b>✗ 중대한 오류</b>로 표시한 판정만 보여 드립니다. 문제없다고 확인된 판정은 AI 판정을 그대로 씁니다.</span></li>' +
          '<li><span><b>전문의 확인</b> — 판정마다 <b>AI 최종 판정</b>에 동의하시는지 골라 주세요. 비동의하시면 올바른 판정을 골라 주시면 됩니다.</span></li>' +
        '</ol>' +
        '<div class="gc-legend">' +
          '<div>' + mkHTML('minor') + '<span>판정은 맞지만 인용·사유에 결함이 있어, 원래 판정을 유지했습니다.</span></div>' +
          '<div>' + mkHTML('major') + '<span>판정이 틀렸다고 보아, AI 감사가 판정을 바꿨습니다(보정 판정).</span></div>' +
        '</div>' +
        '<ul class="clean small muted" style="margin-top:14px">' +
          '<li>답변을 만든 AI 시스템의 이름은 공개하지 않으며 “답변 1·답변 2”로 표시합니다.</li>' +
          '<li>판정 화면 위쪽 <b>[환자 정보]</b> 버튼으로 환자 기록을 언제든 볼 수 있습니다.</li>' +
          '<li>창을 닫아도 같은 기기·브라우저에서 다시 열면 이어서 진행됩니다.</li>' +
        '</ul>' +
      '</section>' +
      (linked ? continuationCardHTML()
        : eligibilityHTML() + '<div id="evalHost">' + (draft.eligible === 'yes' ? evaluatorCardHTML() : '') + '</div>');
    elDock.innerHTML = '';
    sendView();
  }

  function renderBlocked() {
    elMain.innerHTML =
      '<section class="card gc-blocked" id="blocked">' +
        '<span class="eyebrow">참여 대상 안내</span>' +
        '<h1>참여해 주셔서 감사합니다</h1>' +
        '<p class="lead" style="margin-top:8px">' + esc(ELIG.blocked) + '</p>' +
        '<p class="small muted" style="margin-top:10px">AI 답변의 임상 수용성 평가는 다른 진료과 의사 선생님도 참여하실 수 있습니다.</p>' +
        '<div class="btn-row" style="margin-top:16px">' +
          '<a class="btn btn-primary" href="../" id="toCaLink">임상 수용성 평가로 이동</a>' +
          '<button type="button" class="btn btn-ghost" data-act="elig-back">← 답을 잘못 고르셨다면</button>' +
        '</div>' +
      '</section>';
    elDock.innerHTML = '';
  }

  function renderStarting() {
    elMain.innerHTML = '<section class="card"><p class="status-line pending"><span class="dot"></span>검증을 준비하고 있습니다…</p></section>';
    elDock.innerHTML = '';
  }

  function seenNote(patient, u) {
    for (var i = 0; i < u; i++) if (G.units[S.order[i]].patient === patient) {
      return '<p class="notice info">이 환자는 <b>답변 ' + (i + 1) + '</b>에서 이미 보셨습니다. 이번에는 <b>다른 CDSS 답변</b>입니다.</p>';
    }
    if ((S.prev_patients || []).indexOf(patient) >= 0) {
      return '<p class="notice info">이 환자는 <b>이전 Part</b>에서 이미 보셨습니다. 이번에는 <b>다른 CDSS 답변</b>입니다.</p>';
    }
    return '';
  }

  function renderUnitMain() {
    var st = curStep(), key = S.order[st.u];
    var out = DATA.outputs[key], p = DATA.patients[out.patient];
    var items = unitItems(key);
    var byCombo = {};
    items.forEach(function (it) { byCombo[it.combo] = (byCombo[it.combo] || 0) + 1; });
    var nBefore = itemOrder(st.u, 0) - 1;
    elMain.innerHTML =
      '<div class="case-head"><span class="pill navy">답변 ' + (st.u + 1) + ' / ' + nUnits() + '</span>' +
        '<span class="pill">판정 ' + (nBefore + 1) + '–' + (nBefore + items.length) + ' / ' + totalItems() + '</span></div>' +
      '<h1 class="gc-h1">답변 ' + (st.u + 1) + ' — 확인할 판정 ' + items.length + '건</h1>' +
      '<p class="lead">가상 환자 <b>' + esc(out.patient) + '</b>에 대한 CDSS 답변입니다. 이 답변의 AI 판정 중 AI 감사가 표시한 <b>' + items.length + '건</b>을 차례로 확인합니다.</p>' +
      seenNote(out.patient, st.u) +
      '<section class="card gc-pt">' +
        '<div class="pt-head"><span class="pt-id">' + esc(p.id) + '</span><span class="gc-pt-line">' + patientLine(p) + '</span></div>' +
        '<p class="small" style="margin-top:6px"><span class="muted">내원 이유</span> ' + esc(p.visit_reason) + '</p>' +
        '<button type="button" class="btn btn-ghost gc-pt-btn" data-act="patient">환자 정보 전체 보기</button>' +
      '</section>' +
      (byCombo[0] ? '<section class="card tight gc-p1"><b>Phase 1 · 환자 분류 및 의뢰</b><span class="gc-cnt">판정 ' + byCombo[0] + '건</span></section>' : '') +
      '<h2 class="section-title" style="margin-top:20px">CDSS가 제시한 약물 조합 3개</h2>' +
      '<p class="small muted" style="margin-top:-4px">각 판정은 해당 조합의 답변을 기준으로 합니다. 처방 내용은 판정 화면에서 펼쳐 볼 수 있습니다.</p>' +
      '<div class="gc-combos">' + out.combinations.map(function (cb, i) {
        var n = byCombo[i + 1] || 0;
        return '<article class="gc-combo' + (n ? '' : ' none') + '">' +
          '<header class="cc-head"><span class="cc-no">조합 ' + (i + 1) + '</span>' +
            '<span class="gc-cnt' + (n ? '' : ' zero') + '">' + (n ? '판정 ' + n + '건' : '확인할 판정 없음') + '</span></header>' +
          drugChipsHTML(cb) + '</article>';
      }).join('') + '</div>';
  }

  function renderItemMain() {
    var st = curStep(), item = curItem(), key = S.order[st.u];
    var out = DATA.outputs[key];
    var cb = item.combo ? out.combinations[item.combo - 1] : null;
    var ord = itemOrder(st.u, st.i), tot = totalItems();
    elMain.innerHTML =
      '<div class="case-head">' +
        '<span class="pill navy">판정 ' + ord + ' / ' + tot + '</span>' +
        '<span class="pill">답변 ' + (st.u + 1) + ' · 환자 ' + esc(item.patient) + '</span>' +
        '<span class="pill teal">' + (item.combo ? '조합 ' + item.combo : 'Phase 1') + ' · 답 ' + esc(item.question) + '</span>' +
      '</div>' +
      '<section class="card gc-elem">' +
        '<div class="gc-elem-top"><span class="gc-elem-id">' + esc(item.element) + '</span><span class="gc-elem-k">채점 요소</span></div>' +
        '<h1 class="gc-title">' + esc(item.title) + '</h1>' +
        pathHTML(item) +
      '</section>' +
      criterionHTML(item) +
      answerCardHTML(item, out, cb) +
      raterCardHTML(item, out) +
      auditCardHTML(item, out) +
      finalLineHTML(item) +
      basisHTML(item);
    // 감점 기준이 4줄 이하로 끝나면 '전체 보기' 버튼은 숨김
    var crit = $('gcCrit'), btn = elMain.querySelector('[data-act="crit"]');
    if (crit && btn && !ui.critOpen && crit.scrollHeight <= crit.clientHeight + 2) btn.hidden = true;
  }

  function renderDock() {
    if (!S || S.screen !== 'eval' || staleTab || !S.order) { elDock.innerHTML = ''; return; }
    var st = curStep();
    var back = (S.stepIdx > 0 && !S.review) ? '<button type="button" class="btn btn-ghost" data-act="back">이전</button>' : '';
    var nav = function (label, enabled) {
      return '<div class="dock-nav' + (back ? '' : ' single') + '">' + back +
        '<button type="button" class="btn btn-primary" data-act="next"' + (enabled ? '' : ' aria-disabled="true"') + '>' + label + '</button></div>';
    };
    var html = '<div class="dock-inner">';
    if (st.i < 0) {
      var n = unitItems(S.order[st.u]).length;
      html += '<div class="dock-kicker"><span>답변 ' + (st.u + 1) + ' / ' + nUnits() + '</span></div>' +
        '<p class="dock-msg">이 답변에서 확인할 판정은 <b>' + n + '건</b>입니다. 환자 기록은 언제든 위쪽 [환자 정보]로 볼 수 있습니다.</p>' +
        nav('판정 시작 →', true);
    } else {
      var item = curItem(), j = jm(item), ord = itemOrder(st.u, st.i), tot = totalItems();
      var hint = j.agree === null ? '동의 여부를 골라 주세요' : (j.agree === false && !j.alt_verdict ? '올바른 판정을 골라 주세요' : '');
      html += '<div class="dock-kicker"><span>판정 ' + ord + ' / ' + tot + '</span><span class="req-hint">' + hint + '</span></div>' +
        '<p class="dock-statement gc-ask" id="gcAsk">AI 최종 판정 ' + vdHTML(item.final) + '에 동의하십니까?</p>' +
        '<div class="gc-choice" role="group" aria-labelledby="gcAsk">' +
          '<button type="button" class="ch agree" data-agree="1" aria-pressed="' + (j.agree === true) + '">동의</button>' +
          '<button type="button" class="ch disagree" data-agree="0" aria-pressed="' + (j.agree === false) + '">비동의</button>' +
        '</div>';
      if (j.agree === false) {
        var alts = VERDICTS.filter(function (v) { return v.id !== item.final; });
        html += '<div class="gc-alt">' +
          '<p class="gc-alt-k" id="gcAltK">올바른 판정<span class="req">*</span></p>' +
          '<div class="gc-choice alt" role="group" aria-labelledby="gcAltK">' + alts.map(function (v) {
            return '<button type="button" class="ch alt v-' + esc(v.id) + '" data-alt="' + esc(v.id) + '" aria-pressed="' + (j.alt_verdict === v.id) + '">' +
              '<b>' + esc(v.label) + '</b>' + (v.hint ? '<small>' + esc(v.hint) + '</small>' : '') + '</button>';
          }).join('') + '</div>' +
          '<label class="gc-alt-k" for="gcComment">의견 <span class="muted">(선택)</span></label>' +
          '<textarea class="input gc-comment" id="gcComment" rows="2" maxlength="2000" placeholder="' +
            (shortDock() ? '다르게 보신 이유 한 줄 (선택)' : '왜 다르게 보시는지 한 줄만 남겨 주시면 판정을 확정하는 데 큰 도움이 됩니다.') + '">' +
            esc(j.comment || '') + '</textarea>' +
        '</div>';
      }
      html += nav(S.review ? '저장하고 요약으로 →' : (ord === tot ? '다음: 마무리 →' : '다음 →'), jComplete(j));
    }
    html += '</div>';
    elDock.innerHTML = html;
    updateDockSize();
  }

  elDock.addEventListener('click', function (e) {
    if (!elDrawer.hidden || staleTab) return;
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-agree')) { setAgree(b.getAttribute('data-agree') === '1'); return; }
    if (b.hasAttribute('data-alt')) { setAlt(b.getAttribute('data-alt')); return; }
    var act = b.getAttribute('data-act');
    if (act === 'next') goNext();
    else if (act === 'back') goBack();
  });
  elDock.addEventListener('input', function (e) {
    if (e.target.id !== 'gcComment' || !onItem()) return;
    jm(curItem()).comment = e.target.value;
    saveSoon();
  });

  function recapHTML() {
    var rows = [];
    STEPS.forEach(function (st, idx) {
      if (st.i < 0) {
        rows.push('<li class="gc-recap-unit">답변 ' + (st.u + 1) + ' · 환자 ' + esc(G.units[S.order[st.u]].patient) + '</li>');
        return;
      }
      var it = unitItems(S.order[st.u])[st.i], j = S.judgments[it.id];
      var res = !jComplete(j) ? '<span class="muted">미확인</span>'
        : j.agree ? '<span class="gc-res agree">동의</span>' + vdHTML(it.final)
          : '<span class="gc-res disagree">비동의</span>' + vdHTML(j.alt_verdict);
      rows.push('<li class="gc-recap-row"><span class="gc-r-no">' + itemOrder(st.u, st.i) + '</span>' +
        '<span class="gc-r-t"><b>' + esc(it.element) + '</b> ' + (it.combo ? '조합 ' + it.combo : 'Phase 1') + ' · ' + esc(it.title) + '</span>' +
        '<span class="gc-r-res">' + res + '</span>' +
        '<button type="button" class="link-btn" data-edit="' + idx + '" aria-label="판정 ' + itemOrder(st.u, st.i) + ' 수정">수정</button></li>');
    });
    return '<ul class="gc-recap">' + rows.join('') + '</ul>';
  }

  function renderFinal() {
    var c = counts();
    elMain.innerHTML =
      '<section class="card"><span class="eyebrow">마지막 단계</span>' +
        '<h1 class="gc-h1" style="margin-top:6px">판정 ' + c.total + '건을 모두 확인하셨습니다</h1>' +
        '<p class="lead" style="margin-top:6px">아래 문항에 답하신 뒤 <b>검증 제출</b>을 눌러 주세요.</p>' +
        '<div class="stat-row" style="margin-top:14px">' +
          '<div class="stat"><b>' + c.agree + '</b><span>동의</span></div>' +
          '<div class="stat"><b>' + c.disagree + '</b><span>비동의</span></div>' +
        '</div></section>' +
      (END_ITEMS.length ? '<section class="card sub-items"><span class="sub-tag">마무리 문항</span><div id="endItems" style="margin-top:6px">' +
        END_ITEMS.map(function (f) { return fieldHTML(f, (S.end_items[f.id] || {}).value || '', 'ei_'); }).join('') + '</div></section>' : '') +
      '<section class="card"><div class="field"><label for="overallComment">전반적인 의견 (선택)</label>' +
        '<p class="small muted">AI 채점·AI 감사 방식, 채점표, 이번 검증 방식에 대해 하실 말씀이 있으면 적어 주세요.</p>' +
        '<textarea class="input" id="overallComment" maxlength="5000">' + esc(S.overall_comment) + '</textarea>' +
        '<div class="char-count" id="ocCount">' + S.overall_comment.length + ' / 5000</div></div>' +
        '<button type="button" class="btn btn-accent btn-block" id="submitBtn" data-act="submit" style="margin-top:14px">검증 제출</button></section>' +
      '<section class="card"><h2 class="section-title">판정 요약</h2>' +
        '<p class="small muted">고치실 판정이 있으면 [수정]을 눌러 주세요. 고친 뒤 이 화면으로 돌아옵니다.</p>' + recapHTML() + '</section>';
    elDock.innerHTML = '';
  }

  function downloadJSON() {
    var payload = {
      study_id: S.study_id, app_version: S.app_version, data_version: S.data_version,
      instrument_version: CFG.INSTRUMENT_VERSION || '',
      session_id: S.session_id, is_test: S.is_test, evaluator: S.evaluator, evaluator_id: S.evaluator_id,
      part: S.part, sequence_index: S.seq_index, seq_source: S.seq_source, order: S.order,
      session_ordinal: S.session_ordinal, linked_session_id: S.linked_session_id,
      entry: S.entry, consent: S.consent, device: S.device,
      session: sessionSummary(), end_items: S.end_items || {}, overall_comment: S.overall_comment,
      judgments: allJudgments()
    };
    payload.units_blinded = true;   // 답변 식별자는 '환자_답변N'(N = 이 Part 의 제시 순서). 원래 답변은 Part·환자 번호로 연결됨
    var text = JSON.stringify(payload, null, 2);
    (S.order || []).forEach(function (k, u) {
      var unit = G.units[k] || {};
      text = text.split(k).join((unit.patient || 'P') + '_답변' + (u + 1));
    });
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'guideline-concordance_' + (S.evaluator.name || 'anon') + '_Part' + S.part + '_' + S.session_id.slice(0, 8) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function renderDone() {
    var sum = sessionSummary(), c = counts();
    var status;
    if (!CFG.ENDPOINT) {
      status = '<p class="status-line pending"><span class="dot"></span>테스트 모드: 서버 주소(ENDPOINT)가 설정되지 않아 응답이 전송되지 않았습니다.</p>' +
        '<p class="small muted" style="margin-top:6px">아래 버튼으로 응답 파일(JSON)을 내려받을 수 있습니다.</p>';
    } else if (!S.outbox.length && S.net.status !== 'sending') {
      status = '<p class="status-line ok"><span class="dot"></span>응답이 안전하게 저장되었습니다.</p>';
    } else if (S.net.status === 'fail' || !flushing) {
      status = '<p class="status-line fail"><span class="dot"></span>전송하지 못한 응답이 있습니다 (' + S.outbox.length + '건).</p>' +
        '<p class="small muted" style="margin-top:6px">네트워크 연결을 확인한 뒤 [다시 전송]을 눌러 주세요. 응답은 이 기기에 보관되어 있으며, 응답 파일을 내려받아 연구진에게 보내 주셔도 됩니다.' +
        (S.net.last_error ? ' (' + esc(S.net.last_error) + ')' : '') + '</p>';
    } else {
      status = '<p class="status-line pending"><span class="dot"></span>응답을 전송하고 있습니다…</p>';
    }
    var showRetry = !!(CFG.ENDPOINT && S.outbox.length && (S.net.status === 'fail' || !flushing));
    var showDl = !CFG.ENDPOINT || showRetry || S.is_test;
    var done = (S.done_parts || []).concat([S.part]);
    var others = PARTS.filter(function (p) { return done.indexOf(p.id) < 0; });
    var part = partById(S.part) || {};
    elMain.innerHTML =
      '<section class="card hero"><span class="eyebrow">완료</span><h1>검증해 주셔서 감사합니다</h1>' +
        '<p class="desc">' + esc(S.evaluator.name) + ' 선생님 · ' + esc(part.label || '') + ' 판정 ' + c.done + '건이 기록되었습니다.</p></section>' +
      '<section class="card">' + status +
        '<div class="stat-row" style="margin-top:14px">' +
          '<div class="stat"><b>' + c.done + ' / ' + c.total + '</b><span>확인한 판정</span></div>' +
          '<div class="stat"><b>' + c.agree + ' · ' + c.disagree + '</b><span>동의 · 비동의</span></div>' +
          '<div class="stat"><b>' + fmtMin(sum.total_active_ms + sum.total_idle_ms) + '</b><span>총 소요 시간</span></div>' +
        '</div>' +
        ((showRetry || showDl) ? '<div class="btn-row" style="margin-top:16px">' +
          (showRetry ? '<button type="button" class="btn btn-primary" id="retryBtn" data-act="retry">다시 전송</button>' : '') +
          (showDl ? '<button type="button" class="btn btn-ghost" id="dlBtn" data-act="download">응답 파일(JSON) 내려받기</button>' : '') +
        '</div>' : '') +
      '</section>' +
      (others.length ? '<section class="card gc-next"><h2 class="section-title">다른 Part 이어서 검증하기</h2>' +
        '<p class="small muted">같은 검증자 정보와 동의로 바로 이어서 하실 수 있습니다. 같은 환자에 대한 <b>다른 CDSS 답변</b>입니다.</p>' +
        '<div class="btn-row" style="margin-top:10px">' + others.map(function (p) {
          var n = partItemCount(p);
          return '<button type="button" class="btn btn-accent" data-next-part="' + esc(p.id) + '">' + esc(p.label) + ' 이어서 검증하기 <span class="gc-btn-sub">판정 ' + n + '건 · ' + esc(minutesRange(n)) + '</span></button>';
        }).join('') + '</div></section>' : '') +
      '<section class="card"><p class="small muted">이 기기에서 다른 선생님이 검증하시려면 아래 버튼을 눌러 새로 시작해 주세요.</p>' +
        '<button type="button" class="btn btn-ghost" id="newBtn" data-act="new" style="margin-top:10px">새 검증 시작</button></section>';
    elDock.innerHTML = '';
  }

  function restart(nextPart) {
    if (!S) return;
    var unsent = (S.outbox || []).slice();
    if (!nextPart) {
      if (unsent.length && CFG.ENDPOINT) {
        if (!window.confirm('아직 전송되지 않은 응답이 있습니다. 새로 시작하면 이 기기에 보관된 응답이 삭제됩니다. 계속하시겠습니까?')) return;
      } else if (!window.confirm('새 검증을 시작하시겠습니까?')) return;
    }
    var prev = S;
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    S = null;
    STEPS = [];
    flushing = false;
    lastRev = 0;
    draft = emptyDraft();
    if (nextPart) {
      draft.eligible = 'yes';
      draft.name = prev.evaluator.name;
      PROFILE.forEach(function (f) { draft.fields[f.id] = (prev.evaluator.fields || {})[f.id] || ''; });
      draft.part = nextPart;
      draft.consent = true; draft.consent_at = (prev.consent || {}).at || nowIso(); draft.consent_inherited = true;
      draft.linked = prev.session_id;
      draft.done_parts = (prev.done_parts || []).concat([prev.part]);
      draft.evaluator_id = prev.evaluator_id || null;
      draft.prev_patients = (prev.prev_patients || []).concat(prev.order.map(function (k) { return G.units[k].patient; }));
      draft.pending = CFG.ENDPOINT ? unsent : [];   // 못 보낸 응답은 다음 Part 세션의 보관함으로 옮겨 계속 전송
      saveDraft();
    }
    T.last = performance.now();
    render();
    window.scrollTo(0, 0);
    if (nextPart && $('evaluatorCard')) $('evaluatorCard').scrollIntoView({ block: 'start' });
    focusTop();
  }

  function updateTopbar() {
    var label = '', pct = 0, showPatient = false;
    if (staleTab) { label = ''; }
    else if (S && S.screen === 'eval' && S.order) {
      var st = curStep();
      label = '답변 ' + (st.u + 1) + '/' + nUnits() + ' · ' + (st.i >= 0 ? '판정 ' + itemOrder(st.u, st.i) + '/' + totalItems() : '시작');
      pct = S.stepIdx / STEPS.length * 100;
      showPatient = true;
    } else if (S && S.screen === 'final') { label = '제출 전'; pct = 100; }
    else if (S && S.screen === 'done') { label = '완료'; pct = 100; }
    $('topbar').classList.toggle('in-case', !!(S && S.screen === 'eval'));
    elTopProg.textContent = label;
    elFill.style.width = pct + '%';
    elPatientBtn.hidden = !showPatient;
  }

  // gc.css 의 '휴대폰(높이 ≤ 700px)' 규칙과 같은 조건: 의견 칸이 한 줄이라 안내문을 짧게
  function shortDock() {
    try { return window.matchMedia('(max-height: 700px) and (max-width: 1023px)').matches; } catch (e) { return false; }
  }
  function dockIsFixed() { return getComputedStyle(elDock).position === 'fixed'; }
  function updateDockSize() {
    var h = (elDock.innerHTML && dockIsFixed()) ? elDock.offsetHeight : 0;
    document.documentElement.style.setProperty('--dock-h', h + 'px');
  }
  if (window.ResizeObserver) new ResizeObserver(updateDockSize).observe(elDock);
  window.addEventListener('resize', updateDockSize);

  function renderStale() {
    elMain.innerHTML =
      '<section class="card"><span class="eyebrow">다른 탭에서 진행 중</span>' +
        '<h1 class="gc-h1" style="margin-top:6px">이 검증은 다른 탭(창)에서 이어서 진행되고 있습니다</h1>' +
        '<p class="lead" style="margin-top:8px">응답이 섞이지 않도록 이 탭은 멈췄습니다. 이 탭을 닫거나, 이 탭에서 계속하려면 아래 버튼을 눌러 주세요. ' +
        '(다른 탭은 자동으로 멈춥니다.)</p>' +
        '<button type="button" class="btn btn-primary" data-act="takeover" style="margin-top:14px">이 탭에서 이어서 하기</button></section>';
    elDock.innerHTML = '';
  }

  function render() {
    var testMode = (S ? S.is_test : (URL_TEST || !CFG.ENDPOINT));
    elTestBanner.hidden = !testMode;
    elTestBanner.textContent = !CFG.ENDPOINT
      ? '테스트 모드 — 서버 주소가 설정되지 않아 응답이 서버로 전송되지 않습니다.'
      : '테스트 응답 — 이 응답은 분석에서 제외되도록 표시됩니다.';

    if (staleTab) renderStale();
    else if (!S) { if (draft.eligible === 'no') renderBlocked(); else renderIntro(); }
    else if (S.screen === 'starting') renderStarting();
    else if (S.screen === 'eval') { if (curItem()) renderItemMain(); else renderUnitMain(); renderDock(); }
    else if (S.screen === 'final') renderFinal();
    else if (S.screen === 'done') renderDone();
    elLayout.classList.toggle('no-dock', !elDock.innerHTML);
    updateTopbar();
    updateDockSize();
  }

  // ---------------------------------------------------------------------------
  // Main-area events (one delegated listener per event type; screens re-render innerHTML)
  // ---------------------------------------------------------------------------
  function segSelect(seg, b) {
    Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) {
      x.setAttribute('aria-checked', String(x === b));
      x.setAttribute('tabindex', x === b ? '0' : '-1');
    });
  }
  function pickSeg(b) {
    var seg = b.parentNode, fid = seg.getAttribute('data-field'), val = b.getAttribute('data-value');
    if (staleTab) return;
    segSelect(seg, b);
    if (!S) { draft.fields[fid] = val; saveDraft(); }
    else if (S.screen === 'final' && END_BY_ID[fid]) {
      S.end_items[fid] = { value: val, code: fieldCode(END_BY_ID[fid], val) };
      save();
    }
  }
  function setElig(v) {
    if (S) return;
    if (v === 'no') {
      draft.eligible = 'no';
      render(); window.scrollTo(0, 0); focusTop();
      return;
    }
    var first = draft.eligible !== 'yes';
    draft.eligible = 'yes';
    Array.prototype.forEach.call(elMain.querySelectorAll('[data-elig]'), function (x) {
      x.setAttribute('aria-pressed', String(x.getAttribute('data-elig') === 'yes'));
    });
    if (first && $('evalHost')) {
      $('evalHost').innerHTML = evaluatorCardHTML();
      var card = $('evaluatorCard');
      if (card && card.scrollIntoView) card.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
    }
  }
  function setPart(id) {
    if (S || !partById(id) || draft.done_parts.indexOf(id) >= 0) return;
    draft.part = id;
    Array.prototype.forEach.call(elMain.querySelectorAll('[data-part]'), function (x) {
      x.setAttribute('aria-pressed', String(!x.disabled && x.getAttribute('data-part') === id));
    });
    saveDraft();
  }
  function trackOpen(kind) {
    if (!onItem()) return;
    var j = jm(curItem());
    if (!j.opened[kind]) { j.opened[kind] = true; saveSoon(); }
  }

  elMain.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || !elMain.contains(b) || b.disabled) return;
    if (b.getAttribute('data-act') === 'takeover') { location.reload(); return; }
    if (staleTab) return;
    if (b.hasAttribute('data-elig')) { setElig(b.getAttribute('data-elig')); return; }
    if (b.hasAttribute('data-part')) { setPart(b.getAttribute('data-part')); return; }
    if (b.getAttribute('role') === 'radio' && b.parentNode.hasAttribute('data-field')) { pickSeg(b); return; }
    if (b.hasAttribute('data-edit')) { editFromFinal(Number(b.getAttribute('data-edit'))); return; }
    if (b.hasAttribute('data-next-part')) { restart(b.getAttribute('data-next-part')); return; }
    var act = b.getAttribute('data-act');
    if (act === 'start') startSession();
    else if (act === 'elig-back') { draft.eligible = ''; render(); window.scrollTo(0, 0); var eb = elMain.querySelector('[data-elig="yes"]'); if (eb) eb.focus(); }
    else if (act === 'patient') openDrawer();
    else if (act === 'crit') {
      ui.critOpen = !ui.critOpen;
      $('gcCrit').classList.toggle('open', ui.critOpen);
      b.setAttribute('aria-expanded', String(ui.critOpen));
      b.textContent = ui.critOpen ? '접기' : '전체 보기';
      if (ui.critOpen) trackOpen('criterion');
    }
    else if (act === 'submit') goNext();
    else if (act === 'retry') flush();
    else if (act === 'download') downloadJSON();
    else if (act === 'new') restart(null);
  });
  elMain.addEventListener('keydown', function (e) {
    var b = e.target.closest && e.target.closest('.seg button[role="radio"]');
    if (!b) return;
    var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    var all = Array.prototype.slice.call(b.parentNode.querySelectorAll('button'));
    var nb = all[(all.indexOf(b) + d + all.length) % all.length];
    pickSeg(nb); nb.focus();
  });
  elMain.addEventListener('input', function (e) {
    var t = e.target;
    if (staleTab) return;
    if (t.id === 'evName') { draft.name = t.value; saveDraft(); }
    else if (t.hasAttribute('data-field-text') && !S) { draft.fields[t.getAttribute('data-field-text')] = t.value; saveDraft(); }
    else if (t.id === 'overallComment' && S) {
      S.overall_comment = t.value;
      var cc = $('ocCount'); if (cc) cc.textContent = t.value.length + ' / 5000';
      saveSoon();
    }
  });
  elMain.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'evConsent') {
      draft.consent = t.checked; draft.consent_at = t.checked ? nowIso() : null; draft.consent_inherited = false;
    }
  });
  // <details> 펼침 기록 (toggle 은 버블링되지 않으므로 capture 단계에서 받음)
  elMain.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || d.tagName !== 'DETAILS' || !d.open) return;
    var k = d.getAttribute('data-track');
    if (k) trackOpen(k);
  }, true);

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (S && S.screen === 'starting') {
    // 순서 배정 도중 창이 닫힌 경우: 처음부터
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    S = null; STEPS = [];
  }
  if (!S) draft = loadDraft() || emptyDraft();
  if (S && (S.screen === 'eval' || S.screen === 'final')) {
    S.metrics.resumes += 1;
    S.device.last_resume = deviceInfo();
    save();
    setTimeout(function () { toast('이전에 진행하던 검증을 불러왔습니다.', 3200); }, 300);
  }
  render();
  if (S && S.screen === 'eval' && curItem()) { jm(curItem()).visits += 1; save(); }
  if (S) flush();

  // expose minimal hooks for QA (no PII beyond what the page shows)
  window.__GC_APP__ = { version: CFG.APP_VERSION, state: function () { return S; }, steps: function () { return STEPS; } };
})();
