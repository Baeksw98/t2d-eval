/* QR 안내 — 공용 코드
 * ------------------------------------------------------------
 * 쓰는 곳: qr/index.html (허브: QR 3종을 한 화면에), qr/main/ · qr/ca/ · qr/gc/ (트랙별 공유 페이지: 안내 문구·코드·인쇄)
 *   <body data-track="ca" data-base="../">  →  QRSite.page()      (트랙별 페이지, ?mode=card | ?mode=poster 는 인쇄용)
 *   <body data-base="">                    →  QRSite.hub()       (허브)
 * QR 이 가리키는 주소 (tools/make_qr.py 와 같아야 합니다):
 *   main  https://eval.asclep.org/?src=qr      처음 화면 — 두 평가 중 선택 (이미 인쇄된 select.* 와 같은 주소)
 *   ca    https://eval.asclep.org/ca/?src=qr   임상 수용성 평가
 *   gc    https://eval.asclep.org/gc/?src=qr   가이드라인 부합도 검증
 *   QR·링크 주소에는 언어를 넣지 않습니다(받는 사람의 브라우저 언어를 따름).
 * 문구: i18n/qr.js (qr.* 키, 한국어/영어) — 이 파일에는 화면 문구가 없습니다. 헤더 공용 문구는 i18n/site.js.
 *   페이지는 assets/i18n.js → i18n/site.js → i18n/qr.js 를 <head> 에서 먼저 읽습니다. 언어를 바꾸면('t2d:lang') 다시 그립니다.
 * 인쇄용(?mode=card|poster)은 ?lang=en 이 없으면 한국어로 만듭니다(tools/render_qr_assets.js 의 qr/*-card.png · *-poster-a4.pdf
 *   = 한국어 인쇄물). 영어 화면의 [A4 안내문] 버튼은 미리 만든 한국어 PDF 대신 ?mode=poster&lang=en 인쇄 화면을 엽니다.
 * 소요 시간·Type/Part: 기본값은 세트 v1 (i18n/qr.js qr.time.*). window.T2D_DESIGN(data/design.js)이 있으면 그 값을 씁니다.
 * 미리 만든 이미지: qr/<id>.svg|png (make_qr.py), qr/<id>-card.png · qr/<id>-poster-a4.pdf (tools/render_qr_assets.js)
 * 기관·세션 코드(site)나 Type/Part 를 넣으면 QR 은 브라우저에서 즉석 생성합니다(qrcode-generator, 없으면 기본 이미지). */
(function () {
  'use strict';
  var HOST = 'eval.asclep.org';
  var ORIGIN = 'https://' + HOST;
  var I = window.T2D && window.T2D.t ? window.T2D : null;
  var t = function (k, v) { return I ? I.t(k, v) : k; };
  var lang = function () { return I ? I.lang : 'ko'; };
  var PATHS = { main: '/', ca: '/ca/', gc: '/gc/' };
  var ORDER = ['main', 'ca', 'gc'];
  var INK = { main: '#14304a', ca: '#b4541a', gc: '#187368' };

  // ---------------------------------------------------------------------------
  // times and Types/Parts: active case set (window.T2D_DESIGN) or the set v1 defaults
  // ---------------------------------------------------------------------------
  function rng(m) { return m && m.length === 2 && Number(m[0]) > 0 && Number(m[1]) >= Number(m[0]) ? [Number(m[0]), Number(m[1])] : null; }
  function design() { var d = window.T2D_DESIGN; return d && typeof d === 'object' ? d : null; }
  function caInfo() {
    var c = (design() || {}).ca || {};
    var r = rng(c.minutes) || [20, 30];
    var ids = (c.types || []).map(function (x) { return x && x.id ? String(x.id) : ''; }).filter(Boolean);
    return { n: Number(c.per_session) > 0 ? Number(c.per_session) : 2, lo: r[0], hi: r[1], values: ids.length ? ids : ['A', 'B'] };
  }
  function gcInfo() {
    var g = (design() || {}).gc || {};
    var parts = (g.parts || []).filter(function (p) { return p && p.id; }).map(function (p) { return { p: String(p.id), r: rng(p.minutes) }; });
    if (!parts.length) parts = [{ p: 'A', r: [20, 25] }, { p: 'B', r: [10, 15] }];
    var time = parts.map(function (x) { return x.r ? t('qr.time.gc.part', { p: x.p, lo: x.r[0], hi: x.r[1] }) : 'Part ' + x.p; }).join(' · ');
    var all = parts.filter(function (x) { return x.r; }).map(function (x) { return x.r; });
    return { time: time, values: parts.map(function (x) { return x.p; }), lo: all.length ? Math.min.apply(null, all.map(function (r) { return r[0]; })) : 0,
      hi: all.length ? Math.max.apply(null, all.map(function (r) { return r[1]; })) : 0 };
  }

  // One track's text in the current language (rebuilt on every render, so a language switch takes effect everywhere).
  function def(id) {
    var ca = caInfo(), gc = gcInfo();
    var caTime = t('qr.time.ca', { n: ca.n, lo: ca.lo, hi: ca.hi });
    var vars = { ca_time: caTime, gc_time: gc.time, n: ca.n, lo: ca.lo, hi: ca.hi };
    var k = function (s, v) { return t('qr.' + id + '.' + s, v || vars); };
    var mainLo = Math.min(ca.lo, gc.lo || ca.lo), mainHi = Math.max(ca.hi, gc.hi);
    var C = {
      id: id, path: PATHS[id], img: id,
      name: k('name'), file: k('file'), title: k('title'), subtitle: k('subtitle'), who: k('who'), brand: k('brand'),
      time: id === 'ca' ? caTime : id === 'gc' ? gc.time : t('qr.time.main', { lo: mainLo, hi: mainHi }),
      hint: [k('hint1'), k('hint2')], foot: k('foot'), caTime: caTime, gcTime: gc.time
    };
    var values = id === 'ca' ? ca.values : gc.values, list = values.join('·');
    if (id !== 'main') {
      C.variant = { param: id === 'ca' ? 'type' : 'part', label: id === 'ca' ? 'Type' : 'Part', values: values, list: list,
        none: t('qr.variant.none'), help: k('vhelp') };
    }
    C.steps = function (v) {
      if (id === 'main') return [k('step1'), k('step2'), k('step3')];
      return [t('qr.main.step1'), v ? k('step2.v', { v: v }) : k('step2.none', { list: list }), k('step3')];
    };
    C.message = function (url, v) {
      var m = { url: url, about: ORIGIN + '/about/', ca_time: caTime, gc_time: gc.time, n: ca.n, lo: ca.lo, hi: ca.hi };
      if (id !== 'main') m.vnote = v ? k('msg.v', { v: v }) : k('msg.none', { list: list });
      return k('msg', m);
    };
    return C;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var cleanSite = function (v) { return String(v || '').replace(/[^0-9A-Za-z_\-]/g, '').slice(0, 20); };
  var toastT;
  function toast(msg) {
    var el = document.getElementById('toast'); if (!el) return;
    el.textContent = msg; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { el.hidden = true; }, 2600);
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove(); return ok;
  }
  function copy(text, done) {
    var ok = function () { toast(done); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text) ? ok() : toast(t('qr.toast.copyFail')); });
    } else { fallbackCopy(text) ? ok() : toast(t('qr.toast.copyFail')); }
  }
  function share(data) {
    if (navigator.share) {
      navigator.share(data).catch(function (e) { if (e && e.name !== 'AbortError') copy(data.url || data.text, t('qr.toast.shareCopied')); });
    } else {
      copy(data.url || data.text, t('qr.toast.noShare'));
    }
  }
  function saveBlob(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast(t('qr.toast.saved'));
  }
  function qrModel(url) {
    if (!window.qrcode) return null;
    var q = window.qrcode(0, 'Q'); q.addData(url); q.make(); return q;
  }
  // Re-render on a language switch, keeping keyboard focus on the language button that was pressed.
  function onLang(app, render) {
    window.addEventListener('t2d:lang', function () {
      var a = document.activeElement, sel = null;
      if (a && a.closest && a.closest('.prefs')) sel = a.hasAttribute('data-lang') ? '[data-lang="' + a.getAttribute('data-lang') + '"]' : '[data-theme-cycle]';
      render();
      if (sel) { var b = app.querySelector('.prefs ' + sel); if (b) b.focus(); }
    });
  }

  /**
   * One track's QR helper. o = { base: '../' | '', site: '', variant: '' }.
   * base = path from the current page to qr/ (where the pre-made images live).
   */
  function track(id, o) {
    var C = def(id);
    var T = { C: C, id: id, base: o.base || '', site: cleanSite(o.site), variant: '' };
    T.refresh = function () { C = T.C = def(id); };   // after a language switch
    T.setVariant = function (v) { v = String(v || '').toUpperCase(); T.variant = (C.variant && C.variant.values.indexOf(v) >= 0) ? v : ''; };
    T.setVariant(o.variant);
    T.custom = function () { return !!(T.site || T.variant); };
    T.variantLabel = function () { return T.variant ? C.variant.label + ' ' + T.variant : ''; };
    T.fullUrl = function (src) {
      return ORIGIN + C.path + '?src=' + (src || 'qr') + (T.variant ? '&' + C.variant.param + '=' + T.variant : '') + (T.site ? '&site=' + T.site : '');
    };
    T.shortUrl = function () { return HOST + C.path.replace(/\/$/, ''); };
    T.img = function (ext) { return T.base + C.img + ext; };
    T.printHref = function (basic) {   // 인쇄 화면 (트랙 페이지의 ?mode=poster), basic = 코드 없이
      var q = ['mode=poster'];
      if (!basic && T.variant) q.push(C.variant.param + '=' + T.variant);
      if (!basic && T.site) q.push('site=' + T.site);
      if (lang() !== 'ko') q.push('lang=' + lang());
      return T.base + C.img + '/?' + q.join('&');
    };
    // 미리 만든 A4 PDF 는 한국어 → 영어 화면에서는 같은 안내문의 영어 인쇄 화면
    T.posterHref = function () { return lang() === 'ko' ? T.base + C.img + '-poster-a4.pdf' : T.printHref(true); };
    T.pageHref = function () { return T.base + id + '/' + (T.site ? '?site=' + T.site : ''); };
    T.message = function () { return C.message(T.fullUrl('kakao'), T.variant); };
    // QR: 코드가 없고 forceStatic 이면 미리 만든 이미지(qr/<id>.svg = make_qr.py 가 만든 QR 과 같은 것)
    T.qrSvg = function (cls, forceStatic) {
      var q = forceStatic ? null : qrModel(T.fullUrl('qr'));
      var label = t('qr.alt', { url: T.shortUrl() });
      if (!q) return '<img class="' + (cls || '') + '" src="' + T.img('.svg') + '" alt="' + esc(label) + '">';
      var n = q.getModuleCount(), m = 4, d = '';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
      return '<svg class="' + (cls || '') + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '" shape-rendering="crispEdges" role="img" aria-label="' + esc(label) + '">' +
        '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    };
    T.cardName = function () {
      return C.file + (T.variant ? '_' + C.variant.label + T.variant : '') + (T.site ? '_' + T.site : '') + '_QR.png';
    };
    // ---------- share image (canvas) ----------
    var FONT = function () { return getComputedStyle(document.body).fontFamily; };
    function fitText(g, text, weight, size, maxW) {
      g.font = weight + ' ' + size + 'px ' + FONT();
      while (size > 18 && g.measureText(text).width > maxW) { size -= 2; g.font = weight + ' ' + size + 'px ' + FONT(); }
    }
    T.preloadFonts = function () {
      if (!document.fonts || !document.fonts.load) return;
      [['800 64px', C.title], ['600 32px', C.subtitle], ['800 40px', 'Type Part AB'], ['800 56px', T.shortUrl()],
        ['500 32px', C.hint.join(' ')], ['600 28px', t('qr.site.line', { site: T.site })]].forEach(function (f) {
        try { document.fonts.load(f[0] + ' ' + FONT(), f[1]).catch(function () {}); } catch (_) {}
      });
    };
    T.cardBlob = function () {
      var q = qrModel(T.fullUrl('qr'));
      if (!q) return fetch(T.img('-card.png')).then(function (r) { if (!r.ok) throw new Error('card'); return r.blob(); });
      var W = 1080, H = 1140 + (T.variant ? 94 : 0) + (T.site ? 52 : 0), cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var g = cv.getContext('2d'), maxW = W - 96, y = 120, ink = INK[id];
      g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
      g.textAlign = 'center';
      g.fillStyle = '#14304a'; fitText(g, C.title, '800', 64, maxW); g.fillText(C.title, W / 2, y);
      y += 62; g.fillStyle = '#5a6b7c'; fitText(g, C.subtitle, '600', 32, maxW); g.fillText(C.subtitle, W / 2, y);
      if (T.variant) {
        var pw = 240, ph = 70; y += 34;
        g.fillStyle = ink; g.beginPath();
        if (g.roundRect) g.roundRect(W / 2 - pw / 2, y, pw, ph, 35); else g.rect(W / 2 - pw / 2, y, pw, ph);
        g.fill(); g.fillStyle = '#fff'; g.font = '800 40px ' + FONT(); g.fillText(T.variantLabel(), W / 2, y + 49);
        y += ph - 10;
      }
      var n = q.getModuleCount(), m = 4, size = 680, cell = size / (n + 2 * m), x0 = (W - size) / 2, y0 = y + 30;
      g.fillStyle = '#000';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(Math.floor(x0 + (c + m) * cell), Math.floor(y0 + (r + m) * cell), Math.ceil(cell), Math.ceil(cell));
      y = y0 + size + 70;
      g.fillStyle = ink; fitText(g, T.shortUrl(), '800', 56, maxW); g.fillText(T.shortUrl(), W / 2, y);
      g.fillStyle = '#5a6b7c';
      y += 70; fitText(g, C.hint[0], '500', 32, maxW); g.fillText(C.hint[0], W / 2, y);
      y += 48; fitText(g, C.hint[1], '500', 32, maxW); g.fillText(C.hint[1], W / 2, y);
      if (T.site) { var sl = t('qr.site.line', { site: T.site }); y += 52; fitText(g, sl, '600', 28, maxW); g.fillText(sl, W / 2, y); }
      return new Promise(function (res, rej) { cv.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob')); }, 'image/png'); });
    };
    T.saveImage = function () {
      T.cardBlob().then(function (b) { saveBlob(b, T.cardName()); }, function () { toast(t('qr.toast.imgFailCopy')); });
    };
    T.shareImage = function () {
      T.cardBlob().then(function (blob) {
        var file = new File([blob], T.cardName(), { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file], title: C.title, text: T.fullUrl('kakao') }).catch(function (e) { if (e && e.name !== 'AbortError') saveBlob(blob, T.cardName()); });
        }
        saveBlob(blob, T.cardName());
      }).catch(function () { toast(t('qr.toast.imgFailSend')); });
    };
    T.copyLink = function () { copy(T.fullUrl('link'), t('qr.toast.linkCopied')); };
    T.copyMessage = function (text) { copy(text || T.message(), t('qr.toast.msgCopied')); };
    T.shareLink = function () { share({ title: C.title, url: T.fullUrl('kakao') }); };
    T.shareMessage = function (text) { share({ title: C.title, text: text || T.message() }); };
    T.present = function () {
      var prev = document.activeElement;
      var el = document.createElement('div');
      el.className = 'present';
      el.setAttribute('data-track', id);
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', t('qr.present.label', { title: C.title }));
      el.innerHTML = '<div><h1>' + esc(C.title) + '</h1><div class="p-sub">' + esc(C.subtitle) + '</div>' +
          (T.variant ? '<span class="pill">' + esc(T.variantLabel()) + '</span>' : '') + '</div>' +
        T.qrSvg('p-qr') +
        '<div><div class="p-url">' + esc(T.shortUrl()) + (T.site ? ' <small>· ' + esc(T.site) + '</small>' : '') + '</div>' +
          '<div class="p-hint">' + esc(t('qr.present.hint', { time: C.time })) + '</div></div>' +
        '<button type="button" class="p-close" aria-label="' + esc(t('qr.close')) + '">✕</button>';
      document.body.appendChild(el);
      var btn = el.querySelector('.p-close');
      var close = function () {
        if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
        el.remove(); document.removeEventListener('keydown', onKey);
        if (prev && prev.focus) prev.focus();
      };
      var onKey = function (e) { if (e.key === 'Escape') close(); else if (e.key === 'Tab') { e.preventDefault(); btn.focus(); } };
      btn.addEventListener('click', close);
      document.addEventListener('keydown', onKey);
      btn.focus();
      if (el.requestFullscreen) el.requestFullscreen().catch(function () {});
    };
    return T;
  }

  // ---------------------------------------------------------------------------
  // header (hub + track pages): same brand and menu as the landing page and About (brand → home, 소개, KO/EN + theme)
  // title = this page's name, shown under the brand; extra = leading nav links (track pages: back to all QR codes)
  // ---------------------------------------------------------------------------
  var ARROW = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>';
  function headerHTML(title, siteRoot, extra) {
    return '<header class="top"><div class="top-inner">' +
      '<a class="brand" href="' + siteRoot + '" aria-label="' + esc(t('site.brand.home')) + '"><span class="mark" aria-hidden="true"></span>' +
        '<span class="title"><strong>' + esc(t('site.brand.name')) + '</strong><small>' + esc(title) + '</small></span></a>' +
      '<div class="top-end"><nav' + (extra ? ' class="with-back"' : '') + ' aria-label="' + esc(t('qr.nav.label')) + '">' + (extra || '') +
        '<a class="nav-about" href="' + siteRoot + 'about/">' + t('site.nav.about') + '</a></nav>' +
        (I && I.controlsHTML ? I.controlsHTML() : '') + '</div>' +
      '</div></header>';
  }
  function bindHeader(app) { if (I && I.bindControls) I.bindControls(app); }
  var small = function () { return ' <small>' + esc(t('qr.opt')) + '</small>'; };

  // ---------------------------------------------------------------------------
  // track page (qr/main/, qr/ca/, qr/gc/)
  // ---------------------------------------------------------------------------
  function page() {
    var body = document.body, id = body.getAttribute('data-track'), base = body.getAttribute('data-base') || '../';
    var params = new URLSearchParams(location.search);
    var mode = params.get('mode') || '';
    var app = document.getElementById('app');

    // ---------- printable outputs (tools/render_qr_assets.js: ?mode=card / ?mode=poster) ----------
    if (mode === 'poster' || mode === 'card') {
      // Printed material is Korean unless ?lang=en asks otherwise. Not saved: the visitor's own language choice stays as it was.
      if (I && params.get('lang') !== 'en' && I.lang !== 'ko') { I.lang = 'ko'; document.documentElement.setAttribute('lang', 'ko'); }
      var T0 = track(id, { base: base, site: params.get('site'), variant: params.get(id === 'ca' ? 'type' : 'part') });
      var C0 = T0.C;
      body.classList.add('print');
      if (T0.custom() && !window.qrcode) { T0.site = ''; T0.variant = ''; }   // QR 에 코드를 담을 수 없으면 기본 안내문으로
      // 기본(코드 없음)은 미리 만든 qr/<id>.svg 를 그대로 써서 qr/<id>.png 와 같은 QR 이 되게 합니다
      var qr = T0.qrSvg('qr', !T0.custom());
      var badge = T0.variant ? '<span class="type">' + esc(T0.variantLabel()) + '</span>' : '';
      if (mode === 'card') {
        app.innerHTML = '<div class="card-img">' +
          '<h1>' + esc(C0.title) + '</h1><div class="en">' + esc(C0.subtitle) + '</div>' + badge + qr +
          '<div class="url">' + esc(T0.shortUrl()) + '</div>' +
          '<div class="hint">' + esc(C0.hint[0]) + '<br>' + esc(C0.hint[1]) + '</div>' +
          (T0.site ? '<div class="site">' + esc(t('qr.site.line', { site: T0.site })) + '</div>' : '') + '</div>';
        return;
      }
      var tracks = id === 'main' ? '<div class="tracks">' +
        '<div style="--c:var(--orange)"><b>' + esc(t('qr.ca.title')) + '</b><span>' + esc(t('qr.ca.audience')) + '<br>' + esc(C0.caTime) + '</span></div>' +
        '<div style="--c:var(--teal)"><b>' + esc(t('qr.gc.title')) + '</b><span>' + esc(t('qr.gc.audience')) + '<br>' + esc(C0.gcTime) + '</span></div></div>' : '';
      app.innerHTML = '<section class="sheet' + (T0.variant ? ' with-part' : '') + (tracks ? ' with-tracks' : '') + '">' +
        '<div class="brand"><span class="mark"></span>' + esc(C0.brand) + '</div>' +
        '<h1>' + esc(C0.title) + '</h1><div class="en">' + esc(C0.subtitle) + '</div>' + badge + qr +
        '<div class="url">' + esc(T0.shortUrl()) + (T0.site ? '<small>' + esc(t('qr.site.line', { site: T0.site })) + '</small>' : '') + '</div>' +
        tracks +
        '<ol class="steps">' + C0.steps(T0.variant).map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>' +
        '<div class="foot">' + C0.foot + '</div></section>' +
        '<button type="button" class="print-btn" id="printBtn">' + esc(t('qr.print')) + '</button>';
      document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
      return;
    }

    // ---------- interactive page ----------
    var T = track(id, { base: base, site: params.get('site'), variant: params.get(id === 'ca' ? 'type' : 'part') });
    function syncUrl() {
      var q = [];
      if (T.variant) q.push(T.C.variant.param + '=' + T.variant);
      if (T.site) q.push('site=' + T.site);
      try { history.replaceState(null, '', q.length ? '?' + q.join('&') : location.pathname); } catch (_) {}
    }
    function render() {
      T.refresh();
      var C = T.C, V = C.variant;
      var noLib = !window.qrcode;
      var allHref = '../' + (T.site ? '?site=' + T.site : '');
      app.innerHTML =
        headerHTML(t('qr.hdr.page', { title: C.title }), '../../',
          '<a class="nav-back" href="' + allHref + '">' + ARROW + '<span>' + esc(t('qr.nav.all')) + '</span></a>') +
        '<main class="share">' +
          '<section class="card qr-wrap" aria-labelledby="qrTitle">' +
            '<h1 class="qr-title" id="qrTitle">' + esc(C.title) + '</h1>' +
            '<p class="qr-en">' + esc(C.subtitle) + '</p>' +
            (T.variant ? '<span class="pill">' + esc(t('qr.variant.pill', { v: T.variantLabel() })) + '</span>' : '') +
            T.qrSvg('qr-img') +
            '<div class="qr-url">' + esc(T.shortUrl()) + (T.site ? ' <small>· ' + esc(T.site) + '</small>' : '') + '</div>' +
            (noLib && T.custom() ? '<p class="warn">' + esc(t('qr.warn.noLib')) + '</p>' : '') +
            '<p class="qr-sub">' + esc(C.who) + '</p>' +
            '<div class="btns">' +
              '<button type="button" class="btn primary wide" id="present">' + esc(t('qr.btn.presentWide')) + '</button>' +
              '<button type="button" class="btn accent" id="shareImg">' + esc(t('qr.btn.shareImg')) + '</button>' +
              '<button type="button" class="btn" id="shareLink">' + esc(t('qr.btn.shareLink')) + '</button>' +
              '<button type="button" class="btn" id="copyLink">' + esc(t('qr.btn.copyLink')) + '</button>' +
              '<button type="button" class="btn" id="dl">' + esc(t('qr.btn.saveImg')) + '</button>' +
            '</div>' +
          '</section>' +

          '<section class="card">' +
            '<h2>' + esc(t('qr.msg.h')) + '</h2>' +
            '<textarea id="msg" aria-label="' + esc(t('qr.msg.aria')) + '">' + esc(T.message()) + '</textarea>' +
            '<div class="btns btns-row"><button type="button" class="btn primary" id="copyMsg">' + esc(t('qr.btn.copyMsg')) + '</button>' +
              '<button type="button" class="btn" id="shareMsg">' + esc(t('qr.btn.shareMsg')) + '</button></div>' +

            '<h2 class="gap"><span>' + esc(t('qr.site.h')) + small() + '</span></h2>' +
            '<p class="muted help">' + esc(t('qr.site.help')) + '</p>' +
            '<div class="site-row"><input id="siteCode" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + esc(t('qr.site.h')) + '" placeholder="' + esc(t('qr.site.ph')) + '" value="' + esc(T.site) + '">' +
            '<button type="button" class="btn primary" id="applySite">' + esc(t('qr.site.apply')) + '</button></div>' +

            (V ? '<h2 class="gap"><span>' + esc(t('qr.variant.h', { label: V.label })) + small() + '</span></h2>' +
              '<p class="muted help">' + V.help + '</p>' +
              '<div class="seg" role="group" aria-label="' + esc(t('qr.variant.h', { label: V.label })) + '" style="--n:' + (V.values.length + 1) + '">' +
                [''].concat(V.values).map(function (p) {
                  return '<button type="button" data-variant="' + p + '" aria-pressed="' + (T.variant === p) + '">' + (p ? esc(V.label) + ' ' + p : esc(V.none)) + '</button>';
                }).join('') +
              '</div>' : '') +

            '<h2 class="gap">' + esc(t('qr.how.h')) + '</h2>' +
            '<ul class="muted">' +
              '<li>' + t('qr.page.how.kakao') + '</li>' +
              '<li>' + t('qr.page.how.room') + '</li>' +
              '<li>' + t('qr.page.how.print') + ' <a href="' + esc(T.posterHref()) + '" target="_blank" rel="noopener">' + esc(t('qr.page.pdf')) + '</a>' +
                (T.custom() ? esc(t('qr.page.pdf.basic')) + ' · <a href="' + esc('?' + T.printHref().split('?')[1]) + '" target="_blank" rel="noopener">' + esc(t('qr.page.printCode')) + '</a>' : '') + '</li>' +
              (id === 'main' ? '<li>' + t('qr.page.how.main') + '</li>' : '') +
              (id === 'ca' ? '<li>' + t('qr.page.how.ca', { list: V.list }) + '</li>' : '') +
              (id === 'gc' ? '<li>' + t('qr.page.how.gc1') + '</li><li>' + t('qr.page.how.gc2', { list: V.list }) + '</li>' : '') +
              '<li>' + t('qr.page.how.all', { link: '<a href="' + allHref + '">' + esc(t('qr.nav.all')) + '</a>' }) + '</li>' +
            '</ul>' +
          '</section>' +
        '</main>';

      bindHeader(app);
      var $ = function (x) { return document.getElementById(x); };
      $('present').addEventListener('click', T.present);
      $('copyLink').addEventListener('click', T.copyLink);
      $('dl').addEventListener('click', T.saveImage);
      $('applySite').addEventListener('click', applySite);
      $('siteCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); applySite(); } });
      Array.prototype.forEach.call(document.querySelectorAll('[data-variant]'), function (b) {
        b.addEventListener('click', function () {
          var before = T.variant;
          T.setVariant(b.getAttribute('data-variant'));
          if (T.variant === before) return;
          syncUrl(); render();
          toast(T.variant ? t('qr.toast.variantSet', { v: T.variantLabel() }) : t('qr.toast.variantOff', { label: V.label }));
        });
      });
      $('copyMsg').addEventListener('click', function () { T.copyMessage($('msg').value); });
      $('shareLink').addEventListener('click', T.shareLink);
      $('shareMsg').addEventListener('click', function () { T.shareMessage($('msg').value); });
      $('shareImg').addEventListener('click', T.shareImage);
      T.preloadFonts();
    }
    function applySite() {
      var v = document.getElementById('siteCode').value, s = cleanSite(v);
      if (s === T.site && v === s) return;
      T.site = s; syncUrl(); render();
      toast(T.site ? t('qr.toast.siteSet', { site: T.site }) : t('qr.toast.siteCleared'));
    }
    render();
    onLang(app, render);
  }

  // ---------------------------------------------------------------------------
  // hub (qr/index.html): the three QR codes side by side
  // ---------------------------------------------------------------------------
  function hub() {
    var params = new URLSearchParams(location.search);
    var site = cleanSite(params.get('site'));
    var app = document.getElementById('app');
    var Ts = {};
    function render() {
      ORDER.forEach(function (id) { Ts[id] = track(id, { base: '', site: site }); });
      var noLib = !window.qrcode;
      app.innerHTML =
        headerHTML(t('qr.hdr.hub'), '../') +
        '<main>' +
          '<section class="card hub-intro">' +
            '<h1>' + esc(t('qr.hub.h')) + '</h1>' +
            '<ul class="which">' + ORDER.map(function (id) {
              return '<li><span class="dot" data-track="' + id + '" aria-hidden="true"></span><span>' + t('qr.hub.which.' + id) + '</span></li>';
            }).join('') + '</ul>' +
            (site ? '<p>' + t('qr.hub.siteOn', { site: esc(site) }) + '</p>' : '') +
            (noLib && site ? '<p class="warn" style="margin-top:8px">' + esc(t('qr.hub.warnNoLib')) + '</p>' : '') +
          '</section>' +
          '<div class="qr-grid">' + ORDER.map(cardHTML).join('') + '</div>' +
          '<section class="card">' +
            '<h2><span>' + esc(t('qr.site.h')) + ' <small>' + esc(t('qr.hub.site.small')) + '</small></span></h2>' +
            '<p class="muted help">' + esc(t('qr.site.help')) + '</p>' +
            '<div class="site-row"><input id="siteCode" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' + esc(t('qr.site.h')) + '" placeholder="' + esc(t('qr.site.ph')) + '" value="' + esc(site) + '">' +
            '<button type="button" class="btn primary" id="applySite">' + esc(t('qr.site.apply')) + '</button></div>' +
            '<h2 class="gap">' + esc(t('qr.how.h')) + '</h2>' +
            '<ul class="muted">' +
              '<li>' + t('qr.hub.how.room') + '</li>' +
              '<li>' + t('qr.hub.how.kakao') + '</li>' +
              '<li>' + t('qr.hub.how.print') + '</li>' +
            '</ul>' +
          '</section>' +
        '</main>';
      bindHeader(app);
      Array.prototype.forEach.call(app.querySelectorAll('[data-act]'), function (b) {
        b.addEventListener('click', function () {
          var T = Ts[b.getAttribute('data-id')], act = b.getAttribute('data-act');
          if (act === 'present') T.present();
          else if (act === 'copy') T.copyLink();
          else if (act === 'msg') T.copyMessage();
          else if (act === 'share') T.shareImage();
          else if (act === 'png') T.saveImage();
        });
      });
      document.getElementById('applySite').addEventListener('click', applySite);
      document.getElementById('siteCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); applySite(); } });
      ORDER.forEach(function (id) { Ts[id].preloadFonts(); });
    }
    function cardHTML(id) {
      var T = Ts[id], C = T.C;
      var b = function (act, label, cls) { return '<button type="button" class="btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-id="' + id + '">' + esc(label) + '</button>'; };
      return '<section class="card qr-card' + (id === 'main' ? ' featured' : '') + '" data-track="' + id + '" aria-labelledby="h_' + id + '">' +
        T.qrSvg('qr-img') +
        '<div class="head">' + (id === 'main' ? '<span class="badge">' + esc(t('qr.hub.badge')) + '</span>' : '') +
          '<h2 id="h_' + id + '">' + esc(C.title) + '</h2>' +
          '<p class="who">' + esc(C.who) + '</p></div>' +
        '<div class="qr-url">' + esc(T.shortUrl()) + (site ? ' <small>· ' + esc(site) + '</small>' : '') + '</div>' +
        '<div class="btns">' +
          b('present', t('qr.btn.present'), 'primary wide') +
          b('copy', t('qr.btn.copyLink')) + b('msg', t('qr.btn.copyMsgCard')) +
          b('share', t('qr.btn.shareImg'), 'accent') + b('png', t('qr.btn.png')) +
          '<a class="btn" href="' + esc(site ? T.printHref() : T.posterHref()) + '" target="_blank" rel="noopener">' + esc(t(site ? 'qr.btn.a4code' : 'qr.btn.a4')) + '</a>' +
          '<a class="btn" href="' + esc(T.pageHref()) + '">' + esc(t('qr.btn.settings')) + '</a>' +
        '</div>' +
      '</section>';
    }
    function applySite() {
      var v = document.getElementById('siteCode').value, s = cleanSite(v);
      if (s === site && v === s) return;
      site = s;
      try { history.replaceState(null, '', site ? '?site=' + site : location.pathname); } catch (_) {}
      render();
      toast(site ? t('qr.toast.siteSet3', { site: site }) : t('qr.toast.siteCleared'));
    }
    render();
    onLang(app, render);
  }

  window.QRSite = { HOST: HOST, ORDER: ORDER, def: def, track: track, page: page, hub: hub };
})();
