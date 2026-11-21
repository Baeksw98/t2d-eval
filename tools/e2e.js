/**
 * End-to-end run against tools/mock_gas_server.js (or any server that serves the site).
 * Usage: node tools/e2e.js <baseUrl> <outDir> [device=mobile|desktop] [name] [role=resident|specialist|intern|all] [type=A|B] [lang=ko|en]
 *   <baseUrl> is the site root (e.g. http://localhost:8787/) or the CA page itself (…/ca/): the CA evaluation lives at
 *   /ca/ since the landing page took over /, so a site root gets 'ca/' appended. Anything else is used as given.
 *   role 'all' runs the intern, resident and specialist paths one after another (fresh browser context each).
 * Per role: fills the intro (v3.4 profile: role-specific items + the single AI-use question 'ai_freq'), checks that
 * starting without the AI question names it ('AI 사용 빈도를 선택해 주세요.'), completes both cases of the Type with
 * deterministic answers, submits, and checks the evaluator payload (field set per role, ai_freq code). If <baseUrl>
 * serves /__sheets (the mock), also checks the Sessions row (Eval_ai_freq / _code). Screenshots go to <outDir>
 * (case-step shots for the first role only). Prints one JSON line per role; exit 1 if any role reported errors.
 * Language (KO/EN, assets/i18n.js + i18n/ca.js): the page is opened with ?lang=<lang>; expected texts come from the
 * dictionary. Every screen: <html lang> = lang, and in English no Hangul outside case content ([lang="ko"] = patient
 * record / AI output, [data-ugc] = the evaluator's own name, inputs). Every POST to the CA web app is captured: each
 * carries ui_lang = lang and set_id = 'v1', and stored values stay the canonical Korean label + code in either language.
 * First role also: a mid-case language switch (and back) keeps the step, the rating and the timing; the theme button
 * cycles system → light → dark → system and sets <html data-theme>. The language history is sent: session.ui_lang_start,
 * session.ui_lang_switches, case.ui_langs / ui_lang_mixed (case 1 of the first role is seen in both languages).
 * Once per run (live safety): a session saved by the previous, Korean-only version (no language fields) resumes in Korean on a
 * device whose browser language is English (locale en-US) and nothing is saved to 't2d:lang'; a session started in English
 * resumes in English even when 't2d:lang' is gone; an explicit ?lang= wins over the session's language.
 */
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

// UI dictionary, read the same way the page reads it (i18n/ca.js registers ko/en through T2D.i18n.add)
const DICT = (() => {
  const d = { ko: {}, en: {} };
  new Function('T2D', fs.readFileSync(path.join(__dirname, '..', 'i18n', 'ca.js'), 'utf8'))({ i18n: { add: (x) => { Object.assign(d.ko, x.ko); Object.assign(d.en, x.en); } } });
  return d;
})();
const T = (lang, key, vars) => String(DICT[lang][key] !== undefined ? DICT[lang][key] : DICT.ko[key]).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? vars[n] : m));
const HANGUL = /[\uac00-\ud7a3]/;
// visible text with Hangul outside case content (patient record / AI output carry lang="ko"), the evaluator's name and inputs
async function hangulInChrome(page) {
  return page.evaluate(() => {
    const re = /[\uac00-\ud7a3]/, bad = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      if (!re.test(n.nodeValue)) continue;
      const el = n.parentElement;
      if (!el || el.closest('[lang="ko"], [data-ugc], script, style, noscript, [hidden]')) continue;
      if (!el.getClientRects().length) continue;
      bad.push(n.nodeValue.trim().slice(0, 50));
    }
    // attributes people see or hear: placeholders, aria-labels, titles
    document.querySelectorAll('[placeholder], [aria-label], [title]').forEach(el => {
      if (el.closest('[lang="ko"], [hidden]')) return;
      ['placeholder', 'aria-label', 'title'].forEach(a => { const v = el.getAttribute(a); if (v && re.test(v)) bad.push('@' + a + ': ' + v.slice(0, 40)); });
    });
    if (re.test(document.title)) bad.push('title: ' + document.title);
    return bad.slice(0, 8);
  });
}

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
  const lang = process.argv[8] === 'en' ? 'en' : 'ko';
  const roles = roleArg === 'all' ? ['intern', 'resident', 'specialist'] : [roleArg];
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  let failed = 0;
  for (let ri = 0; ri < roles.length; ri++) {
    const res = await runRole(browser, { base, outDir, kind, evName: roles.length > 1 ? evName + '-' + roles[ri] : evName, role: roles[ri], studyType, detail: ri === 0, lang });
    console.log(JSON.stringify(res));
    if (res.errors.length) failed++;
  }
  const rl = await resumeLangCheck(browser, base);
  console.log(JSON.stringify(rl));
  if (rl.errors.length) failed++;
  await browser.close();
  if (failed) { console.error(`e2e: ${failed} role path(s) reported errors`); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });

// site root → CA page (/ca/). A URL whose path already names a page (…/ca/, …/index.html, a temp copy) is kept.
function caUrl(u) {
  const x = new URL(u);
  if (x.pathname === '/' || x.pathname === '') x.pathname = '/ca/';
  return x.toString();
}

async function runRole(browser, { base, outDir, kind, evName, role, studyType, detail, lang }) {
  const ctxOpts = kind === 'mobile' ? { ...devices['iPhone 13'] } : { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 };
  const ctx = await browser.newContext({ ...ctxOpts, locale: 'ko-KR' });
  const sent = [];
  // beacons (view / progress) do not expose their body to the request event: keep a copy in the page
  await ctx.addInitScript(() => {
    const nb = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
    if (!nb) return;
    window.__beacons = [];
    navigator.sendBeacon = function (url, data) {
      try { if (data && data.text) data.text().then(t => window.__beacons.push(t)); else window.__beacons.push(String(data)); } catch (_) {}
      return nb(url, data);
    };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || (m.type() === 'warning' && /\[i18n\]/.test(m.text()))) errors.push('console: ' + m.text()); });
  const takeBeacons = async () => {
    const list = await page.evaluate(() => (window.__beacons || []).splice(0)).catch(() => []);
    list.forEach(t => { try { const j = JSON.parse(t); if (j && j.action) sent.push(j); } catch (_) {} });
  };
  // every payload sent to the CA web app (outbox POSTs; beacons via takeBeacons)
  page.on('request', r => {
    if (r.method() !== 'POST' || !/\/exec(\?|$)/.test(r.url())) return;
    try { const j = JSON.parse(r.postData() || ''); if (j && j.action) sent.push(j); } catch (_) {}
  });
  // per screen: <html lang> and (English) no Hangul in the UI chrome
  const checkLang = async (label) => {
    const hl = await page.evaluate(() => document.documentElement.lang);
    if (hl !== lang) errors.push(`${label}: <html lang> = ${hl}`);
    if (lang === 'en') { const bad = await hangulInChrome(page); if (bad.length) errors.push(`${label}: Hangul in UI chrome ${JSON.stringify(bad)}`); }
  };

  // the app ignores next/back for 450 ms after each screen change (double-tap guard) — act like a person
  const clickNext = async () => { await page.waitForTimeout(500); await page.click('[data-act="next"]'); };
  const clickBack = async () => { await page.waitForTimeout(500); await page.click('[data-act="back"]'); };
  let shot = 0;
  const snap = async (label, full = false) => {
    shot++;
    await page.screenshot({ path: path.join(outDir, `${role}_${String(shot).padStart(2, '0')}_${kind}_${label}.png`), fullPage: full });
  };

  await page.goto(base + (base.includes('?') ? '&' : '?') + 'reset=1&src=e2e&site=S1&lang=' + lang);
  await page.waitForSelector('#evName');
  await page.waitForTimeout(200);
  await takeBeacons();
  await snap('intro_top');
  await checkLang('intro');
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
  const wantToast = lang === 'en' ? T('en', 'ca.err.fieldSelect', { name: 'AI use frequency' }) : 'AI 사용 빈도를 선택해 주세요.';
  if (toastText.trim() !== wantToast) errors.push('missing-AI toast was: ' + JSON.stringify(toastText) + ' (expected ' + JSON.stringify(wantToast) + ')');
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
    await checkLang(`case ${ci + 1} vignette`);
    if (detail && ci < 2) await snap(`c${ci + 1}_vignette`);
    if (detail && ci === 0) await snap(`c${ci + 1}_vignette_full`, true);
    await clickNext();
    // p1
    await page.waitForSelector('.likert button[data-rate]');
    if (detail && ci === 0) await snap(`c${ci + 1}_p1`);
    await checkLang(`case ${ci + 1} p1`);
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
    await checkLang(`case ${ci + 1} combo`);
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
      await checkLang(`case ${ci + 1} ${k}`);
      if (detail && ci === 0 && k === 'p3') {
        // mid-case language switch (and back): same step, same rating, timing keeps running, no new session
        const other = lang === 'en' ? 'ko' : 'en';
        const before = await page.evaluate(() => { const s = window.__T2D_APP__.state(); return { step: s.stepIdx, r: s.cases[0].ratings.p3, id: s.session_id, ms: s.cases[0].metrics.steps.p3.active_ms }; });
        await page.click(`#topbar .prefs [data-lang="${other}"]`);
        await page.waitForFunction(l => document.documentElement.lang === l, other);
        await page.waitForTimeout(1200);
        const mid = await page.evaluate(() => { const s = window.__T2D_APP__.state(); return { step: s.stepIdx, r: s.cases[0].ratings.p3, id: s.session_id, ms: s.cases[0].metrics.steps.p3.active_ms, pressed: (document.querySelector('.likert button[aria-checked="true"]') || {}).getAttribute ? document.querySelector('.likert button[aria-checked="true"]').getAttribute('data-rate') : null, stmt: document.getElementById('stmt').textContent }; });
        if (mid.step !== before.step || mid.r !== before.r || mid.id !== before.id || mid.pressed !== String(before.r)) errors.push('language switch changed the state ' + JSON.stringify({ before, mid }));
        if (!(mid.ms > before.ms)) errors.push('timing stopped after the language switch');
        if (mid.stmt.trim() !== T(other, 'ca.instrument.p3.statement')) errors.push('statement not re-rendered in ' + other + ': ' + mid.stmt);
        if (detail) await snap(`c1_p3_lang_${other}`);
        await page.click(`#topbar .prefs [data-lang="${lang}"]`);
        await page.waitForFunction(l => document.documentElement.lang === l, lang);
        // theme: system → light → dark → system; <html data-theme> always light|dark
        const themes = [];
        for (let i = 0; i < 3; i++) {
          await page.click('#topbar .prefs [data-theme-cycle]');
          themes.push(await page.evaluate(() => [window.T2D.theme, document.documentElement.getAttribute('data-theme')].join(':')));
        }
        if (themes.join(',') !== 'light:light,dark:dark,system:light') errors.push('theme cycle ' + themes.join(','));
        if ((await page.evaluate(() => window.__T2D_APP__.state().stepIdx)) !== before.step) errors.push('theme switch moved the step');
      }
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
    await checkLang(`case ${ci + 1} comment`);
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
      await takeBeacons();
      await page.reload();
      await page.waitForSelector('#caseComment');
      const resumed = await page.evaluate(() => window.__T2D_APP__.state().metrics.resumes);
      if (resumed < 1) errors.push('resume not counted');
    }
    await clickNext();
  }
  await page.waitForSelector('#overallComment');
  await snap('final');
  await checkLang('final');
  await page.click('#endItems .seg[data-field="intent_use"] button >> nth=3');
  await page.fill('#overallComment', '전반적으로 참고 가치가 있음');
  await page.waitForTimeout(500);
  await page.click('#submitBtn');
  await page.waitForSelector('.status-line');
  await page.waitForFunction(() => document.querySelector('.status-line.ok') || document.querySelector('.status-line.fail'), null, { timeout: 30000 }).catch(() => {});
  await snap('done');
  await checkLang('done');
  const st = await page.evaluate(() => window.__T2D_APP__.state());
  // payload: evaluator field set per role, AI question coded 1–5 in display order
  const ev = st.evaluator || {};
  const keys = Object.keys(ev.fields || {}).sort();
  if (keys.join() !== EXPECT_FIELDS[role].slice().sort().join()) errors.push(`evaluator.fields keys [${keys}] ≠ [${EXPECT_FIELDS[role]}]`);
  if ((ev.fields || {}).ai_freq !== AI_FREQ_LABEL || (ev.codes || {}).ai_freq !== AI_FREQ_PICK + 1) errors.push('ai_freq payload ' + JSON.stringify([ev.fields && ev.fields.ai_freq, ev.codes && ev.codes.ai_freq]));
  if (st.screen !== 'done') errors.push('session did not reach the done screen: ' + st.screen);
  if (st.cases.filter(c => c.completed_at).length !== st.order.length) errors.push('not all cases completed');
  // payloads: ui_lang / set_id on every message; canonical Korean values + codes whatever the UI language
  const mine = sent.filter(p => p.action === 'view' || p.session_id === st.session_id);
  const acts = mine.map(p => p.action);
  ['view', 'start', 'case', 'finish'].forEach(a => { if (acts.indexOf(a) < 0) errors.push('no ' + a + ' payload captured'); });
  mine.forEach(p => {
    if (p.ui_lang !== lang) errors.push(`${p.action} payload ui_lang = ${p.ui_lang}`);
    if (p.set_id !== 'v1') errors.push(`${p.action} payload set_id = ${p.set_id}`);
  });
  const fin = mine.filter(p => p.action === 'finish').pop();
  if (fin) {
    const e = fin.evaluator || {};
    const roleKo = { intern: '인턴', resident: '레지던트', specialist: '전문의' }[role];
    if (e.role_label !== roleKo) errors.push('payload role_label ' + e.role_label);
    if ((e.fields || {}).ai_freq !== AI_FREQ_LABEL) errors.push('payload ai_freq ' + (e.fields || {}).ai_freq);
    if (role === 'specialist' && (e.fields.specialty !== '기타: =임상약리학' || e.fields.board_years !== '5–9년')) errors.push('payload specialist fields ' + JSON.stringify(e.fields));
    if (!HANGUL.test(e.detail || '')) errors.push('payload detail not canonical Korean: ' + e.detail);
    const c1 = fin.cases[0].items || {};
    if (!c1.harm || c1.harm.value !== '경미한 위해 가능성' || c1.harm.code !== 2) errors.push('payload case 1 harm ' + JSON.stringify(c1.harm));
    if (!c1.would_prescribe || c1.would_prescribe.value !== '일부 수정하여 처방하겠다' || c1.would_prescribe.code !== 2) errors.push('payload case 1 would_prescribe ' + JSON.stringify(c1.would_prescribe));
    if (!c1.harm_phases || c1.harm_phases.value !== 'P3;P4') errors.push('payload harm_phases ' + JSON.stringify(c1.harm_phases));
    const iu = (fin.end_items || {}).intent_use;
    if (!iu || iu.value !== '4 · 그렇다' || iu.code !== 4) errors.push('payload intent_use ' + JSON.stringify(iu));
    // language history: start language, switches (first role switched twice inside case 1), per-case languages
    const ss = fin.session || {}, cs = fin.cases || [];
    if (ss.ui_lang_start !== lang) errors.push('session.ui_lang_start ' + ss.ui_lang_start);
    if (ss.ui_lang_switches !== (detail ? 2 : 0)) errors.push('session.ui_lang_switches ' + ss.ui_lang_switches);
    const wantLangs = detail ? [lang, lang === 'en' ? 'ko' : 'en'] : [lang];
    if (JSON.stringify(ss.ui_langs) !== JSON.stringify(wantLangs)) errors.push('session.ui_langs ' + JSON.stringify(ss.ui_langs));
    cs.forEach((c, i) => {
      const mixed = detail && i === 0;
      if (c.ui_lang_mixed !== mixed || c.ui_langs[0] !== lang) errors.push(`case ${i + 1} ui_langs ${JSON.stringify(c.ui_langs)} mixed ${c.ui_lang_mixed}`);
      const p1 = ((c.metrics || {}).steps || {}).p1 || {};
      if (p1.ui_lang !== lang) errors.push(`case ${i + 1} p1 rated in ${p1.ui_lang}`);
    });
  }
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
  return { kind, lang, role, detail: ev.detail, fields: ev.fields, codes: ev.codes, order: st.order, seq: st.seq_index, seq_source: st.seq_source, outbox: st.outbox.length, net: st.net.status, payloads: acts.length, sheet, errors };
}

// Live safety: which language a resumed session is shown in (assets/i18n.js default 'ko' + app.js pinSessionLang).
async function resumeLangCheck(browser, base) {
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  const view = () => page.evaluate(() => ({
    html: document.documentElement.lang, lang: window.T2D && window.T2D.lang,
    stored: localStorage.getItem('t2d:lang'), main: (document.getElementById('main') || {}).innerText || ''
  }));
  const reopen = async (q) => { await page.goto(base + (q || '')); await page.waitForSelector('.pt-head'); await page.waitForTimeout(300); };
  // start a test session (Korean UI: no language chosen), then make its saved state look like the Korean-only version's
  await page.goto(base + (base.includes('?') ? '&' : '?') + 'reset=1&test=1&src=e2e-lang');
  await page.waitForSelector('#evName');
  await page.evaluate(() => localStorage.removeItem('t2d:lang'));
  await page.fill('#evName', '언어확인');
  await page.click('#roleSeg button[data-role="intern"]');
  await page.click('#commonFields .seg[data-field="ai_freq"] button >> nth=0');
  await page.click('#typeSeg button[data-type="A"]');
  await page.check('#evConsent');
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  await page.waitForSelector('.pt-head');
  const KEY = 't2d-ca:T2D-CA-2026:v3';
  // edit the saved state while the app is NOT open (it saves its in-memory state when the page is left): on /about/, same origin
  const edit = async (fn) => {
    await page.goto(new URL('/about/', base).toString());
    await page.evaluate(([k, src]) => {
      const s = JSON.parse(localStorage.getItem(k)); (new Function('s', src))(s); localStorage.setItem(k, JSON.stringify(s));
      localStorage.removeItem('t2d:lang');
    }, [KEY, fn]);
  };
  await edit('delete s.ui_lang_start; delete s.ui_langs; delete s.set_id; (s.cases || []).forEach(function (c) { delete c.metrics.ui_langs; });');
  // 1) old Korean session, English browser → Korean, nothing saved
  await reopen('');
  let v = await view();
  if (v.html !== 'ko' || v.lang !== 'ko' || v.stored !== null || !/환자/.test(v.main)) errors.push('old session on an en-US browser: ' + JSON.stringify({ html: v.html, lang: v.lang, stored: v.stored }));
  const st = await page.evaluate(() => window.__T2D_APP__.state());
  if (JSON.stringify(st.ui_langs) !== '["ko"]' || JSON.stringify(st.cases[0].metrics.ui_langs) !== '["ko"]') errors.push('old session language history not seeded with ko: ' + JSON.stringify([st.ui_langs, st.cases[0].metrics.ui_langs]));
  // 2) a session started in English, 't2d:lang' gone → English (not saved)
  await edit("s.ui_lang_start = 'en';");
  await reopen('');
  v = await view();
  if (v.html !== 'en' || v.lang !== 'en' || v.stored !== null || !v.main.includes(T('en', 'ca.vig.title'))) errors.push('English session without t2d:lang: ' + JSON.stringify({ html: v.html, lang: v.lang, stored: v.stored }));
  // 3) an explicit choice wins: ?lang=ko on that English session
  await reopen('?lang=ko');
  v = await view();
  if (v.html !== 'ko' || v.stored !== 'ko') errors.push('explicit ?lang=ko: ' + JSON.stringify({ html: v.html, stored: v.stored }));
  await ctx.close();
  return { check: 'resume-language', errors };
}
