/**
 * Render share-ready QR cards (PNG) and the printable A4 poster (PDF) from qr/index.html.
 * Needs the local server: node tools/mock_gas_server.js 8787
 * Usage: node tools/render_qr_assets.js [http://localhost:8787]
 */
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const base = (process.argv[2] || 'http://localhost:8787').replace(/\/$/, '');
  const out = path.resolve(__dirname, '..', 'qr');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 2, viewport: { width: 800, height: 1200 } });
  const page = await ctx.newPage();
  for (const [t, name] of [['a', 'type-a'], ['b', 'type-b'], ['s', 'select']]) {
    await page.goto(`${base}/qr/?mode=card&t=${t}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await (await page.$('.card-img')).screenshot({ path: path.join(out, `${name}-card.png`) });
    console.log('card', name);
  }
  await page.goto(`${base}/qr/?mode=poster`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: path.join(out, 'poster-a4.pdf'), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  console.log('poster pdf');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
