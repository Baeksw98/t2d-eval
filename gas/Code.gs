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
 * 모든 쓰기는 (SessionId[, CaseKey]) 기준 upsert 이므로 같은 요청이 재전송되어도 중복 행이 생기지 않습니다.
 */

// ============================================================
// CONFIG
// ============================================================
var SPREADSHEET_ID = '1-R-BZKkhyaTSHvHssM5sazwjq-KKQqfjzIqAhFMbS10';            // 시트에서 [확장 프로그램 → Apps Script]로 만든 경우 비워 둠. script.google.com 에서 따로 만든 경우 시트 ID 입력
var BACKEND_VERSION = '2026-11-19.ca-backend-v4';
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
    'AppVersion', 'DataVersion', 'BackendVersion', 'MetricsJson']);
  return h;
}

function longHeaders_() {
  return ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder',
    'CaseKey', 'PatientId', 'PatientSeenPrior', 'Model', 'ModelName', 'ComboChoice', 'ComboKey', 'RankCueVisible',
    'Phase', 'PhaseLabel', 'TargetKey', 'Score', 'Acceptable_4plus', 'FirstScore', 'Changed',
    'VisibleSec', 'ActiveOnlySec', 'TTFRSec', 'Changes', 'ScrollPct', 'ScrollAtFirstRating', 'Chars', 'CharsPerSec',
    'Visits', 'HarmInPhase'];
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
    'Language', 'TimeZone', 'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion'
  ];
}

function visitsHeaders_() {
  return ['ReceivedAt', 'VisitId', 'DeviceId', 'Src', 'Site', 'Wave', 'TypeParam', 'FormFactor', 'InAppBrowser',
    'ReferrerOrigin', 'IsTest', 'AppVersion'];
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
      !!p.is_test, short_(p.app_version)].map(cell_));
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function short_(v, n) { return String(v == null ? '' : v).slice(0, n || 64); }

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
  Object.assign(row, evalCols_(p));
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
    seq = p.is_test ? Math.floor(Math.random() * n) : nextBalancedSeq_(t, n, p.study_type || '');
  }
  p.sequence_index = seq;
  upsertSession_(ss, db, p, 'started');
  return seq;
}

/**
 * 균형 배정: 실제(비테스트) 세션 중 응답이 1건 이상 들어온 세션(in_progress/completed)과
 * 최근 2시간 이내 시작한 세션(started, 진행 중일 가능성)을 순서별로 세어 가장 적은 순서를 배정.
 * 동률이면 순환 카운터 순서를 따른다. → 중도 이탈자가 Latin square 균형을 깨지 않음.
 */
function nextBalancedSeq_(t, n, studyType) {
  var props = PropertiesService.getScriptProperties();
  var key = 'SEQ_COUNTER' + (studyType ? '_' + studyType : '');
  var counter = Number(props.getProperty(key) || '0');
  props.setProperty(key, String(counter + 1));
  var counts = [];
  for (var i = 0; i < n; i++) counts.push(0);
  var now = Date.now();
  t.rows.forEach(function (r) {
    var test = isTrue_(r[t.map.IsTest - 1]);
    if (test) return;
    if (t.map.StudyType && String(r[t.map.StudyType - 1]) !== String(studyType)) return;   // 같은 Type 안에서만 균형
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
  Object.assign(row, evalCols_(p));
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
  Object.assign(row, evalCols_(p));
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
    Object.assign(lrow, evalCols_(p));
    tWrite_(lt, tFind_(lt, { SessionId: p.session_id, CaseKey: c.case_key, Phase: k.toUpperCase() }), lrow);
  });
}

function logRaw_(ss, p, elapsedMs, error) {
  var sh = sheet_(ss, SHEET.RAW, rawHeaders_());
  var row = [new Date(), String(p.action || ''), String(p.session_id || ''), String(p.msg_id || ''), !!p.is_test,
    clip_(JSON.stringify(p)), elapsedMs, error || ''];
  sh.appendRow(row.map(cell_));
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
    vals[col - 1] = (v === undefined || v === null) ? '' : v;
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
  if (appended.length) t.sh.getRange(t.orig + 2, 1, appended.length, t.width).setValues(appended);
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
  [[SHEET.RESP, respHeaders_()], [SHEET.LONG, longHeaders_()], [SHEET.SESS, sessHeaders_()],
   [SHEET.VISITS, visitsHeaders_()], [SHEET.RAW, rawHeaders_()]].forEach(function (x) {
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
  try { ensureSummaryTrigger_(); Logger.log('✅ Summary 자동 갱신(10분 주기) 설정 완료'); }
  catch (eTrig) { Logger.log('⚠️ 자동 갱신 트리거 설정 실패: ' + eTrig); }
  Logger.log('✅ 시트 준비 완료: ' + ss.getUrl());
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

// ============================================================
// SUMMARY / ANALYSIS (gas/src/summary.gs)
// ============================================================
/**
 * 요약 통계 · 분석용 데이터 생성기
 *
 *  buildSummary(includeTests)   Sessions · Responses · PhaseLong · Visits · Concordance 를 시트마다 한 번씩 읽어
 *                               Summary(논문용 표), AnalysisLong(R/Stata 용 long format), Codebook(컬럼 설명)을 새로 씀
 *  buildSummaryIncludingTests() 테스트 응답 포함
 *  refreshSummaryIfDirty()      10분 주기 트리거: 스크립트 속성 SUMMARY_DIRTY='1' 일 때만 재생성
 *  ensureSummaryTrigger_()      위 트리거를 하나만 설치 (core 의 setup 에서 호출)
 *
 * Summary 구성
 *  [0] 머리말  [1] 참여 흐름(CHERRIES)  [2] 평가자 특성(Table 1)  [3] 설계 균형
 *  [4] 주 결과(모델·케이스 × Phase, I-CVI, k*, S-CVI)  [5] 모델 비교(평가자 내)  [6] 평가자 간 일치도
 *  [7] 하위군  [8] 조합 선택  [9] 안전성  [10] 활용 의향  [11] 소요 시간·읽기 노력  [12] 데이터 품질
 *  [13] 정성 자료  [14] 가이드라인 부합도 연결  [15] 방법 기술용 자동 문구
 *
 * 포함 규칙은 sm_rules_() (Summary [0] 에도 그대로 출력). 모든 컬럼은 헤더 이름으로 찾고,
 * 없는 컬럼은 빈 값으로 본다(이전 버전 시트 호환). 출력 시트마다 setValues 는 1회, 모든 문자열은 cell_() 경유.
 */

var SM_ALONG = 'AnalysisLong';
var SM_CODEBOOK = 'Codebook';
var SM_CONC = 'Concordance';
var SM_WIDTH = 20;                     // Summary 열 수 (고정 폭으로 패딩)
var SM_Z = 1.959963984540054;          // 95% 양측 정규 분위수
var SM_EU = 2;                         // rWG 기대 분산 σ²EU = (5² − 1) / 12
var SM_CASES_DEFAULT = 2;              // Order 가 비어 있을 때 세션당 케이스 수
var SM_RULE = { cps: 25, minSec: 5, caseFrac: 0.3, straightMin: 6, hiddenFrac: 0.5, scrollMin: 60 };
var SM_SCORE_COL = { p1: 'P1_Referral', p2: 'P2_SharedDecision', p3: 'P3_Pharmacotherapy', p4: 'P4_FollowUp', p5: 'P5_Education' };
var SM_STEP_KO = {
  vignette: '환자 정보', p1: 'Phase 1', combo: '조합 선택', p2: 'Phase 2', p3: 'Phase 3', p4: 'Phase 4',
  p5: 'Phase 5', comment: '케이스 의견', final: '전체 의견·제출 화면'
};
var SM_OPT = {
  year: ['R1', 'R2', 'R3'],
  major: ['내과', '가정의학과', '기타 (직접 입력)'],
  board_years: ['5년 미만', '5–9년', '10–19년', '20년 이상'],
  t2d_volume: ['월 1명 미만', '월 1–10명', '월 11–30명', '월 31명 이상'],
  ai_use: ['사용한 적 없음', '월 1회 미만', '월 1회–주 1회', '주 2회 이상', '거의 매일'],
  harm: ['없음', '경미한 위해 가능성', '중대한 위해 가능성'],
  would_prescribe: ['그대로 처방', '일부 수정하여 처방', '처방할 조합 없음']
};
var SM_KEYW = { harm: ['없음', '경미', '중대'], would_prescribe: ['그대로', '수정', '없음'] };
var SM_ROLE_ORDER = ['인턴', '레지던트', '전문의'];
var SM_TRUST_BANDS = ['1–2 (낮음)', '3 (중간)', '4–5 (높음)'];
var SM_AL_COLS = ['EvaluatorCode', 'EvaluatorId', 'SessionId', 'SessionOrdinal', 'StudyType', 'SequenceIndex', 'CaseOrder',
  'GlobalCaseOrder', 'PatientId', 'PatientSeenPrior', 'Model', 'ModelName', 'CaseKey', 'ComboRankAI', 'ComboKey',
  'RankCueVisible', 'Phase', 'TargetKey', 'Score', 'Acceptable', 'FirstScore', 'Changed', 'Role', 'ResidentYear', 'Major',
  'Specialty', 'BoardYears', 'T2DVolume_code', 'AIUse_code', 'AITrust_code', 'Src', 'Site', 'Wave', 'FormFactor',
  'InAppBrowser', 'VisibleSec', 'ActiveOnlySec', 'TTFRSec', 'Chars', 'CharsPerSec', 'ScrollAtFirstRating', 'HarmCode',
  'HarmInPhase', 'WouldPrescribeCode', 'IntentUseCode', 'SpeederFlag', 'CaseSpeeder', 'StraightlineFlag',
  'HiddenHeavyFlag', 'RatedBeforeReadFlag', 'IncludedInAnalysis', 'ExclusionReason', 'IsTest'];

// ============================================================
// PUBLIC ENTRY POINTS
// ============================================================
function buildSummaryIncludingTests() { return buildSummary(true); }

function buildSummary(includeTests) {
  includeTests = includeTests === true;   // 메뉴·트리거가 넘기는 이벤트 객체는 false 로 취급
  var props = PropertiesService.getScriptProperties();
  var wasDirty = props.getProperty('SUMMARY_DIRTY') === '1';
  // 읽기 전에 지운다 → 생성 중 들어온 응답은 core 가 다시 '1' 로 표시하여 다음 주기에 반영
  sm_clearDirty_(props);
  try {
    var ss = ss_();
    var D = sm_load_(ss, includeTests);
    var sum = sm_summary_(D);
    var al = sm_analysisLong_(D);
    var cb = sm_codebook_(D);
    var width = SM_WIDTH;
    sum.rows.forEach(function (r) { if (r.length > width) width = r.length; });
    sm_write_(ss, SHEET.SUMMARY, sum.rows, width, sum.bold, false);
    sm_write_(ss, SM_ALONG, al, SM_AL_COLS.length, [0], true);
    sm_write_(ss, SM_CODEBOOK, cb, cb[0].length, [0], true);
    var at = new Date().toISOString();
    props.setProperty('SUMMARY_BUILT_AT', at);
    var res = {
      builtAt: at, includeTests: includeTests, evaluators: D.inc.evals.length, sessions: D.inc.sessions.length,
      cases: D.inc.cases.length, ratings: sm_scored_(D.inc.phases).length, analysisRows: al.length - 1
    };
    Logger.log('✅ Summary 갱신: ' + JSON.stringify(res));
    return res;
  } catch (err) {
    if (wasDirty) { try { props.setProperty('SUMMARY_DIRTY', '1'); } catch (e2) {} }
    throw err;
  }
}

/** 시간 기반 트리거(10분)용: 새 응답이 있을 때만, 잠금을 얻은 경우에만 재생성 */
function refreshSummaryIfDirty() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SUMMARY_DIRTY') !== '1') return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;   // 응답 저장 중이면 다음 주기에
  try {
    buildSummary(false);
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
  return true;
}

/** refreshSummaryIfDirty 시간 트리거를 정확히 1개만 유지 (중복 삭제). 멱등. */
function ensureSummaryTrigger_() {
  if (typeof ScriptApp === 'undefined') return false;
  var handler = 'refreshSummaryIfDirty';
  var keep = null;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== handler) return;
    var clock = !ScriptApp.EventType || !t.getEventType || t.getEventType() === ScriptApp.EventType.CLOCK;
    if (!keep && clock) keep = t;
    else ScriptApp.deleteTrigger(t);
  });
  if (!keep) ScriptApp.newTrigger(handler).timeBased().everyMinutes(10).create();
  return true;
}

function sm_clearDirty_(props) {
  if (typeof props.deleteProperty === 'function') props.deleteProperty('SUMMARY_DIRTY');
  else props.setProperty('SUMMARY_DIRTY', '0');
}

// ============================================================
// READ + JOIN + DERIVE
// ============================================================
/** 시트 전체를 getValues 1회로 읽어 {cols, rows:[{헤더: 값}]} 로 변환. 없는 시트는 빈 테이블. */
function sm_read_(ss, name) {
  var t = { name: name, exists: false, cols: [], rows: [] };
  var sh = ss.getSheetByName(name);
  if (!sh) return t;
  t.exists = true;
  var lr = sh.getLastRow(), lc = sh.getLastColumn();
  if (lr < 1 || lc < 1) return t;
  var v = sh.getRange(1, 1, lr, lc).getValues();
  var idx = {};
  v[0].forEach(function (h, j) {
    h = sm_str_(h);
    if (h !== '' && !sm_has_(idx, h)) { idx[h] = j; t.cols.push(h); }
  });
  for (var i = 1; i < v.length; i++) {
    var r = v[i], o = {}, any = false;
    for (var k = 0; k < t.cols.length; k++) {
      var x = r[idx[t.cols[k]]];
      o[t.cols[k]] = x;
      if (!sm_blank_(x)) any = true;
    }
    if (any) t.rows.push(o);
  }
  return t;
}

/** 헤더 행만 읽기 (RawJSON 처럼 내용이 큰 시트는 Codebook 용 컬럼 목록만 필요) */
function sm_readHeader_(ss, name) {
  var t = { name: name, exists: false, cols: [], rows: [] };
  var sh = ss.getSheetByName(name);
  if (!sh) return t;
  t.exists = true;
  var lc = sh.getLastColumn();
  if (lc > 0) t.cols = sh.getRange(1, 1, 1, lc).getValues()[0].map(sm_str_).filter(function (h) { return h !== ''; });
  return t;
}

/** Concordance(가이드라인 부합도) 시트: 없으면 헤더만 만들어 둔다 */
function sm_readConc_(ss) {
  if (!ss.getSheetByName(SM_CONC)) {
    var sh = ss.insertSheet(SM_CONC);
    sh.getRange(1, 1, 1, 2).setValues([[cell_('TargetKey'), cell_('ConcordanceScore')]]);
    try { sh.getRange(1, 1, 1, 2).setFontWeight('bold'); sh.setFrozenRows(1); } catch (e) {}
    return { name: SM_CONC, exists: true, created: true, cols: ['TargetKey', 'ConcordanceScore'], rows: [] };
  }
  return sm_read_(ss, SM_CONC);
}

function sm_load_(ss, includeTests) {
  var D = {
    includeTests: includeTests,
    S: sm_read_(ss, SHEET.SESS), R: sm_read_(ss, SHEET.RESP), L: sm_read_(ss, SHEET.LONG),
    V: sm_read_(ss, SHEET.VISITS || 'Visits'), C: sm_readConc_(ss),
    sessions: [], byId: {}, pool: [], cases: [], phases: [], evals: [], evByKey: {}, modelName: {},
    inc: { sessions: [], cases: [], phases: [], evals: [] },
    excl: { test: sm_zero_(), pilot: sm_zero_(), duplicate: sm_zero_() },
    incompleteRows: 0, visits: [], caseVisMedian: NaN, raw: sm_readHeader_(ss, SHEET.RAW)
  };
  D.S.rows.forEach(function (o) {
    var id = sm_str_(o.SessionId);
    if (id) (D.byId[id] || sm_addSess_(D, id)).row = o;
  });
  D.R.rows.forEach(function (o) {
    var sid = sm_str_(o.SessionId), key = sm_str_(o.CaseKey);
    if (!sid || !key) return;
    var s = sm_has_(D.byId, sid) ? D.byId[sid] : sm_addSess_(D, sid);
    if (sm_has_(s.caseBy, key)) { s.caseBy[key].row = o; return; }
    var c = { key: key, sess: s, row: o };
    s.caseBy[key] = c;
    s.caseList.push(c);
  });
  var longBy = {};
  D.L.rows.forEach(function (o) {
    longBy[sm_str_(o.SessionId) + '\u0001' + sm_str_(o.CaseKey) + '\u0001' + sm_str_(o.Phase).toUpperCase()] = o;
  });

  // ---- 세션 속성 · 평가자 식별 ----
  var pseudo = {}, nPseudo = 0;
  D.sessions.forEach(function (s) {
    s.isTest = sm_bool_(sm_sf_(s, 'IsTest')) === true;
    s.type = sm_str_(sm_sf_(s, 'StudyType'));
    s.seq = sm_str_(sm_sf_(s, 'SequenceIndex'));
    s.wave = sm_str_(sm_sf_(s, 'Wave'));
    s.status = sm_str_(sm_sf_(s, 'Status')).toLowerCase();
    s.code = sm_str_(sm_sf_(s, 'EvaluatorCode'));
    s.evId = sm_str_(sm_sf_(s, 'EvaluatorId'));
    var nm = sm_str_(sm_sf_(s, 'EvaluatorName')).replace(/\s+/g, '').toLowerCase();
    var role = sm_str_(sm_sf_(s, 'EvaluatorRole'));
    s.ident = s.code ? 'C:' + s.code : s.evId ? 'I:' + s.evId : (nm || role) ? 'N:' + nm + '|' + role : 'S:' + s.id;
    if (s.code) s.pcode = s.code;
    else {
      if (!sm_has_(pseudo, s.ident)) pseudo[s.ident] = 'R' + ('00' + (++nPseudo)).slice(-3);
      s.pcode = pseudo[s.ident];
    }
    s.firstSeen = sm_time_(sm_sf_(s, 'FirstSeenAt'));
    s.cases = s.caseList.filter(function (c) { return sm_str_(c.row.CaseCompletedAt) !== ''; });
    var order = sm_str_(sm_sf_(s, 'Order'));
    s.nExpected = order ? order.split('>').filter(function (x) { return x.trim() !== ''; }).length : SM_CASES_DEFAULT;
    s.complete = s.status === 'completed' || (s.cases.length > 0 && s.cases.length >= s.nExpected);
    var fin = sm_time_(sm_sf_(s, 'FinishedAt')), last = NaN;
    s.cases.forEach(function (c) {
      var t = sm_time_(c.row.CaseCompletedAt);
      if (sm_fin_(t) && (!sm_fin_(last) || t > last)) last = t;
    });
    s.doneAt = sm_fin_(fin) ? fin : last;
    var ordv = sm_num_(sm_sf_(s, 'SessionOrdinal'));
    s.ordinal = sm_fin_(ordv) ? ordv : (sm_str_(sm_sf_(s, 'LinkedSessionId')) ? 2 : NaN);
    s.intent = sm_item_(sm_sf_(s, 'End_intent_use'), sm_sf_(s, 'End_intent_use_code'), null).code;
    s.reason = '';
  });

  // ---- 테스트 제외 → pool (참여 흐름 표의 모집단) ----
  D.sessions.forEach(function (s) {
    if (s.isTest && !includeTests) { sm_addExcl_(D.excl.test, s); return; }
    D.pool.push(s);
    D.incompleteRows += s.caseList.length - s.cases.length;
  });

  // ---- 파일럿 · 같은 Type 중복 ----
  var groups = {};
  D.pool.forEach(function (s) {
    if (/^pilot/i.test(s.wave)) { s.reason = 'pilot'; return; }
    if (!s.cases.length) return;
    var g = s.ident + '\u0001' + s.type;
    (groups[g] = groups[g] || []).push(s);
  });
  Object.keys(groups).forEach(function (g) {
    var arr = groups[g];
    if (arr.length < 2) return;
    arr.sort(sm_attemptCmp_);
    arr.forEach(function (s, i) { s.dupGroup = arr.length; if (i > 0) s.reason = 'duplicate'; });
  });
  D.pool.forEach(function (s) { if (s.reason) sm_addExcl_(D.excl[s.reason], s); });

  // ---- 평가자 ----
  D.pool.forEach(function (s) {
    var e = D.evByKey[s.ident];
    if (!e) {
      e = { ident: s.ident, pcode: s.pcode, sessions: [], incSessions: [], phases: [] };
      D.evByKey[s.ident] = e;
      D.evals.push(e);
    }
    e.sessions.push(s);
    s.ev = e;
    if (!s.reason && s.cases.length) e.incSessions.push(s);
  });
  D.evals.forEach(function (e) {
    var cmp = function (a, b) { return sm_cmpNum_(a.firstSeen, b.firstSeen) || sm_cmpNum_(a.ordinal, b.ordinal) || a.ord - b.ord; };
    e.incSessions.sort(cmp);
    e.sessions.sort(cmp);
    e.first = e.incSessions[0] || e.sessions[0];
    sm_profile_(e);
  });

  // ---- 케이스 · Phase ----
  D.pool.forEach(function (s) {
    s.cases.forEach(function (c) {
      sm_caseDerive_(s, c);
      if (c.modelNameRaw && !sm_has_(D.modelName, c.model)) D.modelName[c.model] = c.modelNameRaw;
      D.cases.push(c);
      c.phases = PHASE_KEYS.map(function (k) {
        var p = sm_phaseDerive_(s, c, k, longBy[s.id + '\u0001' + c.key + '\u0001' + k.toUpperCase()] || null);
        D.phases.push(p);
        return p;
      });
    });
    var sc = [];
    s.cases.forEach(function (c) { c.phases.forEach(function (p) { if (sm_fin_(p.score)) sc.push(p.score); }); });
    s.straight = sc.length >= SM_RULE.straightMin ? (sc.every(function (v) { return v === sc[0]; }) ? 1 : 0) : '';
  });

  D.inc.sessions = D.pool.filter(function (s) { return !s.reason && s.cases.length > 0; });
  D.inc.cases = D.cases.filter(function (c) { return c.included; });
  D.inc.phases = D.phases.filter(function (p) { return p.c.included; });
  D.inc.evals = D.evals.filter(function (e) { return e.incSessions.length > 0; });

  var vis = D.inc.cases.map(function (c) { return c.vis; }).filter(sm_fin_);
  D.caseVisMedian = vis.length ? median_(vis) : NaN;
  D.cases.forEach(function (c) {
    c.caseSpeeder = (sm_fin_(c.vis) && sm_fin_(D.caseVisMedian)) ? (c.vis < SM_RULE.caseFrac * D.caseVisMedian ? 1 : 0) : '';
  });
  D.phases.forEach(function (p) {
    p.anyFlag = [p.speeder, p.c.caseSpeeder, p.sess.straight, p.c.hiddenHeavy, p.rbr].indexOf(1) >= 0 ? 1 : 0;
  });
  D.inc.phases.forEach(function (p) { p.sess.ev.phases.push(p); });
  D.inc.evals.forEach(function (e) {
    var sc = sm_scored_(e.phases).map(function (p) { return p.score; });
    e.meanScore = sc.length ? mean_(sc) : NaN;
    var it = e.incSessions.map(function (s) { return s.intent; }).filter(sm_fin_);
    e.intent = it.length ? mean_(it) : NaN;
  });
  D.visits = D.V.rows.filter(function (v) { return includeTests || sm_bool_(v.IsTest) !== true; });
  return D;
}

function sm_zero_() { return { sessions: 0, cases: 0, phases: 0 }; }
function sm_addExcl_(x, s) { x.sessions++; x.cases += s.cases.length; x.phases += s.cases.length * PHASE_KEYS.length; }

function sm_addSess_(D, id) {
  var s = { id: id, row: null, caseBy: {}, caseList: [], cases: [], ord: D.sessions.length, reason: '' };
  D.byId[id] = s;
  D.sessions.push(s);
  return s;
}

/** 세션 값: Sessions 행 → 비어 있으면 그 세션의 Responses 행 (이전 버전·Sessions 행 누락 대비) */
function sm_sf_(s, k) {
  var v = s.row ? s.row[k] : undefined;
  if (!sm_blank_(v)) return v;
  for (var i = 0; i < s.caseList.length; i++) {
    var w = s.caseList[i].row[k];
    if (!sm_blank_(w)) return w;
  }
  return '';
}

/** 중복 시도 정렬: 모든 케이스 완료 세션 우선 → 완료 시각(FinishedAt, 없으면 마지막 CaseCompletedAt) → 처음 본 시각 */
function sm_attemptCmp_(a, b) {
  if (a.complete !== b.complete) return a.complete ? -1 : 1;
  return sm_cmpNum_(a.doneAt, b.doneAt) || sm_cmpNum_(a.firstSeen, b.firstSeen) || a.ord - b.ord;
}

/** 평가자 특성: 첫 포함 세션 값, 비어 있으면 같은 평가자의 다른 세션 값 (예: ai_trust 는 첫 세션에서만 질문) */
function sm_profile_(e) {
  var list = [e.first].concat(e.incSessions, e.sessions);
  var pick = function (k) {
    for (var i = 0; i < list.length; i++) { var v = sm_sf_(list[i], k); if (!sm_blank_(v)) return v; }
    return '';
  };
  e.role = sm_str_(pick('EvaluatorRole'));
  e.kind = /레지던트|resident/i.test(e.role) ? 'resident' : /전문의|specialist/i.test(e.role) ? 'specialist' :
    /인턴|intern/i.test(e.role) ? 'intern' : '';
  e.year = sm_str_(pick('Eval_year')) || sm_str_(pick('ResidentYear'));
  e.major = sm_str_(pick('Eval_major'));
  e.specialty = sm_str_(pick('Eval_specialty'));
  e.board = sm_item_(pick('Eval_board_years'), pick('Eval_board_years_code'), SM_OPT.board_years);
  e.t2d = sm_item_(pick('Eval_t2d_volume'), pick('Eval_t2d_volume_code'), SM_OPT.t2d_volume);
  e.aiUse = sm_item_(pick('Eval_ai_use'), pick('Eval_ai_use_code'), SM_OPT.ai_use);
  e.aiTrust = sm_item_(pick('Eval_ai_trust'), pick('Eval_ai_trust_code'), null);
  e.src = sm_str_(pick('Src'));
  e.site = sm_str_(pick('Site'));
  e.form = sm_str_(pick('FormFactor'));
  e.inApp = sm_str_(pick('InAppBrowser'));
}

function sm_caseDerive_(s, c) {
  var o = c.row;
  c.included = !s.reason;
  c.reason = s.reason;
  c.model = sm_modelKey_(o.Model, o.ModelName);
  c.modelRaw = sm_str_(o.Model);
  c.modelNameRaw = sm_str_(o.ModelName);
  c.patient = sm_str_(o.PatientId) || c.key.split('_')[0];
  c.caseOrder = sm_num_(o.CaseOrder);
  c.rank = sm_num_(o.ComboRankAI);
  if (!sm_fin_(c.rank)) c.rank = sm_num_(o.ComboChoice);
  c.comboKey = sm_str_(o.ComboKey) || (sm_fin_(c.rank) ? c.key + '_C' + c.rank : '');
  c.rankCue = sm_bool_(o.RankCueVisible);
  var a = sm_num_(o.CaseActiveSec), i = sm_num_(o.CaseIdleSec);
  if (sm_fin_(a) || sm_fin_(i)) c.vis = (sm_fin_(a) ? a : 0) + (sm_fin_(i) ? i : 0);
  else c.vis = sm_sumNum_(STEPS.map(function (st) { return o['Sec_' + STEP_COL[st]]; }));
  c.hidden = sm_num_(o.CaseHiddenSec);
  c.wall = sm_num_(o.CaseWallSec);
  c.hiddenHeavy = (sm_fin_(c.hidden) && sm_fin_(c.wall) && c.wall > 0) ? (c.hidden > SM_RULE.hiddenFrac * c.wall ? 1 : 0) : '';
  c.harm = sm_item_(o.Case_harm, o.Case_harm_code, SM_OPT.harm, SM_KEYW.harm);
  c.harmPhases = sm_str_(o.Case_harm_phases).toUpperCase().split(/[;,\s]+/).filter(function (x) { return x !== ''; });
  c.would = sm_item_(o.Case_would_prescribe, o.Case_would_prescribe_code, SM_OPT.would_prescribe, SM_KEYW.would_prescribe);
  c.comment = sm_str_(o.CaseComment);
  c.resets = sm_num_(o.ComboResets);
  var seen = [1, 2, 3].map(function (n) { return sm_bool_(o['ComboSeen_' + n]); });
  c.seenAll = seen.every(function (b) { return b === null; }) ? null : seen.every(function (b) { return b === true; });
  c.drawerOpens = sm_num_(o.PatientDrawerOpens);
  c.drawerSec = sm_num_(o.PatientDrawerSec);
}

function sm_phaseDerive_(s, c, k, lo) {
  var o = c.row, L = lo || {}, P = k.toUpperCase(), col = STEP_COL[k];
  var p = { sess: s, c: c, k: k, P: P, lo: lo };
  var sc = sm_num_(L.Score);
  if (!(sc >= 1 && sc <= 5)) sc = sm_num_(o[SM_SCORE_COL[k]]);
  p.score = (sc >= 1 && sc <= 5) ? Math.round(sc) : NaN;
  p.acc = sm_fin_(p.score) ? (p.score >= 4 ? 1 : 0) : NaN;
  p.vis = sm_firstNum_([L.VisibleSec, L.ActiveSec, o['Sec_' + col]]);
  p.activeOnly = sm_num_(L.ActiveOnlySec);
  p.ttfr = sm_firstNum_([L.TTFRSec, o['TTFR_' + col]]);
  p.chars = sm_firstNum_([L.Chars, o['Chars_' + col]]);
  p.cps = (sm_fin_(p.chars) && sm_fin_(p.vis) && p.vis > 0) ? p.chars / p.vis : sm_num_(L.CharsPerSec);
  p.scrollFR = sm_firstNum_([L.ScrollAtFirstRating, o['ScrollAtFR_' + col]]);
  p.changes = sm_firstNum_([L.Changes, o['Changes_' + col]]);
  p.firstScore = sm_num_(L.FirstScore);
  var ch = sm_bool_(L.Changed);
  p.changed = ch === null ? '' : (ch ? 1 : 0);
  var hip = sm_num_(L.HarmInPhase);
  p.harmIn = sm_fin_(hip) ? hip :
    (c.harmPhases.length ? (c.harmPhases.indexOf(P) >= 0 ? 1 : 0) : (c.harm.code === 1 ? 0 : NaN));
  p.target = sm_str_(L.TargetKey) ||
    (k === 'p1' ? c.key + '|P1' : (sm_fin_(c.rank) ? c.key + '|C' + c.rank + '|' + P : c.key + '|' + P));
  p.speeder = sm_fin_(p.vis) ? ((p.vis < SM_RULE.minSec || (sm_fin_(p.cps) && p.cps > SM_RULE.cps)) ? 1 : 0) : '';
  p.rbr = sm_fin_(p.scrollFR) ? (p.scrollFR < SM_RULE.scrollMin ? 1 : 0) : '';
  return p;
}

function sm_modelKey_(model, name) {
  var m = sm_str_(model).toLowerCase(), n = sm_str_(name).toLowerCase(), s = m + ' ' + n;
  if (/gpt/.test(s)) return 'gpt';
  if (/deepseek/.test(s)) return 'deepseek';
  return m || n || '(미상)';
}

function sm_rules_() {
  var R = SM_RULE;
  return [
    '테스트 응답(IsTest=TRUE)은 Summary·AnalysisLong 에서 모두 제외합니다(메뉴 [테스트 응답 포함] 실행 시에만 포함).',
    '케이스는 CaseCompletedAt 이 기록된 경우에만 집계합니다(중도 이탈 세션이라도 완료한 케이스는 포함).',
    'Wave 가 pilot 인 세션은 주 분석에서 제외(IncludedInAnalysis=0, ExclusionReason=pilot)하되 참여 흐름 [1] 에는 셉니다.',
    '평가자 식별: EvaluatorCode → 없으면 EvaluatorId → 없으면 정규화한 성명(공백 제거·소문자) + "|" + EvaluatorRole.',
    '같은 평가자가 같은 StudyType 을 2회 이상 응답(완료 케이스 ≥ 1)하면 가장 먼저 완료한 세션만 포함합니다(모든 케이스를 완료한 세션 우선, 완료 시각 = FinishedAt, 없으면 마지막 CaseCompletedAt). 나머지는 ExclusionReason=duplicate.',
    '세션 완료 = Status=completed 또는 완료 케이스 수 ≥ 제시 케이스 수(Order, 없으면 ' + SM_CASES_DEFAULT + ').',
    '수용(Acceptable) = 점수 ≥ 4. 이 요약의 I-CVI 는 수용 비율과 같습니다.',
    '품질 플래그(제외하지 않고 보고·민감도 분석에만 사용): SpeederFlag(Phase) = 글자 수/표시 시간 > ' + R.cps + '자/초 또는 표시 시간 < ' + R.minSec +
      '초; CaseSpeeder(케이스) = 케이스 표시 시간 < 분석 포함 케이스 중앙값 × ' + R.caseFrac + '; StraightlineFlag(세션) = 평정 ' + R.straightMin +
      '개 이상이 모두 같은 점수; HiddenHeavyFlag(케이스) = CaseHiddenSec > ' + R.hiddenFrac + ' × CaseWallSec; RatedBeforeReadFlag(Phase) = 첫 응답 시점 스크롤 < ' +
      R.scrollMin + '%. 판정에 필요한 값이 없으면 빈칸(판정 불가).',
    '표시 시간 = active + idle (다른 앱·탭으로 가려진 hidden 제외). 사분위수는 R type 7 방식. 비율은 소수 셋째 자리, 평균은 둘째 자리, % 는 첫째 자리.',
    '평가자 특성(직군·진료량·AI 사용·AI 신뢰 등)은 평가자의 첫 포함 세션 값이며, 비어 있으면 같은 평가자의 다른 세션 값을 씁니다.'
  ];
}

// ============================================================
// SUMMARY SHEET
// ============================================================
function sm_out_() {
  var o = { rows: [], bold: [] };
  o.add = function (r) { o.rows.push(r && r.length ? r : ['']); };
  o.title = function (t) { o.bold.push(o.rows.length); o.rows.push([t]); };
  o.head = function (r) { o.bold.push(o.rows.length); o.rows.push(r); };
  o.sub = function (t) { o.rows.push([t]); };
  o.note = function (t) { o.rows.push(['※ ' + t]); };
  o.gap = function () { o.rows.push(['']); };
  return o;
}

function sm_summary_(D) {
  var o = sm_out_();
  [sm_s0_, sm_s1_, sm_s2_, sm_s3_, sm_s4_, sm_s5_, sm_s6_, sm_s7_, sm_s8_, sm_s9_, sm_s10_, sm_s11_, sm_s12_,
    sm_s13_, sm_s14_, sm_s15_].forEach(function (f) { f(o, D); });
  return o;
}

// [0] 머리말 ---------------------------------------------------
function sm_s0_(o, D) {
  o.title('임상 수용성 평가 — 요약 통계 (Summary)');
  o.add(['생성 시각', new Date()]);
  o.add(['테스트 응답', D.includeTests ? '포함 (buildSummaryIncludingTests)' : '제외 (IsTest=TRUE 제외)']);
  o.add(['백엔드 버전', typeof BACKEND_VERSION === 'undefined' ? '' : BACKEND_VERSION]);
  o.gap();
  o.title('[0] 머리말 — 표본과 포함 규칙');
  o.head(['항목', '값', '', '']);
  o.add(['분석 포함 평가자 수 (고유 평가자)', D.inc.evals.length]);
  o.add(['분석 포함 세션 수', D.inc.sessions.length]);
  o.add(['분석 포함 완료 케이스 수', D.inc.cases.length]);
  o.add(['분석 포함 Phase 평정 수', sm_scored_(D.inc.phases).length]);
  o.add(['AnalysisLong 행 수 (테스트 외 완료 케이스 × Phase)', D.phases.length]);
  var fs = D.pool.map(function (s) { return s.firstSeen; }).filter(sm_fin_);
  o.add(['데이터 기간 (Sessions.FirstSeenAt, 테스트 제외)', fs.length ? new Date(Math.min.apply(null, fs)) : '', '~',
    fs.length ? new Date(Math.max.apply(null, fs)) : '']);
  o.gap();
  o.head(['제외 사유', '세션 수', '완료 케이스 수', 'Phase 행 수', '설명']);
  o.add(['test', D.excl.test.sessions, D.excl.test.cases, D.excl.test.phases,
    D.includeTests ? '테스트 포함 모드 — 제외하지 않음' : 'IsTest=TRUE — Summary·AnalysisLong 모두에서 제외']);
  o.add(['pilot', D.excl.pilot.sessions, D.excl.pilot.cases, D.excl.pilot.phases, 'Wave=pilot — 주 분석 제외(IncludedInAnalysis=0), 참여 흐름에는 포함']);
  o.add(['duplicate', D.excl.duplicate.sessions, D.excl.duplicate.cases, D.excl.duplicate.phases, '같은 평가자의 같은 Type 반복 — 첫 완료 세션만 포함']);
  o.add(['미완료 케이스 행', '', D.incompleteRows, '', 'CaseCompletedAt 없음 — 집계하지 않음']);
  o.add(['완료 케이스가 없는 세션', D.pool.filter(function (s) { return !s.cases.length; }).length, 0, 0, '시작 후 이탈 — [1] 참여 흐름 참고']);
  o.gap();
  o.head(['버전', '값', '세션 수']);
  [['AppVersion', 'AppVersion'], ['InstrumentVersion', 'InstrumentVersion']].forEach(function (x) {
    var cnt = sm_counts_(D.pool, function (s) { return sm_str_(sm_sf_(s, x[1])) || '(미기록)'; });
    if (!cnt.length) o.add([x[0], '(세션 없음)', 0]);
    cnt.forEach(function (kv, i) { o.add([i ? '' : x[0], kv[0], kv[1]]); });
  });
  o.gap();
  o.head(['포함 · 파생 규칙']);
  sm_rules_().forEach(function (t, i) { o.add([(i + 1) + '. ' + t]); });
  o.gap();
}

// [1] 참여 흐름 -------------------------------------------------
function sm_s1_(o, D) {
  var hasV = D.V.exists;
  o.title('[1] 참여 흐름 (CHERRIES) — 테스트 제외, 파일럿·중복 세션 포함');
  o.head(['구분', '값', '방문 고유 기기 (DeviceId)', '방문 수', '세션 시작', '세션 시작 고유 기기', '≥1 케이스 완료 세션',
    '완료 세션', '참여율 (시작 세션 ÷ 방문 기기)', '완료율 (완료 ÷ 시작)', '분석 포함 세션']);
  o.add(sm_flowRow_('전체', '', hasV ? D.visits : null, D.pool));
  var types = sm_uniq_(D.pool.map(function (s) { return s.type; })).sort();
  var vTypes = D.visits.map(function (v) { return sm_str_(v.TypeParam).toUpperCase(); });
  var typeAttributable = types.some(function (t) { return t && vTypes.indexOf(t.toUpperCase()) >= 0; });
  types.forEach(function (t) {
    var vs = (hasV && typeAttributable) ? D.visits.filter(function (v) { return sm_str_(v.TypeParam).toUpperCase() === t.toUpperCase(); }) : null;
    o.add(sm_flowRow_('StudyType', t || '(미기록)', vs, D.pool.filter(function (s) { return s.type === t; })));
  });
  ['Src', 'Site'].forEach(function (col) {
    var vals = sm_uniq_(D.pool.map(function (s) { return sm_str_(sm_sf_(s, col)); })
      .concat(D.visits.map(function (v) { return sm_str_(v[col]); })));
    if (col === 'Site' && !vals.some(function (x) { return x !== ''; })) return;
    vals.sort().forEach(function (val) {
      o.add(sm_flowRow_(col, val || '(없음)', hasV ? D.visits.filter(function (v) { return sm_str_(v[col]) === val; }) : null,
        D.pool.filter(function (s) { return sm_str_(sm_sf_(s, col)) === val; })));
    });
  });
  o.note('조회율(view rate)은 초대 대상 수(분모)를 알 수 없어 계산하지 않았습니다. 참여율 = 시작 세션 ÷ 방문 고유 기기 (한 기기에서 Type 2개를 하면 1을 넘을 수 있음), 완료율 = 완료 세션 ÷ 시작 세션.');
  o.note(typeAttributable ? 'StudyType 행의 방문 수는 링크에 Type 이 지정된(TypeParam) 방문만 셉니다.'
    : 'Visits 에는 Type 정보(TypeParam=A/B)가 없어 StudyType 행의 방문 지표는 비워 두었습니다.');
  if (!hasV) o.note('Visits 시트가 없어 방문 지표를 계산하지 못했습니다.');
  o.gap();

  var nc = D.pool.filter(function (s) { return !s.complete; });
  o.sub('[1-2] 미완료 세션의 마지막 도달 지점 (n = ' + nc.length + ')');
  o.head(['FurthestStep', '설명', 'FurthestCase = 1', 'FurthestCase = 2', '그 외 / 미기록', '합계']);
  var order = ['vignette', 'p1', 'combo', 'p2', 'p3', 'p4', 'p5', 'comment', 'final'];
  var by = {};
  nc.forEach(function (s) {
    var st = sm_str_(sm_sf_(s, 'FurthestStep')).toLowerCase() || '(미기록)';
    var fc = sm_num_(sm_sf_(s, 'FurthestCase'));
    var b = by[st] = by[st] || [0, 0, 0];
    b[fc === 1 ? 0 : fc === 2 ? 1 : 2]++;
  });
  var keys = sm_orderKeys_(Object.keys(by), order.concat(['(미기록)']));
  var tot = [0, 0, 0];
  keys.forEach(function (k) {
    var b = by[k];
    tot[0] += b[0]; tot[1] += b[1]; tot[2] += b[2];
    o.add([k, SM_STEP_KO[k] || '', b[0], b[1], b[2], b[0] + b[1] + b[2]]);
  });
  o.add(['합계', '', tot[0], tot[1], tot[2], tot[0] + tot[1] + tot[2]]);
  o.gap();

  var typesBy = {};
  D.pool.forEach(function (s) {
    if (!s.complete || s.reason === 'pilot') return;
    (typesBy[s.ident] = typesBy[s.ident] || {})[s.type] = 1;
  });
  var both = Object.keys(typesBy).filter(function (k) { return Object.keys(typesBy[k]).length >= 2; }).length;
  var linked = D.pool.filter(function (s) { return sm_str_(sm_sf_(s, 'LinkedSessionId')) !== '' || s.ordinal === 2; }).length;
  o.head(['지표', '값']);
  o.add(['두 Type 을 모두 완료한 평가자 수 (파일럿 제외)', both]);
  o.add(['이어서 평가한 세션 수 (LinkedSessionId 또는 SessionOrdinal = 2)', linked]);
  o.gap();
}

function sm_flowRow_(label, val, visits, sessions) {
  var dev = visits ? sm_uniqCount_(visits.map(function (v) { return sm_str_(v.DeviceId); })) : '';
  var sdev = sm_uniqCount_(sessions.map(function (s) { return sm_str_(sm_sf_(s, 'DeviceId')); }));
  var started = sessions.length;
  var any = sessions.filter(function (s) { return s.cases.length > 0; }).length;
  var done = sessions.filter(function (s) { return s.complete; }).length;
  var inc = sessions.filter(function (s) { return !s.reason && s.cases.length > 0; }).length;
  return [label, val, dev, visits ? visits.length : '', started, sdev, any, done,
    (visits && dev) ? r3_(started / dev) : '', started ? r3_(done / started) : '', inc];
}

// [2] 평가자 특성 -------------------------------------------------
function sm_s2_(o, D) {
  var E = D.inc.evals;
  o.title('[2] 평가자 특성 (Table 1) — 분석 포함 고유 평가자 N = ' + E.length + ' (첫 포함 세션 기준)');
  o.head(['변수', '수준', 'n', '%', '분모']);
  sm_cat_(o, '직군', E, function (e) { return e.role; }, SM_ROLE_ORDER);
  var res = E.filter(function (e) { return e.kind === 'resident'; });
  sm_cat_(o, '레지던트 년차', res, function (e) { return e.year; }, SM_OPT.year);
  sm_cat_(o, '레지던트 전공', res, function (e) { return e.major; }, SM_OPT.major);
  var sp = E.filter(function (e) { return e.kind === 'specialist'; });
  sm_cat_(o, '전문의 주 분야', sp, function (e) { return e.specialty; }, null);
  sm_cat_(o, '전문의 연차 (board_years)', sp, function (e) { return e.board.label; }, SM_OPT.board_years);
  sm_cat_(o, '제2형 당뇨병 진료량 (t2d_volume)', E, function (e) { return e.t2d.label; }, SM_OPT.t2d_volume);
  sm_cat_(o, 'AI 도구 사용 빈도 (ai_use)', E, function (e) { return e.aiUse.label; }, SM_OPT.ai_use);
  var tr = E.map(function (e) { return e.aiTrust.code; }).filter(sm_fin_);
  o.add(['AI 신뢰 (ai_trust, 1–5)', '중앙값 (Q1–Q3)', tr.length ? sm_medIqrText_(tr) : '', '', tr.length]);
  sm_cat_(o, 'AI 신뢰 분포', E, function (e) { return sm_fin_(e.aiTrust.code) ? String(e.aiTrust.code) : ''; }, ['1', '2', '3', '4', '5']);
  sm_cat_(o, '유입 경로 (Src)', E, function (e) { return e.src; }, null, '(없음)');
  if (E.some(function (e) { return e.site; })) sm_cat_(o, '기관 (Site)', E, function (e) { return e.site; }, null, '(없음)');
  sm_cat_(o, '기기 (FormFactor)', E, function (e) { return e.form; }, ['mobile', 'tablet', 'desktop'], '(미기록)');
  sm_cat_(o, '인앱 브라우저 (InAppBrowser)', E, function (e) { return e.inApp; }, null, '(일반 브라우저)');
  o.note('% = 분모 대비 백분율. 레지던트 항목은 직군 = 레지던트, 전문의 항목은 직군 = 전문의 평가자만 분모로 씁니다. AI 신뢰 1 = 전혀 신뢰하지 않음 … 5 = 매우 신뢰함.');
  o.gap();
}

function sm_cat_(o, label, list, fn, order, blank) {
  var cnt = {}, keys = [];
  list.forEach(function (x) {
    var k = sm_str_(fn(x)) || blank || '(미응답)';
    if (!sm_has_(cnt, k)) { cnt[k] = 0; keys.push(k); }
    cnt[k]++;
  });
  if (!keys.length) { o.add([label, '(해당 없음)', 0, '', 0]); return; }
  sm_orderKeys_(keys, order).forEach(function (k, i) {
    o.add([i ? '' : label, k, cnt[k], r1_(100 * cnt[k] / list.length), list.length]);
  });
}

// [3] 설계 균형 ---------------------------------------------------
function sm_s3_(o, D) {
  o.title('[3] 설계 균형');
  o.head(['StudyType', 'SequenceIndex', '제시 순서 (Order)', '시작 세션', '완료 세션 (전체)', '완료 세션 (분석 포함)']);
  var g = {}, keys = [];
  D.pool.forEach(function (s) {
    var k = s.type + '\u0001' + s.seq;
    if (!sm_has_(g, k)) { g[k] = []; keys.push(k); }
    g[k].push(s);
  });
  keys.sort();
  if (!keys.length) o.add(['(세션 없음)']);
  keys.forEach(function (k) {
    var arr = g[k], parts = k.split('\u0001');
    var ord = sm_counts_(arr, function (s) { return sm_str_(sm_sf_(s, 'Order')); }).filter(function (kv) { return kv[0]; });
    o.add([parts[0] || '(미기록)', parts[1] === '' ? '(미기록)' : sm_numOrStr_(parts[1]), ord.length ? ord[0][0] : '', arr.length,
      arr.filter(function (s) { return s.complete; }).length,
      arr.filter(function (s) { return s.complete && !s.reason; }).length]);
  });
  o.gap();
  o.head(['CaseKey', '환자', '모델', '완료 케이스 (분석 포함)', '세션 내 1번째', '세션 내 2번째', '이어서 평가 세션 (GlobalCaseOrder ≥ 3)', '완료 케이스 (전체: 파일럿·중복 포함)']);
  var ck = sm_caseKeys_(D.cases);
  if (!ck.length) o.add(['(완료 케이스 없음)']);
  ck.forEach(function (k) {
    var all = D.cases.filter(function (c) { return c.key === k; });
    var inc = all.filter(function (c) { return c.included; });
    o.add([k, all[0].patient, D.modelName[all[0].model] || all[0].model, inc.length,
      inc.filter(function (c) { return c.caseOrder === 1; }).length,
      inc.filter(function (c) { return c.caseOrder === 2; }).length,
      inc.filter(function (c) { return sm_num_(c.row.GlobalCaseOrder) >= 3; }).length, all.length]);
  });
  o.gap();
}

// [4] 주 결과 -----------------------------------------------------
function sm_s4_(o, D) {
  var hdr = ['n', '평균', 'SD', '중앙값', 'Q1', 'Q3', '1점', '2점', '3점', '4점', '5점', '수용 비율 (I-CVI)', '95% CI 하한',
    '95% CI 상한', 'Pc', 'k*', 'k* 판정'];
  o.title('[4] 주 결과 — 임상 수용성 (5점 척도, 수용 = 4점 이상)');
  o.note('이 표의 I-CVI = 4점 이상 비율(= 수용 비율). 95% CI = Wilson. k* = Polit(2007) 수정 카파: Pc = C(N,A)·0.5^N (N = 평정 수, A = 4점 이상 수), k* = (I-CVI − Pc)/(1 − Pc); 판정 k* > .74 우수, .60–.74 양호, .40–.59 보통, < .40 미흡.');
  o.sub('[4-1] 모델 × Phase');
  o.head(['모델', 'Phase'].concat(hdr));
  var groups = sm_models_(D).concat([{ key: '*', name: '전체' }]);
  var scvi = [];
  groups.forEach(function (g) {
    var sub = D.inc.phases.filter(function (p) { return g.key === '*' || p.c.model === g.key; });
    var ic = [];
    PHASE_KEYS.forEach(function (k) {
      var st = sm_scoreStats_(sm_scoresOf_(sub, k));
      ic.push(st.n ? st.icvi : NaN);
      o.add([g.name, PHASE_LABEL[k]].concat(sm_statCells_(st)));
    });
    scvi.push([g.name, ic]);
  });
  o.gap();
  o.sub('[4-2] 모델별 S-CVI');
  o.head(['모델', 'Phase 수', 'S-CVI/Ave (Phase I-CVI 평균)', 'S-CVI/UA (I-CVI = 1 인 Phase 비율)', 'P1 I-CVI', 'P2 I-CVI', 'P3 I-CVI', 'P4 I-CVI', 'P5 I-CVI']);
  scvi.forEach(function (x) {
    var v = x[1].filter(sm_fin_);
    var ua = v.filter(function (q) { return q === 1; }).length;
    o.add([x[0], v.length, v.length ? r3_(mean_(v)) : '', v.length ? r3_(ua / v.length) : ''].concat(x[1].map(r3_)));
  });
  o.gap();
  o.sub('[4-3] 케이스 (CaseKey) × Phase');
  o.head(['CaseKey', 'Phase'].concat(hdr));
  var ck = sm_caseKeys_(D.inc.cases);
  if (!ck.length) o.add(['(분석 포함 케이스 없음)']);
  ck.forEach(function (key) {
    var sub = D.inc.phases.filter(function (p) { return p.c.key === key; });
    PHASE_KEYS.forEach(function (k) { o.add([key, PHASE_LABEL[k]].concat(sm_statCells_(sm_scoreStats_(sm_scoresOf_(sub, k))))); });
  });
  o.gap();
}

function sm_scoreStats_(sc) {
  var n = sc.length, dist = [0, 0, 0, 0, 0];
  sc.forEach(function (v) { dist[v - 1]++; });
  var a = dist[3] + dist[4], ci = sm_wilson_(a, n), kp = sm_kappa_(n, a);
  return {
    n: n, mean: n ? mean_(sc) : NaN, sd: n > 1 ? sd_(sc) : NaN, med: n ? median_(sc) : NaN,
    q1: sm_q_(sc, 0.25), q3: sm_q_(sc, 0.75), dist: dist, a: a, icvi: n ? a / n : NaN,
    lo: ci[0], hi: ci[1], pc: kp.pc, k: kp.k, label: kp.label
  };
}

function sm_statCells_(st) {
  return [st.n, r2_(st.mean), r2_(st.sd), r2_(st.med), r2_(st.q1), r2_(st.q3)].concat(st.dist)
    .concat([r3_(st.icvi), r3_(st.lo), r3_(st.hi), sm_round_(st.pc, 4), r3_(st.k), st.label]);
}

// [5] 모델 비교 (평가자 내) -------------------------------------------
function sm_s5_(o, D) {
  var pr = sm_modelPair_(D);
  o.title('[5] 모델 비교 (평가자 내) — ' + (pr ? pr.a.name + ' − ' + pr.b.name : '두 모델 자료 필요'));
  if (!pr) { o.note('두 모델을 모두 평가한 자료가 없습니다.'); o.gap(); return; }
  var units = sm_pairUnits_(D, pr);
  o.head(['Phase', '쌍 n', '평균 차이', 'SD', '중앙값 차이', pr.a.name + ' 높음 비율', '같음 비율', pr.a.name + ' 낮음 비율']);
  var all = [];
  PHASE_KEYS.forEach(function (k) {
    var d = sm_pairDiffs_(units, k);
    all = all.concat(d);
    o.add([PHASE_LABEL[k]].concat(sm_diffCells_(d)));
  });
  o.add(['전체 (모든 Phase 쌍)'].concat(sm_diffCells_(all)));
  o.add(['평가자 × Type 단위 수', units.length]);
  o.note('평가자 × StudyType 안에서 두 모델(GPT 1건, DeepSeek 1건)을 모두 평가한 경우만 짝지었습니다(차이 = ' + pr.a.name + ' − ' + pr.b.name +
    '). 기술 통계이며, 추론은 AnalysisLong 으로 R 의 누적 링크 혼합모형(CLMM: Score ~ Model + Phase + CaseOrder + (1|EvaluatorCode) + (1|PatientId))에서 수행합니다.');
  o.gap();
}

function sm_modelPair_(D) {
  var ms = sm_models_(D);
  var find = function (k) { for (var i = 0; i < ms.length; i++) if (ms[i].key === k) return ms[i]; return null; };
  if (find('gpt') && find('deepseek')) return { a: find('gpt'), b: find('deepseek') };
  return ms.length >= 2 ? { a: ms[0], b: ms[1] } : null;
}

function sm_pairUnits_(D, pr) {
  var g = {}, keys = [];
  D.inc.cases.forEach(function (c) {
    var k = c.sess.ident + '\u0001' + c.sess.type;
    if (!sm_has_(g, k)) { g[k] = {}; keys.push(k); }
    if (!sm_has_(g[k], c.model)) g[k][c.model] = c;
  });
  return keys.filter(function (k) { return g[k][pr.a.key] && g[k][pr.b.key]; })
    .map(function (k) { return { a: g[k][pr.a.key], b: g[k][pr.b.key] }; });
}

function sm_pairDiffs_(units, k) {
  var out = [];
  units.forEach(function (u) {
    var i = PHASE_KEYS.indexOf(k), sa = u.a.phases[i].score, sb = u.b.phases[i].score;
    if (sm_fin_(sa) && sm_fin_(sb)) out.push(sa - sb);
  });
  return out;
}

function sm_diffCells_(d) {
  var n = d.length;
  var cnt = function (f) { return d.filter(f).length; };
  return [n, n ? r2_(mean_(d)) : '', n > 1 ? r2_(sd_(d)) : '', n ? r2_(median_(d)) : '',
    n ? r3_(cnt(function (x) { return x > 0; }) / n) : '', n ? r3_(cnt(function (x) { return x === 0; }) / n) : '',
    n ? r3_(cnt(function (x) { return x < 0; }) / n) : ''];
}

// [6] 평가자 간 일치도 ------------------------------------------------
function sm_s6_(o, D) {
  o.title('[6] 평가자 간 일치도 — TargetKey (출력 × 조합 × Phase) 단위');
  o.head(['TargetKey', 'CaseKey', '모델', 'Phase', '조합 (AI 순위)', '평가자 n', '평균', 'SD', '수용 비율', 'rWG', '이분(≥4) 쌍 일치율']);
  var T = sm_targets_(D);
  if (!T.length) o.add(['(분석 포함 평정 없음)']);
  var rw = [], pa = [];
  T.forEach(function (t) {
    var sc = t.scores, n = sc.length, a = sc.filter(function (v) { return v >= 4; }).length;
    var rwg = sm_rwg_(sc), agree = sm_pairAgree_(n, a);
    if (sm_fin_(rwg)) rw.push(rwg);
    if (sm_fin_(agree)) pa.push(agree);
    var p0 = t.phases[0];
    o.add([t.key, p0.c.key, D.modelName[p0.c.model] || p0.c.model, p0.P, p0.k === 'p1' ? '' : (sm_fin_(p0.c.rank) ? 'C' + p0.c.rank : ''),
      n, r2_(mean_(sc)), n > 1 ? r2_(sd_(sc)) : '', r3_(a / n), r3_(rwg), r3_(agree)]);
  });
  o.add(['요약 (평가자 n ≥ 2 인 대상)', '대상 수', rw.length, 'rWG 중앙값', rw.length ? r3_(median_(rw)) : '', '쌍 일치율 평균', pa.length ? r3_(mean_(pa)) : '']);
  o.note('rWG = 1 − s²/σ²EU (σ²EU = 2: 5점 균등분포, s² = 표본분산, 0 미만은 0, 평가자 2명 이상). 쌍 일치율 = 4점 이상 여부가 같은 평가자 쌍의 비율. Gwet AC2 · Krippendorff α 는 AnalysisLong 으로 R 에서 계산합니다.');
  o.gap();
}

function sm_targets_(D) {
  var g = {}, keys = [];
  sm_scored_(D.inc.phases).forEach(function (p) {
    if (!sm_has_(g, p.target)) { g[p.target] = { key: p.target, phases: [], scores: [] }; keys.push(p.target); }
    g[p.target].phases.push(p);
    g[p.target].scores.push(p.score);
  });
  return keys.map(function (k) { return g[k]; }).sort(function (x, y) {
    var a = x.phases[0], b = y.phases[0];
    return sm_cmpStr_(a.c.key, b.c.key) || sm_cmpStr_(a.P, b.P) || sm_cmpNum_(a.c.rank, b.c.rank) || sm_cmpStr_(x.key, y.key);
  });
}

// [7] 하위군 -------------------------------------------------------
function sm_s7_(o, D) {
  o.title('[7] 하위군 — Phase 별 수용 비율(≥4)과 평균');
  var hdr = ['변수', '수준', '평가자 n', '평정 n'];
  PHASE_KEYS.forEach(function (k) { hdr.push(k.toUpperCase() + ' 수용 비율', k.toUpperCase() + ' 평균'); });
  o.head(hdr);
  var P = sm_scored_(D.inc.phases);
  var band = function (c) { return !sm_fin_(c) ? '' : c <= 2 ? SM_TRUST_BANDS[0] : c === 3 ? SM_TRUST_BANDS[1] : SM_TRUST_BANDS[2]; };
  [
    ['직군', function (p) { return p.sess.ev.role; }, SM_ROLE_ORDER],
    ['제2형 당뇨병 진료량', function (p) { return p.sess.ev.t2d.label; }, SM_OPT.t2d_volume],
    ['AI 도구 사용 빈도', function (p) { return p.sess.ev.aiUse.label; }, SM_OPT.ai_use],
    ['AI 신뢰 (밴드)', function (p) { return band(p.sess.ev.aiTrust.code); }, SM_TRUST_BANDS],
    ['기기 (FormFactor, 세션)', function (p) { return sm_str_(sm_sf_(p.sess, 'FormFactor')); }, ['mobile', 'tablet', 'desktop']]
  ].forEach(function (v) {
    var g = {}, keys = [];
    P.forEach(function (p) {
      var k = sm_str_(v[1](p)) || '(미응답)';
      if (!sm_has_(g, k)) { g[k] = []; keys.push(k); }
      g[k].push(p);
    });
    if (!keys.length) { o.add([v[0], '(자료 없음)']); return; }
    sm_orderKeys_(keys, v[2]).forEach(function (k, i) {
      var arr = g[k];
      var row = [i ? '' : v[0], k, sm_uniqCount_(arr.map(function (p) { return p.sess.ev.ident; })), arr.length];
      PHASE_KEYS.forEach(function (ph) {
        var sc = sm_scoresOf_(arr, ph);
        row.push(sc.length ? r3_(sc.filter(function (x) { return x >= 4; }).length / sc.length) : '', sc.length ? r2_(mean_(sc)) : '');
      });
      o.add(row);
    });
  });
  o.note('단위 = Phase 평정. 평가자 특성은 첫 포함 세션 기준, 기기는 각 세션 기준. 작은 하위군은 해석에 주의하세요.');
  o.gap();
}

// [8] 조합 선택 -----------------------------------------------------
function sm_s8_(o, D) {
  var C = D.inc.cases;
  o.title('[8] 조합 선택 — AI 1순위 조합 선택률 (화면 순서 = AI 순위)');
  o.head(['구분', 'CaseKey', '모델', '순위 단서 표시', 'n', 'AI 1순위', '2순위', '3순위', 'AI 1순위 선택률', '95% CI 하한', '95% CI 상한', '정확 이항 p (단측, H0: 1/3)']);
  var cueText = function (b) { return b === true ? '있음' : b === false ? '없음' : '(미기록)'; };
  var row = function (label, key, model, cue, arr) {
    var r = arr.filter(function (c) { return c.rank >= 1 && c.rank <= 3; });
    var d = [1, 2, 3].map(function (x) { return r.filter(function (c) { return c.rank === x; }).length; });
    var n = r.length, ci = sm_wilson_(d[0], n);
    o.add([label, key, model, cue, n, d[0], d[1], d[2], n ? r3_(d[0] / n) : '', r3_(ci[0]), r3_(ci[1]), sm_pText_(sm_binomUpper_(d[0], n, 1 / 3))]);
  };
  sm_caseKeys_(C).forEach(function (k) {
    var arr = C.filter(function (c) { return c.key === k; });
    row('CaseKey', k, D.modelName[arr[0].model] || arr[0].model, cueText(sm_mode_(arr.map(function (c) { return c.rankCue; }))), arr);
  });
  [true, false, null].forEach(function (b) {
    var arr = C.filter(function (c) { return c.rankCue === b; });
    if (arr.length) row('순위 단서별', '', '', cueText(b), arr);
  });
  row('전체', '', '', '', C);
  o.note('p = P(X ≥ k | n, 1/3): 우연(1/3)보다 AI 1순위를 더 자주 고르는지에 대한 단측 정확 이항 검정. 화면 순서가 AI 순위와 같으므로 첫 위치 효과와 구분되지 않습니다.');
  o.gap();

  o.sub('[8-2] 처방 의향 (Case_would_prescribe)');
  o.head(['모델', '응답 n', '그대로 처방', '일부 수정', '처방할 조합 없음', '그대로 비율', '수정 비율', '없음 비율']);
  sm_models_(D).concat([{ key: '*', name: '전체' }]).forEach(function (m) {
    var arr = C.filter(function (c) { return (m.key === '*' || c.model === m.key) && c.would.code >= 1 && c.would.code <= 3; });
    var d = [1, 2, 3].map(function (x) { return arr.filter(function (c) { return c.would.code === x; }).length; });
    var n = arr.length;
    o.add([m.name, n, d[0], d[1], d[2], n ? r3_(d[0] / n) : '', n ? r3_(d[1] / n) : '', n ? r3_(d[2] / n) : '']);
  });
  o.gap();
  o.sub('[8-3] 조합 탐색');
  o.head(['모델', '케이스 n', '조합 변경(ComboResets > 0) n', '비율', '세 조합 모두 노출 판정 가능 n', '세 조합 모두 노출 n', '비율']);
  sm_models_(D).concat([{ key: '*', name: '전체' }]).forEach(function (m) {
    var arr = C.filter(function (c) { return m.key === '*' || c.model === m.key; });
    var rs = arr.filter(function (c) { return sm_fin_(c.resets); });
    var rp = rs.filter(function (c) { return c.resets > 0; }).length;
    var sv = arr.filter(function (c) { return c.seenAll !== null; });
    var sa = sv.filter(function (c) { return c.seenAll === true; }).length;
    o.add([m.name, arr.length, rp, rs.length ? r3_(rp / rs.length) : '', sv.length, sa, sv.length ? r3_(sa / sv.length) : '']);
  });
  o.gap();
}

// [9] 안전성 -------------------------------------------------------
function sm_s9_(o, D) {
  var C = D.inc.cases;
  o.title('[9] 안전성 — 환자 위해 가능성 (Case_harm: 없음 / 경미 / 중대)');
  o.head(['구분', '대상', '응답 n', '없음', '경미', '중대', '위해 가능성 비율 (경미 + 중대)', '95% CI 하한', '95% CI 상한', '중대 비율']);
  var row = function (label, name, arr) {
    var h = arr.filter(function (c) { return c.harm.code >= 1 && c.harm.code <= 3; });
    var d = [1, 2, 3].map(function (x) { return h.filter(function (c) { return c.harm.code === x; }).length; });
    var n = h.length, any = d[1] + d[2], ci = sm_wilson_(any, n);
    o.add([label, name, n, d[0], d[1], d[2], n ? r3_(any / n) : '', r3_(ci[0]), r3_(ci[1]), n ? r3_(d[2] / n) : '']);
  };
  sm_models_(D).forEach(function (m) { row('모델', m.name, C.filter(function (c) { return c.model === m.key; })); });
  sm_caseKeys_(C).forEach(function (k) { row('CaseKey', k, C.filter(function (c) { return c.key === k; })); });
  row('전체', '', C);
  o.gap();
  o.sub('[9-2] 위해 가능 Phase (HarmInPhase)');
  o.head(['Phase', '판정 가능 케이스', '해당 Phase 지목 n', '비율 (판정 가능 대비)', '비율 (분석 포함 케이스 대비)']);
  PHASE_KEYS.forEach(function (k) {
    var P = D.inc.phases.filter(function (p) { return p.k === k; });
    var ev = P.filter(function (p) { return sm_fin_(p.harmIn); });
    var hit = ev.filter(function (p) { return p.harmIn === 1; }).length;
    o.add([PHASE_LABEL[k], ev.length, hit, ev.length ? r3_(hit / ev.length) : '', P.length ? r3_(hit / P.length) : '']);
  });
  o.note('HarmInPhase = 1: 위해 가능성(경미 이상)에서 해당 Phase 를 지목, 0: 다른 Phase 만 지목했거나 위해 없음, 빈칸: 위해 Phase 를 고르지 않음(판정 불가).');
  o.gap();
  o.sub('[9-3] 중대한 위해 가능성 응답 목록 (테스트 외 완료 케이스 전체)');
  o.head(['CaseKey', '평가자 코드', '위해 수준', '지목 Phase', '분석 포함', '케이스 의견 (최대 200자)']);
  var major = D.cases.filter(function (c) { return c.harm.code === 3; });
  if (!major.length) o.add(['(없음)']);
  major.forEach(function (c) {
    o.add([c.key, c.sess.pcode, c.harm.label || SM_OPT.harm[2], c.harmPhases.join(';'), c.included ? '예' : '아니오 (' + c.reason + ')',
      c.comment.length > 200 ? c.comment.slice(0, 200) + '…' : c.comment]);
  });
  o.gap();
}

// [10] 활용 의향 ----------------------------------------------------
function sm_s10_(o, D) {
  o.title('[10] 활용 의향 (End_intent_use, 1 전혀 그렇지 않다 … 5 매우 그렇다) — 세션 단위');
  o.head(['직군', '응답 세션 n', '1', '2', '3', '4', '5', '4점 이상 비율', '중앙값']);
  var S = D.inc.sessions.filter(function (s) { return s.intent >= 1 && s.intent <= 5; });
  var roles = sm_orderKeys_(sm_uniq_(S.map(function (s) { return s.ev.role || '(미응답)'; })), SM_ROLE_ORDER);
  roles.concat(['전체']).forEach(function (r) {
    var arr = S.filter(function (s) { return r === '전체' || (s.ev.role || '(미응답)') === r; });
    var v = arr.map(function (s) { return Math.round(s.intent); });
    var d = [1, 2, 3, 4, 5].map(function (x) { return v.filter(function (y) { return y === x; }).length; });
    o.add([r, v.length].concat(d).concat([v.length ? r3_((d[3] + d[4]) / v.length) : '', v.length ? r2_(median_(v)) : '']));
  });
  o.gap();
  o.head(['Spearman 순위 상관 (평가자 단위)', 'n (평가자)', 'rho']);
  var E = D.inc.evals, ms = E.map(function (e) { return e.meanScore; });
  var a = sm_spearman_(E.map(function (e) { return e.aiTrust.code; }), ms);
  var b = sm_spearman_(E.map(function (e) { return e.intent; }), ms);
  o.add(['AI 신뢰 (ai_trust_code) vs 평가자 평균 점수', a.n, r3_(a.rho)]);
  o.add(['활용 의향 (End_intent_use_code) vs 평가자 평균 점수', b.n, r3_(b.rho)]);
  o.note('평가자 평균 점수 = 분석 포함 Phase 점수(P1–P5)의 평균. 활용 의향은 평가자의 포함 세션 값 평균. 동점은 평균 순위. n < 3 이면 계산하지 않습니다.');
  o.gap();
}

// [11] 소요 시간 · 읽기 노력 ------------------------------------------
function sm_s11_(o, D) {
  var C = D.inc.cases, models = sm_models_(D).concat([{ key: '*', name: '전체' }]);
  var inModel = function (m) { return function (c) { return m.key === '*' || c.model === m.key; }; };
  o.title('[11] 소요 시간 · 읽기 노력 (표시 시간 = active + idle, hidden 제외)');
  o.head(['지표', '대상', 'n', '중앙값', 'Q1', 'Q3', '최소', '최대']);
  var mins = D.inc.sessions.filter(function (s) { return s.complete; }).map(function (s) {
    return sm_sumNum_([sm_sf_(s, 'TotalActiveMin'), sm_sf_(s, 'TotalIdleMin')]);
  }).filter(sm_fin_);
  o.add(sm_descRow_('세션 총 표시 시간 (분)', '완료 세션', mins, 1));
  models.forEach(function (m) {
    o.add(sm_descRow_('케이스 표시 시간 (초)', m.name, C.filter(inModel(m)).map(function (c) { return c.vis; }).filter(sm_fin_), 1));
  });
  var readSteps = ['p1', 'combo', 'p2', 'p3', 'p4', 'p5'];
  models.forEach(function (m) {
    var v = C.filter(inModel(m)).map(function (c) {
      var sec = 0, ch = 0;
      readSteps.forEach(function (st) {
        var s1 = sm_num_(c.row['Sec_' + STEP_COL[st]]), c1 = sm_num_(c.row['Chars_' + STEP_COL[st]]);
        if (sm_fin_(s1) && sm_fin_(c1)) { sec += s1; ch += c1; }
      });
      return ch > 0 ? sec / ch * 1000 : NaN;
    }).filter(sm_fin_);
    o.add(sm_descRow_('1,000자당 표시 시간 (초; P1·조합·P2–P5)', m.name, v, 1));
  });
  o.gap();
  o.head(['단계', 'n', '표시 시간 중앙값 (초)', 'Q1', 'Q3', '첫 응답까지 중앙값 (초, TTFR)', '응답 변경 ≥ 1 비율']);
  STEPS.forEach(function (st) {
    var col = STEP_COL[st], pi = PHASE_KEYS.indexOf(st), hasResp = st !== 'vignette' && st !== 'comment';
    var get = function (c, prefix, field) {
      var v = sm_num_(c.row[prefix + col]);
      return (!sm_fin_(v) && pi >= 0) ? c.phases[pi][field] : v;
    };
    var secs = C.map(function (c) { return get(c, 'Sec_', 'vis'); }).filter(sm_fin_);
    var tt = hasResp ? C.map(function (c) { return get(c, 'TTFR_', 'ttfr'); }).filter(sm_fin_) : [];
    var chg = hasResp ? C.map(function (c) { return get(c, 'Changes_', 'changes'); }).filter(sm_fin_) : [];
    o.add([SM_STEP_KO[st], secs.length, r1_(median_(secs)), r1_(sm_q_(secs, 0.25)), r1_(sm_q_(secs, 0.75)),
      tt.length ? r1_(median_(tt)) : '', chg.length ? r3_(chg.filter(function (x) { return x >= 1; }).length / chg.length) : '']);
  });
  o.gap();
  o.head(['읽기 속도 중앙값 (자/초)', 'P1', 'P2', 'P3', 'P4', 'P5', '전체 Phase']);
  models.forEach(function (m) {
    var P = D.inc.phases.filter(function (p) { return m.key === '*' || p.c.model === m.key; });
    var row = [m.name];
    PHASE_KEYS.forEach(function (k) {
      var v = P.filter(function (p) { return p.k === k; }).map(function (p) { return p.cps; }).filter(sm_fin_);
      row.push(v.length ? r1_(median_(v)) : '');
    });
    var all = P.map(function (p) { return p.cps; }).filter(sm_fin_);
    row.push(all.length ? r1_(median_(all)) : '');
    o.add(row);
  });
  o.gap();
  o.head(['기타 지표', '값', '해당 n', '분모']);
  var ch = D.inc.phases.filter(function (p) { return sm_fin_(p.changes); });
  var chn = ch.filter(function (p) { return p.changes >= 1; }).length;
  o.add(['응답을 1회 이상 바꾼 Phase 비율', ch.length ? r3_(chn / ch.length) : '', chn, ch.length]);
  var dw = C.filter(function (c) { return sm_fin_(c.drawerOpens); });
  var users = dw.filter(function (c) { return c.drawerOpens > 0; });
  o.add(['환자 정보 서랍을 연 케이스 비율', dw.length ? r3_(users.length / dw.length) : '', users.length, dw.length]);
  var ds = users.map(function (c) { return c.drawerSec; }).filter(sm_fin_);
  o.add(['서랍 사용 케이스의 열람 시간 중앙값 (초)', ds.length ? r1_(median_(ds)) : '', ds.length, '']);
  o.gap();
}

function sm_descRow_(label, target, v, d) {
  if (!v.length) return [label, target, 0];
  return [label, target, v.length, sm_round_(median_(v), d), sm_round_(sm_q_(v, 0.25), d), sm_round_(sm_q_(v, 0.75), d),
    sm_round_(Math.min.apply(null, v), d), sm_round_(Math.max.apply(null, v), d)];
}

// [12] 데이터 품질 --------------------------------------------------
function sm_s12_(o, D) {
  var P = D.inc.phases, C = D.inc.cases, S = D.inc.sessions;
  o.title('[12] 데이터 품질 — 플래그(제외하지 않음)와 민감도 분석, 분석 포함 자료 기준');
  o.head(['플래그', '단위', '정의', '판정 가능 n', '해당 n', '비율']);
  var fr = function (name, unit, def, vals) {
    var ev = vals.filter(function (v) { return v === 0 || v === 1; });
    var hit = ev.filter(function (v) { return v === 1; }).length;
    o.add([name, unit, def, ev.length, hit, ev.length ? r3_(hit / ev.length) : '']);
  };
  var R = SM_RULE;
  fr('SpeederFlag', 'Phase', '글자 수/표시 시간 > ' + R.cps + '자/초 또는 표시 시간 < ' + R.minSec + '초', P.map(function (p) { return p.speeder; }));
  fr('RatedBeforeReadFlag', 'Phase', '첫 응답 시점 스크롤 < ' + R.scrollMin + '%', P.map(function (p) { return p.rbr; }));
  fr('CaseSpeeder', '케이스', '케이스 표시 시간 < ' + R.caseFrac + ' × 중앙값 (' + r1_(D.caseVisMedian) + '초)', C.map(function (c) { return c.caseSpeeder; }));
  fr('HiddenHeavyFlag', '케이스', 'CaseHiddenSec > ' + R.hiddenFrac + ' × CaseWallSec', C.map(function (c) { return c.hiddenHeavy; }));
  fr('StraightlineFlag', '세션', '평정 ' + R.straightMin + '개 이상이 모두 같은 점수', S.map(function (s) { return s.straight; }));
  fr('플래그 1개 이상', 'Phase', '위 5개 중 하나라도 해당', P.map(function (p) { return p.anyFlag; }));
  o.gap();
  o.head(['세션 지표', '해당 세션 n', '분석 포함 세션 n', '비율']);
  var sr = function (label, f) { var h = S.filter(f).length; o.add([label, h, S.length, S.length ? r3_(h / S.length) : '']); };
  sr('SeqSource = local (서버 대신 기기에서 순서 배정)', function (s) { return sm_str_(sm_sf_(s, 'SeqSource')).toLowerCase() === 'local'; });
  sr('Resumes ≥ 1 (재접속하여 이어감)', function (s) { return sm_num_(sm_sf_(s, 'Resumes')) >= 1; });
  sr('SendFailures ≥ 1 (전송 실패 후 재전송)', function (s) { return sm_num_(sm_sf_(s, 'SendFailures')) >= 1; });
  o.gap();
  o.sub('[12-2] 민감도 분석 — 수용 비율(≥4), 플래그가 붙은 Phase 평정 제외 시');
  o.head(['대상', '전체 n', '전체 수용 비율', '플래그 제외 n', '플래그 제외 수용 비율', '차이 (제외 − 전체)']);
  var sens = function (label, arr, flagFn) {
    var a = sm_scored_(arr), b = a.filter(function (p) { return flagFn(p) !== 1; });
    var ra = a.length ? sm_accRate_(a) : NaN, rb = b.length ? sm_accRate_(b) : NaN;
    o.add([label, a.length, r3_(ra), b.length, r3_(rb), (sm_fin_(ra) && sm_fin_(rb)) ? r3_(rb - ra) : '']);
  };
  var any = function (p) { return p.anyFlag; };
  sm_models_(D).concat([{ key: '*', name: '전체' }]).forEach(function (m) {
    sens(m.name + ' — 플래그 1개 이상 제외', P.filter(function (p) { return m.key === '*' || p.c.model === m.key; }), any);
  });
  [['SpeederFlag', function (p) { return p.speeder; }], ['RatedBeforeReadFlag', function (p) { return p.rbr; }],
    ['CaseSpeeder', function (p) { return p.c.caseSpeeder; }], ['HiddenHeavyFlag', function (p) { return p.c.hiddenHeavy; }],
    ['StraightlineFlag', function (p) { return p.sess.straight; }]].forEach(function (f) {
    sens('전체 — ' + f[0] + ' 만 제외', P, f[1]);
  });
  o.gap();
}

// [13] 정성 자료 ----------------------------------------------------
function sm_s13_(o, D) {
  var C = D.inc.cases;
  o.title('[13] 정성 자료');
  o.head(['지표', '값', '해당 n', '분모']);
  var cm = C.filter(function (c) { return c.comment !== ''; });
  o.add(['케이스 의견을 남긴 비율', C.length ? r3_(cm.length / C.length) : '', cm.length, C.length]);
  o.add(['케이스 의견 길이 중앙값 (글자)', cm.length ? median_(cm.map(function (c) { return c.comment.length; })) : '', cm.length, '']);
  var S = D.inc.sessions.filter(function (s) { return s.complete; });
  var oc = S.filter(function (s) { return sm_str_(sm_sf_(s, 'OverallComment')) !== ''; }).length;
  o.add(['전체 의견을 남긴 완료 세션 비율', S.length ? r3_(oc / S.length) : '', oc, S.length]);
  o.note('의견 원문은 Responses.CaseComment, Sessions.OverallComment 에 있습니다(이 요약에는 [9-3] 중대한 위해 응답의 의견만 표시).');
  o.gap();
}

// [14] 가이드라인 부합도 연결 -------------------------------------------
function sm_s14_(o, D) {
  o.title('[14] 가이드라인 부합도 연결 (Concordance 시트: TargetKey, ConcordanceScore)');
  var conc = {}, ckeys = [];
  D.C.rows.forEach(function (r) {
    var k = sm_str_(r.TargetKey), v = sm_num_(r.ConcordanceScore);
    if (!k || !sm_fin_(v)) return;
    if (!sm_has_(conc, k)) ckeys.push(k);
    conc[k] = v;
  });
  if (!ckeys.length) {
    o.note('Concordance 시트에 TargetKey(예: P051_deepseek|P1, P051_deepseek|C2|P3)와 ConcordanceScore 를 입력하면 의사 평정과 나란히 표시됩니다.');
    o.gap();
    return;
  }
  var T = sm_targets_(D), tby = {};
  T.forEach(function (t) { tby[t.key] = t; });
  o.head(['TargetKey', 'ConcordanceScore', '평가자 n', '평균 점수', '수용 비율']);
  var xs = [], ym = [], ya = [];
  ckeys.sort().forEach(function (k) {
    var t = sm_has_(tby, k) ? tby[k] : null;
    var n = t ? t.scores.length : 0;
    var m = n ? mean_(t.scores) : NaN, a = n ? t.scores.filter(function (v) { return v >= 4; }).length / n : NaN;
    if (n) { xs.push(conc[k]); ym.push(m); ya.push(a); }
    o.add([k, conc[k], n, r2_(m), r3_(a)]);
  });
  var s1 = sm_spearman_(xs, ym), s2 = sm_spearman_(xs, ya);
  o.head(['Spearman 순위 상관 (TargetKey 단위)', 'n (대상)', 'rho']);
  o.add(['ConcordanceScore vs 평균 점수', s1.n, r3_(s1.rho)]);
  o.add(['ConcordanceScore vs 수용 비율', s2.n, r3_(s2.rho)]);
  var miss = T.filter(function (t) { return !sm_has_(conc, t.key); });
  o.sub('부합도 점수가 없는 평정 대상 (' + miss.length + '개)');
  if (miss.length) o.head(['TargetKey', '평가자 n']);
  miss.forEach(function (t) { o.add([t.key, t.scores.length]); });
  o.gap();
}

// [15] 방법 기술용 문구 ---------------------------------------------
function sm_s15_(o, D) {
  var started = D.pool.length, done = D.pool.filter(function (s) { return s.complete; }).length;
  var dev = sm_uniqCount_(D.visits.map(function (v) { return sm_str_(v.DeviceId); }));
  var pct = started ? r1_(100 * done / started) : 0;
  var types = sm_uniq_(D.pool.map(function (s) { return s.type; }).filter(function (t) { return t; })).sort();
  o.title('[15] 방법 기술용 자동 문구 (수치는 현재 자료 기준)');
  var t = [];
  t.push('본 연구는 QR 코드와 링크로 배포한 개방형 웹 설문(open web survey)으로 수행하였다. ' +
    (D.V.exists ? '자료 수집 기간 중 고유 기기 ' + dev + '대에서 소개 화면 조회가 ' + D.visits.length + '회 있었고, ' : '') +
    '평가 세션 ' + started + '건이 시작되어 ' + done + '건이 완료되었다(완료율 ' + pct + '%).');
  t.push('평가자는 ' + (types.length ? 'Type ' + types.join('/') + ' ' : '') + '중 하나를 선택하여 가상 환자 2명에 대한 AI 답변 2건(두 모델 각 1건, 모델명 비공개)을 평가하였고, Type 안의 제시 순서는 서버가 균형 배정하였다.');
  t.push('각 케이스는 환자 정보, Phase 1, 치료 조합 선택, Phase 2–5, 의견의 8개 화면으로 구성되었으며, 평가 화면마다 하나의 평가 문항(5점 척도)만 제시하였다.');
  t.push('Phase 2–5 는 평가자가 선택한 치료 조합에 해당하는 AI 답변을 제시하는 적응형(adaptive) 구조이다.');
  t.push('평정 문항은 응답해야 다음 화면으로 넘어갈 수 있는 강제 응답(forced response)으로 설정하였고, 자유 의견은 선택 응답이었다.');
  t.push((D.includeTests ? '시험 응답도 포함하여 집계하였다. ' : '시험 응답 ' + D.excl.test.sessions + '개 세션은 분석에서 제외하였다. ') +
    '같은 평가자가 같은 Type 을 반복 응답한 ' + D.excl.duplicate.sessions + '개 세션은 최초 완료 세션만 남기고 제외하였으며, 파일럿 세션 ' +
    D.excl.pilot.sessions + '개는 주 분석에서 제외하였다.');
  t.push('최종 분석에는 평가자 ' + D.inc.evals.length + '명이 완료한 ' + D.inc.cases.length + '개 케이스의 Phase 평정 ' +
    sm_scored_(D.inc.phases).length + '건이 포함되었다. 응답 품질 지표(빠른 응답, 일자형 응답, 읽기 전 응답 등)는 제외 기준이 아니라 민감도 분석에 사용하였다.');
  t.forEach(function (x) { o.add([x]); });
  o.gap();
}

// ============================================================
// ANALYSIS LONG
// ============================================================
function sm_analysisLong_(D) {
  var rows = [SM_AL_COLS.slice()];
  var ph = D.phases.slice().sort(function (a, b) {
    return sm_cmpStr_(a.sess.pcode, b.sess.pcode) || sm_cmpNum_(a.sess.firstSeen, b.sess.firstSeen) ||
      (a.sess.ord - b.sess.ord) || sm_cmpNum_(a.c.caseOrder, b.c.caseOrder) || sm_cmpStr_(a.c.key, b.c.key) ||
      (PHASE_KEYS.indexOf(a.k) - PHASE_KEYS.indexOf(b.k));
  });
  ph.forEach(function (p) {
    var s = p.sess, c = p.c, o = c.row, e = s.ev;
    var r = {
      EvaluatorCode: s.pcode, EvaluatorId: s.evId, SessionId: s.id, SessionOrdinal: s.ordinal, StudyType: s.type,
      SequenceIndex: sm_numOrStr_(s.seq), CaseOrder: c.caseOrder, GlobalCaseOrder: sm_num_(o.GlobalCaseOrder),
      PatientId: c.patient, PatientSeenPrior: sm_b01_(o.PatientSeenPrior), Model: c.modelRaw || c.model, ModelName: c.modelNameRaw,
      CaseKey: c.key, ComboRankAI: c.rank, ComboKey: c.comboKey, RankCueVisible: sm_b01_(o.RankCueVisible),
      Phase: p.P, TargetKey: p.target, Score: p.score, Acceptable: p.acc, FirstScore: p.firstScore, Changed: p.changed,
      Role: e.role, ResidentYear: e.year, Major: e.major, Specialty: e.specialty, BoardYears: e.board.label,
      T2DVolume_code: e.t2d.code, AIUse_code: e.aiUse.code, AITrust_code: e.aiTrust.code,
      Src: sm_str_(sm_sf_(s, 'Src')), Site: sm_str_(sm_sf_(s, 'Site')), Wave: s.wave,
      FormFactor: sm_str_(sm_sf_(s, 'FormFactor')), InAppBrowser: sm_str_(sm_sf_(s, 'InAppBrowser')),
      VisibleSec: p.vis, ActiveOnlySec: p.activeOnly, TTFRSec: p.ttfr, Chars: p.chars, CharsPerSec: r2_(p.cps),
      ScrollAtFirstRating: p.scrollFR, HarmCode: c.harm.code, HarmInPhase: p.harmIn, WouldPrescribeCode: c.would.code,
      IntentUseCode: s.intent, SpeederFlag: p.speeder, CaseSpeeder: c.caseSpeeder, StraightlineFlag: s.straight,
      HiddenHeavyFlag: c.hiddenHeavy, RatedBeforeReadFlag: p.rbr, IncludedInAnalysis: c.included ? 1 : 0,
      ExclusionReason: c.reason, IsTest: s.isTest ? 1 : 0
    };
    rows.push(SM_AL_COLS.map(function (k) { return r[k]; }));
  });
  return rows;
}

// ============================================================
// CODEBOOK
// ============================================================
function sm_codebook_(D) {
  var rows = [['Sheet', 'Column', 'Description', 'Type/Coding', 'InSheet']];
  var defs = sm_cbDefs_();
  var lists = sm_cbLists_();
  var present = { Visits: D.V, Sessions: D.S, Responses: D.R, PhaseLong: D.L, RawJSON: D.raw, Concordance: D.C };
  var dyn = /^(Eval|Case|End)_/;
  Object.keys(lists).forEach(function (sheet) {
    var t = present[sheet], actual = t ? t.cols : [];
    var seen = {};
    var emit = function (col, inSheet) {
      if (sm_has_(seen, col)) return;
      seen[col] = 1;
      var d = (sm_has_(defs, sheet + '.' + col) && defs[sheet + '.' + col]) || (sm_has_(defs, col) && defs[col]) ||
        sm_cbPattern_(col) || sm_cbItem_(col) || ['(설명 없음 — 이전 버전 또는 추가 컬럼)', ''];
      rows.push([sheet, col, d[0], d[1], sheet === SM_ALONG ? 'Y' : (inSheet ? 'Y' : (t && t.exists ? 'N' : '(시트 없음)'))]);
    };
    lists[sheet].forEach(function (col) { emit(col, actual.indexOf(col) >= 0); });
    actual.filter(function (c) { return dyn.test(c); }).forEach(function (col) { emit(col, true); });
    actual.forEach(function (col) { emit(col, true); });
  });
  Object.keys(SM_ITEMS).forEach(function (id) {
    var it = SM_ITEMS[id];
    rows.push(['(문항 정의)', it[0] + id, it[1], it[2], '']);
    if (it[3]) rows.push(['(문항 정의)', it[0] + id + '_code', it[1] + ' — 코드', '정수 (선택지 순서, 1부터)', '']);
  });
  return rows;
}

var SM_ITEMS = {
  year: ['Eval_', '레지던트 년차', 'R1, R2, R3', true],
  major: ['Eval_', '레지던트 전공', '내과, 가정의학과, 기타 (직접 입력)', true],
  specialty: ['Eval_', '전문의 주 분야 (세부전문)', '목록 + 기타 (직접 입력); 코드 의미 없음', true],
  board_years: ['Eval_', '전문의 취득 후 연차', '5년 미만, 5–9년, 10–19년, 20년 이상', true],
  t2d_volume: ['Eval_', '제2형 당뇨병 환자 진료량', '월 1명 미만, 월 1–10명, 월 11–30명, 월 31명 이상', true],
  ai_use: ['Eval_', 'AI 도구 사용 빈도', '사용한 적 없음, 월 1회 미만, 월 1회–주 1회, 주 2회 이상, 거의 매일', true],
  ai_trust: ['Eval_', 'AI 신뢰 수준 (첫 세션에서 응답, 이어서 평가 시 승계)', '1 전혀 신뢰하지 않음 … 5 매우 신뢰함', true],
  harm: ['Case_', '환자 위해 가능성', '없음(1), 경미한 위해 가능성(2), 중대한 위해 가능성(3)', true],
  harm_phases: ['Case_', '위해 가능 Phase (위해 ≥ 2 일 때, 선택)', 'P1, COMBO, P2–P5 복수 선택, 세미콜론 구분 (예: P3;P4)', false],
  would_prescribe: ['Case_', '이 답변의 조합을 처방할 의향', '그대로 처방(1), 일부 수정하여 처방(2), 처방할 조합 없음(3)', true],
  intent_use: ['End_', '향후 진료에서 이 AI 를 활용할 의향', '1 전혀 그렇지 않다 … 5 매우 그렇다', true]
};

function sm_cbItem_(col) {
  var m = /^(Eval|Case|End)_(.+?)(_code)?$/.exec(col);
  if (!m) return null;
  var it = sm_has_(SM_ITEMS, m[2]) ? SM_ITEMS[m[2]] : null;
  var label = it ? it[1] : ({ Eval: '평가자 정보 항목', Case: '케이스별 보조 문항', End: '세션 종료 문항' })[m[1]] + ' ' + m[2];
  return m[3] ? [label + ' — 코드', '정수 (선택지 순서, 1부터)'] : [label, it ? it[2] : '문자열 (선택지 라벨)'];
}

function sm_cbPattern_(col) {
  var m = /^(Sec|TTFR|Changes|Scroll|Visits|ScrollAtFR|Chars)_(\w+)$/.exec(col);
  if (m) {
    var st = null;
    STEPS.forEach(function (s) { if (STEP_COL[s] === m[2]) st = s; });
    var nm = st ? SM_STEP_KO[st] : m[2];
    var d = {
      Sec: [nm + ' 화면 표시 시간 (active + idle, hidden 제외)', '실수 (초)'],
      TTFR: [nm + ' 화면 진입 후 첫 응답까지 시간', '실수 (초)'],
      Changes: [nm + ' 첫 응답 이후 응답을 바꾼 횟수', '정수'],
      Scroll: [nm + ' 최대 스크롤 도달률', '0–100 (%)'],
      Visits: [nm + ' 화면 방문 횟수', '정수'],
      ScrollAtFR: [nm + ' 첫 응답 시점의 스크롤 도달률', '0–100 (%)'],
      Chars: [nm + ' 화면 본문 글자 수', '정수']
    };
    return d[m[1]];
  }
  m = /^ComboSeen_(\d)$/.exec(col);
  if (m) return ['조합 ' + m[1] + ' 카드가 화면에 노출되었는지', 'TRUE/FALSE'];
  m = /^ComboDwellSec_(\d)$/.exec(col);
  if (m) return ['조합 ' + m[1] + ' 카드 노출 시간', '실수 (초)'];
  return null;
}

function sm_cbLists_() {
  var resp = ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear', 'StudyType',
    'SequenceIndex', 'SeqSource', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder', 'CaseKey', 'PatientId',
    'PatientSeenPrior', 'Model', 'ModelName', 'P1_Referral', 'ComboChoice', 'ComboName', 'ComboKey', 'ComboIsAIFirst', 'ComboRankAI',
    'RankCueVisible', 'P2_SharedDecision', 'P3_Pharmacotherapy', 'P4_FollowUp', 'P5_Education', 'CaseComment', 'CaseStartedAt',
    'CaseCompletedAt', 'CaseActiveSec', 'CaseIdleSec', 'CaseHiddenSec', 'CaseWallSec'];
  var six = ['p1', 'combo', 'p2', 'p3', 'p4', 'p5'];
  STEPS.forEach(function (s) { resp.push('Sec_' + STEP_COL[s]); });
  six.forEach(function (s) { resp.push('TTFR_' + STEP_COL[s]); });
  six.forEach(function (s) { resp.push('Changes_' + STEP_COL[s]); });
  STEPS.forEach(function (s) { resp.push('Scroll_' + STEP_COL[s]); });
  STEPS.forEach(function (s) { resp.push('Visits_' + STEP_COL[s]); });
  PHASE_KEYS.forEach(function (k) { resp.push('ScrollAtFR_' + STEP_COL[k]); });
  ['vignette'].concat(six).forEach(function (s) { resp.push('Chars_' + STEP_COL[s]); });
  resp = resp.concat(['ComboSeen_1', 'ComboSeen_2', 'ComboSeen_3', 'ComboDwellSec_1', 'ComboDwellSec_2', 'ComboDwellSec_3',
    'RxDetailsOpens', 'Interruptions', 'ComboResets', 'PatientDrawerOpens', 'PatientDrawerSec', 'AppVersion', 'DataVersion',
    'BackendVersion', 'MetricsJson']);
  return {
    Visits: ['ReceivedAt', 'VisitId', 'DeviceId', 'Src', 'Site', 'Wave', 'TypeParam', 'FormFactor', 'InAppBrowser', 'ReferrerOrigin',
      'IsTest', 'AppVersion'],
    Sessions: ['FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail',
      'ResidentYear', 'StudyType', 'SequenceIndex', 'SeqSource', 'Order', 'Status', 'CasesCompleted', 'LinkedSessionId',
      'EvaluatorId', 'EvaluatorCode', 'DeviceId', 'VisitId', 'SessionOrdinal', 'Src', 'Site', 'Wave', 'TypePreselected',
      'InAppBrowser', 'ReferrerOrigin', 'ConsentVersion', 'ConsentAt', 'ConsentInherited', 'InstrumentVersion', 'Incentive',
      'StartedAt', 'FinishedAt', 'TotalActiveMin', 'TotalIdleMin', 'TotalHiddenMin', 'TotalWallMin', 'IntroSec', 'FinalSec',
      'Resumes', 'Interruptions', 'SendFailures', 'FurthestCase', 'FurthestStep', 'LastActivityAt', 'PartialRatingsN',
      'OverallComment', 'FormFactor', 'ViewportW', 'ViewportH', 'ScreenW', 'ScreenH', 'DPR', 'TouchPoints', 'CoarsePointer',
      'Language', 'TimeZone', 'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion'],
    Responses: resp,
    PhaseLong: ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
      'StudyType', 'SequenceIndex', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder', 'CaseKey',
      'PatientId', 'PatientSeenPrior', 'Model', 'ModelName', 'ComboChoice', 'ComboKey', 'RankCueVisible', 'Phase', 'PhaseLabel',
      'TargetKey', 'Score', 'Acceptable_4plus', 'FirstScore', 'Changed', 'VisibleSec', 'ActiveOnlySec', 'TTFRSec', 'Changes',
      'ScrollPct', 'ScrollAtFirstRating', 'Chars', 'CharsPerSec', 'Visits', 'HarmInPhase'],
    RawJSON: ['ReceivedAt', 'Action', 'SessionId', 'MsgId', 'IsTest', 'Payload', 'ElapsedMs', 'Error'],
    Concordance: ['TargetKey', 'ConcordanceScore'],
    AnalysisLong: SM_AL_COLS.slice()
  };
}

function sm_cbDefs_() {
  var d = {};
  var a = function (k, desc, type) { d[k] = [desc, type || '']; };
  // 여러 시트 공통
  a('ServerUpdatedAt', '서버가 행을 마지막으로 갱신한 시각', '날짜시간');
  a('SessionId', '평가 세션 ID (Type 1개 = 세션 1개)', 'UUID');
  a('IsTest', '시험 응답 여부 (TRUE 면 분석 제외)', 'TRUE/FALSE');
  a('EvaluatorName', '평가자 성명 — 개인정보, AnalysisLong 에는 없음', '문자열');
  a('EvaluatorRole', '직군', '인턴 / 레지던트 / 전문의');
  a('EvaluatorDetail', '직군 상세 표시 (예: 레지던트 · R2)', '문자열');
  a('ResidentYear', '레지던트 년차', 'R1 / R2 / R3');
  a('StudyType', '평가 Type (AI 답변 2건 묶음)', 'A / B');
  a('SequenceIndex', 'Type 안의 제시 순서 번호', '정수 (0부터)');
  a('SeqSource', '제시 순서 배정 출처', 'server / local (서버 미응답 시 기기 임의 배정)');
  a('EvaluatorId', '평가자 ID (기기에서 생성, 이어서 평가 시 승계)', 'UUID');
  a('EvaluatorCode', '서버 가명 코드 (정규화 성명 + 직군 해시 기준, 같은 사람 = 같은 코드)', 'E001… (테스트 T001…)');
  a('SessionOrdinal', '평가자의 몇 번째 Type 인지', '1 = 첫 Type, 2 = 이어서 평가');
  a('CaseOrder', '세션 안에서의 케이스 순서', '1–2');
  a('GlobalCaseOrder', '이어서 평가를 포함한 전체 케이스 순서', '1–4');
  a('CaseKey', 'AI 답변 식별자 (환자_모델)', '예: P051_deepseek');
  a('PatientId', '가상 환자 ID', 'P051 / P011');
  a('PatientSeenPrior', '앞선 연결 세션에서 같은 환자를 이미 봤는지', 'TRUE/FALSE');
  a('Model', '모델 코드 (평가자에게 비공개)', 'gpt / deepseek');
  a('ModelName', '모델 이름 (평가자에게 비공개)', '문자열');
  a('ComboChoice', '선택한 치료 조합 번호 (화면 순서 = AI 순위)', '1–3');
  a('ComboKey', '선택한 조합 키', '<CaseKey>_C<AI 순위>');
  a('RankCueVisible', '조합 이름에 순위 단서(우선/후순위/대안/권장)가 보였는지', 'TRUE/FALSE (GPT 답변 = TRUE)');
  a('Src', '유입 경로 (링크의 src 파라미터)', '예: qr, link');
  a('Site', '기관 (링크의 site 파라미터)', '문자열');
  a('Wave', '수집 차수 (링크의 wave 파라미터)', 'pilot = 파일럿 (주 분석 제외)');
  a('FormFactor', '기기 형태', 'mobile / tablet / desktop');
  a('InAppBrowser', '인앱 브라우저(카카오톡 등) 감지 결과', '문자열 (빈칸 = 일반 브라우저)');
  a('ReferrerOrigin', '유입 페이지 출처 (origin 만)', '문자열');
  a('DeviceId', '기기 ID (브라우저에 저장된 무작위 ID, 개인 식별 불가)', '문자열');
  a('VisitId', '소개 화면 방문 ID (Visits 와 연결)', 'UUID');
  a('AppVersion', '사이트 버전', '문자열');
  a('DataVersion', '케이스 자료 버전', '문자열');
  a('BackendVersion', '백엔드(Apps Script) 버전', '문자열');
  a('Interruptions', '화면 이탈(중단) 횟수', '정수');
  // Visits
  a('Visits.ReceivedAt', '서버가 방문 기록을 받은 시각', '날짜시간');
  a('Visits.VisitId', '방문 ID (소개 화면 1회 조회; Sessions.VisitId 와 연결)', 'UUID');
  a('Visits.TypeParam', '링크로 Type 이 미리 지정되었는지 / 지정된 Type', 'preset · A · B · 빈칸');
  // Sessions
  a('FirstSeenAt', '서버가 세션을 처음 받은 시각', '날짜시간');
  a('Order', '제시된 케이스 순서', 'CaseKey > CaseKey');
  a('Status', '진행 상태 (후퇴하지 않음)', 'started → in_progress → completed');
  a('CasesCompleted', '완료한 케이스 수', '정수');
  a('LinkedSessionId', '이어서 평가한 경우 앞선 세션 ID', 'UUID');
  a('TypePreselected', '링크로 Type 이 미리 선택되었는지', 'TRUE/FALSE');
  a('TypeHint', '시작 화면에서 "추천"으로 표시된 Type (빈칸 = 추천 없음)', 'A / B / 빈칸');
  a('ConsentVersion', '연구 동의서 버전', '문자열');
  a('ConsentAt', '동의 시각 (기기 기준)', 'ISO 시각');
  a('ConsentInherited', '앞선 세션의 동의를 승계했는지', 'TRUE/FALSE');
  a('InstrumentVersion', '설문 도구(문항) 버전', '문자열');
  a('Incentive', '사례 관련 응답 (설정에 따름)', '문자열');
  a('StartedAt', '평가 시작 시각 (기기 기준)', 'ISO 시각');
  a('FinishedAt', '제출 시각 (기기 기준)', 'ISO 시각');
  a('TotalActiveMin', '총 active 시간 (화면 표시 + 3분 이내 조작)', '실수 (분)');
  a('TotalIdleMin', '총 idle 시간 (화면 표시 중 3분 넘게 조작 없음)', '실수 (분)');
  a('TotalHiddenMin', '총 hidden 시간 (다른 앱·탭으로 가려짐)', '실수 (분)');
  a('TotalWallMin', '시작부터 제출까지 경과 시간', '실수 (분)');
  a('IntroSec', '소개 화면 체류 시간', '실수 (초)');
  a('FinalSec', '마지막(전체 의견) 화면 체류 시간', '실수 (초)');
  a('Resumes', '재접속하여 이어간 횟수', '정수');
  a('SendFailures', '서버 전송 실패 횟수 (자동 재전송됨)', '정수');
  a('FurthestCase', '도달한 마지막 케이스 번호', '정수 (1부터)');
  a('FurthestStep', '도달한 마지막 단계', 'vignette|p1|combo|p2|p3|p4|p5|comment|final');
  a('LastActivityAt', '마지막 활동 시각 (기기 기준)', 'ISO 시각');
  a('PartialRatingsN', '진행 중 입력된 평정 수 (미완료 포함)', '정수');
  a('OverallComment', '전체 의견 (자유 서술)', '문자열');
  a('ViewportW', '브라우저 화면 너비', '정수 (px)');
  a('ViewportH', '브라우저 화면 높이', '정수 (px)');
  a('ScreenW', '기기 화면 너비', '정수 (px)');
  a('ScreenH', '기기 화면 높이', '정수 (px)');
  a('DPR', '기기 픽셀 비율', '실수');
  a('TouchPoints', '최대 동시 터치 수', '정수');
  a('CoarsePointer', '터치 위주 입력 기기인지', 'TRUE/FALSE');
  a('Language', '브라우저 언어', '문자열');
  a('TimeZone', '기기 시간대', 'IANA 시간대');
  a('UserAgent', '브라우저 UA 문자열', '문자열');
  // Responses
  a('P1_Referral', 'Phase 1 의뢰 여부 결정 — 임상 결정에 유의미한 참고가 되는지', '1–5 (1 전혀 그렇지 않다 … 5 매우 그렇다)');
  a('ComboName', '선택한 조합 이름', '문자열');
  a('ComboIsAIFirst', 'AI 1순위 조합을 골랐는지', 'TRUE/FALSE');
  a('ComboRankAI', '선택한 조합의 AI 순위', '1–3');
  a('P2_SharedDecision', 'Phase 2 공유 의사결정 점수 (선택 조합 기준)', '1–5');
  a('P3_Pharmacotherapy', 'Phase 3 약물 처방 결정 점수 (선택 조합 기준)', '1–5');
  a('P4_FollowUp', 'Phase 4 추적관찰 계획 점수 (선택 조합 기준)', '1–5');
  a('P5_Education', 'Phase 5 환자 교육 점수 (선택 조합 기준)', '1–5');
  a('CaseComment', '케이스 자유 의견', '문자열');
  a('CaseStartedAt', '케이스 시작 시각 (기기 기준)', 'ISO 시각');
  a('CaseCompletedAt', '케이스 완료 시각 — 비어 있으면 미완료 (집계 제외)', 'ISO 시각');
  a('CaseActiveSec', '케이스 active 시간', '실수 (초)');
  a('CaseIdleSec', '케이스 idle 시간', '실수 (초)');
  a('CaseHiddenSec', '케이스 hidden 시간 (다른 앱·탭)', '실수 (초)');
  a('CaseWallSec', '케이스 시작~완료 경과 시간', '실수 (초)');
  a('RxDetailsOpens', '처방 상세를 펼친 횟수', '정수');
  a('ComboResets', '조합을 바꿔 Phase 2–5 점수가 초기화된 횟수', '정수');
  a('PatientDrawerOpens', '평가 중 환자 정보 서랍을 연 횟수', '정수');
  a('PatientDrawerSec', '환자 정보 서랍 열람 시간', '실수 (초)');
  a('MetricsJson', '단계별 상세 지표 원본 (active/idle/hidden ms, 응답 이력 등)', 'JSON (49,000자에서 절단)');
  // PhaseLong
  a('Phase', 'Phase', 'P1–P5');
  a('PhaseLabel', 'Phase 이름', '문자열');
  a('TargetKey', '평정 대상 키 (출력 × 조합 × Phase; 가이드라인 부합도와 연결)', 'P051_deepseek|P1 또는 P051_deepseek|C2|P3');
  a('Score', '최종 점수', '1–5');
  a('Acceptable_4plus', '4점 이상 여부', '1/0');
  a('FirstScore', '처음 고른 점수 (조합 변경 후 기준)', '1–5');
  a('Changed', '첫 점수 이후 응답을 바꿨는지', '1/0');
  a('VisibleSec', 'Phase 화면 표시 시간 (active + idle)', '실수 (초)');
  a('ActiveOnlySec', 'Phase 화면 active 시간', '실수 (초)');
  a('TTFRSec', '첫 응답까지 시간', '실수 (초)');
  a('PhaseLong.Changes', '첫 응답 이후 응답을 바꾼 횟수', '정수');
  a('ScrollPct', '최대 스크롤 도달률', '0–100 (%)');
  a('ScrollAtFirstRating', '첫 응답 시점의 스크롤 도달률', '0–100 (%)');
  a('PhaseLong.Chars', 'Phase 본문 글자 수', '정수');
  a('CharsPerSec', '읽기 속도 = 글자 수 ÷ 표시 시간', '실수 (자/초)');
  a('PhaseLong.Visits', 'Phase 화면 방문 횟수', '정수');
  a('HarmInPhase', '위해 가능 Phase 로 지목되었는지', '1 / 0 / 빈칸 (판정 불가)');
  // RawJSON
  a('ReceivedAt', '서버가 요청을 받은 시각', '날짜시간');
  a('Action', '요청 종류', 'start | case | finish | progress');
  a('MsgId', '클라이언트 메시지 ID (재전송 식별)', '문자열');
  a('Payload', '요청 원문', 'JSON (49,000자에서 절단)');
  a('ElapsedMs', '서버 처리 시간', '정수 (ms)');
  a('Error', '처리 오류 메시지', '문자열');
  // Concordance
  a('Concordance.TargetKey', '가이드라인 부합도를 채점한 대상 (PhaseLong.TargetKey 와 같은 형식)', '문자열');
  a('ConcordanceScore', '가이드라인 부합도 점수 (연구진 입력)', '실수');
  // AnalysisLong
  var A = function (k, desc, type) { a('AnalysisLong.' + k, desc, type); };
  A('EvaluatorCode', '평가자 가명 (EvaluatorCode; 없으면 이 시트에서만 쓰는 임시 가명 R001…)', '문자열');
  A('SessionOrdinal', '평가자의 몇 번째 Type 인지', '1 / 2');
  A('PatientSeenPrior', '앞선 연결 세션에서 같은 환자를 봤는지', '1/0');
  A('Model', '모델 코드', 'gpt / deepseek');
  A('ComboRankAI', '선택한 조합의 AI 순위 (Phase 2–5 가 이 조합 기준)', '1–3');
  A('RankCueVisible', '조합 이름에 순위 단서가 보였는지', '1/0');
  A('Phase', 'Phase', 'P1–P5');
  A('Score', '최종 점수', '1–5');
  A('Acceptable', '수용 (Score ≥ 4)', '1/0');
  A('FirstScore', '처음 고른 점수', '1–5');
  A('Changed', '첫 점수 이후 응답을 바꿨는지', '1/0');
  A('Role', '직군 (평가자 첫 포함 세션 기준)', '인턴 / 레지던트 / 전문의');
  A('ResidentYear', '레지던트 년차', 'R1–R3');
  A('Major', '레지던트 전공 (Eval_major)', '문자열');
  A('Specialty', '전문의 주 분야 (Eval_specialty)', '문자열');
  A('BoardYears', '전문의 취득 후 연차 (Eval_board_years)', '문자열');
  A('T2DVolume_code', '제2형 당뇨병 진료량 코드', '1 월 1명 미만 … 4 월 31명 이상');
  A('AIUse_code', 'AI 도구 사용 빈도 코드', '1 사용한 적 없음 … 5 거의 매일');
  A('AITrust_code', 'AI 신뢰 코드', '1 전혀 신뢰하지 않음 … 5 매우 신뢰함');
  A('Src', '유입 경로 (세션)', '문자열');
  A('Site', '기관 (세션)', '문자열');
  A('Wave', '수집 차수 (세션)', 'pilot = 파일럿');
  A('FormFactor', '기기 형태 (세션)', 'mobile / tablet / desktop');
  A('InAppBrowser', '인앱 브라우저 감지 (세션)', '문자열');
  A('VisibleSec', 'Phase 화면 표시 시간 (active + idle)', '실수 (초)');
  A('ActiveOnlySec', 'Phase 화면 active 시간', '실수 (초)');
  A('TTFRSec', '첫 응답까지 시간', '실수 (초)');
  A('Chars', 'Phase 본문 글자 수', '정수');
  A('CharsPerSec', '읽기 속도 = Chars ÷ VisibleSec', '실수 (자/초)');
  A('ScrollAtFirstRating', '첫 응답 시점의 스크롤 도달률', '0–100 (%)');
  A('HarmCode', '환자 위해 가능성 (케이스)', '1 없음 / 2 경미 / 3 중대');
  A('HarmInPhase', '위해 가능 Phase 로 지목되었는지', '1 / 0 / 빈칸 (판정 불가)');
  A('WouldPrescribeCode', '처방 의향 (케이스)', '1 그대로 / 2 일부 수정 / 3 처방할 조합 없음');
  A('IntentUseCode', '향후 활용 의향 (세션 종료 문항)', '1–5');
  A('SpeederFlag', '빠른 응답: 글자 수/표시 시간 > 25자/초 또는 표시 시간 < 5초 (Phase)', '1 / 0 / 빈칸 (판정 불가)');
  A('CaseSpeeder', '빠른 케이스: 케이스 표시 시간 < 0.3 × 분석 포함 케이스 중앙값', '1 / 0 / 빈칸');
  A('StraightlineFlag', '일자형 응답: 세션의 평정 ≥ 6개가 모두 같은 점수', '1 / 0 / 빈칸 (평정 < 6)');
  A('HiddenHeavyFlag', '케이스 시간의 절반 넘게 다른 앱·탭 (CaseHiddenSec > 0.5 × CaseWallSec)', '1 / 0 / 빈칸');
  A('RatedBeforeReadFlag', '읽기 전 응답: 첫 응답 시점 스크롤 < 60%', '1 / 0 / 빈칸');
  A('IncludedInAnalysis', '주 분석 포함 여부', '1 / 0');
  A('ExclusionReason', '주 분석 제외 사유', '빈칸 / pilot / duplicate');
  A('IsTest', '시험 응답 (테스트 포함 모드에서만 1 이 나옴)', '1 / 0');
  return d;
}

// ============================================================
// WRITE
// ============================================================
/** 시트를 비우고 고정 폭으로 패딩한 값을 setValues 1회로 기록 (모든 문자열은 cell_ 로 텍스트 고정) */
function sm_write_(ss, name, rows, width, boldRows, freeze) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  var out = (rows.length ? rows : [['']]).map(function (r) {
    var a = [];
    for (var i = 0; i < width; i++) a.push(sm_cell_(i < r.length ? r[i] : ''));
    return a;
  });
  sh.getRange(1, 1, out.length, width).setValues(out);
  try {   // 서식은 부가 기능 — 실패해도 값 기록에는 영향 없음
    if (freeze) sh.setFrozenRows(1);
    if (boldRows && boldRows.length) {
      if (typeof sh.getRangeList === 'function') {
        var last = sm_colA1_(width);
        sh.getRangeList(boldRows.map(function (i) { return 'A' + (i + 1) + ':' + last + (i + 1); })).setFontWeight('bold');
      } else if (boldRows[0] === 0) {
        sh.getRange(1, 1, 1, width).setFontWeight('bold');
      }
    }
  } catch (eFmt) {}
  return sh;
}

function sm_cell_(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v;
  if (sm_isDate_(v)) return isNaN(v.getTime()) ? '' : v;
  return cell_(String(v));
}

function sm_colA1_(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// ============================================================
// STATISTICS
// ============================================================
/** Wilson 95% 신뢰구간 */
function sm_wilson_(x, n) {
  if (!n) return [NaN, NaN];
  var z2 = SM_Z * SM_Z, p = x / n, den = 1 + z2 / n;
  var c = (p + z2 / (2 * n)) / den;
  var h = SM_Z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

var SM_LF = [0];
function sm_lfact_(n) { for (var i = SM_LF.length; i <= n; i++) SM_LF[i] = SM_LF[i - 1] + Math.log(i); return SM_LF[n]; }
function sm_lchoose_(n, k) { return sm_lfact_(n) - sm_lfact_(k) - sm_lfact_(n - k); }

/** 정확 이항 단측 p = P(X ≥ k | n, p) */
function sm_binomUpper_(k, n, p) {
  if (!n) return NaN;
  if (k <= 0) return 1;
  var s = 0;
  for (var i = k; i <= n; i++) s += Math.exp(sm_lchoose_(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}

/** Polit (2007) 수정 카파 k* */
function sm_kappa_(n, a) {
  if (!n) return { pc: NaN, k: NaN, label: '' };
  var pc = Math.exp(sm_lchoose_(n, a) + n * Math.log(0.5));
  var k = pc >= 1 ? NaN : (a / n - pc) / (1 - pc);
  var label = !sm_fin_(k) ? '' : k > 0.74 ? '우수' : k >= 0.60 ? '양호' : k >= 0.40 ? '보통' : '미흡';
  return { pc: pc, k: k, label: label };
}

/** rWG = 1 − s²/σ²EU (평가자 2명 이상, 0 미만은 0) */
function sm_rwg_(v) {
  if (v.length < 2) return NaN;
  var s = sd_(v);
  return Math.max(0, 1 - s * s / SM_EU);
}

/** 이분(≥4) 평가에서 일치하는 평가자 쌍의 비율 */
function sm_pairAgree_(n, a) {
  if (n < 2) return NaN;
  var c2 = function (x) { return x * (x - 1) / 2; };
  return (c2(a) + c2(n - a)) / c2(n);
}

/** 평균 순위(동점 처리) */
function sm_ranks_(a) {
  var idx = a.map(function (v, i) { return i; }).sort(function (i, j) { return a[i] - a[j]; });
  var r = new Array(a.length);
  for (var i = 0; i < idx.length;) {
    var j = i;
    while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
    for (var k = i; k <= j; k++) r[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Spearman rho = 평균 순위의 Pearson 상관. 결측 쌍 제외, n < 3 또는 분산 0 이면 NaN */
function sm_spearman_(xs, ys) {
  var x = [], y = [];
  for (var i = 0; i < xs.length; i++) {
    if (sm_fin_(xs[i]) && sm_fin_(ys[i])) { x.push(Math.round(xs[i] * 1e9) / 1e9); y.push(Math.round(ys[i] * 1e9) / 1e9); }
  }
  var n = x.length;
  if (n < 3) return { n: n, rho: NaN };
  var rx = sm_ranks_(x), ry = sm_ranks_(y), mx = mean_(rx), my = mean_(ry), sxy = 0, sxx = 0, syy = 0;
  for (var j = 0; j < n; j++) {
    sxy += (rx[j] - mx) * (ry[j] - my); sxx += (rx[j] - mx) * (rx[j] - mx); syy += (ry[j] - my) * (ry[j] - my);
  }
  return { n: n, rho: (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : NaN };
}

/** 분위수 (R type 7, 선형 보간) */
function sm_q_(a, p) {
  if (!a.length) return NaN;
  var b = a.slice().sort(function (x, y) { return x - y; });
  var h = (b.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return b[lo] + (h - lo) * (b[hi] - b[lo]);
}

function sm_medIqrText_(v) {
  return String(r2_(median_(v))) + ' (' + r2_(sm_q_(v, 0.25)) + '–' + r2_(sm_q_(v, 0.75)) + ')';
}

function sm_accRate_(ps) { return ps.filter(function (p) { return p.score >= 4; }).length / ps.length; }
function sm_scored_(ps) { return ps.filter(function (p) { return sm_fin_(p.score); }); }
function sm_scoresOf_(ps, k) { return ps.filter(function (p) { return p.k === k && sm_fin_(p.score); }).map(function (p) { return p.score; }); }

function sm_pText_(p) {
  if (!sm_fin_(p)) return '';
  return p < 0.0001 ? '<0.0001' : sm_round_(p, 4);
}

// ============================================================
// SMALL HELPERS
// ============================================================
function sm_has_(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function sm_fin_(v) { return typeof v === 'number' && isFinite(v); }
function sm_isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function sm_blank_(v) { return v === undefined || v === null || (typeof v === 'string' && v.trim() === ''); }

function sm_str_(v) {
  if (v === undefined || v === null) return '';
  if (sm_isDate_(v)) return isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v).trim();
}

function sm_num_(v) {
  if (v === undefined || v === null || typeof v === 'boolean' || sm_isDate_(v)) return NaN;
  if (typeof v === 'number') return v;
  var s = String(v).trim();
  return s === '' ? NaN : Number(s);
}

function sm_bool_(v) {
  if (v === true || v === false) return v;
  if (v === 1 || v === 0) return v === 1;
  var s = sm_str_(v).toUpperCase();
  if (s === 'TRUE' || s === '1' || s === 'Y' || s === 'YES') return true;
  if (s === 'FALSE' || s === '0' || s === 'N' || s === 'NO') return false;
  return null;
}

function sm_b01_(v) { var b = sm_bool_(v); return b === null ? '' : (b ? 1 : 0); }

function sm_time_(v) {
  if (v === undefined || v === null || v === '') return NaN;
  if (sm_isDate_(v)) return v.getTime();
  if (typeof v === 'number') return v > 1e11 ? v : NaN;
  var t = Date.parse(String(v).trim());
  return isNaN(t) ? NaN : t;
}

function sm_firstNum_(arr) {
  for (var i = 0; i < arr.length; i++) { var n = sm_num_(arr[i]); if (sm_fin_(n)) return n; }
  return NaN;
}

function sm_sumNum_(arr) {
  var t = NaN;
  arr.forEach(function (v) { var n = sm_num_(v); if (sm_fin_(n)) t = (sm_fin_(t) ? t : 0) + n; });
  return t;
}

function sm_numOrStr_(v) { var n = sm_num_(v); return sm_fin_(n) ? n : sm_str_(v); }

/** 문항 값 {label, code}: _code 가 있으면 그대로, 없으면 선택지·키워드·앞자리 숫자(리커트)로 추정 */
function sm_item_(label, code, opts, keyw) {
  var l = sm_str_(label), c = sm_num_(code);
  if (!(c >= 1)) {
    c = NaN;
    if (l && opts && opts.indexOf(l) >= 0) c = opts.indexOf(l) + 1;
    else if (l && keyw) { for (var j = 0; j < keyw.length; j++) if (l.indexOf(keyw[j]) >= 0) { c = j + 1; break; } }
    else if (l && !opts) { var m = /^\s*([1-9])(?!\d)/.exec(l); if (m) c = Number(m[1]); }
  }
  if (!l && c >= 1 && opts && opts[c - 1]) l = opts[c - 1];
  return { label: l, code: c };
}

function sm_cmpNum_(x, y) {   // 결측(NaN)은 뒤로
  var fx = sm_fin_(x), fy = sm_fin_(y);
  if (fx && fy) return x - y;
  if (fx !== fy) return fx ? -1 : 1;
  return 0;
}
function sm_cmpStr_(a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; }

function sm_uniq_(a) { var s = {}; return a.filter(function (x) { var k = String(x); if (sm_has_(s, k)) return false; s[k] = 1; return true; }); }
function sm_uniqCount_(a) { return sm_uniq_(a.filter(function (x) { return x !== '' && x !== null && x !== undefined; })).length; }

function sm_counts_(list, fn) {
  var c = {}, keys = [];
  list.forEach(function (x) { var k = fn(x); if (!sm_has_(c, k)) { c[k] = 0; keys.push(k); } c[k]++; });
  return keys.map(function (k) { return [k, c[k]]; }).sort(function (a, b) { return (b[1] - a[1]) || sm_cmpStr_(a[0], b[0]); });
}

function sm_mode_(a) {
  var c = sm_counts_(a, function (x) { return x === null ? 'null' : String(x); });
  if (!c.length) return null;
  return c[0][0] === 'true' ? true : c[0][0] === 'false' ? false : null;
}

/** 수준 정렬: 지정 순서 → 그 외 가나다 → (미응답)·(없음) 같은 괄호 수준은 마지막 */
function sm_orderKeys_(keys, order) {
  order = order || [];
  return keys.slice().sort(function (a, b) {
    var ma = /^\(/.test(a), mb = /^\(/.test(b);
    if (ma !== mb) return ma ? 1 : -1;
    var ia = order.indexOf(a), ib = order.indexOf(b);
    if (ia >= 0 || ib >= 0) { if (ia < 0) return 1; if (ib < 0) return -1; return ia - ib; }
    return sm_cmpStr_(a, b);
  });
}

function sm_models_(D) {
  var seen = {}, out = [];
  D.inc.cases.forEach(function (c) {
    if (sm_has_(seen, c.model)) return;
    seen[c.model] = 1;
    out.push({ key: c.model, name: D.modelName[c.model] || c.model });
  });
  return out.sort(function (a, b) { return sm_cmpStr_(a.name, b.name); });
}

function sm_caseKeys_(cases) { return sm_uniq_(cases.map(function (c) { return c.key; })).sort(); }

function sm_round_(v, d) {
  if (v === '' || v === null || v === undefined || typeof v !== 'number' || !isFinite(v)) return '';
  var f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function unique_(a) { var s = {}; return a.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); }
function mean_(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : ''; }
function sd_(a) {
  if (a.length < 2) return '';
  var m = mean_(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}
function median_(a) {
  if (!a.length) return '';
  var b = a.slice().sort(function (x, y) { return x - y; });
  var h = Math.floor(b.length / 2);
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
}
function r1_(v) { return sm_round_(v, 1); }
function r2_(v) { return sm_round_(v, 2); }
function r3_(v) { return sm_round_(v, 3); }
