/* QR 안내 — 공용 코드
 * ------------------------------------------------------------
 * 쓰는 곳: qr/index.html (허브: QR 3종을 한 화면에), qr/main/ · qr/ca/ · qr/gc/ (트랙별 공유 페이지: 안내 문구·코드·인쇄)
 *   <body data-track="ca" data-base="../">  →  QRSite.page()      (트랙별 페이지, ?mode=card | ?mode=poster 는 인쇄용)
 *   <body data-base="">                    →  QRSite.hub()       (허브)
 * QR 이 가리키는 주소 (tools/make_qr.py 와 같아야 합니다):
 *   main  https://eval.asclep.org/?src=qr      처음 화면 — 두 평가 중 선택 (이미 인쇄된 select.* 와 같은 주소)
 *   ca    https://eval.asclep.org/ca/?src=qr   임상 수용성 평가
 *   gc    https://eval.asclep.org/gc/?src=qr   가이드라인 부합도 검증
 * 미리 만든 이미지: qr/<id>.svg|png (make_qr.py), qr/<id>-card.png · qr/<id>-poster-a4.pdf (tools/render_qr_assets.js)
 * 기관·세션 코드(site)나 Type/Part 를 넣으면 QR 은 브라우저에서 즉석 생성합니다(qrcode-generator, 없으면 기본 이미지). */
(function () {
  'use strict';
  var HOST = 'eval.asclep.org';
  var ORIGIN = 'https://' + HOST;
  var GC_TIME = 'Part A 약 20–25분 · Part B 약 10–15분';
  var CA_TIME = 'AI 답변 2건 · 약 20–30분';

  var TRACKS = {
    main: {
      id: 'main', path: '/', img: 'main', name: '통합 QR',
      title: '제2형 당뇨병 AI 벤치마크 평가 참여',
      subtitle: '두 평가 중 선택 · 임상 수용성 / 가이드라인 부합도',
      who: '처음 화면에서 두 평가 중 하나를 고릅니다. 대상이 섞인 자리(학회·병원 공지)에 권장',
      brand: 'Hybrid Physician–AI Benchmark · 제2형 당뇨병 CDSS',
      time: '평가별 약 10–30분',
      hint: ['휴대폰 카메라로 QR을 비추면 평가 선택 화면이 열립니다', '두 평가 중 하나를 고르세요 · 중간에 닫아도 이어서 진행됩니다'],
      steps: function () {
        return ['휴대폰 기본 카메라로 위 QR 코드를 비추세요.',
          '첫 화면에서 참여할 평가를 고르세요. 인턴·레지던트·전문의는 <b>임상 수용성 평가</b>, 내분비대사내과 분과전문의는 <b>가이드라인 부합도 검증</b>도 참여할 수 있습니다.',
          '화면 안내에 따라 AI 답변을 읽고 평가합니다. 벤치마크 소개는 첫 화면의 <b>[벤치마크 소개]</b>에서 볼 수 있습니다.'];
      },
      foot: '중간에 닫아도 같은 기기·브라우저에서 다시 열면 이어서 진행됩니다.',
      message: function (url) {
        return '[제2형 당뇨병 AI 벤치마크 평가 참여 안내]\n' +
          '안녕하세요. 제2형 당뇨병 AI 임상 의사결정 지원 시스템(CDSS)의 답변을 의사가 직접 평가하는 연구(Hybrid Physician–AI Benchmark)에 참여를 부탁드립니다.\n\n' +
          '첫 화면에서 해당하는 평가를 골라 주세요.\n' +
          '• 임상 수용성 평가 — 인턴·레지던트·전문의 · ' + CA_TIME + '\n' +
          '• 가이드라인 부합도 검증 — 내분비대사내과 분과전문의 · ' + GC_TIME + '\n' +
          '• 휴대폰으로 바로 참여할 수 있고, 중간에 닫아도 같은 기기에서 다시 열면 이어서 진행됩니다\n\n' +
          '▶ 참여 링크: ' + url + '\n' +
          '▶ 벤치마크 소개: ' + ORIGIN + '/about/\n\n' +
          '※ 여러 사람이 함께 있는 자리에서도 평가는 각자 독립적으로 해 주세요.';
      }
    },
    ca: {
      id: 'ca', path: '/ca/', img: 'ca', name: '임상 수용성 평가',
      title: '임상 수용성 평가',
      subtitle: 'Clinical Acceptability · 인턴·레지던트·전문의',
      who: '인턴·레지던트·전문의 · ' + CA_TIME,
      brand: 'AI 기반 T2D 임상 의사결정 지원 시스템',
      time: CA_TIME,
      hint: ['휴대폰 카메라로 QR을 비추면 평가가 시작됩니다', CA_TIME + ' · 중간에 닫아도 이어서 진행됩니다'],
      variant: { param: 'type', label: 'Type', values: ['A', 'B'], none: '직접 선택',
        help: '보통은 <b>직접 선택</b>으로 두세요. 한 자리에서 Type을 나눠 부탁드릴 때만 지정하면, 시작 화면에서 그 Type이 미리 선택됩니다(바꿀 수 있음).' },
      steps: function (v) {
        return ['휴대폰 기본 카메라로 위 QR 코드를 비추세요.',
          '성명과 직군(인턴·레지던트·전문의)을 입력하고, ' + (v ? '<b>Type ' + v + '</b>로 시작하세요' : '평가 유형(Type A·B)을 고르세요') + '.',
          'AI 답변 2건을 읽고 Phase별로 1–5점 평가합니다 (약 20–30분).'];
      },
      foot: '중간에 닫아도 같은 기기·브라우저에서 다시 열면 이어서 진행됩니다.<br>한 Type을 마치면 다른 Type도 이어서 평가할 수 있습니다.',
      message: function (url, v) {
        return '[임상 수용성 평가 참여 안내]\n' +
          '안녕하세요. AI 기반 제2형 당뇨병 외래 진료 권고안에 대한 임상 수용성 평가에 참여 부탁드립니다.\n\n' +
          '• 대상: 인턴·레지던트·전문의\n' +
          '• 소요 시간: 약 20–30분 (AI 답변 2건' + (v ? ', 이번 안내: Type ' + v : ', 시작 화면에서 Type A·B 중 선택') + ')\n' +
          '• 휴대폰으로 바로 참여할 수 있습니다\n' +
          '• 중간에 닫아도 같은 기기에서 다시 열면 이어서 진행됩니다\n\n' +
          '▶ 참여 링크: ' + url + '\n\n' +
          '※ 여러 사람이 함께 있는 자리에서도 평가는 각자 독립적으로 해 주세요.';
      }
    },
    gc: {
      id: 'gc', path: '/gc/', img: 'gc', name: '가이드라인 부합도 검증',
      title: '가이드라인 부합도 검증',
      subtitle: 'Physician Validation · 내분비대사내과 분과전문의',
      who: '내분비대사내과 분과전문의 · ' + GC_TIME,
      brand: 'AI 기반 T2D 임상 의사결정 지원 시스템',
      time: GC_TIME,
      hint: ['휴대폰 카메라로 QR을 비추면 검증이 시작됩니다', GC_TIME + ' · 중간에 닫아도 이어서 진행됩니다'],
      variant: { param: 'part', label: 'Part', values: ['A', 'B'], none: '직접 선택',
        help: '보통은 <b>직접 선택</b>으로 두세요. 한 자리에서 Part를 나눠 부탁드릴 때만 지정하면, 시작 화면에서 그 Part가 미리 선택됩니다(바꿀 수 있음).' },
      steps: function (v) {
        return ['휴대폰 기본 카메라로 위 QR 코드를 비추세요.',
          '분과전문의 여부를 확인하고, 성명과 간단한 경력 정보를 입력한 뒤 ' + (v ? '<b>Part ' + v + '</b>로 시작하세요' : 'Part A·B 중 하나를 고르세요') + '.',
          'AI 채점 판정 중 <b>AI 감사가 다시 확인이 필요하다고 표시한 판정</b>만 보고, 동의 또는 비동의를 고릅니다 (' + GC_TIME + ').'];
      },
      foot: '중간에 닫아도 같은 기기·브라우저에서 다시 열면 이어서 진행됩니다.<br>한 Part를 마치면 다른 Part도 이어서 검증할 수 있습니다.',
      message: function (url, v) {
        return '[가이드라인 부합도 검증 참여 안내]\n' +
          '안녕하세요. 내분비대사내과 분과전문의 선생님께 AI 기반 제2형 당뇨병 진료 권고안의 가이드라인 부합도 채점에 대한 전문가 검증을 부탁드립니다.\n\n' +
          'AI가 CDSS 답변을 가이드라인 기반 채점표로 채점한 판정 가운데, AI 감사가 다시 확인이 필요하다고 표시한 판정만 보여 드립니다. ' +
          '판정마다 동의 또는 비동의(비동의 시 올바른 판정 선택)를 골라 주시면 됩니다.\n\n' +
          '• 대상: 내분비대사내과 분과전문의\n' +
          '• 소요 시간: ' + GC_TIME + (v ? ' (이번 안내: Part ' + v + ')' : ' (시작 화면에서 Part A·B 중 하나 선택)') + '\n' +
          '• 한 Part를 마치신 뒤 다른 Part도 이어서 검증해 주시면 큰 도움이 됩니다\n' +
          '• 휴대폰으로 바로 참여할 수 있고, 중간에 닫아도 같은 기기에서 다시 열면 이어서 진행됩니다\n\n' +
          '▶ 참여 링크: ' + url + '\n\n' +
          '※ 여러 분이 함께 계신 자리에서도 검증은 각자 독립적으로 해 주세요.';
      }
    }
  };
  var ORDER = ['main', 'ca', 'gc'];
  var INK = { main: '#14304a', ca: '#b4541a', gc: '#187368' };

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var cleanSite = function (v) { return String(v || '').replace(/[^0-9A-Za-z_\-]/g, '').slice(0, 20); };
  var toastT;
  function toast(msg) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 2600);
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
      navigator.clipboard.writeText(text).then(ok, function () { fallbackCopy(text) ? ok() : toast('복사하지 못했습니다. 길게 눌러 복사해 주세요.'); });
    } else { fallbackCopy(text) ? ok() : toast('복사하지 못했습니다. 길게 눌러 복사해 주세요.'); }
  }
  function share(data) {
    if (navigator.share) {
      navigator.share(data).catch(function (e) { if (e && e.name !== 'AbortError') copy(data.url || data.text, '공유가 지원되지 않아 복사했습니다'); });
    } else {
      copy(data.url || data.text, '이 기기는 공유 기능이 없어 복사했습니다. 카카오톡에 붙여넣어 주세요');
    }
  }
  function saveBlob(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('이미지를 저장했습니다. 카카오톡에서 사진으로 보내 주세요');
  }
  function qrModel(url) {
    if (!window.qrcode) return null;
    var q = window.qrcode(0, 'Q'); q.addData(url); q.make(); return q;
  }

  /**
   * One track's QR helper. o = { base: '../' | '', site: '', variant: '' }.
   * base = path from the current page to qr/ (where the pre-made images live).
   */
  function track(id, o) {
    var C = TRACKS[id];
    var T = { C: C, id: id, base: o.base || '', site: cleanSite(o.site), variant: '' };
    T.setVariant = function (v) { v = String(v || '').toUpperCase(); T.variant = (C.variant && C.variant.values.indexOf(v) >= 0) ? v : ''; };
    T.setVariant(o.variant);
    T.custom = function () { return !!(T.site || T.variant); };
    T.variantLabel = function () { return T.variant ? C.variant.label + ' ' + T.variant : ''; };
    T.fullUrl = function (src) {
      return ORIGIN + C.path + '?src=' + (src || 'qr') + (T.variant ? '&' + C.variant.param + '=' + T.variant : '') + (T.site ? '&site=' + T.site : '');
    };
    T.shortUrl = function () { return HOST + C.path.replace(/\/$/, ''); };
    T.img = function (ext) { return T.base + C.img + ext; };
    T.posterHref = function () { return T.base + C.img + '-poster-a4.pdf'; };
    T.printHref = function () {   // 코드가 들어간 안내문 (트랙 페이지의 ?mode=poster)
      var q = ['mode=poster'];
      if (T.variant) q.push(C.variant.param + '=' + T.variant);
      if (T.site) q.push('site=' + T.site);
      return T.base + (id === 'main' ? 'main' : C.img) + '/?' + q.join('&');
    };
    T.pageHref = function () { return T.base + id + '/' + (T.site ? '?site=' + T.site : ''); };
    T.message = function () { return C.message(T.fullUrl('kakao'), T.variant); };
    // QR: 코드가 없고 forceStatic 이면 미리 만든 이미지(qr/<id>.svg = make_qr.py 가 만든 QR 과 같은 것)
    T.qrSvg = function (cls, forceStatic) {
      var q = forceStatic ? null : qrModel(T.fullUrl('qr'));
      var label = 'QR 코드: ' + T.shortUrl();
      if (!q) return '<img class="' + (cls || '') + '" src="' + T.img('.svg') + '" alt="' + esc(label) + '">';
      var n = q.getModuleCount(), m = 4, d = '';
      for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
      return '<svg class="' + (cls || '') + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (n + 2 * m) + ' ' + (n + 2 * m) + '" shape-rendering="crispEdges" role="img" aria-label="' + esc(label) + '">' +
        '<rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    };
    T.cardName = function () {
      return C.title.replace(/\s/g, '') + (T.variant ? '_' + C.variant.label + T.variant : '') + (T.site ? '_' + T.site : '') + '_QR.png';
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
        ['500 32px', C.hint.join(' ')], ['600 28px', '기관·세션 코드: ' + T.site]].forEach(function (f) {
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
      if (T.site) { y += 52; fitText(g, '기관·세션 코드: ' + T.site, '600', 28, maxW); g.fillText('기관·세션 코드: ' + T.site, W / 2, y); }
      return new Promise(function (res, rej) { cv.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob')); }, 'image/png'); });
    };
    T.saveImage = function () {
      T.cardBlob().then(function (b) { saveBlob(b, T.cardName()); }, function () { toast('이미지를 만들지 못했습니다. [링크 복사]를 이용해 주세요'); });
    };
    T.shareImage = function () {
      T.cardBlob().then(function (blob) {
        var file = new File([blob], T.cardName(), { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file], title: C.title, text: T.fullUrl('kakao') }).catch(function (e) { if (e && e.name !== 'AbortError') saveBlob(blob, T.cardName()); });
        }
        saveBlob(blob, T.cardName());
      }).catch(function () { toast('이미지를 만들지 못했습니다. [링크 보내기]를 이용해 주세요'); });
    };
    T.copyLink = function () { copy(T.fullUrl('link'), '링크를 복사했습니다'); };
    T.copyMessage = function (text) { copy(text || T.message(), '안내 문구를 복사했습니다'); };
    T.shareLink = function () { share({ title: C.title, url: T.fullUrl('kakao') }); };
    T.shareMessage = function (text) { share({ title: C.title, text: text || T.message() }); };
    T.present = function () {
      var prev = document.activeElement;
      var el = document.createElement('div');
      el.className = 'present';
      el.setAttribute('data-track', id);
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      el.setAttribute('aria-label', C.title + ' QR 코드');
      el.innerHTML = '<div><h1>' + esc(C.title) + '</h1><div class="p-sub">' + esc(C.subtitle) + '</div>' +
          (T.variant ? '<span class="pill">' + esc(T.variantLabel()) + '</span>' : '') + '</div>' +
        T.qrSvg('p-qr') +
        '<div><div class="p-url">' + esc(T.shortUrl()) + (T.site ? ' <small>· ' + esc(T.site) + '</small>' : '') + '</div>' +
          '<div class="p-hint">휴대폰 카메라로 QR 코드를 비춰 주세요 · ' + esc(C.time) + ' · 중간에 닫아도 이어서 진행됩니다</div></div>' +
        '<button type="button" class="p-close" aria-label="닫기">✕</button>';
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
  // header (hub + track pages): brand, back to the hub, site links
  // ---------------------------------------------------------------------------
  var ARROW = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>';
  // Same brand and menu as the landing page and About (site.css .site-header): brand → home, 홈 · 벤치마크 소개 · 평가 참여.
  // title = this page's name, shown under the brand. (sub is no longer shown in the header.)
  function headerHTML(title, sub, siteRoot, extra) {
    return '<header class="top"><div class="top-inner">' +
      '<a class="brand" href="' + siteRoot + '" aria-label="홈 — T2D 벤치마크"><span class="mark" aria-hidden="true"></span>' +
        '<span class="title"><strong>T2D 벤치마크</strong><small>' + esc(title) + '</small></span></a>' +
      '<nav aria-label="사이트 메뉴">' + (extra || '') +
        '<a class="nav-home" href="' + siteRoot + '">홈</a><a href="' + siteRoot + 'about/">벤치마크 소개</a>' +
        '<a class="nav-cta" href="' + siteRoot + '#tracks">평가 참여</a></nav>' +
      '</div></header>';
  }

  // ---------------------------------------------------------------------------
  // track page (qr/main/, qr/ca/, qr/gc/)
  // ---------------------------------------------------------------------------
  function page() {
    var body = document.body, id = body.getAttribute('data-track'), base = body.getAttribute('data-base') || '../';
    var C = TRACKS[id];
    var params = new URLSearchParams(location.search);
    var mode = params.get('mode') || '';
    var T = track(id, { base: base, site: params.get('site'), variant: C.variant ? params.get(C.variant.param) : '' });
    var app = document.getElementById('app');

    // ---------- printable outputs (tools/render_qr_assets.js: ?mode=card / ?mode=poster) ----------
    if (mode === 'poster' || mode === 'card') {
      body.classList.add('print');
      if (T.custom() && !window.qrcode) { T.site = ''; T.variant = ''; }   // QR 에 코드를 담을 수 없으면 기본 안내문으로
      // 기본(코드 없음)은 미리 만든 qr/<id>.svg 를 그대로 써서 qr/<id>.png 와 같은 QR 이 되게 합니다
      var qr = T.qrSvg('qr', !T.custom());
      var badge = T.variant ? '<span class="type">' + esc(T.variantLabel()) + '</span>' : '';
      if (mode === 'card') {
        app.innerHTML = '<div class="card-img">' +
          '<h1>' + esc(C.title) + '</h1><div class="en">' + esc(C.subtitle) + '</div>' + badge + qr +
          '<div class="url">' + esc(T.shortUrl()) + '</div>' +
          '<div class="hint">' + esc(C.hint[0]) + '<br>' + esc(C.hint[1]) + '</div>' +
          (T.site ? '<div class="site">기관·세션 코드: ' + esc(T.site) + '</div>' : '') + '</div>';
        return;
      }
      var tracks = id === 'main' ? '<div class="tracks">' +
        '<div style="--c:var(--orange)"><b>임상 수용성 평가</b><span>인턴·레지던트·전문의<br>' + esc(CA_TIME) + '</span></div>' +
        '<div style="--c:var(--teal)"><b>가이드라인 부합도 검증</b><span>내분비대사내과 분과전문의<br>' + esc(GC_TIME) + '</span></div></div>' : '';
      app.innerHTML = '<section class="sheet' + (T.variant ? ' with-part' : '') + (tracks ? ' with-tracks' : '') + '">' +
        '<div class="brand"><span class="mark"></span>' + esc(C.brand) + '</div>' +
        '<h1>' + esc(C.title) + '</h1><div class="en">' + esc(C.subtitle) + '</div>' + badge + qr +
        '<div class="url">' + esc(T.shortUrl()) + (T.site ? '<small>기관·세션 코드: ' + esc(T.site) + '</small>' : '') + '</div>' +
        tracks +
        '<ol class="steps">' + C.steps(T.variant).map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>' +
        '<div class="foot">' + C.foot + '</div></section>' +
        '<button type="button" class="print-btn" id="printBtn">인쇄하기</button>';
      document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
      return;
    }

    // ---------- interactive page ----------
    function syncUrl() {
      var q = [];
      if (T.variant) q.push(C.variant.param + '=' + T.variant);
      if (T.site) q.push('site=' + T.site);
      try { history.replaceState(null, '', q.length ? '?' + q.join('&') : location.pathname); } catch (_) {}
    }
    function render() {
      var noLib = !window.qrcode;
      var V = C.variant;
      app.innerHTML =
        headerHTML(C.title + ' · QR 안내', '화면에 띄우거나 카카오톡으로 보내 참여를 안내하세요', '../../',
          '<a href="../' + (T.site ? '?site=' + T.site : '') + '">' + ARROW + '모든 QR</a>') +
        '<main class="share">' +
          '<section class="card qr-wrap" aria-labelledby="qrTitle">' +
            '<h1 class="qr-title" id="qrTitle">' + esc(C.title) + '</h1>' +
            '<p class="qr-en">' + esc(C.subtitle) + '</p>' +
            (T.variant ? '<span class="pill">' + esc(T.variantLabel()) + ' 지정</span>' : '') +
            T.qrSvg('qr-img') +
            '<div class="qr-url">' + esc(T.shortUrl()) + (T.site ? ' <small>· ' + esc(T.site) + '</small>' : '') + '</div>' +
            (noLib && T.custom() ? '<p class="warn">QR 생성 도구를 불러오지 못해 코드가 없는 기본 QR을 보여 드립니다. 링크와 안내 문구에는 코드가 그대로 들어갑니다.</p>' : '') +
            '<p class="qr-sub">' + esc(C.who) + '</p>' +
            '<div class="btns">' +
              '<button type="button" class="btn primary wide" id="present">화면에 크게 띄우기</button>' +
              '<button type="button" class="btn accent" id="shareImg">QR 이미지 보내기</button>' +
              '<button type="button" class="btn" id="shareLink">링크 보내기</button>' +
              '<button type="button" class="btn" id="copyLink">링크 복사</button>' +
              '<button type="button" class="btn" id="dl">QR 이미지 저장</button>' +
            '</div>' +
          '</section>' +

          '<section class="card">' +
            '<h2>카카오톡 안내 문구</h2>' +
            '<textarea id="msg" aria-label="안내 문구">' + esc(T.message()) + '</textarea>' +
            '<div class="btns" style="max-width:none;margin-top:8px"><button type="button" class="btn primary" id="copyMsg">문구 복사</button><button type="button" class="btn" id="shareMsg">문구와 함께 공유</button></div>' +

            '<h2 style="margin-top:18px">기관·세션 코드 <small>(선택)</small></h2>' +
            '<p class="muted" style="margin:0 0 8px">여러 병원·학회·회차에서 모집할 때 코드를 넣으면 QR과 링크에 담겨, 어디서 참여했는지 결과에 함께 기록됩니다. 영문·숫자만.</p>' +
            '<div class="site-row"><input id="siteCode" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="기관·세션 코드" placeholder="예: SNUH01, kes2026" value="' + esc(T.site) + '">' +
            '<button type="button" class="btn primary" id="applySite">적용</button></div>' +

            (V ? '<h2 style="margin-top:18px">' + esc(V.label) + ' 지정 <small>(선택)</small></h2>' +
              '<p class="muted" style="margin:0 0 8px">' + V.help + '</p>' +
              '<div class="seg" role="group" aria-label="' + esc(V.label) + ' 지정">' +
                [''].concat(V.values).map(function (p) {
                  return '<button type="button" data-variant="' + p + '" aria-pressed="' + (T.variant === p) + '">' + (p ? esc(V.label) + ' ' + p : esc(V.none)) + '</button>';
                }).join('') +
              '</div>' : '') +

            '<h2 style="margin-top:18px">이렇게 쓰세요</h2>' +
            '<ul class="muted">' +
              '<li><b>카카오톡:</b> [QR 이미지 보내기] 또는 [링크 보내기] → 공유 목록에서 카카오톡 선택. PC에서는 [문구 복사] 후 대화창에 붙여넣기.</li>' +
              '<li><b>학회·회의실:</b> [화면에 크게 띄우기] → 참가자가 카메라로 스캔.</li>' +
              '<li><b>인쇄:</b> <a href="' + T.posterHref() + '" target="_blank" rel="noopener">A4 안내문 PDF</a>' +
                (T.custom() ? ' (기본 QR) · <a href="' + esc('?' + T.printHref().split('?')[1]) + '" target="_blank" rel="noopener">코드가 들어간 안내문 인쇄</a>' : '') + '</li>' +
              (id === 'main' ? '<li>QR을 찍으면 <b>처음 화면</b>이 열리고, 참여자가 임상 수용성 평가와 가이드라인 부합도 검증 중 하나를 고릅니다.</li>' : '') +
              (id === 'ca' ? '<li>평가자는 시작 화면에서 <b>Type A·B 중 하나를 직접</b> 고릅니다. 끝나면 다른 Type도 이어서 평가할 수 있습니다.</li>' : '') +
              (id === 'gc' ? '<li><b>대상:</b> 내분비대사내과 분과전문의만 참여합니다. 시작 화면에서 본인이 확인합니다.</li>' +
                '<li>검증자는 시작 화면에서 <b>Part A·B 중 하나를 직접</b> 고릅니다. 끝나면 다른 Part도 이어서 검증할 수 있습니다.</li>' : '') +
              '<li>다른 QR(통합 · 임상 수용성 · 가이드라인 부합도)은 <a href="../' + (T.site ? '?site=' + T.site : '') + '">모든 QR</a>에 있습니다.</li>' +
            '</ul>' +
          '</section>' +
        '</main>';

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
          toast(T.variant ? T.variantLabel() + '가 QR과 링크에 반영되었습니다' : V.label + ' 지정을 해제했습니다 (참여자가 직접 선택)');
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
      toast(T.site ? '기관·세션 코드 "' + T.site + '"가 QR과 링크에 반영되었습니다' : '기관·세션 코드를 지웠습니다');
    }
    render();
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
        headerHTML('QR · 참여 안내', '평가 참여를 안내할 QR 코드와 링크', '../') +
        '<main>' +
          '<section class="card hub-intro">' +
            '<h1>어떤 QR을 쓸까요?</h1>' +
            '<ul class="which">' +
              '<li><span class="dot" data-track="main" aria-hidden="true"></span><span><b>통합 QR (권장)</b> — 대상이 섞인 자리. 처음 화면에서 참여자가 두 평가 중 하나를 고릅니다.</span></li>' +
              '<li><span class="dot" data-track="ca" aria-hidden="true"></span><span><b>임상 수용성 평가</b> — 인턴·레지던트·전문의에게 바로 평가 화면을 열어 줄 때.</span></li>' +
              '<li><span class="dot" data-track="gc" aria-hidden="true"></span><span><b>가이드라인 부합도 검증</b> — 내분비대사내과 분과전문의 모임에서.</span></li>' +
            '</ul>' +
            (site ? '<p>기관·세션 코드 <b>' + esc(site) + '</b>가 아래 QR과 링크에 모두 들어가 있습니다.</p>' : '') +
            (noLib && site ? '<p class="warn" style="margin-top:8px">QR 생성 도구를 불러오지 못해 QR에는 코드가 들어가지 않습니다. 링크에는 들어갑니다.</p>' : '') +
          '</section>' +
          '<div class="qr-grid">' + ORDER.map(cardHTML).join('') + '</div>' +
          '<section class="card">' +
            '<h2>기관·세션 코드 <small>(선택 · 세 QR 모두에 적용)</small></h2>' +
            '<p class="muted" style="margin:0 0 8px">여러 병원·학회·회차에서 모집할 때 코드를 넣으면 QR과 링크에 담겨, 어디서 참여했는지 결과에 함께 기록됩니다. 영문·숫자만.</p>' +
            '<div class="site-row"><input id="siteCode" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="기관·세션 코드" placeholder="예: SNUH01, kes2026" value="' + esc(site) + '">' +
            '<button type="button" class="btn primary" id="applySite">적용</button></div>' +
            '<h2 style="margin-top:18px">이렇게 쓰세요</h2>' +
            '<ul class="muted">' +
              '<li><b>회의·강의실:</b> [크게 띄우기] → 참가자가 휴대폰 카메라로 스캔.</li>' +
              '<li><b>카카오톡:</b> [QR 이미지 보내기] 또는 [안내 문구 복사] → 대화창에 붙여넣기. 문구를 고치거나 Type·Part를 지정하려면 각 카드의 <b>[안내 문구·설정]</b>.</li>' +
              '<li><b>인쇄:</b> 각 카드의 [A4 PDF]. 이미 인쇄해 둔 예전 임상 수용성 평가 QR(eval.asclep.org)은 이제 처음 화면으로 열립니다.</li>' +
            '</ul>' +
          '</section>' +
        '</main>';
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
      var b = function (act, label, cls) { return '<button type="button" class="btn' + (cls ? ' ' + cls : '') + '" data-act="' + act + '" data-id="' + id + '">' + label + '</button>'; };
      return '<section class="card qr-card' + (id === 'main' ? ' featured' : '') + '" data-track="' + id + '" aria-labelledby="h_' + id + '">' +
        T.qrSvg('qr-img') +
        '<div class="head">' + (id === 'main' ? '<span class="badge">추천 · 통합</span>' : '') +
          '<h2 id="h_' + id + '">' + esc(C.title) + '</h2>' +
          '<p class="who">' + esc(C.who) + '</p></div>' +
        '<div class="qr-url">' + esc(T.shortUrl()) + (site ? ' <small>· ' + esc(site) + '</small>' : '') + '</div>' +
        '<div class="btns">' +
          b('present', '크게 띄우기', 'primary wide') +
          b('copy', '링크 복사') + b('msg', '안내 문구 복사') +
          b('share', 'QR 이미지 보내기', 'accent') + b('png', 'PNG 저장') +
          '<a class="btn" href="' + esc(site ? T.printHref() : T.posterHref()) + '" target="_blank" rel="noopener">' + (site ? 'A4 인쇄 (코드 포함)' : 'A4 PDF') + '</a>' +
          '<a class="btn" href="' + esc(T.pageHref()) + '">안내 문구·설정</a>' +
        '</div>' +
      '</section>';
    }
    function applySite() {
      var v = document.getElementById('siteCode').value, s = cleanSite(v);
      if (s === site && v === s) return;
      site = s;
      try { history.replaceState(null, '', site ? '?site=' + site : location.pathname); } catch (_) {}
      render();
      toast(site ? '기관·세션 코드 "' + site + '"가 세 QR과 링크에 반영되었습니다' : '기관·세션 코드를 지웠습니다');
    }
    render();
  }

  window.QRSite = { HOST: HOST, TRACKS: TRACKS, ORDER: ORDER, track: track, page: page, hub: hub };
})();
