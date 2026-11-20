/* Site pages (landing /, About /about/) — no dependencies.
 * 1) Carries the attribution params (src · site · wave) into links marked data-carry.
 * 2) Landing: shows an '이어서 하기' banner when this browser holds an unfinished evaluation.
 *    Reads (never writes) the evaluation apps' localStorage:
 *      CA  't2d-ca:T2D-CA-2026:v3'  (app.js: STORE_KEY = 't2d-ca:' + STUDY_ID + ':v3', screen intro → case → final → done)
 *      GC  'gc:state:v1'            (gc/gc.js: screen starting → eval → final → done)
 *      GC  'gc:draft:v1'            (gc/gc.js: next-Part continuation saved before its session starts; has .linked)
 * 3) About: highlights the current section in the sticky table of contents. On phones the long figure bodies and the
 *    phase table (details[data-mobile-closed], open in the HTML) start closed; a link into one opens it.
 * 4) Entry referrer: keeps the external origin of this visit ('' = direct) in sessionStorage 't2d:entry_ref', because
 *    on /ca/ and /gc/ document.referrer is then this site; app.js / gc.js REF_ORIGIN fall back to it (no payload change). */
(function () {
  'use strict';

  var CARRY = ['src', 'site', 'wave'];

  // ---- 4) entry referrer (landing also does this in its <head>, before a legacy redirect) ----
  try {
    var refOrigin = document.referrer ? new URL(document.referrer).origin : '';
    if (refOrigin !== location.origin) sessionStorage.setItem('t2d:entry_ref', refOrigin);
  } catch (_) {}
  var CA_KEY = 't2d-ca:T2D-CA-2026:v3';
  var GC_KEY = 'gc:state:v1';
  var GC_DRAFT_KEY = 'gc:draft:v1';

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

  // ---- 2) resume banner ----
  function read(key) {
    try { var raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function letter(x) { x = String(x || '').toUpperCase(); return /^[A-Z]$/.test(x) ? x : ''; }

  function findResumes() {
    var out = [];
    var ca = read(CA_KEY);
    if (ca && ca.v === 1) {
      var t = letter(ca.study_type) ? 'Type ' + letter(ca.study_type) : '';
      var n = (ca.order && ca.order.length) || 0;
      var unsent = (ca.outbox && ca.outbox.length) || 0;
      if (ca.screen === 'case') {
        var ci = (typeof ca.caseIdx === 'number' ? ca.caseIdx : 0) + 1;
        out.push({ track: 'ca', href: 'ca/', title: '진행 중인 임상 수용성 평가가 있습니다',
          sub: [t, n ? '케이스 ' + Math.min(ci, n) + '/' + n + ' 진행 중' : '진행 중'], btn: '이어서 하기', icon: 'i-resume', test: ca.is_test });
      } else if (ca.screen === 'final') {
        out.push({ track: 'ca', href: 'ca/', title: '임상 수용성 평가 제출만 남았습니다',
          sub: [t, '마지막 문항과 제출'], btn: '이어서 하기', icon: 'i-resume', test: ca.is_test });
      } else if (ca.screen === 'done' && unsent) {
        out.push({ track: 'ca', href: 'ca/', title: '전송되지 않은 임상 수용성 평가 응답이 있습니다',
          sub: [t, '평가 페이지를 열면 다시 전송합니다'], btn: '열어서 전송하기', icon: 'i-send', test: ca.is_test });
      }
    }
    var gs = read(GC_KEY);
    var gcActive = false;
    if (gs && gs.v === 1) {
      var p = letter(gs.part) ? 'Part ' + letter(gs.part) : '';
      var gUnsent = (gs.outbox && gs.outbox.length) || 0;
      if (gs.screen === 'eval') {
        gcActive = true;
        out.push({ track: 'gc', href: 'gc/', title: '진행 중인 가이드라인 부합도 검증이 있습니다',
          sub: [p, '진행 중'], btn: '이어서 하기', icon: 'i-resume', test: gs.is_test });
      } else if (gs.screen === 'final') {
        gcActive = true;
        out.push({ track: 'gc', href: 'gc/', title: '가이드라인 부합도 검증 제출만 남았습니다',
          sub: [p, '마무리 문항과 제출'], btn: '이어서 하기', icon: 'i-resume', test: gs.is_test });
      } else if (gs.screen === 'done' && gUnsent) {
        gcActive = true;
        out.push({ track: 'gc', href: 'gc/', title: '전송되지 않은 가이드라인 부합도 검증 응답이 있습니다',
          sub: [p, '검증 페이지를 열면 다시 전송합니다'], btn: '열어서 전송하기', icon: 'i-send', test: gs.is_test });
      }
    }
    if (!gcActive) {
      var d = read(GC_DRAFT_KEY);
      if (d && d.linked) {
        var dp = letter(d.part);
        out.push({ track: 'gc', href: 'gc/', title: '가이드라인 부합도 검증을 이어서 할 수 있습니다',
          sub: [dp ? 'Part ' + dp + ' 준비됨' : '다음 Part 준비됨', '처음 입력하신 정보와 동의를 그대로 사용'], btn: '이어서 하기', icon: 'i-resume' });
      }
    }
    return out;
  }

  var zone = document.getElementById('resume');
  if (zone) {
    var items = findResumes();
    if (items.length) {
      zone.innerHTML = '<h2 class="sr-only">이어서 하기</h2>' + items.map(function (r) {
        var sub = r.sub.filter(Boolean).join(' · ') + (r.test ? ' · 테스트 응답' : '') + ' — 이 기기·브라우저에 저장되어 있습니다.';
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
  }

  // ---- 3a) collapsible blocks: closed on phones, open elsewhere (and without JS); a link into one opens it ----
  var folds = Array.prototype.slice.call(document.querySelectorAll('details[data-mobile-closed]'));
  if (folds.length) {
    var target = function (hash) { try { return hash && hash.length > 1 ? document.getElementById(decodeURIComponent(hash.slice(1))) : null; } catch (_) { return null; } };
    var openFor = function (el) { folds.forEach(function (d) { if (el && (d === el || d.contains(el))) d.open = true; }); };
    try {
      if (window.matchMedia('(max-width: 759px)').matches) {
        var t0 = target(location.hash);
        folds.forEach(function (d) { if (!(t0 && (d === t0 || d.contains(t0)))) d.open = false; });
      }
    } catch (_) {}
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (a) openFor(target(a.getAttribute('href')));
    });
    window.addEventListener('hashchange', function () { openFor(target(location.hash)); });
  }

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
