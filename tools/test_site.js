// Landing page (/) tests: legacy root redirects, '이어서 하기' banner (reads CA/GC localStorage), src·site·wave carried into links.
// Evaluation pages are stubbed (no app code, no backend traffic).
// Usage: node tools/mock_gas_server.js 8787   then   node tools/test_site.js http://localhost:8787 [shotsDir]
const { chromium } = require('playwright');
const base = process.argv[2] || 'http://127.0.0.1:8931';
const shots = process.argv[3];
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const mk = async (opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: opts.w || 390, height: 844 }, deviceScaleFactor: 1, colorScheme: opts.scheme || 'light' });
    await ctx.route(/\/(ca|gc)\/(\?.*)?(#.*)?$/, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>stub' }));
    await ctx.route(/script\.google(usercontent)?\.com/, r => r.abort());
    if (opts.seed) await ctx.addInitScript(s => { localStorage.clear(); for (const k in s) localStorage.setItem(k, JSON.stringify(s[k])); }, opts.seed);
    return ctx;
  };
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
  // --- param carry ---
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
    await p.click('.track.gc .btn');
    await p.waitForTimeout(100);
    ok(new URL(p.url()).pathname === '/gc/' && new URL(p.url()).searchParams.get('src') === 'qr', 'clicking GC goes to /gc/?src=qr…');
    await p.goto(base + '/about/?src=qr');
    const ah = await p.$$eval('a[data-carry]', as => as.map(a => a.getAttribute('href')));
    ok(ah.includes('/ca/?src=qr') && ah.includes('/gc/?src=qr') && ah.includes('/?src=qr'), 'About CTAs + home carry src');
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
    ['garbage', { [CA]: 'not json{', 'gc:state:v1': 42 }, []],
  ];
  for (const [name, seed, want] of scen) {
    for (const w of (name === 'both' ? [390, 1440] : [390])) {
      const c = await mk({ seed, w });
      if (name === 'garbage') await c.addInitScript(() => { localStorage.setItem('t2d-ca:T2D-CA-2026:v3', 'not json{'); });
      const p = await c.newPage();
      const errs = [];
      p.on('pageerror', e => errs.push(e.message));
      p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
      await p.goto(base + '/?src=qr', { waitUntil: 'networkidle' });
      const vis = await p.isVisible('#resume');
      const txt = vis ? await p.innerText('#resume') : '';
      if (!want.length) ok(!vis, `${name}: no banner`);
      else want.forEach(s => ok(txt.includes(s), `${name}: banner has "${s}"`));
      if (vis) {
        const hrefs = await p.$$eval('#resume a', as => as.map(a => a.getAttribute('href')));
        ok(hrefs.every(h => /^\/(ca|gc)\/\?src=qr$/.test(h)), `${name}: banner links ${hrefs.join(', ')}`);
      }
      ok(!errs.length, `${name}: no console errors ${errs.join(' | ')}`);
      if (shots && (name === 'both' || name === 'ca-case')) await p.screenshot({ path: `${shots}/resume-${name}-${w}.png` });
      await c.close();
    }
  }
  await browser.close();
  console.log(fail ? `${fail} FAILED` : 'ALL PASS');
  process.exit(fail ? 1 : 0);
})();
