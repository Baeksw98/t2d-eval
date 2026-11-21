/**
 * 임상 수용성 평가 — 사이트 설정
 * ------------------------------------------------------------
 * ENDPOINT: Google Apps Script 웹 앱 URL (…/exec). 비워 두면 "테스트 모드"로 동작하며
 *           응답은 서버로 전송되지 않고 기기에만 저장됩니다(완료 화면에서 JSON 다운로드 가능).
 *
 * 언어(KO/EN): 화면 문구는 i18n/ca.js 에 있습니다. 이 파일의 문항·선택지는
 *   · label, options, other … = 한국어 원문 = 응답에 저장되는 값(canonical). 화면 언어와 관계없이 항상 이 값과 code 가 저장됩니다.
 *   · en: { label, options, … } = 영어 화면에서만 보이는 번역 (같은 순서). 없으면 한국어를 그대로 보여 줍니다.
 *   한국어 값이 그대로 남아 있으므로 이전 버전 화면(app.js)이 이 파일을 읽어도 그대로 동작합니다.
 */
window.T2D_CONFIG = {
  ENDPOINT: 'https://script.google.com/macros/s/AKfycbxPxzjMttjnyGlgwY_8AYRCMcMGN1_LLGsgShtMg0ZTcSPE3d52m3f4WALNJMuH0S1KUg/exec',

  STUDY_ID: 'T2D-CA-2026',
  APP_VERSION: '2026-11-20.ca-v3.6',

  // 연구 메타데이터 (응답과 함께 저장 → 논문 방법 기술·버전별 분석용)
  INSTRUMENT_VERSION: 'Delphi-final P1–P5 (5-point agreement)',  // 주 평가 문항(Delphi 확정본) 버전
  CONSENT_VERSION: '2026-11-19-v3',  // 동의 문구를 바꾸면 올려 주세요 (v3: 수집 항목 '직군·연차/경력, AI 사용 빈도')
  IRB_NO: '',                        // IRB 승인번호를 넣으면 동의 문구에 표시됩니다 (예: 'XXXX-2026-0123')
  STUDY_WAVE: 'main',                // 'pilot' 이면 주 분석에서 자동 제외 (링크에 ?wave=pilot 으로도 지정 가능)
  INCENTIVE: '없음',                  // 참여 보상 (CHERRIES 보고 항목)

  // ------------------------------------------------------------
  // 평가자 직군 — 직군을 고르면 그 직군의 추가 항목(fields)이 나타납니다.
  //  · 인턴: 추가 항목 없음 / 레지던트: 연차만 / 전문의: 주 분야 + 전문의 경력 (v3.4, PI 결정)
  //  · 직군 추가: 항목 하나를 더 넣으면 됩니다 (예: { id: 'fellow', label: '전임의', en: { label: 'Fellow' }, fields: [...] }).
  //  · field type: 'choice'(버튼), 'select'(목록, groups 로 묶음 가능), 'text'(직접 입력)
  //  · select 의 other: 이 문구를 고르면 직접 입력칸이 나타납니다.
  //  · short: 오류 안내에 쓰는 짧은 이름 (예: 'AI 사용 빈도' → "AI 사용 빈도를 선택해 주세요."). 없으면 label 을 씁니다.
  //  · 응답 시트에는 EvaluatorRole / EvaluatorDetail 과 Eval_<field id> 컬럼으로 저장됩니다(백엔드가 자동으로 컬럼 추가).
  //  · 이미 쓰인 field id 의 선택지·의미를 바꾸지 마세요(기존 응답과 코드가 섞입니다). 바꿀 때는 새 id 를 씁니다.
  //    v3.3 까지 쓰던 id: major(레지던트 전공), t2d_volume, ai_use, ai_trust — 시트·요약에는 이전 응답으로 남아 있습니다.
  // ------------------------------------------------------------
  EVALUATOR_ROLES: [
    { id: 'intern', label: '인턴', en: { label: 'Intern' }, fields: [] },
    {
      id: 'resident', label: '레지던트', en: { label: 'Resident' },
      fields: [
        { id: 'year', label: '레지던트 연차', type: 'choice', options: ['R1', 'R2', 'R3'], required: true,
          en: { label: 'Residency year', short: 'Residency year' } }
      ]
    },
    {
      id: 'specialist', label: '전문의', en: { label: 'Specialist' },
      fields: [
        {
          id: 'specialty', label: '주 분야 (세부전문)', type: 'select', required: true,
          placeholder: '주 분야를 선택하세요',
          other: '기타 (직접 입력)',
          groups: [
            { label: '내과 세부전문', options: ['내분비대사내과', '순환기내과(심장)', '신장내과', '소화기내과', '호흡기내과', '감염내과', '혈액종양내과', '류마티스내과', '알레르기내과', '노년내과'],
              en: { label: 'Internal medicine subspecialties', options: ['Endocrinology and metabolism', 'Cardiology', 'Nephrology', 'Gastroenterology', 'Pulmonology', 'Infectious diseases', 'Hematology and oncology', 'Rheumatology', 'Allergy', 'Geriatrics'] } },
            { label: '그 외', options: ['일반내과 (세부전문 없음)', '가정의학과'],
              en: { label: 'Other', options: ['General internal medicine (no subspecialty)', 'Family medicine'] } }
          ],
          en: { label: 'Main field (subspecialty)', short: 'Main field', placeholder: 'Select your main field', other: 'Other (please specify)' }
        },
        { id: 'board_years', label: '전문의 취득 후 경력', type: 'choice', options: ['5년 미만', '5–9년', '10–19년', '20년 이상'], required: true,
          en: { label: 'Years since board certification', short: 'Years since board certification', options: ['< 5 years', '5–9 years', '10–19 years', '≥ 20 years'] } }
      ]
    }
  ],

  // ------------------------------------------------------------
  // 모든 직군 공통 배경 문항 (평가자 특성 표 Table 1 용) — v3.4 부터 AI 사용 빈도 1문항
  //  · ai_freq 는 v3.3 의 ai_use(5단계, 월 단위)와 척도가 달라 새 id 를 씁니다(코드를 섞지 않기 위해).
  //    GC(/gc/gc-config.js)의 같은 문항과 id·문구·선택지·코드(1–5)가 같아야 합니다.
  //  · firstSessionOnly: 다른 Type 을 이어서 평가할 때는 다시 묻지 않고 처음 응답을 그대로 사용
  //    (이전 세션에 이 응답이 없으면 — 예: v3.3 에서 시작한 평가자 — 이어서 평가할 때 묻습니다)
  //  · layout 'list': 선택지가 길어 세로로 표시
  // ------------------------------------------------------------
  COMMON_FIELDS: [
    {
      id: 'ai_freq', short: 'AI 사용 빈도',
      label: '진료·학습·연구에 생성형 AI(대화형 AI 챗봇 등)나 AI 진료 보조 도구를 얼마나 자주 사용하십니까?',
      type: 'choice', layout: 'list', required: true, firstSessionOnly: true,
      options: ['사용한 적 없음', '주 1회 미만', '주 1–2회', '주 3–6회', '거의 매일'],
      en: {
        short: 'AI use frequency',
        label: 'How often do you use generative AI (e.g., AI chatbots) or AI clinical support tools for patient care, learning or research?',
        options: ['Never', 'Less than once a week', '1–2 times a week', '3–6 times a week', 'Almost every day']
      }
    }
  ],

  // ------------------------------------------------------------
  // 케이스마다 묻는 보조 문항 — Phase 5 평가 뒤 '의견' 화면에 별도 카드로 표시 (Delphi 주 문항과 분리)
  // ------------------------------------------------------------
  CASE_ITEMS: [
    {
      id: 'harm', label: '이 AI 답변을 수정 없이 그대로 따른다면, 환자에게 위해가 될 수 있는 내용(잘못된 약물·용량, 금기 위반, 필요한 조치 누락 등)이 있었습니까?',
      type: 'choice', layout: 'list', required: true,
      options: ['없음', '경미한 위해 가능성', '중대한 위해 가능성'],
      en: {
        label: 'If this AI answer were followed without changes, did it contain anything that could harm the patient (e.g., a wrong drug or dose, a contraindication violated, a needed action missing)?',
        options: ['None', 'Possible minor harm', 'Possible serious harm']
      }
    },
    {
      id: 'harm_phases', label: '위해 가능성이 있었던 부분 (해당하는 것 모두, 선택)',
      type: 'multi', required: false, showIf: { item: 'harm', minCode: 2 },
      options: [['P1', 'Phase 1 의뢰'], ['COMBO', '후보 조합'], ['P2', 'Phase 2'], ['P3', 'Phase 3'], ['P4', 'Phase 4'], ['P5', 'Phase 5']],
      en: {
        label: 'Where was the potential harm? (all that apply, optional)',
        options: ['Phase 1 referral', 'Candidate regimens', 'Phase 2', 'Phase 3', 'Phase 4', 'Phase 5']
      }
    },
    {
      id: 'would_prescribe', label: '선생님이 이 환자를 직접 진료한다면, 선택하신 조합을 실제로 처방하시겠습니까?',
      type: 'choice', layout: 'list', required: true,
      options: ['그대로 처방하겠다', '일부 수정하여 처방하겠다', '후보 3개 중 처방할 조합이 없다'],
      en: {
        label: 'If you were treating this patient yourself, would you actually prescribe the regimen you chose?',
        options: ['Yes, as it is', 'Yes, with some changes', 'No — none of the 3 candidates']
      }
    }
  ],

  // ------------------------------------------------------------
  // 마지막 화면 보조 문항 (세션당 1회)
  // ------------------------------------------------------------
  END_ITEMS: [
    {
      id: 'intent_use', label: '이와 같은 AI 권고안이 실제 외래 진료 중에 제공된다면, 진료에 활용할 의향이 있다.',
      type: 'choice', layout: 'list', required: true,
      options: ['1 · 전혀 그렇지 않다', '2 · 그렇지 않다', '3 · 보통이다', '4 · 그렇다', '5 · 매우 그렇다'],
      en: {
        label: 'If AI recommendations like these were available during real outpatient visits, I would be willing to use them in my practice.',
        options: ['1 · Strongly disagree', '2 · Disagree', '3 · Neutral', '4 · Agree', '5 · Strongly agree']
      }
    }
  ],

  // ------------------------------------------------------------
  // 평가 유형 — 평가자는 Type 하나를 골라 AI 답변 2건을 평가합니다.
  //  · 활성 케이스 세트의 data/design.js(window.T2D_DESIGN.ca.types)가 있으면 그 Type 을 씁니다(tools/build_cases.py 가 생성).
  //    아래 STUDY_TYPES 는 그 파일이 없을 때 쓰는 기본값(세트 v1 = 현재 연구)입니다.
  //  · 각 Type 에 가상 환자 2명(P051, P011)과 AI 2종(DeepSeek, GPT)이 한 번씩 섞여 들어갑니다.
  //  · sequences: 같은 Type 안의 제시 순서. 서버가 응답이 들어온 세션 수가 가장 적은 순서부터 배정합니다
  //    (서버 미연결 시 무작위).
  //  · 평가자는 시작 화면에서 Type 을 직접 고릅니다 (QR 은 하나). ?type=A 처럼 링크로 미리 지정하는 것도 여전히 가능합니다.
  // ------------------------------------------------------------
  STUDY_TYPES: [
    { id: 'A', label: 'Type A', sequences: [['P051_deepseek', 'P011_gpt'], ['P011_gpt', 'P051_deepseek']] },
    { id: 'B', label: 'Type B', sequences: [['P011_deepseek', 'P051_gpt'], ['P051_gpt', 'P011_deepseek']] }
  ],

  // 예상 소요 시간 안내 (Type 1개 = AI 답변 2건) — [최소, 최대] 분. data/design.js 의 ca.minutes 가 있으면 그 값을 씁니다.
  // (ESTIMATED_MINUTES 문자열은 이전 버전 화면 호환용으로 남겨 둡니다.)
  ESTIMATED_MINUTES_RANGE: [20, 30],
  ESTIMATED_MINUTES: '20–30분'
};
