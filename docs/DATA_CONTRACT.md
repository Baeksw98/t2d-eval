# Data contract (v3) — client payloads → Google Sheets

This file is the single source of truth for what the site sends and what the backend stores.
The CA site is served at `https://eval.asclep.org/ca/` (`ca/index.html` + root `app.js`/`config.js`; moved from `/` in site v3.5,
`APP_VERSION 2026-11-20.ca-v3.5`; no payload field or storage-key change). `entry.src`/`site`/`wave` come from the `/ca/` URL; the
landing page `/` and the legacy short links `/a/`, `/b/` pass them on (`?src=qr` from the printed QR → landing → `/ca/?src=qr`).
What changed in meaning: (1) `entry.referrer_origin` (Visits/Sessions `ReferrerOrigin`): for a visit that comes through `/`, `/about/`,
`/a/` or `/b/`, `document.referrer` on `/ca/` is this site, so the entry page stores the external origin of the visit in
`sessionStorage['t2d:entry_ref']` (`''` = direct) and `app.js` uses that instead; a direct external link to `/ca/` still uses
`document.referrer` as before. (2) A scan of the printed CA QR (`/?src=qr`) now opens the landing page, which sends no beacon, so
**Visits no longer includes people who leave on the landing page**; a Visits row is written only once they open `/ca/` (or `/gc/`).
`gas/src/core.gs` writes these sheets; `gas/src/summary.gs` reads them. `tools/build_gas.py` concatenates
`gas/src/*.gs` into the single `gas/Code.gs` that is pasted into Apps Script.

Conventions
- Every non-empty string cell is written with a leading apostrophe (text marker). Real Sheets and the mock strip
  it on read, so readers compare plain strings.
- Booleans are real booleans (`TRUE`/`FALSE`). Numbers are numbers. Seconds have 1 decimal, minutes 1 decimal.
- Coded answers are stored twice: label column `X` (Korean text) and `X_code` (integer, 1-based option index).
- Dynamic columns: evaluator profile fields → `Eval_<id>` (+ `Eval_<id>_code`), per-case secondary items →
  `Case_<id>` (+ `_code`), end-of-session items → `End_<id>` (+ `_code`). The backend appends missing headers
  (so `Eval_ai_freq`/`_code` appear by themselves on the first v3.4 row, with no backend redeploy).
- Test sessions: `IsTest = TRUE` (URL `?test=1`, or site without ENDPOINT). Excluded from Summary/AnalysisLong.

## Item ids used by the Summary (config.js)
Evaluator profile since site v3.4 (`APP_VERSION 2026-11-19.ca-v3.4`):
인턴 → no role item · 레지던트 → `year` only · 전문의 → `specialty`, `board_years`; plus ONE common item for every role, `ai_freq`.
Consent text v3.4 lists "성명, 직군·연차/경력, AI 사용 빈도, …" → `CONSENT_VERSION 2026-11-19-v3` (stored as `ConsentVersion`;
sessions started before the deploy keep the version they stored).

| id | where | options (code = index+1) |
|---|---|---|
| `year` | resident field | R1, R2, R3 |
| `specialty` | specialist field | list + 기타 (직접 입력) (no code semantics) |
| `board_years` | specialist field | 5년 미만, 5–9년, 10–19년, 20년 이상 |
| `ai_freq` | common profile, every role (v3.4+), first session only (carried into linked sessions; asked in the continuation when the earlier session has none) | 사용한 적 없음(1), 주 1회 미만(2), 주 1–2회(3), 주 3–6회(4), 거의 매일(5) — same id/label/options/codes as GC |
| `harm` | per case | 없음(1), 경미한 위해 가능성(2), 중대한 위해 가능성(3) |
| `harm_phases` | per case, optional, only if harm ≥ 2 | multi: P1, COMBO, P2, P3, P4, P5 → stored `P3;P4` |
| `would_prescribe` | per case | 그대로 처방(1), 일부 수정하여 처방(2), 처방할 조합 없음(3) |
| `intent_use` | end of session | 1 전혀 그렇지 않다 … 5 매우 그렇다 |

Legacy profile items (site ≤ v3.3, no longer asked). Their columns and values stay in the sheets for respondents who
answered them; sessions started on v3.3 and resumed after the v3.4 deploy keep sending them (the evaluator object is fixed
at session start). The Summary shows them only when ≥ 1 included evaluator has a value, labelled `(v3.3 이전 문항)`.

| id | where | options (code = index+1) |
|---|---|---|
| `major` | resident field (≤ v3.3) | 내과, 가정의학과, 기타 (직접 입력) |
| `t2d_volume` | common profile (≤ v3.3) | 월 1명 미만, 월 1–10명, 월 11–30명, 월 31명 이상 |
| `ai_use` | common profile (≤ v3.3) | 사용한 적 없음, 월 1회 미만, 월 1회–주 1회, 주 2회 이상, 거의 매일 — **different scale from `ai_freq`; never merge the codes** |
| `ai_trust` | common profile (≤ v3.3), first session only | 1 전혀 신뢰하지 않음 … 5 매우 신뢰함 |

Evaluator characteristics in Summary/AnalysisLong are per evaluator: the first included session's value, else the value
from another session of the same evaluator (so a v3.3 evaluator who continued on v3.4 has both the legacy items from
session 1 and `ai_freq` from session 2). AnalysisLong carries `AIFreq_code` (after `BoardYears`) next to the legacy
`T2DVolume_code`, `AIUse_code`, `AITrust_code`, `Major` (blank for evaluators who were not asked).

## Sheets
**Timestamps (backend v5, 2026-11-20):** every column whose name ends in `At` (ReceivedAt, FirstSeenAt, ServerUpdatedAt,
StartedAt, FinishedAt, ConsentAt, CaseStartedAt, CaseCompletedAt, LastActivityAt …) is stored as a real date-time value
(client ISO strings are converted), shown as `yyyy-mm-dd hh:mm:ss` in the spreadsheet time zone `Asia/Seoul`; the value keeps
milliseconds. `resetAllResponses()` (run from the Apps Script editor) backs up the whole spreadsheet as a copy, clears the five
response sheets to their headers, resets EvaluatorCode/sequence counters and rebuilds Summary (Concordance is kept).


### Visits (one row per intro page view, no PII) — action `view`
`ReceivedAt, VisitId, DeviceId, Src, Site, Wave, TypeParam, FormFactor, InAppBrowser, ReferrerOrigin, IsTest, AppVersion`
(`TypeParam` = the `?type=` value in the link, normally blank because evaluators choose the Type on the start screen.)

### Sessions (one row per evaluation session = one Type)
`FirstSeenAt, ServerUpdatedAt, SessionId, IsTest, EvaluatorName, EvaluatorRole, EvaluatorDetail, ResidentYear,
StudyType, SequenceIndex, SeqSource, Order, Status, CasesCompleted, LinkedSessionId,
EvaluatorId, EvaluatorCode, DeviceId, VisitId, SessionOrdinal,
Src, Site, Wave, TypePreselected, InAppBrowser, ReferrerOrigin,
ConsentVersion, ConsentAt, ConsentInherited, InstrumentVersion, Incentive,
StartedAt, FinishedAt, TotalActiveMin, TotalIdleMin, TotalHiddenMin, TotalWallMin, IntroSec, FinalSec,
Resumes, Interruptions, SendFailures, FurthestCase, FurthestStep, LastActivityAt, PartialRatingsN,
OverallComment, FormFactor, ViewportW, ViewportH, ScreenW, ScreenH, DPR, TouchPoints, CoarsePointer,
Language, TimeZone, UserAgent, AppVersion, DataVersion, BackendVersion`
+ `Eval_*`, `End_*`.
- `Status`: started → in_progress → completed (never regresses).
- `EvaluatorId`: client UUID; new for a fresh evaluator, inherited by a linked continuation session.
- `EvaluatorCode`: server pseudonym `E001…`, one per EvaluatorKey = SHA-256(normalised name + role id).
- `SessionOrdinal`: 1 = first Type for this evaluator, 2 = continuation.
- Evaluators choose the Type themselves on the start screen (one common QR); `TypePreselected` is TRUE only when a link carried ?type=.
- `FurthestCase` (1-based) / `FurthestStep` (vignette|p1|combo|p2|p3|p4|p5|comment|final) from `progress` pings.

### Responses (one row per session × case)
`ServerUpdatedAt, SessionId, IsTest, EvaluatorName, EvaluatorRole, EvaluatorDetail, ResidentYear, StudyType,
SequenceIndex, SeqSource, EvaluatorId, EvaluatorCode, SessionOrdinal, CaseOrder, GlobalCaseOrder,
CaseKey, PatientId, PatientSeenPrior, Model, ModelName,
P1_Referral, ComboChoice, ComboName, ComboKey, ComboIsAIFirst, ComboRankAI, RankCueVisible,
P2_SharedDecision, P3_Pharmacotherapy, P4_FollowUp, P5_Education,
CaseComment, CaseStartedAt, CaseCompletedAt, CaseActiveSec, CaseIdleSec, CaseHiddenSec, CaseWallSec,
Sec_{Vignette,P1,Combo,P2,P3,P4,P5,Comment}, TTFR_{P1,Combo,P2,P3,P4,P5}, Changes_{P1,Combo,P2,P3,P4,P5},
Scroll_{…8 steps}, Visits_{…8 steps}, ScrollAtFR_{P1..P5},
Chars_{Vignette,P1,Combo,P2,P3,P4,P5}, ComboSeen_{1,2,3}, ComboDwellSec_{1,2,3}, RxDetailsOpens, Interruptions,
ComboResets, PatientDrawerOpens, PatientDrawerSec, AppVersion, DataVersion, BackendVersion, MetricsJson`
+ `Eval_*`, `Case_*`.
- `Sec_*` = visible time (active + idle) per step; hidden excluded. Active-only per step is in MetricsJson.
- `ComboRankAI` = AI's rank of the chosen combination (display order = AI order, so = ComboChoice).
- `ComboIsAIFirst` = (ComboRankAI = 1). `RankCueVisible` = the output's combination names contain a rank cue
  (우선/후순위/대안/권장) was shown. Since v3.2 the AI's combination names are not displayed (boxes are labelled 조합 1/2/3 with the drug list), so the client sends FALSE.
- `ComboKey` = `<CaseKey>_C<ComboRankAI>`.
- `GlobalCaseOrder` = position across linked sessions (1–4). `PatientSeenPrior` = same patient seen in an
  earlier linked session.

### PhaseLong (one row per session × case × phase P1–P5)
`ServerUpdatedAt, SessionId, IsTest, EvaluatorName, EvaluatorRole, EvaluatorDetail, ResidentYear, StudyType,
SequenceIndex, EvaluatorId, EvaluatorCode, SessionOrdinal, CaseOrder, GlobalCaseOrder, CaseKey, PatientId,
PatientSeenPrior, Model, ModelName, ComboChoice, ComboKey, RankCueVisible, Phase, PhaseLabel, TargetKey,
Score, Acceptable_4plus, FirstScore, Changed, VisibleSec, ActiveOnlySec, TTFRSec, Changes, ScrollPct,
ScrollAtFirstRating, Chars, CharsPerSec, Visits, HarmInPhase`
+ `Eval_*`.
- `TargetKey` = `P051_deepseek|P1` for Phase 1, `P051_deepseek|C2|P3` for Phases 2–5 (joins to guideline
  concordance scored per output × combination × phase).
- `HarmInPhase` = 1 if `Case_harm_phases` lists this phase, 0 if harm was answered but not this phase, blank if
  harm phases were not given.

### RawJSON
`ReceivedAt, Action, SessionId, MsgId, IsTest, Payload, ElapsedMs, Error`

### Generated by the Summary builder (every 10 min when new data arrived; or run `buildSummary`)
- **Summary** — human-readable tables for the paper (see summary.gs header).
- **AnalysisLong** — pseudonymised (no names), one row per EvaluatorCode × case × phase for every non-test completed
  case, with `IncludedInAnalysis` (0/1) + `ExclusionReason`, covariates and quality flags. For R/Stata.
- **Codebook** — every column of every sheet with a description.

## Payloads (client → `doPost`, body = JSON text/plain)
Common to `start | case | finish | progress`:
`action, msg_id, client_time, study_id, app_version, data_version, instrument_version, session_id (UUID), is_test,
evaluator {name, role, role_label, fields{id: label}, codes{id: int}, detail, year}, evaluator_id, device_id,
visit_id, session_ordinal, study_type, linked_session_id, sequence_index, seq_source, order[], n_sequences,
entry {src, site, wave, type_preselected, type_param, in_app, referrer_origin}, consent {version, at, inherited}, incentive`

- `start`: + `device{…}`. Response `{ok, seq_index}`.
- `case`: + `case{…}` (see below), `session{…}`, `device{…}`.
- `finish`: + `cases[]`, `session{…}`, `overall_comment`, `end_items{id: {value, code}}`, `device{…}`.
- `progress`: + `progress{furthest_case, furthest_step, partial_ratings_n, last_activity_at}`. Fire-and-forget.
- `view` (no session): `action, msg_id, client_time, study_id, app_version, is_test, visit_id, device_id, entry{…},
  form_factor`. Fire-and-forget; the backend must stay light (append only).

`case` record: `case_index, case_key, patient_id, model, model_name, ratings{p1..p5}, combo_choice, combo_name,
combo_key, combo_rank_ai, combo_is_ai_first, rank_cue_visible, global_case_order, patient_seen_prior, comment,
started_at, completed_at, items{id: {value, code}}, chars{vignette,p1,combo,p2,p3,p4,p5},
combo_exposure{seen:[b,b,b], dwell_ms:[n,n,n]}, rx_details_opens, interruptions,
metrics{steps{<step>: {active_ms, idle_ms, hidden_ms, wall_ms, visits, ttfr_ms, changes, history, scroll_max,
scroll_at_fr, drawer_opens, drawer_ms, interruptions}}, combo_resets, case_active_ms, case_idle_ms,
case_hidden_ms, case_wall_ms, drawer_opens, drawer_ms}`

`session` summary: `started_at, finished_at, total_active_ms, total_idle_ms, total_hidden_ms, total_wall_ms,
intro_ms, final_ms, resumes, cases_completed, interruptions, send_failures`

> GC (guideline-concordance physician validation, `/gc/`) is a separate evaluation procedure with its own Apps Script project and spreadsheet: see [`docs/GC_CONTRACT.md`](GC_CONTRACT.md).
