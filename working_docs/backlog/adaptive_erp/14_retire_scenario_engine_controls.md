# 14 — Retire scenario-level engine controls coherently

## Handoff

- Status: Done (staged, not committed).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 14 of 21. Execute after [13](13_add_automatic_run_reset.md); the worker and lifecycle no longer depend on the legacy retry/drain policy.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phases 1 and 4, D07, D08 and D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: shared configuration contracts and coordinated API, worker, load-orchestrator, seed and web consumers.

## Objective and fixed rules

Presets describe the experiment; a versioned internal worker policy describes processing protection. Remove obsolete knobs everywhere they can still influence new runs, while keeping historic snapshots readable without rewriting them. This is one coordinated runnable producer/consumer cleanup, not a new policy algorithm.

Remove `retryPolicy` (`maxAttempts`, `initialBackoffMs`), `drainTimeoutSeconds`, `circuitBreakerFailureThreshold`, `circuitBreakerResetTimeoutMs`, and `erpConfig.requestTimeoutMs` from new presets, accepted scenario snapshots, forms, active readers and the load-orchestrator journal. No new run uses the old 300-second drain failure or emits `business_drain_timeout`.

Keep traffic, inventory (`startingStock`, `quantityPerCheckout`, `reservationHoldMinutes`), ERP latency/capacity/error rate, admin-only forced outage, and `orderProcessConcurrency`. Keep `pendingPersistenceRetryAfterSeconds`: it controls reservation persistence, not ERP abandonment.

## Repository entry points

Use task 01's consumer inventory. Start with `packages/contracts/src/{demo,erp,queue,run-result,public-runtime-policy-validation}.ts`, DB scenario seeds/readers, `apps/worker/src/application/run-config.ts`, worker runtime config, `apps/api/src/services/demo-run-service.ts`, API retry-policy resolvers/publishers, the scenario snapshot and journal readers in `apps/load-orchestrator/`, and draft/form/preset presentation in `apps/web/`. Include `.env.example` files and the local configuration reference where a setting is actually changed. Verify concrete callers before removing symbols.

## Implementation work

- [x] Remove retired fields from current input schemas, seeded preset definitions, snapshot producers, serialization and journal writers in the same slice. Update all affected consumers/tests rather than leaving hidden default fallbacks.
- [x] Persist the engine-policy version with each newly accepted run. Ensure the worker's actual policy/version agrees with that evidence; no browser-supplied internal constants or scenario overrides may change pacing, retries or deadlines.
- [x] Keep a narrow historical read path that accepts and ignores retired fields in old snapshots. Preserve original stored content and incident history; do not use historical compatibility as permission for new input to configure retired behavior.
- [x] Remove obsolete form inputs, validation hints, summaries and translations/copy that imply users control retry exhaustion or drain expiry. Keep new admission/runtime UI work for tasks 17–18; this task only removes now-invalid controls and keeps the dashboard runnable.
- [x] Remove temporary adapters explicitly recorded by earlier tasks, unused ERP retry resolvers and dead imports caused by this work. Preserve unrelated reservation persistence and notification policies. Do not globally delete every symbol called `maxAttempts` without checking ownership.
- [x] Retire the recovery-attempt ceiling that task 05 stranded when it removed recovery-attempt exhaustion escalation: `ORDER_RECOVERY_MAX_ATTEMPTS` and `orderRecoveryMaxAttempts` in `apps/worker/src/runtime/config.ts`, the `maxRecoveryAttempts` dependency option in `apps/worker/src/application/order-recovery-scanner.ts`, its wiring in `apps/worker/src/index.ts`, the entries in `apps/worker/.env.example` and `docs/local_development.md`, and the unit fixture that still supplies it. The value is parsed and passed but never read. The same scanner's summary also still declares and logs `escalated` as a hardcoded `0`: either remove the field or restore a real count. It is worker-internal with no API or dashboard consumer, so neither change touches a contract.
- [x] Drop the queue parameters that task 05's `attempts: 1` cutover made inert: the ignored `_options` argument and its meaningless `backoff` option in `apps/api/src/queue/bullmq-order-process-job-publisher.ts`, and the unused `_token` parameter in `apps/worker/src/queue/bullmq-order-process-consumer.ts`. Confirm no remaining caller depends on their shape before changing the signatures.
- [x] Separate network deadline bounds, recovery/publication leases and operational warnings. No removed knob may return as an order-failure default, environment-only deadline or maintenance cancellation.
- [x] Update load-orchestrator accepted configuration/journal parsing and restart tests so a journal does not resurrect retired settings. Current writers use the new format; prior persisted evidence remains readable where the repository supports it.
- [x] Remove the contract scaffolding prepared for features the plan does not contain, with its tests and re-exports: the ERP condition profile schemas in `packages/contracts/src/erp-profile.ts` and every reference to them in `acceptance-fixtures.ts`, `estimate.ts`, `index.ts` and the contract tests. The `finite-outage`, `latency-increase` and low-capacity fixtures keep their scenario and expected counts; they describe a condition change that a test applies through the mock's existing chaos controls, not a profile. Confirm with a repository search that nothing else consumes the removed symbols.

## Acceptance and validation

- [x] New preset/custom requests and snapshots contain only supported scenario parameters; retired settings cannot affect worker policy or finalization.
- [x] Existing seeded public presets still parse, including `surge-10k`; public 10,000-buyer capacity is not reduced.
- [x] Historical snapshots containing the retired fields remain readable and unchanged. The incident's data is not migrated or rebuilt.
- [x] Reservation-persistence retry settings and supported notification recovery remain intact; changed journals recover correctly after restart.
- [x] Run focused contracts, seed, API, worker, orchestrator and web tests; `pnpm type-check`; `pnpm test:unit`; and `pnpm test:infra:up` before affected API/integration lanes. Search all retired names and classify remaining historical/unrelated references in the handoff.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome. Use Linux/Dev Container execution and isolated resources, no unsolicited composition/characterization or runtime reset. All artifacts are English. Report executed/skipped checks and remaining compatibility boundaries; locked decisions require explicit approval to change.

## Completion handoff

Deliver the coordinated retirement with a list of removed and intentionally retained references. Record engine-version persistence and historical parsing behavior. Next: [15 — conservative duration estimator](15_implement_conservative_duration_estimator.md).

## Completion notes (2026-09-21)

Status: implemented on `feat/adaptive-erp-and-admission`, staged-ready but **not committed**; leave the commit hash pending.

### Removed per area

- **Contracts** (`packages/contracts/src/`): `retryPolicy` (`maxAttempts`, `initialBackoffMs`), `drainTimeoutSeconds`, `circuitBreakerFailureThreshold`, `circuitBreakerResetTimeoutMs` removed from `backpressureConfigSchema`; `requestTimeoutMs` removed from `erpRunConfigSchema`. `retryPolicySchema` and `erp-profile.ts` (with `erpProfileSchema`, `acceptedErpProfileSchema`, `erpProfileAnchorSchema`) deleted; re-exports, `estimate.ts`'s `profile` input, and the `profile` field on acceptance fixtures removed. The `finite-outage`, `latency-increase`, and low-capacity fixtures keep their `config` and exact expected counts; the outage/latency segments moved into their descriptions (tests apply them through the mock's chaos controls). `acceptedRunConfigWriteSchema`, `saveDemoPresetRequestSchema`, `startDemoRunRequestSchema` (via the shared snapshot schema), and `trafficExecutionStartRequestSchema` are strict, so new input containing a retired field is rejected.
- **DB** (`packages/db/`): seed presets carry only the supported backpressure/ERP fields; the seed-time JSONB backfill block (`ERP_CIRCUIT_*`, `ORDER_PROCESS_MAX_ATTEMPTS`, `ORDER_PROCESS_BACKOFF_BASE_MS`) removed. New generated migration `0012_retire_scenario_engine_controls` adds nullable `demo_runs.engine_policy_name`/`engine_policy_version`; `0011` and earlier untouched; `migration-metadata.test.ts` expects 13 journal entries.
- **API**: `services/run-retry-policy-resolver.ts`, `queue/postgres-run-retry-policy-resolver.ts` and their test deleted (no live caller remained — the resolver was threaded but `.resolve()` was never invoked). `OrderProcessJobPublishOptions`/`retryPolicy` and the publisher's inert `retryOptions`/`backoff` removed (`attempts: 1` retained); `runRetryPolicyResolver` removed from `ReserveOrderService`, the pending-persistence recovery service/factory, and the composition root; `orderProcessMaxAttempts`/`orderProcessBackoffBaseMs`/`demoRunDrainTimeoutSeconds` removed from `ApiConfig`; the unused `drainTimeoutSeconds` option removed from `DemoRunFinalizationService`. Run acceptance (`DemoRunLifecycleService.createAcceptedRun`) writes the shared engine-policy identity columns.
- **Worker**: `ORDER_RECOVERY_MAX_ATTEMPTS`/`orderRecoveryMaxAttempts` and the scanner's `maxRecoveryAttempts` option removed; the hardcoded `escalated: 0` field removed from the scan summary (worker-internal, no consumer). `ERP_REQUEST_TIMEOUT_MS`, `ERP_CIRCUIT_FAILURE_THRESHOLD`, `ERP_CIRCUIT_RESET_TIMEOUT_MS` removed from worker config. The confirmation client's `dispatch` now requires the adaptive policy's request deadline (the snapshot-timeout task-08 adapter fallback is gone); the client's remaining local network bound is `lookupTimeoutMs` (status lookups only), wired from `adaptiveErpAdmissionPolicy.initialRequestDeadlineMs` — not environment-configurable. The consumer's unused `_token` parameter and the worker publisher's inert `retryOptions`/`backoff` removed; the publication fence no longer loads/validates the stored snapshot just to feed the retired retry budget (`operation` takes no snapshot).
- **Load orchestrator**: journal reads use a historical read boundary; writers keep the strict materialized schema. Restart/recovery proven by a pre-retirement journal fixture (see tests).
- **Web**: retired form inputs (`ERP timeout ms`, `Drain timeout seconds`, `Circuit failure threshold`, `Circuit reset timeout ms`), effective-preview rows, run-history fact rows, policy comparison groups (`retry`, `backpressureTimeouts`), server-field maps, the `requestTimeoutMs` advanced-issue classification, and related copy removed. Dashboard runs (web unit suite green).
- **Docs/env**: `apps/api/.env.example`, `.env.example`, `apps/worker/.env.example`, `docs/local_development.md` (four retired rows + drain paragraph), and the `cross_service_conventions.md` formatter example updated. `docker-compose.yml` no longer forwards the retired env names to any service, and `scripts/runtime-smoke.mjs` computes its run deadline from a fixed harness-owned tail allowance (`RUNTIME_SMOKE_RUN_TIMEOUT_MS` override unchanged), so no retired setting can affect new runs through the smoke/composition lanes.

### Engine-policy persistence choice

The identity is defined once in contracts: `adaptiveErpAdmissionEnginePolicyIdentity = { name: "adaptive-erp-admission", version: 1 }` (validated by `enginePolicyIdentitySchema` in `processing-control.ts`). Run acceptance persists it in dedicated nullable `demo_runs` columns via migration `0012` (nullable so it applies to a populated database; no rewrite of stored rows). The worker's `adaptiveErpAdmissionPolicy.version` string is derived from that constant (`"adaptive-erp-admission-v1"`), so the API-persisted evidence and the running policy cannot drift. Focused tests: the API test asserts an accepted run row carries exactly the shared identity; a worker unit test asserts the policy version equals the shared constant. No browser-supplied value or scenario override can influence it (the constant is not exposed through any input schema).

### Historical parsing behavior

- `historicalAcceptedRunConfigSnapshotSchema` (contracts) is the read boundary for persisted `demo_runs.config_snapshot` (API `parsePersistedAcceptedRunConfigSnapshot`, worker `parsePersistedRunConfig`): supported fields keep materialized rigor, retired knobs are accepted and stripped, so nothing retired can survive into a new snapshot.
- `historicalTrafficExecutionStartRequestSchema` is the journal read boundary; the strict materialized schema still governs writers. Proven with fixtures: an old-format snapshot (API finalization test, worker reader integration test, contracts tests) and an old-format journal restart test in the load orchestrator (restart-readable, retired knobs ignored, and the post-cancellation rewrite verified to contain only the current format).
- Compatibility boundary (review ruling, 2026-09-21): a pre-retirement load-orchestrator journal is read through the stripping schema, and any later state transition rewrites it in the current format without the retired fields. This is accepted: the journal is operational state of in-flight executions, the task requires that "a journal does not resurrect retired settings" and that current writers use the new format, and per the 2026-09-21 user decision no stored content is worth preserving. Accepted-run snapshots in PostgreSQL are not rewritten by anything in this task; `business_drain_timeout` failure rows keep parsing.

### `business_drain_timeout` classification

Kept, read-only historical. No code path emits it (task 10 removed the producer), but `internalRunFailureReasonSchema.parse` guards persisted `failure_reason` text on read paths (run history, projections, terminal transitions), so removing the literal would break old rows. Comment added at the vocabulary; no new run can produce it.

### Intentionally retained references (classified)

- **Guard rows (kept)**: HTTP-client `requestTimeoutMs` in `apps/api/src/services/traffic-execution-gateway.ts` and `apps/load-orchestrator/src/application/api-client.ts` (unrelated same-named option); pending-persistence `maxAttempts`/`initialBackoffMs` policy, `pendingPersistenceRetryAfterSeconds`, and `PENDING_PERSISTENCE_RECOVERY_MAX_ATTEMPTS` (reservation persistence); traffic/inventory/ERP latency/capacity/error-rate/forced-outage/`orderProcessConcurrency`; `markEscalated` on the recovery persistence (owned by tasks 02/05/06; dead in the scanner interface but out of task 14's ownership).
- **Removed after review (cycle 2)**: the retired env forwarding in `docker-compose.yml` (`ORDER_PROCESS_MAX_ATTEMPTS`, `ORDER_PROCESS_BACKOFF_BASE_MS`, `DEMO_RUN_DRAIN_TIMEOUT_SECONDS`, `ERP_REQUEST_TIMEOUT_MS`, `ERP_CIRCUIT_FAILURE_THRESHOLD`, `ERP_CIRCUIT_RESET_TIMEOUT_MS`) and the `DEMO_RUN_DRAIN_TIMEOUT_SECONDS` forwarding in `scripts/composition-characterization.mjs`; `scripts/runtime-smoke.mjs` now derives its run deadline from a fixed harness-owned tail allowance instead of the retired drain knob (the earlier "inert plumbing" classification was wrong — the smoke cleanup requests an admin reset when its deadline expires, so the retired setting still affected new runs). `scripts/runtime-smoke.test.mjs` does not cover that calculation; no test change needed. An earlier mechanical edit had also stripped guard-row HTTP-client `requestTimeoutMs` overrides in tests; those were restored (`traffic-execution-gateway.test.ts` ×4, `api.test.ts` and `load-orchestrator.test.ts` load-orchestrator clients).
- **Historical (kept read-only)**: `business_drain_timeout` in the failure vocabulary (above).

### Checks executed

Cycle 1: `pnpm test:unit` (all packages + scripts, pass), `pnpm test:infra:up` (containers started), `pnpm test:api` (pass), `pnpm test:integration` (6 packages pass; db 6 files / 83 tests, worker 10 files / 100 tests), `pnpm test:db:migrate` (rebuild from migrations incl. `0012` on a populated database), `pnpm type-check` and `pnpm type-check:test` (clean), Biome check on touched files.

Cycle 2 (review fixes: smoke deadline, compose env forwarding, guard-row test restores, fixture wording, docs): Biome check on touched files, `pnpm type-check`, `pnpm test:unit`, `pnpm test:api` re-run (50 files / 634 tests passed), `pnpm test:unit` 10/10 tasks green, type-check clean. The authoritative doc `docs/architecture.md` now names the policy `adaptive-erp-admission-v1`. Not run (per instructions): `pnpm test:composition`, `pnpm test:characterization`, `pnpm runtime:*`. `pnpm format:check` keeps its two known pre-existing offenders untouched.
