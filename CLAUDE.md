# t2d-eval — working notes for Claude

## What this repo is
- Static site on GitHub Pages (`eval.asclep.org`, branch `main`) + Google Apps Script backends. It is a **living benchmark**:
  new cases and models plug into fixed instruments through versioned case sets (see "Case pipeline").
- `/` = landing page: what the benchmark is + choose an evaluation (GC or CA), with an '이어서 하기' banner when this browser has an
  unfinished evaluation. Source: root `index.html`. Root URLs that target CA (`?type=`, `?reset=1`, `?test=1` with no track param,
  `?track=ca`) go straight to `/ca/` keeping query+hash; `?track=gc` → `/gc/`. The printed CA QR (`/?src=qr`) opens the landing.
- `/ca/` = clinical acceptability (CA) evaluation. Treat it as LIVE with real physicians: any push to `main` reaches respondents immediately.
  Source: `ca/index.html`, which loads the root `app.js`, `config.js`, `styles.css`, `data/cases.js`, `data/design.js` via `../`.
  Backend source: `gas/src/*.gs`. It moved from `/` in v3.5 with the same localStorage keys (`t2d-ca:T2D-CA-2026:v3`, `t2d-ca:device`)
  and payloads, so sessions started at `/` resume at `/ca/`. `/a/`, `/b/` → `/ca/?type=A|B`.
- `/gc/` = guideline-concordance (GC) physician validation. It runs as its own evaluation procedure, with its own Apps Script project
  and its own spreadsheet. Source: `gc/*`. Backend source: `gas/gc/*.gs`. It shares the root `styles.css`, `data/cases.js`, `data/design.js`.
- `/about/` = About the benchmark (`about/*`), a standalone page (no participation content, no paper title). Landing + About share
  `site.css` and `assets/*` (not `styles.css`).
- `/qr/` = QR hub (`qr/index.html`, shared code `qr/qr.js` + `qr/qr.css`, same header as the landing page;
  per-track pages `qr/main/`, `qr/ca/`, `qr/gc/`; images from `tools/make_qr.py` + `tools/render_qr_assets.js`).
  While `T2D_FEATURES.gc` is false the hub shows only the main + CA QR codes and the main card/poster/message use the `qr.main1.*`
  texts (CA only); `qr/main-*` and `qr/ca-*` were re-rendered that way on 2026-11-24 (re-render `main` again when GC opens).
  `qr/select.*` is the printed CA QR — never change it (same URL as `qr/main.*`).
- Home/About links inside an evaluation appear only on its intro screen (never during a case/item, never where leaving loses state).
- Contracts: `docs/DATA_CONTRACT.md` (CA) and `docs/GC_CONTRACT.md` (GC).

## Case pipeline (cases/ → generated data) — `cases/README.md`
- Source of truth: `cases/models.json` (model `code` + `aliases`; names never shown to evaluators), `cases/sources/ca/*.md` (CDSS output
  documents, upload format), `cases/sources/gc/*.md` (채점·감사 검증 reports), `cases/sets/<id>.json` (patients × models, sources,
  per_session, Types/Parts `auto` or explicit), `cases/active.json` (`{"set": …, "gc_set": …}`: `set` = the CA set assigned to new
  evaluators, also used by the landing/QR pages; `gc_set` (default = `set`) = the GC set, so a CA-only set can be active while `/gc/` keeps
  loading the archives of a set that has GC data).
- CA sources come in two formats (`tools/cases_lib/ca_parse.py`): A = patient record + per-model output JSON (v1); B = one exam md with
  `## 환자 기록` and `## 모델 N. <alias>` sections of Korean prose + prescription tables (v2). Format B is detected automatically.
- `python3 tools/build_cases.py [--set id] [--check]` validates everything first (readable errors, nothing written on error), then writes
  per set `data/sets/<id>/{cases,design}.js`, `gc/data/sets/<id>/gc_items.js`, `gc/data/sets/<id>.json`, plus `gc/data/sets/index.json`
  and, for the active sets, `data/cases.js`, `data/design.js` (from `set`), `gc/data/gc_items.js` (from `gc_set`), and stamps
  `gc/index.html` to load `data/sets/<gc_set>/…` directly; then runs `tools/build_gas.py`.
  Library: `tools/cases_lib/` (ca_parse, gc_parse, design, validate, blinding, build). `tools/parse_md.py`, `build_data.py`, `build_gc_data.py` are
  legacy wrappers. Tests: `python3 tools/test_cases.py` (v1 reproduction, synthetic 3×3 fixture in `tools/fixtures/cases/`, validation).
  The build refuses (file:line, nothing written): a GC report that deviates from the format anywhere, a model name/alias/code or run id
  in any evaluator-visible text (`blinding.py`; e2e twin `tools/blinding_regex.js`), and any change to a `"status": "frozen"` set's archive.
  All tests follow `cases/active.json` (GC protocol tests keep running on the v1 archive). After a set switch that changes times or
  Types/Parts, re-render `qr/*-card.png` / `qr/*-poster-a4.pdf` with `tools/render_qr_assets.js` (`cases/README.md` step 6).
- Set **v1** = the Nov 2026 study (P051/P011 × deepseek/gpt), frozen: never edit `cases/sets/v1.json`, its sources or its archives. Its data
  equals the pre-pipeline files apart from `set_id`; `auto` on v1 reproduces Type/Part A/B exactly.
- Never hand-edit generated files: `data/cases.js`, `data/design.js`, `data/sets/**`, `gc/data/**`, `gas/Code.gs`, `gas/GcCode.gs`.
- Apps read Types/Parts from `window.T2D_DESIGN` (fallback: the v1 literals in `config.js` / `gc/gc-config.js`). A saved session whose
  `set_id` differs from the active set loads `data/sets/<saved>/…` before resuming, so archives must never be deleted.
- Payload values stay canonical (Korean label + code) in any UI language; every payload carries `ui_lang` and `set_id`.

## Backends and redeploys
- `gas/Code.gs` (CA, `BACKEND_VERSION …ca-backend-v6`) and `gas/GcCode.gs` (GC, `GC_BACKEND_VERSION …gc-backend-v4`) are generated with
  `python3 tools/build_gas.py` (run by build_cases). The PI pastes a generated file into Apps Script and redeploys it by hand, so always
  say whether a change needs a redeploy:
  - **Content changes (cases, models, sets, switching the active set) need no repaste.** CA reads models from the data; GC fetches each
    set from `https://eval.asclep.org/gc/data/sets/<id>.json` (UrlFetchApp, 10-min CacheService, embedded `GC_ITEMS` = active set at build
    time as fallback). The GC v4 deployment needs the extra permission 「외부 서비스에 연결」.
  - Backend code changes (`gas/src/*.gs`, `gas/gc/*.gs`) do need a repaste + new deployment version.
- New sheet columns are appended at the right end (existing positions never move). `UiLang`/`SetId` blank in old rows = ko / v1.
- CA Summary analyses one set (most completed cases, or script property `SUMMARY_SET` = id | `all`); per-model tables for any number of
  models, paired model comparison only with exactly 2. GC summary groups adjudication/concordance by set.

## Language and theme (all pages)
- `assets/i18n.js` (header comment = API contract) loads synchronously in `<head>` before stylesheets; dictionaries `i18n/{site,qr,ca,gc}.js`
  call `T2D.i18n.add({ko, en})` with flat keys (`site.*`, `about.*`, `qr.*`, `ca.*`, `gc.*`). Static HTML: `data-i18n`, `data-i18n-html`,
  `data-i18n-attr`; JS UI: `T2D.t(key, vars)`, `T2D.pick(obj)`, re-render on the `t2d:lang` event; header controls `T2D.controlsHTML()` +
  `T2D.bindControls()`. **Korean is always the default** (`?lang=en` or the EN button only). Case content stays in its source language.
- Theme: `<html data-theme="light|dark">` is always set by i18n.js; dark tokens under `:root[data-theme="dark"]` and under
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`. Check every page in both themes.

## Current study state (2026-11-24)
- **Only the clinical acceptability (CA) assessment is open.** `assets/features.js` (`window.T2D_FEATURES = { gc: false, about: false }`)
  gates every link into `/gc/` and `/about/`: the landing GC card (shown greyed with a "비활성화" badge) and the About links open a
  "currently disabled" dialog instead of navigating. The pages themselves still exist (their URLs were never shared). To open an
  area, set its flag to `true`. Loaded on the landing, About, QR pages, `/ca/` and `/gc/`.
- **Patient record = clinical layout** (`assets/clinical.js`, used by `app.js` and `gc/gc.js`; display only, data unchanged):
  diabetes-related comorbidities first as a 'item | value' grid — `CKD: Stage n` (no eGFR range), `Heart failure` / `ASCVD` / `MASLD`:
  `Yes (detail)` or `No`, `Obesity: Yes` when the current BMI ≥ 25 kg/m² else `No` (the BMI value itself is only in the body-measurement rows), diabetic retinopathy/neuropathy moved here from the other list — then
  the other (non-diabetes) comorbidities without the BMI line; the separate "현재 신체검사" chips are gone and the lab table starts
  with the body-measurement/BP rows, then blood tests. A patient already seen in the session (or in the previous Type) gets a key
  summary (HbA1c, eGFR, BMI, BP, comorbidities, current medications) with the full record behind 「전체 환자 기록 펼치기」.
- **Active CA set = v2 (live 2026-11-24, frozen):** P051 only × 4 models, CA only (`"gc": false`), source
  `cases/sources/ca/2026-11-24_E11_P051_4models.md` (format B). Type A = `P051_claude` + `P051_deepseek`, Type B = `P051_gpt` + `P051_glm`,
  each in both presentation orders; 2 answers per session, about 20–30 min. `cases/active.json` = `{ "set": "v2", "gc_set": "v1" }`.
  Model names for analysis: Claude Fable 5.2, GLM-5.3 Flash (PI confirmed 5.3 on 2026-11-24; the old 5.4 aliases were removed).
  The CA Summary analyses the set with the most completed cases: set the script property `SUMMARY_SET=v2` to analyse v2 only.

## Survey UX principle (standing request from the PI)
Every evaluation screen must let the respondent take in the information quickly and do the required evaluation right away:
- Show information in the order it is reasoned about. GC example: ① CDSS answer → ② why the AI rater scored it → ③ the AI audit's opinion → ④ the resulting final verdict → the respondent's decision.
- Ask only what the analysis needs. Remove questions that do not fit the respondent group, for example practice-volume questions for trainees.
- Use short Korean text, a clear hierarchy and one obvious next action. Check every screen on a phone (390px and 320px) and on an iPad.

## Invariants
- GC screens never show model names or run ids (blinding).
- Changing the CA site must not break a respondent's in-progress session (`localStorage` state) or a continuation into the other Type.
- Tests: `python3 tools/test_cases.py`, `node tools/test_summary.js`, `node tools/test_gc.js` (runs test_summary too), mock backend
  `node tools/mock_gas_server.js <port>` (serves the site; UrlFetchApp serves repository files), and the e2e suites `tools/e2e.js`
  (site root → `/ca/`) and `tools/e2e_gc.js`; landing redirects/resume banner: `node tools/test_site.js <mock url>`.
- The landing banner (`assets/site.js`) hardcodes the CA key `t2d-ca:T2D-CA-2026:v3`: change it there too if `STUDY_ID` or the key suffix changes.
