/**
 * 가이드라인 부합도 검증 (GC track) — 사이트 설정
 * ------------------------------------------------------------
 * GC 는 임상 수용성 평가(루트 /)와 별개의 평가 절차입니다: 자기 Apps Script 프로젝트(gas/GcCode.gs)와
 * 자기 Google 스프레드시트로 응답을 보냅니다. CA 의 config.js / Apps Script 와는 관계없습니다.
 *
 * 언어(KO/EN): 화면 문구는 i18n/gc.js 에 있습니다. 이 파일의 문항·선택지는
 *   · label, options … = 한국어 원문 = 응답에 저장되는 값(canonical, 백엔드 gas/gc/gc.gs GC_OPT 와 같은 순서)
 *   · en: { label, options, … } = 영어 화면에서만 보이는 번역 (같은 순서). 응답에는 항상 한국어 값 + code 가 저장됩니다.
 */
window.GC_CONFIG = {
  // GC 웹 앱 URL (…/exec). 아직 비어 있음 → 테스트 모드(응답은 이 기기에만 저장되고 서버로 보내지 않음).
  // gas/GcCode.gs 를 새 Apps Script 프로젝트로 배포한 뒤 받은 웹 앱 URL 을 여기에 넣으면 실제 수집이 시작됩니다.
  ENDPOINT: '',

  STUDY_ID: 'T2D-GC-2026',
  APP_VERSION: '2026-11-21.gc-v2.2',
  INSTRUMENT_VERSION: 'GC physician validation v2 (audit-flagged judgments)',
  CONSENT_VERSION: 'gc-2026-11-19-v2',
  IRB_NO: '',
  STUDY_WAVE: 'main',
  INCENTIVE: '없음',

  // 참여 자격: 이 문항에 '예'를 고른 경우에만 진행 (자기 보고)
  ELIGIBILITY: {
    id: 'endo_board',
    label: '내분비대사내과 분과전문의이십니까?',
    yes: '예, 내분비대사내과 분과전문의입니다',
    no: '아니요',
    blocked: '이 검증은 내분비대사내과 분과전문의만 참여할 수 있습니다. 참여해 주셔서 감사합니다.',
    en: {
      label: 'Are you board-certified in endocrinology and metabolism?',
      yes: 'Yes, I am board-certified',
      no: 'No',
      blocked: 'This validation is open only to physicians board-certified in endocrinology and metabolism.'
    }
  },

  // 검증자 특성 (Table 1 용). 이어서 다른 Part 를 할 때는 다시 묻지 않습니다(앞 세션에 없던 문항만 묻습니다).
  // short = 이어서 하기 화면의 요약 줄에 쓰는 짧은 이름.
  // ai_freq 는 임상 수용성 평가(config.js COMMON_FIELDS)와 같은 id·문구·선택지·코드(1–5, 이 순서)입니다.
  PROFILE_FIELDS: [
    { id: 'board_years', short: '분과전문의 경력', label: '분과전문의 취득 후 경력', type: 'choice', required: true,
      options: ['5년 미만', '5–9년', '10–19년', '20년 이상'],
      en: { short: 'Years certified', label: 'Years since endocrinology board certification', options: ['< 5 years', '5–9 years', '10–19 years', '≥ 20 years'] } },
    { id: 'setting', short: '주 근무 기관', label: '주 근무 기관', type: 'choice', required: true,
      options: ['상급종합병원', '종합병원', '병원·의원', '기타'],
      en: { short: 'Main practice setting', label: 'Main practice setting', options: ['Tertiary hospital', 'General hospital', 'Hospital or clinic', 'Other'] } },
    { id: 'ai_freq', short: 'AI 사용 빈도', label: '진료·학습·연구에 생성형 AI(대화형 AI 챗봇 등)나 AI 진료 보조 도구를 얼마나 자주 사용하십니까?',
      type: 'choice', layout: 'list', required: true,
      options: ['사용한 적 없음', '주 1회 미만', '주 1–2회', '주 3–6회', '거의 매일'],
      en: {
        short: 'AI use frequency',
        label: 'How often do you use generative AI (e.g., AI chatbots) or AI clinical support tools for patient care, learning or research?',
        options: ['Never', 'Less than once a week', '1–2 times a week', '3–6 times a week', 'Almost every day']
      } }
  ],

  // 판정마다: 동의 / 비동의. 비동의면 올바른 판정을 고릅니다. hint 는 비동의 후 고르는 버튼에 함께 보입니다.
  // 채점 요소 제목은 대부분 '… 누락'처럼 결함을 적은 것이므로, 충족 = 감점 사유 없음 임을 분명히 둡니다.
  // 응답에는 id(met / deducted / not_applicable)가 저장됩니다.
  VERDICTS: [
    { id: 'met', label: '충족', hint: '감점 기준에 해당하지 않음', en: { label: 'Met', hint: 'The deduction criterion does not apply' } },
    { id: 'deducted', label: '감점', hint: '감점 기준에 해당함', en: { label: 'Deducted', hint: 'The deduction criterion applies' } },
    { id: 'not_applicable', label: '채점 대상 아님', hint: '이 환자·조합에는 이 항목을 적용하지 않아야 함',
      en: { label: 'Not applicable', hint: 'This element should not apply to this patient and regimen' } }
  ],

  // 마지막 화면 문항 (세션당 1회)
  END_ITEMS: [
    { id: 'info_sufficient', label: 'CDSS 답변, AI 채점 판정과 AI 감사 의견만으로 판정을 확정하기에 정보가 충분했다.',
      type: 'choice', layout: 'list', required: true,
      options: ['1 · 전혀 그렇지 않다', '2 · 그렇지 않다', '3 · 보통이다', '4 · 그렇다', '5 · 매우 그렇다'],
      en: {
        label: 'The CDSS answer, the AI rater’s verdict and the AI audit’s opinion alone gave me enough information to confirm each verdict.',
        options: ['1 · Strongly disagree', '2 · Disagree', '3 · Neutral', '4 · Agree', '5 · Strongly agree']
      } },
    { id: 'hitl_acceptable', label: 'AI 감사가 문제를 표시한 판정만 전문의가 확정하고 나머지는 AI 판정을 그대로 쓰는 방식은 타당하다.',
      type: 'choice', layout: 'list', required: true,
      options: ['1 · 전혀 그렇지 않다', '2 · 그렇지 않다', '3 · 보통이다', '4 · 그렇다', '5 · 매우 그렇다'],
      en: {
        label: 'Having specialists confirm only the verdicts the AI audit flagged, and keeping the AI verdicts for the rest, is a reasonable approach.',
        options: ['1 · Strongly disagree', '2 · Disagree', '3 · Neutral', '4 · Agree', '5 · Strongly agree']
      } }
  ],

  // Part — 활성 케이스 세트의 data/design.js(window.T2D_DESIGN.gc.parts)가 있으면 그 Part 를 씁니다(tools/build_cases.py 가 생성).
  // 아래 PARTS 는 그 파일이 없을 때 쓰는 기본값(세트 v1)입니다.
  // 각 Part 에 환자 2명(P051, P011)과 CDSS 2종이 한 번씩 들어갑니다 (임상 수용성 Type A/B 와 같은 짝).
  // sequences: 같은 Part 안의 제시 순서. 서버가 가장 적게 쓰인 순서를 배정합니다(서버 미연결 시 무작위).
  PARTS: [
    { id: 'A', label: 'Part A', sequences: [['P051_deepseek', 'P011_gpt'], ['P011_gpt', 'P051_deepseek']] },
    { id: 'B', label: 'Part B', sequences: [['P011_deepseek', 'P051_gpt'], ['P051_gpt', 'P011_deepseek']] }
  ],

  // 판정 1건당 예상 시간(분) — 시작 화면의 예상 소요 시간 계산용 (design.js 의 Part minutes 가 있으면 그 값)
  MINUTES_PER_ITEM: 1.2
};
