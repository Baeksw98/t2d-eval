/**
 * End-to-end run of the GC site (/gc/) against tools/mock_gas_server.js, whose GC web app (gas/GcCode.gs, a separate
 * Apps Script project with its own spreadsheet) answers at /gc-exec.
 *
 *   node tools/mock_gas_server.js 8791 &
 *   node tools/e2e_gc.js [baseUrl=http://localhost:8791] [outDir] [--noendpoint] [--live] [--no-layout] [--allow-no-backend]
 *
 *   --noendpoint        ENDPOINT emptied (pure test mode: nothing is sent, done screen offers the JSON file)
 *   --live              no ?test=1 (sessions are not marked IsTest; default is test mode)
 *   --no-layout         skip the extra layout probes (Galaxy S8, iPad, iPhone landscape)
 *   --allow-no-backend  do not fail when the backend has no GC sheets (e.g. a server without the GC project)
 *
 * Runs
 *   1. iPhone 13: intro → eligibility "아니요" → blocked → back → eligible, profile, consent, Part A → all items
 *      (agree / disagree + corrected verdict + comment, an edit via [이전], a reload/resume, a fix from the
 *      final summary) → finish → "다른 Part 이어서" → Part B → finish.
 *   2. Desktop 1366×860: same with ?part=B preselected, then continuation into Part A.
 * Every screen: no horizontal scroll, no model names on the page. Whole run: no console errors.
 * Backend (GC spreadsheet via /__sheets?app=gc): GC_Sessions / GC_Judgments rows are checked field by field against
 * what was entered (verdicts, agreement flags, timing, Opened*, Eval_*, End_*), then /__gcsummary builds the GC summary
 * and GC_Adjudication / GC_Concordance are re-derived independently from GC_Judgments + gc_items.js (contract rules)
 * and compared; GC_Summary [1]/[4]/[5] are spot-checked. Exit code 1 if anything failed.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const pos = args.filter(a => !a.startsWith('--'));
const BASE = (pos[0] || 'http://localhost:8791').replace(/\/+$/, '').replace(/\/gc$/, '');
const OUT = pos[1] || path.join(os.tmpdir(), 'gc-e2e-shots');
const NO_ENDPOINT = flags.has('--noendpoint');
const TEST = !flags.has('--live');
const LAYOUT = !flags.has('--no-layout');
const ALLOW_NO_BACKEND = flags.has('--allow-no-backend');
const GC_EXEC = BASE + '/gc-exec';
fs.mkdirSync(OUT, { recursive: true });

const errors = [];
const notes = [];
const fail = (m) => { errors.push(m); console.log('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);

// GC config and data, read the same way the page reads them
function loadWindowScript(file) {
  const w = {};
  new Function('window', fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))(w);
  return w;
}
const GC_CONFIG = loadWindowScript('gc/gc-config.js').GC_CONFIG;
const GC_DATA = loadWindowScript('gc/data/gc_items.js').GC_DATA;
const ITEM = {};
Object.values(GC_DATA.units).forEach(u => u.items.forEach(it => { ITEM[it.id] = it; }));
const partItems = (pid) => GC_CONFIG.PARTS.find(p => p.id === pid).sequences[0].reduce((a, k) => a + GC_DATA.units[k].items.length, 0);
const altsFor = (it) => GC_CONFIG.VERDICTS.map(v => v.id).filter(v => v !== it.final);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newPage(browser, kind) {
  const opts = kind === 'desktop' ? { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 } : { ...devices[kind] };
  const ctx = await browser.newContext({ ...opts, locale: 'ko-KR', acceptDownloads: true });
  // ENDPOINT → this mock's GC web app /gc-exec (or empty for --noendpoint), whether or not the mock rewrites gc-config.js itself
  await ctx.route('**/gc/gc-config.js*', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/ENDPOINT:\s*'[^']*'/, `ENDPOINT: '${NO_ENDPOINT ? '' : GC_EXEC}'`);
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => fail(`[${kind}] pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const url = (m.location() && m.location().url) || '';
    if (/jsdelivr|fonts\.|pretendard/i.test(url + m.text())) return;   // web font CDN may be unreachable offline
    fail(`[${kind}] console error: ${m.text()} ${url}`);
  });
  return { ctx, page };
}

function makeRunner(page, kind) {
  let shot = 0;
  const S = () => page.evaluate(() => {
    const s = window.__GC_APP__.state();
    if (!s) return null;
    const steps = window.__GC_APP__.steps();
    const st = steps[s.stepIdx] || {};
    const it = (s.screen === 'eval' && st.i >= 0) ? window.GC_DATA.units[s.order[st.u]].items[st.i] : null;
    const k = steps.slice(0, s.stepIdx + 1).filter(x => x.i >= 0).length;
    return {
      screen: s.screen, stepIdx: s.stepIdx, review: s.review, u: st.u, i: st.i, nSteps: steps.length, itemId: it ? it.id : null,
      k, session_id: s.session_id, evaluator_id: s.evaluator_id, part: s.part, order: s.order, seq_source: s.seq_source,
      seq_index: s.seq_index, session_ordinal: s.session_ordinal, linked: s.linked_session_id, consent: s.consent,
      is_test: s.is_test, resumes: s.metrics.resumes, outbox: s.outbox.length, net: s.net, judgments: s.judgments, entry: s.entry
    };
  });
  const snap = async (label, full = false) => {
    shot++;
    await page.screenshot({ path: path.join(OUT, `${kind.replace(/\W+/g, '')}_${String(shot).padStart(2, '0')}_${label}.png`), fullPage: full });
  };
  const checkLayout = async (label) => {
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, w: window.innerWidth,
      text: document.body.innerText
    }));
    if (r.sw > r.w + 1) fail(`[${kind}] horizontal scroll on ${label}: scrollWidth ${r.sw} > ${r.w}`);
    const m = r.text.match(/gpt|deepseek|openai|gemini|claude|anthropic|20261118_ko/i);
    if (m) fail(`[${kind}] blinding: "${m[0]}" visible on ${label}`);
  };
  // the app ignores next/back for 450 ms after each screen change (double-tap guard) — act like a person
  const clickNext = async () => {
    const before = await S();
    await sleep(520);
    await page.click('[data-act="next"]');
    await page.waitForFunction(b => {
      const s = window.__GC_APP__.state();
      return s.screen !== b.screen || s.stepIdx !== b.stepIdx;
    }, { screen: before.screen, stepIdx: before.stepIdx });
  };
  const clickBack = async () => {
    const before = await S();
    await sleep(520);
    await page.click('[data-act="back"]');
    await page.waitForFunction(b => window.__GC_APP__.state().stepIdx !== b, before.stepIdx);
  };
  return { S, snap, checkLayout, clickNext, clickBack };
}

// deterministic decisions: item order k → agree, or disagree with one of the two other verdicts (+ comment)
function plan(k, it, sessionNo) {
  if ((k + sessionNo) % 3 === 0) {
    const alts = altsFor(it);
    const alt = alts[k % alts.length];
    const comment = k % 2 ? `E2E 비동의 ${k}: 답변에 해당 내용이 있음` : `=SUM(A1) 수식처럼 보이는 의견 ${k}`;
    return { agree: false, alt, comment };
  }
  return { agree: true };
}

async function decide(page, it, d, expected) {
  if (d.agree) {
    await page.click('[data-agree="1"]');
    expected[it.id] = { agree: true, phys: it.final, comment: '' };
  } else {
    await page.click('[data-agree="0"]');
    await page.click(`[data-alt="${d.alt}"]`);
    if (d.comment) await page.fill('#gcComment', d.comment);
    expected[it.id] = { agree: false, phys: d.alt, comment: d.comment || '' };
  }
}

async function intro(page, R, kind, firstPart, urlPart) {
  const q = new URLSearchParams({ reset: '1', src: 'e2e' });
  if (TEST) q.set('test', '1');
  if (urlPart) q.set('part', urlPart);
  await page.goto(`${BASE}/gc/?${q}`);
  await page.waitForSelector('#eligCard');
  if (await page.$('#evaluatorCard')) fail(`[${kind}] evaluator form visible before eligibility`);
  await R.checkLayout('intro');
  await R.snap('intro');
  // eligibility "아니요" → blocked screen with a link back to the CA site
  await page.click('[data-elig="no"]');
  await page.waitForSelector('#blocked');
  const href = await page.$eval('#toCaLink', a => a.href);
  if (href !== `${BASE}/`) fail(`[${kind}] blocked screen link → ${href}`); else ok('blocked screen links to ../');
  await R.checkLayout('blocked');
  await R.snap('blocked');
  await page.click('[data-act="elig-back"]');
  await page.waitForSelector('#eligCard');
  // eligible → form appears
  await page.click('[data-elig="yes"]');
  await page.waitForSelector('#evaluatorCard');
  if (urlPart) {
    const pre = await page.$eval(`[data-part="${urlPart}"]`, b => b.getAttribute('aria-pressed'));
    if (pre !== 'true') fail(`[${kind}] ?part=${urlPart} not preselected`); else ok(`?part=${urlPart} preselected`);
  }
  // start with nothing filled → stays on intro
  await page.click('#startBtn');
  await sleep(150);
  if (await page.evaluate(() => !!window.__GC_APP__.state())) fail(`[${kind}] session started without required fields`);
  await page.fill('#evName', kind === 'desktop' ? 'E2E 데스크톱' : 'E2E 모바일');
  await page.click('.seg[data-field="board_years"] button >> nth=2');
  await page.click('.seg[data-field="setting"] button >> nth=0');
  await page.click('.seg[data-field="t2d_volume"] button >> nth=1');
  await page.click(`[data-part="${firstPart}"]`);
  await page.click('#startBtn');   // no consent yet → still intro
  await sleep(150);
  if (await page.evaluate(() => !!window.__GC_APP__.state())) fail(`[${kind}] session started without consent`);
  await page.check('#evConsent');
  await R.checkLayout('intro filled');
  await R.snap('intro_filled', true);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__GC_APP__.state() && window.__GC_APP__.state().screen === 'eval', null, { timeout: 20000 });
}

async function runItems(page, R, kind, sessionNo, expected, extras) {
  const s0 = await R.S();
  let unitsSeen = 0;
  for (;;) {
    const s = await R.S();
    if (s.screen !== 'eval') break;
    if (s.i < 0) {
      unitsSeen++;
      await page.waitForSelector('.gc-combo');
      const n = await page.$$eval('.gc-combo', els => els.length);
      if (n !== 3) fail(`[${kind}] unit intro shows ${n} combinations`);
      await R.checkLayout(`unit ${s.u + 1}`);
      if (extras && s.u === 0) {
        await R.snap(`s${sessionNo}_unit${s.u + 1}`);
        await page.click('[data-act="patient"]');
        await page.waitForSelector('#drawer:not([hidden]) .lab-table');
        await R.snap(`s${sessionNo}_drawer`);
        await page.click('#drawerClose');
        await page.waitForSelector('#drawer', { state: 'hidden' });
      }
      await R.clickNext();
      continue;
    }
    const it = ITEM[s.itemId];
    const k = s.k;
    await page.waitForSelector('.gc-title');
    for (const sel of ['.gc-path', '.gc-crit', '.gc-answer', '.gc-rater', '.gc-audit', '.gc-final', '.gc-basis']) {
      if (!(await page.$(sel))) fail(`[${kind}] item ${it.id}: missing ${sel}`);
    }
    if (it.audit.mark === 'major' && it.audit.corrected && !(await page.$('.gc-compare'))) fail(`[${kind}] item ${it.id}: ✗ comparison missing`);
    const ask = await page.$eval('#gcAsk', e => e.textContent);
    const finalLabel = GC_CONFIG.VERDICTS.find(v => v.id === it.final).label;
    if (!ask.includes(finalLabel)) fail(`[${kind}] item ${it.id}: dock question "${ask}" lacks AI final "${finalLabel}"`);
    await R.checkLayout(`item ${k}`);

    if (extras && k === 1) {
      await R.snap(`s${sessionNo}_item1`);
      await R.snap(`s${sessionNo}_item1_full`, true);
      // [다음] without a decision does nothing
      await sleep(520);
      await page.click('[data-act="next"]', { force: true });
      await sleep(120);
      if ((await R.S()).stepIdx !== s.stepIdx) fail(`[${kind}] advanced without a decision`);
      // expanders → opened flags
      const crit = await page.$('[data-act="crit"]:not([hidden])');
      if (crit) await crit.click();
      await page.click('.gc-answer details.gc-more > summary');
      await page.click('details.gc-basis > summary');
      await page.waitForSelector('.gc-answer details.gc-more[open] .gc-full-row.cur');
      // agree, then change to disagree (changes ≥ 1), disagree needs a verdict before [다음] works
      await page.click('[data-agree="1"]');
      await page.click('[data-agree="0"]');
      await sleep(520);
      await page.click('[data-act="next"]', { force: true });
      await sleep(120);
      if ((await R.S()).stepIdx !== s.stepIdx) fail(`[${kind}] advanced on 비동의 without a corrected verdict`);
      const alt = altsFor(it)[1];
      await page.click(`[data-alt="${alt}"]`);
      await page.fill('#gcComment', 'E2E 첫 판정: 동의 → 비동의로 변경');
      expected[it.id] = { agree: false, phys: alt, comment: 'E2E 첫 판정: 동의 → 비동의로 변경' };
      await R.checkLayout('item 1 disagree');
      await R.snap(`s${sessionNo}_item1_disagree`);
      const j = (await R.S()).judgments[it.id];
      if (!(j.changes >= 1 && j.ttfd_ms != null)) fail(`[${kind}] changes/ttfd not recorded: ${JSON.stringify({ c: j.changes, t: j.ttfd_ms })}`);
      if (!(j.opened.full_answer && j.opened.basis && (j.opened.criterion || !crit))) fail(`[${kind}] opened flags not recorded: ${JSON.stringify(j.opened)}`);
      else ok('opened flags + ttfd + changes recorded');
    } else if (extras && k === 2) {
      await page.click('#patientBtn');
      await page.waitForSelector('#drawer:not([hidden])');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#drawer', { state: 'hidden' });
      await decide(page, it, plan(k, it, sessionNo), expected);
      if (!(await R.S()).judgments[it.id].opened.patient) fail(`[${kind}] opened.patient not recorded`);
    } else {
      await decide(page, it, plan(k, it, sessionNo), expected);
    }

    if (extras && k === 3) {
      // go back one item, change that judgment, come forward again (re-sent as an upsert)
      await R.clickBack();
      const prev = await R.S();
      const pit = ITEM[prev.itemId];
      const was = expected[pit.id];
      const pressed = await page.$eval(was.agree ? '[data-agree="1"]' : '[data-agree="0"]', b => b.getAttribute('aria-pressed'));
      if (pressed !== 'true') fail(`[${kind}] previous decision not restored on [이전]`);
      if (was.agree) {
        await page.click('[data-agree="0"]');
        await page.click(`[data-alt="${altsFor(pit)[0]}"]`);
        await page.fill('#gcComment', 'E2E 이전으로 돌아가 수정');
        expected[pit.id] = { agree: false, phys: altsFor(pit)[0], comment: 'E2E 이전으로 돌아가 수정' };
      } else {
        await page.click('[data-agree="1"]');
        expected[pit.id] = { agree: true, phys: pit.final, comment: '' };
      }
      await R.clickNext();
      ok('edited a previous judgment via [이전]');
    }
    if (extras && k === 5) {
      // reload mid-item → resume with the decision kept
      await page.reload();
      await page.waitForSelector('.gc-title');
      const r = await R.S();
      if (r.resumes < 1 || r.itemId !== it.id) fail(`[${kind}] resume failed (${r.resumes}, ${r.itemId})`);
      else ok('reload resumes on the same item');
    }
    await R.clickNext();
  }
  if (unitsSeen !== 2) fail(`[${kind}] saw ${unitsSeen} unit intros`);
  return s0;
}

async function finalAndSubmit(page, R, kind, sessionNo, expected, extras) {
  await page.waitForSelector('#submitBtn');
  await R.checkLayout('final');
  if (extras) {
    await R.snap(`s${sessionNo}_final`, true);
    // submit without the required end items → stays
    await sleep(500);
    await page.click('#submitBtn');
    await sleep(150);
    if ((await R.S()).screen !== 'final') fail(`[${kind}] submitted without end items`);
    // fix one judgment from the summary list → back to the summary
    await page.click('.gc-recap [data-edit] >> nth=1');
    await page.waitForSelector('.gc-title');
    const s = await R.S();
    if (!s.review || (await page.$('[data-act="back"]'))) fail(`[${kind}] review mode not shown`);
    const it = ITEM[s.itemId];
    const was = expected[it.id];
    if (was.agree) {
      await page.click('[data-agree="0"]');
      await page.click(`[data-alt="${altsFor(it)[1]}"]`);
      // a comment typed earlier for this item (before switching to 동의) comes back in the textarea and is sent
      const kept = (await page.$eval('#gcComment', t => t.value)).trim();
      expected[it.id] = { agree: false, phys: altsFor(it)[1], comment: kept };
    } else {
      await page.click('[data-agree="1"]');
      expected[it.id] = { agree: true, phys: it.final, comment: '' };
    }
    await R.clickNext();
    await page.waitForSelector('#submitBtn');
    ok('fixed a judgment from the final summary');
  }
  await page.click('.seg[data-field="info_sufficient"] button >> nth=3');
  await page.click('.seg[data-field="hitl_acceptable"] button >> nth=' + (sessionNo % 2 ? 4 : 2));
  await page.fill('#overallComment', `E2E 전체 의견 ${kind} ${sessionNo}`);
  await sleep(500);
  await page.click('#submitBtn');
  await page.waitForSelector('.status-line');
  await page.waitForFunction(() => document.querySelector('.status-line.ok, .status-line.fail') ||
    /테스트 모드/.test((document.querySelector('.status-line') || {}).textContent || ''), null, { timeout: 40000 }).catch(() => {});
  await R.checkLayout('done');
  const st = await R.S();
  const status = await page.$eval('.status-line', e => e.className.replace('status-line', '').trim());
  if (extras) await R.snap(`s${sessionNo}_done`);
  return { st, status };
}

async function runFlow(browser, kind, firstPart, urlPart) {
  console.log(`\n=== ${kind}: Part ${firstPart} → continuation ===`);
  const { ctx, page } = await newPage(browser, kind);
  const R = makeRunner(page, kind);
  const sessions = [];
  const expected1 = {};
  await intro(page, R, kind, firstPart, urlPart);
  const s1 = await R.S();
  ok(`session 1 Part ${s1.part}, order ${s1.order.join(' > ')}, seq ${s1.seq_index} (${s1.seq_source})`);
  if (s1.is_test !== (TEST || NO_ENDPOINT)) fail(`[${kind}] is_test = ${s1.is_test}`);
  await runItems(page, R, kind, 1, expected1, true);
  const d1 = await finalAndSubmit(page, R, kind, 1, expected1, true);
  sessions.push({ ...d1.st, expected: expected1, status: d1.status, part: firstPart, reloaded: true });
  if (kind !== 'desktop' && (await page.$('#dlBtn'))) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlBtn')]);
    const j = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    if (j.judgments.length !== partItems(firstPart)) fail(`[${kind}] JSON backup has ${j.judgments.length} judgments`);
    else ok('JSON backup downloads with all judgments');
  }

  // continuation into the other Part
  const other = GC_CONFIG.PARTS.map(p => p.id).find(p => p !== firstPart);
  await page.click(`[data-next-part="${other}"]`);
  await page.waitForSelector('#evaluatorCard');
  if (await page.$('#evConsent')) fail(`[${kind}] continuation asks for consent again`);
  if (await page.$('#evName')) fail(`[${kind}] continuation asks for the profile again`);
  if ((await page.$eval(`[data-part="${firstPart}"]`, b => b.disabled)) !== true) fail(`[${kind}] finished Part still selectable`);
  if ((await page.$eval(`[data-part="${other}"]`, b => b.getAttribute('aria-pressed'))) !== 'true') fail(`[${kind}] other Part not preselected`);
  await R.checkLayout('continuation intro');
  await R.snap('continuation_intro');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__GC_APP__.state() && window.__GC_APP__.state().screen === 'eval', null, { timeout: 20000 });
  const s2 = await R.S();
  if (s2.session_ordinal !== 2) fail(`[${kind}] session_ordinal ${s2.session_ordinal}`);
  if (s2.linked !== s1.session_id) fail(`[${kind}] linked_session_id ${s2.linked} ≠ ${s1.session_id}`);
  if (s2.evaluator_id !== s1.evaluator_id) fail(`[${kind}] evaluator_id changed in continuation`);
  if (!s2.consent.inherited) fail(`[${kind}] consent not marked inherited`);
  if (s2.part !== other) fail(`[${kind}] continuation part ${s2.part}`);
  ok(`session 2 Part ${s2.part}, ordinal 2, linked to session 1, same evaluator_id`);
  const expected2 = {};
  await runItems(page, R, kind, 2, expected2, false);
  const d2 = await finalAndSubmit(page, R, kind, 2, expected2, false);
  sessions.push({ ...d2.st, expected: expected2, status: d2.status, part: other });
  // finished both Parts → no further continuation offered
  if (await page.$('[data-next-part]')) fail(`[${kind}] continuation offered after both Parts`);
  for (const s of sessions) {
    const n = Object.keys(s.expected).length, want = partItems(s.part);
    if (n !== want) fail(`[${kind}] Part ${s.part}: ${n} judgments entered, expected ${want}`);
    const judg = s.judgments;
    Object.keys(s.expected).forEach(id => {
      const j = judg[id], e = s.expected[id];
      if (!j || j.agree !== e.agree) fail(`[${kind}] state ${id}: agree ${j && j.agree} ≠ ${e.agree}`);
      if (j && !(j.active_ms > 0) ) fail(`[${kind}] state ${id}: no active time`);
    });
    console.log(`  · Part ${s.part}: ${n} judgments, send status "${s.status}", outbox ${s.outbox}, net ${s.net.status}${s.net.last_error ? ' (' + s.net.last_error + ')' : ''}`);
  }
  await ctx.close();
  return sessions;
}

// short layout probes on other form factors (no horizontal scroll on intro, unit intro, item + disagree dock)
async function layoutProbe(browser, kind) {
  const { ctx, page } = await newPage(browser, kind);
  const R = makeRunner(page, kind);
  const q = new URLSearchParams({ reset: '1', src: 'e2e-layout', test: '1' });
  await page.goto(`${BASE}/gc/?${q}`);
  await page.waitForSelector('#eligCard');
  await page.click('[data-elig="yes"]');
  await page.fill('#evName', 'E2E 레이아웃');
  for (const f of ['board_years', 'setting', 't2d_volume']) await page.click(`.seg[data-field="${f}"] button >> nth=0`);
  await page.click('[data-part="A"]');
  await page.check('#evConsent');
  await R.checkLayout('intro');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__GC_APP__.state() && window.__GC_APP__.state().screen === 'eval', null, { timeout: 20000 });
  await page.waitForSelector('.gc-combo');
  await R.checkLayout('unit');
  await R.clickNext();
  await page.waitForSelector('.gc-title');
  await page.click('[data-agree="0"]');
  await page.click('.gc-answer details.gc-more > summary');
  await R.checkLayout('item + disagree');
  // the decision buttons must stay reachable on screen
  const box = await page.$eval('[data-act="next"]', b => { const r = b.getBoundingClientRect(); return { b: r.bottom, h: window.innerHeight }; });
  if (box.b > box.h + 1 && kind.indexOf('landscape') < 0) fail(`[${kind}] [다음] below the viewport`);
  await R.snap('probe_item');
  ok(`${kind}: layout ok`);
  await ctx.close();
}

async function checkBackend(allSessions) {
  console.log('\n=== backend sheets ===');
  if (NO_ENDPOINT) { console.log('  (skipped: --noendpoint)'); return; }
  let sheets;
  try { sheets = await (await fetch(BASE + '/__sheets?app=gc')).json(); } catch (e) { fail('cannot read /__sheets?app=gc: ' + e.message); return; }
  if (!sheets.GC_Sessions || !sheets.GC_Judgments || !sheets.GC_Sessions.length) {
    if (!ALLOW_NO_BACKEND) { fail('GC_Sessions / GC_Judgments missing in the GC backend (/__sheets?app=gc) — backend checks could not run'); return; }
    console.log('  SKIP: GC_Sessions / GC_Judgments do not exist in this backend (--allow-no-backend).');
    notes.push('backend checks skipped (no GC sheets)');
    allSessions.forEach(s => { if (s.status !== 'fail' && s.status !== 'ok') fail(`unexpected send status ${s.status}`); });
    return;
  }
  if (sheets.Sessions || sheets.Responses || sheets.RawJSON) fail('CA sheets found in the GC spreadsheet');
  const table = (name) => {
    const rows = sheets[name] || [];
    const h = rows[0] || [];
    return rows.slice(1).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  };
  const S = table('GC_Sessions'), J = table('GC_Judgments'), V = table('Visits');
  let timingExact = 0;
  allSessions.forEach((s, n) => {
    const tag = `session ${n + 1} (Part ${s.part})`;
    if (s.status !== 'ok') fail(`${tag}: done screen send status "${s.status}" (expected ok)`);
    const rows = S.filter(r => r.SessionId === s.session_id);
    if (rows.length !== 1) { fail(`${tag}: ${rows.length} GC_Sessions rows`); return; }
    const r = rows[0];
    const exp = s.expected, ids = Object.keys(exp);
    const nAgree = ids.filter(id => exp[id].agree).length;
    const want = {
      Part: s.part, Status: 'completed', IsTest: !!(TEST), ItemsTotal: ids.length, ItemsDone: ids.length,
      AgreeN: nAgree, DisagreeN: ids.length - nAgree, SessionOrdinal: s.session_ordinal,
      LinkedSessionId: s.linked || '', EvaluatorId: s.evaluator_id, SeqSource: s.seq_source, SequenceIndex: s.seq_index,
      Src: 'e2e', ConsentInherited: !!s.consent.inherited, ConsentVersion: GC_CONFIG.CONSENT_VERSION,
      // profile entered on the intro (continuation inherits it): board_years nth=2, setting nth=0, t2d_volume nth=1
      Eval_board_years: GC_CONFIG.PROFILE_FIELDS[0].options[2], Eval_board_years_code: 3,
      Eval_setting: GC_CONFIG.PROFILE_FIELDS[1].options[0], Eval_setting_code: 1,
      Eval_t2d_volume: GC_CONFIG.PROFILE_FIELDS[2].options[1], Eval_t2d_volume_code: 2,
      // end items: info_sufficient nth=3; hitl_acceptable nth=4 (session 1) / nth=2 (session 2)
      End_info_sufficient: GC_CONFIG.END_ITEMS[0].options[3], End_info_sufficient_code: 4,
      End_hitl_acceptable: GC_CONFIG.END_ITEMS[1].options[s.session_ordinal === 1 ? 4 : 2], End_hitl_acceptable_code: s.session_ordinal === 1 ? 5 : 3,
      Resumes: s.resumes
    };
    Object.keys(want).forEach(k => { if (r[k] !== want[k]) fail(`${tag}: GC_Sessions.${k} = ${JSON.stringify(r[k])}, expected ${JSON.stringify(want[k])}`); });
    if (!/^GT?\d{3}$/.test(String(r.EvaluatorCode))) fail(`${tag}: EvaluatorCode ${r.EvaluatorCode}`);
    // the mid-session reload fires a gc_progress beacon (pagehide) → drop-off point recorded
    if (s.reloaded && !(Number(r.FurthestUnit) >= 1 && Number(r.FurthestItem) >= 1)) fail(`${tag}: FurthestUnit/FurthestItem not recorded (${r.FurthestUnit}/${r.FurthestItem})`);
    if (!r.End_info_sufficient || !r.End_hitl_acceptable) fail(`${tag}: End_* items missing`);
    if (!String(r.OverallComment).startsWith('E2E 전체 의견')) fail(`${tag}: OverallComment ${r.OverallComment}`);
    if (!(Number(r.TotalActiveMin) >= 0) || r.FinishedAt === '') fail(`${tag}: session timing missing`);
    const jr = J.filter(x => x.SessionId === s.session_id);
    if (jr.length !== ids.length) fail(`${tag}: ${jr.length} GC_Judgments rows, expected ${ids.length}`);
    jr.forEach(x => {
      const e = exp[x.ItemId], it = ITEM[x.ItemId];
      if (!e || !it) { fail(`${tag}: unexpected judgment row ${x.ItemId}`); return; }
      const w = {
        Agree: e.agree, PhysVerdict: e.phys, PhysVerdict_code: GC_CONFIG.VERDICTS.findIndex(v => v.id === e.phys) + 1,
        Comment: e.comment, AIFinal: it.final, RaterVerdict: it.rater.verdict, AuditMark: it.audit.mark,
        TargetKey: it.target_key, Part: s.part, SessionOrdinal: s.session_ordinal, IsTest: !!TEST,
        AgreeWithAIFinal: e.phys === it.final, AgreeWithRater: e.phys === it.rater.verdict
      };
      // timing + opened flags = what the client sent with the latest change of this judgment (client state at the end)
      const cj = (s.judgments || {})[x.ItemId] || {};
      const sec = ms => Math.round(Math.round(ms) / 100) / 10;
      cj.item_ms = (cj.active_ms || 0) + (cj.idle_ms || 0);   // client payload item_ms = active + idle (visible)
      w.Changes = cj.changes;
      w.OpenedCriterion = !!(cj.opened || {}).criterion; w.OpenedFullAnswer = !!(cj.opened || {}).full_answer;
      w.OpenedBasis = !!(cj.opened || {}).basis; w.OpenedPatient = !!(cj.opened || {}).patient;
      Object.keys(w).forEach(k => { if (x[k] !== w[k]) fail(`${tag}: ${x.ItemId} ${k} = ${JSON.stringify(x[k])}, expected ${JSON.stringify(w[k])}`); });
      if (!(Number(x.ItemSec) > 0)) fail(`${tag}: ${x.ItemId} ItemSec ${x.ItemSec}`);
      if (x.TTFDSec === '' || x.TTFDSec == null) fail(`${tag}: ${x.ItemId} TTFDSec empty`);
      // the server keeps the timing sent with the last CHANGE of a judgment (an unchanged re-send is skipped), so the
      // stored values never exceed the client's final totals and match them for items that were not revisited
      if (!(x.ItemSec <= sec(cj.item_ms) + 0.05 && x.ActiveSec <= sec(cj.active_ms) + 0.05 && x.ActiveSec <= x.ItemSec + 0.05 &&
        x.TTFDSec <= x.ItemSec + 0.05)) fail(`${tag}: ${x.ItemId} timing ${x.ItemSec}/${x.ActiveSec}/${x.TTFDSec} vs client ${sec(cj.item_ms)}/${sec(cj.active_ms)}/${sec(cj.ttfd_ms)}`);
      if (x.TTFDSec !== sec(cj.ttfd_ms)) fail(`${tag}: ${x.ItemId} TTFDSec ${x.TTFDSec} ≠ client ${sec(cj.ttfd_ms)}`);
      if (x.ItemSec === sec(cj.item_ms)) timingExact++;
    });
    if (!errors.some(e => e.startsWith(tag))) ok(`${tag}: GC_Sessions row + ${jr.length} GC_Judgments rows match`);
  });
  const nJ = J.filter(x => allSessions.some(s => s.session_id === x.SessionId)).length;
  ok(`timing columns (ItemSec/ActiveSec/TTFDSec) consistent; ItemSec equal to the client total for ${timingExact}/${nJ} judgments (the rest were revisited after the last change)`);
  const opened = J.filter(x => allSessions.some(s => s.session_id === x.SessionId) && (x.OpenedCriterion === true || x.OpenedFullAnswer === true || x.OpenedBasis === true)).length;
  if (!opened) fail('no Opened* flags stored'); else ok(`Opened* flags stored (${opened} rows)`);
  const visits = V.filter(v => v.Src === 'e2e' && /gc/i.test(String(v.AppVersion)));
  if (!visits.length) fail('no Visits row for the GC intro (view beacon)'); else ok(`view beacon stored (${visits.length} Visits rows)`);
  await checkSummary(J, S, V);
}

/**
 * buildGcSummary on the GC backend (/__gcsummary), then an independent re-derivation of GC_Adjudication and
 * GC_Concordance from GC_Judgments + gc_items.js with the contract rules (docs/GC_CONTRACT.md), plus spot checks of GC_Summary.
 */
async function checkSummary(J, S, V) {
  console.log('\n=== GC summary (buildGcSummary' + (TEST ? 'IncludingTests' : '') + ') ===');
  let out;
  try { out = await (await fetch(BASE + '/__gcsummary' + (TEST ? '?tests=1' : ''))).json(); } catch (e) { fail('cannot run /__gcsummary: ' + e.message); return; }
  if (out.error) { fail('buildGcSummary threw: ' + out.error); return; }
  const tab = (rows) => rows.slice(1).map(r => Object.fromEntries(rows[0].map((k, i) => [k, r[i]])));
  const ADJ = tab(out.GC_Adjudication), CONC = tab(out.GC_Concordance), SUM = out.GC_Summary;
  const allItems = Object.values(GC_DATA.units).reduce((a, u) => a.concat(u.items), []);
  if (ADJ.length !== allItems.length) fail(`GC_Adjudication has ${ADJ.length} rows, expected ${allItems.length}`);
  // votes: counted rows (test rows only in test mode), one per EvaluatorCode per item, latest AnsweredAt wins
  const pool = J.filter(x => TEST || x.IsTest !== true).filter(x => ['met', 'deducted', 'not_applicable'].indexOf(x.PhysVerdict) >= 0);
  const votes = {};
  pool.forEach(x => {
    const v = votes[x.ItemId] = votes[x.ItemId] || {};
    const prev = v[x.EvaluatorCode];
    if (!prev || Date.parse(x.AnsweredAt) >= Date.parse(prev.AnsweredAt)) v[x.EvaluatorCode] = x;
  });
  const adjExp = {};
  let nVotes = 0, nAgreeFinal = 0, nAgreeRater = 0;
  allItems.forEach(it => {
    const vs = Object.values(votes[it.id] || {}).map(x => x.PhysVerdict);
    nVotes += vs.length; nAgreeFinal += vs.filter(v => v === it.final).length; nAgreeRater += vs.filter(v => v === it.rater.verdict).length;
    const cnt = { met: 0, deducted: 0, not_applicable: 0 };
    vs.forEach(v => { cnt[v]++; });
    const n = vs.length;
    const best = ['met', 'deducted', 'not_applicable'].reduce((b, k) => (cnt[k] > cnt[b] ? k : b), 'met');
    let adj = it.final, status = '대기';
    if (n && cnt[best] * 2 > n) { adj = best; status = n === 1 ? '잠정(1인)' : (cnt[best] === n ? '확정(만장일치)' : '확정(다수결)'); }
    else if (n) status = '추가 검토 필요';
    adjExp[it.id] = { n, adj, status, cnt };
    const row = ADJ.find(r => r.ItemId === it.id);
    if (!row) { fail(`GC_Adjudication: no row for ${it.id}`); return; }
    const got = [row.N, row.Met, row.Deducted, row.NotApplicable, row.Adjudicated, row.Status, row.AIFinal].join('|');
    const want = [n, cnt.met, cnt.deducted, cnt.not_applicable, adj, status, it.final].join('|');
    if (got !== want) fail(`GC_Adjudication ${it.id}: ${got} ≠ expected ${want}`);
  });
  const statusN = {};
  Object.values(adjExp).forEach(e => { statusN[e.status] = (statusN[e.status] || 0) + 1; });
  ok(`GC_Adjudication: ${ADJ.length} items match the contract rules (${Object.keys(statusN).map(k => k + ' ' + statusN[k]).join(', ')})`);
  // concordance: start from concordance_base (met_ai, n); adjudicated ≠ AI final moves met/deducted or removes n/a
  let concN = 0;
  Object.values(GC_DATA.units).forEach(u => Object.keys(u.concordance_base).forEach(k => {
    const b = u.concordance_base[k];
    let n = b.n, met = b.met_ai;
    u.items.filter(it => it.target_key === k).forEach(it => {
      const e = adjExp[it.id];
      if (!e || e.adj === it.final) return;
      if (e.adj === 'not_applicable') { n--; if (it.final === 'met') met--; } else if (e.adj === 'met') met++; else met--;
    });
    const row = CONC.find(r => r.TargetKey === k);
    const score = n > 0 ? Math.round(met / n * 10000) / 10000 : '';
    if (!row) { fail(`GC_Concordance: no row for ${k}`); return; }
    const got = [row.N_AI, row.Met_AI, row.N_Adj, row.Met_Adj, row.ConcordanceScore].join('|'), want = [b.n, b.met_ai, n, met, score].join('|');
    if (got !== want) fail(`GC_Concordance ${k}: ${got} ≠ expected ${want}`);
    concN++;
  }));
  if (CONC.length !== concN) fail(`GC_Concordance has ${CONC.length} rows, expected ${concN}`);
  else ok(`GC_Concordance: ${concN} TargetKeys re-derived (N_Adj, Met_Adj, ConcordanceScore)`);
  // GC_Summary spot checks
  const section = (n) => { const i = SUM.findIndex(r => String(r[0]).startsWith('[' + n + ']')); const j = SUM.findIndex((r, k) => k > i && /^\[\d+\]/.test(String(r[0]))); return i < 0 ? [] : SUM.slice(i, j < 0 ? SUM.length : j); };
  for (let i = 0; i <= 8; i++) if (!section(i).length) fail(`GC_Summary: section [${i}] missing`);
  const pool2 = S.filter(r => TEST || r.IsTest !== true);
  const s1 = section(1).find(r => r[0] === '전체') || [];
  const completed = pool2.filter(r => r.Status === 'completed').length;
  if (s1[3] !== pool2.length || s1[6] !== completed) fail(`GC_Summary [1]: sessions ${s1[3]}/${s1[6]} ≠ ${pool2.length}/${completed}`);
  const s4 = section(4).find(r => r[0] === '전체' && r[2] === nVotes) || [];
  if (s4[3] !== nAgreeFinal || s4[7] !== nAgreeRater) fail(`GC_Summary [4]: agree final/rater ${s4[3]}/${s4[7]} ≠ ${nAgreeFinal}/${nAgreeRater} (n ${nVotes})`);
  const s5 = section(5);
  ['Part A', 'Part B'].forEach(p => {
    const r = s5.find(x => x[0] === p) || [];
    const items = allItems.filter(it => GC_CONFIG.PARTS.find(q => q.id === p.slice(-1)).sequences[0].indexOf(it.unit) >= 0);
    const ns = items.map(it => adjExp[it.id].n);
    const sameN = ns.every(n => n === ns[0]) && ns[0] >= 2;
    if (sameN && typeof r[6] !== 'number') fail(`GC_Summary [5] ${p}: Fleiss κ missing although every item has n = ${ns[0]}`);
    if (!sameN && r[6] !== '') fail(`GC_Summary [5] ${p}: κ ${r[6]} although item n differ`);
  });
  const names = S.map(r => String(r.EvaluatorName)).filter(Boolean);
  const leak = ['GC_Summary', 'GC_Adjudication', 'GC_Concordance'].some(n => out[n].some(r => r.some(v => names.indexOf(String(v)) >= 0)));
  if (leak) fail('physician names appear in the GC summary sheets');
  if (!out.GC_Codebook.length || out.GC_Codebook.slice(1).some(r => String(r[2]).indexOf('설명 없음') >= 0)) fail('GC_Codebook missing or has undocumented columns');
  ok(`GC_Summary: [0]–[8] present; [1] ${pool2.length} sessions / ${completed} completed; [4] AI final agreement ${nAgreeFinal}/${nVotes}, raw Rater ${nAgreeRater}/${nVotes}; [5] κ ` +
    (s5.filter(x => /^Part/.test(x[0])).map(x => x[0] + ' ' + (x[6] === '' ? '—' : x[6])).join(', ')) + '; no names; GC_Codebook complete');
}

(async () => {
  console.log(`GC e2e → ${BASE}/gc/  (${NO_ENDPOINT ? 'no ENDPOINT' : 'ENDPOINT ' + BASE + '/exec'}, ${TEST ? 'test sessions' : 'live sessions'}), screenshots: ${OUT}`);
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const all = [];
  all.push(...await runFlow(browser, 'iPhone 13', 'A', ''));
  all.push(...await runFlow(browser, 'desktop', 'B', 'B'));
  if (LAYOUT) {
    console.log('\n=== layout probes ===');
    for (const k of ['Galaxy S8', 'iPad (gen 7)', 'iPhone 13 landscape']) await layoutProbe(browser, k);
  }
  await sleep(800);   // let the last beacons land
  await checkBackend(all);
  await browser.close();
  console.log(`\n${errors.length ? 'FAILED' : 'PASSED'}: ${errors.length} problem(s)${notes.length ? ' · ' + notes.join('; ') : ''}`);
  if (errors.length) { errors.forEach(e => console.log(' - ' + e)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
