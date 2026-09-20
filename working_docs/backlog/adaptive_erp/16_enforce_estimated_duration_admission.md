# 16 — Enforce estimated-duration admission at preview and run start

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 16 of 21. Execute after [15](15_implement_conservative_duration_estimator.md); use its API-owned versioned estimator.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 5, sections 5 and 7, D11 and D12. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API effective-policy, preview/run-start application services and shared contracts.

## Objective and fixed rules

Enforce the initial 600-second conservative estimated-occupancy ceiling for dashboard public and admin preset/custom starts. Keep the setting at the effective demo policy/deployment-ceiling boundary, never in worker business logic. There is no bypass in either mode. The estimate is an internal admission mechanism: it is not persisted with the run and nothing about it is shown once the run is accepted. The runtime limit is the separate automatic reset of task 13.

Start must resolve authoritative inputs and recompute under the existing admission serialization. That recomputation is the only authority; a preview is advisory and nothing the browser submits about an estimate is read. Reject before a run is created, inventory is allocated, traffic starts or a visitor budget is consumed. Preserve authentication, CSRF, hard parameter caps, one-nonterminal-run serialization and existing public budgets.

## Repository entry points

`apps/api/src/services/{demo-run-service,public-runtime-policy-service}.ts`, `apps/api/src/routes/demo-run-routes.ts`, existing preset/custom resolvers and visitor-budget adapters, `packages/contracts/src/{demo,estimate,public-runtime-policy-validation,run-result}.ts`, and corresponding API/service tests. Reuse existing bounded read/auth and runtime wiring conventions; new routes remain thin.

## Implementation work

- [ ] Add the occupancy setting with initial 600-second effective value and deployment ceiling through the current policy service. Apply to both public/admin preset/custom launches without weakening other caps or providing a normal bypass.
- [ ] Expose side-effect-free bounded estimate preview through existing public/admin access controls and read rate limiting. Resolve the same scenario/policy as start; previews create no run, inventory, slot, queue work or visitor-budget reservation.
- [ ] Under existing start serialization, resolve the current preset/custom snapshot and effective deployment/policy, then recompute the estimate and decide. Never accept a browser-supplied duration or decision.
- [ ] Reject a conservative duration above the effective ceiling or an unestimable scenario with structured reason, duration when finite, bottleneck, ceiling, versions and useful adjustment guidance. Exactly-equal values are admitted; display rounding must not change the decision.
- [ ] Remove the contract scaffolding prepared for a preview fingerprint and a persisted estimate, with its tests and re-exports: `estimateFingerprintSchema`, the `fingerprint` field of `estimatePreviewSchema`, `estimateStaleRejectionSchema`, `acceptedEstimateSnapshotSchema` and the `estimateObservation*` schemas in `packages/contracts/src/estimate.ts`. Confirm with a repository search that nothing else consumes them.
- [ ] Keep rejected starts side-effect-free even under concurrent start/preview, changed preset, changed policy and failed validation. Do not burn a public start token before the estimation check succeeds.

## Acceptance and validation

- [ ] API tests prove below/equal/above-ceiling behavior in public and admin modes, forced-outage/unestimable rejection, duplicate-aware estimates and admissibility of incident/public presets.
- [ ] A preset or policy changed between preview and start is decided by the start-time recomputation alone: still under the ceiling it starts, above it is rejected with zero side effects.
- [ ] A tampered client duration cannot bypass enforcement. Unauthorized/CSRF-invalid calls retain existing protections.
- [ ] Concurrent starts preserve one-run admission; rejected and preview requests consume no visitor start budget or inventory and launch no k6 work.
- [ ] Run focused services/contracts tests, `pnpm type-check`, `pnpm test:infra:up` and `pnpm test:api`.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep workflows in services, dependencies explicit and clients in composition roots. Format/check touched supported files with Biome; use Linux/Dev Container and isolated resources. No schema change is expected. No reference-data wipe or unsolicited composition/characterization. Report actual/skipped checks and preserve locked decisions.

## Completion handoff

Deliver authoritative preview/start enforcement and side-effect tests. Record endpoint/contracts, serialization order and policy settings. Next: [17 — dashboard admission preview](17_build_dashboard_estimate_and_admission_flow.md).
