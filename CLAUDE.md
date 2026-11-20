# t2d-eval — working notes for Claude

## What this repo is
- Static site on GitHub Pages (`eval.asclep.org`, branch `main`) + Google Apps Script backends.
- `/` = landing page: what the benchmark is + choose an evaluation (GC or CA), with an '이어서 하기' banner when this browser has an
  unfinished evaluation. Source: root `index.html`. Root URLs that target CA (`?type=`, `?reset=1`, `?test=1` with no track param,
  `?track=ca`) go straight to `/ca/` keeping query+hash; `?track=gc` → `/gc/`. The printed CA QR (`/?src=qr`) opens the landing.
- `/ca/` = clinical acceptability (CA) evaluation. It is LIVE with real physicians, so any push to `main` reaches respondents immediately.
  Source: `ca/index.html`, which loads the root `app.js`, `config.js`, `styles.css`, `data/cases.js` via `../`. Backend source: `gas/src/*.gs`.
  It moved from `/` in v3.5 with the same localStorage keys (`t2d-ca:T2D-CA-2026:v3`, `t2d-ca:device`) and payloads, so sessions
  started at `/` resume at `/ca/`. `/a/`, `/b/` → `/ca/?type=A|B`.
- `/gc/` = guideline-concordance (GC) physician validation. It runs as its own evaluation procedure, with its own Apps Script project
  and its own spreadsheet. Source: `gc/*`. Backend source: `gas/gc/*.gs`. It shares the root `styles.css` and `data/cases.js`.
- `/about/` = About the benchmark (`about/*`). Landing + About share `site.css` and `assets/*` (not `styles.css`).
- `/qr/` = QR hub (`qr/index.html`, shared code `qr/qr.js` + `qr/qr.css`, same header as the landing page;
  per-track pages `qr/main/`, `qr/ca/`, `qr/gc/`; images from `tools/make_qr.py` + `tools/render_qr_assets.js`).
  `qr/select.*` is the printed CA QR — never change it (same URL as `qr/main.*`).
- Home/About links inside an evaluation appear only on its intro screen (never during a case/item, never where leaving loses state).
- `gas/Code.gs` (CA) and `gas/GcCode.gs` (GC) are generated with `python3 tools/build_gas.py`. Never hand-edit them.
  The PI pastes a generated file into Apps Script and redeploys it by hand, so always say whether a change needs a redeploy.
- `gc/data/gc_items.js` is generated with `tools/build_gc_data.py`. Never hand-edit it.
- Contracts: `docs/DATA_CONTRACT.md` (CA) and `docs/GC_CONTRACT.md` (GC).

## Survey UX principle (standing request from the PI)
Every evaluation screen must let the respondent take in the information quickly and do the required evaluation right away:
- Show information in the order it is reasoned about. GC example: ① CDSS answer → ② why the AI rater scored it → ③ the AI audit's opinion → ④ the resulting final verdict → the respondent's decision.
- Ask only what the analysis needs. Remove questions that do not fit the respondent group, for example practice-volume questions for trainees.
- Use short Korean text, a clear hierarchy and one obvious next action. Check every screen on a phone (390px and 320px) and on an iPad.

## Invariants
- GC screens never show model names or run ids (blinding).
- Changing the CA site must not break a respondent's in-progress session (`localStorage` state) or a continuation into the other Type.
- Tests: `node tools/test_summary.js`, `node tools/test_gc.js`, mock backend `node tools/mock_gas_server.js <port>`, and the e2e suites
  `tools/e2e.js` (site root → `/ca/`) and `tools/e2e_gc.js`; landing redirects/resume banner: `node tools/test_site.js <mock url>`.
- The landing banner (`assets/site.js`) hardcodes the CA key `t2d-ca:T2D-CA-2026:v3`: change it there too if `STUDY_ID` or the key suffix changes.
