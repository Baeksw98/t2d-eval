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
 * Every item: the screen reads as a story in DOM order — 채점 항목 card, then ① CDSS 답변 → ② AI 채점 → ③ AI 감사 →
 * ④ 최종 판정 (numbered <li> steps with h2 headings), then 채점표 적용 근거; no outcome strip above; ④ shows '감사에서 바뀜'
 * (struck AI 채점 verdict) iff audit.corrected differs from the rater verdict, else '변경 없음'; the dock asks about ④.
 * Intro: profile = board_years, setting, ai_freq (5 options, codes 1–5); the ①→④ reading order on intro and unit intro,
 * and no other numbered list there (the process lines are unnumbered, so ①–④ only ever mean the item-screen steps).
 * Item screen also: no '판정 N / M' pill in the case head and no 충족/감점 legend in the 채점 항목 card (topbar, dock and ④
 * carry them); the rubric question is labelled '채점표 질문' and quoted 「…」; ② labels the reason '판정 사유' (③ refers to
 * AI 채점의 「판정 사유」); the word 'Rater' never shows (③ text says 'AI 채점'); a sentence ②/③ quote from another answer
 * of the same combination is shown inside ① (.gc-cited-row, highlighted) — the expected answers are computed here from
 * data/cases.js independently of the page.
 * v1 draft probe: a continuation draft saved by the v1 page (no `missing`, has t2d_volume) asks ai_freq and can start.
 * Layout probes (unless --no-layout): Galaxy S8, iPhone SE (320 px), iPad portrait + landscape, iPhone 13 landscape, and a
 * Phase 1 item (combo 0, injected into the data in the browser only; nothing is sent).
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
const T2D_DATA = loadWindowScript('data/cases.js').T2D_DATA;
const ITEM = {};
Object.values(GC_DATA.units).forEach(u => u.items.forEach(it => { ITEM[it.id] = it; }));
// what the page shows for ③ (and ②): the data's 'Rater' in the screen's term 'AI 채점'
const screenTerms = (s) => String(s == null ? '' : s).replace(/Rater(는|가)?/g, (_, p) => 'AI 채점' + (p === '는' ? '은' : p === '가' ? '이' : ''));
// answers of the same combination (or Phase 1) — other than the item's own — that contain a ②/③ quote, in answer order
const ALL_Q = ['2.1', '2.2', '2.3', '3.1', '3.2', '3.3', '3.4', '3.5', '3.6', '3.7', '3.8', '4.1', '4.2', '4.3', '5.1', '5.2', '5.3', '5.4'];
function answerText(it, q) {
  const out = T2D_DATA.outputs[it.unit];
  if (!it.combo) { const p1 = out.phase_1 || {}; return q === '1.1' ? [(p1['1.1'] || {}).answer, (p1['1.1'] || {}).referral].join('\n') : String(p1[q] || ''); }
  const a = out.combinations[it.combo - 1].answers[q];
  return a && typeof a === 'object' ? [a.answer, a.next_visit].join('\n') : String(a == null ? '' : a);
}
function expectedCited(it) {
  const ev = it.audit.evidence.map(e => (String(e).match(/^([^“]*?)\s*:\s*“([\s\S]*)”\s*$/) || [])[2]).filter(Boolean);
  const qs = it.combo ? ALL_Q : ['1.1', '1.2'];
  const hit = new Set();
  it.rater.quotes.concat(ev).map(q => String(q || '').trim()).filter(q => q.length >= 2).forEach(q => {
    if (answerText(it, it.question).indexOf(q) >= 0) return;
    const o = qs.find(x => x !== it.question && answerText(it, x).indexOf(q) >= 0);
    if (o) hit.add(o);
  });
  return qs.filter(x => hit.has(x));
}
const partItems = (pid) => GC_CONFIG.PARTS.find(p => p.id === pid).sequences[0].reduce((a, k) => a + GC_DATA.units[k].items.length, 0);
const altsFor = (it) => GC_CONFIG.VERDICTS.map(v => v.id).filter(v => v !== it.final);
const VLABEL = Object.fromEntries(GC_CONFIG.VERDICTS.map(v => [v.id, v.label]));
const PF = Object.fromEntries(GC_CONFIG.PROFILE_FIELDS.map(f => [f.id, f]));
const PF_AI_LAST = GC_CONFIG.PROFILE_FIELDS.find(f => f.id === 'ai_freq').options[4];
const changedByAudit = (it) => !!it.audit.corrected && it.audit.corrected !== it.rater.verdict;
const storyStats = { items: 0, changed: 0, unchanged: 0, cited: 0 };

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

// item screen = story in DOM order: 채점 항목 → ① CDSS 답변 → ② AI 채점 → ③ AI 감사 → ④ 최종 판정 → 채점표 적용 근거
async function checkItemScreen(page, kind, it) {
  const tag = `[${kind}] item ${it.id}`;
  const changed = changedByAudit(it);
  const d = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const txt = (s) => { const e = q(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; };
    const after = (a, b) => !!(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
    const steps = [1, 2, 3, 4].map(n => q('#gcStep' + n));
    const ol = q('ol.gc-steps'), elem = q('.gc-elem'), basis = q('details.gc-basis');
    return {
      missing: ['.gc-elem', '.gc-elem .gc-crit #gcCrit', 'ol.gc-steps', 'details.gc-basis'].filter(s => !q(s)),
      strip: !!q('.gc-path, .gc-compare'),
      order: steps.every(Boolean) && steps.every((el, i) => i === 0 || after(steps[i - 1], el)),
      inList: steps.every(el => el && el.tagName === 'LI' && el.parentElement === ol),
      elemFirst: after(elem, ol), basisAfter: after(steps[3], basis),
      cls: steps.map(el => (el && el.querySelector(':scope > section') || {}).className || ''),
      heads: [1, 2, 3, 4].map(n => { const h = q('#gcS' + n + 'h'); return h ? h.tagName + '|' + h.textContent : ''; }),
      labelled: steps.map((el, i) => !!el && (el.querySelector(':scope > section') || { getAttribute: () => '' }).getAttribute('aria-labelledby') === 'gcS' + (i + 1) + 'h'),
      badges: steps.map(el => el ? txt('#' + el.id + ' > section > .gc-step-head > .gc-step-no') : ''),
      h1: txt('h1'),
      raterChip: txt('#gcStep2 .gc-step-aside'), markChip: txt('#gcStep3 .gc-step-aside'), markMean: txt('#gcStep3 .gc-mark-mean'),
      why: txt('#gcStep2 .gc-why'), expl: txt('#gcStep3 .gc-why'),
      badge: txt('#gcStep4 .gc-step-aside'), from: txt('#gcStep4 .gc-ba-from .vd'), struck: !!q('#gcStep4 .gc-ba-from .vd.struck'),
      to: txt('#gcStep4 .gc-ba-to .vd'),
      ask: txt('#gcAsk'), askJump: !!q('#gcAsk [data-act="to-final"]'),
      navyPill: !!q('.case-head .pill.navy'), vkey: !!q('.gc-vkey'),
      qk: txt('#gcStep1 .gc-qtext-k'), qtext: txt('#gcStep1 .gc-qtext'),
      raterMini: Array.from(document.querySelectorAll('#gcStep2 h3.mini')).map(e => e.textContent.trim()),
      cited: Array.from(document.querySelectorAll('#gcStep1 .gc-cited-row')).map(e => e.getAttribute('data-q')),
      citedMarked: Array.from(document.querySelectorAll('#gcStep1 .gc-cited-row')).every(e => !!e.querySelector('mark.gc-hl')),
      oldLoc: /전체 답변 보기에서 표시/.test(document.body.innerText),
      rater: /Rater/.test(document.body.innerText)
    };
  });
  const bad = [];
  if (d.missing.length) bad.push('missing ' + d.missing.join(', '));
  if (d.strip) bad.push('outcome strip / comparison above the reading flow');
  if (!d.order) bad.push('steps not in DOM order ① < ② < ③ < ④');
  if (!d.inList) bad.push('steps are not the <li> of ol.gc-steps');
  if (!d.elemFirst) bad.push('채점 항목 card not before the steps');
  if (!d.basisAfter) bad.push('채점표 적용 근거 not after ④');
  ['gc-answer', 'gc-rater', 'gc-audit', 'gc-final'].forEach((c, i) => { if (d.cls[i].split(' ').indexOf(c) < 0) bad.push(`step ${i + 1} is not .${c}`); });
  const titles = ['CDSS 답변', 'AI 채점', 'AI 감사', '최종 판정'];
  d.heads.forEach((h, i) => { if (!h.startsWith('H2|') || h.indexOf(titles[i]) < 0) bad.push(`step ${i + 1} heading "${h}"`); });
  if (d.labelled.some(x => !x)) bad.push('step sections not labelled by their headings');
  if (d.badges.join('') !== '1234') bad.push('step badges ' + d.badges.join(','));
  if (d.h1 !== it.title) bad.push(`h1 "${d.h1}" ≠ element title`);
  const why = it.rater.verdict === 'deducted' ? '왜 감점했나' : it.rater.verdict === 'met' ? '왜 충족으로 봤나' : '';
  if (why && d.heads[1].indexOf(why) < 0) bad.push(`② heading lacks "${why}"`);
  if (d.raterChip !== VLABEL[it.rater.verdict]) bad.push(`② verdict chip "${d.raterChip}" ≠ ${VLABEL[it.rater.verdict]}`);
  if (it.rater.reason && d.why !== screenTerms(it.rater.reason).replace(/\s+/g, ' ').trim()) bad.push('② reason text differs from rater.reason');
  if (d.markChip.indexOf(it.audit.mark === 'major' ? '✗' : '△') !== 0) bad.push(`③ mark chip "${d.markChip}"`);
  if (!d.markMean) bad.push('③ mark meaning missing');
  if (it.audit.explanation && d.expl !== screenTerms(it.audit.explanation).replace(/\s+/g, ' ').trim()) bad.push('③ explanation text differs');
  if (d.rater) bad.push("the word 'Rater' is visible (the screen calls it AI 채점)");
  if (d.navyPill) bad.push("duplicate '판정 N / M' pill in the case head");
  if (d.vkey) bad.push('충족/감점 legend still in the 채점 항목 card');
  if (it.question_text && (d.qk.indexOf('채점표 질문') !== 0 || d.qtext.indexOf('「' + it.question_text.replace(/\s+/g, ' ').trim() + '」') < 0)) bad.push(`rubric question not labelled/quoted: "${d.qtext}"`);
  if (d.raterMini[0] !== '판정 사유') bad.push(`② first label "${d.raterMini[0]}" (expected 판정 사유)`);
  const wantCited = expectedCited(it);
  if (d.cited.join(',') !== wantCited.join(',')) bad.push(`① cited other answers [${d.cited}] ≠ expected [${wantCited}]`);
  if (d.cited.length && !d.citedMarked) bad.push('① cited other answer shown without its highlight');
  if (d.oldLoc) bad.push("old location note '전체 답변 보기에서 표시' still shown");
  if (wantCited.length) storyStats.cited++;
  // ④: '바뀜' iff audit.corrected differs from the rater verdict
  if (/바뀜/.test(d.badge) !== changed) bad.push(`④ badge "${d.badge}" but changed = ${changed}`);
  if (!changed && d.badge !== '변경 없음') bad.push(`④ badge "${d.badge}" (expected 변경 없음)`);
  if (d.struck !== changed) bad.push(`④ AI 채점 verdict struck = ${d.struck}, changed = ${changed}`);
  if (d.from.indexOf(VLABEL[it.rater.verdict]) !== 0) bad.push(`④ from "${d.from}" ≠ ${VLABEL[it.rater.verdict]}`);
  if (d.to !== VLABEL[it.final]) bad.push(`④ to "${d.to}" ≠ final ${VLABEL[it.final]}`);
  if (!d.askJump || d.ask.indexOf('최종 판정') < 0 || d.ask.indexOf(VLABEL[it.final]) < 0) bad.push(`dock question "${d.ask}" does not point at ④ (${VLABEL[it.final]})`);
  bad.forEach(b => fail(`${tag}: ${b}`));
  storyStats.items++; storyStats[changed ? 'changed' : 'unchanged']++;
  return d;
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
  // profile = board_years, setting, ai_freq (no t2d_volume); ai_freq options in config order (codes 1–5)
  const prof = await page.evaluate(() => ({
    fields: Array.from(document.querySelectorAll('#profileFields [data-field]')).map(e => e.getAttribute('data-field')),
    ai: Array.from(document.querySelectorAll('.seg[data-field="ai_freq"] button')).map(b => b.textContent),
    order: document.querySelectorAll('.gc-order li').length,
    otherNumbered: document.querySelectorAll('#main ol:not(.gc-order), main ol:not(.gc-order)').length
  }));
  if (prof.fields.join(',') !== 'board_years,setting,ai_freq') fail(`[${kind}] intro profile fields ${prof.fields.join(',')}`);
  else if (JSON.stringify(prof.ai) !== JSON.stringify(PF.ai_freq.options)) fail(`[${kind}] ai_freq options ${JSON.stringify(prof.ai)}`);
  else ok('intro profile: board_years, setting, ai_freq (5 options in order)');
  if (prof.order !== 4) fail(`[${kind}] intro reading order shows ${prof.order} steps`);
  if (prof.otherNumbered) fail(`[${kind}] intro has another numbered list besides the ①→④ reading order`);
  await page.click('.seg[data-field="board_years"] button >> nth=2');
  await page.click('.seg[data-field="setting"] button >> nth=0');
  await page.click('.seg[data-field="ai_freq"] button >> nth=1');
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
      const nOrder = await page.$$eval('.gc-order li', els => els.length);
      if (nOrder !== 4) fail(`[${kind}] unit intro reading order shows ${nOrder} steps`);
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
    await checkItemScreen(page, kind, it);
    await R.checkLayout(`item ${k}`);

    if (extras && k === 1) {
      await R.snap(`s${sessionNo}_item1`);
      await R.snap(`s${sessionNo}_item1_full`, true);
      // [다음] without a decision does nothing
      await sleep(520);
      await page.click('[data-act="next"]', { force: true });
      await sleep(120);
      if ((await R.S()).stepIdx !== s.stepIdx) fail(`[${kind}] advanced without a decision`);
      // '④ 최종 판정' in the dock question scrolls to step ④
      await page.click('#gcAsk [data-act="to-final"]');
      const reached = await page.waitForFunction(() => {
        const r = document.getElementById('gcStep4').getBoundingClientRect();
        const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        return r.top >= 0 && (r.top < 160 || (bottom && r.top < window.innerHeight));
      }, null, { timeout: 3000 }).then(() => true, () => false);
      if (!reached) fail(`[${kind}] dock '④ 최종 판정' did not scroll to step ④`); else ok('dock question jumps to ④');
      await page.evaluate(() => window.scrollTo(0, 0));
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

// a continuation draft saved by the v1 page (gc:draft:v1 without `missing`, fields with t2d_volume) → ai_freq is asked
async function v1DraftProbe(browser) {
  console.log('\n=== v1 continuation draft ===');
  const kind = 'iPhone 13';
  const { ctx, page } = await newPage(browser, kind);
  const q = new URLSearchParams({ src: 'e2e-layout', test: '1' });
  await page.goto(`${BASE}/gc/?reset=1&${q}`);
  await page.waitForSelector('#eligCard');
  const v1draft = {
    eligible: 'yes', name: 'E2E 구버전', fields: { board_years: '10–19년', setting: '상급종합병원', t2d_volume: '월 100–299명' },
    part: 'B', consent: true, consent_at: new Date().toISOString(), consent_inherited: true,
    linked: '11111111-2222-4333-8444-555555555555', done_parts: ['A'], evaluator_id: 'e2e-v1-draft', prev_patients: [], pending: [],
    introBucket: { active_ms: 0, idle_ms: 0, hidden_ms: 0, wall_ms: 0 }
  };
  await page.evaluate(d => { localStorage.removeItem('gc:state:v1'); localStorage.setItem('gc:draft:v1', JSON.stringify(d)); }, v1draft);
  await page.goto(`${BASE}/gc/?${q}`);
  await page.waitForSelector('#evaluatorCard');
  const info = await page.evaluate(() => ({
    ask: Array.from(document.querySelectorAll('#evaluatorCard [data-field]')).map(e => e.getAttribute('data-field')),
    notice: (document.querySelector('.notice.info') || {}).textContent || ''
  }));
  if (info.ask.join(',') !== 'ai_freq') fail(`[v1 draft] continuation asks [${info.ask}] (expected ai_freq)`);
  if (info.notice.indexOf('AI 사용 빈도') < 0) fail(`[v1 draft] notice does not name the new question: "${info.notice}"`);
  await page.click('.seg[data-field="ai_freq"] button >> nth=4');
  await page.click('#startBtn');
  const started = await page.waitForFunction(() => window.__GC_APP__.state() && window.__GC_APP__.state().screen === 'eval', null, { timeout: 20000 }).then(() => true, () => false);
  if (!started) fail('[v1 draft] session did not start after answering ai_freq');
  else {
    const st = await page.evaluate(() => { const s = window.__GC_APP__.state(); return { f: s.evaluator.fields, c: s.evaluator.codes, l: s.linked_session_id, p: s.part }; });
    if (st.f.ai_freq !== PF_AI_LAST || st.c.ai_freq !== 5 || 't2d_volume' in st.f || st.l !== v1draft.linked || st.p !== 'B') fail(`[v1 draft] session evaluator ${JSON.stringify(st)}`);
    else ok(`v1 draft: ai_freq asked, session B starts linked with {${Object.keys(st.f).join(', ')}}`);
  }
  await ctx.close();
}

// short layout probes on other form factors (no horizontal scroll on intro, unit intro, item + disagree dock).
// allItems: also walk every item of the Part (agree) and check the ①→④ structure and the width on each.
async function layoutProbe(browser, kind, part = 'A', allItems = false) {
  const { ctx, page } = await newPage(browser, kind);
  const R = makeRunner(page, kind);
  const q = new URLSearchParams({ reset: '1', src: 'e2e-layout', test: '1' });
  await page.goto(`${BASE}/gc/?${q}`);
  await page.waitForSelector('#eligCard');
  await page.click('[data-elig="yes"]');
  await page.fill('#evName', 'E2E 레이아웃');
  for (const f of GC_CONFIG.PROFILE_FIELDS.map(x => x.id)) await page.click(`.seg[data-field="${f}"] button >> nth=0`);
  await page.click(`[data-part="${part}"]`);
  await page.check('#evConsent');
  await R.checkLayout('intro');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__GC_APP__.state() && window.__GC_APP__.state().screen === 'eval', null, { timeout: 20000 });
  await page.waitForSelector('.gc-combo');
  await R.checkLayout('unit');
  await R.clickNext();
  await page.waitForSelector('.gc-title');
  // expander first: on short screens (iPhone SE) the 비동의 dock is tall and a centred element would sit behind it
  await page.click('.gc-answer details.gc-more > summary');
  await page.click('[data-agree="0"]');
  await R.checkLayout('item + disagree');
  // the decision buttons must stay reachable on screen (unless the dock follows the content, as on landscape phones)
  const box = await page.$eval('[data-act="next"]', b => {
    const r = b.getBoundingClientRect();
    return { b: r.bottom, h: window.innerHeight, pos: getComputedStyle(document.getElementById('dock')).position };
  });
  if (box.b > box.h + 1 && box.pos !== 'static') fail(`[${kind}] [다음] below the viewport`);
  await R.snap(`probe_${part}_item`);
  if (allItems) {
    await page.click('[data-agree="1"]');
    let n = 0;
    for (;;) {
      await R.clickNext();
      const s = await R.S();
      if (s.screen !== 'eval') break;
      if (s.i < 0) { await R.checkLayout(`unit ${s.u + 1}`); continue; }
      await page.waitForSelector('.gc-title');
      await page.click('.gc-answer details.gc-more > summary');
      await checkItemScreen(page, kind, ITEM[s.itemId]);
      await R.checkLayout(`item ${s.k} (${s.itemId})`);
      await page.click('[data-agree="1"]');
      n++;
    }
    ok(`${kind}: Part ${part} — all ${n + 1} items: ①→④ structure and no horizontal scroll`);
  }
  ok(`${kind}: layout ok`);
  await ctx.close();
}

// Phase 1 item (combo 0): the current data has none, so one is injected into GC_DATA in the browser only
// (ENDPOINT emptied for this page: nothing is sent). Checks the ①→④ story, the Phase 1 answer and its expander.
async function phase1Probe(browser, kind) {
  const ctx = await browser.newContext({ ...devices[kind], locale: 'ko-KR' });
  const CASES = loadWindowScript('data/cases.js').T2D_DATA;
  const unit = GC_CONFIG.PARTS.find(p => p.id === 'A').sequences[0][0];
  const p1 = (CASES.outputs[unit].phase_1 || {})['1.1'] || {};
  const tpl = GC_DATA.units[unit].items.find(it => it.audit.mark === 'major') || GC_DATA.units[unit].items[0];
  const quote = String(p1.answer || '').slice(0, 24);
  const item = JSON.parse(JSON.stringify(tpl));
  Object.assign(item, { id: unit + '|P1|Q1.1-99', combo: 0, question: '1.1', question_text: '', element: 'Q1.1-99', target_key: unit + '|P1' });
  item.rater.quotes = quote ? [quote] : [];
  await ctx.route('**/gc/gc-config.js*', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(/ENDPOINT:\s*'[^']*'/, "ENDPOINT: ''");
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
  });
  await ctx.route('**/gc/data/gc_items.js*', async (route) => {
    const res = await route.fetch();
    const body = (await res.text()) + `\n;window.GC_DATA.units[${JSON.stringify(unit)}].items.unshift(${JSON.stringify(item)});\n`;
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'content-type': 'text/javascript; charset=utf-8' } });
  });
  const page = await ctx.newPage();
  const tag = `${kind} Phase 1`;
  page.on('pageerror', e => fail(`[${tag}] pageerror: ${e.message}`));
  const R = makeRunner(page, tag);
  await page.goto(`${BASE}/gc/?reset=1&test=1&src=e2e-p1`);
  await page.waitForSelector('#eligCard');
  await page.click('[data-elig="yes"]');
  await page.fill('#evName', 'E2E Phase 1');
  for (const f of GC_CONFIG.PROFILE_FIELDS.map(x => x.id)) await page.click(`.seg[data-field="${f}"] button >> nth=0`);
  await page.click('[data-part="A"]');
  await page.check('#evConsent');
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__GC_APP__.state() && window.__GC_APP__.state().screen === 'eval', null, { timeout: 20000 });
  // jump to the injected item (the saved position is restored on reload)
  const found = await page.evaluate((id) => {
    const s = window.__GC_APP__.state(), steps = window.__GC_APP__.steps();
    const idx = steps.findIndex(st => st.i >= 0 && window.GC_DATA.units[s.order[st.u]].items[st.i].id === id);
    if (idx >= 0) s.stepIdx = idx;
    return idx >= 0;
  }, item.id);
  if (!found) { fail(`[${tag}] injected item not in the session`); await ctx.close(); return; }
  await sleep(1600);
  await page.reload();
  await page.waitForSelector('.gc-title');
  if ((await R.S()).itemId !== item.id) { fail(`[${tag}] did not open the injected item`); await ctx.close(); return; }
  await checkItemScreen(page, tag, item);
  const p = await page.evaluate(() => ({
    sub: (document.querySelector('#gcStep1 .gc-step-sub') || {}).textContent || '',
    chips: !!document.querySelector('#gcStep1 .cc-drugs'),
    hl: document.querySelectorAll('#gcStep1 .gc-ans-body mark.gc-hl.r').length,
    summary: (document.querySelector('.gc-answer details.gc-more > summary') || {}).textContent || ''
  }));
  if (!/^Phase 1 · 답 1\.1/.test(p.sub)) fail(`[${tag}] ① sub "${p.sub}"`);
  if (p.chips) fail(`[${tag}] drug chips shown for a Phase 1 item`);
  if (quote && !p.hl) fail(`[${tag}] AI 채점 quote not highlighted in the Phase 1 answer`);
  if (p.summary.indexOf('Phase 1 전체 답변') < 0) fail(`[${tag}] expander "${p.summary}"`);
  await page.click('.gc-answer details.gc-more > summary');
  const rows = await page.$$eval('.gc-answer .gc-full-row', els => els.length);
  if (rows !== 2) fail(`[${tag}] Phase 1 full answer shows ${rows} rows`);
  await R.checkLayout('Phase 1 item');
  await page.click('[data-agree="0"]');
  await page.click(`[data-alt="${altsFor(item)[0]}"]`);
  const j = (await R.S()).judgments[item.id];
  if (!j || j.agree !== false || j.alt_verdict !== altsFor(item)[0] || !j.opened.full_answer) fail(`[${tag}] decision not recorded: ${JSON.stringify(j && { a: j.agree, v: j.alt_verdict, o: j.opened })}`);
  await R.snap('phase1_item', true);
  ok(`${tag}: ①→④ story, Phase 1 answer + expander, decision recorded`);
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
      // profile entered on the intro (continuation inherits it): board_years nth=2, setting nth=0, ai_freq nth=1
      Eval_board_years: PF.board_years.options[2], Eval_board_years_code: 3,
      Eval_setting: PF.setting.options[0], Eval_setting_code: 1,
      Eval_ai_freq: PF.ai_freq.options[1], Eval_ai_freq_code: 2,
      // end items: info_sufficient nth=3; hitl_acceptable nth=4 (session 1) / nth=2 (session 2)
      End_info_sufficient: GC_CONFIG.END_ITEMS[0].options[3], End_info_sufficient_code: 4,
      End_hitl_acceptable: GC_CONFIG.END_ITEMS[1].options[s.session_ordinal === 1 ? 4 : 2], End_hitl_acceptable_code: s.session_ordinal === 1 ? 5 : 3,
      Resumes: s.resumes
    };
    Object.keys(want).forEach(k => { if (r[k] !== want[k]) fail(`${tag}: GC_Sessions.${k} = ${JSON.stringify(r[k])}, expected ${JSON.stringify(want[k])}`); });
    if (Object.keys(r).some(c => /t2d_volume/.test(c))) fail(`${tag}: GC_Sessions still has a t2d_volume column`);
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
  const s4all = section(4).find(r => r[0] === '전체' && r[2] === nVotes) || [];
  if (s4all[3] !== nAgreeFinal || s4all[7] !== nAgreeRater) fail(`GC_Summary [4]: agree final/rater ${s4all[3]}/${s4all[7]} ≠ ${nAgreeFinal}/${nAgreeRater} (n ${nVotes})`);
  const s4 = section(4);
  const i43 = s4.findIndex(r => String(r[0]).startsWith('[4-3]'));
  const all43 = i43 < 0 ? null : s4.slice(i43).find(r => r[0] === '전체');
  if (!all43) fail('GC_Summary [4-3] (AI 사용 빈도별 AI 최종 동의율) missing');
  else if (all43[3] !== nVotes || all43[4] !== nAgreeFinal) fail(`GC_Summary [4-3] 전체 ${all43[3]}/${all43[4]} ≠ ${nVotes}/${nAgreeFinal}`);
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
  ok(`GC_Summary: [0]–[8] present; [1] ${pool2.length} sessions / ${completed} completed; [4] AI final agreement ${nAgreeFinal}/${nVotes}, raw Rater ${nAgreeRater}/${nVotes}; [4-3] by ai_freq; [5] κ ` +
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
    for (const k of ['Galaxy S8', 'iPad (gen 7)', 'iPad (gen 7) landscape', 'iPhone 13 landscape']) await layoutProbe(browser, k);
    await layoutProbe(browser, 'iPhone SE', 'A', true);   // 320 px: every item of both Parts
    await layoutProbe(browser, 'iPhone SE', 'B', true);
    await phase1Probe(browser, 'iPhone 13');
  }
  await v1DraftProbe(browser);
  await sleep(800);   // let the last beacons land
  await checkBackend(all);
  await browser.close();
  console.log(`\nitem screens checked (①→④ order, ④ 바뀜 iff corrected ≠ rater): ${storyStats.items} (바뀜 ${storyStats.changed}, 변경 없음 ${storyStats.unchanged}, with cited other answers ${storyStats.cited})`);
  console.log(`\n${errors.length ? 'FAILED' : 'PASSED'}: ${errors.length} problem(s)${notes.length ? ' · ' + notes.join('; ') : ''}`);
  if (errors.length) { errors.forEach(e => console.log(' - ' + e)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
