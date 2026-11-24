/* T2D site — feature gate for areas that are built but not open yet.
 *
 * window.T2D_FEATURES: true = open, false = links to it show a "currently disabled" dialog instead of navigating.
 * The pages themselves stay in place (their URLs were never shared); only the buttons and links are gated.
 * Load after assets/i18n.js on every page that links to a gated area (landing, About, QR hub, /ca/).
 *
 *   gc    → /gc/     가이드라인 부합도 검증 (guideline-concordance validation)
 *   about → /about/  벤치마크 소개 (About the benchmark)
 *
 * To open an area later: set its flag to true (one line) and push. Nothing else needs to change.
 */
window.T2D_FEATURES = window.T2D_FEATURES || { gc: false, about: false };

(function () {
  'use strict';
  var F = window.T2D_FEATURES;
  var T2D = window.T2D || {};
  var tr = function (key) { return T2D.t ? T2D.t(key) : key; };

  if (T2D.i18n) {
    T2D.i18n.add({
      ko: {
        'feat.badge': '준비 중',
        'feat.close': '닫기',
        'feat.toCa': '임상 수용성 평가 시작',
        'feat.gc.title': '가이드라인 부합도 검증은 현재 비활성화되어 있습니다',
        'feat.gc.body': '지금은 임상 수용성 평가만 진행하고 있습니다. 이 검증은 준비가 끝나는 대로 열어 안내드리겠습니다.',
        'feat.about.title': '벤치마크 소개 페이지는 현재 비활성화되어 있습니다',
        'feat.about.body': '지금은 임상 수용성 평가만 진행하고 있습니다. 소개 페이지는 준비가 끝나는 대로 공개합니다.'
      },
      en: {
        'feat.badge': 'Coming soon',
        'feat.close': 'Close',
        'feat.toCa': 'Start the clinical acceptability assessment',
        'feat.gc.title': 'The guideline concordance validation is currently disabled',
        'feat.gc.body': 'Only the clinical acceptability assessment is open at the moment. This validation will open once it is ready.',
        'feat.about.title': 'The About page is currently disabled',
        'feat.about.body': 'Only the clinical acceptability assessment is open at the moment. The About page will be published once it is ready.'
      }
    });
  }

  /** Which gated area a link points to ('' = not gated or open). */
  function gatedArea(a) {
    if (!a || !a.getAttribute) return '';
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return '';
    var path;
    try { path = new URL(href, location.href).pathname; } catch (_) { return ''; }
    if (path.indexOf('/qr/') === 0) return '';                       // QR hub pages (incl. /qr/gc/) are separate
    if (F.gc === false && /^\/gc(\/|$)/.test(path)) return 'gc';
    if (F.about === false && /^\/about(\/|$)/.test(path)) return 'about';
    return '';
  }

  // ---------- dialog ----------
  var CSS =
    '.feat-ov{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px;' +
      'background:rgba(10,22,34,.48);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}' +
    '.feat-dlg{width:100%;max-width:420px;border-radius:18px;padding:24px 22px 20px;background:var(--surface,#fff);color:var(--text,#16212c);' +
      'box-shadow:0 20px 60px rgba(10,22,34,.28);font-family:inherit;text-align:left}' +
    '.feat-ic{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;margin-bottom:14px;' +
      'background:var(--gray-soft,#eef2f6);color:var(--heading,#14304a)}' +
    '.feat-ic svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.feat-dlg h2{margin:0;font-size:18px;line-height:1.4;font-weight:800;color:var(--heading,#14304a);letter-spacing:-.01em}' +
    '.feat-dlg p{margin:8px 0 0;font-size:14.5px;line-height:1.6;color:var(--muted,#55667a)}' +
    '.feat-act{display:flex;gap:8px;margin-top:20px;flex-wrap:wrap}' +
    '.feat-act button,.feat-act a{flex:1 1 auto;min-height:46px;border-radius:12px;font:inherit;font-size:15px;font-weight:700;cursor:pointer;' +
      'display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;text-decoration:none;border:1px solid transparent}' +
    '.feat-primary{background:#b4541a;color:#fff}' +
    '.feat-primary:hover{background:#9c4815}' +
    '.feat-close{background:transparent;color:var(--heading,#14304a);border-color:var(--line-2,#cfd8e2)!important}' +
    '.feat-act :focus-visible{outline:3px solid var(--focus,#2f7de1);outline-offset:2px}' +
    '@media (prefers-reduced-motion:no-preference){.feat-dlg{animation:featIn .16s ease-out}}' +
    '@keyframes featIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}';
  var styled = false;
  var openEl = null, lastFocus = null;

  function caHref() {
    // /ca/ relative to the site root, carrying src · site · wave like the landing buttons
    var u = new URL('/ca/', location.href);
    try {
      var q = new URLSearchParams(location.search);
      ['src', 'site', 'wave'].forEach(function (k) { var v = q.get(k); if (v) u.searchParams.set(k, v); });
    } catch (_) {}
    return u.pathname + u.search;
  }

  function close() {
    if (!openEl) return;
    openEl.parentNode.removeChild(openEl);
    openEl = null;
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (_) {} }
  }
  function onKey(e) {
    if (!openEl) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {   // keep focus inside the dialog
      var f = openEl.querySelectorAll('a[href],button');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function show(area) {
    if (!styled) {
      var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st); styled = true;
    }
    close();
    lastFocus = document.activeElement;
    var onCa = /^\/ca(\/|$)/.test(location.pathname);
    var ov = document.createElement('div');
    ov.className = 'feat-ov';
    ov.innerHTML =
      '<div class="feat-dlg" role="dialog" aria-modal="true" aria-labelledby="featTitle" aria-describedby="featBody">' +
        '<div class="feat-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>' +
        '<h2 id="featTitle"></h2><p id="featBody"></p>' +
        '<div class="feat-act">' +
          (onCa ? '' : '<a class="feat-primary" data-feat-ca></a>') +
          '<button type="button" class="feat-close" data-feat-close></button>' +
        '</div>' +
      '</div>';
    ov.querySelector('#featTitle').textContent = tr('feat.' + area + '.title');
    ov.querySelector('#featBody').textContent = tr('feat.' + area + '.body');
    ov.querySelector('[data-feat-close]').textContent = tr('feat.close');
    var go = ov.querySelector('[data-feat-ca]');
    if (go) { go.textContent = tr('feat.toCa'); go.setAttribute('href', caHref()); }
    ov.addEventListener('click', function (e) {
      if (e.target === ov || (e.target.closest && e.target.closest('[data-feat-close]'))) close();
    });
    document.body.appendChild(ov);
    openEl = ov;
    document.addEventListener('keydown', onKey, true);
    (go || ov.querySelector('[data-feat-close]')).focus();
  }

  // Any click on a link into a gated area opens the dialog instead (capture phase: before other handlers).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button > 0) return;
    var a = e.target.closest && e.target.closest('a[href]');
    var area = gatedArea(a);
    if (!area) return;
    e.preventDefault();
    e.stopPropagation();
    show(area);
  }, true);

  // Mark gated links so pages can style them (e.g. a "준비 중" badge) and assistive tech knows they do not navigate.
  function mark(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('a[href]'), function (a) {
      var area = gatedArea(a);
      if (area) { a.setAttribute('data-gated', area); a.setAttribute('aria-haspopup', 'dialog'); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mark(); });
  else mark();

  T2D.features = { flags: F, show: show, mark: mark, gatedArea: gatedArea };
  window.T2D = T2D;
})();
