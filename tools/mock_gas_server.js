/**
 * Local test harness: runs gas/Code.gs unchanged inside Node with an in-memory mock of
 * SpreadsheetApp / LockService / PropertiesService / ContentService, and serves:
 *   - the static site at  http://localhost:PORT/
 *   - the "web app"     at http://localhost:PORT/exec   (POST JSON, GET health)
 *   - sheet dump        at http://localhost:PORT/__sheets  (JSON of all sheets, for tests)
 *   - control           at http://localhost:PORT/__fail?n=K  (make the next K /exec POSTs fail with 500)
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
  appendRow(vals) {
    vals.forEach(v => { if (typeof v === 'string' && /^[=+\-@]/.test(v)) console.warn('[mock] UNGUARDED formula-like append:', this.name, v.slice(0, 40)); });
    this.cells[this.getLastRow()] = vals.slice(); return this;
  }
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
const SS = new Spreadsheet();
const props = {};
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => SS, openById: () => SS, getUi: () => ({ alert() {}, createMenu() { return { addItem() { return this; }, addSeparator() { return this; }, addToUi() {} }; } }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, getProperties: () => Object.assign({}, props), deleteProperty: k => { delete props[k]; } }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }) },
  Logger: { log: (...a) => console.log('[GAS]', ...a) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, str) => Array.from(require('crypto').createHash(alg).update(String(str), 'utf8').digest()).map(b => (b > 127 ? b - 256 : b)),
    sleep: () => {}
  },
  ScriptApp: (() => {
    const triggers = [];
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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas', 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
ctx.setup();

function dumpSheets() {
  const o = {};
  SS.sheets.forEach(s => {
    const lr = s.getLastRow(), lc = s.getLastColumn();
    o[s.name] = lr ? s.getRange(1, 1, lr, Math.max(lc, 1)).getValues().map(r => r.map(v => (v instanceof Date ? v.toISOString() : v))) : [];
  });
  return o;
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml' };
let failNext = 0, delayMs = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.pathname === '/exec') {
    if (req.method === 'GET') {
      const out = ctx.doGet({});
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
        const out = ctx.doPost({ postData: { contents: body, type: ct } });
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }); res.end(out.getContent());
      }, delayMs);
    });
    return;
  }
  if (url.pathname === '/__sheets') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dumpSheets())); return; }
  if (url.pathname === '/__fail') { failNext = Number(url.searchParams.get('n') || 1); res.end('ok'); return; }
  if (url.pathname === '/__delay') { delayMs = Number(url.searchParams.get('ms') || 0); res.end('ok'); return; }
  if (url.pathname === '/__refresh') { ctx.refreshSummaryIfDirty && ctx.refreshSummaryIfDirty(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ dirty: props.SUMMARY_DIRTY || null, built: props.SUMMARY_BUILT_AT || null })); return; }
  if (url.pathname === '/__props') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(props)); return; }
  if (url.pathname === '/__summary') { ctx.buildSummary(url.searchParams.get('tests') === '1'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(dumpSheets().Summary || [])); return; }
  // static
  let p = decodeURIComponent(url.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  // config override: point ENDPOINT to the mock unless ?noendpoint=1 is in the referer
  if (p === '/config.js' && !/noendpoint=1/.test(req.headers.referer || '')) {
    const src = fs.readFileSync(fp, 'utf8').replace(/ENDPOINT:\s*'[^']*'/, `ENDPOINT: 'http://localhost:${PORT}/exec'`);
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' }); res.end(src); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(fp).pipe(res);
});
server.listen(PORT, () => console.log(`mock GAS + static server on http://localhost:${PORT}`));
