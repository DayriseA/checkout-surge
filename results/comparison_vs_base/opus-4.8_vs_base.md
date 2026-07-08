# Consolidated Comparison Report — `checkout-surge-opus` vs `checkout-forge`

Consolidated comparison of `checkout-surge-opus` (compared implementation, built autonomously by Opus 4.8) against `checkout-forge` (reference baseline). This document is the standalone deduplicated comparison report following `comparison_report_format.md`. Topic codes `C{n}` are assigned sequentially in document order and are permanent; overlapping findings have been merged into single topics.

**Coverage:** domain model and contracts; durable persistence and data integrity; Redis inventory hot path; buy path and API request handling under surge; demo run lifecycle, presets, and control plane; asynchronous order pipeline and downstream resilience; realtime observability and dashboard read models; load generation and benchmark measurement; web dashboard frontend and UX surface; access protection, abuse control, and public-run governance; runtime topology, packaging, and operational tooling; testing strategy and engineering quality system; documentation fidelity and roadmap truthfulness.

| Code | Topic | Verdict |
| :-- | :-- | :-- |
| C1 | Contracts package organization & vocabulary single-sourcing | better |
| C2 | Lifecycle state vocabularies (reservation / order / run / traffic / attempt) | same |
| C3 | Entity model completeness & faithfulness (contracts & tables) | worse |
| C4 | Event, queue & metric naming conventions | same |
| C5 | Shared error shape & correlation-ID conventions | same |
| C6 | Buy-flow outcome contract | worse |
| C7 | Derived presentation vocabulary ("simulated purchase status") | missing |
| C8 | Realtime dashboard event contract | worse |
| C9 | Run configuration, preset & runtime-policy vocabulary | worse |
| C10 | Schema strictness & typing rigor | worse |
| C11 | Boundary validation discipline & contract drift | same |
| C12 | CHECK-constraint invariant enforcement | worse |
| C13 | Run↔offer ownership enforcement (nullable-`runId` edge case) | same |
| C14 | Single-active-run guarantee at the database level | better |
| C15 | Migration hygiene & tooling | better |
| C16 | Seed data & re-seed idempotency | same |
| C17 | Run-scoped cleanup & retention | same |
| C18 | Index fitness for read patterns | worse |
| C19 | JSONB column typing & write/read validation | same |
| C20 | Atomic reservation gate & race safety | same |
| C21 | Idempotency record content & replay crash-consistency | better |
| C22 | Idempotency conflict rule | same |
| C23 | Sold-out losing-path cost profile | same |
| C24 | Pending-persistence sentinel resilience under a real PostgreSQL outage | better |
| C25 | Pending-persistence reconciliation into durable history | better |
| C26 | Compensating reversal of holds rejected by durable persistence | better |
| C27 | Uninitialized-inventory behavior | same |
| C28 | TTL & hold-expiry edge handling | same |
| C29 | Keyspace cleanup & Redis hygiene | better |
| C30 | Idempotency-key input hygiene in the keyspace | worse |
| C31 | Terminal inventory snapshot into durable history | same |
| C32 | Inventory status projection & recent-events retention | same |
| C33 | Test coverage of the hot-path primitives | better |
| C34 | Run/sale eligibility gate on the buy path | same |
| C35 | Accepted-path sequencing & partial-failure handling | better |
| C36 | Sold-out dashboard pressure aggregation | same |
| C37 | Surge tuning & startup-validated API configuration | same |
| C38 | Order status lookup projection | worse |
| C39 | Run start orchestration & post-insert failure handling | better |
| C40 | Run provisioning: frozen snapshots & isolated inventory | same |
| C41 | Traffic completion vs business completion | same |
| C42 | Finalization settlement checks & drain-timeout semantics | worse |
| C43 | Exactly-one immutable terminal summary guarantee | worse |
| C44 | Startup/crash reconciliation | better |
| C45 | Late-traffic gating across lifecycle transitions | worse |
| C46 | Preset model & management flows | same |
| C47 | Admin reset & recovery workflow | worse |
| C48 | Traffic-delivery classification & unexpected-response enforcement | worse |
| C49 | Lifecycle decomposition & testability architecture | better |
| C50 | Queue topology, producer discipline & job hand-off | same |
| C51 | Order lifecycle transitions & ERP attempt-history fidelity | same |
| C52 | Run-scoped backpressure & retry-policy application | worse |
| C53 | Circuit breaker semantics & cooperation with queue retries | better |
| C54 | At-least-once discipline & idempotent consumption | better |
| C55 | Post-confirmation notification pipeline | better |
| C56 | Mock ERP simulation realism & chaos governance | better |
| C57 | Consistency-lag measurement | same |
| C58 | Worker runtime: readiness, shutdown & configuration | better |
| C59 | SSE endpoint, fan-out topology & backpressure policy | better |
| C60 | Authoritative recovery read & live-vs-history split | worse |
| C61 | Live delivery of run status & traffic metrics | worse |
| C62 | Queue status projection | same |
| C63 | ERP resilience projection & breaker visibility | better |
| C64 | API health & readiness endpoints | better |
| C65 | Traffic-mode to k6 execution mapping & VU sizing | same |
| C66 | Generated k6 script materialization & injection safety | same |
| C67 | Attempt identity: idempotency keys & correlation IDs | same |
| C68 | Load-orchestrator live metric aggregation under surge | better |
| C69 | Traffic-completion report delivery & accounting depth | worse |
| C70 | k6 summary parsing & run diagnostics | worse |
| C71 | Load-orchestrator process lifecycle control | worse |
| C72 | Run-start ordering & load-control topology | same |
| C73 | Load-orchestrator configuration & k6 packaging | same |
| C74 | Load-orchestrator test coverage | same |
| C75 | Browser recovery/realtime protocol correctness | same |
| C76 | Reconnect & connection-status UX | same |
| C77 | Live watch view: gold signals, frozen config & surge storytelling | worse |
| C78 | Public demo picker & bounded custom-run form | worse |
| C79 | Run history frontend: pagination, detail depth & traffic grading | worse |
| C80 | Admin console frontend control surface | same |
| C81 | BFF discipline & same-origin proxy mechanics | same |
| C82 | Frontend decomposition & testability architecture | better |
| C83 | Dashboard update cadence & render economy | same |
| C84 | Dashboard accessibility & states-of-the-world coverage | same |
| C85 | Admin session establishment & cookie mechanics | better |
| C86 | Service-token enforcement on admin-only mutating surfaces | same |
| C87 | Run-start endpoint protection & privilege derivation at the API | worse |
| C88 | Load-orchestrator service boundary (direct load starts) | worse |
| C89 | Server-issued public visitor identity | same |
| C90 | Public run-budget enforcement (windows, races, release) | worse |
| C91 | Layered configuration governance (hard caps ≥ policy ≥ run config) | same |
| C92 | Public-safe DTO & secret sanitization | same |
| C93 | Run-history deletion protection & delete-all confirmation | same |
| C94 | Mock ERP chaos-control authorization | same |
| C95 | Security-focused test coverage | same |
| C96 | Reference compose topology & service separation | same |
| C97 | Single-origin reverse proxy configuration & SSE routing | better |
| C98 | Service image construction & packaging | better |
| C99 | Runtime lifecycle separation: setup command, infra-only mode, no auto-start | same |
| C100 | Environment/config conventions across dev/container modes | better |
| C101 | Health check & read-only smoke tooling | same |
| C102 | Mutating dashboard-path load smoke & self-cleanup | better |
| C103 | Runtime reset tooling | same |
| C104 | Dev-container workflow | same |
| C105 | Test infrastructure isolation (compose mechanics) | same |
| C106 | Test taxonomy & root command contract | worse |
| C107 | Test infrastructure isolation & parallel safety | same |
| C108 | Database reset machinery, locking & destructive-op guards | same |
| C109 | Hard-property coverage & suite depth | better |
| C110 | Determinism & flake discipline | same |
| C111 | Testability architecture (dependency injection & factories) | same |
| C112 | Frontend testing approach | same |
| C113 | Repo-wide typing, lint & dependency hygiene | same |
| C114 | README accuracy vs shipped behavior | worse |
| C115 | Design-doc adaptation (living docs vs fossilized spec copies) | same |
| C116 | Stale Phase-9 snapshot claims in `runtime_topology.md` | worse |
| C117 | Roadmap completion truthfulness | same |
| C118 | Honest scoping: declared non-goals and deferrals | better |
| C119 | Delivery journaling and claim traceability | better |
| C120 | Setup instructions, commands, and documented defaults vs configured reality | same |
| C121 | Frontend TSX test discovery in standard commands | better |

---

## Domain model, shared vocabulary & contracts layer

### C1 — Contracts package organization & vocabulary single-sourcing (better)

#### Reference behavior

The baseline keeps one `@checkout-forge/contracts` package with twelve modules organized by flow (common, domain, buy-flow, demo-runs, dashboard, events, metrics, load, queue, resilience, erp), barrel-exported from a single index. The canonical enum values (reservation status, order status, event names, etc.) are declared as Zod enums in the contracts package, but the Drizzle schema in the `db` package re-declares the same literal values by hand in its `pgEnum` calls, so the contract vocabulary and the database vocabulary are two parallel copies kept in sync only by discipline (partially backstopped by hand-written CHECK constraints such as the known-event-name check on `order_events`). Some vocabularies never make it into a database enum at all — the run's traffic status is stored as free text.

**References:**
- `checkout-forge/packages/contracts/src/index.ts:1` — barrel export of the twelve flow modules.
- `checkout-forge/packages/contracts/src/domain.ts:12` — canonical reservation-status Zod enum in contracts.
- `checkout-forge/packages/db/src/schema.ts:45` — the same status values re-typed by hand into `pgEnum`.
- `checkout-forge/packages/db/src/schema.ts:390` — CHECK constraint re-listing known event names as a drift backstop.

#### Compared behavior

The compared implementation also ships one `@checkout-surge/contracts` package (fifteen modules organized by resource: enums, common, buy, inventory, queue, dashboard, erp, demo, load, preset-validation, recovery, run-history, health, consistency-lag). Its distinctive move is a dedicated `enums.ts` that exports every canonical vocabulary both as an `as const` value tuple *and* as the Zod enum built from it; the Drizzle schema imports those exact tuples into its `pgEnum` definitions (via an `enumValues(...)` helper), so the contract vocabulary and the database vocabulary are mechanically the same values rather than two copies. This coverage extends further into the schema than the baseline's: `traffic_execution_status` is a proper contract-derived pgEnum where the baseline stores free text. The package also carries a dedicated vocabulary test suite asserting the canonical status sets, dot-notation event naming, semantic/physical queue names, and reserved metric names.

**References:**
- `checkout-surge-opus/packages/contracts/src/enums.ts:11` — `RESERVATION_STATUSES` tuple exported alongside the Zod enum.
- `checkout-surge-opus/packages/contracts/src/index.ts:7` — barrel export of the fifteen resource modules.
- `checkout-surge-opus/packages/db/src/schema.ts:49` — all lifecycle enums derived from contract constants (`enumValues(...)`), including `traffic_execution_status`.
- `checkout-surge-opus/packages/contracts/test/unit/vocabulary.test.ts:18` — tests pinning the canonical vocabularies and naming rules.

#### Verdict rationale

Both implementations satisfy the spec's "one shared contracts package as single source of truth", and both layouts scale fine. The compared implementation is graded better on this narrow topic because its vocabulary single-sourcing is structural rather than disciplinary: the DB enums cannot drift from the contract enums because they are the same arrays, more of the vocabulary reaches native enums (typed `traffic_status` vs baseline free text), and a regression test pins the vocabulary. The baseline's duplicated literals are a real (if so-far unrealized) drift channel that it papers over with hand-written CHECK constraints. One demerit on the compared side: its contract files are saturated with roadmap-task references ("Task 8.4", "Phase 10") in doc comments, which is drift-prone self-description and is covered later in the documentation-fidelity findings rather than graded here.

---

### C2 — Lifecycle state vocabularies (reservation / order / run / traffic / attempt) (same)

#### Reference behavior

The baseline implements the spec's hard vocabulary split exactly: reservation `secured | rejected | released | expired`, order `queued | processing | confirmed | failed`, ERP attempt `succeeded | failed | timed_out`, API-owned run lifecycle `starting | active | draining | completed | failed`, orchestrator-owned traffic execution `starting | active | succeeded | failed`, and traffic delivery grades `complete | warning | degraded | failed`. Retry state is never a first-class order status; it surfaces as derived flags (`retrying`, `delayed`) on dashboard read models only.

**References:**
- `checkout-forge/packages/contracts/src/domain.ts:12` — reservation and order status enums.
- `checkout-forge/packages/contracts/src/load.ts:13` — run-lifecycle, traffic-execution and delivery-status enums.
- `checkout-forge/packages/contracts/src/dashboard.ts:62` — retry/delayed as derived booleans on a read model, not statuses.

#### Compared behavior

The compared implementation carries the identical five vocabularies, value-for-value, in `enums.ts`, with the reservation-vs-order distinction called out as deliberate. Retry pressure is likewise kept out of the canonical order status: it added `order.retrying` and `order.delayed` *event names* for live dashboard feedback, with explicit documentation (and code) that these are live-only signals that never change the persisted order status or write durable `order_events` rows.

**References:**
- `checkout-surge-opus/packages/contracts/src/enums.ts:11` — identical reservation/order status sets, "kept deliberately distinct".
- `checkout-surge-opus/packages/contracts/src/enums.ts:50` — identical run-lifecycle and traffic vocabularies.
- `checkout-surge-opus/packages/contracts/src/dashboard.ts:49` — `retrying`/`delayed` documented as live-only, never the canonical persisted status.

#### Verdict rationale

Exact match on every spec-mandated vocabulary, including the subtle requirement that retry state stays derived context. The compared implementation's extra `order.retrying`/`order.delayed` event names are an additive variation (judged as event naming in C4 and realtime semantics in C59-C64), not a vocabulary violation. No meaningful difference either way.

---

### C3 — Entity model completeness & faithfulness (contracts & tables) (worse)

*Merged topic: covers both the entity model as expressed in the shared contract language and its mapping onto PostgreSQL tables.*

#### Reference behavior

The baseline models the full sixteen-entity set as distinct schemas/tables — 15 tables plus contract-level entity schemas: Product, SaleOffer (with `purpose`), Reservation, Order, ErpAttempt, OrderEvent, DemoPreset, DemoRun (immutable JSONB config snapshot), the run↔offer ownership link (`demo_run_sale_contexts`), ReservationPendingPersistence, SimulatedNotification, a dedicated per-run reservation-outcome aggregate table (`demo_run_reservation_outcomes`, unique per `(runId, outcome)` with vocabulary checks), DemoRunFinalization, DemoRunSummary, and a PublicRuntimePolicy singleton whose persisted shape carries the public run *budget* (per-visitor/global window), the public-custom *defaults*, and the public-custom *limits* as one admin-editable policy document. The finalization record carries a rich set of typed JSONB diagnostic blocks (traffic delivery, timing breakdown, run diagnostics, API request lifecycle) alongside the immutable summary. Entity-level schemas (Product, Reservation, Order, ErpAttempt, OrderEvent) are part of the shared contract surface.

**References:**
- `checkout-forge/packages/db/src/schema.ts:429` — dedicated `demo_run_reservation_outcomes` aggregate table with unique `(runId, outcome)` and vocabulary checks.
- `checkout-forge/packages/db/src/schema.ts:493` — finalization row with five typed JSONB diagnostic summary columns.
- `checkout-forge/packages/db/src/schema.ts:523` — runtime-policy singleton table.
- `checkout-forge/packages/contracts/src/demo-runs.ts:381` — `publicRuntimePolicySchema` = budget + custom-run defaults + limits.
- `checkout-forge/packages/contracts/src/demo-runs.ts:335` — budget policy (per-visitor/global/window) inside the persisted policy.
- `checkout-forge/packages/contracts/src/domain.ts:50` — entity-level schemas (Product/SaleOffer/Reservation/Order/ErpAttempt/OrderEvent) in the shared contract surface.

#### Compared behavior

The compared implementation ships 14 tables covering almost the whole entity set with the intended responsibilities: Product, SaleOffer with `purpose`, DemoPreset, DemoRun with immutable `config_snapshot`, a 1:1 `demo_run_sale_context` ownership link (unique on both `runId` and `saleOfferId`), Reservation, Order (unique `reservationId`, satisfying "confirmed order traceable to exactly one reservation"), ErpAttempt (unique `(orderId, attemptNumber)`), OrderEvent, ReservationPendingPersistence (with the intentional non-FK `reservationId`, reasoning documented), SimulatedNotification, DemoRunFinalization, DemoRunSummary, PublicRuntimePolicy.

Two entities are reinterpreted:

1. The per-run reservation-outcome aggregate has no entity of its own. The `demo_run_reservation_outcomes` table originally existed but was dropped in migration 0003 as dead weight; the commit rationale states the sold-out aggregate already persists durably inside `demo_run_summaries.terminalInventorySnapshot` (JSONB, written at finalization), and the docs/entity list were updated to match.
2. PublicRuntimePolicy is reduced to a caps-only document (a reused `presetCapsSchema`), while the public run *budget* lives in environment configuration (`PUBLIC_RUN_BUDGET_*`) rather than in the persisted, admin-editable policy.

Additionally, migration 0004 slimmed `demo_run_finalizations` and `demo_run_summaries` by dropping the timing-breakdown, run-diagnostics, and request-lifecycle JSONB columns, so terminal records retain the HTTP summary, traffic delivery, business outcomes, and inventory snapshot but less diagnostic depth than the baseline. Entity-level schemas (Product, Reservation, Order rows, etc.) are not part of the contracts package at all — the Drizzle schema is the entity source and contracts carry only boundary/read-model shapes.

**References:**
- `checkout-surge-opus/packages/db/src/schema.ts:141` — 1:1 run↔offer ownership context with both uniques.
- `checkout-surge-opus/packages/db/drizzle/0003_salty_vision.sql:1` — drop of the reservation-outcomes table and enum, with rationale.
- `checkout-surge-opus/packages/db/drizzle/0004_even_doctor_strange.sql:1` — removal of the extra diagnostic JSONB columns from finalizations/summaries.
- `checkout-surge-opus/packages/contracts/src/run-history.ts:22` — sold-out aggregate folded into the terminal inventory snapshot.
- `checkout-surge-opus/packages/contracts/src/demo.ts:235` — `publicRuntimePolicySchema` is caps-only (`presetCapsSchema`).
- `checkout-surge-opus/apps/api/src/services/public-run-budget.ts:17` — budget limits injected from env config, not from the policy entity.
- `checkout-surge-opus/packages/db/src/schema.ts:286` — pending-persistence `reservationId` deliberately not an FK, with the reasoning documented.
- `checkout-surge-opus/packages/db/src/schema.ts:350` — `demo_run_summaries` absorbing the aggregate/inventory views as JSONB.

#### Verdict rationale

Fourteen of the sixteen entities are faithful, including the hard ones (ownership link done 1:1 with real uniques, pending-persistence, finalization kept separate from summary — the exact merge the spec warns against was avoided). The spec-mandated durability behavior is met on both sides: sold-out losers are never persisted per attempt and their run-scoped aggregate lands in durable history at finalization.

But the two reinterpretations are precisely the "merged or reinterpreted" pattern the spec flags. Folding the reservation-outcome aggregate into the summary snapshot still satisfies the letter of "aggregates copied in at finalization", yet it loses the standalone `(runId, outcome)` record with its own uniqueness guarantee, timestamps, and queryability (and makes mid-run aggregates a Redis-only fact) — a defensible consolidation (the table was write-only in practice, and the change was made deliberately through a documented migration) but still a reduction. Moving the budget out of PublicRuntimePolicy changes the entity's intended responsibility — in the baseline an admin can retune public budgets at runtime; in the compared build that requires a redeploy. The migration-0004 slimming likewise trades away diagnostic richness the baseline retains in terminal records.

Judged purely as a persistence layer, the compared build offsets these with stronger vocabulary typing (see C1) and misses no spec durability obligation — from that angle alone the grade would be `same`. But against the spec's full entity list and the entities' intended responsibilities, both reinterpretations are reductions of what the shared model can express, so the merged topic grades mildly worse. Budget enforcement and governance mechanics are judged in C90/C91; terminal-record content is judged in C43.

---

### C4 — Event, queue & metric naming conventions (same)

#### Reference behavior

The baseline defines lowercase dot-notation, domain-first business event names (`reservation.secured`, `erp.attempt.failed`, …), colon-separated semantic queue names (`orders:process`, `notifications:record`) with BullMQ-safe physical counterparts declared beside them, and the seven reserved metric names covering the four gold signals plus traffic latency/failure-rate.

**References:**
- `checkout-forge/packages/contracts/src/domain.ts:35` — canonical business event name enum.
- `checkout-forge/packages/contracts/src/queue.ts:12` — semantic + physical queue name pairs.
- `checkout-forge/packages/contracts/src/metrics.ts:10` — the seven reserved metric names.

#### Compared behavior

The compared implementation carries the same event names (plus the two additive live-only names `order.retrying` / `order.delayed`, still lowercase dot-notation domain-first), the same two queues expressed as explicit `{semantic, physical}` pairs, and the identical seven reserved metric names. The naming rules themselves are regression-tested (dot-notation shape, semantic/physical pairing, reserved metric list).

**References:**
- `checkout-surge-opus/packages/contracts/src/enums.ts:80` — event names, superset of the baseline's set, same convention.
- `checkout-surge-opus/packages/contracts/src/enums.ts:103` — `QUEUE_NAMES` semantic/physical map.
- `checkout-surge-opus/packages/contracts/src/enums.ts:109` — `METRIC_NAMES` matching the reserved set exactly.

#### Verdict rationale

Both implementations match every spec-mandated naming convention exactly; the compared one adds two convention-conforming event names and pins the rules with tests. One cosmetic variation: traffic mode identifiers differ (`buyer_spike`/`steady_arrival` vs the baseline's `buyer-spike`/`steady-arrival-rate`); the naming conventions in the spec govern events/queues/metrics, not these mode discriminants, so it is a legitimate open-detail choice. Graded same.

---

### C5 — Shared error shape & correlation-ID conventions (same)

#### Reference behavior

The baseline defines the mandated error payload (`code`, `message`, optional `details`, `correlationId`, `timestamp`) with `details` typed as a recursive JSON value, ISO-8601 timestamps with explicit offset, and a `correlationId` schema that trims and bounds length (1–128). Correlation IDs ride on every cross-boundary shape: buy responses, queue job payloads, ERP requests, read models, and three of the four realtime event types require one.

**References:**
- `checkout-forge/packages/contracts/src/common.ts:41` — `errorResponseSchema` with recursive-JSON `details`.
- `checkout-forge/packages/contracts/src/common.ts:10` — bounded, trimmed correlation-ID schema.
- `checkout-forge/packages/contracts/src/queue.ts:17` — correlation ID mandatory on queue job payloads.

#### Compared behavior

The compared implementation defines the same five-field error payload (with `details` as `z.record(z.unknown())`) and routes *every* API error — deliberate `ApiError`s, Fastify client errors, and unhandled 500s — through one boundary handler that builds that exact shape with a correlation ID and timestamp. Correlation IDs are mandatory on queue jobs and ERP confirmation requests and present on read models; the correlation-ID schema itself is only `z.string().min(1)` (no trim/upper bound). The realtime envelope makes `correlationId` optional.

**References:**
- `checkout-surge-opus/packages/contracts/src/common.ts:57` — `errorPayloadSchema` matching the mandated shape.
- `checkout-surge-opus/apps/api/src/runtime/errors.ts:52` — every error path (ApiError / 4xx / 500 / 404) funneled into the shared shape with a correlation ID.
- `checkout-surge-opus/packages/contracts/src/queue.ts:13` — correlation ID mandatory on job payloads.
- `checkout-surge-opus/packages/contracts/src/common.ts:10` — unbounded `correlationIdSchema`.

#### Verdict rationale

Both meet the spec: same payload shape, ISO-8601-with-offset timestamps, correlation IDs propagated across every service boundary. The compared build's centralized error handler that normalizes even framework and unhandled errors into the contract shape is a genuinely nice touch; the baseline's stricter correlation-ID bounds (max 128, trimmed) and recursive-JSON `details` are marginally tighter typing. These wash out — graded same, with the strictness theme continued in C10.

---

### C6 — Buy-flow outcome contract (worse)

#### Reference behavior

The baseline's buy response is a discriminated union of `reservation_secured` / `reservation_pending_persistence` / `reservation_rejected`, where the rejected variant carries a typed rejection-reason enum (`sold_out`, `sale_not_active`, `duplicate_request`, `invalid_quantity`) — so the "ineligible run/offer" outcome is a first-class typed response, not a generic error. The pending-persistence variant carries a structured `persistence` block with `retryAfterSeconds` guidance. Machine-readable outcome and rejection-reason response *headers* are part of the contract, letting the load generator classify outcomes with discarded response bodies.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:72` — three-variant discriminated buy response union.
- `checkout-forge/packages/contracts/src/domain.ts:14` — typed rejection-reason enum including `sale_not_active`.
- `checkout-forge/packages/contracts/src/buy-flow.ts:78` — outcome/rejection-reason header names in the contract.
- `checkout-forge/packages/contracts/src/buy-flow.ts:57` — pending-persistence `retryAfterSeconds` guidance.

#### Compared behavior

The compared buy response is a four-variant discriminated union: `reservation_secured`, `reservation_pending_persistence` (with `order: null` per spec), `sold_out`, and `idempotency_conflict`. Ineligible run/offer traffic is *not* part of the typed response union — it is thrown as a generic contract error payload with code `run_sale_closed` or a mismatch code, HTTP 409/400. There are no outcome headers in the contract: the k6 script classifies outcomes purely from HTTP status codes, where `sold_out` and `idempotency_conflict` share 409 and ineligibility is also a 409 error, so the transport cannot distinguish the losing outcomes without parsing bodies. The pending-persistence variant carries no retry-after guidance.

**References:**
- `checkout-surge-opus/packages/contracts/src/buy.ts:42` — four-variant buy response union (`order: null` on pending persistence).
- `checkout-surge-opus/apps/api/src/routes/buy-routes.ts:10` — `sold_out` and `idempotency_conflict` both mapped to 409; no outcome headers set.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:194` — ineligibility thrown as a generic `run_sale_closed` error payload, outside the union.
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-script.ts:120` — outcome classification from status codes (202/409) only.

#### Verdict rationale

The spec mandates distinct response outcomes for secured, pending-persistence, sold-out, idempotent replay, idempotency conflict, *and* ineligible run/offer. The compared build produces distinguishable responses for all of them (the error payload's `code` field is machine-readable), so this is not a gap — but the contract design is weaker: the ineligible outcome lives outside the typed union in a free-string error code, there is no rejection-reason vocabulary, and dropping the baseline's outcome headers means three different losing outcomes collapse into "a 409" at the transport level, which directly degrades what the load generator can measure (see C48). Losing `retryAfterSeconds` on pending persistence removes the spec-referenced retry guidance from the shared language. The two-phase semantics themselves (202 + `order: null`) are faithful; the taxonomy around them is thinner. Worse.

---

### C7 — Derived presentation vocabulary ("simulated purchase status") (missing)

#### Reference behavior

The baseline defines a `customerOrderStatus` presentation vocabulary (`sold_out`, `sale_not_active`, `reservation_secured`, `processing`, `confirmed`, `failed`, `reservation_expired`) as a first-class contract enum. Every buy response and the order-status lookup carry a `customerStatus` field *derived* at read time from reservation + order state (never persisted), and the order lookup additionally returns reservation state, a labeled event timeline, and per-order consistency lag — a full buyer-facing projection built from the internal vocabularies.

**References:**
- `checkout-forge/packages/contracts/src/domain.ts:25` — the derived presentation vocabulary as a contract enum.
- `checkout-forge/packages/contracts/src/buy-flow.ts:99` — order-status response with `customerStatus`, reservation state, timeline, lag.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:257` — derivation from live order state, not a stored column.

#### Compared behavior

The compared implementation has no counterpart vocabulary. The buy response's discriminant (`reservation_secured` / `sold_out` / …) partially plays the role at purchase time, but there is no unified simulated-purchase-status enum, and the order lookup returns only the raw internal order summary (id, public id, canonical status, queuedAt) with no derived customer status, no reservation context, and no timeline. On the positive side, nothing presentation-shaped is persisted anywhere — the "derived, not persisted" rule is trivially satisfied by absence.

**References:**
- `checkout-surge-opus/packages/contracts/src/buy.ts:29` — order summary limited to internal id/status/queuedAt.
- `checkout-surge-opus/apps/api/src/services/order-reader.ts:14` — order lookup returns the minimal internal projection only.
- `checkout-surge-opus/packages/contracts/src/enums.ts:11` — no presentation-status vocabulary anywhere in the enum module.

#### Verdict rationale

This is a baseline reference point rather than spec-mandated behavior, so its absence is a variation to judge on merits — but the merits favor the baseline: the presentation vocabulary is what lets a buyer-facing surface (and the demo narrative) express "reservation expired" or "sale not active" without leaking internal state machines, and the compared build's raw `queued/processing/confirmed/failed` lookup pushes that translation onto every consumer. Since there is no counterpart artifact at all, the verdict is missing rather than worse.

---

### C8 — Realtime dashboard event contract (worse)

#### Reference behavior

The baseline's realtime contract is a strict Zod discriminated union of exactly four event types (`order.status.updated`, `dashboard.metric.observed`, `business.event.recorded`, `load.run.updated`), each with a concrete, closed payload schema (metric events themselves constrained per metric name). The publisher validates the complete event against this union before writing to the shared Redis channel and swallows/logs publish failures so realtime can never block checkout or lifecycle work. The SSE gateway re-validates every inbound frame against the same union and drops malformed frames with a warning. A consumer that passes validation therefore has a payload whose full shape is contract-guaranteed.

**References:**
- `checkout-forge/packages/contracts/src/events.ts:51` — four-type discriminated union with closed payload schemas.
- `checkout-forge/packages/contracts/src/events.ts:10` — the closed event-type vocabulary.
- `checkout-forge/packages/contracts/src/metrics.ts:30` — per-metric payload refinements (literal units/dimensions).
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:24` — full-event validation before publish; failures logged, never thrown to callers.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` — inbound frames re-validated against the union and dropped when malformed.

#### Compared behavior

The compared implementation uses a single open envelope: `eventName` from the shared business-event enum, attribution fields (`occurredAt`, optional `correlationId`/`runId`/`saleOfferId`), and `payload: z.record(z.unknown())`. The envelope is validated on both publish and subscribe in one shared db-package helper, so channel name and wire encoding cannot drift between services and malformed frames are dropped with a report. Refined per-event payload shapes (`inventory.updated`, the order lifecycle events, `notification.recorded`) exist and are parsed by producers before wrapping the envelope, but consume-side validation only checks the envelope. A producer that skips its payload parse, or a payload schema that drifts, is not caught at the bus boundary the way the baseline's union catches it. Payload contents are non-secret, though Opus does expose internal `orderId`/`reservationId` UUIDs alongside public order ids on the public stream; that is identifier hygiene rather than a credential leak.

**References:**
- `checkout-surge-opus/packages/contracts/src/dashboard.ts:15` — open envelope with `z.record(z.unknown())` payload.
- `checkout-surge-opus/packages/db/src/dashboard-events.ts:28` — publish-side validation of the envelope.
- `checkout-surge-opus/packages/db/src/dashboard-events.ts:55` — consume-side validation and drop-on-invalid.
- `checkout-surge-opus/packages/contracts/src/dashboard.ts:76` — refined payload schemas enforced by producers, not by the subscriber.
- `checkout-surge-opus/apps/worker/src/adapters/redis-live-order-outcome-publisher.ts:53` — producer-side payload parse before publishing the envelope.

#### Verdict rationale

Both satisfy the spec's both-sides validation requirement at the envelope level, and Opus's shared publish/subscribe helper is a useful drift guard. The difference is validation depth: the baseline guarantees the full payload shape end-to-end via a discriminated union, while Opus guarantees only the wrapper end-to-end and relies on each producer remembering to validate its refined payload. The open-envelope extensibility argument is coherent, but the baseline shows a closed union covering the same product surface. Slightly weaker wire contract, so `worse`.

---

### C9 — Run configuration, preset & runtime-policy vocabulary (worse)

#### Reference behavior

The baseline's run configuration is four strict blocks (traffic / inventory / erp / backpressure) with cross-field `superRefine` rules (errorRate requires the matching failure mode, VU ordering, cap-aware traffic schema built per caps object). The backpressure block is complete per the spec's per-run knobs: concurrency, ERP timeout, breaker threshold/reset, and retry policy, plus a curated catalog of named backpressure strategies. The contract layer also carries UI control metadata and a policy schema that cross-validates its own defaults against its own limits at parse time.

**References:**
- `checkout-forge/packages/contracts/src/demo-runs.ts:326` — four-block strict run configuration.
- `checkout-forge/packages/contracts/src/demo-runs.ts:234` — full backpressure config (concurrency/timeout/breaker/retry).
- `checkout-forge/packages/contracts/src/demo-runs.ts:97` — caps-parameterized traffic schema factory with cross-field refinements.
- `checkout-forge/packages/contracts/src/demo-runs.ts:393` — policy schema self-validating defaults against limits.

#### Compared behavior

The compared implementation has the same four-block shape (`traffic`/`inventory`/`erp`/`backpressure`) but the backpressure block contains only an optional `workerConcurrency` — the run snapshot's vocabulary has no per-run ERP timeout, breaker thresholds, or retry policy (those are worker environment configuration). The ERP block cleverly reuses the chaos-controls schema so a run's frozen ERP behavior and the global knobs are one shape. Cap enforcement is factored into a separate dependency-free `preset-validation` module — a pure rule engine that collects *all* violations (rather than failing on the first) and a `capsExceedingCeiling` comparator keeping the DB-owned policy inside deployment hard caps; this is cleaner and more testable than the baseline's schema-embedded superRefines. There is no backpressure-strategy catalog and no control metadata in the contract layer.

**References:**
- `checkout-surge-opus/packages/contracts/src/demo.ts:29` — backpressure vocabulary reduced to optional `workerConcurrency`.
- `checkout-surge-opus/packages/contracts/src/demo.ts:25` — ERP block reusing the chaos-controls shape.
- `checkout-surge-opus/packages/contracts/src/preset-validation.ts:155` — pure cap validator collecting every violation.
- `checkout-surge-opus/packages/contracts/src/preset-validation.ts:182` — policy-vs-deployment-ceiling comparator.
- `checkout-surge-opus/apps/worker/src/services/run-concurrency-controller.ts:51` — only concurrency is resolved per run at runtime.

#### Verdict rationale

The decomposition is arguably better than the baseline's (a pure, exhaustively-reporting validator beats superRefine spaghetti, and unifying run-ERP behavior with chaos controls removes a shape duplication the baseline carries). But the spec explicitly expects the run snapshot's backpressure config to cover concurrency, timeout, breaker thresholds, and retry policy, and the compared vocabulary simply cannot express three of those four per run — a spec-level gap in the shared language whose behavioral consequences land in C52. Losing the strategy catalog and self-validating policy defaults also shrinks what the vocabulary can say. The gap outweighs the cleaner engineering: worse.

---

### C10 — Schema strictness & typing rigor (worse)

#### Reference behavior

The baseline leans hard on strict typing: 59 `.strict()` object schemas (unknown keys rejected) across demo-runs, load and dashboard modules; discriminated unions for every multi-outcome shape; literal-typed units and dimensions on metric schemas; bounded strings (correlation ID and idempotency key capped at 128, preset slugs regex-bound); a recursive `JsonValue` type for JSON payloads; and numeric range constraints throughout (finite floats, 0–1 rates, HTTP status 100–599).

**References:**
- `checkout-forge/packages/contracts/src/demo-runs.ts:39` — representative `.strict()` usage (33 in this file alone).
- `checkout-forge/packages/contracts/src/common.ts:10` — bounded correlation-ID / run-ID primitives.
- `checkout-forge/packages/contracts/src/metrics.ts:30` — literal-constrained metric payloads.

#### Compared behavior

The compared contracts use zero `.strict()` — every object schema silently strips unknown keys. Discriminated unions are used where they matter (buy response, traffic config, recovery resources), numeric constraints are comparable (int/positive/0–1 rates), and IDs are more consistently typed (run IDs are UUIDs everywhere vs the baseline's `string ≤128`). But free-string fields are looser: correlation ID and idempotency key are unbounded `min(1)` strings, event payloads and error `details` are `z.record(z.unknown())`, and `order_events.eventName` in the DB is plain text with no CHECK (the baseline constrains it — see C12).

**References:**
- `checkout-surge-opus/packages/contracts/src/buy.ts:13` — unbounded idempotency-key string.
- `checkout-surge-opus/packages/contracts/src/common.ts:10` — unbounded correlation ID.
- `checkout-surge-opus/packages/contracts/src/dashboard.ts:21` — `z.record(z.unknown())` payloads.
- `checkout-surge-opus/packages/db/src/schema.ts:265` — event name stored as unconstrained text.

#### Verdict rationale

Schema strictness is a differentiating dimension, and the direction is consistent: the baseline rejects unknown keys on ~60 shapes and bounds its strings; the compared build strips-and-accepts everywhere and leaves hot-path strings (idempotency keys hitting Redis at 10k RPS) unbounded — the keyspace consequence of that unbounded key is graded separately in C30. UUID-typed run IDs are a genuine point in the compared build's favor, and neither implementation uses branded types. On balance the compared contracts are meaningfully more permissive at the boundaries the contracts exist to police: worse.

---

### C11 — Boundary validation discipline & contract drift (same)

#### Reference behavior

Every baseline service consumes the shared package and validates at its boundaries: 43 contract-importing files and ~94 schema-parse sites in the API alone, 23 in the load orchestrator, 43 in the web app (whose BFF re-validates upstream responses against contracts before serving the browser), and both ends of the realtime channel.

**References:**
- `checkout-forge/packages/contracts/src/index.ts:1` — single shared surface all five apps import.
- `checkout-forge/packages/contracts/src/events.ts:51` — the union validated at publish and consume.

#### Compared behavior

The compared implementation shows the same discipline: contracts are imported across all five apps (44 files in the API, 26 in web), request bodies are `safeParse`d at routes, the orchestrator validates the accepted snapshot at its ingress, the pub/sub helper validates both directions, and the web tier re-validates API responses against contract schemas (readiness, run views, caps, error payloads) rather than trusting the proxy. Read paths map DB rows into contract-typed projections (e.g. `OrderReader` returns a contract `OrderSummary`) instead of re-declaring local shapes; no drifted duplicate shapes were found.

**References:**
- `checkout-surge-opus/apps/api/src/routes/buy-routes.ts:26` — route-level contract validation.
- `checkout-surge-opus/apps/load-orchestrator/src/routes/load-routes.ts:27` — orchestrator ingress validating the shared snapshot schema.
- `checkout-surge-opus/apps/web/src/lib/api.ts:148` — web tier re-validating API responses against contract schemas.
- `checkout-surge-opus/packages/db/src/dashboard-events.ts:28` — shared publish/subscribe helper enforcing validation for every producer/consumer.

#### Verdict rationale

Both implementations genuinely use the shared contracts at service boundaries rather than re-declaring local shapes; neither shows contract drift between services. The baseline has more raw parse sites, but that tracks its larger contract surface rather than better discipline — the compared build even centralizes the realtime validation so individual producers cannot skip it. Same.

---

## Durable persistence & data integrity

### C12 — CHECK-constraint invariant enforcement (worse)

#### Reference behavior

The baseline pushes a substantial amount of invariant enforcement into PostgreSQL itself: 22 CHECK constraints across the schema. These cover positive quantities and non-negative stock/counters, sale-window validity, lifecycle timestamp coupling (a `confirmed` order must have `confirmedAt`, terminal timestamps must not precede `queuedAt`, ERP attempts must finish at-or-after start), event-name vocabulary on `order_events` (generated from the contracts enum), preset visibility/editability rules, summary terminal-status, and the runtime-policy singleton (`id = 'active'`). Dedicated integration suites prove these constraints reject bad writes.

**References:**
- `checkout-forge/packages/db/src/schema.ts:271` — order lifecycle timestamp CHECK block (confirmed/failed/processing/ordering).
- `checkout-forge/packages/db/src/schema.ts:389` — `order_events` event-name CHECK generated from the contract enum.
- `checkout-forge/packages/db/src/schema.ts:531` — runtime-policy singleton CHECK.
- `checkout-forge/packages/db/src/schema.ts:137` — preset visibility/editability CHECKs.
- `checkout-forge/packages/db/test/lifecycle-timestamp-invariants.integration.test.ts:114` — integration tests proving the timestamp CHECKs fire.
- `checkout-forge/packages/db/test/vocabulary-constraints.integration.test.ts:40` — tests proving event-vocabulary and summary-status CHECKs fire.

#### Compared behavior

The compared schema contains zero CHECK constraints (confirmed by grepping the generated migrations). Quantity positivity, stock non-negativity, timestamp/lifecycle coupling, event-name vocabulary, preset editability rules, and the policy singleton are all enforced only in application code or not at all. Concretely: nothing prevents a second `public_runtime_policy` row with a different id (the `'active'` id is only a column default), a `confirmed` order with a NULL `confirmedAt`, an `order_events` row with an invented event name (the column is plain text), or a `demo_run_summaries` row with a non-terminal status (its status column reuses the full run-status enum, which includes `starting`/`active`/`draining`). It does compensate partially with stronger enum typing (see C1) and unique constraints equivalent to the baseline's (one summary/finalization per run, one order per reservation, unique attempt numbers), but a buggy or bypassing write that violates lifecycle or vocabulary invariants is accepted silently.

**References:**
- `checkout-surge-opus/packages/db/drizzle/0000_past_red_wolf.sql:1` — initial migration; contains no CHECK constraint anywhere (grep count 0 vs 22 in the baseline's initial migration).
- `checkout-surge-opus/packages/db/src/schema.ts:369` — policy table: `'active'` is only a default, no singleton CHECK.
- `checkout-surge-opus/packages/db/src/schema.ts:350` — summaries reuse the full `demo_run_status` enum (non-terminal statuses accepted) and allow NULL `businessOutcomeSummary`/`httpSummary`.
- `checkout-surge-opus/packages/db/src/schema.ts:265` — `order_events.eventName` is unconstrained text.

#### Verdict rationale

This is the persistence-layer headline question — "how much integrity lives in the database vs only in application code" — and the answer diverges sharply: 22 database-enforced invariants with test coverage versus none. The compared implementation's contract-derived enums narrow some value domains, but the cross-column invariants the baseline enforces (timestamp coupling, terminal-status-only summaries, singleton policy, event vocabulary) have no database backstop, so an application bug corrupts durable history undetected. Clear grade: worse.

---

### C13 — Run↔offer ownership enforcement and the nullable-`runId` edge case (same)

#### Reference behavior

The baseline enforces generated-offer ownership at two layers: composite `(runId, saleOfferId)` foreign keys to the sale-context table on every run-attributed table, plus hand-authored PL/pgSQL triggers as a last line of defense — explicitly because `MATCH SIMPLE` skips composite-FK checking whenever `runId` is NULL, so a generated-offer row written with a missing or mismatched run id would otherwise slip through. A second trigger restricts the sale context itself to `generated_run`-purpose offers. Triggers fire on `INSERT OR UPDATE OF run_id, sale_offer_id`.

**References:**
- `checkout-forge/packages/db/src/schema.ts:220` — composite FK from reservations to the sale context (repeated on orders, events, pending persistence, notifications).
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:26` — `enforce_run_owned_sale_offer_attribution` trigger function, applied to all five run-attributed tables.
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:1` — offer-purpose trigger on the sale context.

#### Compared behavior

The compared implementation independently arrived at the identical two-layer design: the same composite FKs (via a shared `runOwnershipForeignKey` helper), the same pair of hand-authored trigger functions on the same tables, and — notably — an explicit comment in both the schema and the migration explaining the `MATCH SIMPLE` NULL-skip gap and warning that the trigger migration is invisible to drizzle-kit introspection and must survive squashes. It additionally covers the trigger behavior with direct database-level integration tests (catalog offer rejected from the sale context; NULL/mismatched `run_id` rejected on a generated-offer reservation; correct attribution accepted). Two minor mechanical differences: its triggers fire on every `INSERT OR UPDATE` rather than only on updates of the relevant columns (slightly more trigger executions on unrelated updates), and its sale context uses a composite primary key with per-column uniques versus the baseline's single-column PK plus uniques — functionally equivalent 1:1 enforcement.

**References:**
- `checkout-surge-opus/packages/db/src/schema.ts:160` — `MATCH SIMPLE` gap documented; shared composite-FK helper.
- `checkout-surge-opus/packages/db/drizzle/0001_run_ownership_triggers.sql:27` — attribution trigger function applied to all five run-attributed tables.
- `checkout-surge-opus/packages/db/src/schema.ts:141` — sale context composite PK + uniques keeping run↔offer 1:1.
- `checkout-surge-opus/packages/db/test/integration/schema.test.ts:159` — direct integration tests of both triggers, including the NULL-`run_id` case.

#### Verdict rationale

The ownership check asks whether the implementation noticed the nullable-`runId` edge at all — the compared implementation not only noticed it but documented it and reproduced the baseline's full defense-in-depth (FKs + triggers on all five tables), and it tests the triggers at the database layer where the baseline's db package tests do not exercise them directly. The baseline's column-scoped trigger firing is marginally more efficient. Substantively identical protection: same. (Note: the ownership trigger's rejection of a mismatched write is also what the compared build's compensating-reversal path handles — see C26.)

---

### C14 — Single-active-run guarantee at the database level (better)

#### Reference behavior

The baseline's "only one run may be active-or-draining at a time" rule is race-safe in the normal start workflow, but the guarantee is procedural: the repository takes a transaction-scoped advisory lock on a hard-coded key and then checks for any `starting`/`active`/`draining` run before inserting. The database schema itself carries no declarative constraint preventing two non-terminal `demo_runs` rows, so any writer that bypasses that one locked repository method can violate the invariant without PostgreSQL rejecting it.

**References:**
- `checkout-forge/packages/db/src/schema.ts:148` — `demo_runs` table: status enum and plain status index, no partial unique constraint on non-terminal statuses.
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:1` — no partial/predicate index anywhere in the migration history (grep for `WHERE` finds none).
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:36` — advisory-lock + check-then-insert transaction enforcing the start workflow.

#### Compared behavior

The compared implementation added a hand-authored partial unique index over the constant expression `(status IN ('starting','active','draining'))` restricted to non-terminal rows, making PostgreSQL the race-safe authority: two concurrent starts collide on the index and the loser gets a unique violation the API maps to a 409. The migration comment records precisely why it exists — it replaced a read-then-create overlap check that two concurrent starts could both pass — and warns it will not round-trip through drizzle-kit regeneration.

**References:**
- `checkout-surge-opus/packages/db/drizzle/0002_single_non_terminal_run.sql:14` — partial unique index enforcing at most one non-terminal run.
- `checkout-surge-opus/packages/db/drizzle/0002_single_non_terminal_run.sql:1` — rationale comment: replaces a racy read-then-create check.

#### Verdict rationale

This is a spec-mandated invariant ("only one run may be active-or-draining at a time") that the baseline holds only when callers follow the intended repository path and advisory-lock convention. That is enough for ordinary API starts, but it is not a database invariant. The compared implementation moved the guarantee into PostgreSQL with a correct, well-documented partial unique index, so even an accidental alternate writer collides with the constraint. Better.

---

### C15 — Migration hygiene & tooling (better)

#### Reference behavior

The baseline ships two migrations: one large squashed initial schema plus the hand-authored trigger migration, both registered in the drizzle journal. Migrations are applied via the `drizzle-kit migrate` CLI in dev, while the test path uses a separate custom mechanism: the testing helper rebuilds the schema by replaying the SQL files itself, with a journal-comparison and schema-fingerprint check that truncates when current and rebuilds only on drift. The fragility of the hand-authored trigger SQL under squashes is a known, documented risk.

**References:**
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:1` — single squashed initial schema (all 15 tables in one migration).
- `checkout-forge/packages/db/package.json:22` — `db:migrate` delegates to the drizzle-kit CLI.
- `checkout-forge/packages/db/src/testing.ts:93` — test reset path with journal + schema-fingerprint checks, replaying migrations itself.

#### Compared behavior

The compared implementation keeps a genuine incremental history — five migrations including the initial schema, both hand-authored invariant migrations, and two later refactors (table drop, column slimming — see C3) each generated through the journal rather than by resetting it. It also ships a programmatic migrator wrapping drizzle-orm's `migrate()` that creates the target database if absent; the same code path is used by the deploy/CLI entry point and by the test-database reset, so tests exercise exactly the migration path production uses (including the hand-authored trigger migration, because it is journal-registered). Both hand-authored migrations carry explicit preserve-on-squash warnings, mirrored in a schema-file comment. The test reset is simpler than the baseline's (table-presence check, rebuild on mismatch) but self-healing in the same way.

**References:**
- `checkout-surge-opus/packages/db/drizzle/meta/_journal.json:1` — five-entry incremental journal including refactor migrations.
- `checkout-surge-opus/packages/db/src/migrator.ts:17` — programmatic `applyMigrations` shared by deployment CLI and test reset, with ensure-database-exists.
- `checkout-surge-opus/packages/db/src/schema.ts:34` — schema-level warning that the trigger migration must survive regeneration/squashes.
- `checkout-surge-opus/packages/db/src/testing/index.ts:121` — test reset applies the real migration journal, truncates when current, rebuilds on drift.

#### Verdict rationale

On the migration-hygiene dimensions — incremental history vs squashed schema, survival of hand-authored SQL, and a coherent application story — the compared implementation is ahead: it evolved its schema through the journal (the two refactor migrations prove the incremental workflow actually worked), and one programmatic migrator serves deploy and tests alike, removing the baseline's split between CLI-driven dev migration and a bespoke test-side SQL replayer. The baseline's schema-fingerprint truncate-vs-rebuild optimization is more sophisticated for test cost, but that is a test-infrastructure nicety rather than migration hygiene. Better.

---

### C16 — Seed data & re-seed idempotency (same)

#### Reference behavior

The baseline seeds the demo product, a baseline catalog sale offer (500 stock, explicit sale window), a seed inventory event, the durable presets, and the runtime-policy singleton. Its conflict strategy is refresh-oriented: `onConflictDoUpdate` restores canonical values on re-seed, and the Redis inventory counters for the seeded offer are unconditionally reset to full stock. Preset seeding supports modes (insert-missing by default), and the policy seed is insert-if-absent so operator edits survive.

**References:**
- `checkout-forge/packages/db/src/seed.ts:51` — `onConflictDoUpdate` refresh semantics for product and offer.
- `checkout-forge/packages/db/src/seed.ts:125` — unconditional Redis inventory reset to full stock on every seed.
- `checkout-forge/packages/db/src/public-runtime-policy.ts:49` — `seedPublicRuntimePolicy` keeps an existing policy untouched.

#### Compared behavior

The compared seed covers the same baseline set (deterministic-id product, catalog offer at 100 stock, presets, public-custom base, runtime policy) with preserve-oriented semantics: every insert is `onConflictDoNothing`, and Redis inventory is initialized only when absent — a comment explains this keeps a partially consumed catalog offer consistent instead of re-baselining Redis to full while durable reservations remain (the same guarded-init primitive noted in C29). Idempotency is proven by dedicated integration tests, including a test that re-seeding leaves consumed live counters untouched. Differences: no seed inventory event row (the baseline records one), and the seeded offer's sale window columns are nullable/unset rather than an explicit active window.

**References:**
- `checkout-surge-opus/packages/db/src/seed.ts:48` — guarded Redis init matching the durable rows' do-nothing semantics, with rationale.
- `checkout-surge-opus/packages/db/src/presets.ts:236` — presets and policy seeded `onConflictDoNothing`, documented as idempotent.
- `checkout-surge-opus/packages/db/test/integration/schema.test.ts:113` — explicit repeated-seed idempotency test.
- `checkout-surge-opus/packages/db/test/integration/schema.test.ts:124` — re-seed preserves consumed live inventory.

#### Verdict rationale

Both are idempotent and neither corrupts nor duplicates baseline data on re-seed — the core seed-data question. They embody opposite philosophies: the baseline's refresh semantics guarantee a canonical baseline after re-seed (at the cost of silently resetting live Redis counters out from under existing durable reservations — arguably the less consistent behavior the compared implementation's comment calls out); the compared preserve semantics never fight the operator but also never repair a drifted baseline row. The compared side tests its idempotency directly; the baseline records a seed inventory event the compared side omits. Honors roughly even: same.

---

### C17 — Run-scoped cleanup & retention (same)

#### Reference behavior

The baseline's cleanup deletes old generated-run state in a single transaction in child-before-parent order across the full run-attributed graph (events, notifications, ERP attempts, pending persistence, orders, reservations, summaries, outcome aggregates, finalizations, sale context, run row, then the generated offers), always preserving runs in non-terminal statuses and a keep-latest window defaulting to 15. It also exposes an explicit-ids variant, and returns a structured result of deleted/preserved runs.

**References:**
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:71` — full-graph transactional delete, child-before-parent.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:47` — active-run preservation guard.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:19` — default keep-latest 15.

#### Compared behavior

The compared implementation delivers the equivalent contract: transactional child-before-parent deletion over the same graph (ERP attempts resolved via order ids rather than the nullable `runId` — a slightly more robust key), non-terminal runs always preserved, keep-latest defaulting to 15, and a structured result. It adds two things the baseline's db package keeps elsewhere or lacks: a by-id cleanup that bypasses the guards for the mutating smoke check's self-cleanup, and an integrated `clearRunLiveState` helper that retires the run's ephemeral Redis namespace (inventory keys, outcome aggregate, traffic metrics, eligibility record) without touching durable history — with explicit comments separating live-state clearing from the durable record. Minor difference: it orders the keep-latest window by `createdAt` versus the baseline's `startedAt`; both are consistent recency orderings.

**References:**
- `checkout-surge-opus/packages/db/src/run-cleanup.ts:37` — shared transactional delete body, ERP attempts keyed by order id.
- `checkout-surge-opus/packages/db/src/run-cleanup.ts:122` — maintenance GC preserving non-terminal runs and latest-N (default 15).
- `checkout-surge-opus/packages/db/src/run-cleanup.ts:86` — Redis live-state clearing kept separate from durable rows.
- `checkout-surge-opus/packages/db/src/run-cleanup.ts:184` — by-id cleanup for the smoke run's self-cleanup.

#### Verdict rationale

Both satisfy the cleanup criteria: full-graph cascade correctness, active-run protection, configurable latest-N retention at the same default, and history preserved outside the retention window. The compared version integrates Redis live-state retirement and a smoke-cleanup path into the same module and keys ERP-attempt deletion more robustly; the baseline's equivalent Redis handling lives in its ops tooling rather than being absent. No behavioral gap on either side: same. (Redis-side namespace deletion mechanics are graded in C29.)

---

### C18 — Index fitness for read patterns (worse)

#### Reference behavior

The baseline's indexes are shaped for its actual read patterns, particularly run-scoped pagination: composite indexes `(run_id, occurred_at, id)` on order events, `(run_id, queued_at, id)` on orders, `(run_id, started_at, attempt_number)` on ERP attempts, `(run_id, secured_at, id)` on pending persistence, `(run_id, recorded_at, id)` on notifications, and a descending `(captured_at, id)` index on summaries for newest-first run-history listing — 27 indexes in the initial migration.

**References:**
- `checkout-forge/packages/db/src/schema.ts:264` — orders composite run-pagination index.
- `checkout-forge/packages/db/src/schema.ts:383` — order events `(run_id, occurred_at, id)` index.
- `checkout-forge/packages/db/src/schema.ts:488` — summaries descending `(captured_at, id)` history index.
- `checkout-forge/packages/db/src/schema.ts:311` — ERP attempts `(run_id, started_at, attempt_number)` index.

#### Compared behavior

The compared schema carries 11 mostly single-column indexes (`run_id`, `status`, `order_id`, `sale_offer_id`, `correlation_id` on selected tables) plus the uniques. There is no composite run+time index anywhere, no index at all on `erp_attempts` beyond the `(order_id, attempt_number)` unique, and no `captured_at` ordering index on summaries for history listing. Run-scoped timeline or paginated reads therefore filter on a single-column `run_id` index and sort in memory; ERP-attempt reads by run have no supporting index.

**References:**
- `checkout-surge-opus/packages/db/src/schema.ts:192` — reservations: three single-column indexes, no composite.
- `checkout-surge-opus/packages/db/src/schema.ts:251` — `erp_attempts` has only the order/attempt unique, no run or time index.
- `checkout-surge-opus/packages/db/src/schema.ts:350` — summaries: no `captured_at` index for newest-first history reads.

#### Verdict rationale

Index choices should be judged against the actual read patterns: run-scoped queries, history pagination, and event-timeline reads. The baseline designed composite indexes precisely for those; the compared implementation covers the filter columns but not the sort/pagination shape. At demo data volumes (runs capped by a retention window of 15) the practical impact is small — single-run row counts stay in the low tens of thousands and Postgres will sort them cheaply — but as schema fitness for the declared access patterns it is measurably thinner, including one table (ERP attempts) with no run-scoped index at all. Worse, with the nuance that this is a latent rather than felt cost at this system's scale.

---

### C19 — JSONB column typing & write/read validation (same)

*Covers what is structured vs dumped into JSONB, and whether JSONB payloads are schema-validated on write.*

#### Reference behavior

Both implementations put the same things in JSONB: preset config blocks, the run config snapshot, summary/finalization blocks, event payloads, and the runtime policy. The baseline types every JSONB column at compile time with the corresponding contract type (`.$type<DemoRunConfiguration>()` etc.), so write sites are statically checked against the contracts package, and it Zod-parses the runtime policy on write before persisting. Read-side validation is left to consumers.

**References:**
- `checkout-forge/packages/db/src/schema.ts:126` — preset JSONB columns typed with contract types.
- `checkout-forge/packages/db/src/schema.ts:466` — summary JSONB blocks typed with contract types.
- `checkout-forge/packages/db/src/public-runtime-policy.ts:27` — policy Zod-parsed before write.

#### Compared behavior

The compared schema types all JSONB columns as a generic `Record<string, unknown>`, deliberately keeping the db package free of deep contract types, and instead validates at the read boundary: every preset row is reassembled and Zod-parsed through a single `mapDemoPresetRow` before any caller sees it, and the runtime policy is Zod-parsed on every read and on the update's returning row. So a drifted or hand-edited JSONB payload is caught loudly at read time rather than prevented at write time; conversely, a buggy write is not stopped by the type system the way the baseline's `$type` annotations stop it.

**References:**
- `checkout-surge-opus/packages/db/src/schema.ts:45` — generic `Json` type for all JSONB columns.
- `checkout-surge-opus/packages/db/src/preset-store.ts:23` — centralized Zod parse of every preset row on read.
- `checkout-surge-opus/packages/db/src/runtime-policy.ts:22` — policy Zod-parsed on read and on update returning.

#### Verdict rationale

Neither implementation schema-validates all JSONB at the database write boundary; each picked one half of the protection. The baseline's compile-time contract typing prevents a class of type-mismatched writes but trusts whatever is stored; the compared runtime parse-on-read guarantees no consumer ever operates on a malformed payload but only after it was durably written. For data integrity, write-side prevention is marginally preferable, but the compared read-side parsing is systematic (every preset/policy read) where the baseline's write-side parse covers only the policy. These offset: same. (The terminal inventory snapshot is a notable exception on the compared side — it *is* schema-validated on write; see C31.)

---

## Redis inventory hot path (atomicity & idempotency core)

Both implementations centralize the hot-path primitives in `packages/db` (baseline: `redis-inventory.ts`; compared: `reserve-stock.ts` + `inventory.ts` + `redis-keys.ts`) and orchestrate them from an API-side `ReserveOrderService`. API orchestration is judged in C34-C36; these topics cover the primitives' correctness, the keyspace, and the idempotency/pending-persistence core, including the API-side pieces that define the idempotency record's lifecycle and the pending sentinel's semantics.

### C20 — Atomic reservation gate & race safety (same)

#### Reference behavior

The baseline makes the entire accept-path decision in one Lua script: idempotency lookup first, then stock check, then decrement/increment of the counters hash, hold record write, expiration-ZSET entry, capped inventory event, and an atomically stored pending idempotency record. Because everything runs in a single script, no interleaving of concurrent requests can observe intermediate state: the decrement-to-zero boundary, duplicate keys racing, and quantity > 1 (checked as `remaining < quantity` before a quantity-sized decrement) are all decided under Redis's single-threaded execution. An integration test fires 20 concurrent attempts at 5 units and asserts exactly 5 reservations.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:127` — the single reserve Lua script (idempotency → stock → decrement → hold → expiry → event → pending record).
- `checkout-forge/packages/db/src/redis-inventory.ts:173` — sold-out branch checked before any decrement.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:246` — concurrent no-oversell test (20 contenders, 5 units).

#### Compared behavior

The compared implementation uses the same mechanism: one Lua script performing idempotency lookup, stock check (`remaining < quantity`), counter updates, hold record, expiry-ZSET entry, capped event, and the atomically stored idempotency record. It additionally validates quantity inside the script (rejecting non-positive or non-integer values with a distinct `invalid_quantity` outcome) rather than relying purely on upstream contract validation. Its concurrency tests are somewhat stronger: 80 contenders against 50 units, plus a dedicated test that 20 concurrent requests sharing one idempotency key collapse to exactly one reservation with all replays returning the same stored record.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:67` — the single reserve Lua script with the same ordered decision sequence.
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:76` — in-script quantity validation (defense in depth).
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:236` — 80-contender no-oversell test.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:259` — concurrent same-key duplicates collapse to one reservation.

#### Verdict rationale

Both implementations satisfy the #1 non-negotiable guarantee with the same architecture — a single Lua script as the exclusive stock gate — and both are race-safe by construction across the decrement-to-zero boundary, racing duplicates, and quantity > 1. The compared implementation adds an in-script quantity guard and slightly deeper concurrency tests, but these are marginal hardening on an already-equivalent core, so the verdict is `same` (test depth is graded separately in C33).

---

### C21 — Idempotency record content & replay crash-consistency (better)

#### Reference behavior

The baseline uses a two-script lifecycle. The reserve script atomically stores a *pending* record (`outcome: "reserved"` plus the full hold) under the idempotency key, so a crash immediately after the decrement still replays consistently. After durable persistence resolves, a second Lua script overwrites the key with the final stored *response body* (secured or pending-persistence), giving byte-faithful replays (only `correlationId` is re-stamped) with no database round-trip. The weakness is the window between the two scripts: if the process crashes after the PostgreSQL write but before the finalize script runs, the key holds the pending record forever, and every future replay answers `reservation_pending_persistence` even though the order was durably persisted and queued — a permanently misleading replay that nothing corrects.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:219` — pending record stored atomically inside the reserve script.
- `checkout-forge/packages/db/src/redis-inventory.ts:229` — second Lua script that finalizes the stored response and flips hold persistence status.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:224` — finalize call placed after persistence + queue publish (the crash window).
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:294` — a still-pending record always replays as pending-persistence.

#### Compared behavior

The compared implementation generates the complete reservation identity up front (reservation id, token, order id, public order id) and stores that full hold record atomically with the decrement — one write, no second finalize script, so there is no state in Redis that can go stale. On a replay, secured-vs-pending is resolved by checking whether the durable order actually exists (a primary-key point read), with a read failure deliberately resolving to "pending" as the safe answer. This makes replays self-consistent under every crash interleaving: a crash before persistence replays as pending, and once the order is durably visible, replays automatically upgrade to secured — the exact window where the baseline lies forever. The trade-off is that every replay of an accepted hold costs one PostgreSQL read (relevant in duplicate-attempt load mode, where ~half of a duplicating buyer's traffic is replays), and replayed responses are reconstructed from the record rather than byte-faithful stored bodies.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:104` — full hold record stored atomically with the decrement (`SET … EX ttl` inside the reserve script).
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:117` — full identity (order id, public order id) decided before the gate so the stored record can answer replays alone.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:247` — replay resolves secured-vs-pending from durable order existence.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:263` — a failing existence read answers as pending (fail-safe).

#### Verdict rationale

Both store the accepted outcome atomically with the decrement, satisfying the spec's core requirement — neither has a replay/oversell window. The difference is what happens after: the baseline's two-phase stored-response design gives cheaper, byte-faithful replays but has an unrecoverable inconsistency (crash between persist and finalize → permanently wrong pending replays for a real order), while the compared design derives replay truth from the durable record and is therefore correct under every partial-failure interleaving, at the cost of one indexed PostgreSQL point read per replay. Correctness under crashes is the property this Redis hot-path design needs to protect, and replays are a small minority of surge traffic outside deliberate duplicate mode, so the compared implementation grades `better`. The nuance worth keeping: at 10k RPS in duplicate-attempt mode the baseline's Redis-only replay path is meaningfully cheaper, and a design combining both (stored final response *and* durable fallback) would beat either.

---

### C22 — Idempotency conflict rule (same)

#### Reference behavior

Idempotency is scoped `saleOfferId + idempotencyKey` (the key is namespaced under the offer's prefix). "Same request" is judged by quantity only: the reserve script compares the stored record's quantity against the incoming one and returns `idempotency_conflict` on mismatch, which the API maps to a 409 with the offending key in the details. Other payload fields (e.g. `runId`) are not part of the comparison.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:150` — conflict decided by quantity comparison inside the script.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:130` — conflict mapped to a 409 with details.

#### Compared behavior

Identical scoping (per-offer key namespace) and an identical rule: the script compares stored vs requested quantity and returns `idempotency_conflict` on mismatch, otherwise replays. The conflict outcome carries no stored record back to the caller (the baseline returns it internally but doesn't expose it either), and the API answers with an explicit conflict status. `runId` is likewise outside the comparison, mitigated in both implementations by the pre-gate eligibility check.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:80` — quantity-only conflict/replay decision in the script.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:163` — conflict-on-different-quantity covered by test.

#### Verdict rationale

The rule, its scoping, and its blind spots (quantity-only, not full-payload) are the same in both implementations. Neither is stricter or looser than the other in any way that changes behavior, so `same`.

---

### C23 — Sold-out losing-path cost profile (same)

#### Reference behavior

The sold-out branch lives inside the same reserve script and does exactly two cheap Redis hash operations: increment the `api_sold_out_decision` aggregate counter and set the latest-observed timestamp. No stock decrement, no per-request idempotency record, no PostgreSQL involvement, no per-loser durable write — losing traffic at 10k RPS costs one Lua invocation per request and nothing else.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:173` — sold-out branch: HINCRBY counter + HSET timestamp only, then return.

#### Compared behavior

Byte-for-byte the same design: the sold-out branch increments the `api_sold_out_decision` field and sets an `_at` timestamp on the outcomes hash, returning before any decrement, hold write, or idempotency record. A dedicated test asserts sold-out attempts store no idempotency record and leave counters untouched.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:90` — sold-out branch: aggregate increment + timestamp only.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:178` — asserts no decrement and no idempotency record on the losing path.

#### Verdict rationale

Both keep the losing path exactly as cheap as the spec demands — aggregate counter only, nothing durable, nothing per-request. Field naming differs trivially (`api_sold_out_decision:count`/`:latestObservedAt` vs `api_sold_out_decision`/`_at`); behavior is equivalent. `same`.

---

### C24 — Pending-persistence sentinel resilience under a real PostgreSQL outage (better)

#### Reference behavior

When the durable order write fails after Redis secured the hold, the baseline (a) inserts a durable `reservation_pending_persistence` row, (b) returns the distinct pending-persistence response with a retry-after hint, and (c) stores that response plus the pending-ZSET entry via the finalize script. Step (a) is the flaw: it is an *unguarded write to the same PostgreSQL that just failed*. Under a genuine PostgreSQL outage — the headline scenario this mechanism exists for — that insert throws, the buyer gets a 500 instead of the mandated pending-persistence response, and the finalize script never runs, so the pending ZSET is never written and the secured hold is invisible to the operator-facing pending count. The path only works when the failure was scoped to the order insert (e.g. a constraint violation) while PostgreSQL itself remained reachable — which is exactly what the baseline's own test simulates (a fake failing only `persistReservedOrder`).

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:188` — durable pending-row insert attempted immediately in the catch block, unguarded.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:192` — that insert targets the same PostgreSQL that just failed.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:206` — pending ZSET/response stored only after the durable insert succeeds.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:483` — the test's fake fails only the order write, masking the full-outage case.

#### Compared behavior

The compared implementation records the pending sentinel entirely in Redis — which is provably healthy at that instant, since the gate just used it. A `MULTI` atomically writes the time-scored pending ZSET entry *and* a companion records hash carrying the full run-scoped payload (correlation id, run id, idempotency key, quantity, token, timestamps) needed to materialize the durable row later, explicitly designed not to depend on the PostgreSQL that just failed. The buyer receives the distinct `reservation_pending_persistence` response with `order: null`; the hold is immediately visible in the inventory-status pending count and oldest-pending age. Classified client-error rejections are excluded from this path (they compensate instead, see C26), and a failure of the pending mark itself is logged as an explicit double fault before surfacing. API-level tests exercise the path with a genuinely failing persistence layer, including the status-read visibility and replay-as-pending follow-ups. One gap both sides share: a hard process crash *between* the gate and the sentinel write leaves a hold no sentinel tracks.

**References:**
- `checkout-surge-opus/packages/db/src/inventory.ts:195` — sentinel = pending ZSET + full-payload records hash, written atomically in Redis only.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:308` — catch block: transient failures mark pending in Redis and return the pending response; classified rejections take the compensation path.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:408` — double-fault (mark itself fails) logged explicitly before surfacing.
- `checkout-surge-opus/apps/api/test/api/buy-pending-persistence.test.ts:172` — API tests for hold preservation, status visibility, and pending replay under failing persistence.

#### Verdict rationale

The spec mandates that Redis-secured holds failing durable persistence be preserved, tracked visibly, and reported distinctly to the caller. The compared implementation delivers all three under the realistic failure (PostgreSQL down), because its sentinel path touches only Redis. The baseline delivers them only when PostgreSQL failed selectively but is still accepting writes; under a real outage it returns a 500 and loses operator visibility of the hold — the mechanism fails precisely when it matters most. That is a concrete correctness difference on spec-mandated behavior: `better`.

---

### C25 — Pending-persistence reconciliation into durable history (better)

#### Reference behavior

The baseline writes pending state (durable row at failure time when possible, Redis ZSET for visibility) but never reconciles it: nothing ever consumes the pending ZSET, flips a hold to persisted, or revisits the record. This is honest — the docs explicitly declare automatic reconciliation out of scope as a production extension point — but the capability is absent.

**References:**
- `checkout-forge/docs/redis_inventory_hot_path.md:27` — reconciliation declared intentionally out of scope.
- `checkout-forge/docs/redis_inventory_hot_path.md:85` — pending state kept visible, reconciliation left as future work.

#### Compared behavior

The compared implementation ships a working reconciler: it reads the full-payload records hash (C24) and materializes durable `reservation_pending_persistence` rows with `ON CONFLICT (reservation_id) DO NOTHING`, making re-runs idempotent and non-destructive. It is invoked at the two lifecycle moments that need durable consistency — run finalization before a draining run is graded terminal, and API startup reconciliation for a draining run a restart left behind — rather than as a polling loop. The Redis sentinel is deliberately left in place so pending holds stay operator-visible and replays keep answering as pending; malformed hash entries are skipped rather than failing the batch. It still does not *release* pending holds or re-drive them into orders (holds stay pending for life, same as the baseline's stance on hold lifecycle).

**References:**
- `checkout-surge-opus/apps/api/src/services/pending-persistence-reconciler.ts:45` — materializes durable rows from the Redis sentinel.
- `checkout-surge-opus/apps/api/src/services/pending-persistence-reconciler.ts:49` — idempotent insert (`onConflictDoNothing` on reservation id).
- `checkout-surge-opus/apps/api/src/services/run-finalization-service.ts:117` — finalization invokes pending-hold reconciliation before grading a draining run terminal.
- `checkout-surge-opus/apps/api/src/services/startup-reconciliation-service.ts:111` — startup recovery invokes the same reconciliation for recovered draining runs.
- `checkout-surge-opus/packages/db/src/inventory.ts:238` — reconciliation read tolerating malformed entries.

#### Verdict rationale

The reconciliation question is whether anything ever consumes the pending marker. In the baseline the answer is no (declared); in the compared implementation the answer is yes — an idempotent bridge from the Redis-resilient sentinel to the durable record, wired into finalization and crash recovery. Because the compared side's failure-time write is Redis-only (C24), this reconciler is also what makes its durable audit trail *complete*, closing the loop the baseline attempts (fragilely) at failure time. Neither side reconciles the hold itself into an order, so the gap is narrowed, not eliminated — but on this dimension the compared implementation does strictly more, correctly: `better`.

---

### C26 — Compensating reversal of holds rejected by durable persistence (better)

#### Reference behavior

The baseline has no reversal primitive. Every durable-write failure after a secured hold — including a non-retryable *client-error* rejection such as the run-ownership trigger (C13) refusing a mismatched `(runId, saleOfferId)` write — is treated identically as pending-persistence: the hold stays decremented forever, a pending row is recorded, and the caller receives a pending response for a reservation that can never become an order. The baseline reduces the odds of hitting this (it rejects all buys without an eligible run pre-Redis), but a stale eligibility cache or trigger-level rejection still lands in the catch-all, permanently leaking that stock into "pending" with no reconciliation (C25).

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:178` — single catch-all: every persistence error becomes pending-persistence; no reversal exists.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:96` — pre-Redis eligibility rejection narrows (but does not eliminate) the exposure.

#### Compared behavior

The compared implementation distinguishes transient durable failures (→ pending-persistence, C24) from classified non-retryable rejections (the ownership trigger's `run_sale_offer_mismatch`, reachable via null-runId catalog traffic hitting a run's generated offer). For the latter it runs a second Lua script that atomically restores the counters (reading the reversed quantity from the stored hold record rather than trusting the caller), deletes the hold, its expiry entry, and its idempotency record (so a corrected retry decides afresh), and appends a corrective inventory event. It is guarded by the hold's presence, so repeat reversals are `not_held` no-ops, and a reversal that itself fails is logged without masking the client error. The primitive has its own test suite covering full unwind, retry-after-reversal, no-op, and repeat-idempotency.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:177` — atomic reversal script (counters, hold, expiry, idempotency, corrective event).
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:314` — classified rejection compensates instead of masking as pending.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:342` — reversal failure logged, never hides the original rejection.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:305` — dedicated reversal test suite.

#### Verdict rationale

Part of this machinery exists because the compared implementation *chose* to accept catalog (non-run) traffic, widening the mismatch surface the baseline closes at the eligibility gate. But the failure class is real in both designs (any classified rejection after the decrement), and the outcomes differ sharply: baseline → permanent stock leak dressed as pending-persistence plus a misleading buyer response; compared → clean atomic unwind, honest client error, retry can re-decide. The reversal is correctly scoped (it is not lifecycle expiry, which both sides intentionally omit), quantity-safe, idempotent, and tested. `better`.

---

### C27 — Uninitialized-inventory behavior (same)

#### Reference behavior

If traffic arrives before the offer's state hash is seeded (or after cleanup), the reserve script detects the missing `remainingStock` field and returns an explicit `inventory_not_initialized` outcome before any write; the API maps it to a 503. No crash, no silent accept, no idempotency record for the attempt.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:165` — explicit not-initialized outcome from the script.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:122` — mapped to a 503 error.

#### Compared behavior

Same explicit fail-closed design: the script checks the state hash first (`HGETALL` empty → `missing_inventory`) and returns before any mutation; the API maps it to a 404 `inventory_not_initialized` error. The status read likewise returns `null` for uninitialized offers, and both the reserve and reverse scripts share the guard. Covered by tests on both scripts.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:68` — state-hash existence checked first, explicit `missing_inventory` outcome.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:136` — mapped to a 404 error.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:87` — uninitialized behavior tested.

#### Verdict rationale

Both fail closed with an explicit, non-mutating outcome. The HTTP status differs (503 vs 404 — arguable both ways: "service state missing" vs "resource unknown"), which is a response-mapping nuance folded into C6 rather than a hot-path difference. `same`.

---

### C28 — TTL & hold-expiry edge handling (same)

#### Reference behavior

Defaults are 15-minute hold window and 1800 s idempotency TTL, environment-overridable and validated at startup. A retry after the idempotency TTL lapses is a fresh attempt (the stored record is simply gone). Expired holds are tracked — the expiration ZSET makes them countable and inspectable via the status read — but intentionally never auto-released; that reconciliation is a documented production extension. Expiry scores come from the API process clock (the `expiresAt` the service computed), not Redis server time.

**References:**
- `checkout-forge/apps/api/src/config.ts:47` — 15 min hold / 1800 s TTL defaults.
- `checkout-forge/packages/db/src/redis-inventory.ts:199` — expiry ZSET scored with caller-computed epoch ms.
- `checkout-forge/docs/redis_inventory_hot_path.md:69` — expired holds tracked, not released (declared).

#### Compared behavior

Identical defaults (15 min / 1800 s, environment-overridable), identical track-don't-release stance on expired holds (ZSET-derived expired count in the status read, release explicitly declared out of scope), and the same API-clock scoring of expiry. The compared side additionally has an explicit test that a duplicate arriving after the idempotency record expired is treated as a fresh attempt (documenting the deliberate double-spend-by-design consequence), and its clock is injectable for deterministic tests.

**References:**
- `checkout-surge-opus/apps/api/src/runtime/config.ts:192` — same 15 min / 1800 s defaults.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:205` — post-TTL duplicate treated as fresh attempt (tested).
- `checkout-surge-opus/packages/db/src/inventory.ts:102` — expired-hold count derived from the expiration ZSET, holds never released.

#### Verdict rationale

Same defaults, same TTL semantics, same deliberate non-release of expired holds, same clock source and therefore the same clock-skew characteristics. The compared side tests one more edge; behavior is indistinguishable. `same`.

---

### C29 — Keyspace cleanup & Redis hygiene (better)

#### Reference behavior

The baseline's namespace teardown (used by reset/reseed) enumerates per-key idempotency entries with `KEYS pattern` — a blocking O(N) scan of the whole keyspace — then issues one `DEL` of the named keys plus all matches. For a demo-scale dataset this works, but `KEYS` on the hot Redis during any live activity is the canonical anti-pattern, and `DEL` of a large batch blocks similarly. The key names themselves are assembled in one helper, but the deletion list is hand-enumerated, so a newly added key type must be remembered in the cleanup path.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:313` — `redis.keys(pattern)` blocking enumeration of idempotency keys.
- `checkout-forge/packages/db/src/redis-inventory.ts:314` — hand-enumerated key list + single bulk `DEL`.

#### Compared behavior

The compared implementation retires a generated offer's namespace with cursor-based `SCAN` (bounded `COUNT 200` batches) and non-blocking `UNLINK`, and the glob pattern `inventory:{id}:*` is single-sourced in the keys module — every present and future key under the namespace (state, holds, ZSETs, events, outcomes, records hash, all idempotency keys) is covered without a hand-maintained list. Initialization is separate from teardown, with an existence check keeping re-seeding idempotent instead of re-baselining live counters (the same guard C16 relies on).

**References:**
- `checkout-surge-opus/packages/db/src/inventory.ts:149` — SCAN + UNLINK batched namespace cleanup.
- `checkout-surge-opus/packages/db/src/redis-keys.ts:46` — single-sourced namespace pattern covering all key types.
- `checkout-surge-opus/packages/db/src/inventory.ts:48` — idempotent re-seed guard (`hasInventoryState`).

#### Verdict rationale

Same run isolation (fresh per-run offer UUIDs give each run a fresh namespace in both) and same TTL discipline, but the compared cleanup is strictly better operational hygiene: non-blocking enumeration and deletion, and structurally complete coverage via a single-sourced pattern instead of a maintainable-by-memory list containing a blocking `KEYS` call. `better`.

---

### C30 — Idempotency-key input hygiene in the keyspace (worse)

#### Reference behavior

The baseline caps the idempotency key at 128 characters in the buy contract and passes it through `encodeURIComponent` before embedding it in the Redis key, so caller-supplied bytes can neither inflate keys unboundedly nor contain glob metacharacters (`*`, `?`, `[`) or separators that would interact with the pattern-based cleanup and key readability.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:20` — `nonEmptyStringSchema.max(128)` on the idempotency key.
- `checkout-forge/packages/db/src/redis-inventory.ts:298` — `encodeURIComponent` before key interpolation.

#### Compared behavior

The compared contract accepts any non-empty string (`z.string().min(1)`, no length cap — the same unbounded-string pattern noted in C10), and the key helper interpolates it raw into `inventory:{offer}:idempotency:{key}`. Redis keys are binary-safe and the offer-scoped prefix means no namespace escape, and cleanup matches by namespace prefix so glob characters in a key don't break deletion — but a public buy surface accepting megabyte idempotency keys stores them twice per accepted request (key name + inside the hold record), an unbounded-memory vector, and keys containing `*`/newlines degrade operability (SCAN patterns, log lines, debugging).

**References:**
- `checkout-surge-opus/packages/contracts/src/buy.ts:13` — `z.string().min(1)`, no maximum length.
- `checkout-surge-opus/packages/db/src/redis-keys.ts:54` — raw interpolation into the Redis key.

#### Verdict rationale

No exploitable injection exists on either side (Redis keys are binary-safe and the namespace prefix is fixed), so this is hygiene, not a vulnerability — but the baseline bounds and encodes attacker-influenced input reaching its hottest keyspace and the compared implementation does neither. Small, real, and one-sided: `worse`.

---

### C31 — Terminal inventory snapshot into durable history (same)

#### Reference behavior

When a run reaches a terminal summary, the baseline captures a Redis-derived inventory snapshot (remaining/reserved/allocated, pending count, expired count) via the status read plus the sold-out outcome aggregate, and copies them into the immutable run summary so audits survive Redis resets. The docs pin this as the audit contract.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:304` — snapshot + aggregate captured at terminal-summary time.
- `checkout-forge/docs/redis_inventory_hot_path.md:25` — documented terminal-snapshot audit guarantee.

#### Compared behavior

The compared run-summary writer does the equivalent: it reads the live inventory state (which already folds in secured count, sold-out rejections, pending and expired figures — see C32) at terminal time, validates it against a dedicated `terminalInventorySnapshot` contract schema, and persists it on the immutable summary row, surfaced through run-history reads. This snapshot is also where the compared build durably lands the sold-out aggregate that the baseline keeps in a dedicated table (see C3).

**References:**
- `checkout-surge-opus/apps/api/src/services/run-summary-writer.ts:99` — snapshot captured and written into the terminal summary.
- `checkout-surge-opus/apps/api/src/services/run-summary-writer.ts:169` — snapshot schema-validated before persisting.

#### Verdict rationale

Both satisfy the spec-mandated audit copy at run end with substantively the same content; the compared side schema-validates the snapshot on write (a small plus), the baseline's is assembled from two reads (a wash). Summary content and lifecycle are judged in C43; as a hot-path primitive the capability is equivalent. `same`.

---

### C32 — Inventory status projection & recent-events retention (same)

#### Reference behavior

The baseline's status projection returns allocated/remaining/reserved stock, last-updated, pending-persistence count, expired-hold count, and oldest-pending age — each derived live from its dedicated key in one parallel read batch. The sold-out aggregate is a separate read function. Recent inventory events are kept in a capped list of the last 500 (RPUSH + LTRIM, hardcoded in the script).

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:401` — status projection with pending/expired/oldest-age visibility.
- `checkout-forge/packages/db/src/redis-inventory.ts:211` — events list capped at 500 in-script.
- `checkout-forge/packages/db/src/redis-inventory.ts:372` — sold-out aggregate exposed via a separate read.

#### Compared behavior

The compared projection returns the same core figures plus `reservationsSecuredCount` (hold-hash length, doubling as cumulative accepted count since holds are never released) and `soldOutRejectionCount` folded into the single snapshot, each derived from its single-source key in one parallel batch. Events are kept newest-first (LPUSH + LTRIM) with a configurable cap defaulting to 100 rather than 500.

**References:**
- `checkout-surge-opus/packages/db/src/inventory.ts:89` — one-read snapshot including secured and sold-out counts.
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:19` — events cap default 100, parameterized.

#### Verdict rationale

The spec-required visibility (remaining/reserved/allocated, pending count, expired count, oldest-pending age) is fully present on both sides. The compared projection is marginally richer per read and its event cap is parameterized but smaller (100 vs 500 — a legitimate open-detail choice; nothing in either codebase's consumers needs more than the recent window). Differences cancel out: `same`.

---

### C33 — Test coverage of the hot-path primitives (better)

#### Reference behavior

The baseline's integration suite (real Redis) covers initialization, atomic accept with hold/expiry/event assertions, sold-out without decrement, replay and conflict, the second-script finalize path (stored response + hold persistence flip, including the hold-missing edge), a 20-way concurrency storm, uninitialized-inventory reporting, and pending-persistence visibility. API-level tests cover the pending-persistence outcome, but with a fake that fails only the order write (see C24).

**References:**
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:28` — the primitive suite (9 tests spanning init, accept, sold-out, replay/conflict, finalize, concurrency, pending visibility).
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:483` — pending path tested with a selectively failing persistence fake.

#### Compared behavior

The compared suite (real Redis) covers everything equivalent on the reserve gate and adds the edges the baseline leaves untested: post-TTL duplicate treated as a fresh attempt, in-script invalid-quantity rejection, a larger concurrency storm (80 contenders / 50 units), and a dedicated concurrent-duplicate test proving same-key races collapse to exactly one reservation with identical replayed records. The reversal script gets its own five-test suite (full unwind, retry-after-reversal decides afresh, not-held no-op, uninitialized, repeat idempotency). API-level tests exercise the pending-persistence path end-to-end including status-read pressure and replay-as-pending semantics.

**References:**
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:86` — gate suite including TTL-expiry, invalid-quantity, and 80-way storm.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:259` — concurrent same-key duplicate collapse test (absent in baseline).
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:305` — dedicated reversal suite.
- `checkout-surge-opus/apps/api/test/api/buy-pending-persistence.test.ts:172` — end-to-end pending path incl. visibility and replay.

#### Verdict rationale

Both suites hit the hard property (concurrent no-oversell) against real Redis. The compared suite tests strictly more Redis hot-path edge cases — duplicate-key races, TTL expiry, quantity validation, and its extra reversal primitive — while the baseline's unique coverage (the finalize script) tests machinery the compared design eliminated. Systemic testing methodology is covered in C106-C113; within the hot-path primitive tests, the compared coverage is deeper: `better`.

---

## Buy path & API request handling under surge

### C34 — Run/sale eligibility gate on the buy path (same)

#### Reference behavior

The baseline makes run attribution mandatory for every buy: the request must carry a `runId` in the body or `x-load-run-id` header, and a body/header mismatch is rejected before any store access. Eligibility is a Redis-backed, API-owned cache entry containing the accepting run state and serialized sale offer; the per-request gate is a single Redis read, and any miss, mismatch, parse failure, or non-accepting status fails closed as `sale_not_active` without touching PostgreSQL or the stock gate. Because the cached offer is available, the accepted path also avoids a catalog read.

**References:**
- `checkout-forge/apps/api/src/routes/buy.ts:90` — `runId` required and reconciled before store access.
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:110` — single Redis GET, fail-closed on miss/mismatch/non-accepting status.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:96` — ineligible traffic rejected before Redis stock work or PostgreSQL.

#### Compared behavior

The compared implementation uses the same Redis-backed eligibility authority for run-attributed traffic: a run is opened at activation, closed on terminal transitions, checked with one Redis read, and fails closed with distinct reason codes (`unknown_run`, `offer_mismatch`, `closed`) before the stock gate. The difference is that `runId` is optional. Catalog-style buys without a run id skip this gate and reserve against the named offer; if such traffic targets a generated run offer, the database ownership trigger rejects the persistence write and the service compensates by reversing the Redis hold (see C26).

**References:**
- `checkout-surge-opus/apps/api/src/services/run-sale-eligibility.ts:52` — one-read fail-closed run/offer eligibility check.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:108` — eligibility enforced only when a `runId` is present.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:314` — trigger-rejected catalog buy compensated by reversing the hold.
- `checkout-surge-opus/apps/api/src/runtime/run-attribution.ts:27` — body/header run-id reconciliation with mismatch rejection.

#### Verdict rationale

For the surge path the product is built around — run-attributed load — both implementations enforce the same cheap, fail-closed eligibility gate before stock mutation or PostgreSQL. The compared implementation's optional catalog traffic widens an edge case the baseline forbids outright: a run-offer buy without a run id can briefly decrement Redis before trigger rejection and compensation. That is worse for that edge's losing-path cost, but the stock leak is closed by the reversal primitive and the feature is deliberately broader than the baseline's stricter contract. For the scoped run/sale gate itself, the implementations are equivalent: `same`.

---

### C35 — Accepted-path sequencing & partial-failure handling (better)

#### Reference behavior

The baseline accepted path is Redis reserve → one PostgreSQL CTE writing reservation, order, and lifecycle events atomically → queue publish → Redis idempotency-response finalization → dashboard signal → response. The single SQL statement is tight and atomic, but failure handling after persistence is brittle. If queue publish throws after the order commit, the buyer gets a 500 for a real reservation and the idempotency record is never finalized, so replays can report pending-persistence for an order that is already durable and intended for processing. Its pending-persistence sentinel is also written to PostgreSQL inside the catch for a PostgreSQL failure, the full-outage weakness already graded in C24.

**References:**
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:77` — atomic CTE for reservation, order, and two events.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:222` — unguarded queue publish after durable commit.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:188` — pending row attempted in the same PostgreSQL failure path.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:224` — idempotency response finalized only after enqueue succeeds.

#### Compared behavior

The compared path is eligibility → Redis reserve → PostgreSQL transaction for reservation/order/events → queue publish → response, with dashboard publication treated as best-effort. Durable-write failures mark a Redis pending sentinel with the full payload (C24) and are reconciled later (C25). Classified non-retryable persistence rejections compensate the hold (C26). Queue-publish failure after commit is logged, but the buyer still receives the secured response because the durable `queued` order is now the source of truth; the queue handoff uses `jobId = orderId`, so a later re-drive can be idempotent. A double fault while marking pending is logged distinctly before surfacing as a 500.

**References:**
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:287` — persistence failure split into pending vs classified-compensation paths.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:372` — enqueue failure logged while returning the secured response.
- `checkout-surge-opus/apps/api/src/services/order-process-queue.ts:74` — `jobId = orderId` for idempotent handoff.
- `checkout-surge-opus/apps/api/src/services/pending-persistence-sink.ts:5` — pending sentinel deliberately lives in Redis.
- `checkout-surge-opus/apps/api/src/index.ts:220` — pending reconciler wired into finalization/startup paths.

#### Verdict rationale

This is where several earlier Redis/persistence differences matter in API orchestration. On persistence failure, the compared implementation reports and tracks pending state through the store that is still healthy; the baseline attempts a second write to the failing store. On queue-publish failure, the baseline turns a durable success into a buyer-facing 500 and leaves replay state stale; the compared implementation returns the truthful secured response and leaves an idempotently recoverable durable artifact. The baseline's one-statement persistence is a useful latency simplification, but the compared implementation is more recoverable and more honest across the relevant partial states. `better`.

---

### C36 — Sold-out dashboard pressure aggregation (same)

#### Reference behavior

The baseline keeps the sold-out losing path cheap (one Redis Lua decision and no durable/per-request record, see C23) while still making sold-out pressure visible live. The buy service observes sold-out losers into an in-process per-run/offer aggregator, which flushes at a 500 ms cadence as bounded dashboard metric events and flushes remaining observations on shutdown. The same aggregator's running totals back the snapshot's sold-out count. The trade-off is that those displayed totals are process-local memory: an API restart mid-run zeroes them until new observations arrive, and multiple API instances would each have their own partial view.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:145` — sold-out path observes only the in-process aggregator.
- `checkout-forge/apps/api/src/services/sold-out-dashboard-metric-aggregator.ts:49` — 500 ms aggregate flush per run/offer.
- `checkout-forge/apps/api/src/services/sold-out-dashboard-metric-aggregator.ts:120` — shutdown flush of pending aggregates.
- `checkout-forge/apps/api/src/services/sold-out-dashboard-metric-aggregator.ts:38` — process-local in-memory running totals.

#### Compared behavior

The compared implementation keeps the raw loser path just as cheap: the Lua script increments the sold-out counter and timestamp, then returns; the API sends the response without PostgreSQL work, per-request records, timers, or dashboard publication. Sold-out pressure is surfaced through the inventory-status projection and recovery snapshot as `soldOutRejectionCount`, which lives in the same Redis keyspace as the atomic gate. That makes the count restart-safe and correct across any number of API instances. The cost is live latency: the browser sees updates only through the recovery/status polling path rather than through a 500 ms pushed metric event, so the realtime stream goes quiet after stock reaches zero unless the client polls.

**References:**
- `checkout-surge-opus/packages/db/src/reserve-stock.ts:91` — sold-out branch increments the aggregate counter only.
- `checkout-surge-opus/apps/api/src/services/reserve-order-service.ts:144` — sold-out returns immediately with no observation/publish hook.
- `checkout-surge-opus/apps/api/src/services/inventory-reader.ts:18` — sold-out count reachable through the status read.
- `checkout-surge-opus/packages/contracts/src/inventory.ts:22` — cumulative `soldOutRejectionCount` on the inventory projection.

#### Verdict rationale

Both satisfy the strict cost side of the spec: sold-out losers do not decrement stock, write PostgreSQL, create per-request idempotency records, or emit per-loser events. They optimize different parts of the observability trade-off. The baseline is more live (500 ms push) but process-local and restart-fragile; Opus is restart-safe, multi-instance-correct, and cheaper (zero flush loop), but delayed by the polling cadence. Neither dominates, so the consolidated verdict is `same`. The broader absence of pushed run/traffic metrics in Opus is graded separately in C61.

---

### C37 — Surge tuning & startup-validated API configuration (same)

#### Reference behavior

The baseline treats surge behavior as configuration that must be valid before the server starts. A Zod environment schema parses and range-checks tunables, including the 8192 default TCP listen backlog, hold/idempotency/pending retry defaults, caps, budgets, and the API PostgreSQL pool size. The backlog is passed to `listen`, API and worker pool sizes are independently configurable, and startup cross-validates the public runtime policy against deployment hard caps.

**References:**
- `checkout-forge/apps/api/src/config.ts:74` — range-checked `API_LISTEN_BACKLOG` default 8192.
- `checkout-forge/apps/api/src/index.ts:264` — backlog applied at server listen.
- `checkout-forge/apps/api/src/config.ts:192` — startup public-policy-vs-hard-cap validation.

#### Compared behavior

The compared implementation covers the same surge-critical knobs: fail-fast config parsing raises `ConfigError` on malformed values, `API_LISTEN_BACKLOG` defaults to 8192 and is passed to `listen`, the API pool max defaults to 10, hold/idempotency/finalization settings are environment driven, and deployment traffic caps are parsed against a schema. Its validation is thinner than the baseline's in some places (positive integer checks rather than richer ranges everywhere, and policy-vs-cap consistency lives in the policy service rather than a boot assertion), while it adds a deliberate degraded mode where missing Redis makes the buy path return 503 instead of preventing the API process from starting.

**References:**
- `checkout-surge-opus/apps/api/src/runtime/config.ts:203` — fail-fast `API_LISTEN_BACKLOG` default 8192.
- `checkout-surge-opus/apps/api/src/index.ts:417` — backlog applied at `app.listen`.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:141` — deployment traffic caps parsed and validated.

#### Verdict rationale

Both implementations expose and apply the two burst-relevant API tunables — accept backlog and bounded PostgreSQL pool — and both validate configuration at startup rather than discovering invalid values under load. The baseline has broader schema validation and an earlier policy consistency check; the compared implementation has a coherent degraded-mode stance. Those differences do not materially change the surge path. `same`.

---

### C38 — Order status lookup projection (worse)

#### Reference behavior

The baseline's order-status endpoint is a rich read model for the asynchronous half of the buy contract. It returns reservation status and expiry, order lifecycle timestamps (`queued`, `processing`, `confirmed`, `failed`), failure code/message, derived customer-facing status, per-order consistency lag, and a labeled event timeline, all validated against the shared contract. Inventory status is separately queryable with the live projection already covered in C32.

**References:**
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:239` — rich order-status projection with lifecycle, failure detail, lag, and timeline.
- `checkout-forge/apps/api/src/routes/order-status.ts:1` — public order-status route.
- `checkout-forge/packages/contracts/src/buy-flow.ts:99` — contract shape for the full order-status response.

#### Compared behavior

The compared implementation has a public `GET /orders/:publicOrderId`, so the required capability exists, but the projection is minimal: id, public order id, current order status, and queued timestamp. It does not expose reservation state, expiry, processing/confirmed/failed timestamps, failure details, event timeline, or per-order consistency lag. The aggregate consistency-lag read and inventory-status projection exist separately, but a buyer polling after a 202 cannot tell why an order failed or inspect the reservation/order timeline.

**References:**
- `checkout-surge-opus/apps/api/src/services/order-reader.ts:14` — four-field order summary projection.
- `checkout-surge-opus/apps/api/src/routes/order-routes.ts:12` — public order lookup route.
- `checkout-surge-opus/apps/api/src/services/inventory-reader.ts:18` — inventory status projection present and schema-validated.

#### Verdict rationale

This partially overlaps C7's missing presentation vocabulary, but the issue here is the API read model itself. Both implementations make order and inventory status queryable, so this is not `missing`. The baseline read answers the natural questions created by async confirmation — what happened, when, and why — while the compared read mostly exposes the raw order status and leaves failure explanation/timeline to nowhere. Inventory status is a wash; order status is materially thinner. `worse`.

---

## Demo run lifecycle, presets & control plane

### C39 — Run start orchestration & post-insert failure handling (better)

#### Reference behavior

The baseline splits run start across creation and start services: creation looks up the preset, checks visibility, clamps public custom inputs, freezes the accepted configuration, and creates the run; start delegates traffic to the orchestrator and marks the run failed if delegation throws. The one-active-run rule is race-safe in the normal path via the advisory-lock repository covered in C14. If Redis inventory initialization or traffic start fails after the run row exists, the run is failed and a terminal summary is written, so failed starts still produce history records.

**References:**
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:36` — advisory-lock + check-then-insert transaction for starts.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:145` — inventory-init failure fails the run and writes a terminal summary.
- `checkout-forge/apps/api/src/services/demo-run-start-service.ts:50` — traffic-start failure path fails the run and preserves the original error.

#### Compared behavior

The compared implementation concentrates the workflow in `RunStartService`: preset lookup, visibility, effective-config resolution, cap validation, friendly overlap read, public-budget charge, durable provisioning, inventory init, eligibility open, traffic delegation, and promotion to `active`. The one-active-run claim is the database insert itself through the partial unique index covered in C14, with unique violations translated to a typed 409. Post-insert failures are classified with stable reason codes (`inventory_init_failed`, `sale_eligibility_open_failed`, `traffic_start_failed`), eligibility is closed, and a summary capture is attempted. Public run budget is charged only after rejectable checks have passed.

**References:**
- `checkout-surge-opus/apps/api/src/services/postgres-run-store.ts:50` — run-row insert as the atomic claim on the single non-terminal slot.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:143` — overlap read documented as advisory; the index is authoritative.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:152` — budget charged after rejectable checks.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:305` — per-step start failure handling with stable reason codes.

#### Verdict rationale

Both implementations convert post-insert start failures into failed runs with history. The compared implementation is stronger because the concurrency claim is declarative in PostgreSQL (see C14), its failure reasons are more specific, and its budget charging is sequenced to avoid burning allowance on rejected starts. The baseline's service split is clear, but the compared workflow is more robust end to end: `better`.

---

### C40 — Run provisioning: frozen snapshots & isolated inventory (same)

#### Reference behavior

Starting a baseline run freezes the accepted traffic, inventory, ERP, and backpressure configuration into the run row before traffic starts. Each normal run clones the baseline offer into a generated run-scoped sale offer and initializes isolated Redis inventory from the frozen stock value, so repeated runs do not require reset and do not share inventory. Zero starting stock is valid for sold-out demonstrations.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:118` — accepted configuration is clamped and frozen before run creation.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:146` — per-run Redis inventory initialized from the frozen snapshot.
- `checkout-forge/packages/contracts/src/demo-runs.ts:194` — non-negative `startingStock`, including zero.

#### Compared behavior

The compared implementation provisions the generated offer, `demo_runs` row with `configSnapshot`, and `demo_run_sale_context` ownership row in one transaction before any attributable traffic can start. Redis inventory is initialized from the snapshot's allocation before delegation, later preset edits cannot affect the run, and zero-stock runs are explicitly allowed for sold-out demonstrations.

**References:**
- `checkout-surge-opus/apps/api/src/services/postgres-run-store.ts:38` — offer + run snapshot + ownership context created transactionally.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:226` — durable recovery baseline established before inventory init and delegation.
- `checkout-surge-opus/packages/contracts/src/demo.ts:18` — zero stock documented as valid for sold-out demonstrations.

#### Verdict rationale

Both satisfy the lifecycle requirement: immutable start snapshot, generated run-owned offer, isolated PostgreSQL/Redis inventory, and valid zero-stock runs. The compared provisioning transaction is tidier, but the behavior is equivalent. `same`.

---

### C41 — Traffic completion vs business completion (same)

#### Reference behavior

The baseline treats k6 success as traffic completion only. A successful traffic report moves the run to `draining`; a separate API-owned finalization loop decides when business work has settled and only then completes or fails the run. Lifecycle updates from the orchestrator are guarded so stale reports cannot resurrect terminal runs, and the finalization poll/drain-timeout defaults are 5 s / 300 s.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:194` — successful traffic report maps to `draining`, not `completed`.
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:229` — status-guarded lifecycle updates.
- `checkout-forge/apps/api/src/config.ts:50` — 5 s poll / 300 s drain-timeout defaults.

#### Compared behavior

The compared implementation keeps the same separation: completion ingest maps orchestrator success to `markDraining`, maps non-succeeded terminal traffic to a failed run, and leaves `draining → completed | failed` to a finalization poller. Duplicate or stale completion reports are guarded and ignored, and the same 5 s / 300 s defaults are used.

**References:**
- `checkout-surge-opus/apps/api/src/services/load-completion-ingest.ts:62` — success maps to `draining`; completion stays with finalization.
- `checkout-surge-opus/apps/api/src/services/postgres-run-store.ts:102` — guarded `markDraining` and `markTrafficFailed`.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:200` — 5 s poll / 300 s settle-timeout defaults.

#### Verdict rationale

Both avoid the core shortcut the spec forbids: k6 success does not equal run success. Guarded transitions and default timing are equivalent. `same`.

---

### C42 — Finalization settlement checks & drain-timeout semantics (worse)

#### Reference behavior

The baseline finalization decision reconciles multiple sources before declaring a run complete: pending-persistence count must be zero, all orders must be terminal, every confirmed order must have a notification, and accepted-response accounting must reconcile k6 outcome counters, API request-lifecycle counters, and durable order rows with duplicate-attempt semantics. Any unexpected response observed by k6 fails the run. At drain timeout, outstanding work fails the run with a dimension-specific stable reason such as `pending_reservation_reconciliation_timeout`, `business_drain_timeout`, or `simulated_notification_timeout`; explainable counter drift is preserved as diagnostic warnings.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:505` — completion requires pending=0, terminal orders, notifications, and balanced accounting.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:420` — unexpected k6 responses fail the run.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:570` — drain timeout produces failed runs with dimension-specific reasons.
- `checkout-forge/apps/api/src/services/accepted-reservation-accounting.ts:1` — duplicate-aware accepted-reservation accounting.

#### Compared behavior

The compared readiness check is much shallower: no orders still `queued`/`processing`, and no confirmed order missing its notification record. It invokes the pending-persistence reconciler before grading (see C25), but it does not reconcile durable counts against k6 accepted counters or API-side response accounting. Once the settle timeout elapses, readiness is forced true even if unsettled work remains, so the run can finalize as `completed` with still-processing orders visible only inside summary counts. If `trafficEndedAt` is missing, the run is treated as immediately timed out.

**References:**
- `checkout-surge-opus/apps/api/src/services/run-finalization-service.ts:177` — readiness = unsettled orders + missing notifications, with timeout override.
- `checkout-surge-opus/apps/api/src/services/run-finalization-service.ts:129` — only major traffic shortfall fails a finalized draining run.
- `checkout-surge-opus/apps/api/src/services/finalization-store.ts:100` — settlement queries cover unsettled orders and confirmed-without-notification.
- `checkout-surge-opus/apps/api/src/services/run-summary-writer.ts:126` — business outcomes counted, not reconciled against traffic evidence.

#### Verdict rationale

The compared implementation is simpler and does check the two most visible business-settlement dimensions, but `completed` means much less than it does in the baseline. It does not certify that accepted responses are durably accounted for, and a timeout can turn outstanding work into a completed run rather than an honest failure. For a run-history artifact meant to support audit and demo trust, that is materially weaker. `worse`.

---

### C43 — Exactly-one immutable terminal summary guarantee (worse)

#### Reference behavior

The baseline routes every terminal path through one `DemoRunTerminalSummaryService`. Summary insert, finalization-row touch, `markFinalized`, and reservation-outcome aggregate copy happen in one transaction; the run is not stamped finalized unless the summary exists. Duplicate finalization converges on the existing row, and completed runs refuse summarization without valid observed traffic data. The summary payload is rich: HTTP and delivery summaries, timing and diagnostics, API request-lifecycle evidence, business outcomes including consistency-lag average/p95, and the Redis-derived terminal inventory snapshot.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:222` — summary insert + `markFinalized` + aggregate copy in one transaction.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:108` — completed runs require valid observed traffic.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:199` — consistency-lag stats computed into the summary.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:302` — duplicate finalization converges on existing summaries.

#### Compared behavior

The compared implementation also uses one shared writer and `ON CONFLICT DO NOTHING` on `runId`, so duplicate summaries are prevented. The problem is ordering: terminal status is applied first, then summary capture is best-effort on run-start failure, traffic-failure ingest, finalization, reset, and startup reconciliation. If summary writing fails after the terminal transition, the poller cannot retry because the guarded transition has already happened. The payload is also thinner: business outcome counts, terminal inventory snapshot with sold-out aggregates, and, for finalized runs, raw HTTP summary plus graded delivery; no consistency-lag statistic, request-lifecycle record, diagnostics, or timing breakdown survive into history.

**References:**
- `checkout-surge-opus/apps/api/src/services/run-summary-writer.ts:104` — one-summary-per-run via `ON CONFLICT DO NOTHING`.
- `checkout-surge-opus/apps/api/src/services/run-finalization-service.ts:132` — terminal transition applied before summary write.
- `checkout-surge-opus/apps/api/src/services/load-completion-ingest.ts:129` — summary capture is best-effort after traffic failure.
- `checkout-surge-opus/apps/api/src/services/run-summary-writer.ts:113` — summary payload limited to counts, inventory snapshot, and optional delivery facts.

#### Verdict rationale

The spec says exactly one summary per terminal run. The compared implementation enforces only the "at most one" half, while the baseline couples finalization to summary persistence so failures retry rather than leave permanent gaps. The thinner payload reinforces the downgrade, though its snapshot-derived sold-out aggregates do satisfy the aggregate-copy requirement already discussed in C3/C31. `worse`.

---

### C44 — Startup/crash reconciliation (better)

#### Reference behavior

On boot, the baseline reconciles `starting`/`active`/`draining` runs before serving: interrupted `starting`/`active` runs get placeholder finalization rows, are failed with stable reason `api_restart_interrupted_run`, and receive terminal summaries; `draining` runs are left for the poller so they survive API restarts. Eligibility is updated through the summary path so failed runs stop accepting traffic.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:55` — fail interrupted runs, leave draining runs to the poller.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:9` — stable `api_restart_interrupted_run` reason.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:92` — placeholder finalization rows inserted for summaries.

#### Compared behavior

The compared implementation satisfies the same boot contract with the same reason code: before `listen()` and before the poller starts, `starting`/`active` runs are failed, sale eligibility is explicitly closed, summaries are written, and `draining` runs remain recoverable. It adds immediate pending-hold materialization for recovered draining runs, isolates per-run reconciliation failures so one bad run does not block the rest or prevent boot, and uses a TTL backstop on eligibility records.

**References:**
- `checkout-surge-opus/apps/api/src/services/startup-reconciliation-service.ts:70` — per-run reconciliation with failure isolation.
- `checkout-surge-opus/apps/api/src/services/startup-reconciliation-service.ts:109` — draining runs get pending holds materialized at boot.
- `checkout-surge-opus/apps/api/src/index.ts:406` — reconciliation ordered before `listen()` and poller startup.
- `checkout-surge-opus/packages/db/src/run-sale-eligibility.ts:17` — TTL backstop on eligibility records.

#### Verdict rationale

Both meet the spec's crash-recovery baseline. The compared implementation adds useful hardening: pending materialization happens immediately for recovered draining runs, failures are isolated per run, and eligibility has a self-expiry backstop. Its best-effort summary caveat is already charged in C43; startup reconciliation behavior itself is `better`.

---

### C45 — Late-traffic gating across lifecycle transitions (worse)

#### Reference behavior

The baseline's run-sale eligibility cache carries lifecycle status and is updated on every transition. The buy path accepts only `starting` or `active`, so once traffic completion moves the run to `draining`, late requests fail closed before Redis stock mutation or PostgreSQL writes. Post-traffic buys cannot contaminate settlement accounting or the terminal summary.

**References:**
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:162` — `canAcceptTraffic` is `starting`/`active` only.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:170` — eligibility status pushed on lifecycle reports, including `draining`.

#### Compared behavior

The compared eligibility record is a binary `accepting` flag. It opens at start and closes on terminal transitions (start failure, traffic failure, finalization, reset, startup reconciliation), but traffic success moving the run to `draining` deliberately does not close eligibility. A draining run therefore continues accepting buy traffic until finalization closes it, potentially for the 300 s settle timeout plus a poll tick. Those late requests create real reservations/orders and are counted in the terminal summary as run outcomes.

**References:**
- `checkout-surge-opus/apps/api/src/services/run-sale-eligibility.ts:52` — eligibility decision has unknown/mismatch/closed, not lifecycle-status acceptance.
- `checkout-surge-opus/apps/api/src/services/load-completion-ingest.ts:93` — draining path explicitly leaves eligibility open for later finalization.
- `checkout-surge-opus/apps/api/src/services/run-finalization-service.ts:147` — eligibility closed only after terminal finalization.

#### Verdict rationale

Per-request eligibility enforcement remains equivalent for active run traffic (C34), but the lifecycle open/close behavior diverges exactly where the spec calls out late traffic. The baseline stops accepting when draining begins; the compared implementation keeps accepting throughout draining, which can distort the immutable run record and delay finalization. `worse`.

---

### C46 — Preset model & management flows (same)

#### Reference behavior

The baseline seeds the durable public preset set (preview, surge, idempotency-check, and public-custom base) plus editable admin presets including a persisted Custom scratch preset. Admin management supports create-from-scratch, save with read-only enforcement, duplicate, and copy-to-custom. Public visitors can start only public presets or the public-custom flow, where runtime policy clamps traffic, stock, ERP latency/TPS/error-rate, allowed failure modes, and backpressure profiles field by field.

**References:**
- `checkout-forge/packages/db/src/demo-presets.ts:83` — seeded public preset set and public-custom base.
- `checkout-forge/apps/api/src/services/demo-preset-management-service.ts:66` — create/save/duplicate/copy-to-custom with caps validation.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:200` — per-field public-custom clamping against runtime policy.

#### Compared behavior

The compared implementation seeds the same public catalog shape, two admin starter presets, and a persisted admin `Custom` scratch preset with deterministic ids and idempotent reseeding. Management supports list, update with `preset_read_only` rejection, duplicate under a free admin slug, and copy-to-custom. It does not expose create-from-scratch; duplicate is the minting path. Its public-custom flow is narrower: visitors submit only traffic and starting stock, while ERP behavior and backpressure come from the read-only base preset and are validated against the persisted policy/caps object.

**References:**
- `checkout-surge-opus/packages/db/src/presets.ts:40` — seeded public set, admin starters, Custom scratch preset, idempotent seeding.
- `checkout-surge-opus/apps/api/src/services/preset-service.ts:45` — update/duplicate/copy-to-custom with read-only and caps enforcement.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:168` — public-custom override limited to traffic + inventory.

#### Verdict rationale

Both preserve the core preset model: durable public read-only set, editable admin presets, persisted Custom scratch, duplicate/copy-to-custom, hard-cap validation, immutable snapshots at start, and no policy leakage into stored presets. The compared public sandbox is narrower and lacks create-from-scratch, but neither breaks the spec mandate. `same`.

---

### C47 — Admin reset & recovery workflow (worse)

#### Reference behavior

Baseline reset is a recovery workflow: it marks live runs failed through status-guarded recovery updates, writes terminal summaries, aborts the in-flight traffic run at the load orchestrator, clears reset-owned queues, and clears live dashboard state and in-process aggregators. Run history is not deleted. The guarded recovery update prevents a reset racing finalization from flipping an already-completed run back to failed.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-recovery-service.ts:148` — orchestrator traffic abort with typed error mapping.
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:183` — recovery update guarded on non-terminal statuses.
- `checkout-forge/apps/api/src/services/demo-reset-service.ts:48` — recover → clear queues → clear live dashboard state; history preserved.

#### Compared behavior

The compared reset recovers non-terminal runs by failing them with `demo_reset_recovery`, closing eligibility, capturing a summary before wiping live state, clearing each run's Redis live namespace, and clearing reset-owned queues while preserving history. It is stronger on Redis hygiene, but misses two important recovery properties. There is no traffic abort surface, so k6 continues to hit the API until it exits naturally. Also, `markFailed` is an unguarded `WHERE id = ...` update, so a reset that races finalization can overwrite a run just completed by the poller, while the already-written summary remains `completed`.

**References:**
- `checkout-surge-opus/apps/api/src/services/demo-reset-service.ts:108` — fail → close eligibility → capture summary → clear live state; queues always cleared.
- `checkout-surge-opus/packages/db/src/run-cleanup.ts:86` — per-run Redis live-state clearing.
- `checkout-surge-opus/apps/api/src/services/postgres-run-store.ts:90` — unguarded `markFailed` update.
- `checkout-surge-opus/apps/api/src/services/traffic-run-launcher.ts:35` — launcher has launch only, no abort surface.

#### Verdict rationale

The compared reset preserves history and cleans Redis thoroughly, but it cannot actually stop the load run and has a race that can make a durable run row disagree with its immutable summary. The baseline's abort and guarded updates are the more important recovery guarantees. `worse`.

---

### C48 — Traffic-delivery classification & unexpected-response enforcement (worse)

#### Reference behavior

The baseline classifies every buy response inside the generated k6 script from machine-readable outcome/reason headers, without relying on response bodies. It increments custom counters for accepted reservations, sold-out rejections, and unexpected responses, and declares a k6 threshold that fails the traffic process on any unexpected response. API-side delivery grading then reconciles the raw k6 facts with tight shortfall thresholds: zero shortfall is `complete`, up to 1% is `warning`, up to 5% is `degraded`, beyond that fails the run. Completed runs require valid traffic evidence; otherwise the run eventually fails with a traffic-summary timeout rather than inventing a successful delivery record.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:59` — k6 threshold fails on any unexpected response.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:111` — header-based accepted / sold-out / unexpected classification.
- `checkout-forge/apps/api/src/services/traffic-delivery-classifier.ts:3` — 1% / 5% shortfall thresholds.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:715` — any unexpected response fails the run.

#### Compared behavior

The compared generated script defines no custom outcome counters and reads no outcome headers. It treats all 2xx responses and all 409 responses as expected, so secured reservations and sold-out rejections do not inflate `http_req_failed`, but neither do unexpected 409s such as idempotency conflicts or ineligible-run errors. API-side grading combines delivered/scheduled ratio and generic HTTP failure rate, taking the worse grade. That two-dimensional structure is cleaner than the baseline's shortfall-only API classifier, but its tolerances are loose: `complete` allows up to 1% unexpected responses, `degraded` allows up to 25%, and a degraded run still finalizes `completed`. When no HTTP summary is available, grading returns `complete` with null measured figures.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-script.ts:124` — blanket `expectedStatuses` for all 2xx and 409 responses, no custom counters.
- `checkout-surge-opus/packages/contracts/src/load.ts:126` — completion summary has generic HTTP facts, not accepted/sold-out/unexpected counters.
- `checkout-surge-opus/apps/api/src/services/grade-traffic-delivery.ts:22` — ratio and failure-rate thresholds.
- `checkout-surge-opus/apps/api/src/services/grade-traffic-delivery.ts:76` — missing HTTP summary grades `complete`.

#### Verdict rationale

The compared design has a good high-level shape, but the semantics are too permissive for the spec's correctness story. The traffic layer cannot distinguish a valid sold-out 409 from a key-collision/idempotency-conflict 409, generic failures can be present in a `complete` or `completed` run, and missing traffic evidence can still produce a completed history record. The baseline fails loudly on all of those cases and keeps an explicit outcome breakdown. `worse`.

---

### C49 — Lifecycle decomposition & testability architecture (better)

#### Reference behavior

The baseline decomposes lifecycle responsibilities into creation, start, finalization, terminal-summary writing, recovery, startup reconciliation, and preset management, sharing one terminal-summary writer. Some services still self-instantiate concrete defaults when collaborators are not injected, optional collaborators can silently reduce summary content, and the finalization service is large enough to mix decision logic, accounting, and persistence orchestration.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:110` — constructor self-instantiates default collaborators.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:293` — optional Redis silently nulls terminal inventory snapshot content.

#### Compared behavior

The compared implementation uses consistent ports-and-adapters boundaries across start, completion ingest, finalization, summary writing, reset, startup reconciliation, preset service, and cleanup. Services depend on narrow interfaces (`RunStore`, `FinalizationReader`, `RunSummaryWriter`, `RunSaleEligibility`, `PresetConfigSource`), domain errors are defined on ports, clocks/id generators are injected, guard semantics are encoded in return values, and units stay smaller. Lifecycle behavior has dedicated unit and integration/API suites.

**References:**
- `checkout-surge-opus/apps/api/src/services/run-store.ts:78` — lifecycle write port with guard semantics.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:21` — narrow structural interfaces for testable workflow orchestration.
- `checkout-surge-opus/apps/api/src/services/run-store.ts:15` — domain error defined on the port, not the adapter.

#### Verdict rationale

Both codebases have the right lifecycle decomposition. The compared implementation is cleaner engineering in this layer: fewer hidden dependencies, less optional silent degradation, explicit port contracts, deterministic collaborators, and smaller services. `better`.

---

## Asynchronous order pipeline & downstream resilience

### C50 — Queue topology, producer discipline & job hand-off (same)

#### Reference behavior

The baseline runs two BullMQ queues: `orders:process` for API-to-worker order processing and a simulated-notification queue produced and consumed by the worker. The order-process producer validates every payload against the shared contract before enqueueing, uses `jobId = orderId` so repeated enqueue attempts collapse to one job, and bounds completed and failed job retention to the last 1000. Redis connection options are parsed through a shared helper, with the worker using BullMQ's required `maxRetriesPerRequest: null` setting.

**References:**
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:57` — validated enqueue with `jobId: orderId`.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:137` — default job options and 1000/1000 retention.
- `checkout-forge/apps/worker/src/queues/simulated-notification-queue.ts:52` — notification enqueue keyed by order/email.
- `checkout-forge/apps/worker/src/queues/order-process-worker.ts:114` — worker Redis connection options with BullMQ-safe retry setting.

#### Compared behavior

The compared implementation has the same two-queue topology: `orders:process` (physical `orders-process`) and `notifications:record`. It also uses `jobId = orderId` for idempotent hand-off, but validates the payload at the consumer boundary rather than in the producer because the producer is called from an already-typed buy workflow. Completed-job retention is bounded to 1000 with an explicit surge-growth rationale; failed jobs are deliberately retained for operator visibility. The worker composition root creates separate Redis connections for order consumption, notification consumption, notification production, and live-state publishing, with comments documenting why blocking consumer connections should not be shared with producers.

**References:**
- `checkout-surge-opus/apps/api/src/services/order-process-queue.ts:74` — `jobId = orderId` idempotent hand-off.
- `checkout-surge-opus/apps/api/src/services/order-process-queue.ts:26` — completed retention bound with surge rationale.
- `checkout-surge-opus/apps/worker/src/adapters/order-process-worker.ts:62` — consumer-boundary payload validation.
- `checkout-surge-opus/apps/worker/src/index.ts:59` — dedicated Redis connections per worker role.

#### Verdict rationale

Both implementations deliver the required queue topology, idempotent job identity, contract validation at a meaningful pipeline boundary, and bounded completed-job growth. The baseline validates earlier and bounds failed-job retention too; the compared implementation is more explicit about connection hygiene and intentionally keeps failed jobs visible. These are reasonable trade-offs with no meaningful product difference, so the verdict is `same`. API-side publish failure handling remains C35.

---

### C51 — Order lifecycle transitions & ERP attempt-history fidelity (same)

#### Reference behavior

The baseline worker drives `queued -> processing -> confirmed | failed`, writing each status transition and its order event in a transaction. `markProcessing` performs an in-transaction check-and-set so only a `queued` order advances, terminal redeliveries are skipped, and every confirmation outcome writes an append-only ERP attempt row with latency, HTTP status, terminality, and distinct `timed_out` status for timeouts. Two fidelity caveats are that an open-circuit rejection is recorded as a failed ERP attempt even though no ERP call happened, and unexpected worker-side failures are also written as ERP attempts, which conflates downstream behavior with worker faults.

**References:**
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:62` — transactional check-and-set to `processing`.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:106` — terminal-order skip on redelivery.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:201` — failed/timed-out ERP attempt recording.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:128` — worker-side throw recorded as an ERP attempt.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:34` — circuit-open rejection enters attempt history.

#### Compared behavior

The compared implementation implements the same lifecycle with transactional row-and-event writes. Its attempt recorder sits inside the ERP-backed confirmation path, so attempts are recorded for actual outbound calls only: confirmed, business rejected, HTTP error, timeout, or unreachable host. Circuit-open deferrals and worker-side faults do not create phantom attempt rows. Business rejection fails the order immediately as non-retryable, while exhausted transient retries fail with stable `erp_retries_exhausted`. The main weakness is that the processing status check happens before the transaction: an already-loaded `queued` order is then unconditionally marked processing, so a rare concurrent duplicate delivery could double-write `order.processing` where the baseline's transaction-level guard would not.

**References:**
- `checkout-surge-opus/apps/worker/src/services/order-confirmation.ts:94` — attempt recorded around each actual ERP call.
- `checkout-surge-opus/apps/worker/src/services/order-confirmation.ts:197` — timeout/unreachable/HTTP error taxonomy.
- `checkout-surge-opus/apps/worker/src/services/process-order-service.ts:109` — terminal-order skip and queued-only processing path.
- `checkout-surge-opus/apps/worker/src/services/process-order-service.ts:251` — `erp_retries_exhausted` terminal failure.
- `checkout-surge-opus/apps/worker/src/adapters/postgres-order-progress-store.ts:44` — transactional row/event writes with caller-side status check.

#### Verdict rationale

Both satisfy the spec's lifecycle and append-only attempt-history requirements, including monotonic attempt uniqueness and distinct timeout status. The compared implementation has a more truthful "ERP attempts are actual ERP calls" model; the baseline has a stronger transaction-level guard against duplicate processing transitions. Those strengths offset each other under BullMQ's normal per-job locking, so this remains `same`.

---

### C52 — Run-scoped backpressure & retry-policy application (worse)

#### Reference behavior

The baseline applies the run snapshot's backpressure configuration across the async pipeline. Retry policy is resolved from the run snapshot at enqueue time, so attempts and backoff travel with the job; the worker also uses the same snapshot to decide max-attempt terminality. Worker concurrency is applied dynamically, ERP request timeout comes from the run's backpressure config, and the circuit breaker is instantiated per run with snapshot thresholds.

**References:**
- `checkout-forge/apps/api/src/index.ts:68` — run-scoped job-options resolver wired into the producer.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:153` — snapshot retry policy mapped to BullMQ attempts/backoff.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:282` — max attempts resolved from run backpressure config.
- `checkout-forge/apps/worker/src/clients/mock-erp-client.ts:44` — per-run ERP request timeout override.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:70` — per-run breaker thresholds.
- `checkout-forge/apps/worker/src/index.ts:101` — active-run concurrency poller.

#### Compared behavior

The compared run snapshot carries run-scoped ERP behavior, but its backpressure block contains only optional `workerConcurrency`. A per-job `RunConcurrencyController` reads that value from the cached run snapshot and mutates the BullMQ worker's concurrency, falling back to the configured default for catalog or unset runs. Retry attempts/backoff are global API environment defaults applied as queue default job options, and ERP timeout plus breaker thresholds are global worker environment configuration. A run therefore cannot vary retry cadence, request timeout, or breaker behavior.

**References:**
- `checkout-surge-opus/packages/contracts/src/demo.ts:29` — backpressure schema is `workerConcurrency` only.
- `checkout-surge-opus/apps/worker/src/services/run-concurrency-controller.ts:40` — per-job run-scoped concurrency application.
- `checkout-surge-opus/apps/api/src/services/order-process-queue.ts:62` — global retry policy as queue default options.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:194` — retry policy sourced from environment.
- `checkout-surge-opus/apps/worker/src/runtime/config.ts:85` — timeout and breaker thresholds are global worker config.

#### Verdict rationale

C9 already grades the contract-level narrowing of the backpressure vocabulary; this topic grades whether the worker actually applies the run snapshot. The baseline covers all mandated knobs: concurrency, timeout, breaker thresholds, and retry policy. The compared implementation cleanly applies one of the four and handles run-scoped ERP behavior elsewhere, but most of the per-run backpressure surface is absent. That is a genuine spec gap, so `worse`.

---

### C53 — Circuit breaker semantics & cooperation with queue retries (better)

#### Reference behavior

The baseline uses a consecutive-failure circuit breaker with a threshold of five and a 10 second reset window. Its half-open state admits every concurrent caller after the first one flips `open` to `half_open`, so a struggling ERP can receive many simultaneous probes. An open-circuit decision is returned as a retryable rejection, recorded as a failed ERP attempt, and rethrown, consuming BullMQ attempts; with default three attempts and one-second backoff against a 10 second reset window, an order can exhaust retries during an outage without reaching the ERP. Worker health exposes the real breaker snapshot, but the API-side resilience status infers only `open` or `unknown` from recent synthetic attempt rows.

**References:**
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:30` — half-open admits concurrent callers.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:34` — open circuit returns retryable rejection.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:222` — retryable rejection rethrown and consumes attempts.
- `checkout-forge/apps/api/src/services/erp-resilience-status-service.ts:72` — API state inferred from attempt rows.

#### Compared behavior

The compared breaker holds a `probeInFlight` reservation so exactly one half-open probe is admitted. Open-circuit denial throws before the confirmation client runs, so no ERP call and no attempt row occur. The queue adapter moves the job to a delayed state with the lock token and throws BullMQ's `DelayedError`, which parks the job without incrementing `attemptsMade`; the wake-up delay is based on the breaker's retry window, or a short probe delay when another half-open probe is already in flight. Deferral also publishes a live `order.delayed` signal. Breaker state is published to Redis only on genuine transitions, including a `probeAt` timestamp, so the API can read the worker's actual breaker state rather than infer it from attempt history.

**References:**
- `checkout-surge-opus/apps/worker/src/services/circuit-breaker.ts:49` — single-probe half-open reservation.
- `checkout-surge-opus/apps/worker/src/services/circuit-breaking-order-confirmation.ts:74` — denial before ERP call or attempt row.
- `checkout-surge-opus/apps/worker/src/adapters/order-process-worker.ts:67` — `moveToDelayed` plus `DelayedError`.
- `checkout-surge-opus/apps/worker/src/services/process-order-service.ts:134` — circuit-open deferral and live signal.
- `checkout-surge-opus/apps/worker/src/services/circuit-breaking-order-confirmation.ts:111` — transition-only state publication with `probeAt`.

#### Verdict rationale

The compared implementation fixes the two breaker failure modes that matter most under outage: unbounded half-open probes and burning retry attempts while the breaker is open. It also makes operator-visible breaker state real rather than inferred. The baseline's per-run breaker thresholds are better, but that is charged in C52; on breaker mechanics and queue cooperation, the compared implementation is clearly `better`.

---

### C54 — At-least-once discipline & idempotent consumption (better)

#### Reference behavior

The baseline handles ordinary redelivery by skipping terminal orders, using a check-and-set for the processing transition, and retrying missing durable order rows until attempts exhaust. Its hardest gap is the crash-after-ERP-success window: if the worker or database write fails after a successful ERP call but before `confirmed` is durable, redelivery sees the order as still `processing` and calls the mock ERP again. The mock ERP treats every request independently, so the order can be fulfilled twice; depending on BullMQ attempt numbering, the duplicate ERP attempt row can then collide with `(orderId, attemptNumber)`.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:106` — terminal-order redelivery skip.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:91` — missing order throws and retries.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:52` — ERP re-processes each request without order memory.

#### Compared behavior

The compared worker handles redelivery explicitly. Missing durable orders are logged loudly and acknowledged because retrying cannot recreate them. An already-`processing` order resumes at confirmation without re-emitting `order.processing`. The crash-after-ERP-success window is closed at the dependency: the mock ERP stores a first-write-wins confirmation ledger per order and replays the stored result, including the same ERP reference, before applying any chaos decision. That means redelivery after a successful confirmation does not produce a second fulfillment even during a later outage. The same pattern carries into notifications: recording is idempotent and live counters move only when a new row was actually inserted.

**References:**
- `checkout-surge-opus/apps/worker/src/services/process-order-service.ts:91` — missing order logged and acknowledged.
- `checkout-surge-opus/apps/worker/src/services/process-order-service.ts:117` — already-processing orders resume at confirmation.
- `checkout-surge-opus/apps/mock-erp/src/services/erp-confirmation-service.ts:73` — confirmation ledger replay before chaos.
- `checkout-surge-opus/apps/mock-erp/src/services/confirmation-ledger.ts:29` — first-write-wins per-order memory.

#### Verdict rationale

Both implementations have the common at-least-once protections: terminal skip, stable job identity, and idempotent notification recording. The compared implementation additionally addresses the two hard cases: poison/orphan jobs and crash-after-ERP-success. Its ERP ledger makes the simulated downstream dependency idempotent in the way a real order backend would need to be. That is materially stronger, so `better`.

---

### C55 — Post-confirmation notification pipeline (better)

#### Reference behavior

After confirmation, the baseline enqueues a simulated-notification job on the second queue with job id `${orderId}-email`; enqueue failure is logged and swallowed so the confirmed order is not failed. The consumer records the notification transactionally, guarded by a confirmed-order check and existing-row check, and writes a durable `notification.recorded` event. It does not publish a realtime dashboard event or live counter.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:257` — best-effort notification enqueue.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:149` — confirmed-only idempotent record with durable event.

#### Compared behavior

The compared implementation mirrors the second queue and best-effort enqueue, including an explicit rationale that retrying the confirmed order would skip processing and never re-enqueue the notification. Its consumer reloads the durable order instead of trusting copied job fields, applies the confirmed-only guard, and writes the notification row plus durable event in one idempotent transaction. When the row is newly inserted, it also bumps the run-scoped live `notificationsRecorded` aggregate and publishes a `notification.recorded` realtime event, so live dashboard counts remain dedup-correct under redelivery.

**References:**
- `checkout-surge-opus/apps/worker/src/services/process-order-service.ts:210` — best-effort hand-off with retry-semantics rationale.
- `checkout-surge-opus/apps/worker/src/services/record-notification-service.ts:52` — reload + confirmed-only guard; live bump only when new.
- `checkout-surge-opus/apps/worker/src/adapters/postgres-notification-recorder.ts:53` — transactional idempotent record plus durable event.
- `checkout-surge-opus/apps/worker/src/adapters/redis-live-order-outcome-publisher.ts:88` — live count and realtime event publication.

#### Verdict rationale

Both satisfy the durable notification requirement and keep notification failure from poisoning confirmed orders. The compared implementation adds useful live observability and avoids trusting potentially stale job-payload copies for order attribution, while preserving idempotency. The margin is modest but real: `better`.

---

### C56 — Mock ERP simulation realism & chaos governance (better)

#### Reference behavior

The baseline mock ERP applies chaos in the order latency, forced outage, TPS limit, then random error, so outage and throttling responses are delayed by the configured latency. TPS limiting is a sliding one-second window scoped by run when run behavior is supplied, but per-run scope entries are not pruned for the process lifetime. Run behavior is transported in a base64url-encoded JSON header from the worker. Chaos settings are env-seeded, live-updatable through token-protected endpoints, and validated against admin safety caps, but cap-violation status/code selection depends on string-matching error messages in the server error handler.

**References:**
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:56` — latency before outage/TPS/error decisions.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:126` — sliding-window TPS scopes with no pruning.
- `checkout-forge/apps/worker/src/clients/mock-erp-client.ts:57` — run behavior transported via encoded header.
- `checkout-forge/apps/mock-erp/src/server.ts:242` — cap violations classified by error-message matching.

#### Compared behavior

The compared mock ERP applies outage, TPS, and error before latency where appropriate: outage and throttle fail fast, while processed confirmations and transient errors bear configured latency. TPS limiting is a fixed one-second window per run/global scope; it is less precise across boundaries than a sliding window, but stale scopes are pruned so memory stays bounded. Run behavior travels as a schema-validated `erp` field in the request body. Chaos controls are env-seeded and live-updatable behind a service token, with a dedicated store that rejects cap violations as structured HTTP 422 errors instead of relying on string matching. Failure responses use stable 503/429 codes that the worker maps through the shared error-payload contract. The confirmation ledger from C54 also makes the mock downstream more realistic for at-least-once processing.

**References:**
- `checkout-surge-opus/apps/mock-erp/src/services/erp-behavior.ts:60` — fail-fast outage/TPS and request-body run override.
- `checkout-surge-opus/apps/mock-erp/src/services/tps-limiter.ts:26` — fixed-window per-scope limiter with stale-scope pruning.
- `checkout-surge-opus/apps/mock-erp/src/services/chaos-control-store.ts:52` — typed cap validation with structured violations.
- `checkout-surge-opus/apps/mock-erp/src/services/erp-confirmation-service.ts:92` — stable 503/429 outcome mapping.

#### Verdict rationale

Both implementations expose the required chaos knobs and run-scoped behavior. The baseline's sliding TPS window is more precise than the compared fixed window, which can admit boundary bursts, but the compared implementation is stronger on fail-fast realism, bounded limiter state, contract-native run-behavior transport, typed cap validation, stable error handling, and idempotent confirmation replay. On balance, `better`. Authorization for chaos-control endpoints is covered in C94.

---

### C57 — Consistency-lag measurement (same)

#### Reference behavior

The baseline measures consistency lag per confirmed order from the job's enqueue timestamp to ERP confirmation completion, clamps it at zero, and immediately emits a `dashboard.metric.observed` realtime event named `order.consistency_lag` with order/offer dimensions. Its dashboard snapshot also recomputes a run-scoped lag projection from durable confirmed orders in the current run or offer: confirmed count, average, latest, and p95. Run scoping prevents a fresh run from showing the previous run's lag, but the snapshot read is unbounded over every confirmed order in scope.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:181` — per-confirmed-order lag metric emitted to realtime.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:288` — enqueue-to-confirmation lag calculation.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:141` — run-scoped durable lag projection over all confirmed orders in scope.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:281` — scope filter fails closed when no run/offer context exists.

#### Compared behavior

The compared implementation derives lag on read from durable `queuedAt -> confirmedAt` order timestamps over the 100 most recent confirmed orders globally, then summarizes sample size, average, p50, p95, max, last lag, and last-confirmed timestamp using deterministic nearest-rank percentiles. The projection is exposed through the API and included in recovery reads. It survives process restarts and Redis resets because it is DB-derived, and it is bounded and index-friendly, but it is poll-cadence rather than event-cadence and is not run-filtered, so a fresh run can temporarily include samples from the previous run until new confirmations displace them.

**References:**
- `checkout-surge-opus/apps/api/src/services/consistency-lag-reader.ts:14` — bounded latest-100-confirmed sample.
- `checkout-surge-opus/apps/api/src/services/consistency-lag-reader.ts:44` — durable lag samples over recent confirmed orders.
- `checkout-surge-opus/apps/api/src/services/consistency-lag-reader.ts:73` — nearest-rank p50/p95 calculation.
- `checkout-surge-opus/packages/contracts/src/consistency-lag.ts:15` — consistency-lag summary contract.

#### Verdict rationale

Both measure the same meaningful endpoint, enqueue-to-confirmation, from durable order timestamps somewhere in the system. The baseline wins on run isolation and push immediacy; Opus wins on bounded read cost, restart-proof recovery, and richer percentile/max statistics. The cross-run bleed is a real display flaw, while the baseline's unbounded run scan is a real polling-cost flaw. These trade-offs offset, so `same`. Dashboard rendering is covered in C75-C84; the broader push-vs-poll delivery pattern is C61.

---

### C58 — Worker runtime: readiness, shutdown & configuration (better)

#### Reference behavior

The baseline validates worker configuration at startup with Zod and uses the shared defaults for ERP timeout, breaker threshold/reset, concurrency, and pool size, but it also supplies localhost fallbacks for database, Redis, and ERP URLs. A worker started without those environment variables silently points at local infrastructure. Readiness reports whether URLs are configured, whether BullMQ workers report `isRunning()`, and the breaker snapshot. Shutdown closes workers, publishers, and the PostgreSQL client on SIGINT/SIGTERM.

**References:**
- `checkout-forge/apps/worker/src/config.ts:16` — localhost fallbacks for infrastructure URLs.
- `checkout-forge/apps/worker/src/index.ts:113` — readiness based on URL presence and `isRunning()`.
- `checkout-forge/apps/worker/src/index.ts:146` — shutdown closes workers, publishers, and DB pool.

#### Compared behavior

The compared worker keeps the same overlapping defaults but requires the three infrastructure URLs, failing fast with a named `ConfigError` rather than falling back to localhost. Readiness checks go beyond BullMQ `isRunning()`: each consumer exposes `isBrokerReachable()` using ioredis connection status, explicitly avoiding a PING that could queue forever with `maxRetriesPerRequest: null`. Shutdown is guarded as single-flight and ordered: health server first, then both consumers, then producer queue, Redis connections, database pool, and process exit.

**References:**
- `checkout-surge-opus/apps/worker/src/runtime/config.ts:82` — required infrastructure URLs with fail-fast config error.
- `checkout-surge-opus/apps/worker/src/adapters/order-process-worker.ts:103` — broker-reachability readiness check.
- `checkout-surge-opus/apps/worker/src/index.ts:202` — guarded ordered shutdown sequence.

#### Verdict rationale

Both drain in-flight jobs through BullMQ worker shutdown, but the compared implementation is more operationally honest: missing infrastructure config fails at boot, readiness can detect a stalled Redis-backed consumer that still reports "running", and shutdown stops advertising health before draining. That is `better`.

---

## Realtime observability & dashboard read models

### C59 — SSE endpoint, fan-out topology & backpressure policy (better)

#### Reference behavior

The baseline runs one process-wide Redis subscription per API instance and fans frames out to in-memory browser sinks. Each client gets its own 20 second heartbeat timer. Backpressure is strict no-buffering: the first `write()` returning `false` closes that client's connection, relying on EventSource reconnect plus the recovery read to resynchronize. The stream uses the expected `text/event-stream`, `no-cache, no-transform`, and keep-alive headers; proxy buffering is handled in Caddy rather than directly on the response. Subscriber errors and reconnects are logged and do not crash the stream.

**References:**
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:31` — single process-wide subscription, clients as in-memory sinks.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:74` — SSE headers.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:189` — close-on-first-backpressure policy.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:68` — per-client heartbeat timer.

#### Compared behavior

The compared implementation uses the same shared-subscription topology but decomposes it into a transport-agnostic `DashboardSseHub` and an `HttpSseConnection` adapter. The hub uses one heartbeat timer for all clients, sends an initial connected comment, advertises a browser `retry:` delay, includes `X-Accel-Buffering: no` plus a correlation-id header, and 503s explicitly when Redis is not configured. Backpressure is bounded rather than immediate-drop: each connection pauses when `write()` returns false, resumes on `drain`, and is closed only when its per-connection frame queue exceeds the configured cap. Heartbeat cadence, buffer cap, and retry delay are startup-validated settings; the hub also closes idempotently on shutdown.

**References:**
- `checkout-surge-opus/apps/api/src/services/dashboard-sse-hub.ts:42` — single hub-level heartbeat timer for all connections.
- `checkout-surge-opus/apps/api/src/runtime/sse-connection.ts:45` — pause-on-backpressure and resume-on-drain handling.
- `checkout-surge-opus/apps/api/src/runtime/sse-connection.ts:80` — bounded per-connection frame queue.
- `checkout-surge-opus/apps/api/src/routes/dashboard-routes.ts:37` — stream headers including `X-Accel-Buffering: no`, correlation id, and Redis-absent 503.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:196` — validated SSE heartbeat, buffer cap, and retry-delay config.

#### Verdict rationale

Both avoid per-browser Redis subscriptions and keep memory bounded for slow consumers. Opus is stronger operationally: one heartbeat timer scales better than per-client timers, the `retry:` directive and connected comment make reconnect behavior explicit, `X-Accel-Buffering` makes streaming safer behind proxies, and the bounded queue tolerates transient TCP stalls without unbounded memory. That is a better implementation of the same topology.

---

### C60 — Authoritative recovery read & live-vs-history split (worse)

#### Reference behavior

The baseline's recovery read reconstructs the current run from durable PostgreSQL state plus in-memory live state, preferring the fresher source so a refreshed tab after an API restart can restore full context. The response includes the current run and frozen config, latest traffic metrics, inventory, queue and ERP projections, run outcome aggregates recomputed from durable orders, an order-status list, recent order outcomes, consistency lag, and applied backpressure policy. When the current run has just gone terminal, the matching immutable summary is included so final projections settle from backend truth. Run history otherwise stays on its HTTP-only surface. The cost downside is that the order-status list is unbounded, so recovery on a 10k-order run can return 10k rows.

**References:**
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:58` — durable-vs-in-memory current-run merge.
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:104` — terminal summary included for the just-terminal current run.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:109` — outcome aggregates recomputed from durable orders.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:178` — unbounded per-order status list in the snapshot.

#### Compared behavior

The compared recovery read is a bounded composed read: durable current run with frozen `configSnapshot`, sale-offer tracking, inventory, queue, ERP resilience, consistency lag, and latest per-run traffic metrics from Redis. Each projection degrades independently to a typed `unavailable` resource, so one failing upstream does not blank the whole board, and run history is not promoted into live state. The material gaps are completeness gaps: order-outcome counts exist only as Redis aggregates advanced by `order.*` SSE events and are not in recovery or another read endpoint, so a refresh can zero the outcomes panel until new order events arrive. Also, the current-run query returns only non-terminal runs, so after terminal transition recovery has no equivalent of the baseline's terminal-summary settle read.

**References:**
- `checkout-surge-opus/apps/api/src/services/dashboard-recovery-reader.ts:68` — composed durable run and projection recovery read.
- `checkout-surge-opus/apps/api/src/services/dashboard-recovery-reader.ts:98` — typed per-projection degradation.
- `checkout-surge-opus/apps/api/src/services/demo-run-reader.ts:92` — durable current-run plus frozen config snapshot.
- `checkout-surge-opus/packages/contracts/src/recovery.ts:54` — recovery contract has no order-outcome aggregate field.
- `checkout-surge-opus/apps/web/src/lib/live-dashboard-state.ts:85` — client-side note that outcomes have no recovery baseline.

#### Verdict rationale

Opus's recovery read is cleaner and cheaper: bounded, restart-safe for the current run, and resilient to partial projection failures. But the authoritative recovery path is less complete: it cannot restore the order-outcomes panel and it does not carry the just-terminal summary used to settle final projections from backend truth. The spec prioritizes recovery correctness after refresh/reconnect; losing that context outweighs the engineering polish, so `worse`.

---

### C61 — Live delivery of run status & traffic metrics (worse)

#### Reference behavior

When the load orchestrator streams a metric batch, the baseline API immediately pushes one `load.run.updated` event and one `dashboard.metric.observed` event per traffic metric to browsers. Spectators see request rate, latency, failure rate, and run-state transitions at ingestion cadence without polling. The API also maintains latest traffic metrics in process memory for recovery and throttles durable live-run-state writes to at most one per second per run. The trade-off is that latest-metrics recovery state is lost on API restart until the next batch arrives.

**References:**
- `checkout-forge/apps/api/src/services/load-metric-stream-service.ts:64` — `load.run.updated` pushed on every ingested batch.
- `checkout-forge/apps/api/src/services/load-metric-stream-service.ts:82` — traffic metrics pushed as `dashboard.metric.observed` events.
- `checkout-forge/apps/api/src/services/load-metric-stream-service.ts:44` — durable live-run-state writes throttled to 1 s.
- `checkout-forge/apps/api/src/services/dashboard-recovery-state-service.ts:19` — latest traffic metrics held in process memory.

#### Compared behavior

The compared metric-ingestion endpoint writes forwarded samples into a per-run Redis latest-metrics hash and does not publish dashboard events for traffic metrics or run status. Its event-name enum has no run-lifecycle or metric event counterpart. Live delivery of request surge, queue depth, consistency lag, and run status therefore depends on the web client polling recovery every 2.5 seconds. The Redis projection is more durable than the baseline's process-memory map and survives API restarts, but each open tab re-executes the multi-store recovery composition throughout the surge: PostgreSQL run read, Redis reads, BullMQ queue calls, ERP-attempt query, and consistency-lag query.

**References:**
- `checkout-surge-opus/apps/api/src/services/load-metrics-ingest.ts:24` — metric ingestion writes only the Redis projection.
- `checkout-surge-opus/packages/db/src/load-metrics.ts:44` — latest-observation-per-metric Redis hash.
- `checkout-surge-opus/packages/contracts/src/enums.ts:80` — no run-lifecycle or traffic-metric event exists.
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:43` — 2.5 s recovery poll as delivery mechanism.
- `checkout-surge-opus/apps/api/src/services/dashboard-recovery-reader.ts:77` — multi-store recovery composition re-run by polls.

#### Verdict rationale

The baseline uses SSE for live observability and recovery for resynchronization. Opus inverts that for major signals, making recovery polling the delivery channel for run status and traffic metrics. The Redis latest-metrics projection is a real durability improvement, but the product is visibly less live and observer count now multiplies backend read load during the surge window. Missing push delivery for headline signals is `worse`.

---

### C62 — Queue status projection (same)

#### Reference behavior

The baseline exposes a BullMQ queue-health projection with depth (`waiting + delayed`), waiting/active/delayed/failed/completed counts, retrying-job detection, oldest-waiting age, and failed-job details. The response is contract-validated and each observation is logged.

**References:**
- `checkout-forge/apps/api/src/services/queue-health-service.ts:29` — queue depth, counts, retrying detection, oldest wait, and failed jobs.

#### Compared behavior

The compared implementation exposes the equivalent queue status surface: waiting/active/delayed/failed/completed counts, `queueDepth` as waiting plus delayed, oldest-waiting age from the head-of-line job, and a bounded recent-failures window. It lacks the baseline's distinct retrying-job detector, but delayed count is still available as a retry-pressure signal and the ERP resilience projection carries retry pressure more explicitly.

**References:**
- `checkout-surge-opus/apps/api/src/services/order-process-queue.ts:77` — queue health read with counts, depth, oldest wait, and recent failures.

#### Verdict rationale

Both implementations expose the queue state needed for the live dashboard and recovery read. The baseline has a slightly richer retrying-job flag; Opus keeps the core projection bounded and composes retry pressure into the ERP panel. No spec-required queue visibility is absent, so `same`. Inventory status projection details remain C32.

---

### C63 — ERP resilience projection & breaker visibility (better)

#### Reference behavior

The baseline worker owns a correct circuit breaker snapshot, but the dashboard-facing API projection does not consume it. Instead, the API infers circuit state from recent durable `erp_attempts`: a recent `erp_circuit_open` row means `open`, otherwise the state is `unknown`, and `nextRetryAt` is always `null`. Health classification is a heuristic over a 60 second attempt window plus queue retry pressure. Operators therefore cannot see `closed`, `half_open`, or a recovery countdown on the dashboard surface, even though the worker health port has the real facts.

**References:**
- `checkout-forge/apps/api/src/services/erp-resilience-status-service.ts:72` — API circuit state inferred as `open` or `unknown`, `nextRetryAt: null`.
- `checkout-forge/apps/api/src/services/erp-resilience-status-service.ts:101` — heuristic health from windowed attempts and queue pressure.
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:62` — real breaker snapshot exists in the worker.
- `checkout-forge/apps/worker/src/index.ts:130` — breaker snapshot exposed only on worker health readiness.

#### Compared behavior

The compared worker publishes real breaker state to Redis on transitions, and the API resilience read composes that actual state with queue retry pressure and recent confirmation-delay statistics. The projection includes closed/open/half_open state, consecutive failures, reported-at time, and computed `retryAfterMs` until the next probe. Health classification is a pure function over real breaker facts: open is unavailable, half-open degraded, closed-but-failing degraded, and missing reports unknown.

**References:**
- `checkout-surge-opus/apps/worker/src/services/circuit-breaking-order-confirmation.ts:122` — worker publishes breaker state to Redis on transition.
- `checkout-surge-opus/apps/api/src/services/erp-resilience-reader.ts:80` — API composes real circuit state, retry pressure, and confirmation delay.
- `checkout-surge-opus/apps/api/src/services/erp-resilience-reader.ts:88` — retry-after computed from the published probe time.
- `checkout-surge-opus/apps/api/src/services/erp-resilience-reader.ts:38` — pure health classification from circuit facts.

#### Verdict rationale

C53 already grades the breaker mechanics and queue cooperation; this topic grades the operator-facing read model. On that surface Opus is clearly stronger: it shows the real worker breaker state and recovery timing rather than inferring a partial state from attempt rows. `better`.

---

### C64 — API health & readiness endpoints (better)

#### Reference behavior

The baseline API has `/health/live` for process liveness and `/health/ready` with a real database `select 1` probe. Redis readiness, however, checks only that a URL is configured, not that Redis is reachable; a live Redis outage can leave the API reporting ready even though no buy request can secure a reservation. Worker readiness is stronger and is covered in C58.

**References:**
- `checkout-forge/apps/api/src/routes/health.ts:22` — Redis readiness is URL-configured only.
- `checkout-forge/apps/api/src/routes/health.ts:39` — real database readiness probe.
- `checkout-forge/apps/worker/src/index.ts:117` — worker readiness covers config, breaker state, and consumer-loop liveness.

#### Compared behavior

The compared API readiness probes database, Redis, and queue dependencies with explicit fatal/degraded semantics. Database unreachable is fatal, Redis configured-but-unreachable is fatal because the hot reservation path cannot operate without it, and queue probe failure is degraded because reads can still work. Its worker readiness additionally detects the stalled-but-running BullMQ consumer case by checking broker reachability, as covered in C58.

**References:**
- `checkout-surge-opus/apps/api/src/services/readiness.ts:46` — Redis is actually probed and unreachable Redis is fatal.
- `checkout-surge-opus/apps/api/src/services/readiness.ts:60` — queue probe is a deliberate non-fatal degraded signal.
- `checkout-surge-opus/apps/worker/src/services/readiness.ts:18` — stalled-consumer detection via broker reachability.

#### Verdict rationale

Opus's readiness endpoints better reflect demo readiness rather than configuration presence. In particular, it closes the baseline's most consequential false-positive: reporting an API ready while Redis, the stock gate authority, is unreachable. That is `better`.

---

## Load generation & benchmark measurement

### C65 — Traffic-mode to k6 execution mapping & VU sizing (same)

#### Reference behavior

The baseline maps buyer-spike traffic to `per-vu-iterations`, with one VU per buyer and two iterations in duplicate mode, and maps steady arrival traffic to `constant-arrival-rate`. Steady-arrival VU pools are derived from the requested rate (roughly rate for pre-allocated VUs and 2x rate for max VUs), clamped to the 10k cap, with admin overrides reconciled so max VUs never falls below pre-allocated VUs. Each generated scenario sets a 5 second `gracefulStop`, and numeric inputs are defensively rounded before reaching k6.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:149` — generated scenarios for buyer-spike and steady-arrival modes.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:207` — steady-arrival VU derivation and cap/override reconciliation.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:238` — buyer-spike plan with one VU per buyer and duplicate iterations.

#### Compared behavior

The compared implementation uses the same executor mapping: buyer-spike becomes `per-vu-iterations` with buyer-count VUs and duplicate-mode double iterations, while steady arrival becomes `constant-arrival-rate` with automatic VU sizing and optional advanced-VU overrides. Its orchestrator does not locally clamp VUs to 10k and does not set `gracefulStop`, so it relies on upstream API hard-cap validation and k6's default 30 second graceful stop. The traffic config is a discriminated Zod union with integer/positivity constraints, and advanced VU overrides must supply both pre-allocated and max VUs together.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-script.ts:58` — both executor mappings and automatic VU sizing.
- `checkout-surge-opus/packages/contracts/src/load.ts:24` — discriminated traffic config schemas.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:143` — upstream environment hard caps for buyers, requests, RPS, duration, and VUs.

#### Verdict rationale

Both implementations deliver the promised traffic shapes: a real one-VU-per-buyer spike and scheduled-iterations-per-second steady arrival, with admin-level VU control. The baseline is more defensive inside the orchestrator; Opus depends on API-side caps that do exist and has a cleaner contract shape for overrides. The differences are robustness details rather than fidelity gaps, so `same`.

---

### C66 — Generated k6 script materialization & injection safety (same)

#### Reference behavior

The baseline generates a temporary k6 script and spawns k6 with an argument array rather than a shell string. Dynamic values enter the script through `JSON.stringify`, so IDs, URLs, paths, and headers stay JSON literals instead of executable code. Temporary files are cleaned up in a `finally` block.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:64` — dynamic values serialized into the script with `JSON.stringify`.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:258` — temp-directory script materialization and cleanup.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:313` — k6 spawned with argv, not shell interpolation.

#### Compared behavior

The compared implementation follows the same pattern: generated options and runtime parameters are embedded as JSON literals, k6 is launched with an argument array from a fresh temp directory, and temp files are removed after the run. It also includes a unit test proving a hostile `buyEndpointPath` is escaped as data rather than interpreted as code.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-script.ts:110` — script template injects `PARAMS` and options as JSON literals.
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-runner.ts:94` — argv-based spawn and temp-dir lifecycle.
- `checkout-surge-opus/apps/load-orchestrator/test/unit/k6-script.test.ts:132` — hostile-string escaping regression test.

#### Verdict rationale

Both implementations use the right script-generation discipline: structured serialization plus argv spawning. Neither exposes a meaningful injection path for run-controlled values. Opus has the more explicit regression test, but behavior is equivalent, so `same`.

---

### C67 — Attempt identity: idempotency keys & correlation IDs (same)

#### Reference behavior

The baseline derives idempotency keys deterministically from the run and iteration identity. Buyer-spike keys are per buyer, so duplicate mode reuses the same key for the duplicate attempt; steady-arrival keys are per global iteration. Correlation IDs remain distinct per attempt, including duplicates. A guard drops over-scheduled steady-arrival iterations beyond the planned attempt count, and each request carries the run ID for API attribution.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:173` — per-mode idempotency-key and correlation-ID derivation.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:87` — request body and headers include idempotency key, correlation ID, and load-run ID.

#### Compared behavior

The compared script uses the same identity model with different index sources: buyer-spike keys are per VU, duplicate iterations of the same VU reuse the key, and steady-arrival keys are per scenario iteration. Keys include the run ID, avoiding cross-run collisions, and correlation IDs combine iteration and VU identity so duplicate attempts remain individually traceable. Requests include `quantity: 1`, `runId`, `saleOfferId`, and the `x-load-run-id` header. There is no over-scheduled-iteration guard, but the k6 executor bounds scheduled work and any missing work appears as `dropped_iterations`.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-script.ts:128` — per-mode idempotency-key derivation with run-ID scoping.
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-script.ts:143` — per-attempt correlation ID and run-ID header.

#### Verdict rationale

Both satisfy the core discipline: unique key per planned attempt, deliberate reuse only for duplicate-mode replay, run-scoped keys, and distinct correlation IDs per emitted request. The baseline's extra steady-arrival guard improves planned-count exactness, not key correctness. `same`.

---

### C68 — Load-orchestrator live metric aggregation under surge (better)

#### Reference behavior

The baseline reads k6 JSON points from stdout and converts each supported point into one dashboard metric event, then batches those events to the API on a 500 ms flush loop capped at 250 events. At 10k requests in roughly one second, the three point streams can generate around 30k samples, so the unbounded pending buffer can lag far behind the run. Its `http_reqs` adapter emits the configured scheduled rate rather than the observed rate, latency/failure samples are raw per-request points, and the flush `fetch` has no timeout, so a hung API can stall future metric flushing.

**References:**
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:402` — one dashboard metric queued per parsed k6 point.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:436` — unbounded pending buffer with 250-event/500 ms flush cadence.
- `checkout-forge/apps/load-orchestrator/src/metric-adapter.ts:20` — request-rate metric adapted from configured rate.
- `checkout-forge/apps/load-orchestrator/src/api-metric-stream-client.ts:35` — metric POST without request timeout.

#### Compared behavior

The compared implementation writes k6 points to a file and tails it with serialized, chunk-buffered reads, preserving partial lines and avoiding pressure on the k6 process. A pure `TrafficMetricStream` closes one-second windows only after a later watermark appears, deriving actual request rate, mean latency, and failure fraction. That caps live metric output to at most three samples per second per run regardless of request volume, and the final open window is flushed before completion. Forwarding is best-effort with a 5 second timeout. The one naming nit is that the observed request rate is published under the reserved `traffic.scheduled_request_rate` metric name.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-runner.ts:118` — file-tail metric path with final post-exit flush.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-metric-stream.ts:54` — windowing and watermark-based line processing.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-metric-stream.ts:118` — derived per-window rate, latency, and failure fraction.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-reporter.ts:44` — 5 second timeout on metric forwards.

#### Verdict rationale

This grades the generator-side measurement channel, not the API/browser delivery path already covered by C61. On this surface Opus is clearly stronger: bounded aggregation, honest observed rates, back-pressure-safe tailing, and a timed-out forward path beat the baseline's unbounded per-point queue and potentially wedged flush client. `better`.

---

### C69 — Traffic-completion report delivery & accounting depth (worse)

#### Reference behavior

At k6 exit, the baseline assembles a rich completion report: HTTP summary, outcome counters, planned-vs-emitted-vs-observed reconciliation, dropped/completed/unstarted iteration facts, VU-pool usage, timing breakdown, and diagnostics. If the API does not accept the report, the orchestrator retains it and retries on a one-second timer until delivery succeeds, so a transient API outage at exactly the terminal moment does not orphan the run.

**References:**
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:497` — terminal report assembly with HTTP, outcome, delivery, timing, and diagnostics data.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:738` — delivery summary with planned/dropped/unstarted/shortfall reconciliation.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:629` — retained completion report retried until API acceptance.

#### Compared behavior

The compared completion report carries run ID, execution status, exit code, truncated error text, traffic end time, and a generic HTTP summary with totals, failed counts/rates, iterations, dropped iterations, and latency percentiles. API-side grading can derive the core scheduled-vs-delivered shortfall from the frozen config, but the orchestrator sends the completion once with a 5 second timeout and swallows failures after logging. Because the orchestrator also exposes no current-run/status endpoint (see C71), the API cannot re-fetch a lost completion. The report omits the outcome breakdown merged into C48 and the richer timing/diagnostic context covered in C70.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-run-service.ts:139` — lean completion construction.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-reporter.ts:93` — single best-effort completion POST with swallowed failures.
- `checkout-surge-opus/apps/api/src/services/grade-traffic-delivery.ts:39` — API-side scheduled-request derivation and delivery-ratio grading.

#### Verdict rationale

Moving grading to the API is reasonable, and Opus sends enough facts for basic shortfall math. The gap is reliability and depth: the baseline eventually delivers the terminal report and preserves enough detail to explain planned/emitted/observed discrepancies, while Opus can silently lose the one message that lets a run leave its live state and provides less accounting context when it lands. `worse`.

---

### C70 — k6 summary parsing & run diagnostics (worse)

#### Reference behavior

The baseline treats k6 terminal data as fallible and reconciles it from multiple sources. It reads `--summary-export`, falls back to a bounded stdout-tail scan when needed, tolerates both legacy and `values`-wrapped summary layouts, and records per-metric source provenance plus warnings when fallbacks are used. It also captures bounded stderr and environment diagnostics such as process limits, relevant kernel settings, and k6 version, so a degraded high-volume run has explanatory context.

**References:**
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:377` — summary-export read with stdout-tail fallback and warnings.
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:280` — tolerance for multiple summary shapes.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:607` — per-metric source tracking.
- `checkout-forge/apps/load-orchestrator/src/load-run-diagnostics.ts:26` — environment diagnostics collection.

#### Compared behavior

The compared parsers are defensive but single-source. Malformed point lines are ignored safely, and the summary parser accepts the summary-export document, deriving failure count from rate when needed, but a missing or unparseable summary degrades to null/zero values without secondary recovery, provenance, or warning. Failure explanation is a truncated stderr string. Opus mitigates k6 version drift with a real-k6 integration test against its pinned k6 image, and it reports richer latency percentiles than the baseline, but it has less ability to notice and explain parser/summary degradation at runtime.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-output.ts:42` — strict drop-on-malformed point parsing.
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-summary.ts:47` — single-source summary parse with null/zero degradation.
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-runner.ts:85` — missing summary file treated as empty.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-run-service.ts:206` — failure explanation limited to truncated stderr.

#### Verdict rationale

Both parsers are safe in the face of malformed lines, and Opus's real-binary test is valuable. But the baseline makes degraded measurement visible through fallback sources, provenance, warnings, and environment diagnostics. Opus can silently turn missing terminal evidence into nulls that downstream may treat as clean, so its measurement pipeline is less trustworthy under partial failures. `worse`.

---

### C71 — Load-orchestrator process lifecycle control (worse)

#### Reference behavior

The baseline exposes the process controls the rest of the demo needs: readiness probes actual k6 executability with a timeout, a current-run endpoint reports what the orchestrator is running, and a token-guarded abort endpoint validates the requested run before SIGTERMing the child and returning a typed outcome. Spawn errors and crashes still produce traffic reports, overlapping starts are rejected, and async callbacks are guarded by run ID so stale events from an old run cannot mutate the current one.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-readiness.ts:15` — timeout-bounded k6 executability probe.
- `checkout-forge/apps/load-orchestrator/src/server.ts:117` — current-run status and token-guarded start/abort routes.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:201` — abort workflow with run matching and typed outcomes.

#### Compared behavior

The compared orchestrator has a synchronous single-run guard, maps spawn failures to failed completions, cleans up temp directories, and has a stronger readiness probe implementation (TTL-cached, concurrency-collapsed, with a real preset-traffic kill switch). But its HTTP surface is only a start route: no abort/cancel endpoint and no current-run read. An admin reset cannot stop in-flight k6 traffic (the lifecycle consequence is also reflected in C47), and the API has no pollable fallback if the single completion POST is lost (see C69).

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/routes/load-routes.ts:17` — route surface is only POST start.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-run-service.ts:102` — in-memory current-run guard not exposed over HTTP.
- `checkout-surge-opus/apps/load-orchestrator/src/services/k6-binary-probe.ts:25` — TTL-cached, concurrency-collapsed k6 probe.

#### Verdict rationale

Readiness quality is not the problem; Opus's probe is well engineered. The missing controls are the issue. Timeout/cancellation and run visibility are explicit load-orchestrator concerns, and the compared orchestrator cannot stop a running k6 process or answer what it is running. That is materially worse than the baseline's controllable runner. `worse`.

---

### C72 — Run-start ordering & load-control topology (same)

#### Reference behavior

In the baseline, the load orchestrator is the start entry point. Before spawning k6 it reports lifecycle state to the API, establishing the recovery baseline, and aborts the start if the API rejects or is unreachable. The start route validates operator mode and requires the control service token.

**References:**
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:177` — API lifecycle report before spawning k6.
- `checkout-forge/apps/load-orchestrator/src/api-traffic-report-client.ts:47` — lifecycle-report client.
- `checkout-forge/apps/load-orchestrator/src/server.ts:125` — token- and operator-mode-guarded start route.

#### Compared behavior

The compared topology inverts control: the API owns run creation and recovery-baseline establishment, then delegates an already accepted traffic snapshot to the orchestrator. The orchestrator re-validates the snapshot and starts k6 in the background only after synchronous acceptance. That structure satisfies the same ordering by construction. The start route checks a kill switch but does not require a service token; that defense-in-depth gap is covered in C88 rather than changing this topology verdict.

**References:**
- `checkout-surge-opus/apps/api/src/services/traffic-run-launcher.ts:63` — API delegates the accepted traffic snapshot with timeout handling.
- `checkout-surge-opus/apps/load-orchestrator/src/routes/load-routes.ts:18` — snapshot validation and kill switch on start.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-run-service.ts:84` — fire-and-forget k6 execution after synchronous acceptance.

#### Verdict rationale

Both designs ensure k6 does not start before the API has established the run baseline. The baseline uses a reverse lifecycle-report handshake; Opus makes the API the owner and delegates execution after acceptance. The auth asymmetry matters, but it belongs to access protection. For ordering and topology alone, `same`.

---

### C73 — Load-orchestrator configuration & k6 packaging (same)

#### Reference behavior

The baseline validates orchestrator environment at boot with a Zod schema, including port ranges, URL/path shapes, and a required `CONTROL_SERVICE_TOKEN`; invalid config prevents startup. The reference container bakes in a pinned k6 binary so the standard runtime does not depend on host-installed k6.

**References:**
- `checkout-forge/apps/load-orchestrator/src/config.ts:16` — startup env validation with required control token.
- `checkout-forge/apps/load-orchestrator/Dockerfile:1` — pinned k6 image inside the orchestrator container.

#### Compared behavior

The compared implementation uses hand-rolled fail-fast validators for integers, booleans, and URLs and adds useful knobs such as the preset-start kill switch and configurable metrics/completion endpoint paths. Its control service token is optional, logging a warning rather than refusing startup, which aligns with the unguarded control route noted in C72. k6 is also baked into the image, pinned to a newer major version with a documented rationale.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/runtime/config.ts:56` — fail-fast typed config validators.
- `checkout-surge-opus/apps/load-orchestrator/src/runtime/config.ts:45` — optional control token warning behavior.
- `checkout-surge-opus/apps/load-orchestrator/Dockerfile:20` — pinned k6 image in the service container.

#### Verdict rationale

Both meet the operational baseline: malformed config fails fast, and k6 is part of the service image. The baseline is stricter about the secret; Opus has more runtime knobs and a newer pinned k6. Those trade-offs offset for this topic, with the access-control consequence covered in C88. `same`.

---

### C74 — Load-orchestrator test coverage (same)

#### Reference behavior

The baseline has deep load-orchestrator tests over runner, parser, summary, delivery, retry, stderr-bounding, and route behavior, including auth, conflict, and abort surfaces. k6 itself is not spawned in the suite, consistent with treating k6 scenarios as benchmark artifacts rather than correctness tests.

**References:**
- `checkout-forge/apps/load-orchestrator/test/load-orchestrator.test.ts:1` — large unit suite over runner, parser, and summary derivations.
- `checkout-forge/apps/load-orchestrator/test/load-orchestrator-routes.api.test.ts:1` — route tests for auth, conflicts, and abort behavior.

#### Compared behavior

The compared suite is smaller but more granular, with focused unit tests for config, script generation, output/summary parsing, metric windowing, reporter timeout behavior, lifecycle, routes, readiness, and probe caching. It also includes a genuine integration test that launches the real k6 binary against a throwaway HTTP server, asserts parsed traffic samples and succeeded completion, skips when k6 is absent, and can be forced to fail if `REQUIRE_K6=1`.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/test/integration/k6-run.test.ts:23` — real-k6 end-to-end integration test with observable skip/require behavior.
- `checkout-surge-opus/apps/load-orchestrator/test/unit/traffic-metric-stream.test.ts:1` — unit coverage for metric windowing and watermark behavior.

#### Verdict rationale

The baseline tests more of its larger runner surface, especially retry/fallback and abort paths. Opus has cleaner focused tests and the real-k6 integration proof the baseline lacks, which directly reduces parser/version-drift risk. Different strengths, comparable adequacy for each implementation's own surface. `same`.

---

## Web dashboard: frontend architecture & UX surface

### C75 — Browser recovery/realtime protocol correctness (same)

#### Reference behavior

The baseline implements the prescribed browser-side realtime discipline in a dedicated, framework-free coordinator. Recovery runs on connect, manual refresh, and after start/reset. While a recovery fetch is in flight, incoming live events are discarded and a flag is set; the coordinator then loops until it completes a recovery with no discarded events, so stale live events cannot overwrite the fresh authoritative baseline. Terminal `load.run.updated` events trigger one final recovery per run id, settling final projections from backend truth. Failed recoveries surface as a visible "Live sync issue" state and retry on a 3-second scheduler.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:49` — live events discarded while recovery is in flight.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:59` — one-time final recovery per terminal run event.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:91` — follow-up recovery loop when events were discarded.
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:51` — SSE open triggers recovery and events are schema-validated before applying.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:26` — retry scheduler for failed recoveries.

#### Compared behavior

The compared implementation has an equivalent pure `RecoveryCoordinator`: recoveries are serialized and coalesced, `shouldApply()` gates live events during an in-flight fetch, and discards arm a serialized follow-up recovery. The SSE `onopen` handler re-baselines before further live updates. It does not implement the literal terminal-event final recovery; instead, a 2.5-second recovery poll acts as the settlement backstop and also keeps panels that are not fully event-driven fresh. Failed recoveries are swallowed and retried by the next poll rather than shown as a distinct sync issue. As a useful refinement, the reducer clears run-scoped live overlay state when the recovered run identity changes, preventing run-N ticks or order events from contaminating run-N+1.

**References:**
- `checkout-surge-opus/apps/web/src/lib/recovery-coordinator.ts:44` — `shouldApply` discards during recovery and arms a serialized follow-up.
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:43` — 2.5 s recovery poll used as terminal-settlement backstop.
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:94` — `onopen` re-baselines from the authoritative read.
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:71` — failed recovery keeps the last baseline and waits for the next poll.
- `checkout-surge-opus/apps/web/src/lib/live-dashboard-state.ts:146` — live overlay reset on run-identity change.

#### Verdict rationale

Both implementations satisfy the hard browser-client rule already foreshadowed by the backend recovery topic (C60): discard live events during recovery, follow up after discards, and serialize recovery work. The baseline is closer to the spec's exact terminal-event wording and makes failed recovery visible; the compared implementation bounds terminal staleness with polling and adds a direct cross-run overlay reset. These are different trade-offs over the same correctness core, so the frontend protocol verdict is `same`.

---

### C76 — Reconnect & connection-status UX (same)

#### Reference behavior

Connection state is explicit in the baseline UI. Stream handlers set `live` on open and `reconnecting` on error, recovery sets `recovering`, and failed recovery sets a visible "Live sync issue, attempting to recover..." status. The top navigation displays the status, an "Updated HH:MM" chip shows the last observed event time, and a manual Refresh button lets the spectator force recovery.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:51` — open maps to live; error maps to reconnecting.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:95` — failed recovery surfaces a sync-issue status.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:79` — manual Refresh button wired to recovery.

#### Compared behavior

The compared implementation models connection state as a typed `connecting | open | reconnecting` enum rendered as a labelled pulse-dot indicator with a "last event x ago" readout. An `everOpened` flag distinguishes never-connected from dropped streams. There is no manual refresh and no distinct recovery-failure state, but the watch page gets a server-rendered baseline before the client stream attaches, and SSR API failures render degraded panels rather than an error wall.

**References:**
- `checkout-surge-opus/apps/web/src/components/panels.tsx:38` — connection indicator with status label and last-event age.
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:100` — `everOpened` distinguishes connecting from reconnecting.
- `checkout-surge-opus/apps/web/src/app/watch/page.tsx:27` — SSR baseline with degraded fallback when the API is unreachable.

#### Verdict rationale

Both avoid silent staleness for spectators by showing live/reconnecting state. The baseline adds manual refresh and a more explicit sync-issue state; the compared implementation adds a cleaner typed status model, last-event-age feedback, and graceful first paint under API trouble. Neither dominates. `same`.

---

### C77 — Live watch view: gold signals, frozen config & surge storytelling (worse)

#### Reference behavior

The baseline watch page is a rich spectator surface: a lifecycle header, metric tiles for the four gold signals with 24-sample sparklines, help-text tooltips, business outcomes, traffic/lifecycle panels, ERP/queue status, a recent order-event feed, and the spec-mandated "Accepted Configuration" panel rendering the frozen run config snapshot. Planned-attempt displays also annotate duplicate-attempt context.

**References:**
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:96` — gold-signal metric tiles with sparklines and help text.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:174` — frozen "Accepted Configuration" panel from the run snapshot.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:215` — recent order events feed with outcome badges.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:283` — rolling sparkline series builder.

#### Compared behavior

The compared watch page renders a coherent burst narrative with panels for surge, inventory drain, queue depth, ERP health, outcomes, and consistency lag. All four gold signals are genuinely present: live reservations per second over a 15-second window plus sold-out rejections, inventory drain and pending/expired counts, queue backlog and oldest wait, and p50/p95/max lag. But the frozen run configuration is never rendered: recovery carries `configSnapshot`, then the adapter/state drop it, so the run panel shows only preset name, status, and timestamps. There are no sparklines or trend visuals, the tracked `lastOrderEvent` is not rendered, and the page still shows a stale "Load-run controls ... Task 6.4" placeholder even though controls exist elsewhere.

**References:**
- `checkout-surge-opus/apps/web/src/components/panels.tsx:61` — request-surge panel with live windowed rate.
- `checkout-surge-opus/apps/web/src/components/panels.tsx:304` — run status panel renders no config snapshot.
- `checkout-surge-opus/apps/web/src/lib/dashboard-recovery.ts:27` — adapter drops `configSnapshot` from recovery payload.
- `checkout-surge-opus/apps/web/src/app/watch/page.tsx:14` — stale load-run-controls placeholder panel rendered to users.
- `checkout-surge-opus/apps/web/src/lib/live-dashboard-state.ts:44` — 15 s rolling window deriving live surge rate.

#### Verdict rationale

The compared implementation is not missing the gold signals, and its instantaneous surge rate is a good frontend addition over cumulative counters. The downgrade comes from the live-view requirements and product polish: it fetches then discards the frozen run configuration, omits the order-event feed it partly tracks, lacks trend visuals, and exposes a fossilized placeholder to spectators. Relative to the baseline's complete watch surface, this is `worse`.

---

### C78 — Public demo picker & bounded custom-run form (worse)

#### Reference behavior

The baseline public picker fetches the preset catalog and public runtime policy from the API at request time, so cards reflect server truth for names, summaries, planned-attempt labels, stock, and traffic shape. The public custom form supports both buyer-spike and steady-arrival modes plus policy-bounded ERP behavior and a restricted backpressure selection, with policy-driven range errors, clamp-on-blur notes, and metadata-backed help text. Its weakness is that an unreachable API hard-throws into the Next.js error page instead of rendering a degraded picker.

**References:**
- `checkout-forge/apps/web/src/app/page.tsx:37` — presets and runtime policy fetched from API truth.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:278` — buyer-spike / steady-arrival mode toggle in the public custom form.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:719` — clamp-on-blur with policy-bound notes.

#### Compared behavior

The compared picker hardcodes the four public preset choices as slug/name literals instead of reading the catalog, so display metadata is thin and can drift from server-side preset changes. Its custom form is cleanly bounded and validated through a pure builder, including all validation errors and duplicate-attempt ceiling checks, but it models only buyer-spike: no public steady-arrival mode, ERP settings, or backpressure options. It does degrade gracefully when caps are unavailable, polls current-run state to disable starts, and navigates to the watch view after a successful start.

**References:**
- `checkout-surge-opus/apps/web/src/app/page.tsx:11` — hardcoded public preset slug list.
- `checkout-surge-opus/apps/web/src/lib/public-custom-form.ts:9` — custom form fields are buyer-spike only.
- `checkout-surge-opus/apps/web/src/lib/public-custom-form.ts:57` — cap validation including duplicate-attempt total ceiling.
- `checkout-surge-opus/apps/web/src/components/public-run-launcher.tsx:20` — current-run poll disables starts; success navigates to watch.
- `checkout-surge-opus/apps/web/src/app/page.tsx:23` — graceful degradation when caps are unavailable.

#### Verdict rationale

Both provide curated preset starts, bounded custom starts, client-side validation backed by server revalidation, an admin entry, and active-run disabling. The compared implementation is more resilient when the API is down and has a nice start-to-watch flow. But it exposes far less public-custom capability, hides most preset context, and hardcodes a catalog that should be API-owned. As the product's front door, the compared picker is materially thinner. `worse`.

---

### C79 — Run history frontend: pagination, detail depth & traffic grading (worse)

#### Reference behavior

The baseline run-history page is cursor-paginated with a back/forward cursor stack, renders traffic-delivery badges and observed-traffic summaries per row, and links to a dedicated per-run detail page with sanitized public details and a deeper admin view. Admin deletion supports per-row, multi-select, and delete-all flows; delete-all requires the typed `DELETE_ALL_RUN_SUMMARIES` confirmation token.

**References:**
- `checkout-forge/apps/web/src/app/run-history/run-history-client.tsx:53` — cursor pagination state and page loads.
- `checkout-forge/apps/web/src/app/run-history/run-history-client.tsx:36` — typed delete-all confirmation token.
- `checkout-forge/apps/web/src/app/run-history/[runId]/page.tsx:11` — per-run detail route.
- `checkout-forge/apps/web/src/app/run-history/traffic-summary-view.ts:1` — traffic-delivery badge/summary derivation.

#### Compared behavior

The compared run-history page fetches all summaries in one unpaginated list and renders flat rows with identity/status, business outcomes, and terminal inventory. There is no per-run detail page. The payload already includes `httpSummary`, `trafficDeliverySummary`, and `trafficDeliveryStatus`, but the web tier never renders them; the view helper surfaces only business and inventory fields, and comments in the page/view still describe Phase 10 traffic grading as future work. Admin deletion is solid, with per-row and delete-all operations through the session-gated proxy and a typed confirmation phrase for delete-all.

**References:**
- `checkout-surge-opus/apps/web/src/app/run-history/page.tsx:18` — single unpaginated fetch of all summaries and stale Phase-10 comment.
- `checkout-surge-opus/apps/web/src/lib/run-history-view.ts:14` — only business and inventory stats derived.
- `checkout-surge-opus/packages/contracts/src/run-history.ts:88` — HTTP and traffic-delivery summaries exist in the payload.
- `checkout-surge-opus/apps/web/src/components/admin-run-history.tsx:130` — delete-all requires typed confirmation.

#### Verdict rationale

The compared implementation meets the safety side of run history, including admin-gated deletion and public-safe rows. It misses the spec's pagination requirement, has no detail view, and most importantly hides the benchmark headline results that the backend computes and returns. This duplicates none of C69's backend accounting judgment; it is a frontend rendering gap. `worse`.

---

### C80 — Admin console frontend control surface (same)

#### Reference behavior

The baseline admin console, behind a sign-in gate, covers run starts from the full preset catalog, per-field preset editing with duplicate and copy-to-custom flows, runtime-policy editing with hard-cap cross-validation feedback and metadata help, ERP chaos controls, and reset with confirmation. The feature set is broad, but it sits inside a very large client component supported by extracted pure modules for validation and state.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:74` — large admin console component.
- `checkout-forge/apps/web/src/app/admin/page.tsx:25` — sign-in gate before the operator shell renders.
- `checkout-forge/apps/web/src/app/dashboard-runtime-policy-validation.ts:1` — pure runtime-policy draft validation.

#### Compared behavior

The compared admin console covers the same operator surface as separate panels: run controls from the actual preset list, admin-only and Custom presets, per-field preset editor with duplicate/copy-to-custom routes, runtime-policy editing bounded by hard caps, ERP chaos controls including forced outage and reset, and demo reset behind a confirmation dialog with result summary. The preset editor edits within a preset's stored traffic mode rather than switching modes. Anonymous visitors see only the passphrase gate.

**References:**
- `checkout-surge-opus/apps/web/src/app/admin/page.tsx:23` — anonymous visitors see only the sign-in gate.
- `checkout-surge-opus/apps/web/src/components/run-controls-view.tsx:26` — admin start choices derived from real preset list.
- `checkout-surge-opus/apps/web/src/lib/preset-editor.ts:3` — per-field preset editor preserving traffic mode and advanced VU sizing.
- `checkout-surge-opus/apps/web/src/components/admin-demo-reset.tsx:24` — reset behind confirmation dialog.

#### Verdict rationale

Feature-for-feature, both admin consoles cover the expected operator controls. The baseline has richer form affordances and mode-switching; the compared implementation is much better factored and derives its start list from live catalog data. Security enforcement of those controls is covered in C85-C94, not this frontend-surface topic. Net result: `same`.

---

### C81 — BFF discipline & same-origin proxy mechanics (same)

#### Reference behavior

The baseline proxies backend reads and controls through same-origin Next.js handlers. Service URLs, the control token, and the admin passphrase live in server-validated env config, and a route-ownership test pins that frontend ownership. The shared read proxy enforces a 5-second upstream timeout and schema-validates upstream JSON before relaying. Its SSE shim does not forward the browser abort signal to the upstream fetch and sets no proxy-buffering header, so disconnected spectators can leave dangling upstream SSE connections.

**References:**
- `checkout-forge/apps/web/src/app/api/dashboard/dashboard-read-proxy.ts:30` — 5 s timeout and schema validation on proxied reads.
- `checkout-forge/apps/web/src/app/web-access.ts:50` — server-side env schema; secrets and service URLs are not public.
- `checkout-forge/apps/web/src/app/dashboard/events/route.ts:15` — SSE shim fetch lacks browser abort forwarding.
- `checkout-forge/apps/web/src/app/frontend-route-ownership.test.ts:1` — test pinning proxy route ownership.

#### Compared behavior

The compared implementation has the same single-origin discipline: no public service URLs, all reads and controls through `/api/dashboard/*` handlers, and contract validation on relayed payloads. Its admin path is cleaner: a centralized `proxyAdminApi` fail-closes with 401 without a session and 503 without a configured token, so admin routes inherit the same guard. The run-start route derives principal information server-side from session or signed visitor identity. Its SSE shim forwards the browser abort signal and disables buffering, but the server-side read helpers attach no upstream timeout, so a hung API can hang a route handler.

**References:**
- `checkout-surge-opus/apps/web/src/lib/admin-api.ts:46` — centralized fail-closed admin proxy.
- `checkout-surge-opus/apps/web/src/app/api/dashboard/runs/route.ts:26` — principal derived server-side.
- `checkout-surge-opus/apps/web/src/app/dashboard/events/route.ts:22` — SSE shim forwards abort signal; buffering disabled at line 44.
- `checkout-surge-opus/apps/web/src/lib/api.ts:73` — proxied reads without upstream timeout.

#### Verdict rationale

Both implementations keep the browser on the dashboard origin, keep secrets server-side, and avoid reimplementing core business logic in the web tier. The baseline bounds normal read latency but leaks upstream SSE work on disconnect; the compared implementation fixes SSE lifecycle/buffering and centralizes admin proxy enforcement but leaves read timeouts unbounded. These offset. `same`.

---

### C82 — Frontend decomposition & testability architecture (better)

#### Reference behavior

The baseline's pure-logic pattern is real: recovery coordination, retry scheduling, live-state reduction, view-model derivation, presentation formatting, and form validation live in framework-free modules with unit tests, plus DOM-level tests for accessible markup. But the React component tier has several monoliths: the admin console, public home client, and admin run-detail view each mix extensive handlers, drafts, and render sections in files around 1,200-1,800 lines.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:27` — pure coordinator module.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:1` — large pure view-model module.
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:74` — very large admin console component.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:71` — very large public home component.

#### Compared behavior

The compared frontend applies the same pure-core idea more consistently into the component layer: each feature has a pure `lib/` module, pure presentational views, and a thin client wrapper for fetch/poll glue. State flows through a reducer with selectors that take `now` as a parameter for deterministic tests. The web test suite covers the reducer, recovery coordinator, form builders, and presentational views through focused unit/RTL tests.

**References:**
- `checkout-surge-opus/apps/web/src/lib/live-dashboard-state.ts:17` — pure reducer and selectors with injected `now`.
- `checkout-surge-opus/apps/web/src/components/public-run-launcher.tsx:15` — thin glue wrapper / pure view split pattern.
- `checkout-surge-opus/apps/web/src/lib/recovery-coordinator.ts:12` — framework-free protocol class.
- `checkout-surge-opus/apps/web/test/unit/recovery-coordinator.test.ts:1` — representative pure-module test.

#### Verdict rationale

Both codebases test pure frontend logic. The compared implementation is structurally ahead because it extends the separation into React itself, keeping components small and consistently split between glue and presentation. The baseline's large client components are a real maintainability drag despite strong helper modules. `better`.

---

### C83 — Dashboard update cadence & render economy (same)

#### Reference behavior

The baseline is event-driven: state updates when an SSE event arrives or recovery completes, the view model is memoized on state, and sparkline samples are deduplicated before causing a render. Burst event volume is bounded upstream by API aggregation and throttling (see C36 and C61); the client applies each event as one React state update without additional coalescing.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:58` — view model memoized on snapshot/live state.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:301` — sparkline samples deduplicated before triggering render.

#### Compared behavior

The compared client also dispatches one reducer action per validated SSE event and relies on upstream aggregation for burst control. It adds a 1-second clock tick for surge-rate and last-event-age display plus a 2.5-second per-client recovery poll. That poll buys terminal settlement and freshness for panels without live events, but it creates steady per-spectator recovery traffic even when idle.

**References:**
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:43` — 2.5 s recovery poll and 1 s clock tick per client.
- `checkout-surge-opus/apps/web/src/components/live-dashboard.tsx:111` — one reducer dispatch per validated SSE event.

#### Verdict rationale

Neither implementation adds client-side coalescing beyond the backend aggregation cadence, and both render once per delivered event. The compared poll has a linear steady-state cost per spectator; the baseline avoids that but relies on more precise event/recovery trigger wiring. At expected demo audience sizes, the trade is comparable. `same`.

---

### C84 — Dashboard accessibility & states-of-the-world coverage (same)

#### Reference behavior

The baseline labels page regions with `aria-label`s, hides decorative tone dots, uses Radix primitives for keyboard/focus-sensitive controls, and covers loading, empty, error, sold-out, and failed-run displays. DOM-level tests explicitly assert accessible markup on key controls, and destructive-action tests pin confirmation flows.

**References:**
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:92` — region labels and hidden decorative markers.
- `checkout-forge/apps/web/src/app/dashboard-ui.dom.test.tsx:1` — DOM tests asserting accessible markup.
- `checkout-forge/apps/web/src/app/destructive-actions.test.ts:1` — confirmation-flow coverage.
- `checkout-forge/apps/web/src/components/ui/alert-dialog.tsx:1` — Radix-based dialog primitives.

#### Compared behavior

The compared implementation uses native buttons and labelled inputs, `role="alert"` for error output, `aria-hidden` for decorative dots, `htmlFor` labels in forms, and Radix for modal flows. Panels render explicit unavailable or empty states such as "Unavailable", "No runs recorded yet", "No run in progress", and not-initialized inventory messaging. Starts are loading-disabled, and errors surface inline and via toasts. RTL tests cover presentational states, though not with the same explicit accessibility-test focus as the baseline.

**References:**
- `checkout-surge-opus/apps/web/src/components/public-run-launcher-view.tsx:81` — `role="alert"` and labelled number fields.
- `checkout-surge-opus/apps/web/src/components/metric.tsx:1` — shared stat/bar/unavailable primitives.
- `checkout-surge-opus/apps/web/src/components/admin-run-history.tsx:135` — labelled typed-confirmation input in delete-all dialog.
- `checkout-surge-opus/apps/web/test/unit/public-run-launcher-view.test.tsx:1` — RTL state coverage for launcher view.

#### Verdict rationale

Both clear the accessibility and state-coverage bar: labelled controls, keyboard-capable primitives, alert roles, hidden decoration, and explicit loading/empty/error/failure states. The baseline has more tooltip/help density and more explicit accessibility tests; the compared implementation is leaner but consistent. `same`.

---

## Access protection, abuse control & public-run governance

### C85 — Admin session establishment & cookie mechanics (better)

#### Reference behavior

The baseline mints a stateless HMAC-SHA256-signed admin session value of the form `expiresAtMs.signature` after a passphrase check. The passphrase comparison hashes both sides first and uses `timingSafeEqual`, so it is constant-time and length-safe. The cookie is HttpOnly, `SameSite=Lax`, Secure in production, and defaults to an 8-hour max age. Required web-access secrets are validated when the config is loaded; a missing secret surfaces as a config-load failure rather than a designed login response.

**References:**
- `checkout-forge/apps/web/src/app/web-access.ts:125` — signed admin session value.
- `checkout-forge/apps/web/src/app/web-access.ts:175` — constant-time passphrase check over SHA-256 digests.
- `checkout-forge/apps/web/src/app/api/admin/session/route.ts:20` — HttpOnly, `SameSite=Lax`, Secure-in-production cookie.
- `checkout-forge/apps/web/src/app/web-access.ts:50` — required secrets validated at config load.

#### Compared behavior

The compared implementation uses the same HMAC-SHA256 and digest-then-`timingSafeEqual` pattern, but the token payload is versioned JSON (`v`, `iat`, `exp`) encoded in base64url and the signature is verified before the payload is trusted. It sets the admin cookie `SameSite=Strict`, fails login with a designed 503 (`admin_login_unavailable`) when required secrets are unconfigured, and factors the pure session/passphrase logic away from the Next.js route glue with direct unit tests.

**References:**
- `checkout-surge-opus/apps/web/src/lib/admin-session.ts:33` — versioned signed token with signature checked before payload trust.
- `checkout-surge-opus/apps/web/src/lib/admin-session.ts:78` — constant-time passphrase check over SHA-256 digests.
- `checkout-surge-opus/apps/web/src/lib/admin-session.ts:94` — fail-closed login decision when unconfigured.
- `checkout-surge-opus/apps/web/src/lib/admin-auth.ts:63` — HttpOnly, `SameSite=Strict`, Secure-in-production cookie.

#### Verdict rationale

Both satisfy the spec's passphrase-to-signed-HttpOnly-session model and keep secrets server-side. The compared implementation is modestly stronger: `SameSite=Strict` is tighter than Lax, the unconfigured-secret path is an intentional 503 instead of an incidental exception path, and the signature-before-payload discipline plus pure testable session core are cleaner. `better`.

---

### C86 — Service-token enforcement on admin-only mutating surfaces (same)

#### Reference behavior

The baseline requires the control service token at admin-only API surfaces such as reset, preset mutation, runtime-policy updates, run-summary deletion, load-metric ingestion, and finalization reports. The guard also validates the operator-mode header for admin-only routes and returns distinct errors for missing/wrong tokens, invalid modes, and non-admin principals. The web proxy checks the admin session before attaching the token. Token comparison is a plain string comparison.

**References:**
- `checkout-forge/apps/api/src/routes/demo-runs.ts:405` — `requireControlAccess` checks token and operator mode.
- `checkout-forge/apps/api/src/http.ts:49` — plain string service-token comparison.
- `checkout-forge/apps/web/src/app/api/control/demo/reset/route.ts:13` — web proxy checks admin session before attaching token.

#### Compared behavior

The compared implementation attaches a `requireServiceToken` guard to every admin/internal API route group it defines: reset, run-history deletion, presets, runtime policy, load metrics, and completion reports. The guard fails closed with 503 when no token is configured and uses constant-time comparison. Admin API proxying is centralized in `proxyAdminApi`, which combines session validation and token attachment for the web tier. Admin routes rely on the token as the trusted-caller proof rather than additionally requiring the operator-mode header.

**References:**
- `checkout-surge-opus/apps/api/src/server.ts:145` — admin/internal route groups registered behind the token guard.
- `checkout-surge-opus/apps/api/src/runtime/auth.ts:51` — fail-closed service-token guard.
- `checkout-surge-opus/apps/api/src/runtime/auth.ts:18` — constant-time token comparison.
- `checkout-surge-opus/apps/web/src/lib/admin-api.ts:45` — centralized session-check and token-attachment helper.

#### Verdict rationale

For the admin-only surfaces covered by this topic, both reject direct calls without the trusted token and both keep the token out of the browser. The compared mechanics are cleaner (constant-time, fail-closed when unconfigured, centralized proxy helper); the baseline has richer mode-derived error taxonomy. The meaningful divergences are the public/admin run-start endpoint and the load-orchestrator boundary, split into C87 and C88. `same`.

---

### C87 — Run-start endpoint protection & privilege derivation at the API (worse)

#### Reference behavior

The baseline protects `POST /internal/demo/runs/start` with the service token for every start, public or admin, before it derives any principal. Public starts require the proxy-forwarded signed visitor identity; a public start without that header is rejected. Privilege is derived from validated proxy/session context, not from the body, and an admin-mode claim without a valid session gets rejected at the web proxy rather than downgraded.

**References:**
- `checkout-forge/apps/api/src/routes/demo-runs.ts:281` — start route runs `requireControlAccess` before processing.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:302` — public start without visitor id is rejected.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:30` — admin claim without session rejected at the proxy.

#### Compared behavior

The compared API registers `POST /demo/runs` without an authentication guard. `derivePrincipal` treats a request as admin only when the operator-mode header and a valid token are both present, but otherwise silently downgrades to a public principal. The visitor id is read from the raw `x-visitor-id` header and defaults to `"anonymous"`; signature verification happens only in the dashboard proxy. A direct caller that can reach the API can therefore start public runs and rotate the visitor header to evade the per-visitor budget, leaving the global budget and per-run caps as the effective abuse controls.

**References:**
- `checkout-surge-opus/apps/api/src/routes/run-routes.ts:43` — `POST /demo/runs` registered without token guard.
- `checkout-surge-opus/apps/api/src/routes/run-routes.ts:65` — visitor id read from raw request header with `"anonymous"` fallback.
- `checkout-surge-opus/apps/api/src/runtime/auth.ts:39` — unauthenticated admin claims downgraded to public.
- `checkout-surge-opus/apps/api/test/unit/auth.test.ts:25` — downgrade behavior is deliberate and tested.

#### Verdict rationale

The compared implementation makes the correct privilege decision for a forged admin claim, but it turns the start surface into a rate-limited public API when reached directly. The spec explicitly requires service endpoints that start load to reject unauthenticated direct calls, and the baseline implements that. Topology, global budgets, and hard caps mitigate the blast radius; they do not restore the service-side boundary. This is a material regression on the core defense-in-depth question. `worse`.

---

### C88 — Load-orchestrator service boundary (direct load starts) (worse)

#### Reference behavior

The baseline load orchestrator enforces its own service-token boundary for both starting and aborting load runs. A direct caller cannot spawn k6 traffic or abort a current run without the shared control token, so the orchestrator does not rely on the dashboard or API to have already authorized the action.

**References:**
- `checkout-forge/apps/load-orchestrator/src/server.ts:125` — `/load/runs` start requires the control token.
- `checkout-forge/apps/load-orchestrator/src/server.ts:159` — abort route likewise token-guarded.

#### Compared behavior

The compared orchestrator's `POST /internal/load/runs` has no inbound authentication. It checks only a preset-traffic kill switch and the shared load snapshot schema. That schema validates shape but not deployment caps: buyer count and rate are unbounded positive integers and advanced VU controls are accepted. The orchestrator holds the control token only for outbound metric and completion reports back to the API.

**References:**
- `checkout-surge-opus/apps/load-orchestrator/src/routes/load-routes.ts:18` — start route has kill-switch and schema validation only.
- `checkout-surge-opus/packages/contracts/src/load.ts:24` — load snapshot traffic fields are unbounded positive integers.
- `checkout-surge-opus/apps/load-orchestrator/src/services/traffic-reporter.ts:105` — token used for outbound reports, not inbound authorization.

#### Verdict rationale

This security finding is distinct from C72's start-ordering verdict and C73's packaging/config verdict. For direct service calls, the compared orchestrator bypasses the API's policy, budget, and cap layers and can launch unbounded infrastructure load from any network location that can reach the service. The baseline independently defends the same boundary. `worse`.

---

### C89 — Server-issued public visitor identity (same)

#### Reference behavior

The baseline issues a random UUID visitor id in an HMAC-signed HttpOnly `SameSite=Lax` cookie. The web proxy verifies or mints that cookie and forwards only the plain id to the API on a private header alongside the service token. Client-supplied forwarding headers are not trusted by the intended browser path.

**References:**
- `checkout-forge/apps/web/src/app/web-access.ts:154` — signed visitor cookie value.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:69` — verify-or-mint at the proxy and forward plain id.

#### Compared behavior

The compared implementation uses the same structure: `randomUUID`, HMAC-SHA256, HttpOnly `SameSite=Lax` visitor cookie, constant-time verification, and proxy-forwarded plain id. If the visitor-cookie secret is unconfigured, the proxy forwards no id and the API buckets the request as `"anonymous"`, which degrades toward a stricter shared budget on the proxy path. The implementation documents the clear-cookie identity-rotation limitation and relies on the global budget as the backstop.

**References:**
- `checkout-surge-opus/apps/web/src/lib/visitor-id.ts:20` — sign/verify implementation with constant-time comparison.
- `checkout-surge-opus/apps/web/src/lib/admin-auth.ts:86` — proxy verify-or-mint and null forwarding when unconfigured.

#### Verdict rationale

Within the browser/proxy path, the two visitor-identity schemes are equivalent: server-issued, signed, HttpOnly, and not browser-readable as a raw authority token. The direct-API spoofability of `x-visitor-id` in the compared implementation is already charged in C87, because it comes from bypassing the proxy boundary rather than from the visitor-cookie scheme itself. `same`.

---

### C90 — Public run-budget enforcement (windows, races, release) (worse)

#### Reference behavior

The baseline enforces per-visitor and global fixed-window budgets in Redis with one Lua reservation script that checks both counters and increments both only when both are under limit, so concurrent starts cannot both spend the last slot. Enforcement is fail-closed for every non-admin principal. If the start later fails after budget reservation, a release script decrements both counters. Rejections include retry-after guidance, and budget values live in the persisted public runtime policy.

**References:**
- `checkout-forge/apps/api/src/services/public-run-budget-service.ts:83` — atomic check-both/increment-both Lua script.
- `checkout-forge/apps/api/src/services/public-run-budget-service.ts:114` — release script for failed starts.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:369` — reserved budget released when start throws.
- `checkout-forge/apps/api/src/services/public-run-budget-policy.ts:14` — fail-closed public-budget predicate.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:341` — budget read from persisted runtime policy.

#### Compared behavior

The compared implementation has the same atomic consume core and the same default values (2 visitor starts, 6 global starts, 300-second window). It charges only after preset lookup, cap validation, and the overlap check pass, and real-Redis integration tests cover visitor/global windows, independence, concurrent limits, reject-consumes-nothing, and reset. The missing refinements are release, retry-after, and policy control: the public-budget port exposes only `consume`, failed starts after budget charge burn a slot for the whole window, 429s carry no retry-after guidance, and the limits come from env rather than the persisted runtime policy.

**References:**
- `checkout-surge-opus/packages/db/src/public-run-budget.ts:28` — atomic check-both/increment-both consume Lua.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:155` — budget charged after validation and overlap check.
- `checkout-surge-opus/apps/api/src/services/public-run-budget.ts:12` — budget port exposes `consume` only.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:30` — env-only budget defaults.
- `checkout-surge-opus/packages/db/test/integration/public-run-budget.test.ts:49` — real-Redis budget-window coverage.

#### Verdict rationale

The enforcement core is sound in both systems, and the compared ordering avoids burning budget for early validation failures. The baseline still has the more complete public-governance behavior: release semantics after a failed launch, retry-after feedback, and admin-tunable budgets inside the public runtime policy. With a two-start visitor allowance, a post-charge orchestrator or inventory failure can lock a legitimate compared visitor out for the window. `worse`.

---

### C91 — Layered configuration governance (hard caps ≥ policy ≥ run config) (same)

#### Reference behavior

The baseline implements deployment hard caps, an admin-editable persisted public runtime policy constrained by those caps, and per-run validation against the active policy. Startup cross-validation refuses to boot if the configured public policy defaults exceed hard caps. Public custom starts clamp traffic, stock, ERP latency/TPS/error-rate, and allowed backpressure profiles, while admin starts still remain bounded by deployment caps and the one-active-run rule.

**References:**
- `checkout-forge/apps/api/src/config.ts:207` — boot refuses policy defaults above hard caps.
- `checkout-forge/apps/api/src/services/public-runtime-policy-service.ts:82` — policy updates validated against hard caps with field detail.

#### Compared behavior

The compared implementation also has env deployment caps, a persisted runtime policy, policy-update validation against the deployment ceiling, and API-side revalidation on start. If caps are unconfigured, policy management and public custom starts fail closed. Its public-custom surface is stricter in one respect: public overrides may set only traffic and starting stock, while ERP behavior and backpressure come from the read-only `public-custom` base preset, making public forced outage or hostile error rates unreachable. Softer edges are that seeded policy defaults are not cross-checked against deployment caps at boot, and budget values are not part of the policy (see C90).

**References:**
- `checkout-surge-opus/apps/api/src/services/public-runtime-policy-service.ts:38` — policy updates rejected when dimensions exceed deployment caps.
- `checkout-surge-opus/apps/api/src/services/run-start-service.ts:168` — public custom override limited to traffic and inventory.
- `checkout-surge-opus/apps/api/src/routes/run-routes.ts:98` — public caps read is advisory; start revalidates.
- `checkout-surge-opus/packages/db/src/presets.ts:24` — seeded policy default is not boot-cross-validated against env caps.

#### Verdict rationale

The baseline is more rigorous about boot-time policy-vs-cap invariants and keeps budgets in the policy. The compared implementation has a narrower public-custom attack surface and fail-closed behavior when cap configuration is missing. Those advantages point in different directions and neither implementation dominates the governance layer as a whole. `same`.

---

### C92 — Public-safe DTO & secret sanitization (same)

#### Reference behavior

The baseline exposes public run history and run details through schema-shaped DTOs with aggregates, statuses, and frozen configuration, excluding reservation tokens, idempotency keys, raw event payloads, and internal URLs. Browser-facing config ignores `NEXT_PUBLIC_*` service URLs, and service URLs/tokens stay in server-side web-access config. Runs record and expose public-safe operator attribution.

**References:**
- `checkout-forge/apps/web/src/app/web-access.test.ts:93` — test asserts `NEXT_PUBLIC_*` service URLs are ignored.
- `checkout-forge/apps/web/src/app/web-access.ts:41` — service base URLs held server-side only.

#### Compared behavior

The compared public contracts likewise cannot represent tokens, keys, raw event payloads, or internal service URLs. Run history contains counts, statuses, grading, terminal inventory aggregates, and business-outcome counters. The current-run view carries `operatorMode` for attribution. Backend URLs are private env vars resolved server-side, and proxy error responses are normalized code/message envelopes without upstream URL leakage.

**References:**
- `checkout-surge-opus/packages/contracts/src/run-history.ts:73` — public history summary schema carries aggregates only.
- `checkout-surge-opus/packages/contracts/src/demo.ts:176` — run view carries public-safe `operatorMode`.
- `checkout-surge-opus/apps/web/src/lib/admin-api.ts:25` — Mock ERP URL resolved server-side.

#### Verdict rationale

No leak was found in either implementation's public DTOs or browser config. The baseline has a more explicit negative test for `NEXT_PUBLIC` URL leakage; the compared schemas are equally restrictive by construction. SSE payload sanitization was reviewed at the contract level and remains noted in the caveats. `same`.

---

### C93 — Run-history deletion protection & delete-all confirmation (same)

#### Reference behavior

Baseline run-summary deletion routes require the service token plus admin operator mode behind a session-checked proxy. Delete-all additionally requires the literal confirmation value `DELETE_ALL_RUN_SUMMARIES` at the contract schema, and demo reset does not delete history.

**References:**
- `checkout-forge/packages/contracts/src/dashboard.ts:370` — delete-all confirmation as schema-level literal.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:180` — delete-all parses confirmation before service call.

#### Compared behavior

The compared implementation guards single, selected, and all-history deletion with the service token behind the admin-session proxy. IDs are contract-validated, selected delete is bounded to 200 ids, reset remains separate from history deletion, and delete-all requires a deployment-configured confirmation value. If that value is unset, the route fails closed with 503.

**References:**
- `checkout-surge-opus/apps/api/src/routes/admin-run-history-routes.ts:53` — token-guarded delete-all route.
- `checkout-surge-opus/apps/api/src/services/run-history-deletion-service.ts:39` — delete-all fails closed when confirmation is unconfigured.
- `checkout-surge-opus/packages/contracts/src/run-history.ts:111` — selected-delete bounded to 200 ids.

#### Verdict rationale

Both meet the spec's protection bar: admin auth plus service token plus typed delete-all confirmation, and reset does not erase history. The baseline's fixed literal matches the shared spec exactly; the compared env-configured phrase adds deployment opt-in and fail-closed behavior at the cost of a less portable UI constant. Overall protection is equivalent. `same`.

---

### C94 — Mock ERP chaos-control authorization (same)

#### Reference behavior

The baseline exposes chaos status as a public read and protects chaos update/reset with the ERP service's own token check. Updates are validated against env-backed safety caps before application, so the ERP does not merely trust the dashboard or API.

**References:**
- `checkout-forge/apps/mock-erp/src/server.ts:123` — public chaos-status read.
- `checkout-forge/apps/mock-erp/src/server.ts:135` — token-guarded chaos update with cap validation.

#### Compared behavior

The compared ERP has the same endpoint split: `GET /erp/chaos` is public, while `PUT /erp/chaos` and `POST /erp/chaos/reset` use a service-token preHandler with constant-time comparison and fail-closed 503 behavior when unconfigured. Cap validation lives in the chaos store and returns per-field violations. The dashboard reaches mutation only through the admin-session proxy.

**References:**
- `checkout-surge-opus/apps/mock-erp/src/routes/chaos-routes.ts:21` — public read and guarded PUT/reset routes.
- `checkout-surge-opus/apps/mock-erp/src/runtime/auth.ts:18` — fail-closed constant-time token guard.

#### Verdict rationale

This security topic complements C56, which grades the mock ERP's simulation behavior. For authorization, both implementations match the endpoint matrix: public read-only visibility, admin-session plus service-token mutation, and independent service-side enforcement. The compared guard hygiene is marginally better, but not enough to change the verdict. `same`.

---

### C95 — Security-focused test coverage (same)

#### Reference behavior

The baseline has real-Redis integration coverage for public run budgets, including release behavior; API tests for tokenless/wrong-token control calls; web proxy tests for session rejection and browser-config secrecy; and load-orchestrator route tests that assert its token boundary.

**References:**
- `checkout-forge/apps/api/test/public-run-budget-service.integration.test.ts:1` — real-Redis budget windows and release.
- `checkout-forge/apps/web/src/app/control-routes.test.ts:1` — proxy-route session rejection coverage.
- `checkout-forge/apps/load-orchestrator/test/load-orchestrator-routes.api.test.ts:1` — orchestrator token-boundary tests.

#### Compared behavior

The compared suite directly tests its pure session, passphrase, visitor-id, and principal-derivation code; API fail-closed behavior on admin presets, reset, runtime policy, run-history deletion, and metric ingestion; and real-Redis public-budget windows, global ceilings, visitor independence, reject-consumes-nothing, and reset. It does not have rejection tests for direct run starts or orchestrator starts because those surfaces are intentionally open in the implementation.

**References:**
- `checkout-surge-opus/apps/api/test/unit/auth.test.ts:11` — principal-derivation downgrade matrix.
- `checkout-surge-opus/packages/db/test/integration/public-run-budget.test.ts:49` — real-Redis public-budget behavior.
- `checkout-surge-opus/apps/api/test/api/admin-presets.test.ts:133` — fail-closed rejection tests on admin surfaces.

#### Verdict rationale

Both suites verify the security model they actually implement with a mix of pure, route, and real-infrastructure tests. The compared suite's missing direct-start rejection tests mirror the design gaps already charged in C87/C88 rather than a separate failure of testing discipline. `same`.

---

## Runtime topology, packaging & operational tooling

### C96 — Reference compose topology & service separation (same)

#### Reference behavior

The baseline reference runtime is an honest multi-service topology: PostgreSQL, Redis, API, worker, mock ERP, load orchestrator, web, and Caddy proxy all run as separate containers. Service-to-service URLs use compose DNS, startup is health-gated through `depends_on: condition: service_healthy`, direct service ports are published only as debug surfaces, and k6 is baked into the load-orchestrator image rather than required on the host. It also threads surge-aware tuning into compose: the API listen backlog default is in the shared environment block and the load orchestrator raises its `nofile` ulimit. The weaker operational details are no restart policy, no healthcheck start period, and hardcoded project/infra ports.

**References:**
- `checkout-forge/docker-compose.yml:17` — full eight-service topology with health-gated dependencies.
- `checkout-forge/docker-compose.yml:111` — load-orchestrator `nofile` ulimit raised for surge connection counts.
- `checkout-forge/docker-compose.yml:15` — `API_LISTEN_BACKLOG` default wired through the shared service environment.
- `checkout-forge/docker-compose.yml:160` — Caddy proxy depends on API and web health.

#### Compared behavior

The compared runtime preserves the same service boundaries: the worker, mock ERP, load orchestrator, API, web, PostgreSQL, Redis, and proxy are all separate containers, and the orchestrator image contains k6 at the configured path. It adds several operational improvements: `restart: unless-stopped` for long-lived services, a shared healthcheck anchor with `start_period`, parameterized project and infra ports, optional root `.env` layering, and Node-based health probes that do not assume `wget` exists in slim images. It keeps the API backlog default in API config rather than compose and lacks the baseline's load-orchestrator `nofile` ulimit.

**References:**
- `checkout-surge-opus/docker-compose.yml:28` — same eight-service topology with compose-DNS URLs and health-gated startup.
- `checkout-surge-opus/docker-compose.yml:22` — shared healthcheck anchor, `start_period`, and restart policy.
- `checkout-surge-opus/docker-compose.yml:128` — k6 baked into the load-orchestrator image.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:203` — `API_LISTEN_BACKLOG` default retained in API runtime config.

#### Verdict rationale

Both implementations satisfy the topology requirement: all application services and infrastructure are real separate containers, k6 is containerized, and the proxy is the browser entrypoint. The compared version is more polished as an operations artifact, while the baseline is more explicit about surge-specific container limits. Those differences balance out for the service-separation question, so the verdict is `same`.

---

### C97 — Single-origin reverse proxy configuration & SSE routing (better)

#### Reference behavior

The baseline Caddy config provides the required split: `/dashboard/events*` routes to the API and everything else routes to the web service on the single browser origin. A host-native variant mirrors that split against localhost ports. The SSE path works by relying on Caddy's `text/event-stream` behavior, but the config does not explicitly document or encode the no-buffering concern, and it has no global hardening or compression options.

**References:**
- `checkout-forge/infra/caddy/Caddyfile:1` — two-route proxy split for API SSE and web traffic.
- `checkout-forge/infra/caddy/Caddyfile.host-native:1` — same minimal split for host-native services.

#### Compared behavior

The compared Caddy config keeps the same browser-origin contract but makes the streaming behavior explicit: the SSE route uses `flush_interval -1`, comments explain that the event stream bypasses Next.js, the global block disables the Caddy admin API and automatic HTTPS for the local demo, and non-stream traffic is gzip-compressed. The host-native Caddyfile documents how to run it. The web app also includes a same-origin SSE pass-through route for proxyless development, with `no-transform` / `x-accel-buffering: no` headers and upstream abort propagation.

**References:**
- `checkout-surge-opus/infra/caddy/Caddyfile:14` — SSE route to the API with explicit `flush_interval -1`.
- `checkout-surge-opus/infra/caddy/Caddyfile:1` — global `admin off`, `auto_https off`, and gzip encoding.
- `checkout-surge-opus/infra/caddy/Caddyfile.host-native:9` — documented host-native Caddy variant.
- `checkout-surge-opus/apps/web/src/app/dashboard/events/route.ts:16` — proxyless same-origin SSE shim with anti-buffering headers.

#### Verdict rationale

This topic overlaps the frontend BFF mechanics in C81 and SSE transport behavior in C59, but it grades the runtime proxy artifact itself. Both route correctly; the compared implementation is better because it makes SSE no-buffering explicit, hardens the local proxy surface, and preserves the same-origin stream contract even when developers are not running Caddy.

---

### C98 — Service image construction & packaging (better)

#### Reference behavior

The baseline uses one shared `Dockerfile.runtime` image for API, worker, mock ERP, and web, with service commands overridden in compose, plus a separate load-orchestrator Dockerfile that copies k6 0.56.0 from the Grafana image. The shared image gets useful manifest-first dependency caching and includes a `runtime-setup` target so migrations/seed changes do not rebuild app bundles. However, the final image carries the full workspace with dev dependencies and source/test files, runs as root, and has a default `pnpm dev` command even though compose overrides it for runtime use.

**References:**
- `checkout-forge/Dockerfile.runtime:19` — shared app stage with full workspace install and no non-root user.
- `checkout-forge/Dockerfile.runtime:1` — DB-only `runtime-setup` target.
- `checkout-forge/apps/load-orchestrator/Dockerfile:1` — k6 copied from the Grafana image into the orchestrator image.

#### Compared behavior

The compared implementation gives each app service its own multi-stage Dockerfile. The common pattern builds with turbo, emits a pruned production bundle via `pnpm deploy --legacy --prod`, copies only compiled output and production `node_modules` into a slim runtime stage, runs as the `node` user, and starts with direct `node dist/index.js` entrypoints. The web image ships Next standalone output, k6 is pinned at 1.8.0 in the orchestrator image, and a DB package Dockerfile keeps the setup-image property. The main trade-offs are weaker Docker layer caching (`COPY . .` precedes install, mitigated by a pnpm store cache mount) and more image builds than the baseline's shared image.

**References:**
- `checkout-surge-opus/apps/api/Dockerfile:16` — multi-stage build and pruned production deployment bundle.
- `checkout-surge-opus/apps/api/Dockerfile:22` — `COPY . .` before install, weakening Docker-layer cache reuse.
- `checkout-surge-opus/apps/load-orchestrator/Dockerfile:20` — k6 1.8.0 pinned in the orchestrator image.
- `checkout-surge-opus/apps/web/Dockerfile:32` — Next standalone runtime image.
- `checkout-surge-opus/packages/db/Dockerfile:16` — DB-only setup image.

#### Verdict rationale

C73 already grades the orchestrator's runtime config and k6 packaging from the load-generation perspective; this topic grades image construction across the whole runtime. The compared implementation is materially stronger: smaller production-oriented images, non-root runtime users, direct node entrypoints, per-service packaging, and an equally deliberate setup image. The baseline's manifest-first caching and shared build are useful, but they do not outweigh the runtime-image quality gap.

---

### C99 — Runtime lifecycle separation: setup command, infra-only mode, no auto-start (same)

#### Reference behavior

The baseline keeps container startup separate from database setup. Migrations and seed run only through a profile-gated `runtime-setup` one-shot service invoked by `pnpm runtime:setup`; plain `docker compose up` does not auto-migrate or auto-seed. `pnpm infra:up` starts only PostgreSQL and Redis for host-native development, `runtime:wipe` is an explicit volume-destroying command, and the dev-container starts only the workspace service rather than the full topology.

**References:**
- `checkout-forge/docker-compose.yml:177` — profile-gated `runtime-setup` service.
- `checkout-forge/package.json:7` — explicit infra, setup, runtime-up, and wipe command surface.

#### Compared behavior

The compared runtime follows the same lifecycle contract: setup is a profile-gated one-shot service, `pnpm runtime:setup` deliberately runs migrate + seed, `pnpm infra:up` starts only PostgreSQL and Redis with `--wait`, and destructive wipe remains separate. The compose file documents the command surface inline. A minor wart is that `infra:down` maps to project-wide `docker compose down`, so if the full runtime is up it stops everything rather than targeting only infra.

**References:**
- `checkout-surge-opus/docker-compose.yml:186` — profile-gated setup service with no restart.
- `checkout-surge-opus/package.json:31` — infra-only, setup, runtime-up, and wipe scripts.
- `checkout-surge-opus/packages/db/Dockerfile:40` — setup image command runs migrate then seed.

#### Verdict rationale

Both satisfy the spec's lifecycle separation: starting containers does not implicitly mutate the database, setup is explicit, infra-only development is supported, and editor startup does not launch the full runtime. The compared `--wait` ergonomics and inline comments are nice; the broad `infra:down` is a small operational mismatch. Overall behavior is equivalent.

---

### C100 — Environment/config conventions across dev/container modes (better)

#### Reference behavior

The baseline has a coherent root `.env.example` documenting host-native defaults, service URLs, secrets, hard caps, listen backlog, pool sizes, and `WEB_ORIGIN` guidance for host-native/Codespaces/hosted deployments. Compose overrides service URLs for container DNS. Host-native commands use a `run-with-env.mjs` wrapper that loads root and local env files with shell variables winning. The main weakness is that compose bakes `change-me` fallback values for every shared secret, so the container runtime can boot with known default credentials if no `.env` is present.

**References:**
- `checkout-forge/.env.example:1` — root env example covering secrets, tuning, caps, and origin guidance.
- `checkout-forge/docker-compose.yml:8` — compose-level `change-me` secret fallbacks.
- `checkout-forge/scripts/run-with-env.mjs:17` — layered env loading wrapper.

#### Compared behavior

The compared implementation splits configuration documentation between a root `.env.example` for shared infrastructure/secrets and per-app `.env.example` files for service knobs. The API example documents caps, budgets, hold windows, SSE tuning, backlog, and the boundary between env-owned hard caps and DB-owned runtime policy. Compose consumes the root `.env` via `env_file` without secret fallbacks, with comments stating that the runtime expects `.env` and services fail fast on missing required config. Project names and infra host ports are parameterized. Ops scripts share a small dependency-free env parser rather than requiring every script to be wrapped.

**References:**
- `checkout-surge-opus/.env.example:3` — documented env precedence and shared secret/infra scope.
- `checkout-surge-opus/apps/api/.env.example:25` — API-specific tuning and hard-cap documentation.
- `checkout-surge-opus/docker-compose.yml:11` — compose uses `.env` without baked secret fallbacks.
- `checkout-surge-opus/scripts/lib/env-files.mjs:6` — shared dependency-free env parser for ops scripts.
- `checkout-surge-opus/apps/api/src/runtime/config.ts:184` — centralized startup config parsing and validation.

#### Verdict rationale

Both have a workable host/container/test env story. The compared implementation is better because it avoids known-secret compose defaults, documents per-service knobs near their owners, parameterizes runtime names/ports, and makes operational scripts self-load the same env layers. The baseline's CORS/`WEB_ORIGIN` guidance is more expansive, but the compared system's browser path is strictly same-origin, making that a narrower concern.

---

### C101 — Health check & read-only smoke tooling (same)

#### Reference behavior

The baseline exposes a shallow readiness poll and a deeper non-mutating runtime smoke. `pnpm health:check` polls service readiness and the dashboard through a deadline, reporting named readiness sub-checks. `pnpm runtime:smoke` proves demo readiness rather than mere liveness: it checks compose health, HTTP readiness, dashboard recovery through the proxy, SSE through the proxy, and `k6 version` inside the load-orchestrator container.

**References:**
- `checkout-forge/scripts/health-check.mjs:34` — deadline-based readiness polling with sub-check reporting.
- `checkout-forge/scripts/runtime-smoke-check.mjs:54` — compose, readiness, recovery, SSE, and in-container k6 checks.
- `checkout-forge/scripts/runtime-smoke-check.mjs:154` — SSE content-type and first-frame probe through the proxy.

#### Compared behavior

The compared scripts cover the same readiness surface. `health:check` polls the four service readiness endpoints plus dashboard reachability in parallel, self-loading env files. `runtime:smoke` checks compose health, direct readiness, proxy reachability, a same-origin BFF read, SSE reachability through the proxy including a connect frame, and in-container `k6 version`. It uses a shared checklist/probe library and reports all failures in a table rather than stopping at the first failure.

**References:**
- `checkout-surge-opus/scripts/health-check.mjs:28` — parallel readiness polling plus dashboard reachability.
- `checkout-surge-opus/scripts/runtime-smoke.mjs:24` — read-only runtime smoke coverage.
- `checkout-surge-opus/scripts/lib/runtime-smoke.mjs:92` — reusable SSE probe validating content type and connect frames.

#### Verdict rationale

Both satisfy the "demo readiness" bar and include the two easy-to-miss checks: SSE through the single origin and k6 inside the orchestrator container. The compared implementation reports failures more comprehensively and shares probe code; the baseline inspects readiness payload details more strictly. Neither proves materially more for this non-mutating readiness topic.

---

### C102 — Mutating dashboard-path load smoke & self-cleanup (better)

#### Reference behavior

The baseline `runtime:smoke:load` exercises the real dashboard path: reset runtime, establish an admin session through the proxy, start a tiny custom run through the same-origin control route, poll recovery to terminal `completed`, assert traffic metrics landed, and clean up in `finally`. Cleanup removes exactly the created run's rows and Redis keys, but it does so with hand-maintained SQL sent through `docker compose exec psql` and Redis pattern deletion through `redis-cli --scan`. That proves the path, but the cleanup script duplicates schema/keyspace knowledge and works only against the compose runtime.

**References:**
- `checkout-forge/scripts/runtime-smoke-check.mjs:192` — dashboard-triggered load smoke through admin login and control route.
- `checkout-forge/scripts/runtime-smoke-cleanup.mjs:94` — multi-table cleanup SQL maintained in the script.
- `checkout-forge/scripts/runtime-smoke-cleanup.mjs:168` — Redis key cleanup through compose `redis-cli`.

#### Compared behavior

The compared load smoke drives the same proxy-chain path: admin login, demo reset, start run, observe, and clean up. It goes further by watching live SSE business events during the run, verifying the isolated inventory drains, cleaning up through a first-class DB-package by-run-id cleanup CLI, and verifying afterward that the run inventory namespace is gone. Because it shrinks an editable admin preset rather than posting a one-off custom config, it snapshots and restores that preset on every exit path. Minor issues are the shared-preset mutation and a stale script comment claiming finalization is not built even though the code handles finalized runs.

**References:**
- `checkout-surge-opus/scripts/runtime-smoke-load.mjs:173` — live SSE business-event observation during the run.
- `checkout-surge-opus/scripts/runtime-smoke-load.mjs:235` — cleanup through the DB package's by-run cleanup CLI.
- `checkout-surge-opus/scripts/runtime-smoke-load.mjs:249` — post-cleanup inventory namespace verification.
- `checkout-surge-opus/scripts/runtime-smoke-load.mjs:64` — preset snapshot/restore on all exit paths.
- `checkout-surge-opus/scripts/runtime-smoke-load.mjs:9` — stale finalization comment.

#### Verdict rationale

Both prove the real mutating demo path with auth and cleanup, which is the hard requirement. The compared implementation is better because it verifies more of the runtime pipeline (live SSE and inventory drain), uses an owned cleanup API instead of duplicated raw SQL/key patterns, and validates cleanup success. The preset mutation and stale comment are deductions, but they do not erase the structural advantage.

---

### C103 — Runtime reset tooling (same)

#### Reference behavior

The baseline reset command calls the token-protected API demo reset and mock-ERP chaos reset in parallel, attaches a generated correlation ID, and prints structured outcome details such as recovered run, queue clearing, reset timestamp, and correlation ID. It requires the control token and is reused by the load smoke.

**References:**
- `checkout-forge/scripts/runtime-reset-client.mjs:22` — parallel token-authenticated API and mock-ERP resets.
- `checkout-forge/scripts/runtime-reset.mjs:3` — structured reset outcome reporting.

#### Compared behavior

The compared reset command performs the same protected operation against the API and mock ERP, self-loads env files, and reports clear actionable errors for missing tokens or unreachable services. Its header documents that reset is not wipe and points operators to `runtime:wipe` + `runtime:setup` for database recreation. It reports simpler per-target pass/fail output and does not attach a correlation ID.

**References:**
- `checkout-surge-opus/scripts/runtime-reset.mjs:27` — parallel token-authenticated API and mock-ERP reset calls.
- `checkout-surge-opus/scripts/runtime-reset.mjs:4` — reset-vs-wipe semantics documented in the script.

#### Verdict rationale

The server-side meaning of reset is covered in C47; this topic grades the operator client. Both commands reach the same protected endpoints and work across runtime modes. The baseline has richer trace output; the compared script has better env self-loading and inline semantics. Net behavior is equivalent.

---

### C104 — Dev-container workflow (same)

#### Reference behavior

The baseline dev-container is a compose overlay with its own project name, workspace-only autostart, Docker-in-Docker, and labeled forwarded ports. Its strongest detail is dependency-volume isolation: named volumes cover the pnpm store, root `node_modules`, and each package's `node_modules`, preventing Linux dependency trees from touching the host checkout. The overlay also rewires app volumes for live-source compose runtime development, and `post-create.sh` installs a host k6 pinned by parsing the orchestrator Dockerfile.

**References:**
- `checkout-forge/.devcontainer/docker-compose.yml:9` — named dependency volumes for pnpm store, root, and per-package `node_modules`.
- `checkout-forge/.devcontainer/docker-compose.yml:23` — app service volume rewiring for live-source development.
- `checkout-forge/.devcontainer/post-create.sh:104` — host k6 installation pinned to the orchestrator Dockerfile version.
- `checkout-forge/.devcontainer/devcontainer.json:15` — workspace-only autostart and forwarded ports.

#### Compared behavior

The compared dev-container has the same basic guardrails: workspace-only autostart, Docker-in-Docker, and the same forwarded-port set. It documents project-name separation so the editor container lifecycle and network do not entangle with `pnpm runtime:up`, persists agent tooling configs across rebuilds, and includes a git-worktree repair script for the branch-per-experiment workflow. Its dependency isolation is shallower: only the pnpm store and root `node_modules` are named volumes, so per-package `node_modules` can land on the bind mount. It also does not install a workspace k6.

**References:**
- `checkout-surge-opus/.devcontainer/docker-compose.yml:1` — documented editor-vs-runtime compose project separation.
- `checkout-surge-opus/.devcontainer/docker-compose.yml:20` — dependency volumes limited to pnpm store and root `node_modules`.
- `checkout-surge-opus/.devcontainer/post-create.sh:79` — persisted agent-tool configuration across rebuilds.
- `checkout-surge-opus/.devcontainer/devcontainer.json:7` — workspace-only autostart and forwarded ports.

#### Verdict rationale

Both meet the important lifecycle rule: opening the dev-container does not auto-start the whole runtime. The baseline is stronger on dependency isolation and host k6 parity; the compared implementation is stronger on explicit runtime/editor project separation and workspace-specific tooling ergonomics. These are meaningful but balanced advantages.

---

### C105 — Test infrastructure isolation (compose mechanics) (same)

#### Reference behavior

The baseline test compose file creates dedicated PostgreSQL and Redis services under a separate project on non-conflicting ports, with persistent named volumes. The reset script surgically drops the public schema, enumerates and force-drops per-package derived test databases, and flushes test Redis without recreating containers. Those mechanics support the deeper per-package isolation strategy graded in C107.

**References:**
- `checkout-forge/docker-compose.test.yml:1` — separate test project, dedicated ports, and persistent volumes.
- `checkout-forge/scripts/test-infra-reset.mjs:9` — surgical schema/database/Redis reset against test containers only.

#### Compared behavior

The compared test compose file provides the same isolation contract with a parameterized project name and env-overridable PostgreSQL and Redis ports. Both stores run on `tmpfs`, so test infrastructure is ephemeral and starts clean by construction. `test:infra:up` uses `--wait`, and reset is a full `down -v && up -d --wait` recreate. That is slower than an in-place reset but harder to drift from the actual schema/keyspace.

**References:**
- `checkout-surge-opus/docker-compose.test.yml:9` — tmpfs-backed dedicated test PostgreSQL/Redis with parameterized ports.
- `checkout-surge-opus/package.json:33` — wait-gated test infra up and full teardown/recreate reset.

#### Verdict rationale

Both satisfy the runtime requirement that test infrastructure be isolated from development state. The compared tmpfs/full-recreate approach is clean and complete; the baseline's surgical reset is faster and reflects the repo's derived-database isolation model. The testing methodology built on these containers is graded in C106-C113, so the compose mechanics are `same`.

---

## Testing strategy & engineering quality system

### C106 — Test taxonomy & root command contract (worse)

#### Reference behavior

The baseline classifies tests by filename suffix (`*.test.ts` = unit, `*.integration.test.ts`, `*.api.test.ts`) and drives all three tiers through three shared root Vitest configs whose include/exclude globs enforce the boundary mechanically. A unit run cannot accidentally pick up an infra-backed file. Every package carries the same script quartet (`test`, `test:unit`, `test:integration`, `test:api`), and both infra tiers are wrapped in `run-with-test-env.mjs`, so the documented root command contract holds uniformly. Turbo explicitly disables caching for `test`, `test:integration`, and `test:api`, so infrastructure-backed suites re-execute instead of replaying cached results against changed external state.

**References:**
- `checkout-forge/vitest.config.ts:25` — unit config excludes API and integration suffixes.
- `checkout-forge/apps/api/package.json:21` — per-package test scripts and infra-tier wrapper use.
- `checkout-forge/turbo.json:23` — `cache: false` on test tasks.

#### Compared behavior

The compared implementation uses a directory taxonomy (`test/unit`, `test/integration`, `test/api`), which is also clear, and its root unit lane collects only `test/unit/**`. The command contract breaks below that root, though: `apps/api`'s `test:integration` runs `vitest run --passWithNoTests` with no path filter, while the package Vitest config includes all of `test/**`. Root `pnpm test:integration` therefore sweeps in API-boundary suites without the test-env wrapper they require, producing either a module-load env failure or, if the env is already exported, a run against the wrong isolation context. The same unfiltered pattern in `mock-erp` and `web` mislabels unit suites under infra tier names. Turbo also lacks `cache: false` on test tasks, leaving external-state-dependent results eligible for cache replay.

**References:**
- `checkout-surge-opus/vitest.unit.config.ts:11` — root unit lane restricted to `test/unit/**`.
- `checkout-surge-opus/apps/api/package.json:16` — unfiltered `test:integration` script with no test-env wrapper.
- `checkout-surge-opus/apps/api/vitest.config.ts:10` — package config includes all of `test/**`.
- `checkout-surge-opus/apps/api/test/api/buy-persistence.test.ts:44` — API infra suite throws when `TEST_DATABASE_URL` is absent.
- `checkout-surge-opus/apps/mock-erp/package.json:15` — unfiltered tier script pattern.
- `checkout-surge-opus/turbo.json:12` — test tasks without explicit cache disabling.

#### Verdict rationale

Both taxonomies are legitimate, and the compared repo's directory layout is arguably easier to scan. The grade turns on the root command contract: the baseline's scripts do what the testing doc promises in every package, while the compared `pnpm test:integration` path is defective for the API package and tier-confused in other packages. Turbo caching compounds the issue because integration results can be replayed without rechecking the actual test infrastructure. This is orchestration-layer quality rather than suite-depth quality; the latter is graded separately in C109.

---

### C107 — Test infrastructure isolation & parallel safety (same)

#### Reference behavior

The baseline runs dedicated test PostgreSQL and Redis services on non-conflicting ports, then adds per-package isolation in `scripts/run-with-test-env.mjs`: it layers `.env.test.example` plus optional `.env.test`, rewrites `TEST_DATABASE_URL` with a per-package database-name suffix, and assigns Redis-using packages dedicated logical DB indices. Tests consume the normal env variables and stay unaware of the isolation details; missing derived databases are created on demand.

**References:**
- `checkout-forge/scripts/run-with-test-env.mjs:14` — per-package database suffixing and Redis logical-DB map.
- `checkout-forge/docker-compose.test.yml:1` — dedicated test PostgreSQL/Redis services on separate ports.

#### Compared behavior

The compared implementation ships the same isolation model: a dedicated compose file and ports, the same env-layering wrapper, per-package database-name suffixes, and a Redis logical-DB map with the same package assignments. Its compose startup adds `--wait` health gating, and its reset is a full container teardown/recreate rather than a surgical in-place reset. As noted in C106, the isolation only applies when package scripts actually invoke the wrapper.

**References:**
- `checkout-surge-opus/scripts/run-with-test-env.mjs:20` — package-to-Redis-DB mapping and test DB suffix rewrite.
- `checkout-surge-opus/package.json:35` — wait-gated test infra startup and reset command shape.

#### Verdict rationale

This is the methodology layer built on the compose mechanics already covered in C105. Both repos provide per-package databases, per-package Redis logical DBs, committed test env defaults, local overrides, and non-conflicting ports. The compared implementation's `--wait` is a small improvement; the full reset is blunter than the baseline's surgical reset. The net quality is the same, with the C106 script defect treated as a command-contract issue rather than an isolation-design issue.

---

### C108 — Database reset machinery, locking & destructive-op guards (same)

#### Reference behavior

The baseline database testing module serializes test files within a package through a cross-process file lock scoped to the derived database name, while still allowing packages to run concurrently. Its reset helper truncates only when the applied migration hashes and a stored schema fingerprint prove the schema is current; otherwise it drops and rebuilds from migrations. Destructive helpers refuse to run outside `NODE_ENV=test`.

**References:**
- `checkout-forge/packages/db/src/testing.ts:100` — truncate only after migration-journal and schema-fingerprint checks.
- `checkout-forge/packages/db/src/testing.ts:31` — test lock acquisition refuses non-test environments.

#### Compared behavior

The compared implementation has the same overall shape: a per-database file lock with stale-lock reclamation and a reset helper that applies migrations, truncates when all schema tables are present, and rebuilds otherwise. Its drift check is weaker than the baseline's fingerprint because table presence will not detect column-level corruption left by a test. Its destructive guard is stronger in another direction: it refuses to target a database whose name lacks a delimited `test` token, so a mis-set `TEST_DATABASE_URL` pointing at development data is rejected before statements run. That guard is itself unit-tested.

**References:**
- `checkout-surge-opus/packages/db/src/testing/index.ts:121` — migration/reset path with truncate-or-rebuild behavior.
- `checkout-surge-opus/packages/db/src/testing/index.ts:37` — database-name safety guard.
- `checkout-surge-opus/packages/db/test/unit/reset-test-database-guard.test.ts:7` — unit tests for the destructive-op guard.
- `checkout-surge-opus/packages/db/src/testing/index.ts:65` — per-database file lock with stale reclamation.

#### Verdict rationale

The two implementations make different but defensible safety trade-offs. The baseline detects finer-grained schema drift through a fingerprint; the compared repo better protects against an accidentally dangerous connection string and tests that last-line guard. Neither advantage dominates, so the consolidated verdict is `same`.

---

### C109 — Hard-property coverage & suite depth (better)

#### Reference behavior

The baseline has broad test coverage across every workspace and covers important hard properties against real infrastructure: concurrent reservation storms with no oversell, idempotent replay and conflict, pending-persistence visibility, worker breaker behavior, budget-window integration, mutating-surface auth rejections, startup/recovery services, and real BullMQ plus PostgreSQL order processing. Scope-local coverage topics such as C33, C74, and C95 already record several of these strengths from their domains.

**References:**
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:246` — no-oversell test under concurrent Redis-backed attempts.
- `checkout-forge/apps/api/test/public-run-budget-service.integration.test.ts:1` — budget windows against real infrastructure.
- `checkout-forge/apps/worker/test/order-processing.integration.test.ts:1` — real BullMQ/PostgreSQL worker pipeline test.

#### Compared behavior

The compared implementation is larger and deeper while keeping the same real-infrastructure discipline. API-boundary suites build the real server with real test PostgreSQL/Redis and a live BullMQ inspector queue, while worker integration suites exercise the BullMQ-wired path. It covers the baseline's major properties and adds important marginal cases: concurrent same-idempotency-key races collapse to one reservation with identical replay, richer startup-reconciliation coverage, finalization cases for settle timeouts, in-flight orders, unrecorded notifications, major shortfalls, and pending-hold materialization, dedicated pending-persistence reconciler tests, per-transition circuit-breaker tests, and a real-k6 integration test that self-skips only when allowed and can be made fail-loud with `REQUIRE_K6`.

**References:**
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:236` — oversell test with terminal snapshot assertions.
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:259` — concurrent duplicate-key collapse race.
- `checkout-surge-opus/apps/api/test/api/run-finalization.test.ts:348` — pending-hold materialization and finalization edge coverage.
- `checkout-surge-opus/apps/api/test/api/startup-reconciliation.test.ts:1` — dedicated startup/crash-recovery boundary suite.
- `checkout-surge-opus/apps/load-orchestrator/test/integration/k6-run.test.ts:23` — real-k6 spawn test with observable-skip guard.

#### Verdict rationale

Both suites are genuinely integration-backed and both test the headline no-oversell guarantee. The compared implementation is better because it exercises additional high-risk interleavings and lifecycle edges that the baseline does not, especially the concurrent duplicate-idempotency race and richer finalization/reconciliation cases. Approximate counts (about 122 files / 849 cases vs 73 files / 495 cases) corroborate the broader finding but are not the basis of the grade.

---

### C110 — Determinism & flake discipline (same)

#### Reference behavior

The baseline injects clocks through API services so time-dependent logic can be tested without wall-clock coupling, uses polling/wait helpers more often than fixed sleeps for async settling, and confines raw sleeps to a few places such as SSE gateway integration. Fake timers are used where cadence behavior is the subject under test. Parallel safety comes from the isolation and locking machinery covered in C107/C108.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:1` — injected-clock service pattern.
- `checkout-forge/apps/api/test/dashboard-realtime-publisher.test.ts:56` — polling-style async assertion instead of a fixed sleep.

#### Compared behavior

The compared implementation follows the same injected-clock pattern across API services and passes fixed `now` values into Redis hot-path tests, making expiry scoring deterministic. It has a slightly larger fixed-delay surface in worker integration tests, with small sleeps around BullMQ-adjacent behavior where polling would be more robust. Its infra suites use documented 30-second timeouts to absorb parallel cold-start costs. Skipped/todo tests are near zero in both repos.

**References:**
- `checkout-surge-opus/packages/db/test/integration/reserve-stock.test.ts:242` — fixed `now` injected into concurrency tests.
- `checkout-surge-opus/apps/worker/test/integration/process-order.test.ts:236` — fixed delay in worker integration behavior.
- `checkout-surge-opus/apps/api/vitest.config.ts:17` — documented 30-second timeout rationale.

#### Verdict rationale

Both repos treat determinism as a design input: injected clocks, deterministic fixtures, real-infra resets, and test locks are present on both sides. The baseline is marginally better on polling over sleeps; the compared repo is marginally better on deterministic `now` use in the hot-path tests and documented timeout rationale. The remaining sleep usage is a theoretical flake surface, not enough to move the grade.

---

### C111 — Testability architecture (dependency injection & factories) (same)

#### Reference behavior

The baseline exposes build/create factories for services and passes config, database, Redis, queues, and logger dependencies explicitly. Integration tests construct real servers in-process with injected test clients and close resources cleanly. This factory style also underpins lifecycle testability previously noted in C49.

**References:**
- `checkout-forge/apps/api/src/server.ts:85` — `buildApiServer(deps)` factory.
- `checkout-forge/apps/mock-erp/src/server.ts:32` — same dependency-injected server pattern across services.

#### Compared behavior

The compared implementation follows the same rule: `buildApiServer`, `buildMockErpServer`, and `buildLoadOrchestratorServer` receive dependencies explicitly, and the API server documents composition through dependencies as the intended boundary. API-boundary tests wire real test clients and a BullMQ inspector connection into the server factory and tear resources down. The worker is split into adapter/service layers (`BullMqOrderProcessWorker`, `PostgresOrderProgressStore`, `ProcessOrderService`) tested both separately and wired.

**References:**
- `checkout-surge-opus/apps/api/src/server.ts:101` — explicit-dependency server factory.
- `checkout-surge-opus/apps/api/test/api/buy-persistence.test.ts:23` — real test clients injected in an API-boundary suite.
- `checkout-surge-opus/apps/worker/test/integration/process-order.test.ts:18` — worker adapter/service seams exercised by tests.

#### Verdict rationale

Both implementations satisfy the key testability design rule: no domain service needs hidden module-level infrastructure clients to be testable. The compared worker seams are a bit finer-grained; the baseline's service decomposition is comparably injectable. Systemic quality is equivalent.

---

### C112 — Frontend testing approach (same)

#### Reference behavior

The baseline tests dashboard behavior as small pure modules for recovery coordination, retry, live-state reduction, view models, formatting, and validation. It goes deep on the hardest client behavior: discarding live events during recovery, scheduling follow-up recovery after discards, chained follow-ups, failed-recovery behavior, and terminal-run recovery. DOM-level RTL/jsdom tests are present but narrow, focused on accessible markup for key controls.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.test.ts:8` — recovery/discard suite with failure paths.
- `checkout-forge/apps/web/src/app/dashboard-ui.dom.test.tsx:18` — accessible-name DOM assertions.

#### Compared behavior

The compared implementation mirrors the pure-module approach and tests discard-while-recovering, serialized follow-up, request coalescing, and discard-window boundaries in its recovery coordinator. Its rendered UI coverage is broader: RTL suites span admin run controls, preset editing, runtime policy, ERP chaos, run history, and the live dashboard with role/name-based assertions. Its recovery coordinator suite is shallower on failure and terminal paths than the baseline's.

**References:**
- `checkout-surge-opus/apps/web/test/unit/recovery-coordinator.test.ts:28` — discard/follow-up/coalescing coverage.
- `checkout-surge-opus/apps/web/test/unit/admin-run-controls.test.tsx:70` — role/name-based rendered-control assertions.

#### Verdict rationale

This is a balanced trade. The baseline tests the most subtle client-state protocol more thoroughly, while the compared repo tests more rendered UI surfaces with the same accessibility-oriented assertion style. Specific frontend behavior remains graded in C75–C84; as a repo-wide testing approach, both are solid and neither dominates.

---

### C113 — Repo-wide typing, lint & dependency hygiene (same)

#### Reference behavior

The baseline uses one Biome config for lint and format repo-wide, strict TypeScript on a current toolchain, per-package type checking, and a dedicated `type-check:test` tier so test code is checked as well. It has targeted test lint overrides, a relatively smaller dependency footprint, and a committed quality-checklist working agreement.

**References:**
- `checkout-forge/tsconfig.json:6` — strict base TypeScript config.
- `checkout-forge/package.json:43` — current Biome/TypeScript/Vitest toolchain.
- `checkout-forge/biome.json:1` — single repo-wide lint/format config with test overrides.

#### Compared behavior

The compared implementation also uses a single Biome/formatter setup and carries the same quality-checklist agreement. Its TypeScript base is stricter than the baseline's in several meaningful ways (`noUncheckedIndexedAccess`, `noImplicitOverride`, unused checks, fallthrough checks, and `verbatimModuleSyntax`), and a root `tsconfig.test.json` covers every package's `test/` tree with workspace paths. Its toolchain is older (Biome 1.9, TypeScript 5.7, Vitest 2.1) and the dependency graph is modestly larger. A sampled scan found fewer local Zod shape re-declarations outside the shared contracts package, though the baseline's local schemas were mostly legitimate env/config validation.

**References:**
- `checkout-surge-opus/tsconfig.base.json:9` — strictness flags beyond the baseline.
- `checkout-surge-opus/tsconfig.test.json:15` — root test type-check config covering package test trees.
- `checkout-surge-opus/package.json:49` — older Biome/TypeScript/Vitest toolchain.

#### Verdict rationale

The signals point in opposite directions. The compared repo enforces stronger compile-time checks and cleaner contract-shape centralization; the baseline has a fresher toolchain, smaller dependency footprint, and more granular per-package test type-check setup. Both lint/format consistently, type-check tests, and show no major sampled dead-code or duplication red flags. Overall quality-system posture is the same.

---

## Documentation fidelity & roadmap truthfulness

### C114 — README accuracy vs shipped behavior (worse)

#### Reference behavior

The baseline README describes the implemented product in present tense. The quick-start commands (`runtime:up`, `runtime:setup`, `health:check`, `runtime:smoke`, `runtime:smoke:load`, `maintenance:cleanup-runs`, `runtime:wipe`) all exist as root scripts, the feature list matches shipped behavior, and the route surface it documents (`/` picker, `/watch`, `/admin` behind the port-8080 Caddy proxy) exists in the web app. It has a generic work-in-progress banner, but no completion or in-progress claim that contradicts the code.

**References:**
- `checkout-forge/README.md:76` — quick-start command sequence; all commands exist in root scripts.
- `checkout-forge/README.md:102` — proxy/route claims matching the web route directories.

#### Compared behavior

The compared README is nearly identical in shape and its documented command surface is also accurate. It does, however, contain two false statements. First, it says "run-lifecycle finalization and hosted-demo packaging are still in progress." Hosted packaging remains pending, but finalization is implemented, wired into the API composition root, and the compared roadmap declares Phase 10 fully delivered. Second, the tech-stack table lists `react-icons`, which is absent from `apps/web/package.json` and unused in the web source.

**References:**
- `checkout-surge-opus/README.md:7` — stale "run-lifecycle finalization ... still in progress" claim.
- `checkout-surge-opus/apps/api/src/index.ts:239` — finalization poller wired at boot.
- `checkout-surge-opus/working_docs/project_planning.md:48` — Phase 10 declared fully delivered.
- `checkout-surge-opus/README.md:53` — stack row listing unused/absent `react-icons`.

#### Verdict rationale

Both READMEs are broadly useful and command-accurate. The compared README's main drift is conservative — it understates completeness rather than overclaiming — and the `react-icons` row is cosmetic. Still, these are verifiably false statements in the top-level self-description, while the baseline README has no sampled false counterpart. Worse, narrowly.

---

### C115 — Design-doc adaptation (living docs vs fossilized spec copies) (same)

#### Reference behavior

The baseline `docs/` set is written as living documentation of implemented behavior, in present tense and with implementation-specific details that match the code. Sampled claims, such as the API readiness check name, match the implementation.

**References:**
- `checkout-forge/docs/architecture.md:5` — present-tense "demonstrates" framing.
- `checkout-forge/apps/api/src/routes/health.ts:23` — `redis_url_configured` check matching documented readiness payload.

#### Compared behavior

The compared `docs/` set was seeded from the shared docs, but it was not left as a verbatim fossil. Every file diverges from the baseline, and sampled divergences are implementation-specific and true: the Redis hot-path doc documents the compared `run:{runId}:sale-eligibility` key and rejection codes; the architecture doc documents the no-CORS, same-origin proxy decision and the ERP resilience read; and the conventions doc documents the `notifications:record` queue present in the worker. The weakness is presentation: several canonical docs retain spec-tense wording such as "must demonstrate," "target architecture," and "should emit," where the baseline rewrote these into implemented-behavior statements.

**References:**
- `checkout-surge-opus/docs/redis_inventory_hot_path.md:31` — run-eligibility Redis key and rejection codes.
- `checkout-surge-opus/apps/api/src/services/postgres-buy-persistence.ts:103` — `run_sale_offer_mismatch` implemented as documented.
- `checkout-surge-opus/docs/architecture.md:5` — retained "must demonstrate / target architecture" framing.
- `checkout-surge-opus/docs/cross_service_conventions.md:150` — `notifications:record` documented.
- `checkout-surge-opus/apps/api/src/routes/erp-resilience-routes.ts:1` — documented ERP resilience read exists.

#### Verdict rationale

The key failure mode for autonomous builds — seeded design docs fossilizing while code drifts — did not happen in the compared implementation. Its docs were adapted with true implementation details and corrected when the code changed. The baseline is cleaner because it uses factual present-tense framing; the compared docs are equally accurate on sampled substance but less clear about whether they describe a target or the delivered system. Net: same.

---

### C116 — Stale Phase-9 snapshot claims in `runtime_topology.md` (worse)

#### Reference behavior

The baseline runtime-topology doc has no dated validation snapshot that now contradicts the code. Its equivalent passage is a current-tense Dev Container validation note without a stale limitations section.

**References:**
- `checkout-forge/docs/runtime_topology.md:182` — current-tense validation note with no stale limitations section.

#### Compared behavior

The compared runtime-topology doc keeps a "Delivered validation and captured limitations (Task 9.3)" section whose historical validation record is useful, but whose limitation bullets are now false in a living doc. It still says finalization is not implemented until Phase 10 and that dashboard recovery/run-summary routes currently 404. Finalization is now implemented and the recovery proxy route exists. The same section also points readers to a Task 9.3 delivery note in `working_docs/project_planning.md`, but that note was archived under `working_docs/implementation_notes/phase-09.md`, so the pointer is stale.

**References:**
- `checkout-surge-opus/docs/runtime_topology.md:198` — stale claim that finalization/routes are not built.
- `checkout-surge-opus/apps/web/src/app/api/dashboard/recovery/route.ts:1` — the claimed-missing route exists.
- `checkout-surge-opus/docs/runtime_topology.md:193` — stale pointer to a planning-doc note.
- `checkout-surge-opus/working_docs/project_planning.md:875` — documentation maintenance rule requiring stale notes to be promoted/refreshed.

#### Verdict rationale

This is a separate documentation defect from C114 because it contaminates the canonical design docs rather than the README. The bullets are attributable to Phase 9 history, but they sit in `docs/runtime_topology.md` as current limitations and are contradicted by the Phase 10 code. The baseline has no sampled counterpart. Worse.

---

### C117 — Roadmap completion truthfulness (same)

#### Reference behavior

The baseline roadmap marks Phases 0-10 complete and Phases 11-12 pending. Its checkmarks are terse and do not include per-task delivery notes, but its claimed completion frontier aligns with the baseline behavior examined in the functional findings.

**References:**
- `checkout-forge/working_docs/project_planning.md:15` — Phase 0 onward checked through Phase 10.
- `checkout-forge/working_docs/project_planning.md:624` — Phase 10 checked; Phases 11-12 pending.

#### Compared behavior

The compared roadmap claims Phases 1-10 delivered and 11-12 pending, the same frontier as the baseline. Sampled claims held up: the partial unique index for non-terminal runs exists; the finalization poller is wired at boot; startup reconciliation exists with the claimed interruption reason; the finalization gate counts confirmed-but-unnotified orders as unsettled; public preset slugs are seeded; and the load-orchestrator image includes k6.

**References:**
- `checkout-surge-opus/working_docs/project_planning.md:70` — status snapshot: Phases 1-10 delivered, 11 pending, 12 optional.
- `checkout-surge-opus/packages/db/drizzle/0002_single_non_terminal_run.sql:14` — claimed race-safe single-run index.
- `checkout-surge-opus/apps/api/src/services/startup-reconciliation-service.ts:1` — claimed startup reconciliation.
- `checkout-surge-opus/apps/api/src/services/run-finalization-service.ts:183` — notification-settlement gate.
- `checkout-surge-opus/packages/db/src/presets.ts:46` — claimed public preset slugs seeded.
- `checkout-surge-opus/apps/load-orchestrator/Dockerfile:6` — k6 baked into the image.

#### Verdict rationale

Both roadmaps truthfully report the same completion boundary and neither sampled roadmap overclaims. The compared roadmap's evidence is more detailed, but evidence depth is graded separately in C119. On truthfulness alone: same.

---

### C118 — Honest scoping: declared non-goals and deferrals (better)

#### Reference behavior

The baseline declares deferred capabilities in the owning design docs, especially the Redis hot-path choice to track expired holds without automatically releasing them. There is no consolidated limitation register, so a reviewer has to discover intentional deferrals doc by doc.

**References:**
- `checkout-forge/docs/redis_inventory_hot_path.md:67` — hold-expiry reconciliation declared as intentionally deferred.

#### Compared behavior

The compared implementation carries the same in-doc deferrals and adds a consolidated "Declared Demo Non-Goals" register in the roadmap, explicitly framed so intentional limitations are not mistaken for unfinished work. It lists no hold-expiry release, pending-persistence rows never resolving to a final state, best-effort notifications, no orchestrator stop endpoint on admin reset, lost enqueue hand-offs bounded by settle timeout, and deferred DLQ routing. A separate "Active Carry-Forwards" section tracks live caveats, including test-suite flake risk under Docker CPU contention and a superseded-but-kept BFF route.

**References:**
- `checkout-surge-opus/working_docs/project_planning.md:55` — consolidated non-goals register.
- `checkout-surge-opus/working_docs/project_planning.md:44` — active carry-forwards.
- `checkout-surge-opus/docs/redis_inventory_hot_path.md:71` — hold-expiry reconciliation deferral.

#### Verdict rationale

Both repos declare rather than hide important omissions, but the compared implementation makes the scoping auditable in one place and separates intentional non-goals from live caveats. That is a stronger self-description posture than the baseline's scattered per-doc deferrals. Better.

---

### C119 — Delivery journaling and claim traceability (better)

#### Reference behavior

The baseline roadmap records completion with checkmarks over detailed task prose. It does not maintain a per-task delivery record describing what was actually built, how it was verified, or where implementation decisions deviated from the plan. Verifying a baseline checkmark requires going straight to code.

**References:**
- `checkout-forge/working_docs/project_planning.md:632` — checked Task 10.1 prose without a delivery note or evidence trail.

#### Compared behavior

The compared repo pairs its roadmap with a `working_docs/implementation_notes/` archive. Phase notes include "Delivered" paragraphs naming the concrete mechanisms built, verification runs with test counts/manual checks, and implementation notes/deferrals for decisions the plan did not specify. The notes are also self-critical: they disclose an accepted budget-charge race edge and record a finalization gap found by the test matrix, which was then fixed and promoted into the canonical entity doc. A maintenance rule governs the plan/archive/canonical-docs flow, even though C114/C116 show it was not followed perfectly.

**References:**
- `checkout-surge-opus/working_docs/implementation_notes/phase-10.md:68` — Task 10.3a delivery note with mechanism and verification detail.
- `checkout-surge-opus/working_docs/implementation_notes/phase-10.md:77` — self-disclosed accepted race edge.
- `checkout-surge-opus/working_docs/project_planning.md:748` — finalization gap found and fixed in Task 10.4.
- `checkout-surge-opus/docs/core_business_entities.md:510` — promoted settled/delivery-grading semantics.
- `checkout-surge-opus/working_docs/implementation_notes/README.md:20` — archive maintenance rules.

#### Verdict rationale

For an autonomously built implementation, traceability matters: a reviewer needs to know whether checkmarks are evidence-backed. The compared repo gives a concrete delivery trail for sampled tasks, including verification and known caveats. The baseline has good task prose but no comparable evidence layer. Better.

---

### C120 — Setup instructions, commands, and documented defaults vs configured reality (same)

#### Reference behavior

The baseline local-development docs document commands, ports, env variables, and readiness payloads that match sampled code points. Every documented root command exists as a script, the documented `redis_url_configured` readiness check exists, and documented defaults such as ERP timeout, worker concurrency, drain timeout/poll interval, and retention match the configured values used elsewhere in the report.

**References:**
- `checkout-forge/package.json:1` — root scripts covering documented commands.
- `checkout-forge/apps/api/src/routes/health.ts:23` — documented readiness check name matches code.

#### Compared behavior

The compared command surface is script-for-script equivalent, plus a singular `maintenance:cleanup-run` alias. Its local-development doc is maintained against the compared code: it documents readiness check names (`redis_reachable`, `order_process_queue_reachable`) that exist in the readiness service; notification-queue env knobs and defaults consumed by the worker; and the important distinction that public custom-run caps are DB runtime-policy values seeded from `DEFAULT_PUBLIC_RUNTIME_POLICY`, not environment variables. It also documents ERP latency vs timeout behavior. The main weakness is residual seeded "should" phrasing in a few setup sentences for behavior that is already implemented.

**References:**
- `checkout-surge-opus/apps/api/src/services/readiness.ts:33` — documented readiness check names implemented.
- `checkout-surge-opus/apps/worker/src/runtime/config.ts:90` — documented notification env default consumed.
- `checkout-surge-opus/docs/local_development.md:398` — accurate "no `PUBLIC_CUSTOM_*` env knob" callout.
- `checkout-surge-opus/docs/local_development.md:22` — residual "should load `.env`" phrasing.

#### Verdict rationale

Commands were not executed, but static inspection shows both repos' setup docs align with their scripts and sampled configuration defaults. The compared doc is richer about its divergences from the seeded expectations, while the baseline is cleaner in tense and tone. Equivalent practical fidelity: same.

---

### C121 — Frontend TSX test discovery in standard commands (better)

#### Reference behavior

The baseline contains React/DOM-focused frontend suites written as `.test.tsx`, but the root unit Vitest config only includes `*.test.ts` paths. The web package's normal `test` and `test:unit` scripts both delegate to that root config, so those TSX suites are not discovered by the standard baseline test commands unless a developer invokes them by explicit file path or changes the include pattern. This is a command-discovery problem rather than an absence of tests: the suites exist, but the ordinary lanes do not run them.

**References:**
- `checkout-forge/vitest.config.ts:18` — unit include globs cover `.test.ts` paths only.
- `checkout-forge/apps/web/package.json:24` — web `test` delegates to `test:unit`, then API/integration lanes.
- `checkout-forge/apps/web/package.json:25` — web `test:unit` uses the root Vitest config.
- `checkout-forge/apps/web/src/app/dashboard-ui.dom.test.tsx:1` — representative TSX/jsdom suite outside those globs.

#### Compared behavior

The compared implementation also has many `.test.tsx` web component suites, but its web package owns a local Vitest config whose include pattern explicitly covers both `.test.ts` and `.test.tsx`. The package-level web `test` and `test:unit` scripts therefore run those TSX suites, and root `pnpm test` reaches them through Turbo's package `test` task. The remaining gap is at the root fast lane: `pnpm test:unit`, `pnpm test:watch`, and `pnpm test:coverage` use `vitest.unit.config.ts`, whose include pattern still only names `.test.ts`, so the compared repo's TSX component suites are missed by those root-level unit/coverage commands.

**References:**
- `checkout-surge-opus/apps/web/vitest.config.ts:17` — web-local include pattern covers `.test.{ts,tsx}`.
- `checkout-surge-opus/apps/web/package.json:11` — web package `test` runs the local config.
- `checkout-surge-opus/package.json:20` — root `test:unit` uses the root unit config instead.
- `checkout-surge-opus/vitest.unit.config.ts:11` — root unit include globs cover `.test.ts` paths only.
- `checkout-surge-opus/apps/web/test/unit/live-dashboard.test.tsx:1` — representative TSX suite covered by the web package lane but not the root unit lane.

#### Verdict rationale

The compared implementation is better because its full/package web test path actually discovers its TSX component suites, while the baseline's standard web test path does not discover its TSX DOM suites at all. The improvement is incomplete: the compared root unit/watch/coverage lanes still underreport frontend coverage by omitting `.test.tsx`, which reinforces C106's command-contract concerns. Still, relative to the baseline's normal web test behavior, the compared repo preserves more of its frontend test value in standard execution.

---

## Appendix — Method and caveats

- **Coverage.** This consolidated report covers contracts, PostgreSQL persistence, Redis hot path behavior, buy-path/API handling, run lifecycle and control plane, asynchronous order processing, realtime observability, load generation, dashboard UX, access protection and public-run governance, runtime topology and operations, testing strategy, and documentation fidelity.
- **Method.** The analysis was static inspection only — nothing was executed, no migrations run, no tests run, no Docker compose stack started, no images built, no smoke scripts run, no k6 execution, no browser UI session was opened, and no queues/Redis/PostgreSQL/mock ERP/runtime SSE behavior was exercised. Concurrency claims (C20/C90) rest on the single-Lua-script construction plus the presence of concurrency tests, not observed load behavior; sold-out cost at an actual 10k RPS (C23/C36), poll-cost impact during a 10k burst or large spectator audience (C61/C83), and load-metric backlog/aggregation behavior (C68) are reasoned, not measured; the index judgment (C18) is structural, not benchmarked. Verdicts on constraint behavior (C12-C14) rest on migration SQL and schema sources, corroborated by each repo's own integration tests where present. Race-window claims in the lifecycle layer (C45's draining-window acceptance, C47's reset/finalization race), worker-layer claims such as breaker/queue interaction (C53) and crash-after-ERP-success replay (C54), SSE reconnect/backpressure behavior (C59/C75/C76), browser render behavior (C77/C83), load-orchestrator report-loss/control behavior (C69/C71), direct-service authorization exposure (C87/C88), runtime-ops script behavior (C101-C103), testing-command defects/coverage-depth claims (C106-C113 and C121), and setup-command correctness claims (C114/C120) are code/config/documentation analysis, not reproduced runs.
- **Boundary discipline.** Findings noted in one topic but owned by another: DB constraint depth consequences of the entity reinterpretations in C3 are covered by C12/C18; per-run backpressure vocabulary shape in C9 is enforced or not enforced in C52; browser-side recovery/discard discipline and rendering cadence for the server surfaces in C36/C38/C57/C60/C61 are covered in C75/C83; security mechanics for budget/start/reset/delete/chaos/orchestrator/session surfaces are covered in C85-C95; queue publish anomalies are API sequencing in C35 while worker consumption/redelivery is C50/C54; runtime topology, reverse proxy, image packaging, env conventions, and ops scripts are covered in C96-C105; test compose mechanics are C105 while the testing methodology built on them is C106-C113, with C121 calling out a narrower frontend TSX discovery issue; the roadmap-task references saturating the compared build's contract doc comments in C1, stale comments visible in the compared web/runtime scripts in C77/C79/C102, and the compared testing doc's possible schema-fingerprint drift in C108 are covered by the documentation-fidelity topics C114-C120 where supported by the consolidated evidence.
- **Shared gap, graded nowhere as a difference:** in both implementations a hard process crash between the Redis gate and the failure-time sentinel write leaves a secured hold that no pending tracker sees (the compared side's replay path self-corrects the *buyer-facing* answer via the durable read; operator counts still miss it until the hold expires into the expired count).
- **Shared public-abuse gaps.** Rate limiting on public read/realtime paths appears implemented in neither codebase beyond payload-size guards, and admin-login throttling is absent in both. These were not raised as separate topics because the omissions are symmetric.
- **Topology caveat.** C96 confirms both reference topologies publish direct service ports as debug surfaces while routing browsers through one proxy origin. That mitigates exposure for C87/C88 but does not satisfy the shared spec's service-side enforcement rule for direct API/orchestrator calls.
- **SSE sanitization caveat.** C92 reviewed SSE/public payload sanitization at the contract-schema level rather than tracing every publisher; event production and live read models are covered by C8 and C59–C61.
- **Not fully verified.** The internal-helper-leakage question (contract package organization) was checked only at barrel-export level — both packages wholesale-export every module and neither shows obviously internal types in the public surface; no per-symbol audit. Whether the compared implementation's application layer enforces every invariant the baseline puts in CHECK constraints was not verified (C12 grades the database layer's protection, not total system correctness). Parse-site and import counts (C11) are grep approximations, an order-of-magnitude signal rather than precise metrics. The baseline's `dist/` build artifacts were ignored. The run-lifecycle analysis inferred the baseline's summary-repository insert-if-absent behavior from call sites and naming, while the compared partial unique index was already verified directly in C14. k6 parser/version-risk claims (C70/C74) were read from parser structure, pinned Dockerfiles, and tests; neither parser was run against both k6 versions' real output. Runtime-image size, actual Docker layer-cache behavior, compose health ordering, Caddy streaming behavior, smoke cleanup safety, and dev-container behavior (C96-C105) were inferred from files and scripts, not executed. Test counts are approximate grep-derived counts and include parameterized cases unevenly; dead code, duplication, local schema redeclarations, skipped tests, and module-level singleton checks were sampled rather than exhaustively audited. The roadmap audit was sampled rather than exhaustive, the baseline's fidelity was largely treated as the reference comparison point, and setup-instruction correctness was checked statically rather than by executing the documented commands.
- **Naming.** References use the actual repo directory `checkout-surge-opus/…` (the format doc's examples abbreviate the compared repo as `checkout-surge/`).
- **Table counts** (15 baseline vs 14 compared, C3) were confirmed against each repo's own schema integration assertions and migration SQL.
- **No `unknown` verdicts** — every consolidated topic could be graded from the inspected code, configuration, and documentation sources.
