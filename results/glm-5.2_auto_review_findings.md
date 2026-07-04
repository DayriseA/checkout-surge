# Phase 1–10 Final Review — Consolidated Findings

This document consolidates the eight per-area review slices
(`findings_slice_1.md` … `findings_slice_8.md` in `working_docs/review/`) into a
single list of findings, with repetitions removed.

Each slice reviewed a distinct area but some concerns overlapped. The following
deduplication was applied:

- **Merged (single finding).** "Worker readiness check `notification_record_worker_running`
  is contracted/documented but never emitted" appeared as Slice 6 Finding 2 **and**
  Slice 7 Finding 3. They are the same issue and are merged here as
  **Finding 22** (its evidence combines both slices).
- **Kept separate (cross-referenced where noted).** A few findings share context but
  describe different defects and remain distinct entries:
  - **Finding 19** (fail-closed secret check) is a config/ops-hardening gap that the
    slice flagged as overlapping Slice 7's scope, but Slice 7 produced no duplicate
    finding about secrets.
  - **Finding 25** (documented per-package test commands do not exist) and
    **Finding 30** (the only real-k6 test silently skips in the unit lane) both touch
    load-orchestrator test scripts but report different problems.

Severities are preserved verbatim from the slices. The sections below keep the original
review areas (slices) so navigation maps to the source slices.

---

## Index

| # | Area | Finding | Severity |
|---|------|---------|----------|
| 1 | API reservation hot path | No Redis-first run-sale eligibility gate on the buy hot path | HIGH |
| 2 | API reservation hot path | Realtime publications awaited synchronously on the buy hot path | MEDIUM |
| 3 | Persistence / domain state / seeds | Startup reconciliation reports a run as reconciled when it did not fail it | MEDIUM |
| 4 | Persistence / domain state / seeds | `getRunSecuredVsConfirmed` counts all reservation statuses, not just `secured` | LOW |
| 5 | Persistence / domain state / seeds | Preset mutation adapters return `preset_not_found` for a config-validation failure | LOW |
| 6 | Persistence / domain state / seeds | `seedDemoData` silently overwrites admin/API-owned editable rows on re-run | LOW |
| 7 | Worker / queue / mock ERP / notifications | Run-scoped ERP behavior and backpressure captured in the run snapshot are never applied | HIGH |
| 8 | Worker / queue / mock ERP / notifications | Circuit breaker half-open allows multiple concurrent trial calls | LOW–MEDIUM |
| 9 | Worker / queue / mock ERP / notifications | Production worker has no BullMQ retry; unexpected throws strand orders in `processing` | LOW |
| 10 | Run lifecycle / load orchestration / finalization | Finalization writes summary + transition non-atomically; `already_finalized` strands the run in `draining` forever | HIGH |
| 11 | Run lifecycle / load orchestration / finalization | `trafficDeliveryStatus` carries mixed execution-vs-delivery vocabulary; classified delivery status discarded on the draining path | MEDIUM |
| 12 | Run lifecycle / load orchestration / finalization | The one-current-run start gate is a TOCTOU read-then-write; concurrent starts can create two overlapping runs | MEDIUM |
| 13 | Run lifecycle / load orchestration / finalization | The finalization poller does not serialize ticks | LOW |
| 14 | Run lifecycle / load orchestration / finalization | k6 metrics streaming re-reads/re-parses the whole output file every window (quadratic) | LOW |
| 15 | Run lifecycle / load orchestration / finalization | Finalization does not wait for post-confirmation notifications; `notificationsRecorded` undercounts | LOW |
| 16 | Dashboard / realtime / admin / history | Live Watch observes a static seeded sale offer, not the active run's generated offer | HIGH |
| 17 | Dashboard / realtime / admin / history | Public run start promises a `/watch` redirect that never happens | MEDIUM |
| 18 | Dashboard / realtime / admin / history | No client-side recovery re-fetch on SSE reconnect or terminal run events; recovery-sourced counts freeze | MEDIUM |
| 19 | Dashboard / realtime / admin / history | "Fail-closed" secret strength check accepts the committed dev sentinel; no startup validation forces an override | LOW |
| 20 | Dashboard / realtime / admin / history | Public "Demo Picker" cards are decorative: fictional preset slugs and no start action | LOW |
| 21 | Shared contracts / logging / vocabulary | Stable error codes returned by every service are absent from the documented `ERROR_CODES` vocabulary | MEDIUM |
| 22 | Shared contracts / runtime / ops *(merged: slices 6 & 7)* | Worker readiness check `notification_record_worker_running` is contracted and documented but never emitted | MEDIUM |
| 23 | Shared contracts / logging / vocabulary | `IsoTimestamp` accepts any non-empty string; timezone clarity not enforced at the contract boundary | LOW |
| 24 | Shared contracts / logging / vocabulary | `OrderReadResponseSchema` types order/reservation `status` as a free-form string instead of the canonical enum schemas | LOW |
| 25 | Runtime / configuration / ops | Documented per-package test commands do not exist | MEDIUM |
| 26 | Runtime / configuration / ops | Load-orchestrator Dockerfile builds the entire workspace | LOW–MEDIUM |
| 27 | Runtime / configuration / ops | Compose project names are not worktree-isolated despite the docs guaranteeing it | LOW–MEDIUM |
| 28 | Runtime / configuration / ops | `infra:down` tears down the whole project, not just PostgreSQL/Redis | LOW |
| 29 | Runtime / configuration / ops | Caddy has no healthcheck; `runtime:up --wait` can report success without proving the public entry point serves | LOW |
| 30 | Test suite quality | The only real-k6 behavioral test runs in the infrastructure-free unit lane and silently skips when k6 is absent (suite stays green) | HIGH |
| 31 | Test suite quality | `x-load-run-id` header-agreement "matching/absent" cases assert only the absence of a validation path | LOW |

Severity totals: **5 HIGH**, **9 MEDIUM**, **3 LOW–MEDIUM**, **14 LOW** (31 findings).

---

## Section 1 — API Reservation Hot Path

Scope: `apps/api` reservation/buy path + Redis inventory code
(`packages/db/src/inventory/*`, persistence adapter).
(Verified-correct parts intentionally not enumerated: atomic Lua oversell prevention,
idempotency replay/conflict, sold-out cheap path, pending-persistence `order: null`,
queue hand-off after durable write, thin `buy` route, `x-load-run-id` header agreement.)

### Finding 1 — No Redis-first run-sale eligibility gate on the buy hot path (HIGH)

The atomic reservation gate is the documented eligibility signal, but it decides
eligibility **only** from the per-`saleOfferId` inventory `:state` hash existence. It
never validates the request `runId` against the offer's owning run, nor the run's
accepting-traffic lifecycle. There is no Redis run-scoped eligibility payload.

**Evidence**

- `packages/db/src/inventory/reservation-gate.ts:201-205` — the Lua only does
  `HGET :state remainingStock`; absent → `not_initialized`. `runId` is unused for the
  eligibility decision.
- Inventory keys are scoped by `saleOfferId` only
  (`packages/db/src/inventory/redis-keys.ts:21-26`), not by run.
- `apps/api/src/app/services/reserve-order-service.ts:36-40` explicitly states:
  *"The documented Redis run-scoped eligibility payload keyed by runId does not exist
  yet (it lands with the demo-run lifecycle)"* — but the demo-run lifecycle
  (Task 10.3) is implemented (`packages/db/src/run-lifecycle/run-lifecycle.ts`) and
  never added it.
- The contract disagrees with the implementation:
  `packages/contracts/src/buy.ts:80-82` says `runId`+`saleOfferId` are sent *"so the
  API can validate run sale eligibility from the cached record without querying
  PostgreSQL on the losing path"*, and `buy.ts:173-175` defines `not_initialized` as
  *"The run/sale pair is missing, mismatched, or no longer accepting traffic … the run
  has moved past the accepting-traffic lifecycle."*
- `apps/api/tests/buy-run-attribution.integration.test.ts:187-209` proves the mismatch
  path "degrades to `reservation_pending_persistence`" but asserts nothing about Redis
  stock — masking the leak.

**Impact A — wrong-`runId` stock leak + permanent pending-persistence pollution.**
`/buy` is unauthenticated (`apps/api/src/app/routes/buy.ts:15-44`). A generated offer
bought under a non-owning `runId`:

1. passes the gate and decrements Redis stock (`reservation-gate.ts:215-217`);
2. `resolveDurableRunId` returns `null` for the mismatch
   (`reserve-order-service.ts:294-307`);
3. the durable write is rejected by the ownership trigger
   (`packages/db/migrations/0000_burly_random.sql:308-352`: generated offer requires
   `run_id = owner`);
4. the flow lands in the partial-failure branch and records a pending-persistence
   sentinel (`reserve-order-service.ts:537-585`).

That hold can **never** reconcile: every retry carries the wrong `runId`, so
`resolveDurableRunId` keeps returning `null` and the trigger keeps rejecting. Net
effect: Redis stock is permanently leaked and `pendingPersistenceCount` is permanently
inflated. Because there is no reservation-expiry release worker either, leaked holds
never return to `remainingStock`. A client hammering `/buy` with the active run's
`saleOfferId` + an arbitrary wrong `runId` drains the live demo's stock into
unreconcilable holds.

**Impact B — stale/closed runs remain buyable.** Normal finalization does **not** tear
down the run's Redis inventory state and does **not** deactivate its generated sale
offer (only admin reset and startup reconciliation do: `reset-service.ts:325-332`,
`run-lifecycle.ts:147-159`). Since the gate keys eligibility only on inventory-state
existence, a buy against a finalized run's offer (with its own `runId`) still succeeds:
it decrements stock and inserts a fresh reservation/order/events onto a run whose
immutable summary is already written (so the summary is stale, and
`acceptedReservations`/`soldOut` totals no longer match durable rows).
`cleanupOldGeneratedRuns` (`run-maintenance.ts:190-258`) eventually clears Redis for
runs beyond the latest-15 retention, but the just-completed run plus retained history
stay buyable in the window.

The same gap means the seeded catalog offer (which has live inventory:
`packages/db/src/seed-data.ts:385`) accepts any `runId` with null attribution —
possibly intended for catalog, but it is indistinguishable from a run-scoped offer at
the gate.

**Suggested direction.** Add a Redis-first run-sale eligibility signal written when a
run goes `active` and cleared on terminalization/reset (runId↔saleOfferId ownership +
accepting-traffic status), and consult it in the gate before the stock decision so
wrong-run / stale / closed / catalog offers return `not_initialized` on the cheap path
(matching the contract). At minimum, the hot path must not decrement stock for a
`runId` that cannot own the offer.

### Finding 2 — Realtime publications are awaited synchronously on the buy hot path in production (MEDIUM / performance)

Now that Task 6.1 wired a real Redis Pub/Sub publisher in the composition root
(`apps/api/src/index.ts:66`), every accepted reservation serializes several awaited
publishes (and Redis reads) before responding:

- `reserve-order-service.ts:518` awaits `publishSecuredInventoryDrain`, which performs
  an **extra** `getInventoryState` Redis round trip (`hgetall` + `zcount`,
  `apps/api/src/app/services/inventory-drain.ts:58-73`) then `publisher.publish`.
- `reserve-order-service.ts:239` awaits `publishOrderQueued` (publish), and after
  enqueue `reserve-order-service.ts:273` awaits `publishQueueDepth`, which does a
  `queue.getJobCounts` Redis round trip + publish
  (`apps/api/src/app/services/queue-drain.ts:44-73`).

These are still `await`ed despite the modules' own notes saying publication would
*"switch to fire-and-forget when it wires a real channel"* (`inventory-drain.ts:19-20`,
`queue-drain.ts:18-19`, `order-queued.ts:17-18`) — which has now happened. For the
one-second spike the winning path is: gate → PG attribution read → Redis state read →
PUBLISH → durable PG transaction → PUBLISH → `queue.add` → `getJobCounts` → PUBLISH.
The publications remain best-effort (won't fail the buy), but the synchronous awaits add
per-buy latency to the public surge target and contradict the documented
fire-and-forget intent.

Separately, the `getInventoryState` read in `publishSecuredInventoryDrain` is
redundant: the Lua gate already computed the post-decrement
`remainingStock`/`reservedStock` (`reservation-gate.ts:216-218`) but does not surface
them, so the TS layer re-reads them solely to publish.

**Suggested direction.** Make hot-path realtime publication fire-and-forget (queue onto
a background channel/setImmediate, swallow backpressure) now that the transport is live,
and/or return the post-decrement counters from the gate so `publishSecuredInventoryDrain`
does not re-read Redis per buy.

---

## Section 2 — Persistence, Domain State, And Seeds

Scope: `packages/db` (schema, migrations/triggers, seed/reset helpers, run-lifecycle +
inventory persistence adapters) and the persistence adapters in `apps/api` /
`apps/worker` that own durable business writes.
(Verified-correct parts intentionally not enumerated: FK + uniqueness graph,
run-attribution PL/pgSQL triggers, write-once immutable summaries via
`onConflictDoNothing`, FK-safe maintenance delete ordering, sold-out aggregate
surviving via `onConflictDoUpdate`, seed-time contract validation, generated-run offer
purpose enforcement.)

### Finding 3 — Startup reconciliation reports a run as reconciled even when it did not fail it (MEDIUM)

`reconcileInterruptedRunsOnStartup` selects `starting`/`active` runs, then per run fails
the run inside a transaction guarded by `status in (starting, active)`. When that guarded
update matches **zero** rows (a concurrent transition moved the run out of
`starting`/`active` between the SELECT and the UPDATE), the transaction correctly skips
the summary write via an early `return` — but the enclosing loop still pushes the run
into the returned `reconciled` array unconditionally.

**Evidence**

- `packages/db/src/run-lifecycle/run-lifecycle.ts:215-218` — the early `return` only
  aborts the transaction callback; execution continues after `await db.transaction(...)`.
- `packages/db/src/run-lifecycle/run-lifecycle.ts:253-258` —
  `reconciled.push({ runId, presetName, saleOfferId, previousStatus })` runs for **every**
  selected run regardless of whether the guarded update transitioned anything.
- The caller fans out a `run.failed` realtime event for each entry:
  `apps/api/src/app/services/run-lifecycle-service.ts:101-112`
  (`for (const run of reconciled) { await publisher.publish(runFailedEvent(run, occurredAt)); }`)
  and logs an inflated `count` (`run-lifecycle-service.ts:114-119`).
- The code's own comment at `run-lifecycle.ts:216` states the intent ("leave the summary
  to that path") for the zero-match case, but the result array contradicts it. The
  existing tests (`packages/db/tests/run-lifecycle.integration.test.ts:259-316`) only
  cover the happy fail path and the fully-idempotent second pass (where the SELECT itself
  returns nothing); the SELECT-hits / UPDATE-misses race is uncovered.

**Impact.** A run that legitimately transitions `active -> draining` (traffic-end
reported by the orchestrator/finalization poller) during the API startup window is not
failed by reconciliation, yet the dashboard receives a spurious `run.failed` SSE event
for it and the startup log overstates the reconciled count. The run then continues to
drain/finalize normally, so operators see a "failed" event for a run that completes — a
stale/incorrect realtime signal contradicting the durable `demo_runs` truth. With more
than one API instance the race widens (two reconciliations, one wins the update, the
other still reports).

**Suggested direction.** Only push to `reconciled` when the guarded update actually
transitioned (move the push inside the `failed.length > 0` branch, or have the
transaction return a `transitioned` boolean and push on it), so the returned set
reflects runs this reconciliation actually failed.

### Finding 4 — `getRunSecuredVsConfirmed` counts all reservation statuses, not just `secured` (LOW / latent)

`acceptedReservations` is documented as "Durable reservations secured (reservation status
`secured`)", but the query counts every reservation row for the run with no status
filter.

**Evidence**

- `packages/db/src/run-lifecycle/run-recovery.ts:40-43` — interface doc: *"Durable
  reservations secured (reservation status `secured`) for the run."*
- `packages/db/src/run-lifecycle/run-recovery.ts:116-117` —
  `db.select({ value: count() }).from(reservations).where(eq(reservations.runId, runId))`
  (no `status = 'secured'` predicate), unlike the sibling order-by-status counts below it
  which do filter.

**Impact.** No observable bug today: the only reservation writer
(`createSecuredReservationWithOrder`) always inserts `status: "secured"`, and no
`update(reservations)` release/expiry path exists yet (verified — no writes of
`rejected`/`released`/`expired`). So the count is currently correct. But the contract is
wrong: the moment a release/expiry transition persists non-`secured` rows, this counter
silently inflates `acceptedReservations` in every summary that consumes it (startup
reconciliation `run-lifecycle.ts:242`, admin reset `reset-service.ts:194`, normal
finalization `run-finalization-service.ts:302`).

**Suggested direction.** Add `eq(reservations.status, "secured")` to match the documented
semantic (and the analogous orders-by-status filters), so the read stays correct when
reservation lifecycle writes broaden.

### Finding 5 — Preset mutation adapters return `preset_not_found` for a config-validation failure (LOW)

`saveDemoPreset`, `duplicateDemoPreset`, and `copyToCustomPreset` each re-parse the config
through `DemoPresetConfigSchema.safeParse` as a defensive check, but on a parse failure
they return `code: "preset_not_found"` — conflating a validation failure with a missing
preset.

**Evidence**

- `packages/db/src/run-lifecycle/preset-management.ts:88-89` (`saveDemoPreset`),
  `:121-122` (`duplicateDemoPreset`), `:163-164` (`copyToCustomPreset`) —
  `if (!parsed.success) return { ok: false, code: "preset_not_found" }`.
- `PresetMutationCode` (`preset-management.ts:34`) has no validation-error variant, so an
  invalid config is reported to the caller as if the preset did not exist.

**Impact.** The API service is documented to re-validate before calling these primitives,
so this branch should not fire in practice. If it ever does (a contract/schema drift, or a
future caller that skips pre-validation), the surfaced error impersonates
`preset_not_found`, which would drive a 404 / "not found" response for what is actually a
malformed/invalid config — misleading for an operator and hard to diagnose.

**Suggested direction.** Either add a `preset_config_invalid` code to `PresetMutationCode`
(and map parse failures to it), or drop the redundant defensive parse since the service
already validates upstream — but do not report a validation failure as "not found".

### Finding 6 — `seedDemoData` silently overwrites admin/API-owned editable rows on every re-run (LOW / observation)

The seed is upsert-based and treats **editable** rows the same as read-only baseline rows:
re-running it (e.g. `pnpm runtime:setup`) resets the active public runtime policy and
every editable admin preset — including the persisted `admin-custom` scratch preset — back
to the hardcoded defaults.

**Evidence**

- `packages/db/src/seed-data.ts:369-381` — `publicRuntimePolicies` upsert
  `onConflictDoUpdate` sets `policy: PUBLIC_RUNTIME_POLICY` unconditionally, overwriting
  whatever the API wrote.
- `packages/db/src/seed-data.ts:339-367` — every preset (including `visibility: "admin"`,
  `isEditable: true` rows) is upserted with `onConflictDoUpdate` rewriting
  `display`/`trafficConfig`/`inventoryConfig`/`erpConfig`/`backpressureConfig`, so operator
  edits to editable admin presets (and the `admin-custom` scratch config) are discarded.
- This contradicts the ownership model the same files assert: the API "owns" the public
  runtime policy and "may update it" (`public-runtime-policy.ts:6-9`,
  `seed-data.ts:240-244`), and admin presets are documented as editable
  (`preset-management.ts`).

**Impact.** For a fresh demo this is fine (idempotent baseline). The footgun is re-running
setup against a data set an operator has already customized: API-tuned public
budgets/limits and admin-preset tweaks are silently reverted to defaults with no warning.
This is a likely-intended "reset to baseline" behavior, but it is not called out anywhere,
so it reads as data loss.

**Suggested direction.** If re-seed is meant to reset editable state, document that
explicitly (and consider scoping the policy/admin-preset upserts to insert-only so a
populated, operator-edited baseline survives `runtime:setup`). At minimum, note that
`runtime:setup` is not additive for editable rows.

---

## Section 3 — Worker, Queue, Mock ERP, And Notifications

Scope: `apps/worker`, `apps/mock-erp`, the API `orders:process` queue producer
(`apps/api/src/app/queue/orders-process-queue.ts`, `reserve-order-service.ts` enqueue),
ERP clients/resilience, and notification code.
(Verified-correct parts intentionally not enumerated: thin route → service layering,
persist-before-side-effect ordering everywhere, monotonic ERP-attempt numbering with a
`(orderId, attemptNumber)` unique constraint, `jobId = orderId` producer-side dedup,
exponential backoff math, real mock-ERP state machine
`queued -> processing -> confirmed | failed`, idempotent terminal guards, best-effort
notification recording after confirmation, correlation-id threading.)

### Finding 7 — Run-scoped ERP behavior and backpressure captured in the run snapshot are never applied (HIGH)

The demo-run snapshot freezes `erpConfig` (`latencyMs`, `maxTps`, `errorRate`,
`forcedOutage`) and `backpressureConfig` (`enabled`, `orderProcessConcurrency`,
`circuitBreakerFailureThreshold`, `circuitBreakerResetTimeoutMs`) into
`demo_runs.configSnapshot` at start time. The architecture documents these as the live
behavior source: the worker "applies the active run's accepted backpressure policy" and
"calls the mock ERP … with the run-scoped ERP behavior", and the mock ERP "applies the
ERP behavior captured in the run snapshot" (`docs/architecture.md:57,97`;
`docs/admin_access_protection.md:123` — "normal ERP behavior comes from the run
snapshot"). Neither is wired: both services use global/environment values only and ignore
the snapshot.

**Evidence**

- `apps/mock-erp/src/app/services/erp-behavior-service.ts:22-24` states run-scoped
  behavior is "deferred to the demo-run lifecycle phase", and the seam at `:124-127`
  (`resolveControl`) always returns the retained **global** control regardless of
  `input.runId`; it is consumed at `:132`. The demo-run lifecycle (Phases 7–10) is
  implemented and never closed this seam.
- The worker sources every resilience/concurrency knob from global env, never the
  snapshot: `apps/worker/src/index.ts:76-117` builds the breaker + retry policy purely
  from `WorkerConfig`, and `apps/worker/src/app/config.ts:100-107` reads
  `ERP_CIRCUIT_FAILURE_THRESHOLD`, `ERP_CIRCUIT_RESET_TIMEOUT_MS`,
  `ORDER_PROCESS_CONCURRENCY` from the environment. `order-process-service.ts` only uses
  `data.runId` for event payloads, never to resolve run-scoped ERP/backpressure settings.
- The captured config is real and meaningful: `packages/db/src/seed-data.ts:110` and
  `:132` ship `surge-5k`/`surge-10k` with `backpressureConfig: { enabled: true }`, and
  `:197` ships `admin-steady-arrival` with `erpConfig: { latencyMs: 50, errorRate: 0.05 }`.
  The contract documents the intended effect (`packages/contracts/src/demo-control.ts:51-65`:
  "When enabled, the worker caps simultaneous in-flight downstream confirmation calls"),
  and `DemoRunConfigSnapshotSchema` (`demo-control.ts:72-101`) includes both blocks.
- `backpressureConfig` / `erpConfig` are written, validated against caps, merged on
  override (`apps/api/src/app/services/demo-run-start-service.ts:210-215`), and rendered
  on the dashboard, but have no runtime consumer — confirmed by a repo-wide search finding
  no read of either in `apps/worker` or `apps/mock-erp`.

**Impact.** The frozen, cap-validated, dashboard-displayed `erpConfig` and
`backpressureConfig` are dead configuration:

- A run started from `admin-steady-arrival` (50 ms latency, 5 % ERP errors) exhibits
  whatever the global `LATENCY_MS`/`ERROR_RATE`/`FORCED_OUTAGE` happen to be, not the
  snapshot. An operator observing "the run's ERP behavior" on the dashboard is misled.
- `backpressureConfig.enabled = true` on the headline surge presets has no effect: the
  worker's in-flight confirmation cap is the global `ORDER_PROCESS_CONCURRENCY` (default
  5) regardless of the run. The documented "excess jobs accumulate in BullMQ rather than
  piling onto the downstream system" buffer effect is not run-scoped.
- Because run-scoped behavior is absent, the **global** retained chaos control
  (`PUT /chaos`/`POST /chaos/reset`) is the only behavior source and applies to every run
  indiscriminately — i.e. "global ERP chaos settings leaking between runs" is structural,
  not accidental.

**Suggested direction.** Make `resolveControl` honor the run snapshot (pass the accepted
`erpConfig` in the confirm request, or resolve it from the run the worker already
attributes), and have the worker resolve concurrency/breaker settings from the run's
`backpressureConfig` (enriching the job payload or a per-run lookup) instead of global
env. At minimum, document the current state as a known limitation rather than describing
run-scoped behavior as implemented in `docs/architecture.md`.

### Finding 8 — Circuit breaker half-open allows multiple concurrent trial calls, not a single trial (LOW–MEDIUM)

`allow()` documents a half-open "single trial call" but implements an unconditional pass,
so under `ORDER_PROCESS_CONCURRENCY > 1` several confirmations flow during each recovery
probe instead of one.

**Evidence**

- `apps/worker/src/app/erp/circuit-breaker.ts:145-147` — the `half_open` branch returns
  `true` for every call; the inline comment says "allow the single trial call through,"
  which is not what the code does. The class doc (`:11-22`) concedes the breaker is
  "intentionally approximate across the async gap", but the per-call comment overstates
  the guarantee.
- The trial fan-out is bounded by worker concurrency (`apps/worker/src/app/config.ts:107`,
  default 5; `apps/worker/src/index.ts:113-117`). The recovery tests
  (`apps/worker/tests/erp-resilience.integration.test.ts:438-493`) drive jobs serially
  (`concurrency: 1`), so they never exercise the concurrent half-open case.

**Impact.** If the downstream is still failing when the breaker half-opens, up to
`concurrency` calls hit it in one batch before it re-opens (a partial relaxation of the
"don't hammer a failing ERP while open/recovering" property). Recovery still works (any
success closes, sustained failure re-opens), so the deviation is bounded and low-severity.

**Suggested direction.** Either enforce a single in-flight trial in half-open (e.g. a
"probe-in-flight" flag set in `allow()` and cleared on the next
`recordSuccess`/`recordFailure`), or correct the inline comment to state the approximate
multi-trial behavior explicitly.

### Finding 9 — Production worker has no BullMQ retry; unexpected throws strand orders in `processing` and the code comments assume retries that don't exist (LOW)

The in-service retry loop only handles RESULT failures (resolved `succeeded`/`failed`/
`timed_out`/`circuit_open` outcomes). An unexpected throw is meant to propagate to BullMQ,
but neither the producer nor the consumer configures BullMQ `attempts`, so there is no
BullMQ-level retry in production — the job fails after one attempt and the order is left
in `processing` with no worker-driven recovery to terminal.

**Evidence**

- Consumer sets no retry: `apps/worker/src/app/queue/orders-process-worker.ts:50-59`
  constructs the `Worker` with only `connection` + `concurrency`.
- Producer sets no retry:
  `apps/api/src/app/services/reserve-order-service.ts:262`
  `queue.add(ORDER_PROCESS_QUEUE, job, { jobId: facts.orderId })` — no
  `attempts`/`backoff`. BullMQ therefore defaults to a single attempt.
- The code nonetheless reasons as if BullMQ retries exist:
  `apps/worker/src/app/services/order-process-service.ts:163-167` — "An unexpected THROW
  propagates to BullMQ unchanged … so BullMQ-level retry and the Task 4.5 throw contract
  are preserved"; `apps/worker/src/app/services/erp-confirmation.ts:15-19` similarly
  references BullMQ's failure reporting carrying the throw.
- The async-pipeline suite simulates retry by passing `attempts: 2` at `queue.add`
  (`apps/worker/tests/order-async-pipeline.integration.test.ts:296-300` and `:338-342`),
  which does not match the production producer. Its third case (`:326-366`) asserts a
  persistently-throwing job leaves the order permanently `processing`.

**Impact.** Low probability in practice (the HTTP client translates every expected
condition to a result and wraps `fetch` in try/catch, so throws require a genuinely
unexpected error), and run finalization is protected by the drain-timeout policy
(`apps/api/src/app/services/run-finalization-service.ts:214,228-243`) so a stranded order
does not hang finalization. But the stranded order row never reaches
`confirmed`/`failed`, and the "preserved BullMQ-level retry" comments are misleading
about production behavior.

**Suggested direction.** Either configure a small BullMQ `attempts`/`backoff` on the
producer (so the documented throw-retry path actually exists) and reconcile it with the
in-service retry budget, or correct the comments to state that throws are
terminal-at-the-job-level (operator-visible in the failed set) with no automatic
re-drive. Consider a reconciliation/re-enqueue path for orders stuck in `processing`.

---

## Section 4 — Run Lifecycle, Load Orchestration, And Finalization

Scope: `apps/load-orchestrator` (traffic execution, k6 script/parser/aggregator, sinks),
the API-owned run lifecycle/finalization/recovery/start services
(`apps/api/src/app/services/run-*.ts`, `demo-run-start-service.ts`,
`traffic-completion-ingestion-service.ts`, `load-metrics-ingestion-service.ts`,
`recovery-service.ts`), `run-finalization-poller.ts`, the load-orchestrator client,
metric ingestion, recovery state, and summary creation.
(Verified-correct parts intentionally not enumerated: clean
orchestrator-owns-only-traffic/API-owns-lifecycle split, no shell interpolation in k6
argv/script, idempotent lifecycle guards, `trafficEndedAt` vs `finalizedAt` kept distinct,
traffic metrics kept separate from business outcomes, sold-out totals sourced from the
Redis aggregate not per-rejection rows, k6 success → `draining` never → terminal, clean
sold-out runs treated as expected via the response-callback override, recovery sourced
from durable truth.)

### Finding 10 — Finalization writes the summary and the lifecycle transition non-atomically; the `already_finalized` early-return then strands the run in `draining` forever (HIGH)

`finalizeRun` writes the immutable summary, then — in separate statements — upserts the
sold-out aggregate and transitions the lifecycle. If anything interrupts the run after the
summary is written but before `completeRun`/`failRun` commits, the next poller tick
observes the pre-existing summary, treats it as "already finalized", and **never retries
the transition**. The run is left permanently `draining`, which also blocks every
subsequent start (the one-current-run gate treats `draining` as blocking).

**Evidence**

- `apps/api/src/app/services/run-finalization-service.ts:337` writes the summary
  (`writeRunSummary`); `:363-379` upserts the sold-out aggregate; `:382-385` only then
  calls `completeRun`/`failRun`. There is no transaction wrapping summary + transition.
- `apps/api/src/app/services/run-finalization-service.ts:356-359` early-returns
  `already_finalized` as soon as `written === false`, with the comment "A summary already
  existed (already finalized). Do not re-transition or re-publish." That assumption
  ("summary exists ⟹ run already terminalized") is false for this service's own
  non-atomic path.
- The transition primitives are independent conditional updates
  (`packages/db/src/run-lifecycle/run-lifecycle.ts:102-112`, `:124-139`), so a crash or a
  transient DB error between the summary write and the transition leaves the row
  `draining` with a summary already present. A transient failure of `completeRun` itself
  is caught per-run at `run-finalization-service.ts:197-203` (logged,
  `{ finalized: false }`) and is likewise never retried, because the following tick
  early-returns on the existing summary.
- Nothing else recovers this state: startup reconciliation only fails `starting`/`active`
  runs (`packages/db/src/run-lifecycle/run-lifecycle.ts:184-199`); `draining` runs are
  intentionally left recoverable. So the stranded run survives restarts, and
  `findBlockingRun` includes `draining`
  (`packages/db/src/run-lifecycle/run-recovery.ts:19,270-278`), locking out new runs until
  a manual admin reset.
- The idempotency test seeds exactly this state — a `draining` row plus a pre-existing
  summary — and asserts `already_finalized` without ever transitioning the row
  (`apps/api/tests/run-finalization.integration.test.ts:634-687`), codifying the faulty
  assumption. The "second pass is a no-op" test (`:408-421`) only passes because both
  passes run to completion (no interruption between summary and transition).

**Impact.** A process kill, OOM, or a momentary DB error during the finalization window
strands the current run in `draining` indefinitely and silently blocks all future
demonstrations until an operator runs an admin reset. This is the single highest-risk
correctness gap in the slice.

**Suggested direction.** Attempt the lifecycle transition regardless of whether the
summary was freshly written (the transition is already idempotent, guarded on
`status = 'draining'`); use `written` only to decide logging/realtime re-publish.
Alternatively wrap summary + transition in one transaction, or transition first and write
the summary after.

### Finding 11 — `trafficDeliveryStatus` carries mixed execution-vs-delivery vocabulary across lifecycle events; the API-classified delivery status is computed on the draining path and then discarded (MEDIUM)

The same payload field `trafficDeliveryStatus` is populated with load-orchestrator
**execution** status (`active`/`succeeded`/`failed`) on `run.active`/`run.draining`, but
with the API-classified **delivery** status (`complete`/`warning`/`degraded`/`failed`) on
`run.completed`/`run.failed`. On the draining path the service actually computes the
classified delivery summary and then throws it away, emitting the raw execution status
instead.

**Evidence**

- `apps/api/src/app/services/traffic-completion-ingestion-service.ts:120-125` computes
  `trafficDeliverySummary` via `classifyTrafficDelivery`, but uses it only in the log
  (`:182-184`). The `active → draining` transition stores
  `trafficStatus = completed ? "succeeded" : "failed"` (`:155-158`) and the `run.draining`
  realtime event puts that same execution value into `payload.trafficDeliveryStatus`
  (`:166-173`).
- `apps/api/src/app/services/demo-run-start-service.ts:456-463` emits `run.active` with
  `payload.trafficDeliveryStatus = delegation.trafficStatus`, i.e. the orchestrator's
  `TrafficExecutionState.status` (`"active"`).
- `apps/api/src/app/services/run-finalization-service.ts:398-409` emits
  `run.completed`/`run.failed` with
  `payload.trafficDeliveryStatus = trafficDeliverySummary.trafficDeliveryStatus` — the
  classified delivery vocabulary.
- The contract field is permissive
  (`packages/contracts/src/dashboard-events.ts:78` `z.string().min(1).optional()`), so this
  does not crash, but a dashboard consumer of `trafficDeliveryStatus` receives
  `"active"`/`"succeeded"`/`"failed"` early and `"complete"`/`"warning"`/`"degraded"`/
  `"failed"` at termination from the same field.
- Naming is also inconsistent with recovery: the DB column `demo_runs.trafficStatus` is
  documented as the execution status
  (`packages/db/src/run-lifecycle/run-lifecycle.ts:45-49`) and recovery surfaces it as
  `currentRun.trafficStatus` (`apps/api/src/app/services/recovery-service.ts:85`), while
  events call the overlapping concept `trafficDeliveryStatus`.

**Impact.** The API-owned delivery classification (the whole point of "the API — not the
orchestrator — decides delivery quality") is invisible to the UI until the terminal event,
and the field's vocabulary is unstable across a run's lifetime, so any UI logic keying off
`trafficDeliveryStatus` must handle two unrelated vocabularies.

**Suggested direction.** Emit the classified `trafficDeliverySummary.trafficDeliveryStatus`
(or omit the field until classified) on `run.draining`; reconcile the recovery field
name/vocabulary with the event field, or introduce a distinct field for execution status
vs delivery status.

### Finding 12 — The one-current-run start gate is a TOCTOU read-then-write; concurrent starts can create two overlapping runs (MEDIUM)

`canStartRun()` reads for a blocking run with no lock, and the `starting` row is inserted
much later in a separate call. Two start requests that both pass the gate before either
inserts produce two recoverable runs, violating the documented one-current-run invariant.

**Evidence**

- `apps/api/src/app/services/demo-run-start-service.ts:271-275` calls `canStartRun()`
  (`findBlockingRun`, a plain `SELECT`); the run is only created at `:403-410`
  (`createDemoRun`), after preset resolution, cap validation, budget consumption, and
  product lookup.
- `createDemoRun` inserts an unconditional `starting` row with no guard against a second
  in-progress run (`packages/db/src/run-lifecycle/run-creation.ts:142-190`).
- `findCurrentRecoverableRun` returns the newest recoverable row
  (`packages/db/src/run-lifecycle/run-recovery.ts:94-104`), so the loser of the race is
  left as an orphaned `active` run that is still recoverable/consuming inventory.
- The only concurrency control is the public run budget
  (`apps/api/src/app/services/demo-run-start-service.ts:366-377`), which is a
  per-visitor/per-window counter, not a one-run-in-flight guard. With a global budget ≥ 2
  (or two distinct visitors), overlapping starts are permitted.

**Impact.** Overlapping runs corrupt the benchmark: two k6 processes run at once, inventory
accounting is split across two generated sale offers, and current-run recovery is
ambiguous. For a product whose entire purpose is controlled, isolated load runs this is a
meaningful invariant violation (low probability in single-operator use, higher under
concurrent public traffic).

**Suggested direction.** Make the gate atomic with creation — e.g. a conditional `INSERT`
guarded on no existing recoverable run, or an advisory/row lock held across the gate check
and insert — or serialize starts through a single-flight lock.

### Finding 13 — The finalization poller does not serialize ticks; slow finalization lets overlapping ticks race on the same draining run (LOW)

`setInterval` fires on a fixed cadence regardless of whether the previous tick resolved,
and the handler is fire-and-forget.

**Evidence**

- `apps/api/src/app/run-finalization-poller.ts:42-44` schedules `void tick()` on a fixed
  `setInterval`; there is no guard preventing a tick from starting while the previous one
  is still awaiting `finalizeEligibleRuns`.

**Impact.** If a tick runs longer than the poll interval (many draining runs, slow DB),
two ticks overlap and both evaluate the same draining run before either transitions it.
The idempotent guards (run-unique summary, `status = 'draining'` transition guard) prevent
duplicate artifacts in the common case, so this is benign on its own, but it multiplies
redundant DB reads and — combined with Finding 10 — widens the window in which a summary
exists without a transition.

**Suggested direction.** Self-schedule the next tick after the current one resolves
(`setTimeout`-style re-arming) instead of fixed `setInterval`, or add an in-flight guard.

### Finding 14 — k6 metrics streaming re-reads and re-parses the whole output file every window (quadratic in run length); a partially-written line can be dropped from an intermediate window (LOW)

Each flush window reads the entire growing NDJSON file and slices by a positional sample
count, which is O(samples × windows) over the run, and the positional slicing can
permanently skip a sample that was partially written in one window and completed in the
next.

**Evidence**

- `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:91-133`
  `flushWindow` reads the full output file each call; the active-run loop (`:207-219`)
  invokes it every `metricStreamIntervalMs` (default 1 s,
  `apps/load-orchestrator/src/app/config.ts:147`).
- For the documented `surge-10k` contract (~10 000 requests × 3 metrics ≈ 30 000 NDJSON
  lines), every 1 s window re-parses the whole growing file, so total parsing grows
  quadratically with run length.
- `parseK6Output` drops a malformed (partially-written) line
  (`apps/load-orchestrator/src/app/k6/output-parser.ts:33-66`). Because `flushWindow`
  slices new samples by a positional count (`traffic-execution-service.ts:105-108`), a
  line that was partial in window N (dropped, not counted) but complete in window N+1 can
  land before the slice offset and be skipped for that window.
- The terminal summary is unaffected: `reportTrafficCompletion` re-reads and re-parses the
  entire file once (`traffic-execution-service.ts:142-183` → `aggregateTrafficSummary`),
  so the durable artifact is authoritative; only an intermediate realtime sample can be
  lost.

**Impact.** CPU/memory pressure that scales with run size (relevant to the `surge-10k`
demo contract), plus minor best-effort loss of an intermediate traffic sample. No effect
on the final summary or any business invariant.

**Suggested direction.** Track a byte offset (or line count written by k6) and append-read
from there instead of re-reading the whole file each window.

### Finding 15 — Finalization does not wait for post-confirmation notifications, so a run can finalize while notifications are still missing/dropped and `notificationsRecorded` undercounts (LOW)

The "settled" gate waits for queued/processing orders and unreconciled
pending-persistence holds, but not for simulated notifications. Notifications are recorded
as a separate best-effort step *after* the order reaches `confirmed`, so finalization can
fire before they land (or after they were silently swallowed).

**Evidence**

- `apps/api/src/app/services/run-finalization-service.ts:219-226` defines `settled` as
  `queued === 0 && processing === 0 && pendingReconciliation === 0` — no notification
  condition. The summary then snapshots `notificationsRecorded`
  (`run-finalization-service.ts:296-315` via `getRunNotificationCount`).
- The worker commits the `processing → confirmed` transition first, then records the
  simulated notification in a separate, best-effort, swallow-on-failure step
  (`apps/worker/src/app/services/order-process-service.ts:276-337`); a recording failure is
  logged and the order stays confirmed with no notification row.

**Impact.** The immutable summary's `notificationsRecorded` is a point-in-time best-effort
count rather than a settled-state guarantee: a run that finalized immediately after
confirmation (or after a dropped notification) reports fewer notifications than were
intended. This matches the review prompt's "finalization happening while … missing
notifications" condition. Given notifications are documented as non-blocking background
side effects this may be intentional, but it is an accounting gap worth confirming.

**Suggested direction.** Either accept and document `notificationsRecorded` as
best-effort-at-finalization, or add a notification-pending condition to the settled gate
if a complete count is required.

---

## Section 5 — Dashboard, Realtime, Admin, And Run History

Scope: `apps/web` (pages, `components/**`, `lib/**`, `app/api/admin/**` route handlers,
`app/actions.ts`), the realtime client hook, admin session/proxy/read/control helpers, and
the public-safe DTOs the dashboard renders.
(Verified-correct parts intentionally not enumerated: same-origin browser traffic only —
no `NEXT_PUBLIC_*` backend URLs, service tokens never reach the browser, admin privilege
derived from the server-side session/service-token proxy rather than the request body,
defense-in-depth `requireAdmin` on every mutation route, constant-time
passphrase/signature compares, public-safe run-history DTO mirroring the immutable
summary, thin proxy routes that forward unvalidated bodies for API-side validation.)

### Finding 16 — Live Watch observes a static seeded sale offer, not the active run's generated offer (HIGH)

The Live Watch page reads inventory for the **default seeded** sale offer
(`ACTIVE_SALE_OFFER_ID = 00000000-0000-4000-8000-000000000010`) via the env knob
`DASHBOARD_WATCH_SALE_OFFER_ID`, and never resolves the **active run's generated** sale
offer. But every run start creates a brand-new generated sale offer with a
database-generated random id, so during any demo run the inventory-drain / request-surge
panels are pointed at the wrong offer — the static seeded offer has no reservations
written against it while the run drains a completely different offer id. This is the core
Live Watch experience being disconnected from the run it claims to watch.

This was an explicitly deferred TODO that the slice-4 lifecycle phases (Tasks 7.4/10.3)
were supposed to close, and they shipped without the dashboard-side wiring.

**Evidence**

- `apps/web/app/watch/page.tsx:39` resolves the watched offer from
  `getWatchSaleOfferId()` (env knob / seeded default) and feeds it to
  `getInventoryStatus(saleOfferId)` at `:41`, while `getDashboardRecovery()` at `:44` is
  fetched in the same `Promise.all` but its `currentRun.saleOfferId` is never used to pick
  the inventory target.
- `apps/web/lib/config.ts:18` defines `DEFAULT_WATCH_SALE_OFFER_ID` as the seeded offer;
  `:12-18` comment still claims "The dashboard follows the active/current run once the run
  lifecycle lands (project_planning.md Tasks 7.4/10.3)" — that follow-the-run wiring was
  never added.
- `working_docs/implementation_notes/phase-6.md:29` states the knob was a phase-6
  placeholder and that "real active-run resolution lands with Tasks 7.4/10.3." Those tasks
  are implemented, but the resolution never landed on the web side.
- `packages/db/src/run-lifecycle/run-creation.ts:151-160` inserts a generated `purpose =
  'generated_run'` sale offer with a DB `defaultRandom` id for every start; the seeded
  catalog offer is reused only as the parent product, never as the inventory target.
- The active run's offer id is available right where the page already reads:
  `packages/contracts/src/dashboard-recovery.ts:104` (`saleOfferId: Uuid.nullable()` on
  `CurrentDemoRun`), returned by the recovery read the page already performs.

**Impact.** During any generated run the Live Watch inventory drain, remaining-stock, and
sold-out panels reflect the static seeded offer (no live drain, or a stale/`not_initialized`
409) instead of the run's actual stock. The realtime `inventory.updated`/
`inventory.sold_out_rejection` events are published to the **global** `dashboard-events`
channel (not offer-scoped to the watched run), so the panel can incidentally tick from the
run's events, but the authoritative initial snapshot and any recovery refresh are for the
wrong offer and there is no filtering to the active run. The headline "watch the surge"
surface does not watch the run it is supposed to.

**Suggested direction.** Resolve the inventory target from the recovery snapshot first:
fetch `getDashboardRecovery()`, and if `hasCurrentRun && currentRun.saleOfferId` use that
for the inventory read (fall back to the env knob only when there is no current run). If
the run-scoped follow is intentionally deferred, update the `config.ts`/phase-6 claims and
document the manual env override as the only supported path.

### Finding 17 — Public run start promises a `/watch` redirect that never happens (MEDIUM)

On a successful public preset start the toast says "Redirecting to watch…" but the handler
returns immediately and never navigates. The server action only calls `revalidatePath("/")`,
which re-renders the home page into its overlap/active state, so the operator is left on
the home page despite being told they are being sent to the live view.

**Evidence**

- `apps/web/components/load-run-trigger.tsx:35` emits
  `toast.success(\`…Redirecting to watch…\`)` and `:36` `return`s — no
  `useRouter().push("/watch")`, and the component does not even import a router.
- `apps/web/app/actions.ts:50-52` is the only post-success effect:
  `if (outcome.state === "started") revalidatePath("/")`. That revalidates the current
  (home) route; it does not change the route.

**Impact.** The user is misled: the success message promises navigation that does not
occur, and the live results only appear if the user manually clicks "Watch". A reviewer
following the public demo path will reasonably believe the start silently failed.

**Suggested direction.** Either redirect to `/watch` on success (the action can return the
run id and the trigger can `router.push("/watch")`, or the trigger can read the outcome and
navigate), or change the copy to reflect what actually happens (e.g. "Run started — open
Watch to see it live").

### Finding 18 — No client-side recovery re-fetch on SSE reconnect or terminal run events; recovery-sourced counts freeze for the whole watch session (MEDIUM)

The realtime contract documents `/dashboard/recovery` as the authoritative
reconnect/refresh path ("The dashboard discards live events received while a recovery
snapshot is in flight and runs a follow-up recovery if anything arrived during that
window; a received terminal run event triggers one final recovery for that run ID"). The
dashboard client implements none of this: recovery is read exactly once at server render
and passed down as a frozen prop, EventSource auto-reconnect only flips a boolean, and
terminal `run.completed`/`run.failed` events are reducer no-ops.

**Evidence**

- `packages/contracts/src/dashboard-events.ts:9-18` states the
  recovery-on-reconnect / final-recovery contract the client is expected to honor.
- `apps/web/components/watch/live-watch.tsx:36-80` receives `recovery` only via props
  (server-fetched once); there is no client-side re-fetch. The connection effect at
  `:61-63` only dispatches `{ type: "connection", connected }`.
- `apps/web/components/realtime/use-dashboard-events.ts:62-99` exposes no
  reconnect/recovery callback; on a dropped stream the status oscillates
  `error → open` via native auto-reconnect but nothing triggers a fresh recovery read, so
  any events missed during the gap are permanently lost from the UI.
- `apps/web/lib/dashboard-state.ts:368-374` — terminal run events (`run.completed`,
  `run.failed`) and `run.starting`/`active`/`draining` all hit the no-op `default` branch,
  so the watch view never reflects that the run finished or changed phase without a manual
  full-page refresh.
- `apps/web/components/watch/completion-outcomes-panel.tsx:55-56` renders
  confirmed/failed/processing counts straight from the frozen
  `recovery.data.securedVsConfirmed.ordersByStatus`, so during an active session these
  headline numbers never advance even though `order.confirmed`/`order.failed` events are
  arriving (only the session-since-load deltas in the connection banner update).

**Impact.** After an SSE drop, the "since view load" burst counters (`secured`/
`rejected`/`queued`/`confirmed`) and the recovery-sourced completion counts are
understated/stale until a manual reload. After a run finalizes the Live Watch page gives no
indication the run ended. (The absolute remaining/reserved stock and queue depth
self-correct on reconnect because their events carry absolute values, and a manual page
reload recovers everything — so the blast radius is the live "burst" and completion panels
plus lifecycle surfacing, not the durable numbers.)

**Suggested direction.** Treat the realtime stream as hints per the contract: on
(re)connect and on terminal `run.*` events, trigger a fresh recovery read (e.g. via
`router.refresh()` or a client-side recovery fetch) and reconcile, discarding in-flight
live events during that window. At minimum, re-fetch recovery once on the first `open`
after an `error` and on `run.completed`/`run.failed`.

### Finding 19 — "Fail-closed" secret strength check accepts the committed dev sentinel; no startup validation forces an override (LOW)

`isSecretStrongEnough` gates admin-session signing/verification (and visitor-cookie
issuance) and is documented as a "fail closed" guard against an unverifiable session
secret. But it only checks byte length (≥ 16), and every committed dev sentinel it falls
back to is longer than 16 bytes, so the guard is satisfied by the publicly-known defaults.
A deployment that forgets to override the env values silently mints and accepts admin
sessions signed with the committed secret (and accepts the committed passphrase at login),
with no startup check rejecting it. (Primarily a config/operations hardening gap that
overlaps slice 7's scope; the local dockerized runtime intentionally uses the sentinels, so
this is flagged for awareness rather than as a local-runtime break.)

**Evidence**

- `apps/web/lib/config.ts:83-86` `isSecretStrongEnough` is `Buffer.byteLength(secret) >= 16`
  only.
- `apps/web/lib/config.ts:61-62` falls back to `"change-me-admin-passphrase"` /
  `"change-me-admin-session-secret"` (30 bytes — passes the check); `:79`
  `"change-me-public-client-cookie-secret"` and `:113` `"change-me-shared-control-token"`
  likewise.
- `apps/web/lib/admin-session.ts:80` (`createAdminSession` returns `null` only when too
  short) and `:129` (`verifyAdminSession` returns `false` only when too short) therefore do
  not fail closed when the default sentinel is in use. There is no startup validation
  anywhere that rejects the sentinel in a non-local deployment.

**Impact.** The advertised "fail closed rather than issuing unverifiable sessions"
guarantee is defeated for the common misconfiguration (unset secret). Anyone who reads the
repo can log into / forge admin sessions in such a deployment, after which the
service-token proxy faithfully forwards with full privilege.

**Suggested direction.** Either reject the known sentinels explicitly (e.g. a deny-list of
the `change-me-*` values treated as "not configured"), or add startup validation that
fails closed when `NODE_ENV=production` and any of the secrets/tokens is unset or equal to
its sentinel.

### Finding 20 — Public "Demo Picker" cards are decorative: fictional preset slugs and no start action (LOW)

The home page is headed "Public Demo Picker" and lists three "Available demo runs"
(`scarcity-burst`, `steady-drain`, `erp-stall`), but those slugs do not correspond to any
documented preset (the demo contract presets are `preview-1k`, `surge-5k`, `surge-10k`,
`idempotency-check-200`, `public-custom`), and each card's "Select run" button is just a
`<Link href="/watch">` that starts nothing and carries no selection. The only real public
start on the page is the separate `RunStartPanel`, whose trigger is hardcoded to
`preview-1k`. The picker surface therefore neither picks nor starts the documented
presets.

**Evidence**

- `apps/web/app/page.tsx:18-37` defines `DEMO_RUNS` with slugs `scarcity-burst` /
  `steady-drain` / `erp-stall` (not the documented preset slugs).
- `apps/web/app/page.tsx:65-70` renders each card's CTA as
  `<Button asChild><Link href="/watch">Select run</Link></Button>` — navigation only, no run
  start and no per-card selection state.
- `apps/web/components/run-start-panel.tsx:67-71` (and
  `apps/web/components/load-run-trigger.tsx:25` default `presetSlug = "preview-1k"`) is the
  sole actual start, fixed to `preview-1k`.

**Impact.** The public picker is misleading: the showcased runs cannot be started from
their cards, and their slugs do not exist as presets. A reviewer/demo viewer who expects
the documented presets on the public surface will not find them and cannot start them from
the picker.

**Suggested direction.** Either drive the picker cards from the real preset list and have
each card start its preset (via the existing public start action), or relabel the cards as
static examples and make clear the start happens through the Load-Run Controls panel, and
align the card slugs/names with the documented preset contract.

---

## Section 6 — Shared Contracts, Logging, And Cross-Service Vocabulary

Scope: `packages/contracts` (vocabularies, Zod schemas, shared types, service-boundary
payloads) and `packages/logger` (correlation + health builders), plus how `apps/*` emit
and consume those vocabularies.
(Verified-correct parts intentionally not enumerated: the DB pg enums are derived directly
from the vocabulary constants, every `DASHBOARD_EVENT_NAMES` member has a matching
`DashboardRealtimeEventSchema` variant, the k6 buy body/headers match `BuyRequestSchema`,
the web `api-client.ts` parses every projection through the shared contract schema rather
than duplicating shapes, and worker/API realtime projections consistently thread
`correlationId`/`runId`.)

### Finding 21 — Stable error codes returned by every service are absent from the documented `ERROR_CODES` vocabulary (MEDIUM)

`packages/contracts/src/errors.ts` owns `ERROR_CODES` as the "documented baseline set" of
stable, machine-readable error codes and ships the shared `ErrorPayloadSchema` every HTTP
error response conforms to. A whole family of codes now in production use — including a
fundamental cross-service code — is missing from that baseline, and
`ErrorPayloadSchema.code` is typed as the permissive `StableCode = z.string().min(1)`, so
neither the baseline nor the implemented extras are enumerated at the contract boundary.

**Evidence**

- `packages/contracts/src/errors.ts:22-48` — `ERROR_CODES` enumerates 20 codes; there is
  no `not_found`, no `delegation_failed`, no `run_not_deletable`, no `queue_not_configured`,
  and none of the `*_unavailable` family.
- `packages/contracts/src/errors.ts:70-72` + `packages/contracts/src/common.ts:38` —
  `ErrorPayloadSchema.code: StableCode` where `StableCode = z.string().min(1)`, so any
  non-empty string validates as an error code.
- `not_found` is the headline: it is the code returned by **all three services'** 404
  not-found handlers (`apps/api/src/app/plugins/error-handler.ts:66`,
  `apps/mock-erp/src/app/plugins/error-handler.ts:65`,
  `apps/load-orchestrator/src/app/plugins/error-handler.ts:66`) and by domain routes
  (`apps/api/src/app/routes/orders.ts:19`,
  `apps/api/src/app/services/demo-run-start-service.ts:110`,
  `apps/load-orchestrator/src/app/routes/run-control.ts:80`), and is asserted by tests
  (`apps/load-orchestrator/tests/run-control-routes.unit.test.ts:263`,
  `apps/api/tests/demo-run-start.integration.test.ts:310`,
  `apps/api/tests/buy-path.integration.test.ts:384`).
- The valid-but-down projection codes the dashboard depends on are also undocumented:
  `recovery_unavailable` (`apps/api/src/app/services/recovery-service.ts:45`, returned by
  `GET /dashboard/recovery` via `apps/api/src/app/routes/recovery.ts:17`),
  `queue_not_configured` (`apps/api/src/app/services/queue-health-service.ts:41`),
  `erp_health_unavailable` (`apps/api/src/app/services/erp-health-service.ts:44`), plus
  `reset_unavailable`, `maintenance_unavailable`, `run_history_unavailable`,
  `traffic_completion_ingestion_unavailable`, `load_metrics_ingestion_unavailable`, and
  `run_not_deletable`.
- `delegation_failed`
  (`apps/api/src/app/load-orchestrator/load-orchestrator-client.ts:67,102,113,117`) is the
  documented run-start delegation failure surfaced to the operator but absent from the
  vocabulary.

**Impact.** The cross-service error-code contract (slice 6's core concern) has drifted
behind the implementation. A consumer that builds against `ERROR_CODES` / `ErrorCode`
(typed switch, generated client, test fixtures) cannot see `not_found` — the single most
pervasive error code, returned by every service's 404 path — nor the `*_unavailable`
family that the web `api-client.ts` actively keys on to map 503→`unavailable`. The
permissive `StableCode` typing means a typo'd or drifting code (e.g. `not_found` vs
`notfound`) would silently validate and reach clients.

**Suggested direction.** Promote the stabilized codes into `ERROR_CODES` (at minimum
`not_found` and the `*_unavailable` / `delegation_failed` codes that are already tested
and consumed by the dashboard), and tighten `ErrorPayloadSchema.code` toward an
enum-or-baseline check so the vocabulary is enforced at the contract boundary rather than
only documented.

### Finding 22 — Worker readiness check `notification_record_worker_running` is contracted and documented but never emitted (MEDIUM)

*(Consolidated from Slice 6 Finding 2 and Slice 7 Finding 3 — the same defect reported
under both the contracts/vocabulary area and the runtime/ops area.)*

The readiness vocabulary advertises a `notification_record_worker_running` check as part
of a healthy worker, but the worker readiness service never reports it. Phase 8
notification recording landed as **inline** behavior inside order processing, not a
separate worker loop, so the check name is stale relative to the implemented design.

**Evidence**

- `packages/contracts/src/health.ts:63-70` — `READINESS_CHECK_NAMES.worker` lists six
  checks, the last being `notification_record_worker_running`.
- `docs/local_development.md:213` — the "Healthy readiness includes these checks" table
  lists `notification_record_worker_running=ok` for the Worker.
- `apps/worker/src/app/services/readiness-service.ts:81` — returns
  `[databaseConfigured, redisConfigured, mockErpConfigured, circuitBreaker, workerRunning]`
  (five checks); `notification_record_worker_running` is never produced.
- `apps/worker/src/app/services/readiness-service.ts:14-17` — comment claims the check
  "lands with its phase (Phase 8)" and is "NOT reported here yet", but Phase 8 notification
  recording is implemented: it runs inline inside the order-process worker
  (`apps/worker/src/app/services/order-process-service.ts:308-336`) after a fresh
  `confirmed` transition.
- `apps/worker/src/index.ts` — no separate notification BullMQ worker is constructed; the
  worker composition root builds only the `orders:process` consumer
  (`apps/worker/src/index.ts:113-117`). So there is no distinct "notification record
  worker" loop whose running state the documented check could reflect.

**Impact.** Contract/vocabulary/docs drift on the readiness surface: the documented check
list (6) disagrees with the implemented response (5), and the check name
(`..._worker_running`) advertises a separate worker process that was never built —
notification recording is folded into the order-process worker. An operator or monitor
relying on the documented vocabulary (or comparing `GET /health/ready` /
`pnpm health:check` output against the documented table) to assert the notification path
is alive gets no signal, and any consumer that validates worker readiness against
`READINESS_CHECK_NAMES.worker` will fail to find it. Because the notification work is
inline (covered by `order_process_worker_running`), this is a vocabulary/docs drift rather
than a missing safety check — but the drift is real and misleads operators.

**Suggested direction.** Reconcile the vocabulary with the implementation: either drop
`notification_record_worker_running` from `READINESS_CHECK_NAMES.worker` and the docs table
(notification recording is covered by `order_process_worker_running`), or rename it to
reflect the inline behavior; and update the readiness-service comment, which is now stale
relative to Phase 8. If a distinct notification loop is intended later, track it
explicitly.

### Finding 23 — `IsoTimestamp` accepts any non-empty string, so timezone clarity is not enforced at the contract boundary (LOW)

The shared timestamp schema used for every `occurredAt` / `capturedAt` / `timestamp` /
`securedAt` / `expiresAt` field validates only `z.string().min(1)`, despite the convention
doc and the field comments requiring ISO-8601 UTC `Z` strings.

**Evidence**

- `packages/contracts/src/common.ts:17` — `export const IsoTimestamp = z.string().min(1);`
  (comment admits it "Accepts any string; callers validate semantics where required").
- Consumed as the timestamp type across the contract surface:
  `ErrorPayloadSchema.timestamp` (`errors.ts:80`), every buy response
  `occurredAt`/`securedAt`/`expiresAt` (`buy.ts`),
  `ReadinessResponseSchema.timestamp` / `LivenessResponseSchema.timestamp` (`health.ts`),
  `OrderEventRecordSchema.occurredAt`/`createdAt` (`lifecycle.ts:109-110`), and every
  dashboard realtime/metric `occurredAt`.

**Impact.** Producers emit UTC `Z` strings today, so there is no observable bug — but
nothing in the contract catches a producer that emits a naive local timestamp, a non-ISO
string, or a millisecond-epoch. Such a value would pass `IsoTimestamp` and reach
clients/the dashboard, directly the "timestamps without timezone clarity" risk. Because
timestamp parsing is centralized here, a single regex/`z.string().datetime()` tightening
would protect every boundary at once.

**Suggested direction.** Tighten `IsoTimestamp` (e.g. `z.string().datetime()` or an
ISO-8601-with-offset regex) so the documented UTC-`Z`/offset invariant is enforced at the
contract boundary rather than left to each producer's discipline.

### Finding 24 — `OrderReadResponseSchema` types order/reservation `status` as a free-form string instead of the canonical enum schemas (LOW)

The GET `/orders/:publicOrderId` response defines both the order and reservation `status`
fields as `z.string().min(1)` rather than the shared `OrderStatusSchema` /
`ReservationStatusSchema`, so the response can advertise a non-canonical lifecycle value.

**Evidence**

- `apps/api/src/app/services/order-query-service.ts:29` — order `status: z.string().min(1)`.
- `apps/api/src/app/services/order-query-service.ts:37` — reservation
  `status: z.string().min(1)`.
- Contrast the canonical enums in `packages/contracts/src/enums.ts:36` (`OrderStatusSchema`)
  and `:34` (`ReservationStatusSchema`), which the DB columns
  (`packages/db/src/schema.ts:215,185`) and every other contract surface already use.

**Impact.** The file comment marks this as a deliberately temporary, non-cross-service
schema (it is not yet consumed by the frontend), so impact is low today. But it is exactly
the "lifecycle values differing between contracts, services" drift the slice targets: a
single read path can return a status string outside the documented vocabulary with no
validation, and the loose typing will silently propagate if the schema is promoted to
shared contracts later.

**Suggested direction.** Type the two `status` fields with `OrderStatusSchema` and
`ReservationStatusSchema` (or `.nullable()` variants) so the read path cannot emit a
non-canonical lifecycle value, matching the rest of the codebase.

---

## Section 7 — Runtime, Configuration, And Operations

Scope: compose files, Dockerfiles, Caddy config, root/package scripts, env examples,
health/readiness, smoke checks, Dev Container, and test-infrastructure isolation.
(Verified-correct parts intentionally not enumerated: every service runs in its own
container, k6 baked into the load-orchestrator image, all internal service-to-service URLs
use Compose DNS, `/dashboard/events` routed to the API via Caddy, `surge-10k` preserved at
10,000 buyers, `runtime:setup` runs migrate→seed idempotently, `runtime:reset`/
`maintenance:cleanup-runs` delegate to API-owned endpoints without deleting history,
test-env port-isolation guard + per-package DB/Redis rewrite, FLUSHALL confined to
`reset-test-infra.mjs`, API readiness honestly probes DB+queue, `.env` git-ignored and
`.dockerignore` strips secrets.)

> Note: Slice 7 Finding 3 (`notification_record_worker_running` readiness check) is the
> same defect as Slice 6 Finding 2 and is consolidated above as **Finding 22**. It is not
> repeated here.

### Finding 25 — Documented per-package test commands do not exist (MEDIUM)

`docs/local_development.md` "Useful package commands" advertises five per-package test
entry points that none of the packages define. Running any of them fails immediately.

**Evidence**

- `docs/local_development.md:300-308` lists:
  - `pnpm --filter api test:api` (line 304)
  - `pnpm --filter worker test:integration` (line 305)
  - `pnpm --filter mock-erp test:unit` (line 306)
  - `pnpm --filter load-orchestrator test:api` (line 307)
  - `pnpm --filter web test:api` (line 308)
- The actual package scripts only define `dev`/`build`/`start`/`type-check` for
  `apps/{api,worker,load-orchestrator,mock-erp}/package.json`, and `apps/web/package.json`
  only defines `test:unit`/`test:watch` — there is no `test:api`, `test:integration`, or
  service-level `test:unit` script on any of them.
- Confirmed at runtime:
  ```
  $ pnpm --filter @checkout-surge/api test:api        → ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
  $ pnpm --filter @checkout-surge/mock-erp test:unit  → ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
  $ pnpm --filter @checkout-surge/web test:api        → ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
  ```
- The real contract is the root scripts (`package.json:40-42`): `test:api` / `test:worker`
  / `test:integration` drive each package through `scripts/run-with-test-env.mjs` +
  `vitest.integration.config.ts`, and `test:unit` (`package.json:20`) sweeps
  mock-erp/load-orchestrator/etc. unit tests via the root `vitest.config.ts`. The docs
  table simply does not match it.

**Impact.** A reviewer/contributor following the documented "Useful package commands" hits
`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` for 5 of the 7 listed commands and has no documented
pointer to the real `test:api`/`test:worker`/`test:integration`/`test:unit` root entry
points for service tests. The command contract the review helper calls out as a stability
requirement is stale here.

**Suggested direction.** Replace the "Useful package commands" table with the actual root
commands (`pnpm test:api`, `pnpm test:worker`, `pnpm test:integration`, `pnpm test:unit`,
and the existing `pnpm --filter @checkout-surge/db db:migrate`/`seed` and
`pnpm --filter @checkout-surge/web test:unit`), or add the missing per-package scripts
that delegate to the test-env runner.

### Finding 26 — Load-orchestrator Dockerfile builds the entire workspace (LOW–MEDIUM)

`apps/load-orchestrator/Dockerfile` runs an unfiltered `pnpm build`, so the
load-orchestrator image build compiles every package in the monorepo (including the
Next.js web bundle, api, worker, mock-erp, db) instead of just its own dependency closure.
Every other Dockerfile uses the scoped `--filter=<pkg>...` form.

**Evidence**

- `apps/load-orchestrator/Dockerfile:36-38`:
  ```
  COPY . .
  RUN pnpm install --frozen-lockfile --offline \
   && pnpm build
  ```
- Contrast the scoped form used everywhere else:
  - `docker/Dockerfile.node-service:44-45` → `pnpm --filter=${SERVICE_NAME}... build`
  - `apps/web/Dockerfile:33-34` → `pnpm --filter=@checkout-surge/web... build`
  - `packages/db/Dockerfile:30-31` → `pnpm --filter=@checkout-surge/db... build`
- The load-orchestrator only depends on `@checkout-surge/contracts` +
  `@checkout-surge/logger` (`apps/load-orchestrator/package.json`), so
  `pnpm --filter=@checkout-surge/load-orchestrator... build` is sufficient.

**Impact.** Wasted build time/cache churn on every load-orchestrator image build, and —
more importantly — the load-orchestrator image build is now coupled to packages it never
ships: a build break in `apps/web` (or any other unrelated package) blocks the
load-orchestrator image even though it does not consume it. This contradicts the explicit
design rationale applied to the setup image ("DB-only Docker target, so seed changes do
not rebuild the … application bundles", `packages/db/Dockerfile:5-7`).

**Suggested direction.** Change the RUN to
`pnpm --filter=@checkout-surge/load-orchestrator... build` so only
contracts/logger/load-orchestrator are built, matching the other Dockerfiles.

### Finding 27 — Compose project names are NOT worktree-isolated despite the docs guaranteeing it (LOW–MEDIUM)

Both runtime docs state Compose project names are "branch-specific by default so separate
worktrees do not share project runtime state." The implementation uses a single static
branch-named default per file, so two worktrees of the **same** branch share the same
Compose project, containers, and volumes unless the operator manually overrides the project
name per worktree.

**Evidence**

- `docker-compose.yml:12` — `name: ${COMPOSE_PROJECT_NAME:-checkout-surge-glm-52}`
- `.devcontainer/docker-compose.yml:13` —
  `name: ${DEVCONTAINER_COMPOSE_PROJECT_NAME:-checkout-surge-glm-52-devcontainer}`
- The promise: `docs/local_development.md:121` ("Compose project names are branch-specific
  by default to keep local runtime state isolated across Git worktrees") and
  `docs/runtime_topology.md:104` ("Compose project names are branch-specific by default so
  separate worktrees do not share project runtime state"). The `glm-52` suffix is the
  *branch* identifier, not a worktree identifier.

**Impact.** With two worktrees of the same branch on one host (a documented supported
workflow), `pnpm runtime:up` / `runtime:reset` / `runtime:wipe` in one worktree operate on
the *same* project (same `checkout-surge-postgres-data` / `checkout-surge-redis-data`
volumes, same containers) as the other — so one worktree's reset/wipe mutates the other's
demo state, and a second `runtime:up` reattaches to the first's running containers. The
documented "do not share project runtime state" guarantee is not delivered by default.

**Suggested direction.** Either derive the default project name from the worktree/path
(e.g. a sanitized `$(pwd)`/git worktree name) so worktrees auto-isolate, or correct the
docs to state that worktree isolation requires an explicit
`COMPOSE_PROJECT_NAME`/`DEVCONTAINER_COMPOSE_PROJECT_NAME` override per worktree.

### Finding 28 — `infra:down` tears down the whole project, not just PostgreSQL/Redis (LOW)

`infra:up` correctly scopes to the two data services, but `infra:down` runs an unscoped
`docker compose down`, which stops and removes **every** service in the project —
contradicting its documented purpose.

**Evidence**

- `package.json:29-30`:
  - `infra:up` → `docker compose -f docker-compose.yml up -d --wait postgres redis`
    (scoped)
  - `infra:down` → `docker compose -f docker-compose.yml down` (unscoped)
- `docs/local_development.md:265` — "`pnpm infra:down` | Stop development PostgreSQL and
  Redis".

**Impact.** If the full runtime is up (`pnpm runtime:up`) and an operator runs
`infra:down` expecting to stop only the data services, the entire stack (api, worker, web,
mock-erp, load-orchestrator, caddy) is stopped and removed instead. (Volumes are preserved
— no `-v` — so data is not lost, but the running demo is.)

**Suggested direction.** Scope `infra:down` symmetrically
(`docker compose -f docker-compose.yml down postgres redis`), or update the docs to state
`infra:down` stops the whole project.

### Finding 29 — Caddy has no healthcheck, so `runtime:up --wait` can report success without proving the public entry point serves (LOW)

`docker-compose.yml` defines no healthcheck for the `caddy` service. Because `pnpm
runtime:up` uses `up -d --build --wait`, Compose treats caddy as ready as soon as its
container is running, without verifying the proxy actually serves. Caddy is the single
public dashboard origin, so this is the one place where `--wait`'s "everything is up"
signal is not backed by a real probe.

**Evidence**

- `docker-compose.yml:183-196` — the `caddy` service has ports + depends_on (api, web
  healthy) but no `healthcheck:` block. Every other long-lived service has a healthcheck.
- `scripts/runtime-smoke.mjs:37-39` explicitly excludes `caddy` from
  `SERVICES_WITH_HEALTHCHECK`.

**Impact.** Narrow: caddy's config is validated by `docker compose config`, and it only
starts after api+web are healthy, so a true failure is unlikely. It is mitigated because
both `pnpm health:check` (`scripts/health-check.mjs:32` probes `WEB_BASE_URL/`) and `pnpm
runtime:smoke` hit the proxy root. But a user who runs only `runtime:up` and then opens the
browser has no `--wait`-backed guarantee that the proxy is serving.

**Suggested direction.** Add a lightweight caddy healthcheck (e.g.
`wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1`) so `runtime:up --wait` covers the
public entry point, matching the other services.

---

## Section 8 — Test Suite Quality

Scope: all test files across `apps/*` and `packages/*`, plus the test lane configuration
(`vitest.config.ts`, `vitest.integration.config.ts`, `apps/web/vitest.config.ts`) and the
test-env runners (`scripts/run-with-test-env.mjs`, `scripts/reset-test-infra.mjs`,
`apps/*/tests/helpers.ts`).

Overall the suite is strong and is intentionally not praised here at length:
concurrency/no-oversell (`buy-concurrency`), idempotency/replay/late-duplicate
reconciliation (`buy-queue-handoff`, `buy-late-duplicate-reconciliation`), finalization
settlement holds + force-finalize + idempotency (`run-finalization`), worker state machine
+ real-BullMQ retry/backoff + circuit breaker with an injected clock (`order-processing`,
`order-async-pipeline`, `erp-resilience`), public budget per-visitor + global
(`public-run-budget`, `demo-run-start`), recovery/startup reconciliation (`recovery`),
reset/maintenance ownership safety (`reset`, `run-maintenance`), and real Redis
Pub/Sub→SSE (`dashboard-realtime`) all assert durable business outcomes against isolated
PostgreSQL/Redis with proper per-package isolation locks and clean-slate resets.
High-risk persistence is mocked only where the real implementation is preserved and
re-installed to exercise the pending/reconciliation path. The two items below are the
genuine test-quality gaps.

### Finding 30 — The only real-k6 behavioral test runs in the infrastructure-free unit lane and silently skips (suite stays green) whenever k6 is absent — which is the current state of this environment (HIGH)

`apps/load-orchestrator/tests/k6-roundtrip.test.ts` is named `*.test.ts` (not
`*.integration.test.ts`), so it is picked up by the **root unit lane**
(`vitest.config.ts:33-44`, include `**/*.{test,spec}.{ts,tsx}`, exclude only
`*.integration.test.ts` + `apps/web/**`). That lane is explicitly documented as
"infrastructure-free, build-free, and safe to run in watch mode"
(`vitest.config.ts:4-7,20-23`). This file is neither:

- it opens a real listening TCP socket
  (`apps/load-orchestrator/tests/k6-roundtrip.test.ts:45-54`,
  `createServer(...).listen(0, "127.0.0.1")`), and
- it spawns a real external `k6` binary through the child-process runner (`:25-31`
  `k6Available()` via `spawnSync("k6", ["version"])`; `:80-93`
  `createChildProcessK6Runner({ k6Binary: "k6", ... }).run(...)`).

Worse, when `k6` is not on PATH the file does not fail — it conditionally degrades to
`it.skip` (`:33` `const itIfK6 = (k6: boolean) => (k6 ? it : it.skip)`), and both lanes set
`passWithNoTests: true` (`vitest.config.ts:32`, `vitest.integration.config.ts:30`). The two
tests that silently vanish are the **only** real-k6, runtime-verifying assertions in the
repo:

- `:119-125` — proves the generated buyer-spike script actually executes in real k6 and
  that k6's JSON output parses into the reserved `traffic.*` payloads; and
- `:127-131` — proves the core sold-out traffic contract end to end: when the buy endpoint
  returns only `409` (`sold_out`), `traffic.failure_rate == 0` because the generated script
  overrides k6's response callback to treat expected buy outcomes as expected.

This was confirmed live: `which k6` returns nothing in this environment, so `pnpm
test:unit` / `pnpm test:watch` currently skip both tests and report success with zero
coverage of either property. Without this file, the k6 script is "verified" only by
`script-generator.unit.test.ts`, which locks onto generated **source substrings** (e.g.
`expect(script).toContain('"buyer-" + __VU')`, `'import exec from "k6/execution"'`,
`http.setResponseCallback(...)`,
`apps/load-orchestrator/tests/script-generator.unit.test.ts:96-141`) — incidental
structure, not the behavior that a real k6 run exercises.

There is also no place to move it: `apps/load-orchestrator/package.json` has no `test`
script at all (only `dev`/`build`/`start`/`type-check`), and the root `package.json`
exposes no load-orchestrator lane — `test:api`/`test:worker`/`test:integration` all filter
`@checkout-surge/{api,worker,db}`, so **every** load-orchestrator test (unit or otherwise)
reaches CI only through the root `test:unit` (`pnpm test:unit` = `vitest run && ...`).
*(This is related to Finding 25's stale documented test commands, but a distinct defect:
Finding 25 is the wrong docs table; this is the silent skip of the only behavioral k6
test.)*

**Impact.** In any runner without a host `k6` (local `test:unit`/`test:watch`, and any CI
image that does not bake k6 onto PATH), the headline load-generation guarantees are
unverified yet green: a regression that breaks the generated script's k6 compatibility, or
that stops treating expected `409`s as non-failures (the exact property that makes a clean
all-sold-out run report success), would not be caught by the test suite. The file's own
header claims "this environment has k6 installed, so the roundtrip runs here" (`:10-12`),
but the runner makes no such guarantee and the skip is silent.

**Suggested direction.**

- Rename to `k6-roundtrip.integration.test.ts` so it leaves the infrastructure-free unit
  lane (it then matches `vitest.integration.config.ts`'s `*.integration.test.ts` include)
  and add a load-orchestrator integration lane (a `test`/`test:integration` script +
  `--filter @checkout-surge/load-orchestrator`), mirroring the api/worker/db pattern.
- Stop masking the missing dependency: in that lane, fail when `k6` is absent rather than
  `it.skip` (e.g. an explicit precondition that throws, or gate the lane on a `K6_BINARY`
  that startup validates) so a missing k6 is a visible failure, not a silently-green
  zero-test run. Keep the graceful host skip only for an explicitly opt-in "no-k6"
  convenience mode if desired.

### Finding 31 — `x-load-run-id` header-agreement "matching/absent" cases assert only the absence of a validation path, so they pass against a no-op header check (LOW)

`apps/api/tests/buy-route.unit.test.ts` wires `db: undefined` (`:164-182`), so a request
that clears the header-agreement guard then fails inside the reservation service for an
unrelated reason. The two negative-shape cases lean on that:

- "treats a matching header case-insensitively" (`:206-224`) sends
  `x-load-run-id: <RUN uppercase>` with `runId: RUN` and asserts only
  `headerPaths.not.toContain("runId")` (`:220`).
- "does not require the header" (`:226-240`) sends no header and asserts the same
  (`:235`).

Because the reservation service fails downstream (no DB), the response body is never a
`runId` validation error regardless of whether the header guard ran or matched — so these
assertions cannot distinguish "the header check accepted the match" from "the request blew
up later." They would stay green against a header-check regression that simply never flags
anything (the only thing pinning mismatch detection is the sibling "rejects a body/header
run-id mismatch" case at `:184-204`, which does assert `paths` contains `"runId"`).

**Impact.** Minor: the mismatch case brackets the detection, so a total regression would
surface there. But the matching/absent cases individually verify nothing about the
agreement logic they are named for.

**Suggested direction.** Make the positive cases observe the agreement path itself rather
than the absence of a path — e.g. assert the request reaches the reservation service with a
recognizable, header-independent outcome, or move the agreement guard into the service and
assert its explicit result, so a no-op guard turns these tests red.

---

## Appendix — Consolidation notes

- Source slices: `findings_slice_1.md` … `findings_slice_8.md` (and the scoping guide
  `p1-10_review_helper.md`) in `working_docs/review/`.
- Finding-to-slice mapping for traceability:
  - Section 1 (API reservation hot path): Slice 1.
  - Section 2 (persistence/domain state/seeds): Slice 2.
  - Section 3 (worker/queue/mock ERP/notifications): Slice 3.
  - Section 4 (run lifecycle/load orchestration/finalization): Slice 4.
  - Section 5 (dashboard/realtime/admin/history): Slice 5.
  - Section 6 (shared contracts/logging/vocabulary): Slice 6.
  - Section 7 (runtime/configuration/ops): Slice 7.
  - Section 8 (test suite quality): Slice 8.
- Deduplication applied: Slice 6 Finding 2 + Slice 7 Finding 3 → **Finding 22** (single
  entry).
- Cross-referenced-but-distinct: **Finding 19** (secret check; overlaps slice 7 scope),
  **Finding 25** vs **Finding 30** (test commands vs silent k6 skip).
- The "Final Pass Questions" checklist that frames this review lives in
  `p1-10_review_helper.md` and is not reproduced here.
