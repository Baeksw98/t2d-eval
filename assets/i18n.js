/* T2D site — shared language (KO/EN) + theme (system/light/dark) runtime.
 *
 * Load SYNCHRONOUSLY in <head>, before any stylesheet:
 *     <script src="/assets/i18n.js"></script>            (relative path from the page, e.g. ../assets/i18n.js)
 * then the dictionaries for the page (any order, any time before DOMContentLoaded):
 *     <script src="/i18n/site.js"></script>  <script src="/i18n/ca.js"></script> …
 *
 * Dictionaries register namespaced, flat keys:
 *     T2D.i18n.add({ ko: { 'site.nav.about': '벤치마크 소개', … }, en: { 'site.nav.about': 'About', … } });
 *
 * API (window.T2D):
 *   T2D.lang                      'ko' | 'en'   (current UI language)
 *   T2D.t(key, vars?)             string for the current language; {name} placeholders replaced from vars;
 *                                 falls back to ko, then to the key itself (and logs a console.warn once per key)
 *   T2D.pick(obj)                 for config objects that are either a string or {ko, en}: returns the current-language string
 *   T2D.i18n.add(dict)            register strings (see above)
 *   T2D.i18n.apply(root?)         translate DOM under root (default document):
 *                                   [data-i18n="key"]        → textContent
 *                                   [data-i18n-html="key"]   → innerHTML (OUR OWN trusted strings only)
 *                                   [data-i18n-attr="aria-label:key;title:key2"] → attributes
 *                                 also <title data-i18n> and <meta data-i18n-attr="content:key">
 *   T2D.setLang('en'|'ko')        saves to localStorage 't2d:lang', updates <html lang>, re-applies DOM and fires
 *                                 window event 't2d:lang' (apps re-render their current screen on it)
 *   T2D.theme                     'system' | 'light' | 'dark' (the saved preference)
 *   T2D.setTheme(pref)            saves 't2d:theme', sets <html data-theme="light|dark"> (system → resolved), fires 't2d:theme'
 *   T2D.controlsHTML()            HTML for the header controls (language switch + theme button), class "prefs"
 *   T2D.bindControls(root?)       wires every .prefs inside root (idempotent); call after inserting controlsHTML()
 *
 * Language choice order: ?lang=ko|en  →  localStorage 't2d:lang' (set only by an explicit choice)  →  'ko'.
 * Korean is ALWAYS the default (PI decision): the device/browser language is never used, so a Korean physician whose phone
 * is set to English still gets the Korean instrument; English appears only when the visitor presses EN or opens ?lang=en.
 * ?lang= is also saved, so a shared English link stays English.
 * Theme: localStorage 't2d:theme' (default 'system'); <html data-theme> is ALWAYS set to the resolved value, so CSS can use
 *   :root[data-theme="dark"] { …dark tokens… }  plus  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }
 *   (the media-query copy only matters without JS).
 * Flash control: while English is being applied, <html class="i18n-pending"> hides the body (max 1.2 s safety timeout).
 * Never throws (storage may be blocked in private mode / in-app browsers).
 */
(function () {
  'use strict';
  var W = window, D = document, H = D.documentElement;
  var T2D = W.T2D = W.T2D || {};
  var LANG_KEY = 't2d:lang', THEME_KEY = 't2d:theme';

  function get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }

  // ---------- language ----------
  var lang = null;
  try {
    var q = new URLSearchParams(location.search).get('lang');
    if (q === 'ko' || q === 'en') { lang = q; set(LANG_KEY, q); }
  } catch (_) {}
  if (!lang) { var s = get(LANG_KEY); if (s === 'ko' || s === 'en') lang = s; }
  if (!lang) lang = 'ko';   // default is always Korean — never navigator.language
  T2D.lang = lang;
  H.setAttribute('lang', lang);

  var dict = { ko: {}, en: {} }, warned = {};
  function add(d) {
    if (!d) return;
    ['ko', 'en'].forEach(function (l) {
      var src = d[l] || {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) dict[l][k] = src[k];
    });
  }
  function fmt(s, vars) {
    if (!vars) return s;
    return String(s).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(vars, n) ? String(vars[n]) : m; });
  }
  function t(key, vars) {
    var s = dict[T2D.lang][key];
    if (s === undefined) s = dict.ko[key];
    if (s === undefined) {
      if (!warned[key]) { warned[key] = 1; try { console.warn('[i18n] missing key: ' + key); } catch (_) {} }
      return key;
    }
    return fmt(s, vars);
  }
  function pick(v) {
    if (v === null || v === undefined) return '';
    if (typeof v !== 'object') return String(v);
    var s = v[T2D.lang];
    return s === undefined || s === null ? (v.ko !== undefined ? v.ko : '') : s;
  }
  function apply(root) {
    root = root || D;
    var q = function (sel) { return root.querySelectorAll ? root.querySelectorAll(sel) : []; };
    Array.prototype.forEach.call(q('[data-i18n]'), function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    Array.prototype.forEach.call(q('[data-i18n-html]'), function (el) { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    Array.prototype.forEach.call(q('[data-i18n-attr]'), function (el) {
      String(el.getAttribute('data-i18n-attr')).split(';').forEach(function (pair) {
        var i = pair.indexOf(':'); if (i < 1) return;
        el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      });
    });
    if (root === D) {
      var tt = D.querySelector('title[data-i18n]'); if (tt) D.title = t(tt.getAttribute('data-i18n'));
    }
    syncControls();
  }
  function setLang(l) {
    if (l !== 'ko' && l !== 'en') return;
    T2D.lang = l; set(LANG_KEY, l); H.setAttribute('lang', l);
    apply(D);
    try { W.dispatchEvent(new CustomEvent('t2d:lang', { detail: { lang: l } })); } catch (_) {}
  }

  // ---------- theme ----------
  var mq = null;
  try { mq = W.matchMedia('(prefers-color-scheme: dark)'); } catch (_) {}
  var theme = get(THEME_KEY);
  if (theme !== 'light' && theme !== 'dark') theme = 'system';
  T2D.theme = theme;
  function resolved() { return T2D.theme === 'system' ? (mq && mq.matches ? 'dark' : 'light') : T2D.theme; }
  function paintTheme() { H.setAttribute('data-theme', resolved()); }
  paintTheme();
  if (mq) {
    var onMq = function () { if (T2D.theme === 'system') { paintTheme(); syncControls(); } };
    if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
  }
  function setTheme(p) {
    if (p !== 'system' && p !== 'light' && p !== 'dark') return;
    T2D.theme = p; set(THEME_KEY, p); paintTheme(); syncControls();
    try { W.dispatchEvent(new CustomEvent('t2d:theme', { detail: { theme: p, resolved: resolved() } })); } catch (_) {}
  }

  // ---------- header controls ----------
  var ICON = {
    system: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>'
  };
  var LBL = {
    ko: { lang: '언어', theme: '화면 모드', system: '시스템 설정', light: '라이트 모드', dark: '다크 모드', next: '눌러서 바꾸기' },
    en: { lang: 'Language', theme: 'Theme', system: 'System', light: 'Light', dark: 'Dark', next: 'click to change' }
  };
  function controlsHTML() {
    return '<div class="prefs" role="group">' +
      '<div class="prefs-lang" role="group">' +
        '<button type="button" class="prefs-btn" data-lang="ko" lang="ko">KO</button>' +
        '<button type="button" class="prefs-btn" data-lang="en" lang="en">EN</button>' +
      '</div>' +
      '<button type="button" class="prefs-btn prefs-theme" data-theme-cycle></button>' +
    '</div>';
  }
  function syncControls() {
    var L = LBL[T2D.lang] || LBL.ko;
    Array.prototype.forEach.call(D.querySelectorAll('.prefs'), function (box) {
      box.setAttribute('aria-label', L.lang + ' · ' + L.theme);
      var lg = box.querySelector('.prefs-lang'); if (lg) lg.setAttribute('aria-label', L.lang);
      Array.prototype.forEach.call(box.querySelectorAll('[data-lang]'), function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-lang') === T2D.lang ? 'true' : 'false');
      });
      var tb = box.querySelector('[data-theme-cycle]');
      if (tb) {
        tb.innerHTML = ICON[T2D.theme];
        var label = L.theme + ': ' + L[T2D.theme] + ' (' + L.next + ')';
        tb.setAttribute('aria-label', label); tb.setAttribute('title', label);
      }
    });
  }
  var ORDER = ['system', 'light', 'dark'];
  function bindControls(root) {
    Array.prototype.forEach.call((root || D).querySelectorAll('.prefs'), function (box) {
      if (box.__bound) return; box.__bound = true;
      box.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button'); if (!b || !box.contains(b)) return;
        if (b.hasAttribute('data-lang')) setLang(b.getAttribute('data-lang'));
        else if (b.hasAttribute('data-theme-cycle')) setTheme(ORDER[(ORDER.indexOf(T2D.theme) + 1) % ORDER.length]);
      });
    });
    syncControls();
  }

  // ---------- flash control for English ----------
  if (T2D.lang !== 'ko') {
    H.className += (H.className ? ' ' : '') + 'i18n-pending';
    try {
      var st = D.createElement('style');
      st.textContent = 'html.i18n-pending body{visibility:hidden}';
      (D.head || H).appendChild(st);
    } catch (_) {}
    var reveal = function () { H.className = H.className.replace(/\s*\bi18n-pending\b/g, ''); };
    setTimeout(reveal, 1200);
    D.addEventListener('DOMContentLoaded', function () { apply(D); reveal(); });
  } else {
    D.addEventListener('DOMContentLoaded', function () { apply(D); });
  }

  T2D.t = t; T2D.pick = pick; T2D.setLang = setLang; T2D.setTheme = setTheme;
  T2D.controlsHTML = controlsHTML; T2D.bindControls = bindControls;
  T2D.resolvedTheme = resolved;
  T2D.i18n = { add: add, apply: apply, dict: dict };
})();
