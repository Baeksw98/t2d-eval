/**
 * End-to-end run against tools/mock_gas_server.js.
 * Usage: node tools/e2e.js <baseUrl> <outDir> [device=mobile|desktop] [name]
 * Completes all 4 cases with deterministic answers, screenshots each step, then prints the sheets.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const base = process.argv[2] || 'http://localhost:8787/';
  const outDir = process.argv[3] || 'shots';
  const kind = process.argv[4] || 'mobile';
  const evName = process.argv[5] || '테스트평가자';
  // evaluator profile: argv[6] = resident|specialist|intern (default resident), argv[7] = type A|B (default A)
  const role = process.argv[6] || 'resident';
  const studyType = process.argv[7] || 'A';
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
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
    await page.screenshot({ path: path.join(outDir, `${String(shot).padStart(2, '0')}_${kind}_${label}.png`), fullPage: full });
  };

  await page.goto(base + '?reset=1');
  await page.waitForSelector('#evName');
  await snap('intro_top');
  await page.fill('#evName', evName);
  await page.click(`#roleSeg button[data-role="${role}"]`);
  if (role === 'resident') {
    await page.click('#roleFields .seg[data-field="year"] button[data-value="R2"]');
    await page.click('#roleFields .seg[data-field="major"] button[data-value="내과"]');
  }
  if (role === 'specialist') {
    await page.selectOption('#fld_ev_specialty', '기타 (직접 입력)');
    await page.fill('[data-other="specialty"]', '=임상약리학');
    await page.click('#roleFields .seg[data-field="board_years"] button[data-value="5–9년"]');
  }
  // common background items (first option of each, trust = 4)
  await page.click('#commonFields .seg[data-field="t2d_volume"] button >> nth=2');
  await page.click('#commonFields .seg[data-field="ai_use"] button >> nth=3');
  await page.click('#commonFields .seg[data-field="ai_trust"] button >> nth=3');
  await page.click(`#typeSeg button[data-type="${studyType}"]`);
  await page.waitForTimeout(100);   // headless click-after-scroll race; a person is never this fast
  await page.check('#evConsent');
  await snap('intro_filled', true);
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__T2D_APP__ && window.__T2D_APP__.state() && window.__T2D_APP__.state().screen === 'case');

  const nCases = await page.evaluate(() => window.__T2D_APP__.state().order.length);
  for (let ci = 0; ci < nCases; ci++) {
    // vignette
    await page.waitForSelector('.pt-head');
    await page.waitForTimeout(150);
    if (ci < 2) await snap(`c${ci + 1}_vignette`);
    if (ci === 0) await snap(`c${ci + 1}_vignette_full`, true);
    await clickNext();
    // p1
    await page.waitForSelector('.likert button[data-rate]');
    if (ci === 0) await snap(`c${ci + 1}_p1`);
    // try next without rating -> should not advance
    await page.waitForTimeout(500); await page.click('[data-act="next"]', { force: true });
    const st1 = await page.evaluate(() => window.__T2D_APP__.state().stepIdx);
    if (st1 !== 1) errors.push('advanced without rating at p1');
    await page.click(`.likert button[data-rate="${(ci % 5) + 1}"]`);
    await page.click(`.likert button[data-rate="4"]`); // change -> changes=1
    await clickNext();
    // combo
    await page.waitForSelector('.combo-card');
    if (ci === 0) { await snap(`c${ci + 1}_combo`); await snap(`c${ci + 1}_combo_full`, true); }
    const comboPick = (ci % 3) + 1;
    await page.click(`.combo-card[data-combo="${comboPick}"] .combo-name`);
    if (ci === 0) await snap(`c${ci + 1}_combo_selected`);
    await clickNext();
    for (const k of ['p2', 'p3', 'p4', 'p5']) {
      await page.waitForSelector('.likert button[data-rate]');
      if (ci === 0) await snap(`c${ci + 1}_${k}`);
      if (ci === 0 && k === 'p3') { await page.mouse.wheel(0, 3000); await page.waitForTimeout(200); await snap(`c${ci + 1}_${k}_scrolled`); }
      if (ci === 0 && k === 'p2') {
        await page.click('#patientBtn');
        await page.waitForSelector('#drawer:not([hidden])');
        await page.waitForTimeout(200);
        await snap(`c${ci + 1}_drawer`);
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
    if (ci === 0) await snap(`c${ci + 1}_comment`);
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
      await page.click(`.combo-card[data-combo="${other}"] .combo-name`);
      const r = await page.evaluate(() => window.__T2D_APP__.state().cases[0].ratings);
      if (r.p2 !== null || r.p5 !== null) errors.push('combo change did not reset p2-p5');
      await clickNext();
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
  console.log(JSON.stringify({ kind, order: st.order, seq: st.seq_index, seq_source: st.seq_source, outbox: st.outbox.length, net: st.net, totals: st.metrics, errors }, null, 1));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
