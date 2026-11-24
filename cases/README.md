# cases/ — 케이스·모델·세트의 원본 (source of truth)

이 폴더에 원본 자료를 넣고 `python3 tools/build_cases.py` 를 실행하면, 사이트의 평가 문항 자료가 모두 다시 만들어집니다.
임상 수용성 평가(CA)의 AI 답변 화면, 가이드라인 부합도 검증(GC)의 판정 화면, 그리고 평가자에게 배정하는 Type·Part 가 여기에 포함됩니다.
사이트에 올리기만 하면 되고, **Apps Script 를 다시 붙여넣을 필요는 없습니다.**

*English: put the source documents here and run `python3 tools/build_cases.py`. It regenerates every piece of evaluation data the
site uses: CA answers, GC judgments, and the Type/Part assignment. Pushing the site is enough; no Apps Script repaste for content.*

| 경로 | 내용 |
|---|---|
| `models.json` | 모델 목록: `code`(예: `gpt`), `name`(분석용 이름), `aliases`(원본 문서에 적힌 모든 표기). **평가자에게는 절대 보이지 않음** |
| `sources/ca/*.md` | CDSS 출력 문서 (환자 기록 + 모델별 5단계 출력 JSON) — 받은 형식 그대로 |
| `sources/gc/*.md` | 채점·감사 검증 보고서 (`# E11_P051 · <모델> 채점·감사 검증 자료`) — 받은 형식 그대로 |
| `sets/<id>.json` | 케이스 세트 매니페스트: 환자 · 모델 · 원본 파일 · 세션당 건수 · Type/Part |
| `active.json` | 지금 평가자에게 배정하는 세트: `{ "set": "v2", "gc_set": "v1" }` — `set` = 임상 수용성 평가(CA)·첫 화면·QR, `gc_set` = 가이드라인 부합도 검증(GC) 화면이 쓰는 세트(없으면 `set` 과 같음) |

세트 **v1** = 2026년 11월 연구(환자 P051·P011 × 모델 deepseek·gpt)입니다. 원본·자료 버전·Type/Part 를 모두 적어 두어 **동결**했으므로
고치지 마세요. 새 케이스는 새 세트(v2, v3 …)로 추가합니다.

---

## 케이스·모델·세트 추가하기 (연구책임자용, 단계별)

### 1. 새 모델이면 `models.json` 에 추가
```json
{ "code": "claude", "name": "Claude Example 1.0", "aliases": ["Claude Example 1.0", "Claude-Example-1.0 (2026)"] }
```
- `code`: 영문 소문자로 시작하는 짧은 이름입니다. 밑줄(_)·대문자·공백은 쓰지 마세요.
  unit 키(`P051_claude`)와 응답 시트의 `Model` 열에 들어가며, 한 번 정하면 바꾸지 않습니다.
- `name`: 응답 시트의 `ModelName` 열(분석용)에 들어갑니다. 그 모델이 들어간 세트가 평가에 쓰이기 시작하면 **`name` 도 바꾸지 않습니다**
  (동결된 세트의 보관본이 바뀌게 되어 빌드가 `[frozen-changed]` 로 멈춥니다). 다른 표기는 `aliases` 에 추가하세요.
- `aliases`: 원본 문서의 제목 줄에 적힌 모델 이름을 모두 넣습니다. CA 출력 제목(`GPT 6.1 Sol P011`)과 GC 보고서 제목(`OpenAI gpt-6.1-sol`)이 다르면 둘 다 넣습니다.
  비교할 때 대소문자·공백·하이픈(-)·밑줄은 무시합니다.

### 2. 원본 파일 넣기
**CA** — `cases/sources/ca/` 에 `.md` 파일을 넣습니다. 받은 문서를 한 파일 그대로 넣어도 되고, 환자 × 모델마다 파일을 나눠도 됩니다.
제목 줄 형식만 지키면 됩니다 (`**`, `#` 는 있어도 됩니다):
```
P052 Patient Input Information          ← 환자 기록 (### 인구통계: …, ### 내원 유형: …, ### 병력 … 기존과 같은 절)
P052 Claude Example 1.0                 ← "<환자> <모델 별칭>" 다음 줄부터 출력 JSON { "phase_1": …, "combinations": [3개] }
Claude Example 1.0 P052                 ← "<모델 별칭> <환자>" 순서도 됩니다
```
환자 기록이 여러 파일에 있으면 내용이 같아야 합니다.

**CA 형식 B (v2 부터, 시험 답안 md 한 파일)** — 자동으로 알아봅니다. 제목 줄에 환자 ID(`E11_P051`)가 있고,
`## 환자 기록` 절(형식 A 와 같은 `### 인구통계` … 소절)과 모델마다 `## 모델 N. <모델 별칭>` 절이 있습니다.
모델 절 안에는 `1.1 …?` 같은 문항 줄 + 답(산문), `의뢰:` 줄, `다음 방문:` 줄, 후보 조합 3개와 처방 표
(`| 계열 | 성분 | 같은 계열 대안 | 용량 | 횟수 | 결정 | 용량 조절 | 급여 | 월 본인부담(원) |`)가 들어갑니다.

**GC** — `cases/sources/gc/` 에 채점·감사 검증 보고서를 넣습니다. 보고서 하나에 환자 × 모델 하나이며, 파일 이름은 `E11_P052_claude.md` 처럼 짓기를 권장합니다.
첫 줄은 `# E11_P052 · <모델 별칭> 채점·감사 검증 자료` 입니다(가운뎃점 `·`). AI 감사가 △/✗ 로 표시한 판정만 전문의 검증 문항이 됩니다.
보고서 형식은 기존 보고서와 같아야 합니다: 채점 항목 줄 `**Q2.1-02 제목** — 감점 기준: …`(굵게, em dash `—`), 바로 아래 판정 표
`| 단위 | 판정 | 유형 | 답 인용 | Rater 사유 | 감사 | 채점표 적용 근거 | 의사 검증 |` (8칸), 판정 `○ 충족` / `−1 감점` / `채점하지 않음`,
감사 `✓` / `△ […] …` / `✗ → 충족 …` / `✗ → 감점 …`. 한 곳이라도 다르면 그 파일:줄을 오류로 알려 줍니다(조용히 건너뛰지 않음).

**블라인딩** — 평가자 화면에 보이는 글(CA: 환자 기록·출력 전체, GC: 채점 항목·질문·AI 채점 사유·인용·감사 의견·근거·적용 근거)에
`models.json` 의 모델 이름·별칭·code 나 GC 실행 ID 가 있으면 오류(`[model-name-in-text]`, `[run-id-in-text]`)로 멈춥니다.
원문에서 지우거나 "이 CDSS" 같은 일반 표현으로 바꾸세요. 약 이름처럼 code 로 시작하는 일반 용어(예: `alpha-glucosidase`)와
AI 회사·제품 이름(OpenAI, Claude …)은 경고(△)로만 알려 줍니다.
GC 자료가 아직 없으면 매니페스트에 `"gc": false` 로 두세요(CA 만 있는 세트). 이런 세트를 활성으로 할 때는 `active.json` 의
`gc_set` 에 GC 자료가 있는 세트(예: v1)를 적습니다. 그러지 않으면 `[active-without-gc]` 로 멈춥니다.

### 3. 세트 매니페스트 만들기 — `cases/sets/v2.json`
```json
{
  "id": "v2",
  "status": "draft",
  "title": { "ko": "가상 환자 3명 × CDSS 3종 (2027년 1월)", "en": "3 virtual patients × 3 CDSS (January 2027)" },
  "patients": ["P052", "P053", "P054"],
  "models": ["gpt", "deepseek", "claude"],
  "sources": { "ca": ["ca/2027-01_*.md"], "gc": ["gc/E11_P05[234]_*.md"] },
  "ca": { "per_session": 3, "minutes_per_unit": [10, 15], "types": "auto" },
  "gc": { "per_session": 3, "minutes_per_item": 1.2, "parts": "auto" }
}
```
- `patients` × `models` = 평가할 AI 답변(unit)입니다. unit 마다 CA 출력이 있어야 하고, `"gc": false` 가 아니면 GC 보고서도 있어야 합니다.
- `sources` 를 비우면 `cases/sources/ca/` · `gc/` 의 모든 파일을 읽습니다. 같은 환자 × 모델이 두 파일에 있으면 오류이니, 그럴 때는 sources 로 쓸 파일을 고르세요(glob 가능).
- `per_session` = 평가자 한 명이 한 세션에 보는 답변 수입니다. `"auto"` 이면 Type/Part 가 자동으로 만들어집니다(아래 「자동 배정 규칙」). 직접 쓰려면 v1.json 처럼 적습니다.
- `data_version` 을 쓰지 않으면 내용에서 자동으로 정합니다(내용이 같으면 늘 같은 값).
- 세트 ID 는 다시 쓰지 마세요. 내용을 바꾸려면 새 ID 를 쓰세요(이미 응답한 사람의 자료가 섞이지 않도록).

### 4. 확인 (아무 파일도 쓰지 않음)
```
python3 tools/build_cases.py --set v2 --check
```
- 맨 위에 Type/Part 구성, 세션당 건수, 예상 시간(CA: 답변당 10–15분, GC: 판정당 1.2분)이 나옵니다.
- `검증 결과` 에 `✗ 오류` 가 있으면 고친 뒤 다시 실행합니다. 각 줄에 파일:줄 번호, 이유, 고치는 방법(→)이 있습니다.
  `△ 확인` 은 경고입니다(예: 검증할 판정이 없는 답변은 GC Part 에서 빠짐).

### 5. 만들기 (활성 세트는 그대로)
```
python3 tools/build_cases.py
```
- 모든 세트의 보관본을 씁니다: `data/sets/v2/…` 와 `gc/data/sets/v2.json` 등. 사이트 첫 화면이 쓰는 활성 세트는 바뀌지 않습니다.
- 로컬에서 미리 보려면 잠시 `active.json` 을 v2 로 바꾸고 다시 빌드합니다.
  그다음 `node tools/mock_gas_server.js 8787` 을 실행하고 `http://localhost:8787/ca/?test=1` 과 `/gc/?test=1` 을 열어 봅니다.
  계속 진행하지 않을 거면 v1 로 되돌리고 다시 빌드하세요.

### 6. 평가자에게 배정할 세트 바꾸기
1. `cases/active.json` → `{ "set": "v2" }`
2. `python3 tools/build_cases.py` (활성 파일 `data/cases.js` · `data/design.js` · `gc/data/gc_items.js` 와 `gas/GcCode.gs` 의 내장 사본이 바뀜)
3. 테스트: `python3 tools/test_cases.py`, `node tools/test_summary.js`, `node tools/test_gc.js`
   (활성 세트를 따라가며 검사합니다. GC 백엔드의 프로토콜·요약 검사는 v1 보관본으로 계속 돌고, v1 보관본이 그대로인지도 확인합니다.)
   가능하면 `node tools/mock_gas_server.js 8787` 을 띄우고 `node tools/test_site.js http://localhost:8787`, `node tools/e2e.js http://localhost:8787/ shots mobile`,
   `node tools/e2e_gc.js http://localhost:8787 shots-gc` 도 실행합니다(화면에 모델 이름이 보이지 않는지, payload 의 set_id 가 새 세트인지 확인).
4. **QR 안내 카드·포스터 다시 만들기** — 세션당 건수·예상 시간·Type/Part 가 바뀌었으면, 미리 만들어 둔 `qr/*-card.png` 와 `qr/*-poster-a4.pdf`
   에 이전 세트의 건수·시간이 그대로 적혀 있습니다. `node tools/mock_gas_server.js 8787` 을 띄운 채 `node tools/render_qr_assets.js` 를 실행하고
   바뀐 `qr/*-card.png` · `qr/*-poster-a4.pdf` 를 함께 커밋합니다. (`qr/select.*` 는 인쇄된 QR 이라 다시 만들지 않습니다.)
5. 커밋·push → GitHub Pages 에 반영되면 끝입니다.
6. 평가가 시작되면 그 세트를 **동결**합니다: 매니페스트에 `"status": "frozen"` 을 쓰고, v1.json 처럼 지금 만들어진 `data_version`
   (`data/sets/v2/design.js` 의 `data_version` · `gc_data_version`)과 Type/Part(`ca.types`, `gc.parts` 의 sequences)를 그대로 적어 둡니다.
   그러면 나중에 생성기·파서·`models.json` 이 바뀌어도 그 세트의 Type 이나 문항이 진행 중에 바뀌지 않으며, 바뀌게 되면 빌드가
   `[frozen-changed]` 로 멈춥니다(아무 파일도 쓰지 않음). 정말 바꿔야 하면 새 세트 ID 를 쓰세요(`--allow-frozen-change` 는 연구책임자 확인 후에만).
- **Apps Script 는 다시 붙여넣지 않습니다.** GC 백엔드는 세트 자료를 사이트(`gc/data/sets/<세트>.json`, 활성 세트는 `index.json`)에서 10분마다 읽습니다.
  CA 백엔드에는 케이스 자료가 없습니다.
- 이미 시작한 평가자는 시작한 세트로 끝까지 진행합니다(보관본 `data/sets/<세트>/` 를 읽음). 그래서 **보관본 파일은 지우지 마세요.**
- 분석: CA 요약은 기본으로 완료 케이스가 가장 많은 세트 하나를 분석합니다. 스크립트 속성 `SUMMARY_SET` 에 세트 ID 를 넣으면 그 세트, `all` 을 넣으면 모든 세트를 함께 분석합니다.
  GC 요약은 세트별로 집계합니다.

### Apps Script 를 다시 붙여넣어야 하는 경우 (드뭄)
- 백엔드 코드(`gas/src/*.gs`, `gas/gc/*.gs`)를 고쳤을 때
- 이번 단계의 첫 배포 한 번: CA `ca-backend-v6`(UiLang·SetId 열, 모델 자동 인식), GC `gc-backend-v4`(사이트에서 세트 읽기 — 새 권한 「외부 서비스에 연결」)

---

## 자동 배정 규칙 (`"types": "auto"`, `"parts": "auto"` — `tools/cases_lib/design.py`)
- unit = 환자 × 모델. 한 묶음(Type/Part) = `per_session` 개 unit.
- 모든 unit 이 같은 횟수로 나옵니다. per_session 이 unit 수를 나누면 한 번씩, 아니면 최소 횟수만큼 반복합니다(안내가 나옴).
- 한 묶음 안에서 환자와 모델은 될 수 있는 한 겹치지 않습니다. 매니페스트의 `patients` · `models` 순서로 라틴 방격의 대각선을 따라 묶습니다.
- 묶음 안의 제시 순서는 Williams 설계로 정합니다. 2개면 정순과 역순이고, 각 답변이 각 위치에 같은 횟수로 나오며 앞뒤 순서도 균형을 이룹니다.
  서버가 응답이 적은 순서부터 배정합니다.
- GC Part 는 AI 감사가 표시한 판정이 있는 unit 만으로 같은 규칙에 따라 만듭니다.
  예상 시간은 판정 수 × 1.2분을 5분 단위로 내린 범위입니다(예: 18건 → 20–25분).
- v1 에 auto 를 적용하면 지금의 Type/Part A·B 가 정확히 나옵니다(`tools/test_cases.py` 가 확인).

## 오류 코드 (validation)
`[missing-output]` 출력 없음 · `[missing-record]` 환자 기록 없음 · `[unknown-model]` models.json 에 없는 모델 ·
`[duplicate-key]` 같은 환자 × 모델이 두 번 있음 · `[bad-output-json]` 출력 JSON 형식 오류 · `[combination-count]` 후보 조합이 3개가 아님 ·
`[missing-answers]` 2.1–5.4 답이 빠짐 · `[bad-record]` 환자 기록의 절·항목 이름이 다름 · `[missing-gc-report]` GC 보고서 없음 ·
`[duplicate-alias]` 두 모델이 같은 별칭을 씀 · `[unknown-unit]` Type/Part 에 세트 밖 unit 이 있음 · `[per-session]` 세션당 건수가 unit 수보다 큼 ·
`[no-source-files]` sources 에 맞는 파일 없음 · `[active-without-gc]` GC 활성 세트(`gc_set`, 없으면 `set`)에 GC 자료 없음 ·
GC 보고서 형식: `[bad-element]` 채점 항목 줄 형식이 다름 · `[table-without-element]` 판정 표 위에 채점 항목 줄이 없음 · `[bad-table]` 판정 행이 표 밖에 있음 ·
`[bad-row]` 판정 행이 8칸이 아니거나 첫 칸이 `조합 N`/`Phase 1` 이 아님 · `[bad-verdict]` 판정이 ○/−1/채점하지 않음 이 아님 ·
`[bad-audit]` 감사 칸이 ✓/△/✗ → 충족|감점 이 아님 · `[phase-mismatch]` Phase 1 행과 조합 행이 항목과 맞지 않음 ·
블라인딩: `[model-name-in-text]` 화면에 보이는 글에 모델 이름·별칭·code · `[run-id-in-text]` 화면에 보이는 글에 실행 ID ·
`[frozen-changed]` 동결된 세트의 보관본이 바뀌게 됨(아무 파일도 쓰지 않음).
경고(△, 빌드는 됨): `[no-flagged-items]` 검증할 판정이 없는 답변(GC Part 에서 빠짐) · `[many-groups]` Type 이 너무 많음(per_session 을 단위 수의 약수로) ·
`[unbalanced]` / `[unit-not-assigned]` 직접 쓴 Type/Part 의 균형이 맞지 않음 · `[no-report-title]` GC 파일에서 보고서 제목 줄을 찾지 못함 ·
`[model-code-compound]` code 로 시작하는 일반 용어(예: alpha-glucosidase) · `[vendor-name-in-text]` AI 회사·제품 이름.
매니페스트 `"models"` 에 모델 이름을 쓰면 `[unknown-model]` 이 쓸 code 를 알려 줍니다.

---

## For Claude (checklist)
1. Read `CLAUDE.md`, this file and `cases/sets/v1.json`. Never edit v1, its sources or any generated file
   (`data/cases.js`, `data/design.js`, `data/sets/**`, `gc/data/**`, `gas/Code.gs`, `gas/GcCode.gs`).
2. Add sources under `cases/sources/{ca,gc}/` in the formats above, extend `cases/models.json` if needed, write `cases/sets/<new>.json`.
3. `python3 tools/build_cases.py --set <new> --check` → fix every `✗` (messages name file:line and the fix), then `python3 tools/build_cases.py`.
4. Switch only when the PI asks: `cases/active.json`, rebuild, run `python3 tools/test_cases.py`, `node tools/test_summary.js`,
   `node tools/test_gc.js`, `node tools/test_site.js <mock url>` and the e2e suites against `node tools/mock_gas_server.js <port>`
   (all follow the active set: expected set_id, Types/Parts and times come from `data/cases.js` / `data/design.js`; blinding patterns
   from `cases/models.json`). If per_session, minutes or Types/Parts changed, re-render the QR cards/posters
   (`node tools/render_qr_assets.js` with the mock running; never `qr/select.*`) and commit `qr/*-card.png`, `qr/*-poster-a4.pdf`.
   When the new set goes live, set `"status": "frozen"` and write its generated `data_version`s and Types/Parts into the manifest
   (like `v1.json`); the build then refuses any change to its archive (`[frozen-changed]`).
5. Content changes need no Apps Script redeploy; say so explicitly. Backend code changes (`gas/src`, `gas/gc`) do.
6. Pipeline code: `tools/cases_lib/` (`ca_parse.py`, `gc_parse.py`, `design.py`, `validate.py`, `blinding.py`, `build.py`); fixture set
   (3 patients × 3 fictional models) in `tools/fixtures/cases/`. `tools/parse_md.py`, `build_data.py`, `build_gc_data.py` are legacy wrappers.


## 지금 평가 중인 세트 — v2: P051 × 모델 4종 (임상 수용성 평가만, 2026-11-24 시작)
- 원본: `sources/ca/2026-11-24_E11_P051_4models.md`(형식 B). 매니페스트 `sets/v2.json` — 동결(`"status": "frozen"`, `data_version` 고정).
- Type A = `P051_claude` + `P051_deepseek`, Type B = `P051_gpt` + `P051_glm` (두 제시 순서 모두), 세션당 2건, 약 20–30분.
- `active.json` = `{ "set": "v2", "gc_set": "v1" }`: GC 는 비활성화되어 있고, `/gc/` 화면은 v1 보관본을 그대로 씁니다.
- 같은 환자가 한 Type 에 두 번 나오므로, 두 번째 답변의 환자 정보는 핵심 요약 + 「전체 환자 기록 펼치기」로 보입니다 (app.js).
- 분석: 응답 시트의 `SetId` 열로 v1 응답과 구분됩니다. CA 요약을 v2 만으로 보려면 스크립트 속성 `SUMMARY_SET` = `v2`.
