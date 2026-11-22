#!/usr/bin/env node
/**
 * Unit test for the guideline-concordance (GC) backend: gas/GcCode.gs (= gas/gc/*.gs + shared helpers + GC_ITEMS),
 * the SEPARATE Apps Script project with its own spreadsheet (docs/GC_CONTRACT.md).
 *
 *   python3 tools/build_gas.py && node tools/test_gc.js [--dump <dir>]
 *
 * Loads gas/GcCode.gs unchanged into a vm context with an in-memory Sheets mock (same semantics as
 * tools/mock_gas_server.js: the leading text-marker apostrophe is stripped on read). Checks the build (no duplicate
 * top-level names, no CA entry points), setup() (creates the GC spreadsheet when no ID is set, sheets, one trigger,
 * idempotent), drives doPost with the contract payloads (start, judgments incl. edits / stale re-sends, finish twice,
 * progress, test session, CA payloads rejected), checks the GC_* sheets, balanced sequences and pseudonym codes, then
 * builds a synthetic multi-physician study and checks buildGcSummary (adjudication statuses, hand-computed adjusted
 * concordance, agreement, Fleiss kappa, GC_Codebook), the 10-minute refreshGcSummaryIfDirty trigger, and finally runs
 * tools/test_summary.js (CA backend, gas/Code.gs). No network. Prints PASS/FAIL lines; exit 1 on failure.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DUMP = process.argv.indexOf('--dump') >= 0 ? process.argv[process.argv.indexOf('--dump') + 1] : '';   // write GC sheets as TSV
const CODE_REAL = fs.readFileSync(path.join(ROOT, 'gas', 'GcCode.gs'), 'utf8');
const CA_CODE = fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8');
const loadWindow = (rel) => { const win = {}; vm.runInNewContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), { window: win }); return win; };
// The protocol / summary tests below are written against set v1 (the live study: its items, Parts and the v1 literals in
// gc-config.js). They read v1 from its archive, so they keep passing after cases/active.json switches to another set.
// The ACTIVE set (gc/data/gc_items.js, embedded in gas/GcCode.gs as GC_ITEMS) is checked on its own in staticChecks.
const ACTIVE_GC = loadWindow('gc/data/gc_items.js').GC_DATA;
const ACTIVE_ID = ACTIVE_GC.set_id || 'v1';
const GC_DATA = loadWindow('gc/data/sets/v1/gc_items.js').GC_DATA;
const GC_CONFIG = loadWindow('gc/gc-config.js').GC_CONFIG;
const V1_SET_TEXT = fs.readFileSync(path.join(ROOT, 'gc', 'data', 'sets', 'v1.json'), 'utf8');
const GC_ITEMS_AT = CODE_REAL.lastIndexOf('\nvar GC_ITEMS = {');
// v1 world: the real GcCode.gs, with set v1 as the embedded copy when another set is active (identical when v1 is active)
const CODE = ACTIVE_ID === 'v1' ? CODE_REAL : CODE_REAL.slice(0, GC_ITEMS_AT) + '\nvar GC_ITEMS = ' + V1_SET_TEXT.trim() + ';\n';
const INDEX_URL = 'https://eval.asclep.org/gc/data/sets/index.json';

// ---------------- In-memory spreadsheet mock (same as tools/test_summary.js) ----------------
class Range {
  constructor(sheet, row, col, nr, nc) { Object.assign(this, { sheet, row, col, nr, nc }); }
  getValues() {
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
    for (let r = 0; r < this.nr; r++) {
      const ri = this.row - 1 + r;
      this.sheet.cells[ri] = this.sheet.cells[ri] || [];
      for (let c = 0; c < this.nc; c++) this.sheet.cells[ri][this.col - 1 + c] = vals[r][c];
    }
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setFontWeight() { return this; } setBackground() { return this; } setFontSize() { return this; }
  setNumberFormat(fmt) {
    this.sheet.formats = this.sheet.formats || {};
    for (let r = 0; r < this.nr; r++) for (let c = 0; c < this.nc; c++) this.sheet.formats[(this.row + r) + ':' + (this.col + c)] = fmt;
    return this;
  }
  getNumberFormat() { return ((this.sheet.formats || {})[this.row + ':' + this.col]) || 'General'; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = []; }
  getName() { return this.name; }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
    return new Range(this, r, c, nr, nc);
  }
  getMaxRows() { return Math.max(1000, this.cells.length); }
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
let ssSeq = 0;
class Spreadsheet {
  static copies = 0;
  constructor(name) { this.sheets = [new Sheet('Sheet1')]; this.name = name || 'Untitled'; this.id = 'mock-ss-' + (++ssSeq); }
  getId() { return this.id; }
  getName() { return this.name; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  getSpreadsheetTimeZone() { return this.tz || 'America/New_York'; }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  copy(name) {
    const c = Object.create(Object.getPrototypeOf(this));
    Object.assign(c, this, { name, id: (this.id || 'ss') + '-copy-' + (++Spreadsheet.copies) });
    c.sheets = this.sheets.map(sh => { const n = new Sheet(sh.name); n.cells = sh.cells.map(r => (r || []).slice()); n.formats = Object.assign({}, sh.formats || {}); return n; });
    (Spreadsheet.copied = Spreadsheet.copied || []).push(c);
    return c;
  }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  getUrl() { return 'mock://spreadsheet'; }
}

/**
 * opts.bound   → the script is bound to a spreadsheet (getActiveSpreadsheet returns it); default: standalone project
 *                created at script.google.com (getActiveSpreadsheet → null, setup() creates the spreadsheet)
 * opts.setup   → run setup() right away (default true)
 * opts.code    → script source (default gas/GcCode.gs)
 * opts.fetch   → false: no UrlFetchApp (a deployment without the 'external service' permission); default: UrlFetchApp serves
 *                the repository files for https://eval.asclep.org/<path> (env.site[url] = {code, text} overrides one URL,
 *                env.fetches logs every fetched URL). CacheService.getScriptCache() is an in-memory store (env.cache).
 * opts.from    → an earlier env: the new code runs as a redeploy of that project (same spreadsheets, script properties, triggers)
 */
function makeEnv(opts) {
  opts = opts || {};
  const prev = opts.from || null;
  const SS = prev ? prev.SS : new Spreadsheet('bound');
  const props = prev ? prev.props : {};
  const triggers = prev ? prev.triggers : [];
  const lock = { busy: false, acquired: 0, released: 0, held: false, flushHeld: 0, flushFree: 0 };
  const created = [], opened = [], logs = [];
  const books = prev ? prev.books : { [SS.getId()]: SS };
  const env = { SS, props, triggers, lock, created, opened, logs, fetches: [], site: {}, cache: {}, cachePuts: 0, books };
  // v1 world: when another set is active on the site, the site's index.json is served as if v1 were active
  if (ACTIVE_ID !== 'v1') env.site[INDEX_URL] = { code: 200, text: JSON.stringify({ active: 'v1', sets: ['v1'] }) };
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (opts.bound ? SS : null),
      openById: id => { opened.push(id); if (!books[id]) throw new Error('mock: no spreadsheet ' + id); return books[id]; },
      create: name => { const s = new Spreadsheet(name); books[s.getId()] = s; created.push(s); env.SS = s; return s; },
      getUi: () => ({ alert() {}, createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } }),
      flush: () => { if (lock.held) lock.flushHeld++; else lock.flushFree++; }
    },
    LockService: { getScriptLock: () => ({
      waitLock() { if (lock.busy) throw new Error('busy'); lock.acquired++; lock.held = true; },
      tryLock() { if (lock.busy) return false; lock.acquired++; lock.held = true; return true; },
      releaseLock() { lock.released++; lock.held = false; } }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }, getProperties: () => Object.assign({}, props) }) },
    ScriptApp: {
      EventType: { CLOCK: 'CLOCK' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: t => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: fn => {
        const b = { timeBased: () => b, everyMinutes: () => b, everyHours: () => b,
          create: () => { const t = { getHandlerFunction: () => fn, getEventType: () => 'CLOCK' }; triggers.push(t); return t; } };
        return b;
      }
    },
    Utilities: {
      formatDate: (d, tz, fmt) => new Date(d).toISOString().replace('T', ' ').slice(0, 19),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => Array.from(crypto.createHash(alg).update(String(str), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      sleep: () => {}
    },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }) },
    CacheService: { getScriptCache: () => ({
      get: k => (k in env.cache ? env.cache[k] : null),
      put: (k, v, ttl) => { if (String(v).length > 100000) throw new Error('Argument too large'); env.cache[k] = String(v); env.cachePuts++; env.lastTtl = ttl; },
      remove: k => { delete env.cache[k]; } }) },
    Logger: { log: (m) => logs.push(String(m)) },
    console: { log: () => {}, warn: (...a) => console.warn(...a), error: () => {} },
    JSON, Math, Date, String, Number, Object, Array, isNaN
  };
  if (opts.fetch !== false) {
    ctx.UrlFetchApp = { fetch: (url, o) => {
      env.fetches.push(url);
      (env.fetchHeld = env.fetchHeld || []).push(lock.held);
      if (!o || o.muteHttpExceptions !== true) throw new Error('test: muteHttpExceptions must be set');
      const fake = env.site[url];
      if (fake) { if (fake.throw) throw new Error(fake.throw); return { getResponseCode: () => fake.code, getContentText: () => fake.text }; }
      const m = /^https:\/\/eval\.asclep\.org\/(.+)$/.exec(url);
      const fp = m ? path.join(ROOT, decodeURIComponent(m[1])) : '';
      if (!fp || !fp.startsWith(ROOT) || !fs.existsSync(fp)) return { getResponseCode: () => 404, getContentText: () => 'Not Found' };
      return { getResponseCode: () => 200, getContentText: () => fs.readFileSync(fp, 'utf8') };
    } };
  }
  vm.createContext(ctx);
  vm.runInContext(opts.code || CODE, ctx, { filename: 'GcCode.gs' });
  env.ctx = ctx;
  env.post = (payload) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(payload), type: 'text/plain' } }).getContent());
  if (opts.setup !== false) env.setupUrl = ctx.setup();
  return env;
}

function read(SS, name) {
  const sh = SS.getSheetByName(name);
  if (!sh) return null;
  const lr = sh.getLastRow(), lc = sh.getLastColumn();
  return lr ? sh.getRange(1, 1, lr, Math.max(lc, 1)).getValues() : [];
}
/** sheet → array of {header: value} (data rows only) */
function objs(SS, name) {
  const v = read(SS, name);
  if (!v || !v.length) return [];
  return v.slice(1).map(r => { const o = {}; v[0].forEach((h, i) => { if (h !== '') o[h] = r[i]; }); return o; });
}
function rawCell(SS, name, rowPred, col) {   // stored value incl. the text-marker apostrophe
  const sh = SS.getSheetByName(name), hdr = sh.cells[0].map(h => String(h).replace(/^'/, ''));
  const ci = hdr.indexOf(col);
  const r = sh.cells.slice(1).find(row => rowPred(row.map(v => (typeof v === 'string' && v[0] === "'") ? v.slice(1) : v), hdr));
  return r ? r[ci] : undefined;
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
  const j = rows.findIndex((r, k) => k > i && /^\[\d+\]/.test(String(r[0])));
  return rows.slice(i, j < 0 ? rows.length : j);
}
function row(rows, pred) { return rows.find(pred) || []; }
const r3 = v => Math.round(v * 1000) / 1000;
const r4 = v => Math.round(v * 10000) / 10000;
function wilson(x, n) {   // independent implementation for cross-checking
  const z = 1.959963984540054, p = x / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

// ---------------- contract (docs/GC_CONTRACT.md) ----------------
const H_GC_SESS = ['FirstSeenAt', 'ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorCode', 'EvaluatorId', 'Part',
  'SequenceIndex', 'SeqSource', 'Order', 'Status', 'ItemsTotal', 'ItemsDone', 'AgreeN', 'DisagreeN', 'LinkedSessionId', 'SessionOrdinal',
  'DeviceId', 'VisitId', 'Src', 'Site', 'Wave', 'PartPreselected', 'ConsentVersion', 'ConsentAt', 'ConsentInherited', 'InstrumentVersion',
  'Incentive', 'StartedAt', 'FinishedAt', 'TotalActiveMin', 'TotalWallMin', 'Resumes', 'SendFailures', 'FurthestUnit', 'FurthestItem',
  'LastActivityAt', 'OverallComment', 'FormFactor', 'ViewportW', 'ViewportH', 'UserAgent', 'AppVersion', 'DataVersion', 'BackendVersion',
  'UiLang', 'UiLangStart', 'UiLangs', 'UiLangSwitches', 'SetId'];   // v4: language + case set appended at the end
const H_GC_JUDG = ['ServerUpdatedAt', 'SessionId', 'IsTest', 'EvaluatorName', 'EvaluatorCode', 'EvaluatorId', 'Part', 'SequenceIndex',
  'SessionOrdinal', 'UnitOrder', 'ItemOrder', 'UnitKey', 'PatientId', 'Model', 'Combo', 'Question', 'Element', 'ItemId', 'TargetKey',
  'AuditMark', 'AuditCategory', 'RaterVerdict', 'AuditCorrected', 'AIFinal', 'Agree', 'PhysVerdict', 'PhysVerdict_code', 'AgreeWithRater',
  'AgreeWithAIFinal', 'Comment', 'AnsweredAt', 'ItemSec', 'ActiveSec', 'TTFDSec', 'Changes', 'OpenedCriterion', 'OpenedFullAnswer',
  'OpenedBasis', 'OpenedPatient', 'ClientMismatch', 'AppVersion', 'DataVersion', 'BackendVersion', 'UiLang', 'UiLangs', 'SetId'];
const H_RAW = ['ReceivedAt', 'Action', 'SessionId', 'MsgId', 'IsTest', 'Payload', 'ElapsedMs', 'Error'];
const H_ADJ = ['ItemId', 'UnitKey', 'Element', 'Title', 'Combo', 'Question', 'AuditMark', 'AuditCategory', 'RaterVerdict', 'AIFinal', 'N',
  'AgreeN', 'Met', 'Deducted', 'NotApplicable', 'Adjudicated', 'Status', 'Comments', 'SetId'];
const H_CONC = ['TargetKey', 'N_AI', 'Met_Raw', 'Met_AI', 'Score_Raw', 'Score_AI', 'N_Adj', 'Met_Adj', 'ConcordanceScore', 'FlaggedItems',
  'Adjudicated', 'Pending', 'SetId'];

// ---------------- payload builders ----------------
const ITEM = {};
Object.values(GC_DATA.units).forEach(u => u.items.forEach(it => { ITEM[it.id] = it; }));
const PART_UNITS = {};
GC_CONFIG.PARTS.forEach(p => { PART_UNITS[p.id] = p.sequences[0].slice(); });
const partItems = part => PART_UNITS[part].reduce((a, k) => a.concat(GC_DATA.units[k].items.map(it => it.id)), []);
const uuid = () => crypto.randomUUID();
const T0 = Date.parse('2026-11-20T01:00:00Z');
const iso = ms => new Date(T0 + ms).toISOString();

function physician(name, part, extra) {
  return Object.assign({ name, part, sid: uuid(), evId: uuid(), dev: 'dev-' + name, visit: uuid(), seq: null, seqSource: 'server', order: null,
    ordinal: 1, linked: null, test: false, fields: { board_years: '10–19년', setting: '상급종합병원', ai_freq: '주 1–2회' },
    codes: { board_years: 3, setting: 1, ai_freq: 3 } }, extra || {});
}
function base(ph, action, extra) {
  return Object.assign({
    action, msg_id: uuid(), client_time: new Date().toISOString(), study_id: 'T2D-GC-2026', app_version: GC_CONFIG.APP_VERSION,
    data_version: GC_DATA.data_version, instrument_version: GC_CONFIG.INSTRUMENT_VERSION, session_id: ph.sid, is_test: ph.test,
    evaluator: { name: ph.name, role: 'endo', eligible: true, fields: ph.fields, codes: ph.codes },
    evaluator_id: ph.evId, device_id: ph.dev, visit_id: ph.visit, session_ordinal: ph.ordinal, linked_session_id: ph.linked, part: ph.part,
    sequence_index: ph.seq, seq_source: ph.seqSource, order: ph.order, n_sequences: 2,
    entry: { src: 'qr', site: '', wave: 'main', part_preselected: false, in_app: '', referrer_origin: '' },
    consent: { version: GC_CONFIG.CONSENT_VERSION, at: iso(0), inherited: ph.ordinal > 1 }, incentive: GC_CONFIG.INCENTIVE,
    ui_lang: ph.lang || 'ko', set_id: ph.set || 'v1'   // site v2.2+: screen language and case set on every payload
  }, extra || {});
}
const DEVICE = { form_factor: 'mobile', vw: 390, vh: 844, ua: 'Mozilla/5.0 (iPhone) test' };
function startPh(env, ph) {
  const r = env.post(base(ph, 'gc_start', { device: DEVICE }));
  if (r.ok) {
    ph.seq = r.seq_index;
    ph.order = GC_CONFIG.PARTS.find(p => p.id === ph.part).sequences[r.seq_index].slice();
  }
  return r;
}
function judgment(ph, itemId, verdict, o) {
  o = o || {};
  const it = ITEM[itemId];
  const unitOrder = ph.order ? ph.order.indexOf(it.unit) + 1 : 1;
  return {
    item_id: itemId, unit: it.unit, unit_order: unitOrder, item_order: o.item_order || 1, patient: it.patient, combo: it.combo,
    question: it.question, element: it.element, audit_mark: it.audit.mark, audit_category: it.audit.category,
    rater_verdict: it.rater.verdict, audit_corrected: it.audit.corrected, ai_final: o.ai_final || it.final,
    agree: verdict === it.final, phys_verdict: verdict, comment: o.comment || '', answered_at: o.at || iso(60e3),
    item_ms: o.ms !== undefined ? o.ms : 30000, active_ms: o.active !== undefined ? o.active : 25000, ttfd_ms: o.ttfd !== undefined ? o.ttfd : 12000,
    changes: o.changes || 0, opened: o.opened || { criterion: true, full_answer: false, basis: true, patient: false }
  };
}
const endItems = (a, b) => ({
  info_sufficient: { value: GC_CONFIG.END_ITEMS[0].options[a - 1], code: a },
  hitl_acceptable: { value: GC_CONFIG.END_ITEMS[1].options[b - 1], code: b }
});

// =====================================================================
// 1) Static: generated GC_ITEMS, Part mapping, setup()
// =====================================================================
(function staticChecks() {
  // --- build: one file per project, no duplicates, no CA entry points in the GC project ---
  const topNames = src => (src.match(/^(?:function|var)\s+[A-Za-z_$][\w$]*/gm) || []).map(x => x.split(/\s+/)[1]);
  const gcNames = topNames(CODE);
  const dupes = gcNames.filter((n, i) => gcNames.indexOf(n) !== i);
  eq('GcCode.gs: no top-level name declared twice', dupes.join(','), '');
  const caOnly = ['buildSummary', 'buildSummaryIncludingTests', 'refreshSummaryIfDirty', 'ensureSummaryTrigger_', 'showCounter', 'ss_',
    'handleView_', 'handleStart_', 'logRaw_', 'SPREADSHEET_ID', 'BACKEND_VERSION', 'EXPECTED_STUDY_ID', 'VALID_ACTIONS'];
  eq('GcCode.gs: no CA entry points / CA spreadsheet settings', caOnly.filter(n => gcNames.indexOf(n) >= 0).join(','), '');
  ok('GcCode.gs: does not contain the CA spreadsheet id', !/1-R-BZKkhyaTSHvHssM5sazwjq/.test(CODE));
  ok('GcCode.gs: Korean deployment header first, GC_SPREADSHEET_ID before any function',
    /^\/\*\*[\s\S]*?script\.google\.com[\s\S]*?새 배포[\s\S]*?웹 앱[\s\S]*?모든 사용자[\s\S]*?ENDPOINT[\s\S]*?\*\//.test(CODE) &&
    CODE.indexOf('var GC_SPREADSHEET_ID = "";') > 0 && CODE.indexOf('var GC_SPREADSHEET_ID') < CODE.search(/^function /m));
  const pub = gcNames.filter(n => /^[a-z]/i.test(n) && !/_$/.test(n) && new RegExp('^function ' + n + '\\b', 'm').test(CODE));
  eq('GC Run dropdown = GC functions only', pub.slice().sort().join(','),
    ['buildGcSummary', 'buildGcSummaryIncludingTests', 'doGet', 'doPost', 'onOpen', 'refreshGcSummaryIfDirty', 'resetAllGcResponses', 'setup', 'showGcCounter'].join(','));
  const caNames = topNames(CA_CODE);
  eq('Code.gs (CA): no top-level name declared twice', caNames.filter((n, i) => caNames.indexOf(n) !== i).join(','), '');
  ok('Code.gs (CA): no GC code', !/gc_|GC_/.test(CA_CODE));

  // --- before setup: requests fail with a clear Korean message, nothing is created ---
  const pre = makeEnv({ setup: false });
  const r0 = pre.post({ action: 'gc_start', session_id: uuid(), study_id: 'T2D-GC-2026', msg_id: uuid() });
  ok('before setup: request refused with "setup" hint', r0.ok === false && /setup/.test(r0.error) && /스프레드시트/.test(r0.error), r0.error);
  eq('before setup: no spreadsheet created by a request', pre.created.length, 0);

  // --- setup in a standalone project: creates the GC spreadsheet, stores its id, logs + returns the URL ---
  const env = makeEnv();
  eq('setup: created one spreadsheet', env.created.length, 1);
  eq('setup: spreadsheet name', env.created[0] && env.created[0].getName(), '가이드라인 부합도 검증 (GC) 응답');
  eq('setup: id stored in script property GC_SPREADSHEET_ID', env.props.GC_SPREADSHEET_ID, env.created[0].getId());
  eq('setup: returns the URL', env.setupUrl, env.created[0].getUrl());
  ok('setup: logs the URL', env.logs.some(l => l.indexOf(env.created[0].getUrl()) >= 0));
  const G = env.ctx.GC_ITEMS;
  GC_CONFIG.PROFILE_FIELDS.forEach(f => eq('GC_OPT.' + f.id + ' = gc-config.js PROFILE_FIELDS options (codes)', JSON.stringify(env.ctx.GC_OPT[f.id]), JSON.stringify(f.options)));
  eq('profile fields = board_years, setting, ai_freq', GC_CONFIG.PROFILE_FIELDS.map(f => f.id).join(','), 'board_years,setting,ai_freq');
  eq('GC_BACKEND_VERSION', env.ctx.GC_BACKEND_VERSION, '2026-11-21.gc-backend-v4');
  eq('GC_ITEMS data_version = gc/data/sets/v1/gc_items.js', G.data_version, GC_DATA.data_version);
  eq('GC_ITEMS units', Object.keys(G.units).join(','), Object.keys(GC_DATA.units).join(','));
  eq('GC_ITEMS item counts (P051_gpt 4, P051_deepseek 8, P011_gpt 10, P011_deepseek 7)',
    Object.keys(G.units).map(k => G.units[k].items.length).join(','), '4,8,10,7');
  eq('Part A items = 18', partItems('A').length, 18);
  eq('Part B items = 11', partItems('B').length, 11);
  const allowed = ['id', 'unit', 'patient', 'model', 'combo', 'question', 'element', 'title', 'target_key', 'audit_mark', 'audit_category',
    'audit_corrected', 'rater_verdict', 'final'].sort().join(',');
  ok('GC_ITEMS items carry only the backend fields', Object.values(G.units).every(u => u.items.every(it => Object.keys(it).sort().join(',') === allowed)));
  ok('GC_ITEMS items match gc_items.js (final, rater, audit, target)', Object.values(G.units).every(u => u.items.every(it => {
    const s = ITEM[it.id];
    return s && it.final === s.final && it.rater_verdict === s.rater.verdict && it.audit_mark === s.audit.mark &&
      it.audit_corrected === s.audit.corrected && it.target_key === s.target_key && it.model === GC_DATA.units[it.unit].model;
  })));
  ok('GC_ITEMS concordance_base = gc_items.js', Object.keys(G.units).every(k => JSON.stringify(G.units[k].concordance_base) === JSON.stringify(GC_DATA.units[k].concordance_base)));
  ok('GC_ITEMS block is compact (no criterion/explanation text)', CODE.indexOf('"criterion"') < 0 && CODE.indexOf('"explanation"') < 0);
  // backend Part mapping must match the site config
  const gp = env.ctx.gcParts_(G);
  ok('embedded Parts (GC_ITEMS.parts) = GC_CONFIG.PARTS (gc-config.js fallback)', GC_CONFIG.PARTS.every(p => gp[p.id] &&
    p.sequences.every(seq => seq.slice().sort().join(',') === gp[p.id].slice().sort().join(','))) && Object.keys(gp).length === GC_CONFIG.PARTS.length);
  ok('GC_CONFIG.PARTS sequences per Part = 2 (n_sequences default)', GC_CONFIG.PARTS.every(p => p.sequences.length === 2));
  ok('no GC_PARTS literal left in the backend (Parts come from the set data)', !/var GC_PARTS\b/.test(CODE));
  eq('GC_ITEMS.set_id = v1 (v1 world)', G.set_id, GC_DATA.set_id);
  const SET_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'gc', 'data', 'sets', GC_DATA.set_id + '.json'), 'utf8'));
  eq('GC_ITEMS = gc/data/sets/<active>.json (the copy the backend fetches)', JSON.stringify(G), JSON.stringify(SET_JSON));
  const DESIGN = loadWindow('data/sets/v1/design.js').T2D_DESIGN;
  eq('GC_ITEMS.parts = data/sets/v1/design.js gc.parts (sequences, items, minutes)', JSON.stringify(G.parts),
    JSON.stringify(DESIGN.gc.parts.map(p => ({ id: p.id, sequences: p.sequences, items: p.items, minutes: p.minutes }))));
  // the ACTIVE set: gas/GcCode.gs embeds exactly gc/data/sets/<active>.json, which matches gc/data/gc_items.js and data/design.js
  const realCtx = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(realCtx);
  vm.runInContext(CODE_REAL.slice(GC_ITEMS_AT) + '\nthis.__G = GC_ITEMS;', realCtx);
  const RG = realCtx.__G, ACT_DESIGN = loadWindow('data/design.js').T2D_DESIGN;
  const ACT_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'gc', 'data', 'sets', ACTIVE_ID + '.json'), 'utf8'));
  eq('gas/GcCode.gs embedded GC_ITEMS = gc/data/sets/' + ACTIVE_ID + '.json (active set ' + ACTIVE_ID + ')', JSON.stringify(RG), JSON.stringify(ACT_JSON));
  eq('active set: embedded data_version = gc/data/gc_items.js', RG.data_version, ACTIVE_GC.data_version);
  eq('active set: embedded units / item counts = gc/data/gc_items.js', Object.keys(RG.units).map(k => k + ':' + RG.units[k].items.length).join(','),
    Object.keys(ACTIVE_GC.units).map(k => k + ':' + ACTIVE_GC.units[k].items.length).join(','));
  eq('active set: data/design.js set_id', ACT_DESIGN.set_id, ACTIVE_ID);
  eq('active set: embedded parts = data/design.js gc.parts', JSON.stringify(RG.parts),
    JSON.stringify(ACT_DESIGN.gc.parts.map(p => ({ id: p.id, sequences: p.sequences, items: p.items, minutes: p.minutes }))));
  if (ACTIVE_ID !== 'v1') console.log('NOTE active set is ' + ACTIVE_ID + ': protocol and summary tests run on set v1 (archive gc/data/sets/v1/, embedded copy swapped in memory)');
  ok('deployment header names the one extra permission (외부 서비스에 연결)', /외부 서비스에 연결/.test(CODE.slice(0, 6000)) && /외부 서비스 연결/.test(CODE.slice(0, 6000)));
  const ends = GC_CONFIG.END_ITEMS.map(e => e.id).sort().join(',');
  ok('GC_CB_ITEMS covers END_ITEMS and PROFILE_FIELDS', ends === Object.keys(env.ctx.GC_CB_ITEMS).filter(k => env.ctx.GC_CB_ITEMS[k][0] === 'End_').sort().join(',') &&
    GC_CONFIG.PROFILE_FIELDS.every(f => env.ctx.GC_CB_ITEMS[f.id] && JSON.stringify(env.ctx.GC_OPT[f.id]) === JSON.stringify(f.options)));

  eq('setup: sheets of the GC spreadsheet', env.SS.getSheets().map(s => s.getName()).join(','), 'Visits,GC_Sessions,GC_Judgments,GC_Raw');
  eq('setup: Visits headers (same columns as CA)', JSON.stringify(read(env.SS, 'Visits')[0]), JSON.stringify(['ReceivedAt', 'VisitId', 'DeviceId', 'Src', 'Site', 'Wave', 'TypeParam', 'FormFactor', 'InAppBrowser', 'ReferrerOrigin', 'IsTest', 'AppVersion', 'UiLang', 'SetId']));
  eq('setup: GC_Sessions headers = contract', JSON.stringify(read(env.SS, 'GC_Sessions')[0]), JSON.stringify(H_GC_SESS));
  eq('setup: GC_Judgments headers = contract', JSON.stringify(read(env.SS, 'GC_Judgments')[0]), JSON.stringify(H_GC_JUDG));
  eq('setup: GC_Raw headers = contract', JSON.stringify(read(env.SS, 'GC_Raw')[0]), JSON.stringify(H_RAW));
  eq('setup: one GC summary trigger', env.triggers.map(t => t.getHandlerFunction()).join(','), 'refreshGcSummaryIfDirty');
  // setup again: same spreadsheet (no second create), still one trigger; test-only sheet rebuilt, real data kept
  env.SS.getSheetByName('GC_Raw').cells.push(['x', "'gc_start", "'s", "'m", true, "'{}", 1, '']);
  eq('setup again: returns the same URL', env.ctx.setup(), env.setupUrl);
  eq('setup again: no new spreadsheet', env.created.length, 1);
  eq('setup again: still one trigger', env.triggers.length, 1);
  eq('setup: test-only GC_Raw rebuilt', read(env.SS, 'GC_Raw').length, 1);
  env.SS.getSheetByName('GC_Raw').cells.push(['x', "'gc_start", "'s", "'m", false, "'{}", 1, '']);
  env.ctx.setup();
  eq('setup: GC_Raw with real rows kept', read(env.SS, 'GC_Raw').length, 2);
  eq('doGet: GC service', JSON.parse(env.ctx.doGet({}).getContent()).service, 'guideline-concordance');

  // --- bound to a spreadsheet: uses it instead of creating one ---
  const bound = makeEnv({ bound: true });
  eq('bound project: no spreadsheet created', bound.created.length, 0);
  eq('bound project: id of the bound sheet stored', bound.props.GC_SPREADSHEET_ID, bound.SS.getId());
  ok('bound project: GC sheets created there', !!bound.SS.getSheetByName('GC_Sessions'));
  // --- GC_SPREADSHEET_ID constant wins over the script property ---
  const fixed = makeEnv({ setup: false, code: CODE.replace('var GC_SPREADSHEET_ID = "";', 'var GC_SPREADSHEET_ID = "mock-ss-fixed";') });
  let msg = '';
  try { fixed.ctx.setup(); } catch (e) { msg = e.message; }
  ok('GC_SPREADSHEET_ID constant is used (openById, no create)', fixed.opened.indexOf('mock-ss-fixed') >= 0 && fixed.created.length === 0, msg);
})();

// =====================================================================
// 2) doPost protocol: validation, start, judgments, finish, progress, test session, CA unaffected
// =====================================================================
(function protocol() {
  const env = makeEnv();
  const { post, SS, props } = env;
  const p1 = physician('김 가나', 'A');

  // --- validation (same lock / json / UUID checks as CA) ---
  eq('bad session id rejected', post(base(Object.assign({}, p1, { sid: 'abc' }), 'gc_start')).error, 'bad session id');
  eq('GC action with CA study id rejected', post(base(p1, 'gc_start', { study_id: 'T2D-CA-2026' })).error, 'unknown study');
  eq('CA action rejected by the GC project', post(base(p1, 'start')).error, 'bad request');
  eq('unknown gc_ action rejected', post(base(p1, 'gc_bogus')).error, 'bad request');
  eq('no GC_Sessions row after rejected requests', objs(SS, 'GC_Sessions').length, 0);
  env.lock.busy = true;
  eq('busy lock → busy (client retries)', post(base(p1, 'gc_start')).error, 'busy');
  env.lock.busy = false;
  const rel0 = env.lock.released;

  // --- view beacon: GC study id only (the CA site has its own project) ---
  const view = (study, app, dev, test) => post({ action: 'view', msg_id: uuid(), client_time: iso(0), study_id: study, app_version: app, is_test: !!test,
    visit_id: uuid(), device_id: dev, entry: { src: 'qr', site: '', wave: 'main', part_preselected: false, in_app: '', referrer_origin: '' }, form_factor: 'mobile' });
  eq('view with GC study id ok', view('T2D-GC-2026', GC_CONFIG.APP_VERSION, 'dev-v1').ok, true);
  eq('view with CA study id rejected', view('T2D-CA-2026', '2026-11-19.ca-v3.3', 'dev-v2').error, 'bad request');
  eq('view with other study id rejected', view('OTHER', 'x', 'dev-v3').error, 'bad request');
  const visits = objs(SS, 'Visits');
  eq('Visits rows (GC only)', visits.length, 1);
  eq('Visits row: Src / AppVersion / IsTest', [visits[0].Src, visits[0].AppVersion, visits[0].IsTest].join('/'), 'qr/' + GC_CONFIG.APP_VERSION + '/false');

  // --- start + balanced sequences within a Part ---
  const r1 = startPh(env, p1);
  eq('gc_start ok', r1.ok, true);
  eq('lock released after request', env.lock.released > rel0, true);
  eq('first Part A session → seq 0', r1.seq_index, 0);
  let S = objs(SS, 'GC_Sessions');
  eq('one GC_Sessions row', S.length, 1);
  let s1 = S[0];
  eq('Status started', s1.Status, 'started');
  eq('EvaluatorCode G001', s1.EvaluatorCode, 'G001');
  eq('Part A', s1.Part, 'A');
  eq('SequenceIndex 0', s1.SequenceIndex, 0);
  eq('SeqSource server', s1.SeqSource, 'server');
  eq('ItemsTotal from Part before order is known', s1.ItemsTotal, 18);
  eq('ItemsDone 0', s1.ItemsDone, 0);
  eq('IsTest FALSE (boolean)', s1.IsTest, false);
  eq('Eval_board_years label', s1.Eval_board_years, '10–19년');
  eq('Eval_board_years_code', s1.Eval_board_years_code, 3);
  eq('Eval_ai_freq label', s1.Eval_ai_freq, '주 1–2회');
  eq('Eval_ai_freq_code', s1.Eval_ai_freq_code, 3);
  ok('no Eval_t2d_volume column (question removed)', !read(SS, 'GC_Sessions')[0].some(h => /t2d_volume/.test(h)));
  eq('device FormFactor', s1.FormFactor, 'mobile');
  eq('device ViewportW', s1.ViewportW, 390);
  eq('ConsentVersion', s1.ConsentVersion, GC_CONFIG.CONSENT_VERSION);
  eq('PartPreselected FALSE', s1.PartPreselected, false);
  eq('Src', s1.Src, 'qr');
  eq('BackendVersion', s1.BackendVersion, '2026-11-21.gc-backend-v4');
  ok('FirstSeenAt is a Date', s1.FirstSeenAt instanceof Date);
  eq('GC_Raw logged gc_start', objs(SS, 'GC_Raw').filter(r => r.Action === 'gc_start').length, 1);
  ok('no CA sheets in the GC spreadsheet', ['RawJSON', 'Sessions', 'Responses', 'PhaseLong', 'Summary'].every(n => !SS.getSheetByName(n)));
  ok('CA evaluator code counter untouched', !('EVC_COUNTER' in props));
  eq('re-sent gc_start returns the same seq', post(base(p1, 'gc_start', { sequence_index: null })).seq_index, 0);
  eq('re-sent gc_start: still one row', objs(SS, 'GC_Sessions').length, 1);

  const p2 = physician('이다라', 'A'), p3 = physician('박마바', 'A'), p4 = physician('최사아', 'B');
  eq('second Part A session → seq 1 (least used)', startPh(env, p2).seq_index, 1);
  eq('third Part A session → seq 0 (tie → rotating counter)', startPh(env, p3).seq_index, 0);
  eq('first Part B session → seq 0 (own namespace)', startPh(env, p4).seq_index, 0);
  eq('GC_SEQ_COUNTER_A', props.GC_SEQ_COUNTER_A, '3');
  eq('GC_SEQ_COUNTER_B', props.GC_SEQ_COUNTER_B, '1');
  ok('CA SEQ_COUNTER untouched', !Object.keys(props).some(k => k.indexOf('SEQ_COUNTER') === 0));
  eq('codes G002–G004 in arrival order', objs(SS, 'GC_Sessions').map(r => r.EvaluatorCode).join(','), 'G001,G002,G003,G004');
  const p5 = physician('정자차', 'B', { seq: 1, seqSource: 'local' });
  eq('local seq recorded as given', startPh(env, p5).seq_index, 1);
  eq('SeqSource local', objs(SS, 'GC_Sessions').find(r => r.SessionId === p5.sid).SeqSource, 'local');

  // --- judgments: write, metadata from GC_ITEMS, edit, stale re-send ---
  delete props.GC_SUMMARY_DIRTY;
  const A1 = 'P051_deepseek|C1|Q2.2-04', A2 = 'P051_deepseek|C2|Q3.4-09';
  let r = post(base(p1, 'gc_judgment', { judgment: judgment(p1, A1, 'deducted', { item_order: 1, at: iso(60e3), ai_final: 'met' }) }));
  eq('gc_judgment ok', r.ok, true);
  post(base(p1, 'gc_judgment', { judgment: judgment(p1, A2, 'not_applicable', { item_order: 2, at: iso(120e3), comment: '=HYPERLINK("http://x","y")', ms: 45678, changes: 2 }) }));
  let J = objs(SS, 'GC_Judgments');
  eq('two judgment rows', J.length, 2);
  const j1 = J.find(x => x.ItemId === A1);
  eq('TargetKey from GC_ITEMS', j1.TargetKey, 'P051_deepseek|C1|P2');
  eq('UnitKey', j1.UnitKey, 'P051_deepseek');
  eq('Model derived from unit', j1.Model, 'deepseek');
  eq('PatientId', j1.PatientId, 'P051');
  eq('Combo', j1.Combo, 1);
  eq('Question', j1.Question, '2.2');
  eq('Element', j1.Element, 'Q2.2-04');
  eq('AuditMark', j1.AuditMark, 'major');
  eq('AuditCategory', j1.AuditCategory, ITEM[A1].audit.category);
  eq('RaterVerdict', j1.RaterVerdict, 'met');
  eq('AuditCorrected', j1.AuditCorrected, 'deducted');
  eq('AIFinal is server-authoritative (client sent met)', j1.AIFinal, 'deducted');
  eq('ClientMismatch records the client\'s different ai_final', j1.ClientMismatch, 'ai_final met ≠ deducted');
  eq('Agree TRUE', j1.Agree, true);
  eq('PhysVerdict', j1.PhysVerdict, 'deducted');
  eq('PhysVerdict_code 2', j1.PhysVerdict_code, 2);
  eq('AgreeWithRater FALSE', j1.AgreeWithRater, false);
  eq('AgreeWithAIFinal TRUE', j1.AgreeWithAIFinal, true);
  eq('UnitOrder (order P051_deepseek first)', j1.UnitOrder, 1);
  eq('ItemSec', j1.ItemSec, 30);
  eq('ActiveSec', j1.ActiveSec, 25);
  eq('TTFDSec', j1.TTFDSec, 12);
  eq('OpenedCriterion TRUE', j1.OpenedCriterion, true);
  eq('OpenedFullAnswer FALSE', j1.OpenedFullAnswer, false);
  eq('EvaluatorCode on judgment', j1.EvaluatorCode, 'G001');
  eq('Part on judgment', j1.Part, 'A');
  eq('SequenceIndex on judgment', j1.SequenceIndex, 0);
  ok('GC_Judgments has no Eval_* columns', read(SS, 'GC_Judgments')[0].every(h => !/^Eval_/.test(h)));
  eq('GC_Judgments header unchanged', JSON.stringify(read(SS, 'GC_Judgments')[0]), JSON.stringify(H_GC_JUDG));
  const j2 = J.find(x => x.ItemId === A2);
  eq('not_applicable code 3', j2.PhysVerdict_code, 3);
  eq('ClientMismatch empty when the site matches the server', j2.ClientMismatch, '');
  eq('disagree → Agree FALSE', j2.Agree, false);
  eq('ItemSec rounding (45678 ms → 45.7)', j2.ItemSec, 45.7);
  eq('Changes', j2.Changes, 2);
  eq('formula-like comment stored as text', rawCell(SS, 'GC_Judgments', (r, h) => r[h.indexOf('ItemId')] === A2, 'Comment'), '\'=HYPERLINK("http://x","y")');
  s1 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p1.sid);
  eq('session in_progress after judgment', s1.Status, 'in_progress');
  eq('ItemsDone recomputed', s1.ItemsDone, 2);
  eq('AgreeN', s1.AgreeN, 1);
  eq('DisagreeN', s1.DisagreeN, 1);
  eq('Order written', s1.Order, 'P051_deepseek > P011_gpt');
  eq('ItemsTotal from order', s1.ItemsTotal, 18);
  eq('GC_SUMMARY_DIRTY set by real judgment', props.GC_SUMMARY_DIRTY, '1');
  ok('CA SUMMARY_DIRTY not set by GC', props.SUMMARY_DIRTY !== '1');

  // edit (re-sent with a later answered_at) → upsert, counts recomputed
  post(base(p1, 'gc_judgment', { judgment: judgment(p1, A2, 'met', { item_order: 2, at: iso(180e3), comment: '다시 보니 충족' }) }));
  J = objs(SS, 'GC_Judgments');
  eq('edit: still two rows', J.length, 2);
  eq('edit: verdict replaced', J.find(x => x.ItemId === A2).PhysVerdict, 'met');
  s1 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p1.sid);
  eq('edit: AgreeN 2', s1.AgreeN, 2);
  eq('edit: DisagreeN 0', s1.DisagreeN, 0);
  // a stale re-send (older answered_at) does not overwrite the newer edit
  post(base(p1, 'gc_judgment', { judgment: judgment(p1, A2, 'deducted', { item_order: 2, at: iso(120e3) }) }));
  eq('stale re-send ignored', objs(SS, 'GC_Judgments').find(x => x.ItemId === A2).PhysVerdict, 'met');

  // --- finish (all 18 judgments), then re-send ---
  const ids = partItems('A');
  const all = ids.map((id, i) => {
    if (id === A2) return judgment(p1, A2, 'met', { item_order: 2, at: iso(180e3), comment: '다시 보니 충족' });
    return judgment(p1, id, i === 5 ? (ITEM[id].final === 'met' ? 'deducted' : 'met') : ITEM[id].final, { item_order: i + 1, at: iso((i + 1) * 60e3) });
  });
  const updA2 = objs(SS, 'GC_Judgments').find(x => x.ItemId === A2).ServerUpdatedAt;
  const fin = base(p1, 'gc_finish', {
    judgments: all, end_items: endItems(4, 5), overall_comment: '+수고하셨습니다',
    session: { started_at: iso(0), finished_at: iso(20 * 60e3), total_active_ms: 600000, total_wall_ms: 900000, resumes: 1, send_failures: 0 }, device: DEVICE
  });
  eq('gc_finish ok', post(fin).ok, true);
  J = objs(SS, 'GC_Judgments').filter(x => x.SessionId === p1.sid);
  eq('finish: 18 judgment rows, no duplicates', J.length, 18);
  ok('finish: identical re-sent judgment skipped (ServerUpdatedAt kept)', J.find(x => x.ItemId === A2).ServerUpdatedAt === updA2);
  s1 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p1.sid);
  eq('finish: Status completed', s1.Status, 'completed');
  eq('finish: ItemsDone 18', s1.ItemsDone, 18);
  eq('finish: AgreeN 17', s1.AgreeN, 17);
  eq('finish: DisagreeN 1', s1.DisagreeN, 1);
  eq('finish: End_info_sufficient', s1.End_info_sufficient, '4 · 그렇다');
  eq('finish: End_info_sufficient_code', s1.End_info_sufficient_code, 4);
  eq('finish: End_hitl_acceptable_code', s1.End_hitl_acceptable_code, 5);
  eq('finish: TotalActiveMin', s1.TotalActiveMin, 10);
  eq('finish: TotalWallMin', s1.TotalWallMin, 15);
  eq('finish: Resumes', s1.Resumes, 1);
  eq('finish: FinishedAt is a Date (초 단위 표시)', s1.FinishedAt instanceof Date && s1.FinishedAt.toISOString(), iso(20 * 60e3));
  eq('finish: OverallComment stored as text', rawCell(SS, 'GC_Sessions', (r, h) => r[h.indexOf('SessionId')] === p1.sid, 'OverallComment'), "'+수고하셨습니다");
  const snap = JSON.stringify(objs(SS, 'GC_Judgments').map(x => [x.SessionId, x.ItemId, x.PhysVerdict, String(x.ServerUpdatedAt)]));
  eq('finish re-sent ok', post(Object.assign({}, fin, { msg_id: uuid() })).ok, true);
  eq('finish re-send: judgments unchanged (idempotent)', JSON.stringify(objs(SS, 'GC_Judgments').map(x => [x.SessionId, x.ItemId, x.PhysVerdict, String(x.ServerUpdatedAt)])), snap);
  s1 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p1.sid);
  eq('finish re-send: still completed, ItemsDone 18', s1.Status + '/' + s1.ItemsDone, 'completed/18');
  eq('finish re-send: one session row', objs(SS, 'GC_Sessions').filter(x => x.SessionId === p1.sid).length, 1);
  // late message after completion
  post(base(p1, 'gc_judgment', { judgment: judgment(p1, A1, 'met', { at: iso(30e3) }), session: { total_active_ms: 1000 } }));
  s1 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p1.sid);
  eq('late stale judgment: status does not regress', s1.Status, 'completed');
  eq('late stale judgment: verdict kept', objs(SS, 'GC_Judgments').find(x => x.SessionId === p1.sid && x.ItemId === A1).PhysVerdict, 'deducted');
  eq('late message: time summary not rolled back', s1.TotalActiveMin, 10);
  post(base(p1, 'gc_progress', { progress: { furthest_unit: 1, furthest_item: 2, items_done: 2, last_activity_at: iso(1) } }));
  eq('progress after completion ignored', objs(SS, 'GC_Sessions').find(x => x.SessionId === p1.sid).FurthestUnit, '');
  // 6 starts (incl. re-send) + 4 judgments + 2 finishes + 1 late judgment + 1 progress; rejected/busy requests are not logged
  eq('GC_Raw logs every accepted GC request', objs(SS, 'GC_Raw').length, 14);
  // GC_Raw.Payload = the request as received: valid JSON, no server-added keys (v4 must not copy the case-set data into every row)
  const rawP = objs(SS, 'GC_Raw').map(x => String(x.Payload).replace(/^'/, ''));
  const parsed = rawP.map(t => { try { return JSON.parse(t); } catch (e) { return null; } });
  ok('GC_Raw.Payload: every row parses as JSON', parsed.every(Boolean), rawP.filter((t, i) => !parsed[i]).map(t => t.slice(-40)).join(' | '));
  ok('GC_Raw.Payload: no server-added keys (_set, _gcev)', parsed.every(o => o && !('_set' in o) && !('_gcev' in o)),
    parsed.filter(o => o && ('_set' in o || '_gcev' in o)).map(o => Object.keys(o).filter(k => k[0] === '_').join(',')).join(' | '));
  ok('GC_Raw.Payload: a judgment row stays small (< 4,000 chars)', rawP.filter((t, i) => parsed[i] && parsed[i].action === 'gc_judgment').every(t => t.length < 4000),
    rawP.map(t => t.length).join(','));

  // --- progress ---
  post(base(p2, 'gc_progress', { progress: { furthest_unit: 1, furthest_item: 3, items_done: 2, last_activity_at: iso(5e3) } }));
  const s2 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p2.sid);
  eq('progress: FurthestUnit', s2.FurthestUnit, 1);
  eq('progress: FurthestItem', s2.FurthestItem, 3);
  eq('progress: LastActivityAt is a Date', s2.LastActivityAt instanceof Date && s2.LastActivityAt.toISOString(), iso(5e3));
  eq('progress: status unchanged', s2.Status, 'started');
  const p6 = physician('윤가가', 'B', { seq: 1, order: ['P051_gpt', 'P011_deepseek'] });
  post(base(p6, 'gc_progress', { progress: { furthest_unit: 2, furthest_item: 9, items_done: 8, last_activity_at: iso(9e3) } }));
  const s6 = objs(SS, 'GC_Sessions').find(x => x.SessionId === p6.sid);
  eq('progress for unseen session creates a started row', s6 && s6.Status, 'started');
  eq('progress-created row: Part and ItemsTotal', s6.Part + '/' + s6.ItemsTotal, 'B/11');

  // --- same person, continuation (Part B, linked) → same code; name normalised ---
  const p1b = physician('김가나', 'B', { evId: p1.evId, ordinal: 2, linked: p1.sid });
  startPh(env, p1b);
  const s1b = objs(SS, 'GC_Sessions').find(x => x.SessionId === p1b.sid);
  eq('continuation: same code (whitespace-insensitive name)', s1b.EvaluatorCode, 'G001');
  eq('continuation: SessionOrdinal 2', s1b.SessionOrdinal, 2);
  eq('continuation: LinkedSessionId', s1b.LinkedSessionId, p1.sid);
  eq('continuation: ConsentInherited', s1b.ConsentInherited, true);

  // --- test session ---
  delete props.GC_SUMMARY_DIRTY;
  const t1 = physician('테스트', 'A', { test: true });
  const rt = startPh(env, t1);
  ok('test session: random seq within range', rt.seq_index === 0 || rt.seq_index === 1);
  post(base(t1, 'gc_judgment', { judgment: Object.assign(judgment(t1, A1, 'met'), { item_id: 'P051_deepseek|C9|Q4.9-99' }) }));
  const tj = objs(SS, 'GC_Judgments').find(x => x.SessionId === t1.sid);
  eq('test session: code GT001', objs(SS, 'GC_Sessions').find(x => x.SessionId === t1.sid).EvaluatorCode, 'GT001');
  eq('test session: IsTest TRUE on judgment', tj.IsTest, true);
  eq('unknown ItemId: TargetKey derived from the id', tj.TargetKey, 'P051_deepseek|C9|P4');
  ok('test judgment does not mark the GC summary dirty', props.GC_SUMMARY_DIRTY !== '1');
  ok('test session does not advance the balanced counter', props.GC_SEQ_COUNTER_A === '3');
  // error path → logged to GC_Raw with the error, not to RawJSON
  const bad = post(base(t1, 'gc_finish', { judgments: 5 }));
  eq('error path returns ok:false', bad.ok, false);
  ok('error path logged to GC_Raw with Error', objs(SS, 'GC_Raw').some(x => x.Action === 'gc_finish' && x.SessionId === t1.sid && String(x.Error) !== ''));
  ok('error path: no RawJSON sheet', !SS.getSheetByName('RawJSON'));

  // --- CA payloads are not accepted by the GC project (CA keeps its own project and spreadsheet) ---
  const caSid = uuid();
  const caBase = (action, extra) => Object.assign({ action, msg_id: uuid(), client_time: iso(0), study_id: 'T2D-CA-2026', app_version: '2026-11-19.ca-v3.3',
    data_version: 'd', session_id: caSid, is_test: false, evaluator: { name: '홍길동', role: 'resident' }, study_type: 'A', n_sequences: 2 }, extra || {});
  const nRaw = objs(SS, 'GC_Raw').length;
  eq('CA start rejected', post(caBase('start', { device: DEVICE })).error, 'bad request');
  eq('CA case rejected', post(caBase('case', { case: { case_key: 'P051_deepseek' } })).error, 'bad request');
  eq('CA start with GC study id still rejected', post(caBase('start', { study_id: 'T2D-GC-2026' })).error, 'bad request');
  ok('CA payloads write nothing', !objs(SS, 'GC_Sessions').some(x => x.SessionId === caSid) && objs(SS, 'GC_Raw').length === nRaw &&
    !SS.getSheetByName('Sessions'));
  ok('CA summary flags untouched', props.SUMMARY_DIRTY === undefined && !Object.keys(props).some(k => /^(SEQ_COUNTER|EV[CT]_)/.test(k)));
})();

// =====================================================================
// 3) Adjudication + summary with synthetic multi-physician judgments
// =====================================================================
(function adjudication() {
  const env = makeEnv();
  const { post, SS, props, ctx } = env;
  // item aliases (see docs/GC_CONTRACT.md data; finals in comments)
  const a = {
    a1: 'P051_deepseek|C1|Q2.2-04',  // ✗ final deducted (rater met)
    a2: 'P051_deepseek|C2|Q3.4-09',  // △ met
    a4: 'P051_deepseek|C1|Q3.8-15',  // ✗ met (rater deducted)
    a5: 'P051_deepseek|C1|Q4.2-11',  // ✗ met
    a7: 'P051_deepseek|C1|Q5.4-01',  // ✗ met
    a8: 'P051_deepseek|C1|Q5.4-10',  // △ deducted
    b3: 'P011_gpt|C3|Q3.1-03',       // ✗ deducted (rater met)
    c1: 'P011_deepseek|C1|Q2.2-04',  // △ met
    c2: 'P011_deepseek|C1|Q3.2-05',  // △ met
    c3: 'P011_deepseek|C3|Q4.2-03',  // ✗ met
    c4: 'P011_deepseek|C1|Q4.2-11',  // ✗ met
    c7: 'P011_deepseek|C3|Q4.2-17',  // ✗ met
    d1: 'P051_gpt|C3|Q2.1-02',       // ✗ met (rater deducted)
    d2: 'P051_gpt|C2|Q5.3-03',       // △ met
    d3: 'P051_gpt|C3|Q5.3-03'        // △ met
  };
  const NA = 'not_applicable';
  const PROFILE = [
    // ai_freq: G1 거의 매일, G2 주 3–6회, G3 거의 매일, G4 사용한 적 없음, G5 주 1회 미만, G6 주 1–2회 (→ [2], [4-3])
    { board_years: ['5–9년', 2], setting: ['상급종합병원', 1], ai_freq: ['거의 매일', 5] },
    { board_years: ['10–19년', 3], setting: ['종합병원', 2], ai_freq: ['주 3–6회', 4] },
    { board_years: ['10–19년', 3], setting: ['상급종합병원', 1], ai_freq: ['거의 매일', 5] },
    { board_years: ['20년 이상', 4], setting: ['병원·의원', 3], ai_freq: ['사용한 적 없음', 1] },
    { board_years: ['5년 미만', 1], setting: ['상급종합병원', 1], ai_freq: ['주 1회 미만', 2] },
    { board_years: ['10–19년', 3], setting: ['상급종합병원', 1], ai_freq: ['주 1–2회', 3] }
  ];
  const mk = (name, part, i, extra) => {
    const pr = PROFILE[i];
    const f = {}, c = {};
    Object.keys(pr).forEach(k => { f[k] = pr[k][0]; c[k] = pr[k][1]; });
    return physician(name, part, Object.assign({ fields: f, codes: c }, extra || {}));
  };
  const G1 = mk('일번', 'A', 0), G2 = mk('이번', 'A', 1), G3 = mk('삼번', 'A', 2), G4 = mk('사번', 'B', 3), G5 = mk('오번', 'B', 4), G6 = mk('육번', 'B', 5);
  const plan = (ph, ids, over, ms, comments) => ids.map((id, i) => judgment(ph, id, over[id] !== undefined ? over[id] : ITEM[id].final,
    { item_order: i + 1, at: iso((i + 1) * 60e3), ms, comment: (comments || {})[id] || '' }));
  const finish = (ph, js, ends) => post(base(ph, 'gc_finish', { judgments: js, end_items: endItems(ends[0], ends[1]), overall_comment: '',
    session: { started_at: iso(0), finished_at: iso(30 * 60e3), total_active_ms: 20 * 60e3, total_wall_ms: 25 * 60e3, resumes: 0, send_failures: 0 }, device: DEVICE }));
  const partA = partItems('A'), partB = partItems('B');

  // views: 3 GC (2 devices) + 1 GC test + 1 CA (rejected by this project)
  const view = (study, app, dev, test) => post({ action: 'view', msg_id: uuid(), client_time: iso(0), study_id: study, app_version: app, is_test: !!test,
    visit_id: uuid(), device_id: dev, entry: { src: 'qr' }, form_factor: 'mobile' });
  view('T2D-GC-2026', GC_CONFIG.APP_VERSION, 'dev-g1'); view('T2D-GC-2026', GC_CONFIG.APP_VERSION, 'dev-g1'); view('T2D-GC-2026', GC_CONFIG.APP_VERSION, 'dev-g2');
  view('T2D-GC-2026', GC_CONFIG.APP_VERSION, 'dev-gt', true); view('T2D-CA-2026', '2026-11-19.ca-v3.3', 'dev-c1');

  [G1, G2, G3, G4, G5, G6].forEach(ph => startPh(env, ph));
  finish(G1, plan(G1, partA, { [a.a1]: 'met', [a.a4]: 'deducted', [a.a5]: NA, [a.a8]: NA, [a.b3]: 'met' }, 30000, { [a.a1]: '환자 기록 확인' }), [3, 4]);
  finish(G2, plan(G2, partA, { [a.a1]: 'met', [a.a4]: 'deducted', [a.a5]: NA, [a.a7]: 'deducted', [a.a8]: NA, [a.b3]: 'met' }, 40000, { [a.a7]: '=근거 부족' }), [4, 4]);
  finish(G3, plan(G3, partA, { [a.a1]: 'met', [a.a5]: 'deducted', [a.a7]: NA, [a.a8]: NA }, 50000, { [a.a1]: '동의' }), [2, 5]);
  finish(G4, plan(G4, partB.filter(id => id !== a.c2), { [a.c1]: 'deducted', [a.c3]: 'deducted', [a.c4]: 'deducted', [a.c7]: NA, [a.d1]: 'deducted' }, 20000), [4, 5]);
  plan(G5, partB.filter(id => id !== a.c1 && id !== a.c2), { [a.c3]: 'deducted', [a.c4]: 'deducted', [a.c7]: NA }, 60000)
    .forEach(j => post(base(G5, 'gc_judgment', { judgment: j })));
  plan(G6, [a.d2, a.d3], { [a.d3]: 'deducted' }, 10000).forEach(j => post(base(G6, 'gc_judgment', { judgment: j })));
  // G1 again (second Part A attempt, later): changes a2 → latest wins for G001
  const G1b = mk('일번', 'A', 0, { ordinal: 1 });
  startPh(env, G1b);
  post(base(G1b, 'gc_judgment', { judgment: judgment(G1b, a.a2, 'deducted', { at: iso(5 * 3600e3), ms: 30000 }) }));
  // test physician: excluded unless includeTests
  const T = mk('테스트', 'B', 0, { test: true });
  startPh(env, T);
  post(base(T, 'gc_judgment', { judgment: judgment(T, a.c2, 'deducted') }));
  eq('codes G001–G006 + GT001', objs(SS, 'GC_Sessions').map(r => r.EvaluatorCode).join(','), 'G001,G002,G003,G004,G005,G006,G001,GT001');
  eq('GC_SUMMARY_DIRTY set', props.GC_SUMMARY_DIRTY, '1');

  let res;
  try { res = ctx.buildGcSummary(false); ok('buildGcSummary(false) runs', true); }
  catch (e) { ok('buildGcSummary(false) runs', false, e.stack); return; }
  ok('GC_SUMMARY_DIRTY cleared', props.GC_SUMMARY_DIRTY !== '1');
  ok('buildGcSummary does not touch CA flags', props.SUMMARY_DIRTY === undefined);
  ok('GC_SUMMARY_BUILT_AT recorded', /^\d{4}-/.test(props.GC_SUMMARY_BUILT_AT || ''));
  eq('result: physicians', res.physicians, 6);
  eq('result: counted judgments', res.judgments, 75);

  // --- GC_Adjudication ---
  const ADJ = read(SS, 'GC_Adjudication');
  eq('GC_Adjudication header = contract', JSON.stringify(ADJ[0]), JSON.stringify(H_ADJ));
  eq('GC_Adjudication one row per flagged item', ADJ.length - 1, 29);
  const A = id => { const o = objs(SS, 'GC_Adjudication').find(x => x.ItemId === id); return o || {}; };
  const st = id => A(id).Status + ' → ' + A(id).Adjudicated;
  eq('a1 unanimous met (AI final deducted)', st(a.a1), '확정(만장일치) → met');
  eq('a2 latest-wins per physician → majority met', st(a.a2), '확정(다수결) → met');
  eq('a2 N counts each physician once', A(a.a2).N, 3);
  eq('a2 AgreeN', A(a.a2).AgreeN, 2);
  eq('a4 majority deducted', st(a.a4), '확정(다수결) → deducted');
  eq('a5 majority not_applicable', st(a.a5), '확정(다수결) → not_applicable');
  eq('a7 1/1/1 → further review, AI final kept', st(a.a7), '추가 검토 필요 → met');
  eq('a8 unanimous not_applicable', st(a.a8), '확정(만장일치) → not_applicable');
  eq('b3 majority met', st(a.b3), '확정(다수결) → met');
  eq('c1 single physician → provisional', st(a.c1), '잠정(1인) → deducted');
  eq('c2 no physician (test excluded) → pending, AI final kept', st(a.c2), '대기 → met');
  eq('c2 N = 0', A(a.c2).N, 0);
  eq('c3 n=2 unanimous deducted', st(a.c3), '확정(만장일치) → deducted');
  eq('c7 unanimous not_applicable', st(a.c7), '확정(만장일치) → not_applicable');
  eq('d1 n=2 split → further review', st(a.d1), '추가 검토 필요 → met');
  eq('d2 n=3 unanimous', st(a.d2), '확정(만장일치) → met');
  eq('d3 2:1 majority met', st(a.d3), '확정(다수결) → met');
  eq('a5 counts', [A(a.a5).Met, A(a.a5).Deducted, A(a.a5).NotApplicable].join('/'), '0/1/2');
  eq('Comments joined with codes', A(a.a1).Comments, 'G001: 환자 기록 확인 / G003: 동의');
  eq('formula-like comment guarded in GC_Adjudication', rawCell(SS, 'GC_Adjudication', (r, h) => r[h.indexOf('ItemId')] === a.a7, 'Comments'), "'G002: =근거 부족");
  const statusCount = s => objs(SS, 'GC_Adjudication').filter(x => x.Status === s).length;
  eq('status totals 20/5/1/2/1', ['확정(만장일치)', '확정(다수결)', '잠정(1인)', '추가 검토 필요', '대기'].map(statusCount).join('/'), '20/5/1/2/1');

  // --- GC_Concordance (hand-computed) ---
  const CONC = read(SS, 'GC_Concordance');
  eq('GC_Concordance header = contract', JSON.stringify(CONC[0]), JSON.stringify(H_CONC));
  eq('GC_Concordance one row per TargetKey (4 × 13)', CONC.length - 1, 52);
  const C = k => objs(SS, 'GC_Concordance').find(x => x.TargetKey === k) || {};
  const cc = k => [C(k).N_AI, C(k).Met_Raw, C(k).Met_AI, C(k).N_Adj, C(k).Met_Adj, C(k).ConcordanceScore].join(' ');
  eq('P051_deepseek|C1|P2: a1 deducted→met (+1)', cc('P051_deepseek|C1|P2'), '7 5 4 7 5 0.7143');
  eq('P051_deepseek|C1|P2 Score_Raw / Score_AI', C('P051_deepseek|C1|P2').Score_Raw + ' ' + C('P051_deepseek|C1|P2').Score_AI, '0.7143 0.5714');
  eq('P051_deepseek|C1|P3: a4 met→deducted (−1)', cc('P051_deepseek|C1|P3'), '25 22 23 25 22 0.88');
  eq('P051_deepseek|C1|P4: a5 met→n/a (n−1, met−1)', cc('P051_deepseek|C1|P4'), '16 13 14 15 13 0.8667');
  eq('P051_deepseek|C1|P5: a8 deducted→n/a (n−1), a7 kept', cc('P051_deepseek|C1|P5'), '18 8 9 17 9 0.5294');
  eq('P051_deepseek|C1|P5 flagged/adjudicated/pending', [C('P051_deepseek|C1|P5').FlaggedItems, C('P051_deepseek|C1|P5').Adjudicated, C('P051_deepseek|C1|P5').Pending].join('/'), '2/1/1');
  eq('P051_deepseek|C2|P3: no change', cc('P051_deepseek|C2|P3'), '27 25 25 27 25 0.9259');
  eq('P011_gpt|C3|P3: b3 deducted→met (+1)', cc('P011_gpt|C3|P3'), '17 16 14 17 15 0.8824');
  eq('P011_deepseek|C1|P2: provisional c1 applied', cc('P011_deepseek|C1|P2'), '7 7 7 7 6 0.8571');
  eq('P011_deepseek|C1|P3: pending c2 keeps AI score', cc('P011_deepseek|C1|P3'), '17 16 16 17 16 0.9412');
  eq('P011_deepseek|C1|P3 pending count', C('P011_deepseek|C1|P3').Pending, 1);
  eq('P011_deepseek|C1|P4: c4 met→deducted', cc('P011_deepseek|C1|P4'), '19 17 18 19 17 0.8947');
  eq('P011_deepseek|C3|P4: c3 deducted, c7 n/a', cc('P011_deepseek|C3|P4'), '18 14 17 17 15 0.8824');
  eq('P051_gpt|C3|P2: d1 under review keeps AI', cc('P051_gpt|C3|P2'), '7 5 6 7 6 0.8571');
  eq('P051_gpt|P1 (no flagged items)', cc('P051_gpt|P1') + ' ' + C('P051_gpt|P1').FlaggedItems, '2 2 2 2 2 1 0');
  eq('Phase 1 row sorted first per unit', CONC[1][0], Object.keys(GC_DATA.units)[0] + '|P1');

  // --- GC_Summary ---
  const S = read(SS, 'GC_Summary');
  ok('GC_Summary has sections [0]–[8]', Array.from({ length: 9 }, (_, i) => i).every(i => S.some(r => String(r[0]).startsWith('[' + i + ']'))));
  const names = [G1, G2, G3, G4, G5, G6, T].map(p => p.name);
  ok('no physician names in GC_Summary / GC_Adjudication / GC_Concordance', ['GC_Summary', 'GC_Adjudication', 'GC_Concordance']
    .every(n => !read(SS, n).some(r => r.some(v => names.indexOf(String(v)) >= 0))));
  const s1 = section(S, 1);
  const tot = row(s1, r => r[0] === '전체');
  eq('[1] GC visits (test + CA excluded)', tot[1], 3);
  eq('[1] GC visiting devices', tot[2], 2);
  eq('[1] sessions started', tot[3], 7);
  eq('[1] in progress', tot[5], 3);
  eq('[1] completed', tot[6], 4);
  eq('[1] completion rate 4/7', tot[8], 0.571);
  eq('[1] Part A sessions', row(s1, r => r[0] === 'Part A')[3], 4);
  eq('[1] physicians', row(s1, r => String(r[0]).startsWith('참여 전문의'))[1], 6);
  const s2 = section(S, 2);
  eq('[2] board_years 10–19년 n (G002, G003, G006)', row(s2, r => r[1] === '10–19년')[2], 3);
  eq('[2] board_years 10–19년 %', row(s2, r => r[1] === '10–19년')[3], 50);
  eq('[2] setting 상급종합병원 n', row(s2, r => r[1] === '상급종합병원')[2], 4);
  eq('[2] ai_freq 거의 매일 n / % (G001, G003)', row(s2, r => r[1] === '거의 매일').slice(2, 4).join('/'), '2/33.3');
  ok('[2] ai_freq listed in GC_OPT order', ['사용한 적 없음', '주 1회 미만', '주 1–2회', '주 3–6회', '거의 매일']
    .map(l => s2.findIndex(r => r[1] === l)).every((v, i, a) => v > 0 && (i === 0 || v > a[i - 1])));
  ok('[2] no t2d_volume row', !s2.some(r => /t2d_volume|진료량/.test(String(r[0]))));
  const s3 = section(S, 3);
  eq('[3] status table: 확정(만장일치) total', row(s3, r => r[0] === '확정(만장일치)')[1], 20);
  eq('[3] status table: changed among decided', row(s3, r => r[0] === '합계')[6], 9);
  const s4 = section(S, 4);
  const all = row(s4, r => r[0] === '전체' && r[2] === 75);
  const wa = wilson(50, 75), wr = wilson(36, 75);
  eq('[4] agree with AI final 50/75', all[3], 50); eq('[4] rate', all[4], 0.667);
  eq('[4] Wilson low', all[5], r3(wa[0])); eq('[4] Wilson high', all[6], r3(wa[1]));
  eq('[4] agree with raw Rater 36/75', all[7], 36); eq('[4] rater rate', all[8], 0.48);
  eq('[4] rater Wilson low', all[9], r3(wr[0])); eq('[4] rater Wilson high', all[10], r3(wr[1]));
  const maj = row(s4, r => r[0] === '감사 표시' && String(r[1]).startsWith('✗'));
  eq('[4] ✗ judgments / agree final / agree rater', [maj[2], maj[3], maj[7]].join('/'), '47/28/14');
  const min = row(s4, r => r[0] === '감사 표시' && String(r[1]).startsWith('△'));
  eq('[4] △ judgments / agree final / agree rater (equal: no correction)', [min[2], min[3], min[7]].join('/'), '28/22/22');
  // audit marks are named as on the item screen (gc/gc.js MARK): ✗ 판정 보정 / △ 근거 보완
  eq('[4] audit mark labels match the screen', [maj[1], min[1]].join(' | '), '✗ (판정 보정) | △ (근거 보완)');
  ok('summary uses no old mark names (판정 수정 / 경미한 지적)', !S.some(r => r.some(c => /판정 수정|경미한 지적/.test(String(c)))));
  const it = row(s4, r => r[0] === '전체' && r[1] === 26);
  eq('[4-2] decided items equal to AI final 17/26', it[2] + '/' + it[3], '17/0.654');
  // [4-3] AI 사용 빈도별 AI 최종 동의율. Hand count (latest per physician, final = ITEM.final):
  //   G001 Part A 18 − 6 disagree (a1, a4, a5, a8, b3 + a2 changed later) = 12; G002 18 − 6 = 12; G003 18 − 4 = 14;
  //   G004 10 − 5 = 5; G005 9 − 3 = 6; G006 2 − 1 = 1  → 거의 매일 = G001 + G003 = 26/36
  const i43 = s4.findIndex(r => String(r[0]).startsWith('[4-3]'));
  ok('[4-3] AI use frequency table present inside [4]', i43 > 0);
  const f43 = s4.slice(i43);
  const fr = l => row(f43, r => r[0] === l);
  const frs = l => fr(l).slice(1, 6).join('/');
  eq('[4-3] header', JSON.stringify(f43[1].slice(0, 8)), JSON.stringify(['AI 사용 빈도 (ai_freq)', '코드', '전문의 n', '판정 n', 'AI 최종 동의 n', 'AI 최종 동의율', '95% CI 하한', '95% CI 상한']));
  eq('[4-3] 사용한 적 없음 code/phys/n/agree/rate', frs('사용한 적 없음'), '1/1/10/5/0.5');
  eq('[4-3] 주 1회 미만', frs('주 1회 미만'), '2/1/9/6/' + r3(6 / 9));
  eq('[4-3] 주 1–2회', frs('주 1–2회'), '3/1/2/1/0.5');
  eq('[4-3] 주 3–6회', frs('주 3–6회'), '4/1/18/12/' + r3(12 / 18));
  eq('[4-3] 거의 매일 (2 physicians)', frs('거의 매일'), '5/2/36/26/' + r3(26 / 36));
  const w43 = wilson(26, 36);
  eq('[4-3] 거의 매일 Wilson CI', fr('거의 매일').slice(6, 8).join('/'), r3(w43[0]) + '/' + r3(w43[1]));
  eq('[4-3] 전체 = [4] 전체', fr('전체').slice(2, 6).join('/'), '6/75/50/' + r3(50 / 75));
  ok('[4-3] no (미응답) row when every physician answered', !f43.some(r => String(r[0]).startsWith('(미응답')));
  const s5 = section(S, 5);
  const pa = row(s5, r => r[0] === 'Part A'), pb = row(s5, r => r[0] === 'Part B'), pt = row(s5, r => r[0] === '전체');
  eq('[5] Part A percent agreement = 43/54', pa[4], r3(43 / 54));
  eq('[5] Part A Fleiss kappa = 684/1278', pa[6], r3(684 / 1278));
  eq('[5] Part A raters per item', pa[3], '3');
  eq('[5] Part A unanimous ratio 13/18', pa[5], r3(13 / 18));
  eq('[5] Part B percent agreement = (22/3)/9', pb[4], r3(22 / 27));
  eq('[5] Part B kappa not computed (unequal n)', pb[6], '');
  eq('[5] overall percent agreement = 65/81', pt[4], r3(65 / 81));
  const s6 = section(S, 6);
  const sc = (u, scope) => row(s6, r => r[0] === u && r[2] === scope);
  const p25 = sc('P051_deepseek', 'Phase 2–5');
  eq('[6] P051_deepseek Phase 2–5 N/raw/AI', [p25[3], p25[4], p25[6]].join('/'), '204/150/153');
  eq('[6] P051_deepseek Phase 2–5 scores raw → AI → adjudicated', [p25[5], p25[7], p25[10]].join(' → '), [r4(150 / 204), r4(153 / 204), r4(152 / 202)].join(' → '));
  eq('[6] P051_deepseek Phase 2–5 N_adj/Met_adj', p25[8] + '/' + p25[9], '202/152');
  const c1 = sc('P051_deepseek', '조합 1 (Phase 2–5)');
  eq('[6] P051_deepseek combo 1 adjusted 49/64', [c1[3], c1[6], c1[8], c1[9], c1[10]].join('/'), ['66', '50', '64', '49', r4(49 / 64)].join('/'));
  eq('[6] P051_deepseek Phase 1', [sc('P051_deepseek', 'Phase 1')[3], sc('P051_deepseek', 'Phase 1')[10]].join('/'), '2/1');
  const s7 = section(S, 7);
  const tm = row(s7, r => String(r[0]).startsWith('판정 화면 표시 시간') && r[1] === '전체');
  eq('[7] item time n (all non-test judgment rows)', tm[2], 76);
  eq('[7] item time median / Q1 / Q3', [tm[3], tm[4], tm[5]].join('/'), '40/30/50');
  const s8 = section(S, 8);
  const e1 = row(s8, r => r[0] === 'info_sufficient'), e2 = row(s8, r => r[0] === 'hitl_acceptable');
  eq('[8] info_sufficient n / dist / ≥4 rate / median', [e1[2], e1.slice(3, 8).join(''), e1[8], e1[9]].join(' '), '4 01120 0.5 3.5');
  eq('[8] hitl_acceptable ≥4 rate / median', [e2[8], e2[9]].join(' '), '1 4.5');

  if (DUMP) {
    fs.mkdirSync(DUMP, { recursive: true });
    ['GC_Summary', 'GC_Adjudication', 'GC_Concordance', 'GC_Sessions', 'GC_Judgments'].forEach(n => fs.writeFileSync(path.join(DUMP, n + '.tsv'),
      read(SS, n).map(r => r.map(v => (v instanceof Date ? v.toISOString() : String(v))).join('\t').replace(/\t+$/, '')).join('\n') + '\n'));
    console.log('dumped GC sheets as TSV to ' + DUMP);
  }

  // --- includeTests ---
  ctx.buildGcSummaryIncludingTests();
  eq('includeTests: c2 provisional from the test judgment', objs(SS, 'GC_Adjudication').find(x => x.ItemId === a.c2).Status, '잠정(1인)');
  ctx.buildGcSummary(false);
  eq('rebuild without tests: c2 pending again', objs(SS, 'GC_Adjudication').find(x => x.ItemId === a.c2).Status, '대기');

  // --- GC_Codebook (the GC spreadsheet's own codebook) ---
  const CB = read(SS, 'GC_Codebook');
  eq('GC_Codebook header', JSON.stringify(CB[0]), JSON.stringify(['Sheet', 'Column', 'Description', 'Type / values', 'InSheet']));
  ok('GC_Codebook lists every GC sheet', ['Visits', 'GC_Sessions', 'GC_Judgments', 'GC_Raw', 'GC_Adjudication', 'GC_Concordance'].every(n => CB.some(r => r[0] === n)));
  ok('GC_Codebook: every contract column of GC_Sessions / GC_Judgments listed and present', H_GC_SESS.every(c => CB.some(r => r[0] === 'GC_Sessions' && r[1] === c && r[4] === 'Y')) &&
    H_GC_JUDG.every(c => CB.some(r => r[0] === 'GC_Judgments' && r[1] === c && r[4] === 'Y')));
  ok('GC_Codebook: dynamic Eval_* / End_* columns listed', ['Eval_board_years', 'Eval_board_years_code', 'End_info_sufficient', 'End_hitl_acceptable_code']
    .every(c => CB.some(r => r[0] === 'GC_Sessions' && r[1] === c && r[4] === 'Y')));
  eq('GC_Codebook: Eval_ai_freq documents codes 1–5', (CB.find(r => r[0] === 'GC_Sessions' && r[1] === 'Eval_ai_freq') || [])[3],
    '1 사용한 적 없음, 2 주 1회 미만, 3 주 1–2회, 4 주 3–6회, 5 거의 매일');
  ok('GC_Codebook: Eval_ai_freq_code listed', CB.some(r => r[0] === 'GC_Sessions' && r[1] === 'Eval_ai_freq_code' && r[4] === 'Y'));
  ok('GC_Codebook: no t2d_volume definition', !CB.some(r => /t2d_volume/.test(String(r[1]))));
  eq('GC_Codebook: AuditMark names as on screen', (CB.find(r => r[1] === 'AuditMark') || [])[3], 'major = ✗ 판정 보정 / minor = △ 근거 보완');
  eq('GC_Codebook: End_ item code described', (CB.find(r => r[0] === 'GC_Sessions' && r[1] === 'End_hitl_acceptable_code') || [])[3], '정수 (선택지 순서, 1부터)');
  eq('GC_Codebook: Visits.TypeParam = ?part', (CB.find(r => r[0] === 'Visits' && r[1] === 'TypeParam') || [])[2], '링크로 미리 지정된 Part (?part=)');
  ok('GC_Codebook descriptions are filled', CB.slice(1).every(r => String(r[2]).length > 0 && String(r[2]).indexOf('설명 없음') < 0),
    CB.filter(r => String(r[2]).indexOf('설명 없음') >= 0).map(r => r[0] + '.' + r[1]).join(', '));
  ok('no CA sheets written by the GC summary', ['Summary', 'AnalysisLong', 'Codebook', 'Concordance'].every(n => !SS.getSheetByName(n)));

  // --- 10-minute trigger (refreshGcSummaryIfDirty) ---
  post(base(G6, 'gc_judgment', { judgment: judgment(G6, a.d2, 'deducted', { at: iso(9 * 3600e3) }) }));
  eq('new GC judgment marks GC dirty', props.GC_SUMMARY_DIRTY, '1');
  env.lock.busy = true;
  eq('refreshGcSummaryIfDirty skips when lock busy', ctx.refreshGcSummaryIfDirty(), false);
  eq('GC dirty flag kept when skipped', props.GC_SUMMARY_DIRTY, '1');
  env.lock.busy = false;
  eq('refreshGcSummaryIfDirty runs when dirty', ctx.refreshGcSummaryIfDirty(), true);
  ok('GC dirty cleared', props.GC_SUMMARY_DIRTY !== '1');
  eq('refresh picked up the new judgment (d2 now 2:1)', objs(SS, 'GC_Adjudication').find(x => x.ItemId === a.d2).Status, '확정(다수결)');
  eq('refreshGcSummaryIfDirty no-op when clean', ctx.refreshGcSummaryIfDirty(), false);
  ctx.ensureGcSummaryTrigger_();
  eq('still exactly one trigger', env.triggers.filter(t => t.getHandlerFunction() === 'refreshGcSummaryIfDirty').length, 1);
  eq('no CA trigger in the GC project', env.triggers.filter(t => t.getHandlerFunction() === 'refreshSummaryIfDirty').length, 0);
  eq('showGcCounter lists the Part counters', ctx.showGcCounter(), 'GC_SEQ_COUNTER_A=4, GC_SEQ_COUNTER_B=3');
})();

// =====================================================================
// 3b) Review fixes: lock flush, server-side Agree + ClientMismatch, finish timing, same name, pilot, plurality,
//     CA spreadsheet guard, setup message when the trigger fails
// =====================================================================
(function reviewFixes() {
  const partB = GC_CONFIG.PARTS.find(p => p.id === 'B').sequences[0];
  const bItems = partB.reduce((a, k) => a.concat(GC_DATA.units[k].items), []);
  const metB = bItems.find(it => it.final === 'met').id;
  const sumRow = (SS, prefix) => read(SS, 'GC_Summary').find(r => String(r[0]).indexOf(prefix) === 0) || [];

  // --- lock: SpreadsheetApp.flush() while the lock is still held, before every release ---
  {
    const env = makeEnv();
    const ph = physician('잠금 확인', 'B');
    startPh(env, ph);
    env.post(base(ph, 'gc_judgment', { judgment: judgment(ph, metB, 'met', { at: iso(60e3) }) }));
    env.post({ action: 'view', study_id: 'T2D-GC-2026', visit_id: uuid(), device_id: 'd', entry: { src: 'qr' }, is_test: false });
    env.props.GC_SUMMARY_DIRTY = '1';
    env.ctx.refreshGcSummaryIfDirty();
    ok('flush before each lock release (doPost, view, refresh)', env.lock.flushHeld >= 4 && env.lock.flushFree === 0 && env.lock.released === env.lock.acquired,
      JSON.stringify(env.lock));
  }

  // --- Agree computed on the server; data_version / ai_final / agree mismatches recorded and counted ---
  {
    const env = makeEnv();
    const ph = physician('버전 불일치', 'B');
    startPh(env, ph);
    const j = judgment(ph, metB, 'deducted', { at: iso(60e3), ai_final: 'deducted' });
    j.agree = true;   // the (stale) site showed 'deducted' as the AI final and the physician agreed
    eq('mismatched payload still accepted', env.post(base(ph, 'gc_judgment', { data_version: 'OLD-0', judgment: j })).ok, true);
    const row = objs(env.SS, 'GC_Judgments').find(x => x.ItemId === metB);
    eq('Agree = (PhysVerdict = server AIFinal)', row.Agree, false);
    eq('AIFinal from server GC_ITEMS', row.AIFinal, 'met');
    eq('AgreeWithAIFinal consistent with Agree', row.AgreeWithAIFinal, false);
    eq('ClientMismatch lists data_version, ai_final and agree',
      row.ClientMismatch, 'data_version OLD-0 ≠ ' + GC_DATA.data_version + '; ai_final deducted ≠ met; agree(사이트) true');
    const sess = objs(env.SS, 'GC_Sessions').find(x => x.SessionId === ph.sid);
    eq('session AgreeN/DisagreeN use the server Agree', sess.AgreeN + '/' + sess.DisagreeN, '0/1');
    env.ctx.buildGcSummary(false);
    eq('GC_Summary [0] counts ClientMismatch rows', sumRow(env.SS, '사이트 자료가 서버와 어긋난')[1], 1);
  }

  // --- gc_finish copy with the same verdict: later viewing time and opened panels are kept ---
  {
    const env = makeEnv();
    const ph = physician('다시 보기', 'B');
    startPh(env, ph);
    const closed = { criterion: false, full_answer: false, basis: false, patient: false };
    env.post(base(ph, 'gc_judgment', { judgment: judgment(ph, metB, 'met', { at: iso(60e3), ms: 10000, active: 8000, opened: closed }) }));
    const upd0 = objs(env.SS, 'GC_Judgments').find(x => x.ItemId === metB).ServerUpdatedAt;
    const fin = judgment(ph, metB, 'met', { at: iso(60e3), ms: 45000, active: 30000, changes: 1,
      opened: { criterion: true, full_answer: true, basis: true, patient: true } });
    env.post(base(ph, 'gc_finish', { judgments: [fin], end_items: endItems(4, 4), overall_comment: '',
      session: { started_at: iso(0), finished_at: iso(600e3), total_active_ms: 60000, total_wall_ms: 600000, resumes: 0, send_failures: 0 }, device: DEVICE }));
    const r = objs(env.SS, 'GC_Judgments').find(x => x.ItemId === metB);
    eq('finish copy: ItemSec updated to the session total', r.ItemSec, 45);
    eq('finish copy: ActiveSec updated', r.ActiveSec, 30);
    eq('finish copy: Changes updated', r.Changes, 1);
    ok('finish copy: Opened* = opened at least once', r.OpenedCriterion === true && r.OpenedFullAnswer === true && r.OpenedBasis === true && r.OpenedPatient === true);
    ok('finish copy: verdict row not rewritten (ServerUpdatedAt kept)', r.ServerUpdatedAt === upd0);
    // an older finish copy never lowers the numbers
    env.post(base(ph, 'gc_finish', { judgments: [judgment(ph, metB, 'met', { at: iso(60e3), ms: 20000, active: 1000, opened: closed })],
      end_items: endItems(4, 4), session: { started_at: iso(0), finished_at: iso(600e3) }, device: DEVICE }));
    const r2 = objs(env.SS, 'GC_Judgments').find(x => x.ItemId === metB);
    eq('finish copy: smaller values do not overwrite', r2.ItemSec + '/' + r2.OpenedBasis, '45/true');
  }

  // --- same name: different profiles → separate physicians; same profile + same item on two devices → flagged, merged ---
  {
    const env = makeEnv();
    const x = physician('김민수', 'B', { dev: 'dev-x', fields: { board_years: '5년 미만', setting: '종합병원', ai_freq: '사용한 적 없음' },
      codes: { board_years: 1, setting: 2, ai_freq: 1 } });
    const y = physician('김 민수', 'B', { dev: 'dev-y' });
    const z1 = physician('박영희', 'B', { dev: 'dev-z1' });
    const z2 = physician('박영희', 'B', { dev: 'dev-z2' });
    [x, y, z1, z2].forEach(ph => startPh(env, ph));
    env.post(base(x, 'gc_judgment', { judgment: judgment(x, metB, 'deducted', { at: iso(60e3), comment: '감점이 맞음' }) }));
    env.post(base(y, 'gc_judgment', { judgment: judgment(y, metB, 'met', { at: iso(70e3) }) }));
    env.post(base(z1, 'gc_judgment', { judgment: judgment(z1, metB, 'deducted', { at: iso(80e3) }) }));
    env.post(base(z2, 'gc_judgment', { judgment: judgment(z2, metB, 'met', { at: iso(90e3) }) }));
    const J = objs(env.SS, 'GC_Judgments');
    eq('same normalised name → same EvaluatorCode on the rows', J.filter(r => r.EvaluatorCode === J[0].EvaluatorCode).length, 2);
    env.ctx.buildGcSummary(false);
    const a = objs(env.SS, 'GC_Adjudication').find(r => r.ItemId === metB);
    eq('different profiles counted as two physicians (+ the same-profile pair as one)', a.N, 3);
    eq('votes: met 2 (y, z2 latest), deducted 1 (x)', a.Met + '/' + a.Deducted, '2/1');
    ok('split codes shown as G001-1 in comments', /G001-1: 감점이 맞음/.test(String(a.Comments)), a.Comments);
    const f = sumRow(env.SS, '동명이인 의심');
    eq('GC_Summary [0] 동명이인 의심 = 2 codes', f[1], 2);
    ok('GC_Summary [0] says which code was split and which was merged', /G001: 기기 2개, 전문의 정보\(Eval_\*\)가 서로 다름 → 따로 집계/.test(String(f[2])) &&
      /G002: 기기 2개, 전문의 정보는 같고 같은 판정을 다른 기기에서 다시 함 → 1명으로 집계/.test(String(f[2])), f[2]);
    eq('participating physicians = 3', sumRow(env.SS, '참여 전문의 수')[1], 3);
  }

  // --- normal cross-device continuation (same name, same profile, other Part) is not flagged ---
  {
    const env = makeEnv();
    const a1 = physician('이수진', 'A', { dev: 'phone' });
    const b1 = physician('이수진', 'B', { dev: 'pc' });
    startPh(env, a1); startPh(env, b1);
    env.post(base(a1, 'gc_judgment', { judgment: judgment(a1, partItems('A')[0], 'met', { at: iso(60e3) }) }));
    env.post(base(b1, 'gc_judgment', { judgment: judgment(b1, metB, 'met', { at: iso(70e3) }) }));
    env.ctx.buildGcSummary(false);
    eq('Part A on phone + Part B on PC: one physician', sumRow(env.SS, '참여 전문의 수')[1], 1);
    eq('…and not flagged as 동명이인', sumRow(env.SS, '동명이인 의심')[1], 0);
  }

  // --- pilot sessions (?wave=pilot): in the participation flow only ---
  {
    const env = makeEnv();
    const pl = physician('파일럿', 'B');
    const mn = physician('본조사', 'B');
    const pilotEntry = { entry: { src: 'qr', site: '', wave: 'pilot', part_preselected: false, in_app: '', referrer_origin: '' } };
    env.post(base(pl, 'gc_start', Object.assign({ device: DEVICE }, pilotEntry)));
    env.post(base(pl, 'gc_judgment', Object.assign({ judgment: judgment(pl, metB, 'deducted', { at: iso(60e3) }) }, pilotEntry)));
    startPh(env, mn);
    env.post(base(mn, 'gc_judgment', { judgment: judgment(mn, metB, 'met', { at: iso(70e3) }) }));
    eq('pilot session stored with Wave=pilot', objs(env.SS, 'GC_Sessions').find(r => r.SessionId === pl.sid).Wave, 'pilot');
    env.ctx.buildGcSummary(false);
    const a = objs(env.SS, 'GC_Adjudication').find(r => r.ItemId === metB);
    eq('pilot vote not counted (N 1, met)', a.N + '/' + a.Adjudicated + '/' + a.Status, '1/met/잠정(1인)');
    eq('GC_Summary [0] pilot sessions excluded = 1', sumRow(env.SS, '제외한 파일럿 세션 수')[1], 1);
    eq('participating physicians exclude pilot-only', sumRow(env.SS, '참여 전문의 수')[1], 1);
    const flow = section(read(env.SS, 'GC_Summary'), 1).find(r => r[0] === '전체') || [];
    eq('participation flow still counts the pilot session (2 sessions)', flow[3], 2);
  }

  // --- plurality without a strict majority (n = 4: 2·1·1) → 추가 검토 필요 ---
  {
    const env = makeEnv();
    const votes = ['deducted', 'deducted', 'met', 'not_applicable'];
    votes.forEach((v, i) => {
      const ph = physician('다수' + i, 'B');
      startPh(env, ph);
      env.post(base(ph, 'gc_judgment', { judgment: judgment(ph, metB, v, { at: iso(60e3 + i) }) }));
    });
    env.ctx.buildGcSummary(false);
    const a = objs(env.SS, 'GC_Adjudication').find(r => r.ItemId === metB);
    eq('2·1·1 of 4 → 추가 검토 필요, AI final kept', a.Status + '/' + a.Adjudicated, '추가 검토 필요/met');
    ok('rule text names the no-majority case', read(env.SS, 'GC_Summary').some(r => /과반인 판정이 없으면 추가 검토 필요/.test(String(r[0])) && /2·1·1/.test(String(r[0]))));
  }

  // --- the CA response spreadsheet is never used by GC ---
  {
    // a) the stored / pasted ID points at the CA spreadsheet
    const env = makeEnv({ setup: false });
    ['Responses', 'PhaseLong', 'Sessions', 'Visits', 'RawJSON'].forEach(n => env.SS.insertSheet(n));
    const caVisits = env.SS.getSheetByName('Visits');
    env.props.GC_SPREADSHEET_ID = env.SS.getId();
    let msg = '';
    try { env.ctx.setup(); } catch (e) { msg = e.message; }
    ok('setup refuses the CA spreadsheet (ID)', /임상 수용성 평가\(CA\) 응답 시트/.test(msg) && /GC_SPREADSHEET_ID 를 비우고/.test(msg), msg);
    const r = env.post({ action: 'view', study_id: 'T2D-GC-2026', visit_id: uuid(), device_id: 'd', entry: { src: 'qr' }, is_test: false });
    eq('GC view beacon not written to the CA Visits', r.ok + '/' + caVisits.getLastRow(), 'false/0');
    const ph = physician('씨에이', 'A');
    const r2 = env.post(base(ph, 'gc_start', { device: DEVICE }));
    ok('gc_start refused against the CA spreadsheet', r2.ok === false && /CA/.test(r2.error), r2.error);
    ok('no GC sheets created in the CA spreadsheet', !env.SS.getSheetByName('GC_Sessions') && !env.SS.getSheetByName('GC_Raw'));
    eq('GC_SS_CHECKED not recorded for the CA sheet', env.props.GC_SS_CHECKED, undefined);
    // b) the GC project was made from the CA sheet (Extensions → Apps Script)
    const bnd = makeEnv({ bound: true, setup: false });
    bnd.SS.insertSheet('PhaseLong');
    let msg2 = '';
    try { bnd.ctx.setup(); } catch (e) { msg2 = e.message; }
    ok('setup refuses a project bound to the CA spreadsheet', /새 프로젝트/.test(msg2), msg2);
    eq('bound CA sheet id not stored', bnd.props.GC_SPREADSHEET_ID, undefined);
    // c) a fresh GC sheet is checked once and then remembered
    const okEnv = makeEnv();
    eq('GC sheet checked once (GC_SS_CHECKED = its id)', okEnv.props.GC_SS_CHECKED, okEnv.props.GC_SPREADSHEET_ID);
  }

  // --- setup says plainly when the summary trigger could not be created ---
  {
    const env = makeEnv({ setup: false });
    env.ctx.ScriptApp.newTrigger = () => { throw new Error('권한 없음'); };
    env.ctx.setup();
    const last = env.logs[env.logs.length - 1] || '';
    ok('setup: last log line warns when the trigger failed', /^⚠️ 응답 시트는 만들어졌지만 요약 자동 갱신이 설정되지 않았습니다/.test(last) && last.indexOf('mock://spreadsheet') >= 0, last);
    ok('setup: no ✅ ready line when the trigger failed', !env.logs.some(l => l.indexOf('✅ GC 응답 시트 준비 완료') === 0));
  }
})();

// =====================================================================
// 4) Empty spreadsheet: buildGcSummary still writes complete sheets (AI scores only)
// =====================================================================
(function empty() {
  const env = makeEnv();   // setup() only, no responses
  try { env.ctx.buildGcSummary(false); ok('empty spreadsheet: buildGcSummary runs', true); }
  catch (e) { ok('empty spreadsheet: buildGcSummary runs', false, e.stack); return; }
  eq('empty: all 29 items pending', objs(env.SS, 'GC_Adjudication').filter(x => x.Status === '대기').length, 29);
  const c = objs(env.SS, 'GC_Concordance').find(x => x.TargetKey === 'P051_deepseek|C1|P2');
  eq('empty: ConcordanceScore = AI audit score', c.ConcordanceScore, c.Score_AI);
  ok('empty: GC_Summary written', read(env.SS, 'GC_Summary').length > 30);
  const f = section(read(env.SS, 'GC_Summary'), 4);
  const i = f.findIndex(r => String(r[0]).startsWith('[4-3]'));
  ok('empty: [4-3] lists every ai_freq level with n = 0', i > 0 && ['사용한 적 없음', '주 1회 미만', '주 1–2회', '주 3–6회', '거의 매일', '전체']
    .every(l => { const r = f.slice(i).find(x => x[0] === l); return r && r[2] === 0 && r[3] === 0 && r[5] === ''; }));
})();

// =====================================================================
// 4-2) A physician without ai_freq (e.g. an older site version) → [4-3] (미응답·기타), [2] (미응답)
// =====================================================================
(function noAiFreq() {
  const env = makeEnv();
  const ph = physician('미응답', 'A', { fields: { board_years: '5–9년', setting: '종합병원' }, codes: { board_years: 2, setting: 2 } });
  startPh(env, ph);
  const id = partItems('A')[0];
  env.post(base(ph, 'gc_judgment', { judgment: judgment(ph, id, ITEM[id].final) }));
  env.ctx.buildGcSummary(false);
  const S = read(env.SS, 'GC_Summary');
  const f = section(S, 4);
  const r = f.slice(f.findIndex(x => String(x[0]).startsWith('[4-3]'))).find(x => x[0] === '(미응답·기타)') || [];
  eq('no ai_freq: [4-3] (미응답·기타) phys/n/agree', r.slice(2, 5).join('/'), '1/1/1');
  eq('no ai_freq: [2] AI 사용 빈도 (미응답) n', (section(S, 2).find(x => x[1] === '(미응답)') || [])[2], 1);
})();

// =====================================================================
// 4-3) Case sets: site fetch + 10-minute cache + embedded fallback, several sets, languages
// =====================================================================
const SET_URL = id => 'https://eval.asclep.org/gc/data/sets/' + id + '.json';
const V1_JSON = fs.readFileSync(path.join(ROOT, 'gc', 'data', 'sets', 'v1.json'), 'utf8');
/** a synthetic set 'v2': the v1 data under another id, with its own Parts and one item changed (final flipped) */
function makeV2() {
  const d = JSON.parse(V1_JSON);
  d.set_id = 'v2';
  d.data_version = 'v2.gc-test';
  d.parts = [{ id: 'A', sequences: [['P051_gpt', 'P011_deepseek'], ['P011_deepseek', 'P051_gpt']], items: 11, minutes: [10, 15] },
    { id: 'B', sequences: [['P011_gpt', 'P051_deepseek'], ['P051_deepseek', 'P011_gpt']], items: 18, minutes: [20, 25] },
    { id: 'C', sequences: [['P051_gpt']], items: 4, minutes: [5, 10] }];
  const it = d.units.P051_gpt.items[0];
  it.final = it.final === 'met' ? 'deducted' : 'met';
  return d;
}

(function caseSets() {
  // --- fetch → cache → memo ---
  const env = makeEnv();
  ok('setup checks the site data and logs it', env.logs.some(l => /✅ 사이트 케이스 세트 자료 읽기 확인: 활성 세트 v1/.test(l)), env.logs.slice(-4).join(' | '));
  ok('setup: last log line is still the result line', /✅ GC 응답 시트 준비 완료/.test(env.logs[env.logs.length - 1]));
  const C = env.ctx;
  env.fetches.length = 0; env.cache = {}; C.GC_SET_MEMO_ = {};
  let r = C.gcSetData_('v1');
  eq('gcSetData_(v1): read from the site', r.source, 'site');
  ok('gcSetData_(v1): exact, same data as the embedded copy', r.exact && JSON.stringify(r.data) === JSON.stringify(C.GC_ITEMS));
  eq('gcSetData_: fetch URL', env.fetches.join(','), SET_URL('v1'));
  ok('gcSetData_: cached for 10 minutes', env.cache['gcset:v1'] && env.lastTtl === 600);
  C.gcSetData_('v1');
  eq('gcSetData_: second call in the same execution uses the memo (no fetch)', env.fetches.length, 1);
  C.GC_SET_MEMO_ = {};
  eq('gcSetData_: next execution uses CacheService', C.gcSetData_('v1').source, 'cache');
  eq('gcSetData_: still one fetch', env.fetches.length, 1);
  eq('blank set id = v1', C.gcSetData_('').id, 'v1');
  // --- fallbacks ---
  const fb = (label, setup, id, wantExact, opts) => {
    const e = makeEnv(Object.assign({ setup: false }, opts || {}));
    setup(e);
    const x = e.ctx.gcSetData_(id || 'v1');
    ok(label + ' → embedded copy', x.source === 'embedded' && x.exact === wantExact && x.data === e.ctx.GC_ITEMS, JSON.stringify({ s: x.source, n: x.note, e: x.exact }));
    return x;
  };
  fb('site returns 404', e => { e.site[SET_URL('v1')] = { code: 404, text: 'nope' }; }, 'v1', true);
  fb('site returns HTML instead of JSON', e => { e.site[SET_URL('v1')] = { code: 200, text: '<html>' }; }, 'v1', true);
  const bad = JSON.parse(V1_JSON); delete bad.parts;
  fb('site JSON without parts (shape check)', e => { e.site[SET_URL('v1')] = { code: 200, text: JSON.stringify(bad) }; }, 'v1', true);
  const wrongId = JSON.parse(V1_JSON); wrongId.set_id = 'v7';
  fb('site JSON of another set (set_id check)', e => { e.site[SET_URL('v1')] = { code: 200, text: JSON.stringify(wrongId) }; }, 'v1', true);
  fb('fetch throws (quota, DNS)', e => { e.site[SET_URL('v1')] = { throw: 'Service invoked too many times' }; }, 'v1', true);
  const noPerm = fb('no UrlFetchApp (permission not granted)', () => {}, 'v1', true, { fetch: false });
  ok('fallback note says why', /UrlFetchApp/.test(noPerm.note), noPerm.note);
  const e0 = makeEnv({ fetch: false });
  ok('setup without the permission warns and still finishes', e0.logs.some(l => /⚠️ 사이트 케이스 세트 자료를 읽지 못했습니다/.test(l)) && /✅ GC 응답 시트 준비 완료/.test(e0.logs[e0.logs.length - 1]));
  const v9 = fb('unknown set v9 (not on the site)', () => {}, 'v9', false);
  ok('unknown set: note names the embedded set', /내장 사본은 세트 v1/.test(v9.note), v9.note);
  ok('cache corrupted → refetch', (() => { const e = makeEnv({ setup: false }); e.cache['gcset:v1'] = '{bad'; return e.ctx.gcSetData_('v1').source === 'site'; })());

  // --- the protocol with a second set v2 served by the site ---
  const env2 = makeEnv();
  const V2 = makeV2();
  env2.site[SET_URL('v2')] = { code: 200, text: JSON.stringify(V2) };
  env2.site['https://eval.asclep.org/gc/data/sets/index.json'] = { code: 200, text: JSON.stringify({ active: 'v2', sets: ['v1', 'v2'] }) };
  env2.cache = {};   // setup() already cached index.json (active v1) for 10 minutes: start from a cold cache
  const ph1 = physician('김세트', 'A', { set: 'v2', lang: 'en' });
  const st = env2.post(base(ph1, 'gc_start', { device: DEVICE }));
  ok('v2 start ok', st.ok, JSON.stringify(st));
  ph1.seq = st.seq_index; ph1.order = V2.parts[0].sequences[st.seq_index].slice();
  const sess = objs(env2.SS, 'GC_Sessions').find(x => x.SessionId === ph1.sid);
  eq('v2 session: SetId', sess.SetId, 'v2');
  eq('v2 session: ItemsTotal from the v2 Parts (P051_gpt 4 + P011_deepseek 7)', sess.ItemsTotal, 11);
  eq('v2 session: UiLang', sess.UiLang, 'en');
  const flipped = V2.units.P051_gpt.items[0];
  const jj = judgment(ph1, flipped.id, flipped.final, { ai_final: flipped.final });
  jj.ui_lang = 'en'; jj.ui_langs = ['ko', 'en']; jj.agree = true;
  env2.post(base(ph1, 'gc_judgment', { judgment: jj, data_version: V2.data_version }));
  const jr = objs(env2.SS, 'GC_Judgments').find(x => x.SessionId === ph1.sid && x.ItemId === flipped.id);
  eq('v2 judgment: AIFinal from the v2 set data (changed item)', jr.AIFinal, flipped.final);
  eq('v2 judgment: Agree computed against the v2 data', jr.Agree, true);
  eq('v2 judgment: SetId / UiLang / UiLangs', [jr.SetId, jr.UiLang, jr.UiLangs].join('|'), 'v2|en|ko;en');
  eq('v2 judgment: no ClientMismatch', jr.ClientMismatch, '');
  const jRaw = objs(env2.SS, 'GC_Raw').filter(x => x.SessionId === ph1.sid && x.Action === 'gc_judgment').map(x => String(x.Payload).replace(/^'/, ''));
  ok('v2 judgment: GC_Raw.Payload is the request verbatim (set data not attached)', jRaw.length === 1 && !/"_set"|"_gcev"/.test(jRaw[0]) &&
    JSON.parse(jRaw[0]).judgment.item_id === flipped.id && jRaw[0].length < 4000, jRaw.map(t => t.length + ':' + t.slice(-60)).join(' | '));
  // balanced sequence counted per set
  const ph2 = physician('이세트', 'A', { set: 'v1' });
  eq('first v1 Part A session after a v2 Part A session → seq 0 (sets counted apart)', startPh(env2, ph2).seq_index, 0);
  ok('sequence counters: GC_SEQ_COUNTER_A (v1) and GC_SEQ_COUNTER_A_v2', env2.props.GC_SEQ_COUNTER_A === '1' && env2.props.GC_SEQ_COUNTER_A_v2 === '1', JSON.stringify(env2.props));
  // a v1 judgment of the same item id uses the v1 data
  const jv1 = judgment(ph2, flipped.id, ITEM[flipped.id].final);
  env2.post(base(ph2, 'gc_judgment', { judgment: jv1 }));
  const jr1 = objs(env2.SS, 'GC_Judgments').find(x => x.SessionId === ph2.sid && x.ItemId === flipped.id);
  eq('same ItemId in v1: AIFinal from the v1 data', jr1.AIFinal, ITEM[flipped.id].final);
  eq('v1 judgment: SetId v1, UiLang ko', [jr1.SetId, jr1.UiLang].join('|'), 'v1|ko');
  // a set the site does not have → client values, mismatch recorded
  const ph3 = physician('박세트', 'A', { set: 'v9' });
  startPh(env2, ph3);
  const j9 = judgment(ph3, flipped.id, 'deducted', { ai_final: 'met' });
  env2.post(base(ph3, 'gc_judgment', { judgment: j9 }));
  const jr9 = objs(env2.SS, 'GC_Judgments').find(x => x.SessionId === ph3.sid);
  ok('unknown set v9: judgment stored with the site\'s values and a ClientMismatch note',
    jr9 && jr9.AIFinal === 'met' && /세트 v9 자료를 읽지 못함/.test(jr9.ClientMismatch) && jr9.SetId === 'v9', JSON.stringify(jr9 && [jr9.AIFinal, jr9.ClientMismatch]));
  // summary grouped by set
  let res;
  try { res = env2.ctx.buildGcSummary(false); ok('multi-set summary builds', true); } catch (e) { ok('multi-set summary builds', false, e.stack); return; }
  const S = read(env2.SS, 'GC_Summary');
  const s0 = section(S, 0);
  ok('[0] lists both sets with their source (v2 active from index.json)', s0.some(x => x[0] === '케이스 세트 v2 (활성)' && x[1] === 'v2.gc-test') && s0.some(x => x[0] === '케이스 세트 v1'));
  ok('[0] notes the set whose data could not be read (v9)', s0.some(x => String(x[0]).indexOf('케이스 세트 v9') === 0));
  ok('[0] Part rows qualified by set', s0.some(x => x[0] === '  v2 · Part C' && x[1] === 4) && s0.some(x => x[0] === '  v1 · Part A' && x[1] === 18));
  eq('[0] items = v2 29 + v1 29', row(s0, x => String(x[0]).startsWith('검증 대상 판정 수'))[1], 58);
  ok('[0] judgments of the unreadable set counted apart', row(s0, x => String(x[0]).startsWith('세트 자료에 없는 ItemId'))[1] === 1);
  const s3 = section(S, 3);
  const hdr = s3.find(x => x[0] === '상태');
  eq('[3] status table: one column per set × Part', hdr.slice(2, 7).join(','), 'v2 · Part A,v2 · Part B,v2 · Part C,v1 · Part A,v1 · Part B');
  const s1 = section(S, 1);
  ok('[1] rows per set and per language', s1.some(x => x[0] === '세트 v2' && x[3] === 1) && s1.some(x => x[0] === '화면 언어 en' && x[3] === 1) && s1.some(x => x[0] === '화면 언어 ko' && x[3] === 2));
  ok('[4] language rows when English judgments exist', section(S, 4).some(x => x[0] === '화면 언어 (UiLang)' && x[1] === 'en' && x[2] === 1));
  const ADJ = read(env2.SS, 'GC_Adjudication'), ah = ADJ[0];
  const a2 = ADJ.find(x => x[0] === flipped.id && x[ah.indexOf('SetId')] === 'v2'), a1 = ADJ.find(x => x[0] === flipped.id && x[ah.indexOf('SetId')] === 'v1');
  ok('GC_Adjudication: the same ItemId is a separate row per set', !!a1 && !!a2 && a1 !== a2);
  eq('GC_Adjudication v2 row: AIFinal from v2, 1 vote', [a2[ah.indexOf('AIFinal')], a2[ah.indexOf('N')]].join('|'), flipped.final + '|1');
  const CONC = read(env2.SS, 'GC_Concordance'), ch = CONC[0];
  eq('GC_Concordance: TargetKeys of both sets', CONC.slice(1).filter(x => x[ch.indexOf('SetId')] === 'v2').length, CONC.slice(1).filter(x => x[ch.indexOf('SetId')] === 'v1').length);
  ok('rules mention the set data source', S.some(x => /gc\/data\/sets/.test(String(x[0])) && /^\d+\. /.test(String(x[0]))));
  eq('summary result counts items of both sets', res.items, 58);
  // the site is read before the script lock is taken (a slow site never blocks other requests)
  const env4 = makeEnv();
  env4.cache = {}; env4.fetchHeld = []; env4.fetches.length = 0;
  const ph4 = physician('잠금', 'B');
  startPh(env4, ph4);
  ok('doPost reads the set data before taking the lock', env4.fetches.length === 1 && env4.fetchHeld.every(h => h === false), JSON.stringify([env4.fetches, env4.fetchHeld]));
  // single set (v1 only, the live study): labels stay 'Part A' (no set prefix)
  const env3 = makeEnv();
  env3.ctx.buildGcSummary(false);
  const S3 = read(env3.SS, 'GC_Summary');
  ok('single set: unqualified labels as before', section(S3, 0).some(x => x[0] === '  Part A') && !S3.some(x => /v1 · Part/.test(String(x[0]))));
  ok('single set: [3] columns Part A, Part B', (section(S3, 3).find(x => x[0] === '상태') || []).slice(2, 4).join(',') === 'Part A,Part B');
})();

// =====================================================================
// 4-4) The deployed GC backend (v3, commit 9e8509f) accepts the new payloads (ui_lang, set_id, ui_langs: ignored)
// =====================================================================
(function oldGcBackend() {
  let old = null;
  try { old = require('child_process').execSync('git -C ' + JSON.stringify(ROOT) + ' show 9e8509f:gas/GcCode.gs', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); }
  catch (e) { console.log('SKIP git history not available: deployed GC backend check'); return; }
  const env = makeEnv({ code: old, fetch: false });
  eq('old GC backend is v3', env.ctx.GC_BACKEND_VERSION, '2026-11-20.gc-backend-v3');
  const ph = physician('구버전', 'A', { lang: 'en', set: 'v1' });
  const st = env.post(base(ph, 'gc_start', { device: DEVICE }));
  ph.seq = st.seq_index; ph.order = GC_CONFIG.PARTS[0].sequences[st.seq_index].slice();
  const items = partItems('A');
  const js = items.map((id, i) => Object.assign(judgment(ph, id, ITEM[id].final, { item_order: i + 1 }), { ui_lang: 'en', ui_langs: ['en'] }));
  const r1 = env.post(base(ph, 'gc_judgment', { judgment: js[0] }));
  const r2 = env.post(base(ph, 'gc_finish', { judgments: js, end_items: endItems(4, 4), session: { started_at: iso(0), finished_at: iso(9e5), ui_lang_start: 'en', ui_langs: ['en'], ui_lang_switches: 0 } }));
  ok('old GC backend: new-style payloads accepted', st.ok && r1.ok && r2.ok, JSON.stringify([st, r1, r2]));
  eq('old GC backend: all judgments stored', objs(env.SS, 'GC_Judgments').filter(x => x.SessionId === ph.sid).length, items.length);
  let okSum = true;
  try { env.ctx.buildGcSummary(false); } catch (e) { okSum = false; }
  ok('old GC backend: summary still builds', okSum);
})();

// =====================================================================
// 4-5) Redeploy on the live project: the deployed v3 backend (commit 9e8509f) has sessions from the earlier site (no ui_lang /
//      set_id) and from the current site; then v4 is pasted over it (same spreadsheet + script properties) and the sessions
//      started under v3 finish under v4, before and after the PI runs setup() as the deployment notes say.
// =====================================================================
(function redeployV3toV4() {
  let old = null;
  try { old = require('child_process').execSync('git -C ' + JSON.stringify(ROOT) + ' show 9e8509f:gas/GcCode.gs', { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8'); }
  catch (e) { console.log('SKIP git history not available: v3 → v4 redeploy check'); return; }
  const v3 = makeEnv({ code: old, fetch: false });
  const strip = (p) => { delete p.ui_lang; delete p.set_id; return p; };
  const P = { A: physician('이전사이트', 'A'), B: physician('현재사이트', 'B', { lang: 'en', set: 'v1' }), C: physician('완료v3', 'A') };
  P.A.oldSite = P.C.oldSite = true;
  const send = (env, ph, action, extra) => { const p = base(ph, action, extra); return env.post(ph.oldSite ? strip(p) : p); };
  const js = {};
  Object.keys(P).forEach(id => {
    const ph = P[id];
    const st = send(v3, ph, 'gc_start', { device: DEVICE });
    ph.seq = st.seq_index; ph.order = GC_CONFIG.PARTS.find(p => p.id === ph.part).sequences[st.seq_index].slice();
    js[id] = partItems(ph.part).map((it, i) => {
      const j = judgment(ph, it, ITEM[it].final, { item_order: i + 1 });
      return ph.oldSite ? j : Object.assign(j, { ui_lang: 'en', ui_langs: ['en'] });
    });
    ph.r1 = send(v3, ph, 'gc_judgment', { judgment: js[id][0] });
  });
  const fin = (env, id) => send(env, P[id], 'gc_finish', { judgments: js[id], end_items: endItems(4, 4),
    session: Object.assign({ started_at: iso(0), finished_at: iso(9e5) }, P[id].oldSite ? {} : { ui_lang_start: 'en', ui_langs: ['en'], ui_lang_switches: 0 }) });
  const fC = fin(v3, 'C');
  ok('v3: three sessions started, first judgments and session C stored', ['A', 'B', 'C'].every(id => P[id].r1.ok) && fC.ok);
  const names = ['Visits', 'GC_Sessions', 'GC_Judgments', 'GC_Raw'];
  const before = {};
  names.forEach(n => { before[n] = read(v3.SS, n) || []; });
  // ---- paste v4 over it; first requests before setup() (the PI may test the URL first) ----
  const v4 = makeEnv({ from: v3, setup: false });
  eq('redeploy: v4 on the v3 project', v4.ctx.GC_BACKEND_VERSION, '2026-11-21.gc-backend-v4');
  const fA = fin(v4, 'A');
  ok('redeploy: earlier-site session A (started under v3) finishes under v4 before setup()', fA.ok, JSON.stringify(fA));
  v4.ctx.setup();
  ok('redeploy: setup() reuses the spreadsheet (no new one)', v4.created.length === 0 && v4.props.GC_SPREADSHEET_ID === v3.props.GC_SPREADSHEET_ID);
  const fB = fin(v4, 'B');
  ok('redeploy: current-site session B (started under v3) finishes under v4 after setup()', fB.ok, JSON.stringify(fB));
  const SS = v4.SS;
  names.forEach(n => {
    const h0 = (before[n][0] || []).map(String), h1 = (read(SS, n)[0] || []).map(String);
    ok('redeploy ' + n + ': v3 columns keep their positions, new ones appended (' + h1.slice(h0.length).join(',') + ')',
      h0.length > 0 && h1.slice(0, h0.length).join('|') === h0.join('|'));
  });
  const J = objs(SS, 'GC_Judgments');
  eq('redeploy: all judgments of A, B, C stored once', ['A', 'B', 'C'].map(id => J.filter(x => x.SessionId === P[id].sid).length).join(','),
    ['A', 'B', 'C'].map(id => js[id].length).join(','));
  eq('redeploy: session A judgments → SetId blank (= v1)', [...new Set(J.filter(x => x.SessionId === P.A.sid).map(x => x.SetId || '-'))].join(','), '-');
  // the judgment stored by v3 is not rewritten by the v4 finish (same answer): its new columns stay blank (= v1 / ko); the
  // screen language of that request is still in GC_Raw
  const jb = J.filter(x => x.SessionId === P.B.sid);
  eq('redeploy: session B → judgment 1 (stored by v3) blank, the rest (under v4) SetId v1 / UiLang en',
    [(jb[0].SetId || '-') + '/' + (jb[0].UiLang || '-'), [...new Set(jb.slice(1).map(x => x.SetId + '/' + x.UiLang))].join(',')].join(' | '), '-/- | v1/en');
  ok('redeploy: GC_Raw keeps ui_lang/set_id of the judgment request handled by v3',
    (read(SS, 'GC_Raw') || []).some(r => { const x = r.join(' '); return x.includes(P.B.sid) && x.includes('gc_judgment') && x.includes('"ui_lang":"en"') && x.includes('"set_id":"v1"'); }));
  const S = objs(SS, 'GC_Sessions');
  eq('redeploy: one completed GC_Sessions row per session', ['A', 'B', 'C'].map(id => S.filter(x => x.SessionId === P[id].sid).map(x => x.Status).join('+')).join(','), 'completed,completed,completed');
  ok('redeploy: no ClientMismatch for v1 sessions', J.every(x => !x.ClientMismatch), JSON.stringify(J.filter(x => x.ClientMismatch).map(x => x.ClientMismatch)));
  let okSum = true, err = '';
  try { v4.ctx.buildGcSummary(false); } catch (e) { okSum = false; err = e.message; }
  ok('redeploy: v4 summary builds on the mixed v3/v4 sheets', okSum, err);
  const adj = objs(SS, 'GC_Adjudication');
  ok('redeploy: adjudication rows carry SetId v1 (old rows counted as v1)', adj.length > 0 && adj.every(x => x.SetId === 'v1'));
})();

// =====================================================================
// 5) CA unit tests must still pass
// =====================================================================
(function caTests() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'test_summary.js')], { encoding: 'utf8' });
  const tail = (r.stdout || '').trim().split('\n').pop();
  ok('tools/test_summary.js still all PASS (' + tail + ')', r.status === 0, (r.stdout || '').split('\n').filter(l => l.startsWith('FAIL')).join(' | ') || r.stderr);
})();

// ---- 시각 저장(초 단위·한국 시간) + resetAllGcResponses ----
(function () {
  const env = makeEnv();
  const C = env.ctx;
  C.setup();
  const SS = env.SS;
  eq('GC setup: time zone Asia/Seoul', SS.getSpreadsheetTimeZone(), 'Asia/Seoul');
  const J = SS.getSheetByName('GC_Judgments');
  const jh = J.getRange(1, 1, 1, J.getLastColumn()).getValues()[0];
  eq('GC setup: AnsweredAt formatted to seconds', J.getRange(2, jh.indexOf('AnsweredAt') + 1).getNumberFormat(), 'yyyy-mm-dd hh:mm:ss');
  const db = {};
  const t = C.table_(SS, db, 'GC_Judgments', C.gcJudgHeaders_());
  C.tWrite_(t, -1, { SessionId: 's', ItemId: 'i', AnsweredAt: '2026-11-20T03:04:05.678Z', Comment: '2026-11-20T03:04:05Z' });
  C.tFlush_(t);
  const r = J.getRange(2, 1, 1, jh.length).getValues()[0];
  ok('GC AnsweredAt stored as Date', r[jh.indexOf('AnsweredAt')] instanceof Date && r[jh.indexOf('AnsweredAt')].toISOString() === '2026-11-20T03:04:05.678Z');
  eq('GC Comment stays text', r[jh.indexOf('Comment')], '2026-11-20T03:04:05Z');
  env.props.GCC_x = 'G001'; env.props.GCC_COUNTER = '1'; env.props.GCT_COUNTER = '1'; env.props.GC_SEQ_COUNTER_A = '2'; env.props.GC_SUMMARY_DIRTY = '1';
  const id = env.props.GC_SPREADSHEET_ID;
  const before = (Spreadsheet.copied || []).length;
  C.resetAllGcResponses();
  eq('GC reset: one backup copy', (Spreadsheet.copied || []).length - before, 1);
  eq('GC reset: backup keeps the judgment row', Spreadsheet.copied[Spreadsheet.copied.length - 1].getSheetByName('GC_Judgments').getLastRow(), 2);
  ['Visits', 'GC_Sessions', 'GC_Judgments', 'GC_Raw'].forEach(n => eq('GC reset: ' + n + ' header only', SS.getSheetByName(n).getLastRow(), 1));
  ok('GC reset: codes/counters cleared', !Object.keys(env.props).some(k => /^(GCC_|GCT_|GC_SEQ_COUNTER|GC_SUMMARY_DIRTY$)/.test(k)));
  eq('GC reset: spreadsheet id kept', env.props.GC_SPREADSHEET_ID, id);
  eq('GC reset: lock released', env.lock.acquired, env.lock.released);
})();

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
