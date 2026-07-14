# Cross-Service Conventions — Decisions & Rationale

This document defines the shared language that every service, contract, and UI surface in Checkout-Surge should use.

The goal is to preserve one canonical vocabulary across the implemented shared contracts, persistence models, observability paths, and UI surfaces.

---

## Confirmed Conventions

| Decision Area | Choice | Rationale |
| :-- | :-- | :-- |
| Vocabulary boundary | Keep reservation language and order language distinct | The project's core UX and architecture depend on fast reservation happening before slow final confirmation. |
| Event naming style | Use lowercase dot notation with domain-first names such as `reservation.secured` | Keeps emitted facts readable, stable, and consistent across logs, queues, and dashboard realtime payloads. |
| Correlation identifier name | Use `correlationId` as the canonical cross-service trace field | This aligns with the logger package and gives one shared thread across API, worker, ERP, and dashboards. |
| Timestamp format | Use ISO 8601 strings with an explicit timezone offset at service boundaries; services should emit UTC `Z` strings | This is explicit, portable, and easy to consume across logs, APIs, dashboard realtime payloads, and UI clients. |
| Error payload baseline | Standardize on a strict shared shape with a closed machine-code vocabulary, `message`, optional `details`, `correlationId`, and `timestamp` | Gives clients a stable contract while rejecting typoed or drifting public error codes. |
| Scope of this document | Define semantics and names; leave exact request/response payload schemas to the contract layer | Keeps this document focused on shared language rather than prematurely freezing every contract detail. |
| Reservation lifecycle | `secured`, `rejected`, `released`, `expired` | Separates immediate success, immediate failure, explicit stock release, and time-based hold expiry with minimal ambiguity. |
| Order lifecycle | `queued`, `processing`, `confirmed`, `failed` | Matches the asynchronous pipeline while keeping business state distinct from retry metadata. |
| Queue naming convention | Use lowercase colon-separated semantic queue names with plural domain names by default; the first canonical queue is `orders:process` | Keeps queue names readable and extensible without overcommitting to future queue topology. |
| Metric naming convention | Use lowercase dot notation and reserve semantic names for benchmark and dashboard signals | Keeps dashboard, backend, and documentation vocabulary aligned to the benchmark story. |

---

## Reservation vs. Order

The repository must preserve a hard distinction between a reservation and an order.

- A reservation is the immediate outcome of the fast stock-hold path.
- An order is the longer-lived business record that progresses through asynchronous processing and ERP confirmation.
- A reservation being secured does not mean the order is already confirmed.
- UI labels, event names, database fields, and logs should avoid treating these concepts as synonyms.

This distinction is one of the central narrative and architecture rules of the project.

---

## Event Naming Convention

The project uses a simple event naming rule:

- lowercase
- dot-separated
- domain first
- fact second

Examples:

- `reservation.secured`
- `reservation.released`
- `order.queued`
- `order.processing`
- `order.confirmed`
- `order.failed`
- `notification.recorded`
- `inventory.updated`
- `erp.attempt.failed`
- `erp.attempt.succeeded`

Avoid:

- mixed casing such as `OrderConfirmed`
- implementation-shaped names such as `processOrderJobStarted`
- UI-specific naming leaking into backend events

---

## Trace and Time Conventions

### Correlation IDs

- `correlationId` is the canonical trace field that must survive across service boundaries.
- The first externally visible request should create or adopt the `correlationId`.
- Logs, queue payloads, HTTP requests between internal services, and dashboard realtime events should propagate it.
- HTTP services use `x-correlation-id` as the transport header. Each inbound boundary normalizes or generates one value, returns it in the response header, and binds it to the request-scoped logger so routine Fastify logs are searchable without repeating the field at every call site.
- A route that promotes a validated body correlation ID must update the response header and request/reply loggers together. Per-request child bindings must not mutate the application logger or retain the previous request's correlation fields.
- Browser-facing Next.js proxy routes create one request context, forward only its normalized correlation ID plus explicitly allow-listed server-owned headers, and preserve the validated backend response correlation ID when reconstructing the browser response.

### Timestamps

- Service-boundary timestamps should be expressed as ISO 8601 strings with an explicit timezone offset. Services should emit UTC `Z` strings.
- Timestamp field names should use the `At` suffix for instants, such as `createdAt`, `confirmedAt`, or `occurredAt`.
- Relative durations such as consistency lag should be represented separately from absolute timestamps.

## Dashboard Real-Time Transport

Checkout-Surge must use transport-neutral dashboard realtime events.

- API and worker code publish validated dashboard realtime events to Redis Pub/Sub.
- The API gateway owns the browser-facing SSE stream at `/dashboard/events`.
- Dashboard clients receive live payloads over same-origin `EventSource`.
- Dashboard observability remains public for the demo; admin access gates only privileged controls.
- Live events are ephemeral operator feedback, not the durable system of record.
- `/dashboard/recovery` is the authoritative reconnect and refresh path. It returns the latest dashboard state; it is not an event replay feed.

Redis Pub/Sub and SSE are both best-effort delivery paths. If the API gateway is restarting or a dashboard connection drops, live events may be missed. That is acceptable for this operator dashboard because persisted PostgreSQL records and API-owned HTTP projection endpoints remain the source of truth. The live dashboard must fetch the authoritative dashboard recovery read on initial connection, reconnect, manual refresh, and after start/reset controls before applying subsequent live updates. Recovery establishes a fresh baseline; the browser should discard in-flight live events received before that baseline is applied rather than replaying them afterward. If any live event is discarded during a recovery window, the dashboard should perform a serialized follow-up recovery so sparse one-shot transitions such as terminal run, inventory, or order updates are not silently lost. When a terminal run update is received live, the dashboard should perform one final recovery for that run ID to settle the final projections from backend truth.

The browser reducer owns per-projection event-time watermarks: run lifecycle, inventory, queue, combined business outcome and consistency lag, and traffic keyed by metric name. An event applies only when `occurredAt` is strictly newer than its projection watermark; equal timestamps are first-wins because the event contract has no sequence tie-breaker. Rejected, recovery-window-discarded, and source-stale events do not advance watermarks. Authoritative recovery rebases them, a new-run scope resets them with the old projections, and a same-run lifecycle event advances only the lifecycle watermark so independent projections remain eligible by their own event times.

A fresh nonterminal lifecycle event may establish a new run scope even when `run.started` was missed. Before rendering its run snapshot, the browser must replace every scope-derived projection with its honest empty or null value; it must not retain inventory, metrics, queue, ERP, business outcome, consistency lag, or recent completion data beneath the new run identity. The same serialized coordinator then requests authoritative recovery. Same-run lifecycle updates retain same-run projections. A different-run update is accepted only when its run start is newer than the displayed run (or no run is displayed and its start is not older than the recovery baseline); stale, foreign, inconsistent-ID, and different-run terminal events remain rejected.

`inventory.updated` and `queue.updated` carry complete contract snapshots, not deltas. Their `occurredAt` values come from the projection source (`InventoryStatus.lastUpdatedAt` and `QueueStatus.updatedAt`), and consumers must not replace a newer source snapshot with an older one merely because publication completed later. `InventoryStatus.lastUpdatedAt` includes the newer Redis sold-out observation timestamp when stock itself has stopped changing. Fresh holds publish inventory best-effort; replays do not. Each fresh sold-out Redis decision synchronously dirties the same inventory producer with no I/O, and dirty `(runId, saleOfferId)` scopes coalesce into one cumulative inventory read/publication per 500 ms boundary. Successful durable queue handoffs publish queue state best-effort, whether the enqueue occurs on the request path or while the API reconciles pending Redis persistence. When an inspection observes queued or active work, one API-process timer marks the global queue scope dirty again after two seconds; the single-flight scheduler repeats until a final inspection observes drain. This reuses the shared queue inspector rather than defining depth a second way and does not consume browser recovery budgets.

`business.outcome.updated` remains a cumulative full replacement. API and worker mutation handlers mark it dirty only after fresh durable changes, including a pending-persistence reconciliation that freshly materializes and enqueues a buy before Redis promotion; one scheduler per process coalesces each `(runId, saleOfferId)` for 500 ms, executes one projection at a time, and retains dirty-during-read work. The pending map holds at most 64 dirty scopes plus the current previously captured batch of at most 64 scopes; pending overflow drops and logs the oldest pending scope. Normal shutdown flushes pending work, while expiry of the five-second deadline abandons later scopes without pretending to cancel the one operation already in flight. Terminal completion relies on the pending window plus authoritative final recovery/finalization rather than retaining terminal scheduler state; reset explicitly clears its pending run scopes. The bound and publication rate are process-local. Multiple replicas may publish duplicate snapshots and perform one bounded read per replica; consumers use event-time replacement, never increments, and recovery/finalization remain authoritative.

---

## Error Representation

The baseline shared error shape is:

- `code`
- `message`
- `details` optional
- `correlationId`
- `timestamp`

Conventions:

- `code` must be one of the values exported by the shared `@checkout-surge/contracts` error-code schema; unknown or typoed codes are invalid rather than pass-through strings.
- `message` should be concise and human-readable.
- `details` should carry optional structured context, not a second free-form paragraph.
- Errors returned to clients should avoid leaking infrastructure internals unless that information is intentionally part of the user-facing contract.
- Browser-facing proxy failures use the same full envelope. A backend non-success response is preserved only after strict envelope validation; malformed, non-JSON, unknown-code, or correlation-inconsistent responses become a safe `502 invalid_backend_response` envelope owned by the proxy request.
- The response `x-correlation-id` is the authoritative lookup key. It must agree with any `correlationId` in the response body; a canonical upstream error may recover a missing header from its validated body.
- Protected generated-run teardown requires the control service token (`401` when absent or wrong) and a UUID run parameter (`400` when malformed). It uses `409` for a non-terminal run, ownership mismatch, active/changing attributed queue work, or `run_queue_maintenance_owned_by_other_run` when retained queue maintenance belongs to another run. Infrastructure or post-commit cleanup failures return the canonical `5xx` error envelope and retain durable retry coordinates; clients must repeat the same bodyless DELETE. A post-commit queue-convergence failure also keeps maintenance-owned physical queues paused, including across API restart, until that exact run retry removes the remaining jobs; each marker stores its owning run ID, and another run cannot adopt, resume, clear, or clean through it. Pre-existing operator pauses remain untouched. Successful cleanup and receipt retries return the canonical request `correlationId` and UTC cleanup timestamp; a later repeat returns `already_absent`. Multi-replica deployments must send this protected mutation to one maintenance authority because request serialization is process-local.
- Protected admin reset uses one canonical correlation ID across the API-to-load-orchestrator abort. The abort request always includes the selected run ID and `admin_reset` reason. `no_current_run` is an idempotent success after the API run is durably fenced; a current-run mismatch remains a distinct `409`. The API applies a distinct 20-second default deadline to the complete abort response, including body parsing, so Task 33's bounded TERM-to-KILL escalation can complete. Transport failure, timeout, malformed success, server failure, or unconfirmed child termination becomes a stable API failure without forwarding upstream bodies or credentials. A claimed `failed/admin_reset` run without an immutable summary makes subsequent start admission return `409 demo_reset_incomplete` under the global start lock until reset repair completes; an admin-reset row with its summary does not block starts. Full reset success is returned only after the matching run is fenced, admission is closed, cancellation is confirmed, reset-owned queues are handled, the immutable terminal summary exists, and the run-scoped live metric projection is cleared.

---

## Reservation Lifecycle

The canonical reservation lifecycle is:

- `secured`
- `rejected`
- `released`
- `expired`

`rejected` is the canonical immediate unable-to-reserve state. More specific reasons such as sold out or duplicate submission can be carried separately as reason codes when needed.

---

## Order Lifecycle

The canonical order lifecycle is:

- `queued`
- `processing`
- `confirmed`
- `failed`

Retrying remains a derived processing condition rather than a first-class order state. Retry counts, retry delays, and ERP-attempt history can be represented separately without changing the canonical lifecycle vocabulary.

---

## Queue Naming Convention

Queue names follow these rules:

- Use lowercase colon-separated semantic queue names.
- Use plural domain names by default.
- The first canonical queue is `orders:process`.
- When an infrastructure adapter cannot use the semantic name directly, define an explicit physical name beside the semantic constant. The order-processing BullMQ queue uses `orders-process`, while contracts and dashboard metrics continue to expose `orders:process`.
- The notification-recording queue uses semantic `notifications:record`, physical `notifications-record`, and job name `notification.record`.
- Poison order jobs are persisted in the `order_dead_letters` audit table. There is no separate dead-letter BullMQ queue in the current implementation.

---

## Metric Naming Convention

Metric names follow these rules:

- Use lowercase dot notation.
- Prefer semantic names that describe the observed signal rather than tool-specific implementation details.
- Keep the primary metric vocabulary aligned to benchmark and dashboard signals defined in the delivery constraints.

The reserved canonical metric names are:

- `traffic.scheduled_request_rate`
- `queue.depth`
- `inventory.remaining`
- `inventory.sold_out_rejection`
- `order.consistency_lag`

Dashboard traffic metrics also use:

- `traffic.latency`
- `traffic.failure_rate`

For live k6 observations, `traffic.scheduled_request_rate` is the compatibility name for achieved throughput, not the configured traffic target. Its unit is `requests_per_second`. Production uses a shared one-second producer event-time window: `traffic.latency` is its mean in `ms`, and `traffic.failure_rate` is the fraction of valid failure observations in that same window with unit `ratio`.

---

## Summary

This document establishes a single shared vocabulary for the repository:

- keep reservation and order semantics distinct,
- keep lifecycle names aligned across contracts and schemas,
- use consistent naming for events, queues, metrics, timestamps, correlation IDs, and error payloads,
- preserve a short semantic reference that later work can build on without redefining core terms.
