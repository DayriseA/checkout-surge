# 17c — Re-fit the duration estimator to declared-capacity dispatch and state the design choice

## Handoff

- Status: Implemented and validated. The estimate-ratio acceptance criterion remains partial; by user decision (2026-09-21) it is carried to [task 20](20_verify_policy_against_code_bound_targets.md), and the related D11 question to [carried-over follow-up 6](carried_over_follow_ups.md). Staged, not committed.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: inserted between 17 and 18 (user decision, 2026-09-21). Execute after [17b](17b_pace_erp_dispatch_at_declared_capacity.md); it supplies the corrected runtime behaviour and its measurements.
- Source: revised D06 and D11 in the [implementation plan](../../adaptive_erp_processing_implementation_plan.md), the completion notes of tasks [15](15_implement_conservative_duration_estimator.md), [16](16_enforce_estimated_duration_admission.md), [17](17_build_dashboard_estimate_and_admission_flow.md) and 17b.
- Ownership: the pure API estimator and its constants, the estimator vocabulary in contracts and its web presentation, one seeded admin preset, and the dashboard's About copy.

## Why

Task 15 fitted the estimator to a worker that ramped from 2 launches/s and was throttled by a scheduling defect. It therefore models a pacing ramp (initial 2/s, +0.1/s², ceiling 20/s), doubles the resulting processing time, and charges 5 seconds per excess attempt. After task 17b the worker dispatches at the declared capacity from the first second, so these assumptions are wrong and far too pessimistic. D11's original envelope already describes the right model: ERP envelope = `N / r` with `r = min(declared capacity, C / L)`.

## Objective and fixed rules

- The estimator stays a pure, versioned API service; contracts hold schemas and vocabulary only; React implements no formula (D11, D12). Admission semantics from task 16 do not change: inclusive, unrounded comparison against the effective ceiling, recomputed at start, no bypass in admin mode.
- Replace the ramp model with the D11 envelope using the same margin below declared capacity that task 17b applies, defined once and shared rather than copied. Remove the pacing constants that no longer describe anything (initial rate, ramp, launch ceiling, adaptation multiplier).
- Re-derive the transient-error overhead from how the worker now behaves and from task 17b's measurements. A read-only code review on 2026-09-21 found that an ordinary injected `503` asks for a 1-second pause, not 5; do not keep a constant whose justification is gone, and do not drop to an optimistic one either.
- Stay conservative: every measured finalization time from task 17b must be below its estimate, with the margin stated. Constants remain provisional until task 20; never describe them as a worst-case bound or a confidence interval.
- Bump the estimator identity version, since the formula changes.

## Repository entry points

`apps/api/src/services/demo-duration-estimator.ts` and `apps/api/test/unit/demo-duration-estimator.test.ts`, `packages/contracts/src/estimate.ts` (estimator identity, bottleneck vocabulary) and its tests, `apps/web/src/app/lib/presentation/` (bottleneck and guidance copy added by task 17), `packages/db/src/scripts/seed.ts` (`admin-failure-path`), `apps/web/src/app/page.tsx` (`TechnicalAbout`), [calibration criteria](calibration_criteria.md).

## Implementation work

- [x] Re-fit the formula and constants as described above, with tests for both traffic shapes, the boundaries around the ceiling, the unestimable cases and the zero-work case kept from task 15. Update the tests that assert measured evidence with task 17b's table.
- [x] Remove the `adaptive_pacing` bottleneck value from contracts, the estimator's bottleneck rule and the web vocabulary, confirming by repository search that nothing else uses it. The exhaustive mapping added by task 17 must still fail type-check on an unmapped value.
- [x] Keep every seeded preset (public and admin) and every acceptance fixture admitted, and keep the test that proves it. The incident (`60 + 888/10 = 148.8 s` before margins) and `surge-10k` (140 s before margins, because `C / L = 50/s` binds) must stay admitted with their margins.
- [x] Task 16 lowered the seeded `admin-failure-path` stock from 200 to 90 only to pass admission under the old estimate. If the re-fitted estimator admits 200 with reasonable headroom, restore it; otherwise keep 90 and record the figures.
- [x] Add two or three sentences to the dashboard's About section, in the part that explains how the queue protects the ERP: the worker is configured with the ERP's declared capacity, which is the common case with mainstream ERP and SaaS APIs that publish their limits; when a downstream limit is unknown or variable, an adaptive client-side limiter (for example the adaptive retry mode of the AWS SDKs) is the appropriate technique, and the demo deliberately shows the common case. Match the surrounding tone and keep it short; adjust the existing About sentences that would now be inaccurate.
- [x] Update the rows of [calibration criteria](calibration_criteria.md) that list pacing and estimator parameters, and this backlog's index.

## Non-goals

No worker change (task 17b), no change to the admission endpoints, rejection payload or preview flow, no runtime progress UI (task 18), no final calibration (task 20).

## Acceptance and validation

- [ ] For each scenario measured in task 17b, the estimate is above the measured finalization time and no longer several times larger: report estimate, measurement and ratio in the completion notes.
- [x] All seeded presets and acceptance fixtures are admitted; a genuinely over-budget scenario is still rejected with an attributable bottleneck and guidance.
- [x] The About copy is present, accurate and in English; web tests covering the page still pass.
- [x] Run Biome on touched files, `pnpm type-check`, `pnpm test:unit`, focused contracts, API-unit and web tests; `pnpm test:infra:up`, `pnpm test:api` and `pnpm test:integration --concurrency=1` because the seed and the estimate contracts are touched. Do not run `pnpm test:composition` or `pnpm test:characterization`. No new runtime measurement is required; reuse task 17b's.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). All artifacts in English. Report executed and skipped checks honestly. Altering D11's envelope or D14's targets requires explicit user approval.

## Completion handoff

Deliver the re-fitted versioned estimator, the vocabulary cleanup, the preset decision and the About copy. Record the formula, constants, the estimate-versus-measurement table and the final `admin-failure-path` values. Next: [18 — runtime progress and grace notice](18_build_runtime_progress_and_grace_notice.md).


## Completion notes

The pure API estimator is now `conservative-duration-estimator` v2; engine identity stays `declared-capacity-erp-dispatch` v2. Contracts own vocabulary and identity; the web keeps its exhaustive `satisfies Record<EstimatorBottleneck, string>` mapping and contains no formula. Start/preview authority, worker code, D11’s sequential envelope and D14 targets are unchanged.

For unique acceptable orders `N = min(unique intents, floor(stock / request quantity))`, `demand = N` when `p = 0`, otherwise `N / (1 - p) × 1.25`. With latency `L` in seconds:

- `r = min(declared capacity × (1 - erpDispatchSafetyMargin), C / (L + 0.130))`.
- `erpSeconds = demand / r + (demand - N) × 1` (zero for no orders).
- `conservative = start delay + traffic budget + erpSeconds + 15`.
- Admission remains an inclusive, unrounded comparison with the effective ceiling, initially 600 seconds. Permanent declared outage or `p > 0.3` remains unestimable, including with no work.

The dispatch margin is imported from the single task 17b contracts definition (5%). The 130 ms overhead covers task 17b’s larger measured full-job overhead: `177.78 - 50 = 127.78 ms` for C; surge measured `231.71 - 150 = 81.71 ms`. Rates are consequently 55.556/s for C (below the measured full-job ceiling near 56/s) and 35.714/s for surge (below 43/s). The earlier “140 s / 50/s” illustration is superseded: surge’s sequential base is `120 + 1000 / 35.714 = 148 s`, then 15 s settlement gives **163 s**. Incident uses 9.5/s and gives **168.474 s**. Both stay below 600 s.

`perExcessAttemptPauseSeconds = 1` replaces the five-second cooldown allowance. The mock’s confirmation route sends `Retry-After: 1` for injected 503s; `ErpConfirmationClient` parses it, admission forwards it, and resilience availability guidance uses the supplied delay instead of fallback backoff. The demand margin remains 1.25, supported error-rate maximum 0.3, and settlement allowance 15 s. D’s ten measured 503s for 60 orders finalized at 20.894 s; the modeled demand is 93.75 attempts, with 33.75 s of pause allowance, giving 68.618 s. All constants remain provisional until task 20.

Only task 17b measurements were reused; no new reference-runtime measurement was taken. Ratios and positive margins below use unrounded estimates internally.

| Scenario | Estimate (s) | Measured finalization (s) | Estimate / measured | Margin (s) |
| --- | --- | --- | --- | --- |
| A | 37.632 | 15.252 | 2.467× | 22.380 |
| B: incident | 168.474 | 96.693 | 1.742× | 71.781 |
| C: spike | 30.400 | 8.075 | 3.765× | 22.325 |
| D: transient errors | 68.618 | 20.894 | 3.284× | 47.724 |
| surge-10k | 163.000 | 30.319 | 5.376× | 132.681 |

**Acceptance limitation:** every estimate exceeds its measurement, but “no longer several times larger” is not satisfied for C, D and surge. The mandated sum charges the full traffic budget even when traffic and ERP overlap or a buyer spike ends early (surge: 120 s budget versus 12.969 s measured traffic end), plus the retained settlement and retry allowances. The prescribed formula takes precedence; this combined acceptance checkbox remains unchecked rather than changing D11 or claiming it passed. Task 20 retains final calibration ownership. Orchestrator disposition (user decision, 2026-09-21): deferred to task 20. Overlapping traffic and ERP time would only move C to about 25 s, D to about 58.6 s and surge to about 135 s; the dominant contributors are the fixed 15 s settlement overhead on short runs, the full buyer-spike `maxDurationSeconds` budget and the transient-error allowance, which task 20 re-fits with repeated measurements.

**Admin preset:** restore `admin-failure-path` stock to **200**. Traffic remains 15/s for 12 s, so orders are **180**; ERP remains 300 ms / 30 TPS / error rate 0.25; concurrency remains 4. Demand is **300**, rate **4 / 0.430 = 9.302326/s**, ERP processing **32.25 s**, excess-attempt pauses **120 s**, traffic **12 s**, settlement **15 s**: estimate **179.25 s**, leaving **420.75 s** (70.125%) headroom. At stock 90 the new estimate would be 103.125 s. Seed overwrite behavior is unchanged: existing editable presets are preserved. The task 16 historical stock decision is annotated as superseded; unrelated stock-90 start-time snapshot tests remain unchanged.

The obsolete pacing bottleneck was removed from contracts, estimator attribution/guidance and web mapping. `grep -rn adaptive_pacing` over apps, packages, docs and working_docs, excluding node_modules/generated output and historical tasks 15/17/17b, finds only this task’s removal checklist (documentation of the deletion). A repository source search agrees; there are no executable, test, fixture or authoritative-doc uses. Removed ramp constants and the old assumption code also have no source matches.

### Validation

- Biome on every touched file: passed (10 TypeScript/TSX files checked; Markdown is outside the configured formatter and was manually reviewed without a line-length limit).
- `pnpm type-check`: passed all 11 workspace tasks plus test types.
- `pnpm test:unit`: initial parallel run hit a 5000 ms timeout in unchanged logger `fastify-correlation.test.ts`; `TURBO_CONCURRENCY=1 pnpm test:unit` passed all 11 workspace tasks, environment safety 7 and scripts 54. Package totals: contracts 194, logger 8, DB 60, load orchestrator 178, web 813, worker 131, API 8, mock ERP 64. The existing non-failing React act warning remains.
- Focused contracts: 9/9; API estimator: 8/8; web About/public mental model: 6/6; web estimate: 20/20. The web estimate test reports non-failing jsdom navigation notices. An initial estimator boundary fixture exceeded the public 5000 ms latency maximum after removing the multiplier; it now uses 200 reachable orders and retains both ceiling boundaries and ±0.000001 s checks.
- `pnpm test:infra:up`: isolated PostgreSQL and Redis healthy.
- `pnpm test:api --concurrency=1`: passed 50 files / 654 tests; 4/4 workspace tasks.
- `pnpm test:integration --concurrency=1`: passed 6/6 workspace tasks; DB 6 files / 83 tests, worker 10 files / 108 tests, mock ERP 1 file / 6 tests.
- `git diff --check`: passed.
- No reference-runtime measurement, composition or characterization run: explicitly excluded by task scope. No staging or commits.

Final self-review: API service, contracts, web presentation and tests agree; no route, infrastructure construction, worker, admission flow or runtime-progress changes. The stock-only seed change preserves editable-preset behavior. The sole unresolved acceptance issue is the stated ratio criterion under the required sequential envelope; constants remain provisional until task 20.
