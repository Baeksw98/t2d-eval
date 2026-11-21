/* 가이드라인 부합도 검증 (Guideline Concordance · Physician Validation) — app
 * 분과전문의가 AI 감사가 표시한(△/✗) AI 채점 판정만 확인합니다. 계약: docs/GC_CONTRACT.md
 * 패턴(보관함·재전송·자동 저장·탭 보호·시간 측정)은 루트 app.js(임상 수용성 평가, /ca/)와 같습니다.
 * 화면 문구: i18n/gc.js (+ 환자 기록·처방·답 이름은 i18n/ca.js) · 언어/테마 런타임: assets/i18n.js
 * 문항 설정: gc-config.js (한국어 = 저장 값, en = 영어 화면 번역). 응답에는 언어와 관계없이 한국어 원문 + code / id 를 저장합니다.
 * 케이스 세트: data/gc_items.js (window.GC_DATA, set_id) + ../data/cases.js + ../data/design.js (window.T2D_DESIGN.gc.parts).
 *   저장된 진행 상태(또는 이어서 하기 초안)의 세트가 활성 세트와 다르면 data/sets/<id>/ 보관본을 불러온 뒤 이어서 진행합니다. */
(function () {
  'use strict';

  var CFG = window.GC_CONFIG;
  var G = window.GC_DATA;              // 부팅(boot) 때 진행 중인 세션의 세트로 바뀔 수 있음
  var DATA = window.T2D_DATA;
  function setOf(g, d) { return (g && g.set_id) || (d && d.set_id) || 'v1'; }
  var ACTIVE_SET = setOf(G, DATA);
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
  // Language (assets/i18n.js + i18n/gc.js + i18n/ca.js). 화면은 T2D.lang 으로 그리고, 응답에는 항상 한국어 원문 + code / id.
  // ---------------------------------------------------------------------------
  var I18N = window.T2D || {};
  function t(key, vars) { return I18N.t ? I18N.t(key, vars) : key; }
  function uiLang() { return I18N.lang === 'en' ? 'en' : 'ko'; }
  function pick(v) {   // {ko, en} 또는 문자열 → 화면 언어의 문자열
    if (I18N.pick) return I18N.pick(v);
    return v && typeof v === 'object' ? String(v.ko == null ? '' : v.ko) : String(v == null ? '' : v);
  }
  // config 항목의 화면 문구: 영어 화면이면 o.en[k] (있을 때), 아니면 o[k] (한국어 원문 = 저장 값). {ko, en} 객체도 받는다.
  function tr(o, k) {
    if (!o) return '';
    var v = o[k];
    if (uiLang() === 'en' && o.en && o.en[k] != null) v = o.en[k];
    return pick(v);
  }
  // 선택지 i 의 화면 문구 (o.options[i] 는 저장 값, o.en.options[i] 는 영어 화면 번역)
  function optLabel(o, i) {
    if (uiLang() === 'en' && o.en && o.en.options && o.en.options[i] != null) return pick(o.en.options[i]);
    return pick(o.options[i]);
  }
  // 저장된 값(한국어 원문) → 화면 문구 (이어서 하기 요약 등)
  function valueLabel(f, v) {
    var i = f && f.options ? f.options.indexOf(v) : -1;
    return i >= 0 ? optLabel(f, i) : String(v == null ? '' : v);
  }

  // ---------------------------------------------------------------------------
  // Study definitions
  // ---------------------------------------------------------------------------
  var VERDICTS = CFG.VERDICTS;
  var PROFILE = CFG.PROFILE_FIELDS || [];
  var END_ITEMS = CFG.END_ITEMS || [];
  var ELIG = CFG.ELIGIBILITY;
  // 답 번호 이름·Phase 이름은 임상 수용성 평가와 같은 문구 (i18n/ca.js ca.instrument.*)
  function qLabel(q) { return t('ca.instrument.q.' + q); }
  function phaseName(n) { return 'Phase ' + n + ' · ' + t('ca.instrument.p' + n + '.title'); }
  var PHASE_GROUPS = [
    [2, ['2.1', '2.2', '2.3']],
    [3, ['3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8']],
    [4, ['4.1', '4.2', '4.3']],
    [5, ['5.1', '5.2', '5.3', '5.4']]
  ];
  var ALL_Q = ['2.1', '2.2', '2.3', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '5.4'];
  var END_BY_ID = {}; END_ITEMS.forEach(function (f) { END_BY_ID[f.id] = f; });
  var PROFILE_BY_ID = {}; PROFILE.forEach(function (f) { PROFILE_BY_ID[f.id] = f; });

  // Part(배정 단위): 활성 세트의 data/design.js (T2D_DESIGN.gc.parts) → 없거나 이 세트의 데이터와 맞지 않으면 gc-config.js PARTS
  function validParts(list) {
    return Array.isArray(list) && list.length > 0 && list.every(function (p) {
      return p && p.id && Array.isArray(p.sequences) && p.sequences.length > 0 && p.sequences.every(function (seq) {
        return Array.isArray(seq) && seq.length > 0 && seq.every(function (k) { return !!(G && G.units && G.units[k] && DATA && DATA.outputs && DATA.outputs[k]); });
      });
    });
  }
  function resolveParts() {
    var d = window.T2D_DESIGN, fromDesign = d && d.gc && d.gc.parts;
    if (validParts(fromDesign) && (!d.set_id || d.set_id === setOf(G, DATA))) return fromDesign;
    return CFG.PARTS;
  }
  var PARTS = resolveParts();
  function partById(id) { for (var i = 0; i < PARTS.length; i++) if (PARTS[i].id === id) return PARTS[i]; return null; }
  function partLabel(p) { return p ? pick(p.label) : ''; }
  function verdictById(id) { for (var i = 0; i < VERDICTS.length; i++) if (VERDICTS[i].id === id) return VERDICTS[i]; return null; }
  function vLabel(id) { var v = verdictById(id); return v ? tr(v, 'label') : String(id || ''); }
  function unitItems(k) { return (G.units[k] && G.units[k].items) || []; }
  function partItemCount(p) { return p.sequences[0].reduce(function (a, k) { return a + unitItems(k).length; }, 0); }
  // 한 Part 의 답변 수·환자 수 (안내 문구용; 세트마다 다를 수 있음)
  function partShape(p) {
    var seq = (p && p.sequences[0]) || [], pts = {};
    seq.forEach(function (k) { var u = G.units[k]; if (u) pts[u.patient] = 1; });
    return { u: seq.length || 2, p: Object.keys(pts).length || 2 };
  }
  // 예상 시간: design.js 의 Part minutes [lo, hi] → 없으면 판정 수 × 1건당 예상 시간의 5분 단위 범위 ('약 20–25분')
  function minutesRange(n, p) {
    var mm = p && p.minutes;
    if (Array.isArray(mm) && mm.length === 2 && mm[0] > 0 && mm[1] >= mm[0]) return t('gc.min.range', { lo: mm[0], hi: mm[1] });
    var m = n * (Number(CFG.MINUTES_PER_ITEM) || 1);
    if (m <= 5) return t('gc.min.about', { m: 5 });
    var lo = Math.floor(m / 5) * 5;
    return t('gc.min.range', { lo: lo, hi: lo + 5 });
  }
  function nVerdicts(n) { return t(n === 1 ? 'gc.n.verdict1' : 'gc.n.verdicts', { n: n }); }
  function comboName(n) { return n ? t('gc.combo.n', { n: n }) : 'Phase 1'; }
  function urlPart() { var v = String(params.get('part') || '').toUpperCase(); return partById(v) ? v : ''; }
  var URL_PART = urlPart();

  // 접속 경로(QR·카카오톡·링크)와 기관·차수 코드 — 개인정보 없음
  function safeParam(k) { return String(params.get(k) || '').replace(/[^0-9A-Za-z_\-]/g, '').slice(0, 32); }
  var UA = navigator.userAgent || '';
  var IN_APP = /KAKAOTALK/i.test(UA) ? 'KAKAOTALK' : /NAVER/.test(UA) ? 'NAVER' : /\bLine\//.test(UA) ? 'LINE' :
    /Instagram/i.test(UA) ? 'INSTAGRAM' : /FBAN|FBAV/.test(UA) ? 'FACEBOOK' : /; wv\)/.test(UA) ? 'WEBVIEW' : '';
  // 외부에서 바로 왔으면 그 origin. 처음 화면(/)·소개를 거쳐 왔으면 그 페이지가 남긴 진입 origin (app.js 와 같음)
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
    part_preselected: !!URL_PART, in_app: IN_APP, referrer_origin: REF_ORIGIN
  };
  // 사이트 안 다른 페이지 링크(처음 화면 ../ · 벤치마크 소개 ../about/ · 임상 수용성 평가 ../ca/) — 접속 경로(src·site·wave)만 넘긴다.
  // test·part·reset 은 넘기지 않는다 (루트는 test 가 있으면 /ca/ 로 보낸다).
  var SITE_QS = (function () {
    var q = new URLSearchParams();
    ['src', 'site', 'wave'].forEach(function (k) { var v = safeParam(k); if (v) q.set(k, v); });
    return q.toString() ? '?' + q.toString() : '';
  })();
  var BACK_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>';
  function siteLinksHTML() {
    return '<nav class="site-links" aria-label="' + esc(t('gc.nav.aria')) + '">' +
      '<a href="../' + SITE_QS + '" id="homeLink">' + BACK_SVG + esc(t('gc.nav.home')) + '</a>' +
      '<span class="sep" aria-hidden="true">·</span>' +
      '<a href="../about/' + SITE_QS + '" id="aboutLink">' + esc(t('gc.nav.about')) + '</a></nav>';
  }
  // 영어 화면에서 케이스 내용(환자 기록·CDSS 답변·AI 채점/감사 문구)은 원문(한국어)으로 보인다는 안내 — 화면 영역마다 한 번
  function srcNoteHTML() {
    return uiLang() === 'en' ? '<p class="src-note"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.9 6h-3a15.7 15.7 0 0 0-1.4-3.6A8 8 0 0 1 18.9 8zM12 4c.8 1.2 1.5 2.5 1.9 4h-3.8c.4-1.5 1.1-2.8 1.9-4zM4.3 14a8 8 0 0 1 0-4h3.4a16.5 16.5 0 0 0 0 4H4.3zm.8 2h3a15.7 15.7 0 0 0 1.4 3.6A8 8 0 0 1 5.1 16zm3-8h-3a8 8 0 0 1 4.4-3.6C8.9 5.5 8.4 6.7 8.1 8zM12 20c-.8-1.2-1.5-2.5-1.9-4h3.8c-.4 1.5-1.1 2.8-1.9 4zm2.3-6H9.7a14.7 14.7 0 0 1 0-4h4.6a14.7 14.7 0 0 1 0 4zm.3 5.6c.6-1.1 1.1-2.3 1.4-3.6h3a8 8 0 0 1-4.4 3.6zm1.7-5.6a16.5 16.5 0 0 0 0-4h3.4a8 8 0 0 1 0 4h-3.4z"/></svg>' +
      esc(t('gc.srcNote')) + '</p>' : '';
  }
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
    if (m < 1) return t('gc.time.lt1');
    if (m < 60) return t('gc.time.min', { m: m });
    return t('gc.time.hm', { h: Math.floor(m / 60), m: m % 60 });
  }
  // 월 비용: 숫자(범위)면 화면 언어 형식으로, 아니면 원문 그대로(케이스 내용, lang="ko") — app.js 와 같음
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
      set_id: setOf(G, DATA),           // 케이스 세트 (이 필드가 없는 이전 상태 = v1)
      ui_lang_start: uiLang(),          // 세션을 시작한 화면 언어
      ui_langs: [uiLang()],             // 이 세션에서 보인 화면 언어들 (시작·전환·이어서 하기)
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
      eligible: '', name: '', fields: {}, missing: [], part: URL_PART, consent: false, consent_at: null, consent_inherited: false,
      linked: null, done_parts: [], evaluator_id: null, prev_patients: [], pending: [], introBucket: emptyBucket(),
      set_id: setOf(G, DATA)   // 이어서 하기 초안의 세트 (없는 이전 초안 = v1)
    };
  }
  function loadDraft() {
    try {
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (!d || !d.linked) return null;
      var base = emptyDraft();
      if (!d.set_id) d.set_id = 'v1';             // set_id 가 없는 이전 초안 = 세트 v1
      var oldDraft = !Array.isArray(d.missing);   // v1 페이지가 저장한 초안: missing 이 없음 → 아래에서 다시 계산
      Object.keys(base).forEach(function (k) { if (d[k] === undefined) d[k] = base[k]; });
      if (!d.fields || typeof d.fields !== 'object') d.fields = {};
      if (oldDraft) d.missing = unansweredProfile(d.fields);
      d.introBucket = emptyBucket();
      if (!partById(d.part) || d.done_parts.indexOf(d.part) >= 0) d.part = '';
      return d;
    } catch (_) { return null; }
  }
  function saveDraft() {
    if (S || !draft.linked) return;
    draft.set_id = setOf(G, DATA);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (_) {}
  }
  var draft = emptyDraft();
  // 답이 비어 있는 필수 검증자 정보 문항 id (이어서 검증할 때 이 문항만 묻는다)
  function unansweredProfile(fields) {
    return PROFILE.filter(function (f) { return f.required && !String((fields || {})[f.id] || '').trim(); }).map(function (f) { return f.id; });
  }
  function missingNames() {
    return (draft.linked && draft.missing ? draft.missing : []).map(function (id) {
      var f = PROFILE_BY_ID[id]; return f ? (tr(f, 'short') || tr(f, 'label')) : '';
    }).filter(Boolean);
  }

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
    if (draft.eligible !== 'yes') return [t('gc.err.elig'), '#eligCard'];
    if (!draft.name.trim()) return [t('gc.err.name'), '#evName'];
    for (var i = 0; i < PROFILE.length; i++) {
      var f = PROFILE[i];
      if (f.required && !String(draft.fields[f.id] || '').trim()) {
        // 안전장치: 이어서 검증하는 화면에 이 문항이 없으면(이전 버전 초안 등) 묻는 문항에 넣고 다시 그린다
        if (draft.linked && (!draft.missing || draft.missing.indexOf(f.id) < 0)) {
          draft.missing = (draft.missing || []).concat([f.id]);
          saveDraft(); render();
        }
        return [t('gc.err.profile'), '[data-field="' + f.id + '"]'];
      }
    }
    if (!partById(draft.part) || draft.done_parts.indexOf(draft.part) >= 0) return [t('gc.err.part'), '.part-grid'];
    if (!draft.consent) return [t('gc.err.consent'), '#evConsent'];
    return null;
  }

  var S = null;   // 저장된 진행 상태는 부팅(boot) 때 불러온다 (세트 보관본을 먼저 불러와야 할 수 있음)
  var STEPS = [];   // [{u, i}] — i = -1 은 답변(unit) 안내 화면
  function buildSteps() {
    STEPS = [];
    if (!S || !S.order) return;
    S.order.forEach(function (k, u) {
      STEPS.push({ u: u, i: -1 });
      unitItems(k).forEach(function (_, i) { STEPS.push({ u: u, i: i }); });
    });
  }

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
        try { j = JSON.parse(txt); } catch (_) { throw new Error(t('gc.net.badResponse')); }
        if (!j || !j.ok) throw new Error((j && j.error) || t('gc.net.serverError'));
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
      entry: S.entry || ENTRY, consent: S.consent || {}, incentive: CFG.INCENTIVE || '',
      ui_lang: uiLang(),                 // 이 응답을 보낼 때의 화면 언어 (값은 언어와 관계없이 한국어 원문 + code / 판정 id)
      set_id: S.set_id || 'v1'           // 세션의 케이스 세트 (set_id 가 없는 이전 상태 = v1)
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
      is_test: URL_TEST, visit_id: VISIT_ID, device_id: DEVICE_ID, entry: en, form_factor: deviceInfo().form_factor,
      ui_lang: uiLang(), set_id: setOf(G, DATA)
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
  // 화면 언어 기록: obj.ui_langs 에 지금 언어를 (처음 보일 때만) 더한다 — 판정·세션이 어느 언어로 보였는지 (분석용)
  function noteLang(obj) {
    if (!obj) return;
    var l = uiLang();
    if (!obj.ui_langs) obj.ui_langs = [];
    if (obj.ui_langs.indexOf(l) < 0) obj.ui_langs.push(l);
  }
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
      // 화면 언어: 마지막으로 동의·판정을 고른 때의 언어 / 이 판정 화면이 보인 언어들 (2개 = 언어를 바꿔 가며 본 판정)
      ui_lang: j.ui_lang || null, ui_langs: (j.ui_langs || []).slice(), ui_lang_mixed: (j.ui_langs || []).length > 1,
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
      items_done: counts().done,
      // 화면 언어 이력: 시작 언어, 언어 전환 횟수, 이 세션에서 보인 언어들
      ui_lang_start: S.ui_lang_start || null,
      ui_lang_switches: S.ui_lang_switches || 0,
      ui_langs: (S.ui_langs || [S.ui_lang_start || 'ko']).slice()
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
      noteLang(j);
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
      var tg = elMain.querySelector(err[1]);
      if (tg) {
        tg.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
        var f = tg.matches('input, button') ? tg : tg.querySelector('button:not([disabled]), input');
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
          toast(t(j.agree === false ? 'gc.err.alt' : 'gc.err.agree'));
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
        toast(t('gc.err.endItems'));
        var seg = elMain.querySelector('[data-field="' + missing[0].id + '"]');
        if (seg) { seg.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' }); var b = seg.querySelector('button'); if (b) b.focus({ preventScroll: true }); }
        return;
      }
      var incomplete = counts();
      if (incomplete.done < incomplete.total) { toast(t('gc.err.incomplete')); return; }
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
    j.ui_lang = uiLang(); noteLang(j);
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
    j.ui_lang = uiLang(); noteLang(j);
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
    fillDrawer();
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
  function fillDrawer() {
    var out = DATA.outputs[S.order[curStep().u]];
    elDrawerBody.innerHTML = srcNoteHTML() + patientHTML(DATA.patients[out.patient], true);
    $('drawerTitle').textContent = t('gc.drawer.titleId', { id: out.patient });
    $('drawerClose').setAttribute('aria-label', t('gc.close'));
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

  // 환자 기록: 항목 이름은 화면 언어, 값(케이스 내용)은 원문 그대로 lang="ko" 로 표시 (app.js 와 같음; 문구 키는 i18n/ca.js)
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
  function liKo(arr) { return (arr || []).map(function (s) { return '<li lang="ko">' + esc(s) + '</li>'; }).join(''); }
  function patientHTML(p) {
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
    var tags = function (arr, highlight) {
      return '<div class="tags">' + arr.map(function (x) {
        return '<span class="tag' + (highlight ? hl(x) : '') + '" lang="ko">' + esc(x) + '</span>';
      }).join('') + '</div>';
    };
    h.push(
      '<section class="card">' +
        '<h3 class="section-title">' + esc(t('ca.pt.history')) + '</h3>' +
        '<dl class="kv">' +
          '<dt>' + esc(t('ca.pt.otherConditions')) + '</dt><dd>' + tags(p.history.other_conditions, true) + '</dd>' +
          '<dt>' + t('ca.pt.dmComorbHtml') + '</dt><dd>' + tags(p.history.dm_comorbidities, true) + '</dd>' +
          '<dt>' + esc(t('ca.pt.family')) + '</dt><dd lang="ko">' + esc(p.history.family) + '</dd>' +
          '<dt>' + esc(t('ca.pt.social')) + '</dt><dd><ul class="clean">' + liKo(p.history.social) + '</ul></dd>' +
        '</dl>' +
      '</section>'
    );

    h.push(
      '<section class="card">' +
        '<h3 class="section-title">' + esc(t('ca.pt.meds')) + '</h3>' +
        '<ul class="clean">' + liKo(p.medications) + '</ul>' +
        '<h3 class="section-title" style="margin-top:14px">' + esc(t('ca.pt.exam')) + '</h3>' + tags(p.exam, false) +
      '</section>'
    );

    var th = function (k) { return '<span class="lg">' + esc(t('ca.pt.m' + k)) + '</span><span class="sm">-' + k + 'm</span>'; };
    var head = '<tr><th class="name">' + esc(t('ca.pt.labItem')) + '</th><th>' + th(12) + '</th><th>' + th(9) + '</th><th>' +
      th(6) + '</th><th>' + th(3) + '</th><th class="now">' + esc(t('ca.pt.now')) + '</th></tr>';
    var rows = [], lastGroup = null;
    p.labs.forEach(function (lab) {
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
  function rxHTML(rx) {
    var cls = DECISION_CLASS[rx.decision] || 'keep';
    var cov = rx.reimbursement === '급여' ? 'cov' : 'nocov';
    return '<div class="rx' + (cls === 'stop' ? ' stopped' : '') + '">' +
      '<div class="rx-top"><span class="badge ' + cls + '">' + decisionHTML(rx.decision) + '</span>' +
      '<span class="rx-drug" lang="ko">' + esc(rx.drug) + '</span><span class="rx-class" lang="ko">' + esc(rx.class) + '</span></div>' +
      '<div class="rx-dose" lang="ko">' + esc(rx.dose) + ' · ' + esc(rx.frequency) + '</div>' +
      '<dl class="rx-meta">' +
        '<dt>' + esc(t('ca.rx.titration')) + '</dt><dd lang="ko">' + esc(rx.titration || '—') + '</dd>' +
        '<dt>' + esc(t('ca.rx.coverage')) + '</dt><dd><span class="badge ' + cov + '">' + coverageHTML(rx.reimbursement) + '</span> ' +
          t('ca.rx.perMonthHtml', { cost: fmtCost(rx.monthly_cost_krw) }) + '</dd>' +
        (rx.alternatives ? '<dt>' + esc(t('ca.rx.alternatives')) + '</dt><dd lang="ko">' + esc(rx.alternatives) + '</dd>' : '') +
      '</dl></div>';
  }
  function rxListHTML(list) { return '<div class="rx-list">' + list.map(rxHTML).join('') + '</div>'; }
  // 조합은 AI가 붙인 이름 대신 '조합 N' + 약물 구성으로 표시 (CA 와 같음)
  function drugChipsHTML(cb) {
    return '<div class="cc-drugs">' + cb.prescription.map(function (rx) {
      var cls = DECISION_CLASS[rx.decision] || 'keep';
      return '<span class="drug ' + cls + '"><b lang="ko">' + esc(rx.drug) + '</b><em>' + decisionHTML(rx.decision) + '</em></span>';
    }).join('') + '</div>';
  }

  // ---------------------------------------------------------------------------
  // Render helpers — GC
  // ---------------------------------------------------------------------------
  function vdHTML(id, extra) {
    return '<span class="vd v-' + esc(id) + (extra ? ' ' + extra : '') + '">' + esc(vLabel(id)) +
      (extra && extra.indexOf('struck') >= 0 ? '<span class="sr-only">' + esc(t('gc.vd.struckSr')) + '</span>' : '') + '</span>';
  }
  // AI 감사 표시: △ = 판정은 유지하되 근거 보완이 필요하다는 의견 / ✗ = 판정이 틀렸다고 보고 바로잡음 (문구: gc.instrument.mark.*)
  var MARK = { minor: { sym: '△', key: 'minor' }, major: { sym: '✗', key: 'major' } };
  function markOf(mark) { return mark === 'major' ? MARK.major : MARK.minor; }
  function markLabel(mark) { return t('gc.instrument.mark.' + markOf(mark).key + '.label'); }
  function markMeaning(mark) { return t('gc.instrument.mark.' + markOf(mark).key + '.meaning'); }
  function mkHTML(mark) {
    var m = markOf(mark);
    return '<span class="mk ' + (mark === 'major' ? 'major' : 'minor') + '"><span aria-hidden="true">' + m.sym + '</span> ' + esc(markLabel(mark)) + '</span>';
  }
  // AI 감사가 판정을 바꿨는지 (✗ 의 보정 판정이 AI 채점 판정과 다름) — 화면 ④ 의 '감사에서 바뀜'
  function changedByAudit(item) { return !!item.audit.corrected && item.audit.corrected !== item.rater.verdict; }
  function answerParts(out, combo, q) {
    if (!combo) {
      var p1 = out.phase_1 || {};
      if (q === '1.1') { var a1 = p1['1.1'] || {}; return { callout: a1.referral ? { label: t('gc.ans.referral'), text: a1.referral } : null, text: a1.answer || '' }; }
      return { callout: null, text: typeof p1[q] === 'string' ? p1[q] : '' };
    }
    var a = out.combinations[combo - 1].answers[q];
    if (a && typeof a === 'object') return { callout: a.next_visit ? { label: t('gc.ans.nextVisit'), text: a.next_visit } : null, text: a.answer || '' };
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
  // 답변 본문(케이스 내용)은 lang="ko"; 라벨('다음 방문' 등)만 화면 언어
  function answerBodyHTML(ap, rq, aq) {
    return (ap.callout ? '<span class="callout"><small>' + esc(ap.callout.label) + '</small><span lang="ko">' + markHTML(ap.callout.text, rq, aq) + '</span></span>' : '') +
      (ap.text ? '<p lang="ko">' + markHTML(ap.text, rq, aq) + '</p>' : '<p><span class="muted">' + esc(t('gc.ans.none')) + '</span></p>');
  }

  // ---- 판정 화면: 채점 항목(맥락) → ① CDSS 답변 → ② AI 채점 사유 → ③ AI 감사 의견 → ④ 최종 판정 ----
  // 문장 안의 작은 단계 번호 배지 (①–④ 글자 대신: 글꼴과 관계없이 단계 머리의 번호와 같은 모양)
  function nbHTML(n) { return '<span class="gc-nb">' + n + '</span>'; }
  // 판정 화면을 읽는 순서 (시작 화면·답변 안내 화면에서 같은 모양으로 보여 줌)
  function readOrderHTML() {
    return '<ol class="gc-order" aria-label="' + esc(t('gc.order.aria')) + '">' + [1, 2, 3, 4].map(function (i) {
      return '<li><span class="gc-step-no" aria-hidden="true">' + i + '</span>' + esc(t('gc.order.' + i)) + '</li>';
    }).join('') + '</ol>';
  }
  // 단계 머리: 번호 배지 + 제목(h2) + 오른쪽 요약 칩. 스크린리더에는 'N단계.' 가 앞에 읽힘
  function stepHeadHTML(n, title, sub, aside) {
    return '<header class="gc-step-head">' +
      '<span class="gc-step-no" aria-hidden="true">' + n + '</span>' +
      '<div class="gc-step-tt"><h2 class="gc-step-title" id="gcS' + n + 'h"><span class="sr-only">' + esc(t('gc.step.sr', { n: n })) + '</span>' + title + '</h2>' +
        (sub ? '<p class="gc-step-sub">' + sub + '</p>' : '') + '</div>' +
      (aside ? '<div class="gc-step-aside">' + aside + '</div>' : '') +
    '</header>';
  }
  function stepHTML(n, cls, inner) {
    return '<li class="gc-step gc-s' + n + '" id="gcStep' + n + '" data-step="' + n + '">' +
      '<section class="card ' + cls + '" aria-labelledby="gcS' + n + 'h">' + inner + '</section></li>';
  }
  // 인용문 위치 안내: 'here' → ① 답변에 표시 / 같은 조합의 다른 답(① 아래 '인용된 다른 답'에 함께 표시) / 찾지 못함
  function locNote(loc) {
    return loc === 'here' ? t('gc.loc.hereHtml', { nb: nbHTML(1) })
      : loc ? t('gc.loc.otherHtml', { q: esc(loc), nb: nbHTML(1) }) : esc(t('gc.loc.miss'));
  }
  // ②·③이 인용한 문장이 이 판정의 답이 아닌 같은 조합(또는 Phase 1)의 다른 답에 있으면 그 답 번호들 (답 순서대로)
  // → ① 에서 바로 보여 준다 (전체 답변 펼침에서 찾지 않아도 되게)
  //    반환: { qs: ['5.4', …], r: AI 채점 인용이 있음, a: AI 감사 근거가 있음 }
  function citedOtherQs(out, item, rq, aq) {
    var hit = {}, by = { r: false, a: false };
    [['r', rq], ['a', aq]].forEach(function (src) {
      (src[1] || []).forEach(function (q) {
        var loc = findQuote(out, item, q);
        if (loc && loc !== 'here') { hit[loc] = 1; by[src[0]] = true; }
      });
    });
    return { qs: (item.combo ? ALL_Q : ['1.1', '1.2']).filter(function (q) { return hit[q]; }), r: by.r, a: by.a };
  }
  // 데이터의 'Rater' 는 화면 용어 'AI 채점' 으로 (화면 어디에도 Rater 라는 말이 없음). 케이스 내용(한국어) 안의 치환이다.
  function screenTerms(s) {
    return String(s == null ? '' : s).replace(/Rater(는|가)?/g, function (_, p) {
      return 'AI 채점' + (p === '는' ? '은' : p === '가' ? '이' : '');
    });
  }
  // 고정 용어(채점 감점 유형 · 감사 오류 유형 '… · …')의 영어 화면 문구. 저장 값(payload audit_category 등)은 한국어 그대로이고,
  // 모르는 용어가 하나라도 있으면 null → 원문(한국어, lang="ko")을 그대로 보여 준다 (새 세트에 새 용어가 들어와도 깨지지 않게).
  var TERM_KEYS = {
    '다루지 않음': 'notAddressed', '틀린 권고': 'wrongRec',
    '답변 내용 오독': 'misread', '환자 사실 오류': 'patientFact', '인용 불일치': 'quoteMismatch',
    '항목 적용 오류': 'misapplied', '사유 부족': 'thinReason', '충족 여부': 'aspectVerdict', '인용과 사유': 'aspectQuotes'
  };
  function trTerm(s) {
    s = String(s == null ? '' : s).trim();
    if (uiLang() !== 'en' || !s) return null;
    var parts = s.split(/\s*·\s*/), out = [];
    for (var i = 0; i < parts.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(TERM_KEYS, parts[i])) return null;
      out.push(t('gc.term.' + TERM_KEYS[parts[i]]));
    }
    return out.join(' · ');
  }
  // 감사 근거 출처 표시('CDSS 답변 조합 1, 2.2', '환자 기록 병력', '채점 항목 Q2.2-04 감점 기준', '가이드라인 …')의 영어 화면 문구 (모르면 null)
  var REC_KEYS = { '병력': 'history', '검사 수치': 'labs', '인구통계': 'demo' };
  function trEvidenceLabel(s) {
    s = String(s == null ? '' : s).trim();
    if (uiLang() !== 'en' || !s) return null;
    var m;
    if ((m = s.match(/^CDSS 답변 조합 (\d+),? ?처방$/))) return t('gc.term.evRx', { c: m[1] });
    if ((m = s.match(/^CDSS 답변 조합 (\d+),? ?(\d+(?:\.\d+)?)$/))) return t('gc.term.evAns', { c: m[1], q: m[2] });
    if ((m = s.match(/^CDSS 답변,? ?(\d+(?:\.\d+)?)$/))) return t('gc.term.evAnsP1', { q: m[1] });
    if ((m = s.match(/^환자 기록 (병력|검사 수치|인구통계)$/))) return t('gc.term.evRecord', { what: t('gc.term.rec.' + REC_KEYS[m[1]]) });
    if ((m = s.match(/^채점 항목 (\S+) (감점|지침) 기준$/))) return t('gc.term.evElem', { id: m[1], kind: t(m[2] === '감점' ? 'gc.term.crit.deduct' : 'gc.term.crit.guide') });
    if ((m = s.match(/^가이드라인 ([\x20-\x7E]+)$/))) return t('gc.term.evGuide', { ref: m[1] });
    return null;
  }
  // '오류 유형 · 값' 줄: 값을 번역할 수 있으면 화면 언어로, 아니면 원문(lang="ko")
  function catHTML(labelKey, value) {
    var en = trTerm(value);
    return en !== null
      ? '<p class="gc-cat"><span>' + esc(t(labelKey)) + '</span>' + esc(en) + '</p>'
      : '<p class="gc-cat" lang="ko"><span lang="' + uiLang() + '">' + esc(t(labelKey)) + '</span>' + esc(screenTerms(value)) + '</p>';
  }

  // 채점 항목 (맥락): 요소 ID·제목, 감점 기준(접힘). 충족·감점의 뜻은 ④ 와 비동의 버튼에 있음
  function elementCardHTML(item) {
    return '<section class="card gc-elem" aria-labelledby="gcTitle">' +
      '<div class="gc-elem-top"><span class="gc-elem-id">' + esc(item.element) + '</span><span class="gc-elem-k">' + esc(t('gc.elem.k')) + '</span></div>' +
      '<h1 class="gc-title" id="gcTitle" lang="ko">' + esc(item.title) + '</h1>' +
      '<div class="gc-crit">' +
        '<h2 class="gc-crit-k">' + esc(t('gc.elem.crit')) + '</h2>' +
        '<div class="gc-clamp' + (ui.critOpen ? ' open' : '') + '" id="gcCrit" lang="ko">' + esc(item.criterion) + '</div>' +
        '<button type="button" class="gc-more-btn" data-act="crit" aria-expanded="' + ui.critOpen + '" aria-controls="gcCrit">' +
          esc(t(ui.critOpen ? 'gc.elem.less' : 'gc.elem.more')) + '</button>' +
      '</div>' +
      srcNoteHTML() +
    '</section>';
  }
  function fullAnswerHTML(item, out, cb, rq, aq) {
    var row = function (q) {
      var cur = q === item.question;
      return '<div class="gc-full-row' + (cur ? ' cur' : '') + '"><div class="gc-full-q"><b>' + esc(q) + '</b> ' + esc(qLabel(q)) +
        (cur ? ' <span class="pill orange">' + esc(t('gc.full.this')) + '</span>' : '') + '</div>' +
        answerBodyHTML(answerParts(out, item.combo, q), rq, aq) + '</div>';
    };
    if (!cb) return '<div class="gc-full"><h3 class="mini">' + esc(phaseName(1)) + '</h3>' + ['1.1', '1.2'].map(row).join('') + '</div>';
    return '<div class="gc-full"><h3 class="mini">' + esc(t('gc.full.rx', { n: item.combo })) + '</h3>' + rxListHTML(cb.prescription) +
      PHASE_GROUPS.map(function (g) { return '<h3 class="mini">' + esc(phaseName(g[0])) + '</h3>' + g[1].map(row).join(''); }).join('') + '</div>';
  }
  // ① CDSS 답변: 이 조합의 이 답 (AI 채점 인용 = 노란 표시, AI 감사 근거 = 초록 점선)
  //    + ②·③이 인용한 문장이 같은 조합의 다른 답에 있으면 그 답도 바로 아래에 (표시한 채로)
  function answerStepHTML(item, out, cb) {
    var rq = item.rater.quotes, aq = evidenceQuotes(item);
    var ap = answerParts(out, item.combo, item.question);
    var co = citedOtherQs(out, item, rq, aq), others = co.qs;
    var oParts = others.map(function (q) { return answerParts(out, item.combo, q); });
    var hasR = hasMark(ap, rq) || oParts.some(function (p) { return hasMark(p, rq); });
    var hasA = hasMark(ap, aq) || oParts.some(function (p) { return hasMark(p, aq); });
    var where = t('gc.ans.where', { loc: comboName(item.combo), q: item.question, label: qLabel(item.question) });
    var citedK = t(co.r && co.a ? 'gc.ans.citedBoth' : co.r ? 'gc.ans.citedR' : 'gc.ans.citedA');
    var cited = others.length ? '<div class="gc-cited"><h3 class="mini">' + esc(citedK) + '</h3>' +
      others.map(function (q, i) {
        return '<div class="gc-cited-row" data-q="' + esc(q) + '"><div class="gc-full-q"><b>' + esc(t('gc.q', { q: q })) + '</b> ' + esc(qLabel(q)) + '</div>' +
          answerBodyHTML(oParts[i], rq, aq) + '</div>';
      }).join('') + '</div>' : '';
    return stepHTML(1, 'gc-answer', stepHeadHTML(1, esc(t('gc.ans.title')), esc(where)) +
      // 채점표의 질문은 응답자에게 묻는 말이 아니라 인용임을 분명히 (질문은 아래 dock 의 ④ 하나뿐)
      (item.question_text ? '<p class="gc-qtext"><span class="gc-qtext-k">' + esc(t('gc.ans.qtextK')) + '</span>' +
        esc(t('gc.ans.quote', { q: '\u0000' })).split('\u0000').join('<span lang="ko">' + esc(item.question_text) + '</span>') + '</p>' : '') +
      (cb ? drugChipsHTML(cb) : '') +
      '<div class="gc-ans-body">' + answerBodyHTML(ap, rq, aq) + '</div>' +
      cited +
      ((hasR || hasA) ? '<p class="gc-hl-legend">' +
        (hasR ? '<span><mark class="gc-hl r">' + esc(t('gc.ans.legendR')) + '</mark> ' + t('gc.ans.legendRTextHtml', { nb: nbHTML(2) }) + '</span>' : '') +
        (hasA ? '<span><mark class="gc-hl a">' + esc(t('gc.ans.legendA')) + '</mark> ' + t('gc.ans.legendATextHtml', { nb: nbHTML(3) }) + '</span>' : '') + '</p>' : '') +
      '<details class="gc-more" data-track="full_answer"><summary>' + esc(t(cb ? 'gc.ans.moreCombo' : 'gc.ans.moreP1')) + '</summary>' +
        fullAnswerHTML(item, out, cb, rq, aq) + '</details>');
  }
  // ② AI 채점: 판정 + 감점 유형 + 사유(본문) + 인용
  function raterStepHTML(item, out) {
    var r = item.rater;
    var why = t(r.verdict === 'deducted' ? 'gc.rater.whyDeducted' : r.verdict === 'met' ? 'gc.rater.whyMet' : 'gc.rater.whyOther');
    var quotes = r.quotes.length ? '<ul class="gc-quotes">' + r.quotes.map(function (q) {
      var loc = findQuote(out, item, q);
      return '<li><q lang="ko">' + esc(q) + '</q><span class="qloc' + (loc ? '' : ' miss') + '">' + locNote(loc) + '</span></li>';
    }).join('') + '</ul>' : '<p class="small muted">' + esc(t('gc.rater.noQuotes')) + '</p>';
    return stepHTML(2, 'gc-rater', stepHeadHTML(2, esc(t('gc.rater.title', { why: why })), '', vdHTML(r.verdict)) +
      (r.verdict === 'deducted' && r.type ? catHTML('gc.rater.type', r.type) : '') +
      '<h3 class="mini">' + esc(t('gc.rater.reason')) + '</h3><p class="gc-why" lang="ko">' + esc(screenTerms(r.reason) || '—') + '</p>' +
      '<h3 class="mini">' + esc(t('gc.rater.quotes')) + '</h3>' + quotes);
  }
  // ③ AI 감사 의견: 표시의 뜻(쉬운 말) + 의견 + 오류 유형 + 근거
  function auditStepHTML(item, out) {
    var a = item.audit, major = a.mark === 'major';
    var meaning = (major && !changedByAudit(item)) ? t('gc.instrument.mark.majorKept') : markMeaning(a.mark);
    var ev = a.evidence.length ? '<h3 class="mini">' + esc(t('gc.audit.evidence')) + '</h3><ul class="gc-evidence">' + a.evidence.map(function (e) {
      var p = parseEvidence(e);
      if (!p.quote) return '<li lang="ko">' + esc(screenTerms(e)) + '</li>';
      var loc = out ? findQuoteAnyCombo(out, item, p.quote) : null;
      var other = !!loc && loc.combo !== item.combo;
      var note = !loc ? '' : other ? esc(t('gc.loc.otherCombo', { c: loc.combo, q: loc.q, cur: item.combo })) : locNote(loc.q);
      var lblEn = p.label ? trEvidenceLabel(p.label) : null;
      var lbl = !p.label ? '' : lblEn !== null ? '<span class="ev-src">' + esc(lblEn) + '</span>'
        : '<span class="ev-src" lang="ko">' + esc(screenTerms(p.label)) + '</span>';
      return '<li>' + lbl + '<q lang="ko">' + esc(p.quote) + '</q>' +
        (note ? '<span class="qloc' + (other ? ' other' : '') + '">' + note + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    return stepHTML(3, 'gc-audit ' + (major ? 'major' : 'minor'), stepHeadHTML(3, esc(t('gc.audit.title')), '', mkHTML(a.mark)) +
      '<p class="gc-mark-mean">' + esc(meaning) + '</p>' +
      '<p class="gc-why" lang="ko">' + esc(screenTerms(a.explanation) || '—') + '</p>' +
      (a.category ? catHTML('gc.audit.category', a.category) : '') + ev);
  }
  // ④ 그래서 최종 판정: AI 채점 판정 → 감사 반영 후 최종 판정 (전문의가 동의 여부를 고르는 대상)
  function finalStepHTML(item) {
    var changed = changedByAudit(item), v = verdictById(item.final);
    var badge = changed ? '<span class="gc-chg yes">' + esc(t('gc.s4.changed')) + '</span>' : '<span class="gc-chg no">' + esc(t('gc.s4.unchanged')) + '</span>';
    return stepHTML(4, 'gc-final' + (changed ? ' changed' : ''), stepHeadHTML(4, esc(t('gc.s4.title')), '', badge) +
      '<div class="gc-ba" role="group" aria-label="' + esc(t('gc.s4.baAria')) + '">' +
        '<div class="gc-ba-from"><small>' + esc(t('gc.s4.from')) + '</small>' + vdHTML(item.rater.verdict, changed ? 'struck' : '') + '</div>' +
        '<span class="gc-ba-arrow" aria-hidden="true">→</span>' +
        '<div class="gc-ba-to"><small>' + esc(t('gc.s4.to')) + '</small>' + vdHTML(item.final, 'big') + '</div>' +
      '</div>' +
      (v && v.hint ? '<p class="gc-final-def">' + esc(t('gc.instrument.verdictDef', { label: tr(v, 'label'), hint: tr(v, 'hint') })) + '</p>' : ''));
  }
  function basisHTML(item) {
    if (!item.basis) return '';
    var notes = [];
    var main = String(item.basis).replace(/〔([^〕]*)〕/g, function (_, x) { notes.push(x); return ''; }).trim();
    var lines = main.split(/\s+\/\s+/).filter(function (x) { return x.trim(); });
    return '<details class="card gc-basis" data-track="basis"><summary>' + esc(t('gc.basis.title')) + ' <span class="gc-ref">' + esc(t('gc.basis.ref')) + '</span></summary><div class="gc-basis-body">' +
      '<p class="small muted">' + esc(t('gc.basis.lead')) + '</p>' +
      lines.map(function (l) { return '<p lang="ko">' + esc(l) + '</p>'; }).join('') +
      notes.map(function (n) { return '<p class="gc-note" lang="ko"><span lang="' + uiLang() + '">' + esc(t('gc.basis.note')) + '</span>' + esc(n) + '</p>'; }).join('') +
    '</div></details>';
  }
  function patientLine(p) {
    var a1c = null;
    (p.labs || []).forEach(function (l) { if (!a1c && /HbA1c/i.test(l.name)) a1c = l; });
    return demoHTML(p.demographics) + ' · <span lang="ko">' + esc(p.visit_type) + '</span>' +
      (a1c ? ' · ' + t('gc.pt.hba1cHtml', { v: '<span lang="ko">' + esc(a1c.values[a1c.values.length - 1]) + '</span>' }) : '');
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
  // 선택형 문항 (검증자 정보·마무리 문항 공통). 버튼 값(data-value)은 한국어 원문(저장 값), 보이는 글자만 화면 언어
  function fieldHTML(f, cur, prefix) {
    var id = esc((prefix || '') + f.id);
    var lab = '<span class="label" id="lbl_' + id + '">' + esc(tr(f, 'label')) + (f.required ? '<span class="req">*</span>' : '') + '</span>';
    if (f.type === 'choice') {
      var opts = f.options.map(function (o, i) { return { value: o, label: optLabel(f, i) }; });
      var list = f.layout === 'list';
      return '<div class="field">' + lab + '<div class="seg' + (list ? ' list' : ' gc-seg') + '" role="radiogroup" aria-labelledby="lbl_' + id + '" data-field="' + esc(f.id) + '"' +
        (list ? '' : ' style="--n:' + opts.length + '"') + '>' + segHTML(opts, cur) + '</div></div>';
    }
    return '<div class="field">' + lab.replace('<span class="label"', '<label class="label" for="fld_' + id + '"').replace(/<\/span>$/, '</label>') +
      '<input class="input" type="text" maxlength="60" id="fld_' + id + '" data-field-text="' + esc(f.id) + '" value="' + esc(cur || '') + '"></div>';
  }

  function eligibilityHTML() {
    return '<section class="card" id="eligCard">' +
      '<h2 class="section-title">' + esc(t('gc.elig.title')) + '</h2>' +
      '<p class="gc-q" id="eligQ">' + esc(tr(ELIG, 'label')) + '<span class="req">*</span></p>' +
      '<div class="gc-choice gc-elig" role="group" aria-labelledby="eligQ">' +
        '<button type="button" class="ch" data-elig="yes" aria-pressed="' + (draft.eligible === 'yes') + '">' + esc(tr(ELIG, 'yes')) + '</button>' +
        '<button type="button" class="ch" data-elig="no" aria-pressed="false">' + esc(tr(ELIG, 'no')) + '</button>' +
      '</div>' +
      '<p class="small muted" style="margin-top:8px">' + esc(t('gc.elig.self')) + '</p>' +
    '</section>';
  }
  function partPickerHTML() {
    var sh = partShape(PARTS[0]);
    return '<div class="field gc-parts-field"><span class="label" id="partLabel">' + esc(t('gc.part.label')) + '<span class="req">*</span></span>' +
      '<p class="small muted">' + esc(t('gc.part.help', { p: sh.p, u: sh.u })) + '</p>' +
      '<div class="part-grid" role="group" aria-labelledby="partLabel">' +
      PARTS.map(function (p) {
        var done = draft.done_parts.indexOf(p.id) >= 0, n = partItemCount(p);
        return '<button type="button" class="part-card" data-part="' + esc(p.id) + '" aria-pressed="' + (!done && draft.part === p.id) + '"' + (done ? ' disabled' : '') + '>' +
          '<span class="pc-top"><b>' + esc(partLabel(p)) + '</b>' + (done ? '<span class="pc-done">' + esc(t('gc.part.done')) + '</span>' : '<span class="radio-dot" aria-hidden="true"></span>') + '</span>' +
          '<span class="pc-n">' + t('gc.part.nHtml', { n: n }) + '</span>' +
          '<span class="pc-sub">' + esc(t('gc.part.sub', { min: minutesRange(n, p), u: partShape(p).u })) + '</span>' +
        '</button>';
      }).join('') + '</div></div>';
  }
  function consentHTML() {
    if (draft.consent_inherited) {
      return '<p class="notice" style="margin-top:18px">' + esc(t('gc.consent.inherited')) + '</p>';
    }
    return '<div class="field" style="margin-top:18px"><label class="check"><input type="checkbox" id="evConsent"' + (draft.consent ? ' checked' : '') + '>' +
      '<span>' + esc(t('gc.consent.text')) +
      (CFG.IRB_NO ? esc(t('gc.consent.irb', { no: CFG.IRB_NO })) : '') + '</span></label></div>';
  }
  function startBtnHTML() {
    return '<button type="button" class="btn btn-accent btn-block" id="startBtn" data-act="start" style="margin-top:18px">' +
      esc(t(starting ? 'gc.starting' : 'gc.start')) + '</button>';
  }
  function evaluatorCardHTML() {
    return '<section class="card" id="evaluatorCard">' +
      '<h2 class="section-title">' + esc(t('gc.ev.title')) + '</h2>' +
      '<div class="field"><label for="evName">' + esc(t('gc.ev.name')) + '<span class="req">*</span></label>' +
        '<input class="input" id="evName" type="text" autocomplete="name" maxlength="40" placeholder="' + esc(t('gc.ev.namePh')) + '" value="' + esc(draft.name) + '"></div>' +
      '<div id="profileFields">' + PROFILE.map(function (f) { return fieldHTML(f, draft.fields[f.id] || '', 'pf_'); }).join('') + '</div>' +
      partPickerHTML() + consentHTML() + startBtnHTML() +
    '</section>';
  }
  function continuationCardHTML() {
    // 앞 세션에 답이 있는 문항은 요약만, 없는 문항(앞 세션 이후 추가된 문항)만 여기서 묻는다
    var have = PROFILE.filter(function (f) { return !draft.missing || draft.missing.indexOf(f.id) < 0; });
    var ask = PROFILE.filter(function (f) { return draft.missing && draft.missing.indexOf(f.id) >= 0; });
    var rows = have.map(function (f) {
      return '<li><span class="muted">' + esc(tr(f, 'short') || tr(f, 'label')) + '</span> — <b>' + esc(valueLabel(f, draft.fields[f.id]) || '—') + '</b></li>';
    }).join('');
    return '<section class="card" id="evaluatorCard">' +
      '<h2 class="section-title">' + esc(t('gc.ev.title')) + '</h2>' +
      '<p>' + t('gc.ev.teacherHtml', { name: '<span data-ugc>' + esc(draft.name) + '</span>' }) + '</p>' +
      '<ul class="clean small gc-prof">' + rows + '</ul>' +
      '<p class="small muted" style="margin-top:6px">' + esc(t('gc.ev.reuse')) + '</p>' +
      (ask.length ? '<div id="profileFields" class="gc-prof-ask">' + ask.map(function (f) { return fieldHTML(f, draft.fields[f.id] || '', 'pf_'); }).join('') + '</div>' : '') +
      partPickerHTML() + consentHTML() + startBtnHTML() +
    '</section>';
  }

  // 영어 문장 안에 넣는 설명은 소문자로 시작 ('Met (does not meet …)')
  function lcFirst(x) { x = String(x || ''); return uiLang() === 'en' ? x.charAt(0).toLowerCase() + x.slice(1) : x; }
  function renderIntro() {
    var linked = !!draft.linked;
    var lp = partById(draft.part);
    var vm = verdictById('met'), vd = verdictById('deducted');
    var names = missingNames();
    elMain.innerHTML =
      siteLinksHTML() +   // 시작 화면에만 (판정 중에는 없음). 이어서 하기 정보는 gc:draft:v1 에 남아 있다
      '<section class="card hero">' +
        '<span class="eyebrow">' + esc(t('gc.intro.eyebrow')) + '</span>' +
        '<h1>' + esc(t('gc.intro.title')) + '</h1>' +
        '<p class="sub">' + esc(t('gc.intro.sub')) + '</p>' +
        '<p class="desc">' + esc(t('gc.intro.desc')) + '</p>' +
      '</section>' +
      (linked ? '<p class="notice info">' + (lp ? t('gc.intro.linkedPartHtml', { part: esc(partLabel(lp)) }) : esc(t('gc.intro.linkedAny'))) +
        esc(t('gc.intro.linkedReuse')) +
        (names.length ? t('gc.intro.linkedMissingHtml', { names: esc(names.join(', ')) }) : '') + '</p>' : '') +
      '<section class="card">' +
        '<h2 class="section-title">' + esc(t('gc.intro.howTitle')) + '</h2>' +
        // 번호 배지는 판정 화면의 ①–④ 에만 쓴다 (진행 과정은 번호 없는 목록)
        '<ul class="clean gc-proc">' +
          '<li>' + t('gc.intro.proc1Html', {
            met: esc(vm ? tr(vm, 'label') : 'met'), metHint: esc(lcFirst(vm ? tr(vm, 'hint') : '')), ded: esc(vd ? tr(vd, 'label') : 'deducted')
          }) + '</li>' +
          '<li>' + t('gc.intro.proc2Html') + '</li>' +
        '</ul>' +
        '<p class="gc-howto-k gc-todo">' + t('gc.intro.todoHtml', { nb: nbHTML(4) }) + '</p>' +
        readOrderHTML() +
        '<div class="gc-legend">' +
          '<div>' + mkHTML('minor') + '<span>' + esc(markMeaning('minor')) + '</span></div>' +
          '<div>' + mkHTML('major') + '<span>' + esc(markMeaning('major') + t('gc.instrument.mark.majorChanges')) + '</span></div>' +
        '</div>' +
        '<ul class="clean small muted" style="margin-top:14px">' +
          '<li>' + esc(t('gc.intro.note1')) + '</li>' +
          '<li>' + esc(t('gc.intro.note2')) + '</li>' +
          '<li>' + t('gc.intro.note3Html') + '</li>' +
          '<li>' + esc(t('gc.intro.note4')) + '</li>' +
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
        '<span class="eyebrow">' + esc(t('gc.blocked.eyebrow')) + '</span>' +
        '<h1>' + esc(t('gc.blocked.title')) + '</h1>' +
        '<p class="lead" style="margin-top:8px">' + esc(tr(ELIG, 'blocked')) + '</p>' +
        '<p class="small muted" style="margin-top:10px">' + esc(t('gc.blocked.ca')) + '</p>' +
        '<div class="btn-row" style="margin-top:16px">' +
          '<a class="btn btn-primary" href="../ca/' + SITE_QS + '" id="toCaLink">' + esc(t('gc.blocked.toCa')) + '</a>' +
          '<button type="button" class="btn btn-ghost" data-act="elig-back">' + esc(t('gc.blocked.back')) + '</button>' +
        '</div>' +
        '<nav class="site-links" aria-label="' + esc(t('gc.nav.aria')) + '" style="margin-top:10px"><a href="../' + SITE_QS + '" id="toHomeLink">' +
          BACK_SVG + esc(t('gc.nav.homeBack')) + '</a></nav>' +
      '</section>';
    elDock.innerHTML = '';
  }

  function renderStarting() {
    elMain.innerHTML = '<section class="card"><p class="status-line pending"><span class="dot"></span>' + esc(t('gc.startingMsg')) + '</p></section>';
    elDock.innerHTML = '';
  }

  function seenNote(patient, u) {
    for (var i = 0; i < u; i++) if (G.units[S.order[i]].patient === patient) {
      return '<p class="notice info">' + t('gc.seen.unitHtml', { n: i + 1 }) + '</p>';
    }
    if ((S.prev_patients || []).indexOf(patient) >= 0) {
      return '<p class="notice info">' + t('gc.seen.prevHtml') + '</p>';
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
      '<div class="case-head"><span class="pill navy">' + esc(t('gc.unit.pill', { n: st.u + 1, total: nUnits() })) + '</span>' +
        '<span class="pill">' + esc(t('gc.unit.range', { a: nBefore + 1, b: nBefore + items.length, total: totalItems() })) + '</span></div>' +
      '<h1 class="gc-h1">' + esc(t('gc.unit.h1', { n: st.u + 1, k: items.length })) + '</h1>' +
      '<p class="lead">' + t('gc.unit.leadHtml', { p: esc(out.patient), k: items.length }) + '</p>' +
      seenNote(out.patient, st.u) +
      '<section class="card tight gc-howto"><p class="gc-howto-k">' + t('gc.unit.howtoHtml', { nb: nbHTML(4) }) + '</p>' + readOrderHTML() + '</section>' +
      srcNoteHTML() +
      '<section class="card gc-pt">' +
        '<div class="pt-head"><span class="pt-id">' + esc(p.id) + '</span><span class="gc-pt-line">' + patientLine(p) + '</span></div>' +
        '<p class="small" style="margin-top:6px"><span class="muted">' + esc(t('ca.pt.visitReason')) + '</span> <span lang="ko">' + esc(p.visit_reason) + '</span></p>' +
        '<button type="button" class="btn btn-ghost gc-pt-btn" data-act="patient">' + esc(t('gc.unit.ptAll')) + '</button>' +
      '</section>' +
      (byCombo[0] ? '<section class="card tight gc-p1"><b>' + esc(phaseName(1)) + '</b><span class="gc-cnt">' + esc(nVerdicts(byCombo[0])) + '</span></section>' : '') +
      '<h2 class="section-title" style="margin-top:20px">' + esc(t('gc.unit.combos', { n: out.combinations.length })) + '</h2>' +
      '<p class="small muted" style="margin-top:-4px">' + esc(t('gc.unit.combosHelp')) + '</p>' +
      '<div class="gc-combos">' + out.combinations.map(function (cb, i) {
        var n = byCombo[i + 1] || 0;
        return '<article class="gc-combo' + (n ? '' : ' none') + '">' +
          '<header class="cc-head"><span class="cc-no">' + esc(comboName(i + 1)) + '</span>' +
            '<span class="gc-cnt' + (n ? '' : ' zero') + '">' + esc(n ? nVerdicts(n) : t('gc.unit.none')) + '</span></header>' +
          drugChipsHTML(cb) + '</article>';
      }).join('') + '</div>';
  }

  function renderItemMain() {
    var st = curStep(), item = curItem(), key = S.order[st.u];
    var out = DATA.outputs[key];
    var cb = item.combo ? out.combinations[item.combo - 1] : null;
    // 위에서 아래로: 채점 항목(맥락) → ① CDSS 답변 → ② AI 채점 사유 → ③ AI 감사 의견 → ④ 최종 판정 → (참고) 채점표 적용 근거
    elMain.innerHTML =
      '<div class="case-head">' +
        '<span class="pill">' + esc(t('gc.item.pillUnit', { u: st.u + 1, p: item.patient })) + '</span>' +
        '<span class="pill teal">' + esc(t('gc.item.pillWhere', { loc: comboName(item.combo), q: item.question })) + '</span>' +
      '</div>' +
      elementCardHTML(item) +
      '<ol class="gc-steps" aria-label="' + esc(t('gc.item.stepsAria')) + '">' +
        answerStepHTML(item, out, cb) + raterStepHTML(item, out) + auditStepHTML(item, out) + finalStepHTML(item) +
      '</ol>' +
      basisHTML(item);
    // 감점 기준이 접힌 줄 수 안에 다 들어가면 '전체 보기' 버튼은 숨김
    var crit = $('gcCrit'), btn = elMain.querySelector('[data-act="crit"]');
    if (crit && btn && !ui.critOpen && crit.scrollHeight <= crit.clientHeight + 2) btn.hidden = true;
  }
  function scrollToFinal() {
    var t = $('gcStep4');
    if (!t) return;
    t.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  function renderDock() {
    if (!S || S.screen !== 'eval' || staleTab || !S.order) { elDock.innerHTML = ''; return; }
    var st = curStep();
    var back = (S.stepIdx > 0 && !S.review) ? '<button type="button" class="btn btn-ghost" data-act="back">' + esc(t('gc.dock.back')) + '</button>' : '';
    var nav = function (label, enabled) {
      return '<div class="dock-nav' + (back ? '' : ' single') + '">' + back +
        '<button type="button" class="btn btn-primary" data-act="next"' + (enabled ? '' : ' aria-disabled="true"') + '>' + esc(label) + '</button></div>';
    };
    var html = '<div class="dock-inner">';
    if (st.i < 0) {
      var n = unitItems(S.order[st.u]).length;
      html += '<div class="dock-kicker"><span>' + esc(t('gc.unit.pill', { n: st.u + 1, total: nUnits() })) + '</span></div>' +
        '<p class="dock-msg">' + t('gc.dock.unitMsgHtml', { k: n }) + '</p>' +
        nav(t('gc.dock.start'), true);
    } else {
      var item = curItem(), j = jm(item), ord = itemOrder(st.u, st.i), tot = totalItems();
      var hint = j.agree === null ? t('gc.dock.hintAgree') : (j.agree === false && !j.alt_verdict ? t('gc.dock.hintAlt') : '');
      html += '<div class="dock-kicker"><span>' + esc(t('gc.dock.kicker', { n: ord, total: tot })) + '</span><span class="req-hint">' + esc(hint) + '</span></div>' +
        '<p class="dock-statement gc-ask" id="gcAsk">' + t('gc.instrument.askHtml', {
          step: '<button type="button" class="gc-ask-step" data-act="to-final" title="' + esc(t('gc.dock.toFinal')) + '">' + nbHTML(4) + esc(t('gc.instrument.askStep')) + '</button>',
          vd: vdHTML(item.final)
        }) + '</p>' +
        '<div class="gc-choice" role="group" aria-labelledby="gcAsk">' +
          '<button type="button" class="ch agree" data-agree="1" aria-pressed="' + (j.agree === true) + '">' + esc(t('gc.instrument.agree')) + '</button>' +
          '<button type="button" class="ch disagree" data-agree="0" aria-pressed="' + (j.agree === false) + '">' + esc(t('gc.instrument.disagree')) + '</button>' +
        '</div>';
      if (j.agree === false) {
        var alts = VERDICTS.filter(function (v) { return v.id !== item.final; });
        html += '<div class="gc-alt">' +
          '<p class="gc-alt-k" id="gcAltK">' + esc(t('gc.instrument.alt')) + '<span class="req">*</span></p>' +
          '<div class="gc-choice alt" role="group" aria-labelledby="gcAltK">' + alts.map(function (v) {
            var hint2 = tr(v, 'hint');
            return '<button type="button" class="ch alt v-' + esc(v.id) + '" data-alt="' + esc(v.id) + '" aria-pressed="' + (j.alt_verdict === v.id) + '">' +
              '<b>' + esc(tr(v, 'label')) + '</b>' + (hint2 ? '<small>' + esc(hint2) + '</small>' : '') + '</button>';
          }).join('') + '</div>' +
          '<label class="gc-alt-k" for="gcComment">' + esc(t('gc.dock.comment')) + ' <span class="muted">' + esc(t('gc.dock.optional')) + '</span></label>' +
          '<textarea class="input gc-comment" id="gcComment" rows="2" maxlength="2000" placeholder="' +
            esc(t(shortDock() ? 'gc.dock.phShort' : 'gc.dock.phLong')) + '">' +
            esc(j.comment || '') + '</textarea>' +
        '</div>';
      }
      html += nav(S.review ? t('gc.dock.saveBack') : t(ord === tot ? 'gc.dock.nextFinal' : 'gc.dock.next'), jComplete(j));
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
    else if (act === 'to-final') scrollToFinal();
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
        rows.push('<li class="gc-recap-unit">' + esc(t('gc.recap.unit', { n: st.u + 1, p: G.units[S.order[st.u]].patient })) + '</li>');
        return;
      }
      var it = unitItems(S.order[st.u])[st.i], j = S.judgments[it.id];
      var res = !jComplete(j) ? '<span class="muted">' + esc(t('gc.recap.pending')) + '</span>'
        : j.agree ? '<span class="gc-res agree">' + esc(t('gc.instrument.agree')) + '</span>' + vdHTML(it.final)
          : '<span class="gc-res disagree">' + esc(t('gc.instrument.disagree')) + '</span>' + vdHTML(j.alt_verdict);
      rows.push('<li class="gc-recap-row"><span class="gc-r-no">' + itemOrder(st.u, st.i) + '</span>' +
        '<span class="gc-r-t"><b>' + esc(it.element) + '</b> ' + esc(comboName(it.combo)) + ' · <span lang="ko">' + esc(it.title) + '</span></span>' +
        '<span class="gc-r-res">' + res + '</span>' +
        '<button type="button" class="link-btn" data-edit="' + idx + '" aria-label="' + esc(t('gc.recap.editAria', { n: itemOrder(st.u, st.i) })) + '">' + esc(t('gc.recap.edit')) + '</button></li>');
    });
    return '<ul class="gc-recap">' + rows.join('') + '</ul>';
  }

  function renderFinal() {
    var c = counts();
    elMain.innerHTML =
      '<section class="card"><span class="eyebrow">' + esc(t('gc.fin.eyebrow')) + '</span>' +
        '<h1 class="gc-h1" style="margin-top:6px">' + esc(t('gc.fin.title', { n: c.total })) + '</h1>' +
        '<p class="lead" style="margin-top:6px">' + t('gc.fin.leadHtml') + '</p>' +
        '<div class="stat-row" style="margin-top:14px">' +
          '<div class="stat"><b>' + c.agree + '</b><span>' + esc(t('gc.instrument.agree')) + '</span></div>' +
          '<div class="stat"><b>' + c.disagree + '</b><span>' + esc(t('gc.instrument.disagree')) + '</span></div>' +
        '</div></section>' +
      (END_ITEMS.length ? '<section class="card sub-items"><span class="sub-tag">' + esc(t('gc.fin.endTag')) + '</span><div id="endItems" style="margin-top:6px">' +
        END_ITEMS.map(function (f) { return fieldHTML(f, (S.end_items[f.id] || {}).value || '', 'ei_'); }).join('') + '</div></section>' : '') +
      '<section class="card"><div class="field"><label for="overallComment">' + esc(t('gc.fin.comment')) + '</label>' +
        '<p class="small muted">' + esc(t('gc.fin.commentHelp')) + '</p>' +
        '<textarea class="input" id="overallComment" maxlength="5000">' + esc(S.overall_comment) + '</textarea>' +
        '<div class="char-count" id="ocCount">' + S.overall_comment.length + ' / 5000</div></div>' +
        '<button type="button" class="btn btn-accent btn-block" id="submitBtn" data-act="submit" style="margin-top:14px">' + esc(t('gc.fin.submit')) + '</button></section>' +
      '<section class="card"><h2 class="section-title">' + esc(t('gc.fin.recap')) + '</h2>' +
        '<p class="small muted">' + esc(t('gc.fin.recapHelp')) + '</p>' + srcNoteHTML() + recapHTML() + '</section>';
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
      ui_lang: uiLang(), set_id: S.set_id || 'v1',
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
      status = '<p class="status-line pending"><span class="dot"></span>' + esc(t('gc.done.testMode')) + '</p>' +
        '<p class="small muted" style="margin-top:6px">' + esc(t('gc.done.testModeDl')) + '</p>';
    } else if (!S.outbox.length && S.net.status !== 'sending') {
      status = '<p class="status-line ok"><span class="dot"></span>' + esc(t('gc.done.ok')) + '</p>';
    } else if (S.net.status === 'fail' || !flushing) {
      status = '<p class="status-line fail"><span class="dot"></span>' + esc(t('gc.done.fail', { n: S.outbox.length })) + '</p>' +
        '<p class="small muted" style="margin-top:6px">' + esc(t('gc.done.failHelp')) +
        (S.net.last_error ? ' (' + esc(S.net.last_error) + ')' : '') + '</p>';
    } else {
      status = '<p class="status-line pending"><span class="dot"></span>' + esc(t('gc.done.sending')) + '</p>';
    }
    var showRetry = !!(CFG.ENDPOINT && S.outbox.length && (S.net.status === 'fail' || !flushing));
    var showDl = !CFG.ENDPOINT || showRetry || S.is_test;
    var done = (S.done_parts || []).concat([S.part]);
    var others = PARTS.filter(function (p) { return done.indexOf(p.id) < 0; });
    var part = partById(S.part);
    elMain.innerHTML =
      '<section class="card hero"><span class="eyebrow">' + esc(t('gc.done.eyebrow')) + '</span><h1>' + esc(t('gc.done.title')) + '</h1>' +
        '<p class="desc">' + t('gc.done.descHtml', { name: '<span data-ugc>' + esc(S.evaluator.name) + '</span>', part: esc(partLabel(part) || S.part || ''), n: c.done }) + '</p></section>' +
      '<section class="card">' + status +
        '<div class="stat-row" style="margin-top:14px">' +
          '<div class="stat"><b>' + c.done + ' / ' + c.total + '</b><span>' + esc(t('gc.done.statItems')) + '</span></div>' +
          '<div class="stat"><b>' + c.agree + ' · ' + c.disagree + '</b><span>' + esc(t('gc.done.statAD')) + '</span></div>' +
          '<div class="stat"><b>' + esc(fmtMin(sum.total_active_ms + sum.total_idle_ms)) + '</b><span>' + esc(t('gc.done.statTime')) + '</span></div>' +
        '</div>' +
        ((showRetry || showDl) ? '<div class="btn-row" style="margin-top:16px">' +
          (showRetry ? '<button type="button" class="btn btn-primary" id="retryBtn" data-act="retry">' + esc(t('gc.done.retry')) + '</button>' : '') +
          (showDl ? '<button type="button" class="btn btn-ghost" id="dlBtn" data-act="download">' + esc(t('gc.done.download')) + '</button>' : '') +
        '</div>' : '') +
      '</section>' +
      (others.length ? '<section class="card gc-next"><h2 class="section-title">' + esc(t('gc.done.nextTitle')) + '</h2>' +
        '<p class="small muted">' + t('gc.done.nextHelpHtml') + '</p>' +
        '<div class="btn-row" style="margin-top:10px">' + others.map(function (p) {
          var n = partItemCount(p);
          return '<button type="button" class="btn btn-accent" data-next-part="' + esc(p.id) + '">' + esc(t('gc.done.nextBtn', { part: partLabel(p) })) +
            ' <span class="gc-btn-sub">' + esc(t('gc.done.nextSub', { n: n, min: minutesRange(n, p) })) + '</span></button>';
        }).join('') + '</div></section>' : '') +
      '<section class="card"><p class="small muted">' + esc(t('gc.done.newHelp')) + '</p>' +
        '<button type="button" class="btn btn-ghost" id="newBtn" data-act="new" style="margin-top:10px">' + esc(t('gc.done.newBtn')) + '</button></section>';
    elDock.innerHTML = '';
  }

  function restart(nextPart) {
    if (!S) return;
    var unsent = (S.outbox || []).slice();
    if (!nextPart) {
      if (unsent.length && CFG.ENDPOINT) {
        if (!window.confirm(t('gc.confirm.unsent'))) return;
      } else if (!window.confirm(t('gc.confirm.new'))) return;
    }
    var prev = S;
    try { localStorage.removeItem(STORE_KEY); } catch (_) {}
    // 보관된(이전) 세트로 진행하던 세션이 끝난 뒤 새 검증자는 활성 세트로: 새로 불러온다
    if (!nextPart && setOf(G, DATA) !== ACTIVE_SET) { S = null; location.reload(); return; }
    S = null;
    STEPS = [];
    flushing = false;
    lastRev = 0;
    draft = emptyDraft();
    if (nextPart) {
      draft.eligible = 'yes';
      draft.name = prev.evaluator.name;
      PROFILE.forEach(function (f) { draft.fields[f.id] = (prev.evaluator.fields || {})[f.id] || ''; });
      // 앞 세션에 없던 문항(예: 이후에 추가된 문항)은 이어서 하기 화면에서 묻는다
      draft.missing = unansweredProfile(draft.fields);
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
    var label = '', pct = 0, showPatient = false, html = '';
    if (staleTab) { label = ''; }
    else if (S && S.screen === 'eval' && S.order) {
      var st = curStep();
      // '답변 1/2 · 판정 3/18' — 아주 좁은 화면(영어)에서는 앞의 '답변 1/2 · ' 를 숨긴다 (styles.css .tp-unit)
      html = '<span class="tp-unit">' + esc(t('gc.top.unit', { u: st.u + 1, n: nUnits() })) + ' · </span>' +
        esc(st.i >= 0 ? t('gc.top.item', { k: itemOrder(st.u, st.i), total: totalItems() }) : t('gc.top.start'));
      pct = S.stepIdx / STEPS.length * 100;
      showPatient = true;
    } else if (S && S.screen === 'final') { label = t('gc.top.final'); pct = 100; }
    else if (S && S.screen === 'done') { label = t('gc.top.done'); pct = 100; }
    $('topbar').classList.toggle('in-case', !!(S && S.screen === 'eval'));
    if (html) elTopProg.innerHTML = html; else elTopProg.textContent = label;
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
      '<section class="card"><span class="eyebrow">' + esc(t('gc.stale.eyebrow')) + '</span>' +
        '<h1 class="gc-h1" style="margin-top:6px">' + esc(t('gc.stale.title')) + '</h1>' +
        '<p class="lead" style="margin-top:8px">' + esc(t('gc.stale.lead')) + '</p>' +
        '<button type="button" class="btn btn-primary" data-act="takeover" style="margin-top:14px">' + esc(t('gc.stale.btn')) + '</button></section>';
    elDock.innerHTML = '';
  }

  function render() {
    var testMode = (S ? S.is_test : (URL_TEST || !CFG.ENDPOINT));
    elTestBanner.hidden = !testMode;
    elTestBanner.textContent = t(!CFG.ENDPOINT ? 'gc.banner.noEndpoint' : 'gc.banner.test');

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
      b.textContent = t(ui.critOpen ? 'gc.elem.less' : 'gc.elem.more');
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
    document.title = t('gc.meta.title');
    var bs = document.querySelector('#topbar .brand-text strong'), bm = document.querySelector('#topbar .brand-text small');
    if (bs) bs.textContent = t('gc.brand.title');
    if (bm) bm.textContent = t('gc.brand.sub');
    var last = elPatientBtn.lastChild;   // 아이콘(svg) 다음의 글자
    if (last && last.nodeType === 3) last.nodeValue = ' ' + t('gc.patientBtn');
    else if (last && last.nodeType === 1 && last.tagName.toLowerCase() !== 'svg') last.textContent = t('gc.patientBtn');
    elDock.setAttribute('aria-label', t('gc.dock.aria'));
    $('drawerClose').setAttribute('aria-label', t('gc.close'));
    if (elDrawer.hidden) $('drawerTitle').textContent = t('gc.drawer.title');
  }
  // 언어를 바꾸면 지금 화면을 그 언어로 다시 그린다 (응답·시간 측정·스크롤·펼침 상태는 그대로)
  var booted = false, shownLang = null;
  function onLang() {
    if (!booted) return;
    if (uiLang() === shownLang) return;   // 이미 보이는 언어를 다시 누른 경우: 아무것도 바뀌지 않음
    shownLang = uiLang();
    tick();
    elToast.hidden = true;   // 이전 언어로 뜬 안내는 닫는다
    var y = window.scrollY;
    var open = [];
    Array.prototype.forEach.call(elMain.querySelectorAll('details'), function (d, i) { if (d.open) open.push(i); });
    var focusSel = null, ae = document.activeElement;
    if (ae && elDock.contains(ae)) {
      focusSel = ae.id ? '#' + ae.id : ae.hasAttribute('data-agree') ? '[data-agree="' + ae.getAttribute('data-agree') + '"]' :
        ae.hasAttribute('data-alt') ? '[data-alt="' + ae.getAttribute('data-alt') + '"]' : null;
    }
    render();
    var ds = elMain.querySelectorAll('details');
    // 펼침 상태를 되살린다 (toggle 기록은 이미 열어 본 것이므로 그대로)
    open.forEach(function (i) { var d = ds[i]; if (d && !d.open) d.open = true; });
    if (!elDrawer.hidden && S && S.screen === 'eval') fillDrawer();
    paintChrome();
    window.scrollTo(0, y);
    if (focusSel) { var f = elDock.querySelector(focusSel); if (f) try { f.focus({ preventScroll: true }); } catch (_) {} }
    if (S) {
      S.ui_lang_switches = (S.ui_lang_switches || 0) + 1;
      noteLang(S);
      if (S.screen === 'eval' && curItem()) noteLang(jm(curItem()));
      save();
    }
  }
  window.addEventListener('t2d:lang', onLang);

  // expose minimal hooks for QA (no PII beyond what the page shows)
  window.__GC_APP__ = { version: CFG.APP_VERSION, state: function () { return S; }, steps: function () { return STEPS; }, lang: uiLang };

  // ---------------------------------------------------------------------------
  // Boot
  //  1) 언어 런타임·사전이 없으면(이전 HTML 이 캐시된 경우 등) 먼저 불러온다.
  //  2) 저장된 진행 상태(없으면 이어서 하기 초안)의 케이스 세트(set_id, 없으면 v1)가 활성 세트와 다르면
  //     data/sets/<id>/gc_items.js · ../data/sets/<id>/cases.js · design.js 를 불러와 그 세트로 이어서 진행한다
  //     (보관본이 없으면 활성 세트 그대로). 보통은 둘 다 필요 없어 바로(동기) 시작한다.
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
    var dk = T2 && T2.i18n && T2.i18n.dict && T2.i18n.dict.ko;
    if (!dk || !dk['ca.pt.history']) need.push('../i18n/ca.js');
    if (!dk || !dk['gc.intro.title']) need.push('../i18n/gc.js');
    if (!need.length) { cb(); return; }
    loadSeq(need.map(function (u) { return u + '?v=' + encodeURIComponent(CFG.APP_VERSION); }), cb);
  }
  function savedSetId() {
    try {
      var s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && s.v === 1) return String(s.set_id || 'v1');
      var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
      if (d && d.linked) return String(d.set_id || 'v1');
    } catch (_) {}
    return null;
  }
  function ensureSet(cb) {
    var want = savedSetId();
    if (!want || want === setOf(G, DATA) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(want)) { cb(); return; }
    var active = { g: window.GC_DATA, data: window.T2D_DATA, design: window.T2D_DESIGN };
    var restore = function () { window.GC_DATA = active.g; window.T2D_DATA = active.data; window.T2D_DESIGN = active.design; cb(); };
    loadScript('data/sets/' + want + '/gc_items.js', function (ok) {
      var g = window.GC_DATA;
      if (!ok || !g || g === active.g || (g.set_id && g.set_id !== want)) { restore(); return; }
      loadScript('../data/sets/' + want + '/cases.js', function (ok2) {
        var d = window.T2D_DATA;
        if (!ok2 || !d || d === active.data || (d.set_id && d.set_id !== want)) { restore(); return; }
        if (!g.set_id) g.set_id = want;
        if (!d.set_id) d.set_id = want;
        window.T2D_DESIGN = undefined;
        loadScript('../data/sets/' + want + '/design.js', function (ok3) {
          var ds = window.T2D_DESIGN;
          if (!ok3 || !ds || (ds.set_id && ds.set_id !== want)) window.T2D_DESIGN = null;   // → gc-config.js 기본 Part (세트 v1)
          cb();
        });
      });
    });
  }
  // 이어서 하는 세션: 방문자가 언어를 직접 고른 적이 없으면(?lang= 없음, 't2d:lang' 없음) 세션을 시작한 언어로 보여 준다
  // (ui_lang_start 가 없는 이전 버전 세션 = 한국어). 직접 고른 것이 아니므로 't2d:lang' 에 저장하지 않는다. (app.js 와 같음)
  function explicitLang() {
    try { var q = new URLSearchParams(location.search).get('lang'); if (q === 'ko' || q === 'en') return true; } catch (_) {}
    try { var s = localStorage.getItem('t2d:lang'); return s === 'ko' || s === 'en'; } catch (_) { return false; }
  }
  function pinSessionLang(st) {
    if (!st || st.screen === 'starting' || !I18N.i18n || explicitLang()) return;
    var want = st.ui_lang_start === 'en' ? 'en' : 'ko';
    if (I18N.lang === want) return;
    I18N.lang = want;
    document.documentElement.setAttribute('lang', want);
    I18N.i18n.apply(document);
  }
  function boot() {
    I18N = window.T2D || {};
    G = window.GC_DATA;
    DATA = window.T2D_DATA;
    PARTS = resolveParts();
    URL_PART = urlPart();
    ENTRY.part_preselected = !!URL_PART;
    S = load();
    if (S) { lastRev = S.rev || 0; buildSteps(); }
    if (S && !S.ui_langs) S.ui_langs = [S.ui_lang_start || 'ko'];   // 언어 기록이 없는 이전 상태 = 한국어로 진행
    pinSessionLang(S);
    shownLang = uiLang();
    mountPrefs();
    paintChrome();
    if (S && S.screen === 'starting') {
      // 순서 배정 도중 창이 닫힌 경우: 처음부터
      try { localStorage.removeItem(STORE_KEY); } catch (_) {}
      S = null; STEPS = [];
    }
    draft = S ? emptyDraft() : (loadDraft() || emptyDraft());
    if (S && (S.screen === 'eval' || S.screen === 'final')) {
      S.metrics.resumes += 1;
      S.device.last_resume = deviceInfo();
      save();
      setTimeout(function () { toast(t('gc.toast.resumed'), 3200); }, 300);
    }
    render();
    if (S && S.screen === 'eval' && curItem()) { var jc = jm(curItem()); jc.visits += 1; noteLang(jc); save(); }
    if (S && S.screen !== 'done') { noteLang(S); save(); }
    if (S) flush();
    booted = true;
  }
  ensureI18n(function () { ensureSet(boot); });
})();
