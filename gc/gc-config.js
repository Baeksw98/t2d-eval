/**
 * 가이드라인 부합도 검증 (GC track) — 사이트 설정
 * ------------------------------------------------------------
 * 임상 수용성 평가(루트 /)와 같은 Apps Script 웹 앱으로 보냅니다(action 이 gc_ 로 시작).
 * ENDPOINT 를 비우면 테스트 모드(기기에만 저장)로 동작합니다.
 */
window.GC_CONFIG = {
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbxPxzjMttjnyGlgwY_8AYRCMcMGN1_LLGsgShtMg0ZTcSPE3d52m3f4WALNJMuH0S1KUg/exec',

  STUDY_ID: 'T2D-GC-2026',
  APP_VERSION: '2026-11-19.gc-v1',
  INSTRUMENT_VERSION: 'GC physician validation v1 (audit-flagged judgments)',
  CONSENT_VERSION: 'gc-2026-11-19-v1',
  IRB_NO: '',
  STUDY_WAVE: 'main',
  INCENTIVE: '없음',

  // 참여 자격: 이 문항에 '예'를 고른 경우에만 진행 (자기 보고)
  ELIGIBILITY: {
    id: 'endo_board',
    label: '내분비대사내과 분과전문의이십니까?',
    yes: '예, 내분비대사내과 분과전문의입니다',
    no: '아니요',
    blocked: '이 검증은 내분비대사내과 분과전문의만 참여할 수 있습니다. 참여해 주셔서 감사합니다.'
  },

  // 검증자 특성 (Table 1 용). 이어서 다른 Part 를 할 때는 다시 묻지 않습니다.
  PROFILE_FIELDS: [
    { id: 'board_years', label: '분과전문의 취득 후 경력', type: 'choice', required: true,
      options: ['5년 미만', '5–9년', '10–19년', '20년 이상'] },
    { id: 'setting', label: '주 근무 기관', type: 'choice', required: true,
      options: ['상급종합병원', '종합병원', '병원·의원', '기타'] },
    { id: 't2d_volume', label: '최근 3개월 동안 직접 진료한 제2형 당뇨병 환자 수 (월 평균)', type: 'choice', layout: 'list', required: true,
      options: ['월 100명 미만', '월 100–299명', '월 300명 이상'] }
  ],

  // 판정마다: 동의 / 비동의. 비동의면 올바른 판정을 고릅니다.
  VERDICTS: [
    { id: 'met', label: '충족' },
    { id: 'deducted', label: '감점' },
    { id: 'not_applicable', label: '채점 대상 아님', hint: '이 환자·조합에는 이 항목을 적용하지 않아야 함' }
  ],

  // 마지막 화면 문항 (세션당 1회)
  END_ITEMS: [
    { id: 'info_sufficient', label: 'AI 답변, AI Rater의 판정과 AI 감사 의견만으로 판정을 확정하기에 정보가 충분했다.',
      type: 'choice', layout: 'list', required: true,
      options: ['1 · 전혀 그렇지 않다', '2 · 그렇지 않다', '3 · 보통이다', '4 · 그렇다', '5 · 매우 그렇다'] },
    { id: 'hitl_acceptable', label: 'AI 감사가 문제를 표시한 판정만 전문의가 확정하고 나머지는 AI 판정을 그대로 쓰는 방식은 타당하다.',
      type: 'choice', layout: 'list', required: true,
      options: ['1 · 전혀 그렇지 않다', '2 · 그렇지 않다', '3 · 보통이다', '4 · 그렇다', '5 · 매우 그렇다'] }
  ],

  // Part — 각 Part 에 환자 2명(P051, P011)과 CDSS 2종이 한 번씩 들어갑니다 (임상 수용성 Type A/B 와 같은 짝).
  // sequences: 같은 Part 안의 제시 순서. 서버가 가장 적게 쓰인 순서를 배정합니다(서버 미연결 시 무작위).
  PARTS: [
    { id: 'A', label: 'Part A', sequences: [['P051_deepseek', 'P011_gpt'], ['P011_gpt', 'P051_deepseek']] },
    { id: 'B', label: 'Part B', sequences: [['P011_deepseek', 'P051_gpt'], ['P051_gpt', 'P011_deepseek']] }
  ],

  // 판정 1건당 예상 시간(분) — 시작 화면의 예상 소요 시간 계산용
  MINUTES_PER_ITEM: 1.2
};
