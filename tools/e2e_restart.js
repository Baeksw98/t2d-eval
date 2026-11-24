/**
 * CA restart flow (site v3.9): the landing page offers 이어서 하기 / 처음부터 다시 for an unfinished CA assessment, and the
 * 「임상 수용성 평가」 card always starts over (index.html → ca/?restart=1, app.js clears an unfinished session).
 * Runs against tools/mock_gas_server.js (serves the site, /exec, /__sheets, /__fail). Usage:
 *   node tools/mock_gas_server.js 8787   then   node tools/e2e_restart.js http://localhost:8787 [shotsDir]
 * Checks
 *  1. Banner 이어서 하기 resumes the same session at the same case (no reset).
 *  2. The CA card on the landing page clears an unfinished session: /ca/ shows a fresh intro, the URL loses ?restart=1, a toast
 *     says so, a reload does not clear again, a second tab that still showed the old session stops (stale screen), and the
 *     next session's start payload carries entry.restart_of = the cleared session id. The completed case of the cleared
 *     session stays on the server (Responses).
 *  3. 처음부터 다시 (banner) while the server is unreachable: the cleared session's unsent payloads move to
 *     't2d-ca:T2D-CA-2026:v3:unsent', the landing shows "전송되지 않은 … 응답", and the next /ca/ visit sends them (then the key is gone).
 *  4. A finished session is kept: the card opens the done screen (continuation into the other Type still offered).
 *  5. Plain /ca/ (no ?restart) keeps resuming as before.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
const shots = process.argv[3];
const KEY = 't2d-ca:T2D-CA-2026:v3', UNSENT = KEY + ':unsent';
const DICT = (() => {
  const d = { ko: {}, en: {} };
  new Function('T2D', fs.readFileSync(path.join(__dirname, '..', 'i18n', 'ca.js'), 'utf8'))({ i18n: { add: (x) => { Object.assign(d.ko, x.ko); Object.assign(d.en, x.en); } } });
  return d;
})();
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const sheets = async () => (await fetch(base + '/__sheets')).json();
const rowsOf = (dump, name) => {   // [{col: value}] from the mock dump (first row = header)
  const t = dump[name]; if (!t || !t.length) return [];
  const h = t[0]; return t.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
};

(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'ko-KR' });
  await ctx.route(/script\.google(usercontent)?\.com/, r => r.abort());
  const sent = [];
  ctx.on('request', r => {
    if (r.method() !== 'POST' || !/\/exec(\?|$)/.test(r.url())) return;
    try { const j = JSON.parse(r.postData() || ''); if (j && j.action) sent.push(j); } catch (_) {}
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  const st = () => page.evaluate(() => window.__T2D_APP__ && window.__T2D_APP__.state());
  const stored = (k) => page.evaluate(k => localStorage.getItem(k), k);
  const wait = (ms) => page.waitForTimeout(ms);
  const next = async () => { await wait(500); await page.click('[data-act="next"]'); };
  let shot = 0;
  const snap = async (label) => { if (shots) await page.screenshot({ path: path.join(shots, `restart_${String(++shot).padStart(2, '0')}_${label}.png`) }); };

  // intro → start (resident R2, Type A); returns the session id
  const startSession = async (name, type) => {
    await page.waitForSelector('#evName');
    await page.fill('#evName', name);
    await page.click('#roleSeg button[data-role="resident"]');
    await page.click('#roleFields .seg[data-field="year"] button[data-value="R2"]');
    await page.click('#commonFields .seg[data-field="ai_freq"] button >> nth=2');
    await page.click(`#typeSeg button[data-type="${type}"]`);
    await wait(100);
    await page.check('#evConsent');
    await wait(500);
    await page.click('#startBtn');
    await page.waitForFunction(() => window.__T2D_APP__.state() && window.__T2D_APP__.state().screen === 'case');
    return (await st()).session_id;
  };
  // one full case (vignette → P1 → combo → P2–P5 → comment) → next case / final
  const doCase = async () => {
    await page.waitForSelector('.pt-head'); await next();
    await page.waitForSelector('.likert button[data-rate]'); await page.click('.likert button[data-rate="4"]'); await next();
    await page.waitForSelector('.combo-card'); await wait(500); await page.click('.combo-card[data-combo="1"] .cc-drugs');
    await page.waitForFunction(() => window.__T2D_APP__.state().stepIdx === 3); await wait(900);
    for (const s of [5, 4, 3, 2]) { await page.waitForSelector('.likert button[data-rate]'); await page.click(`.likert button[data-rate="${s}"]`); await next(); }
    await page.waitForSelector('#caseComment');
    await page.click('#caseItems .seg[data-field="harm"] button >> nth=0');
    await page.click('#caseItems .seg[data-field="would_prescribe"] button >> nth=0');
    await next();
  };
  const landing = async () => { await page.goto(base + '/?src=e2e', { waitUntil: 'networkidle' }); };

  // ---- 1. banner 이어서 하기 resumes ----
  await page.goto(base + '/ca/?reset=1&src=e2e');
  const s1 = await startSession('재시작 시험', 'A');
  await doCase();                                   // case 1 completed and sent
  await page.waitForSelector('.pt-head');           // case 2, vignette
  await page.waitForFunction(() => !window.__T2D_APP__.state().outbox.length, null, { timeout: 15000 }).catch(() => {});
  await landing();
  await snap('landing_in_progress');
  ok(/진행 중인 임상 수용성 평가가 있습니다/.test(await page.innerText('#resume')) && /케이스 2\/2/.test(await page.innerText('#resume')), 'landing: banner for the case in progress');
  ok(await page.isVisible('#pcCaRestart'), 'landing: CA card says it starts over');
  await page.click('#resume a:not([data-restart])');
  await page.waitForSelector('.pt-head');
  let s = await st();
  ok(s.session_id === s1 && s.caseIdx === 1, '이어서 하기: same session, case 2');
  ok(!/restart/.test(page.url()), '이어서 하기: no restart param');

  // a second tab still showing the old session (it must stop once the session is cleared elsewhere)
  const tab2 = await ctx.newPage();
  await tab2.goto(base + '/ca/?src=e2e');
  await tab2.waitForSelector('.pt-head');

  // ---- 2. the CA card starts over ----
  await landing();
  await page.click('.pick-card.ca');
  await page.waitForSelector('#evName');
  ok(!(await st()), 'card: no session in memory (fresh intro)');
  ok(!(await stored(KEY)), 'card: saved CA session removed');
  ok(!/restart=1/.test(page.url()) && /[?&]src=e2e/.test(page.url()), 'card: ?restart=1 stripped from the URL, src kept: ' + page.url());
  await wait(500);
  ok(((await page.textContent('#toast')) || '').trim() === DICT.ko['ca.toast.restarted'] && await page.isVisible('#toast'), 'card: toast says the answers were cleared');
  await snap('ca_intro_after_restart');
  await tab2.waitForTimeout(600);
  ok(await tab2.isVisible('#takeOverBtn'), 'second tab with the old session shows the stale screen');
  await tab2.close();
  await page.reload();
  await page.waitForSelector('#evName');
  ok(!(await st()) && !(await page.isVisible('#toast')), 'reload after restart: still the intro, no second clear/toast');
  const s2 = await startSession('재시작 시험', 'A');
  ok(s2 && s2 !== s1, 'new session id after restart');
  await wait(800);
  const start2 = sent.filter(p => p.action === 'start' && p.session_id === s2).pop();
  ok(start2 && start2.entry && start2.entry.restart_of === s1, 'start payload: entry.restart_of = cleared session ' + JSON.stringify(start2 && start2.entry));
  const resp = rowsOf(await sheets(), 'Responses').filter(r => r.SessionId === s1);
  ok(resp.length === 1 && resp[0].CaseCompletedAt, 'server keeps the completed case of the cleared session (' + resp.length + ' row)');

  // ---- 3. 처음부터 다시 while offline: unsent answers are kept and sent later ----
  await page.route(/\/exec(\?|$)/, r => r.abort());
  await doCase();                                   // case 1 of s2: cannot be sent
  await page.waitForSelector('.pt-head');
  s = await st();
  ok(s.outbox.length >= 1, 'offline: case payload waiting in the outbox (' + s.outbox.length + ')');
  const pendingIds = s.outbox.map(x => x.msg_id);
  await landing();
  await page.click('#resume a[data-restart]');
  await page.waitForSelector('#evName');
  const un = JSON.parse((await stored(UNSENT)) || '[]');
  ok(pendingIds.every(id => un.some(x => x.msg_id === id)), '처음부터 다시: unsent payloads moved to the :unsent key (' + un.length + ')');
  ok(!(await stored(KEY)), '처음부터 다시: saved session removed');
  await landing();
  ok(/전송되지 않은 임상 수용성 평가 응답이 있습니다/.test(await page.innerText('#resume')), 'landing: banner for the unsent answers');
  ok(!(await page.isVisible('#pcCaRestart')), 'landing: no "starts over" hint when nothing is in progress');
  await page.unroute(/\/exec(\?|$)/);
  await page.click('#resume a');
  await page.waitForSelector('#evName');
  await page.waitForFunction(k => !localStorage.getItem(k), UNSENT, { timeout: 20000 }).catch(() => {});
  ok(!(await stored(UNSENT)), 'next /ca/ visit sent the unsent payloads (key removed)');
  const resp2 = rowsOf(await sheets(), 'Responses').filter(r => r.SessionId === s2);
  ok(resp2.length === 1 && resp2[0].CaseCompletedAt, 'server received the case of the cleared offline session');

  // ---- 4. a finished session is kept ----
  await startSession('완료 시험', 'B');
  await doCase(); await doCase();
  await page.waitForSelector('#overallComment');
  await page.click('#endItems .seg[data-field="intent_use"] button >> nth=3');
  await wait(500);
  await page.click('#submitBtn');
  await page.waitForSelector('.status-line');
  const done = (await st()).session_id;
  await landing();
  ok(!(await page.isVisible('#resume')) && !(await page.isVisible('#pcCaRestart')), 'landing after a finished session: no banner, no hint');
  await page.click('.pick-card.ca');
  await page.waitForSelector('[data-next-type]');
  s = await st();
  ok(s && s.screen === 'done' && s.session_id === done, 'card after a finished session: done screen kept (other Type offered)');
  await snap('ca_done_kept');

  // ---- 5. plain /ca/ resumes (no ?restart) ----
  await page.click('[data-next-type]');
  await page.waitForSelector('#startBtn');
  await wait(500);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__T2D_APP__.state() && window.__T2D_APP__.state().screen === 'case');
  const linked = (await st()).session_id;
  await wait(800);
  const startL = sent.filter(p => p.action === 'start' && p.session_id === linked).pop();
  ok(startL && startL.entry && !('restart_of' in startL.entry), 'a later session (other Type) carries no restart_of');
  await page.goto(base + '/ca/?src=e2e');
  await page.waitForSelector('.pt-head');
  ok((await st()).session_id === linked, 'plain /ca/ resumes the session in progress');

  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close();
  console.log(fail ? `${fail} FAILED` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
