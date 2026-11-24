/* 임상 수용성 평가 (Physician Clinical Acceptability Assessment) — app
 * 화면 문구: i18n/ca.js (T2D.t) · 언어/테마 런타임: assets/i18n.js · 문항 설정: config.js (한국어 = 저장 값, en = 영어 화면 번역)
 * 케이스 세트: data/cases.js (window.T2D_DATA, set_id) + data/design.js (window.T2D_DESIGN, Type 배정).
 *   저장된 진행 상태의 세트가 활성 세트와 다르면 data/sets/<id>/ 의 보관본을 불러온 뒤 이어서 진행합니다. */
(function () {
  'use strict';

  var CFG = window.T2D_CONFIG;
  var DATA = window.T2D_DATA;          // 부팅(boot) 때 진행 중인 세션의 세트로 바뀔 수 있음
  var ACTIVE_SET = (DATA && DATA.set_id) || 'v1';
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
  // Language (assets/i18n.js + i18n/ca.js). 화면은 T2D.lang 으로 그리고, 응답(payload)에는 항상 한국어 원문 + code 를 저장한다.
  // ---------------------------------------------------------------------------
  var I18N = window.T2D || {};
  function t(key, vars) { return I18N.t ? I18N.t(key, vars) : key; }
  function uiLang() { return I18N.lang === 'en' ? 'en' : 'ko'; }
  function pick(v) {   // {ko, en} 또는 문자열 → 화면 언어의 문자열
    if (I18N.pick) return I18N.pick(v);
    return v && typeof v === 'object' ? String(v.ko == null ? '' : v.ko) : String(v == null ? '' : v);
  }
  // 저장용 값(canonical): {ko, en} 이면 ko, 문자열이면 그대로. 응답에 라벨을 넣는 곳은 모두 이 함수를 거친다.
  function canon(v) { return v && typeof v === 'object' ? String(v.ko == null ? '' : v.ko) : String(v == null ? '' : v); }
  // config 항목의 화면 문구: 영어 화면이면 o.en[k] (있을 때), 아니면 o[k] (한국어 원문). {ko, en} 객체도 받는다.
  function tr(o, k) {
    if (!o) return '';
    var v = o[k];
    if (uiLang() === 'en' && o.en && o.en[k] != null) v = o.en[k];
    return pick(v);
  }
  // 선택지 i 의 화면 문구 (o.options[i] 는 저장 값, o.en.options[i] 는 영어 화면 번역)
  function optLabel(o, i) {
    var raw = o.options[i], lab = Array.isArray(raw) ? raw[1] : raw;
    if (uiLang() === 'en' && o.en && o.en.options && o.en.options[i] != null) return pick(o.en.options[i]);
    return pick(lab);
  }
  // 저장된 값(한국어 원문) → 화면 문구 (완료 화면·이어서 평가 안내 등)
  function valueLabel(f, v) {
    if (!f || v == null || v === '') return String(v == null ? '' : v);
    var lists = f.groups ? f.groups : [f];
    for (var g = 0; g < lists.length; g++) {
      var i = (lists[g].options || []).indexOf(v);
      if (i >= 0) return optLabel(lists[g], i);
    }
    if (f.other && v === f.other) return tr(f, 'other');
    if (f.other && String(v).indexOf('기타: ') === 0) return t('ca.field.otherValue', { v: String(v).slice(4) });
    return String(v);
  }

  // ---------------------------------------------------------------------------
  // Study definitions
  // ---------------------------------------------------------------------------
  var SCALE = [1, 2, 3, 4, 5].map(function (v) { return { v: v, key: 'ca.instrument.scale.' + v }; });
  function scaleLabel(v) { return t('ca.instrument.scale.' + v); }

  // Delphi 확정 문항 (Phase 1–5). 문구는 i18n/ca.js 의 ca.instrument.<phase>.* (한국어 = Delphi 원문)
  var PHASES = {
    p1: { num: 'Phase 1', items: ['1.1', '1.2'] },
    p2: { num: 'Phase 2', items: ['2.1', '2.2', '2.3'] },
    p3: { num: 'Phase 3', items: ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8'] },
    p4: { num: 'Phase 4', items: ['4.1', '4.2', '4.3'] },
    p5: { num: 'Phase 5', items: ['5.1', '5.2', '5.3', '5.4'] }
  };
  function phTitle(k) { return t('ca.instrument.' + k + '.title'); }
  function phStatement(k) { return t('ca.instrument.' + k + '.statement'); }
  function qLabel(q) { return t('ca.instrument.q.' + q); }
  var PHASE_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5'];
  var STEPS = ['vignette', 'p1', 'combo', 'p2', 'p3', 'p4', 'p5', 'comment'];
  function stepLabel(st) { return /^p\d$/.test(st) ? PHASES[st].num : t('ca.step.' + st); }
  var ROLES = CFG.EVALUATOR_ROLES;
  // Type(배정 단위): 활성 세트의 data/design.js → 없거나 이 세트의 케이스와 맞지 않으면 config.js STUDY_TYPES
  function validTypes(list) {
    return Array.isArray(list) && list.length > 0 && list.every(function (ty) {
      return ty && ty.id && Array.isArray(ty.sequences) && ty.sequences.length > 0 && ty.sequences.every(function (seq) {
        return Array.isArray(seq) && seq.length > 0 && seq.every(function (k) { return !!(DATA && DATA.outputs && DATA.outputs[k]); });
      });
    });
  }
  function resolveTypes() {
    var d = window.T2D_DESIGN;
    var fromDesign = d && d.ca && d.ca.types;
    if (validTypes(fromDesign) && (!d.set_id || !DATA.set_id || d.set_id === DATA.set_id)) return fromDesign;
    return CFG.STUDY_TYPES;
  }
  function resolveMinutes() {
    var d = window.T2D_DESIGN, m = d && d.ca && d.ca.minutes;
    if (Array.isArray(m) && m.length === 2 && m.every(function (x) { return x > 0; })) return m;
    return CFG.ESTIMATED_MINUTES_RANGE || [20, 30];
  }
  var TYPES = resolveTypes();
  function roleById(id) { for (var i = 0; i < ROLES.length; i++) if (ROLES[i].id === id) return ROLES[i]; return null; }
  function typeById(id) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i]; return null; }
  function typeLabel(id) { var ty = typeById(id); return ty ? pick(ty.label) : String(id || ''); }
  function urlType() { var v = String(params.get('type') || '').toUpperCase(); return typeById(v) ? v : ''; }
  var URL_TYPE = urlType();
  var COMMON = CFG.COMMON_FIELDS || [];
  var CASE_ITEMS = CFG.CASE_ITEMS || [];
  var END_ITEMS = CFG.END_ITEMS || [];
  // 접속 경로(QR·카카오톡·링크)와 기관·차수 코드 — 개인정보 없음
  function safeParam(k) { return String(params.get(k) || '').replace(/[^0-9A-Za-z_\-]/g, '').slice(0, 32); }
  var UA = navigator.userAgent || '';
  var IN_APP = /KAKAOTALK/i.test(UA) ? 'KAKAOTALK' : /NAVER/.test(UA) ? 'NAVER' : /\bLine\//.test(UA) ? 'LINE' :
    /Instagram/i.test(UA) ? 'INSTAGRAM' : /FBAN|FBAV/.test(UA) ? 'FACEBOOK' : /; wv\)/.test(UA) ? 'WEBVIEW' : '';
  // 외부에서 바로 왔으면 그 origin. 처음 화면(/)·소개·짧은 링크(/a/ /b/)를 거쳐 왔으면 referrer 가 이 사이트이므로,
  // 그 페이지가 sessionStorage 't2d:entry_ref' 에 남긴 진입 origin('' = 직접 접속)을 씀 (assets/site.js)
  var REF_ORIGIN = (function () {
    try {
      var o = document.referrer ? new URL(document.referrer).origin : '';
      if (o !== location.origin) return o;
      var e = sessionStorage.getItem('t2d:entry_ref') || '';
      return e === location.origin ? '' : e;
    } catch (_) { return ''; }
  })();
  var ENTRY = {
    src: safeParam('src') || 'direct', site: safeParam('site'), wave: safeParam('wave') || CFG.STUDY_WAVE || 'main',
    type_preselected: !!URL_TYPE, type_param: URL_TYPE, in_app: IN_APP, referrer_origin: REF_ORIGIN
  };
  // 시작 화면의 '처음 화면'(../) · '벤치마크 소개'(../about/) 링크 — 접속 경로(src·site·wave)만 넘긴다.
  // test·type·reset 은 넘기지 않는다 (루트는 이 값이 있으면 다시 /ca/ 로 보낸다).
  function siteLinksHTML() {
    var q = new URLSearchParams();
    ['src', 'site', 'wave'].forEach(function (k) { var v = safeParam(k); if (v) q.set(k, v); });
    var qs = q.toString() ? '?' + q.toString() : '';
    return '<nav class="site-links" aria-label="' + esc(t('ca.nav.aria')) + '">' +
      '<a href="../' + qs + '" id="homeLink"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>' + esc(t('ca.nav.home')) + '</a>' +
      '<span class="sep" aria-hidden="true">·</span>' +
      '<a href="../about/' + qs + '" id="aboutLink">' + esc(t('ca.nav.about')) + '</a></nav>';
  }
  // 영어 화면에서 케이스 내용(환자 기록·AI 답변)은 원문(한국어)으로 보인다는 안내 — 화면 영역마다 한 번
  function srcNoteHTML() {
    return uiLang() === 'en' ? '<p class="src-note"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4H4.3zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6C8.9 5.5 8.4 6.7 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4z"/></svg>' +
      esc(t('ca.srcNote')) + '</p>' : '';
  }
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
  function typeSeqs() { var ty = S && typeById(S.study_type); return ty ? ty.sequences : TYPES[0].sequences; }

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
    if (m < 1) return t('ca.time.lt1');
    if (m < 60) return t('ca.time.min', { m: m });
    return t('ca.time.hm', { h: Math.floor(m / 60), m: m % 60 });
  }
  // 월 비용: 숫자(범위)면 화면 언어 형식으로, 아니면 원문 그대로(케이스 내용, lang="ko")
  function fmtCost(v) {
    var raw = String(v == null ? '' : v).trim();
    var s = raw.replace(/원/g, '').trim();
    if (!s || /^[-–—]$/.test(s)) return '—';
    var parts = s.split(/\s*[–—-]\s*/);
    var NUM = /^(\d{1,3}(,\d{3})+|\d+)$/;
    if (parts.length > 2 || !parts.every(function (x) { return NUM.test(x); })) return '<span lang="ko">' + esc(raw) + '</span>';
    var nums = parts.map(function (x) { return Number(x.replace(/,/g, '')); });
    if (nums.length === 2 && nums[0] === nums[1]) nums = [nums[0]];
    return esc(t('ca.rx.krw', { n: nums.map(function (n) { return n.toLocaleString('ko-KR'); }).join('–') }));
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
      set_id: DATA.set_id || 'v1',      // 케이스 세트 (이 필드가 없는 이전 상태 = v1)
      ui_lang_start: uiLang(),          // 세션을 시작한 화면 언어 (없는 이전 상태 = ko)
      ui_langs: [uiLang()],             // 이 세션에서 보인 화면 언어들 (시작·전환·이어서 하기)
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

  // 평가자 정보 → 저장용 객체 (직군·추가 항목은 config.EVALUATOR_ROLES 기준). 값은 항상 한국어 원문(canon) + code.
  function buildEvaluator() {
    var role = roleById(draft.role);
    var fields = {}, codes = {}, parts = [canon(role.label)];
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
      name: draft.name.trim(), role: role.id, role_label: canon(role.label), fields: fields, codes: codes,
      detail: parts.join(' · '),
      year: fields.year || ''   // 이전 버전 시트의 ResidentYear 컬럼 호환
    };
  }
  // 평가자 요약 줄 (화면용 HTML): 저장된 detail(한국어 원문)을 화면 언어로 다시 만든다. 직접 입력한 글자는 data-ugc 로 표시
  function evaluatorLineHTML(ev) {
    var role = roleById(ev && ev.role);
    if (!role) return '<span data-ugc>' + esc((ev && ev.detail) || '') + '</span>';
    var parts = [esc(tr(role, 'label'))];
    role.fields.forEach(function (f) {
      var v = (ev.fields || {})[f.id];
      if (!v) return;
      if (f.other && String(v).indexOf('기타: ') === 0) parts.push(esc(t('ca.field.otherValue', { v: '\u0000' })).split('\u0000').join('<span data-ugc>' + esc(String(v).slice(4)) + '</span>'));
      else if (f.type === 'text') parts.push('<span data-ugc>' + esc(v) + '</span>');
      else parts.push(esc(valueLabel(f, v)));
    });
    return parts.join(' · ');
  }
  function hiddenCommon(f) { return !!(f.firstSessionOnly && draft.linked && draft.fields[f.id]); }
  function fieldName(f) { return tr(f, 'short') || tr(f, 'label'); }
  // 목적격 조사: 마지막 한글(끝의 괄호 설명 제외)에 받침이 있으면 '을', 없으면 '를'
  function withObj(word) {
    var w = String(word || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
    var ch = w.charCodeAt(w.length - 1);
    if (ch >= 0xAC00 && ch <= 0xD7A3) return w + ((ch - 0xAC00) % 28 ? '을' : '를');
    return w + '을(를)';
  }
  // 시작 전 확인: 빠진 항목을 이름으로 알려 주고(msg), 그 항목으로 이동할 수 있게 선택자(sel)를 돌려준다
  function draftProblem() {
    if (!draft.name.trim()) return { msg: t('ca.err.name'), sel: '#evName' };
    var role = roleById(draft.role);
    if (!role) return { msg: t('ca.err.role'), sel: '#roleSeg' };
    var all = role.fields.concat(COMMON);
    for (var i = 0; i < all.length; i++) {
      var f = all[i], v = String(draft.fields[f.id] || '').trim();
      var sel = f.type === 'select' ? '#fld_ev_' + f.id : '[data-field="' + f.id + '"]';
      // 짧은 이름(short)이 없는 긴 질문은 이름 대신 강조 표시된 문항을 가리킨다 (판단은 한국어 원문 기준)
      var named = f.short || canon(f.label).length <= 24;
      var nm = { obj: withObj(fieldName(f)), name: fieldName(f) };
      if (f.required && !v) return { msg: named ? t(f.type === 'text' ? 'ca.err.fieldText' : 'ca.err.fieldSelect', nm) : t('ca.err.marked'), sel: sel };
      if (f.other && v === f.other && !String(draft.other[f.id] || '').trim()) return { msg: t('ca.err.fieldOther', nm), sel: '[data-other="' + f.id + '"]' };
    }
    if (!typeById(draft.type)) return { msg: t('ca.err.type'), sel: '#typeSeg' };
    if (!draft.consent) return { msg: t('ca.err.consent'), sel: '#evConsent' };
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

  var S = null;   // 저장된 진행 상태는 부팅(boot) 때 불러온다 (세트 보관본을 먼저 불러와야 할 수 있음)

  function curCase() { return S && S.cases[S.caseIdx]; }
  function curStep() { return STEPS[S.stepIdx]; }
  function stepMetrics(c, step) {
    if (!c.metrics.steps[step]) c.metrics.steps[step] = emptyStepMetrics();
    return c.metrics.steps[step];
  }
  // 화면 언어 기록: obj.ui_langs 에 지금 언어를 (처음 보일 때만) 더한다 — 케이스·세션이 어느 언어로 보였는지 (분석용)
  function noteLang(obj) {
    if (!obj) return;
    var l = uiLang();
    if (!obj.ui_langs) obj.ui_langs = [];
    if (obj.ui_langs.indexOf(l) < 0) obj.ui_langs.push(l);
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
        try { j = JSON.parse(txt); } catch (_) { throw new Error(t('ca.net.badResponse')); }
        if (!j || !j.ok) throw new Error((j && j.error) || t('ca.net.serverError'));
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
      incentive: CFG.INCENTIVE || '',
      ui_lang: uiLang(),                 // 이 응답을 보낼 때의 화면 언어 (값은 언어와 관계없이 한국어 원문 + code)
      set_id: S.set_id || 'v1'           // 세션의 케이스 세트 (set_id 가 없는 이전 상태 = v1)
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
      is_test: URL_TEST, visit_id: VISIT_ID, device_id: DEVICE_ID, entry: ENTRY, form_factor: deviceInfo().form_factor,
      ui_lang: uiLang(), set_id: (DATA && DATA.set_id) || 'v1'
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
      var n = PHASES[k].items.reduce(function (a, q) { return a + textLen(cb.answers[q]); }, 0);
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
      // 이 케이스 화면이 보인 언어들(단계 진입·언어 전환 때 기록) — 2개면 언어를 바꿔 가며 평가한 케이스.
      // 단계별 평가 시점의 언어는 metrics.steps[step].ui_lang (마지막으로 점수·조합을 고른 때) / .ui_langs
      ui_langs: (cm.ui_langs || []).slice(),
      ui_lang_mixed: (cm.ui_langs || []).length > 1,
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
      interruptions: m.interruptions || 0, send_failures: m.send_failures || 0,
      // 화면 언어 이력: 시작 언어(이전 버전 세션 = null → ko), 언어 전환 횟수, 이 세션에서 보인 언어들
      ui_lang_start: S.ui_lang_start || null,
      ui_lang_switches: S.ui_lang_switches || 0,
      ui_langs: (S.ui_langs || [S.ui_lang_start || 'ko']).slice()
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
    noteLang(c.metrics);
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
        toast(t(curStep() === 'combo' ? 'ca.err.combo' : curStep() === 'comment' ? 'ca.err.caseItems' : 'ca.err.rating'));
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
        toast(t('ca.toast.caseSaved', { n: S.caseIdx }));
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
      if (!itemsComplete(END_ITEMS, S.end_items || {})) { toast(t('ca.err.endItems')); return; }
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
    m.ui_lang = uiLang(); noteLang(m);
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
      if (!window.confirm(t('ca.confirm.comboReset', { n: rated.length }))) return;
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
    m.ui_lang = uiLang(); noteLang(m);
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
    fillDrawer();
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
  function fillDrawer() {
    var out = DATA.outputs[curCase().key];
    elDrawerBody.innerHTML = srcNoteHTML() + patientHTML(DATA.patients[out.patient], true);
    $('drawerTitle').textContent = t('ca.drawer.titleId', { id: out.patient });
    $('drawerClose').setAttribute('aria-label', t('ca.close'));
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
    var tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
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

  // 환자 기록: 항목 이름은 화면 언어, 값(케이스 내용)은 원문 그대로 lang="ko" 로 표시
  function ko(html) { return '<span lang="ko">' + html + '</span>'; }
  // 인구통계(예: '61세 남성 (아시아인)'): 영어 화면이면 정형화된 앞부분(나이·성별·흔한 인종 표기)만 번역하고
  // 나머지는 원문(lang="ko")으로 둔다. noParen: 괄호 부분(인종)을 뺀 짧은 형태.
  var ETH_KEYS = { '아시아인': 'asian', '백인': 'white', '흑인': 'black' };
  function demoHTML(s, noParen) {
    s = String(s == null ? '' : s);
    if (noParen) s = s.replace(/\s*\(.*\)$/, '');
    if (uiLang() !== 'en') return '<span lang="ko">' + esc(s) + '</span>';
    var m = s.match(/^(\d+)세\s*(남성|여성)/);
    if (!m) return '<span lang="ko">' + esc(s) + '</span>';
    var out = esc(t('ca.pt.demoAgeSex', { age: m[1], sex: t(m[2] === '남성' ? 'ca.pt.sex.m' : 'ca.pt.sex.f') }));
    var rest = s.slice(m[0].length).trim(), e = rest.match(/^\((아시아인|백인|흑인)\)$/);
    if (e) out += ' (' + esc(t('ca.pt.eth.' + ETH_KEYS[e[1]])) + ')';
    else if (rest) out += ' <span lang="ko">' + esc(rest) + '</span>';
    return out;
  }
  function dmGridHTML(rows) {
    if (!rows.length) return '<span class="muted">—</span>';
    return '<div class="cx" role="list">' + rows.map(function (r) {
      return '<div class="cx-row' + (r.pos ? ' pos' : '') + '" role="listitem"><span class="cx-k">' + esc(r.key) + '</span>' +
        '<span class="cx-v">' + esc(r.value) + '</span></div>';
    }).join('') + '</div>';
  }
  function liKo(arr) { return (arr || []).map(function (s) { return '<li lang="ko">' + esc(s) + '</li>'; }).join(''); }
  // 같은 환자를 다시 볼 때의 핵심 요약: 인적 사항 · 현재 주요 수치 · 당뇨 관련 동반질환 · 현재 복용약
  function patientSummaryHTML(p) {
    var C = T2D.clinical, cx = C.comorbidities(p);
    // '93mL/min/1.73m²' → ['93', 'mL/min/1.73m²'] (큰 숫자 + 작은 단위)
    var split = function (v) { var m = /^\s*([\d.]+(?:\/[\d.]+)?)\s*(.*)$/.exec(String(v || '')); return m ? [m[1], m[2]] : [String(v || ''), '']; };
    var sbp = split(C.current(p, /^SBP$/i))[0], dbp = split(C.current(p, /^DBP$/i))[0];
    var stats = [['HbA1c', split(C.current(p, /HbA1c/i))], ['eGFR', split(C.current(p, /eGFR/i))],
      ['BMI', split(C.current(p, /체질량지수|^BMI$/i))], [t('ca.pt.bp'), sbp && dbp ? [sbp + '/' + dbp, 'mmHg'] : ['', '']]]
      .filter(function (x) { return x[1][0]; });
    return '<section class="card pt-summary">' +
      '<div class="pt-head"><span class="pt-id">' + esc(p.id) + '</span>' +
      '<span class="pt-demo">' + demoHTML(p.demographics) + '</span>' +
      '<span class="pill" lang="ko">' + esc(p.visit_type) + '</span></div>' +
      '<p class="small muted" style="margin-top:4px">' + esc(t('ca.vig.summaryNote')) + '</p>' +
      '<div class="pt-stats">' + stats.map(function (x) {
        return '<div class="pt-stat"><span class="k">' + esc(x[0]) + '</span><span class="v">' + esc(x[1][0]) +
          (x[1][1] ? '<small>' + esc(x[1][1]) + '</small>' : '') + '</span></div>';
      }).join('') + '</div>' +
      '<p class="cx-title" style="margin-top:14px">' + esc(t('ca.pt.dmComorb')) + '</p>' + dmGridHTML(cx.dm) +
      '<dl class="kv" style="margin-top:14px">' +
        '<dt>' + esc(t('ca.pt.otherConditions')) + '</dt><dd>' + (cx.other.length ? '<div class="tags">' + cx.other.map(function (x) {
          return '<span class="tag" lang="ko">' + esc(x) + '</span>'; }).join('') + '</div>' : '<span class="muted">—</span>') + '</dd>' +
        '<dt>' + esc(t('ca.pt.meds')) + '</dt><dd><ul class="clean">' + liKo(p.medications) + '</ul></dd>' +
      '</dl>' +
    '</section>';
  }
  function patientHTML(p, compact) {
    var h = [];
    h.push(
      '<section class="card">' +
        '<div class="pt-head"><span class="pt-id">' + esc(p.id) + '</span>' +
        '<span class="pt-demo">' + demoHTML(p.demographics) + '</span>' +
        '<span class="pill" lang="ko">' + esc(p.visit_type) + '</span></div>' +
        '<p class="small muted" style="margin-top:4px">' + esc(t('ca.pt.synthetic')) + '</p>' +
        '<dl class="kv" style="margin-top:12px">' +
          '<dt>' + esc(t('ca.pt.visitReason')) + '</dt><dd lang="ko">' + esc(p.visit_reason) + '</dd>' +
          '<dt>' + esc(t('ca.pt.dxHistory')) + '</dt><dd lang="ko">' + esc(p.diagnosis_history) + '</dd>' +
          '<dt>' + esc(t('ca.pt.symptoms')) + '</dt><dd><ul class="clean">' + liKo(p.symptoms) + '</ul></dd>' +
        '</dl>' +
      '</section>'
    );

    var hl = function (x) { return /\((No)\)|:\s*Normal|Category:\s*Normal/i.test(x) ? '' : ' hl'; };
    // 당뇨 관련 동반질환: 임상 화면처럼 '항목: 값' (assets/clinical.js — 데이터의 코드 문자열은 그대로 두고 표시만 바꿈)
    var cx = T2D.clinical.comorbidities(p);
    var tags = function (arr, highlight) {
      return '<div class="tags">' + arr.map(function (x) {
        return '<span class="tag' + (highlight ? hl(x) : '') + '" lang="ko">' + esc(x) + '</span>';
      }).join('') + '</div>';
    };
    h.push(
      '<section class="card">' +
        '<h3 class="section-title">' + esc(t('ca.pt.history')) + '</h3>' +
        '<p class="cx-title">' + esc(t('ca.pt.dmComorb')) + '</p>' + dmGridHTML(cx.dm) +
        '<dl class="kv" style="margin-top:14px">' +
          '<dt>' + esc(t('ca.pt.otherConditions')) + '</dt><dd>' + (cx.other.length ? tags(cx.other, false) : '<span class="muted">—</span>') + '</dd>' +
          '<dt>' + esc(t('ca.pt.family')) + '</dt><dd lang="ko">' + esc(p.history.family) + '</dd>' +
          '<dt>' + esc(t('ca.pt.social')) + '</dt><dd><ul class="clean">' + liKo(p.history.social) + '</ul></dd>' +
        '</dl>' +
      '</section>'
    );

    h.push(
      '<section class="card">' +
        '<h3 class="section-title">' + esc(t('ca.pt.meds')) + '</h3>' +
        '<ul class="clean">' + liKo(p.medications) + '</ul>' +
      '</section>'
    );

    var th = function (k) { return '<span class="lg">' + esc(t('ca.pt.m' + k)) + '</span><span class="sm">-' + k + 'm</span>'; };
    var head = '<tr><th class="name">' + esc(t('ca.pt.labItem')) + '</th><th>' + th(12) + '</th><th>' + th(9) + '</th><th>' +
      th(6) + '</th><th>' + th(3) + '</th><th class="now">' + esc(t('ca.pt.now')) + '</th></tr>';
    var rows = [], lastGroup = null;
    T2D.clinical.orderLabs(p.labs).forEach(function (lab) {   // 신체 계측·혈압이 맨 위, 그다음 혈액 검사
      if (lab.group !== lastGroup) {
        rows.push('<tr class="grp"><td colspan="6" lang="ko">' + esc(lab.group) + '</td></tr>');
        lastGroup = lab.group;
      }
      var parts = lab.values.map(splitUnit);
      var units = parts.map(function (x) { return x.unit; });
      var same = units.every(function (u) { return u === units[0]; }) && units[0] != null;
      var cells = parts.map(function (x, i) {
        var val = same ? x.num : lab.values[i];
        return '<td' + (i === parts.length - 1 ? ' class="now"' : '') + ' lang="ko">' + esc(val) + '</td>';
      }).join('');
      rows.push('<tr><td class="name" lang="ko">' + esc(lab.name) + (same && units[0] ? '<small>' + esc(units[0]) + '</small>' : '') + '</td>' + cells + '</tr>');
    });
    h.push(
      '<section class="card">' +
        '<h3 class="section-title">' + esc(t('ca.pt.labs')) + '</h3>' +
        '<div class="lab-wrap"><table class="lab-table"><thead>' + head + '</thead><tbody>' + rows.join('') + '</tbody></table></div>' +
        '<p class="lab-caption">' + t('ca.pt.labCaptionHtml') + '</p>' +
        '<h3 class="section-title" style="margin-top:14px">' + esc(t('ca.pt.extraTests')) + '</h3>' +
        '<ul class="clean">' + liKo(p.extra_tests) + '</ul>' +
      '</section>'
    );

    h.push(
      '<section class="card">' +
        '<h3 class="section-title">' + esc(t('ca.pt.factors')) + '</h3>' +
        '<p class="small" style="font-weight:700;color:var(--navy)">' + esc(t('ca.pt.adherence')) + '</p>' +
        '<ul class="clean" style="margin-top:4px">' + liKo(p.adherence) + '</ul>' +
        '<p class="small" style="font-weight:700;color:var(--navy);margin-top:12px">' + esc(t('ca.pt.economics')) + '</p>' +
        '<p style="margin-top:4px" lang="ko">' + esc(p.economics) + '</p>' +
      '</section>'
    );
    return h.join('');
  }

  var DECISION_CLASS = { '신규': 'new', '유지': 'keep', '중단': 'stop', '감량': 'reduce' };
  // 처방 결정(신규·유지·중단·감량)과 급여 여부는 정해진 값 → 화면 언어로. 그 밖의 값은 원문 그대로
  function decisionHTML(d) { var c = DECISION_CLASS[d]; return c ? esc(t('ca.rx.decision.' + c)) : ko(esc(d)); }
  function coverageHTML(r) { return r === '급여' ? esc(t('ca.rx.cov')) : r === '비급여' ? esc(t('ca.rx.nocov')) : ko(esc(r)); }
  // 용량 · 횟수: 빈 값이나 '-'(예: 중단 약제에 용량을 적지 않은 답변)는 줄에서 빼고, 둘 다 없으면 줄 자체를 생략
  function rxDoseHTML(rx) {
    var parts = [rx.dose, rx.frequency].map(function (v) { return String(v == null ? '' : v).trim(); })
      .filter(function (v) { return v && !/^[-–—]+$/.test(v); });
    return parts.length ? '<div class="rx-dose" lang="ko">' + parts.map(esc).join(' · ') + '</div>' : '';
  }
  function rxHTML(rx) {
    var cls = DECISION_CLASS[rx.decision] || 'keep';
    var cov = rx.reimbursement === '급여' ? 'cov' : 'nocov';
    return '<div class="rx' + (cls === 'stop' ? ' stopped' : '') + '">' +
      '<div class="rx-top"><span class="badge ' + cls + '">' + decisionHTML(rx.decision) + '</span>' +
      '<span class="rx-drug" lang="ko">' + esc(rx.drug) + '</span><span class="rx-class" lang="ko">' + esc(rx.class) + '</span></div>' +
      rxDoseHTML(rx) +
      '<dl class="rx-meta">' +
        '<dt>' + esc(t('ca.rx.titration')) + '</dt><dd lang="ko">' + esc(rx.titration || '—') + '</dd>' +
        '<dt>' + esc(t('ca.rx.coverage')) + '</dt><dd><span class="badge ' + cov + '">' + coverageHTML(rx.reimbursement) + '</span> ' +
          t('ca.rx.perMonthHtml', { cost: fmtCost(rx.monthly_cost_krw) }) + '</dd>' +
        (rx.alternatives ? '<dt>' + esc(t('ca.rx.alternatives')) + '</dt><dd lang="ko">' + esc(rx.alternatives) + '</dd>' : '') +
      '</dl></div>';
  }
  function rxListHTML(list) { return '<div class="rx-list">' + list.map(rxHTML).join('') + '</div>'; }

  // 조합은 AI가 붙인 이름 대신 '조합 N' + 약물 구성으로 통일해 표시 (모델 간 표현 차이·순위 문구 노출 방지)
  function drugChipsHTML(cb) {
    return '<div class="cc-drugs">' + cb.prescription.map(function (rx) {
      var cls = DECISION_CLASS[rx.decision] || 'keep';
      return '<span class="drug ' + cls + '"><b lang="ko">' + esc(rx.drug) + '</b><em>' + decisionHTML(rx.decision) + '</em></span>';
    }).join('') + '</div>';
  }
  function drugLine(cb) {
    return cb.prescription.filter(function (rx) { return rx.decision !== '중단'; }).map(function (rx) { return rx.drug; }).join(' + ');
  }
  function comboNo(n) { return t('ca.combo.no', { n: n }); }
  var POINTS = [['2.1', 'ca.combo.eff', 'eff'], ['2.2', 'ca.combo.safe', 'safe'], ['2.3', 'ca.combo.feas', 'feas']];
  function comboCardHTML(cb, n, c) {
    var on = c.combo === n;
    var tab = (on || (c.combo == null && n === 1)) ? 0 : -1;
    return '<article class="combo-card" role="radio" tabindex="' + tab + '" data-combo="' + n + '" aria-checked="' + on + '" aria-labelledby="cbno' + n + '">' +
      '<header class="cc-head"><span class="cc-no" id="cbno' + n + '">' + esc(comboNo(n)) + '</span><span class="radio-dot" aria-hidden="true"></span></header>' +
      drugChipsHTML(cb) +
      '<ul class="cc-points">' + POINTS.map(function (pt) {
        return '<li class="pt ' + pt[2] + '"><span class="pt-label">' + esc(t(pt[1])) + '</span><span class="pt-text" lang="ko">' + esc(cb.answers[pt[0]]) + '</span></li>';
      }).join('') + '</ul>' +
      '<details class="cc-rx"><summary>' + esc(t('ca.combo.rxDetails')) + '</summary>' + rxListHTML(cb.prescription) + '</details>' +
      '<div class="cc-cta">' + (on ? '<span class="cc-sel">' + esc(t('ca.combo.selected')) + '</span>' : '') + esc(t('ca.combo.cta')) + ' <span aria-hidden="true">→</span></div>' +
      '</article>';
  }
  function selectedBannerHTML(cb, n, expanded) {
    return '<div class="selected-banner" id="selBanner">' +
      '<div class="sb-top"><span class="sb-label">' + esc(t('ca.combo.selected')) + '</span><span class="cc-no">' + esc(comboNo(n)) + '</span></div>' +
      drugChipsHTML(cb) +
      (expanded ? '<div class="sb-rx">' + rxListHTML(cb.prescription) + '</div>'
        : '<details><summary>' + esc(t('ca.combo.rxShow')) + '</summary>' + rxListHTML(cb.prescription) + '</details>') +
      '</div>';
  }

  function itemHTML(no, title, bodyHTML) {
    return '<article class="item"><div class="item-head"><span class="item-no">' + esc(no) + '</span>' +
      '<span class="item-title">' + esc(title) + '</span></div><div class="item-body" lang="ko">' + bodyHTML + '</div></article>';
  }

  function caseHeadHTML(title, sub) {
    var c = curCase(), out = DATA.outputs[c.key], p = DATA.patients[out.patient];
    return '<div class="case-head">' +
      '<span class="pill navy">' + esc(t('ca.case.ofN', { n: S.caseIdx + 1, total: nCases() })) + '</span>' +
      // 한 덩어리(span)로 감싸 pill(inline-flex) 안에서 글자 사이 간격이 생기지 않게
      '<span class="pill"><span>' + esc(t('ca.case.patient', { id: out.patient })) + ' · ' + demoHTML(p.demographics, true) + '</span></span>' +
      '</div>' +
      '<h1 style="font-size:21px;color:var(--navy);margin-top:10px">' + esc(title) + '</h1>' +
      (sub ? '<p class="lead" style="margin-top:4px">' + sub + '</p>' : '');
  }

  function phaseHeadHTML(key) {
    var ph = PHASES[key];
    // 한국어 화면: 한국어 제목 + 영어 부제 / 영어 화면: 영어 제목만
    return '<div class="phase-head"><span class="ph-num">' + esc(ph.num) + '</span><h2>' + esc(phTitle(key)) + '</h2>' +
      (uiLang() === 'ko' ? '<span class="ph-en" lang="en">' + esc(t('ca.instrument.' + key + '.sub')) + '</span>' : '') + '</div>';
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
  // 버튼·목록의 값(data-value, option value)은 항상 한국어 원문(저장 값), 보이는 글자만 화면 언어
  function fieldHTML(f, cur, otherVal, prefix) {
    var id = esc((prefix || '') + f.id);
    var lab = '<span class="label" id="lbl_' + id + '">' + esc(tr(f, 'label')) + (f.required ? '<span class="req">*</span>' : '') + '</span>';
    var otherInput = function () {
      return f.other && cur === f.other ? '<input class="input" type="text" maxlength="60" data-other="' + esc(f.id) + '" placeholder="' + esc(t('ca.field.otherPh')) + '" value="' + esc(otherVal || '') + '">' : '';
    };
    if (f.type === 'choice') {
      var opts = f.options.map(function (o, i) { return { value: o, label: optLabel(f, i) }; });
      if (f.other) opts.push({ value: f.other, label: tr(f, 'other') });
      var list = f.layout === 'list';
      return '<div class="field">' + lab + '<div class="seg' + (list ? ' list' : '') + '" role="radiogroup" aria-labelledby="lbl_' + id + '" data-field="' + esc(f.id) + '"' +
        (list ? '' : ' style="grid-template-columns:repeat(' + opts.length + ',1fr)"') + '>' +
        segHTML('data-value', opts, cur) + '</div>' + otherInput() + '</div>';
    }
    if (f.type === 'multi') {
      var sel = String(cur || '').split(';').filter(Boolean);
      return '<div class="field">' + lab + '<div class="chips" data-multi="' + esc(f.id) + '">' +
        f.options.map(function (o, i) {
          return '<button type="button" class="chip" data-value="' + esc(o[0]) + '" aria-pressed="' + (sel.indexOf(o[0]) >= 0) + '">' + esc(optLabel(f, i)) + '</button>';
        }).join('') + '</div></div>';
    }
    if (f.type === 'select') {
      var opt = function (v, label) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(label) + '</option>'; };
      var o2 = '<option value="">' + esc(tr(f, 'placeholder') || t('ca.field.selectPh')) + '</option>' +
        (f.groups || [{ label: '', options: f.options || [] }]).map(function (g) {
          var o = g.options.map(function (x, i) { return opt(x, optLabel(g, i)); }).join('');
          return g.label ? '<optgroup label="' + esc(tr(g, 'label')) + '">' + o + '</optgroup>' : o;
        }).join('') +
        (f.other ? opt(f.other, tr(f, 'other')) : '');
      return '<div class="field">' + lab.replace('<span class="label"', '<label class="label" for="fld_' + id + '"').replace(/<\/span>$/, '</label>') +
        '<select class="input" id="fld_' + id + '" data-field="' + esc(f.id) + '">' + o2 + '</select>' + otherInput() + '</div>';
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
      if (hiddenCommon(f)) return '<p class="small muted">' + t('ca.intro.reusedHtml', { name: esc(fieldName(f)), value: esc(valueLabel(f, draft.fields[f.id])) }) + '</p>';
      return fieldHTML(f, draft.fields[f.id] || '', draft.other[f.id], 'ev_');
    }).join('');
  }
  function findEvalField(id) {
    var role = roleById(draft.role);
    return (role ? role.fields : []).concat(COMMON).filter(function (f) { return f.id === id; })[0] || null;
  }
  // 한 Type 의 케이스 수·환자 수 (안내 문구용; 세트마다 다를 수 있음)
  function typeShape() {
    var seq = (TYPES[0] && TYPES[0].sequences[0]) || [];
    var pts = {};
    seq.forEach(function (k) { var o = DATA.outputs[k]; if (o) pts[o.patient] = 1; });
    return { n: seq.length || 2, p: Object.keys(pts).length || 2 };
  }

  function renderIntro() {
    var legend = SCALE.map(function (s) { return '<div><b>' + s.v + '</b>' + esc(scaleLabel(s.v)) + '</div>'; }).join('');
    var roles = segHTML('data-role', ROLES.map(function (r) { return { value: r.id, label: tr(r, 'label') }; }), draft.role);
    var types = segHTML('data-type', TYPES.map(function (ty) { return { value: ty.id, label: pick(ty.label) }; }), draft.type);
    var shape = typeShape(), mins = resolveMinutes();
    var tv = { n: shape.n, p: shape.p, lo: mins[0], hi: mins[1], clo: Math.round(mins[0] / shape.n), chi: Math.round(mins[1] / shape.n) };
    // 이어서 평가: 이전 세션에 없던 필수 항목(예: v3.3 에서 시작한 평가자의 AI 사용 빈도)은 무엇인지 알려 준다
    var linkedRole = roleById(draft.role);
    var linkedMissing = !draft.linked ? [] : (linkedRole ? linkedRole.fields : []).concat(COMMON).filter(function (f) {
      return f.required && !String(draft.fields[f.id] || '').trim();
    }).map(fieldName);
    elMain.innerHTML =
      // 이어서 평가(draft.linked)는 이 화면을 떠나면 연결이 끊기므로 링크를 보이지 않는다
      (draft.linked ? '' : siteLinksHTML()) +
      '<section class="card hero">' +
        '<span class="eyebrow">' + esc(t('ca.intro.eyebrow')) + '</span>' +
        '<h1>' + esc(t('ca.intro.title')) + '</h1>' +
        '<p class="sub">' + esc(t('ca.intro.sub')) + '</p>' +
        '<p class="desc">' + esc(t('ca.intro.desc')) + '</p>' +
      '</section>' +

      '<section class="card">' +
        '<h2 class="section-title">' + esc(t('ca.intro.howTitle')) + '</h2>' +
        '<p>' + t('ca.intro.howHtml', tv) + '</p>' +
        '<ol class="flow" style="margin-top:12px">' +
          [1, 2, 3, 4, 5].map(function (i) { return '<li><span>' + t('ca.intro.flow' + i + 'Html') + '</span></li>'; }).join('') +
        '</ol>' +
        '<ul class="clean small muted" style="margin-top:14px">' +
          '<li>' + esc(t('ca.intro.time', tv)) + '</li>' +
          '<li>' + t('ca.intro.patientBtnHtml') + '</li>' +
          '<li>' + esc(t('ca.intro.resume')) + '</li>' +
        '</ul>' +
      '</section>' +

      '<section class="card">' +
        '<h2 class="section-title">' + esc(t('ca.intro.scaleTitle')) + '</h2>' +
        '<p>' + esc(t('ca.intro.scaleLead')) + '</p>' +
        '<p class="notice" style="margin-top:10px">' + t('ca.instrument.templateHtml') + '</p>' +
        '<div class="scale-legend">' + legend + '</div>' +
      '</section>' +

      '<section class="card" id="evaluatorCard">' +
        '<h2 class="section-title">' + esc(t('ca.intro.evalTitle')) + '</h2>' +
        (draft.linked ? '<p class="notice info" style="margin-bottom:14px">' + t('ca.intro.linkedHtml', { type: esc(typeLabel(draft.type)) }) + ' ' +
          (linkedMissing.length ? t('ca.intro.linkedMissingHtml', { names: esc(linkedMissing.join(', ')) }) : esc(t('ca.intro.linkedCheck'))) + '</p>' : '') +
        '<div class="field"><label for="evName">' + esc(t('ca.intro.name')) + '<span class="req">*</span></label>' +
          '<input class="input" id="evName" type="text" autocomplete="name" maxlength="40" placeholder="' + esc(t('ca.intro.namePh')) + '" value="' + esc(draft.name) + '"></div>' +
        '<div class="field"><span class="label" id="roleLabel">' + esc(t('ca.intro.role')) + '<span class="req">*</span></span>' +
          '<div class="seg" role="radiogroup" aria-labelledby="roleLabel" id="roleSeg" style="grid-template-columns:repeat(' + ROLES.length + ',1fr)">' + roles + '</div></div>' +
        '<div id="roleFields">' + roleFieldsHTML() + '</div>' +
        (COMMON.length ? '<div id="commonFields">' + commonFieldsHTML() + '</div>' : '') +
        '<div class="field"><span class="label" id="typeLabel">' + esc(t('ca.intro.type')) + '<span class="req">*</span></span>' +
          '<p class="small muted" style="margin:0">' + esc(t(TYPES.length === 2 ? 'ca.intro.typeChoose2' : 'ca.intro.typeChooseN')) + ' ' + esc(t('ca.intro.typeHelp', tv)) + '</p>' +
          '<div class="seg" role="radiogroup" aria-labelledby="typeLabel" id="typeSeg" style="grid-template-columns:repeat(' + TYPES.length + ',1fr)">' + types + '</div></div>' +
        '<div class="field" style="margin-top:18px"><label class="check"><input type="checkbox" id="evConsent"' + (draft.consent ? ' checked' : '') + '>' +
          '<span>' + esc(t('ca.consent.text')) +
          (CFG.IRB_NO ? esc(t('ca.consent.irb', { no: CFG.IRB_NO })) : '') + '</span></label></div>' +
        '<button type="button" class="btn btn-accent btn-block" id="startBtn" style="margin-top:18px">' + esc(t(starting ? 'ca.intro.starting' : 'ca.intro.start')) + '</button>' +
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
      var tg = e.target;
      if (tg.tagName === 'SELECT' && tg.hasAttribute('data-field')) {
        var id = tg.getAttribute('data-field');
        draft.fields[id] = tg.value;
        var f = findEvalField(id) || {};
        var hasOther = !!card.querySelector('[data-other="' + id + '"]');
        if (f.other && (tg.value === f.other) !== hasOther) {
          $('roleFields').innerHTML = roleFieldsHTML();
          var oi = card.querySelector('[data-other="' + id + '"]'); if (oi) oi.focus();
        }
      }
    });
    card.addEventListener('input', function (e) {
      var tg = e.target;
      if (tg.hasAttribute('data-other')) draft.other[tg.getAttribute('data-other')] = tg.value;
      else if (tg.tagName === 'INPUT' && tg.type === 'text' && tg.hasAttribute('data-field')) draft.fields[tg.getAttribute('data-field')] = tg.value;
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
    elMain.innerHTML = '<section class="card"><p class="status-line pending"><span class="dot"></span>' + esc(t('ca.starting')) + '</p></section>';
    elDock.innerHTML = '';
  }

  function renderCaseMain() {
    var c = curCase(), out = DATA.outputs[c.key], st = curStep();
    var p = DATA.patients[out.patient];
    var html = '';
    if (st === 'vignette') {
      var seen = seenBefore();
      html += caseHeadHTML(t('ca.vig.title'), esc(t('ca.vig.sub'))) + srcNoteHTML();
      var seenPrev = !seen && (S.prev_patients || []).indexOf(out.patient) >= 0;
      if (seen) {
        html += '<p class="notice info same-patient">' + t('ca.vig.seenHtml', { n: seen }) + '</p>';
      } else if (seenPrev) {
        html += '<p class="notice info same-patient">' + t('ca.vig.seenPrevHtml') + '</p>';
      }
      // 이미 본 환자: 핵심 요약만 보여 주고 전체 기록은 펼쳐서 (같은 내용을 다시 읽지 않도록)
      if (seen || seenPrev) html += patientSummaryHTML(p) +
        '<details class="pt-more"><summary>' + esc(t('ca.vig.fullRecord')) + '</summary>' + patientHTML(p, false) + '</details>';
      else html += patientHTML(p, false);
    } else if (st === 'p1') {
      var ph1 = out.phase_1;
      html += caseHeadHTML(t('ca.ans.title')) + srcNoteHTML();
      html += phaseHeadHTML('p1');
      html += '<div class="items">' +
        itemHTML('1.1', qLabel('1.1'), '<span class="callout">' + esc(ph1['1.1'].referral) + '</span><p>' + esc(ph1['1.1'].answer) + '</p>') +
        itemHTML('1.2', qLabel('1.2'), '<p>' + esc(ph1['1.2']) + '</p>') +
      '</div>';
    } else if (st === 'combo') {
      var nC = out.combinations.length;
      html += caseHeadHTML(t('ca.combo.title'), t('ca.combo.subHtml', { n: nC })) + srcNoteHTML();
      html += '<div class="combo-toolbar desk-only"><button type="button" class="btn btn-ghost" data-act="back">' + esc(t('ca.combo.back')) + '</button>' +
        '<span class="muted small">' + esc(t('ca.combo.tapHint')) + '</span>' +
        (c.combo ? '<button type="button" class="btn btn-primary" data-act="next">' + esc(t('ca.combo.continue', { n: c.combo })) + '</button>' : '<span></span>') + '</div>';
      html += '<div class="combo-grid three" role="radiogroup" aria-label="' + esc(t('ca.combo.groupAria')) + '" id="comboGroup">' +
        out.combinations.map(function (cb, i) { return comboCardHTML(cb, i + 1, c); }).join('') + '</div>';
    } else if (PHASES[st]) {
      var cb = out.combinations[c.combo - 1];
      var a = cb.answers;
      html += caseHeadHTML(t('ca.ans.title')) + srcNoteHTML();
      var enter = arrivingFromCombo && st === 'p2';
      html += selectedBannerHTML(cb, c.combo, st === 'p2');
      html += phaseHeadHTML(st).replace('class="phase-head"', 'class="phase-head' + (enter ? ' enter' : '') + '"');
      html += '<div class="items' + (enter ? ' enter' : '') + '">' + PHASES[st].items.map(function (q) {
        var v = a[q];
        var body;
        if (v && typeof v === 'object') {
          body = (v.next_visit ? '<span class="callout"><small>' + esc(t('ca.ans.nextVisit')) + '</small>' + esc(v.next_visit) + '</span>' : '') +
            '<p>' + esc(v.answer || '') + '</p>';
        } else {
          body = '<p>' + esc(v) + '</p>';
        }
        return itemHTML(q, qLabel(q), body);
      }).join('') + '</div>';
    } else if (st === 'comment') {
      html += caseHeadHTML(t('ca.wrap.title'), esc(t('ca.wrap.sub'))) + srcNoteHTML();
      html += '<section class="card"><h3 class="section-title">' + esc(t('ca.wrap.recap')) + '</h3>' + caseRecapHTML(c) +
        '<p class="small muted" style="margin-top:8px">' + esc(t('ca.wrap.fix')) + '</p></section>';
      if (CASE_ITEMS.length) {
        html += '<section class="card sub-items"><span class="sub-tag">' + esc(t('ca.subItems')) + '</span>' +
          '<p class="small muted" style="margin:6px 0 4px">' + esc(t('ca.wrap.subLead')) + '</p>' +
          '<div id="caseItems">' + itemsHTML(CASE_ITEMS, c.items || {}, 'ci_') + '</div></section>';
      }
      html += '<section class="card"><div class="field"><label for="caseComment">' + esc(t('ca.wrap.comment')) + '</label>' +
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
      // (언어를 바꿔 다시 그릴 때 펼침 상태를 되살리는 것은 세지 않음: __restored)
      if (det) det.addEventListener('toggle', function () {
        if (det.__restored) { det.__restored = false; return; }
        if (det.open) { c.metrics.rx_details_opens = (c.metrics.rx_details_opens || 0) + 1; saveSoon(); }
      });
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
    return t((h && Number(h.code) >= 2) ? 'ca.wrap.phHarm' : 'ca.wrap.ph');
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
      return v == null ? '<span class="muted">' + esc(t('ca.recap.none')) + '</span>' : '<b>' + esc(t('ca.recap.points', { v: v })) + '</b> <span class="muted small">' + esc(scaleLabel(v)) + '</span>';
    };
    return '<dl class="kv">' +
      row('p1', 'Phase 1', score('p1')) +
      row('combo', esc(t('ca.recap.combo')), c.combo ? '<b>' + esc(comboNo(c.combo)) + '</b> <span class="muted small" lang="ko">' + esc(drugLine(out.combinations[c.combo - 1])) + '</span>' : '<span class="muted">' + esc(t('ca.recap.noCombo')) + '</span>') +
      row('p2', 'Phase 2', score('p2')) +
      row('p3', 'Phase 3', score('p3')) +
      row('p4', 'Phase 4', score('p4')) +
      row('p5', 'Phase 5', score('p5')) +
      '</dl>';
  }

  function renderDock() {
    if (!S || S.screen !== 'case') { elDock.innerHTML = ''; return; }
    var c = curCase(), st = curStep();
    var back = S.stepIdx > 0 ? '<button type="button" class="btn btn-ghost" data-act="back">' + esc(t('ca.dock.back')) + '</button>' : '';
    var nav = function (label, enabled, accent) {
      return '<div class="dock-nav' + (back ? '' : ' single') + '">' + back +
        '<button type="button" class="btn ' + (accent ? 'btn-accent' : 'btn-primary') + '" data-act="next"' +
        (enabled ? '' : ' aria-disabled="true"') + '>' + esc(label) + '</button></div>';
    };
    var html = '<div class="dock-inner">';
    if (st === 'vignette') {
      html += '<div class="dock-kicker"><span>' + esc(t('ca.dock.vigKicker')) + '</span></div>' +
        '<p class="dock-msg">' + esc(t('ca.dock.vigMsg')) + '</p>' +
        nav(t('ca.dock.vigNext'), true);
    } else if (PHASES[st]) {
      var ph = PHASES[st], val = c.ratings[st];
      html += '<div class="dock-kicker"><span>' + esc(t('ca.dock.phaseKicker', { num: ph.num })) + '</span><span class="req-hint">' + (val == null ? esc(t('ca.dock.chooseScore')) : '') + '</span></div>' +
        '<p class="dock-statement" id="stmt">' + esc(phStatement(st)) + '</p>' +
        '<div class="likert" role="radiogroup" aria-labelledby="stmt">' +
          SCALE.map(function (s) {
            var tab = (val === s.v || (val == null && s.v === 1)) ? 0 : -1;
            return '<button type="button" role="radio" tabindex="' + tab + '" data-rate="' + s.v + '" aria-checked="' + (val === s.v) + '" aria-label="' + esc(t('ca.dock.rateAria', { v: s.v, label: scaleLabel(s.v) })) + '">' +
              s.v + '<small>' + esc(scaleLabel(s.v)) + '</small></button>';
          }).join('') +
        '</div>' +
        '<div class="likert-anchors"><span>1 ' + esc(scaleLabel(1)) + '</span>' +
          (val != null ? '<span class="sel">' + val + ' · ' + esc(scaleLabel(val)) + '</span>' : '') +
          '<span>' + esc(scaleLabel(5)) + ' 5</span></div>' +
        nav(t(st === 'p5' ? 'ca.dock.nextComment' : 'ca.dock.next'), val != null);
    } else if (st === 'combo') {
      html += '<div class="dock-kicker"><span>' + esc(t('ca.combo.title')) + '</span><span class="req-hint">' + (c.combo == null ? esc(t('ca.dock.comboHint')) : '') + '</span></div>' +
        '<p class="dock-msg">' + esc(t('ca.dock.comboMsg')) + '</p>' +
        nav(c.combo ? t('ca.combo.continue', { n: c.combo }) : t('ca.dock.comboChoose'), c.combo != null);
    } else if (st === 'comment') {
      var last = S.caseIdx === nCases() - 1;
      var okItems = itemsComplete(CASE_ITEMS, c.items || {});
      html += '<div class="dock-kicker"><span>' + esc(t('ca.dock.wrapKicker', { n: S.caseIdx + 1 })) + '</span><span class="req-hint">' + (okItems ? '' : esc(t('ca.dock.wrapHint'))) + '</span></div>' +
        '<p class="dock-msg">' + esc(t(last ? 'ca.dock.wrapLastMsg' : 'ca.dock.wrapMsg')) + '</p>' +
        nav(t(last ? 'ca.dock.wrapLastNext' : 'ca.dock.wrapNext'), okItems, true);
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
      return '<section class="card tight"><div class="case-head"><span class="pill navy">' + esc(t('ca.case.n', { n: i + 1 })) + '</span>' +
        '<span class="pill">' + esc(t('ca.case.patient', { id: out.patient })) + '</span></div><div style="margin-top:8px">' + caseRecapHTML(c) + '</div></section>';
    }).join('');
    elMain.innerHTML =
      '<section class="card"><span class="eyebrow">' + esc(t('ca.final.eyebrow')) + '</span>' +
        '<h1 style="font-size:22px;color:var(--navy);margin-top:6px">' + esc(t('ca.final.title')) + '</h1>' +
        '<p class="lead" style="margin-top:6px">' + t('ca.final.leadHtml') + '</p></section>' +
      (END_ITEMS.length ? '<section class="card sub-items"><span class="sub-tag">' + esc(t('ca.subItems')) + '</span><div id="endItems" style="margin-top:6px">' +
        itemsHTML(END_ITEMS, S.end_items || {}, 'ei_') + '</div></section>' : '') +
      '<section class="card"><div class="field"><label for="overallComment">' + esc(t('ca.final.comment')) + '</label>' +
        '<p class="small muted">' + esc(t('ca.final.commentHelp')) + '</p>' +
        '<textarea class="input" id="overallComment" maxlength="5000">' + esc(S.overall_comment) + '</textarea>' +
        '<div class="char-count" id="ocCount">' + S.overall_comment.length + ' / 5000</div></div>' +
        '<button type="button" class="btn btn-accent btn-block" id="submitBtn" style="margin-top:14px">' + esc(t('ca.final.submit')) + '</button></section>' +
      '<h2 class="section-title" style="margin-top:22px">' + esc(t('ca.final.recap')) + '</h2>' + srcNoteHTML() + rows;
    elDock.innerHTML = '';
    $('overallComment').addEventListener('input', function (e) {
      S.overall_comment = e.target.value;
      $('ocCount').textContent = e.target.value.length + ' / 5000';
      saveSoon();
    });
    $('submitBtn').addEventListener('click', goNext);
    if ($('endItems')) bindItems($('endItems'), END_ITEMS, function () { return S.end_items || (S.end_items = {}); }, 'ei_', function () { save(); });
  }

  /** 평가자가 내려받는 응답 파일의 내용 (블라인딩된 JSON 문자열) */
  function downloadText() {
    var payload = {
      study_id: S.study_id, app_version: S.app_version, data_version: S.data_version,
      session_id: S.session_id, is_test: S.is_test, evaluator: S.evaluator, study_type: S.study_type,
      sequence_index: S.seq_index, seq_source: S.seq_source, order: S.order,
      session: sessionSummary(), overall_comment: S.overall_comment, end_items: S.end_items || {}, device: S.device,
      evaluator_id: S.evaluator_id, entry: S.entry, consent: S.consent, session_ordinal: S.session_ordinal,
      ui_lang: uiLang(), set_id: S.set_id || 'v1',
      cases: S.cases.map(function (_, i) {
        var r = buildCaseRecord(i);
        delete r.model; delete r.model_name;   // 평가자가 받는 파일: 모델 코드·이름을 싣지 않음 (서버로 보내는 응답은 그대로)
        return r;
      })
    };
    // 답변 식별자 블라인딩 (GC 와 같은 방식): 'P051_gpt' → 'P051_답변1' (N = 이 Type 의 제시 순서). order·case_key·combo_key 모두 바뀜.
    // 원래 답변은 study_type + sequence_index (+ set_id) 로 연결된다. 긴 키부터 바꿔 접두사가 겹쳐도 섞이지 않게.
    payload.units_blinded = true;
    var text = JSON.stringify(payload, null, 2);
    var keys = (S.order || []).map(function (k, u) {
      var o = DATA.outputs[k] || {};
      return { k: String(k), to: (o.patient || String(k).split('_')[0] || 'P') + '_답변' + (u + 1) };
    }).sort(function (a, b) { return b.k.length - a.k.length; });
    keys.forEach(function (x) { text = text.split(x.k).join(x.to); });
    return text;
  }

  function downloadJSON() {
    var blob = new Blob([downloadText()], { type: 'application/json' });
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
      status = '<p class="status-line pending"><span class="dot"></span>' + esc(t('ca.done.testMode')) + '</p>' +
        '<p class="small muted" style="margin-top:6px">' + esc(t('ca.done.testModeDl')) + '</p>';
    } else if (!S.outbox.length && S.net.status !== 'sending') {
      status = '<p class="status-line ok"><span class="dot"></span>' + esc(t('ca.done.ok')) + '</p>';
    } else if (S.net.status === 'fail' || !flushing) {
      status = '<p class="status-line fail"><span class="dot"></span>' + esc(t('ca.done.fail', { n: S.outbox.length })) + '</p>' +
        '<p class="small muted" style="margin-top:6px">' + esc(t('ca.done.failHelp')) +
        (S.net.last_error ? ' (' + esc(S.net.last_error) + ')' : '') + '</p>';
    } else {
      status = '<p class="status-line pending"><span class="dot"></span>' + esc(t('ca.done.sending')) + '</p>';
    }
    var showRetry = CFG.ENDPOINT && S.outbox.length && (S.net.status === 'fail' || !flushing);
    var doneTypes = (S.done_types || []).concat([S.study_type]);
    var otherTypes = TYPES.filter(function (ty) { return doneTypes.indexOf(ty.id) < 0; });
    elMain.innerHTML =
      '<section class="card hero"><span class="eyebrow">' + esc(t('ca.done.eyebrow')) + '</span><h1>' + esc(t('ca.done.title')) + '</h1>' +
        '<p class="desc">' + t('ca.done.descHtml', {
          name: '<span data-ugc>' + esc(S.evaluator.name) + '</span>', detail: evaluatorLineHTML(S.evaluator), type: esc(typeLabel(S.study_type))
        }) + '</p></section>' +
      '<section class="card">' + status +
        '<div class="stat-row" style="margin-top:14px">' +
          '<div class="stat"><b>' + sum.cases_completed + ' / ' + nCases() + '</b><span>' + esc(t('ca.done.statCases')) + '</span></div>' +
          '<div class="stat"><b>' + esc(fmtMin(sum.total_active_ms + sum.total_idle_ms)) + '</b><span>' + esc(t('ca.done.statTime')) + '</span></div>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:16px">' +
          (showRetry ? '<button type="button" class="btn btn-primary" id="retryBtn">' + esc(t('ca.done.retry')) + '</button>' : '') +
          ((!CFG.ENDPOINT || showRetry) ? '<button type="button" class="btn btn-ghost" id="dlBtn">' + esc(t('ca.done.download')) + '</button>' : '') +
        '</div>' +
      '</section>' +
      (otherTypes.length ? '<section class="card"><h2 class="section-title">' + esc(t('ca.done.otherTitle')) + '</h2>' +
        '<p class="small muted">' + esc(t('ca.done.otherHelp', { n: typeShape().n })) + '</p><div class="btn-row" style="margin-top:10px">' +
        otherTypes.map(function (ty) { return '<button type="button" class="btn btn-primary" data-next-type="' + esc(ty.id) + '">' + esc(t('ca.done.otherBtn', { type: pick(ty.label) })) + '</button>'; }).join('') +
        '</div></section>' : '') +
      '<section class="card"><p class="small muted">' + esc(t('ca.done.newHelp')) + '</p>' +
        '<button type="button" class="btn btn-ghost" id="newBtn" style="margin-top:10px">' + esc(t('ca.done.newBtn')) + '</button></section>';
    elDock.innerHTML = '';
    if ($('retryBtn')) $('retryBtn').addEventListener('click', function () { flush(); });
    if ($('dlBtn')) $('dlBtn').addEventListener('click', downloadJSON);
    var restart = function (prefill) {
      if (S.outbox.length && CFG.ENDPOINT) {
        if (!window.confirm(t('ca.confirm.unsent'))) return;
      } else if (!prefill && !window.confirm(t('ca.confirm.new'))) return;
      var prev = S;
      try { localStorage.removeItem(STORE_KEY); } catch (_) {}
      // 보관된(이전) 세트로 진행하던 세션이 끝난 뒤 새 평가자는 활성 세트로: 새로 불러온다
      if (!prefill && (DATA.set_id || 'v1') !== ACTIVE_SET) { S = null; location.reload(); return; }
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
      label = t('ca.top.case', { n: S.caseIdx + 1, total: nCases(), step: stepLabel(curStep()) });
      pct = (S.caseIdx * STEPS.length + S.stepIdx) / totalSteps() * 100;
      showPatient = S.stepIdx > 0;
    } else if (S && S.screen === 'final') { label = t('ca.top.final'); pct = 100; }
    else if (S && S.screen === 'done') { label = t('ca.top.done'); pct = 100; }
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
      '<section class="card"><span class="eyebrow">' + esc(t('ca.stale.eyebrow')) + '</span>' +
        '<h1 style="font-size:20px;color:var(--navy);margin-top:6px">' + esc(t('ca.stale.title')) + '</h1>' +
        '<p class="lead" style="margin-top:8px">' + esc(t('ca.stale.lead')) + '</p>' +
        '<button type="button" class="btn btn-primary" id="takeOverBtn" style="margin-top:14px">' + esc(t('ca.stale.btn')) + '</button></section>';
    elDock.innerHTML = '';
    $('takeOverBtn').addEventListener('click', function () { location.reload(); });
  }

  function render() {
    var testMode = (S ? S.is_test : (URL_TEST || !CFG.ENDPOINT));
    elTestBanner.hidden = !testMode;
    elTestBanner.textContent = t(!CFG.ENDPOINT ? 'ca.banner.noEndpoint' : 'ca.banner.test');

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
  // Header: language / theme controls (assets/i18n.js) and the static page text
  // ---------------------------------------------------------------------------
  function mountPrefs() {
    if (!I18N.controlsHTML || document.querySelector('#topbar .prefs')) return;
    var slot = $('prefsSlot');
    if (!slot) {   // 이전 HTML(캐시)에는 자리가 없음
      slot = document.createElement('div'); slot.id = 'prefsSlot'; slot.className = 'prefs-slot';
      document.querySelector('#topbar .topbar-right').appendChild(slot);
    }
    slot.innerHTML = I18N.controlsHTML();
    I18N.bindControls(slot);
  }
  // HTML 의 고정 문구 (data-i18n 이 없는 이전 HTML 에서도 맞게)
  function paintChrome() {
    document.title = t('ca.meta.title');
    var bs = document.querySelector('#topbar .brand-text strong'), bm = document.querySelector('#topbar .brand-text small');
    if (bs) bs.textContent = t('ca.brand.title');
    if (bm) bm.textContent = t('ca.brand.sub');
    var last = elPatientBtn.lastChild;   // 아이콘(svg) 다음의 글자
    if (last && last.nodeType === 3) last.nodeValue = ' ' + t('ca.patientBtn');
    else if (last && last.nodeType === 1 && last.tagName.toLowerCase() !== 'svg') last.textContent = t('ca.patientBtn');
    elDock.setAttribute('aria-label', t('ca.dock.aria'));
    $('drawerClose').setAttribute('aria-label', t('ca.close'));
    if (elDrawer.hidden) $('drawerTitle').textContent = t('ca.drawer.title');
  }
  // 언어를 바꾸면 지금 화면을 그 언어로 다시 그린다 (응답·시간 측정·스크롤·펼침 상태는 그대로)
  var booted = false, shownLang = null;
  function onLang() {
    if (!booted) return;
    if (flying) { setTimeout(onLang, 700); return; }
    if (uiLang() === shownLang) return;   // 이미 보이는 언어를 다시 누른 경우: 아무것도 바뀌지 않음
    shownLang = uiLang();
    tick();
    elToast.hidden = true;   // 이전 언어로 뜬 안내는 닫는다
    var y = window.scrollY;
    var open = [];
    Array.prototype.forEach.call(elMain.querySelectorAll('details'), function (d, i) { if (d.open) open.push(i); });
    render();
    var ds = elMain.querySelectorAll('details');
    open.forEach(function (i) { var d = ds[i]; if (d && !d.open) { d.__restored = true; d.open = true; } });
    if (!elDrawer.hidden && S && S.screen === 'case') fillDrawer();
    paintChrome();
    window.scrollTo(0, y);
    if (S) {
      S.ui_lang_switches = (S.ui_lang_switches || 0) + 1;
      noteLang(S);
      if (S.screen === 'case' && curCase()) noteLang(curCase().metrics);
    }
    save();
  }
  window.addEventListener('t2d:lang', onLang);

  // expose minimal hooks for QA (no PII)
  window.__T2D_APP__ = { version: CFG.APP_VERSION, state: function () { return S; }, lang: uiLang, downloadText: function () { return S ? downloadText() : ''; } };

  // ---------------------------------------------------------------------------
  // Boot
  //  1) 언어 런타임·사전이 없으면(이전 HTML 이 캐시된 경우 등) 먼저 불러온다.
  //  2) 저장된 진행 상태의 케이스 세트(set_id, 없으면 v1)가 활성 세트와 다르면 data/sets/<id>/cases.js·design.js 를
  //     불러와 그 세트로 이어서 진행한다(보관본이 없으면 활성 세트 그대로). 보통은 둘 다 필요 없어 바로(동기) 시작한다.
  // ---------------------------------------------------------------------------
  function loadScript(src, cb) {
    var el = document.createElement('script');
    el.src = src; el.async = false;
    el.onload = function () { cb(true); };
    el.onerror = function () { if (el.parentNode) el.parentNode.removeChild(el); cb(false); };
    (document.head || document.documentElement).appendChild(el);
  }
  function loadSeq(list, cb) {
    var i = 0;
    (function next() { if (i >= list.length) { cb(); return; } loadScript(list[i++], next); })();
  }
  function ensureI18n(cb) {
    var T2 = window.T2D, need = [];
    if (!T2 || !T2.t) need.push('../assets/i18n.js');
    if (!T2 || !T2.i18n || !T2.i18n.dict || !T2.i18n.dict.ko['ca.intro.title']) need.push('../i18n/ca.js');
    if (!need.length) { cb(); return; }
    loadSeq(need.map(function (u) { return u + '?v=' + encodeURIComponent(CFG.APP_VERSION); }), cb);
  }
  function savedSetId() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      return (s && s.v === 1) ? String(s.set_id || 'v1') : null;
    } catch (_) { return null; }
  }
  function ensureSet(cb) {
    var want = savedSetId();
    if (!want || want === ((DATA && DATA.set_id) || 'v1') || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(want)) { cb(); return; }
    var active = { data: window.T2D_DATA, design: window.T2D_DESIGN };
    var base = '../data/sets/' + want + '/';
    loadScript(base + 'cases.js', function (ok) {
      var d = window.T2D_DATA;
      if (!ok || !d || d === active.data || (d.set_id && d.set_id !== want)) {
        window.T2D_DATA = active.data; window.T2D_DESIGN = active.design;   // 보관본 없음 → 활성 세트 그대로
        cb(); return;
      }
      if (!d.set_id) d.set_id = want;
      window.T2D_DESIGN = undefined;
      loadScript(base + 'design.js', function (ok2) {
        var g = window.T2D_DESIGN;
        if (!ok2 || !g || (g.set_id && g.set_id !== want)) window.T2D_DESIGN = null;   // → config.js 기본 Type (세트 v1)
        cb();
      });
    });
  }
  // 이어서 하는 세션: 방문자가 언어를 직접 고른 적이 없으면(?lang= 없음, 't2d:lang' 없음) 세션을 시작한 언어로 보여 준다.
  // ui_lang_start 가 없는 이전 버전 세션은 한국어로 시작한 것이다. 직접 고른 것이 아니므로 't2d:lang' 에 저장하지 않는다.
  function explicitLang() {
    try { var q = new URLSearchParams(location.search).get('lang'); if (q === 'ko' || q === 'en') return true; } catch (_) {}
    try { var s = localStorage.getItem('t2d:lang'); return s === 'ko' || s === 'en'; } catch (_) { return false; }
  }
  function pinSessionLang(st) {
    if (!st || st.screen === 'intro' || !I18N.i18n || explicitLang()) return;
    var want = st.ui_lang_start === 'en' ? 'en' : 'ko';
    if (I18N.lang === want) return;
    I18N.lang = want;
    document.documentElement.setAttribute('lang', want);
    I18N.i18n.apply(document);
  }
  function boot() {
    I18N = window.T2D || {};
    DATA = window.T2D_DATA;
    TYPES = resolveTypes();
    URL_TYPE = urlType();
    draft = emptyDraft();
    S = load();
    if (S) lastRev = S.rev || 0;
    if (S && !S.ui_langs) {
      // v3.6 이전 세션(언어 기록 없음)은 한국어로 진행된 것: 이미 시작한 케이스와 세션의 언어 기록을 'ko' 로 채운다
      S.ui_langs = [S.ui_lang_start || 'ko'];
      if (!S.ui_lang_start) (S.cases || []).forEach(function (c) { if (c.started_at && c.metrics && !c.metrics.ui_langs) c.metrics.ui_langs = ['ko']; });
    }
    pinSessionLang(S);
    shownLang = uiLang();
    mountPrefs();
    paintChrome();
    if (S && S.screen === 'intro') {
      // 순서 배정 도중 창이 닫힌 경우: 처음부터
      try { localStorage.removeItem(STORE_KEY); } catch (_) {}
      S = null;
    }
    if (S && (S.screen === 'case' || S.screen === 'final')) {
      S.metrics.resumes += 1;
      S.device.last_resume = deviceInfo();
      save();
      setTimeout(function () { toast(t('ca.toast.resumed'), 3200); }, 300);
    }
    render();
    if (S && S.screen === 'case') { var m = stepMetrics(curCase(), curStep()); m.visits += 1; noteLang(curCase().metrics); save(); }
    if (S && S.screen !== 'done') { noteLang(S); save(); }
    if (S) flush();
    booted = true;
  }
  ensureI18n(function () { ensureSet(boot); });
})();
