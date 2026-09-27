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
| ERP attempt model | Retain the newest 32 ordinary ERP attempts per order plus protected canonical and current unresolved-call evidence | Cumulative control-record counters preserve lifetime outcome totals without unbounded diagnostic rows. |
| ERP result model | Keep worker attempt evidence separate from the Mock ERP's durable terminal-outcome ledger | Status lookup and same-key replay can settle a lost response across process restarts without treating worker-local evidence as proof of the external effect. |
| Order recovery model | Store retryable/accepted-result handoff recovery and poison-job evidence independently from the live queue | An accepted ERP result must not be lost because local persistence failed, and malformed jobs need durable audit evidence. |
| Order event model | Keep an append-only event timeline for reservation and order facts | The operator dashboard, run recap, and post-incident debugging all benefit from a durable event history. |
| Demo preset model | Store public and admin preset definitions as durable database rows | Presets are the public/admin control contract; operators edit accepted configurations rather than raw k6 parameters. |
| Demo run model | Store every run with an immutable configuration snapshot and generated run sale offer | Repeated runs need isolated inventory and reproducible run-scoped behavior without mutating the editable preset draft. |
| Pending persistence model | Track Redis-secured holds that have not yet produced durable reservation/order rows | The system must preserve secured stock decisions and make reconciliation gaps visible instead of hiding partial failures. |
| Simulated notification model | Record the specific post-confirmation simulated-email fact durably without invoking a real provider | The demo proves workflow boundaries without introducing an unimplemented channel vocabulary. |
| Run summary and finalization model | Persist traffic summaries, business outcomes, and terminal finalization records per run | Run History and benchmark artifacts must explain both k6 HTTP behavior and asynchronous business completion. |
| Public runtime policy model | Persist the active public-run policy as a singleton API-owned row | Admins can adjust public budgets, defaults, and custom-run limits without changing deployment hard caps or seeded preset definitions. |
| Traffic delivery quality | Classify request delivery inside `trafficDeliverySummary.trafficDeliveryStatus` as `complete`, `warning`, `degraded`, or `failed` | Keeps traffic fidelity visible without adding terminal demo-run statuses beyond `completed` and `failed`. |
| Quantity semantics | Keep `quantity` in the model, but default the limited-inventory flow to one unit per checkout | The demo is single-item focused, but the schema should not require a breaking change to support quantity later. |
| UI status strategy | Keep canonical persistence states minimal and display the buy outcome or canonical order status directly | This avoids parallel customer/simulated status vocabularies while still supporting clear operator feedback. |
| Realtime order presentation | No separate per-order feed, recent-activity panel, or public order rows; the complete revisioned projection retains aggregate consistency lag and run outcomes | Per-order live activity does not justify a second update protocol. Focused durable diagnostics use `GET /orders/:publicOrderId/status`. |

---

## Entity Overview

The implemented core business objects are:

1. `Product`
2. `SaleOffer`
3. Inventory ownership projection
4. `Reservation`
5. `Order`
6. `ErpAttempt`
7. `OrderRecoveryJob`
8. `OrderDeadLetter`
9. `OrderEvent`

The implemented demo-run control and history model also includes:

10. `DemoPreset`
11. `DemoRun`
12. `DemoRunSaleContext`
13. `ReservationPendingPersistence`
14. `SimulatedNotification`
15. `DemoRunSoldOutCount`
16. `DemoRunFinalization`
17. `DemoRunSummary`
18. `PublicRuntimePolicy`

These objects intentionally separate:

- slow-changing business truth,
- fast-changing operational state,
- append-only history,
- and UI-facing derived status.

`Product` and `SaleOffer` remain PostgreSQL/domain concepts. Shared contracts expose boundary-specific DTOs and should gain generic entity contracts only when a real endpoint or inter-service boundary needs them.

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
- `reservationThroughput` (`windowSeconds`, `successfulReservationCount`, `peakRatePerSecond`, `peakWindowSeconds`, `unit`, `measuredAt`)
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

- represent a successful atomic stock-hold decision,
- define the hold window before downstream confirmation finishes,
- connect the fast Redis decision to the slower durable order workflow.

Recommended fields:

- `id`
- `saleOfferId`
- `correlationId`
- `runId`
- `quantity`
- `reservationToken`
- `expiresAt`
- `securedAt`
- `createdAt`
- `updatedAt`

Important boundary:

- A durable reservation row exists only for a secured hold; row existence carries that fact without a copied single-value status.
- Immediate unsuccessful attempts such as sold-out responses are not represented as durable reservations in the current model.
- Rejected attempts remain response facts and metrics unless a later requirement creates a business reason to persist them.
- Release and expiry are deferred production extensions, not unproduced durable states in the current schema.

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
- The operational waiting dimension is separate from status. A waiting order stays `queued` or `processing` while its durable control record carries one of `local_admission`, `erp_capacity`, `erp_unavailable`, `uncertain_result`; the absence of a reason means "not waiting" and is deliberately not a vocabulary member. A temporary downstream constraint therefore extends waiting instead of failing the order.
- A terminal order failure is a non-transient technical failure, identified by one of these codes: `erp_authentication_failed`, `erp_authorization_failed`, `erp_response_contract_invalid`, `erp_idempotency_conflict`, `erp_attempt_contradiction`, `erp_lookup_identity_contradiction`, `erp_unrecognized_client_error`, `accepted_run_snapshot_missing`, or `accepted_run_snapshot_invalid`. A technical failure fails only the affected order without blocking its scope or the run's completion.
- PostgreSQL requires `processingAt` for `processing`, `confirmed`, and `failed` orders, the matching terminal timestamp for `confirmed` and `failed`, and any non-null terminal timestamp to be at or after `queuedAt`. Equality is valid. These checks remain one-way implications rather than an exact-state encoding: earlier states may carry later timestamps, both terminal timestamps may coexist, and terminal timestamps are not ordered against `processingAt`.
- `GET /orders/:publicOrderId/status` is the public mutable read model for these durable states. It exposes the public order ID, sale offer, secured reservation identity/expiry, the canonical order status, nullable lifecycle and failure fields, confirmed-order consistency lag, and the persisted event timeline while omitting the internal order UUID, reservation tokens, event payloads, and run attribution.
- This endpoint is the retained focused diagnostic read without a separate per-order realtime presentation. It does not imply a customer storefront or a general customer-tracking product.
- `POST /buy` and its idempotent replays remain acceptance-shaped (`secured` reservation and `queued` order); consumers must not use a replay as a current-status lookup.

### 6. ErpAttempt

`ErpAttempt` is an append-only record of a dispatched confirmation or adopted status-lookup result from the Mock ERP. Every actual confirmation POST first receives a durable `ErpCallReference`; status lookups create no call identity and consume no confirmation permit.

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

- `erpCallId` is unique for actual POST results. The `(orderId, deliveryId, attemptNumber)` identity applies to records without a durable call identity, including lookup-adopted canonical results.
- A nullable unique successful `idempotencyKey` forms the worker-local stable success boundary.
- `terminal` records a definitive result at observation time: canonical success or a non-transient technical failure. Capacity, recognized unavailability, and timeout uncertainty remain nonterminal regardless of the queue delivery count. The marker is mirrored into the attempt event payload for internal diagnostics; Run History exposes aggregate attempt status counts and nullable aggregate latency metrics.
- Attempt event diagnostics distinguish dispatched confirmations from status lookups and capture the replay response header separately from canonical JSON. Local, lookup-adopted, and replayed successes do not provide controller health or latency-learning evidence.
- The attempt record should be durable even when the final order eventually succeeds, because the retry history is part of the portfolio story.
- PostgreSQL requires `finishedAt >= startedAt` and uses a composite foreign key to bind `orderId` and `correlationId` to the referenced order. The worker validates the complete delivered order identity, including nullable `runId`, against the locked durable order before processing; the database does not duplicate that workflow check procedurally.

### 7. OrderRecoveryJob

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

Key fields include `recoveryKey`, recovery/source job IDs, `orderId`, validated payload, optional captured result, reason, attempt count, last error, next-attempt/claim/resolution/escalation timestamps, processing generation, lease expiry, waiting reason, publication ownership, unresolved ERP call identity, cumulative attempt categories, and creation/update timestamps.

### 8. OrderDeadLetter

`OrderDeadLetter` is the durable audit record for a poison or structurally invalid order-processing job.

Primary responsibilities:

- preserve the raw JSON-compatible payload and unconstrained claimed order ID even when shared contract parsing fails;
- record job name/ID, semantic queue name, reason, mismatched fields, attempts, correlation ID, and observation time;
- deduplicate exact queue/job/name evidence.

This table is an audit boundary, not a separate BullMQ dead-letter queue.

### 9. OrderEvent

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
- `order.queued`
- `order.processing`
- `order.confirmed`
- `order.failed`
- `notification.recorded`
- `inventory.updated`
- `erp.attempt.failed`
- `erp.attempt.succeeded`

Notes:

- Run-scoped order events include `runId` so run-scoped maintenance can delete events directly by run. Anonymous and admin detail expose neither event rows nor event totals.
- `payload` should remain structured JSON, not free-form log text.
- `OrderEvent` is a business history mechanism, not a replacement for service logs.
- API and worker persistence services construct linked event attribution from the freshly inserted or locked durable order/reservation rather than accepting those fields from an independent writer. PostgreSQL binds every non-null run/sale pair to `DemoRunSaleContext` and retains ordinary order/reservation foreign keys.
- Fully unlinked events remain allowed, and both nullable parent foreign keys retain `ON DELETE SET NULL` behavior. Avoiding a wider composite parent foreign key here preserves those simple history semantics without hand-authored partial-column delete machinery.

### 10. DemoPreset

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

- Public presets such as `preview-1k`, `surge-5k`, `surge-10k`, `slow-erp-5k`, `laggy-erp-5k`, `idempotency-check-200`, and `public-custom` are durable but read-only.
- The Drizzle declarations type preset display/config JSON directly from shared contracts. This is a compile-time write/select boundary; PostgreSQL still stores `jsonb`, so runtime readers validate data according to the schema owned by their specific boundary. Task 13's strict materialized-state work applies to accepted demo-run snapshots and finalization/history evidence, not preset or runtime-policy persistence.
- Admin operators can save editable admin presets, duplicate public presets into admin copies, or copy a preset into `Custom`.
- `DemoPresetService` owns active preset lookup, DTO mapping, list/save/duplicate/copy/archive rules, and guarded soft archival. Run lifecycle receives only its active-preset reader capability; it does not implement preset administration.
- `isSystem` marks seeded/reserved canonical slugs so operator duplicates can be distinguished from system presets. Only operator-created (non-system), editable, non-custom, active admin presets are archivable; public presets, `public-custom`, the persisted `Custom` scratch preset, and all seeded/system admin presets are never archivable.
- Archival is a soft delete: it sets `archivedAt` but keeps the row intact. Active preset lists and lookups exclude rows where `archivedAt` is not null, so an archived preset can no longer be saved, copied, duplicated, or started. The global unique slug index still reserves archived slugs, so they cannot be reused. `DemoRun.presetId` references (`ON DELETE RESTRICT`) remain valid because the preset row is retained, preserving historical run integrity.

### 11. DemoRun

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
- `correlationId`
- `saleOfferId`
- `startedAt`
- `trafficStartedAt`
- `trafficEndedAt`
- `finalizedAt`
- `adminResetCompletedAt`
- `failureReason`
- `createdAt`
- `updatedAt`

Notes:

- The accepted `configSnapshot` is written and re-read with the strict current schema. Unknown fields or invalid values make a persisted snapshot unreadable.
- Every normal run creates a generated run-scoped `SaleOffer` with isolated PostgreSQL and Redis inventory.
- The generated sale offer is bound to the run through `DemoRunSaleContext`; a composite foreign key requires the context's `(runId, saleOfferId)` to match `DemoRun`, and run-owned business rows must use that same pair.
- The load orchestrator owns only traffic execution status; the API owns traffic-delivery quality classification, business draining, and final terminal state.
- Traffic completion moves the run to `draining` and closes new run traffic; elapsed drain time is not a terminal condition. Normal completion requires no queued/processing orders, unresolved ERP call, pending control record, or confirmed order missing its simulated notification. Missing accepted-estimate metadata remains unavailable.
- A hand-authored PostgreSQL partial unique index permits at most one `starting`, `active`, or `draining` run even when concurrent callers bypass the API's fast overlap check.
- Lifecycle changes use expected-status compare-and-set transitions. Traffic-start acknowledgement can move only `starting -> active`; a late acknowledgement reads the authoritative winner and cannot resurrect a draining or terminal run.
- A `starting` row is a durable traffic intent. The API poller replays its exact ID and immutable snapshot against the load orchestrator's journal after ambiguous start outcomes or API restart.
- `correlationId` persists the accepted start request's root correlation so the finalization sweep can publish the terminal dashboard projection within the run's correlation lineage even when no caller correlation is available.
- Boundary snapshots encode the lifecycle as a strict status-discriminated union. `starting` has no traffic timestamps; `active` requires `trafficStartedAt`; `draining` requires both traffic timestamps; and `completed` additionally requires `finalizedAt` while forbidding a failure reason. A failed snapshot always requires `finalizedAt` and `failureReason`, but legally may have no traffic timestamps when startup failed, only `trafficStartedAt` when an active run was reset, or both traffic timestamps after completion evidence. Failed API finalization may retain either succeeded or failed terminal traffic status because business draining can fail after traffic itself succeeded.
- A destructive reset, requested by an admin or triggered automatically, claims the run `failed` with reason `admin_reset` or `auto_reset`, writes its immutable `DemoRunSummary` first, and only then deletes the run's internal rows: simulated notifications, ERP attempts, mock-ERP ledger rows, ERP dispatch calls, order events, orders, reservations, pending-persistence rows, sold-out counts and finalization evidence, plus the `run:<runId>` ERP resilience state, the run's complete Redis inventory namespace and its run-scoped Redis keys. The `demo_runs` row, its `DemoRunSaleContext`, its closed generated sale offer and that one summary survive, so Run History keeps exactly one line for the run. In-flight work is discarded on purpose: worker persistence fails closed once the purged rows are absent and cannot recreate an order or a notification. Reset never returns stock and never releases holds; expired holds stay retained and operator-visible.
- `autoResetAt` is `startedAt` (acceptance time) plus `automaticRunResetDeadlineSeconds` (900). A small API service checks every five seconds, and once at startup, for a nonterminal run past that deadline or an interrupted `auto_reset`, then runs the same reset workflow and re-validates the deadline inside the shared maintenance authority. It holds no per-run timer, so the deadline survives an API restart. From `automaticRunResetGraceNoticeSeconds` (600) after acceptance the spectator view shows a grace-period notice that the run will be reset automatically and its run data discarded. Nothing else terminates a run on elapsed wall-clock time, and an admission-estimate overrun neither terminates the run nor fails an order. Occupancy is the `starting`/`active`/`draining` slot itself, so normal finalization and an admin reset release it as well; the automatic reset is the elapsed-time fallback for a run that is still nonterminal at the deadline.

### 12. DemoRunSaleContext

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

- The run-creation service creates the referenced `SaleOffer` with `purpose = generated_run` and inserts the context in the same transaction.
- The non-null context pair `(runId, saleOfferId)` has a composite foreign key to the unique `DemoRun.(id, saleOfferId)` pair. This prevents contradictory context inserts and updates as well as later changes to either ownership column on the run.
- `Reservation`, `Order`, `ReservationPendingPersistence`, `OrderEvent`, and `SimulatedNotification` records with non-null run attribution must match the owning run context through composite foreign keys.
- The context is deleted with its demo run, while the generated sale offer is cleaned up after dependent run records are removed.

Enforcement note:

- These ownership invariants are guarded at two layers. Redis validates generated-run ownership and accepting state before any PostgreSQL operation. Once Redis secures a hold, the normal write path acquires shared PostgreSQL run admission and validates the durable `(runId, saleOfferId)` pairing plus non-terminal lifecycle state before committing run-attributed rows and publishing the deterministic job. Terminal/reset transitions use the corresponding exclusive lock. Admission callbacks use their reserved session and never perform a nested checkout from the bounded base pool. A terminal-race rejection reverses the Redis hold after admission is released.
- PostgreSQL enforces the context-to-run ownership pair and every non-null business-row `(runId, saleOfferId)` pair declaratively with composite foreign keys in `schema.ts`. With the default `MATCH SIMPLE`, a null `runId` skips that structural check for any sale purpose, not only catalog offers. The API therefore owns nullable catalog selection and prevents a generated offer from losing run attribution by validating run/sale under the run lock and constructing the durable rows from the same secured hold. Run creation separately owns generated-offer purpose when it creates the offer and context in one transaction.
- Order-to-reservation offer/correlation/quantity identity, ERP-attempt correlation, and notification-to-order attribution also use composite foreign keys. Row-local quantity, window, lifecycle, timestamp, and terminal-summary checks remain declarative.
- The API and worker own workflow checks that keys cannot express cleanly: generated-offer purpose at context construction, nullable job/run identity, legal order transitions, and event construction from a locked or freshly inserted parent. Worker sequencing validates an order-processing job through locked transition persistence before ERP-attempt persistence consumes it; notification persistence performs its own lock and identity validation. There is no generalized database validation framework and the baseline installs no trigger functions or non-internal triggers.

### 13. ReservationPendingPersistence

`ReservationPendingPersistence` is subordinate PostgreSQL audit evidence for the Redis-to-PostgreSQL handoff. Redis per-sale pending records remain the discovery and retry-scheduling authority; this table does not drive work.

Logical fields are deliberately minimal: `reservationId`, `saleOfferId`, optional `runId`, `correlationId`, `status`, `attemptCount`, `lastError`, `exhaustedAt`, and creation/update times. It does not mirror the idempotency key, quantity, token, or hold window. Canonical statuses are `pending_reconciliation`, `reconciled`, and `exhausted`. The sole `PendingPersistenceRecoveryService` upserts an attempt audit, verifies/materializes and deterministically reasserts the queue job, marks resolution, and only then removes Redis pending state. First-pass expiry upserts exhausted evidence with zero attempts. Business-outcome projection can display pending/exhausted audit rows, but terminal accounting and blockers use the authoritative Redis pending count so audit history is never a second finalization authority.

The Redis hold and pending record are created atomically with the stock decision. Recovery never reapplies that decision. Request replay delegates to the same owner; startup reconciliation, completion enrichment, finalization, maintenance, routes, and workers do not scan, schedule, retry, or resolve this handoff. Exhaustion preserves the hold, remains operator-queryable in Redis and PostgreSQL, and prevents finalization from silently succeeding.

### 14. SimulatedNotification

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
- `recipientPlaceholder`
- `recordedAt`
- `createdAt`

Notes:

- Notification row existence is the recorded simulated-email audit fact; there is no copied single-value status or unimplemented channel choice.
- Notification records are not provider delivery receipts.
- Current worker behavior records simulated notification completion after successful order confirmation.
- A worker-owned scanner finds confirmed orders missing this record and reasserts the deterministic notification job. Terminally failed notification jobs are removed so later scanner delivery can reuse the same ID.

### 15. DemoRunSoldOutCount

`DemoRunSoldOutCount` is the durable per-run aggregate for sold-out decisions that are intentionally not persisted as individual rows.

Primary responsibilities:

- preserve high-volume losing-path pressure as run-scoped aggregate counts rather than per-attempt rows,
- carry the Redis-derived sold-out aggregate into durable run finalization and history,
- keep sold-out accounting auditable after live Redis state is reset or deleted.

Logical fields:

- `runId`
- `count`
- `latestObservedAt` optional
- `capturedAt`
- `createdAt`

Notes:

- `runId` is the row key, so finalization can idempotently upsert the latest aggregate for a run.
- Redis provenance and the sold-out outcome are inherent in this specific capture path rather than repeated as single-value columns.
- This is the durable counterpart of the architectural decision to aggregate sold-out pressure instead of writing a PostgreSQL row per immediate rejection. See `docs/redis_inventory_hot_path.md` for the Redis-side `sold-out` counter it is derived from.

### 16. DemoRunFinalization

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
- `transportAttemptCounts`
- `httpSummary`
- `trafficOutcomeSummary`
- `trafficDeliverySummary`
- `httpTimingBreakdownSummary`
- `loadRunDiagnosticsSummary`
- `completionEnrichmentStatus`
- `trafficSummaryReceivedAt`
- `createdAt`
- `updatedAt`

Notes:

- k6 success or failure is not the same thing as API-owned demo-run completion.
- The focused traffic-completion service owns schema and accepted-config binding, immutable report insertion, the atomic claim to `draining`, and the enrichment/finalization handoff. The request-facing run-lifecycle service owns run start and does not ingest completion reports.
- The first completion report inserted for a run is authoritative. It is inserted with `completionEnrichmentStatus: pending`. Exact semantic redelivery re-drives sale closure and finalization without replacing the stored report; conflicting delivery fails before those side effects.
- Traffic-completion enrichment performs Redis and PostgreSQL reads outside a database transaction, then changes `pending` to `completed` with a database compare-and-set. The winning update atomically persists the API-owned nested snapshot/business outcome and matching sold-out aggregate. A completed Redis capture failure is represented by `completed` with no snapshot and is not retried into a later observation.
- Pending enrichment is an incomplete finalization input, not a drain blocker or timeout: no terminal run transition or summary is allowed until it concludes. Exact completion redelivery and startup reconciliation retry only this ordinary completion input; neither owns pending-persistence discovery, scheduling, or repair, and there is no separate periodic enrichment scanner.
- The API acknowledges completion only after the draining transition, sale closure, outcome enrichment, and finalization handoff are safely re-drivable.
- Successful traffic completion moves a run into business draining; finalization waits for run-scoped business work to settle.
- `trafficOutcomeSummary.terminalInventorySnapshot`, when present, is the strict, durable Redis observation captured during traffic-completion enrichment. It remains traffic-boundary evidence. Absence is valid when the observation was explicitly unavailable; a present malformed value is corrupt durable evidence and blocks finalization rather than being interpreted as absence. Normal finalization independently captures post-cleanup Redis inventory for Run History while re-reading the latest PostgreSQL business outcome; it does not reuse this earlier observation as terminal state.
- `transportAttemptCounts` is the only transport-total object. It stores planned, started, response-completed, interrupted, and unstarted client attempts and enforces `planned = started + unstarted` and `started = completed + interrupted`. A started attempt is client-side evidence, not proof that the API server received it.
- `httpSummary` keeps permitted and unexpected application responses distinct from generator-side `transportFailures`, plus p95 latency, without copying transport totals. `failedRequests` is exactly `unexpectedResponses + transportFailures`. `trafficDeliverySummary` contains traffic mode, mode-specific buyer/rate/duration/effective-VU plan fields, completed/dropped iteration diagnostics, the attempt-start-derived `requestArrivalSummary`, notes, and the API-owned `trafficDeliveryStatus` without copying transport totals. `requestArrivalSummary` stores the peak aligned-window arrival rate and window width, first-to-last dispatch duration, and a bounded per-window series with observed/retained counts. Total attempts remains canonical in `transportAttemptCounts.startedRequests`. Delivery quality is derived from canonical planned and unstarted counts.
- Current completion input carries raw delivery and execution-plan evidence without `trafficDeliveryStatus`; the API derives the authoritative stored status from `transportAttemptCounts`. Persisted finalization/history readers require the current canonical counts, projections, diagnostics, timing, and matching stored status. They reject old field names, incomplete current objects, and contradictory values instead of translating them. Warning and degraded delivery can still produce a completed run when business invariants pass; failed traffic fidelity uses `traffic_delivery_major_shortfall` after drainable accepted work settles.
- Real-run diagnostics keep pre-flight `generatorCapacity` separate from the nullable sampled `generatorUtilisation` block. The latter retains only scalar peak/minimum/mean observations, final cgroup memory-pressure counters, sample count, and effective interval; it stores no series and does not change the run verdict.
- Finalization treats one unexpected application response as `traffic_outcome_unexpected_responses`. Transport failures are graded against started requests at the delivery classifier's 1% and 5% boundaries; only loss above 5% fails as `traffic_transport_major_loss`. Major request-delivery shortfall takes priority over both. Accepted responses are reconciled against secured reservations and orders; coherent durable counts above the k6 counter are preserved with a structured `traffic_outcome_counter_underreported` diagnostic.

### 17. DemoRunSummary

`DemoRunSummary` is the immutable historical artifact exposed through Run History.

The public history API does not serialize this storage artifact directly. Its list projection is a compact comparison record, while its detail projection is an aggregate-only semantic superset with the accepted run configuration, canonical derived result, reconciliation proof, signal timelines, delivery evidence, lifecycle, and sanitized final inventory. Protected admin detail retains the richer protected diagnostics but no row collections and no identifier search.

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
- `transportAttemptCounts`
- `httpSummary`
- `trafficDeliverySummary`
- `httpTimingBreakdownSummary`
- `serverReservationTimingSummary`
- `loadRunDiagnosticsSummary`
- `businessOutcomeSummary`
- `terminalInventorySnapshot` optional
- `capturedAt`
- `createdAt`

Notes:

- Run summaries are separate from live dashboard recovery state.
- Persisted run snapshots, transport-attempt counts, HTTP, delivery, server-reservation-timing, business-outcome, terminal-inventory, and runtime-policy payloads use their shared contract types in the Drizzle schema. Finalization client timing and real-run diagnostics also use their current shared contract types; terminal run-summary diagnostics remain generic because API-owned failure and accounting annotations are legitimate current variants. Event-polymorphic order-event payloads remain outside this boundary. These TypeScript annotations do not validate existing rows or raw SQL writes; API read boundaries perform runtime schema validation and reject malformed current data with run, row, and field context.
- `terminalInventorySnapshot` carries the Redis-derived terminal observation produced by the applicable terminal workflow, so completed runs stay auditable after live Redis state is reset. Normal post-traffic finalization captures it only after every pending-persistence hold has converged and after the fresh Redis sold-out count agrees with the paired durable business aggregate; disagreement remains draining. Traffic-completion enrichment remains separate earlier evidence. Admin reset and early-failure workflows may capture their own terminal observations. Startup repair does not synthesize a terminal projection for orchestrator-owned or draining work.
- Run History displays traffic delivery quality from `trafficDeliverySummary.trafficDeliveryStatus` next to the terminal run status, rather than encoding warning/degraded delivery as separate demo-run lifecycle states.
- A terminal run should have one summary-backed history record whether it ended through normal finalization, admin recovery, traffic-start failure, or initialization failure.
- Every `businessOutcomeSummary` records `failedOrders` as the total count of failed orders.

### 18. PublicRuntimePolicy

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
- An explicit seed/setup validates the mutable policy's intrinsic relationships and defaults, then inserts it only when the active singleton is absent. It does not read or store API-owned deployment caps. Rerunning setup preserves admin-edited values; a fresh database is required to bootstrap from changed setup defaults.
- The migration runner validates an existing active singleton against the current strict mutable structural and intrinsic semantic contract without translating older or cap-bearing shapes. Incompatible pre-release state is rebuilt through the documented selected-project wipe workflow.
- Admin-protected controls may update this row. API startup configuration is the sole owner of deployment hard caps. `PublicRuntimePolicyService` is the one effective-policy construction boundary: it combines the strict mutable row and caps, owns public/admin DTO mapping and mutation validation, and rejects incompatible policy at update or startup. Run lifecycle receives only its effective-policy reader capability.
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
- `OrderDeadLetter` preserves invalid/untrusted queue evidence and therefore does not require a valid order foreign key.
- One `Order` has many `OrderEvent` records.
- One `Order` may have at most one simulated notification record.
- One `Reservation` may also have many `OrderEvent` records tied to the same `correlationId`.
- One `DemoRun` has at most one `DemoRunSoldOutCount` aggregate row, keyed by `runId`.
- One `DemoRun` has at most one `DemoRunFinalization` and at most one immutable `DemoRunSummary`.
- The deployment has one active `PublicRuntimePolicy` singleton row.

Important implications:

- A click that is immediately sold out does not create an `Order`.
- A confirmed `Order` must always be traceable back to exactly one successful `Reservation`.
- Inventory reconciliation should use both reservation/order durability and Redis counters rather than trusting any single derived UI view.

---

## Storage Boundaries

In this document, **durable** means that the current supported runtime/data shape preserves business facts through its documented process, handoff, and restart failure modes. It does not promise in-place upgrades of legacy pre-release local PostgreSQL, Redis, or load-journal data; [Scope and Caveats](scope_and_caveats.md#intentional-non-goals) owns that compatibility boundary.

### PostgreSQL

PostgreSQL is the durable business source of truth for:

- `Product`
- `SaleOffer`
- successful `Reservation`
- `Order`
- `ErpAttempt`
- `OrderRecoveryJob`
- `OrderDeadLetter`
- `OrderEvent`
- durable sale-inventory baseline fields such as `allocatedStock`
- `DemoPreset`
- `DemoRun`
- `DemoRunSaleContext`
- `ReservationPendingPersistence`
- `SimulatedNotification`
- `DemoRunSoldOutCount`
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
- Redis Pub/Sub projection-dirty signals consumed by the API's bounded latest-projection fan-out

Redis is intentionally not the final historical source for:

- confirmed order history
- ERP attempt history
- durable simulation timelines

### Mock ERP terminal-outcome ledger

The Mock ERP durably stores canonical successes by business idempotency key and immutable request identity. Same-process duplicates still share one running promise; cross-process duplicates converge through the ledger's unique key. Capacity, outage, injected-error, and in-progress state are not stored. `GET /confirmations/:idempotencyKey` returns `succeeded` or `unknown`; `unknown` is never proof that the original POST had no effect. A same-key replay returns the stored canonical JSON and signals reuse only through `x-erp-replayed: true`.

### Derived UI Projections

The UI should consume derived read models rather than raw internal tables or keys.

Examples of derived UI data:

- active sale-offer details
- run ERP outcome and shared-runtime system-status panels
- inventory-drain charts
- consistency-lag metrics

The UI projection layer may combine:

- PostgreSQL order and event history,
- Redis inventory counters,
- in-flight queue metrics,
- and complete revisioned dashboard projections delivered over SSE.

---

## Statuses Surfaced to Admin and Run Summaries

The canonical persistence model remains small: reservation row existence means secured, while order status is `queued`, `processing`, `confirmed`, or `failed`.

The live operator dashboard should expose these states as aggregate run outcomes, and `GET /orders/:publicOrderId/status` remains the focused durable diagnostic for a known order.

### Purchase Outcome and Order Status

The buy response carries one public `outcome`: `reservation_secured`, `reservation_pending_persistence`, `sold_out`, `run_not_accepting_traffic`, `inventory_not_initialized`, or `idempotency_conflict`. It does not repeat that decision in a rejection reason or simulated-status field. The internal Redis `idempotent_replay` decision projects to the normal public `reservation_secured` response.

After acceptance, consumers use the order's canonical status directly. This keeps status language aligned with the portfolio story:

- fast reservation,
- slower final confirmation,
- visible lag when the ERP is slow.

### Admin-Facing Status Model

The admin interface should expose both raw lifecycle state and supporting context:

- secured reservation identity and expiry
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

Any implementation in those areas must preserve the existing reservation/order distinction, durable recovery boundaries, and supported storage boundary. Their classification is recorded in [Scope and Caveats](scope_and_caveats.md); this section remains authoritative for the domain constraints.

---

## Summary

This document establishes a domain model that preserves the core architectural story:

- products, sale offers, and durable order history live in PostgreSQL,
- inventory is a split object with Redis on the hot path,
- reservations are distinct from orders,
- ERP calls use durable call identities, bounded per-order attempt history, and cumulative outcome counters; canonical results and the current unresolved call remain protected while unsafe handoffs retain recovery/dead-letter evidence,
- business facts are preserved in an event timeline,
- demo presets, runs, generated sale ownership contexts, pending-persistence audit evidence, simulated notifications, ERP attempts/recovery evidence, sold-out aggregates, finalizations, summaries, and the public runtime policy are durable PostgreSQL records,
- and the UI derives dashboard-facing statuses from those underlying states rather than redefining the lifecycle itself.
