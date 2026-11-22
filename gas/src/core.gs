/**
 * 임상 수용성 평가 (Physician Clinical Acceptability Assessment) — 응답 수집 백엔드
 * Google Apps Script Web App → Google Sheets
 *
 * 배포 방법 (README.md 참고):
 *   1) 응답을 저장할 Google 스프레드시트 생성 → 확장 프로그램 → Apps Script
 *   2) 이 파일 내용을 Code.gs 에 붙여넣고 저장
 *   3) 함수 setup 1회 실행 (권한 승인 + 시트/헤더 생성)
 *   4) 배포 → 새 배포 → 유형: 웹 앱 / 실행 사용자: 나 / 액세스 권한: 모든 사용자 → 배포
 *   5) 발급된 …/exec URL 을 사이트의 config.js → ENDPOINT 에 입력
 *
 * 시트 구성:
 *   Responses  — AI 답변(케이스) 1건당 1행. 점수·선택 조합·의견·단계별 시간 등 분석용 평면 컬럼
 *   PhaseLong  — (평가자 × 케이스 × Phase) 1행. 점수와 단계별 시간 (CVI·혼합모형 분석용 long format)
 *   Sessions   — 평가자 세션 1건당 1행. 성명·년차·제시 순서·총 소요 시간·기기 정보·전체 의견
 *   RawJSON    — 수신한 모든 요청 원문 (감사 추적용)
 *   Summary    — 메뉴 [요약 통계 갱신] 실행 시 생성 (모델 × Phase 평균, I-CVI, 선호 조합 분포, 소요 시간)
 *
 * 케이스 세트·화면 언어 (v6): 모든 응답에 SetId(케이스 세트, 빈칸 = v1)와 UiLang(화면 언어 ko/en, 빈칸 = ko) 컬럼.
 *   모델은 자료(Model 컬럼)에서 읽으므로 케이스·모델·세트를 바꿔도 이 스크립트를 다시 붙여넣을 필요가 없습니다.
 *   선택지 값은 화면 언어와 관계없이 항상 한국어 원문 + code 로 저장됩니다.
 *
 * 모든 쓰기는 (SessionId[, CaseKey]) 기준 upsert 이므로 같은 요청이 재전송되어도 중복 행이 생기지 않습니다.
 */

// ============================================================
// CONFIG
// ============================================================
var SPREADSHEET_ID = '1-R-BZKkhyaTSHvHssM5sazwjq-KKQqfjzIqAhFMbS10';            // 시트에서 [확장 프로그램 → Apps Script]로 만든 경우 비워 둠. script.google.com 에서 따로 만든 경우 시트 ID 입력
var BACKEND_VERSION = '2026-11-21.ca-backend-v6';
var EXPECTED_STUDY_ID = 'T2D-CA-2026';

var SHEET = {
  RESP: 'Responses',
  LONG: 'PhaseLong',
  SESS: 'Sessions',
  RAW: 'RawJSON',
  SUMMARY: 'Summary',
  VISITS: 'Visits'
};

var PHASE_KEYS = ['p1', 'p2', 'p3', 'p4', 'p5'];
var PHASE_LABEL = {
  p1: 'Phase 1 의뢰 여부 결정',
  p2: 'Phase 2 공유 의사결정',
  p3: 'Phase 3 약물 처방 결정',
  p4: 'Phase 4 추적관찰 계획',
  p5: 'Phase 5 환자 교육'
};
var STEPS = ['vignette', 'p1', 'combo', 'p2', 'p3', 'p4', 'p5', 'comment'];
var STEP_COL = {
  vignette: 'Vignette', p1: 'P1', combo: 'Combo', p2: 'P2', p3: 'P3', p4: 'P4', p5: 'P5', comment: 'Comment'
};

// ============================================================
// HEADERS
// ============================================================
function respHeaders_() {
  var h = [
    'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'SeqSource', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder',
    'CaseKey', 'PatientId', 'PatientSeenPrior', 'Model', 'ModelName',
    'P1_Referral', 'ComboChoice', 'ComboName', 'ComboKey', 'ComboIsAIFirst', 'ComboRankAI', 'RankCueVisible',
    'P2_SharedDecision', 'P3_Pharmacotherapy', 'P4_FollowUp', 'P5_Education',
    'CaseComment', 'CaseStartedAt', 'CaseCompletedAt',
    'CaseActiveSec', 'CaseIdleSec', 'CaseHiddenSec', 'CaseWallSec'
  ];
  STEPS.forEach(function (s) { h.push('Sec_' + STEP_COL[s]); });
  ['p1', 'combo', 'p2', 'p3', 'p4', 'p5'].forEach(function (s) { h.push('TTFR_' + STEP_COL[s]); });
  ['p1', 'combo', 'p2', 'p3', 'p4', 'p5'].forEach(function (s) { h.push('Changes_' + STEP_COL[s]); });
  STEPS.forEach(function (s) { h.push('Scroll_' + STEP_COL[s]); });
  STEPS.forEach(function (s) { h.push('Visits_' + STEP_COL[s]); });
  PHASE_KEYS.forEach(function (k) { h.push('ScrollAtFR_' + STEP_COL[k]); });
  ['vignette', 'p1', 'combo', 'p2', 'p3', 'p4', 'p5'].forEach(function (s) { h.push('Chars_' + STEP_COL[s]); });
  h = h.concat(['ComboSeen_1', 'ComboSeen_2', 'ComboSeen_3', 'ComboDwellSec_1', 'ComboDwellSec_2', 'ComboDwellSec_3',
    'RxDetailsOpens', 'Interruptions', 'ComboResets', 'PatientDrawerOpens', 'PatientDrawerSec',
    'AppVersion', 'DataVersion', 'BackendVersion', 'MetricsJson', 'UiLang', 'UiLangs', 'SetId']);
  return h;
}

function longHeaders_() {
  return ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder',
    'CaseKey', 'PatientId', 'PatientSeenPrior', 'Model', 'ModelName', 'ComboChoice', 'ComboKey', 'RankCueVisible',
    'Phase', 'PhaseLabel', 'TargetKey', 'Score', 'Acceptable_4plus', 'FirstScore', 'Changed',
    'VisibleSec', 'ActiveOnlySec', 'TTFRSec', 'Changes', 'ScrollPct', 'ScrollAtFirstRating', 'Chars', 'CharsPerSec',
    'Visits', 'HarmInPhase', 'UiLang', 'SetId'];
}

function sessHeaders_() {
  return [
    'FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'SeqSource', 'Order', 'Status', 'CasesCompleted', 'LinkedSessionId',
    'EvaluatorId', 'EvaluatorCode', 'DeviceId', 'VisitId', 'SessionOrdinal',
    'Src', 'Site', 'Wave', 'TypePreselected', 'InAppBrowser', 'ReferrerOrigin',
    'ConsentVersion', 'ConsentAt', 'ConsentInherited', 'InstrumentVersion', 'Incentive',
    'StartedAt', 'FinishedAt', 'TotalActiveMin', 'TotalIdleMin', 'TotalHiddenMin', 'TotalWallMin',
    'IntroSec', 'FinalSec', 'Resumes', 'Interruptions', 'SendFailures',
    'FurthestCase', 'FurthestStep', 'LastActivityAt', 'PartialRatingsN', 'OverallComment',
    'FormFactor', 'ViewportW', 'ViewportH', 'ScreenW', 'ScreenH', 'DPR', 'TouchPoints', 'CoarsePointer',
    'Language', 'TimeZone', 'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion',
    'UiLang', 'UiLangStart', 'UiLangs', 'UiLangSwitches', 'SetId'
  ];
}

function visitsHeaders_() {
  return ['ReceivedAt', 'VisitId', 'DeviceId', 'Src', 'Site', 'Wave', 'TypeParam', 'FormFactor', 'InAppBrowser',
    'ReferrerOrigin', 'IsTest', 'AppVersion', 'UiLang', 'SetId'];
}

function rawHeaders_() {
  return ['ReceivedAt', 'Action', 'SessionId', 'MsgId', 'IsTest', 'Payload', 'ElapsedMs', 'Error'];
}

// ============================================================
// HTTP ENTRY POINTS
// ============================================================
function doGet(e) {
  return json_({ ok: true, service: 'clinical-acceptability', backend: BACKEND_VERSION, time: new Date().toISOString() });
}

function doPost(e) {
  var body0 = (e && e.postData && e.postData.contents) || '';
  // 첫 화면 방문 기록(view): 응답 저장보다 우선순위가 낮으므로 잠깐만 기다리고, 바쁘면 건너뜀
  if (body0.indexOf('"action":"view"') !== -1) return handleView_(body0);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(12000);   // 클라이언트 대기 한도(15초/30초)보다 짧게 → 혼잡 시 빨리 'busy' 응답 후 재전송
  } catch (errLock) {
    return json_({ ok: false, error: 'busy' });
  }
  var t0 = Date.now();
  var p = null, ss = null;
  try {
    var body = (e && e.postData && e.postData.contents) || '';
    if (body.length > 900000) return json_({ ok: false, error: 'payload too large' });
    p = JSON.parse(body);
    if (!p || VALID_ACTIONS.indexOf(p.action) < 0) return json_({ ok: false, error: 'bad request' });
    if (!UUID_RE.test(String(p.session_id || ''))) return json_({ ok: false, error: 'bad session id' });
    if (EXPECTED_STUDY_ID && p.study_id !== EXPECTED_STUDY_ID) return json_({ ok: false, error: 'unknown study' });

    ss = ss_();
    var db = {};   // 요청 단위 시트 캐시: 시트마다 1번만 읽고, 끝에서 한 번에 쓴다
    var result = { ok: true };
    if (p.action === 'start') {
      result.seq_index = handleStart_(ss, db, p);
    } else if (p.action === 'case') {
      upsertSession_(ss, db, p, 'in_progress');
      writeCase_(ss, db, p, p['case'], false);
    } else if (p.action === 'finish') {
      upsertSession_(ss, db, p, 'completed');
      (p.cases || []).forEach(function (c) { writeCase_(ss, db, p, c, true); });
    } else if (p.action === 'progress') {
      updateProgress_(ss, db, p);
    }
    // Responses 를 마지막에 기록: finish 재전송 시 '이미 저장됨' 판단 기준(Responses 행)이 다른 시트보다 먼저 생기지 않도록
    [SHEET.SESS, SHEET.LONG, SHEET.RESP].forEach(function (k) { if (db[k]) tFlush_(db[k]); });
    // 새 실제 응답이 있으면 표시만 해 두고, Summary 는 10분 주기 트리거(refreshSummaryIfDirty)가 다시 만든다
    if (!p.is_test && (p.action === 'case' || p.action === 'finish')) {
      PropertiesService.getScriptProperties().setProperty('SUMMARY_DIRTY', '1');
    }
    logRaw_(ss, p, Date.now() - t0, '');
    return json_(result);
  } catch (err) {
    console.error(err && err.stack || err);
    try { if (ss && p) logRaw_(ss, p, Date.now() - t0, String(err && err.message || err)); } catch (_) {}
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

var VALID_ACTIONS = ['start', 'case', 'finish', 'progress'];
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ss_() {
  var ss = SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('응답을 저장할 스프레드시트를 찾을 수 없습니다. 이 스크립트가 시트에 연결된 프로젝트가 아니라면 ' +
      'Code.gs 위쪽 SPREADSHEET_ID 에 시트 주소의 /d/ 와 /edit 사이 ID를 넣고 저장하세요.');
  }
  return ss;
}

// ============================================================
// HANDLERS
// ============================================================
function handleView_(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return json_({ ok: false, error: 'busy' });
  try {
    var p = JSON.parse(body);
    if (!p || p.study_id !== EXPECTED_STUDY_ID || !UUID_RE.test(String(p.visit_id || ''))) return json_({ ok: false, error: 'bad request' });
    var en = p.entry || {};
    var sh = sheet_(ss_(), SHEET.VISITS, visitsHeaders_());
    sh.appendRow([new Date(), p.visit_id, short_(p.device_id), short_(en.src), short_(en.site), short_(en.wave),
      short_(en.type_param || ''), short_(p.form_factor), short_(en.in_app), short_(en.referrer_origin, 120),
      !!p.is_test, short_(p.app_version), uiLang_(p.ui_lang), setId_(p.set_id)].map(cell_));
    sh.getRange(sh.getLastRow(), 1).setNumberFormat(TIME_FMT);   // ReceivedAt: 초 단위
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function short_(v, n) { return String(v == null ? '' : v).slice(0, n || 64); }

/** 화면 언어 ko / en (그 밖의 값은 짧게 잘라 그대로, 없으면 빈칸 = ko 로 해석) */
function uiLang_(v) {
  var s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'ko' || s === 'en' ? s : s.replace(/[^a-z\-]/g, '').slice(0, 8);
}
/** 언어 목록 ['ko','en'] → 'ko;en' */
function uiLangs_(a) { return Array.isArray(a) ? a.map(uiLang_).filter(function (x) { return x; }).join(';') : ''; }
/** 케이스 세트 ID (사이트 data/cases.js 의 set_id). 형식이 아니면 빈칸 = v1 로 해석 */
function setId_(v) {
  var s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(s) ? s : '';
}
/** 세트가 같은지: 빈칸 = v1 */
function sameSet_(a, b) { return (setId_(a) || 'v1') === (setId_(b) || 'v1'); }
/** 모든 응답 행 공통: 보낼 때의 화면 언어 · 케이스 세트 */
function langSetCols_(p) { return { UiLang: uiLang_(p.ui_lang), SetId: setId_(p.set_id) }; }

/** 이탈 지점 기록: 완료된 세션은 건드리지 않음 */
function updateProgress_(ss, db, p) {
  var t = table_(ss, db, SHEET.SESS, sessHeaders_());
  var idx = tFind_(t, { SessionId: p.session_id });
  if (idx >= 0 && String(tGet_(t, idx, 'Status')) === 'completed') return;
  var g = p.progress || {};
  var row = {
    ServerUpdatedAt: new Date(), SessionId: p.session_id, IsTest: !!p.is_test,
    FurthestCase: nz_(g.furthest_case), FurthestStep: short_(g.furthest_step, 20),
    LastActivityAt: short_(g.last_activity_at, 40), PartialRatingsN: nz_(g.partial_ratings_n)
  };
  if (idx < 0) { row.FirstSeenAt = new Date(); row.Status = 'started'; }
  Object.assign(row, evalCols_(p), langSetCols_(p));
  tWrite_(t, idx, row);
}

/** 가명 코드: 같은 사람(정규화한 성명 + 직군)은 기기가 달라도 같은 코드 E001… (테스트는 T001…) */
function evaluatorCode_(p) {
  var ev = p.evaluator || {};
  var norm = String(ev.name || '').replace(/\s+/g, '').toLowerCase() + '|' + String(ev.role || '');
  if (norm === '|') return '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, norm, Utilities.Charset.UTF_8);
  var hex = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 24);
  var props = PropertiesService.getScriptProperties();
  var key = (p.is_test ? 'EVT_' : 'EVC_') + hex;
  var code = props.getProperty(key);
  if (!code) {
    var ck = p.is_test ? 'EVT_COUNTER' : 'EVC_COUNTER';
    var n = Number(props.getProperty(ck) || '0') + 1;
    props.setProperty(ck, String(n));
    code = (p.is_test ? 'T' : 'E') + ('00' + n).slice(-3);
    props.setProperty(key, code);
  }
  return code;
}
/** 제시 순서 배정. 이미 배정된 세션은 같은 값을 돌려준다. */
function handleStart_(ss, db, p) {
  var t = table_(ss, db, SHEET.SESS, sessHeaders_());
  var idx = tFind_(t, { SessionId: p.session_id });
  var n = Number(p.n_sequences) || 4;
  var hasClientSeq = p.seq_source === 'local' && p.sequence_index !== null && p.sequence_index !== undefined;
  var seq;
  if (hasClientSeq) {
    seq = Number(p.sequence_index);        // 클라이언트가 이미 로컬 배정으로 진행 중 → 그 값을 기록
  } else if (idx >= 0) {
    var cur = tGet_(t, idx, 'SequenceIndex');
    if (cur !== '' && cur !== null) seq = Number(cur);
  }
  if (seq === undefined || isNaN(seq)) {
    seq = p.is_test ? Math.floor(Math.random() * n) : nextBalancedSeq_(t, n, p.study_type || '', p.set_id);
  }
  p.sequence_index = seq;
  upsertSession_(ss, db, p, 'started');
  return seq;
}

/**
 * 균형 배정: 실제(비테스트) 세션 중 응답이 1건 이상 들어온 세션(in_progress/completed)과
 * 최근 2시간 이내 시작한 세션(started, 진행 중일 가능성)을 순서별로 세어 가장 적은 순서를 배정.
 * 동률이면 순환 카운터 순서를 따른다. → 중도 이탈자가 Latin square 균형을 깨지 않음.
 * 같은 케이스 세트(SetId, 빈칸 = v1) · 같은 Type 안에서만 센다 (세트마다 Type 구성이 다름). v1 의 카운터 이름은 이전과 같다.
 */
function nextBalancedSeq_(t, n, studyType, setId) {
  var props = PropertiesService.getScriptProperties();
  var sid = setId_(setId) || 'v1';
  var key = 'SEQ_COUNTER' + (studyType ? '_' + studyType : '') + (sid !== 'v1' ? '_' + sid : '');
  var counter = Number(props.getProperty(key) || '0');
  props.setProperty(key, String(counter + 1));
  var counts = [];
  for (var i = 0; i < n; i++) counts.push(0);
  var now = Date.now();
  t.rows.forEach(function (r) {
    var test = isTrue_(r[t.map.IsTest - 1]);
    if (test) return;
    if (t.map.StudyType && String(r[t.map.StudyType - 1]) !== String(studyType)) return;   // 같은 Type 안에서만 균형
    if (t.map.SetId && !sameSet_(r[t.map.SetId - 1], sid)) return;                           // 같은 케이스 세트 안에서만
    var raw = r[t.map.SequenceIndex - 1];
    var seq = Number(raw);
    if (raw === '' || isNaN(seq) || seq < 0 || seq >= n) return;
    var status = String(r[t.map.Status - 1]);
    var first = r[t.map.FirstSeenAt - 1];
    var recent = first instanceof Date ? (now - first.getTime() < 2 * 3600 * 1000) : false;
    if (status === 'in_progress' || status === 'completed' || (status === 'started' && recent)) counts[seq] += 1;
  });
  var min = Math.min.apply(null, counts);
  for (var k = 0; k < n; k++) {
    var cand = (counter + k) % n;
    if (counts[cand] === min) return cand;
  }
  return counter % n;
}

function upsertSession_(ss, db, p, status) {
  var t = table_(ss, db, SHEET.SESS, sessHeaders_());
  var s = p.session || {};
  var d = p.device || {};
  var idx = tFind_(t, { SessionId: p.session_id });
  var prevStatus = idx >= 0 ? String(tGet_(t, idx, 'Status')) : '';
  var rank = { started: 1, in_progress: 2, completed: 3 };
  if (prevStatus && rank[prevStatus] > rank[status]) status = prevStatus;   // 상태는 후퇴하지 않음
  // 완료된 세션에 늦게 도착한 이전 메시지는 요약 수치를 되돌리지 않는다
  var stale = prevStatus === 'completed' && p.action !== 'finish';

  var row = {
    ServerUpdatedAt: new Date(),
    SessionId: p.session_id,
    IsTest: !!p.is_test,
    EvaluatorName: (p.evaluator && p.evaluator.name) || '',
    Status: status,
    AppVersion: p.app_version || '',
    DataVersion: p.data_version || '',
    BackendVersion: BACKEND_VERSION
  };
  if (p.sequence_index !== null && p.sequence_index !== undefined) row.SequenceIndex = p.sequence_index;
  if (p.seq_source) row.SeqSource = p.seq_source;
  if (p.order && p.order.length) row.Order = p.order.join(' > ');
  if (p.linked_session_id) row.LinkedSessionId = p.linked_session_id;
  if (p.device_id) row.DeviceId = short_(p.device_id, 40);
  if (p.visit_id) row.VisitId = short_(p.visit_id, 40);
  var en = p.entry || {}, cs = p.consent || {};
  if (p.entry) {
    row.Src = short_(en.src); row.Site = short_(en.site); row.Wave = short_(en.wave || p.wave);
    row.TypePreselected = !!en.type_preselected; row.InAppBrowser = short_(en.in_app); row.ReferrerOrigin = short_(en.referrer_origin, 120);
  }
  if (p.consent) { row.ConsentVersion = short_(cs.version); row.ConsentAt = short_(cs.at, 40); row.ConsentInherited = !!cs.inherited; }
  if (p.instrument_version) row.InstrumentVersion = short_(p.instrument_version, 120);
  if (p.incentive !== undefined) row.Incentive = short_(p.incentive, 120);
  if (idx < 0) row.FirstSeenAt = new Date();
  if (p.session && !stale) {
    var prevCases = idx >= 0 ? Number(tGet_(t, idx, 'CasesCompleted')) || 0 : 0;
    row.CasesCompleted = Math.max(prevCases, Number(s.cases_completed) || 0);
    if (s.started_at) row.StartedAt = s.started_at;
    if (s.finished_at) row.FinishedAt = s.finished_at;
    row.TotalActiveMin = min_(s.total_active_ms);
    row.TotalIdleMin = min_(s.total_idle_ms);
    row.TotalHiddenMin = min_(s.total_hidden_ms);
    row.TotalWallMin = min_(s.total_wall_ms);
    row.IntroSec = sec_(s.intro_ms);
    row.FinalSec = sec_(s.final_ms);
    row.Resumes = s.resumes;
    row.Interruptions = nz_(s.interruptions);
    row.SendFailures = nz_(s.send_failures);
    if (s.ui_lang_start !== undefined) row.UiLangStart = uiLang_(s.ui_lang_start);
    if (s.ui_langs) row.UiLangs = uiLangs_(s.ui_langs);
    if (s.ui_lang_switches !== undefined) row.UiLangSwitches = nz_(s.ui_lang_switches);
  }
  if (p.action === 'finish') {
    row.OverallComment = p.overall_comment || '';
    row.FurthestStep = 'final';
    Object.assign(row, itemCols_(p.end_items, 'End_'));
  }
  if (p.device) {
    row.FormFactor = d.form_factor; row.ViewportW = d.vw; row.ViewportH = d.vh;
    row.ScreenW = d.sw; row.ScreenH = d.sh; row.DPR = d.dpr; row.TouchPoints = d.touch;
    row.CoarsePointer = d.coarse; row.Language = d.lang; row.TimeZone = d.tz; row.UserAgent = d.ua;
  }
  Object.assign(row, evalCols_(p), langSetCols_(p));
  tWrite_(t, idx, row);
}

function writeCase_(ss, db, p, c, fromFinish) {
  if (!c || !c.case_key) return;
  var t = table_(ss, db, SHEET.RESP, respHeaders_());
  var idx = tFind_(t, { SessionId: p.session_id, CaseKey: c.case_key });
  // finish 에 다시 실려 온 케이스가 이미 같은 내용으로 저장돼 있으면 건너뜀
  if (fromFinish && idx >= 0 && sameTime_(tGet_(t, idx, 'CaseCompletedAt'), c.completed_at)) return;
  var m = c.metrics || {};
  var steps = m.steps || {};
  var r = c.ratings || {};
  var row = {
    ServerUpdatedAt: new Date(),
    SessionId: p.session_id,
    IsTest: !!p.is_test,
    EvaluatorName: (p.evaluator && p.evaluator.name) || '',
    SequenceIndex: nz_(p.sequence_index),
    SeqSource: p.seq_source || '',
    CaseOrder: c.case_index,
    CaseKey: c.case_key,
    PatientId: c.patient_id,
    Model: c.model,
    ModelName: c.model_name,
    P1_Referral: nz_(r.p1),
    ComboChoice: nz_(c.combo_choice),
    ComboName: c.combo_name || '',
    ComboIsAIFirst: c.combo_choice ? (c.combo_choice === 1) : '',
    ComboKey: c.combo_key || (c.combo_choice ? c.case_key + '_C' + c.combo_choice : ''),
    ComboRankAI: nz_(c.combo_rank_ai || c.combo_choice),
    RankCueVisible: c.rank_cue_visible === undefined ? '' : !!c.rank_cue_visible,
    GlobalCaseOrder: nz_(c.global_case_order),
    PatientSeenPrior: c.patient_seen_prior === undefined ? '' : !!c.patient_seen_prior,
    RxDetailsOpens: nz_(c.rx_details_opens),
    Interruptions: nz_(c.interruptions),
    P2_SharedDecision: nz_(r.p2),
    P3_Pharmacotherapy: nz_(r.p3),
    P4_FollowUp: nz_(r.p4),
    P5_Education: nz_(r.p5),
    CaseComment: c.comment || '',
    CaseStartedAt: c.started_at || '',
    CaseCompletedAt: c.completed_at || '',
    CaseActiveSec: sec_(m.case_active_ms),
    CaseIdleSec: sec_(m.case_idle_ms),
    CaseHiddenSec: sec_(m.case_hidden_ms),
    CaseWallSec: sec_(m.case_wall_ms),
    ComboResets: m.combo_resets || 0,
    PatientDrawerOpens: m.drawer_opens || 0,
    PatientDrawerSec: sec_(m.drawer_ms),
    AppVersion: p.app_version || '',
    DataVersion: p.data_version || '',
    BackendVersion: BACKEND_VERSION,
    MetricsJson: clip_(JSON.stringify(m))
  };
  STEPS.forEach(function (s) {
    var st = steps[s] || {};
    row['Sec_' + STEP_COL[s]] = sec_((st.active_ms || 0) + (st.idle_ms || 0));
    row['Scroll_' + STEP_COL[s]] = st.scroll_max === undefined ? '' : st.scroll_max;
    row['Visits_' + STEP_COL[s]] = st.visits || 0;
    if (s !== 'vignette' && s !== 'comment') {
      row['TTFR_' + STEP_COL[s]] = (st.ttfr_ms === null || st.ttfr_ms === undefined) ? '' : sec_(st.ttfr_ms);
      row['Changes_' + STEP_COL[s]] = st.changes || 0;
    }
  });
  var chars = c.chars || {};
  ['vignette', 'p1', 'combo', 'p2', 'p3', 'p4', 'p5'].forEach(function (s) { row['Chars_' + STEP_COL[s]] = nz_(chars[s]); });
  PHASE_KEYS.forEach(function (k) {
    var st = steps[k] || {};
    row['ScrollAtFR_' + STEP_COL[k]] = (st.scroll_at_fr === null || st.scroll_at_fr === undefined) ? '' : st.scroll_at_fr;
  });
  var ex = c.combo_exposure || {};
  [0, 1, 2].forEach(function (i) {
    row['ComboSeen_' + (i + 1)] = ex.seen ? !!ex.seen[i] : '';
    row['ComboDwellSec_' + (i + 1)] = ex.dwell_ms ? sec_(ex.dwell_ms[i]) : '';
  });
  Object.assign(row, itemCols_(c.items, 'Case_'));
  Object.assign(row, evalCols_(p), langSetCols_(p));
  if (c.ui_langs) row.UiLangs = uiLangs_(c.ui_langs);   // 이 케이스 화면이 보인 언어들 (2개 = 언어를 바꿔 가며 평가)
  tWrite_(t, idx, row);

  // Long format (Phase 단위)
  var lt = table_(ss, db, SHEET.LONG, longHeaders_());
  PHASE_KEYS.forEach(function (k) {
    var st = steps[k] || {};
    var score = r[k];
    var vis = (st.active_ms || 0) + (st.idle_ms || 0);
    // 조합을 바꾸면(reset) 그 이후의 응답만 현재 조합에 대한 응답으로 본다
    var rawHist = st.history || [], lastReset = -1;
    rawHist.forEach(function (h, i) { if (h && h[0] === 'reset') lastReset = i; });
    var hist = rawHist.slice(lastReset + 1).filter(function (h) { return typeof h[0] === 'number'; });
    var nChars = (c.chars || {})[k];
    var harmPh = (c.items && c.items.harm_phases) ? String(c.items.harm_phases.value || '') : '';
    var harmAns = c.items && c.items.harm ? Number(c.items.harm.code) : 0;
    var lrow = {
      ServerUpdatedAt: new Date(), SessionId: p.session_id, IsTest: !!p.is_test,
      GlobalCaseOrder: nz_(c.global_case_order), PatientSeenPrior: c.patient_seen_prior === undefined ? '' : !!c.patient_seen_prior,
      ModelName: c.model_name || '', ComboKey: c.combo_key || '', RankCueVisible: c.rank_cue_visible === undefined ? '' : !!c.rank_cue_visible,
      TargetKey: k === 'p1' ? c.case_key + '|P1' : (c.combo_choice ? c.case_key + '|C' + c.combo_choice + '|' + k.toUpperCase() : ''),
      FirstScore: hist.length ? hist[0][0] : nz_(score), Changed: hist.length > 1 ? 1 : 0,
      ScrollAtFirstRating: (st.scroll_at_fr === null || st.scroll_at_fr === undefined) ? '' : st.scroll_at_fr,
      Chars: nz_(nChars), CharsPerSec: (nChars && vis > 0) ? Math.round(nChars / (vis / 1000) * 10) / 10 : '',
      HarmInPhase: harmPh ? (harmPh.split(';').indexOf(k.toUpperCase()) >= 0 ? 1 : 0) : (harmAns === 1 ? 0 : ''),
      EvaluatorName: (p.evaluator && p.evaluator.name) || '',
      SequenceIndex: nz_(p.sequence_index), CaseOrder: c.case_index, CaseKey: c.case_key, PatientId: c.patient_id,
      Model: c.model, ComboChoice: nz_(c.combo_choice), Phase: k.toUpperCase(), PhaseLabel: PHASE_LABEL[k],
      Score: nz_(score), Acceptable_4plus: (score === null || score === undefined) ? '' : (score >= 4 ? 1 : 0),
      VisibleSec: sec_((st.active_ms || 0) + (st.idle_ms || 0)),
      ActiveOnlySec: sec_(st.active_ms || 0),
      TTFRSec: (st.ttfr_ms === null || st.ttfr_ms === undefined) ? '' : sec_(st.ttfr_ms),
      Changes: st.changes || 0, ScrollPct: st.scroll_max === undefined ? '' : st.scroll_max, Visits: st.visits || 0
    };
    Object.assign(lrow, evalCols_(p), langSetCols_(p));
    if (st.ui_lang) lrow.UiLang = uiLang_(st.ui_lang);   // 이 Phase 를 평정한 때의 화면 언어 (없으면 보낼 때의 언어)
    tWrite_(lt, tFind_(lt, { SessionId: p.session_id, CaseKey: c.case_key, Phase: k.toUpperCase() }), lrow);
  });
}

function logRaw_(ss, p, elapsedMs, error) {
  var sh = sheet_(ss, SHEET.RAW, rawHeaders_());
  var row = [new Date(), String(p.action || ''), String(p.session_id || ''), String(p.msg_id || ''), !!p.is_test,
    clip_(JSON.stringify(p)), elapsedMs, error || ''];
  sh.appendRow(row.map(cell_));
  sh.getRange(sh.getLastRow(), 1).setNumberFormat(TIME_FMT);   // ReceivedAt: 초 단위
}

// ============================================================
// SHEET UTILITIES
// ============================================================
/** 시트를 가져오거나 만들고, 필요한 헤더가 모두 있도록 보장(누락된 헤더는 오른쪽 끝에 추가). */
function sheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e3edf5');
    sh.setFrozenRows(1);
    return sh;
  }
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var cur = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  // 이전 버전 호환: PhaseLong 'ActiveSec'(= active+idle)은 'VisibleSec'과 같은 값 → 이름만 바꿔 기존 데이터 유지
  var ai = cur.indexOf('ActiveSec');
  if (name === SHEET.LONG && ai >= 0 && cur.indexOf('VisibleSec') < 0) {
    sh.getRange(1, ai + 1).setValue('VisibleSec');
    cur[ai] = 'VisibleSec';
  }
  var missing = headers.filter(function (h) { return cur.indexOf(h) === -1; });
  if (cur.length === 1 && cur[0] === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#e3edf5');
    sh.setFrozenRows(1);
  } else if (missing.length) {
    sh.getRange(1, cur.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground('#e3edf5');
  }
  return sh;
}

function headerMap_(sh) {
  var lastCol = sh.getLastColumn();
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  hdr.forEach(function (h, i) { if (h !== '') map[String(h)] = i + 1; });
  return { map: map, width: lastCol };
}

/** 요청 단위 테이블 캐시: 헤더+데이터를 한 번에 읽어 메모리에서 찾고, tFlush_ 에서 일괄 기록 */
function table_(ss, db, name, headers) {
  if (db[name]) return db[name];
  var sh = sheet_(ss, name, headers);
  var lastCol = sh.getLastColumn();
  var lastRow = Math.max(sh.getLastRow(), 1);
  var values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  var map = {};
  values[0].forEach(function (h, i) { if (h !== '') map[String(h)] = i + 1; });
  var t = { sh: sh, map: map, width: lastCol, rows: values.slice(1), orig: lastRow - 1, dirty: {} };
  db[name] = t;
  return t;
}

function tFind_(t, keys) {
  var names = Object.keys(keys);
  for (var i = 0; i < t.rows.length; i++) {
    var ok = true;
    for (var j = 0; j < names.length; j++) {
      var col = t.map[names[j]];
      if (!col || String(t.rows[i][col - 1]) !== String(keys[names[j]])) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function tGet_(t, idx, name) {
  var col = t.map[name];
  return (idx >= 0 && col) ? t.rows[idx][col - 1] : '';
}

/** idx >= 0 이면 해당 행의 지정 컬럼만 갱신, 아니면 새 행 추가(메모리). */
/** 평가자 정보 컬럼: 직군·세부 항목(config.EVALUATOR_ROLES 의 fields)은 Eval_<id> 컬럼으로 자동 추가 */
function evalCols_(p) {
  if (p._evc) return p._evc;
  var ev = p.evaluator || {};
  var o = {
    EvaluatorName: ev.name || '', EvaluatorRole: ev.role_label || ev.role || '', EvaluatorDetail: ev.detail || '',
    ResidentYear: ev.year || '', StudyType: p.study_type || '',
    EvaluatorId: short_(p.evaluator_id, 40), EvaluatorCode: evaluatorCode_(p), SessionOrdinal: nz_(p.session_ordinal)
  };
  var f = ev.fields || {}, cd = ev.codes || {};
  Object.keys(f).forEach(function (k) { if (/^[A-Za-z0-9_]{1,40}$/.test(k)) o['Eval_' + k] = short_(f[k], 120); });
  Object.keys(cd).forEach(function (k) { if (/^[A-Za-z0-9_]{1,40}$/.test(k)) o['Eval_' + k + '_code'] = Number(cd[k]) || ''; });
  p._evc = o;
  return o;
}

/** 보조 문항 {id: {value, code}} → <prefix><id>, <prefix><id>_code 컬럼 */
function itemCols_(items, prefix) {
  var o = {};
  Object.keys(items || {}).forEach(function (k) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) return;
    var it = items[k] || {};
    o[prefix + k] = short_(it.value, 200);
    if (it.code !== '' && it.code !== undefined && it.code !== null) o[prefix + k + '_code'] = Number(it.code) || '';
  });
  return o;
}

function tAddCol_(t, name) {
  var col = t.width + 1;
  t.sh.getRange(1, col).setValue(name);
  t.sh.getRange(1, col).setFontWeight('bold').setBackground('#e3edf5');
  t.map[name] = col;
  t.width = col;
  t.rows.forEach(function (r) { while (r.length < col) r.push(''); });
}

function tWrite_(t, idx, rowObj) {
  Object.keys(rowObj).forEach(function (k) { if (!t.map[k] && /^(Eval|Case|End)_/.test(k)) tAddCol_(t, k); });
  var vals;
  if (idx >= 0) {
    vals = t.rows[idx];
  } else {
    vals = [];
    for (var i = 0; i < t.width; i++) vals.push('');
    t.rows.push(vals);
    idx = t.rows.length - 1;
  }
  Object.keys(rowObj).forEach(function (k) {
    var col = t.map[k];
    if (!col) return;
    var v = rowObj[k];
    vals[col - 1] = (v === undefined || v === null) ? '' : (isTimeCol_(k) ? timeVal_(v) : v);
  });
  t.dirty[idx] = true;
}

function tFlush_(t) {
  var idxs = Object.keys(t.dirty).map(Number).sort(function (a, b) { return a - b; });
  var appended = [];
  idxs.forEach(function (i) {
    var safe = t.rows[i].map(cell_);
    if (i < t.orig) t.sh.getRange(i + 2, 1, 1, t.width).setValues([safe]);
    else appended.push(safe);
  });
  if (appended.length) {
    t.sh.getRange(t.orig + 2, 1, appended.length, t.width).setValues(appended);
    var heads = [];
    Object.keys(t.map).forEach(function (h) { heads[t.map[h] - 1] = h; });
    timeColsOf_(heads).forEach(function (c) { t.sh.getRange(t.orig + 2, c, appended.length, 1).setNumberFormat(TIME_FMT); });
  }
  t.orig = t.rows.length;
  t.dirty = {};
}

/**
 * 셀 값 정리: 문자열은 모두 텍스트로 고정(앞에 ' 를 붙임).
 *  - 수식 주입(=, +, -, @ 로 시작) 차단
 *  - '3/4', '2026-11-18' 같은 의견·시각 문자열이 날짜/숫자로 자동 변환되는 것 방지
 *  (Sheets 는 ' 를 표시하지 않으며 getValues 에서도 돌려주지 않는다 → 다시 쓸 때마다 재적용)
 */
function cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' && v !== '') return "'" + v;
  return v;
}

// ------------------------------------------------------------
// 시각 컬럼: 이름이 …At 인 컬럼(ReceivedAt, FirstSeenAt, ServerUpdatedAt, StartedAt, FinishedAt, ConsentAt,
// CaseStartedAt, CaseCompletedAt, LastActivityAt, AnsweredAt …).
//  · 기기가 보낸 ISO 시각 문자열(예: 2026-11-20T01:23:45.678Z)도 문자열이 아니라 날짜·시각 값으로 저장
//  · 표시 형식을 'yyyy-mm-dd hh:mm:ss'(초 단위)로 고정, 스프레드시트 시간대는 한국 시간(Asia/Seoul)
//  · 값 자체는 밀리초까지 보존되므로 소요 시간 계산에 그대로 쓸 수 있다
// ------------------------------------------------------------
var TIME_FMT = 'yyyy-mm-dd hh:mm:ss';
var TIME_ZONE = 'Asia/Seoul';
var ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

function isTimeCol_(name) { return /At$/.test(String(name || '')); }

/** ISO 시각 문자열 → Date (그 밖의 값은 그대로) */
function timeVal_(v) {
  if (typeof v === 'string') {
    var s = v.trim();
    if (ISO_TIME_RE.test(s)) { var t = Date.parse(s); if (!isNaN(t)) return new Date(t); }
  }
  return v;
}

/** 헤더 행에서 시각 컬럼 번호(1부터) */
function timeColsOf_(headers) {
  var out = [];
  (headers || []).forEach(function (h, i) { if (isTimeCol_(h)) out.push(i + 1); });
  return out;
}

/** 시각 컬럼 전체(2행부터 시트 끝까지)에 초 단위 표시 형식 적용 */
function formatTimeCols_(sh) {
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  var hdr = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var n = Math.max(sh.getMaxRows() - 1, 1);
  timeColsOf_(hdr).forEach(function (c) { sh.getRange(2, c, n, 1).setNumberFormat(TIME_FMT); });
}

/** 방금 추가한 행(rowNo)의 시각 셀에 형식 적용 (appendRow 용) */
function formatTimeRow_(sh, rowNo, headers) {
  timeColsOf_(headers).forEach(function (c) { sh.getRange(rowNo, c).setNumberFormat(TIME_FMT); });
}

/** 스프레드시트 시간대를 한국 시간으로 */
function ensureTimeZone_(ss) {
  try { if (ss.getSpreadsheetTimeZone() !== TIME_ZONE) ss.setSpreadsheetTimeZone(TIME_ZONE); }
  catch (eTz) { Logger.log('⚠️ 시간대 설정 실패: ' + eTz); }
}

function clip_(txt) {
  return txt.length > 49000 ? txt.slice(0, 49000) + '…(truncated)' : txt;
}

function sameTime_(a, b) {
  if (a === '' || a === null || a === undefined || !b) return false;
  if (a instanceof Date) return a.getTime() === Date.parse(b);
  return String(a) === String(b);
}

function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function sec_(ms) { return (ms === null || ms === undefined || ms === '') ? '' : Math.round(Number(ms) / 100) / 10; }
function min_(ms) { return (ms === null || ms === undefined || ms === '') ? '' : Math.round(Number(ms) / 6000) / 10; }
function nz_(v) { return (v === null || v === undefined) ? '' : v; }

// ============================================================
// SETUP / MENU / SUMMARY
// ============================================================
/** 최초 1회 실행: 권한 승인 + 시트/헤더 생성 */
function setup() {
  var ss = ss_();
  // 응답이 없거나 테스트 응답(IsTest=TRUE)만 있는 시트는 최신 컬럼 순서로 새로 만든다.
  // 실제 응답이 하나라도 있으면 데이터는 건드리지 않고 누락된 컬럼만 오른쪽 끝에 추가한다.
  dataSheets_().forEach(function (x) {
    var sh = ss.getSheetByName(x[0]);
    if (sh && onlyTestRows_(sh)) {
      sh.clear();
      sh.getRange(1, 1, 1, x[1].length).setValues([x[1]]).setFontWeight('bold').setBackground('#e3edf5');
      sh.setFrozenRows(1);
    } else {
      sheet_(ss, x[0], x[1]);
    }
  });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  ensureTimeZone_(ss);
  dataSheets_().forEach(function (x) { var sh = ss.getSheetByName(x[0]); if (sh) formatTimeCols_(sh); });
  Logger.log('✅ 시각 컬럼: 한국 시간, 초 단위(yyyy-mm-dd hh:mm:ss) 표시');
  try { ensureSummaryTrigger_(); Logger.log('✅ Summary 자동 갱신(10분 주기) 설정 완료'); }
  catch (eTrig) { Logger.log('⚠️ 자동 갱신 트리거 설정 실패: ' + eTrig); }
  Logger.log('✅ 시트 준비 완료: ' + ss.getUrl());
}

/** 응답 데이터 시트와 헤더 (setup·resetAllResponses 공용) */
function dataSheets_() {
  return [[SHEET.RESP, respHeaders_()], [SHEET.LONG, longHeaders_()], [SHEET.SESS, sessHeaders_()],
    [SHEET.VISITS, visitsHeaders_()], [SHEET.RAW, rawHeaders_()]];
}

/**
 * ⚠️ 모든 응답 삭제 (처음부터 다시 수집할 때만 실행)
 *  1) 지금 스프레드시트 전체를 '… (백업 yyyy-MM-dd HH:mm:ss)' 사본으로 내 드라이브에 저장 (되돌릴 수 있음)
 *  2) Responses · PhaseLong · Sessions · Visits · RawJSON 의 응답 행을 모두 지우고 최신 헤더만 남김
 *  3) 평가자 가명 코드(E001…)·테스트 코드(T001…)·순서 배정 카운터를 처음으로 되돌림 → 다음 평가자가 E001
 *  4) Summary 등 요약 시트를 빈 데이터로 다시 만듦
 *  Concordance 시트(GC 결과를 붙여넣는 곳)는 건드리지 않는다.
 *  실행: Apps Script 편집기 위쪽 함수 목록에서 resetAllResponses 선택 → [실행] → 실행 로그에서 백업 링크 확인
 */
function resetAllResponses() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = ss_();
    var stamp = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
    var backup = ss.copy(ss.getName() + ' (백업 ' + stamp + ')');
    Logger.log('💾 백업 사본: ' + backup.getUrl());
    var counts = [];
    dataSheets_().forEach(function (x) {
      var sh = ss.getSheetByName(x[0]);
      var n = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
      if (sh) sh.clear(); else sh = ss.insertSheet(x[0]);
      sh.getRange(1, 1, 1, x[1].length).setValues([x[1]]).setFontWeight('bold').setBackground('#e3edf5');
      sh.setFrozenRows(1);
      formatTimeCols_(sh);
      counts.push(x[0] + ' ' + n + '행');
    });
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties(), removed = 0;
    Object.keys(all).forEach(function (k) {
      if (/^(EVC_|EVT_|SEQ_COUNTER|SUMMARY_DIRTY$|SUMMARY_BUILT_AT$)/.test(k)) { props.deleteProperty(k); removed++; }
    });
    ensureTimeZone_(ss);
    SpreadsheetApp.flush();
    Logger.log('🗑️ 삭제한 응답: ' + counts.join(', ') + ' / 초기화한 코드·카운터 ' + removed + '개');
  } finally {
    try { lock.releaseLock(); } catch (eRel) {}
  }
  try { buildSummary(false); } catch (eSum) { Logger.log('⚠️ 요약 시트 갱신 실패(다음 응답 후 자동 갱신): ' + eSum); }
  Logger.log('✅ 모든 응답을 지웠습니다. 백업은 위 링크에 있습니다. 시각은 한국 시간 초 단위로 기록됩니다.');
}

function onlyTestRows_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return true;
  var hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var col = hdr.indexOf('IsTest');
  if (col < 0) return false;
  var vals = sh.getRange(2, col + 1, lastRow - 1, 1).getValues();
  return vals.every(function (r) { return isTrue_(r[0]); });
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('📊 임상 수용성 평가')
    .addItem('요약 통계 갱신 (테스트 응답 제외)', 'buildSummary')
    .addItem('요약 통계 갱신 (테스트 응답 포함)', 'buildSummaryIncludingTests')
    .addSeparator()
    .addItem('시트·헤더 점검', 'setup')
    .addItem('순서 배정 카운터 확인', 'showCounter')
    .addToUi();
}

function showCounter() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var c = Object.keys(all).filter(function (k) { return k.indexOf('SEQ_COUNTER') === 0; }).map(function (k) { return k + '=' + all[k]; }).join(', ') || '0';
  SpreadsheetApp.getUi().alert('지금까지 순서 배정을 요청한 실제 평가자 수: ' + c + '\n(배정은 응답이 들어온 세션 수가 가장 적은 순서부터 이루어집니다.)');
}
