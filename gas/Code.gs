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
var SPREADSHEET_ID = '';            // 시트에서 [확장 프로그램 → Apps Script]로 만든 경우 비워 둠. script.google.com 에서 따로 만든 경우 시트 ID 입력
var BACKEND_VERSION = '2026-11-19.ca-backend-v3';
var EXPECTED_STUDY_ID = 'T2D-CA-2026';

var SHEET = {
  RESP: 'Responses',
  LONG: 'PhaseLong',
  SESS: 'Sessions',
  RAW: 'RawJSON',
  SUMMARY: 'Summary'
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
    'StudyType', 'SequenceIndex', 'SeqSource', 'CaseOrder', 'CaseKey', 'PatientId', 'Model', 'ModelName',
    'P1_Referral', 'ComboChoice', 'ComboName', 'ComboIsAIFirst',
    'P2_SharedDecision', 'P3_Pharmacotherapy', 'P4_FollowUp', 'P5_Education',
    'CaseComment', 'CaseStartedAt', 'CaseCompletedAt',
    'CaseActiveSec', 'CaseIdleSec', 'CaseHiddenSec', 'CaseWallSec'
  ];
  STEPS.forEach(function (s) { h.push('Sec_' + STEP_COL[s]); });
  ['p1', 'combo', 'p2', 'p3', 'p4', 'p5'].forEach(function (s) { h.push('TTFR_' + STEP_COL[s]); });
  ['p1', 'combo', 'p2', 'p3', 'p4', 'p5'].forEach(function (s) { h.push('Changes_' + STEP_COL[s]); });
  STEPS.forEach(function (s) { h.push('Scroll_' + STEP_COL[s]); });
  STEPS.forEach(function (s) { h.push('Visits_' + STEP_COL[s]); });
  h = h.concat(['ComboResets', 'PatientDrawerOpens', 'PatientDrawerSec',
    'AppVersion', 'DataVersion', 'BackendVersion', 'MetricsJson']);
  return h;
}

function longHeaders_() {
  return ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex',
    'CaseOrder', 'CaseKey', 'PatientId', 'Model', 'ComboChoice', 'Phase', 'PhaseLabel', 'Score', 'Acceptable_4plus',
    'VisibleSec', 'ActiveOnlySec', 'TTFRSec', 'Changes', 'ScrollPct', 'Visits'];
}

function sessHeaders_() {
  return [
    'FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'SeqSource', 'Order', 'Status', 'CasesCompleted', 'LinkedSessionId',
    'StartedAt', 'FinishedAt', 'TotalActiveMin', 'TotalIdleMin', 'TotalHiddenMin', 'TotalWallMin',
    'IntroSec', 'FinalSec', 'Resumes', 'OverallComment',
    'FormFactor', 'ViewportW', 'ViewportH', 'ScreenW', 'ScreenH', 'DPR', 'TouchPoints', 'CoarsePointer',
    'Language', 'TimeZone', 'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion'
  ];
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
    }
    // Responses 를 마지막에 기록: finish 재전송 시 '이미 저장됨' 판단 기준(Responses 행)이 다른 시트보다 먼저 생기지 않도록
    [SHEET.SESS, SHEET.LONG, SHEET.RESP].forEach(function (k) { if (db[k]) tFlush_(db[k]); });
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

var VALID_ACTIONS = ['start', 'case', 'finish'];
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
  }
  if (p.action === 'finish') row.OverallComment = p.overall_comment || '';
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
  Object.assign(row, evalCols_(p));
  tWrite_(t, idx, row);

  // Long format (Phase 단위)
  var lt = table_(ss, db, SHEET.LONG, longHeaders_());
  PHASE_KEYS.forEach(function (k) {
    var st = steps[k] || {};
    var score = r[k];
    var lrow = {
      ServerUpdatedAt: new Date(), SessionId: p.session_id, IsTest: !!p.is_test,
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
  var ev = p.evaluator || {};
  var o = {
    EvaluatorName: ev.name || '', EvaluatorRole: ev.role_label || ev.role || '', EvaluatorDetail: ev.detail || '',
    ResidentYear: ev.year || '', StudyType: p.study_type || ''
  };
  var f = ev.fields || {};
  Object.keys(f).forEach(function (k) { if (/^[A-Za-z0-9_]{1,40}$/.test(k)) o['Eval_' + k] = f[k]; });
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
  Object.keys(rowObj).forEach(function (k) { if (!t.map[k] && /^Eval_/.test(k)) tAddCol_(t, k); });
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
  // 응답이 아직 없는 시트(헤더만 있음)는 최신 컬럼 순서로 헤더를 다시 쓴다. 응답이 있으면 건드리지 않고 누락 컬럼만 뒤에 추가.
  [[SHEET.RESP, respHeaders_()], [SHEET.LONG, longHeaders_()], [SHEET.SESS, sessHeaders_()], [SHEET.RAW, rawHeaders_()]].forEach(function (x) {
    var sh = ss.getSheetByName(x[0]);
    if (sh && sh.getLastRow() <= 1) {
      sh.clear();
      sh.getRange(1, 1, 1, x[1].length).setValues([x[1]]).setFontWeight('bold').setBackground('#e3edf5');
      sh.setFrozenRows(1);
    } else {
      sheet_(ss, x[0], x[1]);
    }
  });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  Logger.log('✅ 시트 준비 완료: ' + ss.getUrl());
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

function buildSummaryIncludingTests() { buildSummary(true); }

/**
 * Summary 시트 생성
 *  - 대상: 완료된 케이스(CaseCompletedAt 존재). 기본적으로 IsTest=TRUE 제외.
 *  - 모델 × Phase: n, 평균, SD, 중앙값, 1~5점 분포, I-CVI(4점 이상 비율). 모델별 S-CVI/Ave(= Phase I-CVI 평균)
 *  - 답변(CaseKey)별 선호 조합 분포, AI 1순위 조합 선택률
 *  - 모델별 케이스 소요 시간(분) 중앙값·평균, Phase별 평균 체류 시간(초)
 */
function buildSummary(includeTests) {
  includeTests = includeTests === true;
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET.RESP);
  if (!sh || sh.getLastRow() < 2) { Logger.log('응답 없음'); return; }
  var hm = headerMap_(sh).map;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var col = function (r, name) { return r[hm[name] - 1]; };
  var rows = data.filter(function (r) {
    var test = col(r, 'IsTest') === true || String(col(r, 'IsTest')).toUpperCase() === 'TRUE';
    return col(r, 'CaseCompletedAt') !== '' && (includeTests || !test);
  });

  var out = [];
  var push = function (arr) { out.push(arr); };
  push(['임상 수용성 평가 — 요약 통계', '', '', '', '', '', '', '', '', '', '', '', '']);
  push(['생성 시각', new Date(), '테스트 응답 포함', includeTests, '완료 케이스 수', rows.length, '평가자 수', unique_(rows.map(function (r) { return col(r, 'SessionId'); })).length, '', '', '', '', '']);
  push(['']);

  var phaseCols = { p1: 'P1_Referral', p2: 'P2_SharedDecision', p3: 'P3_Pharmacotherapy', p4: 'P4_FollowUp', p5: 'P5_Education' };
  var models = unique_(rows.map(function (r) { return col(r, 'ModelName') || col(r, 'Model'); })).sort();
  var groups = models.concat(['전체']);

  push(['[1] 모델 × Phase 임상 수용성 (5점 척도, I-CVI = 4점 이상 비율)']);
  push(['모델', 'Phase', 'n', '평균', 'SD', '중앙값', '1점', '2점', '3점', '4점', '5점', 'I-CVI', '']);
  groups.forEach(function (g) {
    var sub = rows.filter(function (r) { return g === '전체' || (col(r, 'ModelName') || col(r, 'Model')) === g; });
    var icvis = [];
    PHASE_KEYS.forEach(function (k) {
      var vals = sub.map(function (r) { return Number(col(r, phaseCols[k])); }).filter(function (v) { return v >= 1 && v <= 5; });
      var dist = [1, 2, 3, 4, 5].map(function (s) { return vals.filter(function (v) { return v === s; }).length; });
      var icvi = vals.length ? (dist[3] + dist[4]) / vals.length : '';
      if (icvi !== '') icvis.push(icvi);
      push([g, PHASE_LABEL[k], vals.length, r2_(mean_(vals)), r2_(sd_(vals)), median_(vals)].concat(dist).concat([r3_(icvi), '']));
    });
    push([g, 'S-CVI/Ave (Phase I-CVI 평균)', '', '', '', '', '', '', '', '', '', r3_(mean_(icvis)), '']);
  });
  push(['']);

  push(['[2] 답변별 선호 조합 선택 분포']);
  push(['CaseKey', '환자', '모델', 'n', '조합 1', '조합 2', '조합 3', 'AI 1순위 선택률', '', '', '', '', '']);
  unique_(rows.map(function (r) { return col(r, 'CaseKey'); })).sort().forEach(function (key) {
    var sub = rows.filter(function (r) { return col(r, 'CaseKey') === key; });
    var ch = sub.map(function (r) { return Number(col(r, 'ComboChoice')); });
    var cnt = [1, 2, 3].map(function (n) { return ch.filter(function (v) { return v === n; }).length; });
    push([key, col(sub[0], 'PatientId'), col(sub[0], 'ModelName') || col(sub[0], 'Model'), sub.length].concat(cnt).concat([r3_(sub.length ? cnt[0] / sub.length : ''), '', '', '', '', '']));
  });
  push(['']);

  push(['[3] 소요 시간 — 화면 표시 시간(active + idle) 기준, 다른 앱·탭으로 전환된(hidden) 시간 제외. 마지막 열은 active만 집계']);
  push(['모델', 'n', '케이스 중앙값(분)', '케이스 평균(분)', '환자정보(초)', 'P1(초)', '조합선택(초)', 'P2(초)', 'P3(초)', 'P4(초)', 'P5(초)', '의견(초)', '케이스 중앙값(분, active만)']);
  groups.forEach(function (g) {
    var sub = rows.filter(function (r) { return g === '전체' || (col(r, 'ModelName') || col(r, 'Model')) === g; });
    var caseMin = sub.map(function (r) { return (Number(col(r, 'CaseActiveSec')) + Number(col(r, 'CaseIdleSec'))) / 60; });
    var stepMeans = STEPS.map(function (s) {
      return r1_(mean_(sub.map(function (r) { return Number(col(r, 'Sec_' + STEP_COL[s])); }).filter(function (v) { return !isNaN(v); })));
    });
    var caseActiveMin = sub.map(function (r) { return Number(col(r, 'CaseActiveSec')) / 60; });
    push([g, sub.length, r1_(median_(caseMin)), r1_(mean_(caseMin))].concat(stepMeans).concat([r1_(median_(caseActiveMin))]));
  });
  push(['']);
  push(['[4] 평가자 구성 (완료 케이스 기준)']);
  push(['직군', '세부', 'Type', '평가자 수', '완료 케이스 수', '', '', '', '', '', '', '', '']);
  var keyOf = function (r) { return [col(r, 'EvaluatorRole') || '(미기재)', col(r, 'EvaluatorDetail') || '', col(r, 'StudyType') || ''].join('\u0001'); };
  unique_(rows.map(keyOf)).sort().forEach(function (k) {
    var sub = rows.filter(function (r) { return keyOf(r) === k; });
    var parts = k.split('\u0001');
    push([parts[0], parts[1], parts[2], unique_(sub.map(function (r) { return col(r, 'SessionId'); })).length, sub.length, '', '', '', '', '', '', '', '']);
  });
  push(['']);

  push(['[5] 직군별 Phase I-CVI (4점 이상 비율)']);
  push(['직군', 'n(케이스)', 'Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'S-CVI/Ave', '', '', '', '', '']);
  unique_(rows.map(function (r) { return col(r, 'EvaluatorRole') || '(미기재)'; })).sort().concat(['전체']).forEach(function (g) {
    var sub = rows.filter(function (r) { return g === '전체' || (col(r, 'EvaluatorRole') || '(미기재)') === g; });
    var ic = PHASE_KEYS.map(function (k) {
      var v = sub.map(function (r) { return Number(col(r, phaseCols[k])); }).filter(function (x) { return x >= 1 && x <= 5; });
      return v.length ? v.filter(function (x) { return x >= 4; }).length / v.length : '';
    });
    var valid = ic.filter(function (x) { return x !== ''; });
    push([g, sub.length].concat(ic.map(r3_)).concat([r3_(mean_(valid)), '', '', '', '', '']));
  });
  push(['']);
  push(['※ 모델명은 평가자에게 공개되지 않았습니다(블라인드). 평가자는 Type A/B 중 하나를 골라 AI 답변 2건을 평가했고, Type 안의 제시 순서는 균형 배정되었습니다.']);

  var width = 13;
  out = out.map(function (r) { var a = r.slice(0, width); while (a.length < width) a.push(''); return a; });
  var sum = ss.getSheetByName(SHEET.SUMMARY) || ss.insertSheet(SHEET.SUMMARY);
  sum.clear();
  out = out.map(function (r) { return r.map(function (v) { return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v; }); });
  sum.getRange(1, 1, out.length, width).setValues(out);
  sum.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sum.autoResizeColumns(1, width);
  Logger.log('✅ Summary 갱신: ' + rows.length + ' cases');
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
function r1_(v) { return v === '' ? '' : Math.round(v * 10) / 10; }
function r2_(v) { return v === '' ? '' : Math.round(v * 100) / 100; }
function r3_(v) { return v === '' ? '' : Math.round(v * 1000) / 1000; }
