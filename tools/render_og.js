/**
 * Render the link-preview image (Open Graph / KakaoTalk / Slack) for the landing and About pages.
 *   tools/og_image.html -> assets/og.png (1200×630)
 * Usage: node tools/render_og.js [--out=PATH]
 * Needs Playwright + Chromium (preinstalled) and network access to the Pretendard CSS on jsDelivr.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const outOpt = process.argv.slice(2).find(a => a.startsWith('--out='));
  const out = outOpt ? path.resolve(outOpt.slice(6)) : path.resolve(__dirname, '..', 'assets', 'og.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  await page.goto('file://' + path.resolve(__dirname, 'og_image.html'), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const font = await page.evaluate(() => document.fonts.check('800 52px "Pretendard Variable"'));
  if (!font) console.warn('warning: Pretendard did not load; the image uses a fallback font');
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  await browser.close();
  console.log('wrote ' + path.relative(process.cwd(), out));
})();
