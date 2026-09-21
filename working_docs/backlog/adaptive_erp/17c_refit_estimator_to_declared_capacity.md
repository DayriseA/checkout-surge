# 17c — Re-fit the duration estimator to declared-capacity dispatch and state the design choice

## Handoff

- Status: Pending.
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

- [ ] Re-fit the formula and constants as described above, with tests for both traffic shapes, the boundaries around the ceiling, the unestimable cases and the zero-work case kept from task 15. Update the tests that assert measured evidence with task 17b's table.
- [ ] Remove the `adaptive_pacing` bottleneck value from contracts, the estimator's bottleneck rule and the web vocabulary, confirming by repository search that nothing else uses it. The exhaustive mapping added by task 17 must still fail type-check on an unmapped value.
- [ ] Keep every seeded preset (public and admin) and every acceptance fixture admitted, and keep the test that proves it. The incident (`60 + 888/10 = 148.8 s` before margins) and `surge-10k` (140 s before margins, because `C / L = 50/s` binds) must stay admitted with their margins.
- [ ] Task 16 lowered the seeded `admin-failure-path` stock from 200 to 90 only to pass admission under the old estimate. If the re-fitted estimator admits 200 with reasonable headroom, restore it; otherwise keep 90 and record the figures.
- [ ] Add two or three sentences to the dashboard's About section, in the part that explains how the queue protects the ERP: the worker is configured with the ERP's declared capacity, which is the common case with mainstream ERP and SaaS APIs that publish their limits; when a downstream limit is unknown or variable, an adaptive client-side limiter (for example the adaptive retry mode of the AWS SDKs) is the appropriate technique, and the demo deliberately shows the common case. Match the surrounding tone and keep it short; adjust the existing About sentences that would now be inaccurate.
- [ ] Update the rows of [calibration criteria](calibration_criteria.md) that list pacing and estimator parameters, and this backlog's index.

## Non-goals

No worker change (task 17b), no change to the admission endpoints, rejection payload or preview flow, no runtime progress UI (task 18), no final calibration (task 20).

## Acceptance and validation

- [ ] For each scenario measured in task 17b, the estimate is above the measured finalization time and no longer several times larger: report estimate, measurement and ratio in the completion notes.
- [ ] All seeded presets and acceptance fixtures are admitted; a genuinely over-budget scenario is still rejected with an attributable bottleneck and guidance.
- [ ] The About copy is present, accurate and in English; web tests covering the page still pass.
- [ ] Run Biome on touched files, `pnpm type-check`, `pnpm test:unit`, focused contracts, API-unit and web tests; `pnpm test:infra:up`, `pnpm test:api` and `pnpm test:integration --concurrency=1` because the seed and the estimate contracts are touched. Do not run `pnpm test:composition` or `pnpm test:characterization`. No new runtime measurement is required; reuse task 17b's.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). All artifacts in English. Report executed and skipped checks honestly. Altering D11's envelope or D14's targets requires explicit user approval.

## Completion handoff

Deliver the re-fitted versioned estimator, the vocabulary cleanup, the preset decision and the About copy. Record the formula, constants, the estimate-versus-measurement table and the final `admin-failure-path` values. Next: [18 — runtime progress and grace notice](18_build_runtime_progress_and_grace_notice.md).
