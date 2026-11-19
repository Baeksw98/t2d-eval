// ============================================================
// SUMMARY / ANALYSIS (gas/src/summary.gs)
// ============================================================
function buildSummaryIncludingTests() { buildSummary(true); }

/**
 * Summary 시트 생성
 *  - 대상: 완료된 케이스(CaseCompletedAt 존재). 기본적으로 IsTest=TRUE 제외.
 *  - 모델 × Phase: n, 평균, SD, 중앙값, 1~5점 분포, I-CVI(4점 이상 비율). 모델별 S-CVI/Ave(= Phase I-CVI 평균)
 *  - 답변(CaseKey)별 선호 조합 분포, AI 1순위 조합 선택률
 *  - 모델별 케이스 소요 시간(분) 중앙값·평균, Phase별 평균 체류 시간(초)
 */
function buildSummary(includeTests) {
  includeTests = includeTests === true;
  var ss = ss_();
  var sh = ss.getSheetByName(SHEET.RESP);
  if (!sh || sh.getLastRow() < 2) { Logger.log('응답 없음'); return; }
  var hm = headerMap_(sh).map;
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var col = function (r, name) { return r[hm[name] - 1]; };
  var rows = data.filter(function (r) {
    var test = col(r, 'IsTest') === true || String(col(r, 'IsTest')).toUpperCase() === 'TRUE';
    return col(r, 'CaseCompletedAt') !== '' && (includeTests || !test);
  });

  var out = [];
  var push = function (arr) { out.push(arr); };
  push(['임상 수용성 평가 — 요약 통계', '', '', '', '', '', '', '', '', '', '', '', '']);
  push(['생성 시각', new Date(), '테스트 응답 포함', includeTests, '완료 케이스 수', rows.length, '평가자 수', unique_(rows.map(function (r) { return col(r, 'SessionId'); })).length, '', '', '', '', '']);
  push(['']);

  var phaseCols = { p1: 'P1_Referral', p2: 'P2_SharedDecision', p3: 'P3_Pharmacotherapy', p4: 'P4_FollowUp', p5: 'P5_Education' };
  var models = unique_(rows.map(function (r) { return col(r, 'ModelName') || col(r, 'Model'); })).sort();
  var groups = models.concat(['전체']);

  push(['[1] 모델 × Phase 임상 수용성 (5점 척도, I-CVI = 4점 이상 비율)']);
  push(['모델', 'Phase', 'n', '평균', 'SD', '중앙값', '1점', '2점', '3점', '4점', '5점', 'I-CVI', '']);
  groups.forEach(function (g) {
    var sub = rows.filter(function (r) { return g === '전체' || (col(r, 'ModelName') || col(r, 'Model')) === g; });
    var icvis = [];
    PHASE_KEYS.forEach(function (k) {
      var vals = sub.map(function (r) { return Number(col(r, phaseCols[k])); }).filter(function (v) { return v >= 1 && v <= 5; });
      var dist = [1, 2, 3, 4, 5].map(function (s) { return vals.filter(function (v) { return v === s; }).length; });
      var icvi = vals.length ? (dist[3] + dist[4]) / vals.length : '';
      if (icvi !== '') icvis.push(icvi);
      push([g, PHASE_LABEL[k], vals.length, r2_(mean_(vals)), r2_(sd_(vals)), median_(vals)].concat(dist).concat([r3_(icvi), '']));
    });
    push([g, 'S-CVI/Ave (Phase I-CVI 평균)', '', '', '', '', '', '', '', '', '', r3_(mean_(icvis)), '']);
  });
  push(['']);

  push(['[2] 답변별 선호 조합 선택 분포']);
  push(['CaseKey', '환자', '모델', 'n', '조합 1', '조합 2', '조합 3', 'AI 1순위 선택률', '', '', '', '', '']);
  unique_(rows.map(function (r) { return col(r, 'CaseKey'); })).sort().forEach(function (key) {
    var sub = rows.filter(function (r) { return col(r, 'CaseKey') === key; });
    var ch = sub.map(function (r) { return Number(col(r, 'ComboChoice')); });
    var cnt = [1, 2, 3].map(function (n) { return ch.filter(function (v) { return v === n; }).length; });
    push([key, col(sub[0], 'PatientId'), col(sub[0], 'ModelName') || col(sub[0], 'Model'), sub.length].concat(cnt).concat([r3_(sub.length ? cnt[0] / sub.length : ''), '', '', '', '', '']));
  });
  push(['']);

  push(['[3] 소요 시간 — 화면 표시 시간(active + idle) 기준, 다른 앱·탭으로 전환된(hidden) 시간 제외. 마지막 열은 active만 집계']);
  push(['모델', 'n', '케이스 중앙값(분)', '케이스 평균(분)', '환자정보(초)', 'P1(초)', '조합선택(초)', 'P2(초)', 'P3(초)', 'P4(초)', 'P5(초)', '의견(초)', '케이스 중앙값(분, active만)']);
  groups.forEach(function (g) {
    var sub = rows.filter(function (r) { return g === '전체' || (col(r, 'ModelName') || col(r, 'Model')) === g; });
    var caseMin = sub.map(function (r) { return (Number(col(r, 'CaseActiveSec')) + Number(col(r, 'CaseIdleSec'))) / 60; });
    var stepMeans = STEPS.map(function (s) {
      return r1_(mean_(sub.map(function (r) { return Number(col(r, 'Sec_' + STEP_COL[s])); }).filter(function (v) { return !isNaN(v); })));
    });
    var caseActiveMin = sub.map(function (r) { return Number(col(r, 'CaseActiveSec')) / 60; });
    push([g, sub.length, r1_(median_(caseMin)), r1_(mean_(caseMin))].concat(stepMeans).concat([r1_(median_(caseActiveMin))]));
  });
  push(['']);
  push(['[4] 평가자 구성 (완료 케이스 기준)']);
  push(['직군', '세부', 'Type', '평가자 수', '완료 케이스 수', '', '', '', '', '', '', '', '']);
  var keyOf = function (r) { return [col(r, 'EvaluatorRole') || '(미기재)', col(r, 'EvaluatorDetail') || '', col(r, 'StudyType') || ''].join('\u0001'); };
  unique_(rows.map(keyOf)).sort().forEach(function (k) {
    var sub = rows.filter(function (r) { return keyOf(r) === k; });
    var parts = k.split('\u0001');
    push([parts[0], parts[1], parts[2], unique_(sub.map(function (r) { return col(r, 'SessionId'); })).length, sub.length, '', '', '', '', '', '', '', '']);
  });
  push(['']);

  push(['[5] 직군별 Phase I-CVI (4점 이상 비율)']);
  push(['직군', 'n(케이스)', 'Phase 1', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5', 'S-CVI/Ave', '', '', '', '', '']);
  unique_(rows.map(function (r) { return col(r, 'EvaluatorRole') || '(미기재)'; })).sort().concat(['전체']).forEach(function (g) {
    var sub = rows.filter(function (r) { return g === '전체' || (col(r, 'EvaluatorRole') || '(미기재)') === g; });
    var ic = PHASE_KEYS.map(function (k) {
      var v = sub.map(function (r) { return Number(col(r, phaseCols[k])); }).filter(function (x) { return x >= 1 && x <= 5; });
      return v.length ? v.filter(function (x) { return x >= 4; }).length / v.length : '';
    });
    var valid = ic.filter(function (x) { return x !== ''; });
    push([g, sub.length].concat(ic.map(r3_)).concat([r3_(mean_(valid)), '', '', '', '', '']));
  });
  push(['']);
  push(['※ 모델명은 평가자에게 공개되지 않았습니다(블라인드). 평가자는 Type A/B 중 하나를 골라 AI 답변 2건을 평가했고, Type 안의 제시 순서는 균형 배정되었습니다.']);

  var width = 13;
  out = out.map(function (r) { var a = r.slice(0, width); while (a.length < width) a.push(''); return a; });
  var sum = ss.getSheetByName(SHEET.SUMMARY) || ss.insertSheet(SHEET.SUMMARY);
  sum.clear();
  out = out.map(function (r) { return r.map(function (v) { return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v; }); });
  sum.getRange(1, 1, out.length, width).setValues(out);
  sum.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  sum.autoResizeColumns(1, width);
  Logger.log('✅ Summary 갱신: ' + rows.length + ' cases');
}

function unique_(a) { var s = {}; return a.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); }
function mean_(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : ''; }
function sd_(a) {
  if (a.length < 2) return '';
  var m = mean_(a);
  return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1));
}
function median_(a) {
  if (!a.length) return '';
  var b = a.slice().sort(function (x, y) { return x - y; });
  var h = Math.floor(b.length / 2);
  return b.length % 2 ? b[h] : (b[h - 1] + b[h]) / 2;
}
function r1_(v) { return v === '' ? '' : Math.round(v * 10) / 10; }
function r2_(v) { return v === '' ? '' : Math.round(v * 100) / 100; }
function r3_(v) { return v === '' ? '' : Math.round(v * 1000) / 1000; }
