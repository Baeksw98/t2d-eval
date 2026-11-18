/**
 * 임상 수용성 평가 — 사이트 설정
 * ------------------------------------------------------------
 * ENDPOINT: Google Apps Script 웹 앱 URL (…/exec). 비워 두면 "테스트 모드"로 동작하며
 *           응답은 서버로 전송되지 않고 기기에만 저장됩니다(완료 화면에서 JSON 다운로드 가능).
 */
window.T2D_CONFIG = {
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbxPxzjMttjnyGlgwY_8AYRCMcMGN1_LLGsgShtMg0ZTcSPE3d52m3f4WALNJMuH0S1KUg/exec',

  STUDY_ID: 'T2D-CA-2026',
  APP_VERSION: '2026-11-19.ca-v2',

  // ------------------------------------------------------------
  // 평가자 직군 — 직군을 고르면 그 직군의 추가 항목(fields)이 나타납니다.
  //  · 직군 추가: 항목 하나를 더 넣으면 됩니다 (예: { id: 'fellow', label: '전임의', fields: [...] }).
  //  · field type: 'choice'(버튼), 'select'(목록, groups 로 묶음 가능), 'text'(직접 입력)
  //  · select 의 other: 이 문구를 고르면 직접 입력칸이 나타납니다.
  //  · 응답 시트에는 EvaluatorRole / EvaluatorDetail 과 Eval_<field id> 컬럼으로 저장됩니다(백엔드가 자동으로 컬럼 추가).
  // ------------------------------------------------------------
  EVALUATOR_ROLES: [
    { id: 'intern', label: '인턴', fields: [] },
    {
      id: 'resident', label: '레지던트',
      fields: [
        { id: 'year', label: '레지던트 년차', type: 'choice', options: ['R1', 'R2', 'R3'], required: true }
      ]
    },
    {
      id: 'specialist', label: '전문의',
      fields: [
        {
          id: 'specialty', label: '주 분야 (세부전문)', type: 'select', required: true,
          placeholder: '주 분야를 선택하세요',
          other: '기타 (직접 입력)',
          groups: [
            { label: '내과 세부전문', options: ['내분비대사내과', '순환기내과(심장)', '신장내과', '소화기내과', '호흡기내과', '감염내과', '혈액종양내과', '류마티스내과', '알레르기내과', '노년내과'] },
            { label: '그 외', options: ['일반내과 (세부전문 없음)', '가정의학과'] }
          ]
        }
      ]
    }
  ],

  // ------------------------------------------------------------
  // 평가 유형 — 평가자는 Type 하나를 골라 AI 답변 2건을 평가합니다.
  //  · 각 Type 에 가상 환자 2명(P051, P011)과 AI 2종(DeepSeek, GPT)이 한 번씩 섞여 들어갑니다.
  //  · sequences: 같은 Type 안의 제시 순서. 서버가 응답이 들어온 세션 수가 가장 적은 순서부터 배정합니다
  //    (서버 미연결 시 무작위).
  //  · 링크에 ?type=A 또는 ?type=B 를 붙이면 해당 Type 이 미리 선택됩니다.
  // ------------------------------------------------------------
  STUDY_TYPES: [
    { id: 'A', label: 'Type A', sequences: [['P051_deepseek', 'P011_gpt'], ['P011_gpt', 'P051_deepseek']] },
    { id: 'B', label: 'Type B', sequences: [['P011_deepseek', 'P051_gpt'], ['P051_gpt', 'P011_deepseek']] }
  ],

  // 예상 소요 시간 안내 문구 (Type 1개 = AI 답변 2건)
  ESTIMATED_MINUTES: '20–30분'
};
