#!/usr/bin/env node
/**
 * Unit test for the Summary / AnalysisLong / Codebook builder (gas/src/summary.gs).
 *
 *   python3 tools/build_gas.py && node tools/test_summary.js [--dump <dir>]
 *
 * Loads gas/Code.gs unchanged into a vm context with an in-memory Sheets mock (same semantics as
 * tools/mock_gas_server.js: the leading text-marker apostrophe is stripped on read), writes synthetic
 * Sessions / Responses / PhaseLong / Visits / Concordance rows DIRECTLY with the DATA_CONTRACT headers
 * (no doPost), runs buildSummary and checks hand-computed statistics. Prints PASS/FAIL lines; exit 1 on failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DUMP = process.argv.indexOf('--dump') >= 0 ? process.argv[process.argv.indexOf('--dump') + 1] : '';   // write generated sheets as TSV
const CODE = fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8');

// ---------------- In-memory spreadsheet mock (copied from tools/mock_gas_server.js + I/O counters) ----------------
let IO = null;   // { get: {sheet: n}, set: [{sheet, nr, nc, vals}] } while recording
class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
    if (IO) IO.get[this.sheet.name] = (IO.get[this.sheet.name] || 0) + 1;
    const out = [];
    for (let r = 0; r < this.nr; r++) {
      const line = [];
      for (let c = 0; c < this.nc; c++) {
        let v = (this.sheet.cells[this.row - 1 + r] || [])[this.col - 1 + c];
        if (typeof v === 'string' && v[0] === "'") v = v.slice(1);   // Sheets hides the text-marker apostrophe
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(vals) {
    if (vals.length !== this.nr || vals.some(r => r.length !== this.nc)) throw new Error(`setValues dim mismatch ${vals.length}x${vals[0] && vals[0].length} vs ${this.nr}x${this.nc}`);
    if (IO) IO.set.push({ sheet: this.sheet.name, nr: this.nr, nc: this.nc, vals });
    for (let r = 0; r < this.nr; r++) {
      const ri = this.row - 1 + r;
      this.sheet.cells[ri] = this.sheet.cells[ri] || [];
      for (let c = 0; c < this.nc; c++) this.sheet.cells[ri][this.col - 1 + c] = vals[r][c];
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; } setBackground() { return this; } setFontSize() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = []; }
  getName() { return this.name; }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() {
    for (let i = this.cells.length - 1; i >= 0; i--) if ((this.cells[i] || []).some(v => v !== '' && v !== undefined)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.cells.forEach(row => { if (row) for (let i = row.length - 1; i >= 0; i--) if (row[i] !== '' && row[i] !== undefined) { m = Math.max(m, i + 1); break; } });
    return m;
  }
  appendRow(vals) { this.cells[this.getLastRow()] = vals.slice(); return this; }
  setFrozenRows() {} clear() { this.cells = []; } autoResizeColumns() {}
}
class Spreadsheet {
  constructor() { this.sheets = [new Sheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  getUrl() { return 'mock://spreadsheet'; }
}

function makeEnv() {
  const SS = new Spreadsheet();
  const props = {};
  const triggers = [];
  const lock = { busy: false, acquired: 0, released: 0 };
  let tid = 0;
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => SS, openById: () => SS, getUi: () => ({ alert() {}, createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } }) },
    LockService: { getScriptLock: () => ({
      waitLock() { if (lock.busy) throw new Error('busy'); lock.acquired++; },
      tryLock() { if (lock.busy) return false; lock.acquired++; return true; },
      releaseLock() { lock.released++; } }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
    ScriptApp: {
      EventType: { CLOCK: 'CLOCK' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: fn => {
        const spec = { fn, minutes: null };
        const b = { timeBased: () => b, everyMinutes: m => { spec.minutes = m; return b; }, everyHours: () => b,
          create: () => { const t = { getHandlerFunction: () => fn, getEventType: () => 'CLOCK', getUniqueId: () => 'T' + (++tid), spec }; triggers.push(t); return t; } };
        return b;
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => Array.from(crypto.createHash(alg).update(String(str), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      sleep: () => {}
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }) },
    Logger: { log: () => {} },
    console: { log: () => {}, warn: (...a) => console.warn(...a), error: (...a) => console.error(...a) },
    JSON, Math, Date, String, Number, Object, Array, isNaN
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx, { filename: 'Code.gs' });
  return { SS, props, triggers, lock, ctx };
}

/** write rows straight into the mock (strings get the text-marker apostrophe, like core's cell_) */
function put(SS, name, headers, rows) {
  const sh = SS.getSheetByName(name) || SS.insertSheet(name);
  const enc = v => (v === undefined || v === null) ? '' : (typeof v === 'string' && v !== '' ? "'" + v : v);
  sh.cells = [headers.slice()].concat(rows.map(r => headers.map(h => enc(r[h]))));
  return sh;
}
function read(SS, name) {
  const sh = SS.getSheetByName(name);
  if (!sh) return null;
  const lr = sh.getLastRow(), lc = sh.getLastColumn();
  return lr ? sh.getRange(1, 1, lr, Math.max(lc, 1)).getValues() : [];
}

// ---------------- assertions ----------------
let failures = 0, passes = 0;
function ok(name, cond, detail) {
  if (cond) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail !== undefined ? ' — ' + detail : '')); }
}
function eq(name, got, want) {
  const same = (typeof want === 'number' && typeof got === 'number') ? Math.abs(got - want) < 1e-9 : got === want;
  ok(name, same, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}
function section(rows, n) {
  const i = rows.findIndex(r => String(r[0]).startsWith('[' + n + ']'));
  if (i < 0) return [];
  let j = rows.findIndex((r, k) => k > i && /^\[\d+\]/.test(String(r[0])));
  return rows.slice(i, j < 0 ? rows.length : j);
}
function row(rows, pred) { return rows.find(pred) || []; }

// ---------------- contract headers (docs/DATA_CONTRACT.md) ----------------
const STEPC = ['Vignette', 'P1', 'Combo', 'P2', 'P3', 'P4', 'P5', 'Comment'];
const SIX = ['P1', 'Combo', 'P2', 'P3', 'P4', 'P5'];
const PH = ['P1', 'P2', 'P3', 'P4', 'P5'];
const EVAL_COLS = ['Eval_year', 'Eval_year_code', 'Eval_major', 'Eval_major_code', 'Eval_specialty', 'Eval_board_years', 'Eval_board_years_code',
  'Eval_t2d_volume', 'Eval_t2d_volume_code', 'Eval_ai_use', 'Eval_ai_use_code', 'Eval_ai_trust', 'Eval_ai_trust_code'];
const H_VIS = ['ReceivedAt', 'VisitId', 'DeviceId', 'Src', 'Site', 'Wave', 'TypeParam', 'FormFactor', 'InAppBrowser', 'ReferrerOrigin', 'IsTest', 'AppVersion'];
const H_SESS = ['FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
  'StudyType', 'SequenceIndex', 'SeqSource', 'Order', 'Status', 'CasesCompleted', 'LinkedSessionId', 'EvaluatorId', 'EvaluatorCode', 'DeviceId',
  'VisitId', 'SessionOrdinal', 'Src', 'Site', 'Wave', 'TypePreselected', 'InAppBrowser', 'ReferrerOrigin', 'ConsentVersion', 'ConsentAt',
  'ConsentInherited', 'InstrumentVersion', 'Incentive', 'StartedAt', 'FinishedAt', 'TotalActiveMin', 'TotalIdleMin', 'TotalHiddenMin',
  'TotalWallMin', 'IntroSec', 'FinalSec', 'Resumes', 'Interruptions', 'SendFailures', 'FurthestCase', 'FurthestStep', 'LastActivityAt',
  'PartialRatingsN', 'OverallComment', 'FormFactor', 'ViewportW', 'ViewportH', 'ScreenW', 'ScreenH', 'DPR', 'TouchPoints', 'CoarsePointer',
  'Language', 'TimeZone', 'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion'].concat(EVAL_COLS, ['End_intent_use', 'End_intent_use_code']);
const H_RESP = ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear', 'StudyType',
  'SequenceIndex', 'SeqSource', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder', 'CaseKey', 'PatientId',
  'PatientSeenPrior', 'Model', 'ModelName', 'P1_Referral', 'ComboChoice', 'ComboName', 'ComboKey', 'ComboIsAIFirst', 'ComboRankAI',
  'RankCueVisible', 'P2_SharedDecision', 'P3_Pharmacotherapy', 'P4_FollowUp', 'P5_Education', 'CaseComment', 'CaseStartedAt',
  'CaseCompletedAt', 'CaseActiveSec', 'CaseIdleSec', 'CaseHiddenSec', 'CaseWallSec']
  .concat(STEPC.map(s => 'Sec_' + s), SIX.map(s => 'TTFR_' + s), SIX.map(s => 'Changes_' + s), STEPC.map(s => 'Scroll_' + s),
    STEPC.map(s => 'Visits_' + s), PH.map(s => 'ScrollAtFR_' + s), ['Vignette'].concat(SIX).map(s => 'Chars_' + s),
    ['ComboSeen_1', 'ComboSeen_2', 'ComboSeen_3', 'ComboDwellSec_1', 'ComboDwellSec_2', 'ComboDwellSec_3', 'RxDetailsOpens',
      'Interruptions', 'ComboResets', 'PatientDrawerOpens', 'PatientDrawerSec', 'AppVersion', 'DataVersion', 'BackendVersion', 'MetricsJson'],
    EVAL_COLS, ['Case_harm', 'Case_harm_code', 'Case_harm_phases', 'Case_would_prescribe', 'Case_would_prescribe_code']);
const H_LONG = ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear', 'StudyType',
  'SequenceIndex', 'EvaluatorId', 'EvaluatorCode', 'SessionOrdinal', 'CaseOrder', 'GlobalCaseOrder', 'CaseKey', 'PatientId',
  'PatientSeenPrior', 'Model', 'ModelName', 'ComboChoice', 'ComboKey', 'RankCueVisible', 'Phase', 'PhaseLabel', 'TargetKey', 'Score',
  'Acceptable_4plus', 'FirstScore', 'Changed', 'VisibleSec', 'ActiveOnlySec', 'TTFRSec', 'Changes', 'ScrollPct', 'ScrollAtFirstRating',
  'Chars', 'CharsPerSec', 'Visits', 'HarmInPhase'].concat(EVAL_COLS);

// ---------------- synthetic study ----------------
const MODEL_NAME = { gpt: 'GPT-6.1 Sol', deepseek: 'DeepSeek-V4.1-Flash' };
const ORDERS = { A: [['P051_deepseek', 'P011_gpt'], ['P011_gpt', 'P051_deepseek']], B: [['P011_deepseek', 'P051_gpt'], ['P051_gpt', 'P011_deepseek']] };
const T2D = ['월 1명 미만', '월 1–10명', '월 11–30명', '월 31명 이상'];
const AIUSE = ['사용한 적 없음', '월 1회 미만', '월 1회–주 1회', '주 2회 이상', '거의 매일'];
const BOARD = ['5년 미만', '5–9년', '10–19년', '20년 이상'];
const MAJOR = ['내과', '가정의학과', '기타 (직접 입력)'];
const HARM = ['없음', '경미한 위해 가능성', '중대한 위해 가능성'];
const WOULD = ['그대로 처방', '일부 수정하여 처방', '처방할 조합 없음'];
const TRUST = ['1 전혀 신뢰하지 않음', '2', '3', '4', '5 매우 신뢰함'];
const EV = {
  E001: { code: 'E001', id: 'uuid-e001', name: '김 가나', role: '레지던트', year: 'R1', major: 1, t2d: 3, aiUse: 4, trust: 4 },
  E002: { code: 'E002', id: 'uuid-e002', name: '이다라', role: '레지던트', year: 'R2', major: 2, t2d: 2, aiUse: 2, trust: 3 },
  E003: { code: 'E003', id: 'uuid-e003', name: '박마바', role: '전문의', specialty: '내분비대사내과', board: 3, t2d: 4, aiUse: 3, trust: 5 },
  E004: { code: 'E004', id: 'uuid-e004', name: '최사아', role: '전문의', specialty: '가정의학과', board: 2, t2d: 3, aiUse: 5, trust: 4 },
  E005: { code: 'E005', id: 'uuid-e005', name: '정자차', role: '인턴', t2d: 1, aiUse: 1, trust: 2 },
  E006: { code: '', id: 'uuid-e006', name: '강카타', role: '레지던트', year: 'R3', major: 1, t2d: 2, aiUse: 4, trust: 3 },
  E007: { code: 'E007', id: 'uuid-e007', name: '조파하', role: '인턴', t2d: 1, aiUse: 1, trust: 3 },
  E009: { code: 'E009', id: 'uuid-e009', name: '윤가가', role: '전문의', specialty: '신장내과', board: 4, t2d: 4, aiUse: 5, trust: 5 },
  E010: { code: 'E010', id: 'uuid-e010', name: '장나나', role: '레지던트', year: 'R1', major: 1, t2d: 2, aiUse: 2, trust: null },
  T001: { code: 'T001', id: 'uuid-t001', name: '테스트', role: '레지던트', year: 'R2', major: 1, t2d: 2, aiUse: 3, trust: 4 }
};
const C = (s, rank, extra) => Object.assign({ s, rank, harm: 1, would: 1 }, extra || {});
const LONG_COMMENT = '=HYPERLINK("http://x","위험") ' + '용량 과다 위험. '.repeat(20);
const SESSIONS = [
  { sid: 'S1', ev: 'E001', type: 'A', seq: 0, status: 'completed', first: '2026-11-10T01:00:00Z', fin: '2026-11-10T01:30:00Z', dev: 'D1', src: 'qr', form: 'mobile', ordinal: 1, intent: 4, overall: '전반적으로 유용', app: '2026-11-18.ca-v1',
    cases: { P051_deepseek: C([3, 4, 3, 2, 4], 2, { harm: 2, harmPh: 'P3;P4', would: 2 }), P011_gpt: C([5, 4, 4, 5, 4], 1, { comment: '좋음', resets: 1, drawer: [2, 15], changes: { P2: 1 } }) } },
  { sid: 'S2', ev: 'E001', type: 'B', seq: 0, status: 'completed', first: '2026-11-10T02:00:00Z', fin: '2026-11-10T02:30:00Z', dev: 'D1', src: 'qr', form: 'mobile', ordinal: 2, linked: 'S1', intent: 5, resumes: 1, noTrust: true, prior: true, app: '2026-11-18.ca-v1',
    cases: { P011_deepseek: C([3, 3, 4, 4, 2], 2, { would: 3 }), P051_gpt: C([4, 4, 4, 4, 3], 1) } },
  { sid: 'S3', ev: 'E002', type: 'A', seq: 1, status: 'in_progress', first: '2026-11-11T01:00:00Z', fin: '', dev: 'D2', src: 'link', form: 'desktop', ordinal: 1, intent: null,
    cases: { P011_gpt: C([4, 4, 3, 4, 5], 1, { comment: '+추가 설명 필요' }), P051_deepseek: C([4, 3, 3, 4, 4], 1, { would: 2, vis: { P2: 50 }, chars: { P2: 2000 }, comment: '-용량 확인 필요' }) } },
  { sid: 'S4', ev: 'E002', evId: 'uuid-e002b', type: 'A', seq: 0, status: 'completed', first: '2026-11-12T01:00:00Z', fin: '2026-11-12T01:30:00Z', dev: 'D2b', src: 'link', form: 'desktop', ordinal: 1, intent: 2,
    cases: { P051_deepseek: C([1, 1, 1, 1, 1], 3, { would: 3 }), P011_gpt: C([1, 1, 1, 1, 1], 3, { harm: 3, harmPh: 'P1', would: 3, comment: '@참고 중대 위해' }) } },
  { sid: 'S5', ev: 'E003', type: 'B', seq: 1, status: 'completed', first: '2026-11-13T01:00:00Z', fin: '2026-11-13T01:30:00Z', dev: 'D3', src: 'qr', site: 'H1', form: 'mobile', ordinal: 1, intent: 4, overall: '=1+1',
    cases: { P051_gpt: C([5, 4, 5, 3, 4], 1, { would: 2 }), P011_deepseek: C([4, 2, 3, 3, 4], 1, { harm: 2, would: 2, hidden: 400, wall: 700 }) } },
  { sid: 'S6', ev: 'E004', type: 'A', seq: 1, status: 'completed', first: '2026-11-13T03:00:00Z', fin: '2026-11-13T03:30:00Z', dev: 'D4', src: 'link', form: 'desktop', ordinal: 1, intent: 2, sendFailures: 2,
    cases: { P011_gpt: C([5, 5, 4, 4, 4], 2, { would: 2, scroll: { P1: 30 } }), P051_deepseek: C([2, 3, 4, 3, 3], 1, { harm: 3, harmPh: 'P3', would: 3, comment: LONG_COMMENT }) } },
  { sid: 'S7', ev: 'E005', type: 'B', seq: 0, status: 'completed', first: '2026-11-14T01:00:00Z', fin: '2026-11-14T01:30:00Z', dev: 'D5', src: 'qr', form: 'mobile', inApp: 'kakaotalk', ordinal: 1, intent: 4,
    cases: { P011_deepseek: C([4, 4, 4, 4, 4], 1), P051_gpt: C([4, 4, 4, 4, 4], 3) } },
  { sid: 'S8', ev: 'E006', type: 'A', seq: 0, status: 'completed', first: '2026-11-14T03:00:00Z', fin: '2026-11-14T03:30:00Z', dev: 'D6', src: 'qr', form: 'tablet', ordinal: 1, intent: 5, seqSource: 'local',
    cases: { P051_deepseek: C([3, 4, 2, 3, 4], 3, { would: 2, seen: [true, false, true] }), P011_gpt: C([4, 3, 4, 5, 4], 1, { vis: { P5: 4 } }) } },
  { sid: 'S9', ev: 'E007', type: 'B', seq: 1, status: 'started', first: '2026-11-15T01:00:00Z', fin: '', dev: 'D7', src: 'link', form: 'mobile', ordinal: 1, intent: null, furthest: [1, 'p3'],
    cases: { P051_gpt: C([4, 3, null, null, null], 1, { incomplete: true }) } },
  { sid: 'S10', ev: 'E010', type: 'A', seq: 0, status: 'in_progress', first: '2026-11-15T03:00:00Z', fin: '', dev: 'D10', src: 'qr', form: 'mobile', ordinal: 1, intent: null, furthest: [2, 'p2'],
    cases: { P051_deepseek: C([4, 4, 4, 3, 5], 1, { active: 90, idle: 10, visAll: 10 }) } },
  { sid: 'S11', ev: 'T001', type: 'A', seq: 0, status: 'completed', test: true, first: '2026-11-16T01:00:00Z', fin: '2026-11-16T01:30:00Z', dev: 'D8', src: 'qr', form: 'desktop', ordinal: 1, intent: 5,
    cases: { P051_deepseek: C([5, 5, 5, 5, 5], 1), P011_gpt: C([5, 5, 5, 5, 5], 1) } },
  { sid: 'S12', ev: 'E009', type: 'B', seq: 0, status: 'completed', wave: 'pilot', first: '2026-11-09T01:00:00Z', fin: '2026-11-09T01:30:00Z', dev: 'D9', src: 'link', form: 'desktop', ordinal: 1, intent: 3,
    cases: { P011_deepseek: C([2, 2, 2, 2, 2], 2), P051_gpt: C([2, 2, 2, 2, 2], 2) } }
];

function evalFields(e, s) {
  const o = { EvaluatorName: e.name, EvaluatorRole: e.role, EvaluatorDetail: e.role + (e.year ? ' · ' + e.year : ''), ResidentYear: e.year || '',
    EvaluatorId: s.evId || e.id, EvaluatorCode: e.code, SessionOrdinal: s.ordinal, StudyType: s.type, SequenceIndex: s.seq };
  if (e.year) { o.Eval_year = e.year; o.Eval_year_code = Number(e.year.slice(1)); }
  if (e.major) { o.Eval_major = MAJOR[e.major - 1]; o.Eval_major_code = e.major; }
  if (e.specialty) o.Eval_specialty = e.specialty;
  if (e.board) { o.Eval_board_years = BOARD[e.board - 1]; o.Eval_board_years_code = e.board; }
  o.Eval_t2d_volume = T2D[e.t2d - 1]; o.Eval_t2d_volume_code = e.t2d;
  o.Eval_ai_use = AIUSE[e.aiUse - 1]; o.Eval_ai_use_code = e.aiUse;
  if (e.trust && !s.noTrust) { o.Eval_ai_trust = TRUST[e.trust - 1]; o.Eval_ai_trust_code = e.trust; }
  return o;
}

function buildStudy(SS) {
  const sess = [], resp = [], long = [];
  SESSIONS.forEach(s => {
    const e = EV[s.ev];
    const ev = evalFields(e, s);
    const order = ORDERS[s.type][s.seq];
    const t0 = Date.parse(s.first);
    const completed = Object.values(s.cases).filter(c => !c.incomplete).length;
    sess.push(Object.assign({}, ev, {
      FirstSeenAt: new Date(t0), ServerUpdatedAt: new Date(t0 + 3600e3), SessionId: s.sid, IsTest: !!s.test, SeqSource: s.seqSource || 'server',
      Order: order.join(' > '), Status: s.status, CasesCompleted: completed, LinkedSessionId: s.linked || '', DeviceId: s.dev, VisitId: 'V-' + s.sid,
      Src: s.src, Site: s.site || '', Wave: s.wave || '', TypePreselected: false, InAppBrowser: s.inApp || '', ConsentVersion: 'c1',
      InstrumentVersion: 'inst-1', StartedAt: s.first, FinishedAt: s.fin, TotalActiveMin: 20, TotalIdleMin: 2, TotalHiddenMin: 1, TotalWallMin: 23,
      Resumes: s.resumes || 0, Interruptions: 0, SendFailures: s.sendFailures || 0, FurthestCase: s.furthest ? s.furthest[0] : 2,
      FurthestStep: s.furthest ? s.furthest[1] : (s.status === 'completed' ? 'final' : ''), OverallComment: s.overall || '', FormFactor: s.form,
      AppVersion: s.app || '2026-11-19.ca-v2', DataVersion: 'd1', BackendVersion: 'b1',
      End_intent_use: s.intent ? String(s.intent) : '', End_intent_use_code: s.intent || ''
    }));
    Object.keys(s.cases).forEach(key => {
      const c = s.cases[key];
      const ci = order.indexOf(key) + 1;
      const model = key.split('_')[1], pid = key.split('_')[0], cue = model === 'gpt';
      const done = c.incomplete ? '' : new Date(t0 + ci * 20 * 60e3).toISOString();
      const r = Object.assign({}, ev, {
        ServerUpdatedAt: new Date(t0), SessionId: s.sid, IsTest: !!s.test, SeqSource: s.seqSource || 'server', CaseOrder: ci,
        GlobalCaseOrder: s.ordinal === 2 ? ci + 2 : ci, CaseKey: key, PatientId: pid, PatientSeenPrior: !!s.prior, Model: model, ModelName: MODEL_NAME[model],
        P1_Referral: c.s[0], ComboChoice: c.rank, ComboName: 'combo ' + c.rank, ComboKey: key + '_C' + c.rank, ComboIsAIFirst: c.rank === 1,
        ComboRankAI: c.rank, RankCueVisible: cue, P2_SharedDecision: c.s[1], P3_Pharmacotherapy: c.s[2], P4_FollowUp: c.s[3], P5_Education: c.s[4],
        CaseComment: c.comment || '', CaseStartedAt: new Date(t0 + (ci - 1) * 20 * 60e3).toISOString(), CaseCompletedAt: done,
        CaseActiveSec: c.active !== undefined ? c.active : 500, CaseIdleSec: c.idle !== undefined ? c.idle : 40,
        CaseHiddenSec: c.hidden !== undefined ? c.hidden : 10, CaseWallSec: c.wall !== undefined ? c.wall : 560,
        Sec_Vignette: 120, Sec_Combo: 90, Sec_Comment: 20, Chars_Vignette: 1500, Chars_Combo: 1200, TTFR_Combo: 30, Changes_Combo: 0,
        ComboSeen_1: (c.seen || [true, true, true])[0], ComboSeen_2: (c.seen || [true, true, true])[1], ComboSeen_3: (c.seen || [true, true, true])[2],
        ComboResets: c.resets || 0, PatientDrawerOpens: c.drawer ? c.drawer[0] : 0, PatientDrawerSec: c.drawer ? c.drawer[1] : 0,
        Case_harm: HARM[c.harm - 1], Case_harm_code: c.harm, Case_harm_phases: c.harmPh || '',
        Case_would_prescribe: WOULD[c.would - 1], Case_would_prescribe_code: c.would, MetricsJson: '{}'
      });
      PH.forEach((P, i) => {
        const vis = c.visAll !== undefined ? c.visAll : ((c.vis && c.vis[P] !== undefined) ? c.vis[P] : 60);
        const chars = (c.chars && c.chars[P] !== undefined) ? c.chars[P] : 800;
        const scroll = (c.scroll && c.scroll[P] !== undefined) ? c.scroll[P] : 100;
        const ch = (c.changes && c.changes[P]) || 0;
        r['Sec_' + P] = vis; r['Chars_' + P] = chars; r['ScrollAtFR_' + P] = scroll; r['TTFR_' + P] = 20; r['Changes_' + P] = ch;
        if (c.incomplete) return;
        const score = c.s[i];
        const harmIn = c.harmPh ? (c.harmPh.split(';').indexOf(P) >= 0 ? 1 : 0) : (c.harm === 1 ? 0 : '');
        long.push(Object.assign({}, ev, {
          ServerUpdatedAt: new Date(t0), SessionId: s.sid, IsTest: !!s.test, CaseOrder: ci, GlobalCaseOrder: r.GlobalCaseOrder, CaseKey: key,
          PatientId: pid, PatientSeenPrior: !!s.prior, Model: model, ModelName: MODEL_NAME[model], ComboChoice: c.rank, ComboKey: key + '_C' + c.rank,
          RankCueVisible: cue, Phase: P, PhaseLabel: P, TargetKey: P === 'P1' ? key + '|P1' : key + '|C' + c.rank + '|' + P,
          Score: score, Acceptable_4plus: score >= 4 ? 1 : 0, FirstScore: ch ? score - 1 : score, Changed: ch ? 1 : 0, VisibleSec: vis,
          ActiveOnlySec: vis - 5, TTFRSec: 20, Changes: ch, ScrollPct: 100, ScrollAtFirstRating: scroll, Chars: chars,
          CharsPerSec: Math.round(chars / vis * 10) / 10, Visits: 1, HarmInPhase: harmIn
        }));
      });
      resp.push(r);
    });
  });
  put(SS, 'Sessions', H_SESS, sess);
  put(SS, 'Responses', H_RESP, resp);
  put(SS, 'PhaseLong', H_LONG, long);
  const V = (dev, src, extra) => Object.assign({ ReceivedAt: new Date('2026-11-09T00:00:00Z'), VisitId: 'V' + dev + Math.random().toString(16).slice(2, 6), DeviceId: dev, Src: src, Site: '', Wave: '', TypeParam: '', FormFactor: 'mobile', InAppBrowser: '', ReferrerOrigin: '', IsTest: false, AppVersion: 'a' }, extra || {});
  put(SS, 'Visits', H_VIS, [V('D1', 'qr'), V('D1', 'qr'), V('D2', 'link'), V('D2b', 'link'), V('D3', 'qr', { Site: 'H1' }), V('D4', 'link'),
    V('D5', 'qr', { InAppBrowser: 'kakaotalk' }), V('D6', 'qr'), V('D7', 'link'), V('D10', 'qr'), V('D9', 'link', { Wave: 'pilot' }), V('D20', 'qr'),
    V('D21', 'qr'), V('D8', 'qr', { IsTest: true })]);
  put(SS, 'Concordance', ['TargetKey', 'ConcordanceScore'], [
    { TargetKey: 'P011_gpt|P1', ConcordanceScore: 0.9 }, { TargetKey: 'P051_gpt|P1', ConcordanceScore: 0.8 },
    { TargetKey: 'P051_deepseek|P1', ConcordanceScore: 0.5 }, { TargetKey: 'P011_deepseek|P1', ConcordanceScore: 0.6 },
    { TargetKey: 'P011_gpt|C1|P3', ConcordanceScore: 0.85 }, { TargetKey: 'ZZZ_unused|P1', ConcordanceScore: 0.1 }]);
}

// =====================================================================
// 1) Full synthetic study
// =====================================================================
(function mainStudy() {
  const env = makeEnv();
  buildStudy(env.SS);
  env.props.SUMMARY_DIRTY = '1';
  IO = { get: {}, set: [] };
  let res;
  try { res = env.ctx.buildSummary(false); ok('buildSummary(false) runs', true); }
  catch (e) { ok('buildSummary(false) runs', false, e.stack); IO = null; return; }
  const io = IO; IO = null;

  // --- I/O discipline ---
  ['Sessions', 'Responses', 'PhaseLong', 'Visits', 'Concordance'].forEach(n => eq('read ' + n + ' with one getValues', io.get[n] || 0, 1));
  ['Summary', 'AnalysisLong', 'Codebook'].forEach(n => eq(n + ' written with a single setValues', io.set.filter(x => x.sheet === n).length, 1));
  const outWrites = io.set.filter(x => ['Summary', 'AnalysisLong', 'Codebook'].indexOf(x.sheet) >= 0);
  const unguarded = [];
  outWrites.forEach(w => w.vals.forEach(r => r.forEach(v => { if (typeof v === 'string' && v !== '' && v[0] !== "'") unguarded.push(w.sheet + ':' + v.slice(0, 30)); })));
  eq('every string written to output sheets goes through cell_ (no unguarded writes)', unguarded.length, 0);
  const sumRaw = outWrites.find(w => w.sheet === 'Summary').vals;
  ok('formula-like comment stored as text (\'=HYPERLINK…)', sumRaw.some(r => r.some(v => typeof v === 'string' && v.indexOf("'=HYPERLINK") === 0)));
  const widths = sumRaw.map(r => r.length);
  ok('Summary rows padded to one fixed width', widths.every(w => w === widths[0]) && widths[0] >= 20, 'widths ' + [...new Set(widths)]);
  ok('SUMMARY_BUILT_AT recorded (ISO)', /^\d{4}-\d\d-\d\dT/.test(env.props.SUMMARY_BUILT_AT || ''));
  ok('SUMMARY_DIRTY cleared', env.props.SUMMARY_DIRTY !== '1');
  eq('return value: included ratings', res.ratings, 75);

  const S = read(env.SS, 'Summary');
  // --- [0] header ---
  const s0 = section(S, 0);
  eq('[0] evaluators (unique identity)', row(s0, r => String(r[0]).startsWith('분석 포함 평가자 수'))[1], 7);
  eq('[0] included sessions', row(s0, r => r[0] === '분석 포함 세션 수')[1], 8);
  eq('[0] included completed cases', row(s0, r => r[0] === '분석 포함 완료 케이스 수')[1], 15);
  eq('[0] included ratings', row(s0, r => r[0] === '분석 포함 Phase 평정 수')[1], 75);
  const ex = name => row(s0, r => r[0] === name);
  eq('[0] excluded test sessions', ex('test')[1], 1); eq('[0] excluded test cases', ex('test')[2], 2);
  eq('[0] excluded pilot sessions', ex('pilot')[1], 1); eq('[0] excluded pilot cases', ex('pilot')[2], 2);
  eq('[0] excluded duplicate sessions', ex('duplicate')[1], 1); eq('[0] excluded duplicate cases', ex('duplicate')[2], 2);
  eq('[0] incomplete case rows', ex('미완료 케이스 행')[2], 1);
  const win = row(s0, r => String(r[0]).startsWith('데이터 기간'));
  ok('[0] data window first = pilot session (2026-11-09)', win[1] instanceof Date && win[1].toISOString() === '2026-11-09T01:00:00.000Z', String(win[1]));
  ok('[0] data window last = 2026-11-15T03:00Z', win[3] instanceof Date && win[3].toISOString() === '2026-11-15T03:00:00.000Z', String(win[3]));
  eq('[0] AppVersion count (v1 = 2 sessions)', row(s0, r => r[1] === '2026-11-18.ca-v1')[2], 2);

  // --- [1] flow ---
  const s1 = section(S, 1);
  const tot = row(s1, r => r[0] === '전체');
  eq('[1] unique visiting devices (test visit excluded)', tot[2], 12);
  eq('[1] visits', tot[3], 13);
  eq('[1] sessions started (pilot + duplicate counted)', tot[4], 11);
  eq('[1] unique devices that started', tot[5], 10);
  eq('[1] sessions with ≥1 completed case', tot[6], 10);
  eq('[1] completed sessions', tot[7], 9);
  eq('[1] participation rate = 11/12', tot[8], 0.917);
  eq('[1] completion rate = 9/11', tot[9], 0.818);
  eq('[1] Src=qr visits', row(s1, r => r[0] === 'Src' && r[1] === 'qr')[3], 8);
  eq('[1] FurthestStep p3 at case 1', row(s1, r => r[0] === 'p3')[2], 1);
  eq('[1] FurthestStep p2 at case 2', row(s1, r => r[0] === 'p2')[3], 1);
  eq('[1] evaluators who completed both Types', row(s1, r => String(r[0]).startsWith('두 Type'))[1], 1);

  // --- [2] Table 1 ---
  const s2 = section(S, 2);
  const res2 = row(s2, r => r[1] === '레지던트');
  eq('[2] residents n', res2[2], 4); eq('[2] residents %', res2[3], 57.1);
  eq('[2] ai_trust median (IQR)', row(s2, r => String(r[0]).startsWith('AI 신뢰 (ai_trust'))[2], '3.5 (3–4)');
  eq('[2] ai_trust n (E010 blank)', row(s2, r => String(r[0]).startsWith('AI 신뢰 (ai_trust'))[4], 6);

  // --- [3] balance ---
  const s3 = section(S, 3);
  eq('[3] Type A seq 0 completed included sessions (S1, S8)', row(s3, r => r[0] === 'A' && r[1] === 0)[5], 2);
  eq('[3] P051_deepseek included cases', row(s3, r => r[0] === 'P051_deepseek')[3], 5);

  // --- [4] main results ---
  const s4 = section(S, 4);
  const g2 = row(s4, r => r[0] === 'GPT-6.1 Sol' && String(r[1]).startsWith('Phase 2'));
  eq('[4] GPT × P2 n', g2[2], 7); eq('[4] GPT × P2 mean', g2[3], 4);
  eq('[4] GPT × P2 acceptability (I-CVI) 6/7', g2[13], 0.857);
  eq('[4] GPT × P2 Wilson CI low', g2[14], 0.487); eq('[4] GPT × P2 Wilson CI high', g2[15], 0.974);
  eq('[4] GPT × P2 Pc = 7/128', g2[16], 0.0547); eq('[4] GPT × P2 modified kappa k* = 719/847', g2[17], 0.849); eq('[4] GPT × P2 k* label', g2[18], '우수');
  const d4 = row(s4, r => r[0] === 'DeepSeek-V4.1-Flash' && String(r[1]).startsWith('Phase 4'));
  eq('[4] DeepSeek × P4 I-CVI 3/8', d4[13], 0.375); eq('[4] DeepSeek × P4 k* = 0.2', d4[17], 0.2); eq('[4] DeepSeek × P4 k* label', d4[18], '미흡');
  const sg = row(s4, r => r[0] === 'GPT-6.1 Sol' && typeof r[1] === 'number');
  eq('[4] GPT S-CVI/Ave = 31/35', sg[2], 0.886); eq('[4] GPT S-CVI/UA = 1/5', sg[3], 0.2);
  const sd = row(s4, r => r[0] === 'DeepSeek-V4.1-Flash' && typeof r[1] === 'number');
  eq('[4] DeepSeek S-CVI/Ave', sd[2], 0.525); eq('[4] DeepSeek S-CVI/UA', sd[3], 0);
  eq('[4] CaseKey P011_gpt × P1 n', row(s4, r => r[0] === 'P011_gpt' && String(r[1]).startsWith('Phase 1'))[2], 4);

  // --- [5] within-evaluator ---
  const s5 = section(S, 5);
  const p1d = row(s5, r => String(r[0]).startsWith('Phase 1'));
  eq('[5] P1 pairs', p1d[1], 7); eq('[5] P1 mean diff GPT − DeepSeek = 8/7', p1d[2], 1.14); eq('[5] P1 median diff', p1d[4], 1);
  eq('[5] P1 % GPT higher', p1d[5], 0.714); eq('[5] P1 % equal', p1d[6], 0.286); eq('[5] P1 % GPT lower', p1d[7], 0);

  // --- [6] agreement ---
  const s6 = section(S, 6);
  const t1 = row(s6, r => r[0] === 'P051_deepseek|P1');
  eq('[6] P051_deepseek|P1 raters', t1[5], 5); eq('[6] P051_deepseek|P1 mean', t1[6], 3.2);
  eq('[6] P051_deepseek|P1 rWG = 1 − 0.7/2', t1[9], 0.65); eq('[6] P051_deepseek|P1 pair agreement 4/10', t1[10], 0.4);
  const t2 = row(s6, r => r[0] === 'P011_gpt|P1');
  eq('[6] P011_gpt|P1 rWG', t2[9], 0.833); eq('[6] P011_gpt|P1 pair agreement', t2[10], 1);

  // --- [7] subgroups ---
  const s7 = section(S, 7);
  eq('[7] trust band 4–5 evaluators (E001, E003, E004)', row(s7, r => r[1] === '4–5 (높음)')[2], 3);

  // --- [8] combination choice ---
  const s8 = section(S, 8);
  const cue = row(s8, r => r[0] === '순위 단서별' && r[3] === '있음');
  eq('[8] GPT (rank cue) n', cue[4], 7); eq('[8] GPT AI-first k', cue[5], 5); eq('[8] GPT AI-first rate', cue[8], 0.714);
  eq('[8] GPT AI-first Wilson low', cue[9], 0.359); eq('[8] GPT AI-first Wilson high', cue[10], 0.918);
  eq('[8] exact binomial P(X ≥ 5 | 7, 1/3) = 99/2187', cue[11], 0.0453);
  eq('[8] P011_gpt AI-first p = 9/81', row(s8, r => r[1] === 'P011_gpt')[11], 0.1111);
  eq('[8] overall AI-first p (10/15)', row(s8, r => r[0] === '전체' && r[4] === 15)[11], 0.0085);
  eq('[8] would_prescribe GPT 그대로', row(s8, r => r[0] === 'GPT-6.1 Sol' && r[1] === 7)[2], 5);
  eq('[8] ComboResets > 0 (all cases)', row(s8, r => r[0] === '전체' && r[1] === 15 && r[2] === 1)[3], 0.067);

  // --- [9] safety ---
  const s9 = section(S, 9);
  const hd = row(s9, r => r[0] === '모델' && r[1] === 'DeepSeek-V4.1-Flash');
  eq('[9] DeepSeek harm n', hd[2], 8); eq('[9] DeepSeek none/minor/major', [hd[3], hd[4], hd[5]].join('/'), '5/2/1');
  eq('[9] DeepSeek any-harm rate', hd[6], 0.375); eq('[9] DeepSeek any-harm Wilson low', hd[7], 0.137); eq('[9] DeepSeek any-harm Wilson high', hd[8], 0.694);
  const h3 = row(s9, r => String(r[0]).startsWith('Phase 3'));
  eq('[9] HarmInPhase P3 evaluable / hits', h3[1] + '/' + h3[2], '14/2');
  const major = s9.filter(r => r[2] === '중대한 위해 가능성');
  eq('[9] major-harm list rows (incl. duplicate session)', major.length, 2);
  const mj = row(major, r => r[0] === 'P051_deepseek');
  eq('[9] major-harm list uses EvaluatorCode', mj[1], 'E004');
  ok('[9] major-harm comment truncated to 200 chars', String(mj[5]).length === 201 && String(mj[5]).endsWith('…'), String(mj[5]).length);
  eq('[9] excluded major harm flagged', row(major, r => r[0] === 'P011_gpt')[4], '아니오 (duplicate)');

  // --- [10] intent / Spearman ---
  const s10 = section(S, 10);
  const sp1 = row(s10, r => String(r[0]).startsWith('AI 신뢰 (ai_trust_code)'));
  eq('[10] Spearman trust vs mean: n', sp1[1], 6); eq('[10] Spearman trust vs mean: rho (ties)', sp1[2], -0.403);
  const sp2 = row(s10, r => String(r[0]).startsWith('활용 의향'));
  eq('[10] Spearman intent vs mean: n', sp2[1], 5); eq('[10] Spearman intent vs mean: rho', sp2[2], -0.763);
  const it = row(s10, r => r[0] === '레지던트');
  eq('[10] resident intent sessions (S1, S2, S8)', it[1], 3); eq('[10] resident intent ≥4 rate', it[7], 1);

  // --- [11] time ---
  const s11 = section(S, 11);
  eq('[11] session visible minutes median', row(s11, r => String(r[0]).startsWith('세션 총 표시 시간'))[3], 22);
  eq('[11] case visible seconds median (all)', row(s11, r => String(r[0]).startsWith('케이스 표시 시간') && r[1] === '전체')[3], 540);
  eq('[11] changed-phase rate 1/75', row(s11, r => String(r[0]).startsWith('응답을 1회 이상'))[1], 0.013);

  // --- [12] quality / sensitivity ---
  const s12 = section(S, 12);
  const spd = row(s12, r => r[0] === 'SpeederFlag');
  eq('[12] SpeederFlag n/N', spd[4] + '/' + spd[3], '7/75');
  const stl = row(s12, r => r[0] === 'StraightlineFlag');
  eq('[12] StraightlineFlag n/N', stl[4] + '/' + stl[3], '1/7');
  eq('[12] any-flag phases', row(s12, r => r[0] === '플래그 1개 이상')[4], 23);
  eq('[12] SeqSource=local sessions', row(s12, r => String(r[0]).startsWith('SeqSource'))[1], 1);
  const sens = row(s12, r => r[0] === '전체 — 플래그 1개 이상 제외');
  eq('[12] sensitivity: all-ratings acceptability 52/75', sens[2], 0.693);
  eq('[12] sensitivity: flag-free n', sens[3], 52); eq('[12] sensitivity: flag-free acceptability 34/52', sens[4], 0.654);

  // --- [13] qualitative ---
  const s13 = section(S, 13);
  // included comments: S1 P011_gpt, S3 P011_gpt, S3 P051_deepseek, S6 P051_deepseek (S4 is a duplicate)
  eq('[13] cases with a comment 4/15', row(s13, r => String(r[0]).startsWith('케이스 의견을 남긴'))[1], 0.267);
  eq('[13] overall comment among completed included sessions 2/7', row(s13, r => String(r[0]).startsWith('전체 의견을 남긴'))[1], 0.286);

  // --- [14] concordance ---
  const s14 = section(S, 14);
  const cr = row(s14, r => r[0] === 'ConcordanceScore vs 평균 점수');
  eq('[14] target-level Spearman n', cr[1], 5); eq('[14] target-level Spearman rho (ties)', cr[2], 0.821);
  eq('[14] concordance row for unrated target has n = 0', row(s14, r => r[0] === 'ZZZ_unused|P1')[2], 0);
  ok('[14] lists rated targets without a concordance score', s14.some(r => r[0] === 'P051_deepseek|C1|P2'));

  // --- [15] methods text ---
  const s15 = section(S, 15);
  ok('[15] methods text mentions counts', s15.some(r => String(r[0]).indexOf('평가자 7명이 완료한 15개 케이스의 Phase 평정 75건') >= 0));

  // --- privacy ---
  const names = Object.values(EV).map(e => e.name);
  ok('Summary contains no evaluator names', !S.some(r => r.some(v => names.indexOf(String(v)) >= 0)));

  // --- AnalysisLong ---
  const AL = read(env.SS, 'AnalysisLong');
  const H = AL[0], col = n => H.indexOf(n);
  eq('AnalysisLong rows = 19 non-test completed cases × 5', AL.length - 1, 95);
  eq('AnalysisLong IncludedInAnalysis = 1', AL.slice(1).filter(r => r[col('IncludedInAnalysis')] === 1).length, 75);
  eq('AnalysisLong IncludedInAnalysis = 0', AL.slice(1).filter(r => r[col('IncludedInAnalysis')] === 0).length, 20);
  eq('AnalysisLong ExclusionReason pilot', AL.slice(1).filter(r => r[col('ExclusionReason')] === 'pilot').length, 10);
  eq('AnalysisLong ExclusionReason duplicate', AL.slice(1).filter(r => r[col('ExclusionReason')] === 'duplicate').length, 10);
  ok('AnalysisLong has no test session', !AL.some(r => r[col('SessionId')] === 'S11'));
  ok('AnalysisLong has no name column / no names', H.indexOf('EvaluatorName') < 0 && !AL.some(r => r.some(v => names.indexOf(String(v)) >= 0)));
  eq('AnalysisLong pseudonym for blank EvaluatorCode', row(AL, r => r[col('SessionId')] === 'S8')[col('EvaluatorCode')], 'R001');
  const alS8 = AL.find(r => r[col('SessionId')] === 'S8' && r[col('CaseKey')] === 'P011_gpt' && r[col('Phase')] === 'P5');
  eq('AnalysisLong SpeederFlag (VisibleSec 4)', alS8[col('SpeederFlag')], 1);
  const alS7 = AL.find(r => r[col('SessionId')] === 'S7');
  eq('AnalysisLong StraightlineFlag', alS7[col('StraightlineFlag')], 1);
  const alS10 = AL.find(r => r[col('SessionId')] === 'S10');
  eq('AnalysisLong CaseSpeeder', alS10[col('CaseSpeeder')], 1); eq('AnalysisLong StraightlineFlag (<6 ratings) blank', alS10[col('StraightlineFlag')], '');
  const alS2 = AL.find(r => r[col('SessionId')] === 'S2');
  eq('AnalysisLong AITrust carried from first session', alS2[col('AITrust_code')], 4);
  eq('AnalysisLong T2DVolume_code', alS2[col('T2DVolume_code')], 3);
  eq('AnalysisLong PatientSeenPrior 1/0', alS2[col('PatientSeenPrior')], 1);
  const alH = AL.find(r => r[col('SessionId')] === 'S1' && r[col('CaseKey')] === 'P051_deepseek' && r[col('Phase')] === 'P4');
  eq('AnalysisLong HarmInPhase', alH[col('HarmInPhase')], 1); eq('AnalysisLong HarmCode', alH[col('HarmCode')], 2);
  eq('AnalysisLong TargetKey', alH[col('TargetKey')], 'P051_deepseek|C2|P4');

  // --- Codebook ---
  const CB = read(env.SS, 'Codebook');
  ok('Codebook lists every AnalysisLong column', H.every(h => CB.some(r => r[0] === 'AnalysisLong' && r[1] === h)));
  ok('Codebook lists dynamic Case_harm_code in Responses', CB.some(r => r[0] === 'Responses' && r[1] === 'Case_harm_code' && r[4] === 'Y'));
  ok('Codebook lists Visits/Sessions/Responses/PhaseLong/RawJSON', ['Visits', 'Sessions', 'Responses', 'PhaseLong', 'RawJSON'].every(s => CB.some(r => r[0] === s)));
  ok('Codebook descriptions are filled', CB.slice(1).every(r => String(r[2]).length > 0));

  if (DUMP) {
    fs.mkdirSync(DUMP, { recursive: true });
    ['Summary', 'AnalysisLong', 'Codebook'].forEach(n => fs.writeFileSync(path.join(DUMP, n + '.tsv'),
      read(env.SS, n).map(r => r.map(v => (v instanceof Date ? v.toISOString() : String(v)).replace(/\t|\n/g, ' ')).join('\t').replace(/\t+$/, '')).join('\n') + '\n'));
    console.log('dumped Summary/AnalysisLong/Codebook TSV to ' + DUMP);
  }

  // --- includeTests ---
  const r2 = env.ctx.buildSummaryIncludingTests();
  const AL2 = read(env.SS, 'AnalysisLong');
  eq('includeTests: AnalysisLong rows', AL2.length - 1, 105);
  eq('includeTests: IsTest rows', AL2.slice(1).filter(r => r[AL2[0].indexOf('IsTest')] === 1).length, 10);
  eq('includeTests: evaluators', r2.evaluators, 8);

  // --- refresh trigger handler + lock ---
  env.props.SUMMARY_DIRTY = '1';
  env.lock.busy = true;
  eq('refreshSummaryIfDirty skips when lock busy', env.ctx.refreshSummaryIfDirty(), false);
  eq('dirty flag kept when skipped', env.props.SUMMARY_DIRTY, '1');
  env.lock.busy = false;
  const before = env.lock.released;
  eq('refreshSummaryIfDirty rebuilds when dirty', env.ctx.refreshSummaryIfDirty(), true);
  ok('lock released after refresh', env.lock.released === before + 1);
  ok('dirty flag cleared after refresh', env.props.SUMMARY_DIRTY !== '1');
  eq('refreshSummaryIfDirty no-op when clean', env.ctx.refreshSummaryIfDirty(), false);
  eq('refresh builds without tests', read(env.SS, 'AnalysisLong').length - 1, 95);

  // --- trigger install idempotency ---
  env.ctx.ensureSummaryTrigger_(); env.ctx.ensureSummaryTrigger_();
  eq('ensureSummaryTrigger_ installs exactly one trigger', env.triggers.filter(t => t.getHandlerFunction() === 'refreshSummaryIfDirty').length, 1);
  eq('trigger runs every 10 minutes', env.triggers[0].spec.minutes, 10);
  env.ctx.ScriptApp.newTrigger('refreshSummaryIfDirty').timeBased().everyMinutes(10).create();
  env.ctx.ensureSummaryTrigger_();
  eq('ensureSummaryTrigger_ deletes duplicates', env.triggers.filter(t => t.getHandlerFunction() === 'refreshSummaryIfDirty').length, 1);
})();

// =====================================================================
// 2) Empty spreadsheet and header-only sheets
// =====================================================================
(function emptySheets() {
  const env = makeEnv();
  try { env.ctx.buildSummary(false); ok('empty spreadsheet: no exception', true); }
  catch (e) { ok('empty spreadsheet: no exception', false, e.stack); return; }
  ok('empty spreadsheet: Summary written', (read(env.SS, 'Summary') || []).length > 20);
  eq('empty spreadsheet: AnalysisLong header only', read(env.SS, 'AnalysisLong').length, 1);
  eq('empty spreadsheet: Concordance created with header', JSON.stringify(read(env.SS, 'Concordance')), JSON.stringify([['TargetKey', 'ConcordanceScore']]));
  const env2 = makeEnv();
  try {
    env2.ctx.setup();
    env2.ctx.buildSummary(false);
    ok('header-only sheets (after setup): no exception', true);
    eq('setup installs the summary trigger', env2.triggers.length, 1);
    const CB2 = read(env2.SS, 'Codebook');
    ok('Codebook marks RawJSON columns present after setup', CB2.some(r => r[0] === 'RawJSON' && r[1] === 'Payload' && r[4] === 'Y'));
    ok('Codebook marks missing sheets', read(env.SS, 'Codebook').some(r => r[0] === 'Sessions' && r[4] === '(시트 없음)'));
  } catch (e) { ok('header-only sheets (after setup): no exception', false, e.stack); }
})();

// =====================================================================
// 3) Sheets with only the OLD column set (pre-v3 backend)
// =====================================================================
(function oldColumns() {
  const env = makeEnv();
  const OLD_SESS = ['FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'SeqSource', 'Order', 'Status', 'CasesCompleted', 'LinkedSessionId', 'StartedAt', 'FinishedAt',
    'TotalActiveMin', 'TotalIdleMin', 'TotalHiddenMin', 'TotalWallMin', 'IntroSec', 'FinalSec', 'Resumes', 'OverallComment', 'FormFactor',
    'ViewportW', 'ViewportH', 'ScreenW', 'ScreenH', 'DPR', 'TouchPoints', 'CoarsePointer', 'Language', 'TimeZone', 'UserAgent', 'AppVersion',
    'DataVersion', 'BackendVersion', 'Eval_year'];
  const OLD_RESP = ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear',
    'StudyType', 'SequenceIndex', 'SeqSource', 'CaseOrder', 'CaseKey', 'PatientId', 'Model', 'ModelName',
    'P1_Referral', 'ComboChoice', 'ComboName', 'ComboIsAIFirst', 'P2_SharedDecision', 'P3_Pharmacotherapy', 'P4_FollowUp', 'P5_Education',
    'CaseComment', 'CaseStartedAt', 'CaseCompletedAt', 'CaseActiveSec', 'CaseIdleSec', 'CaseHiddenSec', 'CaseWallSec']
    .concat(STEPC.map(s => 'Sec_' + s), SIX.map(s => 'TTFR_' + s), SIX.map(s => 'Changes_' + s), STEPC.map(s => 'Scroll_' + s),
      STEPC.map(s => 'Visits_' + s), ['ComboResets', 'PatientDrawerOpens', 'PatientDrawerSec', 'AppVersion', 'DataVersion', 'BackendVersion', 'MetricsJson', 'Eval_year']);
  const OLD_LONG = ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorRole', 'EvaluatorDetail', 'ResidentYear', 'StudyType',
    'SequenceIndex', 'CaseOrder', 'CaseKey', 'PatientId', 'Model', 'ComboChoice', 'Phase', 'PhaseLabel', 'Score', 'Acceptable_4plus',
    'ActiveSec', 'ActiveOnlySec', 'TTFRSec', 'Changes', 'ScrollPct', 'Visits'];
  const people = [['O1', '홍 길동', '레지던트', 'A', 0, '2026-11-01T01:00:00Z'], ['O2', '홍길동', '레지던트', 'A', 1, '2026-11-02T01:00:00Z'],
    ['O3', '이몽룡', '전문의', 'B', 0, '2026-11-03T01:00:00Z']];
  const sess = [], resp = [], long = [];
  people.forEach(([sid, name, role, type, seq, first]) => {
    const t0 = Date.parse(first);
    sess.push({ FirstSeenAt: new Date(t0), SessionId: sid, IsTest: false, EvaluatorName: name, EvaluatorRole: role, StudyType: type, SequenceIndex: seq,
      Order: ORDERS[type][seq].join(' > '), Status: 'completed', FinishedAt: new Date(t0 + 1800e3).toISOString(), TotalActiveMin: 15, TotalIdleMin: 1, Eval_year: role === '레지던트' ? 'R2' : '' });
    ORDERS[type][seq].forEach((key, i) => {
      const model = key.split('_')[1];
      const sc = [4, 3, 5, 4, 2];
      resp.push({ SessionId: sid, IsTest: false, EvaluatorName: name, EvaluatorRole: role, StudyType: type, SequenceIndex: seq, CaseOrder: i + 1,
        CaseKey: key, PatientId: key.split('_')[0], Model: model, ModelName: MODEL_NAME[model], P1_Referral: sc[0], ComboChoice: 2,
        P2_SharedDecision: sc[1], P3_Pharmacotherapy: sc[2], P4_FollowUp: sc[3], P5_Education: sc[4], CaseComment: '-',
        CaseCompletedAt: new Date(t0 + (i + 1) * 600e3).toISOString(), CaseActiveSec: 300, CaseIdleSec: 20, Sec_P1: 40 });
      PH.forEach((P, j) => long.push({ SessionId: sid, IsTest: false, EvaluatorName: name, CaseKey: key, Model: model, ComboChoice: 2, Phase: P,
        Score: sc[j], ActiveSec: 45, TTFRSec: 10 }));
    });
  });
  put(env.SS, 'Sessions', OLD_SESS, sess);
  put(env.SS, 'Responses', OLD_RESP, resp);
  put(env.SS, 'PhaseLong', OLD_LONG, long);
  let r;
  try { r = env.ctx.buildSummary(false); ok('old column set: no exception', true); }
  catch (e) { ok('old column set: no exception', false, e.stack); return; }
  const AL = read(env.SS, 'AnalysisLong'), H = AL[0], col = n => H.indexOf(n);
  eq('old column set: AnalysisLong rows', AL.length - 1, 30);
  eq('old column set: name|role identity de-duplicates same Type', AL.slice(1).filter(x => x[col('ExclusionReason')] === 'duplicate').length, 10);
  eq('old column set: pseudonyms assigned', [...new Set(AL.slice(1).map(x => x[col('EvaluatorCode')]))].sort().join(','), 'R001,R002');
  eq('old column set: VisibleSec falls back to legacy ActiveSec', AL[1][col('VisibleSec')], 45);
  eq('old column set: TargetKey rebuilt from ComboChoice', AL.find(x => x[col('Phase')] === 'P3')[col('TargetKey')].split('|')[1], 'C2');
  eq('old column set: included evaluators', r.evaluators, 2);
  const S = read(env.SS, 'Summary');
  ok('old column set: Summary has all sections [0]–[15]', Array.from({ length: 16 }, (_, i) => i).every(i => S.some(x => String(x[0]).startsWith('[' + i + ']'))));
})();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
