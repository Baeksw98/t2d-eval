// Site page tests — landing (/), About (/about/), QR hub (/qr/, /qr/main|ca|gc/):
//   legacy root redirects, '이어서 하기' banner (reads CA/GC localStorage), src·site·wave carried into links,
//   About is standalone (no links into /ca/ or /gc/), KO/EN (switch persists across pages, ?lang=, no Hangul visible in English,
//   KO dictionary = the Korean written in the HTML, EN/KO key coverage), theme (persists across pages), no console errors,
//   active case set (data/design.js: landing times, About set line, QR times/Types follow it; without it the v1 HTML text).
// Evaluation pages are stubbed (no app code, no backend traffic). Browser locale defaults to ko-KR.
// Usage: node tools/mock_gas_server.js 8787   then   node tools/test_site.js http://localhost:8787 [shotsDir]
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
// the active case set of this checkout (data/design.js, written by tools/build_cases.py): expected times / set line follow it
const ACT = (() => { const w = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'data', 'design.js'), 'utf8'), { window: w }); return w.T2D_DESIGN; })();
const ACT_MIN = {
  ca: ACT.ca.minutes,
  // a CA-only active set (e.g. v2, "gc": false) has no GC design: the pages keep the HTML / v1 fallback times for GC
  gc: !ACT.gc ? [10, 25] : (ACT.gc.minutes || [Math.min(...ACT.gc.parts.map(p => p.minutes[0])), Math.max(...ACT.gc.parts.map(p => p.minutes[1]))])
};
const ACT_NP = new Set(ACT.units.map(u => u.patient)).size, ACT_NM = new Set(ACT.units.map(u => u.model)).size;
const base = (process.argv[2] || 'http://127.0.0.1:8931').replace(/\/$/, '');
const shots = process.argv[3];
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const HANGUL = /[가-힣ㄱ-ㆎ]/;
const SITE_PAGES = ['/', '/about/', '/qr/', '/qr/main/', '/qr/ca/', '/qr/gc/'];
(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: opts.w || 390, height: 844 }, deviceScaleFactor: 1,
      colorScheme: opts.scheme || 'light', locale: opts.locale || 'ko-KR' });
    // stub the evaluation apps (only /ca/ and /gc/ at the site root — not /qr/ca/)
    await ctx.route(u => /^\/(ca|gc)\/$/.test(new URL(u).pathname), r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>stub' }));
    await ctx.route(/script\.google(usercontent)?\.com/, r => r.abort());
    if (opts.seed) await ctx.addInitScript(s => { localStorage.clear(); for (const k in s) localStorage.setItem(k, typeof s[k] === 'string' ? s[k] : JSON.stringify(s[k])); }, opts.seed);
    return ctx;
  };
  // console errors + i18n warnings (an unreachable external CDN is not the site's fault)
  const watch = (p) => {
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => {
      const loc = (m.location() && m.location().url) || '';
      if (/^https?:\/\/(?!localhost|127\.0\.0\.1)/.test(loc) && /Failed to load resource/.test(m.text())) return;
      if (m.type() === 'error' || (m.type() === 'warning' && /\[i18n\]/.test(m.text()))) errs.push(m.text());
    });
    return errs;
  };
  const visibleHangul = (p) => p.evaluate((src) => {
    const re = new RegExp(src); const out = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) {
      if (!re.test(n.nodeValue)) continue;
      const el = n.parentElement; if (!el || el.closest('script,style,noscript,[hidden],[aria-hidden="true"]')) continue;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display === 'none' || cs.visibility === 'hidden' || (!r.width && !r.height)) continue;
      out.push(n.nodeValue.trim().slice(0, 50));
    }
    // attributes people or assistive tech see
    document.querySelectorAll('[aria-label],[title],[placeholder],[alt]').forEach(el => {
      ['aria-label', 'title', 'placeholder', 'alt'].forEach(a => { const v = el.getAttribute(a); if (v && re.test(v)) out.push('@' + a + ': ' + v.slice(0, 50)); });
    });
    if (re.test(document.title)) out.push('<title>: ' + document.title);
    document.querySelectorAll('meta[name="description"],meta[property^="og:"]').forEach(m => { const v = m.getAttribute('content') || ''; if (re.test(v)) out.push('meta ' + (m.getAttribute('name') || m.getAttribute('property'))); });
    return out;
  }, HANGUL.source);

  // --- redirects ---
  const cases = [
    ['/?type=A&src=qr#top', '/ca/?type=A&src=qr#top'],
    ['/?type=b', '/ca/?type=b'],
    ['/?reset=1', '/ca/?reset=1'],
    ['/?test=1&src=x', '/ca/?test=1&src=x'],
    ['/?track=gc&src=x', '/gc/?src=x'],
    ['/?track=GC', '/gc/'],
    ['/?track=ca&type=B', '/ca/?type=B'],
    ['/?track=gc&type=A', '/gc/?type=A'],
    ['/index.html?type=A', '/ca/?type=A'],
    ['/?src=qr', '/?src=qr'],
    ['/', '/'],
    ['/?site=h1&wave=2', '/?site=h1&wave=2'],
    ['/?lang=en&type=A', '/ca/?lang=en&type=A'],
  ];
  const ctx = await mk();
  for (const [from, to] of cases) {
    const p = await ctx.newPage();
    await p.goto(base + from, { waitUntil: 'load' });
    await p.waitForTimeout(150);
    const u = new URL(p.url());
    ok(u.pathname + u.search + u.hash === to, `redirect ${from} -> ${u.pathname + u.search + u.hash} (want ${to})`);
    await p.close();
  }
  // back button: replace() must not leave the legacy URL in history
  {
    const p = await ctx.newPage();
    await p.goto(base + '/about/');
    await p.goto(base + '/?type=A');
    await p.waitForTimeout(150);
    await p.goBack();
    await p.waitForTimeout(150);
    ok(new URL(p.url()).pathname === '/about/', 'back from redirected CA link returns to the previous page (no redirect loop)');
    await p.close();
  }
  // --- param carry + About is standalone ---
  {
    const p = await ctx.newPage();
    await p.goto(base + '/?src=qr&site=h1&wave=2&foo=1');
    const hrefs = await p.$$eval('a[data-carry]', as => as.map(a => a.getAttribute('href')));
    const gc = hrefs.find(h => h.startsWith('/gc/'));
    const ca = hrefs.find(h => h.startsWith('/ca/'));
    ok(gc === '/gc/?src=qr&site=h1&wave=2', 'GC button carries src/site/wave: ' + gc);
    ok(ca === '/ca/?src=qr&site=h1&wave=2', 'CA button carries src/site/wave: ' + ca);
    ok(hrefs.some(h => h === '/about/?src=qr&site=h1&wave=2'), 'About link carries params');
    ok(!(await p.isVisible('#resume')), 'no resume banner without saved state');
    ok((await p.innerText('.pick-card.ca .pc-meta')).trim() === `약 ${ACT_MIN.ca[0]}–${ACT_MIN.ca[1]}분` && (await p.innerText('.pick-card.gc .pc-meta')).trim() === `약 ${ACT_MIN.gc[0]}–${ACT_MIN.gc[1]}분`, 'landing card times (active set ' + ACT.set_id + ')');
    // GC and About are built but gated (assets/features.js): the card stays visible, a click opens the "disabled" dialog
    ok(await p.getAttribute('.pick-card.gc', 'data-gated') === 'gc' && await p.isVisible('.pick-card.gc .pc-soon'), 'GC card marked as gated with a "준비 중" badge');
    await p.click('.pick-card.gc');
    await p.waitForSelector('.feat-dlg');
    ok(new URL(p.url()).pathname === '/' && /비활성화/.test(await p.innerText('.feat-dlg h2')), 'clicking GC opens the disabled dialog and stays on the landing page');
    ok((await p.getAttribute('.feat-dlg [data-feat-ca]', 'href')) === '/ca/?src=qr&site=h1&wave=2', 'dialog offers the CA assessment, carrying src/site/wave');
    await p.keyboard.press('Escape');
    ok(!(await p.$('.feat-dlg')), 'Escape closes the dialog');
    await p.click('.pick-about');
    await p.waitForSelector('.feat-dlg');
    ok(new URL(p.url()).pathname === '/' && /소개/.test(await p.innerText('.feat-dlg h2')), 'About link opens the disabled dialog');
    await p.click('.feat-dlg [data-feat-close]');
    await p.click('.pick-card.ca');
    await p.waitForTimeout(150);
    ok(new URL(p.url()).pathname === '/ca/', 'the CA card still navigates to /ca/');
    await p.goto(base + '/about/?src=qr');
    const all = await p.$$eval('a[href]', as => as.map(a => a.getAttribute('href')));
    const ah = await p.$$eval('a[data-carry]', as => as.map(a => a.getAttribute('href')));
    ok(ah.includes('/?src=qr') && ah.includes('/about/?src=qr'), 'About home + nav links carry src: ' + ah.join(', '));
    ok(!all.some(h => /(^|\/)(ca|gc)\/?(\?|#|$)/.test(h) || /#tracks/.test(h)), 'About has no links into the evaluations (/ca/, /gc/, #tracks)');
    const txt = await p.innerText('main');
    ok(!/참여하기|평가 참여|시작하기|논문 제목/.test(txt) && !/A hybrid AI rater–physician benchmark/.test(txt), 'About has no participation calls to action and no paper title');
    ok(await p.isVisible('#living') && await p.isVisible('#measures'), 'About has the "two evaluations" and "living benchmark" sections');
    await p.close();
  }
  await ctx.close();

  // --- resume banners ---
  const CA = 't2d-ca:T2D-CA-2026:v3';
  const scen = [
    ['ca-case', { [CA]: { v: 1, screen: 'case', study_type: 'A', order: ['x', 'y'], caseIdx: 1, outbox: [] } }, ['진행 중인 임상 수용성 평가가 있습니다', 'Type A · 케이스 2/2 진행 중']],
    ['ca-final', { [CA]: { v: 1, screen: 'final', study_type: 'B', order: ['x', 'y'], caseIdx: 1, outbox: [] } }, ['임상 수용성 평가 제출만 남았습니다', 'Type B']],
    ['ca-done-unsent', { [CA]: { v: 1, screen: 'done', study_type: 'A', order: ['x', 'y'], outbox: [{ msg_id: 1 }] } }, ['전송되지 않은 임상 수용성 평가 응답이 있습니다']],
    ['ca-done-sent', { [CA]: { v: 1, screen: 'done', study_type: 'A', order: ['x', 'y'], outbox: [] } }, []],
    ['ca-intro', { [CA]: { v: 1, screen: 'intro', study_type: 'A', outbox: [] } }, []],
    ['gc-eval', { 'gc:state:v1': { v: 1, screen: 'eval', part: 'A', outbox: [] } }, ['진행 중인 가이드라인 부합도 검증이 있습니다', 'Part A']],
    ['gc-draft', { 'gc:draft:v1': { linked: 'sess', part: 'B', done_parts: ['A'] } }, ['가이드라인 부합도 검증을 이어서 할 수 있습니다', 'Part B 준비됨']],
    ['gc-draft-unlinked', { 'gc:draft:v1': { part: 'B' } }, []],
    ['both', { [CA]: { v: 1, screen: 'case', study_type: 'B', order: ['x', 'y'], caseIdx: 0, outbox: [], is_test: true }, 'gc:state:v1': { v: 1, screen: 'final', part: 'B', outbox: [] } }, ['케이스 1/2', '테스트 응답', '가이드라인 부합도 검증 제출만 남았습니다']],
    ['both-en', { 't2d:lang': 'en', [CA]: { v: 1, screen: 'case', study_type: 'B', order: ['x', 'y'], caseIdx: 0, outbox: [], is_test: true }, 'gc:state:v1': { v: 1, screen: 'final', part: 'B', outbox: [] } },
      ['You have a clinical acceptability assessment in progress', 'Case 1 of 2 in progress', 'test response', 'Your guideline concordance validation only needs submitting']],
    ['garbage', { [CA]: 'not json{', 'gc:state:v1': '42' }, []],
  ];
  for (const [name, seed, want] of scen) {
    for (const w of (name === 'both' ? [390, 1440] : [390])) {
      const c = await mk({ seed, w });
      const p = await c.newPage();
      const errs = watch(p);
      await p.goto(base + '/?src=qr', { waitUntil: 'networkidle' });
      const vis = await p.isVisible('#resume');
      const txt = vis ? await p.innerText('#resume') : '';
      if (!want.length) ok(!vis, `${name}: no banner`);
      else want.forEach(s => ok(txt.includes(s), `${name}: banner has "${s}"`));
      if (vis) {
        const hrefs = await p.$$eval('#resume a', as => as.map(a => a.getAttribute('href')));
        ok(hrefs.every(h => /^\/(ca|gc)\/\?src=qr$/.test(h)), `${name}: banner links ${hrefs.join(', ')}`);
      }
      if (name === 'both') {   // the banner follows a language switch without a reload
        await p.click('.prefs [data-lang="en"]');
        const t2 = await p.innerText('#resume');
        ok(t2.includes('Case 1 of 2 in progress') && !HANGUL.test(t2), 'both: banner re-renders in English after switching');
        await p.click('.prefs [data-lang="ko"]');
        ok((await p.innerText('#resume')).includes('케이스 1/2 진행 중'), 'both: banner back in Korean');
      }
      ok(!errs.length, `${name}: no console errors ${errs.join(' | ')}`);
      if (shots && (name === 'both' || name === 'ca-case' || name === 'both-en')) await p.screenshot({ path: `${shots}/resume-${name}-${w}.png` });
      await c.close();
    }
  }

  // --- dictionaries: EN/KO key coverage, and the Korean in the HTML = the KO dictionary ---
  {
    const c = await mk();
    const p = await c.newPage();
    await p.goto(base + '/qr/');   // loads i18n/site.js + i18n/qr.js
    const cov = await p.evaluate(() => {
      const d = T2D.i18n.dict, ko = Object.keys(d.ko).filter(k => /^(site|about|qr)\./.test(k)), en = Object.keys(d.en).filter(k => /^(site|about|qr)\./.test(k));
      return { n: ko.length, noEn: ko.filter(k => !(k in d.en)), noKo: en.filter(k => !(k in d.ko)),
        hangulEn: en.filter(k => /[가-힣]/.test(d.en[k])) };
    });
    ok(cov.n > 300 && !cov.noEn.length, `every site/about/qr key has English (${cov.n} keys) ${cov.noEn.join(', ')}`);
    ok(!cov.noKo.length, 'every English key has Korean ' + cov.noKo.join(', '));
    ok(!cov.hangulEn.length, 'no Hangul inside English strings ' + cov.hangulEn.join(', '));
    for (const pg of SITE_PAGES) {
      const bad = await p.evaluate(async (url) => {
        const html = await (await fetch(url)).text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const d = T2D.i18n.dict.ko, out = [];
        const norm = s => String(s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
        const textOf = h => { const x = document.createElement('div'); x.innerHTML = h; return norm(x.textContent); };
        doc.querySelectorAll('[data-i18n]').forEach(el => { const k = el.getAttribute('data-i18n'); if (!(k in d)) out.push('missing ' + k); else if (norm(el.textContent) !== norm(d[k])) out.push(k + ': "' + norm(el.textContent) + '" ≠ "' + norm(d[k]) + '"'); });
        doc.querySelectorAll('[data-i18n-html]').forEach(el => { const k = el.getAttribute('data-i18n-html'); if (!(k in d)) out.push('missing ' + k); else if (norm(el.textContent) !== textOf(d[k])) out.push(k + ' (html): "' + norm(el.textContent) + '" ≠ "' + textOf(d[k]) + '"'); });
        doc.querySelectorAll('[data-i18n-attr]').forEach(el => String(el.getAttribute('data-i18n-attr')).split(';').forEach(pair => {
          const i = pair.indexOf(':'); if (i < 1) return; const a = pair.slice(0, i).trim(), k = pair.slice(i + 1).trim();
          if (!(k in d)) out.push('missing ' + k); else if (norm(el.getAttribute(a)) !== norm(d[k])) out.push(k + ' @' + a + ': "' + norm(el.getAttribute(a)) + '" ≠ "' + norm(d[k]) + '"');
        }));
        return out;
      }, base + pg);
      ok(!bad.length, `${pg}: Korean in the HTML matches the KO dictionary ${bad.slice(0, 5).join(' | ')}`);
    }
    await c.close();
  }

  // --- English everywhere: ?lang=en, no Hangul visible, no console errors (all collapsible blocks opened) ---
  for (const w of [390, 1440]) {
    const c = await mk({ w });
    for (const pg of SITE_PAGES) {
      const p = await c.newPage();
      const errs = watch(p);
      await p.goto(base + pg + (pg === '/' ? '?lang=en' : ''), { waitUntil: 'networkidle' });
      await p.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
      const lang = await p.evaluate(() => document.documentElement.lang);
      const h = await visibleHangul(p);
      ok(lang === 'en', `${pg} @${w}: <html lang="en"> (from ?lang=en on the first page, then saved)`);
      ok(!h.length, `${pg} @${w}: no Hangul visible in English ${h.slice(0, 4).join(' | ')}`);
      const hs = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      ok(hs <= 0, `${pg} @${w}: no horizontal scroll (${hs})`);
      ok(!errs.length, `${pg} @${w}: no console errors ${errs.join(' | ')}`);
      if (shots) await p.screenshot({ path: `${shots}/en-${pg.replace(/\//g, '_')}-${w}.png`, fullPage: true });
      await p.close();
    }
    await c.close();
  }

  // --- language + theme persist across pages; the QR pages re-render in place ---
  {
    const c = await mk();
    const p = await c.newPage();
    const errs = watch(p);
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    ok(await p.evaluate(() => document.documentElement.lang === 'ko' && T2D.lang === 'ko'), 'ko-KR browser starts in Korean');
    ok(await p.getAttribute('.prefs [data-lang="ko"]', 'aria-pressed') === 'true', 'KO button pressed');
    await p.click('.prefs [data-lang="en"]');
    ok((await p.innerText('h1')) === 'Choose an evaluation' && (await p.title()).startsWith('Type 2 Diabetes'), 'landing switches to English in place (heading + <title>)');
    ok((await p.innerText('.pick-card.ca .pc-meta')).trim() === `About ${ACT_MIN.ca[0]}–${ACT_MIN.ca[1]} min`, 'landing card time in English');
    // theme: system → light → dark
    ok(await p.evaluate(() => T2D.theme) === 'system' && await p.evaluate(() => document.documentElement.dataset.theme) === 'light', 'theme starts as system (light scheme)');
    await p.click('.prefs [data-theme-cycle]');
    await p.click('.prefs [data-theme-cycle]');
    ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'theme button reaches dark');
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok(bg === 'rgb(13, 22, 32)', 'landing dark background ' + bg);
    await p.goto(base + '/about/', { waitUntil: 'networkidle' });   // About is gated on the landing page; the page itself still works
    ok(new URL(p.url()).pathname === '/about/', 'went to About');
    ok(await p.evaluate(() => document.documentElement.lang) === 'en' && (await p.innerText('#aboutTitle')) === 'Hybrid Physician–AI Benchmark' && (await p.innerText('#measuresH')) === 'One answer, two evaluations', 'About opens in English');
    ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'About opens in dark');
    ok(await p.getAttribute('.prefs [data-theme-cycle]', 'aria-label') === 'Theme: Dark (click to change)', 'theme button label in English');
    await p.goto(base + '/qr/ca/', { waitUntil: 'networkidle' });
    ok((await p.innerText('#qrTitle')) === 'Clinical acceptability assessment' && await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'QR page opens in English + dark');
    ok((await p.inputValue('#msg')).startsWith('[Invitation: clinical acceptability assessment]'), 'invitation message in English');
    await p.click('.prefs [data-lang="ko"]');
    ok((await p.innerText('#qrTitle')) === '임상 수용성 평가' && (await p.inputValue('#msg')).startsWith('[임상 수용성 평가 참여 안내]'), 'QR page re-renders in Korean in place');
    ok(await p.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-lang')) === 'ko', 'focus stays on the language button after re-render');
    await p.click('[data-variant="B"]');
    ok(new URL(p.url()).searchParams.get('type') === 'B' && (await p.inputValue('#msg')).includes('이번 안내: Type B'), 'Type preset still works');
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    ok((await p.innerText('h1')) === '참여하실 평가를 선택해 주세요', 'Korean persists back on the landing page');
    await p.click('.prefs [data-theme-cycle]');
    ok(await p.evaluate(() => T2D.theme) === 'system' && await p.evaluate(() => localStorage.getItem('t2d:theme')) === 'system', 'theme cycles back to system');
    ok(!errs.length, 'persistence walk: no console errors ' + errs.join(' | '));
    await c.close();
  }
  // --- dark scheme from the OS (theme = system) ---
  {
    const c = await mk({ scheme: 'dark' });
    const p = await c.newPage();
    await p.goto(base + '/about/', { waitUntil: 'networkidle' });
    ok(await p.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'system dark scheme → data-theme="dark"');
    await c.close();
  }
  // --- QR print outputs stay Korean unless ?lang=en (the visitor's saved choice is untouched) ---
  {
    const c = await mk({ seed: { 't2d:lang': 'en' }, locale: 'en-US' });
    const p = await c.newPage();
    const errs = watch(p);
    await p.goto(base + '/qr/ca/?mode=poster', { waitUntil: 'networkidle' });
    ok((await p.innerText('.sheet h1')) === '임상 수용성 평가' && await p.evaluate(() => document.documentElement.lang) === 'ko', 'poster defaults to Korean');
    ok(await p.evaluate(() => localStorage.getItem('t2d:lang')) === 'en', 'poster does not overwrite the saved language');
    await p.goto(base + '/qr/gc/?mode=poster&lang=en&part=B', { waitUntil: 'networkidle' });
    ok((await p.innerText('.sheet h1')) === 'Guideline concordance validation' && (await p.innerText('.sheet .type')) === 'Part B', 'poster in English with ?lang=en');
    await p.goto(base + '/qr/', { waitUntil: 'networkidle' });
    const a4 = await p.$$eval('.qr-card a.btn[target]', as => as.map(a => a.getAttribute('href')));
    // while the guideline concordance validation is disabled (assets/features.js gc:false) the hub shows only the main + CA QR codes
    const gcOn = await p.evaluate(() => !(window.T2D_FEATURES && window.T2D_FEATURES.gc === false));
    const nCards = gcOn ? 3 : 2;
    ok(a4.length === nCards && a4.every(h => /\/\?mode=poster&lang=en$/.test(h)), 'English hub: A4 buttons open the English print view ' + a4.join(', '));
    const tracks = await p.$$eval('.qr-card', els => els.map(e => e.getAttribute('data-track')).join(','));
    ok(tracks === (gcOn ? 'main,ca,gc' : 'main,ca'), 'hub QR cards follow the GC feature flag: ' + tracks);
    if (!gcOn) {
      await p.evaluate(() => localStorage.removeItem('t2d:lang'));
      await p.goto(base + '/qr/main/?mode=poster', { waitUntil: 'networkidle' });
      const sheet = await p.innerText('.sheet');
      ok(!/가이드라인|부합도|벤치마크 소개/.test(sheet) && /임상 수용성 평가/.test(sheet) && (await p.$$('.tracks > div')).length === 1,
        'main poster mentions only the clinical acceptability assessment while GC is disabled');
      await p.goto(base + '/qr/main/', { waitUntil: 'networkidle' });
      ok(!/가이드라인|부합도/.test(await p.inputValue('#msg')), 'main invitation message has no GC line while GC is disabled');
    }
    ok(!errs.length, 'print checks: no console errors ' + errs.join(' | '));
    await c.close();
  }
  // --- active case set (data/design.js → window.T2D_DESIGN): landing times, About set line, QR times and Types ---
  {
    const c = await mk();
    const p = await c.newPage();
    const errs = watch(p);
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    const d = await p.evaluate(() => window.T2D_DESIGN && { id: T2D_DESIGN.set_id, ca: T2D_DESIGN.ca.minutes, gc: T2D_DESIGN.gc ? T2D_DESIGN.gc.minutes : null, n: T2D_DESIGN.units.length });
    ok(!!d && d.id === ACT.set_id, 'landing loads data/design.js (set ' + (d && d.id) + ', active ' + ACT.set_id + ')');
    const mins = await p.$$eval('[data-minutes]', els => els.map(e => e.getAttribute('data-minutes') + '=' + e.textContent));
    ok(d && mins.join('|') === `ca=약 ${d.ca[0]}–${d.ca[1]}분|gc=약 ${ACT_MIN.gc[0]}–${ACT_MIN.gc[1]}분`, 'landing times = the active set (GC: its Parts, or the v1 fallback for a CA-only set) ' + mins.join('|'));
    await p.goto(base + '/about/', { waitUntil: 'networkidle' });
    ok(await p.isVisible('#setNow') && (await p.innerText('#setNow')) === `지금 쓰는 케이스 세트 ${ACT.set_id} · 환자 ${ACT_NP}명 × 모델 ${ACT_NM}종`, 'About shows the current case set: ' + (await p.innerText('#setNow')));
    ok(!errs.length, 'case-set pages: no console errors ' + errs.join(' | '));
    // a different active set (served in place of data/design.js) changes the times, the set line and the QR Types without HTML edits
    const alt = await p.evaluate(() => {
      const x = JSON.parse(JSON.stringify(window.T2D_DESIGN || {}));
      const m0 = (x.units[0] || {}).model || 'gpt';   // one more patient, no new model
      x.set_id = 'v9'; x.units = (x.units || []).concat([{ key: 'P099_' + m0, patient: 'P099', model: m0 }]);
      x.ca.minutes = [35, 45]; x.ca.types = x.ca.types.concat([{ id: 'Z', label: { ko: 'Type Z', en: 'Type Z' }, sequences: x.ca.types[0].sequences }]);
      if (!x.gc) x.gc = { parts: [{ id: 'A' }, { id: 'B' }] };   // CA-only active set: give the stand-in set two GC Parts
      x.gc.minutes = null; x.gc.parts.forEach((pt, i) => { pt.minutes = i ? [5, 10] : [15, 20]; });
      return 'window.T2D_DESIGN = ' + JSON.stringify(x) + ';';
    });
    await c.route(/\/data\/design\.js(\?|$)/, r => r.fulfill({ status: 200, contentType: 'application/javascript', body: alt }));
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    const mins2 = await p.$$eval('[data-minutes]', els => els.map(e => e.textContent));
    ok(mins2.join('|') === '약 35–45분|약 5–20분', 'landing times follow another set (gc = range of its Parts): ' + mins2.join('|'));
    await p.goto(base + '/about/', { waitUntil: 'networkidle' });
    ok((await p.innerText('#setNow')) === `지금 쓰는 케이스 세트 v9 · 환자 ${ACT_NP + 1}명 × 모델 ${ACT_NM}종`, 'About set line follows another set: ' + (await p.innerText('#setNow')));
    await p.goto(base + '/about/?lang=en', { waitUntil: 'networkidle' });
    ok((await p.innerText('#setNow')) === `Current case set v9 · ${ACT_NP + 1} patients × ${ACT_NM} models`, 'About set line in English: ' + (await p.innerText('#setNow')));
    await p.evaluate(() => localStorage.removeItem('t2d:lang'));
    await p.goto(base + '/qr/ca/', { waitUntil: 'networkidle' });
    const vs = await p.$$eval('[data-variant]', els => els.map(e => e.getAttribute('data-variant')).filter(Boolean));
    ok(vs.includes('Z') && (await p.inputValue('#msg')).includes('35–45'), 'QR CA page: Types and time from the set (' + vs.join(',') + ')');
    await c.unroute(/\/data\/design\.js(\?|$)/);
    // no data/design.js (an old cached page or a failed request): the HTML's v1 times, no set line, nothing breaks
    await c.route(/\/data\/design\.js(\?|$)/, r => r.fulfill({ status: 404, body: '' }));
    const errs2 = [];
    p.on('pageerror', e => errs2.push(e.message));
    await p.goto(base + '/', { waitUntil: 'networkidle' });
    ok((await p.$$eval('[data-minutes]', els => els.map(e => e.textContent))).join('|') === '약 20–30분|약 10–25분', 'without data/design.js: landing keeps the v1 times');
    await p.goto(base + '/about/', { waitUntil: 'networkidle' });
    ok(await p.isHidden('#setNow'), 'without data/design.js: no set line on About');
    ok(!errs2.length, 'without data/design.js: no script errors ' + errs2.join(' | '));
    await c.close();
  }
  await browser.close();
  console.log(fail ? `${fail} FAILED` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})();
