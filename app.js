/* 임상 수용성 평가 (Physician Clinical Acceptability Assessment) — app */
(function () {
  'use strict';

  var CFG = window.T2D_CONFIG;
  var DATA = window.T2D_DATA;
  var STORE_KEY = 't2d-ca:' + CFG.STUDY_ID + ':v3';
  var IDLE_MS = 180000;          // 3분 이상 조작이 없으면 idle 로 분류
  var START_TIMEOUT_MS = 15000;  // 순서 배정 요청 대기 한도 (Apps Script 첫 호출 지연 고려)
  var POST_TIMEOUT_MS = 30000;
  var NAV_LOCK_MS = 450;         // 화면 전환 직후 연속 탭으로 단계를 건너뛰지 않도록

  var params = new URLSearchParams(location.search);
  var URL_TEST = params.get('test') === '1';
  if (params.get('reset') === '1') {
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    var keep = new URLSearchParams(location.search); keep.delete('reset');   // src·site·wave·test 는 유지
    history.replaceState(null, '', location.pathname + (keep.toString() ? '?' + keep.toString() : ''));
  }

  // ---------------------------------------------------------------------------
  // Study definitions
  // ---------------------------------------------------------------------------
  var SCALE = [
    { v: 1, label: '전혀 그렇지 않다' },
    { v: 2, label: '그렇지 않다' },
    { v: 3, label: '보통이다' },
    { v: 4, label: '그렇다' },
    { v: 5, label: '매우 그렇다' }
  ];

  var PHASES = {
    p1: {
      num: 'Phase 1', title: '환자 분류 및 의뢰', en: 'Patient classification and referral',
      statement: 'AI가 제공한 환자 분류 및 의뢰 권장 사항은 의뢰 여부 결정(referral decision)에 유의미한 참고가 된다.',
      short: '의뢰 여부 결정',
      items: [['1.1', '의뢰 판단'], ['1.2', '환자 평가']]
    },
    p2: {
      num: 'Phase 2', title: '약물 조합 추천 요약', en: 'Drug-combination summary',
      statement: 'AI가 제공한 약물 조합 추천 요약은 환자와의 공유 의사결정(shared decision-making)에 유의미한 참고가 된다.',
      short: '공유 의사결정',
      items: [['2.1', '효능'], ['2.2', '안전성'], ['2.3', '실행 가능성']]
    },
    p3: {
      num: 'Phase 3', title: '약물 선택 시 고려사항', en: 'Drug-selection considerations',
      statement: 'AI가 제공한 약물 선택 시 고려사항은 약물 처방 결정(pharmacotherapy decision)에 유의미한 참고가 된다.',
      short: '약물 처방 결정',
      items: [['3.1', '동반질환 기반 선택'], ['3.2', '체중 및 BMI'], ['3.3', 'HbA1c 목표'], ['3.4', '용량'],
        ['3.5', '금기 및 주의사항'], ['3.6', '복약 순응도'], ['3.7', '비용 및 급여'], ['3.8', '비당뇨 약물 및 상호작용']]
    },
    p4: {
      num: 'Phase 4', title: '추적관찰 및 모니터링', en: 'Follow-up and monitoring',
      statement: 'AI가 제공한 추적관찰 계획은 환자의 추적관찰(follow-up monitoring) 계획 수립에 유의미한 참고가 된다.',
      short: '추적관찰 계획 수립',
      items: [['4.1', '추적 시기'], ['4.2', '평가 항목'], ['4.3', '이상반응 모니터링']]
    },
    p5: {
      num: 'Phase 5', title: '환자 교육', en: 'Patient education',
      statement: 'AI가 제공한 환자교육 자료는 실제 환자 교육(patient education)에 유의미한 참고가 된다.',
      short: '환자 교육',
      items: [['5.1', '자가 혈당 측정'], ['5.2', '합병증 관리'], ['5.3', '약물 및 주사 교육'], ['5.4', '생활습관 및 응급 대응']]
    }
  };
  var PHASE_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5'];
  var STEPS = ['vignette', 'p1', 'combo', 'p2', 'p3', 'p4', 'p5', 'comment'];
  var STEP_LABEL = {
    vignette: '환자 정보', p1: 'Phase 1', combo: '조합 선택', p2: 'Phase 2', p3: 'Phase 3',
    p4: 'Phase 4', p5: 'Phase 5', comment: '의견'
  };
  var ROLES = CFG.EVALUATOR_ROLES;
  var TYPES = CFG.STUDY_TYPES;
  function roleById(id) { for (var i = 0; i < ROLES.length; i++) if (ROLES[i].id === id) return ROLES[i]; return null; }
  function typeById(id) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i]; return null; }
  var URL_TYPE = typeById(String(params.get('type') || '').toUpperCase()) ? String(params.get('type')).toUpperCase() : '';
  var COMMON = CFG.COMMON_FIELDS || [];
  var CASE_ITEMS = CFG.CASE_ITEMS || [];
  var END_ITEMS = CFG.END_ITEMS || [];
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
    type_preselected: !!URL_TYPE, type_param: URL_TYPE, in_app: IN_APP, referrer_origin: REF_ORIGIN
  };
  var DEVICE_ID = (function () {
    var k = 't2d-ca:device';
    try { var v = localStorage.getItem(k); if (!v) { v = uuid(); localStorage.setItem(k, v); } return v; } catch (_) { return uuid(); }
  })();
  var VISIT_ID = uuid();
  function fieldCode(f, raw) {
    if (f.type !== 'choice') return '';
    var i = f.options.indexOf(raw);
    if (i >= 0) return i + 1;
    return (f.other && raw === f.other) ? f.options.length + 1 : '';
  }
  function textLen(x) {
    if (x == null) return 0;
    if (typeof x === 'string') return x.length;
    if (typeof x === 'number') return String(x).length;
    if (Array.isArray(x)) return x.reduce(function (a, y) { return a + textLen(y); }, 0);
    return Object.keys(x).reduce(function (a, k) { return a + textLen(x[k]); }, 0);
  }
  function nCases() { return (S && S.order) ? S.order.length : 2; }
  function totalSteps() { return nCases() * STEPS.length; }
  function typeSeqs() { var t = S && typeById(S.study_type); return t ? t.sequences : TYPES[0].sequences; }

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

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  function emptyStepMetrics() {
    return {
      active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0, visits: 0, first_enter: null,
      ttfr_ms: null, changes: 0, history: [], scroll_max: 0, scroll_at_fr: null, drawer_opens: 0, drawer_ms: 0, interruptions: 0
    };
  }
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

  function newState(evaluator, studyType, linkedSession) {
    return {
      v: 1,
      study_id: CFG.STUDY_ID,
      app_version: CFG.APP_VERSION,
      data_version: DATA.data_version,
      session_id: uuid(),
      is_test: URL_TEST || !CFG.ENDPOINT,
      evaluator: evaluator,
      study_type: studyType,
      linked_session_id: linkedSession || null,
      created_at: nowIso(),
      started_at: null, finished_at: null,
      screen: 'intro',
      seq_index: null, seq_source: null, order: null,
      caseIdx: 0, stepIdx: 0,
      cases: [],
      overall_comment: '',
      metrics: { intro: emptyBucket(), final: emptyBucket(), active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0, resumes: 0, interruptions: 0, send_failures: 0 },
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
      if (!s || s.v !== 1) return null;
      if (s.order && s.order.some(function (k) { return !DATA.outputs[k]; })) return null;
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
      name: '', role: '', fields: {}, other: {}, type: URL_TYPE, consent: false, consent_at: null, consent_inherited: false,
      linked: null, done_types: [], evaluator_id: null, prev_cases: 0, prev_patients: [], introBucket: emptyBucket()
    };
  }
  var draft = emptyDraft();

  // 평가자 정보 → 저장용 객체 (직군·추가 항목은 config.EVALUATOR_ROLES 기준)
  function buildEvaluator() {
    var role = roleById(draft.role);
    var fields = {}, codes = {}, parts = [role.label];
    var take = function (f, inDetail) {
      var raw = String(draft.fields[f.id] || '').trim(), v = raw;
      if (f.other && raw === f.other) v = '기타: ' + String(draft.other[f.id] || '').trim();
      fields[f.id] = v;
      var cd = fieldCode(f, raw);
      if (cd !== '') codes[f.id] = cd;
      if (inDetail && v) parts.push(v);
    };
    role.fields.forEach(function (f) { take(f, true); });
    COMMON.forEach(function (f) { take(f, false); });
    return {
      name: draft.name.trim(), role: role.id, role_label: role.label, fields: fields, codes: codes,
      detail: parts.join(' · '),
      year: fields.year || ''   // 이전 버전 시트의 ResidentYear 컬럼 호환
    };
  }
  function hiddenCommon(f) { return !!(f.firstSessionOnly && draft.linked && draft.fields[f.id]); }
  function fieldName(f) { return f.short || f.label; }
  // 목적격 조사: 마지막 한글(끝의 괄호 설명 제외)에 받침이 있으면 '을', 없으면 '를'
  function withObj(word) {
    var w = String(word || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    var ch = w.charCodeAt(w.length - 1);
    if (ch >= 0xAC00 && ch <= 0xD7A3) return w + ((ch - 0xAC00) % 28 ? '을' : '를');
    return w + '을(를)';
  }
  // 시작 전 확인: 빠진 항목을 이름으로 알려 주고(msg), 그 항목으로 이동할 수 있게 선택자(sel)를 돌려준다
  function draftProblem() {
    if (!draft.name.trim()) return { msg: '성명을 입력해 주세요.', sel: '#evName' };
    var role = roleById(draft.role);
    if (!role) return { msg: '직군(인턴·레지던트·전문의)을 선택해 주세요.', sel: '#roleSeg' };
    var all = role.fields.concat(COMMON);
    for (var i = 0; i < all.length; i++) {
      var f = all[i], v = String(draft.fields[f.id] || '').trim();
      var sel = f.type === 'select' ? '#fld_ev_' + f.id : '[data-field="' + f.id + '"]';
      // 짧은 이름(short)이 없는 긴 질문은 이름 대신 강조 표시된 문항을 가리킨다
      var named = f.short || f.label.length <= 24;
      if (f.required && !v) return { msg: named ? withObj(fieldName(f)) + (f.type === 'text' ? ' 입력해 주세요.' : ' 선택해 주세요.') : '표시된 문항에 답해 주세요.', sel: sel };
      if (f.other && v === f.other && !String(draft.other[f.id] || '').trim()) return { msg: withObj(fieldName(f)) + ' 직접 입력해 주세요.', sel: '[data-other="' + f.id + '"]' };
    }
    if (!typeById(draft.type)) return { msg: '평가 유형(Type)을 선택해 주세요.', sel: '#typeSeg' };
    if (!draft.consent) return { msg: '안내 사항 확인에 체크해 주세요.', sel: '#evConsent' };
    return null;
  }
  // 빠진 항목으로 화면을 옮기고 잠깐 강조한 뒤 그 항목에 초점
  function showMissing(sel) {
    var card = $('evaluatorCard'), el = card && card.querySelector(sel);
    if (!el) return;
    var box = el.closest('.field') || el;
    try { box.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { box.scrollIntoView(); }
    box.classList.remove('missing'); void box.offsetWidth; box.classList.add('missing');
    setTimeout(function () { box.classList.remove('missing'); }, 2400);
    var target = el.matches('.seg') ? (el.querySelector('[tabindex="0"]') || el.querySelector('button')) : el;
    try { target.focus({ preventScroll: true }); } catch (_) {}
  }

  var S = load();
  if (S) lastRev = S.rev || 0;

  function curCase() { return S && S.cases[S.caseIdx]; }
  function curStep() { return STEPS[S.stepIdx]; }
  function stepMetrics(c, step) {
    if (!c.metrics.steps[step]) c.metrics.steps[step] = emptyStepMetrics();
    return c.metrics.steps[step];
  }
  function currentBucket() {
    if (!S) return draft.introBucket;
    if (S.screen === 'case') return stepMetrics(curCase(), curStep());
    if (S.screen === 'final') return S.metrics.final;
    if (S.screen === 'intro') return S.metrics.intro;
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
    if (dt <= 0 || dt > 6 * 3600 * 1000) return;
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
    if (T.drawerOpen && kind === 'active_ms' && S && S.screen === 'case') {
      stepMetrics(curCase(), curStep()).drawer_ms += dt;
    }
  }
  function markInteract() {
    var now = performance.now();
    if (now - T.lastInteract > IDLE_MS) { tick(); }   // close the idle gap first
    T.lastInteract = now;
  }
  ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input'].forEach(function (ev) {
    window.addEventListener(ev, markInteract, { passive: true, capture: true });
  });
  document.addEventListener('visibilitychange', function () {
    tick();
    if (document.hidden) {
      if (S && S.screen === 'case' && !staleTab && S.order) {
        var sm = stepMetrics(curCase(), curStep());
        sm.interruptions = (sm.interruptions || 0) + 1;
        S.metrics.interruptions = (S.metrics.interruptions || 0) + 1;
      }
      pauseComboDwell();
      sendProgress();
    } else {
      T.lastInteract = performance.now();
      resumeComboDwell();
      flush();
    }
    save();
  });
  var unloading = false;
  window.addEventListener('pagehide', function () { unloading = true; tick(); pauseComboDwell(); sendProgress(); save(); });
  window.addEventListener('pageshow', function () { unloading = false; });
  setInterval(function () { tick(); saveSoon(); }, 1000);

  // Scroll depth of the main content for the current step
  var scrollRaf = 0;
  window.addEventListener('scroll', function () {
    markInteract();
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(function () { scrollRaf = 0; recordScroll(); });
  }, { passive: true });
  function recordScroll() {
    if (!S || S.screen !== 'case' || T.drawerOpen) return;
    var docH = document.documentElement.scrollHeight;
    var seen = window.scrollY + window.innerHeight - (dockIsFixed() ? elDock.offsetHeight : 0);
    var contentH = docH - (dockIsFixed() ? elDock.offsetHeight : 0);
    var pct = contentH <= 0 ? 100 : Math.min(100, Math.round(100 * seen / contentH));
    var m = stepMetrics(curCase(), curStep());
    if (pct > m.scroll_max) m.scroll_max = pct;
  }

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
      session_id: S.session_id, is_test: S.is_test,
      evaluator: S.evaluator, study_type: S.study_type, linked_session_id: S.linked_session_id,
      sequence_index: S.seq_index, seq_source: S.seq_source, order: S.order,
      n_sequences: typeSeqs().length,
      instrument_version: CFG.INSTRUMENT_VERSION || '', wave: (S.entry || ENTRY).wave,
      evaluator_id: S.evaluator_id, device_id: S.device_id || DEVICE_ID, visit_id: S.visit_id || VISIT_ID,
      session_ordinal: S.session_ordinal || 1, entry: S.entry || ENTRY, consent: S.consent || {},
      incentive: CFG.INCENTIVE || ''
    };
  }

  // fire-and-forget 신호 (응답 보관함과 별개): 이탈 지점(progress)과 첫 화면 방문(view)
  function beacon(p) {
    if (!CFG.ENDPOINT) return;
    var body = JSON.stringify(p);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(CFG.ENDPOINT, new Blob([body], { type: 'text/plain;charset=utf-8' }))) return;
    } catch (_) {}
    try { fetch(CFG.ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'no-cors' }).catch(function () {}); } catch (_) {}
  }
  function countRatings() {
    return (S.cases || []).reduce(function (a, c) {
      return a + PHASE_KEYS.filter(function (k) { return c.ratings[k] != null; }).length + (c.combo ? 1 : 0);
    }, 0);
  }
  var lastProgressAt = 0;
  function sendProgress() {
    if (!S || staleTab || !S.order || S.screen === 'done' || S.screen === 'intro') return;
    var now = Date.now();
    if (now - lastProgressAt < 10000) return;
    lastProgressAt = now;
    var p = basePayload('progress');
    p.progress = {
      furthest_case: (S.furthest || {}).case || 1, furthest_step: (S.furthest || {}).step || 'vignette',
      partial_ratings_n: countRatings(), last_activity_at: nowIso()
    };
    beacon(p);
  }
  var viewSent = false;
  function sendView() {
    if (viewSent || !CFG.ENDPOINT) return;
    viewSent = true;
    beacon({
      action: 'view', msg_id: uuid(), client_time: nowIso(), study_id: CFG.STUDY_ID, app_version: CFG.APP_VERSION,
      is_test: URL_TEST, visit_id: VISIT_ID, device_id: DEVICE_ID, entry: ENTRY, form_factor: deviceInfo().form_factor
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
    if (flushing || staleTab || !sess || !CFG.ENDPOINT || !sess.outbox.length) return Promise.resolve();
    flushing = true;
    sess.net.status = 'sending';
    if (sess.screen === 'done') render();
    var loop = function () {
      if (!sess.outbox.length) return Promise.resolve();
      var item = sess.outbox[0];
      return postJSON(item).then(function () {
        var k = sess.outbox.indexOf(item);
        if (k >= 0) sess.outbox.splice(k, 1);
        sess.sent_ids = (sess.sent_ids || []).concat([item.msg_id]).slice(-200);
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
      if (sess !== S) return;   // '새 평가 시작'으로 대체된 세션: 플래그는 이미 초기화됨
      flushing = false;
      save();
      if (S.screen === 'done') render();
    });
  }
  window.addEventListener('online', function () { flush(); });
  setInterval(function () { if (S && S.outbox.length && !document.hidden) flush(); }, 30000);

  // ---------------------------------------------------------------------------
  // Records
  // ---------------------------------------------------------------------------
  function sumSteps(c, field) {
    return STEPS.reduce(function (acc, st) { var m = c.metrics.steps[st]; return acc + (m ? (m[field] || 0) : 0); }, 0);
  }
  function contentChars(out, combo) {
    var cb = combo ? out.combinations[combo - 1] : null;
    var phaseChars = function (k) {
      if (!cb) return 0;
      var n = PHASES[k].items.reduce(function (a, it) { return a + textLen(cb.answers[it[0]]); }, 0);
      return n + textLen(drugLine(cb)) + (k === 'p2' ? textLen(cb.prescription) : 0);
    };
    return {
      vignette: textLen(DATA.patients[out.patient]), p1: textLen(out.phase_1),
      combo: textLen(out.combinations.map(function (x) { return [drugLine(x), x.answers['2.1'], x.answers['2.2'], x.answers['2.3']]; })),
      p2: phaseChars('p2'), p3: phaseChars('p3'), p4: phaseChars('p4'), p5: phaseChars('p5')
    };
  }
  function buildCaseRecord(i) {
    var c = S.cases[i];
    var out = DATA.outputs[c.key];
    var comboName = c.combo ? out.combinations[c.combo - 1].name : '';
    var cm = c.metrics;
    return {
      case_index: i + 1, case_key: c.key, patient_id: out.patient, model: out.model, model_name: out.model_name,
      ratings: c.ratings, combo_choice: c.combo, combo_name: comboName,
      combo_rank_ai: c.combo, combo_key: c.combo ? c.key + '_C' + c.combo : '',
      combo_is_ai_first: c.combo === 1,
      rank_cue_visible: false,   // AI가 붙인 조합 이름(순위 문구 포함)은 화면에 표시하지 않음
      global_case_order: (S.prev_cases || 0) + i + 1,
      patient_seen_prior: (S.prev_patients || []).indexOf(out.patient) >= 0,
      comment: c.comment,
      items: c.items || {},
      chars: contentChars(out, c.combo),
      combo_exposure: {
        seen: (cm.combo_seen || [false, false, false]).slice(),
        dwell_ms: (cm.combo_dwell_ms || [0, 0, 0]).map(function (x) { return Math.round(x); })
      },
      rx_details_opens: cm.rx_details_opens || 0,
      interruptions: sumSteps(c, 'interruptions'),
      started_at: c.started_at, completed_at: c.completed_at,
      metrics: {
        steps: c.metrics.steps,
        combo_resets: c.metrics.combo_resets,
        case_active_ms: Math.round(sumSteps(c, 'active_ms')),
        case_idle_ms: Math.round(sumSteps(c, 'idle_ms')),
        case_hidden_ms: Math.round(sumSteps(c, 'hidden_ms')),
        case_wall_ms: Math.round(sumSteps(c, 'wall_ms')),
        drawer_opens: sumSteps(c, 'drawer_opens'),
        drawer_ms: Math.round(sumSteps(c, 'drawer_ms'))
      }
    };
  }
  function sessionSummary() {
    var m = S.metrics;
    return {
      started_at: S.started_at, finished_at: S.finished_at,
      total_active_ms: Math.round(m.active_ms), total_idle_ms: Math.round(m.idle_ms),
      total_hidden_ms: Math.round(m.hidden_ms), total_wall_ms: Math.round(m.wall_ms),
      intro_ms: Math.round(S.metrics.intro.active_ms + S.metrics.intro.idle_ms),
      final_ms: Math.round(S.metrics.final.active_ms + S.metrics.final.idle_ms),
      resumes: m.resumes,
      cases_completed: S.cases.filter(function (c) { return c.completed_at; }).length,
      interruptions: m.interruptions || 0, send_failures: m.send_failures || 0
    };
  }

  // ---------------------------------------------------------------------------
  // Flow control
  // ---------------------------------------------------------------------------
  function initCases(order) {
    return order.map(function (key) {
      return {
        key: key, ratings: { p1: null, p2: null, p3: null, p4: null, p5: null },
        combo: null, comment: '', items: {}, started_at: null, completed_at: null,
        metrics: { steps: {}, combo_resets: 0, combo_seen: [false, false, false], combo_dwell_ms: [0, 0, 0], rx_details_opens: 0 }
      };
    });
  }

  var navLockUntil = 0;
  function markFurthest(caseNo, step) {
    var rank = (caseNo - 1) * STEPS.length + (step === 'final' ? STEPS.length : STEPS.indexOf(step));
    if (!S.furthest || rank > (S.furthest.rank || 0)) S.furthest = { case: caseNo, step: step, rank: rank };
  }
  function enterStep() {
    elToast.hidden = true;
    closeDrawer();
    stopComboObs();
    navLockUntil = performance.now() + NAV_LOCK_MS;
    markFurthest(S.caseIdx + 1, curStep());
    var c = curCase();
    if (!c.started_at) c.started_at = nowIso();
    var m = stepMetrics(c, curStep());
    m.visits += 1;
    if (!m.first_enter) m.first_enter = nowIso();
    T.lastInteract = performance.now();
    save();
    render();
    window.scrollTo(0, 0);
    try { elMain.focus({ preventScroll: true }); } catch (_) {}
    requestAnimationFrame(recordScroll);
  }

  var starting = false;
  function startSession() {
    if (starting) return;
    var pb = draftProblem();
    if (pb) { toast(pb.msg); showMissing(pb.sel); return; }
    tick();
    starting = true;
    S = newState(buildEvaluator(), draft.type, draft.linked);
    S.done_types = draft.done_types || [];
    S.evaluator_id = draft.evaluator_id || uuid();
    S.device_id = DEVICE_ID; S.visit_id = VISIT_ID; S.entry = ENTRY;
    S.consent = { version: CFG.CONSENT_VERSION || '', at: draft.consent_at || nowIso(), inherited: !!draft.consent_inherited };
    S.session_ordinal = S.done_types.length + 1;
    S.prev_cases = draft.prev_cases || 0;
    S.prev_patients = (draft.prev_patients || []).slice();
    S.end_items = {};
    S.metrics.intro = draft.introBucket;
    S.metrics.active_ms += draft.introBucket.active_ms;
    S.metrics.idle_ms += draft.introBucket.idle_ms;
    S.metrics.hidden_ms += draft.introBucket.hidden_ms;
    S.metrics.wall_ms += draft.introBucket.wall_ms;
    S.started_at = nowIso();
    render();

    var finish = function (seq, source) {
      S.seq_index = seq;
      S.seq_source = source;
      S.order = typeSeqs()[seq].slice();
      S.cases = initCases(S.order);
      S.screen = 'case'; S.caseIdx = 0; S.stepIdx = 0;
      starting = false;
      if (source === 'local' && CFG.ENDPOINT) {
        var sp = basePayload('start');
        sp.device = S.device;
        enqueue(sp);
      }
      enterStep();
    };

    if (!CFG.ENDPOINT) { finish(randInt(typeSeqs().length), 'local'); return; }

    var p = basePayload('start');
    p.device = S.device;
    var settled = false;
    var to = setTimeout(function () {
      if (settled || unloading) return; settled = true;
      finish(randInt(typeSeqs().length), 'local');
    }, START_TIMEOUT_MS);
    postJSON(p, START_TIMEOUT_MS).then(function (j) {
      if (settled) return; settled = true; clearTimeout(to);
      var seq = Number(j.seq_index);
      if (!(seq >= 0 && seq < typeSeqs().length)) seq = randInt(typeSeqs().length);
      S.net.status = 'ok'; S.net.last_ok = nowIso();
      finish(seq, 'server');
    }).catch(function (e) {
      if (settled || unloading) return; settled = true; clearTimeout(to);
      S.net.last_error = String(e && e.message || e);
      finish(randInt(typeSeqs().length), 'local');
    });
  }

  function stepComplete() {
    var c = curCase(), st = curStep();
    if (PHASES[st]) return c.ratings[st] != null;
    if (st === 'combo') return c.combo != null;
    if (st === 'comment') return itemsComplete(CASE_ITEMS, c.items || {});
    return true;
  }
  function itemVisible(f, vals) {
    if (!f.showIf) return true;
    var dep = vals[f.showIf.item];
    return !!(dep && Number(dep.code) >= (f.showIf.minCode || 1));
  }
  function itemsComplete(list, vals) {
    return list.every(function (f) { return !f.required || !itemVisible(f, vals) || (vals[f.id] && vals[f.id].value); });
  }

  function goNext() {
    if (!S) { startSession(); return; }
    if (staleTab || performance.now() < navLockUntil) return;
    tick();
    if (S.screen === 'case') {
      if (!stepComplete()) {
        toast(curStep() === 'combo' ? '선호하는 조합을 선택해 주세요.' : curStep() === 'comment' ? '보조 문항에 모두 답해 주세요.' : '1–5점 중 하나를 선택해 주세요.');
        return;
      }
      if (S.stepIdx < STEPS.length - 1) {
        S.stepIdx += 1;
        enterStep();
        return;
      }
      // complete current case
      var c = curCase();
      c.completed_at = nowIso();
      var p = basePayload('case');
      p.case = buildCaseRecord(S.caseIdx);
      p.device = S.device;
      p.session = sessionSummary();
      if (S.caseIdx < nCases() - 1) {
        S.caseIdx += 1; S.stepIdx = 0;
        enqueue(p);
        enterStep();
        toast('케이스 ' + S.caseIdx + ' 평가가 저장되었습니다.');
      } else {
        S.screen = 'final';
        markFurthest(nCases(), 'final');
        enqueue(p);
        navLockUntil = performance.now() + NAV_LOCK_MS;
        save(); render(); window.scrollTo(0, 0);
      }
      return;
    }
    if (S.screen === 'final') {
      if (!itemsComplete(END_ITEMS, S.end_items || {})) { toast('보조 문항에 답해 주세요.'); return; }
      S.finished_at = nowIso();
      S.screen = 'done';
      var fp = basePayload('finish');
      fp.device = S.device;
      fp.session = sessionSummary();
      fp.overall_comment = S.overall_comment;
      fp.end_items = S.end_items || {};
      fp.cases = S.cases.map(function (_, i) { return buildCaseRecord(i); });
      save(); render(); window.scrollTo(0, 0);
      enqueue(fp);
    }
  }

  function goBack() {
    if (!S || S.screen !== 'case' || S.stepIdx === 0 || staleTab) return;
    if (performance.now() < navLockUntil) return;
    tick();
    S.stepIdx -= 1;
    enterStep();
  }

  function setRating(key, v) {
    if (staleTab) return;
    tick();
    var c = curCase();
    if (c.ratings[key] === v) return;
    var m = stepMetrics(c, key);
    if (m.ttfr_ms == null) { recordScroll(); m.ttfr_ms = Math.round(m.active_ms + m.idle_ms) - (m.ttfr_base || 0); m.scroll_at_fr = m.scroll_max; }
    else m.changes += 1;
    m.history.push([v, Math.round(m.active_ms + m.idle_ms)]);
    c.ratings[key] = v;
    save();
    var hadFocus = elDock.contains(document.activeElement);
    renderDock();
    if (hadFocus) { var b = elDock.querySelector('[data-rate="' + v + '"]'); if (b) b.focus(); }
  }

  // 조합 박스를 누르면: 선택 → 박스가 위쪽 '선택한 조합' 자리로 이동 → Phase 2 문항이 차례로 나타남
  var arrivingFromCombo = false, flying = false;
  function chooseCombo(n, cardEl) {
    if (flying || staleTab || !S || S.screen !== 'case' || curStep() !== 'combo') return;
    if (performance.now() < navLockUntil) return;
    var c = curCase();
    setCombo(n);
    if (c.combo !== n) return;   // 점수 초기화 확인을 취소함
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    var first = cardEl && cardEl.getBoundingClientRect();
    var go = function () { tick(); arrivingFromCombo = true; S.stepIdx = STEPS.indexOf('p2'); enterStep(); };
    if (reduce || !first || !cardEl.animate) { go(); return; }
    flying = true;
    var clone = cardEl.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('[id]'), function (x) { x.removeAttribute('id'); });
    clone.removeAttribute('role'); clone.setAttribute('aria-hidden', 'true'); clone.classList.add('fly');
    var cs = clone.style;
    cs.position = 'fixed'; cs.top = first.top + 'px'; cs.left = first.left + 'px';
    cs.width = first.width + 'px'; cs.height = first.height + 'px'; cs.margin = '0'; cs.zIndex = '45';
    document.body.appendChild(clone);
    cardEl.style.visibility = 'hidden';
    Array.prototype.forEach.call(elMain.querySelectorAll('.combo-card, .combo-toolbar, .case-head, h1, .lead'), function (el) {
      if (el !== cardEl) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    });
    Array.prototype.forEach.call(clone.querySelectorAll('.cc-points, .cc-rx, .cc-cta'), function (el) {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
    });
    setTimeout(function () {
      go();
      var banner = $('selBanner');
      if (!banner) { clone.remove(); flying = false; return; }
      banner.style.opacity = '0';
      var last = banner.getBoundingClientRect();
      var anim = clone.animate([
        { top: first.top + 'px', left: first.left + 'px', width: first.width + 'px', height: first.height + 'px' },
        { top: last.top + 'px', left: last.left + 'px', width: last.width + 'px', height: last.height + 'px' }
      ], { duration: 480, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
      var finished = false;
      var done = function () {
        if (finished) return; finished = true;
        banner.style.transition = 'opacity .18s ease'; banner.style.opacity = '1';
        var out = clone.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
        out.onfinish = function () { clone.remove(); flying = false; };
        setTimeout(function () { if (document.body.contains(clone)) clone.remove(); flying = false; }, 400);
      };
      anim.onfinish = done;
      setTimeout(done, 900);   // 안전장치
    }, 170);
  }

  function setCombo(n) {
    if (staleTab) return;
    tick();
    var c = curCase();
    if (c.combo === n) return;
    var rated = ['p2', 'p3', 'p4', 'p5'].filter(function (k) { return c.ratings[k] != null; });
    if (c.combo != null && rated.length) {
      if (!window.confirm('선호 조합을 바꾸면 이미 입력한 Phase 2–5 점수(' + rated.length + '개)가 초기화됩니다. 바꾸시겠습니까?')) return;
      rated.forEach(function (k) {
        c.ratings[k] = null;
        // 새 조합 기준으로 첫 응답 시간·변경 횟수를 다시 센다 (이전 값은 *_prev 로 보존)
        var sm = stepMetrics(c, k);
        sm.history.push(['reset', Math.round(sm.active_ms + sm.idle_ms)]);
        sm.ttfr_prev_list = (sm.ttfr_prev_list || []).concat([sm.ttfr_ms]);
        sm.ttfr_ms = null;
        sm.ttfr_base = Math.round(sm.active_ms + sm.idle_ms);   // 새 조합 기준 첫 응답 시간은 이 시점부터
        sm.changes_prev = (sm.changes_prev || 0) + sm.changes; sm.changes = 0;
      });
      c.metrics.combo_resets += 1;
    }
    var m = stepMetrics(c, 'combo');
    if (m.ttfr_ms == null) { recordScroll(); m.ttfr_ms = Math.round(m.active_ms + m.idle_ms); m.scroll_at_fr = m.scroll_max; }
    else m.changes += 1;
    m.history.push([n, Math.round(m.active_ms + m.idle_ms)]);
    c.combo = n;
    save();
    // update cards + dock in place (keep scroll position)
    Array.prototype.forEach.call(elMain.querySelectorAll('.combo-card'), function (el) {
      var on = Number(el.getAttribute('data-combo')) === n;
      el.setAttribute('aria-checked', String(on));
      el.setAttribute('tabindex', on ? '0' : '-1');
    });
    var hadFocus = elDock.contains(document.activeElement);
    renderDock();
    if (hadFocus) { var b = elDock.querySelector('[data-combo="' + n + '"]'); if (b) b.focus(); }
  }

  // ---------------------------------------------------------------------------
  // Drawer (patient info)
  // ---------------------------------------------------------------------------
  var lastFocus = null;
  function openDrawer() {
    if (!S || S.screen !== 'case' || staleTab) return;
    tick();
    var c = curCase();
    var out = DATA.outputs[c.key];
    elDrawerBody.innerHTML = patientHTML(DATA.patients[out.patient], true);
    $('drawerTitle').textContent = '환자 정보 · ' + out.patient;
    lastFocus = document.activeElement;
    elDrawer.hidden = false; elBackdrop.hidden = false;
    document.body.style.overflow = 'hidden';
    elLayout.inert = true; $('topbar').inert = true;
    T.drawerOpen = true;
    stepMetrics(c, curStep()).drawer_opens += 1;
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
    if (lastFocus && lastFocus.focus) lastFocus.focus();
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
      return;
    }
    if (staleTab || !elDrawer.hidden || !S || S.screen !== 'case') return;
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var st = curStep();
    var n = Number(e.key);
    if (PHASES[st] && n >= 1 && n <= 5) { setRating(st, n); }
    else if (st === 'combo' && n >= 1 && n <= 3) { setCombo(n); }
  });

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------
  function splitUnit(v) {
    var m = String(v).match(/^([<>]?\s*-?[\d.,]+)\s*(.*)$/);
    return m ? { num: m[1].replace(/\s+/g, ''), unit: m[2] } : { num: String(v), unit: null };
  }

  function patientHTML(p, compact) {
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

  // 조합은 AI가 붙인 이름 대신 '조합 N' + 약물 구성으로 통일해 표시 (모델 간 표현 차이·순위 문구 노출 방지)
  function drugChipsHTML(cb) {
    return '<div class="cc-drugs">' + cb.prescription.map(function (rx) {
      var cls = DECISION_CLASS[rx.decision] || 'keep';
      return '<span class="drug ' + cls + '"><b>' + esc(rx.drug) + '</b><em>' + esc(rx.decision) + '</em></span>';
    }).join('') + '</div>';
  }
  function drugLine(cb) {
    return cb.prescription.filter(function (rx) { return rx.decision !== '중단'; }).map(function (rx) { return rx.drug; }).join(' + ');
  }
  var POINTS = [['2.1', '효과', 'eff'], ['2.2', '안전성', 'safe'], ['2.3', '실행 가능성', 'feas']];
  function comboCardHTML(cb, n, c) {
    var on = c.combo === n;
    var tab = (on || (c.combo == null && n === 1)) ? 0 : -1;
    return '<article class="combo-card" role="radio" tabindex="' + tab + '" data-combo="' + n + '" aria-checked="' + on + '" aria-labelledby="cbno' + n + '">' +
      '<header class="cc-head"><span class="cc-no" id="cbno' + n + '">조합 ' + n + '</span><span class="radio-dot" aria-hidden="true"></span></header>' +
      drugChipsHTML(cb) +
      '<ul class="cc-points">' + POINTS.map(function (pt) {
        return '<li class="pt ' + pt[2] + '"><span class="pt-label">' + pt[1] + '</span><span class="pt-text">' + esc(cb.answers[pt[0]]) + '</span></li>';
      }).join('') + '</ul>' +
      '<details class="cc-rx"><summary>처방 상세 (용량·급여·월 비용)</summary>' + rxListHTML(cb.prescription) + '</details>' +
      '<div class="cc-cta">' + (on ? '<span class="cc-sel">선택한 조합</span>' : '') + '이 조합으로 평가하기 <span aria-hidden="true">→</span></div>' +
      '</article>';
  }
  function selectedBannerHTML(cb, n, expanded) {
    return '<div class="selected-banner" id="selBanner">' +
      '<div class="sb-top"><span class="sb-label">선택한 조합</span><span class="cc-no">조합 ' + n + '</span></div>' +
      drugChipsHTML(cb) +
      (expanded ? '<div class="sb-rx">' + rxListHTML(cb.prescription) + '</div>'
        : '<details><summary>처방 상세 보기</summary>' + rxListHTML(cb.prescription) + '</details>') +
      '</div>';
  }

  function itemHTML(no, title, bodyHTML) {
    return '<article class="item"><div class="item-head"><span class="item-no">' + esc(no) + '</span>' +
      '<span class="item-title">' + esc(title) + '</span></div><div class="item-body">' + bodyHTML + '</div></article>';
  }

  function caseHeadHTML(title, sub) {
    var c = curCase(), out = DATA.outputs[c.key], p = DATA.patients[out.patient];
    return '<div class="case-head">' +
      '<span class="pill navy">케이스 ' + (S.caseIdx + 1) + ' / ' + nCases() + '</span>' +
      '<span class="pill">환자 ' + esc(out.patient) + ' · ' + esc(p.demographics.replace(/\s*\(.*\)$/, '')) + '</span>' +
      '</div>' +
      '<h1 style="font-size:21px;color:var(--navy);margin-top:10px">' + esc(title) + '</h1>' +
      (sub ? '<p class="lead" style="margin-top:4px">' + sub + '</p>' : '');
  }

  function phaseHeadHTML(key) {
    var ph = PHASES[key];
    return '<div class="phase-head"><span class="ph-num">' + esc(ph.num) + '</span><h2>' + esc(ph.title) + '</h2>' +
      '<span class="ph-en">' + esc(ph.en) + '</span></div>';
  }

  function seenBefore() {
    var c = curCase(), pid = DATA.outputs[c.key].patient;
    for (var i = 0; i < S.caseIdx; i++) {
      if (DATA.outputs[S.cases[i].key].patient === pid) return i + 1;
    }
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Screens
  // ---------------------------------------------------------------------------
  function segHTML(attr, items, current) {
    return items.map(function (it, k) {
      var on = current === it.value;
      var tab = (on || (!current && k === 0)) ? 0 : -1;
      return '<button type="button" role="radio" tabindex="' + tab + '" ' + attr + '="' + esc(it.value) + '" aria-checked="' + on + '">' + esc(it.label) + '</button>';
    }).join('');
  }
  // 공통 문항 렌더러: choice(버튼·세로 목록) / select / multi(복수 선택) / text
  function fieldHTML(f, cur, otherVal, prefix) {
    var id = esc((prefix || '') + f.id);
    var lab = '<span class="label" id="lbl_' + id + '">' + esc(f.label) + (f.required ? '<span class="req">*</span>' : '') + '</span>';
    if (f.type === 'choice') {
      var opts = f.options.map(function (o) { return { value: o, label: o }; });
      if (f.other) opts.push({ value: f.other, label: f.other });
      var list = f.layout === 'list';
      return '<div class="field">' + lab + '<div class="seg' + (list ? ' list' : '') + '" role="radiogroup" aria-labelledby="lbl_' + id + '" data-field="' + esc(f.id) + '"' +
        (list ? '' : ' style="grid-template-columns:repeat(' + opts.length + ',1fr)"') + '>' +
        segHTML('data-value', opts, cur) + '</div>' +
        (f.other && cur === f.other ? '<input class="input" type="text" maxlength="60" data-other="' + esc(f.id) + '" placeholder="직접 입력" value="' + esc(otherVal || '') + '">' : '') +
        '</div>';
    }
    if (f.type === 'multi') {
      var sel = String(cur || '').split(';').filter(Boolean);
      return '<div class="field">' + lab + '<div class="chips" data-multi="' + esc(f.id) + '">' +
        f.options.map(function (o) {
          return '<button type="button" class="chip" data-value="' + esc(o[0]) + '" aria-pressed="' + (sel.indexOf(o[0]) >= 0) + '">' + esc(o[1]) + '</button>';
        }).join('') + '</div></div>';
    }
    if (f.type === 'select') {
      var o2 = '<option value="">' + esc(f.placeholder || '선택하세요') + '</option>' +
        (f.groups || [{ label: '', options: f.options || [] }]).map(function (g) {
          var o = g.options.map(function (x) { return '<option' + (cur === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
          return g.label ? '<optgroup label="' + esc(g.label) + '">' + o + '</optgroup>' : o;
        }).join('') +
        (f.other ? '<option' + (cur === f.other ? ' selected' : '') + '>' + esc(f.other) + '</option>' : '');
      return '<div class="field">' + lab.replace('<span class="label"', '<label class="label" for="fld_' + id + '"').replace(/<\/span>$/, '</label>') +
        '<select class="input" id="fld_' + id + '" data-field="' + esc(f.id) + '">' + o2 + '</select>' +
        (f.other && cur === f.other ? '<input class="input" type="text" maxlength="60" data-other="' + esc(f.id) + '" placeholder="직접 입력" value="' + esc(otherVal || '') + '">' : '') +
        '</div>';
    }
    return '<div class="field">' + lab + '<input class="input" type="text" maxlength="60" data-field="' + esc(f.id) + '" value="' + esc(cur || '') + '"></div>';
  }
  function roleFieldsHTML() {
    var role = roleById(draft.role);
    if (!role || !role.fields.length) return '';
    return role.fields.map(function (f) { return fieldHTML(f, draft.fields[f.id] || '', draft.other[f.id], 'ev_'); }).join('');
  }
  function commonFieldsHTML() {
    return COMMON.map(function (f) {
      if (hiddenCommon(f)) return '<p class="small muted">' + esc(fieldName(f)) + ': <b>' + esc(draft.fields[f.id]) + '</b> — 첫 평가 때 응답을 그대로 사용합니다.</p>';
      return fieldHTML(f, draft.fields[f.id] || '', draft.other[f.id], 'ev_');
    }).join('');
  }
  function findEvalField(id) {
    var role = roleById(draft.role);
    return (role ? role.fields : []).concat(COMMON).filter(function (f) { return f.id === id; })[0] || null;
  }

  function renderIntro() {
    var legend = SCALE.map(function (s) { return '<div><b>' + s.v + '</b>' + esc(s.label) + '</div>'; }).join('');
    var roles = segHTML('data-role', ROLES.map(function (r) { return { value: r.id, label: r.label }; }), draft.role);
    var types = segHTML('data-type', TYPES.map(function (t) { return { value: t.id, label: t.label }; }), draft.type);
    // 이어서 평가: 이전 세션에 없던 필수 항목(예: v3.3 에서 시작한 평가자의 AI 사용 빈도)은 무엇인지 알려 준다
    var linkedRole = roleById(draft.role);
    var linkedMissing = !draft.linked ? [] : (linkedRole ? linkedRole.fields : []).concat(COMMON).filter(function (f) {
      return f.required && !String(draft.fields[f.id] || '').trim();
    }).map(fieldName);
    elMain.innerHTML =
      '<section class="card hero">' +
        '<span class="eyebrow">AI 기반 T2D 임상 의사결정 지원 시스템</span>' +
        '<h1>임상 수용성 평가</h1>' +
        '<p class="sub">Physician Clinical Acceptability Assessment</p>' +
        '<p class="desc">AI 임상 의사결정 지원 시스템(CDSS)이 생성한 제2형 당뇨병 외래 진료 권고안을 읽고, ' +
        '각 단계의 답변이 실제 임상 결정에 유의미한 참고가 되는지 평가해 주십시오.</p>' +
      '</section>' +

      '<section class="card">' +
        '<h2 class="section-title">평가 방법</h2>' +
        '<p>선택한 평가 유형(Type)에 따라 가상 환자 2명에 대한 AI 답변 <b>2건</b>을 차례로 평가합니다. 답변을 만든 AI 시스템의 이름은 공개하지 않으며, 제시 순서는 평가자마다 다릅니다.</p>' +
        '<ol class="flow" style="margin-top:12px">' +
          '<li><span><b>환자 정보 확인</b> — 병력, 복용약, 12개월 검사 추이를 먼저 읽습니다.</span></li>' +
          '<li><span><b>Phase 1 평가</b> — 환자 분류 및 의뢰 권고를 읽고 1–5점으로 평가합니다.</span></li>' +
          '<li><span><b>선호 조합 선택</b> — AI가 제시한 약물 조합 3개 중 이 환자에게 가장 선호하는 조합 1개를 고릅니다.</span></li>' +
          '<li><span><b>Phase 2–5 평가</b> — 선택한 조합에 대한 약물 조합 요약, 약물 선택 고려사항, 추적관찰, 환자 교육을 각각 1–5점으로 평가합니다.</span></li>' +
          '<li><span><b>의견 (선택)</b> — 해당 AI 답변에 대한 의견을 자유롭게 남깁니다.</span></li>' +
        '</ol>' +
        '<ul class="clean small muted" style="margin-top:14px">' +
          '<li>예상 소요 시간: ' + esc(CFG.ESTIMATED_MINUTES) + ' (케이스당 약 10–15분)</li>' +
          '<li>평가 중에는 화면 위쪽 <b>[환자 정보]</b> 버튼으로 환자 기록을 언제든 다시 볼 수 있습니다.</li>' +
          '<li>창을 닫아도 같은 기기·브라우저에서 다시 열면 이어서 진행됩니다.</li>' +
        '</ul>' +
      '</section>' +

      '<section class="card">' +
        '<h2 class="section-title">평가 척도</h2>' +
        '<p>각 Phase마다 다음 형식의 문장에 얼마나 동의하는지 선택합니다.</p>' +
        '<p class="notice" style="margin-top:10px">“AI가 제공한 <b>[해당 Phase 내용]</b>은 <b>[해당 임상 결정]</b>에 유의미한 참고가 된다.”</p>' +
        '<div class="scale-legend">' + legend + '</div>' +
      '</section>' +

      '<section class="card" id="evaluatorCard">' +
        '<h2 class="section-title">평가자 정보</h2>' +
        (draft.linked ? '<p class="notice info" style="margin-bottom:14px">이전 평가에 이어 <b>' + esc((typeById(draft.type) || {}).label || '') + '</b>를 평가합니다. ' +
          (linkedMissing.length ? '아래 <b>' + esc(linkedMissing.join(', ')) + '</b> 문항에 답한 뒤 시작해 주세요.' : '아래 정보를 확인하고 시작해 주세요.') + '</p>' : '') +
        '<div class="field"><label for="evName">성명<span class="req">*</span></label>' +
          '<input class="input" id="evName" type="text" autocomplete="name" maxlength="40" placeholder="예: 홍길동" value="' + esc(draft.name) + '"></div>' +
        '<div class="field"><span class="label" id="roleLabel">직군<span class="req">*</span></span>' +
          '<div class="seg" role="radiogroup" aria-labelledby="roleLabel" id="roleSeg" style="grid-template-columns:repeat(' + ROLES.length + ',1fr)">' + roles + '</div></div>' +
        '<div id="roleFields">' + roleFieldsHTML() + '</div>' +
        (COMMON.length ? '<div id="commonFields">' + commonFieldsHTML() + '</div>' : '') +
        '<div class="field"><span class="label" id="typeLabel">평가 유형<span class="req">*</span></span>' +
          '<p class="small muted" style="margin:0">둘 중 하나를 골라 주세요. 각 Type은 서로 다른 AI 답변 2건(약 20–30분)이며, 끝난 뒤 다른 Type도 이어서 평가할 수 있습니다.</p>' +
          '<div class="seg" role="radiogroup" aria-labelledby="typeLabel" id="typeSeg" style="grid-template-columns:repeat(' + TYPES.length + ',1fr)">' + types + '</div></div>' +
        '<div class="field" style="margin-top:18px"><label class="check"><input type="checkbox" id="evConsent"' + (draft.consent ? ' checked' : '') + '>' +
          '<span>본 평가의 목적을 이해했으며, 다음 정보가 연구 목적으로 수집·분석되는 데 동의합니다: 성명, 직군·연차/경력, AI 사용 빈도, 평가 점수와 의견, ' +
          '응답 과정 정보(단계별 소요 시간, 접속 경로, 기기 종류). 분석과 발표에는 성명 대신 가명 코드를 사용합니다.' +
          (CFG.IRB_NO ? ' (IRB 승인번호: ' + esc(CFG.IRB_NO) + ')' : '') + '</span></label></div>' +
        '<button type="button" class="btn btn-accent btn-block" id="startBtn" style="margin-top:18px">' + (starting ? '평가 준비 중…' : '평가 시작') + '</button>' +
      '</section>';

    var card = $('evaluatorCard');
    var pickSeg = function (b) {
      var seg = b.parentNode;
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) {
        x.setAttribute('aria-checked', String(x === b));
        x.setAttribute('tabindex', x === b ? '0' : '-1');
      });
      if (b.hasAttribute('data-role')) {
        var r = b.getAttribute('data-role');
        if (draft.role !== r) {
          // 직군을 바꾸면 이전 직군의 항목만 지운다 (공통 문항·이어서 평가 때 가져온 응답은 유지)
          var prevRole = roleById(draft.role);
          (prevRole ? prevRole.fields : []).forEach(function (f) { delete draft.fields[f.id]; delete draft.other[f.id]; });
          draft.role = r; $('roleFields').innerHTML = roleFieldsHTML();
        }
      } else if (b.hasAttribute('data-type')) {
        draft.type = b.getAttribute('data-type');
      } else if (seg.hasAttribute('data-field')) {
        var fid = seg.getAttribute('data-field');
        var before = draft.fields[fid];
        draft.fields[fid] = b.getAttribute('data-value');
        var ff = findEvalField(fid);
        if (ff && ff.other && ((before === ff.other) !== (draft.fields[fid] === ff.other))) {
          var host = seg.closest('#roleFields, #commonFields');
          if (host) host.innerHTML = host.id === 'roleFields' ? roleFieldsHTML() : commonFieldsHTML();
          var oi = card.querySelector('[data-other="' + fid + '"]'); if (oi) oi.focus();
        }
      }
    };
    card.addEventListener('click', function (e) {
      var b = e.target.closest('.seg button[role="radio"]');
      if (b) pickSeg(b);
    });
    card.addEventListener('keydown', function (e) {
      var b = e.target.closest('.seg button[role="radio"]');
      if (!b) return;
      var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var all = Array.prototype.slice.call(b.parentNode.querySelectorAll('button'));
      var nb = all[(all.indexOf(b) + d + all.length) % all.length];
      pickSeg(nb); nb.focus();
    });
    card.addEventListener('change', function (e) {
      var t = e.target;
      if (t.tagName === 'SELECT' && t.hasAttribute('data-field')) {
        var id = t.getAttribute('data-field');
        draft.fields[id] = t.value;
        var f = findEvalField(id) || {};
        var hasOther = !!card.querySelector('[data-other="' + id + '"]');
        if (f.other && (t.value === f.other) !== hasOther) {
          $('roleFields').innerHTML = roleFieldsHTML();
          var oi = card.querySelector('[data-other="' + id + '"]'); if (oi) oi.focus();
        }
      }
    });
    card.addEventListener('input', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-other')) draft.other[t.getAttribute('data-other')] = t.value;
      else if (t.tagName === 'INPUT' && t.type === 'text' && t.hasAttribute('data-field')) draft.fields[t.getAttribute('data-field')] = t.value;
    });
    $('evName').addEventListener('input', function (e) { draft.name = e.target.value; });
    $('evConsent').addEventListener('change', function (e) {
      draft.consent = e.target.checked; draft.consent_at = e.target.checked ? nowIso() : null; draft.consent_inherited = false;
    });
    $('startBtn').addEventListener('click', startSession);
    elDock.innerHTML = '';
    sendView();
  }

  function renderStarting() {
    elMain.innerHTML = '<section class="card"><p class="status-line pending"><span class="dot"></span>평가를 준비하고 있습니다…</p></section>';
    elDock.innerHTML = '';
  }

  function renderCaseMain() {
    var c = curCase(), out = DATA.outputs[c.key], st = curStep();
    var p = DATA.patients[out.patient];
    var html = '';
    if (st === 'vignette') {
      var seen = seenBefore();
      html += caseHeadHTML('환자 정보', '먼저 환자 기록을 충분히 읽어 주세요. 다음 화면부터 AI 답변이 제시됩니다.');
      if (seen) {
        html += '<p class="notice info same-patient">이 환자는 <b>케이스 ' + seen + '</b>에서 이미 확인하셨습니다. 이번에는 <b>다른 AI 답변</b>을 평가합니다. 필요한 부분만 다시 훑어보셔도 됩니다.</p>';
      } else if ((S.prev_patients || []).indexOf(out.patient) >= 0) {
        html += '<p class="notice info same-patient">이 환자는 <b>이전 Type 평가</b>에서 이미 확인하셨습니다. 이번에는 <b>다른 AI 답변</b>을 평가합니다.</p>';
      }
      html += patientHTML(p, false);
    } else if (st === 'p1') {
      var ph1 = out.phase_1;
      html += caseHeadHTML('AI 답변 평가');
      html += phaseHeadHTML('p1');
      html += '<div class="items">' +
        itemHTML('1.1', '의뢰 판단', '<span class="callout">' + esc(ph1['1.1'].referral) + '</span><p>' + esc(ph1['1.1'].answer) + '</p>') +
        itemHTML('1.2', '환자 평가', '<p>' + esc(ph1['1.2']) + '</p>') +
      '</div>';
    } else if (st === 'combo') {
      html += caseHeadHTML('선호 조합 선택', 'AI가 이 환자에게 제시한 후보 약물 조합 3개입니다. 효과·안전성·실행 가능성을 비교해 <b>가장 선호하는 조합의 박스</b>를 눌러 주세요. 선택한 조합으로 Phase 2–5를 평가합니다.');
      html += '<div class="combo-toolbar desk-only"><button type="button" class="btn btn-ghost" data-act="back">← 이전</button>' +
        '<span class="muted small">박스를 누르면 바로 Phase 2로 넘어갑니다</span>' +
        (c.combo ? '<button type="button" class="btn btn-primary" data-act="next">조합 ' + c.combo + '으로 계속 →</button>' : '<span></span>') + '</div>';
      html += '<div class="combo-grid three" role="radiogroup" aria-label="후보 약물 조합" id="comboGroup">' +
        out.combinations.map(function (cb, i) { return comboCardHTML(cb, i + 1, c); }).join('') + '</div>';
    } else if (PHASES[st]) {
      var cb = out.combinations[c.combo - 1];
      var a = cb.answers;
      html += caseHeadHTML('AI 답변 평가');
      var enter = arrivingFromCombo && st === 'p2';
      html += selectedBannerHTML(cb, c.combo, st === 'p2');
      html += phaseHeadHTML(st).replace('class="phase-head"', 'class="phase-head' + (enter ? ' enter' : '') + '"');
      html += '<div class="items' + (enter ? ' enter' : '') + '">' + PHASES[st].items.map(function (it) {
        var v = a[it[0]];
        var body;
        if (v && typeof v === 'object') {
          body = (v.next_visit ? '<span class="callout"><small>다음 방문</small>' + esc(v.next_visit) + '</span>' : '') +
            '<p>' + esc(v.answer || '') + '</p>';
        } else {
          body = '<p>' + esc(v) + '</p>';
        }
        return itemHTML(it[0], it[1], body);
      }).join('') + '</div>';
    } else if (st === 'comment') {
      html += caseHeadHTML('케이스 마무리', '보조 문항에 답하고, 필요하면 의견을 남겨 주세요.');
      html += '<section class="card"><h3 class="section-title">이번 케이스 평가 요약</h3>' + caseRecapHTML(c) +
        '<p class="small muted" style="margin-top:8px">점수를 고치려면 아래 [이전] 버튼으로 해당 단계로 돌아가세요.</p></section>';
      if (CASE_ITEMS.length) {
        html += '<section class="card sub-items"><span class="sub-tag">보조 문항</span>' +
          '<p class="small muted" style="margin:6px 0 4px">위 임상 수용성 평가(Phase 1–5)와 별개로, 이 케이스의 AI 답변 전체에 대해 답해 주세요.</p>' +
          '<div id="caseItems">' + itemsHTML(CASE_ITEMS, c.items || {}, 'ci_') + '</div></section>';
      }
      html += '<section class="card"><div class="field"><label for="caseComment">자유 의견 (선택)</label>' +
        '<textarea class="input" id="caseComment" maxlength="3000" placeholder="' + esc(commentPlaceholder(c)) + '">' + esc(c.comment) + '</textarea>' +
        '<div class="char-count" id="ccCount">' + c.comment.length + ' / 3000</div></div></section>';
    }
    elMain.innerHTML = html;
    arrivingFromCombo = false;

    if (st === 'combo') {
      var grp = $('comboGroup');
      grp.addEventListener('click', function (e) {
        if (e.target.closest('details')) return;   // 처방 상세 펼치기는 선택이 아님
        var card = e.target.closest('.combo-card');
        if (card) chooseCombo(Number(card.getAttribute('data-combo')), card);
      });
      grp.addEventListener('keydown', function (e) {
        var card = e.target.closest('.combo-card');
        if (!card || e.target.closest('details')) return;
        var n = Number(card.getAttribute('data-combo'));
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); chooseCombo(n, card); return; }
        var d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var nx = grp.querySelector('[data-combo="' + (((n - 1 + d + 3) % 3) + 1) + '"]');
        if (nx) { nx.setAttribute('tabindex', '0'); card.setAttribute('tabindex', '-1'); nx.focus(); }
      });
      var tb = elMain.querySelector('.combo-toolbar');
      if (tb) tb.addEventListener('click', function (e) {
        var b = e.target.closest('[data-act]'); if (!b) return;
        if (b.getAttribute('data-act') === 'back') goBack(); else goNext();
      });
    }
    if (st === 'combo') startComboObs(c);
    if (PHASES[st] && st !== 'p2') {
      var det = elMain.querySelector('#selBanner details');
      if (det) det.addEventListener('toggle', function () { if (det.open) { c.metrics.rx_details_opens = (c.metrics.rx_details_opens || 0) + 1; saveSoon(); } });
    }
    if (st === 'comment' && $('caseItems')) {
      bindItems($('caseItems'), CASE_ITEMS, function () { return curCase().items || (curCase().items = {}); }, 'ci_', function (f) {
        var cm = stepMetrics(curCase(), 'comment');
        var v = curCase().items[f.id];
        cm.history.push([f.id, v ? v.code || v.value : '', Math.round(cm.active_ms + cm.idle_ms)]);
        var ta = $('caseComment'); if (ta) ta.placeholder = commentPlaceholder(curCase());
        renderDock();
      });
    }
    if (st === 'comment') {
      $('caseComment').addEventListener('input', function (e) {
        curCase().comment = e.target.value;
        $('ccCount').textContent = e.target.value.length + ' / 3000';
        saveSoon();
      });
    }
  }

  function itemsHTML(list, vals, prefix) {
    return list.filter(function (f) { return itemVisible(f, vals); }).map(function (f) {
      return fieldHTML(f, (vals[f.id] || {}).value || '', '', prefix);
    }).join('');
  }
  // 보조 문항 입력 처리 (케이스·마지막 화면 공통). getVals() 는 {id: {value, code}} 를 돌려준다.
  function bindItems(host, list, getVals, prefix, onChange) {
    var byId = {}; list.forEach(function (f) { byId[f.id] = f; });
    var rerender = function () { host.innerHTML = itemsHTML(list, getVals(), prefix); };
    host.addEventListener('click', function (e) {
      if (staleTab) return;
      var b = e.target.closest('button');
      if (!b) return;
      var vals = getVals();
      var seg = b.closest('.seg[data-field]'), chips = b.closest('.chips[data-multi]');
      if (seg) {
        var f = byId[seg.getAttribute('data-field')], v = b.getAttribute('data-value');
        var beforeVis = list.map(function (x) { return itemVisible(x, vals); }).join();
        vals[f.id] = { value: v, code: fieldCode(f, v) };
        list.forEach(function (x) { if (!itemVisible(x, vals)) delete vals[x.id]; });
        if (beforeVis !== list.map(function (x) { return itemVisible(x, vals); }).join()) rerender();
        else Array.prototype.forEach.call(seg.querySelectorAll('button'), function (x) {
          x.setAttribute('aria-checked', String(x === b)); x.setAttribute('tabindex', x === b ? '0' : '-1');
        });
        onChange(f);
      } else if (chips) {
        var g = byId[chips.getAttribute('data-multi')];
        var on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        var picked = Array.prototype.filter.call(chips.querySelectorAll('.chip'), function (x) { return x.getAttribute('aria-pressed') === 'true'; })
          .map(function (x) { return x.getAttribute('data-value'); });
        if (picked.length) vals[g.id] = { value: picked.join(';'), code: '' }; else delete vals[g.id];
        onChange(g);
      }
      saveSoon();
    });
  }
  function commentPlaceholder(c) {
    var h = (c.items || {}).harm;
    return (h && Number(h.code) >= 2) ? '위해 가능성이 있다고 판단한 내용을 간단히 적어 주세요 (선택).'
      : '강점, 우려되는 점, 실제 진료에 그대로 쓰기 어려운 부분 등을 자유롭게 적어 주세요.';
  }

  // 후보 조합 카드 노출(화면에 절반 이상 보였는지)과 머문 시간
  var comboObs = null, comboVis = {}, comboCase = null;
  function startComboObs(c) {
    stopComboObs();
    if (!('IntersectionObserver' in window)) return;
    comboCase = c;
    if (!c.metrics.combo_seen) { c.metrics.combo_seen = [false, false, false]; c.metrics.combo_dwell_ms = [0, 0, 0]; }
    comboObs = new IntersectionObserver(function (entries) {
      var now = performance.now();
      entries.forEach(function (en) {
        var k = Number(en.target.getAttribute('data-combo'));
        var vis = en.isIntersecting && en.intersectionRect.height >= 0.5 * Math.min(en.boundingClientRect.height, window.innerHeight);
        if (vis) { comboCase.metrics.combo_seen[k - 1] = true; if (!comboVis[k]) comboVis[k] = document.hidden ? -1 : now; }
        else if (comboVis[k]) { if (comboVis[k] > 0) comboCase.metrics.combo_dwell_ms[k - 1] += now - comboVis[k]; comboVis[k] = 0; }
      });
    }, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    Array.prototype.forEach.call(elMain.querySelectorAll('.combo-card'), function (el) { comboObs.observe(el); });
  }
  function pauseComboDwell() {
    if (!comboObs || !comboCase) return;
    var now = performance.now();
    Object.keys(comboVis).forEach(function (k) {
      if (comboVis[k] > 0) { comboCase.metrics.combo_dwell_ms[k - 1] += now - comboVis[k]; comboVis[k] = -1; }
    });
  }
  function resumeComboDwell() {
    if (!comboObs) return;
    var now = performance.now();
    Object.keys(comboVis).forEach(function (k) { if (comboVis[k] === -1) comboVis[k] = now; });
  }
  function stopComboObs() {
    if (!comboObs) return;
    pauseComboDwell();
    comboObs.disconnect(); comboObs = null; comboVis = {}; comboCase = null;
  }

  function caseRecapHTML(c) {
    var out = DATA.outputs[c.key];
    var row = function (k, label, val) { return '<dt>' + label + '</dt><dd>' + val + '</dd>'; };
    var score = function (k) {
      var v = c.ratings[k];
      return v == null ? '<span class="muted">미입력</span>' : '<b>' + v + '점</b> <span class="muted small">' + esc(SCALE[v - 1].label) + '</span>';
    };
    return '<dl class="kv">' +
      row('p1', 'Phase 1', score('p1')) +
      row('combo', '선호 조합', c.combo ? '<b>조합 ' + c.combo + '</b> <span class="muted small">' + esc(drugLine(out.combinations[c.combo - 1])) + '</span>' : '<span class="muted">미선택</span>') +
      row('p2', 'Phase 2', score('p2')) +
      row('p3', 'Phase 3', score('p3')) +
      row('p4', 'Phase 4', score('p4')) +
      row('p5', 'Phase 5', score('p5')) +
      '</dl>';
  }

  function renderDock() {
    if (!S || S.screen !== 'case') { elDock.innerHTML = ''; return; }
    var c = curCase(), st = curStep();
    var back = S.stepIdx > 0 ? '<button type="button" class="btn btn-ghost" data-act="back">이전</button>' : '';
    var nav = function (label, enabled, accent) {
      return '<div class="dock-nav' + (back ? '' : ' single') + '">' + back +
        '<button type="button" class="btn ' + (accent ? 'btn-accent' : 'btn-primary') + '" data-act="next"' +
        (enabled ? '' : ' aria-disabled="true"') + '>' + label + '</button></div>';
    };
    var html = '<div class="dock-inner">';
    if (st === 'vignette') {
      html += '<div class="dock-kicker"><span>환자 정보 확인</span></div>' +
        '<p class="dock-msg">환자 기록을 확인한 뒤 AI 답변 평가를 시작하세요.</p>' +
        nav('AI 답변 보기 →', true);
    } else if (PHASES[st]) {
      var ph = PHASES[st], val = c.ratings[st];
      html += '<div class="dock-kicker"><span>' + esc(ph.num) + ' · 임상 수용성</span><span class="req-hint">' + (val == null ? '점수를 선택하세요' : '') + '</span></div>' +
        '<p class="dock-statement" id="stmt">' + esc(ph.statement) + '</p>' +
        '<div class="likert" role="radiogroup" aria-labelledby="stmt">' +
          SCALE.map(function (s) {
            var tab = (val === s.v || (val == null && s.v === 1)) ? 0 : -1;
            return '<button type="button" role="radio" tabindex="' + tab + '" data-rate="' + s.v + '" aria-checked="' + (val === s.v) + '" aria-label="' + s.v + '점 ' + esc(s.label) + '">' +
              s.v + '<small>' + esc(s.label) + '</small></button>';
          }).join('') +
        '</div>' +
        '<div class="likert-anchors"><span>1 전혀 그렇지 않다</span>' +
          (val != null ? '<span class="sel">' + val + ' · ' + esc(SCALE[val - 1].label) + '</span>' : '') +
          '<span>매우 그렇다 5</span></div>' +
        nav(st === 'p5' ? '다음: 의견 →' : '다음 →', val != null);
    } else if (st === 'combo') {
      html += '<div class="dock-kicker"><span>선호 조합 선택</span><span class="req-hint">' + (c.combo == null ? '박스를 눌러 선택' : '') + '</span></div>' +
        '<p class="dock-msg">가장 선호하는 조합의 박스를 누르면 바로 Phase 2 평가로 넘어갑니다.</p>' +
        nav(c.combo ? '조합 ' + c.combo + '으로 계속 →' : '조합을 선택하세요', c.combo != null);
    } else if (st === 'comment') {
      var last = S.caseIdx === nCases() - 1;
      var okItems = itemsComplete(CASE_ITEMS, c.items || {});
      html += '<div class="dock-kicker"><span>케이스 ' + (S.caseIdx + 1) + ' 마무리</span><span class="req-hint">' + (okItems ? '' : '보조 문항에 답해 주세요') + '</span></div>' +
        '<p class="dock-msg">' + (last ? '마지막 케이스입니다. 다음 화면에서 전체 의견을 남기고 제출합니다.' : '다음 케이스로 넘어가면 이 케이스의 응답이 저장됩니다.') + '</p>' +
        nav(last ? '케이스 평가 완료 →' : '저장하고 다음 케이스 →', okItems, true);
    }
    html += '</div>';
    elDock.innerHTML = html;
    updateDockSize();
  }

  elDock.addEventListener('keydown', function (e) {
    var b = e.target.closest('button[role="radio"]');
    if (!b) return;
    var d = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    if (b.hasAttribute('data-rate')) {
      var v = Math.min(5, Math.max(1, Number(b.getAttribute('data-rate')) + d));
      setRating(curStep(), v);
      var nb = elDock.querySelector('[data-rate="' + v + '"]'); if (nb) nb.focus();
    } else if (b.hasAttribute('data-combo')) {
      var n = Math.min(3, Math.max(1, Number(b.getAttribute('data-combo')) + d));
      setCombo(n);
      var nc = elDock.querySelector('[data-combo="' + (curCase().combo || n) + '"]'); if (nc) nc.focus();
    }
  });
  elDock.addEventListener('click', function (e) {
    if (!elDrawer.hidden || staleTab) return;
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-rate')) { setRating(curStep(), Number(b.getAttribute('data-rate'))); return; }
    if (b.hasAttribute('data-combo')) { setCombo(Number(b.getAttribute('data-combo'))); return; }
    var act = b.getAttribute('data-act');
    if (act === 'next') goNext();
    else if (act === 'back') goBack();
  });

  function renderFinal() {
    var rows = S.cases.map(function (c, i) {
      var out = DATA.outputs[c.key];
      return '<section class="card tight"><div class="case-head"><span class="pill navy">케이스 ' + (i + 1) + '</span>' +
        '<span class="pill">환자 ' + esc(out.patient) + '</span></div><div style="margin-top:8px">' + caseRecapHTML(c) + '</div></section>';
    }).join('');
    elMain.innerHTML =
      '<section class="card"><span class="eyebrow">마지막 단계</span>' +
        '<h1 style="font-size:22px;color:var(--navy);margin-top:6px">케이스 평가를 모두 마쳤습니다</h1>' +
        '<p class="lead" style="margin-top:6px">AI CDSS 답변 전반에 대한 의견을 남기신 뒤 <b>평가 제출</b>을 눌러 주세요.</p></section>' +
      (END_ITEMS.length ? '<section class="card sub-items"><span class="sub-tag">보조 문항</span><div id="endItems" style="margin-top:6px">' +
        itemsHTML(END_ITEMS, S.end_items || {}, 'ei_') + '</div></section>' : '') +
      '<section class="card"><div class="field"><label for="overallComment">AI 답변 전반에 대한 의견 (선택)</label>' +
        '<p class="small muted">이러한 AI 답변을 실제 진료에서 어떻게 받아들이실지, 신뢰하거나 망설여지는 부분, 개선이 필요한 점 등을 자유롭게 적어 주세요.</p>' +
        '<textarea class="input" id="overallComment" maxlength="5000">' + esc(S.overall_comment) + '</textarea>' +
        '<div class="char-count" id="ocCount">' + S.overall_comment.length + ' / 5000</div></div>' +
        '<button type="button" class="btn btn-accent btn-block" id="submitBtn" style="margin-top:14px">평가 제출</button></section>' +
      '<h2 class="section-title" style="margin-top:22px">제출 전 응답 요약</h2>' + rows;
    elDock.innerHTML = '';
    $('overallComment').addEventListener('input', function (e) {
      S.overall_comment = e.target.value;
      $('ocCount').textContent = e.target.value.length + ' / 5000';
      saveSoon();
    });
    $('submitBtn').addEventListener('click', goNext);
    if ($('endItems')) bindItems($('endItems'), END_ITEMS, function () { return S.end_items || (S.end_items = {}); }, 'ei_', function () { save(); });
  }

  function downloadJSON() {
    var payload = {
      study_id: S.study_id, app_version: S.app_version, data_version: S.data_version,
      session_id: S.session_id, is_test: S.is_test, evaluator: S.evaluator, study_type: S.study_type,
      sequence_index: S.seq_index, seq_source: S.seq_source, order: S.order,
      session: sessionSummary(), overall_comment: S.overall_comment, end_items: S.end_items || {}, device: S.device,
      evaluator_id: S.evaluator_id, entry: S.entry, consent: S.consent, session_ordinal: S.session_ordinal,
      cases: S.cases.map(function (_, i) { return buildCaseRecord(i); })
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'clinical-acceptability_' + (S.evaluator.name || 'anon') + '_' + S.session_id.slice(0, 8) + '.json';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function renderDone() {
    var sum = sessionSummary();
    var status;
    if (!CFG.ENDPOINT) {
      status = '<p class="status-line pending"><span class="dot"></span>테스트 모드: 서버 주소(ENDPOINT)가 설정되지 않아 응답이 전송되지 않았습니다.</p>' +
        '<p class="small muted" style="margin-top:6px">아래 버튼으로 응답 파일(JSON)을 내려받을 수 있습니다.</p>';
    } else if (!S.outbox.length && S.net.status !== 'sending') {
      status = '<p class="status-line ok"><span class="dot"></span>응답이 안전하게 저장되었습니다.</p>';
    } else if (S.net.status === 'fail' || !flushing) {
      status = '<p class="status-line fail"><span class="dot"></span>전송하지 못한 응답이 있습니다 (' + S.outbox.length + '건).</p>' +
        '<p class="small muted" style="margin-top:6px">네트워크 연결을 확인한 뒤 [다시 전송]을 눌러 주세요. 응답은 이 기기에 보관되어 있습니다.' +
        (S.net.last_error ? ' (' + esc(S.net.last_error) + ')' : '') + '</p>';
    } else {
      status = '<p class="status-line pending"><span class="dot"></span>응답을 전송하고 있습니다…</p>';
    }
    var showRetry = CFG.ENDPOINT && S.outbox.length && (S.net.status === 'fail' || !flushing);
    var doneTypes = (S.done_types || []).concat([S.study_type]);
    var otherTypes = TYPES.filter(function (t) { return doneTypes.indexOf(t.id) < 0; });
    elMain.innerHTML =
      '<section class="card hero"><span class="eyebrow">완료</span><h1>평가해 주셔서 감사합니다</h1>' +
        '<p class="desc">' + esc(S.evaluator.name) + ' 선생님 (' + esc(S.evaluator.detail || '') + ') · ' + esc((typeById(S.study_type) || {}).label || '') + ' 응답이 기록되었습니다.</p></section>' +
      '<section class="card">' + status +
        '<div class="stat-row" style="margin-top:14px">' +
          '<div class="stat"><b>' + sum.cases_completed + ' / ' + nCases() + '</b><span>평가한 AI 답변</span></div>' +
          '<div class="stat"><b>' + fmtMin(sum.total_active_ms + sum.total_idle_ms) + '</b><span>총 평가 시간</span></div>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:16px">' +
          (showRetry ? '<button type="button" class="btn btn-primary" id="retryBtn">다시 전송</button>' : '') +
          ((!CFG.ENDPOINT || showRetry) ? '<button type="button" class="btn btn-ghost" id="dlBtn">응답 파일 내려받기</button>' : '') +
        '</div>' +
      '</section>' +
      (otherTypes.length ? '<section class="card"><h2 class="section-title">다른 유형도 평가하기</h2>' +
        '<p class="small muted">같은 평가자 정보로 다른 Type의 AI 답변 2건을 이어서 평가할 수 있습니다.</p><div class="btn-row" style="margin-top:10px">' +
        otherTypes.map(function (t) { return '<button type="button" class="btn btn-primary" data-next-type="' + esc(t.id) + '">' + esc(t.label) + ' 평가하기</button>'; }).join('') +
        '</div></section>' : '') +
      '<section class="card"><p class="small muted">이 기기에서 다른 평가자가 이어서 평가하려면 아래 버튼을 눌러 새로 시작하세요.</p>' +
        '<button type="button" class="btn btn-ghost" id="newBtn" style="margin-top:10px">새 평가 시작</button></section>';
    elDock.innerHTML = '';
    if ($('retryBtn')) $('retryBtn').addEventListener('click', function () { flush(); });
    if ($('dlBtn')) $('dlBtn').addEventListener('click', downloadJSON);
    var restart = function (prefill) {
      if (S.outbox.length && CFG.ENDPOINT) {
        if (!window.confirm('아직 전송되지 않은 응답이 있습니다. 새로 시작하면 이 기기에 보관된 응답이 삭제됩니다. 계속하시겠습니까?')) return;
      } else if (!prefill && !window.confirm('새 평가를 시작하시겠습니까?')) return;
      var prev = S;
      try { localStorage.removeItem(STORE_KEY); } catch (_) {}
      S = null;
      flushing = false;
      lastRev = 0;
      draft = emptyDraft();
      if (prefill) {
        draft.name = prev.evaluator.name; draft.role = prev.evaluator.role;
        var role = roleById(prev.evaluator.role);
        (role ? role.fields : []).forEach(function (f) {
          var v = prev.evaluator.fields[f.id] || '';
          if (f.other && v.indexOf('기타: ') === 0) { draft.fields[f.id] = f.other; draft.other[f.id] = v.slice(4); }
          else draft.fields[f.id] = v;
        });
        COMMON.forEach(function (f) { draft.fields[f.id] = prev.evaluator.fields[f.id] || ''; });
        draft.type = prefill; draft.consent = true; draft.linked = prev.session_id;
        draft.consent_at = (prev.consent || {}).at || nowIso(); draft.consent_inherited = true;
        draft.done_types = (prev.done_types || []).concat([prev.study_type]);
        draft.evaluator_id = prev.evaluator_id || null;
        draft.prev_cases = (prev.prev_cases || 0) + prev.cases.length;
        draft.prev_patients = (prev.prev_patients || []).concat(prev.order.map(function (k) { return DATA.outputs[k].patient; }));
      }
      T.last = performance.now();
      render();
      if (prefill && $('evaluatorCard')) $('evaluatorCard').scrollIntoView({ block: 'start' }); else window.scrollTo(0, 0);
    };
    $('newBtn').addEventListener('click', function () { restart(null); });
    Array.prototype.forEach.call(elMain.querySelectorAll('[data-next-type]'), function (b) {
      b.addEventListener('click', function () { restart(b.getAttribute('data-next-type')); });
    });
  }

  function updateTopbar() {
    var label = '', pct = 0, showPatient = false;
    if (staleTab) { label = ''; }
    else if (S && S.screen === 'case') {
      label = '케이스 ' + (S.caseIdx + 1) + '/' + nCases() + ' · ' + STEP_LABEL[curStep()];
      pct = (S.caseIdx * STEPS.length + S.stepIdx) / totalSteps() * 100;
      showPatient = S.stepIdx > 0;
    } else if (S && S.screen === 'final') { label = '제출 전'; pct = 100; }
    else if (S && S.screen === 'done') { label = '완료'; pct = 100; }
    $('topbar').classList.toggle('in-case', !!(S && S.screen === 'case'));
    elTopProg.textContent = label;
    elFill.style.width = pct + '%';
    elPatientBtn.hidden = !showPatient;
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
        '<h1 style="font-size:20px;color:var(--navy);margin-top:6px">이 평가는 다른 탭(창)에서 이어서 진행되고 있습니다</h1>' +
        '<p class="lead" style="margin-top:8px">응답이 섞이지 않도록 이 탭은 멈췄습니다. 이 탭을 닫거나, 이 탭에서 계속하려면 아래 버튼을 눌러 주세요. ' +
        '(다른 탭은 자동으로 멈춥니다.)</p>' +
        '<button type="button" class="btn btn-primary" id="takeOverBtn" style="margin-top:14px">이 탭에서 이어서 하기</button></section>';
    elDock.innerHTML = '';
    $('takeOverBtn').addEventListener('click', function () { location.reload(); });
  }

  function render() {
    var testMode = (S ? S.is_test : (URL_TEST || !CFG.ENDPOINT));
    elTestBanner.hidden = !testMode;
    elTestBanner.textContent = !CFG.ENDPOINT
      ? '테스트 모드 — 서버 주소가 설정되지 않아 응답이 서버로 전송되지 않습니다.'
      : '테스트 응답 — 이 응답은 분석에서 제외되도록 표시됩니다.';

    if (staleTab) renderStale();
    else if (!S) renderIntro();
    else if (S.screen === 'intro') renderStarting();
    else if (S.screen === 'case') { renderCaseMain(); renderDock(); }
    else if (S.screen === 'final') renderFinal();
    else if (S.screen === 'done') renderDone();
    elLayout.classList.toggle('no-dock', !elDock.innerHTML);
    elLayout.classList.toggle('combo-wide', !!(S && S.screen === 'case' && !staleTab && S.order && curStep() === 'combo'));
    updateTopbar();
    updateDockSize();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  if (S && S.screen === 'intro') {
    // 순서 배정 도중 창이 닫힌 경우: 처음부터
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    S = null;
  }
  if (S && (S.screen === 'case' || S.screen === 'final')) {
    S.metrics.resumes += 1;
    S.device.last_resume = deviceInfo();
    save();
    setTimeout(function () { toast('이전에 진행하던 평가를 불러왔습니다.', 3200); }, 300);
  }
  render();
  if (S && S.screen === 'case') { var m = stepMetrics(curCase(), curStep()); m.visits += 1; save(); }
  if (S) flush();

  // expose minimal hooks for QA (no PII)
  window.__T2D_APP__ = { version: CFG.APP_VERSION, state: function () { return S; } };
})();
