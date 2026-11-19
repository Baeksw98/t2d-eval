# t2d-eval — working notes for Claude

## What this repo is
- Static site on GitHub Pages (`eval.asclep.org`, branch `main`) + Google Apps Script backends.
- `/` = clinical acceptability (CA) evaluation. It is LIVE with real physicians, so any push to `main` reaches respondents immediately.
  Source: `index.html`, `app.js`, `styles.css`, `config.js`, `data/cases.js`. Backend source: `gas/src/*.gs`.
- `/gc/` = guideline-concordance (GC) physician validation. It runs as its own evaluation procedure, with its own Apps Script project
  and its own spreadsheet. Source: `gc/*`. Backend source: `gas/gc/*.gs`.
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
  `tools/e2e.js` and `tools/e2e_gc.js`.
