/**
 * 가이드라인 부합도 검증 (GC, 사이트 eval.asclep.org/gc/) — 응답 수집 백엔드
 * Google Apps Script 웹 앱 → 이 검증 전용 Google 스프레드시트 (임상 수용성 평가 CA 의 스크립트·시트와는 완전히 별개)
 *
 * ※ 이 파일(gas/GcCode.gs)은 tools/build_gas.py 가 만든 결과물입니다. 고칠 때는 gas/gc/*.gs 를 고치고 다시 만드세요.
 *
 * ── 배포 방법 (iPad 에서도 가능, 약 5분) ─────────────────────────────────────────────
 *  iPad: Safari 에서 script.google.com 을 열고 주소창의 「가가」(또는 aA) → '데스크탑 웹 사이트 요청' 을 켜면 편리합니다.
 *  붙여넣을 코드 받는 곳: https://github.com/Baeksw98/t2d-eval/blob/main/gas/GcCode.gs
 *     → 코드 위 오른쪽의 복사 아이콘(「Copy raw file」)을 누르면 파일 전체가 복사됩니다.
 *       (컴퓨터에서는 https://raw.githubusercontent.com/Baeksw98/t2d-eval/main/gas/GcCode.gs 를 열고 전체 선택 → 복사도 됩니다)
 *   1) script.google.com 접속 → 왼쪽 위 [새 프로젝트]
 *      ※ 임상 수용성 평가(CA) 응답 시트의 [확장 프로그램 → Apps Script]에서 만들지 마세요. GC 는 반드시 별도 새 프로젝트입니다.
 *   2) 편집기에 있던 기본 코드(function myFunction…)를 모두 지우고, 이 파일 전체를 붙여넣기 → 저장(💾)
 *      (프로젝트 이름은 왼쪽 위 '제목 없는 프로젝트'를 눌러 예: 'GC 검증 백엔드' 로 바꾸면 찾기 쉽습니다)
 *   3) 위쪽 함수 선택 칸에서 setup 선택 → [실행]
 *      → '권한 검토' → 본인 계정 선택 → ('Google에서 확인하지 않은 앱' 화면이 나오면) 고급 → '…(으)로 이동' → [허용]
 *        권한 항목마다 체크박스가 보이는 화면이면 「모두 선택」을 누른 뒤 [계속] (일부만 허용하면 요약 자동 갱신이 설정되지 않습니다)
 *      → 실행 로그 마지막 줄이 '✅ GC 응답 시트 준비 완료' 인지 확인 ('⚠️' 로 끝나면 setup 을 한 번 더 실행)
 *   4) 아래 [실행 로그]에 나오는 시트 링크(https://docs.google.com/spreadsheets/…)를 눌러 확인
 *      → 내 드라이브에 새 스프레드시트 '가이드라인 부합도 검증 (GC) 응답' 이 만들어져 있습니다
 *        (Visits · GC_Sessions · GC_Judgments · GC_Raw 시트, 10분마다 요약을 갱신하는 트리거 1개 포함)
 *   5) 오른쪽 위 [배포] → [새 배포] → 유형 선택(⚙) → [웹 앱]
 *      → 설명: 'GC v1' / 다음 사용자 인증 정보로 실행: '나' / 액세스 권한이 있는 사용자: '모든 사용자' → [배포]
 *   6) 나타난 '웹 앱 URL'(https://script.google.com/macros/s/…/exec)을 복사
 *      → 사이트의 gc/gc-config.js 의 ENDPOINT 에 넣기 (연구진에게 URL 을 보내 주시면 됩니다)
 *  · 액세스 권한은 반드시 '모든 사용자'(Anyone)여야 합니다. 'Google 계정이 있는 모든 사용자'나 기관 내 사용자로 두면
 *    전문의 브라우저가 Google 로그인으로 막혀 응답이 저장되지 않습니다.
 *  · setup 은 다시 실행해도 안전합니다: 기존 응답은 그대로 두고 빠진 시트·컬럼만 추가하며, 요약 트리거는 1개로 유지됩니다.
 *  · 코드를 고쳐 다시 붙여넣은 뒤에는 [배포] → [배포 관리] → ✏️(수정) → 버전: '새 버전' → [배포] (웹 앱 URL 유지).
 *  · 이미 만들어 둔 GC 전용 빈 스프레드시트를 쓰려면 아래 GC_SPREADSHEET_ID 에 시트 주소의 /d/ 와 /edit 사이 ID 를 넣고 저장하세요.
 *    임상 수용성 평가(CA) 응답 스프레드시트의 ID 는 절대 넣지 마세요 (두 평가의 Visits 가 섞입니다). 넣으면 오류로 멈춥니다.
 *  · 요약은 10분마다 자동 갱신됩니다. 바로 보려면 함수 buildGcSummary (테스트 응답 포함: buildGcSummaryIncludingTests) 실행.
 *
 * ── 시트 구성 ─────────────────────────────────────────────────────────────────────
 *   Visits          GC 소개 화면 방문 1건당 1행 (참여 흐름 분모)
 *   GC_Sessions     검증 세션(Part 1개) 1건당 1행: 전문의 정보(Eval_*), 진행 상태, 소요 시간, 마지막 문항(End_*)
 *   GC_Judgments    세션 × 검증 대상 판정 1행: 동의/비동의, 전문의 판정, 판정별 시간
 *   GC_Raw          받은 요청 원문 (감사 추적용)
 *   GC_Adjudication · GC_Concordance · GC_Summary · GC_Codebook  — buildGcSummary 가 만드는 요약 (docs/GC_CONTRACT.md)
 */

// ============================================================
// CONFIG
// ============================================================
// GC 응답 스프레드시트 ID. 비워 두면 setup 이 새 스프레드시트를 만들고 그 ID 를 스크립트 속성(GC_SPREADSHEET_ID)에 저장합니다.
var GC_SPREADSHEET_ID = "";
var GC_SPREADSHEET_NAME = '가이드라인 부합도 검증 (GC) 응답';
var GC_BACKEND_VERSION = '2026-11-20.gc-backend-v3';

// ============================================================
// HTTP ENTRY POINTS
// ============================================================
function doGet(e) {
  return json_({ ok: true, service: 'guideline-concordance', backend: GC_BACKEND_VERSION, time: new Date().toISOString() });
}

function doPost(e) {
  var body0 = (e && e.postData && e.postData.contents) || '';
  // 소개 화면 방문 기록(view): 응답 저장보다 우선순위가 낮으므로 잠깐만 기다리고, 바쁘면 건너뜀
  if (body0.indexOf('"action":"view"') !== -1) return gcHandleView_(body0);
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(12000);   // 클라이언트 대기 한도보다 짧게 → 혼잡 시 빨리 'busy' 응답 후 재전송
  } catch (errLock) {
    return json_({ ok: false, error: 'busy' });
  }
  var t0 = Date.now();
  var p = null, ss = null;
  try {
    var body = (e && e.postData && e.postData.contents) || '';
    if (body.length > 900000) return json_({ ok: false, error: 'payload too large' });
    p = JSON.parse(body);
    if (!p || GC_ACTIONS.indexOf(p.action) < 0) return json_({ ok: false, error: 'bad request' });
    if (!UUID_RE.test(String(p.session_id || ''))) return json_({ ok: false, error: 'bad session id' });
    if (p.study_id !== GC_STUDY_ID) return json_({ ok: false, error: 'unknown study' });

    ss = gcSs_();
    var db = {};   // 요청 단위 시트 캐시: 시트마다 1번만 읽고, 끝에서 한 번에 쓴다
    var result = { ok: true };
    gcHandle_(ss, db, p, result);   // GC_Sessions · GC_Judgments 기록(flush 포함)
    // 새 실제 판정이 있으면 표시만 해 두고, 요약은 10분 주기 트리거(refreshGcSummaryIfDirty)가 다시 만든다
    if (!p.is_test && (p.action === 'gc_judgment' || p.action === 'gc_finish')) {
      PropertiesService.getScriptProperties().setProperty('GC_SUMMARY_DIRTY', '1');
    }
    gcLogRaw_(ss, p, Date.now() - t0, '');
    return json_(result);
  } catch (err) {
    console.error(err && err.stack || err);
    try { if (ss && p) gcLogRaw_(ss, p, Date.now() - t0, String(err && err.message || err)); } catch (_) {}
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    gcRelease_(lock);
  }
}

/**
 * 잠금 해제 전에 SpreadsheetApp.flush(): 쓰기를 잠금을 쥔 동안 시트에 확정한다. (Lock.releaseLock 문서 권고)
 * 그러지 않으면 바로 다음 요청이 확정 전의 시트를 읽어, 같은 행 위치에 새 행을 쓰거나 이전 값으로 행을 되돌릴 수 있다.
 */
function gcRelease_(lock) {
  try { SpreadsheetApp.flush(); } catch (eFlush) { console.error('flush: ' + eFlush); }
  try { lock.releaseLock(); } catch (eRel) {}
}

/** GC 소개 화면 방문 → Visits (CA 와 같은 컬럼; TypeParam = 링크의 ?part=) */
function gcHandleView_(body) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return json_({ ok: false, error: 'busy' });
  try {
    var p = JSON.parse(body);
    if (!p || p.study_id !== GC_STUDY_ID || !UUID_RE.test(String(p.visit_id || ''))) return json_({ ok: false, error: 'bad request' });
    var en = p.entry || {};
    var sh = sheet_(gcSs_(), GC_SHEET.VISITS, visitsHeaders_());
    sh.appendRow([new Date(), p.visit_id, short_(p.device_id), short_(en.src), short_(en.site), short_(en.wave),
      short_(en.type_param || ''), short_(p.form_factor), short_(en.in_app), short_(en.referrer_origin, 120),
      !!p.is_test, short_(p.app_version)].map(cell_));
    sh.getRange(sh.getLastRow(), 1).setNumberFormat(TIME_FMT);   // ReceivedAt: 초 단위
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    gcRelease_(lock);
  }
}

function gcLogRaw_(ss, p, elapsedMs, error) {
  var sh = sheet_(ss, GC_SHEET.RAW, rawHeaders_());
  var row = [new Date(), String(p.action || ''), String(p.session_id || ''), String(p.msg_id || ''), !!p.is_test,
    clip_(JSON.stringify(p)), elapsedMs, error || ''];
  sh.appendRow(row.map(cell_));
  sh.getRange(sh.getLastRow(), 1).setNumberFormat(TIME_FMT);   // ReceivedAt: 초 단위
}

// 임상 수용성 평가(CA) 응답 스프레드시트에만 있는 시트. 이 중 하나라도 있으면 GC 는 그 스프레드시트를 쓰지 않는다
// (GC 와 CA 는 같은 이름의 Visits 시트를 쓰므로, 같은 스프레드시트면 두 평가의 방문 기록이 섞인다).
var GC_CA_SHEET_NAMES = ['Responses', 'PhaseLong', 'Sessions', 'RawJSON'];

function gcAssertNotCa_(ss, bound) {
  var found = GC_CA_SHEET_NAMES.filter(function (n) { return !!ss.getSheetByName(n); });
  if (!found.length) return;
  throw new Error('이 스프레드시트는 임상 수용성 평가(CA) 응답 시트입니다(' + found.join(', ') + ' 시트가 있음). ' +
    'GC 는 별도의 새 스프레드시트를 써야 합니다 — ' + (bound
      ? '이 프로젝트는 CA 시트에 연결되어 있으니, script.google.com 에서 [새 프로젝트]를 만들어 GcCode.gs 를 붙여넣고 setup 을 실행하세요.'
      : 'GcCode.gs 위쪽 GC_SPREADSHEET_ID 를 비우고("") 저장한 뒤 setup 을 다시 실행하세요. 새 GC 스프레드시트가 자동으로 만들어집니다.'));
}

/**
 * GC 응답 스프레드시트: GC_SPREADSHEET_ID → 스크립트 속성 GC_SPREADSHEET_ID → (setup 에서만) 시트에 연결된 프로젝트면
 * 그 시트, 아니면 새로 만든다. setup 전에 요청이 오면 setup 을 실행하라는 오류를 낸다.
 * CA 응답 스프레드시트면 쓰지 않고 오류를 낸다 (ID 마다 처음 한 번 확인: 스크립트 속성 GC_SS_CHECKED).
 */
function gcSs_(createIfMissing) {
  var props = PropertiesService.getScriptProperties();
  var id = String(GC_SPREADSHEET_ID || '').trim() || props.getProperty('GC_SPREADSHEET_ID') || '';
  if (id) {
    var ssId = SpreadsheetApp.openById(id);
    if (props.getProperty('GC_SS_CHECKED') !== id) {
      gcAssertNotCa_(ssId, false);
      props.setProperty('GC_SS_CHECKED', id);
    }
    return ssId;
  }
  if (!createIfMissing) {
    throw new Error('가이드라인 부합도 검증(GC) 응답 스프레드시트가 아직 없습니다. Apps Script 편집기에서 함수 setup 을 한 번 ' +
      '실행하세요(시트가 자동으로 만들어집니다). 이미 만든 GC 전용 시트를 쓰려면 GcCode.gs 위쪽 GC_SPREADSHEET_ID 에 그 시트 ID 를 넣으세요' +
      '(임상 수용성 평가 CA 응답 시트의 ID 는 안 됩니다).');
  }
  var ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (eAct) { ss = null; }   // 시트에서 [확장 프로그램 → Apps Script]로 만든 경우
  if (ss) gcAssertNotCa_(ss, true);   // ID 를 기록하기 전에 확인
  if (!ss) ss = SpreadsheetApp.create(GC_SPREADSHEET_NAME);
  props.setProperty('GC_SPREADSHEET_ID', ss.getId());
  props.setProperty('GC_SS_CHECKED', ss.getId());
  return ss;
}

// ============================================================
// SETUP / MENU / TRIGGER
// ============================================================
/**
 * 최초 1회 실행: 권한 승인 + GC 스프레드시트(없으면 새로 만듦)·시트·헤더 + 10분 요약 트리거. 다시 실행해도 안전.
 * 실행 로그에 스프레드시트 링크를 남기고 그 URL 을 돌려준다.
 */
function setup() {
  var ss = gcSs_(true);
  // 응답이 없거나 테스트 응답(IsTest=TRUE)만 있는 시트는 최신 컬럼 순서로 새로 만든다.
  // 실제 응답이 하나라도 있으면 데이터는 건드리지 않고 누락된 컬럼만 오른쪽 끝에 추가한다.
  gcDataSheets_().forEach(function (x) {
    var sh = ss.getSheetByName(x[0]);
    if (sh && onlyTestRows_(sh)) {
      sh.clear();
      sh.getRange(1, 1, 1, x[1].length).setValues([x[1]]).setFontWeight('bold').setBackground('#e3edf5');
      sh.setFrozenRows(1);
    } else {
      sheet_(ss, x[0], x[1]);
    }
  });
  var def = ss.getSheetByName('Sheet1') || ss.getSheetByName('시트1');
  if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  ensureTimeZone_(ss);
  gcDataSheets_().forEach(function (x) { var sh = ss.getSheetByName(x[0]); if (sh) formatTimeCols_(sh); });
  Logger.log('✅ 시각 컬럼: 한국 시간, 초 단위(yyyy-mm-dd hh:mm:ss) 표시');
  var trigOk = false;
  try { ensureGcSummaryTrigger_(); trigOk = true; Logger.log('✅ GC 요약 자동 갱신(10분 주기) 설정 완료'); }
  catch (eTrig) { Logger.log('⚠️ 자동 갱신 트리거 설정 실패: ' + eTrig); }
  var url = ss.getUrl();
  Logger.log('다음 단계: [배포] → [새 배포] → 웹 앱 (실행 사용자: 나 / 액세스: 모든 사용자) → 웹 앱 URL 을 gc/gc-config.js ENDPOINT 에');
  // 마지막 줄 = 결과 (헤더 3) 단계에서 이 줄을 확인하도록 안내)
  if (trigOk) {
    Logger.log('✅ GC 응답 시트 준비 완료 — 이 링크에서 확인하세요: ' + url);
  } else {
    Logger.log('⚠️ 응답 시트는 만들어졌지만 요약 자동 갱신이 설정되지 않았습니다 — setup 을 다시 실행하고 권한 화면에서 모든 항목을 ' +
      '허용하세요(체크박스가 보이면 「모두 선택」 → [계속]). 응답 시트: ' + url);
  }
  return url;
}

/** GC 응답 데이터 시트와 헤더 (setup·resetAllGcResponses 공용) */
function gcDataSheets_() {
  return [[GC_SHEET.VISITS, visitsHeaders_()], [GC_SHEET.SESS, gcSessHeaders_()], [GC_SHEET.JUDG, gcJudgHeaders_()],
    [GC_SHEET.RAW, rawHeaders_()]];
}

/**
 * ⚠️ 모든 GC 응답 삭제 (처음부터 다시 수집할 때만 실행)
 *  1) 지금 GC 스프레드시트 전체를 '… (백업 yyyy-MM-dd HH:mm:ss)' 사본으로 내 드라이브에 저장
 *  2) Visits · GC_Sessions · GC_Judgments · GC_Raw 의 응답 행을 모두 지우고 최신 헤더만 남김
 *  3) 전문의 가명 코드(G001…, GT001…)·순서 배정 카운터 초기화, GC 요약 시트를 빈 데이터로 다시 만듦
 */
function resetAllGcResponses() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = gcSs_(false);
    var stamp = Utilities.formatDate(new Date(), TIME_ZONE, 'yyyy-MM-dd HH:mm:ss');
    var backup = ss.copy(ss.getName() + ' (백업 ' + stamp + ')');
    Logger.log('💾 백업 사본: ' + backup.getUrl());
    var counts = [];
    gcDataSheets_().forEach(function (x) {
      var sh = ss.getSheetByName(x[0]);
      var n = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
      if (sh) sh.clear(); else sh = ss.insertSheet(x[0]);
      sh.getRange(1, 1, 1, x[1].length).setValues([x[1]]).setFontWeight('bold').setBackground('#e3edf5');
      sh.setFrozenRows(1);
      formatTimeCols_(sh);
      counts.push(x[0] + ' ' + n + '행');
    });
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties(), removed = 0;
    Object.keys(all).forEach(function (k) {
      if (/^(GCT_|GCC_|GC_SEQ_COUNTER|GC_SUMMARY_DIRTY$|GC_SUMMARY_BUILT_AT$)/.test(k)) { props.deleteProperty(k); removed++; }
    });
    ensureTimeZone_(ss);
    SpreadsheetApp.flush();
    Logger.log('🗑️ 삭제한 응답: ' + counts.join(', ') + ' / 초기화한 코드·카운터 ' + removed + '개');
  } finally {
    try { lock.releaseLock(); } catch (eRel) {}
  }
  try { buildGcSummary(false); } catch (eSum) { Logger.log('⚠️ GC 요약 갱신 실패(다음 응답 후 자동 갱신): ' + eSum); }
  Logger.log('✅ 모든 GC 응답을 지웠습니다. 백업은 위 링크에 있습니다.');
}

/** 시간 기반 트리거(10분)용: 새 실제 판정이 있을 때만, 잠금을 얻은 경우에만 GC 요약 재생성 */
function refreshGcSummaryIfDirty() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('GC_SUMMARY_DIRTY') !== '1') return false;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;   // 응답 저장 중이면 다음 주기에
  try {
    buildGcSummary(false);
  } finally {
    gcRelease_(lock);
  }
  return true;
}

/** refreshGcSummaryIfDirty 시간 트리거를 정확히 1개만 유지 (중복 삭제). 멱등. */
function ensureGcSummaryTrigger_() {
  if (typeof ScriptApp === 'undefined') return false;
  var handler = 'refreshGcSummaryIfDirty';
  var keep = null;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() !== handler) return;
    var clock = !ScriptApp.EventType || !t.getEventType || t.getEventType() === ScriptApp.EventType.CLOCK;
    if (!keep && clock) keep = t;
    else ScriptApp.deleteTrigger(t);
  });
  if (!keep) ScriptApp.newTrigger(handler).timeBased().everyMinutes(10).create();
  return true;
}

/** 시트에 연결된 프로젝트에서만 동작 (script.google.com 의 독립 프로젝트에서는 함수 목록에서 직접 실행) */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('📋 가이드라인 부합도 검증')
    .addItem('요약 갱신 (테스트 응답 제외)', 'buildGcSummary')
    .addItem('요약 갱신 (테스트 응답 포함)', 'buildGcSummaryIncludingTests')
    .addSeparator()
    .addItem('시트·헤더 점검', 'setup')
    .addItem('순서 배정 카운터 확인', 'showGcCounter')
    .addToUi();
}

function showGcCounter() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var c = Object.keys(all).filter(function (k) { return k.indexOf('GC_SEQ_COUNTER') === 0; })
    .map(function (k) { return k + '=' + all[k]; }).join(', ') || '0';
  var msg = 'Part 별 순서 배정을 요청한 실제 전문의 수: ' + c + '\n(배정은 판정이 들어온 세션 수가 가장 적은 순서부터 이루어집니다.)';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (eUi) {}   // 독립 프로젝트에서는 실행 로그로만 표시
  return c;
}
