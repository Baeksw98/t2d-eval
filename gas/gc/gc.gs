// ============================================================
// GUIDELINE-CONCORDANCE BACKEND (gas/gc/gc.gs)
// ============================================================
/**
 * 가이드라인 부합도 전문의 검증 (GC, 사이트 /gc/) — 계약: docs/GC_CONTRACT.md
 * 임상 수용성 평가(CA)와 별개의 Apps Script 프로젝트·스프레드시트 (진입점은 gas/gc/gc_main.gs)
 *
 * 수집 (doPost 가 잠금·JSON·UUID·study_id 검사 후 gcHandle_ 호출, 요청 원문은 GC_Raw)
 *   gc_start     세션 행 생성 + Part 안에서 균형 배정한 제시 순서 { ok, seq_index }
 *   gc_judgment  판정 1건 upsert (SessionId + ItemId), 수정 재전송 시 덮어씀
 *   gc_finish    판정 전체 + 마지막 문항(End_*) + 세션 시간, 재전송해도 결과가 같음
 *   gc_progress  이탈 지점 (완료 세션은 건드리지 않음)
 *   시트: GC_Sessions(세션 1행), GC_Judgments(세션 × 판정 1행), GC_Raw(요청 원문)
 *
 * 요약 (buildGcSummary, 10분 트리거 refreshGcSummaryIfDirty 가 GC_SUMMARY_DIRTY='1' 일 때 실행)
 *   GC_Adjudication  검증 대상 판정(AI 감사가 △/✗ 표시)마다 전문의 판정 집계와 확정 상태
 *   GC_Concordance   TargetKey 별 부합도: AI Rater 원판정 → AI 감사 → 전문의 확정 반영 (ConcordanceScore)
 *   GC_Summary       논문용 표 (참여 흐름, 검증자 특성, 판정별 결과, 일치도, 점수표, 소요 시간, 마지막 문항)
 *   GC_Codebook      모든 GC 시트의 컬럼 설명
 *   CA 연결: GC_Concordance 의 TargetKey·ConcordanceScore 를 CA 스프레드시트의 Concordance 시트에 붙여 넣으면
 *   CA Summary [14] 에 나란히 표시된다 (두 프로젝트는 서로의 시트를 읽지 않음).
 *
 * 판정 메타데이터(GC_ITEMS)는 tools/build_gas.py 가 gc/data/gc_items.js 에서 만들어 GcCode.gs 끝에 붙인다.
 * 시트 유틸리티(table_, tWrite_, cell_, sm_write_ …)는 같은 빌드가 CA 소스(gas/src)에서 이름으로 복사해 온다.
 */

var GC_STUDY_ID = 'T2D-GC-2026';
var GC_ACTIONS = ['gc_start', 'gc_judgment', 'gc_finish', 'gc_progress'];
var GC_SHEET = {
  VISITS: 'Visits', SESS: 'GC_Sessions', JUDG: 'GC_Judgments', RAW: 'GC_Raw',
  ADJ: 'GC_Adjudication', CONC: 'GC_Concordance', SUMMARY: 'GC_Summary', CODEBOOK: 'GC_Codebook'
};
var GC_VERDICTS = ['met', 'deducted', 'not_applicable'];          // PhysVerdict_code = 순서 + 1
var GC_VERDICT_KO = { met: '충족', deducted: '감점', not_applicable: '채점 대상 아님' };
var GC_MARK_KO = { major: '✗ (판정 수정)', minor: '△ (경미한 지적)' };
// Part → 답변(unit) 묶음. gc/gc-config.js 의 PARTS 와 같아야 한다 (tools/test_gc.js 가 확인).
var GC_PARTS = { A: ['P051_deepseek', 'P011_gpt'], B: ['P011_deepseek', 'P051_gpt'] };
var GC_STATUS = {
  PENDING: '대기', UNANIMOUS: '확정(만장일치)', MAJORITY: '확정(다수결)', SINGLE: '잠정(1인)', REVIEW: '추가 검토 필요'
};
var GC_STATUS_ORDER = ['확정(만장일치)', '확정(다수결)', '잠정(1인)', '추가 검토 필요', '대기'];
// 검증자 특성 · 마지막 문항 (gc/gc-config.js PROFILE_FIELDS / END_ITEMS 와 같은 선택지 순서)
var GC_OPT = {
  board_years: ['5년 미만', '5–9년', '10–19년', '20년 이상'],
  setting: ['상급종합병원', '종합병원', '병원·의원', '기타'],
  t2d_volume: ['월 100명 미만', '월 100–299명', '월 300명 이상']
};
var GC_CB_ITEMS = {
  board_years: ['Eval_', '분과전문의 취득 후 경력', '5년 미만, 5–9년, 10–19년, 20년 이상', true],
  setting: ['Eval_', '주 근무 기관', '상급종합병원, 종합병원, 병원·의원, 기타', true],
  t2d_volume: ['Eval_', '최근 3개월 직접 진료한 제2형 당뇨병 환자 수 (월 평균)', '월 100명 미만, 월 100–299명, 월 300명 이상', true],
  info_sufficient: ['End_', 'AI 답변·AI Rater 판정·AI 감사 의견만으로 판정을 확정하기에 정보가 충분했다', '1 전혀 그렇지 않다 … 5 매우 그렇다', true],
  hitl_acceptable: ['End_', 'AI 감사가 표시한 판정만 전문의가 확정하고 나머지는 AI 판정을 쓰는 방식은 타당하다', '1 전혀 그렇지 않다 … 5 매우 그렇다', true]
};
var GC_ADJ_COLS = ['ItemId', 'UnitKey', 'Element', 'Title', 'Combo', 'Question', 'AuditMark', 'AuditCategory', 'RaterVerdict',
  'AIFinal', 'N', 'AgreeN', 'Met', 'Deducted', 'NotApplicable', 'Adjudicated', 'Status', 'Comments'];
var GC_CONC_COLS = ['TargetKey', 'N_AI', 'Met_Raw', 'Met_AI', 'Score_Raw', 'Score_AI', 'N_Adj', 'Met_Adj', 'ConcordanceScore',
  'FlaggedItems', 'Adjudicated', 'Pending'];

// ============================================================
// HEADERS
// ============================================================
function gcSessHeaders_() {
  return ['FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorCode', 'EvaluatorId', 'Part',
    'SequenceIndex', 'SeqSource', 'Order', 'Status', 'ItemsTotal', 'ItemsDone', 'AgreeN', 'DisagreeN', 'LinkedSessionId',
    'SessionOrdinal', 'DeviceId', 'VisitId', 'Src', 'Site', 'Wave', 'PartPreselected', 'ConsentVersion', 'ConsentAt',
    'ConsentInherited', 'InstrumentVersion', 'Incentive', 'StartedAt', 'FinishedAt', 'TotalActiveMin', 'TotalWallMin', 'Resumes',
    'SendFailures', 'FurthestUnit', 'FurthestItem', 'LastActivityAt', 'OverallComment', 'FormFactor', 'ViewportW', 'ViewportH',
    'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion'];
}

function gcJudgHeaders_() {
  return ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorCode', 'EvaluatorId', 'Part', 'SequenceIndex',
    'SessionOrdinal', 'UnitOrder', 'ItemOrder', 'UnitKey', 'PatientId', 'Model', 'Combo', 'Question', 'Element', 'ItemId',
    'TargetKey', 'AuditMark', 'AuditCategory', 'RaterVerdict', 'AuditCorrected', 'AIFinal', 'Agree', 'PhysVerdict',
    'PhysVerdict_code', 'AgreeWithRater', 'AgreeWithAIFinal', 'Comment', 'AnsweredAt', 'ItemSec', 'ActiveSec', 'TTFDSec',
    'Changes', 'OpenedCriterion', 'OpenedFullAnswer', 'OpenedBasis', 'OpenedPatient', 'ClientMismatch', 'AppVersion',
    'DataVersion', 'BackendVersion'];
}

// ============================================================
// ITEM METADATA (GC_ITEMS, generated)
// ============================================================
function gcItems_() {
  return (typeof GC_ITEMS !== 'undefined' && GC_ITEMS && GC_ITEMS.units) ? GC_ITEMS : { data_version: '', units: {} };
}

var GC_ITEM_INDEX_ = null;
function gcItem_(id) {
  if (!GC_ITEM_INDEX_) {
    GC_ITEM_INDEX_ = {};
    var U = gcItems_().units;
    Object.keys(U).forEach(function (k) {
      (U[k].items || []).forEach(function (m) { GC_ITEM_INDEX_[m.id] = m; });
    });
  }
  return Object.prototype.hasOwnProperty.call(GC_ITEM_INDEX_, id) ? GC_ITEM_INDEX_[id] : null;
}

function gcUnitItemCount_(key) {
  var u = gcItems_().units[key];
  return u && u.items ? u.items.length : 0;
}

function gcPartOf_(unitKey) {
  var found = '';
  Object.keys(GC_PARTS).forEach(function (p) { if (GC_PARTS[p].indexOf(unitKey) >= 0) found = p; });
  return found;
}

/** ItemId "P051_gpt|C3|Q2.1-02" → "P051_gpt|C3|P2", "P051_gpt|P1|Q1.1-04" → "P051_gpt|P1" (GC_ITEMS 에 없을 때) */
function gcTargetKey_(itemId) {
  var a = String(itemId || '').split('|');
  if (a.length < 3) return '';
  if (a[1] === 'P1') return a[0] + '|P1';
  var ph = /^Q(\d)/.exec(a[2]);
  return /^C\d$/.test(a[1]) && ph ? a[0] + '|' + a[1] + '|P' + ph[1] : '';
}

// ============================================================
// REQUEST HANDLING (doPost → gcHandle_)
// ============================================================
/** doPost(gc_main.gs)가 잠금을 잡고 검사를 마친 뒤 호출. result 에 응답 필드를 채운다. */
function gcHandle_(ss, db, p, result) {
  if (p.action === 'gc_start') {
    result.seq_index = gcStart_(ss, db, p);
  } else if (p.action === 'gc_judgment') {
    gcWriteJudgment_(ss, db, p, p.judgment, false);
    gcUpsertSession_(ss, db, p, 'in_progress');
  } else if (p.action === 'gc_finish') {
    (p.judgments || []).forEach(function (j) { gcWriteJudgment_(ss, db, p, j, true); });
    gcUpsertSession_(ss, db, p, 'completed');
  } else if (p.action === 'gc_progress') {
    gcProgress_(ss, db, p);
  }
  // 판정 시트를 마지막에 기록 (CA 의 Responses 와 같은 이유: 재전송 판단 기준이 다른 시트보다 먼저 생기지 않도록)
  [GC_SHEET.SESS, GC_SHEET.JUDG].forEach(function (k) { if (db[k]) tFlush_(db[k]); });
}

function gcPart_(p) { return String(p.part || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 8); }

/** 숫자면 숫자, 아니면 빈칸 (NaN 이 시트에 들어가지 않도록) */
function gcNum_(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}
function gcSec_(ms) { var n = gcNum_(ms); return n === '' ? '' : Math.round(n / 100) / 10; }
function gcMin_(ms) { var n = gcNum_(ms); return n === '' ? '' : Math.round(n / 6000) / 10; }
function gcVal_(v, len) { return (typeof v === 'number' && isFinite(v)) ? v : short_(v, len || 40); }
function gcBool_(v) { return (v === undefined || v === null || v === '') ? '' : !!v; }
function gcTime_(v) {
  if (v instanceof Date) return v.getTime();
  var t = Date.parse(String(v == null ? '' : v));
  return isNaN(t) ? NaN : t;
}

/** 가명 코드: 같은 사람(정규화한 성명)은 기기가 달라도 같은 코드 G001… (테스트 GT001…). CA 의 E/T 코드와 별도 네임스페이스. */
function gcEvaluatorCode_(p) {
  var ev = p.evaluator || {};
  var name = String(ev.name || '').replace(/\s+/g, '').toLowerCase();
  if (!name) return '';
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, name + '|endo', Utilities.Charset.UTF_8);
  var hex = bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('').slice(0, 24);
  var props = PropertiesService.getScriptProperties();
  var key = (p.is_test ? 'GCT_' : 'GCC_') + hex;
  var code = props.getProperty(key);
  if (!code) {
    var ck = p.is_test ? 'GCT_COUNTER' : 'GCC_COUNTER';
    var n = Number(props.getProperty(ck) || '0') + 1;
    props.setProperty(ck, String(n));
    code = (p.is_test ? 'GT' : 'G') + ('00' + n).slice(-3);
    props.setProperty(key, code);
  }
  return code;
}

/** 전문의 정보 컬럼 (GC_Sessions): 프로필 항목은 Eval_<id> (+ _code) 로 자동 추가 */
function gcEvalCols_(p) {
  if (p._gcev) return p._gcev;
  var ev = p.evaluator || {};
  var o = {
    EvaluatorName: short_(ev.name, 100), EvaluatorCode: gcEvaluatorCode_(p), EvaluatorId: short_(p.evaluator_id, 40),
    SessionOrdinal: gcNum_(p.session_ordinal)
  };
  var f = ev.fields || {}, cd = ev.codes || {};
  Object.keys(f).forEach(function (k) { if (/^[A-Za-z0-9_]{1,40}$/.test(k)) o['Eval_' + k] = short_(f[k], 120); });
  Object.keys(cd).forEach(function (k) { if (/^[A-Za-z0-9_]{1,40}$/.test(k)) o['Eval_' + k + '_code'] = Number(cd[k]) || ''; });
  p._gcev = o;
  return o;
}

function gcItemsTotal_(p) {
  var units = (p.order && p.order.length) ? p.order : (GC_PARTS[gcPart_(p)] || []);
  var n = 0;
  units.forEach(function (k) { n += gcUnitItemCount_(String(k)); });
  return n || '';
}

/** 제시 순서 배정 (Part 안에서 균형). 이미 배정된 세션은 같은 값을 돌려준다. */
function gcStart_(ss, db, p) {
  var t = table_(ss, db, GC_SHEET.SESS, gcSessHeaders_());
  var idx = tFind_(t, { SessionId: p.session_id });
  var n = Math.min(Math.max(Math.floor(Number(p.n_sequences)) || 2, 1), 24);
  var part = gcPart_(p);
  var hasClientSeq = p.seq_source === 'local' && p.sequence_index !== null && p.sequence_index !== undefined;
  var seq;
  if (hasClientSeq) {
    seq = Number(p.sequence_index);        // 기기에서 이미 배정해 진행 중 → 그 값을 기록
  } else if (idx >= 0) {
    var cur = tGet_(t, idx, 'SequenceIndex');
    if (cur !== '' && cur !== null) seq = Number(cur);
  }
  if (seq === undefined || isNaN(seq)) {
    seq = p.is_test ? Math.floor(Math.random() * n) : gcBalancedSeq_(t, n, part);
  }
  p.sequence_index = seq;
  gcUpsertSession_(ss, db, p, 'started');
  return seq;
}

/**
 * 균형 배정 (CA core.gs nextBalancedSeq_ 와 같은 규칙, 같은 Part 안에서만): 실제(비테스트) 세션 중 판정이 1건 이상
 * 들어온 세션(in_progress/completed)과 최근 2시간 이내 시작한 세션(started)을 순서별로 세어 가장 적은 순서를 배정.
 * 동률이면 순환 카운터(스크립트 속성 GC_SEQ_COUNTER_<Part>) 순서. → 중도 이탈자가 균형을 깨지 않음.
 */
function gcBalancedSeq_(t, n, part) {
  var props = PropertiesService.getScriptProperties();
  var key = 'GC_SEQ_COUNTER' + (part ? '_' + part : '');
  var counter = Number(props.getProperty(key) || '0');
  props.setProperty(key, String(counter + 1));
  var counts = [];
  for (var i = 0; i < n; i++) counts.push(0);
  var now = Date.now();
  t.rows.forEach(function (r) {
    if (isTrue_(r[t.map.IsTest - 1])) return;
    if (t.map.Part && String(r[t.map.Part - 1]) !== String(part)) return;   // 같은 Part 안에서만 균형
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

/** ItemsDone / AgreeN / DisagreeN: 이 세션의 GC_Judgments 행(요청 중 메모리 반영분 포함)에서 다시 센다 */
function gcCounts_(ss, db, sid) {
  var t = table_(ss, db, GC_SHEET.JUDG, gcJudgHeaders_());
  var cs = t.map.SessionId, cv = t.map.PhysVerdict, ca = t.map.Agree;
  var done = 0, agree = 0, dis = 0;
  t.rows.forEach(function (r) {
    if (String(r[cs - 1]) !== String(sid) || GC_VERDICTS.indexOf(String(r[cv - 1])) < 0) return;
    done++;
    if (isTrue_(r[ca - 1])) agree++; else dis++;
  });
  return { ItemsDone: done, AgreeN: agree, DisagreeN: dis };
}

function gcUpsertSession_(ss, db, p, status) {
  var t = table_(ss, db, GC_SHEET.SESS, gcSessHeaders_());
  var s = p.session || {}, d = p.device || {};
  var idx = tFind_(t, { SessionId: p.session_id });
  var prevStatus = idx >= 0 ? String(tGet_(t, idx, 'Status')) : '';
  var rank = { started: 1, in_progress: 2, completed: 3 };
  if (prevStatus && rank[prevStatus] > rank[status]) status = prevStatus;   // 상태는 후퇴하지 않음
  var stale = prevStatus === 'completed' && p.action !== 'gc_finish';      // 완료 후 늦게 온 메시지는 시간 요약을 되돌리지 않음

  var row = {
    ServerUpdatedAt: new Date(), SessionId: p.session_id, IsTest: !!p.is_test, Status: status,
    AppVersion: short_(p.app_version, 80), DataVersion: short_(p.data_version, 80), BackendVersion: GC_BACKEND_VERSION
  };
  var part = gcPart_(p);
  if (part) row.Part = part;
  if (p.sequence_index !== null && p.sequence_index !== undefined) row.SequenceIndex = gcNum_(p.sequence_index);
  if (p.seq_source) row.SeqSource = short_(p.seq_source, 16);
  if (p.order && p.order.length) row.Order = p.order.map(function (k) { return short_(k, 40); }).join(' > ');
  var tot = gcItemsTotal_(p);
  if (tot !== '') row.ItemsTotal = tot;
  if (p.linked_session_id) row.LinkedSessionId = short_(p.linked_session_id, 40);
  if (p.device_id) row.DeviceId = short_(p.device_id, 40);
  if (p.visit_id) row.VisitId = short_(p.visit_id, 40);
  var en = p.entry || {}, cs = p.consent || {};
  if (p.entry) {
    row.Src = short_(en.src); row.Site = short_(en.site); row.Wave = short_(en.wave || p.wave);
    row.PartPreselected = !!en.part_preselected;
  }
  if (p.consent) { row.ConsentVersion = short_(cs.version); row.ConsentAt = short_(cs.at, 40); row.ConsentInherited = !!cs.inherited; }
  if (p.instrument_version) row.InstrumentVersion = short_(p.instrument_version, 120);
  if (p.incentive !== undefined) row.Incentive = short_(p.incentive, 120);
  if (idx < 0) row.FirstSeenAt = new Date();
  if (p.session && !stale) {
    if (s.started_at) row.StartedAt = short_(s.started_at, 40);
    if (s.finished_at) row.FinishedAt = short_(s.finished_at, 40);
    row.TotalActiveMin = gcMin_(s.total_active_ms);
    row.TotalWallMin = gcMin_(s.total_wall_ms);
    row.Resumes = gcNum_(s.resumes);
    row.SendFailures = gcNum_(s.send_failures);
  }
  if (p.action === 'gc_finish') {
    row.OverallComment = clip_(String(p.overall_comment || ''));
    Object.assign(row, itemCols_(p.end_items, 'End_'));
  }
  if (p.device) {
    row.FormFactor = short_(d.form_factor, 20); row.ViewportW = gcNum_(d.vw); row.ViewportH = gcNum_(d.vh);
    row.UserAgent = short_(d.ua, 400);
  }
  Object.assign(row, gcCounts_(ss, db, p.session_id));
  Object.assign(row, gcEvalCols_(p));
  tWrite_(t, idx, row);
}

/** 판정 1건 upsert (SessionId + ItemId). 메타데이터는 서버의 GC_ITEMS 를 우선(없으면 클라이언트 값). */
function gcWriteJudgment_(ss, db, p, j, fromFinish) {
  if (!j || !j.item_id) return;
  var itemId = short_(j.item_id, 80);
  var m = gcItem_(itemId) || {};
  var t = table_(ss, db, GC_SHEET.JUDG, gcJudgHeaders_());
  var idx = tFind_(t, { SessionId: p.session_id, ItemId: itemId });

  var unit = m.unit || short_(j.unit, 40) || itemId.split('|')[0];
  var final = m.final || short_(j.ai_final, 20);
  var rater = m.rater_verdict || short_(j.rater_verdict, 20);
  var phys = GC_VERDICTS.indexOf(j.phys_verdict) >= 0 ? j.phys_verdict : (j.agree === true ? final : '');
  // Agree 는 서버가 계산: 전문의 판정 = 서버의 AI 최종 판정(AIFinal). 사이트의 판정 자료가 서버와 어긋나도 Agree·AgreeN 이 모순되지 않게.
  var agree = phys ? phys === final : '';
  var comment = clip_(String(j.comment || ''));
  if (idx >= 0) {
    // 늦게 도착한 이전 판정은 더 최근 판정을 덮지 않는다
    var prevAt = gcTime_(tGet_(t, idx, 'AnsweredAt')), newAt = gcTime_(j.answered_at);
    if (!isNaN(prevAt) && !isNaN(newAt) && newAt < prevAt) return;
    // finish 에 다시 실려 온 같은 판정: 판정·ServerUpdatedAt 은 그대로 두고, 그 뒤 다시 본 시간과 연 자료만 반영
    // (ItemSec·ActiveSec·Changes 는 기기의 누적값 → 큰 값, Opened* 는 한 번이라도 열었으면 TRUE)
    if (fromFinish && sameTime_(tGet_(t, idx, 'AnsweredAt'), j.answered_at) &&
      String(tGet_(t, idx, 'PhysVerdict')) === phys && String(tGet_(t, idx, 'Comment')) === comment) {
      gcMergeFinishTiming_(t, idx, j);
      return;
    }
  }
  var ev = gcEvalCols_(p);
  var o = j.opened || {};
  var row = {
    ServerUpdatedAt: new Date(), SessionId: p.session_id, IsTest: !!p.is_test,
    EvaluatorName: ev.EvaluatorName, EvaluatorCode: ev.EvaluatorCode, EvaluatorId: ev.EvaluatorId, Part: gcPart_(p),
    SequenceIndex: gcNum_(p.sequence_index), SessionOrdinal: ev.SessionOrdinal,
    UnitOrder: gcNum_(j.unit_order), ItemOrder: gcNum_(j.item_order), UnitKey: unit,
    PatientId: m.patient || short_(j.patient, 20) || unit.split('_')[0],
    Model: m.model || unit.split('_').slice(1).join('_'),
    Combo: m.combo !== undefined ? m.combo : gcNum_(j.combo),
    Question: m.question || short_(j.question, 20), Element: m.element || short_(j.element, 40), ItemId: itemId,
    TargetKey: m.target_key || gcTargetKey_(itemId),
    AuditMark: m.audit_mark || short_(j.audit_mark, 20), AuditCategory: m.audit_category || short_(j.audit_category, 80),
    RaterVerdict: rater, AuditCorrected: m.id ? (m.audit_corrected || '') : short_(j.audit_corrected, 20), AIFinal: final,
    Agree: agree, PhysVerdict: phys, PhysVerdict_code: phys ? GC_VERDICTS.indexOf(phys) + 1 : '',
    AgreeWithRater: phys ? phys === rater : '', AgreeWithAIFinal: phys ? phys === final : '',
    Comment: comment, AnsweredAt: short_(j.answered_at, 40),
    ItemSec: gcSec_(j.item_ms), ActiveSec: gcSec_(j.active_ms), TTFDSec: gcSec_(j.ttfd_ms), Changes: gcNum_(j.changes),
    OpenedCriterion: gcBool_(o.criterion), OpenedFullAnswer: gcBool_(o.full_answer), OpenedBasis: gcBool_(o.basis),
    OpenedPatient: gcBool_(o.patient), ClientMismatch: gcClientMismatch_(p, j, m, final, phys),
    AppVersion: short_(p.app_version, 80), DataVersion: short_(p.data_version, 80), BackendVersion: GC_BACKEND_VERSION
  };
  tWrite_(t, idx, row);
}

/**
 * 사이트가 보낸 값이 서버의 GC_ITEMS 와 다른 점 (빈칸 = 일치). 사이트(gc_items.js)와 붙여넣은 GcCode.gs 의 자료가
 * 어긋난 경우를 찾기 위한 기록이며, 집계는 언제나 서버의 AIFinal 기준이다.
 */
function gcClientMismatch_(p, j, m, final, phys) {
  var out = [];
  var dv = String(gcItems_().data_version || '');
  if (dv && p.data_version && String(p.data_version) !== dv) out.push('data_version ' + short_(p.data_version, 40) + ' ≠ ' + dv);
  if (m && m.id && j.ai_final && String(j.ai_final) !== String(final)) out.push('ai_final ' + short_(j.ai_final, 20) + ' ≠ ' + final);
  if (typeof j.agree === 'boolean' && phys && j.agree !== (phys === final)) out.push('agree(사이트) ' + j.agree);
  return out.join('; ');
}

/** finish 사본의 누적 시간·연 자료를 기존 행에 반영 (판정이 같아 행을 다시 쓰지 않을 때) */
function gcMergeFinishTiming_(t, idx, j) {
  var upd = {}, o = j.opened || {};
  [['ItemSec', gcSec_(j.item_ms)], ['ActiveSec', gcSec_(j.active_ms)], ['Changes', gcNum_(j.changes)]].forEach(function (x) {
    if (x[1] === '') return;
    var cur = tGet_(t, idx, x[0]);
    if (cur === '' || cur === null || isNaN(Number(cur)) || x[1] > Number(cur)) upd[x[0]] = x[1];
  });
  [['OpenedCriterion', o.criterion], ['OpenedFullAnswer', o.full_answer], ['OpenedBasis', o.basis], ['OpenedPatient', o.patient]]
    .forEach(function (x) { if (x[1] === true && !isTrue_(tGet_(t, idx, x[0]))) upd[x[0]] = true; });
  if (Object.keys(upd).length) tWrite_(t, idx, upd);
}

/** 이탈 지점 기록: 완료된 세션은 건드리지 않음 */
function gcProgress_(ss, db, p) {
  var t = table_(ss, db, GC_SHEET.SESS, gcSessHeaders_());
  var idx = tFind_(t, { SessionId: p.session_id });
  if (idx >= 0 && String(tGet_(t, idx, 'Status')) === 'completed') return;
  var g = p.progress || {};
  var row = {
    ServerUpdatedAt: new Date(), SessionId: p.session_id, IsTest: !!p.is_test,
    FurthestUnit: gcVal_(g.furthest_unit, 40), FurthestItem: gcVal_(g.furthest_item, 80), LastActivityAt: short_(g.last_activity_at, 40)
  };
  if (idx < 0) {
    row.FirstSeenAt = new Date(); row.Status = 'started'; row.BackendVersion = GC_BACKEND_VERSION;
    var part = gcPart_(p);
    if (part) row.Part = part;
    if (p.sequence_index !== null && p.sequence_index !== undefined) row.SequenceIndex = gcNum_(p.sequence_index);
    if (p.order && p.order.length) row.Order = p.order.map(function (k) { return short_(k, 40); }).join(' > ');
    var tot = gcItemsTotal_(p);
    if (tot !== '') row.ItemsTotal = tot;
  }
  Object.assign(row, gcEvalCols_(p));
  tWrite_(t, idx, row);
}

// ============================================================
// SUMMARY: buildGcSummary
// ============================================================
function buildGcSummaryIncludingTests() { return buildGcSummary(true); }

function buildGcSummary(includeTests) {
  includeTests = includeTests === true;   // 메뉴·트리거가 넘기는 이벤트 객체는 false 로 취급
  var props = PropertiesService.getScriptProperties();
  var wasDirty = props.getProperty('GC_SUMMARY_DIRTY') === '1';
  if (typeof props.deleteProperty === 'function') props.deleteProperty('GC_SUMMARY_DIRTY');
  else props.setProperty('GC_SUMMARY_DIRTY', '0');
  try {
    var ss = gcSs_();
    var G = gc_load_(ss, includeTests);
    gc_adjudicate_(G);
    var adj = gc_adjRows_(G), conc = gc_concRows_(G), sum = gc_summary_(G), cb = gc_codebook_(G);
    var width = SM_WIDTH;
    sum.rows.forEach(function (r) { if (r.length > width) width = r.length; });
    sm_write_(ss, GC_SHEET.ADJ, adj, GC_ADJ_COLS.length, [0], true);
    sm_write_(ss, GC_SHEET.CONC, conc, GC_CONC_COLS.length, [0], true);
    sm_write_(ss, GC_SHEET.SUMMARY, sum.rows, width, sum.bold, false);
    sm_write_(ss, GC_SHEET.CODEBOOK, cb, cb[0].length, [0], true);
    var at = new Date().toISOString();
    props.setProperty('GC_SUMMARY_BUILT_AT', at);
    var res = {
      builtAt: at, includeTests: includeTests, physicians: G.phys.length, sessions: G.pool.length,
      judgments: G.counted.length, items: G.items.length,
      adjudicated: G.items.filter(function (it) { return it.decided; }).length
    };
    Logger.log('✅ GC_Summary 갱신: ' + JSON.stringify(res));
    return res;
  } catch (err) {
    if (wasDirty) { try { props.setProperty('GC_SUMMARY_DIRTY', '1'); } catch (e2) {} }
    throw err;
  }
}

function gc_load_(ss, includeTests) {
  var G = {
    includeTests: includeTests,
    S: sm_read_(ss, GC_SHEET.SESS), J: sm_read_(ss, GC_SHEET.JUDG), V: sm_read_(ss, GC_SHEET.VISITS),
    raw: sm_readHeader_(ss, GC_SHEET.RAW),
    units: [], items: [], itemBy: {}, sessions: [], sessBy: {}, pool: [], rows: [], counted: [], phys: [], physBy: {},
    unknownItems: 0, excludedTestSessions: 0, excludedPilotSessions: 0, mismatchRows: 0, visits: []
  };
  var data = gcItems_();
  G.dataVersion = data.data_version || '';
  Object.keys(data.units).forEach(function (k) {
    var u = data.units[k];
    var unit = { key: k, patient: u.patient || k.split('_')[0], model: u.model || '', base: u.concordance_base || {}, items: [], part: gcPartOf_(k) };
    (u.items || []).forEach(function (m) {
      var it = { m: m, id: m.id, unit: unit, part: unit.part, final: m.final, rater: m.rater_verdict, byIdent: {}, votes: [] };
      unit.items.push(it);
      G.items.push(it);
      G.itemBy[m.id] = it;
    });
    G.units.push(unit);
  });

  G.S.rows.forEach(function (o) {
    var id = sm_str_(o.SessionId);
    if (!id) return;
    if (sm_has_(G.sessBy, id)) G.sessBy[id].row = o;
    else gc_addSess_(G, id, o, null);
  });
  G.J.rows.forEach(function (o, i) {
    var sid = sm_str_(o.SessionId), itemId = sm_str_(o.ItemId);
    if (!sid || !itemId) return;
    var s = sm_has_(G.sessBy, sid) ? G.sessBy[sid] : gc_addSess_(G, sid, null, o);
    var v = sm_str_(o.PhysVerdict);
    if (GC_VERDICTS.indexOf(v) < 0) return;
    s.rows.push({ o: o, s: s, i: i, itemId: itemId, v: v, test: s.isTest || sm_bool_(o.IsTest) === true });
  });

  G.sessions.forEach(function (s) { s.pilot = /^pilot/i.test(sm_str_(s.row && s.row.Wave)); });
  G.same = gc_sameName_(G, includeTests);
  var pseudo = 0;
  G.sessions.forEach(function (s) {
    if (s.isTest && !includeTests) { G.excludedTestSessions++; return; }
    G.pool.push(s);   // 참여 흐름 [1] 의 모집단 (파일럿 포함, CA 와 같음)
    if (s.pilot) { G.excludedPilotSessions++; return; }   // 파일럿(Wave=pilot) 판정은 집계에서 제외
    s.rows.forEach(function (j) {
      if (j.test && !includeTests) return;
      var code = sm_str_(j.o.EvaluatorCode) || s.code, evId = sm_str_(j.o.EvaluatorId) || s.evId;
      j.ident = gc_ident_(G, code, evId, s.id);
      j.at = sm_time_(j.o.AnsweredAt);
      j.upd = sm_time_(j.o.ServerUpdatedAt);
      j.comment = sm_str_(j.o.Comment);
      j.item = sm_has_(G.itemBy, j.itemId) ? G.itemBy[j.itemId] : null;
      if (sm_str_(j.o.ClientMismatch) !== '') G.mismatchRows++;
      if (!sm_has_(G.physBy, j.ident)) {
        var e = { ident: j.ident, code: j.ident.indexOf('C:') === 0 ? j.ident.slice(2) : ('X' + ('00' + (++pseudo)).slice(-3)), sessions: [], first: null };
        G.physBy[j.ident] = e;
        G.phys.push(e);
      }
      j.ev = G.physBy[j.ident];
      if (j.ev.sessions.indexOf(s) < 0) j.ev.sessions.push(s);
      G.rows.push(j);
      if (!j.item) { G.unknownItems++; return; }
      var prev = j.item.byIdent[j.ident];
      if (!prev || gc_later_(j, prev)) j.item.byIdent[j.ident] = j;   // 같은 전문의는 가장 최근 판정만
    });
  });
  G.items.forEach(function (it) {
    it.votes = Object.keys(it.byIdent).map(function (k) { return it.byIdent[k]; })
      .sort(function (a, b) { return sm_cmpStr_(a.ev.code, b.ev.code); });
    G.counted = G.counted.concat(it.votes);
  });
  G.phys.forEach(function (e) {
    e.sessions.sort(function (a, b) { return sm_cmpNum_(a.firstSeen, b.firstSeen) || a.ord - b.ord; });
    e.first = e.sessions[0];
  });
  G.phys.sort(function (a, b) { return sm_cmpStr_(a.code, b.code); });
  G.visits = G.V.rows.filter(function (v) { return includeTests || sm_bool_(v.IsTest) !== true; });   // 이 시트의 Visits = GC 소개 화면 방문만
  return G;
}

/** 전문의 식별 키: EvaluatorCode → EvaluatorId → SessionId. 동명이인으로 나눈 코드는 'G001-1' 처럼 EvaluatorId 별로. */
function gc_ident_(G, code, evId, sid) {
  var k = code + '\u0001' + evId;
  if (code && evId && G.same && sm_has_(G.same.sub, k)) return 'C:' + G.same.sub[k];
  return code ? 'C:' + code : evId ? 'I:' + evId : 'S:' + sid;
}

/** 전문의 정보(Eval_*, 코드 열 제외) 서명. 값이 모두 비면 '' */
function gc_profileSig_(row) {
  if (!row) return '';
  var keys = Object.keys(row).filter(function (k) { return /^Eval_/.test(k) && !/_code$/.test(k); }).sort();
  var vals = keys.map(function (k) { return sm_str_(row[k]); });
  return vals.join('') === '' ? '' : keys.map(function (k, i) { return k + '=' + vals[i]; }).join('|');
}

/**
 * 동명이인 의심: 가명 코드는 정규화한 성명만으로 정해지므로(같은 사람의 Part A·B 를 기기가 달라도 잇기 위해),
 * 한 코드에 EvaluatorId(기기에서 만든 전문의 ID)가 둘 이상이면 확인한다.
 *  - 전문의 정보(Eval_*)가 서로 다름 → 다른 사람으로 보고 EvaluatorId 별로 따로 센다 (G001-1, G001-2 …, 처음 나온 순서)
 *  - 정보는 같고 같은 판정을 다른 기기에서 다시 함 → 같은 사람으로 보고(최신 판정만) 표시만 한다
 *  - 정보가 같고 판정이 겹치지 않음(예: Part A 는 휴대폰, Part B 는 PC) → 정상, 표시하지 않음
 * 결과 { sub: {code\u0001evId: 'G001-1'}, flagged: [{code, n, split, why}] } → GC_Summary [0]
 */
function gc_sameName_(G, includeTests) {
  var by = {}, order = [];
  G.sessions.forEach(function (s) {
    if ((s.isTest && !includeTests) || s.pilot) return;
    var pairs = {};
    if (s.code && s.evId) pairs[s.evId] = s.code;
    s.rows.forEach(function (j) {
      var c = sm_str_(j.o.EvaluatorCode) || s.code, e = sm_str_(j.o.EvaluatorId) || s.evId;
      if (c && e && !(j.test && !includeTests)) pairs[e] = c;
    });
    Object.keys(pairs).forEach(function (e) {
      var c = pairs[e];
      if (!sm_has_(by, c)) { by[c] = { ids: {}, list: [] }; order.push(c); }
      var g = by[c];
      if (!sm_has_(g.ids, e)) { g.ids[e] = { evId: e, prof: '', items: {} }; g.list.push(g.ids[e]); }
      var x = g.ids[e];
      if (!x.prof) x.prof = gc_profileSig_(s.row);
      s.rows.forEach(function (j) { if ((sm_str_(j.o.EvaluatorId) || s.evId) === e) x.items[j.itemId] = 1; });
    });
  });
  var out = { sub: {}, flagged: [] };
  order.forEach(function (c) {
    var g = by[c];
    if (g.list.length < 2) return;
    var profs = sm_uniq_(g.list.map(function (x) { return x.prof; }).filter(function (p) { return p !== ''; }));
    var seen = {}, overlap = false;
    g.list.forEach(function (x) { Object.keys(x.items).forEach(function (it) { if (seen[it]) overlap = true; seen[it] = 1; }); });
    if (profs.length >= 2) {
      g.list.forEach(function (x, i) { out.sub[c + '\u0001' + x.evId] = c + '-' + (i + 1); });
      out.flagged.push({ code: c, n: g.list.length, split: true, why: '전문의 정보(Eval_*)가 서로 다름' });
    } else if (overlap) {
      out.flagged.push({ code: c, n: g.list.length, split: false, why: '전문의 정보는 같고 같은 판정을 다른 기기에서 다시 함' });
    }
  });
  return out;
}

function gc_addSess_(G, id, row, jrow) {
  var src = row || {};
  var s = {
    id: id, row: row, ord: G.sessions.length, rows: [],
    isTest: sm_bool_(row ? row.IsTest : (jrow ? jrow.IsTest : '')) === true,
    part: sm_str_(src.Part || (jrow && jrow.Part)), status: sm_str_(src.Status).toLowerCase(),
    code: sm_str_(src.EvaluatorCode || (jrow && jrow.EvaluatorCode)), evId: sm_str_(src.EvaluatorId || (jrow && jrow.EvaluatorId)),
    firstSeen: sm_time_(src.FirstSeenAt), ordinal: sm_num_(src.SessionOrdinal), linked: sm_str_(src.LinkedSessionId)
  };
  G.sessBy[id] = s;
  G.sessions.push(s);
  return s;
}

/** 같은 전문의·같은 판정의 두 행 중 a 가 더 최근인가: AnsweredAt → ServerUpdatedAt → 시트 행 순서 */
function gc_later_(a, b) {
  var c = gc_cmpTime_(a.at, b.at) || gc_cmpTime_(a.upd, b.upd) || (a.i - b.i);
  return c > 0;
}
function gc_cmpTime_(x, y) {
  var fx = sm_fin_(x), fy = sm_fin_(y);
  if (fx && fy) return x - y;
  if (fx !== fy) return fx ? 1 : -1;
  return 0;
}

/** 판정 확정 규칙 (docs/GC_CONTRACT.md) */
function gc_adjudicate_(G) {
  G.items.forEach(function (it) {
    var cnt = { met: 0, deducted: 0, not_applicable: 0 };
    it.votes.forEach(function (v) { cnt[v.v]++; });
    var n = it.votes.length, best = 'met';
    GC_VERDICTS.forEach(function (k) { if (cnt[k] > cnt[best]) best = k; });
    it.cnt = cnt;
    it.n = n;
    it.agreeN = cnt[it.final] || 0;
    if (!n) { it.adj = it.final; it.status = GC_STATUS.PENDING; }
    else if (cnt[best] * 2 > n) {
      it.adj = best;
      it.status = n === 1 ? GC_STATUS.SINGLE : (cnt[best] === n ? GC_STATUS.UNANIMOUS : GC_STATUS.MAJORITY);
    } else { it.adj = it.final; it.status = GC_STATUS.REVIEW; }
    it.decided = it.status === GC_STATUS.UNANIMOUS || it.status === GC_STATUS.MAJORITY || it.status === GC_STATUS.SINGLE;
    it.changed = it.adj !== it.final;
  });
  // TargetKey 별 부합도: concordance_base(AI 감사 후) 에서 출발해 확정 판정이 AI 최종과 다른 만큼 조정
  G.targets = [];
  G.units.forEach(function (u) {
    var keys = Object.keys(u.base).sort(gc_targetCmp_);
    keys.forEach(function (k) {
      var b = u.base[k] || {};
      var t = {
        key: k, unit: u, n: Number(b.n) || 0, metRaw: Number(b.met_raw) || 0, metAi: Number(b.met_ai) || 0,
        items: u.items.filter(function (it) { return it.m.target_key === k; })
      };
      t.nAdj = t.n;
      t.metAdj = t.metAi;
      t.items.forEach(function (it) {
        if (!it.changed) return;
        if (it.adj === 'not_applicable') { t.nAdj--; if (it.final === 'met') t.metAdj--; }
        else if (it.adj === 'met') t.metAdj++;
        else if (it.adj === 'deducted') t.metAdj--;
      });
      t.decided = t.items.filter(function (it) { return it.decided; }).length;
      t.pending = t.items.length - t.decided;
      G.targets.push(t);
    });
  });
}

/** TargetKey 정렬: Phase 1 → Phase 2…5, 같은 Phase 안에서는 조합 순 */
function gc_targetCmp_(a, b) {
  var f = function (k) {
    var m = /\|C(\d+)\|P(\d)$/.exec(k);
    return m ? [Number(m[2]), Number(m[1])] : (/\|P1$/.test(k) ? [1, 0] : [9, 9]);
  };
  var x = f(a), y = f(b);
  return (x[0] - y[0]) || (x[1] - y[1]) || sm_cmpStr_(a, b);
}

function gc_score_(met, n) { return n > 0 ? sm_round_(met / n, 4) : ''; }

function gc_adjRows_(G) {
  var rows = [GC_ADJ_COLS.slice()];
  G.items.forEach(function (it) {
    var m = it.m;
    var comments = it.votes.filter(function (v) { return v.comment !== ''; })
      .map(function (v) { return v.ev.code + ': ' + v.comment; }).join(' / ');
    rows.push([it.id, it.unit.key, m.element, m.title, m.combo, m.question, m.audit_mark, m.audit_category, it.rater, it.final,
      it.n, it.agreeN, it.cnt.met, it.cnt.deducted, it.cnt.not_applicable, it.adj, it.status, comments]);
  });
  return rows;
}

function gc_concRows_(G) {
  var rows = [GC_CONC_COLS.slice()];
  G.targets.forEach(function (t) {
    rows.push([t.key, t.n, t.metRaw, t.metAi, gc_score_(t.metRaw, t.n), gc_score_(t.metAi, t.n), t.nAdj, t.metAdj,
      gc_score_(t.metAdj, t.nAdj), t.items.length, t.decided, t.pending]);
  });
  return rows;
}

// ---------------- GC_Summary ----------------
function gc_summary_(G) {
  var o = sm_out_();
  [gc_s0_, gc_s1_, gc_s2_, gc_s3_, gc_s4_, gc_s5_, gc_s6_, gc_s7_, gc_s8_].forEach(function (f) { f(o, G); });
  return o;
}

function gc_rules_() {
  return [
    '검증 대상 = AI 감사가 △(경미한 지적) 또는 ✗(판정 수정)로 표시한 AI Rater 판정. 나머지 판정은 AI 감사가 확인(✓)한 판정으로 전문의가 다시 보지 않습니다.',
    '테스트 응답(IsTest=TRUE)은 모든 표에서 제외합니다(buildGcSummaryIncludingTests 실행 시에만 포함).',
    '파일럿 세션(Wave 가 pilot 으로 시작, 링크의 ?wave=pilot)은 참여 흐름 [1] 에만 세고, 판정 집계·확정·부합도·[2]–[8] 에서는 제외합니다(CA 와 같은 규칙).',
    '전문의 식별: EvaluatorCode(G001…, 정규화한 성명 기준) → 없으면 EvaluatorId → 없으면 SessionId. 같은 전문의가 같은 판정을 여러 번 했으면 가장 최근 판정(AnsweredAt, 같으면 ServerUpdatedAt)만 셉니다.',
    '동명이인: 한 EvaluatorCode 에 EvaluatorId(기기)가 둘 이상이고 전문의 정보(Eval_*)가 서로 다르면 다른 사람으로 보고 EvaluatorId 별로 따로 셉니다(G001-1, G001-2). 정보가 같으면 한 사람으로 보되, 같은 판정을 다른 기기에서 다시 했으면 [0] "동명이인 의심" 에 표시합니다(연구책임자 확인).',
    'Agree 는 서버가 계산합니다(PhysVerdict = AIFinal, AIFinal 은 서버의 GC_ITEMS). 사이트가 보낸 판정 자료 버전·AI 최종 판정·동의 여부가 서버와 다르면 GC_Judgments.ClientMismatch 에 기록하고 [0] 에 행 수를 표시합니다.',
    'ItemSec·ActiveSec·Changes·Opened* 는 판정 화면의 세션 누적값입니다: 제출(gc_finish)한 세션은 제출 시점, 진행 중 세션은 그 판정에서 마지막으로 [다음]을 누른 시점. TTFDSec 은 처음 결정까지의 시간입니다.',
    '진행 중 세션의 판정도 셉니다(전문의가 [다음]을 눌러 확정한 판정). 판정 n = 그 판정을 검증한 전문의 수.',
    '확정 규칙: n = 0 → 대기(AI 최종 유지). 한 판정이 엄격한 과반(> n/2)이면 그 판정으로 확정: n ≥ 2 이고 모두 같으면 확정(만장일치), n ≥ 3 이고 과반이면 확정(다수결), n = 1 이면 잠정(1인). 과반인 판정이 없으면 추가 검토 필요(AI 최종 유지) — 동수, n = 2 에서 갈림, 세 판정으로 나뉘어 가장 많은 판정도 과반이 아닌 경우(예: n = 4 에서 2·1·1)를 모두 포함합니다.',
    '부합도 조정: TargetKey 마다 AI 감사 후 충족 수(Met_AI)와 채점 판정 수(N_AI)에서 출발해, 확정 판정이 AI 최종과 다르면 충족↔감점은 충족 수를 1 옮기고, 채점 대상 아님은 채점 판정 수에서 빼며(AI 최종이 충족이면 충족 수에서도 뺌). ConcordanceScore = Met_Adj ÷ N_Adj (소수 넷째 자리).',
    '점수표 [6] 의 범위별 점수는 대상 TargetKey 들의 충족 수 합 ÷ 채점 판정 수 합(pooled)입니다.',
    '일치율의 95% CI 는 Wilson. 전문의 간 쌍 일치율 = 문항마다 같은 판정을 한 전문의 쌍의 비율(검증자 n ≥ 2)의 평균. Fleiss κ 는 한 Part 의 모든 문항을 같은 수(≥ 2)의 전문의가 검증했을 때만 계산합니다.',
    '참여 자격(분과전문의 여부)은 기기에서 확인하며 서버에는 자격이 있는 경우만 기록됩니다(자격 없음 응답 수는 집계 불가).'
  ];
}

// [0] 머리말
function gc_s0_(o, G) {
  o.title('가이드라인 부합도 전문의 검증 — 요약 통계 (GC_Summary)');
  o.add(['생성 시각', new Date()]);
  o.add(['테스트 응답', G.includeTests ? '포함 (buildGcSummaryIncludingTests)' : '제외 (IsTest=TRUE 제외)']);
  o.add(['백엔드 버전', GC_BACKEND_VERSION]);
  o.add(['판정 자료 버전 (GC_ITEMS)', G.dataVersion]);
  o.gap();
  o.title('[0] 머리말 — 검증 대상과 포함 규칙');
  o.head(['항목', '값', '', '']);
  o.add(['검증 대상 판정 수 (AI 감사 △/✗)', G.items.length]);
  Object.keys(GC_PARTS).forEach(function (p) {
    o.add(['  Part ' + p, G.items.filter(function (it) { return it.part === p; }).length, GC_PARTS[p].join(' + ')]);
  });
  o.add(['  ✗ (판정 수정) / △ (경미한 지적)', G.items.filter(function (it) { return it.m.audit_mark === 'major'; }).length,
    G.items.filter(function (it) { return it.m.audit_mark === 'minor'; }).length]);
  o.add(['참여 전문의 수 (판정 1건 이상)', G.phys.length]);
  o.add(['집계한 전문의 판정 수 (전문의 × 판정, 최신 1건)', G.counted.length]);
  o.add(['확정·잠정 판정 수', G.items.filter(function (it) { return it.decided; }).length]);
  o.add(['제외한 테스트 세션 수', G.includeTests ? '(포함 모드)' : G.excludedTestSessions]);
  o.add(['제외한 파일럿 세션 수 (Wave=pilot, 참여 흐름에만 포함)', G.excludedPilotSessions]);
  o.add(['동명이인 의심 (같은 EvaluatorCode 에 EvaluatorId 2개 이상)', G.same.flagged.length,
    G.same.flagged.map(function (f) {
      return f.code + ': 기기 ' + f.n + '개, ' + f.why + (f.split ? ' → 따로 집계 (' + f.code + '-1 …)' : ' → 1명으로 집계 (최신 판정)');
    }).join(' / ') || '없음']);
  o.add(['사이트 자료가 서버와 어긋난 판정 행 (GC_Judgments.ClientMismatch)', G.mismatchRows,
    G.mismatchRows ? '사이트 gc/data/gc_items.js 와 붙여넣은 GcCode.gs 의 판정 자료 버전을 맞추세요 (집계는 서버 AIFinal 기준)' : '']);
  if (G.unknownItems) o.add(['GC_ITEMS 에 없는 ItemId 판정 행 (집계 제외)', G.unknownItems]);
  o.gap();
  o.head(['포함 · 파생 규칙']);
  gc_rules_().forEach(function (t, i) { o.add([(i + 1) + '. ' + t]); });
  o.gap();
}

// [1] 참여 흐름
function gc_s1_(o, G) {
  o.title('[1] 참여 흐름 — 테스트 제외');
  o.head(['구분', '방문 수 (GC 소개 화면)', '방문 고유 기기', '세션 시작', '시작만 (started)', '진행 중 (in_progress)', '완료 (completed)',
    '판정 1건 이상 세션', '완료율 (완료 ÷ 시작)', '참여율 (시작 ÷ 방문 기기)']);
  var row = function (label, sess, visits) {
    var by = function (st) { return sess.filter(function (s) { return s.status === st; }).length; };
    var dev = visits ? sm_uniqCount_(visits.map(function (v) { return sm_str_(v.DeviceId); })) : '';
    var done = by('completed');
    o.add([label, visits ? visits.length : '', dev, sess.length, by('started'), by('in_progress'), done,
      sess.filter(function (s) { return s.rows.length > 0; }).length, sess.length ? r3_(done / sess.length) : '',
      (visits && dev) ? r3_(sess.length / dev) : '']);
  };
  row('전체', G.pool, G.V.exists ? G.visits : null);
  Object.keys(GC_PARTS).forEach(function (p) { row('Part ' + p, G.pool.filter(function (s) { return s.part === p; }), null); });
  o.note('방문 = Visits 시트(GC 사이트 소개 화면 조회). Part 는 소개 화면 이후에 고르므로 Part 별 방문 수는 없습니다(링크로 미리 지정한 Part 는 Visits.TypeParam).');
  o.note('참여 자격 질문에서 "아니요"를 고른 방문자는 서버에 기록되지 않습니다(자격/비자격 수는 집계 불가).');
  if (G.excludedPilotSessions) o.note('이 표의 세션에는 파일럿 세션(Wave=pilot) ' + G.excludedPilotSessions + '개가 포함됩니다. 판정 집계([2]–[8])에서는 제외합니다.');
  o.gap();
  var parts = {};
  G.pool.forEach(function (s) {
    if (s.status !== 'completed') return;
    var id = gc_ident_(G, s.code, s.evId, s.id);
    (parts[id] = parts[id] || {})[s.part] = 1;
  });
  o.head(['지표', '값']);
  o.add(['참여 전문의 (판정 1건 이상)', G.phys.length]);
  o.add(['두 Part 를 모두 완료한 전문의', Object.keys(parts).filter(function (k) { return Object.keys(parts[k]).length >= 2; }).length]);
  o.add(['이어서 검증한 세션 (SessionOrdinal = 2 또는 LinkedSessionId)', G.pool.filter(function (s) { return s.ordinal === 2 || s.linked !== ''; }).length]);
  o.add(['서버 대신 기기에서 순서 배정한 세션 (SeqSource = local)', G.pool.filter(function (s) { return sm_str_(s.row && s.row.SeqSource).toLowerCase() === 'local'; }).length]);
  o.gap();
}

// [2] 검증자 특성
function gc_s2_(o, G) {
  var E = G.phys;
  var pick = function (e, k) {
    for (var i = 0; i < e.sessions.length; i++) { var r = e.sessions[i].row; if (r && !sm_blank_(r[k])) return r[k]; }
    return '';
  };
  o.title('[2] 검증자 특성 — 판정 1건 이상 전문의 N = ' + E.length + ' (첫 세션 기준)');
  o.head(['변수', '수준', 'n', '%', '분모']);
  sm_cat_(o, '분과전문의 취득 후 경력 (board_years)', E, function (e) { return sm_item_(pick(e, 'Eval_board_years'), pick(e, 'Eval_board_years_code'), GC_OPT.board_years).label; }, GC_OPT.board_years);
  sm_cat_(o, '주 근무 기관 (setting)', E, function (e) { return sm_item_(pick(e, 'Eval_setting'), pick(e, 'Eval_setting_code'), GC_OPT.setting).label; }, GC_OPT.setting);
  sm_cat_(o, '제2형 당뇨병 진료량 (t2d_volume)', E, function (e) { return sm_item_(pick(e, 'Eval_t2d_volume'), pick(e, 'Eval_t2d_volume_code'), GC_OPT.t2d_volume).label; }, GC_OPT.t2d_volume);
  sm_cat_(o, '검증한 Part 수', E, function (e) { return String(sm_uniq_(e.sessions.map(function (s) { return s.part; }).filter(function (x) { return x; })).length); }, ['1', '2']);
  sm_cat_(o, '유입 경로 (Src)', E, function (e) { return sm_str_(pick(e, 'Src')); }, null, '(없음)');
  sm_cat_(o, '기기 (FormFactor)', E, function (e) { return sm_str_(pick(e, 'FormFactor')); }, ['mobile', 'tablet', 'desktop'], '(미기록)');
  o.gap();
}

// [3] 판정별 결과
function gc_s3_(o, G) {
  o.title('[3] 판정별 결과 — 검증 대상 판정 ' + G.items.length + '건');
  o.head(['ItemId', 'Part', '조합', '문항', '요소', '감사 표시', '감사 분류', 'AI Rater', 'AI 최종', '검증 n', 'AI 최종 동의 n',
    '충족', '감점', '채점 대상 아님', '확정 판정', '상태', '부합도 반영']);
  G.items.forEach(function (it) {
    var m = it.m;
    o.add([it.id, it.part, m.combo ? '조합 ' + m.combo : 'Phase 1', m.question, m.element, GC_MARK_KO[m.audit_mark] || m.audit_mark,
      m.audit_category, GC_VERDICT_KO[it.rater] || it.rater, GC_VERDICT_KO[it.final] || it.final, it.n, it.agreeN,
      it.cnt.met, it.cnt.deducted, it.cnt.not_applicable, GC_VERDICT_KO[it.adj] || it.adj, it.status, it.changed ? '변경' : '']);
  });
  o.gap();
  o.head(['상태', '전체', 'Part A', 'Part B', '✗', '△', '그중 AI 최종과 다른 확정']);
  GC_STATUS_ORDER.forEach(function (st) {
    var arr = G.items.filter(function (it) { return it.status === st; });
    var c = function (f) { return arr.filter(f).length; };
    o.add([st, arr.length, c(function (it) { return it.part === 'A'; }), c(function (it) { return it.part === 'B'; }),
      c(function (it) { return it.m.audit_mark === 'major'; }), c(function (it) { return it.m.audit_mark === 'minor'; }),
      c(function (it) { return it.changed; })]);
  });
  o.add(['합계', G.items.length, G.items.filter(function (it) { return it.part === 'A'; }).length,
    G.items.filter(function (it) { return it.part === 'B'; }).length,
    G.items.filter(function (it) { return it.m.audit_mark === 'major'; }).length,
    G.items.filter(function (it) { return it.m.audit_mark === 'minor'; }).length,
    G.items.filter(function (it) { return it.changed; }).length]);
  o.note('자세한 집계와 전문의 의견은 GC_Adjudication 시트에 있습니다.');
  o.gap();
}

// [4] AI 판정과 전문의의 일치
function gc_s4_(o, G) {
  o.title('[4] AI 판정과 전문의 판정의 일치 — 단위: 전문의 × 판정 (최신 1건)');
  o.head(['구분', '수준', '판정 n', 'AI 최종 동의 n', 'AI 최종 동의율', '95% CI 하한', '95% CI 상한',
    'AI Rater 원판정 동의 n', 'AI Rater 동의율', '95% CI 하한', '95% CI 상한']);
  var row = function (label, level, arr) {
    var n = arr.length;
    var a = arr.filter(function (v) { return v.v === v.item.final; }).length;
    var r = arr.filter(function (v) { return v.v === v.item.rater; }).length;
    var ca = sm_wilson_(a, n), cr = sm_wilson_(r, n);
    o.add([label, level, n, a, n ? r3_(a / n) : '', r3_(ca[0]), r3_(ca[1]), r, n ? r3_(r / n) : '', r3_(cr[0]), r3_(cr[1])]);
  };
  var V = G.counted;
  row('전체', '', V);
  ['major', 'minor'].forEach(function (k) { row('감사 표시', GC_MARK_KO[k], V.filter(function (v) { return v.item.m.audit_mark === k; })); });
  sm_uniq_(G.items.map(function (it) { return it.m.audit_category || '(없음)'; })).sort().forEach(function (c) {
    row('감사 분류', c, V.filter(function (v) { return (v.item.m.audit_category || '(없음)') === c; }));
  });
  Object.keys(GC_PARTS).forEach(function (p) { row('Part', p, V.filter(function (v) { return v.item.part === p; })); });
  o.note('△ 판정은 AI 감사가 판정을 바꾸지 않았으므로 AI 최종 = AI Rater 원판정입니다. ✗ 판정에서 두 동의율의 차이가 AI 감사의 수정이 전문의 판단과 맞는 정도를 보여 줍니다.');
  o.gap();
  o.sub('[4-2] 판정(문항) 단위 — 확정·잠정 판정 중 AI 최종 / AI Rater 원판정과 같은 비율');
  o.head(['구분', '확정·잠정 판정 수', 'AI 최종과 같음', '비율', '95% CI 하한', '95% CI 상한', 'AI Rater 원판정과 같음', '비율']);
  var irow = function (label, arr) {
    var d = arr.filter(function (it) { return it.decided; });
    var a = d.filter(function (it) { return it.adj === it.final; }).length, r = d.filter(function (it) { return it.adj === it.rater; }).length;
    var ci = sm_wilson_(a, d.length);
    o.add([label, d.length, a, d.length ? r3_(a / d.length) : '', r3_(ci[0]), r3_(ci[1]), r, d.length ? r3_(r / d.length) : '']);
  };
  irow('전체', G.items);
  ['major', 'minor'].forEach(function (k) { irow(GC_MARK_KO[k], G.items.filter(function (it) { return it.m.audit_mark === k; })); });
  o.gap();
}

/** 문항 하나의 쌍 일치율 P_i = Σ n_j(n_j − 1) / (n(n − 1)) */
function gc_pairAgree_(it) {
  if (it.n < 2) return NaN;
  var s = 0;
  GC_VERDICTS.forEach(function (k) { s += it.cnt[k] * (it.cnt[k] - 1); });
  return s / (it.n * (it.n - 1));
}

/** Fleiss κ: 모든 문항의 검증자 수가 같고 2 이상일 때만 */
function gc_fleiss_(items) {
  if (!items.length) return { k: NaN, why: '문항 없음' };
  var n = items[0].n;
  if (n < 2 || items.some(function (it) { return it.n !== n; })) return { k: NaN, why: '문항마다 검증자 수가 달라 계산하지 않음' };
  var P = mean_(items.map(gc_pairAgree_));
  var tot = items.length * n, pe = 0;
  GC_VERDICTS.forEach(function (k) {
    var pj = items.reduce(function (a, it) { return a + it.cnt[k]; }, 0) / tot;
    pe += pj * pj;
  });
  if (pe >= 1) return { k: NaN, why: '모든 판정이 한 범주 — κ 정의되지 않음', P: P, pe: pe };
  return { k: (P - pe) / (1 - pe), why: '모든 문항 검증자 ' + n + '명', P: P, pe: pe };
}

// [5] 전문의 간 일치도
function gc_s5_(o, G) {
  o.title('[5] 전문의 간 일치도');
  o.head(['범위', '판정(문항) 수', '검증자 ≥ 2 문항 수', '문항별 검증자 수', '쌍 일치율 (평균)', '만장일치 문항 비율', 'Fleiss κ', 'κ 계산 조건']);
  var row = function (label, items) {
    var m = items.filter(function (it) { return it.n >= 2; });
    var pa = m.map(gc_pairAgree_);
    var ns = items.map(function (it) { return it.n; });
    var lo = ns.length ? Math.min.apply(null, ns) : 0, hi = ns.length ? Math.max.apply(null, ns) : 0;
    var fk = gc_fleiss_(items);
    o.add([label, items.length, m.length, lo === hi ? String(lo) : lo + '–' + hi, pa.length ? r3_(mean_(pa)) : '',
      m.length ? r3_(m.filter(function (it) { return gc_pairAgree_(it) === 1; }).length / m.length) : '', r3_(fk.k), fk.why]);
  };
  Object.keys(GC_PARTS).forEach(function (p) { row('Part ' + p, G.items.filter(function (it) { return it.part === p; })); });
  row('전체', G.items);
  o.note('범주 = 충족 / 감점 / 채점 대상 아님. 쌍 일치율 = 같은 판정을 한 전문의 쌍의 비율(문항 평균, 검증자 ≥ 2 문항만).');
  o.gap();
}

// [6] 부합도 점수표
function gc_s6_(o, G) {
  o.title('[6] 가이드라인 부합도 점수 — AI Rater 원판정 → AI 감사 → 전문의 확정 반영');
  o.head(['답변 (UnitKey)', 'Part', '범위', '채점 판정 수 (AI)', '충족 (원판정)', '점수 (원판정)', '충족 (AI 감사 후)', '점수 (AI 감사 후)',
    '채점 판정 수 (확정 반영)', '충족 (확정 반영)', '점수 (확정 반영)', '변화 (확정 − AI 감사)', '검증 대상 판정', '확정·잠정', '대기·검토']);
  G.units.forEach(function (u) {
    var T = G.targets.filter(function (t) { return t.unit === u; });
    var scopes = [['Phase 1', function (t) { return /\|P1$/.test(t.key); }],
      ['Phase 2–5', function (t) { return /\|C\d+\|/.test(t.key); }]];
    sm_uniq_(T.map(function (t) { var m = /\|C(\d+)\|/.exec(t.key); return m ? m[1] : ''; }).filter(function (x) { return x; }))
      .sort().forEach(function (c) { scopes.push(['조합 ' + c + ' (Phase 2–5)', function (t) { return t.key.indexOf('|C' + c + '|') >= 0; }]); });
    scopes.forEach(function (sc) {
      var arr = T.filter(sc[1]);
      var sum = function (f) { return arr.reduce(function (a, t) { return a + t[f]; }, 0); };
      var n = sum('n'), nAdj = sum('nAdj'), sAi = gc_score_(sum('metAi'), n), sAdj = gc_score_(sum('metAdj'), nAdj);
      var fl = arr.reduce(function (a, t) { return a + t.items.length; }, 0), dec = sum('decided');
      o.add([u.key, u.part, sc[0], n, sum('metRaw'), gc_score_(sum('metRaw'), n), sum('metAi'), sAi, nAdj, sum('metAdj'), sAdj,
        (sAi !== '' && sAdj !== '') ? sm_round_(sAdj - sAi, 4) : '', fl, dec, fl - dec]);
    });
  });
  o.note('TargetKey 별 값은 GC_Concordance 시트에 있습니다. TargetKey 와 ConcordanceScore 두 열을 CA 스프레드시트의 Concordance 시트에 붙여 넣으면 CA Summary [14] 에 의사 평정과 나란히 표시됩니다.');
  o.gap();
}

// [7] 소요 시간
function gc_s7_(o, G) {
  o.title('[7] 소요 시간 — 판정 1건 (테스트 외 세션의 모든 판정 행)');
  o.head(['지표', '대상', 'n', '중앙값', 'Q1', 'Q3', '최소', '최대']);
  var R = G.rows.filter(function (j) { return !!j.item; });
  var col = function (arr, k) { return arr.map(function (j) { return sm_num_(j.o[k]); }).filter(sm_fin_); };
  var groups = [['전체', R],
    ['✗ (판정 수정)', R.filter(function (j) { return j.item.m.audit_mark === 'major'; })],
    ['△ (경미한 지적)', R.filter(function (j) { return j.item.m.audit_mark === 'minor'; })],
    ['AI 최종에 동의', R.filter(function (j) { return j.v === j.item.final; })],
    ['AI 최종에 비동의', R.filter(function (j) { return j.v !== j.item.final; })]];
  [['판정 화면 표시 시간 (초, ItemSec)', 'ItemSec'], ['판정 화면 active 시간 (초, ActiveSec)', 'ActiveSec'],
    ['첫 결정까지 시간 (초, TTFDSec)', 'TTFDSec']].forEach(function (m) {
    groups.forEach(function (g) { o.add(sm_descRow_(m[0], g[0], col(g[1], m[1]), 1)); });
  });
  var done = G.pool.filter(function (s) { return s.status === 'completed' && s.row && !s.pilot; });
  o.add(sm_descRow_('세션 총 active 시간 (분)', '완료 세션', done.map(function (s) { return sm_num_(s.row.TotalActiveMin); }).filter(sm_fin_), 1));
  o.add(sm_descRow_('세션 시작~제출 경과 시간 (분)', '완료 세션', done.map(function (s) { return sm_num_(s.row.TotalWallMin); }).filter(sm_fin_), 1));
  var op = function (k) { var v = R.map(function (j) { return sm_bool_(j.o[k]); }).filter(function (b) { return b !== null; }); return v; };
  o.gap();
  o.head(['참고 자료를 연 비율', '판정 행 n', '연 n', '비율']);
  [['감점 기준 전문 (OpenedCriterion)', 'OpenedCriterion'], ['이 조합 전체 답변·처방 (OpenedFullAnswer)', 'OpenedFullAnswer'],
    ['채점표 적용 근거 (OpenedBasis)', 'OpenedBasis'], ['환자 정보 (OpenedPatient)', 'OpenedPatient']].forEach(function (x) {
    var v = op(x[1]), h = v.filter(function (b) { return b; }).length;
    o.add([x[0], v.length, h, v.length ? r3_(h / v.length) : '']);
  });
  o.gap();
}

// [8] 마지막 문항 · 의견
function gc_s8_(o, G) {
  o.title('[8] 마지막 문항 (END_ITEMS, 1 전혀 그렇지 않다 … 5 매우 그렇다) — 완료 세션 단위');
  o.head(['문항', '설명', '응답 세션 n', '1', '2', '3', '4', '5', '4점 이상 비율', '중앙값']);
  var S = G.pool.filter(function (s) { return s.status === 'completed' && s.row && !s.pilot; });
  var ids = [];
  G.S.cols.forEach(function (c) {
    var m = /^End_(.+?)(_code)?$/.exec(c);
    if (m && ids.indexOf(m[1]) < 0) ids.push(m[1]);
  });
  Object.keys(GC_CB_ITEMS).forEach(function (k) { if (GC_CB_ITEMS[k][0] === 'End_' && ids.indexOf(k) < 0) ids.push(k); });
  ids.forEach(function (id) {
    var v = S.map(function (s) { return sm_item_(s.row['End_' + id], s.row['End_' + id + '_code'], null).code; })
      .filter(function (c) { return c >= 1 && c <= 5; }).map(Math.round);
    var d = [1, 2, 3, 4, 5].map(function (x) { return v.filter(function (y) { return y === x; }).length; });
    o.add([id, sm_has_(GC_CB_ITEMS, id) ? GC_CB_ITEMS[id][1] : '', v.length].concat(d)
      .concat([v.length ? r3_((d[3] + d[4]) / v.length) : '', v.length ? r2_(median_(v)) : '']));
  });
  o.gap();
  o.head(['의견', '값', '해당 n', '분모']);
  var V = G.counted, dis = V.filter(function (v) { return v.v !== v.item.final; });
  var cm = function (arr) { return arr.filter(function (v) { return v.comment !== ''; }).length; };
  o.add(['판정 의견을 남긴 비율 (전체)', V.length ? r3_(cm(V) / V.length) : '', cm(V), V.length]);
  o.add(['판정 의견을 남긴 비율 (AI 최종에 비동의한 판정)', dis.length ? r3_(cm(dis) / dis.length) : '', cm(dis), dis.length]);
  var oc = S.filter(function (s) { return sm_str_(s.row.OverallComment) !== ''; }).length;
  o.add(['전체 의견을 남긴 완료 세션 비율', S.length ? r3_(oc / S.length) : '', oc, S.length]);
  o.note('의견 원문: 판정 의견은 GC_Adjudication.Comments(가명 코드와 함께)와 GC_Judgments.Comment, 전체 의견은 GC_Sessions.OverallComment.');
  o.gap();
}

// ============================================================
// CODEBOOK (GC_Codebook: 시트 · 컬럼 · 설명 · 값/단위 · 시트에 있음)
// ============================================================
function gc_codebook_(G) {
  var rows = [['Sheet', 'Column', 'Description', 'Type / values', 'InSheet']];
  var defs = {};
  gcCbDefs_(function (k, desc, type) { defs[k] = [desc, type]; });
  var lists = gcCbLists_();
  var present = {};
  present[GC_SHEET.VISITS] = G.V; present[GC_SHEET.SESS] = G.S; present[GC_SHEET.JUDG] = G.J; present[GC_SHEET.RAW] = G.raw;
  Object.keys(lists).forEach(function (sheet) {
    var t = present[sheet], actual = t ? t.cols : [];
    var seen = {};
    var emit = function (col, inSheet) {
      if (sm_has_(seen, col)) return;
      seen[col] = 1;
      var d = (sm_has_(defs, sheet + '.' + col) && defs[sheet + '.' + col]) || gcCbItem_(col) || (sm_has_(defs, col) && defs[col]) ||
        ['(설명 없음 — 이전 버전 또는 추가 컬럼)', ''];
      var where = t ? (inSheet ? 'Y' : (t.exists ? 'N' : '(시트 없음)')) : '(요약 실행 시 생성)';
      rows.push([sheet, col, d[0], d[1], where]);
    };
    lists[sheet].forEach(function (c) { emit(c, actual.indexOf(c) >= 0); });
    actual.forEach(function (c) { emit(c, true); });   // Eval_* · End_* 등 동적 컬럼
  });
  Object.keys(GC_CB_ITEMS).forEach(function (id) {
    var it = GC_CB_ITEMS[id];
    rows.push(['(문항 정의)', it[0] + id, it[1], it[2], '']);
    if (it[3]) rows.push(['(문항 정의)', it[0] + id + '_code', it[1] + ' — 코드', '정수 (선택지 순서, 1부터)', '']);
  });
  return rows;
}

function gcCbLists_() {
  var o = {};
  o[GC_SHEET.VISITS] = visitsHeaders_();
  o[GC_SHEET.SESS] = gcSessHeaders_();
  o[GC_SHEET.JUDG] = gcJudgHeaders_();
  o[GC_SHEET.RAW] = rawHeaders_();
  o[GC_SHEET.ADJ] = GC_ADJ_COLS.slice();
  o[GC_SHEET.CONC] = GC_CONC_COLS.slice();
  return o;
}

/** GC 시트의 Eval_/End_ 동적 컬럼 설명 */
function gcCbItem_(col) {
  var m = /^(Eval|End)_(.+?)(_code)?$/.exec(col);
  if (!m) return null;
  var it = sm_has_(GC_CB_ITEMS, m[2]) ? GC_CB_ITEMS[m[2]] : null;
  var label = it ? it[1] : (m[1] === 'Eval' ? '전문의 정보 항목 ' : '세션 종료 문항 ') + m[2];
  return m[3] ? [label + ' — 코드', '정수 (선택지 순서, 1부터)'] : [label, it ? it[2] : '문자열 (선택지 라벨)'];
}

function gcCbDefs_(a) {
  var S = function (k, desc, type) { a(GC_SHEET.SESS + '.' + k, desc, type); };
  var J = function (k, desc, type) { a(GC_SHEET.JUDG + '.' + k, desc, type); };
  var A = function (k, desc, type) { a(GC_SHEET.ADJ + '.' + k, desc, type); };
  var C = function (k, desc, type) { a(GC_SHEET.CONC + '.' + k, desc, type); };
  var V = '충족 met / 감점 deducted / 채점 대상 아님 not_applicable';
  // 여러 시트 공통
  a('ServerUpdatedAt', '서버가 행을 마지막으로 갱신한 시각', '날짜시간');
  a('IsTest', '시험 응답 여부 (TRUE 면 요약에서 제외)', 'TRUE/FALSE');
  a('SeqSource', '제시 순서 배정 출처', 'server / local (서버 미응답 시 기기 임의 배정)');
  a('LinkedSessionId', '이어서 검증한 경우 앞선 Part 의 세션 ID', 'UUID');
  a('DeviceId', '기기 ID (브라우저에 저장된 무작위 ID, 개인 식별 불가; CA 사이트와 같은 키)', '문자열');
  a('VisitId', '소개 화면 방문 ID (Visits 와 연결)', 'UUID');
  a('Src', '유입 경로 (링크의 src 파라미터)', '예: qr, link, kakao');
  a('Site', '기관 (링크의 site 파라미터)', '문자열');
  a('Wave', '수집 차수 (링크의 wave 파라미터)', 'main / pilot (pilot 은 판정 집계에서 제외, 참여 흐름에만 포함)');
  a('FormFactor', '기기 형태', 'mobile / tablet / desktop');
  a('InAppBrowser', '인앱 브라우저(카카오톡 등) 감지 결과', '문자열 (빈칸 = 일반 브라우저)');
  a('ReferrerOrigin', '유입 페이지 출처 (origin 만)', '문자열');
  a('BackendVersion', '백엔드(GC Apps Script) 버전', '문자열');
  a('PatientId', '가상 환자 ID', 'P051 / P011');
  a('Model', '모델 코드 (전문의에게 비공개, 분석용)', 'gpt / deepseek');
  // Visits (GC 소개 화면 방문)
  a(GC_SHEET.VISITS + '.ReceivedAt', '서버가 방문 기록을 받은 시각', '날짜시간');
  a(GC_SHEET.VISITS + '.VisitId', '방문 ID (소개 화면 1회 조회; GC_Sessions.VisitId 와 연결)', 'UUID');
  a(GC_SHEET.VISITS + '.TypeParam', '링크로 미리 지정된 Part (?part=)', 'A / B / 빈칸');
  a(GC_SHEET.VISITS + '.AppVersion', 'GC 사이트 버전', '문자열');
  // GC_Sessions
  S('FirstSeenAt', '서버가 세션을 처음 받은 시각', '날짜시간');
  S('ConsentVersion', '연구 동의서 버전', '문자열');
  S('ConsentAt', '동의 시각 (기기 기준)', 'ISO 시각');
  S('Incentive', '사례 관련 안내 (설정값)', '문자열');
  S('StartedAt', '검증 시작 시각 (기기 기준)', 'ISO 시각');
  S('FinishedAt', '제출 시각 (기기 기준)', 'ISO 시각');
  S('Resumes', '새로고침·재방문 후 이어서 진행한 횟수', '정수');
  S('SendFailures', '전송 실패(재시도) 횟수', '정수');
  S('LastActivityAt', '마지막 활동 시각 (progress)', 'ISO 시각');
  S('ViewportW', '화면 너비', '정수 (CSS px)');
  S('ViewportH', '화면 높이', '정수 (CSS px)');
  S('UserAgent', '브라우저 정보', '문자열');
  // GC_Raw
  a(GC_SHEET.RAW + '.ReceivedAt', '서버가 요청을 받은 시각', '날짜시간');
  a(GC_SHEET.RAW + '.MsgId', '클라이언트 메시지 ID (재전송 식별)', '문자열');
  a(GC_SHEET.RAW + '.IsTest', '시험 응답 여부', 'TRUE/FALSE');
  a(GC_SHEET.RAW + '.Payload', '요청 원문', 'JSON (49,000자에서 절단)');
  a(GC_SHEET.RAW + '.ElapsedMs', '서버 처리 시간', '정수 (ms)');
  a(GC_SHEET.RAW + '.Error', '처리 오류 메시지 (빈칸 = 정상)', '문자열');
  [GC_SHEET.SESS, GC_SHEET.JUDG].forEach(function (sh) {
    a(sh + '.SessionId', 'GC 검증 세션 ID (Part 1개 = 세션 1개)', 'UUID');
    a(sh + '.EvaluatorName', '전문의 성명 — 개인정보, 요약·확정 시트에는 없음', '문자열');
    a(sh + '.EvaluatorCode', '서버 가명 코드 (정규화 성명 기준, 같은 사람 = 같은 코드; CA 의 E 코드와 별도). 동명이인으로 판단되면 요약에서 G001-1·G001-2 로 나눔', 'G001… (테스트 GT001…)');
    a(sh + '.EvaluatorId', '전문의 ID (기기에서 생성, 이어서 검증 시 승계)', 'UUID');
    a(sh + '.SequenceIndex', 'Part 안의 제시 순서 번호 (Part 안에서 균형 배정)', '정수 (0부터)');
    a(sh + '.SessionOrdinal', '전문의의 몇 번째 Part 인지', '1 = 첫 Part, 2 = 이어서 검증');
    a(sh + '.DataVersion', '판정 자료 버전 (gc/data/gc_items.js data_version)', '문자열');
    a(sh + '.AppVersion', 'GC 사이트 버전', '문자열');
  });
  a('Part', '검증 Part (답변 2건 묶음)', 'A / B');
  S('Order', '제시된 답변(unit) 순서', 'UnitKey > UnitKey');
  S('Status', '진행 상태 (후퇴하지 않음)', 'started → in_progress → completed');
  a('ItemsTotal', '이 세션에서 검증할 판정 수', '정수');
  a('ItemsDone', '저장된 판정 수 (GC_Judgments 에서 다시 셈)', '정수');
  a('AgreeN', 'AI 최종 판정에 동의한 수', '정수');
  a('DisagreeN', 'AI 최종 판정에 비동의한 수', '정수');
  a('PartPreselected', '링크(?part=)로 Part 가 미리 선택되었는지', 'TRUE/FALSE');
  S('ConsentInherited', '앞선 Part 의 동의를 승계했는지', 'TRUE/FALSE');
  S('InstrumentVersion', '검증 도구 버전', '문자열');
  S('TotalActiveMin', '총 active 시간', '실수 (분)');
  S('TotalWallMin', '시작부터 제출까지 경과 시간', '실수 (분)');
  a('FurthestUnit', '도달한 마지막 답변 번호 (progress)', '정수 (1부터)');
  a('FurthestItem', '도달한 마지막 판정 번호 (progress)', '정수 (1부터)');
  S('OverallComment', '전체 의견 (자유 서술)', '문자열');
  a('UnitOrder', '세션 안의 답변 순서', '1 / 2');
  a('ItemOrder', '세션 안의 판정 순서', '정수 (1부터)');
  a('UnitKey', '답변 식별자 (환자_모델, 전문의에게는 "답변 1/2" 로만 표시)', '예: P051_gpt');
  a('Combo', '치료 조합 번호 (0 = Phase 1)', '0–3');
  a('Question', '답변 문항 번호', '1.1 … 5.4');
  a('Element', '채점 요소 (감점 기준) ID', '예: Q2.1-02');
  a('ItemId', '검증 대상 판정 ID', '<UnitKey>|C<조합>|<Element> (Phase 1: <UnitKey>|P1|<Element>)');
  J('TargetKey', '부합도 집계 대상 (CA PhaseLong.TargetKey 와 같은 형식)', '<UnitKey>|P1 또는 <UnitKey>|C<n>|P<2–5>');
  a('AuditMark', 'AI 감사 표시', 'major = ✗ 판정 수정 / minor = △ 경미한 지적');
  a('AuditCategory', 'AI 감사 지적 분류', '문자열');
  a('RaterVerdict', 'AI Rater 원판정', '충족 met / 감점 deducted');
  a('AuditCorrected', 'AI 감사가 고친 판정 (✗ 만)', 'met / deducted / 빈칸');
  a('AIFinal', 'AI 파이프라인 최종 판정 (= 감사 수정 판정, 없으면 Rater 판정)', 'met / deducted');
  a('Agree', '전문의 판정이 AI 최종 판정(서버 AIFinal)과 같은지 — 서버가 계산', 'TRUE/FALSE');
  a('PhysVerdict', '전문의 판정', V);
  a('PhysVerdict_code', '전문의 판정 코드', '1 met / 2 deducted / 3 not_applicable');
  a('AgreeWithRater', '전문의 판정 = AI Rater 원판정', 'TRUE/FALSE');
  a('AgreeWithAIFinal', '전문의 판정 = AI 최종 판정', 'TRUE/FALSE');
  J('Comment', '판정 의견 (선택, 비동의 시 권장)', '문자열');
  a('AnsweredAt', '판정 시각 (기기 기준, 수정하면 갱신)', 'ISO 시각');
  var CUM = ' (세션 누적: 제출한 세션은 제출 시점, 진행 중 세션은 마지막 [다음] 시점)';
  a('ItemSec', '판정 화면 표시 시간' + CUM, '실수 (초)');
  J('ActiveSec', '판정 화면 active 시간' + CUM, '실수 (초)');
  a('TTFDSec', '첫 결정(동의/비동의)까지 시간', '실수 (초)');
  J('Changes', '첫 결정 이후 결정을 바꾼 횟수' + CUM, '정수');
  a('OpenedCriterion', '감점 기준 전문을 한 번이라도 펼쳤는지' + CUM, 'TRUE/FALSE');
  a('OpenedFullAnswer', '이 조합 전체 답변·처방을 한 번이라도 펼쳤는지' + CUM, 'TRUE/FALSE');
  a('OpenedBasis', '채점표 적용 근거를 한 번이라도 펼쳤는지' + CUM, 'TRUE/FALSE');
  a('OpenedPatient', '환자 정보를 한 번이라도 열었는지' + CUM, 'TRUE/FALSE');
  J('ClientMismatch', '사이트가 보낸 값이 서버 GC_ITEMS 와 다른 점 (빈칸 = 일치; 집계는 서버 AIFinal 기준)', 'data_version … ≠ … ; ai_final … ≠ … ; agree(사이트) …');
  a(GC_SHEET.RAW + '.Action', '요청 종류', 'gc_start | gc_judgment | gc_finish | gc_progress');
  a(GC_SHEET.RAW + '.SessionId', 'GC 검증 세션 ID', 'UUID');
  A('Title', '채점 요소 제목', '문자열');
  A('Combo', '치료 조합 번호 (0 = Phase 1)', '0–3');
  A('N', '판정을 검증한 전문의 수 (테스트 제외, 전문의마다 최신 1건)', '정수');
  A('AgreeN', 'AI 최종 판정과 같은 판정을 한 전문의 수', '정수');
  A('Met', '충족으로 판정한 전문의 수', '정수');
  A('Deducted', '감점으로 판정한 전문의 수', '정수');
  A('NotApplicable', '채점 대상 아님으로 판정한 전문의 수', '정수');
  A('Adjudicated', '확정 판정 (대기·추가 검토 필요면 AI 최종 유지)', V);
  A('Status', '확정 상태', '대기 / 확정(만장일치) / 확정(다수결) / 잠정(1인) / 추가 검토 필요');
  A('Comments', '전문의 의견 (가명 코드: 의견, " / " 로 연결; 동명이인으로 나눈 코드는 G001-1 형식)', '문자열');
  C('TargetKey', '부합도 집계 대상 (CA PhaseLong.TargetKey 와 같은 형식)', '<UnitKey>|P1 또는 <UnitKey>|C<n>|P<2–5>');
  C('N_AI', '채점 판정 수 (AI)', '정수');
  C('Met_Raw', '충족 수 — AI Rater 원판정', '정수');
  C('Met_AI', '충족 수 — AI 감사 후', '정수');
  C('Score_Raw', '부합도 — AI Rater 원판정 (Met_Raw ÷ N_AI)', '0–1 (소수 넷째 자리)');
  C('Score_AI', '부합도 — AI 감사 후 (Met_AI ÷ N_AI)', '0–1 (소수 넷째 자리)');
  C('N_Adj', '채점 판정 수 — 전문의 확정 반영 (채점 대상 아님 제외)', '정수');
  C('Met_Adj', '충족 수 — 전문의 확정 반영', '정수');
  C('ConcordanceScore', '부합도 — 전문의 확정 반영 (Met_Adj ÷ N_Adj). CA 스프레드시트 Concordance 시트에 붙여 넣는 값', '0–1 (소수 넷째 자리)');
  C('FlaggedItems', '이 대상의 검증 대상 판정 수 (AI 감사 △/✗)', '정수');
  C('Adjudicated', '그중 확정·잠정된 판정 수', '정수');
  C('Pending', '그중 대기·추가 검토 필요 판정 수', '정수');
}
