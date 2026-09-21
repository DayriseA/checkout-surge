# 16 — Enforce estimated-duration admission at preview and run start

## Handoff

- Status: Done.
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

- [x] Add the occupancy setting with initial 600-second effective value and deployment ceiling through the current policy service. Apply to both public/admin preset/custom launches without weakening other caps or providing a normal bypass.
- [x] Expose side-effect-free bounded estimate preview through existing public/admin access controls; deployment/web-proxy read rate limiting remains task 17. Resolve the same scenario/policy as start; previews create no run, inventory, slot, queue work or visitor-budget reservation.
- [x] Under existing start serialization, resolve the current preset/custom snapshot and effective deployment/policy, then recompute the estimate and decide. Never accept a browser-supplied duration or decision.
- [x] Reject a conservative duration above the effective ceiling or an unestimable scenario with structured reason, duration when finite, bottleneck, ceiling, versions and useful adjustment guidance. Exactly-equal values are admitted; display rounding must not change the decision.
- [x] Remove the contract scaffolding prepared for a preview fingerprint and a persisted estimate, with its tests and re-exports: `estimateFingerprintSchema`, the `fingerprint` field of `estimatePreviewSchema`, `estimateStaleRejectionSchema`, `acceptedEstimateSnapshotSchema` and the `estimateObservation*` schemas in `packages/contracts/src/estimate.ts`. Confirm with a repository search that nothing else consumes them.
- [x] Keep rejected starts side-effect-free even under concurrent start/preview, changed preset, changed policy and failed validation. Do not burn a public start token before the estimation check succeeds.

## Acceptance and validation

- [x] API tests prove below/equal/above-ceiling behavior in public and admin modes, forced-outage/unestimable rejection, duplicate-aware estimates and admissibility of incident/public presets.
- [x] A preset or policy changed between preview and start is decided by the start-time recomputation alone: still under the ceiling it starts, above it is rejected with zero side effects.
- [x] A tampered client duration cannot bypass enforcement. Unauthorized/CSRF-invalid calls retain existing protections.
- [x] Concurrent starts preserve one-run admission; rejected and preview requests consume no visitor start budget or inventory and launch no k6 work.
- [x] Run focused services/contracts tests, `pnpm type-check`, `pnpm test:infra:up` and `pnpm test:api`.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep workflows in services, dependencies explicit and clients in composition roots. Format/check touched supported files with Biome; use Linux/Dev Container and isolated resources. No schema change is expected. No reference-data wipe or unsolicited composition/characterization. Report actual/skipped checks and preserve locked decisions.

## Completion handoff

Deliver authoritative preview/start enforcement and side-effect tests. Record endpoint/contracts, serialization order and policy settings. Next: [17 — dashboard admission preview](17_build_dashboard_estimate_and_admission_flow.md).

## Completion notes (2026-09-21)

Implementation includes the API/contracts/seed boundary and the explicitly authorized minimal web compatibility correction. `buildPolicyFromDraft` preserves the current server occupancy ceiling, with no new editable ceiling field. Four typed web fixtures and the policy-proxy payload fixture now include the field. No preview UI, estimate proxy route, or ceiling control was added. No files were staged or committed, and the branch was not switched. No estimator formula or constant was changed; D11/D12 remain intact.

### Endpoint and contracts for task 17

- `previewDemoRunPath`: `POST /demo/runs/estimate`; `previewDemoRunRequestSchema` aliases the existing strict `startDemoRunRequestSchema`: `{ presetSlug, configOverride?, correlationId? }`. `previewDemoRunResponseSchema` aliases `estimatePreviewSchema`: `{ result: EstimatorResult }`. Both admitted and rejected estimates return HTTP 200 with `result.decision: "admitted" | "rejected"`. Invalid configurations retain existing validation errors.
- `POST /demo/runs/start` remains HTTP 202 on acceptance. Both routes require the control-service token and `x-demo-operator-mode`; public mode additionally verifies the signed `x-public-visitor-id` credential in the lifecycle service. Existing web start CSRF enforcement is unchanged. Preview has no API read limiter; deployment/web-proxy read limiting and the new web route belong to task 17.
- Rejection uses the existing error envelope with `code: "estimated_duration_rejected"`, HTTP **400**, matching existing `invalid_runtime_policy`/`invalid_run_configuration` status mapping. The exported `estimateAdmissionRejectionDetailsSchema` / `EstimateAdmissionRejectionDetails` defines `details`: `reason: "over_ceiling"` plus `conservativeDurationSeconds`, or `reason: "unestimable"` plus `unestimableReason` and **no duration field**. Both carry `bottleneck`, `effectiveCeilingSeconds`, `estimatorIdentity`, `policyIdentity`, `assumptions`, and nonempty adjustment `reasons`. Identities remain `conservative-duration-estimator` v1 and `adaptive-erp-admission` v1.
- Extra browser fields, including fabricated duration/decision/fingerprint fields, fail strict request validation. No client estimate is read. No estimate is stored on a run or added to runtime/history output.

### Ownership and serialization

`demo-duration-admission-service.ts` maps an accepted snapshot once through `estimatorInputFromSnapshot`, supplies `effectiveEstimatorWorkerConcurrency(orderProcessConcurrency)`, invokes the unchanged pure estimator, and shapes start rejection. `DemoRunLifecycleService.previewRun` and `startRun` share `resolveValidatedConfig`, including public visibility/override rules, current public-custom policy defaults, and hard-cap validation. The existing composition-root lifecycle instance exposes the new method to the thin route; no extra client or service construction is needed.

Start ordering is credential verification and preflight authoritative resolution/validation, then transaction advisory lock, nonterminal-run conflict, incomplete-reset conflict, **fresh policy and preset reads on that transaction connection**, validation and estimation, public budget reservation using that fresh policy, generated offer/run/context inserts, commit, inventory initialization, and traffic start. Conflict wins over estimate rejection. Optional transaction-bound read dependencies on the existing preset/policy readers avoid a nested pool checkout (tested with a one-connection pool). Inventory and traffic use the snapshot actually accepted under the lock, not the preflight snapshot. Preview performs only reads and estimation and never takes the lock.

### Policy and seed

- Mutable/effective setting: `estimatedDemoOccupancyCeilingSeconds`, a positive finite number (fractional seconds supported), default 600. A schema default hydrates legacy JSON rows; no migration or backfill is needed.
- Deployment cap: `deploymentHardCaps.estimatedDemoOccupancyCeilingSeconds`, default and maximum 600. All existing deployment hard caps have environment variables, so `DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS` follows that pattern (positive integer, at most 600), with API/root env examples, Compose forwarding, and local-development documentation updated. A lower deployment cap requires a policy value within it, as with existing cap validation.
- Above-cap policy updates return HTTP 400 `invalid_runtime_policy`, violation `public_limit_estimated_demo_occupancy_exceeds_deployment_cap`, with `value`, `cap`, and the setting path. Lowering applies equally to public/admin, preset/custom starts. There is no admin exemption.
- `admin-failure-path` changes **only stock 200 → 90**. Constant traffic stays **15/s × 12 s**, preallocated/max VUs **10/60**, ERP **300 ms / 30 TPS / 0.25 error rate**, and concurrency **4**. The actual unchanged estimator gives **747 seconds → 403.619037896906 seconds**, preserving meaningful transient-failure traffic with headroom below 450 seconds. All eight actual seeded presets (five public, three admin) and the six acceptance fixtures remain admitted at 600 seconds; the public 10,000-buyer capability is unchanged.
- `overwriteOnConflict: false` preserves an already-seeded admin preset's scenario; reseeding only repairs its system-provenance marker when necessary. Existing databases therefore retain stock 200 until wiped or explicitly edited. No migration/backfill was added, per the development-database wipe convention; this task did not wipe a reference runtime.

### Removed scaffolding and search

Removed the fingerprint, stale-preview, accepted-estimate snapshot, and observation schemas/types/tests from `estimate.ts`; its wildcard index export now exposes only the retained/new contracts. Updated the live estimator inventory in `index.md`. Repository `rg --hidden` search for all removed symbol families, excluding `node_modules`, `.tmp`, `.git`, `.next`, and `.turbo`, found **no live source/test consumers**. The only remaining matches were task 01's historical completion note and this task's removal checklist; both intentionally document the removed work.

### Acceptance evidence

Service tests cover public/admin preset/custom boundaries, unrounded inclusive equality using the computed duration as a fractional policy ceiling, just-above rejection before any budget reservation, unestimable outage/error-rate rejection without duration, duplicate-aware previews, the incident, public preset admission, preview validation and preview while the start lock is held, deterministic conflict precedence, and existing concurrent-start protection. Real two-connection advisory-lock tests change policy or preset after preview/preflight while start waits: fresh under-ceiling values start and over-ceiling values reject. The successful preset-change case changes both ERP capacity (250 → 200 TPS) and starting stock (1000 → 90) after preview/preflight; it asserts the returned snapshot, the generated sale offer's `allocatedStock`, Redis `allocatedStock`/`remainingStock`, and the entire `configSnapshot` passed to the traffic gateway against those start-time values. Rejection assertions cover empty run/offer tables, empty Redis, untouched budget reserve/release functions, and no traffic gateway calls. Route tests cover token/mode protection, tampered bodies, rejected preview HTTP 200, structured start HTTP 400, and trusted principal forwarding; service tests verify invalid visitor credentials for both methods. Contracts test both rejection shapes and strict preview/start intent. Seed tests capture actual seed definitions with I/O mocks and reuse the production snapshot mapper.

### Validation

- `pnpm exec biome check --write <touched paths>`: exit 0. Final pass: **19 supported files checked, no fixes applied** (the first pass fixed 13). Markdown/env/Compose paths are not formatted by this Biome configuration. `git diff --check`: exit 0.
- Final `pnpm type-check`: **exit 0**, Turbo **11 successful / 11 total** (8 cached), followed by successful workspace `tsc -p tsconfig.test.json --noEmit`. The initial five web type errors are resolved by the authorized compatibility correction.
- Final `pnpm test:unit`: **exit 0**. Environment safety **7/7**, script tests **54/54**, and package unit tests **1,430/1,430 across 91 files** passed, including web **790/790**, contracts **188/188**, and API estimator **8/8**. Turbo **11 successful / 11 total** (9 cached). The original web policy-proxy failure is resolved; the unrelated React unawaited `act` warning remains non-failing.
- Web compatibility formatting: `pnpm exec biome check --write` on the six changed web files exited 0 (**6 files checked; 2 fixed**); final touched-file formatting and `git diff --check` also passed.
- `pnpm test:infra:up`: exit 0; isolated PostgreSQL and Redis healthy.
- `pnpm test:api`: exit 0; **50 files / 649 tests**, Turbo **4/4 tasks**. After adding the two custom-boundary cases and the preview-with-lock/validation case, the final focused API command (`pnpm --filter api test:api test/demo-run-service.test.ts test/public-runtime-policy-service.test.ts test/runtime-config.test.ts`) passed **3 files / 98 tests**. The full lane was not redundantly rerun for these test-only additions.
- Reviewer coverage correction: extended the existing successful preset-change case (no new test) to assert start-time stock in Redis and the generated offer, and the full start-time traffic snapshot. `pnpm exec biome check --write apps/api/test/demo-run-service.test.ts`: exit 0, **1 file checked / 1 fixed**. `pnpm --filter api test:api test/demo-run-service.test.ts`: exit 0, **1 file / 53 tests passed**, duration **26.56 seconds**. `git diff --check`: exit 0.
- `pnpm test:integration`: initial parallel run failed the unrelated DB Pub/Sub test because it received the concurrently running worker suite's `corr-worker-integration` dirty signal rather than `corr-dashboard-dirty`; DB **82 passed / 1 failed**, mock ERP **6/6**, worker interrupted by Turbo. The sequential rerun (`pnpm test:integration --concurrency=1`) passed, exit 0: **17 files / 190 tests** (DB **83**, mock ERP **6**, worker **101**), Turbo **6/6 tasks**. No unrelated test or Pub/Sub implementation was changed.
- `pnpm format:check`: exit 1, **four pre-existing formatting offenders**, all untouched: the two reported paths (`apps/mock-erp/src/persistence/postgres-confirmation-ledger.ts`, `packages/db/drizzle/meta/0007_snapshot.json`) plus `packages/db/drizzle/meta/0012_snapshot.json` and `packages/db/drizzle/meta/_journal.json`. Actual output: **527 files checked, 4 errors**.
- Not run: composition, characterization, reference-runtime commands, migration generation, staging or commits.

Final self-review: scope/phase and package boundaries respected; thin routes; no new infrastructure clients; one snapshot mapper and unchanged estimator; no estimate persistence; status/error contracts and tests agree at the API boundary. The web compatibility correction preserves the server-owned value without extending task 17's UI/proxy scope.

### Compatibility correction and follow-ups

The orchestrator explicitly authorized the minimal web compatibility work after the initial handoff. `apps/web/src/app/lib/admin-drafts.ts` now copies `currentPolicy.estimatedDemoOccupancyCeilingSeconds` into the mutable policy save. The existing focused draft round-trip test now starts from **123.456 seconds**, edits unrelated policy fields, and verifies the lowered server value survives. The four typed policy fixtures and the admin policy-proxy payload fixture were updated to include mutable/deployment ceilings. This resolves the initial five TypeScript errors and proxy-test failure; these were consequences of this task's contract change, not pre-existing failures. Task 17 no longer needs to perform this compatibility work.

Task 17 retains only its planned preview UI, request ordering/cancellation, web proxy/Origin/read-limiting boundary, rejection presentation, and hiding estimates after acceptance. Final estimator calibration remains task 20. No unrelated dead code was removed.

The formatting offenders `packages/db/drizzle/meta/0012_snapshot.json` and `packages/db/drizzle/meta/_journal.json` are **pre-existing at HEAD**. Stash-free verification: `git status --short -- <both paths>` produced no output and `git diff HEAD --exit-code -- <both paths>` exited 0. Neither file was modified or formatted by this task. They remain listed alongside the two previously reported formatting offenders above.

### Changed files

- API services: new `apps/api/src/services/demo-duration-admission-service.ts`; changed `demo-run-service.ts`, `demo-preset-service.ts`, and `public-runtime-policy-service.ts`; thin route `apps/api/src/routes/demo-run-routes.ts`; config `apps/api/src/runtime/config.ts`.
- API tests: `apps/api/test/api.test.ts`, `demo-run-service.test.ts`, `demo-administration-test-fixtures.ts`, `public-runtime-policy-service.test.ts`, `runtime-config.test.ts`, and `unit/demo-duration-estimator.test.ts`.
- Contracts: `packages/contracts/src/demo.ts`, `estimate.ts`, `error.ts`, `public-runtime-policy-validation.ts`; tests `packages/contracts/test/estimate.test.ts` and `contracts.test.ts`. The existing wildcard re-export in `src/index.ts` needs no edit.
- Web compatibility only: `apps/web/src/app/lib/admin-drafts.ts`; tests `apps/web/test/admin-drafts.test.ts`, `admin-controller-state.test.tsx`, `browser-workflows.test.ts`, `dashboard-control-surface.test.ts`, and `admin-control-proxy.test.ts`.
- Seed/deployment: `packages/db/src/scripts/seed.ts`, `.env.example`, `apps/api/.env.example`, `docker-compose.yml`.
- Documentation: `docs/architecture.md`, `docs/admin_access_protection.md`, `docs/local_development.md`, this task, and `working_docs/backlog/adaptive_erp/index.md`.
