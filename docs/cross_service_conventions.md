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
| Reservation fact | A durable reservation row or Redis hold is secured by construction | The implemented demo has no durable rejected, released, or expired reservation producer, so a copied single-value status would not add meaning. |
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

Checkout-Surge uses one complete revisioned browser projection.

- API and worker code publish validated dashboard projection-dirty signals to Redis Pub/Sub.
- The API gateway owns the browser-facing SSE stream at `/dashboard/events` and assembles complete `checkout-surge.dashboard-projection` version 1 frames.
- Dashboard clients receive complete projections over same-origin `EventSource`; no delta or per-order event schema is part of the browser protocol.
- Dashboard observability remains public for the demo; admin access gates only privileged controls.
- Live projections are ephemeral operator feedback, not the durable system of record.
- `/dashboard/recovery` is the authoritative reconnect and refresh path. It returns the same complete projection schema; it is not an event replay feed.

Redis Pub/Sub and SSE are both best-effort delivery paths. If the API gateway is restarting or a dashboard connection drops, a projection may be missed. That is acceptable because persisted PostgreSQL records and API-owned projection readers remain the source of truth. The initial connection, first disconnect error in an outage, later reconnect, manual refresh, and post-control repair share one single-flight current-projection HTTP path. Repeated native errors while the stream remains disconnected do not start more reads; simultaneous triggers share the in-flight request. When the browser knows a run/offer scope, it sends the complete paired known-scope query so the read can prefer a current newer run or recover the exact missed terminal. A live projection that races the read is compared atomically when each arrives; neither path buffers or replays the other.

The browser compares revisions only inside one scope. A higher same-scope revision replaces the whole view. Across scopes, it uses only complete projection metadata plus durable run `startedAt`: a newer nonterminal run may replace an older run, a committed projection newer than an idle read handles the C1 start overlap, and a newer authoritative idle projection may clear the current or terminal view. Remembering the last accepted run start prevents a delayed old scope from reviving after idle. A terminal projection can advance only its matching active scope, so a foreign terminal cannot establish another scope. Duplicate/lower revisions, stale scopes, and schema-incoherent candidates are ignored. This is one comparison rule for both live and HTTP delivery, not a second watermark system.

Unavailable reads retain the existing bounded exponential retry policy. Initial loading and public/admin start gating fail closed. Watch keeps its last successful complete projection after a failed read and labels it last-known-good. An accepted live or HTTP projection clears that warning and cancels a scheduled retry. There is no active-run polling loop; immediate lifecycle/terminal publication and connection-triggered current reads provide convergence.

Inventory and queue mutations publish only the internal projection-dirty signal. Fresh holds dirty best-effort; replays do not. Sold-out scopes coalesce for 500 ms, while queue inspection repeats every two seconds until drain. The projection service reads the complete inventory and queue values for both SSE and `/dashboard/recovery`.

API and worker business mutation handlers mark the dashboard dirty only after fresh durable changes. The single API process and single worker runtime each own one scheduler that coalesces each `(runId, saleOfferId)` for 500 ms. The projection service reads aggregate business outcomes and consistency lag into the next complete replacement; no aggregate delta contract exists.

The cutover is canonical-only: publishers and consumers deploy together, existing browser tabs must reload, and active k6 processes must be restarted. Legacy wire shapes and singular k6 counters are not normalized, avoiding duplicate aggregate/delta application and counter double counting.

The worker does not publish individual order status or consistency-lag messages. Retained completion and aggregate consistency-lag views come from the complete projection, while focused order investigation uses the durable status read or protected Run History.

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
- The exported tuple is the sole schema-driving vocabulary for canonical HTTP errors across the API, Mock ERP, load orchestrator, and web BFF. Persistence failure reasons, worker diagnostics, validation-library issue codes, and other non-HTTP discriminators are separate vocabularies and must not be added merely because they also use a field named `code`.
- Public codes describe a client or operator action category. Mechanical validation permutations share `invalid_run_configuration` or `invalid_runtime_policy`; their exact internal violation code and field path belong in `details` when useful.
- Adding a canonical HTTP error code is an intentional shared-contract change: add it once to the exported tuple, keep its lowercase snake-case spelling stable, type the producer with the exported code union, and update contract coverage. Services must not restore an open string schema or introduce a catch-all code to avoid that review.
- Protected load endpoints use `resource_not_found` for an absent accepted run and `traffic_execution_conflict` for a lifecycle or immutable-completion conflict. Exact conflict causes remain structured details. These responses still carry the body correlation ID in the canonical envelope and response header.
- `message` should be concise and human-readable.
- `details` should carry optional structured context, not a second free-form paragraph.
- Errors returned to clients should avoid leaking infrastructure internals unless that information is intentionally part of the user-facing contract.
- Browser-facing proxy failures use the same full envelope. A backend non-success response is preserved only after strict envelope validation; malformed, non-JSON, unknown-code, or correlation-inconsistent responses become a safe `502 invalid_backend_response` envelope owned by the proxy request.
- The response `x-correlation-id` is the authoritative lookup key. It must agree with any `correlationId` in the response body; a canonical upstream error may recover a missing header from its validated body.
- Protected generated-run teardown requires the control service token (`401` when absent or wrong) and a UUID run parameter (`400` when malformed). It uses the grouped `run_cleanup_conflict` category for non-terminal, ownership, malformed-target, or active-job conflicts, with the exact conflict reason in `details`. Queue, resume, Redis, or database failures return the canonical `5xx` error envelope before the durable identity is deleted; clients repeat the same bodyless DELETE. The sole API maintenance authority serializes local reset, retention, and teardown requests. One exact queue operation pauses only locally unpaused order/notification queues, validates all selected jobs before removal, and attempts every locally required resume in `finally`; pre-existing operator pauses remain untouched. Successful cleanup returns the canonical request `correlationId` and UTC cleanup timestamp, and a later repeat returns `already_absent`. There is no broad drain/clean, adapter lease, convergence rescan, teardown receipt, Redis pause-owner key, foreign-owner conflict, or cross-replica/restart pause adoption.
- Protected admin reset uses one canonical correlation ID across the API-to-load-orchestrator abort. The abort request always includes the selected run ID and `admin_reset` reason. `no_current_run` is an idempotent success after the API run is durably fenced; a current-run mismatch remains a distinct `409`. The API applies a distinct 20-second default deadline to the complete abort response, including body parsing, so Task 33's bounded TERM-to-KILL escalation can complete. Transport failure, timeout, malformed success, server failure, or unconfirmed child termination becomes a stable API failure without forwarding upstream bodies or credentials. A claimed `failed/admin_reset` run without an immutable summary makes subsequent start admission return `409 run_conflict` with `details.conflictReason = reset_incomplete` under the global start lock until reset repair completes; an admin-reset row with its summary does not block starts. Full reset success is returned only after the matching run is fenced, admission is closed, cancellation is confirmed, reset-owned queues are handled, the immutable terminal summary exists, and the run-scoped live metric projection is cleared.

---

## Reservation Fact

The implemented reservation vocabulary has one durable fact: `reservation.secured`. A Redis hold or PostgreSQL reservation row is secured by construction, so neither carries a copied status field.

An unsuccessful stock decision is represented once by the public buy `outcome` and does not create a durable reservation. Release and expiry workflows remain future extensions and must define their vocabulary when they gain real producers and consequences.

---

## Order Lifecycle

The canonical order lifecycle is:

- `queued`
- `processing`
- `confirmed`
- `failed`

Retrying remains a derived processing condition rather than a first-class order state. Retry counts, retry delays, and ERP-attempt history can be represented separately without changing the canonical lifecycle vocabulary.

The implemented order workflows permit `queued -> processing | failed` and `processing -> confirmed | failed`; `confirmed` and `failed` are terminal. Producers select the explicit event name that describes the transition rather than deriving it through a generic status-to-event helper.

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
