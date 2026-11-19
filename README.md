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
| `index.html`, `styles.css`, `app.js` | 사이트 본체 (빌드 불필요한 정적 파일) |
| `config.js` | **서버 주소(ENDPOINT)**, 제시 순서, 년차 선택지 |
| `data/cases.js` | 환자 정보 + AI 답변 4건 (원문에서 자동 생성) |
| `gas/Code.gs` | 응답 저장용 Google Apps Script (Google Sheets) |
| `tools/` | 원문 → 데이터 변환, 로컬 테스트 서버, 자동 E2E 테스트 |

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
| 실제 평가 | `https://eval.asclep.org/` |
| Type A 로 바로 안내 | `https://eval.asclep.org/?type=A` |
| Type B 로 바로 안내 | `https://eval.asclep.org/?type=B` |
| 시험 응답 (분석에서 자동 제외) | `https://eval.asclep.org/?test=1` |
| 기기에 저장된 진행 상황 초기화 | `…/?reset=1` |

- 평가자가 창을 닫아도 **같은 기기·브라우저**에서 다시 열면 이어서 진행됩니다.
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

**v3.4 (평가자 정보 간소화) 반영 시 재배포 여부**
- 사이트: `config.js`·`app.js`·`index.html`·`styles.css` 를 GitHub Pages 에 올리면 끝입니다. 이전 버전에서 평가를 진행 중이던 분은 새로고침해도 그대로 이어서 진행·저장됩니다(그 세션은 이전 문항 응답을 계속 보냄).
- CA Apps Script: **응답 수집에는 재배포가 필요 없습니다.** 현재 배포된 백엔드가 `Eval_ai_freq`·`Eval_ai_freq_code` 컬럼을 자동으로 추가합니다.
  Summary·AnalysisLong·Codebook 에 AI 사용 빈도를 반영하려면 `gas/Code.gs` 전체를 Apps Script 에 붙여넣고 **저장**하세요(10분 요약 트리거와 메뉴는 저장된 코드로 실행됨). 응답 수집 코드(core)는 바뀌지 않았으므로 웹 앱 새 버전 배포는 선택 사항입니다.
  붙여넣지 않으면 Summary 는 계속 이전 형식으로 만들어지며(오류 없음), v3.4 평가자는 이전 문항 행에 "(미응답)"으로 잡히고 AI 사용 빈도는 표에 나오지 않습니다(시트 원자료에는 저장됨).

---

## 5. AI 답변·환자 자료를 바꿀 때

원문 마크다운(현재 형식: `# P051 Deepseek V4.1 Flash` / `GPT6.1 Sol P051` 블록 + `P051 Patient Input Information`)을 준비한 뒤:

```bash
python3 tools/parse_md.py <원문.md> data/parsed_raw.json
python3 tools/build_data.py data/parsed_raw.json data/cases.js
```

모델·환자가 바뀌면 `tools/build_data.py` 의 `MODEL_NAMES` 와 `config.js` 의 `SEQUENCES` 도 함께 수정합니다.

---

## 6. 로컬 테스트

```bash
node tools/mock_gas_server.js 8787        # gas/Code.gs 를 그대로 실행하는 모의 서버 + 사이트
# 브라우저: http://localhost:8787/
node tools/e2e.js http://localhost:8787/ ./shots mobile 테스트평가자 all   # 인턴·레지던트·전문의 경로를 각각 완주 + 화면 캡처 (desktop 도 가능)
node tools/test_summary.js                                # Summary·AnalysisLong·Codebook 단위 테스트 (v3.3·v3.4 응답 혼합)
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
| `qr/gc/` | GC 참여 QR·초대 문구 페이지 |

**GC 응답 시트 만들기 (iPad 가능, 약 5분)** — 자세한 순서는 `gas/GcCode.gs` 맨 위 주석에도 있습니다.
0. 붙여넣을 코드 복사: GitHub 의 [`gas/GcCode.gs`](https://github.com/Baeksw98/t2d-eval/blob/main/gas/GcCode.gs) 화면에서 코드 위 오른쪽 **복사 아이콘(「Copy raw file」)** → 파일 전체가 복사됩니다.
   컴퓨터라면 [raw 파일](https://raw.githubusercontent.com/Baeksw98/t2d-eval/main/gas/GcCode.gs)을 열고 전체 선택(⌘A / Ctrl+A) → 복사해도 됩니다.
   (이 링크는 `gas/GcCode.gs` 가 GitHub 에 올라가 있어야 열립니다. 약 1,850줄이라 손으로 옮길 수는 없습니다.)
1. [script.google.com](https://script.google.com) → **새 프로젝트** → 기본 코드를 지우고 복사한 `GcCode.gs` 전체를 붙여넣고 저장
   - 임상 수용성 평가(CA) 응답 시트의 [확장 프로그램 → Apps Script]에서 만들거나, CA 시트 ID 를 `GC_SPREADSHEET_ID` 에 넣지 마세요(두 평가의 `Visits` 가 섞입니다). 그렇게 하면 setup 이 오류로 멈춥니다.
2. 함수 선택에서 **`setup`** → **실행** → 권한 승인 (확인되지 않은 앱 경고가 나오면 고급 → 이동 → 허용. 권한 항목마다 체크박스가 보이면 **「모두 선택」** 후 **[계속]**)
3. 아래 **실행 로그**의 마지막 줄이 `✅ GC 응답 시트 준비 완료 — <링크>` 인지 확인합니다 (`⚠️` 로 끝나면 setup 을 한 번 더 실행). 그 링크가 새로 만들어진 스프레드시트 `가이드라인 부합도 검증 (GC) 응답` 입니다 (Visits·GC_Sessions·GC_Judgments·GC_Raw, 10분 요약 트리거 포함)
4. **배포 → 새 배포 → 웹 앱** (실행 사용자: **나**, 액세스 권한: **모든 사용자**) → 웹 앱 URL 복사
5. 그 URL 을 `gc/gc-config.js` 의 `ENDPOINT: ''` 따옴표 안에 넣고 사이트에 반영

요약(`GC_Adjudication`, `GC_Concordance`, `GC_Summary`, `GC_Codebook`)은 10분마다 자동 갱신되며, 바로 보려면 함수 `buildGcSummary` 실행.
CA Summary [14] 에 연결하려면 `GC_Concordance` 의 `TargetKey`·`ConcordanceScore` 두 열을 CA 스프레드시트의 `Concordance` 시트에 붙여 넣습니다.

```bash
python3 tools/build_gas.py                 # gas/Code.gs (CA) + gas/GcCode.gs (GC) 둘 다 생성
node tools/test_gc.js                      # GC 백엔드 단위 테스트 (+ CA test_summary.js)
node tools/mock_gas_server.js 8791         # CA 웹 앱 /exec, GC 웹 앱 /gc-exec (각자 별도 시트)
node tools/e2e_gc.js http://localhost:8791 ./shots-gc      # GC 사이트 자동 완주 + 시트·요약 검증
curl 'http://localhost:8791/__sheets?app=gc'               # GC 시트 내용
```
