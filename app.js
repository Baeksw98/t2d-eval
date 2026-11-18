/* 임상 수용성 평가 (Physician Clinical Acceptability Assessment) — app */
(function () {
  'use strict';

  var CFG = window.T2D_CONFIG;
  var DATA = window.T2D_DATA;
  var STORE_KEY = 't2d-ca:' + CFG.STUDY_ID + ':v2';
  var IDLE_MS = 180000;          // 3분 이상 조작이 없으면 idle 로 분류
  var START_TIMEOUT_MS = 15000;  // 순서 배정 요청 대기 한도 (Apps Script 첫 호출 지연 고려)
  var POST_TIMEOUT_MS = 30000;
  var NAV_LOCK_MS = 450;         // 화면 전환 직후 연속 탭으로 단계를 건너뛰지 않도록

  var params = new URLSearchParams(location.search);
  var URL_TEST = params.get('test') === '1';
  if (params.get('reset') === '1') {
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    history.replaceState(null, '', location.pathname + (URL_TEST ? '?test=1' : ''));
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
      ttfr_ms: null, changes: 0, history: [], scroll_max: 0, drawer_opens: 0, drawer_ms: 0
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
      metrics: { intro: emptyBucket(), final: emptyBucket(), active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0, resumes: 0 },
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
    return { name: '', role: '', fields: {}, other: {}, type: URL_TYPE, consent: false, linked: null, done_types: [], introBucket: emptyBucket() };
  }
  var draft = emptyDraft();

  // 평가자 정보 → 저장용 객체 (직군·추가 항목은 config.EVALUATOR_ROLES 기준)
  function buildEvaluator() {
    var role = roleById(draft.role);
    var fields = {}, parts = [role.label];
    role.fields.forEach(function (f) {
      var v = String(draft.fields[f.id] || '').trim();
      if (f.other && v === f.other) v = '기타: ' + String(draft.other[f.id] || '').trim();
      fields[f.id] = v;
      if (v) parts.push(v);
    });
    return {
      name: draft.name.trim(), role: role.id, role_label: role.label, fields: fields,
      detail: parts.join(' · '),
      year: fields.year || ''   // 이전 버전 시트의 ResidentYear 컬럼 호환
    };
  }
  function draftError() {
    if (!draft.name.trim()) return '성명을 입력해 주세요.';
    var role = roleById(draft.role);
    if (!role) return '직군(인턴·레지던트·전문의)을 선택해 주세요.';
    for (var i = 0; i < role.fields.length; i++) {
      var f = role.fields[i], v = String(draft.fields[f.id] || '').trim();
      if (f.required && !v) return f.label + '을(를) 선택해 주세요.';
      if (f.other && v === f.other && !String(draft.other[f.id] || '').trim()) return f.label + '을(를) 직접 입력해 주세요.';
    }
    if (!typeById(draft.type)) return '평가 유형(Type)을 선택해 주세요.';
    if (!draft.consent) return '안내 사항 확인에 체크해 주세요.';
    return '';
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
    if (!document.hidden) { T.lastInteract = performance.now(); flush(); }
    save();
  });
  var unloading = false;
  window.addEventListener('pagehide', function () { unloading = true; tick(); save(); });
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
      n_sequences: typeSeqs().length
    };
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
    return STEPS.reduce(function (acc, st) { var m = c.metrics.steps[st]; return acc + (m ? m[field] : 0); }, 0);
  }
  function buildCaseRecord(i) {
    var c = S.cases[i];
    var out = DATA.outputs[c.key];
    var comboName = c.combo ? out.combinations[c.combo - 1].name : '';
    return {
      case_index: i + 1, case_key: c.key, patient_id: out.patient, model: out.model, model_name: out.model_name,
      ratings: c.ratings, combo_choice: c.combo, combo_name: comboName,
      combo_is_ai_first: c.combo === 1,
      comment: c.comment,
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
      cases_completed: S.cases.filter(function (c) { return c.completed_at; }).length
    };
  }

  // ---------------------------------------------------------------------------
  // Flow control
  // ---------------------------------------------------------------------------
  function initCases(order) {
    return order.map(function (key) {
      return {
        key: key, ratings: { p1: null, p2: null, p3: null, p4: null, p5: null },
        combo: null, comment: '', started_at: null, completed_at: null,
        metrics: { steps: {}, combo_resets: 0 }
      };
    });
  }

  var navLockUntil = 0;
  function enterStep() {
    elToast.hidden = true;
    closeDrawer();
    navLockUntil = performance.now() + NAV_LOCK_MS;
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
    var err = draftError();
    if (err) { toast(err); if (!draft.name.trim() && $('evName')) $('evName').focus(); return; }
    tick();
    starting = true;
    S = newState(buildEvaluator(), draft.type, draft.linked);
    S.done_types = draft.done_types || [];
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
    return true;
  }

  function goNext() {
    if (!S) { startSession(); return; }
    if (staleTab || performance.now() < navLockUntil) return;
    tick();
    if (S.screen === 'case') {
      if (!stepComplete()) {
        toast(curStep() === 'combo' ? '선호하는 조합을 선택해 주세요.' : '1–5점 중 하나를 선택해 주세요.');
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
        enqueue(p);
        navLockUntil = performance.now() + NAV_LOCK_MS;
        save(); render(); window.scrollTo(0, 0);
      }
      return;
    }
    if (S.screen === 'final') {
      S.finished_at = nowIso();
      S.screen = 'done';
      var fp = basePayload('finish');
      fp.device = S.device;
      fp.session = sessionSummary();
      fp.overall_comment = S.overall_comment;
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
    if (m.ttfr_ms == null) m.ttfr_ms = Math.round(m.active_ms + m.idle_ms) - (m.ttfr_base || 0);
    else m.changes += 1;
    m.history.push([v, Math.round(m.active_ms + m.idle_ms)]);
    c.ratings[key] = v;
    save();
    var hadFocus = elDock.contains(document.activeElement);
    renderDock();
    if (hadFocus) { var b = elDock.querySelector('[data-rate="' + v + '"]'); if (b) b.focus(); }
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
    if (m.ttfr_ms == null) m.ttfr_ms = Math.round(m.active_ms + m.idle_ms);
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
  function roleFieldsHTML() {
    var role = roleById(draft.role);
    if (!role || !role.fields.length) return '';
    return role.fields.map(function (f) {
      var cur = draft.fields[f.id] || '';
      var lab = '<span class="label" id="lbl_' + esc(f.id) + '">' + esc(f.label) + (f.required ? '<span class="req">*</span>' : '') + '</span>';
      if (f.type === 'choice') {
        return '<div class="field">' + lab + '<div class="seg" role="radiogroup" aria-labelledby="lbl_' + esc(f.id) + '" data-field="' + esc(f.id) + '" style="grid-template-columns:repeat(' + f.options.length + ',1fr)">' +
          segHTML('data-value', f.options.map(function (o) { return { value: o, label: o }; }), cur) + '</div></div>';
      }
      if (f.type === 'select') {
        var opts = '<option value="">' + esc(f.placeholder || '선택하세요') + '</option>' +
          (f.groups || [{ label: '', options: f.options || [] }]).map(function (g) {
            var o = g.options.map(function (x) { return '<option' + (cur === x ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('');
            return g.label ? '<optgroup label="' + esc(g.label) + '">' + o + '</optgroup>' : o;
          }).join('') +
          (f.other ? '<option' + (cur === f.other ? ' selected' : '') + '>' + esc(f.other) + '</option>' : '');
        return '<div class="field">' + lab.replace('<span class="label"', '<label class="label" for="fld_' + esc(f.id) + '"').replace(/<\/span>$/, '</label>') +
          '<select class="input" id="fld_' + esc(f.id) + '" data-field="' + esc(f.id) + '">' + opts + '</select>' +
          (f.other && cur === f.other ? '<input class="input" type="text" maxlength="60" data-other="' + esc(f.id) + '" placeholder="직접 입력" value="' + esc(draft.other[f.id] || '') + '">' : '') +
          '</div>';
      }
      return '<div class="field">' + lab + '<input class="input" type="text" maxlength="60" data-field="' + esc(f.id) + '" value="' + esc(cur) + '"></div>';
    }).join('');
  }

  function renderIntro() {
    var legend = SCALE.map(function (s) { return '<div><b>' + s.v + '</b>' + esc(s.label) + '</div>'; }).join('');
    var roles = segHTML('data-role', ROLES.map(function (r) { return { value: r.id, label: r.label }; }), draft.role);
    var types = segHTML('data-type', TYPES.map(function (t) { return { value: t.id, label: t.label }; }), draft.type);
    elMain.innerHTML =
      '<section class="card hero">' +
        '<span class="eyebrow">AI 기반 T2D 임상 의사결정 지원 시스템</span>' +
        '<h1>임상 수용성 평가</h1>' +
        '<p class="sub">Physician Clinical Acceptability Assessment</p>' +
        '<p class="desc">AI 임상 의사결정 지원 시스템(CDSS)이 생성한 제2형 당뇨병 외래 진료 권고안을 읽고, ' +
        '각 단계의 답변이 실제 임상 결정에 유의미한 참고가 되는지 평가해 주십시오.</p>' +
      '</section>' +

      (draft.linked ? '<p class="notice info">이전 평가에 이어 <b>' + esc((typeById(draft.type) || {}).label || '') + '</b>를 평가합니다. 아래 평가자 정보를 확인하고 시작해 주세요.</p>' : '') +

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
        '<div class="field"><label for="evName">성명<span class="req">*</span></label>' +
          '<input class="input" id="evName" type="text" autocomplete="name" maxlength="40" placeholder="예: 홍길동" value="' + esc(draft.name) + '"></div>' +
        '<div class="field"><span class="label" id="roleLabel">직군<span class="req">*</span></span>' +
          '<div class="seg" role="radiogroup" aria-labelledby="roleLabel" id="roleSeg" style="grid-template-columns:repeat(' + ROLES.length + ',1fr)">' + roles + '</div></div>' +
        '<div id="roleFields">' + roleFieldsHTML() + '</div>' +
        '<div class="field"><span class="label" id="typeLabel">평가 유형<span class="req">*</span></span>' +
          '<p class="small muted" style="margin:0">연구진이 안내한 Type을 선택해 주세요. 각 Type은 AI 답변 2건입니다.</p>' +
          '<div class="seg" role="radiogroup" aria-labelledby="typeLabel" id="typeSeg" style="grid-template-columns:repeat(' + TYPES.length + ',1fr)">' + types + '</div></div>' +
        '<div class="field" style="margin-top:18px"><label class="check"><input type="checkbox" id="evConsent"' + (draft.consent ? ' checked' : '') + '>' +
          '<span>본 평가의 목적을 이해했으며, 응답(성명·직군·평가 점수·의견)과 응답 과정 정보(단계별 소요 시간, 기기 종류)가 연구 목적으로 수집되는 데 동의합니다.</span></label></div>' +
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
        if (draft.role !== r) { draft.role = r; draft.fields = {}; draft.other = {}; $('roleFields').innerHTML = roleFieldsHTML(); }
      } else if (b.hasAttribute('data-type')) {
        draft.type = b.getAttribute('data-type');
      } else if (seg.hasAttribute('data-field')) {
        draft.fields[seg.getAttribute('data-field')] = b.getAttribute('data-value');
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
        var f = (roleById(draft.role).fields.filter(function (x) { return x.id === id; })[0]) || {};
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
    $('evConsent').addEventListener('change', function (e) { draft.consent = e.target.checked; });
    $('startBtn').addEventListener('click', startSession);
    elDock.innerHTML = '';
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
      html += caseHeadHTML('선호 조합 선택', 'AI가 이 환자에게 제시한 후보 약물 조합 3개입니다. 처방 내역을 살펴보고 <b>가장 선호하는 조합 1개</b>를 선택해 주세요. 선택한 조합으로 Phase 2–5를 평가합니다.');
      html += '<div class="combo-grid three" role="radiogroup" aria-label="후보 약물 조합" id="comboGroup">' +
        out.combinations.map(function (cb, i) {
          var n = i + 1;
          var tab = (c.combo === n || (c.combo == null && n === 1)) ? 0 : -1;
          return '<div class="combo-card" role="radio" tabindex="' + tab + '" data-combo="' + n + '" aria-checked="' + (c.combo === n) + '"' +
            ' aria-labelledby="cbno' + n + ' cbname' + n + '">' +
            '<div class="combo-top"><span class="radio-dot" aria-hidden="true"></span><div>' +
              '<div class="combo-no" id="cbno' + n + '">조합 ' + n + '</div><div class="combo-name" id="cbname' + n + '">' + esc(cb.name) + '</div></div></div>' +
            rxListHTML(cb.prescription) +
          '</div>';
        }).join('') + '</div>';
    } else if (PHASES[st]) {
      var cb = out.combinations[c.combo - 1];
      var a = cb.answers;
      html += caseHeadHTML('AI 답변 평가');
      html += '<div class="selected-banner"><div class="sb-label">선택한 조합 · 조합 ' + c.combo + '</div>' +
        '<div class="sb-name">' + esc(cb.name) + '</div>' +
        (st === 'p2' ? '<div style="margin-top:10px">' + rxListHTML(cb.prescription) + '</div>'
          : '<details><summary>처방 내역 보기</summary>' + rxListHTML(cb.prescription) + '</details>') +
        '</div>';
      html += phaseHeadHTML(st);
      html += '<div class="items">' + PHASES[st].items.map(function (it) {
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
      html += caseHeadHTML('이 AI 답변에 대한 의견', '선택 사항입니다. 비워 두고 넘어가셔도 됩니다.');
      html += '<section class="card"><h3 class="section-title">이번 케이스 평가 요약</h3>' + caseRecapHTML(c) +
        '<p class="small muted" style="margin-top:8px">점수를 고치려면 아래 [이전] 버튼으로 해당 단계로 돌아가세요.</p></section>';
      html += '<section class="card"><div class="field"><label for="caseComment">자유 의견</label>' +
        '<textarea class="input" id="caseComment" maxlength="3000" placeholder="강점, 우려되는 점, 실제 진료에 그대로 쓰기 어려운 부분 등을 자유롭게 적어 주세요.">' + esc(c.comment) + '</textarea>' +
        '<div class="char-count" id="ccCount">' + c.comment.length + ' / 3000</div></div></section>';
    }
    elMain.innerHTML = html;

    if (st === 'combo') {
      var grp = $('comboGroup');
      grp.addEventListener('click', function (e) {
        var card = e.target.closest('.combo-card');
        if (card) setCombo(Number(card.getAttribute('data-combo')));
      });
      grp.addEventListener('keydown', function (e) {
        var card = e.target.closest('.combo-card');
        if (!card) return;
        var n = Number(card.getAttribute('data-combo'));
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCombo(n); return; }
        var d = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowUp' || e.key === 'ArrowLeft') ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var m = ((n - 1 + d + 3) % 3) + 1;
        setCombo(m);
        var sel = curCase().combo || m;   // 초기화 확인을 취소했다면 기존 선택에 포커스
        var nx = grp.querySelector('[data-combo="' + sel + '"]');
        if (nx) nx.focus();
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

  function caseRecapHTML(c) {
    var out = DATA.outputs[c.key];
    var row = function (k, label, val) { return '<dt>' + label + '</dt><dd>' + val + '</dd>'; };
    var score = function (k) {
      var v = c.ratings[k];
      return v == null ? '<span class="muted">미입력</span>' : '<b>' + v + '점</b> <span class="muted small">' + esc(SCALE[v - 1].label) + '</span>';
    };
    return '<dl class="kv">' +
      row('p1', 'Phase 1', score('p1')) +
      row('combo', '선호 조합', c.combo ? '<b>조합 ' + c.combo + '</b> <span class="muted small">' + esc(out.combinations[c.combo - 1].name) + '</span>' : '<span class="muted">미선택</span>') +
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
      html += '<div class="dock-kicker"><span>선호 조합 선택</span><span class="req-hint">' + (c.combo == null ? '1개를 선택하세요' : '') + '</span></div>' +
        '<p class="dock-statement" id="stmt">이 환자에게 가장 선호하는 조합은?</p>' +
        '<div class="likert combo-pick" role="radiogroup" aria-labelledby="stmt">' +
          [1, 2, 3].map(function (n) {
            var tab = (c.combo === n || (c.combo == null && n === 1)) ? 0 : -1;
            return '<button type="button" role="radio" tabindex="' + tab + '" data-combo="' + n + '" aria-checked="' + (c.combo === n) + '">조합 ' + n + '</button>';
          }).join('') +
        '</div>' +
        nav('선택 완료 →', c.combo != null);
    } else if (st === 'comment') {
      var last = S.caseIdx === nCases() - 1;
      html += '<div class="dock-kicker"><span>케이스 ' + (S.caseIdx + 1) + ' 마무리</span></div>' +
        '<p class="dock-msg">' + (last ? '마지막 케이스입니다. 다음 화면에서 전체 의견을 남기고 제출합니다.' : '다음 케이스로 넘어가면 이 케이스의 응답이 저장됩니다.') + '</p>' +
        nav(last ? '케이스 평가 완료 →' : '저장하고 다음 케이스 →', true, true);
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
  }

  function downloadJSON() {
    var payload = {
      study_id: S.study_id, app_version: S.app_version, data_version: S.data_version,
      session_id: S.session_id, is_test: S.is_test, evaluator: S.evaluator, study_type: S.study_type,
      sequence_index: S.seq_index, seq_source: S.seq_source, order: S.order,
      session: sessionSummary(), overall_comment: S.overall_comment, device: S.device,
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
        draft.type = prefill; draft.consent = true; draft.linked = prev.session_id;
        draft.done_types = (prev.done_types || []).concat([prev.study_type]);
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
