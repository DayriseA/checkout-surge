# 15 — Enforce estimate preview and authoritative run-start admission

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 15 of 21. Execute after [14](14_implement_conservative_duration_estimator.md); use its API-owned versioned estimator.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 6, sections 5 and 7, D11–D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API effective-policy, preview/run-start application services, persisted accepted evidence and shared contracts.

## Objective and fixed rules

Enforce the initial 600-second conservative estimated-occupancy ceiling for dashboard public and admin preset/custom starts. Keep the setting at the effective demo policy/deployment-ceiling boundary, never in worker business logic. There is no routine dashboard bypass and no runtime deadline implied by admission.

Start must resolve authoritative inputs and recompute under the existing admission serialization. Reject before a run is created, inventory is allocated, traffic starts or a visitor budget is consumed. Preserve authentication, CSRF, hard parameter caps, one-nonterminal-run serialization and existing public budgets.

## Repository entry points

`apps/api/src/services/{demo-run-service,public-runtime-policy-service}.ts`, `apps/api/src/routes/demo-run-routes.ts`, existing preset/custom resolvers and visitor-budget adapters, `packages/contracts/src/{demo,public-runtime-policy-validation,run-result}.ts`, DB run snapshot persistence, and corresponding API/service tests. Reuse existing bounded read/auth and runtime wiring conventions; new routes remain thin.

## Implementation work

- [ ] Add the occupancy setting with initial 600-second effective value and deployment ceiling through the current policy service. Apply to both public/admin preset/custom launches without weakening other caps or providing a normal bypass.
- [ ] Expose side-effect-free bounded estimate preview through existing public/admin access controls and read rate limiting. Resolve the same scenario/policy as start; previews create no run, inventory, slot, queue work or visitor-budget reservation.
- [ ] Fingerprint the normalized resolved scenario snapshot, policy version, estimator version and effective ceiling. Equivalent inputs/versions must produce the same fingerprint; observation timestamps/request ids must not manufacture staleness. Never accept a browser-supplied duration as authoritative.
- [ ] Under existing start serialization, resolve current preset/custom snapshot and effective deployment/policy, then recompute estimate and fingerprint. When a supplied fingerprint differs, return structured `estimate_stale` with the fresh preview before side effects. No fingerprint from tooling/tests skips only the stale check, never recomputation or policy enforcement.
- [ ] Reject a conservative duration above the effective ceiling or an unestimable scenario with structured reason, duration when finite, bottleneck, ceiling, versions and useful adjustment guidance. Exactly-equal values are admitted; display rounding must not change the decision.
- [ ] Persist the accepted estimate, assumptions/fingerprint and policy/estimator/engine identities with successful acceptance. Preserve the durable acceptance timestamp and profile anchor. Coordinate schema and all current readers in a runnable slice; legacy history without this evidence stays readable and explicitly unavailable.
- [ ] Keep rejected starts side-effect-free even under concurrent start/preview, changed preset, changed policy and failed validation. Do not burn a public start token before estimation and stale checks succeed.
- [ ] Provide separate over-accepted-estimate and over-occupancy-ceiling observations from actual elapsed time without terminalization. Retain the occupied run slot until genuine settlement/admin disposition. Keep any exceptional diagnostic execution isolated and protected, not a dashboard escape hatch.

## Acceptance and validation

- [ ] API tests prove below/equal/above-ceiling behavior, permanent outage/unestimable rejection, duplicate-aware estimates and admissibility of incident/public presets.
- [ ] Preset/policy/deployment/estimator changes between preview/start cause attributable stale rejection with fresh preview and zero start side effects; unchanged inputs remain usable.
- [ ] Missing fingerprint still recomputes; tampered client duration cannot bypass enforcement. Unauthorized/CSRF-invalid calls retain existing protections.
- [ ] Concurrent starts preserve one-run admission; rejected and preview requests consume no visitor start budget or inventory and launch no k6 work.
- [ ] Accepted estimate/version evidence survives restart and actual overruns remain nonterminal. Run focused services/contracts tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api` and relevant DB/integration tests.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep workflows in services, dependencies explicit and clients in composition roots. Format/check touched supported files with Biome; use Linux/Dev Container and isolated resources. Follow baseline SQL policy for schema changes; no reference-data wipe or unsolicited composition/characterization. Report actual/skipped checks and preserve locked decisions.

## Completion handoff

Deliver authoritative preview/start enforcement and side-effect tests. Record endpoint/contracts, fingerprint normalization, serialization order, policy settings and accepted evidence. Next: [16 — operational projections](16_project_operational_progress_and_history.md).
