# Checkout Surge (GPT-5.5) vs Checkout Forge — Consolidated Comparison

Reference implementation: `checkout-forge`  
Compared implementation: `checkout-surge`  

## Index

| Code | Topic | Verdict |
| :-- | :-- | :-- |
| C1 | Durable entity model and run-offer ownership vocabulary | same |
| C2 | Canonical lifecycle status vocabularies | same |
| C3 | Primitive refinement and object-schema strictness | better |
| C4 | Demo configuration and JSON contract specificity | worse |
| C5 | Shared runtime validation at service boundaries | same |
| C6 | Error payload and correlation-ID conventions | same |
| C7 | Realtime dashboard event vocabulary | worse |
| C8 | Metric and queue naming vocabulary | worse |
| C9 | Buy response and presentation-status vocabulary | worse |
| C10 | Order-status lookup contract surface | missing |
| C11 | Generated run sale-offer ownership enforcement | better |
| C12 | Confirmed order to successful reservation traceability | better |
| C13 | Sold-out aggregate and terminal-history persistence | same |
| C14 | Database check constraints and lifecycle/timestamp invariants | worse |
| C15 | Index fit for run-scoped reads and history pagination | worse |
| C16 | Migration metadata and hand-authored SQL hygiene | worse |
| C17 | Seeded baseline and idempotency | same |
| C18 | Cleanup and retention tooling | same |
| C19 | Redis keyspace and run isolation | better |
| C20 | Atomic stock gate and oversell safety | same |
| C21 | Atomic idempotency pending record | same |
| C22 | Idempotency conflict rule | same |
| C23 | Sold-out cheap path | same |
| C24 | Pending-persistence Redis sentinel timing | better |
| C25 | Redis-secured hold failure and retry reconciliation | better |
| C26 | Uninitialized-inventory behavior | same |
| C27 | Inventory status projection | better |
| C28 | Initialization and reset key hygiene | better |
| C29 | TTL and expiry edge cases | worse |
| C30 | Recent inventory event retention | worse |
| C31 | Two-phase buy orchestration and ERP separation | same |
| C32 | Per-request run/sale eligibility gate | worse |
| C33 | Buy outcome headers and load-generator classification | worse |
| C34 | Buy response taxonomy, status codes, and retry guidance | better |
| C35 | Idempotent replay response fidelity | worse |
| C36 | PostgreSQL work on the accepted hot path | worse |
| C37 | PostgreSQL persistence failure and pending-persistence response | better |
| C38 | Queue publish and Redis promotion partial states | better |
| C39 | Dashboard update volume and aggregation policy | worse |
| C40 | Surge tuning and startup configuration validation | worse |
| C41 | Duplicate accepted replay accounting | worse |
| C42 | Durable preset catalog and preset mutation controls | same |
| C43 | Accepted run configuration snapshots and public custom handling | same |
| C44 | Generated run sale offers and isolated inventory initialization | same |
| C45 | One active-or-draining run start gate | same |
| C46 | Traffic completion handoff into draining | same |
| C47 | Business-drain finalization and timeout semantics | same |
| C48 | API-side traffic quality classification and terminal reasons | worse |
| C49 | Terminal summary idempotence and failure-path history | better |
| C50 | API startup reconciliation of interrupted and draining runs | same |
| C51 | Admin reset recovery workflow | worse |
| C52 | Order-processing retry policy placement | worse |
| C53 | Run-scoped worker backpressure and queue accumulation | worse |
| C54 | Run-scoped ERP behavior and request timeout | same |
| C55 | Circuit breaker state machine and breaker-blocked retries | better |
| C56 | Circuit breaker run scoping | worse |
| C57 | Order transition events and realtime emission | worse |
| C58 | ERP attempt history fidelity and terminality | worse |
| C59 | Consistency-lag measurement and emission | worse |
| C60 | Post-confirmation notification durability and recovery | better |
| C61 | Mock ERP chaos controls and TPS realism | worse |
| C62 | At-least-once consumption and duplicate-delivery discipline | better |
| C63 | Worker graceful shutdown | better |
| C64 | Realtime transport fan-out and SSE mechanics | same |
| C65 | Authoritative dashboard recovery/read model composition | worse |
| C66 | Live dashboard signal completeness | worse |
| C67 | Realtime failure isolation | worse |
| C68 | Traffic mode mapping and VU sizing | worse |
| C69 | Generated request script and attempt identity | worse |
| C70 | k6 output parsing and terminal summaries | worse |
| C71 | Metric and completion delivery reliability | worse |
| C72 | Load-run lifecycle, readiness, diagnostics, and cancellation | worse |
| C73 | Containerized k6 ownership | same |
| C74 | Traffic accounting reconciliation | worse |
| C75 | Route split and public/operator surface | worse |
| C76 | Web BFF and same-origin browser boundary | worse |
| C77 | Frontend realtime recovery protocol | same |
| C78 | Reconnect and recovery-failure UX | worse |
| C79 | Frontend decomposition and testability | worse |
| C80 | Public picker, custom run, and admin control UX | worse |
| C81 | Run history and destructive admin flows | worse |
| C82 | Admin session establishment and cookie hygiene | worse |
| C83 | Admin and internal service-token enforcement | same |
| C84 | Public run-start trust boundary | worse |
| C85 | Public visitor identity and budget accounting | worse |
| C86 | Public runtime policy and deployment hard caps | worse |
| C87 | Public preset and custom-start authorization | same |
| C88 | Public-safe run history DTO boundary | worse |
| C89 | Destructive operation access gates | same |
| C90 | Internal ingestion endpoint protection | same |
| C91 | Reference runtime topology and explicit setup lifecycle | same |
| C92 | Compose readiness gating and startup robustness | worse |
| C93 | Runtime image construction and service targets | same |
| C94 | Dev Container and Codespaces isolation | same |
| C95 | Env-file wrappers and mode separation | better |
| C96 | Readiness health tooling | same |
| C97 | Non-mutating runtime smoke coverage | worse |
| C98 | Mutating dashboard-path load smoke | worse |
| C99 | Reset and maintenance command surface | worse |
| C100 | Test taxonomy and command surface | worse |
| C101 | Test infrastructure, reset determinism, and parallel safety | worse |
| C102 | Hard-property regression coverage | same |
| C103 | API and service-boundary testability seams | same |
| C104 | Repo-wide quality gates and conventions | same |
| C105 | README status and feature claims | same |
| C106 | Roadmap auditability and completion tracking | better |
| C107 | Design-doc adaptation versus inherited target wording | worse |
| C108 | Local command and runtime documentation alignment | same |
| C109 | Access-surface and run-history documentation fidelity | worse |
| C110 | Honest scoping of deferred work | same |
| C111 | Historical verification evidence | unknown |
| C112 | CORS allow-list wiring across debug-exposed services | same |
| C113 | API gateway graceful shutdown | same |
| C114 | Service-side liveness/readiness endpoint depth | better |
| C115 | Structured logging conventions and hot-path log volume | same |
| C116 | CSRF posture on state-changing dashboard proxy routes | same |
| C117 | Dependency footprint and third-party hygiene | same |

## Findings

### C1 — Durable entity model and run-offer ownership vocabulary (same)

#### Reference behavior

Forge models the required durable entity set as first-class PostgreSQL/Drizzle tables and keeps generated sale offers explicitly tied to demo runs. The model includes the catalog, offers, presets, runs, reservations, orders, ERP attempts, business events, pending persistence, notification history, reservation aggregates, finalizations, summaries, and public runtime policy.

**References:**
- `checkout-forge/packages/db/src/schema.ts:79` — product table starts the core durable model.
- `checkout-forge/packages/db/src/schema.ts:148` — demo-run table.
- `checkout-forge/packages/db/src/schema.ts:179` — run-to-sale-offer context table.
- `checkout-forge/packages/db/src/schema.ts:197` — reservation table.
- `checkout-forge/packages/db/src/schema.ts:237` — order table.
- `checkout-forge/packages/db/src/schema.ts:523` — public runtime policy table.

#### Compared behavior

Surge preserves the same durable entity vocabulary and the same generated-run sale-offer ownership concept. Its table names and organization differ slightly, but the same business objects remain present in PostgreSQL rather than being collapsed into Redis or service-local state.

**References:**
- `checkout-surge/packages/db/src/schema.ts:129` — product table.
- `checkout-surge/packages/db/src/schema.ts:198` — demo-run table.
- `checkout-surge/packages/db/src/schema.ts:226` — run-to-sale-offer context table.
- `checkout-surge/packages/db/src/schema.ts:244` — reservation table.
- `checkout-surge/packages/db/src/schema.ts:274` — order table.
- `checkout-surge/packages/db/src/schema.ts:505` — public runtime policy table.

#### Verdict rationale

The compared implementation is equivalent for entity coverage and durable source-of-truth boundaries. Surge adds some persistence triggers that improve integrity, but those are graded separately in C11 and C12 rather than changing the entity-model verdict.

### C2 — Canonical lifecycle status vocabularies (same)

#### Reference behavior

Forge keeps the required vocabulary split between reservations and orders. Reservation status is about the stock hold decision, while order status is about the asynchronous business process. Demo-run lifecycle status is a separate vocabulary.

**References:**
- `checkout-forge/packages/contracts/src/domain.ts:12` — reservation status contract.
- `checkout-forge/packages/contracts/src/domain.ts:21` — order status contract.
- `checkout-forge/packages/db/src/schema.ts:45` — reservation status enum.
- `checkout-forge/packages/db/src/schema.ts:52` — order status enum.
- `checkout-forge/packages/db/src/schema.ts:65` — demo-run status enum.

#### Compared behavior

Surge uses the same reservation, order, and demo-run status sets. It does not turn retry state into a persisted order status.

**References:**
- `checkout-surge/packages/contracts/src/lifecycle.ts:8` — reservation status contract.
- `checkout-surge/packages/contracts/src/lifecycle.ts:34` — order status contract.
- `checkout-surge/packages/db/src/schema.ts:22` — reservation status enum.
- `checkout-surge/packages/db/src/schema.ts:26` — order status enum.
- `checkout-surge/packages/contracts/src/lifecycle.ts:78` — demo-run status contract.

#### Verdict rationale

This is a straight parity point. Both implementations preserve the canonical business lifecycle split.

### C3 — Primitive refinement and object-schema strictness (better)

#### Reference behavior

Forge has useful primitive contracts, including offset-aware timestamps and bounded correlation IDs. Some entity contracts are still permissive object schemas, and the shared sale-offer contract does not expose the DB-level `purpose` field.

**References:**
- `checkout-forge/packages/contracts/src/common.ts:10` — timestamp primitive.
- `checkout-forge/packages/contracts/src/common.ts:12` — correlation ID primitive.
- `checkout-forge/packages/contracts/src/domain.ts:50` — product schema.
- `checkout-forge/packages/contracts/src/domain.ts:60` — sale-offer schema.
- `checkout-forge/packages/db/src/schema.ts:108` — sale-offer `purpose` column.

#### Compared behavior

Surge tightens the primitive and entity contract layer. It validates correlation ID syntax more strictly, marks core object contracts as strict, includes sale-offer `purpose` in the shared contract, and promotes order event names to a DB enum.

**References:**
- `checkout-surge/packages/contracts/src/primitives.ts:8` — stricter correlation ID primitive.
- `checkout-surge/packages/contracts/src/entities.ts:18` — strict product schema.
- `checkout-surge/packages/contracts/src/entities.ts:28` — sale-offer schema.
- `checkout-surge/packages/contracts/src/entities.ts:40` — sale-offer `purpose` contract field.
- `checkout-surge/packages/db/src/schema.ts:34` — order event name enum.

#### Verdict rationale

Surge is stronger here because it narrows more of the shared public surface and reduces vocabulary drift risk.

### C4 — Demo configuration and JSON contract specificity (worse)

#### Reference behavior

Forge carries detailed typed configuration contracts from the shared package into the DB-facing layer. Preset configuration, run configuration snapshots, runtime policy, finalization payloads, and summaries are typed against domain contracts, and seed/policy paths parse those contracts close to persistence.

**References:**
- `checkout-forge/packages/contracts/src/demo-runs.ts:190` — demo-run configuration schema.
- `checkout-forge/packages/db/src/schema.ts:126` — typed preset display/config JSON.
- `checkout-forge/packages/db/src/schema.ts:159` — typed run config snapshot JSON.
- `checkout-forge/packages/db/src/schema.ts:527` — typed runtime policy JSON.
- `checkout-forge/packages/db/src/demo-presets.ts:531` — seed preset validation.
- `checkout-forge/packages/db/src/public-runtime-policy.ts:27` — policy validation.

#### Compared behavior

Surge has typed load/config schemas, but its DB layer stores many important JSON columns through a generic `JsonRecord` type. Validation still happens in selected API paths, but the persistence boundary is looser and seed data is inserted with less schema-specific checking.

**References:**
- `checkout-surge/packages/contracts/src/load.ts:50` — typed load configuration schema.
- `checkout-surge/packages/db/src/schema.ts:16` — generic `JsonRecord`.
- `checkout-surge/packages/db/src/schema.ts:180` — generic preset/run JSON usage.
- `checkout-surge/packages/db/src/schema.ts:488` — generic run summary JSON.
- `checkout-surge/packages/db/src/schema.ts:509` — generic runtime policy JSON.
- `checkout-surge/packages/db/src/scripts/seed.ts:34` — generic seed preset JSON type.

#### Verdict rationale

Surge keeps useful schemas in the contracts package, but Forge does a better job making those schemas the DB-adjacent source of truth. The compared implementation has more room for persisted JSON drift.

### C5 — Shared runtime validation at service boundaries (same)

#### Reference behavior

Forge validates request and response boundaries with shared contracts across the API, mock ERP, load-metric ingestion, and dashboard realtime consumption.

**References:**
- `checkout-forge/apps/api/src/routes/buy.ts:24` — buy request parsing.
- `checkout-forge/apps/api/src/routes/buy.ts:53` — buy response validation.
- `checkout-forge/apps/mock-erp/src/server.ts:103` — ERP request validation.
- `checkout-forge/apps/api/src/routes/load-metrics.ts:27` — load metric ingestion validation.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` — SSE event validation.

#### Compared behavior

Surge follows the same validation discipline at comparable boundaries: buy routes, mock ERP, load-orchestrator start, API ingestion, and dashboard event fanout.

**References:**
- `checkout-surge/apps/api/src/routes/buy-routes.ts:19` — buy request parsing.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:30` — buy response validation.
- `checkout-surge/apps/mock-erp/src/routes/confirmation-routes.ts:14` — ERP request validation.
- `checkout-surge/apps/load-orchestrator/src/server.ts:98` — orchestrator start validation.
- `checkout-surge/apps/api/src/realtime/dashboard-event-fanout.ts:151` — dashboard event validation.

#### Verdict rationale

Both codebases consistently use the shared contract package at service edges. The important differences are in schema contents and vocabulary, not in the basic validation pattern.

### C6 — Error payload and correlation-ID conventions (same)

#### Reference behavior

Forge uses the required shared error payload shape and propagates `x-correlation-id` through API requests and error responses.

**References:**
- `checkout-forge/packages/contracts/src/common.ts:41` — shared error shape.
- `checkout-forge/apps/api/src/server.ts:94` — correlation ID assignment.
- `checkout-forge/apps/api/src/server.ts:114` — shaped API error response.
- `checkout-forge/apps/api/src/http.ts:9` — request correlation ID helper.

#### Compared behavior

Surge uses the same error payload fields and response-header convention. It is stricter about validating incoming correlation IDs and generates replacements for invalid input.

**References:**
- `checkout-surge/packages/contracts/src/error.ts:4` — shared error shape.
- `checkout-surge/apps/api/src/server.ts:60` — correlation ID assignment.
- `checkout-surge/apps/api/src/server.ts:139` — shaped error payload.
- `checkout-surge/packages/logger/src/correlation.ts:8` — correlation ID validation.

#### Verdict rationale

The convention is equivalent. Forge is more permissive, while Surge is stricter, but neither diverges materially from the shared error/correlation contract.

### C7 — Realtime dashboard event vocabulary (worse)

#### Reference behavior

Forge exposes the baseline realtime dashboard stream as four domain-first event types: order status updates, dashboard metrics, load-run updates, and business events. Producers validate events before publishing, and the SSE gateway validates Redis messages before broadcast; malformed payloads are dropped rather than becoming client state.

**References:**
- `checkout-forge/packages/contracts/src/events.ts:18` — order-status update event schema.
- `checkout-forge/packages/contracts/src/events.ts:31` — dashboard metric event schema.
- `checkout-forge/packages/contracts/src/events.ts:38` — recorded business event schema.
- `checkout-forge/packages/contracts/src/events.ts:51` — discriminated union.
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:24` — producer-side schema validation before publish.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` — inbound Redis payloads are validated before broadcast.

#### Compared behavior

Surge validates realtime events, but it replaces the baseline vocabulary with a different UI/aggregate-oriented set such as `run.started`, `inventory.updated`, `traffic.metric`, and `business.outcome.updated`. It also requires an `eventId` on every dashboard event even though the stream has no replay path that uses event IDs. Redis messages are parsed through the dashboard event schema and invalid messages are dropped, so the validation discipline exists; the divergence is the event language and projection coupling.

**References:**
- `checkout-surge/packages/contracts/src/dashboard-events.ts:16` — alternate event vocabulary.
- `checkout-surge/packages/contracts/src/dashboard-events.ts:31` — dashboard events require `eventId`.
- `checkout-surge/packages/db/src/redis-dashboard-events.ts:23` — Redis messages are parsed through the dashboard event schema.
- `checkout-surge/packages/db/src/redis-dashboard-events.ts:47` — invalid Redis messages are routed to an invalid-message handler.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:533` — traffic metric event publisher.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:229` — aggregate business outcome event.

#### Verdict rationale

Surge's stream is typed, but it is not vocabulary-compatible with the reference and drops the explicit domain-first `business.event.recorded` and per-order `order.status.updated` categories. The unused event IDs and projection-first event names make the stream more coupled to the current dashboard reducer and less faithful to the shared domain model.

### C8 — Metric and queue naming vocabulary (worse)

#### Reference behavior

Forge reserves the expected dashboard metric names and keeps queue names in the colon-separated semantic form. Its k6 custom counters and parser agree on the same metric names.

**References:**
- `checkout-forge/packages/contracts/src/metrics.ts:10` — dashboard metric names.
- `checkout-forge/packages/contracts/src/queue.ts:12` — queue names.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:73` — k6 custom counters.
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:3` — parser metric names.

#### Compared behavior

Surge preserves the shared dashboard metric names and queue names, but its k6 custom counters drift from the reference names.

**References:**
- `checkout-surge/packages/contracts/src/lifecycle.ts:102` — dashboard metric enum.
- `checkout-surge/packages/contracts/src/queue.ts:11` — queue names.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:54` — k6 custom counters.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:57` — parser metric names.

#### Verdict rationale

The queue and dashboard metric vocabulary are equivalent, but load metric names are part of the measurement surface. The k6 naming drift makes Surge worse overall for this topic.

### C9 — Buy response and presentation-status vocabulary (worse)

#### Reference behavior

Forge keeps the buy outcome vocabulary compact and derives presentation status from reservation and order state. It includes a `sale_not_active` presentation state and keeps retry/delay information out of persisted order status.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:25` — secured response outcome.
- `checkout-forge/packages/contracts/src/buy-flow.ts:44` — pending persistence outcome.
- `checkout-forge/packages/contracts/src/buy-flow.ts:63` — rejected outcome.
- `checkout-forge/packages/contracts/src/domain.ts:25` — presentation status vocabulary.
- `checkout-forge/packages/contracts/src/dashboard.ts:53` — dashboard order projection.

#### Compared behavior

Surge exposes more top-level buy outcomes, omits the `sale_not_active` presentation status, maps some non-stock failures to sold-out presentation, and introduces a dashboard display-status enum for delayed/retrying/notification-recorded states.

**References:**
- `checkout-surge/packages/contracts/src/buy.ts:31` — expanded buy outcome schema.
- `checkout-surge/packages/contracts/src/buy.ts:57` — rejection outcomes.
- `checkout-surge/packages/contracts/src/lifecycle.ts:59` — simulated purchase status vocabulary.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:165` — ineligible traffic mapping.
- `checkout-surge/packages/contracts/src/demo.ts:151` — dashboard display status enum.

#### Verdict rationale

Surge does not corrupt persisted order status, but its external and presentation vocabulary is less faithful to the reference model.

### C10 — Order-status lookup contract surface (missing)

#### Reference behavior

Forge exposes a typed public order-status lookup by public order ID, including reservation status, order status, customer status, consistency lag, and timeline information.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:88` — order-status request schema.
- `checkout-forge/packages/contracts/src/buy-flow.ts:99` — order-status response schema.
- `checkout-forge/apps/api/src/routes/order-status.ts:13` — route registration.
- `checkout-forge/apps/api/src/routes/order-status.ts:27` — not-found error behavior.
- `checkout-forge/apps/api/src/server.ts:146` — route mounted in API server.

#### Compared behavior

Surge has order enums and run-history projections, but no comparable `/orders/:publicOrderId/status` route or shared response contract was found in the inspected API/contract surface.

**References:**
- `checkout-surge/apps/api/src/server.ts:7` — registered route imports.
- `checkout-surge/apps/api/src/server.ts:106` — API route registration block.

#### Verdict rationale

This public lookup contract is absent in Surge, so the topic is graded missing rather than merely different.

### C11 — Generated run sale-offer ownership enforcement (better)

#### Reference behavior

Forge creates generated run-specific sale offers and records ownership in a run-sale context. It also has trigger-backed protection for run-attributed writes so generated offers cannot silently drift from their owning run.

**References:**
- `checkout-forge/packages/db/src/demo-runs.ts:75` — generated offer creation.
- `checkout-forge/packages/db/src/demo-runs.ts:111` — run-sale context creation.
- `checkout-forge/packages/db/src/schema.ts:191` — unique ownership row.
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:1` — trigger function.
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:47` — trigger installation.

#### Compared behavior

Surge creates the same generated offer and ownership context, but its trigger is stricter. It rejects generated-offer rows without an ownership context, rejects wrong or missing `run_id`, and rejects catalog offers on run-attributed rows.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:708` — generated offer creation.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:742` — run-sale context creation.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:478` — ownership trigger function.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:499` — wrong or missing run check.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:517` — trigger installation.

#### Verdict rationale

Both implementations noticed the nullable `run_id` composite-FK issue. Surge leaves fewer bypass-write gaps, so it is better.

### C12 — Confirmed order to successful reservation traceability (better)

#### Reference behavior

Forge requires each order to reference one reservation and prevents multiple orders from sharing the same reservation. The normal write path inserts the secured reservation, order, and initial events together.

**References:**
- `checkout-forge/packages/db/src/schema.ts:245` — order reservation FK.
- `checkout-forge/packages/db/src/schema.ts:262` — unique reservation per order.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:91` — reservation/order write transaction.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:153` — initial event write.

#### Compared behavior

Surge keeps the same FK and uniqueness rule, then adds database triggers requiring the backing reservation to exist, be secured, and match order fields such as sale offer, run, correlation ID, and quantity. It also prevents mutation of reservation fields after an order depends on them.

**References:**
- `checkout-surge/packages/db/src/schema.ts:282` — order reservation FK.
- `checkout-surge/packages/db/src/schema.ts:299` — unique reservation per order.
- `checkout-surge/packages/db/drizzle/0001_order_secured_reservation_invariant.sql:1` — order/reservation invariant trigger.
- `checkout-surge/packages/db/drizzle/0001_order_secured_reservation_invariant.sql:17` — matching-field checks.
- `checkout-surge/packages/db/drizzle/0001_order_secured_reservation_invariant.sql:57` — reservation mutation protection.

#### Verdict rationale

Forge's normal path is correct, but Surge enforces the invariant more completely at the database layer. That is a meaningful durability improvement.

### C13 — Sold-out aggregate and terminal-history persistence (same)

#### Reference behavior

Forge keeps sold-out losers out of PostgreSQL on the hot path, counts them in Redis, and writes run-scoped sold-out aggregate data plus a terminal inventory snapshot into durable history at finalization.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:174` — Redis sold-out aggregate increment.
- `checkout-forge/packages/db/src/schema.ts:443` — durable reservation-outcome aggregate.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:216` — terminal summary write.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:293` — terminal inventory snapshot.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:322` — Redis sold-out aggregate read.

#### Compared behavior

Surge follows the same overall boundary: sold-out losers are counted in Redis, durable aggregate rows are written for run history, and terminal inventory snapshots are captured from Redis-derived status.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:235` — Redis sold-out aggregate increment.
- `checkout-surge/packages/db/src/schema.ts:430` — durable reservation-outcome aggregate.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:581` — sold-out aggregate upsert.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:207` — terminal inventory snapshot.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:236` — durable/Redis sold-out fallback.

#### Verdict rationale

The timing and exact fields differ, but both satisfy the important persistence rule: losing sold-out attempts stay cheap during the spike and terminal audit data is copied into durable history.

### C14 — Database check constraints and lifecycle/timestamp invariants (worse)

#### Reference behavior

Forge encodes several lifecycle invariants directly as database checks. Released or expired reservations must carry the corresponding timestamp, and order status must agree with processing, confirmed, or failed timestamps.

**References:**
- `checkout-forge/packages/db/src/schema.ts:226` — reservation released timestamp check.
- `checkout-forge/packages/db/src/schema.ts:230` — reservation expired timestamp check.
- `checkout-forge/packages/db/src/schema.ts:271` — confirmed order timestamp check.
- `checkout-forge/packages/db/src/schema.ts:275` — failed order timestamp check.
- `checkout-forge/packages/db/src/schema.ts:279` — processing timestamp check.

#### Compared behavior

Surge keeps some basic checks, including positive quantities and public preset editability, but it does not define equivalent DB-level checks tying order lifecycle states to their timestamps. Worker code sets timestamps on the normal path, but the database does not backstop bypass writes in the same way.

**References:**
- `checkout-surge/packages/db/src/schema.ts:190` — preset editability/public check.
- `checkout-surge/packages/db/src/schema.ts:266` — reservation quantity check.
- `checkout-surge/packages/db/src/schema.ts:291` — order processing timestamp column.
- `checkout-surge/packages/db/src/schema.ts:292` — order confirmed timestamp column.
- `checkout-surge/packages/db/src/schema.ts:293` — order failed timestamp column.
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:71` — worker timestamp write path.

#### Verdict rationale

Surge improves some specific relational integrity rules, but it loses broader lifecycle/timestamp database checks that Forge has. For this topic, Surge is worse.

### C15 — Index fit for run-scoped reads and history pagination (worse)

#### Reference behavior

Forge uses composite indexes aligned with the actual run-scoped reads: order chronology, ERP attempt chronology, event timelines, pending-persistence inspection, and summary pagination.

**References:**
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:285` — orders by run and queue time.
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:287` — ERP attempts by run and start time.
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:290` — order events by run and occurrence time.
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:294` — pending persistence by run and secured time.
- `checkout-forge/packages/db/src/schema.ts:488` — summary pagination index.

#### Compared behavior

Surge has useful indexes, but many run-scoped history paths rely on simpler single-column indexes rather than composite indexes that match filtering plus sort order.

**References:**
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:327` — orders run index.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:342` — ERP attempts run index.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:350` — order events run index.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:369` — pending persistence run index.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:405` — summary captured-at index.

#### Verdict rationale

Surge is likely weaker for timeline, queue, and paginated history access patterns because fewer indexes match both the run filter and chronological ordering.

### C16 — Migration metadata and hand-authored SQL hygiene (worse)

#### Reference behavior

Forge keeps an incremental Drizzle migration history with snapshot metadata and a separate hand-authored trigger migration. This is fragile in general, but the metadata makes future diffing/regeneration less ambiguous.

**References:**
- `checkout-forge/packages/db/drizzle/meta/_journal.json:6` — initial migration journal entry.
- `checkout-forge/packages/db/drizzle/meta/_journal.json:12` — trigger migration journal entry.
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:1` — hand-authored trigger SQL.
- `checkout-forge/packages/db/drizzle/meta/0000_snapshot.json:1` — initial snapshot metadata.
- `checkout-forge/packages/db/drizzle/meta/0001_snapshot.json:1` — second snapshot metadata.

#### Compared behavior

Surge also uses hand-authored trigger SQL, including trigger blocks embedded in the initial schema and a separate order/reservation invariant migration. The inspected migration metadata only had the journal; Drizzle snapshot JSON files were not present.

**References:**
- `checkout-surge/packages/db/drizzle/meta/_journal.json:6` — initial migration journal entry.
- `checkout-surge/packages/db/drizzle/meta/_journal.json:12` — second migration journal entry.
- `checkout-surge/packages/db/drizzle/0000_initial_schema.sql:455` — embedded run-attribution trigger SQL.
- `checkout-surge/packages/db/drizzle/0001_order_secured_reservation_invariant.sql:1` — hand-authored order/reservation trigger SQL.

#### Verdict rationale

The SQL may work, but the missing snapshot metadata and embedded hand-authored trigger blocks make future migration maintenance riskier than Forge.

### C17 — Seeded baseline and idempotency (same)

#### Reference behavior

Forge seeds the baseline product, catalog offer, durable presets, and runtime policy path idempotently. Fixed baseline data is inserted or updated without obvious duplicate-corruption risk.

**References:**
- `checkout-forge/packages/db/src/seed.ts:43` — product seed.
- `checkout-forge/packages/db/src/seed.ts:62` — sale-offer seed.
- `checkout-forge/packages/db/src/seed.ts:132` — preset seed call.
- `checkout-forge/packages/db/src/demo-presets.ts:281` — insert-missing preset behavior.
- `checkout-forge/apps/api/src/services/public-runtime-policy-service.ts:45` — lazy policy seed.

#### Compared behavior

Surge also seeds the baseline product, catalog offer, presets, scratch/custom presets, and active runtime policy singleton idempotently.

**References:**
- `checkout-surge/packages/db/src/scripts/seed.ts:55` — product seed.
- `checkout-surge/packages/db/src/scripts/seed.ts:77` — sale-offer seed.
- `checkout-surge/packages/db/src/scripts/seed.ts:104` — fixed preset seed.
- `checkout-surge/packages/db/src/scripts/seed.ts:141` — scratch/custom preset handling.
- `checkout-surge/packages/db/src/scripts/seed.ts:146` — runtime policy seed.

#### Verdict rationale

The seeding entry points differ, but both create the required durable baseline in an idempotent way.

### C18 — Cleanup and retention tooling (same)

#### Reference behavior

Forge provides retention-aware durable cleanup for old generated-run history. It preserves live runs, deletes dependent run-scoped rows, and removes generated sale offers for deleted runs. Its terminal-run maintenance cleanup does not appear to remove Redis inventory/idempotency namespaces.

**References:**
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:18` — default retention.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:50` — active-run preservation.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:72` — dependent-row cleanup.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:110` — generated-offer cleanup.
- `checkout-forge/apps/api/src/repositories/demo-run-summary-repository.ts:143` — run-summary cleanup caller.

#### Compared behavior

Surge exposes durable cleanup through a token-protected admin maintenance path separate from reset. It preserves live runs, filters cleanup to old terminal runs, deletes run-scoped dependents, removes generated sale offers, and adds an age threshold. Like Forge, old-run durable cleanup does not appear to delete Redis inventory/idempotency keys.

**References:**
- `checkout-surge/scripts/maintenance-cleanup-runs.mjs:7` — maintenance script token requirement.
- `checkout-surge/packages/contracts/src/demo.ts:527` — cleanup defaults.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:150` — active-run preservation.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:188` — dependent-row cleanup.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:211` — generated-offer cleanup.

#### Verdict rationale

Surge changes the operational surface and adds an age threshold, but the core durable cleanup semantics are equivalent: reset does not erase history, live runs are preserved, and old generated-run data is removed as a graph. Both share the Redis namespace cleanup gap for deleted terminal runs.

### C19 — Redis keyspace and run isolation (better)

#### Reference behavior

Forge scopes inventory state by sale offer and keeps run/sale eligibility in a separate Redis cache that is checked before the stock Lua operation.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:287` — inventory keyspace helper.
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:80` — eligibility cache population.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:87` — eligibility checked before reservation.

#### Compared behavior

Surge still scopes inventory by sale offer, but it stores generated-run scope and accepting/closed state inside the inventory state that the reservation Lua script evaluates. Run closure updates inventory state and eligibility together in Redis.

**References:**
- `checkout-surge/packages/db/src/redis-inventory.ts:102` — inventory keyspace helper.
- `checkout-surge/packages/db/src/redis-inventory.ts:150` — run scope stored in inventory state.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:117` — Lua scope/status validation.
- `checkout-surge/packages/db/src/redis-inventory.ts:256` — run closure update.

#### Verdict rationale

Surge is better because close-vs-reserve ordering is serialized closer to the actual stock gate.

### C20 — Atomic stock gate and oversell safety (same)

#### Reference behavior

Forge uses one Redis Lua script for the reservation decision, including idempotency check, stock check, decrement, reserved counter update, hold write, expiry tracking, event write, and pending idempotency write.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:127` — reservation Lua script.
- `checkout-forge/packages/db/src/redis-inventory.ts:173` — remaining-stock boundary check.
- `checkout-forge/packages/db/src/redis-inventory.ts:345` — single `redis.eval` invocation.

#### Compared behavior

Surge also uses one Redis Lua script and one `redis.eval` for the reservation decision, with the same decrement-to-zero protection and quantity handling.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:83` — reservation Lua script.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:234` — remaining-stock boundary check.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:305` — single `redis.eval` invocation.

#### Verdict rationale

Both implementations satisfy the no-oversell primitive: one serialized Redis operation owns stock decisions.

### C21 — Atomic idempotency pending record (same)

#### Reference behavior

Forge writes the accepted hold, expiry score, inventory event, and pending idempotency record before returning from the same Lua operation.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:198` — hold and expiry writes.
- `checkout-forge/packages/db/src/redis-inventory.ts:213` — pending idempotency record.
- `checkout-forge/packages/db/src/redis-inventory.ts:219` — idempotency TTL.

#### Compared behavior

Surge does the same and additionally writes the pending-persistence ZSET member inside the initial reservation Lua script.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:243` — hold and expiry writes.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:270` — pending idempotency record.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:277` — idempotency TTL.

#### Verdict rationale

Both avoid the dangerous crash window where stock is decremented but no idempotency record exists.

### C22 — Idempotency conflict rule (same)

#### Reference behavior

Forge scopes idempotency by sale offer plus idempotency key. A repeat with the same quantity replays, while the same key with a different quantity conflicts.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:297` — idempotency key scope.
- `checkout-forge/packages/db/src/redis-inventory.ts:145` — conflict comparison.

#### Compared behavior

Surge uses the same effective rule: sale-offer-scoped idempotency key plus quantity comparison.

**References:**
- `checkout-surge/packages/db/src/redis-inventory.ts:114` — idempotency key scope.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:139` — conflict comparison.

#### Verdict rationale

Neither implementation compares a broader request fingerprint at this primitive layer, so the behavior is equivalent.

### C23 — Sold-out cheap path (same)

#### Reference behavior

Forge's sold-out branch increments Redis aggregate counters and returns without stock decrement, idempotency storage, or PostgreSQL writes.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:173` — sold-out branch.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:145` — rejected response mapping.

#### Compared behavior

Surge's sold-out branch follows the same cost profile: Redis aggregate only, then rejected response mapping without durable writes.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:234` — sold-out branch.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:191` — rejected response mapping.

#### Verdict rationale

Both keep losing requests cheap enough for surge conditions.

### C24 — Pending-persistence Redis sentinel timing (better)

#### Reference behavior

Forge creates the pending idempotency record in the initial Lua script, but only adds the reservation to the `pending-persistence` ZSET later, after API-side persistence failure handling.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:198` — initial hold write.
- `checkout-forge/packages/db/src/redis-inventory.ts:213` — pending idempotency record.
- `checkout-forge/packages/db/src/redis-inventory.ts:240` — later response finalization script.
- `checkout-forge/packages/db/src/redis-inventory.ts:261` — pending-persistence ZSET write.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:178` — persistence failure handling.

#### Compared behavior

Surge adds the reservation ID to the pending-persistence ZSET inside the initial reservation Lua script, then removes it atomically when persistence is promoted to accepted.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:247` — initial pending-persistence sentinel.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:70` — accepted promotion script.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:77` — sentinel removal.

#### Verdict rationale

Surge makes every Redis-secured but not-yet-promoted hold visible immediately. Forge can hide a hold if the process dies after the stock script but before later failure handling.

### C25 — Redis-secured hold failure and retry reconciliation (better)

#### Reference behavior

Forge preserves Redis-secured holds after PostgreSQL failure and returns a pending-persistence response, but later retries mainly replay the pending response rather than attempting durable reconciliation from the original hold.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:178` — PostgreSQL failure catch path.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:200` — pending-persistence response.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:289` — pending replay behavior.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:192` — pending persistence insert.

#### Compared behavior

Surge keeps the same pending response behavior, but a later retry for a pending Redis record can inspect durable rows and retry the original durable write without consuming new stock. Its pending row insert is idempotent, and successful persistence marks it reconciled.

**References:**
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:246` — persistence failure handling.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:272` — retry reconciliation path.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:399` — pending response creation.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:151` — idempotent pending row insert.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:118` — reconciled marker.

#### Verdict rationale

Surge has a stronger partial-failure recovery loop. It can turn an eligible retry into durable reservation/order rows without additional stock consumption.

### C26 — Uninitialized-inventory behavior (same)

#### Reference behavior

Forge fails closed when inventory state is missing and maps that condition to a service-unavailable response.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:163` — missing inventory check.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:121` — API mapping.

#### Compared behavior

Surge also fails closed when the inventory state key is missing and maps that outcome to HTTP 503.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:109` — missing inventory check.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:191` — rejected outcome mapping.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:92` — HTTP status mapping.

#### Verdict rationale

Both implementations behave correctly when traffic arrives before seeding or after cleanup.

### C27 — Inventory status projection (better)

#### Reference behavior

Forge projects allocated, remaining, reserved, last-updated, pending-persistence count, expired-hold count, and oldest pending age from Redis inventory state.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:401` — status projection.
- `checkout-forge/apps/api/src/services/inventory-status-service.ts:28` — API status mapping.

#### Compared behavior

Surge exposes the same inventory status route shape and preserves those core fields. It adds sold-out pressure plus a reservation-throughput ring, and validates sale-offer identity and stock arithmetic before returning status.

**References:**
- `checkout-surge/packages/db/src/redis-inventory.ts:204` — status projection.
- `checkout-surge/packages/db/src/redis-inventory.ts:222` — sale-offer identity check.
- `checkout-surge/packages/db/src/redis-inventory.ts:232` — stock arithmetic invariant.
- `checkout-surge/packages/contracts/src/inventory.ts:36` — additional status fields.
- `checkout-surge/apps/api/src/routes/inventory-routes.ts:16` — inventory status route.

#### Verdict rationale

Surge is better because it gives operators more useful hot-path visibility and catches malformed Redis state.

### C28 — Initialization and reset key hygiene (better)

#### Reference behavior

Forge reset deletes a fixed set of inventory keys plus matching idempotency keys, then recreates the inventory state. Demo-run creation calls this reset before run eligibility initialization.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:302` — reset key list.
- `checkout-forge/packages/db/src/redis-inventory.ts:313` — idempotency key cleanup.
- `checkout-forge/packages/db/src/redis-inventory.ts:328` — state recreation.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:145` — run creation reset call.

#### Compared behavior

Surge scans and unlinks the full `inventory:{saleOfferId}:*` namespace, clears previous run eligibility when known, initializes run scope, zeroes sold-out aggregates, and writes an initialization event. It uses SCAN/UNLINK rather than a blocking fixed-list deletion.

**References:**
- `checkout-surge/packages/db/src/redis-inventory.ts:118` — initializer entry.
- `checkout-surge/packages/db/src/redis-inventory.ts:144` — namespace cleanup.
- `checkout-surge/packages/db/src/redis-inventory.ts:150` — initialized state.
- `checkout-surge/packages/db/src/redis-inventory.ts:356` — SCAN/UNLINK helper.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:483` — run start initializer call.

#### Verdict rationale

Surge's initializer is more complete, less blocking, and more resilient to future keys in the inventory namespace.

### C29 — TTL and expiry edge cases (worse)

#### Reference behavior

Forge uses the baseline hold and idempotency TTL defaults, tracks expired holds without auto-release, and refreshes the idempotency key TTL when finalizing the stored accepted response.

**References:**
- `checkout-forge/apps/api/src/config.ts:47` — hold and idempotency TTL defaults.
- `checkout-forge/packages/db/src/redis-inventory.ts:198` — expiry score write.
- `checkout-forge/packages/db/src/redis-inventory.ts:411` — expired hold count.
- `checkout-forge/packages/db/src/redis-inventory.ts:240` — final response TTL refresh.

#### Compared behavior

Surge uses the same default TTLs and adds validation that `expiresAt` is later than `securedAt`. However, accepted promotion requires the idempotency key still to exist and uses `KEEPTTL`, so promotion does not refresh the replay window.

**References:**
- `checkout-surge/apps/api/src/runtime/config.ts:38` — hold and idempotency TTL defaults.
- `checkout-surge/packages/db/src/redis-inventory.ts:214` — expired hold count.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:394` — expiry validation.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:52` — promotion requires existing key.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:77` — `KEEPTTL` promotion.

#### Verdict rationale

Surge improves hold-window validation, but the accepted-idempotency lifecycle is weaker. A late promotion can fail after key expiry, and successful promotion does not extend replay availability.

### C30 — Recent inventory event retention (worse)

#### Reference behavior

Forge keeps the last 500 inventory events in the hot-path Redis event list.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:201` — event append.
- `checkout-forge/packages/db/src/redis-inventory.ts:211` — trim to 500.

#### Compared behavior

Surge caps the same kind of inventory event list at 100 entries.

**References:**
- `checkout-surge/packages/db/src/redis-inventory.ts:9` — event retention constant.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:12` — reservation event retention constant.
- `checkout-surge/packages/db/src/redis-inventory.ts:170` — initialization event trim.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:267` — reservation event trim.

#### Verdict rationale

This does not affect oversell safety, but it reduces operator/debug visibility compared with the baseline.

### C31 — Two-phase buy orchestration and ERP separation (same)

#### Reference behavior

Forge keeps `/buy` as a reservation-only API path. The route validates the request, delegates to the reservation service, persists reservation/order state, enqueues the downstream order-processing job, stores the idempotency response, emits advisory dashboard signals, and returns reservation feedback without calling the ERP.

**References:**
- `checkout-forge/apps/api/src/routes/buy.ts:45` — `/buy` delegates to the reservation service.
- `checkout-forge/apps/api/src/routes/buy.ts:54` — non-rejected buy responses use 202.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:166` — accepted path persists durable reservation/order state.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:222` — accepted path enqueues order processing.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:224` — accepted idempotency response is stored after enqueue.

#### Compared behavior

Surge preserves the same two-phase shape. The route validates and returns 202 for secured, replayed, and pending-persistence responses; the reservation service creates the Redis hold, persists durable rows, enqueues BullMQ work, promotes Redis idempotency, and returns without synchronously confirming with ERP.

**References:**
- `checkout-surge/apps/api/src/routes/buy-routes.ts:30` — route validates the reservation response contract.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:92` — 202 is used for secured, replayed, and pending responses.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:246` — accepted path persists durable reservation/order state.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:263` — accepted path enqueues order processing.
- `checkout-surge/apps/api/src/queue/bullmq-order-process-job-publisher.ts:56` — API publishes a BullMQ job rather than calling ERP.

#### Verdict rationale

Surge is equivalent at the high-level buy contract boundary. Both implementations return immediate reservation feedback and leave final confirmation to asynchronous worker processing.

### C32 — Per-request run/sale eligibility gate (worse)

#### Reference behavior

Forge uses a Redis-backed cached run/sale eligibility record on the buy path. Run start populates Redis with the run, sale offer, status, and serialized offer; each buy request checks that cache and fails closed on a miss, mismatch, or non-accepting status. PostgreSQL is not consulted per losing request.

**References:**
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:29` — cached eligibility shape.
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:80` — eligibility is stored in Redis.
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:110` — per-request lookup reads cached eligibility.
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:120` — miss, mismatch, or non-accepting status fails closed.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:87` — reservation service gates before Redis stock reserve.

#### Compared behavior

Surge has a useful Redis-side run/sale backstop inside the inventory Lua script, but the wired API path also performs a PostgreSQL query for every run-attributed buy before reaching Redis. That query checks the `demo_runs` row by `(runId, saleOfferId)` and status, so ineligible or sold-out surge traffic can still hit PostgreSQL.

**References:**
- `checkout-surge/apps/api/src/services/generated-run-sale-gate.ts:10` — per-request gate method.
- `checkout-surge/apps/api/src/services/generated-run-sale-gate.ts:11` — gate performs a PostgreSQL select.
- `checkout-surge/apps/api/src/services/generated-run-sale-gate.ts:17` — only starting/active rows accept traffic.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:159` — buy path calls the PostgreSQL gate before Redis reserve.
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:121` — Lua also rejects mismatched or closed run sales.

#### Verdict rationale

Surge is stronger at the Redis primitive boundary, but worse for the buy hot path. The extra PostgreSQL gate violates the cached-eligibility requirement and makes losing traffic more expensive than Forge's Redis-only per-request check.

### C33 — Buy outcome headers and load-generator classification (worse)

#### Reference behavior

Forge defines shared machine-readable buy outcome and rejection-reason headers. The buy route emits those headers for every response, and the k6 script discards response bodies while classifying accepted and sold-out outcomes from headers.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:78` — buy outcome header name.
- `checkout-forge/packages/contracts/src/buy-flow.ts:79` — buy rejection-reason header name.
- `checkout-forge/apps/api/src/routes/buy.ts:56` — route emits the outcome header.
- `checkout-forge/apps/api/src/routes/buy.ts:58` — route emits rejection reason for rejected responses.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:54` — k6 discards response bodies.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:111` — k6 classifies from headers.

#### Compared behavior

Surge does not define or emit comparable checkout outcome/rejection headers. Its route only adds `retry-after` for pending-persistence responses, and the k6 script parses `response.json("outcome")` without enabling discarded response bodies.

**References:**
- `checkout-surge/packages/contracts/src/buy.ts:16` — buy contract defines load-run attribution header only.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:37` — route derives status from body outcome.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:38` — only pending-persistence gets an extra response header.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:52` — generated options do not set `discardResponseBodies`.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:85` — k6 reads outcome from the JSON body.

#### Verdict rationale

This is a direct regression from the baseline surge contract. Surge can classify responses, but it depends on response body parsing instead of stable headers designed for high-volume load generation.

### C34 — Buy response taxonomy, status codes, and retry guidance (better)

#### Reference behavior

Forge's buy response union has secured, pending-persistence, and rejected variants. Sold-out and sale-not-active are rejection reasons, while idempotency conflicts and missing inventory are thrown as API errors outside the buy response union. Pending-persistence includes retry guidance in the JSON body, but not an HTTP `Retry-After` header.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:25` — secured response variant.
- `checkout-forge/packages/contracts/src/buy-flow.ts:44` — pending-persistence response variant.
- `checkout-forge/packages/contracts/src/buy-flow.ts:63` — rejected response variant.
- `checkout-forge/apps/api/src/routes/buy.ts:54` — rejected responses map to 409, others to 202.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:121` — missing inventory throws a 503 API error.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:130` — idempotency conflict throws a 409 API error.

#### Compared behavior

Surge exposes more buy outcomes as typed responses: secured, replay, pending-persistence, sold-out, missing inventory, idempotency conflict, and invalid quantity. The route maps them to 202, 400, 409, or 503 and emits an HTTP `retry-after` header for pending-persistence responses. Its ineligible-run mapping is less clean because run-not-accepting traffic is encoded under `inventory_not_initialized`.

**References:**
- `checkout-surge/packages/contracts/src/buy.ts:29` — accepted responses include secured and idempotent replay outcomes.
- `checkout-surge/packages/contracts/src/buy.ts:41` — pending-persistence carries `retryAfterSeconds`.
- `checkout-surge/packages/contracts/src/buy.ts:56` — rejected union includes sold-out, missing inventory, conflict, and invalid quantity.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:38` — pending-persistence emits `retry-after`.
- `checkout-surge/apps/api/src/routes/buy-routes.ts:92` — route maps outcomes to status codes.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:182` — run-not-accepting traffic is distinguished as a rejection reason.

#### Verdict rationale

Despite the imperfect ineligible-run label and the missing headers graded in C33, Surge has a more machine-checkable JSON/status taxonomy and stronger HTTP retry guidance for pending persistence.

### C35 — Idempotent replay response fidelity (worse)

#### Reference behavior

Forge stores the accepted or pending response in Redis after persistence, stripping only the current correlation ID. Replays return the stored business payload with the caller's correlation ID reattached, so the outcome remains the original secured or pending response rather than a replay-specific variant.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:139` — Redis idempotent replays convert back to buy responses.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:224` — accepted response is stored in Redis.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:302` — secured replay returns stored secured response.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:308` — pending replay returns stored pending response.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:321` — only correlation ID is stripped before storage.

#### Compared behavior

Surge reconstructs accepted replays from durable reservation/order rows and returns a distinct `idempotent_replay` outcome with a fresh timestamp. On durable replay it also reasserts the queue job and attempts Redis promotion before responding.

**References:**
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:213` — replay path reads durable rows by reservation ID.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:217` — persisted replay re-enqueues before responding.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:223` — persisted replay returns `idempotent_replay`.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:465` — response builder distinguishes secured from replay.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:471` — replay response gets a fresh timestamp.

#### Verdict rationale

Surge's replay path is useful for recovery, but it is less faithful to the original response. Duplicate accepted requests get a different outcome label and timestamp, whereas Forge more closely replays the stored original response.

### C36 — PostgreSQL work on the accepted hot path (worse)

#### Reference behavior

Forge keeps accepted-path PostgreSQL work compact. After Redis accepts a reservation, one SQL statement inserts the reservation, queued order, and lifecycle events through CTEs. The API PostgreSQL pool size is explicitly configured, and sold-out losers do not consult PostgreSQL.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:166` — accepted path calls durable persistence after Redis reserve.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:77` — one SQL statement starts reservation/order/event CTE persistence.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:103` — order insert is part of the same statement.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:128` — lifecycle events insert in the same statement.
- `checkout-forge/apps/api/src/config.ts:42` — API PostgreSQL pool max is configured.

#### Compared behavior

Surge performs more synchronous PostgreSQL work. It does a pre-Redis PostgreSQL gate for run-attributed traffic, then opens a transaction and issues separate reservation, order, event, and pending-persistence reconciliation operations after Redis accepts.

**References:**
- `checkout-surge/apps/api/src/services/generated-run-sale-gate.ts:11` — run/sale gate performs PostgreSQL read before Redis reserve.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:24` — accepted persistence starts a transaction.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:25` — reservation insert.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:54` — order insert.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:87` — lifecycle event insert.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:118` — pending-persistence reconciliation update.

#### Verdict rationale

Surge's persistence is clear and transactional, but it has more synchronous database round trips and adds the pre-Redis PostgreSQL read from C32. That is worse for the latency-critical 10k-in-1s path.

### C37 — PostgreSQL persistence failure and pending-persistence response (better)

#### Reference behavior

Forge catches PostgreSQL persistence failure after Redis has secured the hold, records a durable pending-persistence row, stores a pending Redis idempotency response, and returns `reservation_pending_persistence` with `order: null`. The recovery writes are awaited directly; if they fail, the buyer response can become a route error even though Redis stock was already held.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:178` — PostgreSQL failure catch starts.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:188` — durable pending-persistence row is recorded.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:200` — pending-persistence response is created.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:206` — pending response is stored in Redis.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:192` — pending row insert is plain insert.

#### Compared behavior

Surge preserves the same buyer-visible pending response but makes the reporting and marker writes best effort. It attempts to upsert a pending-persistence row, ensures the Redis pending marker, and still returns pending even if those recovery writes fail. The pending row write is idempotent through conflict update.

**References:**
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:250` — PostgreSQL failure catch starts.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:255` — pending persistence is recorded without hiding buyer response.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:259` — Redis pending marker is ensured.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:260` — pending response is returned.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:413` — durable pending write failures are caught and reported.
- `checkout-surge/apps/api/src/services/postgres-buy-persistence.ts:172` — pending row insert uses conflict update.

#### Verdict rationale

Surge is more resilient on the Redis-ok/PostgreSQL-failed path. The buyer is more likely to receive the mandated pending-persistence response, and repeated attempts can update the same pending row.

### C38 — Queue publish and Redis promotion partial states (better)

#### Reference behavior

Forge persists durable rows, publishes the queue job, then stores the accepted idempotency response in Redis. If queue publish fails after persistence, durable reservation/order rows remain without a queue job or accepted Redis response. If Redis response storage fails after queue publish, the route errors with durable rows and a queue job present while Redis can still replay the original pending hold.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:166` — persistence happens before enqueue.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:222` — queue publish happens after persistence.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:224` — accepted Redis response is stored after queue publish.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:270` — only dashboard emission is caught locally.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:294` — unpromoted Redis pending record replays as pending persistence.

#### Compared behavior

Surge acknowledges the PostgreSQL/BullMQ split and makes the partial states more recoverable. It uses the order ID as a deterministic BullMQ job ID, reasserts the job on durable idempotent replays before Redis promotion, and catches promotion failure without hiding durable success from the current buyer response.

**References:**
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:217` — durable replay re-enqueues the persisted buy.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:263` — new accepted path enqueues before promotion.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:264` — Redis promotion follows enqueue.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:360` — deterministic reassertion before promotion is documented.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:385` — promotion failure is caught and reported.

#### Verdict rationale

Surge can still return an initial error if queue publish fails, but later replay can find durable rows, re-add the deterministic job, and promote Redis. That makes the accepted-path partial states more recoverable than Forge's.

### C39 — Dashboard update volume and aggregation policy (worse)

#### Reference behavior

Forge bounds high-frequency dashboard work. Sold-out losers stay cheap in Redis and the API, then observations are batched by an in-process aggregator and flushed every 500 ms per run/offer, with a shutdown flush. Live traffic-state persistence is also throttled, and traffic metrics are folded into recovery state without turning every losing buy request into durable or realtime work.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:174` — sold-out branch increments aggregate count only.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:152` — API records sold-out pressure in aggregator.
- `checkout-forge/apps/api/src/services/sold-out-dashboard-metric-aggregator.ts:5` — default flush interval is 500 ms.
- `checkout-forge/apps/api/src/services/sold-out-dashboard-metric-aggregator.ts:120` — close flushes pending aggregates.
- `checkout-forge/apps/api/src/services/load-metric-stream-service.ts:44` — live run-state persistence defaults to a 1000 ms throttle.
- `checkout-forge/apps/api/src/services/dashboard-recovery-state-service.ts:93` — traffic metrics update latest recovery state.

#### Compared behavior

Surge also keeps each sold-out loser cheap, but the API buy service does not publish or batch an equivalent live sold-out dashboard signal. Sold-out pressure is exposed through Redis inventory status and copied/upserted into durable run outcomes around traffic completion/finalization. For traffic metrics, the API stores a capped recent list, but then iterates each ingested metric sample and awaits a dashboard publish for every sample. Business outcome updates also recompute database summaries and publish aggregate events after accepted reservations and worker-side transitions.

**References:**
- `checkout-surge/packages/db/src/redis-stock-reservation.ts:234` — sold-out branch is aggregate-only in Redis.
- `checkout-surge/packages/db/src/redis-inventory.ts:245` — inventory projection exposes Redis sold-out pressure.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:73` — stored traffic metric cap is 50 samples.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:532` — every metric sample is iterated for publication.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:533` — each metric sample is published as a dashboard event.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:218` — business outcome updates recompute summaries before publishing.

#### Verdict rationale

Surge avoids per-loser events and caps recovery storage, but its live observability cost profile is less bounded. It lacks Forge's 500 ms sold-out aggregate signal during the spike, emits traffic metrics per sample, and can make successful reservation/order churn pay for database-backed business-outcome recomputation.

### C40 — Surge tuning and startup configuration validation (worse)

#### Reference behavior

Forge makes surge tunables explicit and startup-validated. API config parses and range-checks port, PostgreSQL pool size, hold/idempotency/retry settings, public traffic caps, and `API_LISTEN_BACKLOG` with default 8192. It also cross-validates public policy caps against hard caps and passes the configured backlog to Fastify.

**References:**
- `checkout-forge/apps/api/src/config.ts:36` — Zod API environment schema.
- `checkout-forge/apps/api/src/config.ts:42` — separately tunable API PostgreSQL pool.
- `checkout-forge/apps/api/src/config.ts:49` — pending-persistence retry default is configured.
- `checkout-forge/apps/api/src/config.ts:74` — `API_LISTEN_BACKLOG` default is 8192.
- `checkout-forge/apps/api/src/config.ts:192` — public policy is cross-validated against hard traffic caps.
- `checkout-forge/apps/api/src/index.ts:264` — configured listen backlog is passed to the server.

#### Compared behavior

Surge has the major knobs: API backlog, API PostgreSQL pool, worker PostgreSQL pool, pending-persistence retry settings, and finalization polling, and it passes backlog to Fastify. Its env wrappers are strong (see C95), but runtime consumption is lighter: many numeric settings use generic positive-integer parsing, hard-cap cross-validation is not part of hot-path API config, `DEMO_RUN_DRAIN_TIMEOUT_SECONDS` is advertised by compose and API env examples without being consumed by the API runtime config, and the web tier reads critical backend URLs and secrets directly from `process.env` in proxy helpers instead of through one startup-validated config object.

**References:**
- `checkout-surge/apps/api/src/runtime/config.ts:20` — API runtime config loader.
- `checkout-surge/apps/api/src/runtime/config.ts:24` — `API_LISTEN_BACKLOG` default is 8192.
- `checkout-surge/apps/api/src/runtime/config.ts:27` — separately tunable API PostgreSQL pool.
- `checkout-surge/apps/api/src/runtime/config.ts:61` — finalization poll interval is parsed.
- `checkout-surge/apps/api/src/runtime/config.ts:84` — generic positive-integer parser lacks upper range checks.
- `checkout-surge/docker-compose.yml:69` — compose advertises `DEMO_RUN_DRAIN_TIMEOUT_SECONDS`.
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:105` — web proxy reads the control token directly from `process.env`.

#### Verdict rationale

Surge is aware of the same main surge knobs, so this is not missing. It is still worse because startup validation is less comprehensive and less range-specific, and because some advertised/runtime-critical variables are either unconsumed or validated lazily at call sites. That increases the risk of invalid or unsafe config surviving until the demo path is exercised.

### C41 — Duplicate accepted replay accounting (worse)

#### Reference behavior

Forge explicitly separates accepted HTTP responses from unique durable reservations. The k6 script counts accepted responses, including duplicate accepted replays, and finalization derives expected durable reservation counts for duplicate buyer-spike runs while cross-checking API lifecycle status counts and durable reservations/orders.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:113` — accepted response classification includes 202 secured/pending outcomes.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:121` — accepted response counter increments per accepted response.
- `checkout-forge/apps/api/src/services/accepted-reservation-accounting.ts:19` — accepted response count converts to durable reservation count.
- `checkout-forge/apps/api/src/services/accepted-reservation-accounting.ts:26` — duplicate buyer-spike mode is handled specially.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:741` — API lifecycle 202 responses are counted.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:787` — finalization checks accepted response mismatch conditions.

#### Compared behavior

Surge's k6 script counts HTTP 202 responses, so duplicate accepted replays are counted at the traffic layer. However, API finalization primarily reads durable business outcome counts from PostgreSQL reservations/orders as `acceptedReservations`; the inspected finalization flow does not derive expected unique reservations from accepted response counts or compare duplicate accepted-response accounting against durable rows the way Forge does.

**References:**
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:92` — any 202 increments accepted responses.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:611` — traffic outcome summary is stored with completion data.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:52` — business outcome summary counts durable reservations and orders.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:63` — accepted reservations are counted from durable secured reservations.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:145` — finalization reads durable business outcome summary.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:221` — terminal snapshot uses durable accepted reservation count.

#### Verdict rationale

Surge preserves accepted-response counts in traffic summaries, but it does not appear to use them for the duplicate replay reconciliation that Forge performs. That weakens finalization accounting for idempotency-check runs where accepted HTTP responses intentionally outnumber unique durable reservations.

### C42 — Durable preset catalog and preset mutation controls (same)

#### Reference behavior

Forge seeds the expected public read-only presets, including preview, surge, idempotency-check, and public-custom. It also seeds a persisted editable admin `custom` scratch preset. Preset updates are restricted to editable presets, and duplicate/copy-to-custom flows create or update admin presets rather than mutating public presets.

**References:**
- `checkout-forge/packages/db/src/demo-presets.ts:81` — default preset catalog starts.
- `checkout-forge/packages/db/src/demo-presets.ts:214` — public-custom preset is public and read-only.
- `checkout-forge/packages/db/src/demo-presets.ts:247` — admin `custom` scratch preset is editable.
- `checkout-forge/packages/db/src/demo-presets.ts:359` — save rejects non-editable presets.
- `checkout-forge/packages/db/src/demo-presets.ts:444` — duplicate creates an editable admin preset.
- `checkout-forge/packages/db/src/demo-presets.ts:476` — copy-to-custom updates the persisted custom preset.

#### Compared behavior

Surge seeds the same public shapes and persisted admin scratch preset. Its schema enforces public presets as read-only, admin save requires an editable admin preset, duplicate creates an admin editable preset, and copy-to-custom writes only the admin `custom` preset.

**References:**
- `checkout-surge/packages/db/src/scripts/seed.ts:182` — seed preset list starts.
- `checkout-surge/packages/db/src/scripts/seed.ts:238` — idempotency-check public preset.
- `checkout-surge/packages/db/src/scripts/seed.ts:260` — public-custom read-only base.
- `checkout-surge/packages/db/src/scripts/seed.ts:324` — admin `custom` scratch preset.
- `checkout-surge/packages/db/src/schema.ts:190` — database check keeps public presets non-editable.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:287` — admin save requires editable admin preset.

#### Verdict rationale

Surge preserves the durable preset model and mutation boundary. Its seed values and flags differ in places, but public presets remain read-only and editable state stays in admin-owned presets.

### C43 — Accepted run configuration snapshots and public custom handling (same)

#### Reference behavior

Forge resolves the accepted run configuration before creation, using either preset configuration, submitted public-custom configuration, or active runtime policy defaults. It stores that accepted configuration as the run's immutable `configSnapshot`, so later preset or policy edits do not alter started runs.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:102` — requested configuration is separated from the preset.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:118` — public-custom defaults come from runtime policy.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:122` — accepted configuration is parsed before run creation.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:127` — run is created with the accepted snapshot.
- `checkout-forge/packages/db/src/demo-runs.ts:57` — DB creation re-parses the config snapshot.

#### Compared behavior

Surge also resolves and validates an accepted snapshot before run creation, then stores it in `demo_runs.config_snapshot`. For public custom starts, it uses active runtime-policy `publicCustomDefaults` as the base and applies request overrides only to the run snapshot.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:449` — active public runtime policy is read before accepting config.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:451` — accepted config is resolved before run creation.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:452` — accepted snapshot is validated against caps.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:773` — public custom base comes from policy defaults.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:785` — accepted snapshot is parsed after overrides.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:728` — stored run row receives `configSnapshot`.

#### Verdict rationale

Both implementations freeze the accepted run configuration into the run row and avoid linking terminal behavior to mutable preset rows. Surge's public-custom path remains a run input/policy-default flow rather than mutating the public preset.

### C44 — Generated run sale offers and isolated inventory initialization (same)

#### Reference behavior

Forge creates a generated sale offer for each normal run, links it through the run-sale context, initializes Redis inventory for that generated offer, and initializes run-sale eligibility. Initialization failure is handled as a terminal run failure rather than leaving an ambiguous started run.

**References:**
- `checkout-forge/packages/db/src/demo-runs.ts:75` — generated sale offer is inserted per run.
- `checkout-forge/packages/db/src/demo-runs.ts:90` — run row stores the generated sale offer ID.
- `checkout-forge/packages/db/src/demo-runs.ts:111` — run-sale context links run and generated offer.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:145` — Redis inventory is initialized for the generated offer.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:152` — run-sale eligibility is initialized.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:157` — initialization failure marks the run failed.

#### Compared behavior

Surge also creates a generated sale offer, stores the run's generated sale offer ID, links the run-sale context, and initializes Redis inventory as accepting for that generated run. If inventory initialization fails, it uses the terminal failure path.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:483` — Redis inventory initialization starts after run creation.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:489` — generated run inventory is initialized as accepting.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:491` — initialization failure calls terminal failure path.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:708` — generated sale offer is inserted per run.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:721` — run row stores generated sale offer and snapshot.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:742` — run-sale context is inserted.

#### Verdict rationale

The run isolation model is equivalent. Both allocate a fresh generated offer and Redis inventory namespace per run, so repeated runs are not coupled to shared baseline inventory.

### C45 — One active-or-draining run start gate (same)

#### Reference behavior

Forge serializes run creation with a PostgreSQL advisory transaction lock and rejects a new start if any run is `starting`, `active`, or `draining`. The lock wraps both active-run lookup and creation, preventing concurrent starts from both passing the check.

**References:**
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:19` — active statuses include starting, active, and draining.
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:36` — create path uses active-run lock.
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:40` — advisory lock wraps the transaction.
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:56` — active run lookup checks active statuses.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:136` — active conflict is surfaced as a start rejection.

#### Compared behavior

Surge uses its own PostgreSQL advisory transaction lock around start creation. Inside that locked transaction it checks for an existing `starting`, `active`, or `draining` run and rejects before inserting generated offer and run rows.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:71` — start-lock key definition.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:672` — run creation transaction starts.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:673` — advisory transaction lock is acquired.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:675` — active-or-draining run lookup.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:681` — active conflict rejection.

#### Verdict rationale

Both implementations enforce the one-live-run rule at the API creation boundary with database serialization, and both include draining runs in the conflict window.

### C46 — Traffic completion handoff into draining (same)

#### Reference behavior

Forge treats the load orchestrator as the source of traffic execution facts, not the owner of run completion. A traffic report stores traffic summaries, moves the API run to `draining`, closes sale eligibility to new buy traffic, and then evaluates whether business work has settled.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:184` — traffic report ingestion path.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:198` — traffic summary is upserted durably.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:203` — traffic report updates run state.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:215` — run-sale eligibility is updated after traffic completion.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:238` — finalization is evaluated after traffic handling.

#### Compared behavior

Surge also records traffic completion separately from business completion. It inserts the finalization input, moves the run to `draining` only from `starting` or `active`, closes Redis run-sale eligibility, publishes a run update, and invokes the finalizer.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:546` — traffic completion report ingestion starts.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:604` — finalization input is inserted.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:628` — API run is moved to `draining`.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:641` — run-sale eligibility is closed after traffic completion.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:654` — run update is published before finalization attempt.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:657` — finalization runs after draining transition.

#### Verdict rationale

Surge preserves the key lifecycle distinction: traffic completion creates a draining run, and terminal completion remains API-owned after business settlement.

### C47 — Business-drain finalization and timeout semantics (same)

#### Reference behavior

Forge's API-owned finalization poller evaluates draining runs. It checks pending persistence, queued/processing orders, missing notifications, accepted-reservation accounting, and API lifecycle counts. Before timeout it keeps the run draining; after timeout it fails with stable reasons such as pending reconciliation timeout or business drain timeout.

**References:**
- `checkout-forge/apps/api/src/index.ts:191` — finalization service receives configured drain timeout.
- `checkout-forge/apps/api/src/index.ts:207` — finalization poller evaluates draining runs on interval.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:251` — draining candidates are polled.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:446` — drain state is read from durable business rows.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:505` — blockers must clear before completion.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:570` — timeout converts blockers into stable failures.

#### Compared behavior

Surge also runs an API-owned finalization poller over draining runs. It reads run-scoped business outcomes, blocks on pending persistence, queued/processing/retrying orders, and missing notifications, then uses the frozen run snapshot's drain timeout to bound settlement. Timeout fails with `business_drain_timeout`.

**References:**
- `checkout-surge/apps/api/src/index.ts:288` — finalization poller is started.
- `checkout-surge/apps/api/src/runtime/config.ts:61` — finalization poll interval defaults to 5 seconds.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:57` — poller scans draining runs.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:143` — finalization parses immutable run snapshot.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:149` — business drain blockers are computed.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:176` — drain timeout comes from the frozen snapshot.

#### Verdict rationale

Surge's blocker set is somewhat simpler, especially around accepted-response reconciliation already graded in C41, but it still decouples traffic completion from business settlement and bounds draining with a snapshot-derived timeout.

### C48 — API-side traffic quality classification and terminal reasons (worse)

#### Reference behavior

Forge classifies traffic delivery quality in the API from raw delivery facts. It computes complete/warning/degraded/failed from request shortfall ratios, overlays that status onto traffic summaries, fails runs on unexpected responses, and fails major delivery shortfall with a stable `traffic_delivery_major_shortfall` reason only after drainable business work settles.

**References:**
- `checkout-forge/apps/api/src/services/traffic-delivery-classifier.ts:6` — API-side traffic delivery classifier.
- `checkout-forge/apps/api/src/services/traffic-delivery-classifier.ts:23` — shortfall ratio drives classification.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:188` — traffic reports are parsed and classified by API.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:416` — unexpected response traffic failure is checked.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:427` — classified delivery status is used in finalization.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:558` — major delivery shortfall fails after blockers clear.

#### Compared behavior

Surge has the delivery-status vocabulary, but the API completion contract requires the incoming report to already contain `trafficDeliveryStatus`. The finalizer trusts that stored status and maps only stored `failed` delivery status to major shortfall. The inspected finalization logic does not classify quality from raw planned/emitted counts and does not fail on unexpected response counts from the traffic outcome summary.

**References:**
- `checkout-surge/packages/contracts/src/lifecycle.ts:98` — delivery status vocabulary exists.
- `checkout-surge/packages/contracts/src/load.ts:134` — completion report requires preclassified delivery status.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:616` — traffic delivery summary is stored from the report.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:193` — finalizer parses stored delivery summary.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:196` — only stored `failed` maps to major shortfall.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:200` — run traffic failure maps generically to `traffic_failed`.

#### Verdict rationale

Surge supports terminal failure after traffic failure, but the API no longer owns delivery-quality classification from raw k6 facts. Trusting a preclassified load-side status and missing Forge's explicit unexpected-response terminal reason is worse for the run-control plane.

### C49 — Terminal summary idempotence and failure-path history (better)

#### Reference behavior

Forge routes terminal completion, failure, admin recovery, initialization failure, and traffic-start failure through a terminal summary service. The repository inserts the summary with `onConflictDoNothing` by run ID, marks the run finalized, and includes a Redis terminal inventory snapshot when available.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-start-service.ts:56` — traffic-start failure marks the created run failed.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:89` — shared terminal summary writer.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:136` — terminal inventory snapshot is captured.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:222` — summary and finalization changes are stored transactionally.
- `checkout-forge/apps/api/src/repositories/demo-run-summary-repository.ts:86` — summary insert is idempotent by run ID.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:262` — run row is marked finalized from the stored summary.

#### Compared behavior

Surge also uses one terminal summary writer for normal finalization, initialization/start failures, startup reconciliation, and admin reset. It adds a per-run PostgreSQL advisory transaction lock around terminal writes, checks for an existing summary under that lock, claims the terminal run only from allowed current statuses, and inserts one summary with the supplied terminal inventory snapshot.

**References:**
- `checkout-surge/apps/api/src/services/terminal-demo-run-transition.ts:47` — per-run terminal advisory lock key.
- `checkout-surge/apps/api/src/services/terminal-demo-run-transition.ts:60` — shared terminal writer entrypoint.
- `checkout-surge/apps/api/src/services/terminal-demo-run-transition.ts:62` — existing summary is checked inside the lock.
- `checkout-surge/apps/api/src/services/terminal-demo-run-transition.ts:82` — terminal run is claimed before summary insert.
- `checkout-surge/apps/api/src/services/terminal-demo-run-transition.ts:96` — terminal summary row is inserted once.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:845` — initialization/start failure path uses the shared writer.

#### Verdict rationale

Both satisfy the exactly-one-history-record requirement through a unique run summary. Surge is stronger against finalization/admin-reset/startup races because it serializes terminal writes with a per-run advisory transaction lock and an allowed-current-status claim.

### C50 — API startup reconciliation of interrupted and draining runs (same)

#### Reference behavior

Forge reconciles `starting`, `active`, and `draining` runs on API startup. Interrupted `starting` and `active` runs receive finalization records and summaries with stable `api_restart_interrupted_run`; draining runs are reported but not failed, so the normal finalization poller can continue settling them.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:8` — startup reconciliation covers starting, active, and draining.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:57` — recoverable runs are listed.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:58` — starting/active runs are interrupted.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:61` — interrupted runs get finalization rows and summaries.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:66` — terminal writer fails interrupted runs.
- `checkout-forge/apps/api/src/index.ts:204` — reconciliation runs before API server setup completes.

#### Compared behavior

Surge performs the same startup scan. It closes sale eligibility and writes failed summaries for interrupted starting/active runs with `api_restart_interrupted_run`, including business outcome and terminal inventory when available. It preserves draining runs, repairs their sale eligibility to closed, and lets the regular finalization poller resume.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:48` — startup scan covers starting, active, and draining.
- `checkout-surge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:52` — starting/active runs are interrupted.
- `checkout-surge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:60` — interrupted runs are processed.
- `checkout-surge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:85` — terminal writer fails interrupted runs.
- `checkout-surge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:114` — draining runs are preserved and eligibility repaired closed.
- `checkout-surge/apps/api/src/index.ts:280` — reconciliation runs before finalization poller startup.

#### Verdict rationale

Surge matches the required recovery depth: interrupted starting/active runs are terminalized with a stable reason and draining runs survive process churn. Its explicit eligibility repair is useful, but not enough to grade above Forge's equivalent behavior.

### C51 — Admin reset recovery workflow (worse)

#### Reference behavior

Forge treats reset as recovery. It first recovers/finalizes any active-or-draining run through the shared terminal summary path, then clears reset-owned queues and live dashboard/sold-out aggregate state. The recovery service also aborts the active load run through the load-orchestrator client when available, so synthetic traffic stops as part of reset.

**References:**
- `checkout-forge/apps/api/src/services/demo-reset-service.ts:48` — reset starts by recovering any active run.
- `checkout-forge/apps/api/src/services/demo-reset-service.ts:55` — queues are cleared after recovery.
- `checkout-forge/apps/api/src/services/demo-reset-service.ts:56` — live dashboard state is cleared.
- `checkout-forge/apps/api/src/services/demo-reset-service.ts:57` — sold-out aggregate state is cleared.
- `checkout-forge/apps/api/src/services/demo-run-recovery-service.ts:100` — recoverable runs are durably marked failed.
- `checkout-forge/apps/api/src/services/demo-run-recovery-service.ts:148` — recovered traffic run is aborted.

#### Compared behavior

Surge reset also finds starting/active/draining runs, writes failed terminal summaries with `admin_reset`, closes run-sale eligibility, and cleans reset-owned BullMQ queues. The inspected reset path has no traffic-aborter counterpart and no explicit live dashboard-state clear; it relies on terminal writes, closed eligibility, and subsequent reads/events. The runtime reset client also calls only the API reset endpoint, so the operational reset command does not restore mock ERP chaos state the way Forge's multi-service reset client does.

**References:**
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:63` — admin reset entrypoint.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:65` — reset scans starting, active, and draining runs.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:81` — terminal writer fails live runs with admin-reset data.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:116` — run-sale eligibility is closed after reset finalization.
- `checkout-surge/apps/api/src/services/demo-maintenance-service.ts:131` — queue cleanup runs after terminalization.
- `checkout-surge/scripts/runtime-reset.mjs:11` — operational reset script calls only `/admin/demo/reset`.

#### Verdict rationale

Surge preserves history and closes eligibility, but it is weaker as a full recovery workflow. Without an explicit traffic aborter, live dashboard-state clear, or multi-service reset client, stale load execution, stale live projections, or stale ERP chaos settings can outlive an admin reset more easily than in Forge.

### C52 — Order-processing retry policy placement (worse)

#### Reference behavior

Forge sets BullMQ retry cadence on the producer side. The order queue has default exponential retry settings, and the API wires a run-backpressure job-options resolver that reads the immutable run snapshot and resolves per-run attempts/backoff at enqueue time. The worker separately enforces terminal-attempt logic.

**References:**
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:52` — queue default job options are installed on the producer.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:59` — enqueue resolves per-job options before adding the job.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:139` — default order-processing attempts are `3`.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:142` — default exponential backoff starts at `1_000` ms.
- `checkout-forge/apps/api/src/services/run-backpressure-policy-resolver.ts:31` — run snapshot backpressure config becomes job options.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:77` — worker still enforces terminal-attempt logic.

#### Compared behavior

Surge's API publisher uses process-level retry settings rather than the accepted run snapshot. The visible defaults are four attempts and 500 ms backoff from environment/runtime config. The worker uses `job.opts.attempts` for terminality, but no producer-side resolver derives attempts/backoff from each run snapshot.

**References:**
- `checkout-surge/apps/api/src/queue/bullmq-order-process-job-publisher.ts:32` — default retry options are local constants.
- `checkout-surge/apps/api/src/queue/bullmq-order-process-job-publisher.ts:57` — enqueue applies fixed `retryOptions.maxAttempts`.
- `checkout-surge/apps/api/src/queue/bullmq-order-process-job-publisher.ts:58` — enqueue applies fixed exponential backoff base.
- `checkout-surge/apps/api/src/runtime/config.ts:28` — retry attempts come from process environment.
- `checkout-surge/apps/api/src/index.ts:106` — API wires process-level retry options into publisher.
- `checkout-surge/apps/worker/src/queue/bullmq-order-process-consumer.ts:187` — worker terminality reads BullMQ job attempts.

#### Verdict rationale

Surge still uses BullMQ retries, but retry cadence is not run-scoped. A correctly frozen run snapshot can be bypassed for retry timing, which is worse than Forge's per-run enqueue policy.

### C53 — Run-scoped worker backpressure and queue accumulation (worse)

#### Reference behavior

Forge applies run-scoped order-processing concurrency at the BullMQ worker boundary. The worker resolves the run's backpressure policy for each job and updates `worker.concurrency`, with a poller refreshing active-run concurrency. Excess work remains visible in BullMQ waiting/delayed state instead of being pulled into the worker process.

**References:**
- `checkout-forge/apps/worker/src/index.ts:85` — worker initializes from active-run backpressure policy.
- `checkout-forge/apps/worker/src/index.ts:91` — per-job runtime policy resolver reads by run ID.
- `checkout-forge/apps/worker/src/index.ts:106` — active-run poll updates worker concurrency.
- `checkout-forge/apps/worker/src/queues/order-process-worker.ts:38` — worker resolves backpressure per delivered job.
- `checkout-forge/apps/worker/src/queues/order-process-worker.ts:41` — BullMQ worker concurrency is updated from run policy.

#### Compared behavior

Surge starts the BullMQ consumer with process-level concurrency and wraps only the ERP confirmation call in a run-scoped semaphore based on `snapshot.backpressureConfig.orderProcessConcurrency`. This caps concurrent downstream calls, but jobs have already been consumed from BullMQ and can wait inside the worker; high run concurrency also cannot exceed the process-level cap.

**References:**
- `checkout-surge/apps/worker/src/index.ts:151` — order-process consumer uses process-level concurrency.
- `checkout-surge/apps/worker/src/index.ts:153` — run-scoped backpressure wraps confirmation.
- `checkout-surge/apps/worker/src/application/run-backpressure.ts:28` — semaphore size comes from run snapshot.
- `checkout-surge/apps/worker/src/application/run-backpressure.ts:30` — only inner confirmation call is semaphore-protected.
- `checkout-surge/apps/worker/src/runtime/config.ts:23` — process-level order concurrency default is env-configured.

#### Verdict rationale

Surge protects the ERP from too many concurrent calls, but it does not apply run concurrency at the queue-consumption boundary. Under slow ERP conditions, work can accumulate as active in-process waiters rather than visibly backing up in the queue.

### C54 — Run-scoped ERP behavior and request timeout (same)

#### Reference behavior

Forge resolves ERP behavior from the run snapshot and passes it to the mock ERP on each confirmation request through a run-behavior header. The worker also applies the run's ERP request timeout from backpressure config, falling back to defaults when no run policy exists.

**References:**
- `checkout-forge/apps/worker/src/services/run-erp-behavior-resolver.ts:26` — ERP config is parsed from run snapshot.
- `checkout-forge/apps/worker/src/clients/run-scoped-order-confirmation-client.ts:27` — confirmation client resolves run-scoped ERP config.
- `checkout-forge/apps/worker/src/clients/mock-erp-client.ts:44` — request timeout uses run config when present.
- `checkout-forge/apps/worker/src/clients/mock-erp-client.ts:57` — ERP behavior is sent in mock ERP header.
- `checkout-forge/apps/mock-erp/src/server.ts:104` — mock ERP parses run behavior from request header.

#### Compared behavior

Surge reads the accepted run snapshot in the worker, applies `erpConfig.requestTimeoutMs` to the HTTP abort timeout, and includes run-scoped ERP chaos settings in the confirmation request body. The mock ERP prefers request ERP config over global fallback.

**References:**
- `checkout-surge/apps/worker/src/persistence/postgres-run-config-reader.ts:14` — worker reads run config snapshot.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:161` — confirmation client reads run config by job run ID.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:162` — request timeout comes from run snapshot.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:283` — request body includes run-scoped ERP config.
- `checkout-surge/apps/worker/src/application/run-config.ts:7` — run snapshot maps chaos fields into ERP request config.
- `checkout-surge/apps/mock-erp/src/application/chaos-control-service.ts:128` — request ERP config overrides global fallback.

#### Verdict rationale

The transport differs, but the behavior is equivalent: worker calls carry the run snapshot's ERP behavior and timeout to the downstream simulator.

### C55 — Circuit breaker state machine and breaker-blocked retries (better)

#### Reference behavior

Forge implements closed/open/half-open breaker semantics, including reopening on half-open failure. However, once the open window expires, `canAttempt()` allows every caller through until success/failure is recorded, so half-open is not constrained to a single probe. Breaker-open rejection is treated as a retryable failed confirmation and consumes a BullMQ attempt.

**References:**
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:30` — `canAttempt` gates only while state is `open`.
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:40` — expired open window transitions to `half_open`.
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:54` — half-open failure reopens circuit.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:34` — open circuit returns retryable rejection.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:201` — retryable rejections are recorded as failed attempts.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:222` — retryable nonterminal failures are thrown to BullMQ.

#### Compared behavior

Surge explicitly tracks `halfOpenProbeInFlight`, rejects additional half-open callers, closes on success, and reopens immediately on counted half-open failure. Breaker-open errors are handled specially by the BullMQ consumer: the job is moved to delayed until retry time and a `DelayedError` avoids ordinary failure semantics.

**References:**
- `checkout-surge/apps/worker/src/application/erp-circuit-breaker.ts:46` — breaker tracks half-open probe in flight.
- `checkout-surge/apps/worker/src/application/erp-circuit-breaker.ts:67` — additional half-open callers are rejected.
- `checkout-surge/apps/worker/src/application/erp-circuit-breaker.ts:122` — half-open counted failure reopens immediately.
- `checkout-surge/apps/worker/src/queue/bullmq-order-process-consumer.ts:190` — circuit-open errors get special handling.
- `checkout-surge/apps/worker/src/queue/bullmq-order-process-consumer.ts:191` — job is moved to delayed by retry-after time.
- `checkout-surge/apps/worker/src/queue/bullmq-order-process-consumer.ts:192` — `DelayedError` prevents ordinary failure semantics.

#### Verdict rationale

Surge is better on classic breaker edge cases. It enforces a single half-open probe and delays breaker-blocked jobs rather than counting them as ERP attempts and normal retry failures.

### C56 — Circuit breaker run scoping (worse)

#### Reference behavior

Forge creates run-specific circuit breakers when a job has run ID and backpressure config. The cache key includes run breaker threshold and reset timeout, so each run's frozen policy controls its own breaker state and thresholds. Jobs without run policy fall back to default env settings.

**References:**
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:18` — per-run breaker cache.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:71` — config key includes run failure threshold.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:72` — config key includes run reset timeout.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:80` — new run breaker uses run threshold.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:85` — run breaker is cached by run ID.

#### Compared behavior

Surge wires a single `ErpCircuitBreaker` from process-level `ERP_CIRCUIT_FAILURE_THRESHOLD` and `ERP_CIRCUIT_RESET_TIMEOUT_MS`. It sits inside the run-scoped semaphore wrapper, but breaker thresholds and state are not keyed by run and do not read `snapshot.backpressureConfig`.

**References:**
- `checkout-surge/apps/worker/src/index.ts:153` — run-scoped wrapper surrounds breaker rather than configuring it.
- `checkout-surge/apps/worker/src/index.ts:155` — a single `ErpCircuitBreaker` instance is constructed.
- `checkout-surge/apps/worker/src/index.ts:162` — breaker failure threshold comes from worker env config.
- `checkout-surge/apps/worker/src/index.ts:163` — breaker reset timeout comes from worker env config.
- `checkout-surge/apps/worker/src/index.ts:167` — one breaker snapshot is published to Redis.

#### Verdict rationale

Surge's breaker state machine is stronger, but its scoping is weaker. The run snapshot's breaker thresholds do not control breaker behavior, and different runs cannot have independent breaker state.

### C57 — Order transition events and realtime emission (worse)

#### Reference behavior

Forge persists order state transitions and ERP attempt events as append-only order events. It also emits realtime dashboard events for processing, retry/failure, and confirmation transitions using canonical `order.status.updated`, so the dashboard can track each order's transition path.

**References:**
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:82` — `order.processing` event is persisted.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:124` — `erp.attempt.succeeded` event is persisted.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:138` — `order.confirmed` event is persisted.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:227` — failed ERP attempt event is persisted.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:260` — terminal `order.failed` event is persisted.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:236` — realtime event type is `order.status.updated`.

#### Compared behavior

Surge persists append-only order events for processing, confirmed, failed, and ERP attempt outcomes. Its live signal is aggregate `business.outcome.updated` after processing/retry/failure/confirmation/notification transitions, not per-order `order.status.updated`.

**References:**
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:74` — `order.processing` event is persisted.
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:99` — `order.confirmed` event is persisted.
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:129` — `order.failed` event is persisted.
- `checkout-surge/apps/worker/src/persistence/postgres-erp-attempt-persistence.ts:59` — ERP attempt event name is persisted.
- `checkout-surge/apps/worker/src/application/order-process-job-handler.ts:121` — processing transition publishes aggregate outcome update.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:229` — realtime event type is `business.outcome.updated`.

#### Verdict rationale

Durable event coverage is broadly equivalent, but realtime transition fidelity is worse. Surge's aggregate event is useful for summaries, but it is not the required per-order transition stream.

### C58 — ERP attempt history fidelity and terminality (worse)

#### Reference behavior

Forge records durable ERP attempt rows for success, failure, timeout, thrown worker errors, and breaker-open outcomes. Attempt numbers derive from BullMQ delivery attempts. Failed-attempt order events include a `terminal` flag, and terminal failures update the order to `failed` in the same transaction as the final attempt event.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:76` — attempt number derives from BullMQ attempts made.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:128` — thrown worker errors record failed attempts.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:206` — ERP timeout code maps to `timed_out`.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:96` — successful attempt row insert.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:207` — failed/timed-out attempt row insert.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:230` — failed attempt event payload includes `terminal`.

#### Compared behavior

Surge records ERP attempt rows for successful responses, failed responses, timeouts, invalid responses, and request failures. Attempt events include status, attempt number, attempts made, latency, and error detail. The attempt event payload does not carry a terminal flag, and final order failure is persisted separately by the order handler. Breaker-open delays are not recorded as ERP attempts, which is appropriate when no ERP call happened.

**References:**
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:187` — parsed ERP responses are recorded as attempts.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:197` — timeouts are recorded as `timed_out`.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:219` — invalid responses are recorded as failed attempts.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:234` — request failures are recorded as failed attempts.
- `checkout-surge/apps/worker/src/persistence/postgres-erp-attempt-persistence.ts:43` — attempt number is stored.
- `checkout-surge/apps/worker/src/persistence/postgres-erp-attempt-persistence.ts:61` — event payload lacks terminality.

#### Verdict rationale

Surge has good per-call attempt coverage, but the attempt/event history loses Forge's explicit final-attempt marker. Terminality can be inferred from a separate order failure, but the attempt audit trail is less faithful.

### C59 — Consistency-lag measurement and emission (worse)

#### Reference behavior

Forge emits a realtime dashboard metric for every confirmed order. After recording successful ERP attempt and order confirmation, the worker emits `dashboard.metric.observed` with metric name `order.consistency_lag` and the per-order buy-to-confirmation delta.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:165` — successful attempt is persisted before lag emission.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:178` — order confirmed event is emitted.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:186` — metric name is `order.consistency_lag`.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:189` — metric value is per-order lag.

#### Compared behavior

Surge computes consistency lag as an aggregate read model. After confirmation, the worker publishes a business outcome dashboard update that recomputes confirmed count, average lag, p95 lag, max lag, pending confirmation count, and oldest pending age. It does not emit a per-confirmed-order consistency-lag metric.

**References:**
- `checkout-surge/apps/worker/src/application/order-process-job-handler.ts:181` — confirmed order transition is persisted.
- `checkout-surge/apps/worker/src/application/order-process-job-handler.ts:188` — confirmation publishes business outcome update.
- `checkout-surge/apps/worker/src/index.ts:192` — worker publisher calls `publishBusinessOutcomeDashboardUpdate`.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:95` — consistency lag is read as a summary.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:107` — summary counts confirmed orders.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:229` — emitted event is aggregate `business.outcome.updated`.

#### Verdict rationale

Surge measures lag, but it emits aggregate lag summaries rather than per-confirmed-order lag metrics. That is worse for the mandated per-order signal and individual delay diagnosis.

### C60 — Post-confirmation notification durability and recovery (better)

#### Reference behavior

Forge enqueues notification recording after a confirmed order and catches enqueue failures so they do not fail the order. The notification worker records one durable simulated notification only if the order is confirmed and skips duplicate notifications by checking for an existing row before insert.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:197` — confirmed path enqueues notification record job.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:257` — notification enqueue is isolated in a helper.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:267` — notification enqueue failure is logged but not thrown.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:149` — notification recording checks durable order state.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:166` — duplicate notification rows are skipped.
- `checkout-forge/apps/worker/src/queues/simulated-notification-queue.ts:64` — notification jobs use deterministic order/channel job IDs.

#### Compared behavior

Surge also publishes notification-recording work after confirmation and treats publish failure as noncritical. Its durable notification insert uses `onConflictDoNothing` on `(orderId, channel)`, and it adds a recovery scanner that finds confirmed orders missing email notifications and republishes jobs.

**References:**
- `checkout-surge/apps/worker/src/application/order-process-job-handler.ts:214` — confirmed path publishes notification record job.
- `checkout-surge/apps/worker/src/application/order-process-job-handler.ts:228` — notification publish reporting is noncritical.
- `checkout-surge/apps/worker/src/queue/bullmq-notification-record-publisher.ts:20` — publisher builds durable-recording jobs.
- `checkout-surge/apps/worker/src/persistence/postgres-notification-record-persistence.ts:71` — duplicate insert uses conflict-do-nothing.
- `checkout-surge/apps/worker/src/persistence/postgres-notification-recovery-persistence.ts:12` — recovery query finds missing notifications.
- `checkout-surge/apps/worker/src/application/notification-recovery-scanner.ts:57` — scanner republishes missing notification jobs.

#### Verdict rationale

Surge is better because it covers the crash/failure window after order confirmation and before durable notification recording. The recovery scanner gives follow-up work a durable repair loop.

### C61 — Mock ERP chaos controls and TPS realism (worse)

#### Reference behavior

Forge's mock ERP reads latency, TPS, error rate, and outage defaults from environment and exposes live admin updates/reset. Run behavior supplied by the worker overrides global chaos controls. TPS limiting uses a per-scope sliding one-second window, scoped by run ID when run behavior is supplied; TPS exhaustion returns retryable `erp_tps_limit` and HTTP 429.

**References:**
- `checkout-forge/apps/mock-erp/src/config.ts:34` — global chaos knobs come from environment.
- `checkout-forge/apps/mock-erp/src/server.ts:151` — admin route updates chaos controls live.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:56` — run behavior overrides global chaos.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:73` — TPS slot acquisition gates confirmations.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:132` — sliding-window limiter evicts old timestamps.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:167` — run behavior scopes TPS by run ID.

#### Compared behavior

Surge has configurable chaos knobs, live admin update/reset, and request-supplied ERP config overriding global defaults. Its precedence is outage, TPS, then injected error after configured latency, and TPS exhaustion returns HTTP 429 with retryable worker semantics. The limiter uses fixed wall-clock second buckets rather than a sliding one-second window.

**References:**
- `checkout-surge/apps/mock-erp/src/runtime/config.ts:18` — global chaos knobs come from environment.
- `checkout-surge/apps/mock-erp/src/application/chaos-control-service.ts:52` — live chaos update path.
- `checkout-surge/apps/mock-erp/src/application/chaos-control-service.ts:128` — request ERP config overrides global fallback.
- `checkout-surge/apps/mock-erp/src/application/chaos-control-service.ts:139` — forced outage is checked before TPS/error injection.
- `checkout-surge/apps/mock-erp/src/application/chaos-control-service.ts:148` — TPS exhaustion returns `erp_capacity_exceeded`.
- `checkout-surge/apps/mock-erp/src/application/chaos-control-service.ts:167` — TPS limiter uses fixed second windows.

#### Verdict rationale

Surge is configurable and run-overridable, but fixed second buckets are a weaker approximation of a rolling downstream bottleneck than Forge's sliding one-second window.

### C62 — At-least-once consumption and duplicate-delivery discipline (better)

#### Reference behavior

Forge tolerates terminal redelivery by checking durable order status after `markProcessing` and returning cleanly for confirmed or failed orders. It uses deterministic order job IDs, but a job redelivered while the order is already `processing` still proceeds to another ERP call, and the worker does not validate the full job payload against durable order identity.

**References:**
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:63` — order-processing job ID is deterministic by order ID.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:48` — worker reads durable order before processing.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:106` — terminal confirmed/failed orders are skipped.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:113` — terminal redelivery is logged and acknowledged.

#### Compared behavior

Surge also uses deterministic order job IDs and skips terminal redelivery. It improves the guard by locking the order row and validating public order ID, reservation ID, sale offer ID, correlation ID, run ID, quantity, and queued timestamp against the job payload. It also checks for an existing successful ERP attempt before issuing another downstream request, and the mock ERP replays successful confirmations by idempotency key.

**References:**
- `checkout-surge/apps/api/src/queue/bullmq-order-process-job-publisher.ts:59` — order-processing job ID is deterministic by order ID.
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:61` — terminal orders return without processing.
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:140` — durable order is locked for transition validation.
- `checkout-surge/apps/worker/src/persistence/postgres-order-transition-persistence.ts:162` — job identity fields are compared to durable order fields.
- `checkout-surge/apps/worker/src/application/erp-confirmation-client.ts:156` — existing successful ERP attempt is reused.
- `checkout-surge/apps/mock-erp/src/application/confirmation-service.ts:47` — mock ERP replays successful confirmations by idempotency key.

#### Verdict rationale

Surge is better because it validates job identity and can avoid repeating an ERP call after a successful attempt has already been persisted. Neither implementation fully prevents concurrent duplicate deliveries while an order is still `processing`, but Surge covers more crash/redelivery cases.

### C63 — Worker graceful shutdown (better)

#### Reference behavior

Forge exposes a close function that clears the backpressure poller, closes both BullMQ workers, closes publishers, ends PostgreSQL, and closes the health server. Signal handlers register that async close function directly, but do not explicitly await shutdown before process exit or report shutdown failure.

**References:**
- `checkout-forge/apps/worker/src/index.ts:146` — worker close function starts.
- `checkout-forge/apps/worker/src/index.ts:149` — order-process worker is closed.
- `checkout-forge/apps/worker/src/index.ts:150` — notification worker is closed.
- `checkout-forge/apps/worker/src/index.ts:153` — PostgreSQL client is ended.
- `checkout-forge/apps/worker/src/index.ts:157` — SIGINT registers async close function directly.
- `checkout-forge/apps/worker/src/index.ts:158` — SIGTERM registers async close function directly.

#### Compared behavior

Surge centralizes shutdown in a runtime close path, closes the health server, order consumer, notification consumer, recovery scanner, publisher, PostgreSQL, and Redis, and aggregates cleanup errors. Its SIGTERM/SIGINT handlers await `runtime.close()`, then exit successfully or log and exit with failure. The notification recovery scanner waits for in-flight scans before closing.

**References:**
- `checkout-surge/apps/worker/src/runtime/worker-runtime.ts:77` — runtime close helper starts.
- `checkout-surge/apps/worker/src/runtime/worker-runtime.ts:88` — order-process consumer is closed.
- `checkout-surge/apps/worker/src/runtime/worker-runtime.ts:92` — recovery scanner is closed when present.
- `checkout-surge/apps/worker/src/application/notification-recovery-scanner.ts:108` — scanner waits for in-flight work.
- `checkout-surge/apps/worker/src/index.ts:273` — signal shutdown awaits runtime close.
- `checkout-surge/apps/worker/src/index.ts:278` — SIGTERM exits after shutdown promise settles.

#### Verdict rationale

Surge's shutdown path is more explicit and auditable. Both use BullMQ close semantics, but Surge coordinates all resources through one awaited shutdown promise and reports failures.

### C64 — Realtime transport fan-out and SSE mechanics (same)

#### Reference behavior

Forge implements the expected browser-facing realtime topology: one API-owned Redis subscription is fanned out to in-memory SSE clients, and each browser connection is only a sink. The stream uses SSE headers, heartbeat comment frames, schema validation before broadcast, and an explicit no-buffering backpressure policy: if a client write returns false or throws, that client is closed and expected to reconnect and recover through the HTTP recovery read.

**References:**
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:31` — one gateway owns the process-wide Redis subscription.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:54` — subscribes once to the dashboard Redis channel.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:68` — heartbeat frames are scheduled per connection.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:74` — SSE response headers are set.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` — inbound pub/sub payloads are validated before broadcast.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:199` — failed or backpressured writes close the client.

#### Compared behavior

Surge has the same broad transport shape. The API creates a single Redis dashboard-event subscriber and forwards valid messages into a process-local fanout. Browser clients are tracked in memory, receive SSE headers, reconnect guidance, and heartbeat comments, and are closed on write backpressure rather than buffered. It also sets `x-accel-buffering: no`, which is a useful proxy hint not present in the baseline API code.

**References:**
- `checkout-surge/apps/api/src/index.ts:120` — constructs one API-local dashboard fanout.
- `checkout-surge/apps/api/src/index.ts:121` — creates the Redis dashboard event subscriber.
- `checkout-surge/apps/api/src/index.ts:125` — subscriber events are forwarded into the fanout.
- `checkout-surge/apps/api/src/realtime/dashboard-event-fanout.ts:55` — SSE headers include no-cache and no proxy buffering.
- `checkout-surge/apps/api/src/realtime/dashboard-event-fanout.ts:67` — sends EventSource retry guidance on connect.
- `checkout-surge/apps/api/src/realtime/dashboard-event-fanout.ts:98` — heartbeat comments keep connections alive.

#### Verdict rationale

This is functionally equivalent to the baseline for transport cost and client backpressure. Surge does not create per-client Redis subscriptions, does not accumulate per-client backlogs, and uses the API as the browser-facing realtime owner. The proxy-buffering header is a small improvement, but not enough to change the overall grade because the reference already covers the core mechanics.

### C65 — Authoritative dashboard recovery/read model composition (worse)

#### Reference behavior

Forge's recovery read is the authoritative resynchronization path. It resolves the current run from durable database state when possible, merges that with in-memory live traffic state, and returns a validated recovery response containing a full snapshot, current run, recent traffic metrics, and terminal summary context when relevant. The current-run-scoped snapshot composes inventory, queue, ERP resilience, run outcomes, consistency lag, order status snapshots, recent orders, and the applied backpressure policy.

**References:**
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:40` — recovery builds current run, snapshot, traffic metrics, and terminal summary.
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:58` — durable current run is reconciled with in-memory state.
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:84` — recoverable runs are read from the database.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:52` — snapshot read accepts an optional run scope.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:63` — inventory, queue, ERP, outcomes, lag, statuses, and recent orders are read together.
- `checkout-forge/packages/contracts/src/dashboard.ts:108` — recovery response contract wraps the authoritative snapshot.

#### Compared behavior

Surge has a real recovery endpoint and reconstructs current `starting`, `active`, or `draining` runs from PostgreSQL, including the frozen config snapshot. It also reads inventory, queue, ERP, business outcomes, consistency lag, recent traffic metrics, and recent completion outcomes in one service call, and degrades individual projections to `null` or empty arrays if a read fails. However, when there is no current run, it falls back to an active catalog offer, which weakens the current-run-only live/watch boundary. Its recovery shape is also flatter and narrower than the baseline: there is no nested snapshot with correlation/observed metadata, no order status snapshot list, no applied backpressure policy field outside the run config, and no terminal summary handoff in the live recovery response.

**References:**
- `checkout-surge/apps/api/src/services/dashboard-recovery-service.ts:53` — recovery context reads current runs from PostgreSQL.
- `checkout-surge/apps/api/src/services/dashboard-recovery-service.ts:57` — only starting/active/draining runs are selected as current.
- `checkout-surge/apps/api/src/services/dashboard-recovery-service.ts:85` — falls back to an active catalog offer when no current run exists.
- `checkout-surge/apps/api/src/services/dashboard-recovery-service.ts:134` — recovery service entry point.
- `checkout-surge/apps/api/src/services/dashboard-recovery-service.ts:157` — recovery composes inventory, queue, ERP, business outcome, lag, metrics, and completion outcomes.
- `checkout-surge/packages/contracts/src/demo.ts:187` — flat recovery response contract.

#### Verdict rationale

Surge implements the important baseline idea that recovery comes from backend truth rather than missed-event replay. The grade is still worse because the current-run boundary is less strict, the response is less self-describing, and several baseline recovery fields are absent. The fallback to catalog-offer observability is especially risky because live state should be scoped to the current run rather than non-run catalog state.

### C66 — Live dashboard signal completeness (worse)

#### Reference behavior

Forge makes the four gold signals available through live events, recovery projections, and a focused frontend view model. The contract includes traffic, queue, inventory, and consistency-lag metric names; recovery snapshots include inventory status, queue health, ERP resilience, run outcomes, consistency lag, order status snapshots, and recent orders. The web view model then turns those projections into queue depth, inventory drain, traffic latency/failure metrics, ERP status, and consistency-lag panels while filtering metrics by run/sale-offer scope and timestamp.

**References:**
- `checkout-forge/packages/contracts/src/metrics.ts:8` — metric names include traffic, queue, inventory, and consistency-lag signals.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:141` — consistency lag is computed from order queue/confirmation timestamps.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:233` — live view model derives queue, inventory, consistency lag, and order counts.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:249` — traffic request rate, latency, and failure-rate metrics feed the load-run panel.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:283` — ERP panel derives circuit, attempts, failures, and average latency.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:825` — metric events are scoped by run and sale offer.

#### Compared behavior

Surge's recovery read covers many of the same projections: inventory status includes pending persistence and sold-out pressure, recovery includes queue and ERP status, and business outcome plus consistency-lag summaries are part of the response. Its watch surface is useful, with panels for recovery, request surge, inventory, queue, ERP health, consistency lag, run outcomes, and recent completions. The live stream and projection are still less complete. The contract defines `inventory.updated` and `queue.updated`, but the inspected production publishers emit run lifecycle events, traffic metrics, and business outcome updates; inventory drain and queue pressure rely mainly on recovery reads or future producers. On the frontend, request rate is first-class, but latency and failure rate are not as prominent as Forge's gold-signal presentation, and accepted live events update React state directly.

**References:**
- `checkout-surge/packages/contracts/src/demo.ts:187` — recovery response includes inventory, metrics, queue, ERP, business outcome, lag, and recent completions.
- `checkout-surge/packages/contracts/src/dashboard-events.ts:53` — inventory update event type is defined.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:533` — production metric event publishing is traffic-metric based.
- `checkout-surge/packages/db/src/business-outcome-dashboard.ts:229` — production business outcome realtime event type.
- `checkout-surge/apps/web/src/app/components/dashboard-panels.tsx:370` — request surge panel shows request rate, reservation rate, sold-out pressure, and latest metric.
- `checkout-surge/apps/web/src/app/components/dashboard-panels.tsx:563` — consistency-lag panel shows p95, average, max, and pending work.

#### Verdict rationale

Recovery signal breadth and the frontend panels are decent, but live observability is worse. A dashboard connected during a run can receive traffic and business outcome changes, but not the full set of inventory and queue projection changes promised by the event contract. The browser is therefore more dependent on recovery refreshes for key gold signals, and the UI gives latency/failure-rate signals less first-class treatment than the baseline.

### C67 — Realtime failure isolation (worse)

#### Reference behavior

Forge treats realtime as advisory. Producer-side validation failures and Redis publish failures are logged and dropped without blocking checkout, worker processing, controls, or metric ingestion. The SSE gateway similarly drops malformed inbound messages and isolates client write failures to the affected connection. This keeps observability failures from becoming product-path failures.

**References:**
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:24` — invalid events are logged instead of published.
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:38` — publish failures are documented as non-blocking.
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:40` — Redis publish is fire-and-forget with a catch handler.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:151` — malformed JSON is handled inside parsing.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` — schema-invalid Redis messages are dropped.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:199` — client write failure closes only that client.

#### Compared behavior

Surge isolates several realtime failures correctly: run lifecycle publishing catches errors, business outcome publication from the buy path is scheduled without hiding durable success, worker-side publication helpers report failures without failing jobs, and invalid Redis pub/sub messages are logged and ignored. The gap is metric ingestion: `ingestMetrics` appends samples to Redis and then awaits every dashboard publish without a local catch. A Redis pub/sub failure on one metric sample can therefore fail the internal metric ingestion request.

**References:**
- `checkout-surge/packages/db/src/redis-dashboard-events.ts:27` — dashboard publishing awaits Redis `publish`.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:528` — metric ingestion entry point.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:533` — metric ingestion awaits each dashboard publish.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:956` — run lifecycle publish wrapper.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:971` — run event publish failures are caught and logged.
- `checkout-surge/apps/api/src/services/reserve-order-service.ts:322` — business outcome publish failures are caught so durable buy success is not hidden.

#### Verdict rationale

Surge understands best-effort realtime in several places, but applies it inconsistently. Metric ingestion is part of the observability pipeline and should keep accepting measurements even if pub/sub fanout is down. Because one unhandled publish failure can turn a metrics request into a failure, Surge is worse than Forge's consistently advisory publisher design.

### C68 — Traffic mode mapping and VU sizing (worse)

#### Reference behavior

Forge maps the two benchmark traffic modes to the intended k6 executors. Buyer-spike uses `per-vu-iterations` with one VU per buyer and one or two iterations depending on duplicate-attempt mode. Steady arrival uses `constant-arrival-rate` with `timeUnit: "1s"` and derived VU sizing: preallocated VUs default near the requested rate, max VUs default around twice the rate, and both are capped at 10,000 unless explicit admin values are supplied. The generated plan also includes a graceful stop and precise planned-attempt accounting.

**References:**
- `checkout-forge/packages/contracts/src/load.ts:29` — buyer-spike traffic schema.
- `checkout-forge/packages/contracts/src/load.ts:39` — steady-arrival traffic schema with optional VU overrides.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:149` — buyer-spike emits `per-vu-iterations`.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:161` — steady arrival emits `constant-arrival-rate`.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:207` — steady VU derivation with rate-sized preallocation and 10k caps.

#### Compared behavior

Surge preserves the broad executor split and serializes scenario config as JSON rather than interpolating raw shell or JavaScript expressions. The steady-arrival defaults are weaker: preallocated VUs default to `ceil(rate / 2)`, max VUs default to `rate * 2`, and the script generation path does not locally cap derived max VUs at 10,000. API hard-cap validation checks explicit `k6Vus` overrides, but derived defaults can exceed deployment caps when overrides are omitted. The generated scenarios also omit Forge's explicit `gracefulStop`.

**References:**
- `checkout-surge/packages/contracts/src/load.ts:20` — buyer-spike traffic schema.
- `checkout-surge/packages/contracts/src/load.ts:32` — steady-arrival traffic schema with nested `k6Vus` overrides.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:14` — executor selection by traffic mode.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:23` — steady-arrival `constant-arrival-rate` scenario.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:29` — default VU derivation of `rate / 2` and `rate * 2`.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:1128` — deployment VU caps are enforced only when `k6Vus` is explicit.

#### Verdict rationale

Surge uses the right executor families, but its defaults make the benchmark less reliable. Under-provisioned preallocated VUs can make k6 the bottleneck for steady runs, while uncapped derived max VUs can bypass the deployment VU cap. Missing graceful stop is smaller, but it is another loss of parity with the reference execution model.

### C69 — Generated request script and attempt identity (worse)

#### Reference behavior

Forge keeps user-influenced values inside `JSON.stringify` literals and sends compact buy requests with run ID, generated sale offer ID, quantity `1`, idempotency key, and correlation ID. Attempt identity is deterministic and run-scoped: buyer-spike duplicates intentionally reuse each buyer key, while steady arrival derives keys from the run and global iteration index. Steady-arrival iterations beyond the planned count are dropped in-script so k6 overscheduling cannot inflate accounting. As covered in C33, the script also discards response bodies and classifies outcomes from headers.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:54` — response bodies are discarded.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:64` — generated parameters are serialized as JSON literals.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:87` — buy request body includes run, offer, quantity, idempotency key, and correlation ID.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:111` — classification reads outcome and rejection-reason headers.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:173` — buyer and steady identity snippets.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:186` — overscheduled steady iterations return `null`.

#### Compared behavior

Surge also embeds validated configuration via `JSON.stringify`, and its normal and duplicate-attempt idempotency keys are deterministic and run-scoped. The script is heavier and less disciplined on the request path: it does not set `discardResponseBodies`, parses `response.json("outcome")` on every request, and classifies sold-out responses from the body rather than headers. It sends `quantity` from `inventoryConfig.quantityPerCheckout` even though traffic also has `quantityPerAttempt`, and this path does not enforce the expected request shape where each emitted attempt has quantity `1`. It carries a correlation ID in the body but does not send the `x-correlation-id` header used across service boundaries.

**References:**
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:33` — generated script config is serialized from the start request.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:52` — script config embedded with `JSON.stringify`.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:60` — default function derives iteration and idempotency key.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:66` — buy request body includes run, offer, idempotency key, quantity, and correlation ID.
- `checkout-surge/apps/load-orchestrator/src/application/k6-script.ts:85` — per-request response body parsing for outcome classification.
- `checkout-surge/packages/contracts/src/load.ts:56` — inventory config permits configurable `quantityPerCheckout`.

#### Verdict rationale

Surge avoids obvious script-injection hazards and mostly preserves idempotency-key discipline, but it makes each synthetic buyer do more work and weakens the strict request shape. The body-parsing regression overlaps C33; the additional load-generator issues are the quantity source ambiguity, missing correlation header, and lack of in-script overschedule dropping.

### C70 — k6 output parsing and terminal summaries (worse)

#### Reference behavior

Forge consumes k6's JSON point stream for live samples but does not rely on that stream alone for terminal truth. It runs k6 with `--summary-export`, parses both legacy and end-of-test summary formats, falls back to a bounded stdout tail when the summary file is missing or invalid, and records metric-source diagnostics. Terminal summaries prefer summary-export counters for totals, accepted reservations, sold-out rejections, unexpected responses, iterations, and dropped iterations. Percentiles and timing breakdowns come from summary data when available, with explicit nulls when only rolling point aggregates are available.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:31` — point-stream metrics include HTTP, outcome, iteration, and dropped-iteration metrics.
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:84` — summary metrics are extracted from JSON summary objects.
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:166` — summary parser reads counters, trends, and rate metrics.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:313` — k6 is spawned with `--summary-export` and JSON point output.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:377` — summary export is read with stdout fallback and diagnostic warnings.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:869` — terminal counts prefer summary-export over point-stream aggregates.

#### Compared behavior

Surge parses JSON point lines and tolerates malformed or unsupported lines. Its accumulator tracks emitted requests, failures, accepted responses, sold-out responses, unexpected responses, dropped iterations, and an in-memory latency array. Terminal reports are computed entirely from that point accumulator. The runner does not request `--summary-export`, and there is no fallback summary parser, source annotation, full HTTP timing breakdown, or compatibility layer for summary shape changes. P95 latency is computed from retained point values in memory.

**References:**
- `checkout-surge/apps/load-orchestrator/src/application/k6-runner.ts:63` — k6 is spawned with JSON point output only.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:17` — point-only accumulator fields.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:47` — supported point metrics in the accumulator.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:74` — terminal completion report is built from accumulator state.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:107` — timing breakdown is reduced to p95 latency.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:159` — malformed JSON lines are tolerated.

#### Verdict rationale

This is worse for benchmark measurement. Surge's parser is adequate for lightweight live telemetry, but final reports are less trustworthy when they depend only on point-stream delivery and in-memory samples. Forge's summary-export path gives better terminal counters, better diagnostics, and better resilience to output loss or k6 output drift.

### C71 — Metric and completion delivery reliability (worse)

#### Reference behavior

Forge establishes durable API state before traffic starts: the API creates the run, and the load orchestrator reports a starting lifecycle state to the API before spawning k6. Live metrics are batched and sent to an internal API endpoint with the control service token. Completion reports are also posted with the service token, and failed completion delivery is retained in memory and retried on the finalization poll interval until accepted or superseded.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-start-service.ts:48` — run creation precedes traffic start.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:164` — orchestrator initializes current run as `starting`.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:177` — lifecycle sink is called before k6 execution.
- `checkout-forge/apps/load-orchestrator/src/api-metric-stream-client.ts:35` — live metric stream posts with service token.
- `checkout-forge/apps/load-orchestrator/src/api-traffic-report-client.ts:92` — completion report posts with service token.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:629` — failed completion report delivery is retained and retried.

#### Compared behavior

Surge also has the API create the run and initialize Redis inventory before asking the load orchestrator to start traffic. Its orchestrator start endpoint is service-token protected, and the API client sends metrics and completion reports to token-protected internal endpoints. Metrics are batched with a default 100-sample or 1-second flush policy. Completion delivery retries with exponential backoff, but only for a finite default of five attempts; after that, the error is logged and the report is abandoned. There is no separate orchestrator-to-API lifecycle report before spawning k6; the orchestrator spawns and returns `active`, and the API updates the run afterward.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:474` — accepted run is created before inventory and traffic start.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:483` — Redis inventory is initialized before traffic starts.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:498` — API calls the load orchestrator after run setup.
- `checkout-surge/apps/load-orchestrator/src/server.ts:88` — traffic start endpoint requires the control service token.
- `checkout-surge/apps/load-orchestrator/src/application/api-client.ts:36` — internal API posts include correlation and service-token headers.
- `checkout-surge/apps/load-orchestrator/src/application/k6-runner.ts:214` — completion retry is finite and throws after max attempts.

#### Verdict rationale

Surge preserves the essential API-before-k6 ordering and protected ingestion endpoints, so this is not missing. It is worse because a long enough API outage can strand a draining run without the completion report needed for normal finalization. The missing pre-spawn lifecycle report is a smaller observability downgrade, but the abandoned terminal report is the material reliability gap.

### C72 — Load-run lifecycle, readiness, diagnostics, and cancellation (worse)

#### Reference behavior

Forge's readiness endpoint verifies that the configured k6 binary is executable. Before execution it collects diagnostics including CPU count, file descriptor limits, selected network kernel settings, k6 version, and the exact execution plan. It captures bounded stderr lines for final diagnostics. The load orchestrator also exposes an abort endpoint that kills the active k6 child with `SIGTERM`, clears pending metric/report state for that run, and returns a structured abort outcome.

**References:**
- `checkout-forge/apps/load-orchestrator/src/server.ts:91` — readiness includes a k6 executable check.
- `checkout-forge/apps/load-orchestrator/src/load-run-diagnostics.ts:15` — diagnostics collect execution plan, OS limits, network settings, and k6 version.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:263` — diagnostics are collected before writing and spawning the k6 script.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:331` — k6 stderr lines are observed and retained.
- `checkout-forge/apps/load-orchestrator/src/server.ts:159` — abort endpoint is exposed.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:201` — abort clears state and terminates the child process.

#### Compared behavior

Surge has basic readiness checks for API reachability and k6. When `K6_BINARY` is a path, it checks filesystem executable access; when the binary is expected on `PATH`, readiness reports a degraded status because it does not execute `k6 version`. Spawn errors, non-zero exits, final metric flush, and temporary directory cleanup are handled. Stderr is only logged, not retained in completion diagnostics. The diagnostics summary contains only started/completed timestamps, and the load orchestrator has no abort/cancel endpoint or tracked current child process that an operator can terminate.

**References:**
- `checkout-surge/apps/load-orchestrator/src/runtime/readiness.ts:20` — readiness checks API, preset start flag, and k6.
- `checkout-surge/apps/load-orchestrator/src/runtime/readiness.ts:137` — path binaries are checked with filesystem access only.
- `checkout-surge/apps/load-orchestrator/src/runtime/readiness.ts:151` — PATH binaries are reported as degraded rather than verified.
- `checkout-surge/apps/load-orchestrator/src/application/k6-runner.ts:149` — stderr is logged but not retained in the report.
- `checkout-surge/apps/load-orchestrator/src/application/k6-runner.ts:156` — spawn errors and close events produce completion reports.
- `checkout-surge/apps/load-orchestrator/src/server.ts:88` — only a start endpoint exists for traffic execution.

#### Verdict rationale

Surge covers basic happy and failure exits, but Forge is materially more operational. Cancellation, richer readiness, bounded stderr retention, and system/k6 diagnostics matter when a benchmark under-delivers or the generator itself becomes the bottleneck.

### C73 — Containerized k6 ownership (same)

#### Reference behavior

Forge's load-orchestrator image owns the k6 binary by copying it from a `grafana/k6` image stage into the Node runtime image and setting `K6_BINARY` to the copied path. The reference container path therefore does not depend on host-installed k6.

**References:**
- `checkout-forge/apps/load-orchestrator/Dockerfile:1` — `grafana/k6` stage provides the k6 runtime.
- `checkout-forge/apps/load-orchestrator/Dockerfile:8` — `K6_BINARY` points to the container-local binary.
- `checkout-forge/apps/load-orchestrator/Dockerfile:12` — k6 is copied into the load-orchestrator image.

#### Compared behavior

Surge uses the same ownership pattern in its root multi-target Dockerfile. A `grafana/k6` stage supplies the binary, the load-orchestrator runtime target copies it to `/usr/local/bin/k6`, and compose config points `K6_BINARY` at that path for the separate load-orchestrator service.

**References:**
- `checkout-surge/Dockerfile:70` — `grafana/k6` stage supplies the binary.
- `checkout-surge/Dockerfile:72` — load-orchestrator runtime target.
- `checkout-surge/Dockerfile:74` — k6 is copied into the load-orchestrator image.
- `checkout-surge/docker-compose.yml:166` — compose defines a separate load-orchestrator service.
- `checkout-surge/docker-compose.yml:175` — compose sets `K6_BINARY` to `/usr/local/bin/k6`.

#### Verdict rationale

This is equivalent. Both implementations keep k6 inside the load-orchestrator runtime image and avoid making host k6 a prerequisite for the reference container deployment.

### C74 — Traffic accounting reconciliation (worse)

#### Reference behavior

Forge's completion report separates HTTP summary, k6 outcome counters, traffic delivery summary, timing breakdown, and diagnostics. Traffic delivery includes planned buyers and attempts, scheduled rate, VU sizing, observed requests, dropped/completed/unstarted iterations, and request shortfall. During API finalization, Forge compares k6-reported accepted and sold-out outcomes with durable/API-side evidence and records diagnostic warnings for underreporting, overreporting, and API-vs-k6 sold-out mismatches. Unexpected checkout responses produce a stable traffic failure reason.

**References:**
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:511` — completion report includes HTTP, outcome, delivery, timing, and diagnostics sections.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:738` — traffic delivery summary includes planned, observed, dropped, completed, unstarted, and shortfall fields.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:683` — k6 outcome summary includes total attempts, accepted reservations, sold-out rejections, and unexpected responses.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:515` — finalization warns when k6 underreports accepted reservations.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:543` — finalization warns when API sold-out decisions differ from k6 sold-out rejections.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:715` — unexpected k6 responses map to a stable failure reason.

#### Compared behavior

Surge's completion report has basic accounting: planned, emitted, completed, failed, accepted, sold-out, unexpected, p95 latency, failure rate, dropped iterations, and a traffic delivery status. The API stores business outcome and terminal inventory evidence when it receives the completion report. The delivery summary is narrower than Forge's and omits scheduled rate, buyer count, VU plan, completed iterations, unstarted iterations, and request shortfall. Finalization fails the run when `trafficDeliveryStatus` is failed, but the inspected flow does not reconcile k6 accepted/sold-out counters against API-side evidence or produce comparable mismatch diagnostics.

**References:**
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:85` — completion report structure with HTTP and outcome summaries.
- `checkout-surge/apps/load-orchestrator/src/application/k6-output-parser.ts:123` — traffic delivery status derived from emitted/planned ratio and unexpected responses.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:604` — API stores the load finalization row from the completion report.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:611` — business outcome and terminal inventory are attached to the stored outcome summary.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:113` — finalization writes stored traffic summaries into the terminal summary.
- `checkout-surge/apps/api/src/services/demo-run-finalization-service.ts:193` — failed traffic delivery status maps to a finalization failure reason.

#### Verdict rationale

Surge can tell that k6 under-delivered or saw unexpected responses, but it loses several dimensions needed to explain why and does not cross-check k6 counters against durable business/API evidence. This overlaps C48's API-side classification concern, but the load-reporting issue is narrower: the benchmark report itself is less auditable and less useful for diagnosing measurement mismatch.

### C75 — Route split and public/operator surface (worse)

#### Reference behavior

Forge keeps the route model close to the spec. The root route renders the public demo picker from public-safe preset and runtime-policy reads, while `/admin` is server-gated before rendering the operator dashboard. Its shared navigation treats the admin entry as a distinct mode rather than making the operator shell part of the ordinary anonymous surface.

**References:**
- `checkout-forge/apps/web/src/app/page.tsx:16` — root route renders the public home client from public preset and policy reads.
- `checkout-forge/apps/web/src/app/admin/page.tsx:17` — admin route checks the signed admin session before rendering `DashboardClient`.
- `checkout-forge/apps/web/src/components/dashboard/top-nav.tsx:7` — normal navigation includes Demo, Watch, History, and About.
- `checkout-forge/apps/web/src/components/dashboard/top-nav.tsx:16` — admin entry is an explicit mode with route-ownership notes.

#### Compared behavior

Surge has the main routes in place: `/` for public starts, `/watch` for spectators, `/run-history` for history, and `/admin` for admin controls. The boundary is more visible to anonymous users than in Forge. The global layout exposes an Admin nav item to all visitors, the admin page always renders the admin page shell before the client-side sign-in gate, and the public history page always mounts admin deletion controls below the history list.

**References:**
- `checkout-surge/apps/web/src/app/layout.tsx:10` — global nav includes `/admin` for all visitors.
- `checkout-surge/apps/web/src/app/page.tsx:4` — root route renders the public demo surface.
- `checkout-surge/apps/web/src/app/admin/page.tsx:4` — admin page always renders the admin console page shell.
- `checkout-surge/apps/web/src/app/components/admin-console.tsx:547` — protected controls are hidden behind a client-side sign-in gate.
- `checkout-surge/apps/web/src/app/run-history/page.tsx:32` — public history page always includes `RunHistoryAdminControls`.

#### Verdict rationale

Surge implements the required route split, and this is not primarily a security finding. It is worse as a UX/access-model surface because anonymous visitors still see more operator affordances than the spec's public demo model intends.

### C76 — Web BFF and same-origin browser boundary (worse)

#### Reference behavior

Forge routes browser reads, controls, and the SSE stream through the dashboard origin. Dashboard read proxies validate upstream responses against shared contracts, the web route proxies the API event stream, mutating control routes derive privilege server-side before attaching internal service-token/operator headers, and the reference Caddy proxy routes `/dashboard/events*` directly to the API while sending other browser traffic to the web service.

**References:**
- `checkout-forge/apps/web/src/app/api/dashboard/dashboard-read-proxy.ts:20` — shared read proxy validates upstream JSON with Zod.
- `checkout-forge/apps/web/src/app/dashboard/events/route.ts:10` — web route proxies the dashboard SSE stream.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:23` — start proxy derives privilege from the admin session.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:80` — start proxy calls the internal API with control headers and public visitor identity.
- `checkout-forge/infra/caddy/Caddyfile:2` — Caddy routes dashboard-event traffic separately.
- `checkout-forge/infra/caddy/Caddyfile:8` — Caddy sends default browser traffic to the web service.

#### Compared behavior

Surge has a reasonable JSON proxy helper and uses it for dashboard recovery and start/control routes. Its Caddy runtime also provides a same-origin split by routing `/dashboard/events` to the API and other browser traffic to the web service. Server components read backend URLs directly on the server, which keeps secrets out of the browser but creates a second read path. The bigger gap is realtime in the web app: the browser constructs the `EventSource` URL from a path or `NEXT_PUBLIC_DASHBOARD_EVENTS_URL`, and the inspected web app does not own a Next route that proxies the SSE stream. The Caddy path makes the reference container runtime work, but the public override still supports direct browser-to-API access.

**References:**
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:136` — shared JSON proxy validates backend responses.
- `checkout-surge/apps/web/src/app/api/dashboard/recovery/route.ts:4` — recovery has a same-origin JSON proxy route.
- `checkout-surge/apps/web/src/app/lib/api.ts:116` — server-rendered dashboard snapshot reads API and ERP backend URLs directly.
- `checkout-surge/apps/web/src/app/lib/realtime.ts:3` — browser SSE URL can be overridden with `NEXT_PUBLIC_DASHBOARD_EVENTS_URL`.
- `checkout-surge/infra/caddy/Caddyfile:9` — Caddy routes the dashboard events path to the API.
- `checkout-surge/infra/caddy/Caddyfile:14` — Caddy sends default browser traffic to the web service.

#### Verdict rationale

The JSON BFF story is close, but Surge is less disciplined about the single browser-origin rule. The missing web-owned SSE proxy and public direct-API override make the browser boundary weaker than Forge's all-browser-calls-through-web-origin design.

### C77 — Frontend realtime recovery protocol (same)

#### Reference behavior

Forge implements the prescribed client recovery protocol in a small coordinator. It performs authoritative recovery, discards live events while recovery is in flight, repeats recovery if anything was discarded, and triggers a final recovery after terminal run events. The live hook validates SSE payloads with the shared contract before applying them.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:49` — live events are discarded while recovery is running.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:74` — recovery repeats until no live event was discarded.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:59` — terminal run events trigger a follow-up recovery.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:67` — recovery fetch validates the shared recovery schema.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.test.ts:8` — tests cover discard-during-recovery behavior.

#### Compared behavior

Surge implements the same core client semantics inside `OperatorDashboard`. It tracks in-flight recovery and discarded live events, coalesces refreshes, runs a follow-up recovery when needed, validates SSE payloads before application, filters stale/previous-run events, and requests recovery after terminal run events. Tests cover follow-up recovery, stale-event filtering, and terminal recovery.

**References:**
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:64` — refs track in-flight recovery and discarded live events.
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:68` — refresh logic coalesces recovery and follows up after discarded events.
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:120` — SSE messages are parsed and contract-validated.
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:299` — terminal run events request authoritative recovery.
- `checkout-surge/apps/web/test/browser-workflows.test.ts:230` — browser test asserts follow-up recovery after an event during refresh.
- `checkout-surge/apps/web/test/dashboard-phase6.test.ts:104` — reducer tests ignore previous-run/stale live events.

#### Verdict rationale

This is equivalent on the core correctness rule that matters most: stale live events do not overwrite a fresh recovery baseline. Surge's implementation is less cleanly factored, which is graded in C79, but the recovery behavior itself reaches parity.

### C78 — Reconnect and recovery-failure UX (worse)

#### Reference behavior

Forge exposes connection state in the live UI and separates transport reconnection from authoritative recovery. SSE open marks the stream live and starts recovery; stream errors mark reconnecting. If recovery fails, the live-state hook surfaces an explicit sync issue and schedules retry recovery every three seconds until an authoritative read succeeds.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:51` — SSE open marks the connection live and triggers recovery.
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:55` — SSE errors mark the connection as reconnecting.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:87` — recovery start/success/failure statuses are surfaced.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:95` — recovery failure schedules retry.
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:568` — UI distinguishes snapshot-ready from snapshot-pending states.

#### Compared behavior

Surge shows realtime status and event count, marks the stream connected/disconnected/unsupported, and refreshes recovery when the stream opens. Recovery read failures become unavailable `BackendRead` results rather than entering a scheduled authoritative retry loop. Users can manually refresh, and EventSource reconnect can trigger another recovery, but a failed recovery read can sit as an unavailable panel without active retry.

**References:**
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:113` — SSE open sets connected and refreshes recovery.
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:117` — SSE error sets disconnected.
- `checkout-surge/apps/web/src/app/components/dashboard-panels.tsx:284` — recovery panel displays live stream status and event count.
- `checkout-surge/apps/web/src/app/lib/client/proxy-json.ts:26` — client proxy reads return unavailable objects.
- `checkout-surge/apps/web/src/app/components/dashboard-panels.tsx:271` — recovery retry is exposed as a manual refresh button.

#### Verdict rationale

Surge is not silently stale because it shows disconnected and unavailable states. It is worse because recovery failure handling is passive compared with Forge's explicit sync-issue state and scheduled authoritative retry, which matters during API restarts and stream drops.

### C79 — Frontend decomposition and testability (worse)

#### Reference behavior

Forge deliberately separates client mechanics from presentation. Recovery coordination, realtime binding, retry scheduling, live-state reduction, view-model derivation, validation, formatting, route ownership, and destructive-action behavior live in smaller tested modules. It also tests the failure-prone realtime/recovery logic as focused pure modules before layering DOM coverage over user-visible controls.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:27` — recovery coordination is a small standalone module.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:43` — React hook composes recovery, realtime, retry, and view-model modules.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:260` — view-model derivation is pure logic outside components.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.test.ts:8` — focused tests cover discard-during-recovery behavior.
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.test.ts:15` — realtime binding tests cover same-origin EventSource behavior.
- `checkout-forge/apps/web/src/app/dashboard-ui.dom.test.tsx:1` — DOM-level tests cover accessible dashboard UI.

#### Compared behavior

Surge has reusable panels and helper modules, plus tests for important workflows, but more behavior lives inside large client components. `OperatorDashboard` owns watch state, realtime, recovery, event reduction, public start actions, and admin utility panels. `AdminConsole` owns authentication, protected reads, policy editing, preset editing, starts, reset, cleanup, ERP controls, parsing, and draft conversion in one file. The tests prove important cases, including follow-up recovery when SSE events arrive during refresh and stale-event filtering, but they are broader workflow/reducer tests rather than the baseline's finer-grained state-machine coverage.

**References:**
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:51` — one component owns watch state, realtime, recovery, and controls.
- `checkout-surge/apps/web/src/app/components/operator-dashboard.tsx:229` — event reduction is embedded in the component module.
- `checkout-surge/apps/web/src/app/components/admin-console.tsx:142` — large admin component owns auth, reads, editing, starts, reset, cleanup, and ERP actions.
- `checkout-surge/apps/web/src/app/components/admin-console.tsx:1323` — preset/runtime draft conversion is embedded in the admin component file.
- `checkout-surge/apps/web/test/browser-workflows.test.ts:230` — browser workflow test covers follow-up recovery during refresh.
- `checkout-surge/apps/web/test/dashboard-phase6.test.ts:104` — reducer tests ignore previous-run and stale live events.

#### Verdict rationale

Surge is testable enough to avoid a complete frontend monolith, but the architecture is materially worse. Forge's smaller pure modules and focused recovery/realtime tests make the client rules easier to audit and evolve; Surge concentrates too many responsibilities in a few large files and covers several edge cases through coarser tests.

### C80 — Public picker, custom run, and admin control UX (worse)

#### Reference behavior

Forge's public home page supports curated public presets, a policy-driven bounded public custom form, admin sign-in entry, and start gating while a run is in progress. The admin console adds richer preset management, runtime-policy editing, reset recovery, ERP controls, and confirmation flows. Public custom controls are guided by policy limits and keep admin-only behavior out of the ordinary public path.

**References:**
- `checkout-forge/apps/web/src/app/public-home-client.tsx:217` — public preset selection section.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:246` — bounded public custom section.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:309` — public custom fields derive help and limits from runtime policy.
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:1112` — admin recovery actions are grouped and explained.
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:1558` — reset uses a confirmation dialog explaining consequences.

#### Compared behavior

Surge covers the major controls: curated public presets, public custom inputs constrained by runtime policy, start blocking during active/draining runs, admin runtime-policy editing, preset save/duplicate/copy-to-custom, reset, cleanup, and ERP controls. The UX is thinner. The public custom form can expose forced-outage UI when policy allows it, the watch page has hard-coded public start buttons for fixed preset slugs instead of rendering the available preset list, and admin destructive actions are mostly plain buttons with status messages rather than modal confirmations.

**References:**
- `checkout-surge/apps/web/src/app/components/public-demo-entry.tsx:117` — curated public presets render on the root page.
- `checkout-surge/apps/web/src/app/components/public-demo-entry.tsx:177` — public custom form uses runtime policy limits.
- `checkout-surge/apps/web/src/app/components/public-demo-entry.tsx:291` — forced-outage checkbox can appear in the public custom form if policy allows it.
- `checkout-surge/apps/web/src/app/components/dashboard-panels.tsx:299` — watch-page start controls are hard-coded preset slugs.
- `checkout-surge/apps/web/src/app/components/admin-console.tsx:613` — admin runtime-policy panel is present.
- `checkout-surge/apps/web/src/app/components/admin-console.tsx:973` — admin preset editor supports start/save/duplicate/copy-to-custom.

#### Verdict rationale

Surge is featureful, but Forge is more deliberate about public/operator separation and destructive-flow clarity. Hard-coded watch preset controls and optional public forced-outage exposure show a less tightly governed UI model.

### C81 — Run history and destructive admin flows (worse)

#### Reference behavior

Forge treats run history as a public-safe HTTP-only surface with separate admin deletion capability. Summary and detail views expose traffic, business, ERP, inventory, timing, and diagnostic information through view-model helpers and tests. Destructive deletion uses confirmation dialogs, and delete-all sends a typed confirmation token while the UI explains the blast radius.

**References:**
- `checkout-forge/apps/web/src/app/run-history/page.tsx:7` — run history is a route-level HTTP page with admin state detected separately.
- `checkout-forge/apps/web/src/app/run-history/run-history-client.tsx:129` — delete-all sends an explicit confirmation token.
- `checkout-forge/apps/web/src/app/run-history/run-history-client.tsx:474` — delete-all confirmation dialog explains it deletes every persisted summary.
- `checkout-forge/apps/web/src/app/run-history/run-detail-view.tsx:90` — detail view renders traffic, business, ERP, and timing metrics.
- `checkout-forge/apps/web/src/app/run-history/run-history-summary-view.test.ts:45` — summary view-model tests cover public metrics.

#### Compared behavior

Surge has paginated public history and a detail view with traffic, business, inventory, configuration, order, and ERP-attempt sections. It also implements selected-summary deletion and delete-all with a typed confirmation string. The UX is weaker because the admin deletion panel is always mounted on the public history page, asks for the passphrase inline, executes deletion via buttons without an explicit modal confirmation step, and hard-reloads the page afterward.

**References:**
- `checkout-surge/apps/web/src/app/run-history/page.tsx:14` — public run history route fetches a paginated page.
- `checkout-surge/apps/web/src/app/components/run-history-list.tsx:37` — summary cards render run metrics and terminal inventory.
- `checkout-surge/apps/web/src/app/components/run-history-detail.tsx:15` — detail view renders summary, config, orders, and ERP attempts.
- `checkout-surge/apps/web/src/app/components/run-history-admin-controls.tsx:18` — admin deletion controls are mounted on the history page.
- `checkout-surge/apps/web/src/app/components/run-history-admin-controls.tsx:74` — delete-all sends the typed confirmation string.
- `checkout-surge/apps/web/test/browser-workflows.test.ts:307` — browser test verifies delete-all confirmation request body.

#### Verdict rationale

Surge is not missing run history, and the typed delete-all token is a good guard. It is still worse because public history includes visible admin cleanup controls and destructive actions lack Forge's clearer confirmation-dialog treatment.

### C82 — Admin session establishment and cookie hygiene (worse)

#### Reference behavior

Forge establishes admin access through a server-side passphrase route. The passphrase comparison hashes both values and uses timing-safe comparison, then successful authentication sets a signed `HttpOnly` cookie with path scope, max age, `SameSite=Lax`, and the production `Secure` attribute. The access helper also centralizes required secret loading, session verification, signed visitor cookies, and construction of trusted control headers.

**References:**
- `checkout-forge/apps/web/src/app/web-access.ts:50` — web access config requires the admin passphrase, session secret, visitor cookie secret, and control token.
- `checkout-forge/apps/web/src/app/web-access.ts:125` — admin session cookie value is HMAC-signed over the expiry payload.
- `checkout-forge/apps/web/src/app/web-access.ts:175` — passphrase comparison uses hashed timing-safe comparison.
- `checkout-forge/apps/web/src/app/api/admin/session/route.ts:19` — login sets `HttpOnly`, `SameSite=Lax`, max-age, path, and production `Secure`.

#### Compared behavior

Surge has the same broad passphrase-to-signed-cookie flow and keeps the resulting admin session `HttpOnly`. Its details are weaker: the passphrase is submitted in a custom request header and compared with direct string equality, the emitted cookie omits `Secure` even in production, and malformed session max-age configuration falls back silently to the default.

**References:**
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:23` — admin passphrase is read from a request header and directly compared.
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:57` — admin session cookie is HMAC-signed over an expiry timestamp.
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:76` — cookie string includes `HttpOnly` and `SameSite=Lax` but no `Secure`.
- `checkout-surge/apps/web/src/app/api/admin/session/route.ts:6` — successful passphrase check issues the session cookie.

#### Verdict rationale

Surge implements the core signed-session mechanism, so this is not missing. Forge is stronger on production cookie hygiene and comparison discipline; the missing `Secure` attribute is the clearest regression for a public admin surface.

### C83 — Admin and internal service-token enforcement (same)

#### Reference behavior

Forge layers browser admin sessions over internal service-token checks. The web proxy validates the signed admin session before forwarding privileged requests, and the API, mock ERP, and load orchestrator independently reject missing or invalid control tokens on their protected routes.

**References:**
- `checkout-forge/apps/web/src/app/api/control/demo/reset/route.ts:13` — reset proxy rejects requests without a valid admin session.
- `checkout-forge/apps/web/src/app/api/control/mock-erp/chaos/route.ts:17` — ERP chaos mutation is admin-session gated and forwards control headers.
- `checkout-forge/apps/api/src/routes/demo-reset.ts:15` — API reset route independently requires the control service token.
- `checkout-forge/apps/mock-erp/src/server.ts:135` — mock ERP chaos mutation requires the control token.
- `checkout-forge/apps/load-orchestrator/src/server.ts:125` — load start endpoint requires the control token.

#### Compared behavior

Surge preserves the same defense-in-depth shape for admin and internal operations. Next.js admin routes check the signed admin session and attach the configured control token, while the downstream API, mock ERP, and load orchestrator repeat service-token checks at their own boundaries.

**References:**
- `checkout-surge/apps/web/src/app/api/admin/demo/reset/route.ts:10` — reset proxy requires admin session and forwards control-token headers.
- `checkout-surge/apps/web/src/app/api/admin/erp-chaos/route.ts:24` — ERP chaos mutation is session-gated and token-proxied.
- `checkout-surge/apps/api/src/routes/admin-maintenance-routes.ts:21` — API maintenance routes require the control token.
- `checkout-surge/apps/mock-erp/src/routes/chaos-routes.ts:27` — mock ERP chaos update requires the control token.
- `checkout-surge/apps/load-orchestrator/src/server.ts:88` — traffic execution start requires the control token.

#### Verdict rationale

For admin-only and internal service calls, Surge reaches parity. Error taxonomy differs, but the effective security boundary is the same: the browser needs an admin session, and direct service calls need the private token.

### C84 — Public run-start trust boundary (worse)

#### Reference behavior

Forge treats public run starts as mutating control operations that still pass through the trusted dashboard proxy. The proxy derives operator mode from the validated admin session, never from the body, attaches the service token for both public and admin starts, and attaches a server-issued public visitor id only for public starts. The API requires the service token and derives the principal from the trusted operator-mode assertion.

**References:**
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:23` — operator privilege is derived from the admin session.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:80` — public and admin starts are forwarded with control headers.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:281` — API run-start route requires control access even when `adminOnly` is false.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:294` — API principal is derived from the trusted operator-mode assertion.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:405` — control access rejects invalid tokens or operator modes.

#### Compared behavior

Surge splits public and admin web start routes. The admin route is token-proxied, but the public route forwards directly to the API without the control token. The API start route defaults missing operator mode to public, accepts public starts without the service token, and reads the public visitor id from a normal request header.

**References:**
- `checkout-surge/apps/web/src/app/api/demo/runs/start/route.ts:32` — public start proxy forwards public operator and visitor headers without a service token.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:140` — API start route is public before parsing the body.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:188` — principal derivation defaults missing operator mode to public.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:195` — only admin mode checks the control service token.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:208` — public visitor id is read directly from the request header.

#### Verdict rationale

This is a major access-model regression. A direct caller can start public Surge runs and choose arbitrary visitor ids, bypassing the server-issued signed visitor identity rule. Forge keeps the proxy and service-token channel as the trust boundary for public starts too.

### C85 — Public visitor identity and budget accounting (worse)

#### Reference behavior

Forge issues signed `HttpOnly` visitor cookies in the web tier and forwards only the verified visitor id to the API over the service-token channel. Budget reservation is a Redis Lua operation that checks visitor and global counts before incrementing either key, and the API releases a reserved budget slot if a later start step fails.

**References:**
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:66` — public start resolves or creates a server-signed visitor identity.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:105` — new visitor identity is stored as an `HttpOnly` signed cookie.
- `checkout-forge/apps/api/src/services/public-run-budget-service.ts:83` — Lua reservation checks counts before incrementing.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:340` — public principals reserve budget before starting a run.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:369` — reserved budget is released if run start fails after reservation.

#### Compared behavior

Surge also creates signed visitor cookies in the web tier, but the API cannot distinguish proxy-issued visitor headers from direct caller headers. Its Redis budget path increments global and visitor counters first, then checks limits and throws if either limit was exceeded. Rejected over-limit attempts therefore consume future budget, and there is no matching release path for that rejection.

**References:**
- `checkout-surge/apps/web/src/app/lib/server/public-visitor.ts:12` — web tier resolves or creates a signed visitor identity.
- `checkout-surge/apps/web/src/app/api/demo/runs/start/route.ts:37` — visitor id is forwarded to the API as a plain header.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:125` — budget keys are built from the supplied visitor id.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:131` — Redis `MULTI` increments counters before limit checks.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:150` — over-limit decisions are thrown after incrementing.

#### Verdict rationale

Surge has the visible visitor-cookie feature, but the enforcement is weaker. Visitor identity is spoofable at the API boundary, and rejected over-budget attempts still burn budget. Forge's reservation script and compensation path are both more precise.

### C86 — Public runtime policy and deployment hard caps (worse)

#### Reference behavior

Forge treats deployment hard caps as API startup configuration. The API parses hard-cap environment values on boot, builds or validates the public runtime policy against those hard caps, rejects runtime-policy updates that exceed them, and validates public custom run snapshots against both policy limits and deployment caps.

**References:**
- `checkout-forge/apps/api/src/config.ts:52` — deployment hard-cap values are parsed as API startup config.
- `checkout-forge/apps/api/src/config.ts:90` — API startup creates policy and asserts it fits hard caps.
- `checkout-forge/apps/api/src/services/public-runtime-policy-service.ts:57` — policy updates parse the full policy before persistence.
- `checkout-forge/apps/api/src/services/public-runtime-policy-service.ts:82` — public traffic caps are compared to hard caps.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:200` — public custom config is validated against policy limits and hard caps.

#### Compared behavior

Surge models the same layers, but deployment hard caps live inside the persisted runtime-policy row seeded from environment variables rather than in API startup config. Admin updates preserve and validate against the current persisted hard-cap object, and run starts check accepted snapshots against the persisted caps and public custom limits. If deployment cap environment values change later, the running API keeps using the stored row until reseed or manual update.

**References:**
- `checkout-surge/apps/api/src/runtime/config.ts:1` — API runtime config has no deployment hard-cap or public policy fields.
- `checkout-surge/packages/db/src/scripts/seed.ts:422` — runtime policy, budgets, public custom limits, and deployment hard caps are seeded from environment variables.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:410` — admin policy update preserves the current persisted deployment hard caps.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:1188` — policy updates validate public limits against persisted hard caps.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:1077` — run snapshots are checked against deployment hard caps and public custom limits.

#### Verdict rationale

Surge performs meaningful cap validation, so this is not missing. It is worse because hard caps are not an environment-backed startup invariant after seeding; Forge keeps deployment caps tied to the running deployment and cross-validates policy on every boot.

### C87 — Public preset and custom-start authorization (same)

#### Reference behavior

Forge rejects public starts of admin-only presets, allows public configuration overrides only through the public custom preset, applies public custom limits to stock, ERP, failure-mode, and backpressure settings, and persists the run's operator mode.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:95` — public starts of admin-only presets are rejected.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:107` — public configuration override is allowed only for the public custom preset.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:212` — public custom stock, ERP, failure-mode, and backpressure limits are enforced.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:127` — accepted runs persist `operatorMode`.

#### Compared behavior

Surge implements the same service-level authorization rules once a public principal has been derived. Public callers can only use public presets, public overrides are limited to the custom preset, snapshots are checked against public custom limits where appropriate, and the persisted run row records operator mode.

**References:**
- `checkout-surge/apps/api/src/services/demo-run-service.ts:759` — public starts of non-public presets are rejected.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:766` — public overrides are rejected except for the custom preset.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:1137` — public custom limit enforcement is applied for public custom runs.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:721` — accepted run persistence records `operatorMode`.

#### Verdict rationale

This finding intentionally excludes the trust-boundary flaw in C84. Within the run service's preset/custom authorization logic, Surge covers the same main cases as Forge.

### C88 — Public-safe run history DTO boundary (worse)

#### Reference behavior

Forge separates public run detail from protected operational detail. Public history detail returns summaries, public diagnostics, operator mode, timeline, config snapshot, queue/inventory aggregates, and ERP aggregate statistics. Full reservation rows, pending reservations, orders, ERP attempts, notifications, and order events are reserved for internal dashboard detail routes protected by the control token.

**References:**
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:32` — public run-detail route calls the public-safe detail method.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:77` — full run detail is under an internal control-token route.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:128` — public detail is built through a separate public DTO.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:143` — public detail includes summaries and aggregate projections.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:191` — admin/internal detail includes raw operational collections.

#### Compared behavior

Surge exposes one public run-history detail route. It avoids the most explicit forbidden leaks such as reservation tokens and idempotency keys, but the public response includes row-level collections for orders, ERP attempts, notifications, and events. Those DTOs expose internal order ids, attempt ids, sale offer ids, event sources, and correlation ids.

**References:**
- `checkout-surge/apps/api/src/routes/run-history-routes.ts:29` — public run-history detail route returns service detail without auth.
- `checkout-surge/apps/api/src/services/run-history-service.ts:183` — public detail includes order, ERP attempt, notification, and event collections.
- `checkout-surge/apps/api/src/services/run-history-service.ts:275` — public order records include internal ids and correlation id.
- `checkout-surge/apps/api/src/services/run-history-service.ts:291` — public ERP attempt records include internal ids and correlation id.
- `checkout-surge/apps/api/src/services/run-history-service.ts:337` — public event timeline records include sale offer id, correlation id, and optional order id.

#### Verdict rationale

Surge is not leaking the most sensitive forbidden fields, but its public/admin DTO boundary is much thinner. Forge keeps anonymous history closer to public-safe summaries and aggregates, while Surge publishes more operational identifiers and row-level internals.

### C89 — Destructive operation access gates (same)

#### Reference behavior

Forge protects destructive history deletion through both the web admin session and API service-token checks. Delete-all requires a typed confirmation value at the contract/API layer in addition to admin authentication.

**References:**
- `checkout-forge/apps/web/src/app/api/control/run-summaries/delete/route.ts:17` — bulk deletion proxy requires admin session.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:143` — bulk delete endpoint requires the service token.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:166` — delete-all endpoint requires the service token.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:180` — delete-all request body is validated against the confirmation schema.

#### Compared behavior

Surge also gates destructive history deletion through an admin-session proxy and service-token API route. Its contract accepts either selected run ids or the literal `DELETE_ALL_RUN_SUMMARIES` confirmation token, not both.

**References:**
- `checkout-surge/apps/web/src/app/api/admin/demo/runs/history/route.ts:16` — run-history delete proxy requires admin session.
- `checkout-surge/apps/web/src/app/api/admin/demo/runs/history/route.ts:37` — proxy forwards deletion with the control token.
- `checkout-surge/apps/api/src/routes/run-history-routes.ts:45` — API delete route requires the control token.
- `checkout-surge/packages/contracts/src/demo.ts:483` — delete-all confirmation is a literal token and conflicts with selected deletion.
- `checkout-surge/apps/api/src/services/run-history-service.ts:214` — service deletes all summaries only when confirmation is present.

#### Verdict rationale

Access protection for destructive history deletion is equivalent. The UX weaknesses are covered in C81, and run-owned cleanup completeness belongs to lifecycle/persistence findings rather than this access-gate verdict.

### C90 — Internal ingestion endpoint protection (same)

#### Reference behavior

Forge protects load metric ingestion and load-run lifecycle/finalization reports with the control service token. These endpoints are internal service surfaces, not browser-public routes.

**References:**
- `checkout-forge/apps/api/src/routes/load-metrics.ts:13` — load metric ingestion is an internal route.
- `checkout-forge/apps/api/src/routes/load-metrics.ts:16` — metric ingestion requires the control token.
- `checkout-forge/apps/api/src/routes/load-run-finalization.ts:23` — lifecycle report route is internal and token-protected.
- `checkout-forge/apps/api/src/routes/load-run-finalization.ts:60` — traffic report route is internal and token-protected.

#### Compared behavior

Surge follows the same pattern for metric ingestion and traffic-completion reports. Both routes live in the API route module and require the configured control token before applying the payload.

**References:**
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:163` — load metric ingestion endpoint requires the control token.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:175` — traffic completion endpoint requires the control token.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:528` — metric ingestion is applied after route-level validation.
- `checkout-surge/apps/api/src/services/demo-run-service.ts:546` — traffic completion report is parsed after token-gated routing.

#### Verdict rationale

Surge is equivalent for internal ingestion access control. Route paths and service names differ, but the mutating ingestion surfaces are not publicly callable without the shared service token.

### C91 — Reference runtime topology and explicit setup lifecycle (same)

#### Reference behavior

Forge's reference compose runtime preserves the claimed service boundaries: PostgreSQL, Redis, API, worker, mock ERP, load orchestrator, web, and Caddy proxy are separate services. The load orchestrator is a containerized service rather than a host-side k6 prerequisite, and database mutation is kept behind an explicit setup service and package command instead of happening implicitly during normal startup.

**References:**
- `checkout-forge/docker-compose.yml:46` — API is its own compose service.
- `checkout-forge/docker-compose.yml:68` — worker is its own compose service.
- `checkout-forge/docker-compose.yml:90` — mock ERP is its own compose service.
- `checkout-forge/docker-compose.yml:106` — load orchestrator is its own compose service.
- `checkout-forge/docker-compose.yml:132` — web service is separate from the API.
- `checkout-forge/docker-compose.yml:177` — profiled setup service keeps migration/seed out of normal startup.

#### Compared behavior

Surge preserves the same broad runtime shape. It has separate containers for the API, worker, mock ERP, load orchestrator, web, dashboard proxy, PostgreSQL, Redis, and a setup target. Its package scripts also preserve infra-only startup, full runtime startup, explicit setup, health, smoke, reset, and cleanup commands.

**References:**
- `checkout-surge/docker-compose.yml:45` — API is its own compose service.
- `checkout-surge/docker-compose.yml:103` — worker is its own compose service.
- `checkout-surge/docker-compose.yml:137` — mock ERP is its own compose service.
- `checkout-surge/docker-compose.yml:166` — load orchestrator is its own compose service.
- `checkout-surge/docker-compose.yml:192` — web service is separate from the API.
- `checkout-surge/docker-compose.yml:241` — profiled setup service exists.

#### Verdict rationale

Surge does not collapse the reference runtime boundaries. Naming and profile details differ, but the operational contract is equivalent: containers do not auto-migrate or auto-seed on startup, and host-native development can use an infra-only mode.

### C92 — Compose readiness gating and startup robustness (worse)

#### Reference behavior

Forge uses health-gated dependency ordering through the app chain. The API waits for healthy PostgreSQL and Redis, the worker waits for healthy data services and mock ERP, the load orchestrator waits for healthy API readiness, and browser-facing services wait for healthy upstreams. That makes `docker compose up` closer to demo readiness than mere process creation.

**References:**
- `checkout-forge/docker-compose.yml:59` — API waits for healthy PostgreSQL.
- `checkout-forge/docker-compose.yml:61` — API waits for healthy Redis.
- `checkout-forge/docker-compose.yml:79` — worker waits for healthy PostgreSQL.
- `checkout-forge/docker-compose.yml:83` — worker waits for healthy mock ERP.
- `checkout-forge/docker-compose.yml:124` — load orchestrator requires API health.
- `checkout-forge/docker-compose.yml:148` — web requires API health.

#### Compared behavior

Surge health-gates the lower service dependencies, but weakens the upper browser-facing graph. The web service waits only for API, mock ERP, and load orchestrator to be started, and the dashboard proxy waits only for API and web to be started. The proxy can therefore look available while backend reads, controls, or streaming paths are still settling.

**References:**
- `checkout-surge/docker-compose.yml:90` — API waits for healthy PostgreSQL.
- `checkout-surge/docker-compose.yml:92` — API waits for healthy Redis.
- `checkout-surge/docker-compose.yml:122` — worker waits for healthy PostgreSQL.
- `checkout-surge/docker-compose.yml:126` — worker waits for healthy mock ERP.
- `checkout-surge/docker-compose.yml:180` — load orchestrator requires API health.
- `checkout-surge/docker-compose.yml:208` — web only requires API to be started.
- `checkout-surge/docker-compose.yml:231` — dashboard proxy only requires API to be started.

#### Verdict rationale

Surge has solid low-level readiness gating, but the top-level dashboard path is less robust than Forge. The browser origin can become reachable before the full demo path is ready, which increases first-run ambiguity and pushes more responsibility onto separate health/smoke scripts.

### C93 — Runtime image construction and service targets (same)

#### Reference behavior

Forge uses a DB-only runtime setup target for migration/seed and a shared app image target for Node services. Its load-orchestrator image is dedicated and installs only the load-orchestrator dependency closure while owning the k6 binary as covered in C73.

**References:**
- `checkout-forge/Dockerfile.runtime:1` — DB-only `runtime-setup` image target.
- `checkout-forge/Dockerfile.runtime:11` — setup target installs only the DB package closure.
- `checkout-forge/Dockerfile.runtime:19` — shared app image target for Node app services.
- `checkout-forge/Dockerfile.runtime:39` — app target installs monorepo dependencies.
- `checkout-forge/apps/load-orchestrator/Dockerfile:19` — load-orchestrator image uses a filtered install.

#### Compared behavior

Surge puts the runtime targets in one root Dockerfile. It has a DB-focused setup target, a shared workspace build target, named runtime targets for API, worker, mock ERP, web, and load orchestrator, and the same container-owned k6 pattern noted in C73. The tradeoff is that app runtime targets inherit the full workspace install/build instead of being pruned per service.

**References:**
- `checkout-surge/Dockerfile:10` — DB-focused `runtime-setup` target.
- `checkout-surge/Dockerfile:18` — setup target installs only the DB package closure.
- `checkout-surge/Dockerfile:31` — shared workspace target for app builds.
- `checkout-surge/Dockerfile:44` — workspace target installs the full monorepo.
- `checkout-surge/Dockerfile:50` — API runtime target.
- `checkout-surge/Dockerfile:72` — load-orchestrator runtime target.

#### Verdict rationale

Surge's target naming and single-file organization are cleaner, while Forge's load-orchestrator image is leaner. Both keep setup separate from normal startup and build service-specific runtime targets, so the overall image-construction posture is equivalent.

### C94 — Dev Container and Codespaces isolation (same)

#### Reference behavior

Forge's Dev Container starts only the workspace service, forwards the expected runtime/debug/test ports, uses Docker-in-Docker, and avoids automatically starting the full topology. Its compose overlay uses named dependency volumes so Linux `node_modules` do not pollute the host workspace.

**References:**
- `checkout-forge/.devcontainer/devcontainer.json:5` — only the workspace service is auto-started.
- `checkout-forge/.devcontainer/devcontainer.json:15` — runtime, debug, and test ports are forwarded.
- `checkout-forge/.devcontainer/docker-compose.yml:8` — workspace runs privileged for Docker-in-Docker.
- `checkout-forge/.devcontainer/docker-compose.yml:13` — root `node_modules` uses a named volume.
- `checkout-forge/.devcontainer/post-start.sh:18` — post-start keeps runtime commands explicit.

#### Compared behavior

Surge follows the same Dev Container strategy. It starts only the workspace service, forwards the same operational ports, uses Docker-in-Docker, and uses named dependency volumes. Its post-start script additionally repairs a branch/worktree-specific Git layout before checking Docker. One minor inconsistency is that the load-orchestrator overlay does not override the root build target to `workspace` like the other app overlays, but it still runs the dev command with mounted workspace volumes.

**References:**
- `checkout-surge/.devcontainer/devcontainer.json:5` — only the workspace service is auto-started.
- `checkout-surge/.devcontainer/devcontainer.json:7` — runtime, debug, and test ports are forwarded.
- `checkout-surge/.devcontainer/docker-compose.yml:21` — workspace runs privileged for Docker-in-Docker.
- `checkout-surge/.devcontainer/docker-compose.yml:6` — root `node_modules` uses a named volume.
- `checkout-surge/.devcontainer/docker-compose.yml:68` — load orchestrator overlay starts its dev command.
- `checkout-surge/.devcontainer/post-start.sh:20` — post-start keeps runtime startup explicit.

#### Verdict rationale

Surge preserves the important development-container boundaries: isolated dependency volumes, Docker-in-Docker, explicit runtime commands, and no surprise full-topology startup. The load-orchestrator target inconsistency is minor relative to that parity.

### C95 — Env-file wrappers and mode separation (better)

#### Reference behavior

Forge has committed host and test env examples, and wrappers load runtime or test env files before running commands. The test wrapper derives package-scoped database names and Redis logical DBs for selected packages, keeping destructive test state away from development state. Runtime env loading is intentionally simple: root `.env` and `.env.local` are loaded while inherited shell variables are preserved.

**References:**
- `checkout-forge/.env.example:2` — host-native development database default.
- `checkout-forge/.env.example:40` — dashboard proxy base URL default.
- `checkout-forge/.env.test.example:4` — isolated test PostgreSQL URL.
- `checkout-forge/.env.test.example:5` — isolated test Redis URL.
- `checkout-forge/scripts/run-with-test-env.mjs:14` — Redis logical DB isolation map.
- `checkout-forge/scripts/run-with-test-env.mjs:45` — package-scoped test isolation is applied.

#### Compared behavior

Surge keeps the same env-example convention and improves the wrapper model. `env-utils.mjs` centralizes runtime env path ordering, package-local `.env.example` loading, test env loading, and package-scoped test isolation. Its Redis DB map covers more packages than the reference wrapper, and both runtime/test wrapper scripts use the same utility surface.

**References:**
- `checkout-surge/.env.example:6` — host-native development database default.
- `checkout-surge/.env.example:20` — worker health URL default.
- `checkout-surge/.env.test.example:7` — isolated test PostgreSQL URL.
- `checkout-surge/.env.test.example:8` — isolated test Redis URL.
- `checkout-surge/scripts/env-utils.mjs:10` — Redis DB isolation map covers multiple packages.
- `checkout-surge/scripts/env-utils.mjs:21` — runtime env search includes root and package env files.

#### Verdict rationale

Surge's env wrapper is more coherent and reusable. It preserves the reference's runtime/test separation while reducing duplicated parsing logic and making package-local env defaults first-class. C40 still captures that some application config consumers are less disciplined than this wrapper layer.

### C96 — Readiness health tooling (same)

#### Reference behavior

Forge's health check probes API, worker, mock ERP, load orchestrator, and dashboard reachability. It expects JSON readiness status for service endpoints, surfaces nested failed checks, and exits nonzero unless every required service is ready.

**References:**
- `checkout-forge/scripts/health-check.mjs:1` — health script enumerates service checks.
- `checkout-forge/scripts/health-check.mjs:6` — API readiness expects JSON status.
- `checkout-forge/scripts/health-check.mjs:12` — worker readiness expects JSON status.
- `checkout-forge/scripts/health-check.mjs:24` — load-orchestrator readiness expects JSON status.
- `checkout-forge/scripts/health-check.mjs:146` — nested failed checks are included in output.

#### Compared behavior

Surge's runtime health check probes API liveness, API readiness, worker readiness, mock ERP readiness, load-orchestrator readiness, and dashboard proxy reachability. It also explicitly requires nested load-orchestrator checks for API reachability and k6 binary executability. It is less startup-friendly than Forge because it performs a single pass rather than a polling wait loop, but the readiness surfaces are comparable.

**References:**
- `checkout-surge/scripts/runtime-health-check.mjs:5` — API liveness is checked.
- `checkout-surge/scripts/runtime-health-check.mjs:10` — API readiness is checked.
- `checkout-surge/scripts/runtime-health-check.mjs:15` — worker readiness is checked.
- `checkout-surge/scripts/runtime-health-check.mjs:25` — load-orchestrator readiness is checked.
- `checkout-surge/scripts/runtime-health-check.mjs:28` — nested API reachability and k6 binary checks are required.
- `checkout-surge/scripts/runtime-health-check.mjs:100` — required nested checks are inspected.

#### Verdict rationale

Both implementations check demo readiness rather than mere process liveness, including the load-orchestrator/k6 requirement. Forge is friendlier for waiting during startup; Surge is stricter about nested load-orchestrator checks. The result is equivalent.

### C97 — Non-mutating runtime smoke coverage (worse)

#### Reference behavior

Forge's non-mutating smoke script verifies compose service presence and health, HTTP readiness, dashboard recovery through the proxy, SSE through the proxy, and k6 inside the load-orchestrator container. Its SSE check waits for an actual first frame, which catches buffering or stream-body failures that a header-only check would miss.

**References:**
- `checkout-forge/scripts/runtime-smoke-check.mjs:14` — required compose services list includes all runtime services.
- `checkout-forge/scripts/runtime-smoke-check.mjs:57` — dashboard recovery is read through the proxy.
- `checkout-forge/scripts/runtime-smoke-check.mjs:58` — SSE is checked through the proxy.
- `checkout-forge/scripts/runtime-smoke-check.mjs:167` — SSE first frame is validated.
- `checkout-forge/scripts/runtime-smoke-check.mjs:186` — k6 version output is validated inside the container.

#### Compared behavior

Surge's non-mutating smoke script validates compose config, service state, health-check output, k6 inside the load-orchestrator container, dashboard recovery, and SSE reachability. The gap is stream depth: it verifies status and `text/event-stream` content type, then aborts; it does not wait for a heartbeat or event frame.

**References:**
- `checkout-surge/scripts/runtime-smoke.mjs:21` — smoke checks k6 inside the load-orchestrator container.
- `checkout-surge/scripts/runtime-smoke.mjs:61` — dashboard same-origin recovery is checked.
- `checkout-surge/scripts/runtime-smoke.mjs:62` — dashboard SSE reachability is checked.
- `checkout-surge/scripts/runtime-smoke.mjs:106` — SSE check uses an abort controller.
- `checkout-surge/scripts/runtime-smoke.mjs:118` — SSE check inspects content type.
- `checkout-surge/scripts/runtime-smoke.mjs:120` — SSE check fails on wrong content type.

#### Verdict rationale

Surge covers the same major non-mutating surfaces, but it is shallower at the most proxy-sensitive one. For this topology, accepting SSE headers without observing a frame is materially weaker than Forge's smoke check.

### C98 — Mutating dashboard-path load smoke (worse)

#### Reference behavior

Forge's mutating smoke option starts from runtime reset, establishes an admin dashboard session through the proxy, starts a tiny admin run through the dashboard control route, waits for the run to reach terminal `completed`, verifies k6 traffic metrics reached recovery state, and then cleans up only the generated smoke-run data.

**References:**
- `checkout-forge/scripts/runtime-smoke-check.mjs:7` — load smoke is an optional smoke mode.
- `checkout-forge/scripts/runtime-smoke-check.mjs:202` — admin session is created through the dashboard proxy.
- `checkout-forge/scripts/runtime-smoke-check.mjs:224` — load run is started through the dashboard control proxy route.
- `checkout-forge/scripts/runtime-smoke-check.mjs:284` — run must reach `completed`.
- `checkout-forge/scripts/runtime-smoke-check.mjs:292` — traffic metrics must be present in recovery state.
- `checkout-forge/scripts/runtime-smoke-check.mjs:306` — generated smoke run is cleaned up.

#### Compared behavior

Surge has a separate mutating load smoke script. It resets through the API service URL, starts a public custom run through the dashboard origin using a script-forged public visitor cookie, waits only until traffic status is `succeeded` or `failed`, checks that recent metrics exist, and then deletes generated rows and Redis keys directly.

**References:**
- `checkout-surge/scripts/runtime-smoke-load.mjs:24` — script resets the running demo before the smoke run.
- `checkout-surge/scripts/runtime-smoke-load.mjs:47` — reset uses the API base URL.
- `checkout-surge/scripts/runtime-smoke-load.mjs:62` — run start uses the dashboard route.
- `checkout-surge/scripts/runtime-smoke-load.mjs:68` — public visitor cookie is generated by the script.
- `checkout-surge/scripts/runtime-smoke-load.mjs:121` — completion condition is traffic status, not terminal run status.
- `checkout-surge/scripts/runtime-smoke-load.mjs:152` — script performs direct cleanup.

#### Verdict rationale

Surge proves that a small public run can launch and k6 can finish traffic, but Forge proves more of the real operator demo path: authenticated dashboard control, backend finalization, metric projection, and cleanup after a terminal run. Stopping at traffic completion can miss the post-traffic drain/finalization failures the product is designed to expose.

### C99 — Reset and maintenance command surface (worse)

#### Reference behavior

Forge exposes operational reset and cleanup commands that match the multi-service runtime. The reset client calls both the API demo reset and mock ERP chaos reset with the shared control token. Maintenance cleanup defaults to retaining the latest 15 runs and is exposed as a package command. Smoke cleanup is scoped to the generated run it created.

**References:**
- `checkout-forge/scripts/runtime-reset-client.mjs:10` — reset requires the control service token.
- `checkout-forge/scripts/runtime-reset-client.mjs:23` — API demo reset endpoint is called.
- `checkout-forge/scripts/runtime-reset-client.mjs:27` — mock ERP chaos reset endpoint is also called.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:19` — default maintenance retention is 15 runs.
- `checkout-forge/package.json:16` — maintenance cleanup command is exposed.

#### Compared behavior

Surge exposes reset and generated-run cleanup commands, but the reset script calls only the API reset endpoint and does not reset mock ERP chaos state, reinforcing the reset gap described in C51. Its maintenance cleanup is API-mediated and supports `keepLatest` and `olderThanDays`, which is useful, but the wrapper does only minimal local numeric parsing. The load-smoke script also performs direct SQL/Redis cleanup, so part of the operational surface remains tool-specific rather than going through the polished maintenance path.

**References:**
- `checkout-surge/scripts/runtime-reset.mjs:3` — reset script targets the API base URL only.
- `checkout-surge/scripts/runtime-reset.mjs:11` — reset calls `/admin/demo/reset`.
- `checkout-surge/scripts/maintenance-cleanup-runs.mjs:12` — maintenance cleanup calls the API cleanup endpoint.
- `checkout-surge/scripts/maintenance-cleanup-runs.mjs:39` — `--keep-latest` is parsed locally.
- `checkout-surge/scripts/maintenance-cleanup-runs.mjs:44` — `--older-than-days` is parsed locally.
- `checkout-surge/scripts/runtime-smoke-load.mjs:152` — load smoke performs direct generated-data cleanup.

#### Verdict rationale

Surge has a reasonable cleanup API and command surface, but reset is materially incomplete for the runtime because ERP chaos state is outside the operational reset command. Combined with direct smoke cleanup, the maintenance tooling is less cohesive and less trustworthy than Forge's multi-service reset plus scoped cleanup surface.

### C100 — Test taxonomy and command surface (worse)

#### Reference behavior

Forge exposes stable root commands for the full test suite and for unit, integration, and API/service-boundary tiers. The same package-level script contract is repeated across workspaces, even when a tier has no matching tests and uses `--passWithNoTests`, so `turbo run test:*` remains uniform as packages evolve.

**References:**
- `checkout-forge/package.json:30` — root test type-check delegates through Turbo.
- `checkout-forge/package.json:31` — root full test command runs package test tasks.
- `checkout-forge/package.json:32` — root unit tier command.
- `checkout-forge/package.json:33` — root integration tier command.
- `checkout-forge/package.json:34` — root API/service-boundary tier command.
- `checkout-forge/apps/api/package.json:21` — representative package exposes all test tiers.

#### Compared behavior

Surge keeps the same root command names, but tier membership is encoded through root-level package filters rather than a uniform package-local contract. The API participates only in `test:api`, the DB package only in `test:integration`, and web's API-style proxy tests are package-local rather than included by the root API tier.

**References:**
- `checkout-surge/package.json:20` — full root test command chains unit, API, and integration tiers.
- `checkout-surge/package.json:21` — unit tier manually filters selected packages.
- `checkout-surge/package.json:22` — integration tier manually filters DB and worker.
- `checkout-surge/package.json:23` — API tier manually filters only the API package.
- `checkout-surge/apps/api/package.json:11` — API package exposes only `test:api`.
- `checkout-surge/apps/web/package.json:13` — web keeps API-style proxy tests outside the root API tier.

#### Verdict rationale

Surge has a usable taxonomy, but it is more brittle. In Forge, adding a package or a tier-specific test is mostly package-local; in Surge, root filters must stay synchronized with package intent or tests can silently fall outside the standard tier commands.

### C101 — Test infrastructure, reset determinism, and parallel safety (worse)

#### Reference behavior

Forge uses dedicated PostgreSQL and Redis test services on non-conflicting ports, then layers package-scoped database names and Redis logical DBs on top. Database reset is guarded and self-healing: files within one package serialize through a lock, reset refuses non-test environments, `FLUSHDB` is the Redis rule, and the DB helper truncates only when migration metadata and a schema fingerprint match; otherwise it rebuilds from migrations.

**References:**
- `checkout-forge/docker-compose.test.yml:4` — dedicated PostgreSQL test service.
- `checkout-forge/docker-compose.test.yml:20` — dedicated Redis test service.
- `checkout-forge/scripts/run-with-test-env.mjs:39` — per-package database and Redis isolation.
- `checkout-forge/packages/db/src/testing.ts:18` — test-infrastructure lock directory.
- `checkout-forge/packages/db/src/testing.ts:93` — reset asserts the test environment.
- `checkout-forge/packages/db/src/testing.ts:100` — reset chooses truncate only when migrations and fingerprint match.

#### Compared behavior

Surge also has dedicated PostgreSQL and Redis test services and a shared env utility that derives package-specific database names and Redis logical DBs. The weaker part is reset determinism: the DB helper always runs migrations and truncates a fixed table list, lacks Forge's schema fingerprint guard, uses a shorter lock timeout, and primarily relies on the database name containing `test` rather than an environment-plus-schema safety model.

**References:**
- `checkout-surge/docker-compose.test.yml:4` — dedicated PostgreSQL test service.
- `checkout-surge/docker-compose.test.yml:20` — dedicated Redis test service.
- `checkout-surge/scripts/env-utils.mjs:182` — test database URL is suffixed per package.
- `checkout-surge/scripts/env-utils.mjs:189` — test Redis URL is rewritten to a package DB.
- `checkout-surge/packages/db/src/testing.ts:9` — reset uses a fixed table list.
- `checkout-surge/packages/db/src/testing.ts:55` — reset runs migrations before truncating the fixed list.

#### Verdict rationale

Surge has the right infrastructure shape, and its package-level isolation is meaningful. It is still worse because fixed reset lists, weaker guards, and no schema fingerprint make the suite easier to break as schema objects, tables, and intentionally destructive tests evolve.

### C102 — Hard-property regression coverage (same)

#### Reference behavior

Forge tests the central correctness properties with real Redis and API/service-boundary tests. The suite covers cheap sold-out rejection, duplicate replay, idempotency conflict, concurrent no-oversell behavior, uninitialized inventory handling, pending-persistence visibility, and API partial-failure behavior.

**References:**
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:92` — sold-out path preserves stock and avoids per-loser idempotency records.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:126` — duplicate replay and idempotency conflict coverage.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:246` — concurrent reservation attempts do not oversell.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:274` — uninitialized inventory and pending-persistence visibility.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:483` — API durable failure leaves pending state.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:938` — duplicate buy requests replay without a second reservation.

#### Compared behavior

Surge also directly tests these hard properties with real Redis/PostgreSQL and Fastify injection. Its DB integration suite covers atomic hold creation, sold-out cheapness, pre-durable retry behavior, conflicts, malformed Redis state, and a larger concurrent reservation storm; API tests cover concurrent no-oversell, shared idempotency races, and retry reconciliation after a real PostgreSQL-triggered transaction failure.

**References:**
- `checkout-surge/packages/db/test/integration/db.integration.test.ts:824` — atomic Redis hold creation stores replayable pending state.
- `checkout-surge/packages/db/test/integration/db.integration.test.ts:970` — sold-out path avoids per-loser records.
- `checkout-surge/packages/db/test/integration/db.integration.test.ts:1005` — pending retry promotes to accepted replay.
- `checkout-surge/packages/db/test/integration/db.integration.test.ts:1197` — idempotency quantity conflict leaves stock unchanged.
- `checkout-surge/packages/db/test/integration/db.integration.test.ts:1356` — 250 concurrent reservations across multiple clients do not oversell.
- `checkout-surge/apps/api/test/api.test.ts:2423` — real PostgreSQL failure leaves pending-persistence state and reconciles on retry.

#### Verdict rationale

This is equivalent for the Redis/API hot-path properties. Surge is stronger on a few individual stress and transaction-failure tests, while Forge spreads comparable hard-property coverage across the same central invariants and more surrounding lifecycle surfaces. The topic is coverage of the hardest invariants, not the domain behavior verdicts already covered in C20 through C38.

### C103 — API and service-boundary testability seams (same)

#### Reference behavior

Forge follows the testability rule at the API boundary. `buildApiServer` accepts explicit config, logger, database clients, Redis, queue publishers, persistence services, dashboard services, run services, policy services, and lifecycle services. Tests build the server with injected dependencies and use Fastify injection instead of starting a listener, while shutdown closes injected infrastructure.

**References:**
- `checkout-forge/apps/api/src/server.ts:48` — `ApiServerDependencies` centralizes injected infrastructure and services.
- `checkout-forge/apps/api/src/server.ts:85` — `buildApiServer` builds from explicit dependencies.
- `checkout-forge/apps/api/src/server.ts:132` — `onClose` closes queue, Redis, and PostgreSQL resources.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:90` — tests inject fake queue publishers.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:205` — test server is built from injected dependencies.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:278` — tests close the server after use.

#### Compared behavior

Surge also exposes an API server factory with injected config, logger, readiness, realtime fanout, dashboard recovery, ERP status, inventory status, queue status, reservation, run, maintenance, and history services. Its API tests build tailored servers with fake or real services, use Fastify injection, track servers for cleanup, and close externally created DB/Redis resources explicitly.

**References:**
- `checkout-surge/apps/api/src/server.ts:35` — `BuildApiServerOptions` defines injected dependencies.
- `checkout-surge/apps/api/src/server.ts:51` — async `buildApiServer` factory returns a configured Fastify app.
- `checkout-surge/apps/api/test/api.test.ts:176` — `buildTestServer` accepts injectable persistence, reservation, fanout, queue, and reader dependencies.
- `checkout-surge/apps/api/test/api.test.ts:228` — tests build the API through the server factory.
- `checkout-surge/apps/api/test/api.test.ts:800` — API test suite tracks servers for cleanup.
- `checkout-surge/apps/api/test/api.test.ts:1831` — integration suite closes DB and Redis resources.

#### Verdict rationale

This is equivalent. Both repos avoid route-module singletons for the service boundary, support dependency injection well enough to test failure paths, and use Fastify injection for API correctness tests. The ownership boundary differs, but the testability result is comparable.

### C104 — Repo-wide quality gates and conventions (same)

#### Reference behavior

Forge uses strict TypeScript, Biome formatting/linting, Turbo build/type-check/test tasks, and explicit test type-check scripts. Its Biome config includes a targeted test-file override, allowing common test patterns without loosening production linting.

**References:**
- `checkout-forge/tsconfig.json:6` — strict TypeScript is enabled.
- `checkout-forge/package.json:25` — root lint command runs Biome.
- `checkout-forge/package.json:29` — root production type-check command.
- `checkout-forge/package.json:30` — root test type-check command.
- `checkout-forge/biome.json:16` — Biome linter is enabled.
- `checkout-forge/biome.json:44` — test-file lint override.

#### Compared behavior

Surge also has a coherent quality-gate setup with Biome, Turbo, strict TypeScript, and root test type-checking. Its TypeScript base is stricter in some useful ways, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Its Biome setup is simpler and lacks Forge's test-file override, while the command-surface weaknesses are handled separately in C100.

**References:**
- `checkout-surge/tsconfig.base.json:7` — strict TypeScript is enabled.
- `checkout-surge/tsconfig.base.json:17` — `noUncheckedIndexedAccess` is enabled.
- `checkout-surge/tsconfig.base.json:18` — `exactOptionalPropertyTypes` is enabled.
- `checkout-surge/tsconfig.test.json:11` — root test type-check includes test files and Vitest configs.
- `checkout-surge/package.json:14` — root production type-check command.
- `checkout-surge/package.json:15` — root test type-check command.

#### Verdict rationale

The repo-wide quality gates are broadly equivalent. Surge has stricter compiler options; Forge has more mature lint exceptions and more uniform package-level quality scripts. Neither side clearly dominates at this level, even though C100 and C101 capture concrete weaknesses in Surge's testing command and reset machinery.

### C105 — README status and feature claims (same)

#### Reference behavior

Forge's README presents the shipped local demo as a realistic checkout-surge simulator, lists the major service responsibilities, and gives a command sequence for the containerized runtime. The feature list matches the rest of the implementation shape: Redis reservations, BullMQ order processing, mock ERP controls, realtime spectator views, k6 orchestration, public/admin presets, reset, recovery, and cleanup. It also correctly frames host-native k6 as an alternate workflow because the reference runtime carries k6 inside the load-orchestrator image.

**References:**
- `checkout-forge/README.md:7` — high-level product and architecture proof description.
- `checkout-forge/README.md:59` — feature list covering reservation, worker, ERP, realtime, k6, and admin controls.
- `checkout-forge/README.md:84` — quick-start sequence begins with `.env`, `runtime:up`, and setup.
- `checkout-forge/README.md:138` — host-native k6 is described as alternate-only.
- `checkout-forge/package.json:12` — documented `runtime:setup` command exists.
- `checkout-forge/package.json:14` — documented `runtime:smoke` command exists.

#### Compared behavior

Surge's README is adapted to `checkout-surge` rather than being a blind copy of the baseline text. It is explicit that the local Node.js implementation is complete through Phase 10.5, while hosted deployment and the optional Go comparison track remain later work. Its feature list includes Phase 10.5-facing surfaces such as Run History list/detail reads and public runtime policy management, and the documented runtime, smoke, reset, cleanup, and test commands have corresponding root scripts.

**References:**
- `checkout-surge/README.md:7` — status through Phase 10.5 and explicit later roadmap work.
- `checkout-surge/README.md:68` — feature list includes Run History and public runtime policy management.
- `checkout-surge/README.md:95` — quick-start runtime setup command.
- `checkout-surge/README.md:112` — documented runtime smoke command.
- `checkout-surge/README.md:142` — documented reset and cleanup commands.
- `checkout-surge/package.json:34` — documented runtime setup, smoke, reset, and cleanup scripts exist.

#### Verdict rationale

README fidelity is equivalent. Surge's README makes some claims about surfaces that are weaker in implementation details elsewhere in this report, but at the README feature-list level it accurately describes the shipped local scope and leaves hosted/Go work out of the completed claim.

### C106 — Roadmap auditability and completion tracking (better)

#### Reference behavior

Forge's roadmap is a living implementation plan with completed phases through run lifecycle/finalization and later phases still open for hosted deployment and the Go comparison track. It is readable and aligned with the baseline docs, but it mostly records tasks and decisions rather than detailed per-phase completion evidence.

**References:**
- `checkout-forge/working_docs/project_planning.md:11` — roadmap declares itself living documentation.
- `checkout-forge/working_docs/project_planning.md:624` — Phase 10 is marked complete.
- `checkout-forge/working_docs/project_planning.md:679` — Task 10.5 covers dashboard recovery and lifecycle ownership.
- `checkout-forge/working_docs/project_planning.md:694` — hosted deployment remains open.
- `checkout-forge/working_docs/project_planning.md:748` — optional Go benchmark track remains open.

#### Compared behavior

Surge's roadmap is more auditable. Early phases include completion commit lists and final verification command lists, later phases include detailed completion summaries, and the roadmap records a post-Phase-10 documentation/product-surface audit that created Phase 10.5 to close alignment gaps before hosted deployment. One historical blemish remains: Task 10.5.1 says a separate public detail route was not added, while Task 10.5.6 later records adding it.

**References:**
- `checkout-surge/working_docs/project_planning.md:59` — completion commits recorded for Phase 1.
- `checkout-surge/working_docs/project_planning.md:68` — final verification commands recorded for Phase 1.
- `checkout-surge/working_docs/project_planning.md:848` — post-Phase-10 audit names documentation/product-surface gaps.
- `checkout-surge/working_docs/project_planning.md:852` — Phase 10.5 created for final product surface and documentation alignment.
- `checkout-surge/working_docs/project_planning.md:882` — earlier summary says public detail route was not added.
- `checkout-surge/working_docs/project_planning.md:941` — later Task 10.5.6 records added public-safe detail reads.

#### Verdict rationale

Surge gives reviewers more audit handles than Forge: commit lists, verification lists, phase summaries, and a remediation phase for documentation drift. The Task 10.5.1/10.5.6 tension should be annotated as superseded, but it does not outweigh the stronger roadmap trail. Whether the historical commands actually ran is graded separately in C111.

### C107 — Design-doc adaptation versus inherited target wording (worse)

#### Reference behavior

Forge's design docs generally read as living documentation for the implemented system. They still use normative language where useful, but high-level docs often speak in current-state terms, and the Redis hot-path document explicitly calls automatic hold release not yet implemented.

**References:**
- `checkout-forge/docs/architecture.md:5` — architecture describes implemented decisions that make the demo possible.
- `checkout-forge/docs/load_generation_metrics_streaming.md:3` — load-generation doc describes the current demo flow.
- `checkout-forge/docs/automated_testing_infrastructure.md:165` — API factory is documented as already following the expected pattern.
- `checkout-forge/docs/cross_service_conventions.md:16` — timestamp convention references current services.
- `checkout-forge/docs/redis_inventory_hot_path.md:69` — automatic hold reconciliation is explicitly not implemented.

#### Compared behavior

Surge has adapted many names and implementation notes, but several docs still read as target/specification documents even where code has landed. The architecture, repository-layout, testing, and load-generation docs still describe target behavior or things that should be implemented, leaving readers to distinguish implemented facts from inherited blueprint constraints by cross-checking the code.

**References:**
- `checkout-surge/docs/architecture.md:5` — architecture is still described as target work to realize.
- `checkout-surge/docs/repository_layout.md:3` — repository layout is still described as target structure.
- `checkout-surge/docs/automated_testing_infrastructure.md:3` — testing foundation is described as target/to implement.
- `checkout-surge/docs/load_generation_metrics_streaming.md:3` — load-generation behavior is described as target.
- `checkout-surge/docs/automated_testing_infrastructure.md:165` — API factory still "should follow" the pattern.
- `checkout-surge/docs/core_business_entities.md:159` — deferred hold-expiry wording says "target demo model."

#### Verdict rationale

This is worse than Forge for documentation fidelity. The issue is not that the features are necessarily absent; it is that the docs mix current implementation, desired architecture, and inherited specification voice in a way that forces maintainers to verify too much against the code.

### C108 — Local command and runtime documentation alignment (same)

#### Reference behavior

Forge documents the runtime command contract in README, local-development docs, and runtime-topology docs. Those docs describe a single-origin Caddy proxy, separate app/data services, explicit setup instead of hidden migrations, smoke checks, reset, and cleanup retaining the latest 15 runs by default, and the root manifest plus runtime files back those claims.

**References:**
- `checkout-forge/docs/local_development.md:243` — command table documents setup, reset, smoke, smoke-load, cleanup, and dev commands.
- `checkout-forge/docs/runtime_topology.md:57` — setup is explicit migration/seed work.
- `checkout-forge/docs/runtime_topology.md:193` — operational verification checklist references setup, smoke, smoke-load, and cleanup.
- `checkout-forge/package.json:12` — root runtime scripts exist.
- `checkout-forge/docker-compose.yml:46` — API is a separate compose service.
- `checkout-forge/infra/caddy/Caddyfile:1` — Caddy serves the single-origin proxy on port 8080.

#### Compared behavior

Surge's command and topology docs make the same broad claims, and the root scripts, Dockerfile, compose file, Caddy config, and smoke scripts line up with them. `runtime:setup` maps to a compose setup target, `runtime:smoke` checks SSE and k6, `runtime:smoke:load` performs a small dashboard-proxied public-custom run and cleanup, and maintenance cleanup calls the protected cleanup API.

**References:**
- `checkout-surge/docs/local_development.md:263` — command table documents setup, reset, smoke, smoke-load, cleanup, dev, and tests.
- `checkout-surge/docs/runtime_topology.md:182` — smoke-load behavior and generated-run cleanup are documented.
- `checkout-surge/package.json:34` — root runtime scripts map to concrete scripts.
- `checkout-surge/docker-compose.yml:45` — API is a separate compose service.
- `checkout-surge/docker-compose.yml:241` — runtime setup service exists.
- `checkout-surge/scripts/runtime-smoke.mjs:21` — smoke check includes in-container k6 verification.

#### Verdict rationale

This is equivalent for documentation-to-artifact alignment. The functional depth of Surge's smoke and reset commands is weaker in C97 through C99, but the documentation accurately points at real scripts and the intended runtime topology.

### C109 — Access-surface and run-history documentation fidelity (worse)

#### Reference behavior

Forge's access-protection docs describe public-safe Run History reads, admin-only deletion, and privilege derivation from trusted proxy/session state plus a service-token boundary. Those claims align with the implementation: public detail uses a separate safe DTO, full operational detail is protected, public starts still pass through the trusted proxy/service-token channel, and destructive deletion requires admin auth plus confirmation.

**References:**
- `checkout-forge/docs/admin_access_protection.md:126` — Run History summaries and public-safe detail DTOs are public.
- `checkout-forge/docs/admin_access_protection.md:127` — Run History deletion is admin-only and confirmation-gated.
- `checkout-forge/docs/admin_access_protection.md:141` — principal derivation and service-token boundary are documented.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:281` — run-start route requires control access even when public starts are allowed.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:128` — public detail is built through a separate public DTO.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:180` — delete-all request validates the confirmation schema.

#### Compared behavior

Surge's docs make similarly strong access-surface claims, and some parts are true: Run History list/detail routes exist, deletion is service-token protected, and admin runtime-policy proxying is session gated. However, earlier consolidated findings show the docs overstate the trust-boundary reality. Public run starts can reach the API without the service token and can supply visitor identity through a normal header, and public Run History detail exposes row-level operational collections and identifiers beyond Forge's public-summary boundary.

**References:**
- `checkout-surge/docs/admin_access_protection.md:141` — implementation note documents service-token-bound privilege derivation and runtime policy.
- `checkout-surge/docs/admin_access_protection.md:143` — Run History implementation note covers public detail and admin delete-all confirmation.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:188` — missing operator mode defaults to public.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:195` — only admin mode checks the control service token.
- `checkout-surge/apps/api/src/routes/demo-run-routes.ts:208` — public visitor id is read from a normal request header.
- `checkout-surge/apps/api/src/services/run-history-service.ts:183` — public detail includes row-level order, ERP attempt, notification, and event collections.

#### Verdict rationale

This is worse because the documentation is too optimistic relative to the implementation. Surge documents the intended public/admin model, but C84, C85, and C88 show meaningful gaps in the public-start trust boundary and public history DTO boundary. The result is not just a functional security weakness; it is also a self-description mismatch.

### C110 — Honest scoping of deferred work (same)

#### Reference behavior

Forge explicitly marks production-style hold-expiry reconciliation, CI, hosted deployment, and the Go comparison track as outside the completed local demo. The docs separate the current local reference runtime from future hosted deployment and record the Go track as optional/open.

**References:**
- `checkout-forge/docs/redis_inventory_hot_path.md:69` — expired holds are tracked but not released/reconciled automatically.
- `checkout-forge/docs/automated_testing_infrastructure.md:194` — CI is not fully implemented yet.
- `checkout-forge/docs/runtime_topology.md:205` — runtime topology doc does not define hosted deployment packaging.
- `checkout-forge/working_docs/project_planning.md:694` — hosted deployment phase remains open.
- `checkout-forge/working_docs/project_planning.md:748` — optional Go benchmark track remains open.

#### Compared behavior

Surge is similarly explicit about deferred scope. README names hosted deployment readiness and Go comparison as later work, the planning file keeps Phase 11 and Phase 12 open, runtime topology separates local validation from hosted benchmark isolation, and Redis/domain docs keep automatic hold-expiry reconciliation out of the active demo model.

**References:**
- `checkout-surge/README.md:7` — hosted deployment and optional Go track remain later work.
- `checkout-surge/docs/redis_inventory_hot_path.md:28` — automatic hold-expiry reconciliation is out of scope.
- `checkout-surge/docs/runtime_topology.md:184` — local runs are not hosted benchmark runs.
- `checkout-surge/working_docs/project_planning.md:954` — hosted deployment phase remains open.
- `checkout-surge/working_docs/project_planning.md:1008` — optional Go benchmark track remains open.

#### Verdict rationale

Surge is equivalent for honest scoping of known deferred work. Its main documentation risk is the mixed target/current voice in C107, not silent claims that hosted deployment, Go benchmarking, or production hold-expiry reconciliation have shipped.

### C111 — Historical verification evidence (unknown)

#### Reference behavior

Forge's roadmap is living documentation, but it does not provide a complete external proof log for every completed task. Its README and docs expose commands that can be run, and the root manifest contains the expected scripts, so the baseline was evaluated here as documentation-to-artifact alignment rather than proof of historical command execution.

**References:**
- `checkout-forge/working_docs/project_planning.md:11` — roadmap is living documentation.
- `checkout-forge/package.json:31` — root test command exists.
- `checkout-forge/package.json:36` — root coverage command exists.
- `checkout-forge/docs/local_development.md:267` — coverage command is documented.

#### Compared behavior

Surge's roadmap is more assertive about verification. Phase 10.5 says relevant non-runtime checks, runtime smoke, and runtime smoke-load were run with no skipped checks. The corresponding scripts exist, but the inspected repo artifacts do not include machine-readable logs proving those executions, and local verification notes say commit verification was blocked by safe-directory ownership checks.

**References:**
- `checkout-surge/working_docs/project_planning.md:943` — final alignment verification task.
- `checkout-surge/working_docs/project_planning.md:948` — runtime smoke and load smoke claimed when Docker verification is available.
- `checkout-surge/working_docs/project_planning.md:949` — "None skipped" is claimed.
- `checkout-surge/package.json:20` — root test command chains unit, API, and integration lanes.
- `checkout-surge/package.json:37` — runtime smoke command exists.
- `checkout-surge/package.json:38` — runtime load smoke command exists.

#### Verdict rationale

This remains unknown. Surge makes stronger historical verification claims than Forge and has the scripts those claims reference, but the report corpus does not prove that the commands actually ran. Treat this as an evidence limitation rather than an implementation defect.

### C112 — CORS allow-list wiring across debug-exposed services (same)

#### Reference behavior

Forge treats `WEB_ORIGIN` as a cross-service browser allow-list. The API, mock ERP, and load orchestrator all parse it into their CORS configuration, so direct debug ports honor the same pinned dashboard origin the reference runtime uses. When the variable is unset, parsing intentionally falls back to wildcard behavior as the documented development default, and the compose runtime pins all three services to the proxy origin.

**References:**
- `checkout-forge/apps/api/src/server.ts:90` — API registers CORS from configured web origins.
- `checkout-forge/apps/api/src/config.ts:223` — unset `WEB_ORIGIN` parses to wildcard `true`.
- `checkout-forge/apps/mock-erp/src/server.ts:38` — mock ERP registers the same origin allow-list.
- `checkout-forge/apps/load-orchestrator/src/server.ts:241` — load orchestrator matches allowed origins manually.
- `checkout-forge/docker-compose.yml:54` — compose pins `WEB_ORIGIN` to the dashboard proxy origin (repeated for mock ERP and load orchestrator).

#### Compared behavior

Surge wires `WEB_ORIGIN` only into the API. Its CORS registration falls back to allow-all when the parsed origin list is empty, matching Forge's unset-variable behavior, and the compose runtime pins the variable to the proxy origin. The mock ERP and load orchestrator register no CORS plugin at all, so their direct debug ports emit no cross-origin headers — browsers cannot read their responses cross-origin, which is fail-closed rather than a gap. However, the local-development and architecture docs claim `WEB_ORIGIN` configures direct service debug CORS across services, which only the API actually consumes.

**References:**
- `checkout-surge/apps/api/src/server.ts:57` — API CORS falls back to allow-all when no origins are configured.
- `checkout-surge/apps/api/src/runtime/config.ts:53` — `WEB_ORIGIN` is parsed only by API runtime config.
- `checkout-surge/docker-compose.yml:13` — compose pins `WEB_ORIGIN` for the reference runtime.
- `checkout-surge/docs/local_development.md:374` — docs claim `WEB_ORIGIN` also drives direct service debug CORS.
- `checkout-surge/docs/architecture.md:27` — architecture doc repeats the multi-service debug CORS claim.

#### Verdict rationale

The effective browser-boundary posture is equivalent: both pin the API's CORS to the proxy origin in the reference runtime, and both degrade to wildcard when the variable is unset. Surge's internal services emitting no CORS headers is stricter, not weaker. The blemishes — a documented-vs-consumed `WEB_ORIGIN` drift in the same family as C40's unconsumed drain-timeout variable, and losing the baseline's pinned debug CORS on direct mock-ERP/load-orchestrator ports — are a documentation and developer-experience nuisance, not a security regression, so the grade stays same.

### C113 — API gateway graceful shutdown (same)

#### Reference behavior

Forge's API close path is guarded against re-entry, stops the finalization poller and the sold-out metric aggregator, and settles the realtime publisher, SSE gateway, notification queue admin, and Fastify server closes together, logging any rejected cleanup. Closing the Fastify server triggers an `onClose` hook that closes the queue publisher, disconnects Redis, and ends the PostgreSQL client. Signal handlers invoke the close function and set a failing exit code when shutdown itself errors.

**References:**
- `checkout-forge/apps/api/src/index.ts:239` — close function starts with a re-entry guard.
- `checkout-forge/apps/api/src/index.ts:246` — finalization poller and sold-out aggregator are stopped first.
- `checkout-forge/apps/api/src/index.ts:248` — realtime, SSE, queue-admin, and server closes settle together with warnings on failure.
- `checkout-forge/apps/api/src/server.ts:132` — Fastify `onClose` closes the queue publisher, Redis, and PostgreSQL.
- `checkout-forge/apps/api/src/index.ts:276` — signal handler reports shutdown failure via exit code.

#### Compared behavior

Surge memoizes a single close promise that stops the finalization poller and delegates to a dedicated resource-cleanup module. That module closes the server and event fanout first, then settles the dashboard subscriber, job publisher, queue inspector, queue maintenance, Redis, and database closes, aggregating every failure into one `AggregateError`. SIGTERM/SIGINT handlers await the close promise and exit with an explicit success or failure status, and the startup-failure path runs the same cleanup.

**References:**
- `checkout-surge/apps/api/src/index.ts:251` — memoized close stops the poller and delegates to the cleanup module.
- `checkout-surge/apps/api/src/runtime/api-resource-cleanup.ts:11` — cleanup closes the server first, then settles dependency closes.
- `checkout-surge/apps/api/src/runtime/api-resource-cleanup.ts:32` — cleanup failures aggregate into one reported error.
- `checkout-surge/apps/api/src/index.ts:316` — SIGTERM awaits close and exits with an explicit status.
- `checkout-surge/apps/api/src/index.ts:339` — startup failure runs the same cleanup path.

#### Verdict rationale

This completes the shutdown picture that C63 graded only for the worker. At the API tier both implementations stop background pollers, close realtime/queue/database resources, and report cleanup failures. Surge's explicit exit-code discipline and aggregated error reporting are marginally cleaner; Forge reaches the same resource set through `allSettled` plus the Fastify `onClose` hook. Unlike the worker comparison, neither side leaves a material gap, so this is same.

### C114 — Service-side liveness/readiness endpoint depth (better)

#### Reference behavior

Forge's API readiness endpoint genuinely probes PostgreSQL with a `select 1`, but its Redis check only reports whether a Redis URL is configured. The worker's readiness checks are configuration-presence checks for the database, Redis, and mock-ERP URLs plus BullMQ-worker-running flags and a circuit-breaker state signal — no live PostgreSQL, Redis, or queue connectivity probe runs at the worker. A service can therefore report ready while its infrastructure is unreachable.

**References:**
- `checkout-forge/apps/api/src/routes/health.ts:19` — API readiness endpoint.
- `checkout-forge/apps/api/src/routes/health.ts:23` — Redis readiness is a configuration-only check.
- `checkout-forge/apps/api/src/routes/health.ts:45` — database reachability is genuinely probed.
- `checkout-forge/apps/worker/src/index.ts:117` — worker readiness checks are URL-configured presence checks.
- `checkout-forge/apps/worker/src/index.ts:130` — breaker state is exposed as a readiness signal.
- `checkout-forge/apps/worker/src/index.ts:136` — worker-running checks complete the worker readiness set.

#### Compared behavior

Surge's readiness endpoints actively probe infrastructure. The API readiness check runs a PostgreSQL `SELECT 1`, pings Redis, and verifies order-process queue connectivity. The worker readiness check probes PostgreSQL and Redis, verifies both BullMQ consumers are running, and checks connectivity for both the order-process and notification-record queues, attaching failure messages per check.

**References:**
- `checkout-surge/apps/api/src/runtime/readiness.ts:20` — API readiness probes PostgreSQL.
- `checkout-surge/apps/api/src/runtime/readiness.ts:33` — API readiness pings Redis.
- `checkout-surge/apps/api/src/runtime/readiness.ts:46` — API readiness checks queue connectivity.
- `checkout-surge/apps/worker/src/runtime/readiness.ts:23` — worker readiness probes PostgreSQL.
- `checkout-surge/apps/worker/src/runtime/readiness.ts:36` — worker readiness pings Redis.
- `checkout-surge/apps/worker/src/runtime/readiness.ts:60` — worker readiness checks order-process queue connectivity.

#### Verdict rationale

This is distinct from C96, which graded the operational health *scripts*; here the endpoints those scripts and the compose healthchecks call are compared. Surge's readiness answers reflect real infrastructure reachability, while Forge's worker (and the API's Redis dependency) can claim readiness on configuration alone. Forge's breaker-state readiness signal is a useful operator extra that Surge's readiness lacks (Surge exposes breaker snapshots through other reads per C56), but that does not offset the shallower probes, so Surge is better.

### C115 — Structured logging conventions and hot-path log volume (same)

#### Reference behavior

Forge's shared logger package builds pino loggers with a service-name base binding, `LOG_LEVEL` environment control, ISO-8601 log timestamps matching the cross-service timestamp convention, and correlation-ID child helpers. The API hands that logger to Fastify without disabling request logging, so every buy request pays Fastify's default two info lines during a surge, while the reservation service itself stays quiet on the hot path, logging only dashboard-publish failures. No pino redaction is configured anywhere.

**References:**
- `checkout-forge/packages/logger/src/index.ts:57` — level comes from options or `LOG_LEVEL`.
- `checkout-forge/packages/logger/src/index.ts:62` — log lines use ISO timestamps.
- `checkout-forge/packages/logger/src/index.ts:70` — correlation child helper.
- `checkout-forge/apps/api/src/server.ts:86` — Fastify request logging is left enabled with the service logger.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:274` — the hot-path service logs only on publish failure.

#### Compared behavior

Surge's logger package follows the same pino-plus-service-binding pattern and adds contract-schema validation of the service name, correlation normalization on bound IDs, and a silent-logger helper for tests. It does not override pino's timestamp, so log lines carry epoch-millisecond timestamps rather than the ISO form. The API likewise leaves Fastify request logging enabled and keeps the buy service silent per request. Its queue-status service emits an info log on every status read, which is chattier but off the buy path. No redaction is configured either.

**References:**
- `checkout-surge/packages/logger/src/logger.ts:16` — service name is validated against the shared contract.
- `checkout-surge/packages/logger/src/logger.ts:21` — pino options carry no timestamp override (epoch default).
- `checkout-surge/packages/logger/src/logger.ts:32` — silent logger helper for tests.
- `checkout-surge/apps/api/src/server.ts:52` — Fastify request logging is left enabled with the service logger.
- `checkout-surge/apps/api/src/services/queue-status-service.ts:26` — every queue-status read emits an info log.

#### Verdict rationale

The logging systems are equivalent where it matters: same library, same service/correlation binding discipline, the same hot-path cost profile (both accept Fastify's default per-request logging at 10k RPS and keep service-level hot-path logging quiet), and the same absence of redaction. The differences cancel out — Forge's ISO log timestamps track the cross-service convention more literally, while Surge validates service names, ships a test-silent logger, and is slightly chattier on operator status reads.

### C116 — CSRF posture on state-changing dashboard proxy routes (same)

#### Reference behavior

Forge's mutating admin operations go through Next.js proxy routes that authorize solely from the signed `HttpOnly` admin session cookie issued with `SameSite=Lax`. There are no CSRF tokens and no origin/referer verification on those routes, so cross-site request protection rests entirely on the `SameSite=Lax` attribute preventing the cookie from accompanying cross-site POSTs.

**References:**
- `checkout-forge/apps/web/src/app/api/admin/session/route.ts:19` — session cookie is issued with `SameSite=Lax`.
- `checkout-forge/apps/web/src/app/api/control/demo/reset/route.ts:13` — mutating proxy authorizes from the session cookie alone.

#### Compared behavior

Surge has the same shape. Its `requireAdminSession` helper reads and verifies the signed session cookie, which is issued `HttpOnly` with `SameSite=Lax`, and the mutating admin proxy routes apply that gate before forwarding with the control token. No CSRF token or origin check exists on either side. The public run-start proxy requires no session at all, which makes CSRF moot for that route — its weakness is the missing trust boundary already graded in C84.

**References:**
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:39` — mutating admin proxies authorize via the session-cookie check.
- `checkout-surge/apps/web/src/app/lib/server/backend-proxy.ts:76` — session cookie is `HttpOnly` and `SameSite=Lax`.
- `checkout-surge/apps/web/src/app/api/admin/demo/reset/route.ts:11` — reset proxy applies the session gate before proxying.

#### Verdict rationale

Both implementations rely on `SameSite=Lax` as the sole cross-site defense for admin mutations — adequate against the classic cross-site POST vector, with no defense-in-depth token or origin verification on either side. The weaknesses unique to Surge (missing `Secure` cookie attribute, unauthenticated public start) are graded in C82 and C84 and do not change the CSRF-specific parity here.

### C117 — Dependency footprint and third-party hygiene (same)

#### Reference behavior

Forge's runtime dependency set across all workspaces resolves to 17 external packages, all mainstream and load-bearing: the shared infra core (fastify, `@fastify/cors`, bullmq, ioredis, postgres, drizzle-orm, zod, pino) plus a web UI layer built on radix-ui with lucide-react icons, sonner toasts, and the clsx/class-variance-authority/tailwind-merge styling utilities.

**References:**
- `checkout-forge/apps/web/package.json:5` — web dependency block carries the UI-layer packages.
- `checkout-forge/apps/web/package.json:11` — radix-ui provides the accessible component primitives.

#### Compared behavior

Surge resolves to 11 external runtime packages with the identical infra core and no third-party UI layer at all: the web app depends only on Next, React, and the workspace contracts package, hand-rolling all components.

**References:**
- `checkout-surge/apps/web/package.json:16` — web depends only on Next, React, and the contracts package.
- `checkout-surge/apps/api/package.json:14` — API dependency block mirrors Forge's infra core.

#### Verdict rationale

Both codebases are frugal and mainstream — no dead weight, no exotic or stale packages, and an identical infrastructure core. Surge is leaner by six packages, but the practical consequence of dropping the UI layer (hand-rolled components without radix's accessible primitives) is already graded under frontend decomposition and UX in C79 and C80 rather than double-counted here. As a hygiene judgment, neither side dominates.

## Appendix — Scope and caveats

- **Method.** All findings come from static inspection of both repositories; neither stack was executed for this report. Documented behaviors that only manifest at runtime (actual surge throughput, compose startup ordering in practice, k6 delivery fidelity) are graded from code and configuration, not observation. C111 records the resulting evidence limitation for historical verification claims.
- **Final gap-verification pass.** After C1–C111 were consolidated, a dedicated pass re-checked scope dimensions that had no matching topic. It produced C112–C117 and additionally confirmed parity in areas judged not to warrant their own sections: unhandled-error response sanitization (both APIs return a generic 500 payload and keep error detail in server logs), production Redis client construction (both use `lazyConnect` with bounded `maxRetriesPerRequest` at runtime call sites), explicit ARIA/role markup (absent from both frontends; accessibility rests on semantic HTML plus, in Forge, radix primitives — folded into C79/C80), and queue-status read projections including retrying-job detection (comparable on both sides — folded into C65/C66).
- **Areas not examined.** Node/pnpm engine pinning, license/legal hygiene, and Git history quality were out of scope. Dependency freshness was assessed only at the name/footprint level (C117), not against a vulnerability database.
- **Reference naming.** `checkout-surge/...` references throughout this report resolve to the compared implementation's repository (locally checked out as `checkout-surge-gpt`).
