# 14 — Retire scenario-level engine controls coherently

## Handoff

- Status: Pending.
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

- [ ] Remove retired fields from current input schemas, seeded preset definitions, snapshot producers, serialization and journal writers in the same slice. Update all affected consumers/tests rather than leaving hidden default fallbacks.
- [ ] Persist the engine-policy version with each newly accepted run. Ensure the worker's actual policy/version agrees with that evidence; no browser-supplied internal constants or scenario overrides may change pacing, retries or deadlines.
- [ ] Keep a narrow historical read path that accepts and ignores retired fields in old snapshots. Preserve original stored content and incident history; do not use historical compatibility as permission for new input to configure retired behavior.
- [ ] Remove obsolete form inputs, validation hints, summaries and translations/copy that imply users control retry exhaustion or drain expiry. Keep new admission/runtime UI work for tasks 17–18; this task only removes now-invalid controls and keeps the dashboard runnable.
- [ ] Remove temporary adapters explicitly recorded by earlier tasks, unused ERP retry resolvers and dead imports caused by this work. Preserve unrelated reservation persistence and notification policies. Do not globally delete every symbol called `maxAttempts` without checking ownership.
- [ ] Retire the recovery-attempt ceiling that task 05 stranded when it removed recovery-attempt exhaustion escalation: `ORDER_RECOVERY_MAX_ATTEMPTS` and `orderRecoveryMaxAttempts` in `apps/worker/src/runtime/config.ts`, the `maxRecoveryAttempts` dependency option in `apps/worker/src/application/order-recovery-scanner.ts`, its wiring in `apps/worker/src/index.ts`, the entries in `apps/worker/.env.example` and `docs/local_development.md`, and the unit fixture that still supplies it. The value is parsed and passed but never read. The same scanner's summary also still declares and logs `escalated` as a hardcoded `0`: either remove the field or restore a real count. It is worker-internal with no API or dashboard consumer, so neither change touches a contract.
- [ ] Drop the queue parameters that task 05's `attempts: 1` cutover made inert: the ignored `_options` argument and its meaningless `backoff` option in `apps/api/src/queue/bullmq-order-process-job-publisher.ts`, and the unused `_token` parameter in `apps/worker/src/queue/bullmq-order-process-consumer.ts`. Confirm no remaining caller depends on their shape before changing the signatures.
- [ ] Separate network deadline bounds, recovery/publication leases and operational warnings. No removed knob may return as an order-failure default, environment-only deadline or maintenance cancellation.
- [ ] Update load-orchestrator accepted configuration/journal parsing and restart tests so a journal does not resurrect retired settings. Current writers use the new format; prior persisted evidence remains readable where the repository supports it.
- [ ] Remove the contract scaffolding prepared for features the plan does not contain, with its tests and re-exports: the ERP condition profile schemas in `packages/contracts/src/erp-profile.ts` and every reference to them in `acceptance-fixtures.ts`, `estimate.ts`, `index.ts` and the contract tests. The `finite-outage`, `latency-increase` and low-capacity fixtures keep their scenario and expected counts; they describe a condition change that a test applies through the mock's existing chaos controls, not a profile. Confirm with a repository search that nothing else consumes the removed symbols.

## Acceptance and validation

- [ ] New preset/custom requests and snapshots contain only supported scenario parameters; retired settings cannot affect worker policy or finalization.
- [ ] Existing seeded public presets still parse, including `surge-10k`; public 10,000-buyer capacity is not reduced.
- [ ] Historical snapshots containing the retired fields remain readable and unchanged. The incident's data is not migrated or rebuilt.
- [ ] Reservation-persistence retry settings and supported notification recovery remain intact; changed journals recover correctly after restart.
- [ ] Run focused contracts, seed, API, worker, orchestrator and web tests; `pnpm type-check`; `pnpm test:unit`; and `pnpm test:infra:up` before affected API/integration lanes. Search all retired names and classify remaining historical/unrelated references in the handoff.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check only touched supported files with Biome. Use Linux/Dev Container execution and isolated resources, no unsolicited composition/characterization or runtime reset. All artifacts are English. Report executed/skipped checks and remaining compatibility boundaries; locked decisions require explicit approval to change.

## Completion handoff

Deliver the coordinated retirement with a list of removed and intentionally retained references. Record engine-version persistence and historical parsing behavior. Next: [15 — conservative duration estimator](15_implement_conservative_duration_estimator.md).
