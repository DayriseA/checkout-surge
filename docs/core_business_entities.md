# Core Business Entities — Decisions & Rationale

This document defines the shared domain model implemented by the schema, contracts, API, worker, Mock ERP, and UI.

The goal is to keep the limited-inventory checkout flow and its recovery boundaries explicit as the implementation evolves.

---

## Decisions Summary

| Decision Area | Choice | Rationale |
| :-- | :-- | :-- |
| Product model | Keep products as durable catalog records in PostgreSQL | Product identity and merchandising data should remain stable and sale-agnostic. |
| Sale configuration model | Separate `SaleOffer` from `Product` | Event-specific pricing, allocated stock, and sale windows describe how a product is being sold in a specific limited-inventory event, not what the product is. |
| Sale ownership model | Mark sale offers by purpose and bind generated run offers through `DemoRunSaleContext` | Catalog offers remain reusable business definitions, while generated run offers must be owned by exactly one demo run and cannot be mixed across run-attributed records. |
| Inventory model | Treat inventory as a split object: durable baseline in PostgreSQL, hot-path counters and holds in Redis | This preserves a fast reservation path without losing a durable source for resets, seeding, and reconciliation. |
| Reservation model | Model reservations as first-class stock holds separate from orders | The project's core workflow depends on "reservation secured" not meaning "order confirmed." |
| Rejected reservation persistence | Do not create a PostgreSQL row for every immediate sold-out rejection in the current model | At surge scale, persisting every reject would create noise without improving business recovery or operator understanding. |
| Order model | Create an order only from a successful reservation | Orders represent the asynchronous business process, not every attempted click. |
| ERP attempt model | Store ERP calls as append-only attempt records per order | Retry behavior, latency analysis, and failure diagnosis all require attempt history, not just a final outcome. |
| ERP result model | Store successful Mock ERP confirmations in an independent first-write-wins ledger | Repeated or concurrent delivery must replay the same accepted external result across service instances and restarts. |
| Order recovery model | Store retryable/accepted-result handoff recovery and poison-job evidence independently from the live queue | An accepted ERP result must not be lost because local persistence failed, and malformed jobs need durable audit evidence. |
| Order event model | Keep an append-only event timeline for reservation and order facts | The operator dashboard, run recap, and post-incident debugging all benefit from a durable event history. |
| Demo preset model | Store public and admin preset definitions as durable database rows | Presets are the public/admin control contract; operators edit accepted configurations rather than raw k6 parameters. |
| Demo run model | Store every run with an immutable configuration snapshot and generated run sale offer | Repeated runs need isolated inventory and reproducible run-scoped behavior without mutating the editable preset draft. |
| Pending persistence model | Track Redis-secured holds that have not yet produced durable reservation/order rows | The system must preserve secured stock decisions and make reconciliation gaps visible instead of hiding partial failures. |
| Simulated notification model | Record post-confirmation notification facts durably without sending real email or SMS | The demo proves workflow boundaries without introducing real external delivery providers. |
| Run summary and finalization model | Persist traffic summaries, business outcomes, and terminal finalization records per run | Run History and benchmark artifacts must explain both k6 HTTP behavior and asynchronous business completion. |
| Public runtime policy model | Persist the active public-run policy as a singleton API-owned row | Admins can adjust public budgets, defaults, and custom-run limits without changing deployment hard caps or seeded preset definitions. |
| Traffic delivery quality | Classify request delivery inside `trafficDeliverySummary.trafficDeliveryStatus` as `complete`, `warning`, `degraded`, or `failed` | Keeps traffic fidelity visible without adding terminal demo-run statuses beyond `completed` and `failed`. |
| Quantity semantics | Keep `quantity` in the model, but default the limited-inventory flow to one unit per checkout | The demo is single-item focused, but the schema should not require a breaking change to support quantity later. |
| UI status strategy | Keep canonical persistence states minimal and derive dashboard-facing labels from reservation plus order state | This avoids contaminating the core domain model with presentation-specific labels while still supporting clear operator feedback. |

---

## Entity Overview

The implemented core business objects are:

1. `Product`
2. `SaleOffer`
3. Inventory ownership projection
4. `Reservation`
5. `Order`
6. `ErpAttempt`
7. `ErpConfirmationResult`
8. `OrderRecoveryJob`
9. `OrderDeadLetter`
10. `OrderEvent`

The implemented demo-run control and history model also includes:

11. `DemoPreset`
12. `DemoRun`
13. `DemoRunSaleContext`
14. `ReservationPendingPersistence`
15. `SimulatedNotification`
16. `DemoRunReservationOutcome`
17. `DemoRunFinalization`
18. `DemoRunSummary`
19. `PublicRuntimePolicy`

These objects intentionally separate:

- slow-changing business truth,
- fast-changing operational state,
- append-only history,
- and UI-facing derived status.

---

## Canonical Entity Definitions

### 1. Product

`Product` is the durable catalog record.

Primary responsibilities:

- identify the item being sold,
- provide the stable catalog identity that sale offers and admin views ultimately refer to.

Recommended fields:

- `id`
- `sku`
- `slug`
- `name`
- `isActive`
- `createdAt`
- `updatedAt`

Notes:

- The first seeded dataset may only include one limited-inventory product, but the product model should still remain sale-agnostic.

### 2. SaleOffer

`SaleOffer` is the sale-specific commercial configuration for a product.

Primary responsibilities:

- define how a product is being sold in a given limited-inventory event,
- own the stock allocated to that event,
- define the window used to activate inventory on the hot path.

Recommended fields:

- `id`
- `productId`
- `name`
- `allocatedStock`
- `saleStartsAt`
- `saleEndsAt`
- `isActive`
- `purpose`
- `createdAt`
- `updatedAt`

Notes:

- `allocatedStock` is the durable quantity committed to this sale event, not the live remaining counter.
- A single product can have multiple sale offers over time without changing the product identity.
- `purpose` distinguishes reusable `catalog` offers from generated `generated_run` offers created for isolated demo-run traffic.

### 3. Inventory Ownership Projection

Inventory is intentionally split by lifecycle phase rather than modeled as a live PostgreSQL counter table.

Durable allocation fields:

- `saleOffers.allocatedStock`
- `demoRuns.configSnapshot.inventoryConfig.startingStock`

Live Redis status fields:

- `saleOfferId`
- `allocatedStock`
- `remainingStock`
- `reservedStock`
- `lastUpdatedAt`
- `pendingPersistenceCount`
- `expiredReservationCount`
- `oldestPendingPersistenceAgeSeconds`
- `reservationThroughput` (`windowSeconds`, `successfulReservationCount`, `rate`, `unit`, `measuredAt`)
- `soldOutPressure` (`rejectionCount`, `latestObservedAt`)

Terminal run-history snapshot fields:

- `startingStock`
- `remainingStock`
- `reservedStock`
- `acceptedReservations`
- `soldOutRejections`
- `pendingPersistenceCount`
- `capturedAt`
- `source`

Notes:

- `saleOffers.allocatedStock` is the durable quantity committed to a sale event, not the live remaining counter.
- Redis owns mutable stock decisions and operator inventory status while a run is active.
- PostgreSQL stores the durable allocation, business ledger, and terminal Redis-derived inventory snapshot.
- Payment cancel, timeout release, and automatic hold-expiry reconciliation are deferred production extension points rather than active counters in the current demo model.

### 4. Reservation

`Reservation` is the first-class representation of the stock-hold decision.

Primary responsibilities:

- represent the outcome of the atomic stock-hold decision,
- define the hold window before downstream confirmation finishes,
- connect the fast Redis decision to the slower durable order workflow.

Recommended fields:

- `id`
- `saleOfferId`
- `correlationId`
- `runId`
- `quantity`
- `status`
- `reservationToken`
- `expiresAt`
- `securedAt`
- `releasedAt` optional
- `expiredAt` optional
- `releaseReason` optional
- `createdAt`
- `updatedAt`

Canonical statuses:

- `secured`
- `rejected`
- `released`
- `expired`

Important boundary:

- Immediate unsuccessful attempts such as sold-out responses are not represented as durable reservations in the current model.
- Rejected attempts remain response facts, metrics, and optional event/log payloads unless a later requirement creates a business reason to persist them.
- PostgreSQL requires `releasedAt` when status is `released` and `expiredAt` when status is `expired`. These are intentionally one-way guarantees: timestamps may be present in other states, and the database does not infer or rewrite historical transition times.

### 5. Order

`Order` is the durable business process started from a successful reservation.

Primary responsibilities:

- represent the asynchronous lifecycle after the stock hold succeeds,
- anchor ERP processing, retries, and final simulated purchase outcome,
- provide the main lookup record for admin investigation and run-outcome reporting.

Recommended fields:

- `id`
- `publicOrderId`
- `saleOfferId`
- `reservationId`
- `correlationId`
- `runId`
- `quantity`
- `status`
- `failureCode` optional
- `failureMessage` optional
- `queuedAt`
- `processingAt` optional
- `confirmedAt` optional
- `failedAt` optional
- `createdAt`
- `updatedAt`

Canonical statuses:

- `queued`
- `processing`
- `confirmed`
- `failed`

Notes:

- These statuses intentionally match the lifecycle defined in `docs/cross_service_conventions.md`.
- Retry metadata is not a separate order status; it belongs in ERP-attempt history and derived UI messaging.
- PostgreSQL requires `processingAt` for `processing`, `confirmed`, and `failed` orders, the matching terminal timestamp for `confirmed` and `failed`, and any non-null terminal timestamp to be at or after `queuedAt`. Equality is valid. These checks remain one-way implications rather than an exact-state encoding: earlier states may carry later timestamps, both terminal timestamps may coexist, and terminal timestamps are not ordered against `processingAt`.
- `GET /orders/:publicOrderId/status` is the public mutable read model for these durable states. It exposes the public order ID, sale offer, reservation status/expiry, nullable lifecycle and failure fields, confirmed-order consistency lag, and the persisted event timeline while omitting the internal order UUID, reservation tokens, event payloads, and run attribution.
- `POST /buy` and its idempotent replays remain acceptance-shaped (`secured` reservation and `queued` order); consumers must not use a replay as a current-status lookup.

### 6. ErpAttempt

`ErpAttempt` is an append-only record of a worker interaction with the Mock ERP.

Primary responsibilities:

- capture each outbound ERP call,
- preserve retry history,
- store latency and outcome details for resilience analysis.

Recommended fields:

- `id`
- `orderId`
- `deliveryId`
- `correlationId`
- `runId`
- `attemptNumber`
- `status`
- `terminal`
- `httpStatus` optional
- `errorCode` optional
- `errorMessage` optional
- `latencyMs`
- `startedAt`
- `finishedAt`
- `confirmationId` optional
- `idempotencyKey` optional
- `response` optional
- `createdAt`

Canonical statuses:

- `succeeded`
- `failed`
- `timed_out`

Notes:

- `attemptNumber` is monotonic within an order delivery; `(orderId, deliveryId, attemptNumber)` is unique so a recovery delivery can start its own attempt sequence without contradicting the original delivery.
- A nullable unique successful `idempotencyKey` forms the worker-local stable success boundary.
- `terminal` records the worker's disposition at call time: success and non-retryable rejection are terminal, while a temporary failure is nonterminal only when the delivery has a known remaining attempt. An absent maximum is conservatively terminal. The marker is mirrored into the attempt event payload and exposed only in protected admin run-history rows; anonymous detail exposes closed status counts and nullable aggregate latency metrics. It does not prohibit later manual or recovery replay.
- The attempt record should be durable even when the final order eventually succeeds, because the retry history is part of the portfolio story.
- PostgreSQL requires `finishedAt >= startedAt`. It also compares the duplicated nullable `runId` and non-null `correlationId` with the referenced order on every insert and relevant update.

### 7. ErpConfirmationResult

`ErpConfirmationResult` is the Mock ERP-owned first-write-wins result ledger, independent from checkout orders.

Primary responsibilities:

- persist a successful response before the Mock ERP returns it;
- replay the same response for concurrent calls and after service restart;
- reject reuse of an idempotency key with a contradictory immutable request.

Implemented fields:

- `id`
- `idempotencyKey`
- `orderId` (the external request identity, intentionally not a foreign key to checkout orders)
- `requestFingerprint`
- `response`
- `confirmationId`
- `httpStatus`
- `processedAt`
- `createdAt`

Notes:

- The unique idempotency key is authoritative across Mock ERP processes; an in-process single-flight map is only a fast coalescing path.
- A generated run's successful results remain replayable for the full lifetime of its orders. Targeted teardown and broad retention remove those results by external `orderId` in the same transaction as the terminal generated-run graph, before deleting the orders; unrelated run and catalog results are preserved.
- Failed/transient decisions are not cached, so a later delivery can retry.
- The worker-facing confirmation response is a strict status-discriminated contract. A successful response carries a non-empty `confirmationId` and HTTP status `200`, with no error metadata. A failed response carries a `4xx` or `5xx` HTTP status plus non-empty error code and message, with no confirmation ID.

### 8. OrderRecoveryJob

`OrderRecoveryJob` is durable worker-owned recovery state for a processing handoff that cannot safely be treated as an ordinary failed order.

Primary responsibilities:

- retain captured successful ERP results when local attempt/order persistence fails;
- track failed BullMQ source identity and disposition;
- support bounded claim leases, autonomous re-enqueue, resolution, and escalation.

Implemented statuses:

- `pending`
- `enqueued`
- `escalated`
- `resolved`

Key fields include `recoveryKey`, recovery/source job IDs, `orderId`, validated payload, optional captured result, reason, attempt count, last error, next-attempt/claim/resolution/escalation timestamps, and creation/update timestamps.

### 9. OrderDeadLetter

`OrderDeadLetter` is the durable audit record for a poison or structurally invalid order-processing job.

Primary responsibilities:

- preserve the raw JSON-compatible payload and unconstrained claimed order ID even when shared contract parsing fails;
- record job name/ID, semantic queue name, reason, mismatched fields, attempts, correlation ID, and observation time;
- deduplicate exact queue/job/name evidence.

This table is an audit boundary, not a separate BullMQ dead-letter queue.

### 10. OrderEvent

`OrderEvent` is the append-only event timeline for reservation and order facts.

Primary responsibilities:

- preserve the business timeline in durable form,
- support admin investigation and run-outcome reporting,
- provide a stable replay-friendly record that matches emitted event names.

Recommended fields:

- `id`
- `orderId` optional
- `reservationId` optional
- `saleOfferId`
- `correlationId`
- `runId`
- `eventName`
- `payload`
- `source`
- `occurredAt`
- `createdAt`

Expected event names include:

- `reservation.secured`
- `reservation.rejected`
- `reservation.released`
- `reservation.expired`
- `order.queued`
- `order.processing`
- `order.confirmed`
- `order.failed`
- `notification.recorded`
- `inventory.updated`
- `erp.attempt.failed`
- `erp.attempt.succeeded`

Notes:

- Run-scoped order events include `runId` so protected admin Run History can read a bounded event timeline directly by run, including events that are not reachable through an already-persisted order or reservation row. Anonymous detail exposes only the aggregate event count.
- `payload` should remain structured JSON, not free-form log text.
- `OrderEvent` is a business history mechanism, not a replacement for service logs.
- When `orderId` is present, PostgreSQL requires the event's `reservationId`, `saleOfferId`, nullable `runId`, and `correlationId` to match that order. Order attribution takes precedence and includes the order's backing reservation identity.
- When only `reservationId` is present, the event's offer, nullable run, and correlation attribution must match that reservation. Fully unlinked events remain allowed, and both nullable foreign keys retain `ON DELETE SET NULL` behavior.

### 11. DemoPreset

`DemoPreset` is the durable public/admin control definition used to start demo runs.

Primary responsibilities:

- define the accepted traffic, inventory, ERP, and backpressure configuration for a startable demo shape,
- distinguish public read-only presets from editable admin-only presets,
- provide a persisted `Custom` scratch preset for operator experiments.

Logical fields:

- `id`
- `slug`
- `visibility`
- `isEditable`
- `isCustom`
- `isSystem`
- `archivedAt` (nullable)
- `display`
- `trafficConfig`
- `inventoryConfig`
- `erpConfig`
- `backpressureConfig`
- `createdAt`
- `updatedAt`

Notes:

- Public presets such as `preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`, and `public-custom` are durable but read-only.
- The Drizzle declarations type preset display/config JSON directly from shared contracts. This is a compile-time write/select boundary; PostgreSQL still stores `jsonb`, so API response construction and other legacy-row readers retain runtime schema validation.
- Admin operators can save editable admin presets, duplicate public presets into admin copies, or copy a preset into `Custom`.
- `isSystem` marks seeded/reserved canonical slugs so operator duplicates can be distinguished from system presets. Only operator-created (non-system), editable, non-custom, active admin presets are archivable; public presets, `public-custom`, the persisted `Custom` scratch preset, and all seeded/system admin presets are never archivable.
- Archival is a soft delete: it sets `archivedAt` but keeps the row intact. Active preset lists and lookups exclude rows where `archivedAt` is not null, so an archived preset can no longer be saved, copied, duplicated, or started. The global unique slug index still reserves archived slugs, so they cannot be reused. `DemoRun.presetId` references (`ON DELETE RESTRICT`) remain valid because the preset row is retained, preserving historical run integrity.

### 12. DemoRun

`DemoRun` is the durable lifecycle record for one accepted public or admin run.

Primary responsibilities:

- freeze the accepted preset configuration into an immutable `configSnapshot`,
- own the API lifecycle `starting -> active -> draining -> completed | failed`,
- connect the generated run sale offer, k6 traffic execution, dashboard recovery, and final run history.

Logical fields:

- `id`
- `presetId`
- `presetName`
- `operatorMode`
- `status`
- `trafficStatus`
- `configSnapshot`
- `saleOfferId`
- `startedAt`
- `trafficStartedAt`
- `trafficEndedAt`
- `finalizedAt`
- `failureReason`
- `createdAt`
- `updatedAt`

Notes:

- Every normal run creates a generated run-scoped `SaleOffer` with isolated PostgreSQL and Redis inventory.
- The generated sale offer is bound to the run through `DemoRunSaleContext`; a composite foreign key requires the context's `(runId, saleOfferId)` to match `DemoRun`, and run-owned business rows must use that same pair.
- The load orchestrator owns only traffic execution status; the API owns traffic-delivery quality classification, business draining, and final terminal state.
- A hand-authored PostgreSQL partial unique index permits at most one `starting`, `active`, or `draining` run even when concurrent callers bypass the API's fast overlap check.
- Lifecycle changes use expected-status compare-and-set transitions. Traffic-start acknowledgement can move only `starting -> active`; a late acknowledgement reads the authoritative winner and cannot resurrect a draining or terminal run.
- A `starting` row is a durable traffic intent. The API poller replays its exact ID and immutable snapshot against the load orchestrator's journal after ambiguous start outcomes or API restart.
- Boundary snapshots encode the lifecycle as a strict status-discriminated union. `starting` has no traffic timestamps; `active` requires `trafficStartedAt`; `draining` requires both traffic timestamps; and `completed` additionally requires `finalizedAt` while forbidding a failure reason. A failed snapshot always requires `finalizedAt` and `failureReason`, but legally may have no traffic timestamps when startup failed, only `trafficStartedAt` when an active run was reset, or both traffic timestamps after completion evidence. Failed API finalization may retain either succeeded or failed terminal traffic status because business draining can fail after traffic itself succeeded.

### 13. DemoRunSaleContext

`DemoRunSaleContext` is the ownership link between a demo run and its generated sale offer.

Primary responsibilities:

- enforce that generated run sale offers belong to exactly one demo run,
- provide the `(runId, saleOfferId)` ownership pair used by run-attributed business records,
- prevent catalog offers or another run's generated offer from being written into run-scoped rows.

Logical fields:

- `runId`
- `saleOfferId`
- `createdAt`
- `updatedAt`

Notes:

- The referenced `SaleOffer` must have `purpose = generated_run`.
- The non-null context pair `(runId, saleOfferId)` has a composite foreign key to the unique `DemoRun.(id, saleOfferId)` pair. This prevents contradictory context inserts and updates as well as later changes to either ownership column on the run. Existing-database migration aborts if contradictory historical rows exist so ownership must be reconciled explicitly rather than guessed.
- `Reservation`, `Order`, `ReservationPendingPersistence`, `OrderEvent`, and `SimulatedNotification` records for generated sale offers must match the owning run context.
- The context is deleted with its demo run, while the generated sale offer is cleaned up after dependent run records are removed.

Enforcement note:

- These ownership invariants are guarded at two layers. Redis validates generated-run ownership and accepting state before any PostgreSQL operation. Once Redis secures a hold and the API resolves its frozen run policy, the normal write path acquires shared PostgreSQL run admission and validates the durable `(runId, saleOfferId)` pairing plus non-terminal lifecycle state before committing run-attributed rows and publishing the deterministic job. Terminal/reset transitions use the corresponding exclusive lock. Admission callbacks use their reserved session and never perform a nested checkout from the bounded base pool. A terminal-race rejection reverses the Redis hold after admission is released.
- Behind that, PostgreSQL enforces context ownership declaratively with the composite foreign key and enforces the remaining purpose and business-row rules with PL/pgSQL trigger functions that act as the last line of defense if a write ever bypasses or contradicts the application check. These triggers are not generated or surfaced by Drizzle:
  - `enforce_demo_run_sale_context_offer_purpose` rejects a context whose referenced sale offer is not `purpose = generated_run`.
  - `enforce_run_owned_sale_offer_attribution` rejects a run-attributed row (`Reservation`, `Order`, `ReservationPendingPersistence`, `OrderEvent`, `SimulatedNotification`) whose `runId` does not match the run that owns its generated `saleOfferId`.
- A similar composite foreign key on each run-attributed business table would not fully cover its rule: those tables allow `runId = NULL`, and PostgreSQL `MATCH SIMPLE` skips the foreign-key check when any referencing column is `NULL`. The attribution trigger closes that nullable gap where a generated offer is written with a missing run, and also rejects a catalog offer paired with any run. The context table itself has two non-null ownership columns, so its composite foreign key has no corresponding `MATCH SIMPLE` gap. Trigger lookups are single-row probes on indexed/unique columns against a tiny per-run table, so the per-write cost is negligible.
- These triggers and functions live in a hand-authored SQL migration and are invisible to `schema.ts` and `drizzle-kit` introspection. They must be preserved whenever migrations are regenerated, reset, or squashed, otherwise the enforcement is silently lost.
- Lifecycle and child/parent attribution guards are installed by append-only migration `0011_lifecycle_and_child_attribution_guards`. The migration takes write-conflicting locks across the affected tables, audits historical lifecycle and attribution contradictions, and aborts with SQLSTATE `23514` plus a stable constraint name instead of inventing timestamps or choosing an attribution source. Operators must reconcile the named contradiction explicitly and retry. Lifecycle checks are added `NOT VALID` and then validated in the same guarded migration; child-write guards are installed before parent-preservation guards. Child writes lock their referenced order or reservation, while parent updates inspect existing children under the parent row lock, so concurrent writes cannot create a disagreement between the two directions.

### 14. ReservationPendingPersistence

`ReservationPendingPersistence` records a Redis-secured hold that still needs durable reconciliation.

Primary responsibilities:

- preserve the Redis fast-path decision when PostgreSQL writes fail after stock has been secured,
- expose pending reconciliation to operators and finalization logic,
- retain enough context to reconcile or explain the hold later.

Logical fields:

- `id`
- `reservationId`
- `saleOfferId`
- `correlationId`
- `runId`
- `idempotencyKey`
- `quantity`
- `reservationToken`
- `status`
- `securedAt`
- `expiresAt`
- `createdAt`
- `updatedAt`

Canonical statuses:

- `pending_reconciliation`
- `reconciled`

Notes:

- `reservationId` is reserved by the Redis success path even when the durable `reservations` row does not yet exist.
- Pending visibility is created atomically with the Redis stock decision and removed atomically with accepted-idempotency promotion after durable persistence.
- Eligible request retries can converge the hold while admission remains open. During draining and API startup, an autonomous reconciler reads the Redis companion record/index without reopening admission, restores or finds the durable buy, reasserts the deterministic order job, marks this row reconciled, and promotes Redis.
- Terminal-safe reconciliation classifies exact durable evidence before mutation: a matching reservation/order is re-enqueued and promoted, while only a hold with no durable buy and a terminal/invalid ownership disposition is reversed. Other failures remain discoverable and are rescored so later records are not starved. Drain timeout may select `pending_persistence_reconciliation_timeout`, but the run remains draining until every Redis pending structure has converged; only then may the failed immutable summary be written. Guarded terminal writing and immutable-summary uniqueness retain their normal race and retry behavior.

### 15. SimulatedNotification

`SimulatedNotification` is the durable record of a post-confirmation notification workflow.

Primary responsibilities:

- show that confirmed orders can trigger follow-up business work,
- avoid using a real email/SMS provider in a systems demo,
- contribute to run finalization and run-history outcome counts.

Logical fields:

- `id`
- `orderId`
- `saleOfferId`
- `correlationId`
- `runId`
- `channel`
- `recipientPlaceholder`
- `status`
- `recordedAt`
- `createdAt`

Canonical statuses:

- `recorded`

Notes:

- Notification records are audit facts, not provider delivery receipts.
- Current worker behavior records simulated notification completion after successful order confirmation.
- A worker-owned scanner finds confirmed orders missing this record and reasserts the deterministic notification job. Terminally failed notification jobs are removed so later scanner delivery can reuse the same ID.

### 16. DemoRunReservationOutcome

`DemoRunReservationOutcome` is the durable per-run aggregate for reservation outcomes that are intentionally not persisted as individual rows.

Primary responsibilities:

- preserve high-volume losing-path pressure as run-scoped aggregate counts rather than per-attempt rows,
- carry the Redis-derived sold-out aggregate into durable run finalization and history,
- keep sold-out accounting auditable after live Redis state is reset or deleted.

Logical fields:

- `id`
- `runId`
- `outcome`
- `count`
- `latestObservedAt` optional
- `source`
- `capturedAt`
- `createdAt`

Notes:

- The first tracked `outcome` should be `api_sold_out_decision`, counted in Redis on the losing reservation path and copied into this table during finalization with `source = redis`.
- `(runId, outcome)` is unique, so finalization can idempotently upsert the latest aggregate for a run.
- This is the durable counterpart of the architectural decision to aggregate sold-out pressure instead of writing a PostgreSQL row per immediate rejection. See `docs/redis_inventory_hot_path.md` for the Redis-side `reservation-outcomes` counter it is derived from.

### 17. DemoRunFinalization

`DemoRunFinalization` stores the traffic-completion report and finalization inputs for a run.

Primary responsibilities:

- preserve k6 exit details and HTTP-level traffic summaries,
- keep traffic outcome data separate from asynchronous business outcomes,
- provide idempotent run-finalization input for the API-owned finalization service.

Logical fields:

- `id`
- `runId`
- `exitCode`
- `errorMessage`
- `httpSummary`
- `trafficOutcomeSummary`
- `trafficDeliverySummary`
- `httpTimingBreakdownSummary`
- `loadRunDiagnosticsSummary`
- `apiRequestLifecycleSummary`
- `completionEnrichmentStatus`
- `trafficSummaryReceivedAt`
- `createdAt`
- `updatedAt`

Notes:

- k6 success or failure is not the same thing as API-owned demo-run completion.
- The first completion report inserted for a run is authoritative. It is inserted with `completionEnrichmentStatus: pending`; legacy rows default to `completed` for compatibility. Duplicate or conflicting deliveries re-drive sale closure and finalization without replacing the stored report.
- Traffic-completion enrichment performs Redis and PostgreSQL reads outside a database transaction, then changes `pending` to `completed` with a database compare-and-set. The winning update atomically persists the API-owned nested snapshot/business outcome and matching sold-out aggregate. A completed Redis capture failure is represented by `completed` with no snapshot and is not retried into a later observation.
- Pending enrichment is an incomplete finalization input, not a drain blocker or timeout: no terminal run transition or summary is allowed until it concludes. Startup and periodic lifecycle recovery retry pending enrichment.
- The API acknowledges completion only after the draining transition, sale closure, outcome enrichment, reconciliation, and finalization pass are safely re-drivable.
- Successful traffic completion moves a run into business draining; finalization waits for run-scoped business work to settle.
- `trafficOutcomeSummary.terminalInventorySnapshot`, when present, is the strict, durable Redis observation captured during traffic-completion enrichment. It remains traffic-boundary evidence. Absence is a valid legacy or explicitly unavailable observation; a present malformed value is corrupt durable evidence and blocks finalization rather than being interpreted as absence. Normal finalization independently captures post-cleanup Redis inventory for Run History while re-reading the latest PostgreSQL business outcome; it does not reuse this earlier observation as terminal state.
- Completion input carries raw delivery and execution-plan evidence and may omit `trafficDeliveryStatus`; the API recomputes the authoritative stored status from planned and emitted requests. Stored/history summaries always expose `complete`, `warning`, `degraded`, or `failed`, including normalized legacy rows. Warning and degraded delivery can still produce a completed run when business invariants pass; failed traffic fidelity uses `traffic_delivery_major_shortfall` after drainable accepted work settles.
- `trafficDeliverySummary` preserves traffic mode, mode-specific buyer/rate/duration/effective-VU plan fields, completed and dropped iterations, and nullable unstarted/request-shortfall diagnostics. Dropped or unstarted iterations alone do not downgrade delivery when request shortfall is zero.
- Finalization treats unexpected responses as `traffic_outcome_unexpected_responses` and reconciles accepted responses against secured reservations and orders. Missing evidence times out as `accepted_response_accounting_timeout`; coherent durable counts above the k6 counter are preserved with a structured `traffic_outcome_counter_underreported` diagnostic.

### 18. DemoRunSummary

`DemoRunSummary` is the immutable historical artifact exposed through Run History.

Primary responsibilities:

- store the terminal recap for a demo run,
- combine HTTP-level traffic data with business outcome summaries,
- support public historical read views and admin deletion workflows.

Logical fields:

- `id`
- `runId`
- `presetName`
- `status`
- `failureReason`
- `startedAt`
- `endedAt`
- `httpSummary`
- `trafficDeliverySummary`
- `httpTimingBreakdownSummary`
- `loadRunDiagnosticsSummary`
- `apiRequestLifecycleSummary`
- `businessOutcomeSummary`
- `terminalInventorySnapshot` optional
- `capturedAt`
- `createdAt`

Notes:

- Run summaries are separate from live dashboard recovery state.
- Persisted run snapshots, HTTP and delivery summaries, business outcomes, terminal inventory, and the runtime-policy payload use their shared contract types in the Drizzle schema. Finalization diagnostics whose contracts intentionally remain open objects stay generic, and event-polymorphic order-event payloads are outside this boundary. These TypeScript annotations do not validate existing rows or raw SQL writes; DB-adjacent readers reject malformed legacy data with identifiable errors.
- `terminalInventorySnapshot` carries the Redis-derived terminal observation produced by the applicable terminal workflow, so completed runs stay auditable after live Redis state is reset. Normal post-traffic finalization captures it only after every pending-persistence hold has converged and after the fresh Redis sold-out count agrees with the paired durable business aggregate; disagreement remains draining. Traffic-completion enrichment remains separate earlier evidence. Admin reset and early-failure workflows may capture their own terminal observations. Startup repair does not synthesize a terminal projection for orchestrator-owned or draining work.
- Run History displays traffic delivery quality from `trafficDeliverySummary.trafficDeliveryStatus` next to the terminal run status, rather than encoding warning/degraded delivery as separate demo-run lifecycle states.
- A terminal run should have one summary-backed history record whether it ended through normal finalization, admin recovery, traffic-start failure, or initialization failure.

### 19. PublicRuntimePolicy

`PublicRuntimePolicy` is the API-owned singleton policy that bounds public demo starts and public custom-run configuration.

Primary responsibilities:

- define public run budget windows and start limits,
- provide editable defaults for the public custom-run form,
- cap public custom traffic, inventory, ERP behavior, and allowed failure modes within deployment hard caps.

Logical fields:

- `id`
- `policy`
- `createdAt`
- `updatedAt`

Notes:

- The singleton row uses the stable id `active`.
- An explicit seed/setup validates the environment-backed mutable-policy baseline and inserts it only when the active singleton is absent. The seven API-owned deployment caps are mirrored into setup solely for this semantic validation and compatibility storage. Rerunning setup preserves admin-edited values; a fresh database is required to bootstrap from changed setup defaults.
- Admin-protected controls may update this row. API startup configuration owns deployment hard caps, overlays them at the persistence/application boundary, and rejects updates or startup when mutable policy values exceed current caps.
- Public runtime policy changes do not mutate public preset definitions; they control public custom-run bounds and public budget behavior.

---

## Relationship Model

The implemented domain relationships are:

- One `Product` has many `SaleOffer` records.
- One `DemoPreset` has many `DemoRun` records.
- One `DemoRun` has one generated run `SaleOffer` through one `DemoRunSaleContext`.
- One `SaleOffer` has many `Reservation` records.
- One `SaleOffer` has many `Order` records.
- One `DemoRun` may have many `Reservation`, `Order`, `ErpAttempt`, `OrderEvent`, and `SimulatedNotification` records through run attribution.
- Run-owned `Reservation`, `Order`, `ReservationPendingPersistence`, `OrderEvent`, and `SimulatedNotification` rows must match the run's `DemoRunSaleContext` when they reference a generated run sale offer.
- One successful `Reservation` creates one `Order`.
- One `Order` has many `ErpAttempt` records.
- One `Order` may have durable `OrderRecoveryJob` records; recovery keys make logical recovery evidence idempotent.
- `ErpConfirmationResult` is deliberately independent of the checkout `Order` foreign-key graph because it belongs to the Mock ERP boundary.
- `OrderDeadLetter` preserves invalid/untrusted queue evidence and therefore does not require a valid order foreign key.
- One `Order` has many `OrderEvent` records.
- One `Order` may have simulated notification records.
- One `Reservation` may also have many `OrderEvent` records tied to the same `correlationId`.
- One `DemoRun` has many `DemoRunReservationOutcome` aggregate rows, unique per `(runId, outcome)`.
- One `DemoRun` has at most one `DemoRunFinalization` and at most one immutable `DemoRunSummary`.
- The deployment has one active `PublicRuntimePolicy` singleton row.

Important implications:

- A click that is immediately sold out does not create an `Order`.
- A confirmed `Order` must always be traceable back to exactly one successful `Reservation`.
- Inventory reconciliation should use both reservation/order durability and Redis counters rather than trusting any single derived UI view.

---

## Storage Boundaries

### PostgreSQL

PostgreSQL is the durable business source of truth for:

- `Product`
- `SaleOffer`
- successful `Reservation`
- `Order`
- `ErpAttempt`
- `ErpConfirmationResult`
- `OrderRecoveryJob`
- `OrderDeadLetter`
- `OrderEvent`
- durable sale-inventory baseline fields such as `allocatedStock`
- `DemoPreset`
- `DemoRun`
- `DemoRunSaleContext`
- `ReservationPendingPersistence`
- `SimulatedNotification`
- `DemoRunReservationOutcome`
- `DemoRunFinalization`
- `DemoRunSummary`
- `PublicRuntimePolicy`

PostgreSQL is also the system of record for:

- pricing used at the time the order was created,
- final order outcome,
- ERP interaction history,
- reconstructable simulation timelines,
- accepted run configuration snapshots,
- immutable run-history summaries.
- active public-run budgets, public custom-run defaults, and public custom-run limits.

### Redis

Redis owns the fast-changing operational state required for the limited-inventory hot path:

- remaining stock counter per sale offer
- reservation hold tokens and expiry data
- queue state
- near-real-time counters used for dashboards
- Redis Pub/Sub fan-out for ephemeral dashboard realtime events

Redis is intentionally not the final historical source for:

- confirmed order history
- ERP attempt history
- durable simulation timelines

### Derived UI Projections

The UI should consume derived read models rather than raw internal tables or keys.

Examples of derived UI data:

- active sale-offer details
- admin queue and ERP health panels
- inventory-drain charts
- consistency-lag metrics

The UI projection layer may combine:

- PostgreSQL order and event history,
- Redis inventory counters,
- in-flight queue metrics,
- and live dashboard realtime events delivered over SSE.

---

## Statuses Surfaced to Admin and Run Summaries

The canonical persistence states remain small:

- reservation: `secured`, `rejected`, `released`, `expired`
- order: `queued`, `processing`, `confirmed`, `failed`

The operator dashboard and run summaries should expose these states in both aggregate and drill-down form.

The recent completion-outcome DTO is also status-discriminated. Every outcome has `queuedAt`; processing and terminal outcomes require `processingAt`; confirmed and failed outcomes require only their matching terminal timestamp and forbid the opposite one. Notification display state and `notificationRecordedAt` occur together only on confirmed outcomes. This keeps the dashboard projection aligned with the durable producer rather than accepting timestamps from a later or contradictory lifecycle state.

### Simulated Purchase Status Model

Simulated purchase status should be derived from reservation outcome plus order state:

| Simulated Status | Derived From | Meaning |
| :-- | :-- | :-- |
| `sold_out` | immediate reservation reject with reason `sold_out` | No stock could be secured. |
| `sale_not_active` | immediate reservation reject with reason `run_not_accepting_traffic` | The run or sale is closed, mismatched, unknown, or otherwise ineligible for traffic. |
| `reservation_secured` | reservation `secured` and order `queued` | Stock is held and background confirmation will continue. |
| `processing` | order `processing` or queued-with-visible-delay | ERP confirmation is still in progress. |
| `confirmed` | order `confirmed` | Purchase completed successfully. |
| `failed` | order `failed` | Background confirmation failed terminally. |
| `reservation_expired` | reservation `expired` | Hold lapsed before completion or required recovery released it. |

Rejected decisions that do not describe a simulated customer lifecycle state keep `simulatedStatus` present but set it to `null`: `inventory_not_initialized` is an operational readiness failure, `idempotency_conflict` is a request conflict, and `quantity_invalid` is a request validation or decision failure. Consumers should derive neutral failure text from the precise rejection reason and must not fall back to “Sold out.”

This keeps status language aligned with the portfolio story:

- fast reservation,
- slower final confirmation,
- visible lag when the ERP is slow.

### Admin-Facing Status Model

The admin interface should expose both raw lifecycle state and supporting context:

- reservation status
- order status
- current retry count
- latest ERP-attempt outcome
- consistency lag
- failure code when present

Admin operators should be able to distinguish:

- a request rejected before reservation,
- a secured reservation waiting in queue,
- an order actively processing,
- an order failing repeatedly,
- and a terminally failed order.

---

## Decisions Deferred to Later Tasks

The implemented schema, Redis keys, and public contracts are now concrete. The current domain deliberately leaves these broader design choices unfrozen because their capabilities remain outside the implemented track:

- physical dead-letter queue topology,
- account modeling,
- payment authorization, cancellation, and automatic reservation expiry/release,
- external notification-provider integration.

Any implementation in those areas must preserve the existing reservation/order distinction, durable recovery boundaries, and hosted retention policy. Their classification and decision triggers are tracked in [Scope and Caveats](scope_and_caveats.md#deferred-decisions); this section remains authoritative for the domain constraints.

---

## Summary

This document establishes a domain model that preserves the core architectural story:

- products, sale offers, and durable order history live in PostgreSQL,
- inventory is a split object with Redis on the hot path,
- reservations are distinct from orders,
- ERP retries are captured as delivery-scoped append-only attempt history, successful Mock ERP decisions are first-write-wins, and unsafe handoffs have durable recovery/dead-letter evidence,
- business facts are preserved in an event timeline,
- demo presets, runs, generated sale ownership contexts, pending persistence, simulated notifications, ERP results/recovery evidence, reservation-outcome aggregates, finalizations, summaries, and the public runtime policy are durable PostgreSQL records,
- and the UI derives dashboard-facing statuses from those underlying states rather than redefining the lifecycle itself.
