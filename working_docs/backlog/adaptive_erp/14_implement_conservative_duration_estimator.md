# 14 — Implement the conservative duration estimator

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 14 of 21. Execute after [13](13_add_reproducible_admin_erp_profiles.md); corrected processing/profile behavior is available for initial measurements.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 6, section 7, D10, D11 and D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: a small pure API application estimation service and its tests. API enforcement is task 15.

## Objective and fixed rules

Estimate demo occupancy from run acceptance through expected business/notification settlement. The worker learns from responses; this estimator uses declared scenario conditions and effective deployment limits. Contracts contain schemas/types, not the authoritative formula; React never implements a second estimator.

The first-version conservative envelope is `start delay + traffic budget + ERP processing envelope + notification cost + calibrated margins`. Constant-arrival traffic budget is `durationSeconds`; buyer-spike budget is `maxDurationSeconds`. The explanatory ideal may show overlap, but only the conservative value decides admission.

For constant conditions, `N` is maximum unique acceptable orders from unique checkout intent, stock and quantity; `C` is minimum of per-run and deployed worker concurrency; `L` is latency in seconds including a nonzero overhead floor; `r = min(declared capacity, C / L)` and ERP envelope is `N / r`. Duplicate HTTP attempts do not multiply `N`.

## Repository entry points

`apps/api/src/services/demo-run-service.ts`, existing effective policy service, `packages/contracts/src/{demo,erp,public-runtime-policy-validation}.ts`, task 01's fixtures and task 13's profile definitions, existing seeded scenarios and the load-orchestrator's accepted traffic-shape semantics. Add the estimator beside API application services with explicit inputs; it must not construct clients, mutate state or import worker implementation internals.

## Implementation work

- [ ] Resolve unique intent correctly for both traffic modes, idempotent duplicate scenarios, stock/quantity truncation, zero acceptable stock and finite arrivals. Derive from the actual scenario contract rather than equating emitted HTTP count with orders.
- [ ] Compute effective concurrency using the deployed ceiling, not only browser/preset input. Apply a nonzero latency/processing overhead floor and bounded arithmetic; reject unsupported values through existing contracts rather than inventing throughput.
- [ ] For profiles, integrate the outstanding service demand against the finite capacity/latency/outage segments from the defined anchor and base recovery tail. Count scheduled downtime once at its defined place; do not add both a separate outage duration and an already-integrated outage penalty. Keep the conservative traffic-plus-processing envelope explicit.
- [ ] Include independent transient-error expected demand `1 / (1 - p)` with the policy margin and retry/cooldown overhead. A rate above the estimator's supported policy maximum, permanent outage, 100% persistent transient failure, or unsupported recovery horizon is unestimable, not zero duration.
- [ ] Handle zero accepted work deliberately: no ERP demand or artificial division by zero, while configured start/traffic occupancy still matters. Do not label an expected demand factor or safety margin a worst-case bound or confidence interval.
- [ ] Return explanatory/conservative values, bottleneck, assumptions, policy/estimator versions, effective ceiling, allowed/rejected decision and actionable reasons. Admit when conservative duration is at most the effective ceiling, initially 600 seconds; compare before display rounding.
- [ ] Collect small isolated corrected-runtime measurements to choose provisional adaptation/persistence/notification margins and document the environment/assumptions. Final tuning/approval stays task 20; do not hide estimator uncertainty or claim final calibration now.
- [ ] Keep reference sanity checks: incident `60 + 888 / 10 = 148.8 s` and `surge-10k` `120 + 1000 / 250 = 124 s` before margins. Both must remain admissible after supported calibrated margins. Do not hide a worker defect by rejecting the original incident or reducing the public burst.

## Acceptance and validation

- [ ] Unit tests cover both traffic shapes, duplicates, partial quantity, zero accepted work/latency, deployment concurrency, constant conditions and finite profiles with exact boundary timing.
- [ ] Tests cover just below, equal to and just above 600 seconds (and a lower effective ceiling), unsupported/unestimable cases, and no double-counted downtime.
- [ ] The incident and seeded public presets remain admissible; a genuinely over-budget scenario is rejected with an attributable bottleneck and adjustment guidance.
- [ ] Model tests use pure inputs/injected clocks; initial measurements are explicitly isolated and reported. Run focused API/contracts tests, `pnpm test:unit` and `pnpm type-check`; use test infrastructure only for actual measurement/integration boundaries.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check touched supported files with Biome; use Linux/Dev Container execution. No unsolicited composition/characterization, reference-runtime reset or confidence claims. Report tested assumptions, chosen provisional constants and checks. Altering D11's envelope or D14's targets requires explicit user approval.

## Completion handoff

Deliver the pure versioned estimator and fixtures. Record formula, arrival/duplicate semantics, profile integration, error support limit, provisional margins and initial evidence. Next: [15 — authoritative admission](15_enforce_estimate_preview_and_start_admission.md).
