/**
 * Render share-ready QR cards (PNG) and the printable A4 posters (PDF) from the per-track QR pages (shared code qr/qr.js).
 *   main (qr/main/) -> qr/main-card.png, qr/main-poster-a4.pdf   제2형 당뇨병 AI 벤치마크 평가 참여 (처음 화면, 두 평가 중 선택)
 *   ca   (qr/ca/)   -> qr/ca-card.png,   qr/ca-poster-a4.pdf     임상 수용성 평가 (인턴·레지던트·전문의)
 *   gc   (qr/gc/)   -> qr/gc-card.png,   qr/gc-poster-a4.pdf     가이드라인 부합도 검증 (내분비대사내과 분과전문의)
 * The legacy CA files qr/select-card.png and qr/poster-a4.pdf (already printed; their QR = main's URL) are not re-rendered.
 * Needs the local server: node tools/mock_gas_server.js 8787   (and the QR SVGs from tools/make_qr.py)
 * Usage: node tools/render_qr_assets.js [http://localhost:8787] [all|main|ca|gc[,…]] [--out=DIR]
 *   default: all sets into qr/. --out writes to another folder (e.g. to compare with the committed assets).
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SETS = {
  main: { page: 'qr/main/', card: 'main-card.png', poster: 'main-poster-a4.pdf' },
  ca: { page: 'qr/ca/', card: 'ca-card.png', poster: 'ca-poster-a4.pdf' },
  gc: { page: 'qr/gc/', card: 'gc-card.png', poster: 'gc-poster-a4.pdf' }
};

(async () => {
  const args = process.argv.slice(2);
  const opt = args.filter(a => a.startsWith('--'));
  const pos = args.filter(a => !a.startsWith('--'));
  const base = (pos.find(a => /^https?:\/\//.test(a)) || 'http://localhost:8787').replace(/\/$/, '');
  const which = pos.find(a => !/^https?:\/\//.test(a)) || 'all';
  const names = which === 'all' ? Object.keys(SETS) : which.split(',');
  names.forEach(n => { if (!SETS[n]) throw new Error(`unknown set "${n}" (all | main | ca | gc)`); });
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
    await open(`${base}/${s.page}?mode=card`);
    await (await page.$('.card-img')).screenshot({ path: path.join(out, s.card) });
    console.log('card', path.join(out, s.card));
    await open(`${base}/${s.page}?mode=poster`);
    await page.pdf({ path: path.join(out, s.poster), format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    console.log('poster pdf', path.join(out, s.poster));
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
