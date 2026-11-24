/* T2D — patient record shown the way a clinician reads it (shared by /ca/ app.js and /gc/ gc.js).
 *
 * The case data keeps the generator's coded strings (e.g. 'CKD: Stage 1 (90+)', 'HF (No)', 'MASLD: Normal',
 * 'BMI Category: Obese Class II'). This module turns them into a clinical summary at display time only; the data
 * files and the response payloads are unchanged.
 *
 *   T2D.clinical.comorbidities(p) → { dm: [{key, value, pos}], other: [string] }
 *     dm    = diabetes-related comorbidities in a fixed clinical order
 *             CKD: Stage n · Heart failure: Yes (detail) / No · ASCVD: Yes (detail) / No · MASLD: Yes (detail) / No ·
 *             BMI: category (current kg/m²) · Retinopathy / Neuropathy: Yes (moved from the other-conditions list)
 *     other = the remaining (non-diabetes) conditions, without the BMI category line (already shown under BMI)
 *   T2D.clinical.orderLabs(labs) → the lab rows with the body-measurement/BP group first, then the blood tests
 *   T2D.clinical.current(p, re)   → the current-visit value of the first lab row whose name matches re ('' if none)
 */
(function () {
  'use strict';
  var T2D = window.T2D = window.T2D || {};

  var NO = /^(no|none|normal|absent|없음|정상)$/i;
  var ORDER = ['CKD', 'Heart failure', 'ASCVD', 'MASLD', 'BMI', 'Retinopathy', 'Neuropathy'];

  function detail(s) {
    // 'HFmrEF (NYHA Class III)' → 'HFmrEF, NYHA III' · 'CAD (MI 2y ago)' → 'CAD, MI 2y ago' (no nested brackets)
    return String(s || '').replace(/\s*\(([^()]*)\)\s*$/, ', $1').replace(/NYHA\s*Class\s*([IV]+)/i, 'NYHA $1')
      .replace(/\s+/g, ' ').trim();
  }
  function yesNo(v) {
    v = String(v == null ? '' : v).trim();
    if (!v || NO.test(v)) return { value: 'No', pos: false };
    if (/^yes$/i.test(v)) return { value: 'Yes', pos: true };
    return { value: 'Yes (' + detail(v) + ')', pos: true };
  }

  /** current-visit value of a lab row (last value), e.g. '30.4 kg/m²' */
  function current(p, re) {
    var labs = (p && p.labs) || [];
    for (var i = 0; i < labs.length; i++) {
      if (re.test(labs[i].name)) { var v = labs[i].values || []; return String(v[v.length - 1] || ''); }
    }
    return '';
  }
  function currentBmi(p) {
    var v = current(p, /체질량지수|^BMI$/i);
    if (v) return v.replace(/^([\d.]+)\s*(?=[A-Za-z])/, '$1 ');
    var ex = (p && p.exam) || [];
    for (var i = 0; i < ex.length; i++) { var m = /(?:체질량지수|BMI)\s*([\d.]+\s*kg\/m²?)/i.exec(ex[i]); if (m) return m[1]; }
    return '';
  }

  /** one coded comorbidity string → {key, value, pos} (null when it is not a known diabetes-related item) */
  function parseDm(s, p) {
    var t = String(s || '').trim(), m;
    if ((m = /^CKD\s*(?::\s*(.+)|\((.+)\))$/i.exec(t))) {
      var cv = (m[1] || m[2] || '').trim();
      var st = /stage\s*([0-9]+[ab]?)/i.exec(cv);
      if (st) {
        var n = st[1].toLowerCase();
        return { key: 'CKD', value: 'Stage ' + n, pos: /^(3|4|5)/.test(n) };
      }
      var yn = yesNo(cv.replace(/\s*\(.*\)$/, ''));
      return { key: 'CKD', value: yn.value, pos: yn.pos };
    }
    if ((m = /^(?:HF|Heart failure|심부전)\s*(?::\s*(.+)|\((.+)\))$/i.exec(t))) { var h = yesNo(m[1] || m[2]); return { key: 'Heart failure', value: h.value, pos: h.pos }; }
    if ((m = /^ASCVD\s*(?::\s*(.+)|\((.+)\))$/i.exec(t))) { var a = yesNo(m[1] || m[2]); return { key: 'ASCVD', value: a.value, pos: a.pos }; }
    if ((m = /^MASLD\s*(?::\s*(.+)|\((.+)\))$/i.exec(t))) { var l = yesNo(m[1] || m[2]); return { key: 'MASLD', value: l.value, pos: l.pos }; }
    if ((m = /^(?:BMI\s*Category|Body mass index category)\s*:\s*(.+)$/i.exec(t))) {
      var cat = m[1].trim(), num = currentBmi(p);
      return { key: 'BMI', value: cat + (num ? ' (' + num + ')' : ''), pos: !NO.test(cat) };
    }
    return null;
  }
  // diabetes complications that sit in the other-conditions list of the source data
  var DM_OTHER = [
    { re: /당뇨병?\s*망막병증|diabetic\s+retinopathy/i, key: 'Retinopathy' },
    { re: /당뇨병?\s*(?:말초\s*)?신경병증|diabetic\s+(?:peripheral\s+)?neuropathy/i, key: 'Neuropathy' }
  ];

  function comorbidities(p) {
    var hist = (p && p.history) || {};
    var dm = [], other = [], extra = [];
    (hist.dm_comorbidities || []).forEach(function (s) {
      var r = parseDm(s, p);
      if (r) dm.push(r); else extra.push({ key: String(s).split(/[:(]/)[0].trim() || String(s), value: String(s).replace(/^[^:(]*[:(]\s*/, '').replace(/\)$/, '').trim(), pos: true });
    });
    (hist.other_conditions || []).forEach(function (s) {
      var t = String(s || '').trim();
      if (!t) return;
      if (/^(?:Body mass index category|BMI\s*Category)\s*:/i.test(t)) {          // shown under BMI
        if (!dm.some(function (x) { return x.key === 'BMI'; })) { var b = parseDm(t, p); if (b) dm.push(b); }
        return;
      }
      for (var i = 0; i < DM_OTHER.length; i++) {
        if (DM_OTHER[i].re.test(t)) {
          if (!dm.some(function (x) { return x.key === DM_OTHER[i].key; })) dm.push({ key: DM_OTHER[i].key, value: 'Yes', pos: true });
          return;
        }
      }
      other.push(t);
    });
    dm.sort(function (a, b) { return ORDER.indexOf(a.key) - ORDER.indexOf(b.key); });
    return { dm: dm.concat(extra), other: other };
  }

  var BODY = /신체|계측|혈압|vital|body|anthropometr/i;
  function orderLabs(labs) {
    var body = [], rest = [];
    (labs || []).forEach(function (l) { (BODY.test(l.group || '') ? body : rest).push(l); });
    return body.concat(rest);
  }

  T2D.clinical = { comorbidities: comorbidities, orderLabs: orderLabs, current: current, parseDm: parseDm };
})();
