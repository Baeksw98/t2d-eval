/**
 * 임상 수용성 평가 — 사이트 설정
 * ------------------------------------------------------------
 * ENDPOINT: Google Apps Script 웹 앱 URL (…/exec). 비워 두면 "테스트 모드"로 동작하며
 *           응답은 서버로 전송되지 않고 기기에만 저장됩니다(완료 화면에서 JSON 다운로드 가능).
 */
window.T2D_CONFIG = {
  ENDPOINT: '',

  STUDY_ID: 'T2D-CA-2026',
  APP_VERSION: '2026-11-18.ca-v1',

  // 평가자 년차 선택지
  RESIDENT_YEARS: ['R1', 'R2', 'R3', 'R4'],

  // 제시 순서 — 4×4 Latin square (환자·모델 교차 배치).
  // 각 위치(1~4번째)에 4개 답변이 한 번씩 등장하고, 연속된 두 케이스는 항상 환자가 다릅니다.
  // (2→3번째에서는 같은 모델이 연속됩니다 — 2×2 설계에서 환자·모델 동시 교대는 불가능. 분석 시 제시 위치를 공변량으로 고려)
  // 서버가 응답이 들어온 세션 수가 가장 적은 순서부터 배정합니다(서버 미연결 시 무작위).
  SEQUENCES: [
    ['P051_deepseek', 'P011_gpt', 'P051_gpt', 'P011_deepseek'],
    ['P051_gpt', 'P011_deepseek', 'P051_deepseek', 'P011_gpt'],
    ['P011_deepseek', 'P051_gpt', 'P011_gpt', 'P051_deepseek'],
    ['P011_gpt', 'P051_deepseek', 'P011_deepseek', 'P051_gpt']
  ],

  // 예상 소요 시간 안내 문구
  ESTIMATED_MINUTES: '40–60분'
};
