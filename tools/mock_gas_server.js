/**
 * Local test harness: runs the two Apps Script projects unchanged inside Node, each in its OWN vm context with its own
 * in-memory spreadsheet / script properties / triggers (mock SpreadsheetApp / LockService / PropertiesService /
 * ContentService / ScriptApp), exactly like the two separate deployments:
 *   - CA  gas/Code.gs    web app at http://localhost:PORT/exec     (site /ca/, root config.js ENDPOINT rewritten to it)
 *   - GC  gas/GcCode.gs  web app at http://localhost:PORT/gc-exec  (site /gc/, gc/gc-config.js ENDPOINT rewritten to it)
 *     The GC project is a standalone project: its setup() creates the spreadsheet (SpreadsheetApp.create), as on script.google.com.
 * and serves:
 *   - the static site   at http://localhost:PORT/   (landing /, CA /ca/, GC /gc/, About /about/, QR /qr/;
 *                       both configs' ENDPOINT rewritten unless ?noendpoint=1 is in the referer)
 *   - sheet dump        at /__sheets            (CA)   /__sheets?app=gc   (GC)        JSON of all sheets, for tests
 *   - script properties at /__props             (CA)   /__props?app=gc    (GC)
 *   - summaries         /__refresh (CA refreshSummaryIfDirty) · /__summary[?tests=1] (CA buildSummary → Summary)
 *                       /__refresh?app=gc (refreshGcSummaryIfDirty) · /__gcsummary[?tests=1] (buildGcSummary → GC summary sheets)
 *   - control           /__fail?n=K (next K web-app POSTs fail with 500) · /__delay?ms=N
 * Usage: node tools/mock_gas_server.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] || 8787);

// ---------------- In-memory spreadsheet mock ----------------
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
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error(`setValues dim mismatch ${vals.length}x${vals[0].length} vs ${this.nr}x${this.nc}`);
    for (let r = 0; r < this.nr; r++) {
      const ri = this.row - 1 + r;
      this.sheet.cells[ri] = this.sheet.cells[ri] || [];
      for (let c = 0; c < this.nc; c++) {
        const v = vals[r][c];
        if (this.row - 1 + r > 0 && typeof v === 'string' && /^[=+\-@]/.test(v)) console.warn('[mock] UNGUARDED formula-like write:', this.sheet.name, v.slice(0, 40));
        this.sheet.cells[ri][this.col - 1 + c] = v;
      }
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
  appendRow(vals) {
    vals.forEach(v => { if (typeof v === 'string' && /^[=+\-@]/.test(v)) console.warn('[mock] UNGUARDED formula-like append:', this.name, v.slice(0, 40)); });
    this.cells[this.getLastRow()] = vals.slice(); return this;
  }
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
  getUrl() { return 'mock://spreadsheet/' + this.id; }
}

/** One Apps Script project: its own vm context, spreadsheet(s), script properties and triggers. */
function makeProject(label, file, opts) {
  const books = {};
  const P = { label, props: {}, triggers: [], ss: null };
  if (opts.bound) { P.ss = new Spreadsheet(label); books[P.ss.getId()] = P.ss; }
  const props = P.props, triggers = P.triggers;
  const ctx = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => (opts.bound ? P.ss : null),
      // bound (CA): any id opens the one spreadsheet (CA's SPREADSHEET_ID is set); GC: only spreadsheets created here
      openById: (id) => { if (books[id]) return books[id]; if (opts.bound) return P.ss; throw new Error('mock: no spreadsheet ' + id); },
      create: (name) => { const s = new Spreadsheet(name); books[s.getId()] = s; P.ss = s; return s; },
      getUi: () => ({ alert() {}, createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } }),
      flush: () => {}   // writes are synchronous in this mock (GC calls flush() before releasing the lock)
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, getProperties: () => Object.assign({}, props), deleteProperty: k => { delete props[k]; } }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }) },
    Logger: { log: (...a) => console.log(`[GAS ${label}]`, ...a) },
    Utilities: {
      formatDate: (d, tz, fmt) => new Date(d).toISOString().replace('T', ' ').slice(0, 19),
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => Array.from(require('crypto').createHash(alg).update(String(str), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
      sleep: () => {}
    },
    ScriptApp: (() => {
      const mk = (fn) => ({ getHandlerFunction: () => fn, getEventType: () => 'CLOCK', getUniqueId: () => fn + triggers.length });
      return {
        EventType: { CLOCK: 'CLOCK' },
        getProjectTriggers: () => triggers.slice(),
        deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
        newTrigger: (fn) => { const b = { timeBased: () => b, everyMinutes: () => b, everyHours: () => b, create: () => { const t = mk(fn); triggers.push(t); return t; } }; return b; }
      };
    })(),
    console,
    JSON, Math, Date, String, Number, Object, Array, isNaN
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas', file), 'utf8'), ctx, { filename: file });
  ctx.setup();
  P.ctx = ctx;
  P.dump = () => {
    const o = {};
    (P.ss ? P.ss.sheets : []).forEach(s => {
      const lr = s.getLastRow(), lc = s.getLastColumn();
      o[s.name] = lr ? s.getRange(1, 1, lr, Math.max(lc, 1)).getValues().map(r => r.map(v => (v instanceof Date ? v.toISOString() : v))) : [];
    });
    return o;
  };
  return P;
}
const CA = makeProject('CA', 'Code.gs', { bound: true });     // CA: script bound to (or opened by id) the CA spreadsheet
const GC = makeProject('GC', 'GcCode.gs', { bound: false });  // GC: standalone project, setup() creates its spreadsheet

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json' };
let failNext = 0, delayMs = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/exec' || url.pathname === '/gc-exec') {
    const app = url.pathname === '/gc-exec' ? GC : CA;
    if (req.method === 'GET') {
      const out = app.ctx.doGet({ parameter: Object.fromEntries(url.searchParams) });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out.getContent()); return;
    }
    if (req.method === 'OPTIONS') { res.writeHead(405, cors); res.end(); return; }  // GAS has no preflight support
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (!/^text\/plain/i.test(ct)) console.warn('[mock] non-simple content-type:', ct);
      setTimeout(() => {
        if (failNext > 0) { failNext--; res.writeHead(500, cors); res.end('fail'); return; }
        const out = app.ctx.doPost({ postData: { contents: body, type: ct } });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out.getContent());
      }, delayMs);
    });
    return;
  }
  const app = url.searchParams.get('app') === 'gc' ? GC : CA;
  const sendJson = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/__sheets') { sendJson(app.dump()); return; }
  if (url.pathname === '/__fail') { failNext = Number(url.searchParams.get('n') || 1); res.end('ok'); return; }
  if (url.pathname === '/__delay') { delayMs = Number(url.searchParams.get('ms') || 0); res.end('ok'); return; }
  if (url.pathname === '/__props') { sendJson(app.props); return; }
  if (url.pathname === '/__refresh') {
    if (app === GC) { const ran = GC.ctx.refreshGcSummaryIfDirty(); sendJson({ ran, dirty: GC.props.GC_SUMMARY_DIRTY || null, built: GC.props.GC_SUMMARY_BUILT_AT || null }); return; }
    const ran = CA.ctx.refreshSummaryIfDirty && CA.ctx.refreshSummaryIfDirty();
    sendJson({ ran, dirty: CA.props.SUMMARY_DIRTY || null, built: CA.props.SUMMARY_BUILT_AT || null }); return;
  }
  if (url.pathname === '/__summary') { CA.ctx.buildSummary(url.searchParams.get('tests') === '1'); sendJson(CA.dump().Summary || []); return; }
  if (url.pathname === '/__gcsummary') {
    let result, error = null;
    try { result = GC.ctx.buildGcSummary(url.searchParams.get('tests') === '1'); } catch (e) { error = String(e && e.stack || e); }
    const d = GC.dump();
    sendJson({ result, error, GC_Adjudication: d.GC_Adjudication || [], GC_Concordance: d.GC_Concordance || [], GC_Summary: d.GC_Summary || [], GC_Codebook: d.GC_Codebook || [] });
    return;
  }
  // static
  let p = decodeURIComponent(url.pathname);
  // like GitHub Pages: /ca → /ca/ (directory without the trailing slash), keeping the query
  const dirFp = path.join(ROOT, p);
  if (!p.endsWith('/') && dirFp.startsWith(ROOT) && fs.existsSync(dirFp) && fs.statSync(dirFp).isDirectory()) {
    res.writeHead(301, { Location: p + '/' + url.search }); res.end(); return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  // config override: CA /config.js (loaded by /ca/ as ../config.js) → /exec, GC /gc/gc-config.js → /gc-exec (separate projects),
  // unless ?noendpoint=1 is in the referer
  if ((p === '/config.js' || p === '/gc/gc-config.js') && !/noendpoint=1/.test(req.headers.referer || '')) {
    const src = fs.readFileSync(fp, 'utf8').replace(/ENDPOINT:\s*'[^']*'/, `ENDPOINT: 'http://localhost:${PORT}${p === '/config.js' ? '/exec' : '/gc-exec'}'`);
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }); res.end(src); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
});
server.listen(PORT, () => console.log(`mock GAS + static server on http://localhost:${PORT}  (CA web app /exec, GC web app /gc-exec)`));
