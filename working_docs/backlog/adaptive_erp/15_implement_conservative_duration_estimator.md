# 15 — Implement the conservative duration estimator

## Handoff

- Status: Done (pending commit).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 15 of 21. Execute after [14](14_retire_scenario_engine_controls.md); corrected processing behavior is available for initial measurements.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 5, section 7, D11 and D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: a small pure API application estimation service and its tests. API enforcement is task 16.

## Objective and fixed rules

Estimate demo occupancy from run acceptance through expected business/notification settlement. The worker learns from responses; this estimator uses declared scenario conditions and effective deployment limits. Contracts contain schemas/types, not the authoritative formula; React never implements a second estimator.

The first-version conservative envelope is `start delay + traffic budget + ERP processing envelope + notification cost + calibrated margins`. Constant-arrival traffic budget is `durationSeconds`; buyer-spike budget is `maxDurationSeconds`. The explanatory ideal may show overlap, but only the conservative value decides admission.

For constant conditions, `N` is maximum unique acceptable orders from unique checkout intent, stock and quantity; `C` is minimum of per-run and deployed worker concurrency; `L` is latency in seconds including a nonzero overhead floor; `r = min(declared capacity, C / L)` gives the ideal base. The provisional processing envelope additionally models policy-v1 pacing and transient cooldowns, as specified in the implementation addendum and completion notes below. Duplicate HTTP attempts do not multiply `N`.

## Repository entry points

`apps/api/src/services/demo-run-service.ts`, existing effective policy service, `packages/contracts/src/{demo,erp,public-runtime-policy-validation}.ts`, task 01's fixtures, existing seeded scenarios and the load-orchestrator's accepted traffic-shape semantics. Add the estimator beside API application services with explicit inputs; it must not construct clients, mutate state or import worker implementation internals.

## Implementation work

- [x] Resolve unique intent correctly for both traffic modes, idempotent duplicate scenarios, stock/quantity truncation, zero acceptable stock and finite arrivals. Derive from the actual scenario contract rather than equating emitted HTTP count with orders.
- [x] Compute effective concurrency using the deployed ceiling, not only browser/preset input. Apply a nonzero latency/processing overhead floor and bounded arithmetic; reject unsupported values through existing contracts rather than inventing throughput.
- [x] Include independent transient-error expected demand `1 / (1 - p)` with the policy margin and retry/cooldown overhead. A rate above the estimator's supported policy maximum, a forced outage, or 100% persistent transient failure is unestimable, not zero duration.
- [x] Apply scenario support checks before the zero-work shortcut: a forced outage or an error rate above the supported policy maximum remains unestimable and rejected even when `N = 0`. For supported scenarios with zero accepted work, include no ERP demand or artificial division by zero, while configured start/traffic occupancy still matters. Do not label an expected demand factor or safety margin a worst-case bound or confidence interval.
- [x] Return explanatory/conservative values, bottleneck, assumptions, policy/estimator versions, effective ceiling, allowed/rejected decision and actionable reasons. Admit when conservative duration is at most the effective ceiling, initially 600 seconds; compare before display rounding.
- [x] Collect small isolated corrected-runtime measurements to choose provisional adaptation/persistence/notification margins and document the environment/assumptions. Final tuning/approval stays task 20; do not hide estimator uncertainty or claim final calibration now.
- [x] Keep reference sanity checks: incident `60 + 888 / 10 = 148.8 s` and `surge-10k` `120 + 1000 / 250 = 124 s` before margins. Both must remain admissible after supported calibrated margins. Do not hide a worker defect by rejecting the original incident or reducing the public burst.

## Acceptance and validation

- [x] Unit tests cover both traffic shapes, duplicates, partial quantity, zero accepted work/latency, deployment concurrency, and constant conditions with exact boundary timing.
- [x] Tests cover just below, equal to and just above 600 seconds (and a lower effective ceiling), and unsupported/unestimable cases.
- [x] Zero acceptable stock combined with a forced outage or an error rate above the supported maximum is rejected as unestimable without duration figures; a supported zero-work scenario retains start/traffic occupancy and has no ERP demand.
- [x] The incident and seeded public presets remain admissible; a genuinely over-budget scenario is rejected with an attributable bottleneck and adjustment guidance.
- [x] Model tests use pure inputs/injected clocks; initial measurements are explicitly isolated and reported. Run focused API/contracts tests, `pnpm test:unit` and `pnpm type-check`; use test infrastructure only for actual measurement/integration boundaries.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check touched supported files with Biome; use Linux/Dev Container execution. No unsolicited composition/characterization, reference-runtime reset or confidence claims. Report tested assumptions, chosen provisional constants and checks. Altering D11's envelope or D14's targets requires explicit user approval.

## Completion handoff

Deliver the pure versioned estimator and fixtures. Record formula, arrival/duplicate semantics, error support limit, provisional margins and initial evidence. Next: [16 — authoritative admission](16_enforce_estimated_duration_admission.md).


### Completion notes

The pure API service `estimateDemoDuration(input, effectiveCeilingSeconds = 600)` returns a contract-valid result, with shared `conservative-duration-estimator` v1 and `adaptive-erp-admission` v1 identities. Contracts own identities, schemas and vocabulary; the API service owns the formula/constants. No route, admission enforcement, policy setting, UI, worker import, I/O or clock was added to the estimator. Task 16's fingerprint/stale-preview/accepted-estimate/observation scaffolding remains intact.

- `C` is supplied explicitly using `effectiveEstimatorWorkerConcurrency(perRunConcurrency) = min(perRunConcurrency, 10)`. Worker startup rejects a deployed concurrency below 10; accepted per-run concurrency is capped at 10. This assumption is returned with results.
- The k6 generator sends `trafficConfig.quantityPerAttempt` as the request quantity. `inventoryConfig.quantityPerCheckout` is not used by that generated checkout path. `N = min(unique intents, floor(startingStock / quantityPerAttempt))`. Constant-arrival intents are `ratePerSecond * durationSeconds`; the generator guards its finite planned iteration count. Buyer-spike intents are `buyerCount`; duplicate attempts reuse each buyer's idempotency key and never multiply `N`.
- `trafficBudget` is constant-arrival `durationSeconds` or spike `maxDurationSeconds`. `L = (declaredLatencyMs + 50)/1000`; ideal rate `q = min(declaredCapacity, C/L)`; sustainable rate `r = min(q, 20)`.
- `p` is a fraction in `[0, 1]`. Demand `D = N` at zero errors, otherwise `N/(1-p)*1.25`. With `r0 = min(2,r)`, `a = 0.1`, `tr = (r-r0)/a`, and `Dr = r0*tr + a*tr²/2`, ramp time `T = (sqrt(r0²+2*a*D)-r0)/a` when `D <= Dr`, otherwise `tr+(D-Dr)/r`.
- Cooldown `E = (D-N)*5`. Conservative occupancy is `startDelay + trafficBudget + 2*T + E + 15`. Supported zero work skips ERP demand and retains `startDelay + trafficBudget + 15`. Explanatory ideal is `startDelay + max(trafficBudget, N/q)` without margins. Admission compares the unrounded conservative result inclusively to the explicit effective ceiling.
- Forced outage is checked first; then `p > 0.3` (including 100% errors). Both reject as unestimable with no duration fields, even for zero stock. Estimator input now enforces the existing 5000 ms deployment latency ceiling.
- Traffic is the bottleneck when `startDelay + trafficBudget >= 2*T + E`. Otherwise binding-rate ties favor declared capacity, then pacing ceiling (`adaptive_pacing`, a new vocabulary value), then C/L. The latter is `erp_latency` when declared latency is at least 1000 ms, otherwise `worker_concurrency`. Optional result `reasons` carries actionable rejection guidance.

All constants live in one exported API-service object: latency overhead 50 ms; initial launch rate 2/s; ramp 0.1/s²; launch ceiling 20/s; adaptation multiplier 2; transient demand multiplier 1.25; cooldown 5 s per excess call; settlement overhead 15 s; supported maximum error fraction 0.3. These are provisional, chosen by task 15 from small measurements, frozen only by task 20. They are neither worst-case bounds nor confidence intervals.

All five actual seeded public presets and all six acceptance fixtures are admitted. Tests capture the real seed script's values with database/Redis/environment dependencies mocked; no seed data is copied or infrastructure used. The seeded `admin-failure-path` is estimable but rejected (worker-concurrency bottleneck plus substantial retry/cooldown overhead at p=0.25); other seeded admin presets are admitted. Finite-outage/latency-increase fixtures are estimated from their declared base configuration, not their later externally injected chaos windows.

Arithmetic discrepancies in the briefing are recorded without changing D11/D14 or the requested model: the historical capacity-only checks remain `60 + 888/10 = 148.8` and `120 + 1000/250 = 124`. For the actual surge seed, C=10 and L=(150+50)/1000 give q=50/s, so the concurrency-aware pre-margin base is **140 s**, not 124 s. Tests retain the historical 124 s reference separately and assert the real base and admission. The specified error-case formula gives T=27.69696 s and conservative **249.14392 s**, not the approximate 248 s in the addendum.

Files changed: `packages/contracts/src/estimate.ts`, `packages/contracts/test/estimate.test.ts`, `apps/api/src/services/demo-duration-estimator.ts`, `apps/api/test/unit/demo-duration-estimator.test.ts`, `apps/api/package.json`, `apps/api/vitest.unit.config.ts`, `apps/api/vitest.api.config.ts`, and this task, `calibration_criteria.md`, `index.md`. The API previously had no unit lane; a dedicated `test/unit` lane and API-lane exclusion now keep these tests infrastructure-free.

### Initial measurements

Evidence supplied by the orchestrator, not rerun by this implementation: reference runtime wiped and rebuilt from this branch at commit `088a66ff`, Docker Compose on the dev container, one worker replica, engine policy `adaptive-erp-admission` v1. `pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`, and `pnpm runtime:smoke` passed. Runs were started through `POST /demo/runs/start` with `presetSlug: "public-custom"` and a `configOverride`. Timings were read from PostgreSQL `demo_runs`, `orders.confirmed_at`, `simulated_notifications.recorded_at`, and `erp_attempts`. Seconds below are measured from run acceptance. All runs completed with exact accounting and zero failed orders.

| Scenario | N | Declared r = min(cap, C/L) | Traffic end | Last confirmation | Last notification | Finalized | ERP attempts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Constant 10/s × 10 s, stock 60, ERP 5/s @200 ms, C=5 | 60 | 5/s | 10.09 | 55.16 | 55.17 | 60.12 | 60 |
| Incident: constant 25/s × 60 s, stock 888, ERP 10/s @250 ms, C=5 | 888 | 10/s | 60.08 | 196.33 | 196.34 | 199.20 | 889 (one 429) |
| Buyer spike 300 (duplicates on), max 10 s, stock 300, ERP 100/s @50 ms, C=10 | 300 | 100/s | 2.55 | 112.46 | 112.47 | 114.44 | 300 |
| Constant 10/s × 10 s, stock 60, ERP 10/s @100 ms, p=0.2, C=5 | 60 | 10/s | 10.13 | 79.03 | 79.04 | 83.89 | 73 (13 × 503) |

Notification lag after confirmation was approximately 10 ms; finalization followed settlement by 2–5 s, supporting the fixed settlement overhead. Plain N/r substantially understated processing time: pacing starts near 2 launches/s, ramps additively (nominally +1/s per 10 s window, observed slower), and never exceeds 20 launches/s regardless of declared capacity. A transient 503 pauses the run's ERP scope for approximately 5 s. The observed 73 attempts for 60 successes at p=0.2 is consistent with expected demand factor 1.25. The provisional estimates (65, 316.6, 145, and 249.14392 s respectively) cover all four measured finalized times; tests assert this evidence.

Limitations: one run per scenario, no repetitions, one machine, single worker replica, no confidence claim. These observations inform provisional estimator assumptions, not final task-20 calibration or proof of D14 stabilized throughput.

### Follow-ups

Observed worker throughput stays far below the declared ERP capacity and below the nominal pacing ramp, and decays as the backlog shrinks (e.g. 1 confirmation/s against a declared 5/s with 45 orders waiting; incident tail 54 -> 7 confirmations per 10 s after a single 429). The D14 stabilized-throughput target (>= 8/s at 10/s) is at risk; to be investigated by tasks 19/20. The estimator margins above are fitted to this observed behaviour and should be re-fitted if the worker pacing is corrected.

### Validation

- `pnpm exec biome check --write` on all 10 touched paths: exit 0, "Checked 7 files in 173ms. Fixed 3 files." Markdown is not handled by this Biome configuration.
- `pnpm type-check`: exit 0; "11 successful, 11 total" package/build tasks, followed by successful `tsc -p tsconfig.test.json --noEmit`.
- `pnpm test:unit`: exit 0; environment-safety tests 7/7, script tests 54/54, package unit tests 1,430/1,430 across 91 files; Turbo "11 successful, 11 total". The unrelated web browser-workflow suite emitted a React unawaited `act` warning but passed.
- Focused `pnpm --filter api test:unit`: exit 0, 1 file / 8 tests passed. `pnpm --filter @checkout-surge/contracts test:unit`: exit 0, 9 files / 188 tests passed.
- `git diff --check`: exit 0. Final self-review checked scope, phase/package boundaries, contract consistency, vocabulary, relevant tests and simplicity.

Initial focused runs caught missing methods in the seed I/O mocks and corrected the error-case expected arithmetic; these were fixed before the passing runs above. No production seed behavior was changed. No API infrastructure tests were added or modified; their lane only excludes the new unit directory. No Docker/runtime, composition or characterization commands were run by this implementer. No files were staged or committed. The two reported pre-existing workspace formatting offenders were not changed.
