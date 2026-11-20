/**
 * End-to-end run against tools/mock_gas_server.js (or any server that serves the site).
 * Usage: node tools/e2e.js <baseUrl> <outDir> [device=mobile|desktop] [name] [role=resident|specialist|intern|all] [type=A|B]
 *   <baseUrl> is the site root (e.g. http://localhost:8787/) or the CA page itself (…/ca/): the CA evaluation lives at
 *   /ca/ since the landing page took over /, so a site root gets 'ca/' appended. Anything else is used as given.
 *   role 'all' runs the intern, resident and specialist paths one after another (fresh browser context each).
 * Per role: fills the intro (v3.4 profile: role-specific items + the single AI-use question 'ai_freq'), checks that
 * starting without the AI question names it ('AI 사용 빈도를 선택해 주세요.'), completes both cases of the Type with
 * deterministic answers, submits, and checks the evaluator payload (field set per role, ai_freq code). If <baseUrl>
 * serves /__sheets (the mock), also checks the Sessions row (Eval_ai_freq / _code). Screenshots go to <outDir>
 * (case-step shots for the first role only). Prints one JSON line per role; exit 1 if any role reported errors.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const AI_FREQ_PICK = 3;                         // 0-based → '주 3–6회', code 4
const AI_FREQ_LABEL = '주 3–6회';
const EXPECT_FIELDS = {                          // evaluator.fields keys sent for each role (config.js v3.4)
  intern: ['ai_freq'],
  resident: ['year', 'ai_freq'],
  specialist: ['specialty', 'board_years', 'ai_freq']
};
const LEGACY_IDS = ['major', 't2d_volume', 'ai_use', 'ai_trust'];   // v3.3 questions that must no longer be shown

(async () => {
  const base = caUrl(process.argv[2] || 'http://localhost:8787/');
  const outDir = process.argv[3] || 'shots';
  const kind = process.argv[4] || 'mobile';
  const evName = process.argv[5] || '테스트평가자';
  const roleArg = process.argv[6] || 'resident';
  const studyType = process.argv[7] || 'A';
  const roles = roleArg === 'all' ? ['intern', 'resident', 'specialist'] : [roleArg];
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  let failed = 0;
  for (let ri = 0; ri < roles.length; ri++) {
    const res = await runRole(browser, { base, outDir, kind, evName: roles.length > 1 ? evName + '-' + roles[ri] : evName, role: roles[ri], studyType, detail: ri === 0 });
    console.log(JSON.stringify(res));
    if (res.errors.length) failed++;
  }
  await browser.close();
  if (failed) { console.error(`e2e: ${failed} role path(s) reported errors`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

// site root → CA page (/ca/). A URL whose path already names a page (…/ca/, …/index.html, a temp copy) is kept.
function caUrl(u) {
  const x = new URL(u);
  if (x.pathname === '/' || x.pathname === '') x.pathname = '/ca/';
  return x.toString();
}

async function runRole(browser, { base, outDir, kind, evName, role, studyType, detail }) {
  const ctxOpts = kind === 'mobile' ? { ...devices['iPhone 13'] } : { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 };
  const ctx = await browser.newContext({ ...ctxOpts, locale: 'ko-KR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // the app ignores next/back for 450 ms after each screen change (double-tap guard) — act like a person
  const clickNext = async () => { await page.waitForTimeout(500); await page.click('[data-act="next"]'); };
  const clickBack = async () => { await page.waitForTimeout(500); await page.click('[data-act="back"]'); };
  let shot = 0;
  const snap = async (label, full = false) => {
    shot++;
    await page.screenshot({ path: path.join(outDir, `${role}_${String(shot).padStart(2, '0')}_${kind}_${label}.png`), fullPage: full });
  };

  await page.goto(base + (base.includes('?') ? '&' : '?') + 'reset=1&src=e2e&site=S1');
  await page.waitForSelector('#evName');
  await snap('intro_top');
  // intro only: discreet links back to the landing page (../) and About (../about/), carrying src·site·wave only
  if (new URL(page.url()).pathname.endsWith('/ca/')) {
    const links = await page.evaluate(() => ({ home: (document.getElementById('homeLink') || {}).href, about: (document.getElementById('aboutLink') || {}).href }));
    const root = new URL('../', page.url()).toString();
    if (links.home !== root + '?src=e2e&site=S1') errors.push('intro home link → ' + links.home);
    if (links.about !== root + 'about/?src=e2e&site=S1') errors.push('intro About link → ' + links.about);
  }
  await page.fill('#evName', evName);
  await page.click(`#roleSeg button[data-role="${role}"]`);
  if (role === 'resident') {
    await page.click('#roleFields .seg[data-field="year"] button[data-value="R2"]');
  }
  if (role === 'specialist') {
    await page.selectOption('#fld_ev_specialty', '기타 (직접 입력)');
    await page.fill('[data-other="specialty"]', '=임상약리학');
    await page.click('#roleFields .seg[data-field="board_years"] button[data-value="5–9년"]');
  }
  // v3.4 profile: role-specific items only (intern: none), one common AI question, no legacy questions
  const shown = await page.evaluate(() => Array.from(document.querySelectorAll('#evaluatorCard [data-field]')).map(x => x.getAttribute('data-field')));
  const wantShown = EXPECT_FIELDS[role].filter(id => id !== 'ai_freq');
  const roleShown = await page.evaluate(() => Array.from(document.querySelectorAll('#roleFields [data-field]')).map(x => x.getAttribute('data-field')));
  if (roleShown.join() !== wantShown.join()) errors.push(`role fields shown [${roleShown}] ≠ [${wantShown}]`);
  if (role === 'intern' && (await page.$eval('#roleFields', el => el.innerHTML.trim())) !== '') errors.push('intern: role-specific block is not empty');
  LEGACY_IDS.forEach(id => { if (shown.indexOf(id) >= 0) errors.push('legacy question still shown: ' + id); });
  if (shown.indexOf('ai_freq') < 0) errors.push('ai_freq question missing');
  await page.click(`#typeSeg button[data-type="${studyType}"]`);
  await page.waitForTimeout(100);   // headless click-after-scroll race; a person is never this fast
  await page.check('#evConsent');
  // start without the AI question → the toast must name it and the session must not start
  await page.click('#startBtn');
  await page.waitForTimeout(300);
  const toastText = (await page.textContent('#toast')) || '';
  if (toastText.trim() !== 'AI 사용 빈도를 선택해 주세요.') errors.push('missing-AI toast was: ' + JSON.stringify(toastText));
  if (await page.evaluate(() => !!window.__T2D_APP__.state())) errors.push('session started without the AI question');
  if (!(await page.$('#commonFields .field.missing'))) errors.push('missing AI question was not highlighted');
  await page.waitForTimeout(400);
  await snap('intro_missing_ai');
  await page.click(`#commonFields .seg[data-field="ai_freq"] button >> nth=${AI_FREQ_PICK}`);
  await snap('intro_filled', true);
  await page.waitForTimeout(500);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__T2D_APP__ && window.__T2D_APP__.state() && window.__T2D_APP__.state().screen === 'case');

  const nCases = await page.evaluate(() => window.__T2D_APP__.state().order.length);
  for (let ci = 0; ci < nCases; ci++) {
    // vignette
    await page.waitForSelector('.pt-head');
    await page.waitForTimeout(150);
    if (await page.$('.site-links')) errors.push('site links (home/About) shown during a case');
    if (detail && ci < 2) await snap(`c${ci + 1}_vignette`);
    if (detail && ci === 0) await snap(`c${ci + 1}_vignette_full`, true);
    await clickNext();
    // p1
    await page.waitForSelector('.likert button[data-rate]');
    if (detail && ci === 0) await snap(`c${ci + 1}_p1`);
    // try next without rating -> should not advance
    await page.waitForTimeout(500); await page.click('[data-act="next"]', { force: true });
    const st1 = await page.evaluate(() => window.__T2D_APP__.state().stepIdx);
    if (st1 !== 1) errors.push('advanced without rating at p1');
    await page.click(`.likert button[data-rate="${(ci % 5) + 1}"]`);
    await page.click(`.likert button[data-rate="4"]`); // change -> changes=1
    await clickNext();
    // combo
    await page.waitForSelector('.combo-card');
    if (detail && ci === 0) { await snap(`c${ci + 1}_combo`); await snap(`c${ci + 1}_combo_full`, true); }
    const comboPick = (ci % 3) + 1;
    await page.waitForTimeout(500);
    // opening the prescription details must NOT select the card
    await page.click(`.combo-card[data-combo="${comboPick}"] .cc-rx summary`);
    if ((await page.evaluate(() => window.__T2D_APP__.state().stepIdx)) !== 2) errors.push('details toggle advanced the step');
    await page.click(`.combo-card[data-combo="${comboPick}"] .cc-drugs`);   // tap the box → fly to top → Phase 2
    if (detail && ci === 0) { await page.waitForTimeout(330); await snap(`c${ci + 1}_combo_flying`); }
    await page.waitForFunction(() => window.__T2D_APP__.state().stepIdx === 3);
    await page.waitForTimeout(900);
    if (detail && ci === 0) await snap(`c${ci + 1}_p2_arrived`);
    if (await page.$('.combo-card.fly')) errors.push('flying clone left behind');
    for (const k of ['p2', 'p3', 'p4', 'p5']) {
      await page.waitForSelector('.likert button[data-rate]');
      if (detail && ci === 0) await snap(`c${ci + 1}_${k}`);
      if (detail && ci === 0 && k === 'p3') { await page.mouse.wheel(0, 3000); await page.waitForTimeout(200); await snap(`c${ci + 1}_${k}_scrolled`); }
      if (ci === 0 && k === 'p2') {
        await page.click('#patientBtn');
        await page.waitForSelector('#drawer:not([hidden])');
        await page.waitForTimeout(200);
        if (detail) await snap(`c${ci + 1}_drawer`);
        await page.click('#drawerClose');
      }
      const score = { p2: 5, p3: 4, p4: 3, p5: 2 }[k];
      await page.click(`.likert button[data-rate="${score}"]`);
      await clickNext();
    }
    // comment
    await page.waitForSelector('#caseComment');
    // secondary items: case 1 → minor harm in P3+P4, would prescribe with modification
    if (ci === 0) {
      await page.click('#caseItems .seg[data-field="harm"] button >> nth=1');
      await page.click('#caseItems .chips[data-multi="harm_phases"] .chip[data-value="P3"]');
      await page.click('#caseItems .chips[data-multi="harm_phases"] .chip[data-value="P4"]');
      await page.click('#caseItems .seg[data-field="would_prescribe"] button >> nth=1');
    } else {
      await page.click('#caseItems .seg[data-field="harm"] button >> nth=0');
      await page.click('#caseItems .seg[data-field="would_prescribe"] button >> nth=0');
    }
    await page.fill('#caseComment', `케이스 ${ci + 1} 의견: =SUM(A1) 테스트`);
    if (detail && ci === 0) await snap(`c${ci + 1}_comment`);
    if (ci === 0) {
      // back navigation check + combo change reset
      await clickBack(); // p5
      await clickBack(); // p4
      await clickBack(); // p3
      await clickBack(); // p2
      await clickBack(); // combo
      await page.waitForSelector('.combo-card');
      page.once('dialog', d => d.accept());
      const other = comboPick === 3 ? 1 : comboPick + 1;
      await page.waitForTimeout(500);
      await page.click(`.combo-card[data-combo="${other}"] .cc-drugs`);
      await page.waitForFunction(() => window.__T2D_APP__.state().stepIdx === 3);
      const r = await page.evaluate(() => window.__T2D_APP__.state().cases[0].ratings);
      if (r.p2 !== null || r.p5 !== null) errors.push('combo change did not reset p2-p5');
      await page.waitForTimeout(900);
      for (const k of ['p2', 'p3', 'p4', 'p5']) {
        await page.waitForSelector('.likert button[data-rate]');
        await page.click(`.likert button[data-rate="${{ p2: 5, p3: 4, p4: 3, p5: 2 }[k]}"]`);
        await clickNext();
      }
      await page.waitForSelector('#caseComment');
      // reload mid-flow to test resume
      await page.reload();
      await page.waitForSelector('#caseComment');
      const resumed = await page.evaluate(() => window.__T2D_APP__.state().metrics.resumes);
      if (resumed < 1) errors.push('resume not counted');
    }
    await clickNext();
  }
  await page.waitForSelector('#overallComment');
  await snap('final');
  await page.click('#endItems .seg[data-field="intent_use"] button >> nth=3');
  await page.fill('#overallComment', '전반적으로 참고 가치가 있음');
  await page.waitForTimeout(500);
  await page.click('#submitBtn');
  await page.waitForSelector('.status-line');
  await page.waitForFunction(() => document.querySelector('.status-line.ok') || document.querySelector('.status-line.fail'), null, { timeout: 30000 }).catch(() => {});
  await snap('done');
  const st = await page.evaluate(() => window.__T2D_APP__.state());
  // payload: evaluator field set per role, AI question coded 1–5 in display order
  const ev = st.evaluator || {};
  const keys = Object.keys(ev.fields || {}).sort();
  if (keys.join() !== EXPECT_FIELDS[role].slice().sort().join()) errors.push(`evaluator.fields keys [${keys}] ≠ [${EXPECT_FIELDS[role]}]`);
  if ((ev.fields || {}).ai_freq !== AI_FREQ_LABEL || (ev.codes || {}).ai_freq !== AI_FREQ_PICK + 1) errors.push('ai_freq payload ' + JSON.stringify([ev.fields && ev.fields.ai_freq, ev.codes && ev.codes.ai_freq]));
  if (st.screen !== 'done') errors.push('session did not reach the done screen: ' + st.screen);
  if (st.cases.filter(c => c.completed_at).length !== st.order.length) errors.push('not all cases completed');
  // backend rows (mock only): Sessions row carries Eval_ai_freq / Eval_ai_freq_code and no legacy values
  let sheet = 'skipped (no /__sheets)';
  try {
    const r = await fetch(new URL('/__sheets', base).toString());
    if (r.ok) {
      const sh = await r.json(), S = sh.Sessions || [], H = S[0] || [], c = n => H.indexOf(n);
      const row = S.find(x => x[c('SessionId')] === st.session_id);
      if (!row) errors.push('no Sessions row for ' + st.session_id);
      else {
        if (row[c('Eval_ai_freq')] !== AI_FREQ_LABEL || row[c('Eval_ai_freq_code')] !== AI_FREQ_PICK + 1) errors.push('Sessions Eval_ai_freq row value ' + JSON.stringify([row[c('Eval_ai_freq')], row[c('Eval_ai_freq_code')]]));
        LEGACY_IDS.forEach(id => { if (c('Eval_' + id) >= 0 && row[c('Eval_' + id)] !== '') errors.push('legacy column filled: Eval_' + id); });
        if (row[c('Status')] !== 'completed') errors.push('Sessions Status ' + row[c('Status')]);
        sheet = 'ok (Status=completed, Eval_ai_freq=' + row[c('Eval_ai_freq')] + '/' + row[c('Eval_ai_freq_code')] + ')';
      }
    }
  } catch (e) { sheet = 'skipped (' + e.message + ')'; }
  await ctx.close();
  return { kind, role, detail: ev.detail, fields: ev.fields, codes: ev.codes, order: st.order, seq: st.seq_index, seq_source: st.seq_source, outbox: st.outbox.length, net: st.net.status, sheet, errors };
}
