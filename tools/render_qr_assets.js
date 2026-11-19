/**
 * Render share-ready QR cards (PNG) and the printable A4 posters (PDF) from the QR pages.
 *   ca (qr/index.html)    -> qr/select-card.png, qr/poster-a4.pdf      임상 수용성 평가
 *   gc (qr/gc/index.html) -> qr/gc-card.png,     qr/gc-poster-a4.pdf   가이드라인 부합도 검증
 * Needs the local server: node tools/mock_gas_server.js 8787   (and the QR SVGs from tools/make_qr.py)
 * Usage: node tools/render_qr_assets.js [http://localhost:8787] [all|ca|gc] [--out=DIR]
 *   default: all sets into qr/. --out writes to another folder (e.g. to compare with the committed assets).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SETS = {
  ca: { page: 'qr/', cards: [['s', 'select']], poster: 'poster-a4.pdf' },
  gc: { page: 'qr/gc/', cards: [['', 'gc']], poster: 'gc-poster-a4.pdf' }
};

(async () => {
  const args = process.argv.slice(2);
  const opt = args.filter(a => a.startsWith('--'));
  const pos = args.filter(a => !a.startsWith('--'));
  const base = (pos.find(a => /^https?:\/\//.test(a)) || 'http://localhost:8787').replace(/\/$/, '');
  const which = pos.find(a => !/^https?:\/\//.test(a)) || 'all';
  const names = which === 'all' ? Object.keys(SETS) : which.split(',');
  names.forEach(n => { if (!SETS[n]) throw new Error(`unknown set "${n}" (all | ca | gc)`); });
  const outOpt = opt.find(a => a.startsWith('--out='));
  const out = outOpt ? path.resolve(outOpt.slice(6)) : path.resolve(__dirname, '..', 'qr');
  fs.mkdirSync(out, { recursive: true });

  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, deviceScaleFactor: 2, viewport: { width: 800, height: 1200 } });
  const page = await ctx.newPage();
  const open = async (url) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const broken = await page.evaluate(() => Array.from(document.images).filter(i => !i.complete || !i.naturalWidth).map(i => i.src));
    if (broken.length) throw new Error(`image(s) not loaded on ${url}: ${broken.join(', ')} (run python3 tools/make_qr.py first)`);
  };
  for (const n of names) {
    const s = SETS[n];
    for (const [t, name] of s.cards) {
      await open(`${base}/${s.page}?mode=card${t ? '&t=' + t : ''}`);
      await (await page.$('.card-img')).screenshot({ path: path.join(out, `${name}-card.png`) });
      console.log('card', path.join(out, `${name}-card.png`));
    }
    await open(`${base}/${s.page}?mode=poster`);
    await page.pdf({ path: path.join(out, s.poster), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log('poster pdf', path.join(out, s.poster));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
