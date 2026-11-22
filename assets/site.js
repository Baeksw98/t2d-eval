/* Site pages (landing /, About /about/). Needs assets/i18n.js + i18n/site.js (T2D.t); data/design.js is optional.
 * 1) Carries the attribution params (src · site · wave) into links marked data-carry.
 * 2) Landing: shows an '이어서 하기' banner when this browser holds an unfinished evaluation.
 *    Reads (never writes) the evaluation apps' localStorage:
 *      CA  't2d-ca:T2D-CA-2026:v3'  (app.js: STORE_KEY = 't2d-ca:' + STUDY_ID + ':v3', screen intro → case → final → done)
 *      GC  'gc:state:v1'            (gc/gc.js: screen starting → eval → final → done)
 *      GC  'gc:draft:v1'            (gc/gc.js: next-Part continuation saved before its session starts; has .linked)
 * 3) About: highlights the current section in the sticky table of contents. On phones details[data-mobile-closed]
 *    (open in the HTML) start closed; a link into a closed block opens it.
 * 4) Entry referrer: keeps the external origin of this visit ('' = direct) in sessionStorage 't2d:entry_ref', because
 *    on /ca/ and /gc/ document.referrer is then this site; app.js / gc.js REF_ORIGIN fall back to it (no payload change).
 * 5) Language + theme: wires the header controls (T2D.controlsHTML(), inserted inline in the header) and re-renders the
 *    JS-made text (banner, times, case-set line) on 't2d:lang'.
 * 6) Active case set (window.T2D_DESIGN from data/design.js): landing card times (ca.minutes, gc.minutes or the Parts'
 *    range; the HTML keeps the v1 times as fallback) and the About 'current case set' line (#setNow, hidden without it).
 *    The pages load <script src="data/design.js"> (About: ../data/design.js) just before this file; tools/build_cases.py
 *    writes it and keeps its ?v= stamp. qr/qr.js reads the same object for its times and Types/Parts. */
(function () {
  'use strict';

  var CARRY = ['src', 'site', 'wave'];
  var I = window.T2D && window.T2D.t ? window.T2D : null;
  var t = function (k, v) { return I ? I.t(k, v) : ''; };

  // ---- 4) entry referrer (landing also does this in its <head>, before a legacy redirect) ----
  try {
    var refOrigin = document.referrer ? new URL(document.referrer).origin : '';
    if (refOrigin !== location.origin) sessionStorage.setItem('t2d:entry_ref', refOrigin);
  } catch (_) {}
  var CA_KEY = 't2d-ca:T2D-CA-2026:v3';
  var GC_KEY = 'gc:state:v1';
  var GC_DRAFT_KEY = 'gc:draft:v1';

  // ---- 5) header controls ----
  if (I && I.bindControls) I.bindControls(document);

  // ---- 1) attribution params ----
  var carried = [];
  try {
    var q = new URLSearchParams(location.search);
    CARRY.forEach(function (k) { var v = q.get(k); if (v) carried.push([k, v]); });
  } catch (_) {}
  function withCarry(href) {
    if (!carried.length) return href;
    try {
      var u = new URL(href, location.href);
      carried.forEach(function (kv) { if (!u.searchParams.has(kv[0])) u.searchParams.set(kv[0], kv[1]); });
      return u.pathname + u.search + u.hash;
    } catch (_) { return href; }
  }
  function carryLinks(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll('a[data-carry]'), function (a) {
      a.setAttribute('href', withCarry(a.getAttribute('href')));
    });
  }
  carryLinks(document);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---- 6) active case set ----
  var DESIGN = window.T2D_DESIGN && typeof window.T2D_DESIGN === 'object' ? window.T2D_DESIGN : null;
  function range(m) {
    return m && m.length === 2 && isFinite(m[0]) && isFinite(m[1]) && m[0] > 0 && m[1] >= m[0] ? [Number(m[0]), Number(m[1])] : null;
  }
  function designMinutes(track) {
    var d = DESIGN && DESIGN[track];
    if (!d) return null;
    var r = range(d.minutes);
    if (r || track !== 'gc' || !d.parts || !d.parts.length) return r;
    var lo = Infinity, hi = 0;
    d.parts.forEach(function (p) { var pr = range(p && p.minutes); if (pr) { lo = Math.min(lo, pr[0]); hi = Math.max(hi, pr[1]); } });
    return hi ? [lo, hi] : null;
  }
  function renderMinutes() {
    if (!I) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-minutes]'), function (el) {
      var r = designMinutes(el.getAttribute('data-minutes')) || [el.getAttribute('data-lo'), el.getAttribute('data-hi')];
      el.textContent = t('site.pick.minutes', { lo: r[0], hi: r[1] });
    });
  }
  function renderSet() {
    var el = document.getElementById('setNow');
    if (!el || !I || !DESIGN || !DESIGN.set_id) return;
    // patients × models of the set (a unit = one patient × one model)
    var pts = {}, mds = {};
    (DESIGN.units || []).forEach(function (u) { if (u && u.patient) pts[u.patient] = 1; if (u && u.model) mds[u.model] = 1; });
    var np = Object.keys(pts).length, nm = Object.keys(mds).length;
    var count = function (k, n) { return t(n === 1 ? k + '1' : k, { n: n }); };
    el.innerHTML = '<svg class="ic" aria-hidden="true"><use href="../assets/icons.svg#i-layers"/></svg><span>' +
      t(np && nm ? 'about.set.now' : 'about.set.now0', { id: esc(DESIGN.set_id), pt: count('about.set.pt', np), md: count('about.set.md', nm) }) + '</span>';
    el.hidden = false;
  }

  // ---- 2) resume banner ----
  function read(key) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function letter(x) { x = String(x || '').toUpperCase(); return /^[A-Z]$/.test(x) ? x : ''; }

  function findResumes() {
    var out = [];
    var ca = read(CA_KEY);
    if (ca && ca.v === 1) {
      var ty = letter(ca.study_type) ? 'Type ' + letter(ca.study_type) : '';
      var n = (ca.order && ca.order.length) || 0;
      var unsent = (ca.outbox && ca.outbox.length) || 0;
      if (ca.screen === 'case') {
        var ci = (typeof ca.caseIdx === 'number' ? ca.caseIdx : 0) + 1;
        out.push({ track: 'ca', href: 'ca/', title: t('site.resume.ca.case.t'),
          sub: [ty, n ? t('site.resume.case', { i: Math.min(ci, n), n: n }) : t('site.resume.inprog')], btn: t('site.resume.btn'), icon: 'i-resume', test: ca.is_test });
      } else if (ca.screen === 'final') {
        out.push({ track: 'ca', href: 'ca/', title: t('site.resume.ca.final.t'),
          sub: [ty, t('site.resume.ca.final.s')], btn: t('site.resume.btn'), icon: 'i-resume', test: ca.is_test });
      } else if (ca.screen === 'done' && unsent) {
        out.push({ track: 'ca', href: 'ca/', title: t('site.resume.ca.unsent.t'),
          sub: [ty, t('site.resume.ca.unsent.s')], btn: t('site.resume.btn.send'), icon: 'i-send', test: ca.is_test });
      }
    }
    var gs = read(GC_KEY);
    var gcActive = false;
    if (gs && gs.v === 1) {
      var p = letter(gs.part) ? 'Part ' + letter(gs.part) : '';
      var gUnsent = (gs.outbox && gs.outbox.length) || 0;
      if (gs.screen === 'eval') {
        gcActive = true;
        out.push({ track: 'gc', href: 'gc/', title: t('site.resume.gc.eval.t'),
          sub: [p, t('site.resume.inprog')], btn: t('site.resume.btn'), icon: 'i-resume', test: gs.is_test });
      } else if (gs.screen === 'final') {
        gcActive = true;
        out.push({ track: 'gc', href: 'gc/', title: t('site.resume.gc.final.t'),
          sub: [p, t('site.resume.gc.final.s')], btn: t('site.resume.btn'), icon: 'i-resume', test: gs.is_test });
      } else if (gs.screen === 'done' && gUnsent) {
        gcActive = true;
        out.push({ track: 'gc', href: 'gc/', title: t('site.resume.gc.unsent.t'),
          sub: [p, t('site.resume.gc.unsent.s')], btn: t('site.resume.btn.send'), icon: 'i-send', test: gs.is_test });
      }
    }
    if (!gcActive) {
      var d = read(GC_DRAFT_KEY);
      if (d && d.linked) {
        var dp = letter(d.part);
        out.push({ track: 'gc', href: 'gc/', title: t('site.resume.gc.draft.t'),
          sub: [dp ? t('site.resume.gc.draft.part', { p: dp }) : t('site.resume.gc.draft.next'), t('site.resume.gc.draft.s')],
          btn: t('site.resume.btn'), icon: 'i-resume' });
      }
    }
    return out;
  }

  var zone = document.getElementById('resume');
  function renderResume() {
    if (!zone || !I) return;
    var items = findResumes();
    if (!items.length) { zone.hidden = true; zone.innerHTML = ''; return; }
    zone.innerHTML = '<h2 class="sr-only">' + esc(t('site.resume.h')) + '</h2>' + items.map(function (r) {
      var sub = r.sub.filter(Boolean).join(' · ') + (r.test ? ' · ' + t('site.resume.test') : '') + ' — ' + t('site.resume.saved');
      return '<div class="resume ' + r.track + '">' +
        '<span class="r-icon" aria-hidden="true"><svg class="ic"><use href="assets/icons.svg#' + r.icon + '"/></svg></span>' +
        '<div><h3 class="r-title">' + esc(r.title) + '</h3><p>' + esc(sub) + '</p></div>' +
        '<a class="btn ' + (r.track === 'gc' ? 'btn-gc' : 'btn-ca') + '" data-carry href="' + esc(r.href) + '">' + esc(r.btn) +
        '<svg class="ic" aria-hidden="true"><use href="assets/icons.svg#i-arrow"/></svg></a>' +
      '</div>';
    }).join('');
    carryLinks(zone);
    zone.hidden = false;
  }

  function renderAll() { renderMinutes(); renderSet(); renderResume(); }
  renderAll();
  window.addEventListener('t2d:lang', renderAll);

  // ---- 3a) collapsible blocks ----
  //  · details[data-mobile-closed]: closed on phones, open elsewhere (and without JS)
  //  · About '더 알아보기' items (details.more-item) start closed everywhere
  //  · a link (or a URL hash) into a closed block opens it and every closed ancestor
  var target = function (hash) { try { return hash && hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null; } catch (_) { return null; } };
  var openFor = function (el) {
    for (var d = el; d; d = d.parentElement) { if (d.tagName === 'DETAILS') d.open = true; }
  };
  var folds = Array.prototype.slice.call(document.querySelectorAll('details[data-mobile-closed]'));
  try {
    if (folds.length && window.matchMedia('(max-width: 759px)').matches) {
      var t0 = target(location.hash);
      folds.forEach(function (d) { if (!(t0 && (d === t0 || d.contains(t0)))) d.open = false; });
    }
  } catch (_) {}
  openFor(target(location.hash));
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (a) openFor(target(a.getAttribute('href')));
  });
  window.addEventListener('hashchange', function () { openFor(target(location.hash)); });

  // ---- 3) TOC highlight: the last section whose top has passed the header line ----
  var toc = document.querySelector('.toc');
  if (toc) {
    var links = Array.prototype.slice.call(toc.querySelectorAll('a[href^="#"]'));
    var pairs = links.map(function (a) { return [a, document.getElementById(a.getAttribute('href').slice(1))]; })
      .filter(function (p) { return p[1]; });
    var ticking = false;
    var update = function () {
      ticking = false;
      var line = 140, cur = pairs.length ? pairs[0][0] : null;
      for (var i = 0; i < pairs.length; i++) { if (pairs[i][1].getBoundingClientRect().top <= line) cur = pairs[i][0]; }
      if ((window.innerHeight + window.scrollY) >= document.documentElement.scrollHeight - 4 && pairs.length) cur = pairs[pairs.length - 1][0];
      links.forEach(function (a) {
        var on = a === cur;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
      });
    };
    window.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
    window.addEventListener('resize', update);
    update();
  }
})();
