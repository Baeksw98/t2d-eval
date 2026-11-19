/**
 * 임상 수용성 평가 — 사이트 설정
 * ------------------------------------------------------------
 * ENDPOINT: Google Apps Script 웹 앱 URL (…/exec). 비워 두면 "테스트 모드"로 동작하며
 *           응답은 서버로 전송되지 않고 기기에만 저장됩니다(완료 화면에서 JSON 다운로드 가능).
 */
window.T2D_CONFIG = {
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbxPxzjMttjnyGlgwY_8AYRCMcMGN1_LLGsgShtMg0ZTcSPE3d52m3f4WALNJMuH0S1KUg/exec',

  STUDY_ID: 'T2D-CA-2026',
  APP_VERSION: '2026-11-19.ca-v3',

  // 연구 메타데이터 (응답과 함께 저장 → 논문 방법 기술·버전별 분석용)
  INSTRUMENT_VERSION: 'Delphi-final P1–P5 (5-point agreement)',  // 주 평가 문항(Delphi 확정본) 버전
  CONSENT_VERSION: '2026-11-19-v2',  // 동의 문구를 바꾸면 올려 주세요
  IRB_NO: '',                        // IRB 승인번호를 넣으면 동의 문구에 표시됩니다 (예: 'XXXX-2026-0123')
  STUDY_WAVE: 'main',                // 'pilot' 이면 주 분석에서 자동 제외 (링크에 ?wave=pilot 으로도 지정 가능)
  INCENTIVE: '없음',                  // 참여 보상 (CHERRIES 보고 항목)

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
        { id: 'year', label: '레지던트 년차', type: 'choice', options: ['R1', 'R2', 'R3'], required: true },
        { id: 'major', label: '전공 과', type: 'choice', options: ['내과', '가정의학과'], other: '기타 (직접 입력)', required: true }
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
        },
        { id: 'board_years', label: '전문의 취득 후 경력', type: 'choice', options: ['5년 미만', '5–9년', '10–19년', '20년 이상'], required: true }
      ]
    }
  ],

  // ------------------------------------------------------------
  // 모든 직군 공통 배경 문항 (평가자 특성 표 Table 1 용, 한 번 탭)
  //  · firstSessionOnly: 다른 Type 을 이어서 평가할 때는 다시 묻지 않고 처음 응답을 그대로 사용
  //  · layout 'list': 선택지가 길어 세로로 표시
  // ------------------------------------------------------------
  COMMON_FIELDS: [
    {
      id: 't2d_volume', label: '최근 3개월 동안 제2형 당뇨병 환자의 약물 치료 결정에 직접 참여한 환자 수는 월 평균 대략 몇 명입니까? (외래·병동 포함)',
      type: 'choice', layout: 'list', required: true,
      options: ['월 1명 미만', '월 1–10명', '월 11–30명', '월 31명 이상']
    },
    {
      id: 'ai_use', label: '진료·학습·연구 목적으로 생성형 AI(대화형 AI 챗봇 등)나 AI 임상 의사결정 지원 도구를 얼마나 자주 사용하십니까?',
      type: 'choice', layout: 'list', required: true,
      options: ['사용한 적 없음', '월 1회 미만', '월 1회–주 1회', '주 2회 이상', '거의 매일']
    },
    {
      id: 'ai_trust', label: '현재 AI 임상 의사결정 지원 도구가 제시하는 진료 권고를 어느 정도 신뢰하십니까?',
      type: 'choice', layout: 'list', required: true, firstSessionOnly: true,
      options: ['1 · 전혀 신뢰하지 않음', '2 · 별로 신뢰하지 않음', '3 · 보통', '4 · 대체로 신뢰함', '5 · 매우 신뢰함']
    }
  ],

  // ------------------------------------------------------------
  // 케이스마다 묻는 보조 문항 — Phase 5 평가 뒤 '의견' 화면에 별도 카드로 표시 (Delphi 주 문항과 분리)
  // ------------------------------------------------------------
  CASE_ITEMS: [
    {
      id: 'harm', label: '이 AI 답변을 수정 없이 그대로 따른다면, 환자에게 위해가 될 수 있는 내용(잘못된 약물·용량, 금기 위반, 필요한 조치 누락 등)이 있었습니까?',
      type: 'choice', layout: 'list', required: true,
      options: ['없음', '경미한 위해 가능성', '중대한 위해 가능성']
    },
    {
      id: 'harm_phases', label: '위해 가능성이 있었던 부분 (해당하는 것 모두, 선택)',
      type: 'multi', required: false, showIf: { item: 'harm', minCode: 2 },
      options: [['P1', 'Phase 1 의뢰'], ['COMBO', '후보 조합'], ['P2', 'Phase 2'], ['P3', 'Phase 3'], ['P4', 'Phase 4'], ['P5', 'Phase 5']]
    },
    {
      id: 'would_prescribe', label: '선생님이 이 환자를 직접 진료한다면, 선택하신 조합을 실제로 처방하시겠습니까?',
      type: 'choice', layout: 'list', required: true,
      options: ['그대로 처방하겠다', '일부 수정하여 처방하겠다', '후보 3개 중 처방할 조합이 없다']
    }
  ],

  // ------------------------------------------------------------
  // 마지막 화면 보조 문항 (세션당 1회)
  // ------------------------------------------------------------
  END_ITEMS: [
    {
      id: 'intent_use', label: '이와 같은 AI 권고안이 실제 외래 진료 중에 제공된다면, 진료에 활용할 의향이 있다.',
      type: 'choice', layout: 'list', required: true,
      options: ['1 · 전혀 그렇지 않다', '2 · 그렇지 않다', '3 · 보통이다', '4 · 그렇다', '5 · 매우 그렇다']
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
