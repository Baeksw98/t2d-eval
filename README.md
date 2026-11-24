# eval.asclep.org — Hybrid Physician–AI Benchmark 평가 사이트

## 0. 사이트 구성 (주소)

| 주소 | 내용 | 원본 |
|---|---|---|
| `https://eval.asclep.org/` | **처음 화면**: 무엇을 하는 사이트인지 + 두 평가 중 선택. 이 브라우저에 끝나지 않은 평가가 있으면 '이어서 하기' 안내(CA 는 「이어서 하기」·「처음부터 다시」 두 버튼). 「임상 수용성 평가」 카드는 누를 때마다 처음부터 시작(`ca/?restart=1`) | `index.html` |
| `https://eval.asclep.org/ca/` | **임상 수용성 평가 (CA)** — 인턴·레지던트·전문의 (아래 1–6절) | `ca/index.html` + 루트 `app.js`·`config.js`·`styles.css`·`data/cases.js` |
| `https://eval.asclep.org/gc/` | **가이드라인 부합도 검증 (GC)** — 내분비대사내과 분과전문의 (7절) | `gc/*` |
| `https://eval.asclep.org/about/` | 벤치마크 소개 (About) | `about/*` |
| `https://eval.asclep.org/qr/` | 참여 안내 QR 모음 (통합·CA·GC) — 8절 | `qr/*` |

예전 주소도 그대로 동작합니다.
- 루트에 CA 를 가리키는 값이 있으면 바로 `/ca/` 로 보냅니다(쿼리·해시 유지): `?type=` · `?reset=1` · `?test=1` (트랙 지정 없이), `?track=ca`. `?track=gc` → `/gc/`.
- `/a/`, `/b/` → `/ca/?type=A|B` (다른 쿼리·해시 유지).
- 이미 인쇄·배포된 CA QR(`https://eval.asclep.org/?src=qr`, `qr/select.*`)은 이제 처음 화면을 엽니다. 처음 화면은 `src`·`site`·`wave` 를 각 평가 링크에 넘기므로 접속 경로 기록은 유지됩니다.
- CA 를 루트에서 `/ca/` 로 옮겼지만 저장 키(`t2d-ca:T2D-CA-2026:v3`, `t2d-ca:device`)·응답 형식·`config.js` 는 그대로입니다. 루트에서 평가하던 분이 `/ca/` 를 열면(같은 기기·브라우저) 그 자리에서 이어집니다.
- CA·GC 의 **시작 화면에만** 작은 링크 「처음 화면 · 벤치마크 소개」가 있습니다(케이스·판정 중에는 없음. CA 의 '다른 Type 이어서 평가' 시작 화면에도 없음 — 떠나면 이어서 평가 연결이 끊기므로).

---

# 임상 수용성 평가 (Physician Clinical Acceptability Assessment)

AI 기반 제2형 당뇨병(T2D) CDSS 답변을 레지던트가 읽고, Phase별로 **"임상 결정에 유의미한 참고가 되는지"**를 5점 척도로 평가하는 웹 설문입니다. 모바일·데스크톱 모두 지원합니다.

- 평가 대상: 가상 환자 2명(P051, P011) × AI 2종(DeepSeek-V4.1-Flash, GPT-6.1 Sol) = AI 답변 4건을 **Type A / Type B 로 2건씩** 나눔
  - Type A: P051·DeepSeek + P011·GPT / Type B: P011·DeepSeek + P051·GPT (각 Type 에 두 환자·두 모델이 한 번씩)
  - 평가자가 시작 화면에서 Type 을 고름 (링크에 `?type=A` / `?type=B` 를 붙이면 미리 선택). 완료 후 같은 정보로 다른 Type 이어서 평가 가능
- 평가자 정보 (v3.4): 성명 + 직군 + 모든 직군 공통 **AI 사용 빈도** 1문항. 인턴은 추가 항목 없이 바로 시작합니다.

  | 직군 | 직군별 항목 | 공통 문항 |
  |---|---|---|
  | 인턴 | 없음 | AI 사용 빈도 (`ai_freq`): 사용한 적 없음 / 주 1회 미만 / 주 1–2회 / 주 3–6회 / 거의 매일 (코드 1–5) |
  | 레지던트 | 연차 (R1–R3) | 〃 |
  | 전문의 | 주 분야(세부전문), 전문의 취득 후 경력 | 〃 |

  - 직군·항목은 `config.js` 의 `EVALUATOR_ROLES` / `COMMON_FIELDS` 에서 수정합니다. 이미 응답이 쌓인 문항 id 의 선택지는 바꾸지 말고 새 id 를 쓰세요(코드가 섞임).
  - AI 사용 빈도는 첫 평가 때만 묻고, 다른 Type 을 이어서 평가할 때는 그 응답을 그대로 씁니다(이전 세션에 응답이 없으면 그때 묻습니다).
  - 동의 문구의 수집 항목도 "성명, 직군·연차/경력, AI 사용 빈도, …"로 맞췄습니다(`CONSENT_VERSION` `2026-11-19-v3`; 응답 시트 `ConsentVersion` 으로 구분).
  - v3.3 까지 묻던 진료량(`t2d_volume`)·AI 도구 사용 빈도(`ai_use`, 월 단위)·AI 신뢰(`ai_trust`)·레지던트 전공(`major`)은 v3.4 에서 뺐습니다. 이미 받은 응답은 시트에 그대로 있고, Summary 에는 응답한 평가자가 있을 때만 "(v3.3 이전 문항)"으로 표시됩니다. `ai_use` 와 `ai_freq` 는 척도가 달라 합치지 않습니다.
- 블라인드: 평가자에게 모델명을 보여주지 않음
- 제시 순서: Type 안에서 두 순서를 서버가 균형 배정 (응답이 들어온 세션 수가 적은 순서부터)
- 케이스 흐름: 환자 정보 → Phase 1 평가 → 선호 조합 1개 선택 → (선택 조합 기준) Phase 2·3·4·5 평가 → 자유 의견(선택)
- 마지막: 전체 의견(선택) → 제출
- 문항 문구: 논문 Delphi 확정 문구 ("…에 유의미한 참고가 된다"), 1 전혀 그렇지 않다 ~ 5 매우 그렇다

---

## 1. 폴더 구성

| 경로 | 내용 |
|---|---|
| `index.html`, `about/index.html`, `site.css`, `assets/` | 처음 화면(`/`)·벤치마크 소개(`/about/`). `site.css` 는 이 두 쪽 전용(styles.css 토큰 복사 + 다크 모드), `assets/site.js` 는 `src·site·wave` 전달·'이어서 하기' 안내·목차 강조, `assets/icons.svg` 아이콘, `assets/og.png` 링크 미리보기 이미지(1200×630, `node tools/render_og.js` 로 `tools/og_image.html` 에서 생성) |
| `qr/` | 참여 안내 QR 모음(8절) |
| `ca/index.html`, `styles.css`, `app.js` | CA 평가 화면 (`/ca/`; 빌드 불필요한 정적 파일). `styles.css` 는 GC 도 같이 씀 |
| `config.js` | **서버 주소(ENDPOINT)**, 문항·선택지, 기본 Type(세트 v1 — `data/design.js` 가 있으면 그 Type) |
| `cases/` | **케이스·모델·세트 원본** (CDSS 출력 문서, 채점·감사 검증 보고서, `models.json`, `sets/<id>.json`, `active.json`) — [`cases/README.md`](cases/README.md) |
| `data/cases.js`, `data/design.js`, `data/sets/` | 활성 세트의 환자 정보 + AI 답변, Type/Part 구성, 세트별 보관본 (`tools/build_cases.py` 가 자동 생성 — 손으로 고치지 않음) |
| `gas/Code.gs` | 응답 저장용 Google Apps Script (Google Sheets) |
| `tools/` | 케이스 파이프라인(`build_cases.py`, `cases_lib/`), 로컬 테스트 서버, 자동 E2E 테스트 |

---

## 2. 배포 순서 (총 약 20분)

### 2-1. 응답 저장소: Google Sheets + Apps Script

1. Google Drive에서 새 스프레드시트 생성 (예: `T2D 임상 수용성 평가 응답`)
2. 메뉴 **확장 프로그램 → Apps Script** 를 열고, 기본 `Code.gs` 내용을 지운 뒤 `gas/Code.gs` 전체를 붙여넣고 저장
3. 위쪽 함수 선택에서 **`setup`** 을 고르고 **실행** → 권한 승인 (시트 4개가 생성됨)
4. **배포 → 새 배포** → 톱니바퀴에서 **웹 앱** 선택
   - 실행 사용자: **나**
   - 액세스 권한이 있는 사용자: **모든 사용자**
5. **배포** 후 표시되는 웹 앱 URL(`https://script.google.com/macros/s/…/exec`)을 복사
6. 브라우저에서 그 URL을 열어 `{"ok":true,…}` 가 보이면 정상
7. `config.js` 의 `ENDPOINT: ''` 따옴표 안에 URL을 붙여넣기

> 코드를 수정한 뒤에는 **배포 → 배포 관리 → 편집(연필) → 버전: 새 버전 → 배포** 로 갱신해야 같은 URL에 반영됩니다.
> 액세스 권한은 반드시 **모든 사용자(Anyone)** 여야 합니다. "Google 계정이 있는 모든 사용자"나 "asclep.org 내 사용자"로 두면 평가자 브라우저가 Google 로그인으로 막혀 응답이 저장되지 않습니다.
> 이 옵션이 보이지 않으면 Google Workspace 관리 콘솔에서 Drive 외부 공유가 막혀 있는 경우입니다(관리자에게 외부 공유 허용 요청 또는 개인 Gmail 계정으로 시트·스크립트 생성).

### 2-2. 사이트 호스팅: GitHub Pages

1. GitHub에 저장소 생성 (예: `t2d-eval`). 무료 요금제에서 Pages를 쓰려면 **Public** 이어야 합니다.
   (사이트에는 `noindex` 와 `robots.txt` 가 설정되어 검색엔진에 노출되지 않습니다.)
2. 이 폴더의 파일을 저장소에 올리기 (Claude 세션에 GitHub를 연결하면 대신 푸시해 드립니다)
3. 저장소 **Settings → Pages → Build and deployment**: Source = *Deploy from a branch*, Branch = `main` / `/ (root)` → Save
4. 1–2분 뒤 `https://<계정명>.github.io/t2d-eval/` 에서 접속 확인

### 2-3. 도메인 연결: `eval.asclep.org` (Cloudflare)

asclep.org 의 DNS는 **Cloudflare**에서 관리됩니다 (네임서버 `leonard/yolanda.ns.cloudflare.com`).

1. https://dash.cloudflare.com 로그인 → 도메인 목록에서 **asclep.org** 선택
2. 왼쪽 메뉴 **DNS → Records** → **Add record**
3. 아래처럼 입력 후 **Save**

   | 항목 | 값 |
   |---|---|
   | Type | `CNAME` |
   | Name | `eval` |
   | Target | `<GitHub 계정 또는 조직명>.github.io` |
   | Proxy status | **DNS only (회색 구름)** ← 주황색이면 GitHub이 HTTPS 인증서를 발급하지 못합니다 |
   | TTL | Auto |

4. GitHub 저장소 **Settings → Pages → Custom domain** 에 `eval.asclep.org` 가 들어가 있는지 확인 (저장소의 `CNAME` 파일로 자동 설정됨) → DNS check 통과 후 **Enforce HTTPS** 체크
5. 최종 주소: `https://eval.asclep.org`

> 하위 도메인을 바꾸려면 Cloudflare 레코드 이름, 저장소의 `CNAME` 파일, Pages의 Custom domain 세 곳을 같은 값으로 맞추면 됩니다.

---

## 3. 운영 방법

| 용도 | 주소 |
|---|---|
| 실제 평가 | `https://eval.asclep.org/ca/` (처음 화면 `https://eval.asclep.org/` 에서 골라도 됨) |
| Type A 로 바로 안내 | `https://eval.asclep.org/ca/?type=A` (예전 `/?type=A`, `/a/` 도 동작) |
| Type B 로 바로 안내 | `https://eval.asclep.org/ca/?type=B` (예전 `/?type=B`, `/b/` 도 동작) |
| 시험 응답 (분석에서 자동 제외) | `https://eval.asclep.org/ca/?test=1` |
| 기기에 저장된 진행 상황 초기화 (시험용) | `…/ca/?reset=1` |
| 끝나지 않은 평가를 지우고 처음부터 (처음 화면의 CA 카드·「처음부터 다시」가 붙임) | `…/ca/?restart=1` — 끝난 평가(완료 화면)는 그대로 두고, 미전송 응답은 따로 옮겨 마저 보냄 |

- 평가자가 창을 닫아도 **같은 기기·브라우저**에 저장됩니다. 처음 화면에서 **「이어서 하기」**(같은 세션 계속) 또는 **「처음부터 다시」**를 고를 수 있고, **「임상 수용성 평가」 카드를 누르면 언제나 처음부터** 시작합니다(진행 중이던 응답은 이 기기에서 지움, 서버에 이미 저장된 완료 케이스는 남음). `/ca/` 를 직접 열거나 새로고침하면 지금처럼 이어서 진행됩니다.
- 케이스 하나를 마칠 때마다 서버에 저장되므로 중도 이탈해도 완료한 케이스는 남습니다.
- 전송 실패 시 기기에 보관했다가 자동 재전송하며, 완료 화면에서 **다시 전송 / 응답 파일 내려받기**가 가능합니다.
- 한 기기로 여러 명이 평가할 때는 완료 화면의 **새 평가 시작**을 누르면 됩니다.
- 같은 평가를 두 탭(창)에서 열면 마지막에 연 탭만 진행되고 다른 탭은 자동으로 멈춥니다(응답 섞임 방지).
- 모든 문자열은 시트에 텍스트로 저장됩니다(수식 실행·날짜 자동변환 방지).

---

## 4. 수집 데이터 (Google Sheets)

| 시트 | 1행 단위 | 주요 컬럼 |
|---|---|---|
| **Responses** | 평가자 × AI 답변(케이스) | 성명, 직군(`EvaluatorRole`), 직군 상세(`EvaluatorDetail`, 예: 레지던트 · R2 / 전문의 · 내분비대사내과), `Eval_year`·`Eval_specialty`·`Eval_board_years`, AI 사용 빈도 `Eval_ai_freq`(+`_code` 1–5), `StudyType`(A/B), 제시 순서, 환자, 모델, `P1_Referral`, `ComboChoice`(1–3), `ComboIsAIFirst`, `P2`–`P5` 점수, 케이스 의견, 단계별 소요 시간(초), 첫 응답까지 시간(TTFR), 점수 변경 횟수, 스크롤 도달률(%), 단계 재방문 수, 환자 정보 열람 횟수·시간 |
| **PhaseLong** | 평가자 × 케이스 × Phase | 점수, 4점 이상 여부(`Acceptable_4plus`), 체류 시간(`VisibleSec`, `ActiveOnlySec`), 첫 응답까지 시간, 변경 횟수 — CVI·혼합모형 분석용 long format |
| **Sessions** | 평가 세션 1건 (Type 1개) | 직군·Type, 이어서 평가한 경우 이전 세션(`LinkedSessionId`), 상태(started/in_progress/completed), 시작·종료 시각, **총 평가 시간(분)**, 비활성(idle)·백그라운드(hidden) 시간, 재접속 횟수, 전체 의견, 기기 종류·화면 크기·브라우저 |
| **RawJSON** | 수신 요청 1건 | 원문 JSON, 서버 처리 시간(ms), 오류 메시지 (감사 추적용) |
| **Summary** | — | 메뉴 **📊 임상 수용성 평가 → 요약 통계 갱신** 실행 시 생성 |

**시간 정의**
- *active*: 화면이 보이고 3분 이내에 조작(스크롤·터치·입력)이 있었던 시간
- *idle*: 화면은 보이지만 3분 넘게 조작이 없던 시간
- *hidden*: 다른 앱/탭으로 전환되어 화면이 가려진 시간
- 시트의 단계별 `Sec_*`, PhaseLong `VisibleSec`, Summary 소요 시간 = active + idle (hidden 제외)
- active만 필요하면 `CaseActiveSec`, PhaseLong `ActiveOnlySec`, Summary 마지막 열을 사용
- 선호 조합을 바꾸면 Phase 2–5 점수가 초기화되고, 첫 응답 시간·변경 횟수도 새 조합 기준으로 다시 셉니다(이전 값은 `MetricsJson` 에 보존)
- 제시 순서는 연속된 두 케이스의 환자가 항상 다르며, 2→3번째에서만 같은 모델이 연속됩니다(2×2 설계상 불가피). 분석 시 `CaseOrder` 를 공변량으로 고려하세요

**Summary 내용**
1. 모델 × Phase: n, 평균, SD, 중앙값, 1–5점 분포, **I-CVI(4점 이상 비율)**, 모델별 **S-CVI/Ave**
2. 답변별 선호 조합 분포와 **AI 1순위 조합 선택률**
3. 모델별 케이스 소요 시간(중앙값·평균)과 단계별 평균 체류 시간
4. 평가자 구성 (직군 · 세부 · Type 별 인원)
5. 직군별 Phase I-CVI

(실제 Summary 는 [0]–[15] 절로 구성됩니다 — `gas/src/summary.gs` 머리말 참고. 평가자 특성 표 [2] 와 하위군 [7] 의 AI 친숙도 변수는 `ai_freq` 입니다.)

**v3.5 (`2026-11-20.ca-v3.5`: CA 를 `/ca/` 로 이동, 시작 화면에 처음 화면·벤치마크 소개 링크)**
- 사이트만 바뀌었습니다. 응답 형식·저장 키·문항은 v3.4 와 같고, 새로 시작한 세션의 `AppVersion` 만 `2026-11-20.ca-v3.5` 입니다(진행 중이던 세션은 시작할 때의 버전을 그대로 보냄).
- **Apps Script 재배포 불필요** (CA·GC 모두).

**v3.4 (평가자 정보 간소화) 반영 시 재배포 여부**
- 사이트: `config.js`·`app.js`·`index.html`(지금은 `ca/index.html`)·`styles.css` 를 GitHub Pages 에 올리면 끝입니다. 이전 버전에서 평가를 진행 중이던 분은 새로고침해도 그대로 이어서 진행·저장됩니다(그 세션은 이전 문항 응답을 계속 보냄).
- CA Apps Script: **응답 수집에는 재배포가 필요 없습니다.** 현재 배포된 백엔드가 `Eval_ai_freq`·`Eval_ai_freq_code` 컬럼을 자동으로 추가합니다.
  Summary·AnalysisLong·Codebook 에 AI 사용 빈도를 반영하려면 `gas/Code.gs` 전체를 Apps Script 에 붙여넣고 **저장**하세요(10분 요약 트리거와 메뉴는 저장된 코드로 실행됨). 응답 수집 코드(core)는 바뀌지 않았으므로 웹 앱 새 버전 배포는 선택 사항입니다.
  붙여넣지 않으면 Summary 는 계속 이전 형식으로 만들어지며(오류 없음), v3.4 평가자는 이전 문항 행에 "(미응답)"으로 잡히고 AI 사용 빈도는 표에 나오지 않습니다(시트 원자료에는 저장됨).

---

### 응답 시각과 전체 삭제
- 시각 컬럼(이름이 `…At`)은 한국 시간 기준 `yyyy-mm-dd hh:mm:ss`(초 단위)로 표시됩니다. 값에는 밀리초까지 들어 있습니다.
- 응답을 처음부터 다시 받으려면 Apps Script 편집기에서 함수 `resetAllResponses`(GC 는 `resetAllGcResponses`)를 실행합니다.
  실행하면 먼저 스프레드시트 전체를 `(백업 날짜 시각)` 사본으로 내 드라이브에 저장한 뒤, 응답 시트를 헤더만 남기고 비우고,
  평가자 가명 코드(E001…)와 순서 배정 카운터를 처음으로 되돌립니다. 백업 링크는 실행 로그에 나옵니다.

## 5. 케이스·모델·세트를 추가하거나 바꿀 때 (살아 있는 벤치마크)

원본은 모두 `cases/` 에 있고, 사이트 자료는 `tools/build_cases.py` 가 만듭니다. 자세한 단계는 **[`cases/README.md`](cases/README.md)** 를 보세요.

```bash
# 1) cases/sources/ca/ · cases/sources/gc/ 에 원본을 넣고, 새 모델이면 cases/models.json, 새 세트면 cases/sets/v2.json 작성
python3 tools/build_cases.py --set v2 --check   # 2) 검증 + Type/Part·예상 시간 미리 보기 (파일을 쓰지 않음)
python3 tools/build_cases.py                    # 3) 모든 세트의 보관본 작성 (활성 세트는 그대로) + gas/*.gs 다시 생성
# 4) 평가자에게 배정할 때: cases/active.json → {"set": "v2"} → python3 tools/build_cases.py → 테스트 → push
python3 tools/test_cases.py                     # 파이프라인 테스트 (v1 재현, 3×3 합성 세트, 검증 오류)
```

- 세트 v1(현재 연구)은 동결되어 있습니다. 새 케이스는 새 세트로 추가합니다.
- 케이스·모델·세트만 바꾸는 경우 **Apps Script 를 다시 붙여넣지 않습니다.** CA 백엔드는 모델을 자료에서 읽고, GC 백엔드는 세트 자료를 사이트에서 읽습니다.
- 진행 중인 평가자는 시작한 세트로 끝까지 진행합니다(`data/sets/<id>/` 보관본). 보관본은 지우지 마세요.

### 이번 단계의 백엔드 배포 (한 번만)
- **CA** `gas/Code.gs` → `2026-11-21.ca-backend-v6`: `UiLang`·`SetId` 등 열 추가(오른쪽 끝), 모델 자동 인식, 세트별 순서 배정, 세트별 요약.
  CA 응답 시트의 [확장 프로그램 → Apps Script]에 전체 붙여넣기 → 저장 → [배포 관리] → ✏️ → 새 버전 → 배포 (웹 앱 URL 유지).
  배포 전에도 사이트는 그대로 동작합니다(이전 백엔드는 새 필드를 무시하고 RawJSON 에만 남김).
- **GC** `gas/GcCode.gs` → `2026-11-21.gc-backend-v4`: 붙여넣기 → 저장 → `setup` 실행 → 새 권한 **「외부 서비스에 연결」** 허용 → 새 버전 배포.
  실행 로그에 `✅ 사이트 케이스 세트 자료 읽기 확인` 이 보이면 됩니다.
- 요약 분석 세트: CA 요약은 기본으로 완료 케이스가 가장 많은 세트를 분석합니다. Apps Script → 프로젝트 설정 → 스크립트 속성에서 `SUMMARY_SET` 을 세트 ID 또는 `all` 로 정할 수 있습니다.

---

## 6. 로컬 테스트

```bash
node tools/mock_gas_server.js 8787        # gas/Code.gs 를 그대로 실행하는 모의 서버 + 사이트 (/ca → /ca/ 처럼 GitHub Pages 와 같이 동작)
# 브라우저: http://localhost:8787/ (처음 화면) · http://localhost:8787/ca/ (CA) · http://localhost:8787/gc/ (GC) · http://localhost:8787/qr/ (QR)
node tools/e2e.js http://localhost:8787/ ./shots mobile 테스트평가자 all   # 사이트 루트를 주면 /ca/ 를 엽니다. 인턴·레지던트·전문의 경로를 각각 완주 + 화면 캡처 (desktop 도 가능)
node tools/test_summary.js                                # Summary·AnalysisLong·Codebook 단위 테스트 (v3.3·v3.4 응답 혼합, 세트·언어·이전 백엔드 호환)
python3 tools/test_cases.py                               # 케이스 파이프라인 테스트
node tools/test_site.js http://localhost:8787            # 처음 화면: 예전 주소 → /ca/·/gc/ 이동, '이어서 하기' 안내, src·site·wave 전달
node tools/e2e_restart.js http://localhost:8787          # CA 이어서 하기 / 처음부터 다시 / 카드 = 처음부터 (미전송 응답 보존, 완료 세션 유지)
curl http://localhost:8787/__sheets                       # 저장된 시트 내용 확인
```

---

## 7. 가이드라인 부합도 검증 (GC, `/gc/`) — 별도 평가 절차

임상 수용성 평가(CA)와 **별개의 Apps Script 프로젝트·웹 앱 URL·Google 스프레드시트**를 씁니다. CA 의 스크립트·시트·`config.js` 는 건드리지 않습니다(재배포 불필요).
데이터 계약: [`docs/GC_CONTRACT.md`](docs/GC_CONTRACT.md).

| 경로 | 내용 |
|---|---|
| `gc/` | GC 사이트 (`gc/gc-config.js` 의 `ENDPOINT` = GC 웹 앱 URL, 비어 있으면 테스트 모드) |
| `gas/gc/*.gs` | GC 백엔드 원본 → `python3 tools/build_gas.py` 가 **`gas/GcCode.gs`** 로 합침 (붙여넣을 파일) |
| `qr/gc/` | GC 참여 QR·초대 문구 페이지 (QR 은 8절) |

**GC 응답 시트 만들기 (iPad 가능, 약 5분)** — 자세한 순서는 `gas/GcCode.gs` 맨 위 주석에도 있습니다.
0. 붙여넣을 코드 복사: GitHub 의 [`gas/GcCode.gs`](https://github.com/Baeksw98/t2d-eval/blob/main/gas/GcCode.gs) 화면에서 코드 위 오른쪽 **복사 아이콘(「Copy raw file」)** → 파일 전체가 복사됩니다.
   컴퓨터라면 [raw 파일](https://raw.githubusercontent.com/Baeksw98/t2d-eval/main/gas/GcCode.gs)을 열고 전체 선택(⌘A / Ctrl+A) → 복사해도 됩니다.
   (이 링크는 `gas/GcCode.gs` 가 GitHub 에 올라가 있어야 열립니다. 약 2,200줄이라 손으로 옮길 수는 없습니다.)
1. [script.google.com](https://script.google.com) → **새 프로젝트** → 기본 코드를 지우고 복사한 `GcCode.gs` 전체를 붙여넣고 저장
   - 임상 수용성 평가(CA) 응답 시트의 [확장 프로그램 → Apps Script]에서 만들거나, CA 시트 ID 를 `GC_SPREADSHEET_ID` 에 넣지 마세요(두 평가의 `Visits` 가 섞입니다). 그렇게 하면 setup 이 오류로 멈춥니다.
2. 함수 선택에서 **`setup`** → **실행** → 권한 승인 (확인되지 않은 앱 경고가 나오면 고급 → 이동 → 허용. 권한 항목마다 체크박스가 보이면 **「모두 선택」** 후 **[계속]**)
3. 아래 **실행 로그**의 마지막 줄이 `✅ GC 응답 시트 준비 완료 — <링크>` 인지 확인합니다 (`⚠️` 로 끝나면 setup 을 한 번 더 실행). 그 링크가 새로 만들어진 스프레드시트 `가이드라인 부합도 검증 (GC) 응답` 입니다 (Visits·GC_Sessions·GC_Judgments·GC_Raw, 10분 요약 트리거 포함)
4. **배포 → 새 배포 → 웹 앱** (실행 사용자: **나**, 액세스 권한: **모든 사용자**) → 웹 앱 URL 복사
5. 그 URL 을 `gc/gc-config.js` 의 `ENDPOINT: ''` 따옴표 안에 넣고 사이트에 반영

요약(`GC_Adjudication`, `GC_Concordance`, `GC_Summary`, `GC_Codebook`)은 10분마다 자동 갱신되며, 바로 보려면 함수 `buildGcSummary` 실행.
CA Summary [14] 에 연결하려면 `GC_Concordance` 의 `TargetKey`·`ConcordanceScore` 두 열을 CA 스프레드시트의 `Concordance` 시트에 붙여 넣습니다(`SetId` 열까지 붙여 넣으면 CA 요약이 분석 세트의 행만 씁니다).
판정 문항·Part 는 케이스 세트마다 사이트의 `gc/data/sets/<세트>.json` 에서 읽으므로(10분 캐시, 실패하면 내장 사본) 케이스를 바꿔도 다시 붙여넣지 않습니다.

```bash
python3 tools/build_gas.py                 # gas/Code.gs (CA) + gas/GcCode.gs (GC) 둘 다 생성
node tools/test_gc.js                      # GC 백엔드 단위 테스트 (+ CA test_summary.js)
node tools/mock_gas_server.js 8791         # CA 웹 앱 /exec, GC 웹 앱 /gc-exec (각자 별도 시트)
node tools/e2e_gc.js http://localhost:8791 ./shots-gc      # GC 사이트 자동 완주 + 시트·요약 검증
curl 'http://localhost:8791/__sheets?app=gc'               # GC 시트 내용
```

---

## 8. QR 코드 · 참여 안내

QR 허브 **`https://eval.asclep.org/qr/`** 에 QR 3종이 카드로 나란히 있습니다(통합 → CA → GC 순). 카드마다 크게 띄우기(발표 화면), 링크 복사, 안내 문구 복사,
QR 이미지 보내기(휴대폰 공유 → 카카오톡), PNG 저장, A4 PDF, 「안내 문구·설정」(트랙별 페이지)이 있습니다. 기관·세션 코드(`site`)를 넣으면 세 QR·링크에 모두 들어갑니다.

| QR | 주소 (QR 내용) | 대상 | 파일 | 공유 페이지 |
|---|---|---|---|---|
| **통합 (권장)** | `https://eval.asclep.org/?src=qr` — 처음 화면에서 두 평가 중 선택 | 대상이 섞인 자리 | `qr/main.png` · `main.svg` · `main-card.png` · `main-poster-a4.pdf` | `qr/main/` |
| 임상 수용성 평가 | `https://eval.asclep.org/ca/?src=qr` | 인턴·레지던트·전문의 | `qr/ca.png` · `ca.svg` · `ca-card.png` · `ca-poster-a4.pdf` | `qr/ca/` (Type 지정 가능) |
| 가이드라인 부합도 검증 | `https://eval.asclep.org/gc/?src=qr` | 내분비대사내과 분과전문의 | `qr/gc.png` · `gc.svg` · `gc-card.png` · `gc-poster-a4.pdf` | `qr/gc/` (Part 지정 가능) |
| (예전 CA QR, 인쇄됨) | `https://eval.asclep.org/?src=qr` = 통합과 같은 주소 | — | `qr/select.png` · `select.svg` · `select-card.png` · `poster-a4.pdf` (그대로 둠) | — |

- 공용 코드: `qr/qr.js`(주소·QR 즉석 생성·공유·발표 화면) + `qr/qr.css`. 화면·안내 문구(한국어·영어)는 `i18n/qr.js` 에 있으며, 문구를 바꾸면 이 파일만 고치면 됩니다.
- 링크로 공유하면 `src=kakao`(문구·공유) / `src=link`(복사), QR 은 `src=qr` 로 접속 경로가 기록됩니다.
- 예전 인쇄용 주소 `qr/?mode=card|poster` 는 `qr/main/` 으로 넘어갑니다.

다시 만들기 (문구·주소를 바꿨을 때):

```bash
python3 tools/make_qr.py                                 # qr/{main,ca,gc,select}.{png,svg} (select 는 예전과 같은 파일이 나옴)
node tools/mock_gas_server.js 8787                       # (다른 터미널) 로컬 서버
node tools/render_qr_assets.js http://localhost:8787     # qr/{main,ca,gc}-card.png, qr/{main,ca,gc}-poster-a4.pdf
```

QR 내용 확인: PNG 를 아무 QR 리더(휴대폰 카메라 등)로 읽어 위 표의 주소가 나오는지 봅니다. `make_qr.py` 는 만든 주소를 출력합니다.

