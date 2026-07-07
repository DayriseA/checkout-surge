# Consolidated Comparison Report - checkout-forge vs checkout-surge-glm

This report compares checkout-forge and checkout-surge-glm across shared contracts and vocabulary, durable PostgreSQL persistence, the Redis inventory hot path, the API buy path under surge, API boundary validation and cross-service request correlation, the demo-run lifecycle/control plane, the asynchronous order pipeline/downstream resilience layer, realtime observability/read models, load generation/benchmark measurement, the web dashboard frontend/UX surface, access protection/public-run governance, runtime topology/packaging/operational tooling, the testing strategy/engineering quality system, and documentation fidelity/roadmap truthfulness. It merges overlapping findings into consolidated comparison topics.

| Code | Topic | Verdict |
| :-- | :-- | :-- |
| C1 | Entity model and durable schema coverage | same |
| C2 | Canonical vocabulary source and enum derivation | better |
| C3 | Shared lifecycle transition discipline | better |
| C4 | Derived simulated purchase status surface | worse |
| C5 | Buy-flow contract and HTTP response surface | worse |
| C6 | Shared error payload and code governance | better |
| C7 | Realtime event and metric contracts | better |
| C8 | Contract strictness, primitives, and package boundary | same |
| C9 | Database CHECK constraints and non-enum invariant enforcement | worse |
| C10 | Referential integrity and delete semantics | worse |
| C11 | Run-offer ownership enforcement and nullable-run edge case | same |
| C12 | One-current-run storage invariant | better |
| C13 | PostgreSQL index coverage | worse |
| C14 | Migration hygiene | same |
| C15 | Seed data and re-seed idempotency | same |
| C16 | Lifecycle timestamp invariants in PostgreSQL | worse |
| C17 | JSONB typing and write-side validation | same |
| C18 | Redis reservation gate atomicity and race safety | better |
| C19 | Idempotency record lifecycle, queue handoff, and replay consistency | better |
| C20 | Idempotency scope, conflict rule, and TTL edge cases | same |
| C21 | Sold-out and high-frequency realtime cost profile | worse |
| C22 | Pending-persistence visibility and reconciliation | better |
| C23 | Redis keyspace isolation and cleanup hygiene | same |
| C24 | Expired-hold tracking and inventory status projection | same |
| C25 | Terminal Redis inventory snapshot in durable history | same |
| C26 | Hot-path and hard-property test coverage | better |
| C27 | Order and inventory query surfaces | worse |
| C28 | Surge listener and PostgreSQL pool tuning | same |
| C29 | Preset management and public-custom defaults | same |
| C30 | Run creation, frozen snapshots, and isolated inventory | same |
| C31 | Failed-start handling and summary-backed history | worse |
| C32 | Traffic completion vs business completion boundary | same |
| C33 | Drain settlement gate and timeout semantics | worse |
| C34 | Traffic delivery classification and unexpected responses | worse |
| C35 | Startup reconciliation and crash recovery | same |
| C36 | Admin reset and live-run recovery | worse |
| C37 | Old-run cleanup and targeted teardown | better |
| C38 | Lifecycle eligibility closure and late buy traffic | worse |
| C39 | Run-scoped downstream retry and timeout policy | worse |
| C40 | Durable worker order lifecycle and attempt history | worse |
| C41 | Circuit breaker retry cooperation | worse |
| C42 | Mock ERP chaos scoping and precedence | worse |
| C43 | Simulated notification follow-up durability | worse |
| C44 | Worker realtime milestones and consistency-lag pipeline | worse |
| C45 | Internal realtime publication discipline | same |
| C46 | SSE stream gateway and fan-out mechanics | better |
| C47 | Dashboard recovery read model and terminal settle | same |
| C48 | Queue, ERP, and readiness status projections | better |
| C49 | Realtime and read-model test coverage | same |
| C50 | k6 ownership, service boundary, and readiness | same |
| C51 | Traffic model mapping and generator capacity | worse |
| C52 | Attempt identity and script-parameter safety | same |
| C53 | k6 output parsing and terminal accounting | worse |
| C54 | Live k6 metric streaming pipeline | same |
| C55 | Completion-report reliability and cancellation controls | worse |
| C56 | Web route split and public/admin surface layout | same |
| C57 | Frontend recovery and realtime coordination | same |
| C58 | Browser SSE client transport and reconnect UX | same |
| C59 | Live watch UX and run-context storytelling | worse |
| C60 | Public custom run form | missing |
| C61 | Run history frontend surface | worse |
| C62 | Admin console frontend completeness | worse |
| C63 | Web BFF proxy discipline and secret containment | same |
| C64 | Frontend architecture and state decomposition | better |
| C65 | Degraded-state handling of web backend reads | better |
| C66 | Frontend behavior test coverage | same |
| C67 | Admin session and web proxy authorization chain | better |
| C68 | Direct-service authorization boundaries | same |
| C69 | Public visitor identity and budget enforcement | better |
| C70 | Runtime policy and hard-cap governance | worse |
| C71 | Secret defaults and production fail-closed posture | worse |
| C72 | Admin-only destructive operation protection | same |
| C73 | Public-safe read DTO discipline | same |
| C74 | Reference runtime service topology | same |
| C75 | Single-origin reverse proxy and SSE routing | better |
| C76 | Container image construction | better |
| C77 | Explicit setup/startup lifecycle | same |
| C78 | Container environment and config propagation | worse |
| C79 | Runtime health and non-mutating smoke checks | same |
| C80 | Mutating dashboard load smoke | better |
| C81 | Dev Container dependency-volume isolation | worse |
| C82 | Test infrastructure isolation and guardrails | better |
| C83 | Root test taxonomy and command contract | worse |
| C84 | Reset determinism and schema self-healing | worse |
| C85 | Service-boundary testability and dependency injection | same |
| C86 | Access-control and public-governance test coverage | same |
| C87 | Repo-wide type, lint, and test type-check gates | worse |
| C88 | README status and setup-command accuracy | better |
| C89 | Roadmap status consistency | worse |
| C90 | Design-document adaptation to implementation | worse |
| C91 | Implementation-history audit trail | better |
| C92 | Portfolio-facing explanation completeness | worse |
| C93 | Cross-service request correlation plumbing | better |
| C94 | Server-side outbound response contract validation | worse |

---

### C1 — Entity model and durable schema coverage (same)

#### Reference behavior

Checkout-Forge models the full required entity set across its contracts and PostgreSQL schema: products, sale offers with catalog/generated purpose, reservations, orders, ERP attempts, order events, presets, runs, run-offer ownership, pending persistence, simulated notifications, outcome aggregates, finalizations, immutable summaries, and the public runtime policy singleton. Finalization and summary are separate records, sold-out attempts are aggregated rather than persisted one row per loser, and a confirmed order is anchored to exactly one reservation.

**References:**
- `checkout-forge/packages/db/src/schema.ts:79` - full table block covering the required entity model.
- `checkout-forge/packages/db/src/schema.ts:73` - sale-offer purpose enum for catalog vs generated-run offers.
- `checkout-forge/packages/db/src/schema.ts:493` - finalization and summary kept as separate one-per-run records.
- `checkout-forge/packages/contracts/src/domain.ts:60` - contract-level entity schemas for core business records.

#### Compared behavior

Checkout-Surge-GLM models the same entity set with the same responsibilities. The schema comments explicitly number the tables against the entity document; finalization and summary remain separate; the run-offer ownership link is dedicated; order-to-reservation traceability is enforced with a unique reservation reference. It adds reasonable extensions, notably a `backend` discriminator and benchmark-signal JSON on summaries, and uses a larger counter type for sold-out aggregates.

**References:**
- `checkout-surge-glm/packages/db/src/schema.ts:139` - numbered table sections mapping to the required entities.
- `checkout-surge-glm/packages/db/src/schema.ts:354` - dedicated run-offer ownership link.
- `checkout-surge-glm/packages/db/src/schema.ts:465` - one finalization per run, with one summary per run at line 509.
- `checkout-surge-glm/packages/db/src/schema.ts:491` - summary extensions for benchmark signals and backend identity.

#### Verdict rationale

Both implementations preserve the same domain shape rather than collapsing or omitting entities. GLM's documentation in the schema and small comparison-oriented extensions are useful, while Forge exposes richer full entity schemas in the contracts layer. The durable model itself is equivalent; constraint strength and indexing are separated into later topics.

---

### C2 — Canonical vocabulary source and enum derivation (better)

#### Reference behavior

Forge defines the required lifecycle, event, metric, and queue vocabularies in contract modules, but the database re-declares many enum string sets independently in `pgEnum` calls. Some machine-readable values remain free-form, such as demo-run failure reasons. The baseline does generate an event-name CHECK from the shared event vocabulary, but the broader vocabulary architecture still depends on parallel copies staying aligned by discipline.

**References:**
- `checkout-forge/packages/contracts/src/domain.ts:12` - reservation, order, attempt, and event vocabularies.
- `checkout-forge/packages/db/src/schema.ts:45` - PostgreSQL enums re-declared as inline string literals.
- `checkout-forge/packages/contracts/src/demo-runs.ts:659` - `failureReason` as nullable free-form string.
- `checkout-forge/packages/contracts/src/metrics.ts:10` - reserved metric-name enum.

#### Compared behavior

GLM centralizes the vocabulary layer in `vocabularies.ts` and derives Zod enums and PostgreSQL enums from those constants. It covers statuses, reasons, purposes, operator modes, traffic vocabularies, events, metrics, queue names, and backend identifiers. Failure reasons are stable enum values, queue-name mapping fails loud on drift, and the vocabulary set is tested.

**References:**
- `checkout-surge-glm/packages/contracts/src/vocabularies.ts:21` - canonical vocabulary constants.
- `checkout-surge-glm/packages/contracts/src/enums.ts:34` - Zod enums derived from vocabulary constants.
- `checkout-surge-glm/packages/db/src/schema.ts:20` - database schema imports contract constants for pgEnums.
- `checkout-surge-glm/packages/contracts/src/queue.ts:25` - semantic-to-physical queue-name mapping.
- `checkout-surge-glm/packages/contracts/tests/vocabularies.test.ts:1` - vocabulary self-tests.

#### Verdict rationale

GLM is stronger at the shared-language layer because contract schemas and database enums derive from one source. That does not mean its database invariant posture is stronger overall; C9 covers the missing CHECK constraints and unconstrained text fields. For vocabulary authorship and enum drift prevention specifically, GLM is better.

---

### C3 — Shared lifecycle transition discipline (better)

#### Reference behavior

Forge defines the canonical reservation, order, run, and traffic status sets and keeps retry state out of order status. Legal transitions, however, are not part of the shared contract layer; services enforce lifecycle ordering in their own code.

**References:**
- `checkout-forge/packages/contracts/src/load.ts:13` - run lifecycle and traffic execution status enums.
- `checkout-forge/packages/contracts/src/dashboard.ts:62` - retry surfaced as derived fields rather than as order status.

#### Compared behavior

GLM adds shared transition maps and guard helpers for reservations and orders, plus a shared transition-to-event mapping. It also documents and types the distinction between traffic execution status, traffic delivery classification, and API-owned run lifecycle status so those vocabularies do not cross-contaminate payloads.

**References:**
- `checkout-surge-glm/packages/contracts/src/lifecycle.ts:24` - legal reservation and order transition maps.
- `checkout-surge-glm/packages/contracts/src/lifecycle.ts:60` - transition-to-event-name derivation.
- `checkout-surge-glm/packages/contracts/src/dashboard-events.ts:79` - typed split between delivery and execution status on run-state events.
- `checkout-surge-glm/packages/contracts/src/vocabularies.ts:129` - source documentation for traffic vocabulary separation.

#### Verdict rationale

Both honor the spec's state vocabulary split. GLM turns transition legality and event derivation into shared, reusable contract behavior, reducing cross-service drift. That is a real improvement in the shared lifecycle layer.

---

### C4 — Derived simulated purchase status surface (worse)

#### Reference behavior

Forge implements the buyer-facing simulated purchase status as a derived vocabulary. It appears in buy/order-status-facing contracts and realtime order-status events, is computed from reservation plus order state, and is not persisted as its own database status.

**References:**
- `checkout-forge/packages/contracts/src/domain.ts:25` - derived customer-status vocabulary.
- `checkout-forge/packages/contracts/src/buy-flow.ts:99` - order-status response includes customer status and timeline.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:1` - service-side derivation feeds responses and events.

#### Compared behavior

GLM declares the simulated purchase status vocabulary but does not use it outside the contracts package. Buy responses do not carry the derived status, and the order lookup route returns the raw persisted order without a contract-defined response, timeline, or derived customer status. The good part is that GLM also does not persist this presentation vocabulary.

**References:**
- `checkout-surge-glm/packages/contracts/src/vocabularies.ts:182` - declared simulated purchase statuses.
- `checkout-surge-glm/apps/api/src/app/routes/orders.ts:13` - order lookup returns raw persisted order data.

#### Verdict rationale

The baseline delivers the derived presentation surface end to end. GLM has the vocabulary but leaves it inert, so buyers and clients cannot obtain the intended presentation status through the API. This is worse, though not missing entirely because the vocabulary and underlying reservation/order data exist.

---

### C5 — Buy-flow contract and HTTP response surface (worse)

#### Reference behavior

Forge defines a three-way buy response union for secured, pending-persistence, and rejected outcomes. The HTTP route validates the incoming request, validates the service result against the shared response schema before sending it, and emits machine-readable headers for `x-checkout-outcome` plus rejected-response reason. Pending-persistence responses include retry guidance, and idempotency conflict is represented as a rejection reason rather than its own top-level outcome.

**References:**
- `checkout-forge/packages/contracts/src/buy-flow.ts:72` - three-outcome buy response union.
- `checkout-forge/packages/contracts/src/buy-flow.ts:78` - outcome and rejection response headers.
- `checkout-forge/packages/contracts/src/buy-flow.ts:57` - pending-persistence retry hint.
- `checkout-forge/apps/api/src/routes/buy.ts:53` - route validates the response body before send.
- `checkout-forge/apps/api/src/routes/buy.ts:56` - outcome and rejection headers are set on buy responses.

#### Compared behavior

GLM defines a five-way response union with secured, pending-persistence, sold-out, not-initialized, and idempotency-conflict as first-class discriminants. It models idempotent replay as a flag on accepted variants, includes a contract schema for the Redis-stored accepted idempotency record, and adds an explicit run-identity header helper. The route validates the request body and run-id agreement, but sends the service result directly: it does not parse the response through `BuyResponseSchema`, does not emit the baseline outcome/rejection headers, and its pending-persistence body has no retry-after or persistence-guidance field.

**References:**
- `checkout-surge-glm/packages/contracts/src/buy.ts:211` - five-outcome buy response union.
- `checkout-surge-glm/packages/contracts/src/buy.ts:133` - `idempotentReplay` flag.
- `checkout-surge-glm/packages/contracts/src/buy.ts:53` - run-identity header extraction.
- `checkout-surge-glm/apps/api/src/app/routes/buy.ts:43` - route sends the service result directly.
- `checkout-surge-glm/packages/contracts/src/buy.ts:148` - pending-persistence schema lacks retry guidance.

#### Verdict rationale

Both cover the required buy outcomes, and GLM's body discriminants are cleaner for ordinary API clients. For the surge-oriented API surface, however, the regression is material: the load generator cannot classify outcomes from cheap headers, callers get no retry cadence for pending-persistence, and the HTTP edge does not revalidate its outbound body. That makes GLM worse on the buy-flow response surface even though its internal outcome taxonomy is good.

---

### C6 — Shared error payload and code governance (better)

#### Reference behavior

Forge's shared error payload matches the required shape: `code`, `message`, optional `details`, `correlationId`, and timestamp. The `code` field is any non-empty string, so stability depends on route implementations staying disciplined.

**References:**
- `checkout-forge/packages/contracts/src/common.ts:41` - shared error response with free-form code.

#### Compared behavior

GLM uses the same payload shape but constrains `code` to a documented error-code vocabulary unioned with failure and rejection reason vocabularies. It also adds a structured validation-issue shape, helper constructors, a control-token header constant, and tests for the error contract.

**References:**
- `checkout-surge-glm/packages/contracts/src/errors.ts:26` - stable error-code vocabulary.
- `checkout-surge-glm/packages/contracts/src/errors.ts:97` - error `code` validated against the vocabulary.
- `checkout-surge-glm/packages/contracts/src/errors.ts:136` - validation issue shape and helper.
- `checkout-surge-glm/packages/contracts/tests/errors.test.ts:1` - error-contract tests.

#### Verdict rationale

GLM keeps the same external shape while making machine-readable codes governed by the shared contract. That is exactly the right friction for a cross-service error surface.

---

### C7 — Realtime event and metric contracts (better)

#### Reference behavior

Forge uses a four-type realtime dashboard union and validates events at publish, fan-out, and browser consumption. Its payload typing is looser in places: metrics are a generic name/value/unit/dimensions shape with optional per-metric refinements, and `customerStatus` on order events is a bare string.

**References:**
- `checkout-forge/packages/contracts/src/events.ts:51` - four-type realtime union.
- `checkout-forge/packages/contracts/src/events.ts:24` - order event customer status typed as string.
- `checkout-forge/packages/contracts/src/metrics.ts:20` - generic metric sample shape.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` - consumer-side validation.

#### Compared behavior

GLM models realtime as a larger discriminated union over typed event names, reuses durable event payload schemas where appropriate, defines per-metric sample schemas, validates before publication and at fan-out, and revalidates in the web client. It also defines SSE frame shape and a realtime publisher port.

**References:**
- `checkout-surge-glm/packages/contracts/src/dashboard-events.ts:99` - typed event union.
- `checkout-surge-glm/packages/contracts/src/load.ts:214` - per-metric sample schemas.
- `checkout-surge-glm/apps/api/src/app/dashboard-realtime/fanout.ts:115` - fan-out validation and malformed-event drop.
- `checkout-surge-glm/apps/web/components/realtime/use-dashboard-events.ts:136` - browser-side schema validation.

#### Verdict rationale

Both implementations validate realtime data at the important boundaries. GLM's per-event and per-metric typing removes stringly and grab-bag areas in the baseline. That stronger contract precision earns `better`; C21 separately covers GLM's sold-out event volume problem.

---

### C8 — Contract strictness, primitives, and package boundary (same)

#### Reference behavior

Forge is structurally strict: many schemas use `.strict()`, identifiers and correlation IDs are bounded, and cross-field `superRefine` checks cover configuration and summary invariants. Its weaknesses are `z.unknown()` holes in dashboard/summary records, some stringly event fields, and a contract package that includes producer-specific diagnostics and UI-flavored metadata.

**References:**
- `checkout-forge/packages/contracts/src/common.ts:10` - bounded correlation ID primitive.
- `checkout-forge/packages/contracts/src/demo-runs.ts:393` - policy-vs-limit cross-validation.
- `checkout-forge/packages/contracts/src/load.ts:393` - run summary status restricted to terminal states.
- `checkout-forge/packages/contracts/src/dashboard.ts:133` - `z.unknown()` fields.
- `checkout-forge/packages/contracts/src/load.ts:288` - orchestrator diagnostics in shared contracts.

#### Compared behavior

GLM is stricter semantically in several places: enforced error and failure vocabularies, typed JSONB summary shapes, cap-aware schema factories, and recovery-response cross-field validation. It is looser structurally: no `.strict()` usage, unbounded correlation and idempotency key primitives, and a summary status schema that accepts non-terminal run statuses. Its contracts package is well documented and well tested but contains executable policy/crypto/retry logic despite a declared "depends only on zod" boundary, which creates browser-bundle risk through the single entrypoint.

**References:**
- `checkout-surge-glm/packages/contracts/src/common.ts:34` - unbounded correlation and idempotency key primitives.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:419` - summary status accepts full run lifecycle.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:40` - typed summary subdocuments.
- `checkout-surge-glm/packages/contracts/src/dashboard-recovery.ts:165` - recovery response cross-field refinement.
- `checkout-surge-glm/packages/contracts/src/admin-access.ts:24` - Node crypto imports inside contracts.

#### Verdict rationale

Each side is stricter in different dimensions and leaks different concerns through its contracts package. Forge wins on bounded primitives, strict object rejection, and cleaner runtime dependency assumptions; GLM wins on semantic vocabularies, typed JSON documents, documentation, and tests. Net result is `same`.

---

### C9 — Database CHECK constraints and non-enum invariant enforcement (worse)

#### Reference behavior

Forge pushes many invariants into PostgreSQL CHECK constraints: positive quantities, non-negative stock and latency, sale-window sanity, preset editability rules, terminal-only summary status, known aggregate vocabulary, runtime-policy singleton identity, and event-name validity. It also has a unique constraint on reservation tokens and integration tests that exercise these constraints directly.

**References:**
- `checkout-forge/packages/db/src/schema.ts:41` - event-name CHECK generated from contracts.
- `checkout-forge/packages/db/src/schema.ts:137` - preset read-only/editable CHECKs.
- `checkout-forge/packages/db/src/schema.ts:489` - terminal-only summary status.
- `checkout-forge/packages/db/src/schema.ts:531` - runtime-policy singleton CHECK.
- `checkout-forge/packages/db/test/vocabulary-constraints.integration.test.ts:1` - database constraint tests.

#### Compared behavior

GLM has strong enum sourcing from contracts, but its migrations contain no CHECK constraints. Non-enum invariants such as positive quantities, valid sale windows, preset editability, terminal-only summaries, singleton policy identity, and event-name validity are not defended by the database. `order_events.event_name` is unconstrained text, summary status uses the full run-status enum, and reservation tokens are not unique.

**References:**
- `checkout-surge-glm/packages/db/migrations/0000_burly_random.sql:12` - full initial DDL with no CHECK constraints.
- `checkout-surge-glm/packages/db/src/schema.ts:90` - PostgreSQL enums derived from contract constants.
- `checkout-surge-glm/packages/db/src/schema.ts:263` - event name stored as unconstrained text.
- `checkout-surge-glm/packages/db/src/schema.ts:472` - summary status uses full run status enum.
- `checkout-surge-glm/packages/db/src/schema.ts:179` - reservations table has no unique token constraint.

#### Verdict rationale

GLM is better at enum drift prevention, but the database accepts many invalid rows Forge rejects. For the database-integrity question "what happens when a buggy or bypassing write occurs?", GLM is materially weaker.

---

### C10 — Referential integrity and delete semantics (worse)

#### Reference behavior

Forge uses restrictive foreign keys for run-attributed business rows so accidental run deletion fails instead of detaching audit history. Runs have a non-null, unique sale-offer relationship, and orders are tied to reservations with a non-null unique reservation reference.

**References:**
- `checkout-forge/packages/db/src/schema.ts:205` - run-attributed reservation FK uses `onDelete: "restrict"`.
- `checkout-forge/packages/db/src/schema.ts:160` - `demo_runs.sale_offer_id` is non-null, restricted, and unique.
- `checkout-forge/packages/db/src/schema.ts:245` - order-to-reservation reference is non-null, restricted, and unique.

#### Compared behavior

GLM preserves the order-to-reservation anchor, but most business-row `run_id` references use `ON DELETE SET NULL`. Deleting a run can detach reservations, orders, attempts, events, and notifications from their run. `demo_runs.sale_offer_id` is nullable, set-null, and non-unique; the ownership link's sale-offer FK cascades.

**References:**
- `checkout-surge-glm/packages/db/src/schema.ts:185` - reservations `run_id` uses `set null`, repeated across business rows.
- `checkout-surge-glm/packages/db/src/schema.ts:322` - `demo_runs.sale_offer_id` nullable and set-null.
- `checkout-surge-glm/packages/db/src/schema.ts:361` - ownership link cascades on sale-offer deletion.
- `checkout-surge-glm/packages/db/src/schema.ts:211` - order-to-reservation anchor preserved.

#### Verdict rationale

The intended cleanup path may still delete rows deliberately, but the schema's failure mode is weaker: unintended deletes silently erase attribution rather than failing loudly. That undermines auditability compared with the baseline.

---

### C11 — Run-offer ownership enforcement and nullable-run edge case (same)

#### Reference behavior

Forge enforces generated-run sale-offer ownership with composite foreign keys plus hand-authored PL/pgSQL triggers. The triggers cover the important nullable-`runId` edge case where composite FKs under `MATCH SIMPLE` can silently skip enforcement, and also ensure ownership links point only at generated-run offers.

**References:**
- `checkout-forge/packages/db/src/schema.ts:220` - composite FK from reservations to the run-offer ownership pair.
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:1` - trigger enforcing generated-run offer purpose.
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:26` - trigger closing the nullable-run attribution gap.

#### Compared behavior

GLM independently implements equivalent trigger enforcement and explicitly documents the same `MATCH SIMPLE` pitfall in the migration. It covers the same business tables and tests mismatched and null `run_id` rejection. It does not add Forge's extra composite-FK layer, so the trigger is the primary defense, but the invariant coverage is equivalent.

**References:**
- `checkout-surge-glm/packages/db/migrations/0000_burly_random.sql:276` - migration comment naming the `MATCH SIMPLE` gap.
- `checkout-surge-glm/packages/db/migrations/0000_burly_random.sql:308` - attribution trigger rejecting null or mismatched run IDs for generated offers.
- `checkout-surge-glm/packages/db/tests/triggers.integration.test.ts:1` - trigger integration tests.

#### Verdict rationale

This is one of the most subtle data-integrity traps in the system, and GLM catches it. Forge has a thicker defense stack because it also has composite FKs, but both prevent the edge case that matters.

---

### C12 — One-current-run storage invariant (better)

#### Reference behavior

Forge enforces the one-active-or-draining run rule in application code. Run creation happens inside a transaction that takes a PostgreSQL advisory lock, re-checks for a live `starting`/`active`/`draining` run, and maps a loser to a typed `active_run_conflict` error. That is correct for the intended API path, but the database itself has status indexes rather than a unique constraint, so a writer that bypasses the repository method can still insert overlapping current runs.

**References:**
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:36` - lock, live-run check, and insert in one transaction.
- `checkout-forge/apps/api/src/repositories/demo-run-repository.ts:53` - advisory transaction lock serializes normal run creation.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:136` - conflict surfaced as `active_run_conflict`.
- `checkout-forge/packages/db/src/schema.ts:148` - run status is indexed, but there is no live-run uniqueness constraint.

#### Compared behavior

GLM adds a partial unique index over `demo_runs` where status is `starting` or `active`, making concurrent start insertion race-safe at the storage boundary. An application pre-check still treats `draining` as blocking for deterministic 409 responses, and insert-time unique violations are caught by SQLSTATE plus constraint name and mapped back to the same typed overlap response.

**References:**
- `checkout-surge-glm/packages/db/migrations/0002_one_current_run.sql:1` - partial unique index for current runs.
- `checkout-surge-glm/packages/db/src/schema.ts:333` - design rationale for the index and draining exclusion.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-creation.ts:66` - exact unique-violation detection for the current-run constraint.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:424` - race loser converted to deterministic overlap response.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-lifecycle.ts:279` - application gate treats `starting`/`active`/`draining` as blocking.

#### Verdict rationale

Both implementations correctly reject a second start through the normal service path, including under concurrency. GLM does not encode the entire active-or-draining rule in PostgreSQL, but it closes the creation race at the storage boundary and protects future or bypassing writers better than an application-only advisory lock. This remains a concrete improvement.

---

### C13 — PostgreSQL index coverage (worse)

#### Reference behavior

Forge includes secondary indexes for the product's actual read patterns: run-scoped orders, events, ERP attempts, pending persistence, notifications, run history, run status, start times, and presets. These support finalization polling, event timelines, history pagination, and run-scoped reads.

**References:**
- `checkout-forge/packages/db/drizzle/0000_initial_schema.sql:274` - block of secondary indexes.
- `checkout-forge/packages/db/src/schema.ts:264` - composite order index for run-scoped reads.

#### Compared behavior

GLM has no secondary indexes beyond unique constraints and the one-current-run partial index. Run-scoped reads, finalization checks, event timelines, attempt history, and history pagination fall back to sequential scans; FK columns are also unindexed.

**References:**
- `checkout-surge-glm/packages/db/migrations/0000_burly_random.sql:12` - initial DDL lacks `CREATE INDEX` statements.
- `checkout-surge-glm/packages/db/src/schema.ts:528` - schema table definitions without secondary index declarations.

#### Verdict rationale

The dataset may stay small enough for demo operation, but the compared implementation omits the indexes aligned with repeated run-scoped access patterns. This is a clear database fitness gap.

---

### C14 — Migration hygiene (same)

#### Reference behavior

Forge keeps an incremental Drizzle migration history with a generated initial schema and a separate hand-authored trigger migration. The trigger migration is known to be invisible to ORM introspection and fragile under squashing.

**References:**
- `checkout-forge/packages/db/drizzle/0001_run_attribution_triggers.sql:1` - separate trigger migration.
- `checkout-forge/packages/db/drizzle/meta/_journal.json:1` - Drizzle journal for migration history.

#### Compared behavior

GLM keeps a three-step incremental migration history: initial schema with embedded triggers, benchmark-signal additions, and the current-run index. It documents the same trigger-preservation caveat, has a dedicated migrator entry point, and tests migration application and idempotent re-run.

**References:**
- `checkout-surge-glm/packages/db/migrations/meta/_journal.json:1` - incremental migration journal.
- `checkout-surge-glm/packages/db/src/schema.ts:14` - trigger-preservation caveat.
- `checkout-surge-glm/packages/db/src/migrate.ts:41` - migration entry point.
- `checkout-surge-glm/packages/db/tests/migrations.integration.test.ts:1` - migration integration tests.

#### Verdict rationale

Both use real incremental migrations and both carry hand-authored trigger SQL with the same long-term fragility. GLM's embedded triggers are slightly easier to lose during regeneration, but its migration tests and migrator are stronger. Net: same.

---

### C15 — Seed data and re-seed idempotency (same)

#### Reference behavior

Forge seeds the required baseline product, catalog offer, inventory event, Redis inventory state, public/admin presets, and runtime-policy singleton using fixed IDs and idempotent upsert/insert behavior. Re-seeding converges rather than duplicating, and tests cover idempotency and preset modes.

**References:**
- `checkout-forge/packages/db/src/seed.ts:42` - fixed-ID baseline seed and Redis reset.
- `checkout-forge/packages/db/src/public-runtime-policy.ts:49` - insert-only policy seed.
- `checkout-forge/packages/db/test/schema-seed.integration.test.ts:1` - seed idempotency tests.

#### Compared behavior

GLM seeds the same required baseline with fixed IDs and idempotent behavior. It contract-validates preset configs and policy data before persistence and uses an explicit ownership split: code-owned read-only rows are updated by seed, while operator-owned editable rows and policy survive routine setup.

**References:**
- `checkout-surge-glm/packages/db/src/seed-data.ts:241` - contract parsing of seeded preset configs.
- `checkout-surge-glm/packages/db/src/seed-data.ts:349` - ownership-based upsert strategy.
- `checkout-surge-glm/packages/db/src/seed-data.ts:405` - insert-only policy singleton.
- `checkout-surge-glm/packages/db/tests/seed.integration.test.ts:1` - seed idempotency and ownership tests.

#### Verdict rationale

Both satisfy the required baseline and are re-seed safe. GLM is stronger on contract-validating seeded JSON; Forge additionally seeds an inventory event and supports explicit preset reseed behavior. Equivalent outcome.

---

### C16 — Lifecycle timestamp invariants in PostgreSQL (worse)

#### Reference behavior

Forge enforces timestamp coherence in PostgreSQL. Released and expired reservations require the matching timestamp; confirmed and failed orders require terminal timestamps; in-progress orders require processing timestamps; terminal timestamps cannot precede queue time; ERP attempts must finish after they start with non-negative latency. Integration tests exercise these invariants.

**References:**
- `checkout-forge/packages/db/src/schema.ts:271` - order status/timestamp CHECK block.
- `checkout-forge/packages/db/src/schema.ts:318` - ERP attempt timing CHECK.
- `checkout-forge/packages/db/test/lifecycle-timestamp-invariants.integration.test.ts:1` - invariant tests.

#### Compared behavior

GLM does not enforce these timestamp invariants in the database. Terminal order timestamps are nullable with no coherence checks, ERP `finished_at` and `latency_ms` are nullable with no ordering checks, and `reservations.secured_at` is nullable. The durable audit trail can accept inconsistent lifecycles if application code miswrites.

**References:**
- `checkout-surge-glm/packages/db/src/schema.ts:202` - order timestamps nullable with no coherence checks.
- `checkout-surge-glm/packages/db/src/schema.ts:237` - ERP attempt latency and finish time nullable.
- `checkout-surge-glm/packages/db/src/schema.ts:190` - reservation secured timestamp nullable.

#### Verdict rationale

The baseline enforces and tests these lifecycle facts at the durable boundary; GLM assumes them. That is a clear regression for audit integrity.

---

### C17 — JSONB typing and write-side validation (same)

#### Reference behavior

Forge types JSONB columns with contract-derived TypeScript types, covering preset configs, run snapshots, summaries, and policy. Runtime policy is parsed on write and read. Structured versus JSONB boundaries are reasonable: queryable facts are columns, config and summary documents are JSONB.

**References:**
- `checkout-forge/packages/db/src/schema.ts:126` - preset JSONB typed to contract types.
- `checkout-forge/packages/db/src/schema.ts:466` - summary JSONB blocks typed to contract types.
- `checkout-forge/packages/db/src/public-runtime-policy.ts:27` - policy runtime parse on write and read.

#### Compared behavior

GLM deliberately keeps JSONB columns typed as `unknown` at the storage boundary and validates at higher-level write edges. Preset configs are parsed on create/update and at seed time, and policy is parsed on read. Run snapshots and summary blocks are generally written from typed call sites and cast back on read rather than runtime-parsed at write.

**References:**
- `checkout-surge-glm/packages/db/src/schema.ts:126` - JSONB storage typed as `unknown` with rationale.
- `checkout-surge-glm/packages/db/src/run-lifecycle/preset-management.ts:93` - preset write validation.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-finalization.ts:426` - summary read casts rather than parsing.

#### Verdict rationale

Forge has stronger compile-time JSONB coverage; GLM has stronger runtime validation for presets and seeds. Neither fully runtime-validates run snapshots or summaries at write time. The designs are different but comparable.

---

### C18 — Redis reservation gate atomicity and race safety (better)

#### Reference behavior

Forge uses a single Lua script for the reservation decision: idempotency lookup, stock check, decrement, hold creation, expiry score, event append, and pending idempotency record. This proves no oversell under Redis's atomic script execution. Eligibility is checked before the script, so a run can close between eligibility lookup and stock decrement. The script is invoked with `eval`, sending the full script body on each request.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:127` - reserve-stock Lua script.
- `checkout-forge/packages/db/src/redis-inventory.ts:345` - script executed with `redis.eval`.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:87` - eligibility resolved before the Redis script.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:246` - no-oversell concurrency test.

#### Compared behavior

GLM also uses one Lua script for the reservation decision and preserves the no-oversell property, including multi-unit reservations. It moves run/sale eligibility into the atomic script through a per-offer eligibility key, so wrong-run, closed-run, and uninitialized-offer cases reject before stock is touched. The API maps that `not_initialized` gate result to an immediate response without a PostgreSQL read, and durable ownership is probed only after a fresh winning reservation. It registers the script with `defineCommand`, using EVALSHA on the hot path.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:177` - single gate script.
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:219` - in-script eligibility check.
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:337` - script registration via `defineCommand`.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:487` - ineligible gate outcome maps to an immediate response.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:516` - PostgreSQL ownership probe is only on the secured path.
- `checkout-surge-glm/packages/db/tests/reservation-gate.integration.test.ts:231` - no-oversell and multi-unit tests.

#### Verdict rationale

Both are safe against oversell. GLM improves the atomic boundary by including eligibility, avoids PostgreSQL work for ineligible requests, and reduces per-request script overhead with EVALSHA. Those are meaningful hot-path improvements.

---

### C19 — Idempotency record lifecycle, queue handoff, and replay consistency (better)

#### Reference behavior

Forge stores a pending idempotency record atomically with the decrement, then later finalizes that stored response after PostgreSQL persistence and queue publish. On the fresh accepted path it persists reservation/order rows and opening events, awaits BullMQ enqueue, and only then stores the final Redis idempotency response. This prevents double-decrement if the process crashes before persistence, but it creates partial-state windows: if queue publish throws after durable rows were written, the caller can see a route failure before idempotency is finalized; if response finalization fails after persistence, later replays can keep returning pending-persistence even though the order exists. A genuinely pending replay does not attempt to heal persistence.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:219` - pending idempotency record written with the decrement.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:128` - reservation, order, and opening events are persisted.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:222` - queue publish is awaited on the buy path.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:57` - BullMQ enqueue can throw to the caller.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:224` - finalization occurs after persistence and queue publish.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:294` - pending replay maps back to pending response.

#### Compared behavior

GLM generates all reservation and order identifiers before the gate call and stores complete secured facts in the idempotency record atomically with the decrement. It persists reservation, order, and events transactionally, then attempts queue handoff with `jobId = orderId`; producer failures are logged and swallowed once the durable order exists. Replays then check PostgreSQL for the durable order; if missing, the service re-attempts durable persistence from the stored facts, clears pending sentinels on success, and enqueues the recovered order. This makes duplicate retries a self-healing path, at the cost of PostgreSQL reads on replay and not byte-identical timestamps.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:288` - complete secured facts stored with the decrement.
- `checkout-surge-glm/apps/api/src/app/persistence/order-persistence.ts:117` - reservation, order, and events are persisted transactionally.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:269` - queue job id is the order id.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:270` - enqueue failure is logged and swallowed.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:389` - late-duplicate reconciliation.
- `checkout-surge-glm/apps/api/tests/buy-late-duplicate-reconciliation.integration.test.ts:1` - replay-reconciliation tests.

#### Verdict rationale

GLM removes Forge's stranded finalization window and adds active replay-driven reconciliation. Its queue posture is also better for the synchronous two-phase API contract because a durable order can still be returned even if enqueue fails, though this leaves an operational risk if no later reconciler re-enqueues stranded durable queued orders. The replay path is heavier, especially in duplicate-attempt demos, but the consistency improvement is more important.

---

### C20 — Idempotency scope, conflict rule, and TTL edge cases (same)

#### Reference behavior

Forge scopes idempotency to `saleOfferId + idempotencyKey`, compares quantity for conflicts, does not store sold-out outcomes, treats retry after TTL as a fresh attempt, and URL-encodes keys before embedding them in Redis keys. TTL is environment-configurable with a 1800-second default.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:145` - replay/conflict decision compares quantity.
- `checkout-forge/apps/api/src/config.ts:48` - configurable idempotency TTL.
- `checkout-forge/packages/db/src/redis-inventory.ts:298` - idempotency key encoding.
- `checkout-forge/docs/redis_inventory_hot_path.md:63` - sold-out and late-retry semantics.

#### Compared behavior

GLM uses the same scope, quantity-only conflict rule, sold-out-never-stored behavior, and fresh-attempt-after-TTL stance. It returns a richer conflict payload. Its production TTL is effectively hardcoded to 3600 seconds despite a primitive override parameter, and its idempotency key primitive is unbounded and embedded raw.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:195` - quantity-only replay/conflict logic.
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:58` - default 3600-second TTL constant.
- `checkout-surge-glm/packages/contracts/src/common.ts:37` - unbounded idempotency key primitive.
- `checkout-surge-glm/packages/db/tests/reservation-gate.integration.test.ts:152` - sold-out retry evaluated fresh.

#### Verdict rationale

The spec-level idempotency behavior is equivalent. Forge is cleaner on configurability and key hygiene; GLM is more explicit in conflict responses. Net: same.

---

### C21 — Sold-out and high-frequency realtime cost profile (worse)

#### Reference behavior

Forge keeps the sold-out path cheap. The Lua script increments aggregate counters and returns without stock changes, idempotency records, or PostgreSQL work. The API records dashboard pressure through an in-process aggregator flushed every 500 ms, so each losing request adds only an in-memory counter update after the Redis gate and a burst of thousands of losers becomes a handful of realtime metric events. Other high-frequency observability paths are similarly bounded: live traffic run-state persistence is throttled to at most one durable write per second, recent inventory events are capped, and accepted-path dashboard publications are fire-and-forget.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:173` - sold-out script path increments aggregate only.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:152` - in-memory sold-out observation.
- `checkout-forge/apps/api/src/services/sold-out-dashboard-metric-aggregator.ts:1` - 500 ms aggregation flush.
- `checkout-forge/apps/api/src/services/load-metric-stream-service.ts:44` - live run-state persistence throttle.
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:237` - accepted path emits fire-and-forget dashboard events.

#### Compared behavior

GLM's Redis script is equally cheap for sold-out decisions: aggregate increment, no per-loser record, no PostgreSQL. The regression is in the API service and surrounding observability path. Every sold-out decision publishes an `inventory.sold_out_rejection` event with `count: 1`, and that publish is awaited inline before returning the response. Accepted buys also publish per-order `inventory.updated`, `order.queued`, and `queue.depth` events; the queue-depth publication performs a BullMQ `getJobCounts` read per accepted order. Traffic-metrics ingestion republishes one realtime event per forwarded sample with no coalescing. The secured/enqueued publications are mostly scheduled fire-and-forget, but the dashboard event volume during a 10k spike remains roughly one Pub/Sub message per request, fanned out to every SSE client.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:252` - aggregate-only sold-out script path.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:480` - awaited sold-out publish per rejection.
- `checkout-surge-glm/apps/api/src/app/services/inventory-drain.ts:101` - per-decision publish without batching.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:525` - per-accepted inventory publication.
- `checkout-surge-glm/apps/api/src/app/services/queue-drain.ts:61` - per-enqueue queue-depth read and event.
- `checkout-surge-glm/apps/api/src/app/services/load-metrics-ingestion-service.ts:72` - one realtime event per forwarded traffic sample.

#### Verdict rationale

The Redis primitive complies, but the hot path and realtime channel as a whole are more expensive than the baseline exactly when volume is highest. Forge bounds loser pressure to roughly timer cadence; GLM emits per loser and waits for the sold-out publish before responding. Its accepted-path and traffic-sample publications also scale with event count rather than reader demand or fixed cadence. That contradicts the cheap-loser principle and makes the dashboard channel a surge amplifier rather than a bounded projection.

---

### C22 — Pending-persistence visibility and reconciliation (better)

#### Reference behavior

Forge preserves Redis-secured holds when PostgreSQL persistence fails, records a pending-persistence response and sentinel via Lua, and exposes pending count and oldest age in inventory status. Reconciliation is explicitly deferred. A sequencing issue remains: it attempts a durable pending ledger write against the failing database before writing the Redis sentinel, so a second database failure can skip the operator-visible sentinel even though the initial pending idempotency record still prevents oversell.

**References:**
- `checkout-forge/apps/api/src/services/reserve-order-service.ts:188` - durable pending ledger attempted before Redis sentinel.
- `checkout-forge/packages/db/src/redis-inventory.ts:262` - pending sentinel and persistence-status flip.
- `checkout-forge/packages/db/src/redis-inventory.ts:411` - pending count and oldest age projection.
- `checkout-forge/docs/redis_inventory_hot_path.md:69` - reconciliation deferred.

#### Compared behavior

GLM writes the Redis pending sentinel before the best-effort durable ledger row, so operator visibility survives a full PostgreSQL outage. Its sentinel script refreshes pending counters atomically. It also implements a clear-pending primitive and uses the late-duplicate replay path to re-persist stored facts, mark the ledger reconciled, clear the sentinel, and enqueue the recovered order. It still does not proactively reconcile without a retry.

**References:**
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:561` - Redis sentinel first, ledger write best-effort.
- `checkout-surge-glm/packages/db/src/inventory/pending-persistence.ts:43` - sentinel plus atomic counter refresh.
- `checkout-surge-glm/packages/db/src/inventory/pending-persistence.ts:146` - pending-clear primitive.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:349` - successful replay reconciliation clears pending state.

#### Verdict rationale

GLM meets the same visibility requirements and implements actual retry-driven reconciliation. The baseline is honest about deferral, but GLM is plainly stronger on this dimension.

---

### C23 — Redis keyspace isolation and cleanup hygiene (same)

#### Reference behavior

Forge uses per-offer keys for state, reservations, expirations, pending persistence, events, outcome aggregates, and TTL-backed idempotency records. Run isolation comes from generated sale-offer IDs. Cleanup deletes the named keys and sweeps idempotency keys with blocking `KEYS`, which is complete but can stall Redis. Recent events are capped at 500.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:287` - key builders for inventory key families.
- `checkout-forge/packages/db/src/redis-inventory.ts:313` - cleanup sweeps idempotency keys with `KEYS`.
- `checkout-forge/packages/db/src/redis-inventory.ts:211` - recent-events list cap.

#### Compared behavior

GLM uses the same core key families and adds a per-offer run-eligibility key, included in the canonical teardown list. Cleanup deletes named keys but does not sweep idempotency records, leaving them to a one-hour TTL. Because each run uses a fresh sale-offer ID, the residue is bounded and cannot collide with later runs. Events are capped at 100.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/redis-keys.ts:90` - all named inventory keys for teardown.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-maintenance.ts:71` - teardown deletes named keys.
- `checkout-surge-glm/packages/db/src/inventory/redis-keys.ts:72` - run-eligibility key.
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:64` - event-list cap.

#### Verdict rationale

Both keyspaces are isolated and bounded. Forge is complete but blocking; GLM is non-blocking but leaves TTL-bounded idempotency residue. Neither choice changes correctness at the demo scale, so this is `same`.

---

### C24 — Expired-hold tracking and inventory status projection (same)

#### Reference behavior

Forge scores holds by expiry in a ZSET, counts expired holds at read time, and deliberately does not auto-release them. Inventory status exposes remaining, reserved, allocated stock, pending-persistence count, expired-hold count, and oldest pending age. Missing inventory is mapped to a structured not-found API error.

**References:**
- `checkout-forge/packages/db/src/redis-inventory.ts:199` - expiry scored into ZSET.
- `checkout-forge/packages/db/src/redis-inventory.ts:401` - inventory status projection.
- `checkout-forge/docs/redis_inventory_hot_path.md:69` - auto-release deferred.
- `checkout-forge/apps/api/src/routes/inventory-status.ts:30` - missing inventory maps to a structured error.

#### Compared behavior

GLM uses the same expiry ZSET and read-time expired-count derivation, with pipelined status reads and the same deliberate deferral of auto-release. It adds the cumulative sold-out rejection count and windowed accepted-reservation throughput directly on the inventory read, uses read-only drain/throughput signals from bounded event feeds, and returns an explicit `not_initialized` 409 for an uninitialized offer instead of a generic miss.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/reservation-gate.ts:273` - expiry score written at reserve time.
- `checkout-surge-glm/packages/db/src/inventory/redis-keys.ts:140` - pipelined status read and expired-count derivation.
- `checkout-surge-glm/packages/db/src/inventory/drain-signals.ts:68` - additional read-only drain signals.
- `checkout-surge-glm/apps/api/src/app/services/inventory-status-service.ts:63` - sold-out count, throughput, and explicit not-initialized handling.
- `checkout-surge-glm/apps/api/tests/inventory-status.integration.test.ts:1` - status projection coverage.

#### Verdict rationale

The required expired-hold and inventory-state signals are equivalent. GLM has useful read-path extras, especially sold-out count, throughput, and explicit uninitialized-offer semantics, but those are not enough to change the verdict for this narrower Redis inventory-status topic; broader queue/ERP/readiness projections are handled in C48.

---

### C25 — Terminal Redis inventory snapshot in durable history (same)

#### Reference behavior

Forge copies Redis-derived terminal inventory facts into the immutable run summary: starting stock, final remaining/reserved stock, accepted reservations, sold-out rejections, pending persistence, capture time, and source. This preserves audit data after Redis cleanup.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:136` - terminal snapshot assembled for summary.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:304` - snapshot sourced from live Redis status and aggregates.

#### Compared behavior

GLM captures the same category of Redis-derived terminal snapshot during finalization, using live inventory state and drain signals, and writes it into a contract-validated summary shape. It tolerates missing Redis state by recording a null snapshot and captures before live keys are torn down.

**References:**
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:158` - terminal inventory snapshot schema.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:283` - snapshot built during finalization.

#### Verdict rationale

Both satisfy the durable audit-copy requirement. Broader finalization correctness is covered separately, but the Redis snapshot obligation is met on both sides.

---

### C26 — Hot-path and hard-property test coverage (better)

#### Reference behavior

Forge covers the Redis primitive with real integration tests: initialization, secure path effects, sold-out without decrement, replay/conflict, response finalization, uninitialized inventory, pending-persistence visibility, and a concurrency storm proving no oversell. API vertical-slice tests also cover run attribution, durable persistence, idempotency, eligibility failure, reset protection, and pending-persistence behavior. It does not test multi-unit reservations as actual holds, and replay-after-partial-failure coverage is limited.

**References:**
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:246` - primitive no-oversell concurrency storm.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:126` - replay/conflict coverage.
- `checkout-forge/packages/db/test/redis-inventory.integration.test.ts:336` - stored-response edge case.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:483` - pending-persistence API path.
- `checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts:938` - duplicate buy replay through API route.

#### Compared behavior

GLM covers the same primitive properties and adds multi-unit atomicity, no-partial-hold over-ask behavior, wrong-run and closed-run rejection without stock leakage, full HTTP-path no-oversell tests, pending-persistence tests, and late-duplicate reconciliation tests. The late-duplicate suite includes concurrent retries resolving to exactly one durable order, so the partial-failure and reconciliation cases are tested at the system boundary rather than only around the Lua primitive.

**References:**
- `checkout-surge-glm/packages/db/tests/reservation-gate.integration.test.ts:231` - primitive no-oversell, multi-unit, and eligibility tests.
- `checkout-surge-glm/apps/api/tests/buy-concurrency.integration.test.ts:98` - HTTP-path no-oversell coverage.
- `checkout-surge-glm/apps/api/tests/buy-pending-persistence.integration.test.ts:1` - partial-persistence suite.
- `checkout-surge-glm/apps/api/tests/buy-late-duplicate-reconciliation.integration.test.ts:1` - replay-reconciliation suite.
- `checkout-surge-glm/apps/api/tests/buy-late-duplicate-reconciliation.integration.test.ts:261` - concurrent late-duplicate reconciliation to one durable order.

#### Verdict rationale

Both test the headline Redis guarantee against real infrastructure, but GLM covers more edge cases and proves the guarantee through the HTTP path as well as the primitive. For the hot-path guarantees covered so far, its hard-property coverage is stronger.

---

### C27 — Order and inventory query surfaces (worse)

#### Reference behavior

Forge exposes both inventory status and order status as contract-shaped API reads. The order-status surface is a customer-facing asynchronous-checkout projection: it includes reservation state, order lifecycle timestamps, derived customer status, consistency lag, and a timeline loaded from durable order events. Inventory status returns the Redis-derived projection and maps missing inventory to a structured not-found error.

**References:**
- `checkout-forge/apps/api/src/routes/order-status.ts:16` - order status route.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:233` - order timeline events are loaded.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:239` - order status projection begins.
- `checkout-forge/apps/api/src/persistence/order-persistence.ts:257` - derived customer status and consistency lag are included.
- `checkout-forge/apps/api/src/routes/inventory-status.ts:19` - inventory status route.
- `checkout-forge/apps/api/src/routes/inventory-status.ts:30` - missing inventory maps to a structured error.

#### Compared behavior

GLM exposes both inventory and order reads, but the order route is a minimal durable read at `/orders/:publicOrderId`. It returns persisted order and reservation fields without an event timeline, derived customer status, processing/terminal timestamps, failure details, or consistency lag. Its inventory route is much closer to the reference and includes live drain signals from Redis, but the post-buy order lookup is thinner than the asynchronous contract needs.

**References:**
- `checkout-surge-glm/apps/api/src/app/routes/orders.ts:13` - order read route.
- `checkout-surge-glm/apps/api/src/app/services/order-query-service.ts:30` - minimal order read response schema.
- `checkout-surge-glm/apps/api/src/app/services/order-query-service.ts:63` - order projection omits timeline and customer status.
- `checkout-surge-glm/apps/api/src/app/persistence/order-persistence.ts:356` - order lookup by public id.
- `checkout-surge-glm/apps/api/src/app/routes/inventory.ts:15` - inventory status route.
- `checkout-surge-glm/apps/api/src/app/services/inventory-status-service.ts:88` - inventory status includes drain signals.

#### Verdict rationale

This is worse because the buy-path read requirement is not merely that rows are technically fetchable. The reference gives clients a useful view of the asynchronous reservation-to-order lifecycle after the immediate buy response. GLM's inventory read is adequate, but its order read loses the timeline and derived presentation state already noted in C4.

---

### C28 — Surge listener and PostgreSQL pool tuning (same)

#### Reference behavior

Forge makes the API TCP listen backlog and API PostgreSQL pool size explicit startup-validated tunables. The default backlog is 8192, matching the documented need to absorb thousands of near-simultaneous connections, and the API PostgreSQL pool default is 10.

**References:**
- `checkout-forge/apps/api/src/config.ts:42` - API PostgreSQL pool max defaults to 10.
- `checkout-forge/apps/api/src/config.ts:74` - API listen backlog defaults to 8192.
- `checkout-forge/apps/api/src/index.ts:49` - PostgreSQL client uses the configured max connection count.
- `checkout-forge/apps/api/src/index.ts:264` - Fastify listen receives the configured backlog.

#### Compared behavior

GLM has the same two explicit hot-path runtime knobs. `API_LISTEN_BACKLOG` defaults to 8192 and `API_POSTGRES_POOL_MAX` defaults to 10, and the API composition root applies them to the PostgreSQL connection and Fastify `listen` call.

**References:**
- `checkout-surge-glm/apps/api/src/app/config.ts:19` - API listen backlog is modeled in config.
- `checkout-surge-glm/apps/api/src/app/config.ts:21` - API PostgreSQL pool max is modeled in config.
- `checkout-surge-glm/apps/api/src/app/config.ts:118` - backlog defaults to 8192.
- `checkout-surge-glm/apps/api/src/app/config.ts:119` - API PostgreSQL pool max defaults to 10.
- `checkout-surge-glm/apps/api/src/index.ts:34` - PostgreSQL connection uses the configured pool max.
- `checkout-surge-glm/apps/api/src/index.ts:95` - Fastify listen uses the configured backlog.

#### Verdict rationale

For these directly visible buy-path surge knobs, GLM matches the baseline defaults and applies them in the right places. Other configuration differences may matter in operational-runtime topics, but backlog and API pool tuning are equivalent here.

---

### C29 — Preset management and public-custom defaults (same)

#### Reference behavior

Forge seeds the required public preset set, the read-only `public-custom` base, and an editable admin `custom` scratch preset. Admin preset management supports create, save, duplicate, and copy-to-custom, validates accepted configurations against deployment hard caps, rejects read-only preset edits with typed errors, and falls back to the runtime policy's public-custom defaults when a public custom start omits a configuration.

**References:**
- `checkout-forge/packages/db/src/demo-presets.ts:83` - seeded public/custom preset definitions.
- `checkout-forge/apps/api/src/services/demo-preset-management-service.ts:66` - create/save/duplicate/copy-to-custom management surface.
- `checkout-forge/apps/api/src/services/demo-preset-management-service.ts:123` - hard-cap validation before preset persistence.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:118` - omitted public custom config falls back to policy defaults.

#### Compared behavior

GLM seeds the same public preset set plus the read-only `public-custom` base and editable admin presets, including an admin custom scratch preset. Seeded configs are parsed through the contract schema, preset save/duplicate/copy-to-custom paths validate through the contract plus hard caps, and read-only rows are rejected as `preset_not_editable`. Public custom starts without overrides use the stored read-only preset config as the default shape rather than a policy-owned defaults block.

**References:**
- `checkout-surge-glm/packages/db/src/seed-data.ts:79` - seeded public and admin preset definitions.
- `checkout-surge-glm/apps/api/src/app/services/preset-management-service.ts:62` - contract and hard-cap validation before save.
- `checkout-surge-glm/apps/api/src/app/services/preset-management-service.ts:95` - typed read-only mutation errors.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:324` - public custom defaults come from preset config plus overrides.

#### Verdict rationale

Both deliver the durable preset model, read-only enforcement, admin scratch preset, hard-cap validation, and public custom defaulting. Forge exposes a free-form create path and sources public custom defaults from the runtime policy; GLM relies on duplication for new presets and uses the seeded public-custom preset as the default source. Those are product-shape differences, not meaningful capability gaps.

---

### C30 — Run creation, frozen snapshots, and isolated inventory (same)

#### Reference behavior

Forge starts each normal run by cloning the baseline offer into a generated run-scoped sale offer, inserting the run with the validated configuration frozen in `configSnapshot`, linking the run and offer through the sale context, and resetting a fresh Redis inventory keyspace for the generated offer. Later preset edits cannot affect the run because downstream services use the frozen snapshot.

**References:**
- `checkout-forge/packages/db/src/demo-runs.ts:75` - generated sale offer inserted with `purpose: "generated_run"`.
- `checkout-forge/packages/db/src/demo-runs.ts:111` - run and offer linked through sale contexts.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:122` - configuration validated and frozen before creation.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:146` - isolated Redis inventory reset for the generated offer.

#### Compared behavior

GLM performs the same durable creation in one transaction: generated offer, `starting` run row with frozen snapshot, and `demo_run_sale_contexts` link. Redis inventory is seeded after the durable commit, snapshot JSON is re-parsed through `DemoRunConfigSnapshotSchema` before storage, and the run-context trigger enforces that the linked offer is generated-run scoped.

**References:**
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-creation.ts:204` - generated offer, run row, and context link inserted together.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-creation.ts:254` - Redis inventory seeded after durable commit.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:387` - snapshot frozen and revalidated before persistence.
- `checkout-surge-glm/packages/db/migrations/0000_burly_random.sql:308` - trigger enforces generated-run context ownership.

#### Verdict rationale

Both satisfy the core run-start obligations: immutable snapshot, generated offer, explicit run-offer ownership, and isolated Redis inventory. GLM has useful extra validation and a commit-then-seed split; Forge's creation service has an explicit failure path for seed errors, covered in C31. The normal creation behavior is equivalent.

---

### C31 — Failed-start handling and summary-backed history (worse)

#### Reference behavior

Forge handles both post-row Redis initialization failures and load-orchestrator start failures by moving the run to a terminal failed state and writing the immutable terminal summary through the shared summary path. The failed start is visible in history exactly once, no longer blocks the one-active-run gate, and the caller still receives the original typed failure.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:157` - Redis init failure caught and run failed.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:270` - initialization failure writes terminal status and summary.
- `checkout-forge/apps/api/src/services/demo-run-start-service.ts:50` - orchestrator delegation failure marks the run failed.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:279` - shared failure path writes the summary.

#### Compared behavior

GLM documents that a post-commit Redis seed failure must be failed by the run-start service, but the generic catch logs and returns a 503 without calling `failRun`. The run remains `starting`, which blocks all later starts until reset or startup reconciliation, and no summary is written. For orchestrator-start failure, GLM does call `failRun` with `orchestrator_start_failed`, but `failRun` is only a status transition; the finalization poller only evaluates `draining` runs and history is summary-backed, so the terminal failed run is not visible in run history.

**References:**
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-creation.ts:186` - adapter contract says the caller must fail post-commit seed failures.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:417` - generic start catch returns 503 without failing the run.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-lifecycle.ts:279` - `starting` runs block later starts.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:444` - orchestrator failure calls `failRun` only.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-lifecycle.ts:124` - `failRun` is a bare status transition.
- `checkout-surge-glm/apps/api/src/app/services/run-history-service.ts:25` - history reads from summaries only.

#### Verdict rationale

The spec requires every terminal path, including initialization and traffic-start failure, to produce summary-backed history. Forge closes both paths. GLM can strand a blocking `starting` run on Redis seed failure and can create a terminal traffic-start failure that never appears in history. This is a clear lifecycle regression.

---

### C32 — Traffic completion vs business completion boundary (same)

#### Reference behavior

Forge treats k6 completion as traffic truth, not business success. A successful traffic report moves the run to `draining`, not `completed`; k6 failure marks the run failed with a stable reason; and terminal completion happens only after finalization verifies business settlement. It also evaluates finalization immediately on report arrival while a 5 second poller continues as the background driver.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:667` - traffic success maps to demo-run `draining`.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:194` - failed k6 report maps to `k6_failed`.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:238` - immediate finalization evaluation on report arrival.
- `checkout-forge/apps/api/src/index.ts:207` - 5 second finalization poller.

#### Compared behavior

GLM records one traffic finalization input per run behind the token-gated ingestion endpoint, classifies delivery separately from the raw execution status, and uses a guarded `active -> draining` transition so duplicate or late reports are idempotent. The ingestion endpoint does not terminalize the run; the serialized poller owns the final `completed` or `failed` decision. Its drain timeout and poll interval defaults match Forge.

**References:**
- `checkout-surge-glm/apps/api/src/app/services/traffic-completion-ingestion-service.ts:126` - traffic report recorded and classified without terminalizing the run.
- `checkout-surge-glm/apps/api/src/app/services/traffic-completion-ingestion-service.ts:159` - guarded active-to-draining transition for duplicate reports.
- `checkout-surge-glm/apps/api/src/app/run-finalization-poller.ts:83` - serialized poller re-arms without overlapping passes.
- `checkout-surge-glm/apps/api/src/app/config.ts:137` - 300 second drain timeout and 5 second poll defaults.

#### Verdict rationale

Both avoid the core shortcut of treating "k6 exited successfully" as run success. Forge reacts a little sooner on report arrival and fails k6 failures immediately; GLM is stronger on duplicate report idempotency and non-overlapping finalization passes. The boundary between traffic completion and business completion is equivalent.

---

### C33 — Drain settlement gate and timeout semantics (worse)

#### Reference behavior

Forge finalization audits business settlement broadly: pending-persistence holds must be reconciled, orders cannot remain queued or processing, confirmed orders need simulated notifications, durable reservation counts reconcile against k6 and API accepted-response accounting, and over-capacity accepted responses fail the run as oversell evidence. If the drain timeout fires with unsettled work, the run fails with a precise stable reason; benign reconciled counter mismatches are preserved as diagnostic warnings on completed runs.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:505` - settlement requires pending, order, notification, and accounting reconciliation.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:570` - timeout maps unsettled conditions to stable failure reasons.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:793` - accepted responses above stock capacity fail the run.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:513` - reconciled mismatches become warnings.

#### Compared behavior

GLM's settled gate checks only queued orders, processing orders, and unreconciled pending-persistence holds. It deliberately excludes notifications, but it also does not reconcile durable reservation counts against k6 or API-side accepted accounting and has no over-capacity tripwire. More importantly, when the drain timeout fires, terminal status is still decided only by traffic delivery classification, so a run with stuck queued work or unreconciled holds can be finalized as `completed` if traffic delivery looked good.

**References:**
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:234` - settled gate checks queued/processing orders and pending reconciliation.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:243` - timeout measured from traffic end time.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:279` - terminal status is based on delivery classification only.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:68` - only finalization failure reason is major traffic shortfall.

#### Verdict rationale

GLM's notification exclusion is a defensible design choice, but completing a timed-out run with unsettled business work is not. The drain timeout should bound settlement and make unsettled work visible as failure. Forge's finalization is also a stronger audit point because it cross-checks accepted accounting and keeps an oversell tripwire.

---

### C34 — Traffic delivery classification and unexpected responses (worse)

#### Reference behavior

Forge classifies delivery by shortfall: `complete` requires zero shortfall, small shortfalls degrade to warning/degraded, and more than 5% shortfall fails the run. Separately, the k6 script classifies accepted reservations, sold-out rejections, and unexpected responses from machine-readable response headers while discarding bodies. Any unexpected response observed by k6 fails the run with `traffic_outcome_unexpected_responses`, which is especially important for zero-stock sold-out runs where accepted count is not the success criterion.

**References:**
- `checkout-forge/apps/api/src/services/traffic-delivery-classifier.ts:3` - shortfall thresholds with 5% as failure.
- `checkout-forge/apps/api/src/services/traffic-delivery-classifier.ts:19` - `complete` requires zero shortfall.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:59` - k6 threshold requires zero unexpected responses.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:106` - accepted and sold-out outcomes identified from status and headers.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:715` - unexpected responses fail the run.

#### Compared behavior

GLM classifies by delivery ratio with much looser bands: `complete` at 95% delivered, warning at 80%, degraded at 50%, and failed only below 50% or when the process did not complete. Its generated k6 script also does not classify buy responses by outcome headers or emit accepted/sold-out/unexpected custom counters. Instead, it marks all 2xx responses and all 409 responses as expected, so idempotency conflicts, ineligible run/offer errors, and other 409-class failures can be counted as acceptable traffic. The summary carries `unexpectedResponseCount`, derived from generic k6 failure data, but that count does not affect the classification or terminal decision.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:165` - all 409 responses are marked expected by k6.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/output-parser.ts:13` - parser only supports stock k6 HTTP metrics.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:343` - delivery ratio thresholds.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:381` - classification derives from ratio and process completion.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:279` - failed classification is the only traffic-driven terminal failure trigger.

#### Verdict rationale

Thresholds can be implementation choices, but this difference changes the truthfulness of the result: GLM can call a run complete after dropping 5% of planned traffic and can tolerate nearly half the traffic missing without failing. Its k6-side classification is also too broad, so a clean sold-out run and a run repeatedly hitting another 409-class error can look equivalent. Ignoring unexpected responses as a terminal correctness signal removes the spec's explicit protection for sold-out-only traffic. Forge is stricter and more honest here.

---

### C35 — Startup reconciliation and crash recovery (same)

#### Reference behavior

Forge runs startup reconciliation before the API begins listening. Interrupted `starting` and `active` runs are failed with `api_restart_interrupted_run`, eligibility is closed, finalization records and immutable summaries are written through the shared terminal summary path, and durable `draining` runs are preserved for the normal finalization poller.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:8` - recoverable statuses and stable restart failure reason.
- `checkout-forge/apps/api/src/services/demo-run-startup-reconciliation-service.ts:61` - interrupted runs failed and summarized while draining survives.
- `checkout-forge/apps/api/src/index.ts:204` - reconciliation runs before the poller starts.

#### Compared behavior

GLM reconciles the same interrupted statuses with the same stable reason. Each run is handled in its own guarded transaction that fails the run, deactivates the generated sale offer, and inserts an idempotent minimal summary. Draining runs are left recoverable, live Redis inventory and eligibility state are torn down for reconciled runs, best-effort `run.failed` events are published, and startup tolerates an unmigrated database.

**References:**
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-lifecycle.ts:188` - guarded fail, offer deactivation, and idempotent summary.
- `checkout-surge-glm/apps/api/src/app/services/run-lifecycle-service.ts:106` - Redis eligibility and inventory teardown.
- `checkout-surge-glm/apps/api/src/app/services/run-lifecycle-service.ts:91` - startup tolerates unmigrated or unavailable database.
- `checkout-surge-glm/apps/api/src/index.ts:86` - reconciliation ordered before the poller.

#### Verdict rationale

Both satisfy the crash-recovery requirement: interrupted runs become failed summary-backed history, eligibility is closed, and draining runs continue finalizing after restart. GLM is more defensive around races and Redis teardown; Forge's summaries are richer. Net result is equivalent.

---

### C36 — Admin reset and live-run recovery (worse)

#### Reference behavior

Forge's admin recovery workflow force-fails recoverable runs with terminal summaries, aborts the in-flight traffic run at the load orchestrator, and surfaces abort failures instead of silently proceeding. Admin reset composes that recovery with clearing reset-owned queues and live dashboard state, while deliberately preserving run history.

**References:**
- `checkout-forge/apps/api/src/services/demo-run-recovery-service.ts:100` - recoverable runs failed and summarized.
- `checkout-forge/apps/api/src/services/demo-run-recovery-service.ts:184` - load-orchestrator abort with typed error mapping.
- `checkout-forge/apps/api/src/services/demo-reset-service.ts:48` - reset clears queues and live dashboard state after recovery.

#### Compared behavior

GLM's durable reset side is strong: it force-fails the current run with a rich failed summary, deactivates the generated offer, obliterates the orders queue, tears down Redis inventory and eligibility, preserves history, reports teardown flags, and publishes a best-effort `run.failed` event. However, the API-side load-orchestrator client has only `startRun`; no abort or stop call exists in the reset path. Resetting an active run can leave k6 still executing against a torn-down offer, and possibly block the next start if the orchestrator serializes executions.

**References:**
- `checkout-surge-glm/apps/api/src/app/services/reset-service.ts:171` - force-fail writes a rich immutable summary.
- `checkout-surge-glm/apps/api/src/app/services/reset-service.ts:313` - queue obliterate and Redis teardown with honest flags.
- `checkout-surge-glm/apps/api/src/app/load-orchestrator/load-orchestrator-client.ts:44` - orchestrator client exposes start only.

#### Verdict rationale

GLM's persisted recovery record is richer than Forge's, but reset is also supposed to stop the live traffic source and return the system to a startable state. Without an orchestrator abort path, the most important recovery use case remains incomplete. Forge closes that loop, so GLM is worse overall.

---

### C37 — Old-run cleanup and targeted teardown (better)

#### Reference behavior

Forge ships cleanup tooling that deletes old generated-run state while preserving active `starting`/`active`/`draining` runs and retaining the latest N runs by default. Reset does not delete history; cleanup is a deliberate operational path over the database package. Its runtime reset client calls the internal API and mock ERP reset endpoints with the control token, but targeted smoke cleanup is implemented by local `docker compose exec` calls that delete rows and Redis keys directly from the script.

**References:**
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:19` - default retention of 15 runs.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:18` - active statuses are never deleted.
- `checkout-forge/packages/db/src/demo-run-cleanup.ts:121` - deletion set is everything beyond retained newest runs.
- `checkout-forge/scripts/runtime-reset-client.mjs:22` - runtime reset calls API and mock ERP reset endpoints.
- `checkout-forge/scripts/runtime-smoke-cleanup.mjs:94` - smoke cleanup deletes run data directly through PostgreSQL.
- `checkout-forge/scripts/runtime-smoke-cleanup.mjs:168` - smoke cleanup deletes run-scoped Redis keys directly.

#### Compared behavior

GLM matches the retention semantics and hardens destructive cleanup. It deletes only offers verified as `generated_run`, processes each run's FK-safe subtree in its own transaction, performs Redis teardown best-effort after the durable commit, exposes cleanup as an admin service operation, and adds targeted single-run teardown that refuses active runs with 409 and protects catalog offers. The operational scripts also route old-run cleanup and targeted smoke-run teardown through token-gated API maintenance endpoints instead of embedding PostgreSQL and Redis deletion logic locally.

**References:**
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-maintenance.ts:52` - default retention of 15.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-maintenance.ts:209` - active runs and newest runs preserved, with generated-offer guard.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-maintenance.ts:131` - targeted single-run teardown with active-run refusal.
- `checkout-surge-glm/apps/api/src/app/services/maintenance-service.ts:53` - cleanup and targeted delete exposed as admin operations.
- `checkout-surge-glm/scripts/maintenance-cleanup-runs.mjs:40` - old-run cleanup calls the API maintenance endpoint.
- `checkout-surge-glm/scripts/runtime-smoke-load.mjs:267` - smoke cleanup calls targeted API run deletion.

#### Verdict rationale

Both meet the retention-aware cleanup requirement. GLM goes further on catalog-offer protection, per-run transaction isolation, explicit FK ordering, Redis teardown, targeted cleanup, and keeping operational scripts on service-owned maintenance surfaces rather than schema-coupled local deletion. Those are concrete operational improvements. GLM's reset/cleanup scripts are less strict about missing service tokens than Forge's fail-fast reset client, but that caveat is outweighed here by the stronger API-backed cleanup design and is also part of the broader secret-default concern in C71.

---

### C38 — Lifecycle eligibility closure and late buy traffic (worse)

#### Reference behavior

Forge synchronizes the cached run-sale eligibility record with lifecycle transitions. Its traffic-acceptance predicate admits only `starting` and `active`, so when a traffic report moves the run to `draining`, late buy requests are rejected. Eligibility is asserted again at terminal summary time, closing the stale-open window after completion or failure.

**References:**
- `checkout-forge/apps/api/src/services/run-sale-eligibility-service.ts:162` - traffic accepted only for `starting` and `active`.
- `checkout-forge/apps/api/src/services/demo-run-finalization-service.ts:215` - eligibility moved to `draining` on traffic report.
- `checkout-forge/apps/api/src/services/demo-run-terminal-summary-service.ts:169` - terminal summary updates eligibility again.

#### Compared behavior

GLM's Redis-first eligibility gate is strong on the per-request hot path, but the lifecycle update is weaker. The eligibility payload is written at activation with `acceptingTraffic = 1` and cleared only at terminalization, reset, reconciliation, or maintenance teardown. Nothing flips the flag at `draining`, so buys can still be accepted throughout the drain window. That can race finalization: a buy accepted after the settled-gate read but before the terminal transition can create in-flight business work after the run has effectively been judged settled. Terminal cleanup is also best-effort, so a failed Redis delete can leave a terminal offer buyable until another teardown path runs.

**References:**
- `checkout-surge-glm/packages/db/src/inventory/redis-keys.ts:58` - eligibility lifecycle documented as active-to-terminal.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:475` - eligibility payload established at activation.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:416` - eligibility cleared best-effort only on terminal transition.
- `checkout-surge-glm/apps/api/src/app/services/run-finalization-service.ts:234` - settled-gate read that draining-window buys can race.

#### Verdict rationale

C18 covers GLM's stronger atomic request-time eligibility gate. This topic is about when the lifecycle opens and closes that gate. Forge closes traffic at draining and reasserts closure at terminalization. GLM keeps accepting during draining and relies on one best-effort terminal delete, which can invalidate settlement decisions and leave stale acceptance open. That is worse.

---

### C39 — Run-scoped downstream retry and timeout policy (worse)

#### Reference behavior

Forge freezes the downstream resilience profile into each run and applies it at both queue-production and worker-consumption time. The API enqueues BullMQ jobs with retry attempts and exponential backoff derived from either defaults or the run snapshot, while the worker resolves the same run snapshot to apply order-processing concurrency and ERP request timeout. That lets two demo runs exercise different retry, backoff, timeout, and concurrency profiles without changing process-wide environment.

**References:**
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:52` - order queue installs default job options.
- `checkout-forge/apps/api/src/queues/order-process-queue.ts:153` - per-run backpressure job options resolver.
- `checkout-forge/packages/contracts/src/demo-runs.ts:234` - backpressure snapshot includes timeout and retry policy.
- `checkout-forge/apps/worker/src/clients/mock-erp-client.ts:44` - ERP timeout overridden from per-run backpressure config.

#### Compared behavior

GLM has retry machinery, but much of it is process-global rather than run-scoped. BullMQ jobs always use the shared queue retry policy, resolved ERP failures are retried by an in-service loop driven from worker environment, and the mock ERP HTTP client uses a global request timeout. The accepted run snapshot can tune worker concurrency and breaker threshold/reset window, but its backpressure contract omits ERP request timeout, retry max attempts, and retry backoff.

**References:**
- `checkout-surge-glm/packages/contracts/src/queue.ts:112` - fixed shared order-process retry policy.
- `checkout-surge-glm/apps/api/src/app/queue/orders-process-queue.ts:47` - queue default job options come from shared policy.
- `checkout-surge-glm/packages/contracts/src/demo-control.ts:56` - run backpressure shape has concurrency and breaker fields only.
- `checkout-surge-glm/apps/worker/src/app/config.ts:103` - ERP max attempts come from global worker config.
- `checkout-surge-glm/apps/worker/src/app/erp/mock-erp-http-client.ts:152` - request timeout uses client-level global timeout.

#### Verdict rationale

GLM is more elaborate internally, but it loses the baseline's run-snapshot fidelity for retry and timeout behavior. Since downstream resilience needs to vary under different demo configurations, process-global retry and timeout settings are a functional regression.

---

### C40 — Durable worker order lifecycle and attempt history (worse)

#### Reference behavior

Forge advances orders through `queued -> processing -> confirmed | failed` behind a persistence module. Processing transitions, ERP attempt rows, terminal order updates, and durable order events are written transactionally. Failed attempts become terminal only when the retry budget is exhausted or the ERP rejection is non-retryable; otherwise the job throws so BullMQ retry/backoff remains the source of transient recovery.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:77` - terminal attempt derived from BullMQ/run retry budget.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:86` - queued orders marked processing before the ERP call.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:165` - successful ERP result records a succeeded attempt.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:94` - succeeded attempt and confirmed transition are transactional.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:205` - failed attempt and optional terminal failure are transactional.

#### Compared behavior

GLM also has a clear worker persistence module: it loads the order, guards `queued -> processing`, appends ERP attempts, and finalizes only from `processing`. Two durability gaps remain. First, worker-authored `orderEvents` write `reservationId: null` even though the order snapshot and queue job carry the reservation. Second, unexpected throws that exhaust BullMQ retries leave the business order in `processing`, because terminal failure is driven only from resolved ERP results.

**References:**
- `checkout-surge-glm/apps/worker/src/app/persistence/order-transition-persistence.ts:90` - guarded `queued -> processing` transition.
- `checkout-surge-glm/apps/worker/src/app/persistence/order-transition-persistence.ts:105` - processing event writes `reservationId: null`.
- `checkout-surge-glm/apps/worker/src/app/persistence/order-transition-persistence.ts:174` - ERP attempts are appended in the persistence adapter.
- `checkout-surge-glm/apps/worker/src/app/persistence/order-transition-persistence.ts:236` - terminal transition guarded by `status = 'processing'`.
- `checkout-surge-glm/apps/worker/src/app/services/erp-confirmation.ts:20` - persistent throws can leave the order `processing`.

#### Verdict rationale

GLM's normal success and ERP-result failure paths are mostly solid, but the missing reservation attribution weakens the durable event trail. More importantly, a failed BullMQ job with a still-`processing` business order breaks the async lifecycle guarantee that accepted work reaches `confirmed` or `failed`.

---

### C41 — Circuit breaker retry cooperation (worse)

#### Reference behavior

Forge's worker breaker has `closed`, `open`, and `half_open` states. When open, the resilient ERP client short-circuits with retryable `erp_circuit_open`, so open-circuit work consumes the same queue retry and backoff policy as other transient downstream failures. Breaker threshold and reset timeout are resolved per run, and operators can read breaker state and retry timing.

**References:**
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:30` - breaker gates attempts and moves open to half-open after reset.
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:54` - failures open the breaker at threshold or from half-open.
- `checkout-forge/apps/worker/src/resilience/circuit-breaker.ts:62` - breaker snapshot exposes state and retry timing.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:34` - open breaker returns retryable `erp_circuit_open`.
- `checkout-forge/apps/worker/src/clients/resilient-order-confirmation-client.ts:47` - successes and retryable failures feed breaker state.

#### Compared behavior

GLM improves the half-open implementation by allowing only one probe in flight, and it publishes breaker state to Redis for API visibility. The retry cooperation is weaker: its synthetic `circuit_open` result is classified as terminal, so the worker stops retrying and finalizes the order as failed as soon as the breaker is open.

**References:**
- `checkout-surge-glm/apps/worker/src/app/erp/circuit-breaker.ts:117` - half-open single-probe guard.
- `checkout-surge-glm/apps/worker/src/app/erp/circuit-breaker.ts:155` - open and half-open gating.
- `checkout-surge-glm/apps/worker/src/app/erp/resilience.ts:35` - `circuit_open` synthetic error code.
- `checkout-surge-glm/apps/worker/src/app/erp/resilience.ts:48` - `circuit_open` classified as terminal.
- `checkout-surge-glm/apps/worker/src/app/services/order-process-service.ts:280` - final ERP result directly drives confirmed vs failed.

#### Verdict rationale

GLM's single-probe half-open guard is better than Forge's simpler breaker, but the overall behavior is worse because an open breaker should delay and backpressure transient work, not convert valid orders into immediate business failures.

---

### C42 — Mock ERP chaos scoping and precedence (worse)

#### Reference behavior

Forge's mock ERP supports latency, forced outage, TPS cap, and random errors, with run-snapshot behavior overriding global chaos controls per request. TPS accounting is scoped per run when run behavior is supplied, so one run's traffic cannot consume another run's quota. Chaos precedence is explicit: forced outage, then TPS exhaustion, then random error. Runtime chaos reads and mutations are restricted to service-token-protected internal routes.

**References:**
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:56` - run behavior overrides global chaos controls.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:62` - forced outage evaluated before TPS and random errors.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:73` - TPS limiter uses scoped acquisition.
- `checkout-forge/apps/mock-erp/src/services/confirm-order-service.ts:167` - TPS scope is `run:{runId}` when run behavior exists.
- `checkout-forge/apps/mock-erp/src/server.ts:135` - internal chaos mutation route is service-token protected.

#### Compared behavior

GLM implements the main chaos knobs and accepts run-carried ERP configuration from the worker. Its TPS limiter is a token bucket, which is a reasonable algorithm, but the limiter state is shared globally: run-specific max TPS is applied by mutating a shared provider backed by one bucket. It also checks TPS before latency, forced outage, or random error decisions, so an intended forced outage can be reported as throttling when the shared bucket is empty.

**References:**
- `checkout-surge-glm/apps/mock-erp/src/app/services/erp-behavior-service.ts:86` - forced outage decision exists.
- `checkout-surge-glm/apps/mock-erp/src/app/services/erp-behavior-service.ts:127` - shared `throttleMaxTps` backs the limiter.
- `checkout-surge-glm/apps/mock-erp/src/app/services/erp-behavior-service.ts:137` - run ERP config mutates shared TPS provider.
- `checkout-surge-glm/apps/mock-erp/src/app/services/erp-behavior-service.ts:152` - TPS checked before downstream latency/outcome logic.
- `checkout-surge-glm/apps/mock-erp/src/app/services/token-bucket-limiter.ts:30` - token bucket has a single token state.

#### Verdict rationale

GLM covers the feature checklist but loses per-run TPS isolation and the baseline's explicit chaos precedence. The one-active-run rule reduces how often cross-run interference appears, but a shared mutable limiter is still less faithful to the expected run-scoped downstream behavior.

---

### C43 — Simulated notification follow-up durability (worse)

#### Reference behavior

Forge treats notification recording as separate follow-up work. A confirmed order enqueues a job on a dedicated simulated-notification queue; enqueue failure is logged without failing the already-confirmed order. The notification worker records the simulated notification only for confirmed orders and skips existing notifications, so retries are idempotent and transient notification-write failures get their own retry budget.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:197` - confirmed order enqueues notification follow-up.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:257` - notification enqueue failure is swallowed and logged.
- `checkout-forge/apps/worker/src/queues/simulated-notification-queue.ts:43` - notification queue is separate from order processing.
- `checkout-forge/apps/worker/src/queues/simulated-notification-queue.ts:53` - notification job ID is stable per order/channel.
- `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts:149` - durable insert checks order state and existing notification.

#### Compared behavior

GLM records simulated notifications inline after a fresh confirmed transition. It writes the notification row and `notification.recorded` event transactionally, then publishes realtime best-effort; failures are swallowed so confirmation is not rolled back. There is no separate retry path for transient notification-write failures, and the persistence function does not explicitly check for an existing notification, relying instead on the caller invoking it only after winning the guarded confirmation transition.

**References:**
- `checkout-surge-glm/apps/worker/src/app/services/order-process-service.ts:321` - inline notification path runs after confirmed outcome.
- `checkout-surge-glm/apps/worker/src/app/services/order-process-service.ts:355` - order processor directly calls notification persistence.
- `checkout-surge-glm/apps/worker/src/app/services/order-process-service.ts:369` - realtime notification event publishes after inline write.
- `checkout-surge-glm/apps/worker/src/app/persistence/notification-persistence.ts:61` - notification persistence inserts directly.
- `checkout-surge-glm/apps/worker/src/app/persistence/notification-persistence.ts:82` - notification event written in the same transaction.

#### Verdict rationale

This overlaps C33 only at the finalization-settlement boundary. The separate downstream-resilience issue is follow-up durability: Forge gives notifications independent retry and idempotency, while GLM logs and drops transient notification-write failures. That is weaker downstream resilience.

---

### C44 — Worker realtime milestones and consistency-lag pipeline (worse)

#### Reference behavior

Forge emits dashboard events after order-processing milestones and ERP failures while keeping durable order events as the source of truth. On confirmation it also emits an `order.consistency_lag` metric sample for that order, measured in milliseconds from the job enqueue timestamp to confirmation. Separately, the dashboard snapshot and recovery read compute run-scoped lag aggregates, so a refreshed client can recover an authoritative consistency-lag baseline. Realtime publish failures are caught so observability cannot break order processing.

**References:**
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:139` - terminal failure emits order status.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:186` - consistency lag metric emitted on confirmation.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:187` - lag uses job enqueue timestamp and confirmation time.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:141` - run-scoped lag aggregate served in dashboard snapshots.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:246` - dashboard publish failures are swallowed.
- `checkout-forge/apps/worker/src/services/order-processing-service.ts:288` - per-order lag calculated in milliseconds.

#### Compared behavior

GLM publishes validated realtime events for order transitions and every ERP attempt, which is stronger than Forge's narrower attempt-event surface. Its consistency-lag signal is different, though: after each confirmation it queries recent confirmed orders and publishes rolling p95/p50 lag in seconds for the sale offer. The SQL percentile aggregate is more statistically useful than a raw sample, and it is bounded to a recent window, but it runs inside the worker confirmation path for every confirmed order. The signal is also realtime-only: the recovery response does not include lag figures, so a refreshed or reconnecting tab has no authoritative value for this gold signal until a later confirmation publishes another event.

**References:**
- `checkout-surge-glm/apps/worker/src/app/services/order-realtime.ts:25` - order transition realtime publishing is best-effort.
- `checkout-surge-glm/apps/worker/src/app/services/order-realtime.ts:68` - ERP attempt realtime publishing is best-effort.
- `checkout-surge-glm/apps/worker/src/app/services/order-process-service.ts:321` - lag publication triggered after confirmed transition.
- `checkout-surge-glm/packages/db/src/orders/confirmation-lag.ts:47` - lag read model derives percentiles from recent confirmed orders.
- `checkout-surge-glm/packages/db/src/orders/confirmation-lag.ts:65` - windowed SQL percentile aggregate.
- `checkout-surge-glm/apps/worker/src/app/services/order-process-service.ts:334` - aggregate query executed per confirmation.
- `checkout-surge-glm/apps/worker/src/app/services/order-projection.ts:104` - realtime lag payload is p95/p50 seconds.
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:143` - recovery response has no consistency-lag projection.

#### Verdict rationale

C7 grades contract and validation quality, where GLM is better. This topic grades the worker-produced signal pipeline. GLM's ERP-attempt events and SQL percentile math are useful, but the named consistency-lag signal loses the raw per-order measurement, pushes a windowed aggregate query into the worker's per-confirmation path, and cannot be recovered through the authoritative dashboard read. Those cost and recoverability regressions outweigh the stronger percentile projection.

---

### C45 — Internal realtime publication discipline (same)

#### Reference behavior

Forge publishes dashboard events through one Redis Pub/Sub channel and validates events before serialization. API and worker publishers are best-effort: publish promises are detached, failures are logged with event/correlation context, and business code does not wait on or fail because of realtime delivery. The subscriber side revalidates channel messages and drops malformed payloads with a warning.

**References:**
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:24` - publish-side event schema validation.
- `checkout-forge/apps/api/src/realtime/dashboard-realtime-publisher.ts:39` - fire-and-forget publish with logged failures.
- `checkout-forge/apps/worker/src/realtime/dashboard-realtime-publisher.ts:23` - worker uses the same validated best-effort pattern.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:167` - consume-side revalidation and drop behavior.

#### Compared behavior

GLM uses the same single-channel topology and keeps realtime publication best-effort for business operations. Its concrete publisher does not parse at the transport boundary, but event projection helpers parse events before returning them, and the fan-out boundary validates inbound messages again. GLM adds a `RealtimePublicationScheduler` that tracks background publishes and exposes `flush()` during shutdown, reducing the chance of truncating in-flight best-effort events when Redis clients close.

**References:**
- `checkout-surge-glm/packages/db/src/realtime/dashboard-publisher.ts:30` - concrete publisher with validation delegated to projections.
- `checkout-surge-glm/apps/api/src/app/services/inventory-projection.ts:56` - projection helpers parse events before publication.
- `checkout-surge-glm/apps/api/src/app/realtime/publication-scheduler.ts:51` - tracked background publication scheduler.
- `checkout-surge-glm/apps/api/src/index.ts:114` - shutdown flushes in-flight publications.
- `checkout-surge-glm/apps/api/src/app/dashboard-realtime/fanout.ts:115` - fan-out validates channel messages.

#### Verdict rationale

Both implementations preserve the important discipline: shared realtime channel, validation on the path, malformed-event drops, and publish failures that do not break checkout or worker processing. GLM's shutdown flush is a useful refinement, while Forge's publisher enforces validation directly at the transport seam. Those tradeoffs leave the overall publication discipline equivalent.

---

### C46 — SSE stream gateway and fan-out mechanics (better)

#### Reference behavior

Forge's API owns one process-wide Redis subscription and fans events out to in-memory SSE clients. Connections get correct event-stream/no-cache/keep-alive headers, a 20-second comment-frame heartbeat, and cleanup on close/error. Backpressure follows the no-buffering recovery model: if `response.write` returns `false`, the gateway removes and ends that client. It does not impose a client cap, send an SSE `retry:` hint, or write an opening liveness frame before the first event.

**References:**
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:31` - one process-wide subscription with in-memory clients.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:68` - per-client heartbeat timer.
- `checkout-forge/apps/api/src/realtime/dashboard-sse-gateway.ts:193` - backpressure closes the client.
- `checkout-forge/apps/api/src/routes/dashboard-events.ts:18` - stream route hijacks the reply into the gateway.

#### Compared behavior

GLM keeps the same shared-subscription/in-memory-sink architecture and the same no-buffering backpressure rule, then adds transport hardening: an SSE `retry: 3000` reconnect hint, an opening heartbeat frame, `X-Accel-Buffering: no`, charset on the content type, a correlation-ID response header, explicit stream CORS handling, a validated and tunable per-process client cap, and one shared heartbeat timer rather than one timer per client. Frame serialization is isolated in pure helpers, and dead sinks are detached without aborting fan-out to other clients.

**References:**
- `checkout-surge-glm/apps/api/src/app/routes/dashboard.ts:75` - client cap with explicit capacity error.
- `checkout-surge-glm/apps/api/src/app/routes/dashboard.ts:94` - reconnect hint and opening heartbeat.
- `checkout-surge-glm/apps/api/src/app/routes/dashboard.ts:121` - backpressure closes the connection.
- `checkout-surge-glm/apps/api/src/app/dashboard-realtime/fanout.ts:115` - channel validation before fan-out.
- `checkout-surge-glm/apps/api/src/app/dashboard-realtime/sse-frame.ts:32` - pure SSE frame helpers.
- `checkout-surge-glm/apps/api/src/app/config.ts:127` - heartbeat interval and client cap are validated config.

#### Verdict rationale

Both satisfy the spec's core stream model: browser-facing API owner, no replay buffer, heartbeat, validation, teardown, and recovery-based resync after dropped clients. GLM adds practical deployment and resource-bound improvements without losing baseline behavior. The reconnect hint, opening heartbeat, proxy-buffering header, CORS handling, client cap, and shared heartbeat timer make the stream gateway better.

---

### C47 — Dashboard recovery read model and terminal settle (same)

#### Reference behavior

Forge's `/dashboard/recovery` is a rich one-round-trip resynchronization read. It merges in-memory recovery state with durable run data, prefers durable truth for the current run, attaches the frozen config snapshot, and returns the dashboard snapshot, current run, latest traffic metrics, and terminal summary when the current run has just ended. That makes the client-side final recovery after a terminal event self-sufficient. Weaknesses remain: sold-out pressure and latest traffic metrics are process-memory values that reset on API restart, and the embedded order-status projection is unbounded by run size.

**References:**
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:58` - durable/in-memory current-run merge.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:62` - one response aggregates dashboard panels.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:136` - sold-out count sourced from in-process aggregation.
- `checkout-forge/apps/api/src/services/dashboard-snapshot-service.ts:181` - unbounded per-run order status projection.
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:104` - terminal summary embedded after terminal transition.
- `checkout-forge/apps/api/src/services/dashboard-recovery-state-service.ts:56` - terminal-state regression guards.

#### Compared behavior

GLM reconstructs the current run from durable state and Redis-backed live facts rather than API process memory. It selects the latest recoverable `starting`/`active`/`draining` run, revalidates the JSON config snapshot, and composes durable counts, Redis sold-out aggregates, Redis-retained traffic metrics, ERP-attempt counts, notification counts, and retry attempts. This is more restart-proof for the fields it serves. The tradeoff is completeness: inventory, queue, and ERP panels require separate reads, consistency lag is absent from recovery, and terminal runs disappear from recovery immediately, so final settle depends on the terminal realtime event plus a run-history read rather than one final recovery body.

**References:**
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:107` - durable-only current-run reconstruction.
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:131` - parallel recovery composition.
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:66` - config snapshot revalidated through contracts.
- `checkout-surge-glm/packages/db/src/run-lifecycle/traffic-metrics.ts:62` - latest traffic metrics retained in Redis.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-recovery.ts:94` - only starting/active/draining runs are recoverable.
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:109` - terminal run yields no current-run body.

#### Verdict rationale

The implementations fail in opposite directions. Forge is richer and more convenient for a reconnecting browser, including terminal-settle data in one response, but some recovery facts are lost on API restart and one projection is unbounded. GLM is more restart-proof and bounded for what it returns, but recovery is chattier and omits important panels and consistency lag; terminal settle requires another read path. Neither design clearly dominates, so the consolidated verdict is `same`.

---

### C48 — Queue, ERP, and readiness status projections (better)

#### Reference behavior

Forge exposes queue health with waiting/active/delayed/failed/completed counts, retrying detection, oldest-waiting age, and failed-job details. Its ERP resilience endpoint is much thinner: the API infers breaker state from recent `erp_attempts` rows, reports only `open` or `unknown`, and cannot show half-open state, threshold, consecutive failures, or real retry timing from the worker's breaker. Health/readiness checks include a database probe but treat Redis readiness mostly as configuration presence rather than an actual dependency probe.

**References:**
- `checkout-forge/apps/api/src/services/queue-health-service.ts:29` - queue health projection.
- `checkout-forge/apps/api/src/services/erp-resilience-status-service.ts:72` - ERP state inferred from attempts.
- `checkout-forge/apps/api/src/routes/health.ts:19` - readiness checks database and Redis URL configuration.

#### Compared behavior

GLM's queue read covers the same basic counts, oldest-waiting age, bounded failed-job sample, and max failed attempts. Its ERP status is stronger: the worker writes live circuit-breaker state to a shared Redis key, and the API reads that actual snapshot, including state, opened-at, failure count, and threshold, then combines it with a 300-second SQL aggregate over ERP attempts and confirmation latency. Readiness probes real database and queue dependencies with timeouts and uses a documented degraded-vs-unavailable policy; the worker also exposes its own health server.

**References:**
- `checkout-surge-glm/apps/api/src/app/services/queue-health-service.ts:54` - queue counts and bounded failure sample.
- `checkout-surge-glm/apps/api/src/app/services/erp-health-service.ts:76` - live breaker snapshot read from Redis.
- `checkout-surge-glm/apps/api/src/app/services/erp-health-service.ts:94` - windowed ERP-attempt and latency aggregate.
- `checkout-surge-glm/apps/api/src/app/services/readiness-service.ts:60` - dependency probes with timeouts and degraded policy.

#### Verdict rationale

GLM is materially better for operator status reads. Queue is roughly equivalent, but ERP resilience is not: GLM surfaces the worker's live breaker state instead of guessing from recent attempts, and its readiness logic probes real dependencies with a clear status policy. The extra SQL aggregation cost is small for a status endpoint and buys more useful operational visibility.

---

### C49 — Realtime and read-model test coverage (same)

#### Reference behavior

Forge tests the realtime/read-model layer with SSE gateway coverage, including real Redis Pub/Sub integration, publisher behavior, the recovery state machine, sold-out dashboard aggregation, load-metric ingestion, health routes, and frontend-side recovery coordination. Those tests exercise the important validation, fan-out, aggregation, and recovery behaviors for this layer.

**References:**
- `checkout-forge/apps/api/test/dashboard-sse-gateway.integration.test.ts:1` - SSE gateway integration against real Redis.
- `checkout-forge/apps/api/test/sold-out-dashboard-metric-aggregator.test.ts:1` - sold-out aggregation cadence coverage.
- `checkout-forge/apps/api/test/dashboard-recovery-state-service.test.ts:1` - recovery state precedence and regression tests.

#### Compared behavior

GLM covers the same territory with granular tests for fan-out, SSE frame formatting, CORS resolution, pure event projections, and the publication scheduler, plus integration tests for end-to-end realtime, hot-path fire-and-forget behavior, inventory-drain realtime, order-queued realtime, recovery, load-metrics ingestion, queue/ERP/inventory status reads, and worker order realtime.

**References:**
- `checkout-surge-glm/apps/api/tests/dashboard-realtime.integration.test.ts:1` - end-to-end channel-to-SSE integration.
- `checkout-surge-glm/apps/api/tests/buy-realtime-fire-and-forget.integration.test.ts:1` - hot-path publication decoupling.
- `checkout-surge-glm/apps/api/tests/recovery.integration.test.ts:1` - recovery read against real infrastructure.

#### Verdict rationale

Both suites cover the important realtime and read-model mechanics with real infrastructure where it matters. GLM is more granular around pure wire-format and projection helpers, while Forge covers the aggregation cadence GLM lacks. Systemic testing breadth is covered in C83-C87; for this realtime/read-model layer, coverage is equivalent.

---

### C50 — k6 ownership, service boundary, and readiness (same)

#### Reference behavior

Forge keeps k6 inside the load-orchestrator boundary. The load-orchestrator image copies a pinned k6 binary into the runtime image, configures the service to use that bundled binary, verifies the executable in readiness, and exposes traffic start as a token-protected orchestrator control route. That matches the reference topology rule that k6 is not a host prerequisite for the normal runtime.

**References:**
- `checkout-forge/apps/load-orchestrator/Dockerfile:1` - k6 binary sourced from the official k6 image.
- `checkout-forge/apps/load-orchestrator/Dockerfile:8` - runtime `K6_BINARY` points at the bundled binary.
- `checkout-forge/apps/load-orchestrator/src/server.ts:101` - readiness includes the k6 executable check.
- `checkout-forge/apps/load-orchestrator/src/server.ts:125` - run start exposed through the load-orchestrator service.
- `checkout-forge/apps/load-orchestrator/src/server.ts:191` - control service token validation.

#### Compared behavior

GLM preserves the same boundary. Its load-orchestrator Dockerfile copies k6 from a pinned official k6 image, configures `K6_BINARY` to the container-local executable, and readiness runs `k6 version` with a timeout. Its run-start route is also token-gated before accepting delegated traffic snapshots from the API.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/Dockerfile:51` - k6 copied from the official image into the runtime stage.
- `checkout-surge-glm/apps/load-orchestrator/Dockerfile:59` - runtime `K6_BINARY` points at `/usr/local/bin/k6`.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/k6-probe.ts:14` - readiness probe spawns `k6 version`.
- `checkout-surge-glm/apps/load-orchestrator/src/app/routes/run-control.ts:40` - run-start endpoint is the orchestrator control surface.
- `checkout-surge-glm/apps/load-orchestrator/src/app/routes/run-control.ts:41` - run start rejects missing or invalid control tokens.

#### Verdict rationale

The exact k6 version differs, but both implementations satisfy the important architectural boundary: the orchestrator owns the k6 binary, readiness proves k6 can run, and run-start control is protected by the service-token chain. This is equivalent.

---

### C51 — Traffic model mapping and generator capacity (worse)

#### Reference behavior

Forge maps the two user-facing traffic modes to k6 executors that fit the promised shape. Buyer spikes use `per-vu-iterations`, with one VU per buyer and iteration count adjusted for duplicate mode. Steady arrival uses `constant-arrival-rate`, with automatic VU sizing derived from requested rate: pre-allocated VUs are approximately the rate and max VUs approximately double it, capped at 10k. The generated script also discards response bodies, uses a 5 second graceful stop, and drops over-scheduled steady iterations beyond the planned emitted-attempt count.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:55` - k6 discards response bodies.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:149` - buyer-spike and steady-arrival scenarios rendered from the execution plan.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:187` - over-scheduled steady iterations are dropped in-script.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:207` - steady VU pool derived from scheduled rate and capped at 10k.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:238` - buyer-spike VUs and iterations derived from buyers and duplicate mode.

#### Compared behavior

GLM uses the same broad executor choices, but its default steady-arrival capacity is much smaller. Automatic pre-allocation is clamped to at most 50 VUs and max VUs default to twice that, so a 10k RPS run without explicit overrides starts from 50/100 VUs rather than a pool sized near the requested rate. The generated scenarios also omit an explicit graceful stop and do not guard steady-arrival iterations against the planned-attempt count. Buy requests use `responseType: "text"` rather than globally discarding response bodies, which adds avoidable work under surge.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:55` - automatic steady pre-allocation clamped to 50 VUs.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:78` - buyer-spike maps to `per-vu-iterations`.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:92` - steady-arrival maps to `constant-arrival-rate`.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:116` - requests use `responseType: "text"`.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:137` - steady mode uses global iteration identity without a planned-attempt cutoff.

#### Verdict rationale

The executor mapping is directionally correct, but the default capacity heuristic is materially weaker for the benchmark target. Forge sizes the generator so it is less likely to become the bottleneck at 10k RPS; GLM's 50/100 default can under-deliver whenever the buy path slows. The missing graceful stop, planned-attempt guard, and body-discard setting reinforce that the generator is less benchmark-faithful.

---

### C52 — Attempt identity and script-parameter safety (same)

#### Reference behavior

Forge generates k6 scripts from typed snapshots and inserts dynamic values as JSON literals rather than shell-interpolated strings. Attempt identity is deterministic: buyer-spike keys are stable per buyer so duplicate mode reuses the same key, while steady-arrival keys are derived from the global iteration index and include the run ID. Correlation IDs are also deterministic and tied to the run and attempt.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:46` - script generation starts from typed options.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:70` - run and purchase parameters serialized with `JSON.stringify`.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:173` - request identity snippet selected per execution plan.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:179` - buyer-spike duplicate attempts reuse a buyer-derived key.
- `checkout-forge/apps/load-orchestrator/src/k6-script.ts:192` - steady-arrival keys include run ID and global iteration.

#### Compared behavior

GLM also avoids shell interpolation. It bakes only validated numeric scenario options into the generated source and passes run ID, sale offer ID, and buy URL through the child-process environment. Buyer-spike keys are stable per VU, so duplicate mode replays the same key. Steady-arrival keys use `exec.scenario.iterationInTest`, so VU reuse does not collapse attempts. The key strings do not include the run ID, but idempotency is scoped by sale offer and generated offers are run-scoped, so the intended model still avoids practical collisions.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:14` - run identity passed through k6 environment variables.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:114` - buyer-spike idempotency key stable per synthetic buyer.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/script-generator.ts:139` - steady key uses global scenario iteration.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/k6-runner.ts:55` - k6 argv constructed as an argument array.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/k6-runner.ts:67` - k6 spawned with `shell: false`.

#### Verdict rationale

The parameter-passing styles differ, but both avoid shell injection and produce deterministic idempotency behavior for unique and duplicate attempts. The missing run ID in GLM's key string is acceptable because the idempotency scope includes the run-scoped sale offer.

---

### C53 — k6 output parsing and terminal accounting (worse)

#### Reference behavior

Forge consumes both k6's JSON point stream and the exported end-of-test summary. It supports the canonical HTTP metrics, custom outcome counters, iterations, and dropped iterations. The terminal report prefers summary-export counters when available, falls back to point-stream aggregates with diagnostics, and computes delivery fields such as planned attempts, observed requests, dropped iterations, completed iterations, unstarted iterations, and request shortfall.

**References:**
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:31` - supported metrics include HTTP metrics, custom counters, iterations, and dropped iterations.
- `checkout-forge/apps/load-orchestrator/src/k6-output-parser.ts:84` - summary metrics parsed from k6 output/export JSON.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:316` - k6 run uses `--summary-export` and JSON point output.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:683` - terminal traffic outcomes summarize total, accepted, sold-out, and unexpected counts.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:738` - delivery summary includes planned attempts and shortfall fields.

#### Compared behavior

GLM parses only `http_reqs`, `http_req_duration`, and `http_req_failed` from the k6 point output file. It computes totals and latency percentiles by re-parsing the point-output file after k6 exits, but it does not parse k6 summary export, custom counters, dropped iterations, completed iterations, VU allocation, or HTTP timing breakdown sub-metrics. API-side finalization re-derives delivery quality from planned attempts and `httpSummary.httpReqs`, but the recorded output lacks the richer accounting needed to explain under-delivery.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/output-parser.ts:13` - only three k6 metrics are supported.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/metrics-aggregator.ts:131` - terminal summary is based on the same three metrics.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/metrics-aggregator.ts:177` - timing breakdown and request lifecycle summaries are empty.
- `checkout-surge-glm/apps/load-orchestrator/src/app/services/traffic-execution-service.ts:160` - completion report re-parses the full output file.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:256` - traffic outcome schema only carries completion state, exit code, and optional error.

#### Verdict rationale

GLM has enough data for a coarse delivery ratio, but not for benchmark-grade diagnostics. It cannot report dropped or unstarted iterations, distinguish accepted from sold-out outcomes, or prefer k6's terminal summary counters over sampled point aggregation. Failed or degraded traffic is therefore harder to diagnose and less comparable to the baseline.

---

### C54 — Live k6 metric streaming pipeline (same)

#### Reference behavior

Forge adapts k6 point samples into dashboard metrics and streams them to the API's internal metric-ingestion endpoint with the shared service token. The runner batches pending dashboard metrics, flushes them on a short interval, and treats metric delivery as best-effort so observability failures do not fail the traffic run.

**References:**
- `checkout-forge/apps/load-orchestrator/src/metric-adapter.ts:11` - k6 point samples adapted to dashboard metric events.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:402` - parsed k6 samples folded into aggregates and metrics.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:436` - metrics buffered for streaming.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:463` - metric flush failures logged without failing the run.
- `checkout-forge/apps/load-orchestrator/src/api-metric-stream-client.ts:35` - metrics posted to `/internal/load/metrics` with the service token.

#### Compared behavior

GLM also forwards parsed k6-derived metrics to the API over a token-protected internal endpoint, and forwarding failures are swallowed. Its implementation polls the k6 JSON output file with an incremental reader and emits window-level aggregate samples rather than forwarding per-point adapted samples. The live signal is coarser because only three k6 metrics are admitted, but it still covers request rate, latency, and failure rate.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/src/app/services/traffic-execution-service.ts:95` - flush windows read new k6 output and aggregate metrics.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/output-stream-reader.ts:51` - reader append-reads by byte offset and handles partial lines.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/metrics-aggregator.ts:71` - request-rate samples derived from `http_reqs` windows.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/metrics-aggregator.ts:82` - latency samples derived from duration values.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/api-load-metrics-sink.ts:54` - metric ingestion uses the control service token.

#### Verdict rationale

The richer terminal metric limitations are covered in C53. For the live streaming mechanism itself, both implementations use token-protected internal ingestion and best-effort delivery. GLM's incremental file reader is a reasonable alternative to adapting k6 stdout directly, even though its admitted metric set is narrower.

---

### C55 — Completion-report reliability and cancellation controls (worse)

#### Reference behavior

Forge establishes the API recovery baseline before spawning k6 by reporting the `starting` lifecycle state to the API and aborting start if the API rejects it. After k6 exits, the completion report is submitted to the API; if submission fails, the runner retains the pending report and retries on a timer. The orchestrator also exposes a token-protected abort endpoint that terminates the active k6 child with `SIGTERM`, which matters for reset and recovery workflows.

**References:**
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:178` - API lifecycle sink called before k6 execution starts.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:497` - terminal traffic report built after k6 exits.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:596` - failed completion-report submission retained for retry.
- `checkout-forge/apps/load-orchestrator/src/load-runner.ts:239` - abort kills the active child process with `SIGTERM`.
- `checkout-forge/apps/load-orchestrator/src/server.ts:159` - abort exposed as a token-protected control route.

#### Compared behavior

GLM relies on the API to create the run and delegate traffic before k6 starts, which covers start ordering at a higher layer. Its orchestrator completion forwarder is explicitly best-effort, though: non-ok responses, network errors, and timeouts are logged and swallowed with no retained pending report or retry loop. The process runner adds a hard timeout and kills k6 with `SIGKILL` on timeout, but the exposed control routes are start and per-run status only; there is no comparable abort route.

**References:**
- `checkout-surge-glm/apps/load-orchestrator/src/app/services/traffic-execution-service.ts:195` - k6 starts after workdir and execution state setup.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/k6-runner.ts:76` - timed-out k6 runs killed with `SIGKILL`.
- `checkout-surge-glm/apps/load-orchestrator/src/app/services/traffic-execution-service.ts:262` - completion report sent after k6 exits.
- `checkout-surge-glm/apps/load-orchestrator/src/app/k6/api-traffic-completion-sink.ts:64` - forwarding has timeout but no retry.
- `checkout-surge-glm/apps/load-orchestrator/src/app/routes/run-control.ts:75` - run-control exposes status with no abort counterpart.

#### Verdict rationale

Completion reports feed API-owned finalization with k6 exit details and HTTP summaries, so dropping them is not merely losing optional telemetry. Forge keeps failed reports pending and retries; GLM logs and moves on, leaving the API to infer failure later without the real traffic evidence. The missing orchestrator abort route also weakens operational control during reset or recovery.

---

### C56 — Web route split and public/admin surface layout (same)

#### Reference behavior

Forge implements the required dashboard route split: a public picker at the root, a spectator watch view, public run history with per-run details, and an authenticated admin console. The root route checks the admin session server-side before rendering the public home client, so anonymous visitors do not see the operator shell.

**References:**
- `checkout-forge/apps/web/src/app/page.tsx:16` - root picker checks admin session server-side.
- `checkout-forge/apps/web/src/app/admin/page.tsx:1` - separate authenticated admin console route.
- `checkout-forge/apps/web/src/app/run-history/[runId]/page.tsx:1` - public per-run detail route.
- `checkout-forge/apps/web/src/app/watch/page.tsx:1` - spectator watch route.

#### Compared behavior

GLM has the same top-level split: `/`, `/watch`, `/run-history`, and `/admin`, plus an `/about` page. The admin route shows only the sign-in gate until the session is valid, matching the access-model shape. The root page does ship a permanent placeholder panel and stale copy claiming some controls are later-phase work even though those features now exist.

**References:**
- `checkout-surge-glm/apps/web/app/admin/page.tsx:29` - anonymous visitors see only the sign-in gate.
- `checkout-surge-glm/apps/web/app/page.tsx:34` - permanent placeholder panel on the public picker.
- `checkout-surge-glm/apps/web/components/run-start-panel.tsx:64` - stale "later phases" copy.
- `checkout-surge-glm/apps/web/components/site-nav.tsx:19` - admin entry in shared navigation.

#### Verdict rationale

The structural route model and anonymous/admin separation are equivalent. GLM loses polish for placeholder and stale UI copy, but those do not change the route split itself. The completeness of each route's contents is graded separately in C59 through C62.

---

### C57 — Frontend recovery and realtime coordination (same)

#### Reference behavior

Forge implements the prescribed client recovery discipline in dedicated, tested modules. It fetches recovery on connect and reconnect, discards live events while a recovery snapshot is in flight, loops a follow-up recovery if anything was discarded, and performs one final recovery for each terminal run event. Failed recovery enters an explicit sync-issue state and is retried every 3 seconds.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:49` - events during recovery are discarded and flagged.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:74` - recovery loops while discards occurred.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:59` - final recovery deduped per terminal run.
- `checkout-forge/apps/web/src/app/dashboard-live-state.ts:50` - recovery failure retry scheduler.

#### Compared behavior

GLM implements the same core behavior through a pure reducer and a thin `LiveWatch` orchestrator. `recoveryInFlight` discards incoming events and records a follow-up flag, the orchestrator performs that follow-up once the window closes, reconnects trigger recovery after stream errors, and terminal `run.completed` or `run.failed` events trigger a final recovery. Concurrent triggers are coalesced through an in-flight ref. Its weaker edge is failed recovery: it degrades to an unreachable panel state and waits for the next reconnect or terminal trigger rather than scheduling its own retry.

**References:**
- `checkout-surge-glm/apps/web/lib/dashboard-state.ts:318` - reducer discards events while recovery is in flight.
- `checkout-surge-glm/apps/web/components/watch/live-watch.tsx:122` - follow-up recovery effect after the discard window.
- `checkout-surge-glm/apps/web/components/watch/live-watch.tsx:28` - terminal run events trigger final recovery.
- `checkout-surge-glm/apps/web/components/realtime/use-dashboard-events.ts:89` - reconnect callback fires recovery after errors.
- `checkout-surge-glm/apps/web/components/watch/live-watch.tsx:78` - concurrent recovery triggers are coalesced.

#### Verdict rationale

Both implementations satisfy the three hardest frontend requirements: discard during recovery, follow-up recovery after discards, and terminal-event final recovery. Forge is stronger on automatic retry after a failed recovery; GLM has a cleaner pure reducer model and trigger coalescing. The core correctness is equivalent.

---

### C58 — Browser SSE client transport and reconnect UX (same)

#### Reference behavior

Forge uses native `EventSource` with named listeners for the realtime contract event types, validates each frame against the shared Zod event union before applying it, and maps stream state to explicit UI states such as connecting, live, reconnecting, recovering, and sync issue. Native EventSource reconnects are paired with recovery reads.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:59` - named listeners per contract event type.
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:66` - frame validation before apply.
- `checkout-forge/apps/web/src/app/dashboard-client-realtime.ts:51` - recovery fetch on stream open.

#### Compared behavior

GLM's browser hook also uses named listeners, parses and validates every frame with `DashboardRealtimeEventSchema`, relies on native EventSource reconnect, and renders an explicit connecting/live/reconnecting banner. It skips recovery on the first open because the page is server-seeded, then fires recovery on genuine reconnects.

**References:**
- `checkout-surge-glm/apps/web/components/realtime/use-dashboard-events.ts:103` - named listeners per dashboard event name.
- `checkout-surge-glm/apps/web/components/realtime/use-dashboard-events.ts:128` - JSON parsing and contract validation.
- `checkout-surge-glm/apps/web/components/watch/live-watch.tsx:145` - explicit stream status banner states.

#### Verdict rationale

Both browser clients validate live events before state mutation and expose reconnecting state instead of silently going stale. The baseline exposes a few more recovery-specific statuses, while GLM keeps the hook tidy with callback refs and an injectable EventSource constructor for tests. The transport and UX discipline are equivalent.

---

### C59 — Live watch UX and run-context storytelling (worse)

#### Reference behavior

Forge's watch page is a full spectator surface. It shows run phase and lifecycle explanation, metric tiles for the four gold signals plus traffic truth such as observed RPS, observed requests, traffic quality, and planned attempts, rolling sparklines, business outcomes, ERP and queue panels, the frozen accepted configuration, recent order events, and manual refresh. The page explains what the spectator is seeing rather than only exposing raw counters.

**References:**
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:51` - run-phase header and lifecycle explanation.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:174` - frozen accepted configuration panel.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:284` - rolling sparkline series buffer.
- `checkout-forge/apps/web/src/app/watch/watch-run-client.tsx:215` - recent order events feed.

#### Compared behavior

GLM's watch page has polished panels for request surge, inventory drain, queue pressure, ERP health, completion outcomes, and consistency lag, and it correctly resolves the inventory target from the current run's generated sale offer. However, the page lacks a run status header, frozen run-configuration display, and traffic-level metrics. Its request-surge panel states that `traffic.*` metrics are reserved for a later phase, and the reducer ignores run-lifecycle and traffic metric events.

**References:**
- `checkout-surge-glm/apps/web/app/watch/page.tsx:44` - watch page renders the six panels without run status or configuration.
- `checkout-surge-glm/apps/web/components/watch/request-surge-panel.tsx:12` - traffic metrics declared not produced.
- `checkout-surge-glm/apps/web/lib/dashboard-state.ts:427` - reducer ignores run-lifecycle and traffic metric events.
- `checkout-surge-glm/apps/web/app/watch/page.tsx:50` - inventory target uses the current run's generated offer.

#### Verdict rationale

GLM covers several important live signals well, especially consistency lag and inventory targeting, but it misses mandated watch-view context: run status, frozen run configuration, and traffic-level truth. A spectator can see parts of the system reacting but cannot tell from the watch page what run is executing, under which configuration, or how the traffic generator actually performed. That is materially thinner than the baseline.

---

### C60 — Public custom run form (missing)

#### Reference behavior

Forge's public picker includes the required bounded public custom run form. The draft is seeded from runtime-policy defaults, fields are bounded by policy limits with inline clamp messaging, worker-profile choices are restricted, and the form resets from policy defaults. This gives public visitors controlled customization without bypassing governance.

**References:**
- `checkout-forge/apps/web/src/app/public-home-client.tsx:246` - public custom run form section.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:80` - draft initialized from runtime-policy defaults.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:945` - public-policy clamp feedback.

#### Compared behavior

GLM's public surface offers curated preset starts only. The demo picker filters out the `public-custom` base preset, the start controls launch fixed preset slugs, and the web app has no runtime-policy read for public custom bounds. Public visitors cannot configure run parameters from the UI.

**References:**
- `checkout-surge-glm/apps/web/components/demo-picker.tsx:23` - custom presets filtered out of the picker.
- `checkout-surge-glm/apps/web/components/load-run-trigger.tsx:29` - fixed preset slug start control.
- `checkout-surge-glm/apps/web/components/run-start-panel.tsx:70` - home panel hardcodes `preview-1k`.

#### Verdict rationale

The public picker is supposed to provide curated presets plus bounded public custom starts. GLM implements only the curated preset half; there is no form, no policy-bound inputs, and no custom draft state. This is missing rather than merely weaker.

---

### C61 — Run history frontend surface (worse)

#### Reference behavior

Forge's run history is a full public-safe surface: cursor pagination with a back-stack, a summary table, per-run detail pages, and admin deletion flows for single, selected, and all runs. Delete-all requires a typed confirmation token. Summary and traffic rendering logic is factored into tested view-model modules.

**References:**
- `checkout-forge/apps/web/src/app/run-history/run-history-client.tsx:55` - cursor-stack pagination.
- `checkout-forge/apps/web/src/app/run-history/run-history-client.tsx:133` - delete-all sends typed confirmation.
- `checkout-forge/apps/web/src/app/run-history/[runId]/page.tsx:1` - per-run detail route.
- `checkout-forge/apps/web/src/app/run-history/run-history-summary-view.ts:1` - summary view-model module.

#### Compared behavior

GLM's run history is a single server-rendered page with one unpaginated table of terminal summaries and outcome cards for only the three most recent runs. It has no per-run detail route and no deletion UI, even though admin proxy routes for single and bulk deletion exist. Failure reasons are mostly hidden behind hover text.

**References:**
- `checkout-surge-glm/apps/web/app/run-history/page.tsx:56` - unpaginated table.
- `checkout-surge-glm/apps/web/app/run-history/page.tsx:100` - drill-down limited to three runs.
- `checkout-surge-glm/apps/web/app/api/admin/run-history/delete/route.ts:1` - bulk-delete proxy exists without UI.
- `checkout-surge-glm/apps/web/app/run-history/page.tsx:148` - failure reason only in a title tooltip.

#### Verdict rationale

GLM provides a readable sanitized summary, but it lacks pagination, public detail depth, and usable admin deletion flows. The baseline covers the specified public history and operator deletion workflows, including the explicit delete-all confirmation.

---

### C62 — Admin console frontend completeness (worse)

#### Reference behavior

Forge's admin console includes run starts from presets, preset management with inline configuration editing, duplicate and copy-to-custom flows, runtime-policy editing with validation and save feedback, mock ERP chaos controls, and demo reset. Destructive actions use confirmation dialogs and are covered by tests.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-preset-state.ts:18` - editable preset draft state.
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:183` - runtime-policy PUT with validated draft.
- `checkout-forge/apps/web/src/app/api/control/mock-erp/chaos/route.ts:1` - chaos-control proxy surface.
- `checkout-forge/apps/web/src/app/destructive-actions.test.ts:1` - destructive confirmation tests.

#### Compared behavior

GLM includes current-run lifecycle gating, admin starts, preset duplicate/copy-to-custom actions, ERP chaos controls, reset, and an in-UI run-cleanup control with retention selection, which is a useful addition over Forge's CLI-only cleanup. But inline preset configuration editing is explicitly deferred despite an unused PUT proxy route, and there is no runtime-policy read/edit UI at all. Destructive actions use a two-step arm-and-confirm flow rather than typed confirmation, which is adequate for reset and cleanup.

**References:**
- `checkout-surge-glm/apps/web/components/admin/preset-actions.tsx:27` - preset configuration editing explicitly deferred.
- `checkout-surge-glm/apps/web/app/api/admin/presets/[slug]/route.ts:36` - preset PUT proxy exists without UI.
- `checkout-surge-glm/apps/web/components/admin/demo-tools-panel.tsx:118` - in-UI cleanup with keep-latest control.
- `checkout-surge-glm/apps/web/components/admin/lifecycle-panel.tsx:70` - start disabled while a run is live.

#### Verdict rationale

GLM has meaningful admin controls and even adds cleanup to the UI, but it lacks two major baseline capabilities: editing preset configurations and administering runtime policy. The runtime-policy gap is especially important because public custom governance depends on that singleton. Net result is worse.

---

### C63 — Web BFF proxy discipline and secret containment (same)

#### Reference behavior

Forge keeps the browser same-origin through web route handlers. Dashboard reads use server-side upstream URLs with timeout and contract validation, controls attach service tokens and operator headers server-side, and the SSE stream can be proxied through the web app. Backend URLs and secrets remain server-only.

**References:**
- `checkout-forge/apps/web/src/app/api/dashboard/dashboard-read-proxy.ts:20` - read proxy with timeout and validation.
- `checkout-forge/apps/web/src/app/dashboard/events/route.ts:35` - web-side SSE pass-through proxy.
- `checkout-forge/apps/web/src/app/web-access.ts:179` - service token and operator headers built server-side.

#### Compared behavior

GLM is similarly disciplined. Server components and route handlers use server-side URLs, browser controls go through `/api/admin/*` proxies that attach token, operator-mode, and visitor headers server-side, client recovery refetches through a same-origin route, and the Next config documents that no public backend environment values are baked. One difference is that the browser reaches `/dashboard/events` through the external edge proxy rather than a web-side route, so bare `next dev` without the proxy does not serve the stream path.

**References:**
- `checkout-surge-glm/apps/web/lib/proxy.ts:68` - private headers attached server-side.
- `checkout-surge-glm/apps/web/lib/config.ts:119` - service base URLs resolved server-side.
- `checkout-surge-glm/apps/web/app/dashboard/recovery/route.ts:1` - same-origin recovery route.
- `checkout-surge-glm/apps/web/next.config.mjs:6` - no public backend values baked.
- `checkout-surge-glm/apps/web/components/realtime/use-dashboard-events.ts:14` - SSE path expects edge-proxy routing.

#### Verdict rationale

Both implementations keep secrets and internal service URLs out of browser bundles and preserve thin server-side proxying. Forge's web-side SSE proxy is more self-contained for dev; GLM's edge-routed stream is production-idiomatic but proxy-dependent. Neither approach leaks the backend surface, so the verdict is the same.

---

### C64 — Frontend architecture and state decomposition (better)

#### Reference behavior

Forge has a strong pure-module layer for recovery coordination, retry, realtime binding, live-state reduction, view-model derivation, presentation formatting, and validation. The component layer, however, concentrates a large amount of behavior into monolithic client components and client-fetched pages.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.ts:27` - example tested pure module.
- `checkout-forge/apps/web/src/app/dashboard-client.tsx:1` - large admin client component.
- `checkout-forge/apps/web/src/app/public-home-client.tsx:1` - large public home client component.
- `checkout-forge/apps/web/src/app/dashboard-view-model.ts:1` - large view-model module.

#### Compared behavior

GLM uses the App Router more idiomatically: pages are server components that fetch snapshots server-side and stream skeletons through `Suspense`; panels are small presentational pieces with async server wrappers; the main live state is a pure reducer plus a thin orchestrator; controls are small client islands using server actions or fetches. Its largest pieces are substantially smaller and more responsibility-focused.

**References:**
- `checkout-surge-glm/apps/web/lib/dashboard-state.ts:290` - pure reducer for event-to-state mapping.
- `checkout-surge-glm/apps/web/app/watch/page.tsx:36` - server-fetched snapshots and Suspense skeletons.
- `checkout-surge-glm/apps/web/components/watch/live-watch.tsx:48` - thin transport orchestrator.
- `checkout-surge-glm/apps/web/components/admin/lifecycle-panel.tsx:61` - small presentational/admin wrapper pattern.

#### Verdict rationale

Some size difference reflects feature depth, since Forge renders more UI. Still, GLM's separation of server data loading, pure state transitions, small panels, and client islands is cleaner and should scale better. Architecture is better, with the caveat that it is proven over a smaller feature surface.

---

### C65 — Degraded-state handling of web backend reads (better)

#### Reference behavior

Forge's route handlers generally degrade with stable coded JSON errors, and the live client has explicit recovering/sync-issue states. The root public page is less resilient: if preset or runtime-policy reads fail during server rendering, it throws and can become a Next.js error page instead of a degraded picker.

**References:**
- `checkout-forge/apps/web/src/app/page.tsx:42` - home page throws on preset read failure.
- `checkout-forge/apps/web/src/app/page.tsx:54` - home page throws on runtime-policy read failure.
- `checkout-forge/apps/web/src/app/api/dashboard/dashboard-read-proxy.ts:33` - read proxies return stable errors.

#### Compared behavior

GLM applies a uniform never-throw reader convention across server-side reads and client recovery. Network, timeout, HTTP, JSON, and contract failures degrade into stable reasons, and panels render purpose-built fallbacks and skeletons rather than erroring. The dashboard remains navigable even when backend reads fail.

**References:**
- `checkout-surge-glm/apps/web/lib/api-client.ts:85` - never-throw, contract-validated readers.
- `checkout-surge-glm/apps/web/lib/client-recovery.ts:31` - client recovery fetch degrades to stable reasons.
- `checkout-surge-glm/apps/web/components/demo-picker.tsx:51` - picker fallback for unavailable presets.
- `checkout-surge-glm/apps/web/components/watch/completion-outcomes-panel.tsx:29` - per-panel degraded state.

#### Verdict rationale

GLM treats backend unavailability as a first-class web state across the app. Forge handles degraded states well in several layers but lets its front door hard-fail on key read failures. For a public demo dashboard, GLM's approach is better.

---

### C66 — Frontend behavior test coverage (same)

#### Reference behavior

Forge backs its frontend pure-module architecture with tests for recovery coordination, retry, realtime binding, live state, preset state, validation, view models, destructive confirmations, route ownership, and accessible DOM markup. The recovery coordinator tests explicitly cover discarding realtime events while recovery is in flight, follow-up recovery after discarded events, failed recovery behavior, and terminal-run final recovery, so the suite targets the stale-overwrite bugs most likely to regress.

**References:**
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.test.ts:1` - recovery-discipline tests.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.test.ts:58` - follow-up recovery after discarded events.
- `checkout-forge/apps/web/src/app/dashboard-recovery-coordinator.test.ts:294` - terminal run updates request terminal recovery.
- `checkout-forge/apps/web/src/app/destructive-actions.test.ts:1` - confirmation-flow coverage.
- `checkout-forge/apps/web/src/app/frontend-route-ownership.test.ts:1` - BFF route surface asserted.
- `checkout-forge/apps/web/src/app/dashboard-ui.dom.test.tsx:1` - DOM-level accessible-markup tests.

#### Compared behavior

GLM has comparable coverage density for its smaller surface: reducer and state-model tests, EventSource hook tests with a fake constructor, live-watch recovery integration tests for discard/follow-up/terminal recovery, admin proxy and route tests, panel tests, config validation, and format helpers. The tests prove same-origin EventSource subscription, malformed-frame dropping, open/error/reconnect callbacks, reconnect-triggered recovery, terminal-event recovery, and the discard-then-follow-up rule.

**References:**
- `checkout-surge-glm/apps/web/tests/live-watch-recovery.test.tsx:1` - component-level recovery integration tests.
- `checkout-surge-glm/apps/web/tests/live-watch-recovery.test.tsx:255` - recovery re-fetch on SSE reconnect.
- `checkout-surge-glm/apps/web/tests/live-watch-recovery.test.tsx:291` - discard in-flight events and run follow-up recovery.
- `checkout-surge-glm/apps/web/tests/use-dashboard-events.test.ts:1` - EventSource hook coverage.
- `checkout-surge-glm/apps/web/tests/use-dashboard-events.test.ts:109` - malformed realtime frames are dropped.
- `checkout-surge-glm/apps/web/tests/admin-routes.test.ts:1` - admin proxy-route coverage.

#### Verdict rationale

Both suites focus on the important behavior instead of only snapshots, and both cover the recovery/realtime client path plus proxy surfaces. Forge covers more total UI because it has more total UI; GLM's assertion quality and density are comparable for its smaller dashboard.

---

### C67 — Admin session and web proxy authorization chain (better)

#### Reference behavior

Forge implements the intended dashboard-owned admin session model. The web tier requires the admin passphrase, admin-session secret, public-client cookie secret, and control-service token; it mints a signed HttpOnly admin cookie with expiry and forwards privileged controls with the private service token plus operator-mode header. Passphrase comparison uses timing-safe equality. The model is sound, but protected proxy logic is repeated across many route files and the CSRF posture is limited to SameSite=Lax cookies.

**References:**
- `checkout-forge/apps/web/src/app/web-access.ts:51` - required web access secrets and service token.
- `checkout-forge/apps/web/src/app/web-access.ts:125` - signed admin session cookie value.
- `checkout-forge/apps/web/src/app/web-access.ts:135` - admin session verification and expiry check.
- `checkout-forge/apps/web/src/app/web-access.ts:175` - passphrase comparison through hashed timing-safe equality.
- `checkout-forge/apps/web/src/app/web-access.ts:179` - proxy control headers include service token and operator mode.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:18` - run-start proxy derives admin/public mode from validated session.

#### Compared behavior

GLM keeps the same architectural chain but factors it more cleanly. Admin session creation and verification live in a dedicated module, protected proxy routes share a `requireAdmin` guard, and centralized proxy helpers attach the control token and operator-mode header server-side. It also rejects weak admin-session secrets at mint/verify time and uses Next.js instrumentation to refuse production startup when operator-facing web secrets are unset or still equal to local-development sentinels. Its CSRF posture remains broadly equivalent to Forge: HttpOnly SameSite=Lax cookies, with no separate token or origin check found on mutating admin proxy routes.

**References:**
- `checkout-surge-glm/apps/web/lib/admin-session.ts:43` - constant-time passphrase/session equality helper.
- `checkout-surge-glm/apps/web/lib/admin-session.ts:76` - signed HttpOnly admin session creation with weak-secret fail-closed behavior.
- `checkout-surge-glm/apps/web/lib/admin-session.ts:124` - admin session verification and max-age enforcement.
- `checkout-surge-glm/apps/web/lib/admin-proxy.ts:26` - shared admin-session route guard.
- `checkout-surge-glm/apps/web/lib/proxy.ts:68` - centralized service-token/operator-header forwarding.
- `checkout-surge-glm/apps/web/instrumentation.ts:18` - production startup calls secret validation.

#### Verdict rationale

GLM is better for the web authorization chain because it preserves the reference security model while reducing per-route duplication and adding web-tier production secret validation. That makes new admin proxy routes less likely to forget session gating or token attachment. The lack of CSRF protection beyond SameSite=Lax is shared residual risk, not a GLM advantage.

---

### C68 — Direct-service authorization boundaries (same)

#### Reference behavior

Forge does not rely only on dashboard button hiding or web proxy routes. API run-control routes validate a private control token before honoring operator-mode headers; admin-only API surfaces reject public mode; load metrics, finalization/reset/history deletion, mock ERP chaos mutation, and load-orchestrator run control are independently gated at the owning service. Token comparison is a direct string comparison.

**References:**
- `checkout-forge/apps/api/src/routes/demo-runs.ts:281` - internal run-start route requires control access.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:405` - `requireControlAccess` validates token and operator mode.
- `checkout-forge/apps/api/src/http.ts:30` - shared API control-token guard.
- `checkout-forge/apps/api/src/routes/load-metrics.ts:13` - internal load metrics ingestion is token-gated.
- `checkout-forge/apps/mock-erp/src/server.ts:135` - mock ERP chaos mutation is token-gated.
- `checkout-forge/apps/load-orchestrator/src/server.ts:125` - load-orchestrator run start is token-gated.

#### Compared behavior

GLM also enforces direct-service boundaries at each owning service. API internal load ingestion, reset, maintenance, run-history deletion, mock ERP chaos mutation, and load-orchestrator traffic start all validate the service token before mutating. GLM hardens token comparison with `timingSafeEqual`. Its public run-start route intentionally does not reject a missing token outright; instead it treats the request as public, ignores forged admin operator headers unless the token is valid, and then requires a signed visitor identity in the start service.

**References:**
- `checkout-surge-glm/apps/api/src/app/service-token.ts:17` - constant-time service-token comparison.
- `checkout-surge-glm/apps/api/src/app/routes/demo-run-start.ts:29` - admin operator mode honored only with a valid token.
- `checkout-surge-glm/apps/api/src/app/routes/internal-load.ts:43` - load metrics ingestion is token-gated.
- `checkout-surge-glm/apps/api/src/app/routes/admin-reset.ts:37` - reset is token-gated.
- `checkout-surge-glm/apps/mock-erp/src/app/routes/chaos.ts:39` - mock ERP chaos mutation validates service token.
- `checkout-surge-glm/apps/load-orchestrator/src/app/routes/run-control.ts:41` - traffic run start validates service token.

#### Verdict rationale

The protected surfaces have the same defense-in-depth shape in both implementations: services independently reject direct unauthenticated access to dangerous operations, and admin privilege is honored only through token-backed assertions. GLM's constant-time token comparison is a small hardening improvement, but not enough to move the broader boundary verdict above `same`.

---

### C69 — Public visitor identity and budget enforcement (better)

#### Reference behavior

Forge issues a signed public-client cookie in the web proxy and forwards the extracted visitor id to the API as the public budget principal. The API reserves per-visitor and global budget through an atomic Redis Lua script, and it releases the reservation if later validation or start orchestration fails. This is strong when public starts always pass through the service-token-backed proxy, but the API does not independently verify that the forwarded visitor id header is signed.

**References:**
- `checkout-forge/apps/web/src/app/web-access.ts:154` - signed public-client cookie value.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:85` - public starts forward visitor id with control headers.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:302` - public starts require a visitor id header.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:342` - public budget reservation before start.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:370` - budget reservation released on failed start.
- `checkout-forge/apps/api/src/services/public-run-budget-service.ts:30` - Redis Lua budget reservation.

#### Compared behavior

GLM makes visitor identity a shared signed contract. The web tier issues a signed HttpOnly visitor cookie and forwards the signed value as `x-visitor-id`; the API verifies the HMAC before accepting the principal for a public start. Public starts fail closed on missing or invalid visitor identity, then consume a per-visitor/global Redis budget before run creation. GLM is stricter but harsher: denied attempts consume a counter slot, and no release path equivalent to Forge's rollback was found when a post-budget start fails.

**References:**
- `checkout-surge-glm/packages/contracts/src/admin-access.ts:40` - canonical signed visitor id header.
- `checkout-surge-glm/packages/contracts/src/admin-access.ts:91` - visitor id signing helper.
- `checkout-surge-glm/packages/contracts/src/admin-access.ts:128` - visitor id verification helper.
- `checkout-surge-glm/apps/web/app/actions.ts:27` - web action resolves or issues a visitor id.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:290` - API verifies signed visitor id for public principals.
- `checkout-surge-glm/packages/db/src/access/public-run-budget.ts:72` - Redis budget consumption.

#### Verdict rationale

GLM is better on identity spoofing resistance because the API independently verifies a server-issued visitor credential instead of trusting a forwarded string inside the proxy channel. The budget no-release behavior can charge legitimate visitors for infrastructure failures after the budget check, but that is an abuse-control tradeoff rather than a spoofing weakness.

---

### C70 — Runtime policy and hard-cap governance (worse)

#### Reference behavior

Forge implements the full three-layer governance model. Deployment hard caps are parsed and cross-validated at API startup, the public runtime policy is a persisted singleton, admins can update that policy through an admin-only web proxy and API route, and updates are re-validated against hard caps before persistence. Public custom limits cover traffic, stock, ERP latency/TPS/error rate, allowed failure modes, and allowed backpressure strategies.

**References:**
- `checkout-forge/apps/api/src/config.ts:52` - deployment hard-cap environment knobs.
- `checkout-forge/apps/api/src/config.ts:59` - default public budget environment knobs.
- `checkout-forge/apps/api/src/config.ts:62` - default public custom cap environment knobs.
- `checkout-forge/apps/api/src/config.ts:137` - public failure modes and backpressure profiles restricted.
- `checkout-forge/apps/api/src/routes/demo-runs.ts:84` - admin-only runtime-policy update route.
- `checkout-forge/apps/api/src/services/public-runtime-policy-service.ts:58` - runtime-policy update parses and validates before save.
- `checkout-forge/apps/api/src/services/public-runtime-policy-service.ts:82` - persisted policy checked against deployment hard caps.

#### Compared behavior

GLM has a persisted public runtime policy and enforces it for public starts, including public custom limits and run budgets. However, no API or web route for updating the public runtime policy was found, despite seed code preserving edits and comments implying admin-protected controls may update it. GLM also validates run starts against `DEFAULT_DEMO_TRAFFIC_HARD_CAPS` code constants instead of parsing deployment `DEMO_MAX_*` caps into API config and injecting them into the start service. The missing runtime-policy UI is already noted in C62; this topic covers the deeper backend governance gap.

**References:**
- `checkout-surge-glm/packages/contracts/src/demo-control.ts:277` - public runtime policy schema exists.
- `checkout-surge-glm/packages/db/src/run-lifecycle/public-runtime-policy.ts:31` - active public policy is read and schema-validated.
- `checkout-surge-glm/packages/db/src/seed-data.ts:402` - seed preserves existing API-owned public runtime policy.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:301` - public starts load the persisted policy.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:335` - start validation uses the default hard-cap constant.
- `checkout-surge-glm/packages/contracts/src/demo-control.ts:305` - default hard caps are code constants.

#### Verdict rationale

GLM is worse because it enforces a seeded policy but does not provide the admin-editable governance path or deployment-controlled hard-cap layer that the spec requires. Public starts remain bounded, yet the hard-cap >= runtime-policy >= individual-run model is less complete and less deployer-controlled than Forge's.

---

### C71 — Secret defaults and production fail-closed posture (worse)

#### Reference behavior

Forge requires the main security-sensitive secrets at startup. The web access layer rejects missing admin passphrase, admin-session secret, public visitor cookie secret, and control-service token, and the API requires its control-service token. This stricter local setup avoids accidentally running a service with a committed shared token.

**References:**
- `checkout-forge/apps/web/src/app/web-access.ts:51` - admin passphrase required.
- `checkout-forge/apps/web/src/app/web-access.ts:52` - admin session secret required.
- `checkout-forge/apps/web/src/app/web-access.ts:53` - public client cookie secret required.
- `checkout-forge/apps/web/src/app/web-access.ts:55` - control service token required in web tier.
- `checkout-forge/apps/web/src/app/web-access.ts:203` - required-string environment validation.
- `checkout-forge/apps/api/src/config.ts:45` - API control service token required.

#### Compared behavior

GLM improves the web tier by refusing production startup when operator-facing web secrets are absent or still set to sentinel values. The backend services do not match that posture: the API, mock ERP, and load orchestrator default `CONTROL_SERVICE_TOKEN` to a committed sentinel, and the API also defaults `PUBLIC_CLIENT_COOKIE_SECRET`. Since those services enforce the direct-service boundaries from C68, accepting a known default token in a non-local deployment is a meaningful whole-system risk unless external deployment checks catch it.

**References:**
- `checkout-surge-glm/apps/web/lib/config.ts:53` - committed sentinel secret set.
- `checkout-surge-glm/apps/web/lib/config.ts:186` - web-tier production secret validation.
- `checkout-surge-glm/apps/web/instrumentation.ts:18` - validation invoked on Next.js server startup.
- `checkout-surge-glm/apps/api/src/app/config.ts:128` - API defaults control service token to sentinel.
- `checkout-surge-glm/apps/api/src/app/config.ts:130` - API defaults public visitor secret to sentinel.
- `checkout-surge-glm/apps/mock-erp/src/app/config.ts:128` - mock ERP defaults control service token to sentinel.
- `checkout-surge-glm/apps/load-orchestrator/src/app/config.ts:146` - load orchestrator defaults control service token to sentinel.

#### Verdict rationale

GLM is worse at the whole-system secret boundary. Its web-tier validation is good, but backend services also need to fail closed because services must not rely on the dashboard as their protection layer. Forge's required-env approach is safer for the service-token and visitor-signing secrets.

---

### C72 — Admin-only destructive operation protection (same)

#### Reference behavior

Forge keeps reset, run-summary deletion, full run-detail reads, runtime-policy changes, preset mutation, and chaos mutation behind the admin web session plus service-token-backed API/internal routes. Delete-all requires an explicit confirmation literal in the contract and is validated again at the API route.

**References:**
- `checkout-forge/apps/api/src/routes/demo-reset.ts:16` - reset requires service token.
- `checkout-forge/apps/web/src/app/api/control/demo/reset/route.ts:13` - reset proxy requires admin session.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:166` - delete-all route is internal and token-gated.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:180` - delete-all request schema parsed by API.
- `checkout-forge/packages/contracts/src/dashboard.ts:369` - delete-all confirmation literal.
- `checkout-forge/apps/web/src/app/api/control/run-summaries/route.ts:19` - delete-all proxy requires admin session.

#### Compared behavior

GLM gives equivalent protection to reset, maintenance cleanup, targeted run teardown, run-history deletion, preset mutation, and chaos mutation. Web admin proxy routes use the shared admin guard, service-side routes validate the control token, and delete-all requires the shared `DELETE_ALL_RUN_SUMMARIES` confirmation value. GLM also has a targeted maintenance deletion endpoint for runtime smoke cleanup, and it is service-token gated.

**References:**
- `checkout-surge-glm/apps/api/src/app/routes/admin-reset.ts:37` - reset requires service token.
- `checkout-surge-glm/apps/api/src/app/routes/admin-maintenance.ts:44` - cleanup-runs requires service token.
- `checkout-surge-glm/apps/api/src/app/routes/admin-maintenance.ts:61` - targeted run deletion requires service token.
- `checkout-surge-glm/apps/api/src/app/routes/run-history.ts:62` - bulk/delete-all run-history route is token-gated.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:486` - delete-all confirmation literal.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:517` - delete-all confirmation enforced by schema.

#### Verdict rationale

Both implementations meet the destructive-operation requirements. The exact admin UI coverage differs, as discussed in C62, but the server-side protection around destructive operations is equivalent.

---

### C73 — Public-safe read DTO discipline (same)

#### Reference behavior

Forge distinguishes public run-history detail from admin/internal detail. Public detail is built from summary aggregates and sanitized diagnostics; raw reservation tokens, pending idempotency keys, and order event payloads are present only in the full dashboard detail returned from internal token-gated endpoints. Public readers get meaningful detail without the explicitly forbidden operational fields.

**References:**
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:128` - public run-detail read path.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:147` - public diagnostics are mapped through a sanitized subset.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:294` - reservation token appears only in full/internal reservation mapping.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:325` - pending idempotency key appears only in full/internal pending-reservation mapping.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:399` - raw order event payload appears only in full/internal detail.
- `checkout-forge/apps/api/src/routes/dashboard-run-summaries.ts:77` - full by-run detail endpoint is internal and token-gated.

#### Compared behavior

GLM's public read model is narrower. Run history exposes immutable aggregate summaries, and recovery exposes current-run aggregate state. The run-history contract explicitly declares the DTO public-safe and excludes reservation tokens, idempotency keys, raw event payloads, private headers, and unsafe controls. Projection from stored summaries is aggregate-only, so there are fewer sensitive row-level fields to strip.

**References:**
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:438` - public-safe run summary DTO discipline documented in the contract.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:444` - public run summary detail is the aggregate summary schema.
- `checkout-surge-glm/packages/contracts/src/run-summary.ts:470` - public run-history response returns aggregate summaries.
- `checkout-surge-glm/packages/db/src/run-lifecycle/run-finalization.ts:415` - stored summary projected into aggregate DTO.
- `checkout-surge-glm/packages/contracts/src/dashboard-recovery.ts:137` - recovery response is aggregate current-run state.
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:105` - recovery service populates aggregate business and traffic state.

#### Verdict rationale

Security-wise this is equivalent. Forge exposes richer public details but sanitizes them; GLM exposes less detail and therefore has a smaller public data surface. Based on the inspected reports, neither leaks reservation tokens, idempotency keys, raw event payloads, or internal control details through public reads.

---

### C74 — Reference runtime service topology (same)

#### Reference behavior

Forge's reference runtime is an honest multi-service compose topology: PostgreSQL, Redis, API, worker, mock ERP, load orchestrator, web, and Caddy proxy all run as separate services. Application containers use compose DNS for internal service-to-service URLs, direct service ports remain debug surfaces, and the load orchestrator owns the k6 binary inside its image rather than requiring k6 on the host.

**References:**
- `checkout-forge/docker-compose.yml:17` - compose defines separate infrastructure, app, load, web, proxy, and setup services.
- `checkout-forge/docker-compose.yml:46` - API runs as its own service.
- `checkout-forge/docker-compose.yml:68` - worker runs as its own service.
- `checkout-forge/docker-compose.yml:106` - load orchestrator uses its own Dockerfile and service.
- `checkout-forge/docker-compose.yml:160` - Caddy proxy is separate from web/API.
- `checkout-forge/apps/load-orchestrator/Dockerfile:1` - k6 is copied from a pinned Grafana k6 image.

#### Compared behavior

GLM preserves the same runtime split. PostgreSQL, Redis, mock ERP, API, worker, load orchestrator, web, and Caddy are separate compose services; internal URLs point at compose DNS names; direct ports remain diagnostic; and k6 remains packaged inside the load-orchestrator image.

**References:**
- `checkout-surge-glm/docker-compose.yml:20` - compose starts with separate PostgreSQL and Redis services.
- `checkout-surge-glm/docker-compose.yml:52` - mock ERP is a separate service.
- `checkout-surge-glm/docker-compose.yml:72` - API is a separate service.
- `checkout-surge-glm/docker-compose.yml:102` - worker is a separate service.
- `checkout-surge-glm/docker-compose.yml:132` - load orchestrator is a separate service with its own Dockerfile.
- `checkout-surge-glm/docker-compose.yml:189` - Caddy is a separate single-origin proxy service.

#### Verdict rationale

The topology proof is equivalent. GLM does not collapse the worker into the API, embed ERP in-process, or move k6 back to the host. C50 separately grades the load-orchestrator/k6 service boundary in more detail; this topic grades the whole compose topology.

---

### C75 — Single-origin reverse proxy and SSE routing (better)

#### Reference behavior

Forge uses Caddy on port `8080` as the single browser-facing origin. The proxy routes `/dashboard/events*` to the API for SSE and everything else to the web service, with a host-native Caddyfile preserving the same split. The proxy config is otherwise minimal and does not explicitly tune buffering or flush behavior for long-lived event streams.

**References:**
- `checkout-forge/infra/caddy/Caddyfile:1` - Caddy listens on the dashboard proxy origin.
- `checkout-forge/infra/caddy/Caddyfile:2` - `/dashboard/events*` matcher identifies the SSE route.
- `checkout-forge/infra/caddy/Caddyfile:4` - SSE route proxies to the API.
- `checkout-forge/infra/caddy/Caddyfile:7` - all other routes proxy to web.
- `checkout-forge/infra/caddy/Caddyfile.host-native:2` - host-native proxy preserves the route split.

#### Compared behavior

GLM keeps the same browser-origin split and adds proxy settings that are materially better for SSE. It disables the Caddy admin endpoint and sets immediate flushing for `/dashboard/events`; the host-native Caddyfile mirrors the same SSE matcher and flush behavior.

**References:**
- `checkout-surge-glm/infra/caddy/Caddyfile:8` - Caddy admin endpoint is disabled.
- `checkout-surge-glm/infra/caddy/Caddyfile:12` - Caddy listens on port `8080`.
- `checkout-surge-glm/infra/caddy/Caddyfile:16` - `/dashboard/events` is the SSE matcher.
- `checkout-surge-glm/infra/caddy/Caddyfile:17` - SSE route proxies to API.
- `checkout-surge-glm/infra/caddy/Caddyfile:18` - SSE route sets immediate flushing.
- `checkout-surge-glm/infra/caddy/Caddyfile.host-native:14` - host-native proxy uses the same SSE flush behavior.

#### Verdict rationale

GLM is better at the reverse-proxy layer because it preserves the required single-origin route split while explicitly avoiding proxy buffering for realtime frames. The matcher is narrower than Forge's wildcard route, but the product stream uses the exact `/dashboard/events` path, so the flush behavior is the more important operational difference. API-side SSE mechanics remain covered separately in C46.

---

### C76 — Container image construction (better)

#### Reference behavior

Forge has a DB-only `runtime-setup` target and a general `app` target. The app image installs and builds the full monorepo, then individual services start with filtered `pnpm` commands inside that shared workspace image. This works for the reference runtime, but it ships a large runtime image, keeps package-manager tooling in the final app container, and does not produce per-service production bundles. The load-orchestrator image is more scoped because it bakes in k6 separately.

**References:**
- `checkout-forge/Dockerfile.runtime:1` - DB-only setup target exists.
- `checkout-forge/Dockerfile.runtime:19` - shared app image target handles application services.
- `checkout-forge/Dockerfile.runtime:39` - app image installs the full workspace.
- `checkout-forge/Dockerfile.runtime:41` - app image copies all apps and packages.
- `checkout-forge/Dockerfile.runtime:48` - app image builds the full monorepo.
- `checkout-forge/docker-compose.yml:47` - API uses the shared runtime Dockerfile.

#### Compared behavior

GLM uses a more production-shaped image strategy. API, worker, and mock ERP share a parameterized Node-service Dockerfile that primes the pnpm store, builds only the target service's dependency closure, deploys production dependencies, and runs as a non-root user from a minimal `/app` tree. The web image uses Next standalone output, setup has a DB-only image, and load-orchestrator remains a separate k6-owning image.

**References:**
- `checkout-surge-glm/docker/Dockerfile.node-service:35` - Docker layer primes dependencies from lockfile/manifests.
- `checkout-surge-glm/docker/Dockerfile.node-service:44` - installs offline and builds only the selected service closure.
- `checkout-surge-glm/docker/Dockerfile.node-service:51` - creates a production-only deployed bundle.
- `checkout-surge-glm/docker/Dockerfile.node-service:62` - final runtime runs as a non-root user.
- `checkout-surge-glm/apps/web/Dockerfile:2` - web image uses Next standalone output.
- `checkout-surge-glm/packages/db/Dockerfile:2` - setup image is scoped to migration and seeding.

#### Verdict rationale

GLM is better. The reference already packages k6 correctly and has a setup target, but GLM's application images are smaller, more cache-friendly, less coupled to unrelated workspace builds, and closer to real production runtime expectations.

---

### C77 — Explicit setup/startup lifecycle (same)

#### Reference behavior

Forge separates container startup from data mutation. `runtime:up` builds and starts the full topology, while `runtime:setup` is a deliberate one-shot migration/seed command. An infra-only mode starts just PostgreSQL and Redis, and Dev Container startup checks Docker readiness without auto-starting the full runtime.

**References:**
- `checkout-forge/package.json:7` - `infra:up` starts only PostgreSQL and Redis.
- `checkout-forge/package.json:9` - `runtime:up` starts the full compose topology.
- `checkout-forge/package.json:12` - `runtime:setup` is a separate setup command.
- `checkout-forge/docker-compose.yml:177` - setup runs as a profiled one-shot service.
- `checkout-forge/.devcontainer/devcontainer.json:5` - Dev Container only starts the workspace service.
- `checkout-forge/.devcontainer/post-start.sh:18` - post-start tells the developer to start infra or runtime explicitly.

#### Compared behavior

GLM preserves the same lifecycle split. `runtime:up` builds and starts the full topology with compose `--wait`; `runtime:setup` runs a profile-gated setup service; `infra:up` starts only PostgreSQL and Redis. Dev Container startup also starts only the workspace and prints an explicit-start message after Docker becomes ready.

**References:**
- `checkout-surge-glm/package.json:29` - `infra:up` starts only PostgreSQL and Redis.
- `checkout-surge-glm/package.json:31` - `runtime:up` builds and starts the full topology with `--wait`.
- `checkout-surge-glm/package.json:33` - `runtime:setup` explicitly runs the setup profile.
- `checkout-surge-glm/docker-compose.yml:210` - setup service is profile-gated.
- `checkout-surge-glm/.devcontainer/devcontainer.json:5` - Dev Container only starts the workspace service.
- `checkout-surge-glm/.devcontainer/post-start.sh:20` - post-start instructs explicit project infrastructure startup.

#### Verdict rationale

The behavior is equivalent. GLM's use of compose `--wait` and a dedicated DB package image are useful refinements, but both implementations keep startup non-mutating, setup deliberate, infra-only mode available, and Dev Container startup restrained.

---

### C78 — Container environment and config propagation (worse)

#### Reference behavior

Forge's root `.env.example` documents major runtime knobs, and compose passes several critical runtime values into containers: service URLs, `WEB_ORIGIN`, API listen backlog, and separate API/worker PostgreSQL pool sizes. Service-specific env templates also document API hard caps and public custom caps, so the reference container path can receive the tuning values emphasized by the specs.

**References:**
- `checkout-forge/.env.example:6` - API listen backlog is documented at the root.
- `checkout-forge/.env.example:9` - separate API/worker pool sizing is documented.
- `checkout-forge/.env.example:14` - deployment hard caps are documented in root env defaults.
- `checkout-forge/docker-compose.yml:15` - compose passes `API_LISTEN_BACKLOG` into services.
- `checkout-forge/docker-compose.yml:53` - compose passes `API_POSTGRES_POOL_MAX` to API.
- `checkout-forge/docker-compose.yml:74` - compose passes `WORKER_POSTGRES_POOL_MAX` to worker.

#### Compared behavior

GLM documents a broader environment taxonomy and adds useful production secret validation in the web process, but its compose runtime omits many important tunables from application service `environment` blocks. API listen backlog, API/worker pool sizes, run caps, public budget caps, dashboard heartbeat, and worker concurrency/retry knobs are documented or parsed by code, yet changing them in the root `.env` will not affect the reference containers unless they are explicitly injected into compose.

**References:**
- `checkout-surge-glm/docker-compose.yml:16` - shared compose env only includes control token and log level.
- `checkout-surge-glm/docker-compose.yml:79` - API env omits backlog, API pool, and demo cap variables.
- `checkout-surge-glm/docker-compose.yml:109` - worker env omits worker pool and behavior tunables.
- `checkout-surge-glm/apps/api/.env.example:14` - API backlog and pool knobs are documented in the app env template.
- `checkout-surge-glm/apps/worker/.env.example:12` - worker pool/concurrency knobs are documented in the app env template.
- `checkout-surge-glm/apps/api/src/app/config.ts:118` - API supports `API_LISTEN_BACKLOG` but falls back when compose does not pass it.

#### Verdict rationale

GLM is worse for the containerized reference runtime. Its parsers and env templates know about the knobs, but compose is the operational contract for the reference path and does not propagate a large part of that contract. C28 remains `same` for the in-process API defaults; this topic grades whether container operators can actually drive those settings through the documented runtime surface.

---

### C79 — Runtime health and non-mutating smoke checks (same)

#### Reference behavior

Forge has a health command that polls API, worker, mock ERP, load orchestrator, and dashboard reachability. Its non-mutating runtime smoke check verifies all compose services, direct readiness endpoints, dashboard recovery through the proxy, the SSE stream through the proxy, and k6 execution inside the load-orchestrator container.

**References:**
- `checkout-forge/scripts/health-check.mjs:1` - health command targets API, worker, mock ERP, load orchestrator, and web.
- `checkout-forge/scripts/health-check.mjs:46` - all services must report `ok`.
- `checkout-forge/scripts/runtime-smoke-check.mjs:14` - smoke check expects all runtime compose services.
- `checkout-forge/scripts/runtime-smoke-check.mjs:55` - smoke sequence checks compose, HTTP readiness, proxy, SSE, and k6.
- `checkout-forge/scripts/runtime-smoke-check.mjs:136` - dashboard recovery is read through the proxy.
- `checkout-forge/scripts/runtime-smoke-check.mjs:176` - k6 is executed inside the load-orchestrator container.

#### Compared behavior

GLM has the same two-tier shape. `health:check` polls the application readiness endpoints and dashboard origin. `runtime:smoke` verifies the expected eight-service topology, direct readiness, dashboard HTML through the proxy, `/dashboard/events` SSE through Caddy, k6 execution inside the load-orchestrator container, and the merged Dev Container compose config. Its main weakness is that HTTP probes treat any 2xx readiness response as passing, even if the JSON body reports a degraded state.

**References:**
- `checkout-surge-glm/scripts/health-check.mjs:23` - health command targets API, worker, mock ERP, load orchestrator, and dashboard.
- `checkout-surge-glm/scripts/health-check.mjs:39` - health probe treats `response.ok` as success.
- `checkout-surge-glm/scripts/runtime-smoke.mjs:26` - smoke check expects the full eight-service topology.
- `checkout-surge-glm/scripts/runtime-smoke.mjs:191` - smoke check executes configured k6 inside the load-orchestrator container.
- `checkout-surge-glm/scripts/runtime-smoke.mjs:219` - smoke check validates merged Dev Container compose config.
- `checkout-surge-glm/scripts/runtime-smoke.mjs:266` - smoke sequence covers topology, readiness, proxy, SSE, k6, and Dev Container config.

#### Verdict rationale

This is `same` because both implementations prove the important non-mutating runtime surfaces. GLM adds a useful static Dev Container config check, while Forge is stricter about readiness body status. Those differences balance out for the broader health/smoke surface. C48 grades the application read-model readiness projections rather than these operational scripts.

---

### C80 — Mutating dashboard load smoke (better)

#### Reference behavior

Forge can run a mutating dashboard-path load smoke through the runtime smoke script. It logs in through the dashboard admin route, starts a tiny admin run through the dashboard control route, waits for completion via dashboard recovery, verifies that k6 traffic metrics were observed, and then cleans up. The proof is useful, but cleanup shells directly into PostgreSQL and Redis from local scripts, as noted in C37.

**References:**
- `checkout-forge/package.json:15` - load smoke is an option on the runtime smoke script.
- `checkout-forge/scripts/runtime-smoke-check.mjs:192` - dashboard-triggered smoke run workflow starts.
- `checkout-forge/scripts/runtime-smoke-check.mjs:201` - script logs in through the dashboard admin session route.
- `checkout-forge/scripts/runtime-smoke-check.mjs:224` - script starts a run through the dashboard control route.
- `checkout-forge/scripts/runtime-smoke-check.mjs:292` - script verifies k6 traffic metrics reached recovery state.
- `checkout-forge/scripts/runtime-smoke-cleanup.mjs:94` - cleanup deletes run data directly through PostgreSQL.

#### Compared behavior

GLM splits the mutating load smoke into its own command and makes it more representative of the operator path. It resets through API/ERP control endpoints, logs in through the single-origin dashboard proxy, starts a small admin steady-arrival run through the dashboard route, waits for finalization, verifies the finalized artifact through run history including delivered traffic and confirmed orders, and deletes only the smoke run through an API maintenance endpoint.

**References:**
- `checkout-surge-glm/package.json:36` - mutating load smoke has its own root command.
- `checkout-surge-glm/scripts/runtime-smoke-load.mjs:6` - script declares the operator-path proof and targeted cleanup intent.
- `checkout-surge-glm/scripts/runtime-smoke-load.mjs:12` - admin login goes through the single-origin dashboard proxy.
- `checkout-surge-glm/scripts/runtime-smoke-load.mjs:13` - run start goes through the dashboard proxy route.
- `checkout-surge-glm/scripts/runtime-smoke-load.mjs:16` - script verifies the finalized artifact in run history.
- `checkout-surge-glm/scripts/runtime-smoke-load.mjs:267` - cleanup calls the API targeted run deletion endpoint.

#### Verdict rationale

GLM is better. Forge's mutating smoke proves the dashboard-start path, but GLM verifies a fuller business outcome and routes cleanup through the protected application maintenance surface. That makes the smoke closer to the actual operating model and less coupled to database schema details.

---

### C81 — Dev Container dependency-volume isolation (worse)

#### Reference behavior

Forge layers `.devcontainer/docker-compose.yml` over the root compose file and starts only the workspace service. It mounts named volumes for the pnpm store, root `node_modules`, each app's `node_modules`, and shared package `node_modules`, keeping Linux container installs out of the host-visible workspace.

**References:**
- `checkout-forge/.devcontainer/devcontainer.json:3` - Dev Container layers root compose plus override.
- `checkout-forge/.devcontainer/devcontainer.json:5` - only workspace starts on open.
- `checkout-forge/.devcontainer/docker-compose.yml:12` - pnpm store is a named volume.
- `checkout-forge/.devcontainer/docker-compose.yml:13` - root `node_modules` is a named volume.
- `checkout-forge/.devcontainer/docker-compose.yml:14` - web app `node_modules` is a named volume.
- `checkout-forge/.devcontainer/docker-compose.yml:15` - app and package `node_modules` volume coverage continues.

#### Compared behavior

GLM keeps the layered Dev Container shape and starts only the workspace. It adds useful worktree repair support and named config volumes, but only mounts a named volume for the root `node_modules` path. App and package `node_modules` directories are not separately volume-mounted, so installs inside the Dev Container can still create Linux-specific workspace-level dependency directories on the host-visible bind mount.

**References:**
- `checkout-surge-glm/.devcontainer/devcontainer.json:3` - Dev Container layers root compose plus override.
- `checkout-surge-glm/.devcontainer/devcontainer.json:5` - only workspace starts on open.
- `checkout-surge-glm/.devcontainer/docker-compose.yml:24` - workspace is bind-mounted into the container.
- `checkout-surge-glm/.devcontainer/docker-compose.yml:32` - pnpm store is a named volume.
- `checkout-surge-glm/.devcontainer/docker-compose.yml:33` - only root `node_modules` is explicitly volume-mounted.
- `checkout-surge-glm/.devcontainer/post-start.sh:7` - worktree repair is an added Dev Container convenience.

#### Verdict rationale

GLM is worse on dependency isolation. It preserves the high-level Dev Container lifecycle, but loses the baseline's per-workspace `node_modules` volume coverage. In a pnpm monorepo, especially on Windows hosts, that is a practical source of host/container friction.

---

### C82 — Test infrastructure isolation and guardrails (better)

#### Reference behavior

Forge has a separate `docker-compose.test.yml` with its own compose project name, PostgreSQL/Redis services, host ports, and volumes. Its reset script is pinned to the test compose file and explicitly resets only the test database state and dedicated test Redis instance. The test environment wrapper also derives per-package database names and Redis logical DBs, which lets package suites run concurrently without sharing one mutable database or Redis DB.

**References:**
- `checkout-forge/docker-compose.test.yml:1` - test infrastructure has its own compose project name.
- `checkout-forge/docker-compose.test.yml:9` - dedicated `checkout_forge_test` database.
- `checkout-forge/docker-compose.test.yml:11` - PostgreSQL test service binds host port `56432`.
- `checkout-forge/docker-compose.test.yml:23` - Redis test service binds host port `6380`.
- `checkout-forge/scripts/test-infra-reset.mjs:6` - reset script is pinned to `docker-compose.test.yml`.
- `checkout-forge/scripts/run-with-test-env.mjs:45` - package-scoped URL rewriting for isolation.

#### Compared behavior

GLM also has a separate test compose file with its own project name, non-development ports, and separate volumes. Its reset script starts the test services if needed, drops all `checkout_surge_test*` databases, recreates the base test database, and flushes only the dedicated test Redis instance. The testing-system comparison adds an important safety difference: GLM's test environment wrapper defaults missing URLs to the isolated test services and explicitly refuses obvious development PostgreSQL/Redis ports, while still deriving per-package databases and Redis DB indexes.

**References:**
- `checkout-surge-glm/docker-compose.test.yml:6` - test infrastructure has its own compose project name.
- `checkout-surge-glm/docker-compose.test.yml:14` - dedicated `checkout_surge_test` database.
- `checkout-surge-glm/docker-compose.test.yml:29` - Redis test service binds host port `6380`.
- `checkout-surge-glm/scripts/run-with-test-env.mjs:8` - defaults test URLs to isolated services.
- `checkout-surge-glm/scripts/run-with-test-env.mjs:87` - refuses PostgreSQL URLs pointed at development port `5432`.
- `checkout-surge-glm/scripts/run-with-test-env.mjs:93` - refuses Redis URLs pointed at development port `6379`.

#### Verdict rationale

Both implementations isolate test PostgreSQL and Redis from development/demo state and both avoid broad Redis `FLUSHALL`-style resets. GLM is better once the test-environment wrapper is included because it actively fails closed on the most dangerous misconfiguration: accidentally pointing destructive integration tests at normal local development ports. Forge has the essential isolation mechanics, but fewer guardrails around miswired test URLs.

---

### C83 — Root test taxonomy and command contract (worse)

#### Reference behavior

Forge exposes the required root test lanes through Turbo and mirrors the same `test`, `test:unit`, `test:integration`, and `test:api` scripts in each package/app. This gives the taxonomy an enforceable package-level contract: Turbo can run each tier across the workspace, packages with no tests can pass intentionally, and adding a new package follows the same convention. The separate API config also gives API/service-boundary tests their own file suffix and root command.

**References:**
- `checkout-forge/package.json:31` - root `pnpm test` delegates to Turbo across workspace packages.
- `checkout-forge/package.json:32` - root unit lane is a stable Turbo task.
- `checkout-forge/package.json:33` - root integration lane is a stable Turbo task.
- `checkout-forge/package.json:34` - root API/service-boundary lane is a stable Turbo task.
- `checkout-forge/apps/api/package.json:21` - package-level scripts mirror the root taxonomy.
- `checkout-forge/vitest.api.config.ts:5` - API/service tests use a distinct `*.api.test.ts` include pattern.

#### Compared behavior

GLM provides the expected root command names, but the contract is more hand-wired. The root `test` command manually chains infra startup, unit tests, API tests, worker tests, and DB integration tests. Most packages only define build/type-check scripts, not package-level `test:*` scripts, so the test taxonomy is concentrated in the root rather than enforced consistently through every workspace package. The API and worker lanes also run through the integration Vitest config rather than a distinct API/service-boundary config.

**References:**
- `checkout-surge-glm/package.json:19` - root `test` is a manually sequenced shell chain.
- `checkout-surge-glm/package.json:20` - root unit lane runs root Vitest plus a separate web unit command.
- `checkout-surge-glm/package.json:40` - DB integration lane is explicitly filtered to the DB package.
- `checkout-surge-glm/package.json:41` - API lane uses `vitest.integration.config.ts`.
- `checkout-surge-glm/package.json:42` - worker lane is an extra root-only tier, also using the integration config.
- `checkout-surge-glm/apps/api/package.json:6` - app package scripts do not expose the mirrored `test:*` taxonomy.

#### Verdict rationale

GLM has usable root commands, but the taxonomy is less uniform and less scalable. Forge's package-level script contract means Turbo can discover and run the same lanes everywhere; GLM's root script needs to know each package/tier explicitly, which creates drift risk when new packages or test categories appear. The absence of a dedicated API Vitest lane also blurs the mandated API/service-boundary tier into integration testing.

---

### C84 — Reset determinism and schema self-healing (worse)

#### Reference behavior

Forge's DB test reset path is deliberately robust. It acquires a per-database lock, ensures the derived test database exists, checks whether applied migrations and a stored schema fingerprint match the current schema, truncates only when safe, and rebuilds from migrations when drift is detected. The fingerprint includes tables, columns, constraints, indexes, triggers, and functions, so tests that damage schema state can be repaired by the next reset.

**References:**
- `checkout-forge/packages/db/src/testing.ts:27` - per-database test infrastructure lock.
- `checkout-forge/packages/db/src/testing.ts:93` - `resetTestDatabase` entry point.
- `checkout-forge/packages/db/src/testing.ts:102` - reset chooses truncate only when migrations and fingerprint match.
- `checkout-forge/packages/db/src/testing.ts:108` - reset falls back to full migration rebuild.
- `checkout-forge/packages/db/src/testing.ts:244` - schema fingerprint validation.
- `checkout-forge/packages/db/src/testing.ts:275` - fingerprint covers schema objects beyond tables.

#### Compared behavior

GLM also has a per-database lock, database creation, migration in setup helpers, table truncation, and Redis `FLUSHDB`. However, its own reset helper documents that the fingerprint-vs-rebuild optimization is deferred, and `resetTestDatabase` always truncates an explicit table list. If a test or failed migration leaves the schema structurally damaged, the common reset path is less able to self-heal.

**References:**
- `checkout-surge-glm/packages/db/src/reset.ts:12` - per-database lock is exposed.
- `checkout-surge-glm/packages/db/src/reset.ts:14` - reset is truncate-based and notes deferred fingerprint rebuild.
- `checkout-surge-glm/packages/db/src/reset.ts:62` - lock acquisition implementation.
- `checkout-surge-glm/packages/db/src/reset.ts:108` - `resetTestDatabase` truncates the explicit table list.
- `checkout-surge-glm/packages/db/src/reset.ts:117` - Redis reset uses `FLUSHDB`.
- `checkout-surge-glm/packages/db/tests/helpers.ts:68` - integration setup migrates, truncates, and flushes Redis.

#### Verdict rationale

GLM is deterministic for ordinary fixture cleanup, but it is weaker than the baseline against schema drift or damage. The explicit deferred fingerprint work is exactly the baseline's self-healing mechanism, so this is a real regression in the engineering quality system even if most tests pass in normal runs.

---

### C85 — Service-boundary testability and dependency injection (same)

#### Reference behavior

Forge keeps service startup testable by exposing server factories and keeping process startup in separate entrypoints. API, load-orchestrator, and mock ERP tests can use Fastify injection and injected dependencies rather than relying on module-level infrastructure clients.

**References:**
- `checkout-forge/apps/api/src/server.ts:85` - `buildApiServer` accepts explicit server dependencies.
- `checkout-forge/apps/api/src/index.ts:213` - production startup composes dependencies before building the server.
- `checkout-forge/apps/load-orchestrator/src/server.ts:54` - load-orchestrator server factory.
- `checkout-forge/apps/mock-erp/src/server.ts:32` - mock ERP server factory.
- `checkout-forge/apps/mock-erp/test/mock-erp-service.test.ts:24` - tests exercise routes through `server.inject`.

#### Compared behavior

GLM follows the same testability rule. Server factories live under app build modules, dependencies are composed in startup entrypoints, and route/service tests instantiate servers or services with explicit dependencies. The service layer is highly factory-oriented, which keeps integration tests able to use isolated DB/Redis/queue/logger handles.

**References:**
- `checkout-surge-glm/apps/api/src/app/build-server.ts:35` - API server factory receives explicit dependencies.
- `checkout-surge-glm/apps/api/src/index.ts:79` - production startup builds the API from composed dependencies.
- `checkout-surge-glm/apps/load-orchestrator/src/app/build-server.ts:23` - load-orchestrator server factory.
- `checkout-surge-glm/apps/mock-erp/src/app/build-server.ts:24` - mock ERP server factory.
- `checkout-surge-glm/apps/api/src/app/services/reserve-order-service.ts:287` - buy-path service is dependency-injected.
- `checkout-surge-glm/apps/api/tests/queue-health.integration.test.ts:89` - tests build the API server with injected queue dependencies.

#### Verdict rationale

This is equivalent. GLM has more fine-grained factories, but the baseline already satisfies the important quality-system rule: services are constructible with test dependencies and can be closed cleanly. GLM's extra decomposition helps coverage but does not clearly change the systemic grade.

---

### C86 — Access-control and public-governance test coverage (same)

#### Reference behavior

Forge covers the layered access model in both web proxy tests and service/API tests. The web control routes reject anonymous admin actions before forwarding, assert admin-derived privilege for authenticated starts, preserve public budget rejections from the API, and require admin sessions for destructive history actions. API/Redis tests cover public budget windows, release, and global/per-visitor exhaustion. Mock ERP tests cover internal chaos controls rejecting anonymous mutations and cap violations.

**References:**
- `checkout-forge/apps/web/src/app/control-routes.test.ts:49` - anonymous reset rejected before protected upstream call.
- `checkout-forge/apps/web/src/app/control-routes.test.ts:235` - admin principal is derived from session rather than request body.
- `checkout-forge/apps/web/src/app/control-routes.test.ts:433` - public run budget rejections are surfaced.
- `checkout-forge/apps/web/src/app/control-routes.test.ts:523` - run-history deletion requires admin session.
- `checkout-forge/apps/api/test/public-run-budget-service.integration.test.ts:35` - Redis-backed public budget reserve/release/window coverage.
- `checkout-forge/apps/mock-erp/test/mock-erp-service.test.ts:415` - anonymous chaos mutations rejected.

#### Compared behavior

GLM has comparable access and governance coverage. Web tests cover constant-time passphrase checks, signed admin and visitor cookies, service-token/operator-mode header construction, anonymous admin route rejection, and admin starts that do not forward a public visitor identity. API tests cover missing service tokens on admin/deletion surfaces, preset-management authorization, public budget integration, and delete-all confirmation. Production secret validation is also tested.

**References:**
- `checkout-surge-glm/apps/web/tests/admin-access.test.ts:64` - passphrase comparison and verification tests.
- `checkout-surge-glm/apps/web/tests/admin-access.test.ts:80` - signed admin session cookie round-trip/expiry/tamper coverage.
- `checkout-surge-glm/apps/web/tests/admin-access.test.ts:127` - signed visitor identity cookie coverage.
- `checkout-surge-glm/apps/web/tests/admin-routes.test.ts:68` - anonymous admin reset rejected at web boundary.
- `checkout-surge-glm/apps/api/tests/run-history-delete.integration.test.ts:124` - deletion route rejects missing service token.
- `checkout-surge-glm/packages/db/tests/public-run-budget.integration.test.ts:21` - Redis-backed public-run-budget integration suite.

#### Verdict rationale

This is equivalent at the system level. GLM's web security unit tests are especially explicit about cookie signing and proxy headers; Forge's proxy route suite is broader around the actual dashboard control surface. Both provide defense-in-depth test coverage for the expected public/admin surfaces.

---

### C87 — Repo-wide type, lint, and test type-check gates (worse)

#### Reference behavior

Forge uses strict TypeScript, a single Biome config, root lint/type-check scripts, and package-level `type-check:test` scripts. Test compilation is therefore part of the workspace task graph rather than an implied side effect of running Vitest. The Biome config also has explicit test-file overrides for pragmatic testing patterns.

**References:**
- `checkout-forge/tsconfig.json:6` - strict TypeScript enabled.
- `checkout-forge/biome.json:19` - recommended Biome lint preset.
- `checkout-forge/biome.json:44` - test-specific lint overrides.
- `checkout-forge/package.json:29` - root production type-check command.
- `checkout-forge/package.json:30` - root test type-check command.
- `checkout-forge/apps/api/package.json:20` - package-level `type-check:test` script.

#### Compared behavior

GLM has a stricter root TypeScript configuration in several respects and a single Biome config. However, the workspace packages generally expose only `type-check`, not `type-check:test`, even though the root still defines `type-check:test` as a Turbo task. That means the root test type-check gate is weak or effectively empty for most packages unless Turbo finds package scripts not visible in `package.json`.

**References:**
- `checkout-surge-glm/tsconfig.json:9` - strict TypeScript enabled.
- `checkout-surge-glm/tsconfig.json:10` - `noUncheckedIndexedAccess` enabled.
- `checkout-surge-glm/tsconfig.json:11` - `noImplicitOverride` enabled.
- `checkout-surge-glm/biome.json:49` - recommended Biome lint preset.
- `checkout-surge-glm/package.json:14` - root `type-check:test` delegates to Turbo.
- `checkout-surge-glm/apps/api/package.json:6` - package scripts omit `type-check:test`.

#### Verdict rationale

Normal production code type-checking is at least as strict in GLM, but the quality system also includes tests. Forge explicitly type-checks tests per package; GLM declares a root test type-check command without the package-level scripts needed to make that command uniformly meaningful. That makes the compared quality gate worse despite the stronger compiler flags.

---

### C88 — README status and setup-command accuracy (better)

#### Reference behavior

Forge's README is broadly accurate about the shipped runtime commands and feature set, but it still opens with a generic work-in-progress banner. Its Quick Start commands line up with root package scripts for the containerized runtime, setup, smoke checks, load smoke check, and cleanup. The result is usable, but the top-level status does not distinguish completed local-demo functionality from explicitly future hosted/Go work.

**References:**
- `checkout-forge/README.md:3` - README still labels the project as work in progress.
- `checkout-forge/README.md:76` - Quick Start begins the documented local workflow.
- `checkout-forge/package.json:9` - `runtime:up` command exists.
- `checkout-forge/package.json:12` - `runtime:setup` command exists.
- `checkout-forge/package.json:14` - `runtime:smoke` command exists.
- `checkout-forge/package.json:16` - cleanup command exists.

#### Compared behavior

GLM's README gives a more specific status statement: the core system and containerized reference runtime are implemented and demoable locally, while hosted deployment readiness and the optional Go track remain future work. Its Quick Start commands also map directly to root scripts. The runtime command names differ slightly from Forge's, but the documentation tracks GLM's actual command names correctly.

**References:**
- `checkout-surge-glm/README.md:3` - top-level status distinguishes implemented local runtime from remaining phases.
- `checkout-surge-glm/README.md:78` - Quick Start begins the documented local workflow.
- `checkout-surge-glm/package.json:31` - `runtime:up` command exists.
- `checkout-surge-glm/package.json:33` - `runtime:setup` command exists.
- `checkout-surge-glm/package.json:35` - `runtime:smoke` command exists.
- `checkout-surge-glm/package.json:38` - cleanup command exists.

#### Verdict rationale

GLM is better on README usability because its public status is more operationally precise and the promoted commands have matching scripts. This does not mean every completion claim is accurate; C89 captures the separate roadmap inconsistency.

---

### C89 — Roadmap status consistency (worse)

#### Reference behavior

Forge's roadmap is internally consistent at the phase level: Phase 8, including portfolio-facing technical documentation, is checked complete, while Phase 11 and Phase 12 remain open. Its milestone summary matches that story by treating the local portfolio-ready state as reached before hosted deployment and Go comparison work.

**References:**
- `checkout-forge/working_docs/project_planning.md:482` - Phase 8 marked complete.
- `checkout-forge/working_docs/project_planning.md:524` - Task 8.5 portfolio documentation marked complete.
- `checkout-forge/working_docs/project_planning.md:694` - Phase 11 remains open.
- `checkout-forge/working_docs/project_planning.md:748` - Phase 12 remains open.
- `checkout-forge/working_docs/project_planning.md:837` - milestone D describes the portfolio-ready local runtime.

#### Compared behavior

GLM has a clear roadmap contradiction. The README says only Phase 11 and Phase 12 remain, but the roadmap says Task 8.5 is still the only remaining Phase 8 item, the Phase 8 section is still unchecked, and the milestone summary still claims that completing Phases 8 and 9 yields portfolio readiness. The long execution map does acknowledge Task 8.5 as open, but that truth did not make it back to the public status line.

**References:**
- `checkout-surge-glm/README.md:3` - README claims only Phase 11 and Phase 12 remain.
- `checkout-surge-glm/working_docs/project_planning.md:436` - roadmap says Task 8.5 remains, along with Phase 11 and Phase 12.
- `checkout-surge-glm/working_docs/project_planning.md:686` - Phase 8 remains unchecked.
- `checkout-surge-glm/working_docs/project_planning.md:754` - Task 8.5 remains unchecked.
- `checkout-surge-glm/working_docs/project_planning.md:1081` - milestone D still defines Phase 8 plus Phase 9 as portfolio-ready.

#### Verdict rationale

GLM is worse because it has two competing status narratives. The implementation roadmap is honest in the detailed map, but the README omits an open portfolio-documentation task and therefore overstates remaining work as only Phase 11/12.

---

### C90 — Design-document adaptation to implementation (worse)

#### Reference behavior

Forge's design docs generally read as living documentation for an implemented system. The architecture page describes implemented decisions, domain and frontend notes use current/implemented language where the code exists, and explicit deferred production extensions are documented as deferred rather than implied as shipped.

**References:**
- `checkout-forge/docs/architecture.md:5` - architecture doc describes implemented decisions, not only a target.
- `checkout-forge/docs/core_business_entities.md:608` - domain relationships are labeled implemented.
- `checkout-forge/docs/load_generation_metrics_streaming.md:3` - load-generation doc describes the current demo flow.
- `checkout-forge/docs/admin_access_protection.md:147` - frontend route note is labeled current.
- `checkout-forge/docs/local_development.md:37` - browser network model matches the reference web proxy routes.

#### Compared behavior

GLM's docs are partially adapted, especially in runtime/local-development sections, but several important docs still retain seeded target-spec language. Architecture says the implementation "must realize" the target architecture; repository layout says it is the target structure; load-generation docs define target behavior and still mention `/api/dashboard/recovery`, even though GLM also has a same-origin `/dashboard/recovery` route and runtime docs describe a different server-side recovery path. The Phase 9 note says browser dashboard reads are served by the API and consumed server-side by the web app, while the web app includes an explicit browser-facing route and client helper for `/dashboard/recovery`.

**References:**
- `checkout-surge-glm/docs/architecture.md:5` - architecture doc still frames itself as target architecture to be realized.
- `checkout-surge-glm/docs/repository_layout.md:3` - repository layout still says it is the target structure.
- `checkout-surge-glm/docs/load_generation_metrics_streaming.md:3` - load doc still defines target behavior.
- `checkout-surge-glm/docs/load_generation_metrics_streaming.md:51` - doc still names same-origin `/api/dashboard/recovery`.
- `checkout-surge-glm/working_docs/implementation_notes/phase-9.md:79` - implementation note says dashboard reads are API-side and consumed server-side.
- `checkout-surge-glm/apps/web/app/dashboard/recovery/route.ts:2` - web app actually exposes same-origin browser-facing `/dashboard/recovery`.

#### Verdict rationale

GLM is worse because it carries more fossilized blueprint language and at least one concrete documentation drift around dashboard recovery routing. The runtime docs improved substantially, but the design-doc set is less uniformly living documentation than Forge's.

---

### C91 — Implementation-history audit trail (better)

#### Reference behavior

Forge's roadmap is compact and phase-oriented. It records intended tasks and status checkmarks, but it does not carry extracted per-phase implementation notes with verification history, discovered defects, or explicit non-goals. That is adequate for a personal baseline, but thinner as an audit artifact for autonomous-agent evaluation.

**References:**
- `checkout-forge/working_docs/project_planning.md:9` - commits should leave the repo runnable or reviewable.
- `checkout-forge/working_docs/project_planning.md:11` - planning document is described as living documentation.
- `checkout-forge/working_docs/project_planning.md:694` - remaining hosted-deployment phase is tracked at roadmap level.

#### Compared behavior

GLM adds a dedicated implementation-notes layer and cross-links it from the roadmap. These notes are useful for review because they record verification commands, zero-oversell surge observations, discovered defects, deliberate non-goals, pre-existing flakes, and work boundaries. That makes the self-description more inspectable even when some claims still need auditing.

**References:**
- `checkout-surge-glm/working_docs/project_planning.md:22` - roadmap explains that detailed notes live under `implementation_notes/`.
- `checkout-surge-glm/working_docs/implementation_notes/README.md:19` - Phase 8 completed-task notes are indexed.
- `checkout-surge-glm/working_docs/implementation_notes/phase-9.md:37` - validation found and fixed a k6 v2.0.0 defect.
- `checkout-surge-glm/working_docs/implementation_notes/phase-9.md:50` - representative surge runs and zero-overselling result are recorded.
- `checkout-surge-glm/working_docs/implementation_notes/phase-9.md:77` - README promotion records what stale claims were removed.
- `checkout-surge-glm/working_docs/implementation_notes/phase-10.md:43` - pre-existing unrelated flakes are explicitly called out.

#### Verdict rationale

GLM is better on audit trail. The notes do not eliminate doc drift, but they materially improve traceability and make it easier to distinguish completed work, deferred work, validation results, and known risks.

---

### C92 — Portfolio-facing explanation completeness (worse)

#### Reference behavior

Forge includes a richer portfolio-facing explainer surface. The roadmap marks Task 8.5 complete, and the `/about` page explains the real-vs-simulated boundary, request path, gold signals, resilience controls, stack, and what the system proves. This aligns with the portfolio-story purpose of the documentation deliverable.

**References:**
- `checkout-forge/working_docs/project_planning.md:524` - portfolio-facing technical documentation marked complete.
- `checkout-forge/apps/web/src/app/about/page.tsx:184` - About page explains real concurrency, Redis, queue, worker, and ERP boundary.
- `checkout-forge/apps/web/src/app/about/page.tsx:309` - About page explicitly states what the system proves.

#### Compared behavior

GLM has an `/about` page, but it is much thinner. It explains synthetic buyers and lists the four signals, but it does not reach Forge's depth on request-path storytelling, resilience controls, stack choices, or the "what this proves" portfolio framing. More importantly, the roadmap itself still leaves portfolio-facing technical documentation unchecked.

**References:**
- `checkout-surge-glm/working_docs/project_planning.md:754` - portfolio-facing documentation task remains unchecked.
- `checkout-surge-glm/apps/web/app/about/page.tsx:38` - About page exists.
- `checkout-surge-glm/apps/web/app/about/page.tsx:45` - About page explains synthetic buyers.
- `checkout-surge-glm/apps/web/app/about/page.tsx:61` - About page lists the four signals.

#### Verdict rationale

GLM is worse because it has only a minimal explainer while still claiming a mostly complete local demo. This is not a runtime correctness problem, but it matters because the product's self-description is part of the deliverable.

---

### C93 — Cross-service request correlation plumbing (better)

#### Reference behavior

Forge propagates correlation IDs across the important service boundaries. The logger package owns the `x-correlation-id` header constant, trims incoming IDs, rejects IDs longer than 128 characters, and can attach the ID to child loggers. The API, mock ERP, and load orchestrator all echo the header and attach it to logs, and the worker forwards the ID to the ERP client. The implementation is effective, but each Fastify service wires its own request hook and extraction helper, and the API additionally accepts a request-body `correlationId` fallback.

**References:**
- `checkout-forge/packages/logger/src/index.ts:34` - shared correlation header constant.
- `checkout-forge/packages/logger/src/index.ts:44` - incoming IDs are bounded to 128 characters.
- `checkout-forge/apps/api/src/http.ts:9` - API request correlation extraction helper.
- `checkout-forge/apps/api/src/server.ts:94` - API request hook echoes the correlation header.
- `checkout-forge/apps/mock-erp/src/server.ts:41` - mock ERP registers its own correlation hook.
- `checkout-forge/apps/load-orchestrator/src/server.ts:60` - load orchestrator registers its own correlation hook.
- `checkout-forge/apps/worker/src/clients/mock-erp-client.ts:54` - worker forwards the correlation header to mock ERP.

#### Compared behavior

GLM centralizes this concern more cleanly. The logger package exposes independent correlation constants/helpers, each Fastify service applies the same root-level `applyCorrelationId` plugin, and the plugin decorates `request.correlationId` so route and service code can use a typed request field instead of repeatedly reading raw headers. The API, mock ERP, and load orchestrator all apply that plugin in their build roots, and the worker propagates the canonical header when calling mock ERP. The caveat is that GLM's normalizer lowercases caller-provided IDs and does not impose Forge's 128-character cap, so the primitive is still less strict than Forge's bounded normalizer.

**References:**
- `checkout-surge-glm/packages/logger/src/correlation.ts:29` - canonical correlation HTTP header constant.
- `checkout-surge-glm/packages/logger/src/correlation.ts:44` - shared normalization helper with generated fallback.
- `checkout-surge-glm/packages/logger/src/correlation.ts:52` - caller-provided IDs are lowercased rather than preserved verbatim.
- `checkout-surge-glm/apps/api/src/app/plugins/correlation-id.ts:18` - reusable root plugin decorates Fastify requests and echoes the header.
- `checkout-surge-glm/apps/api/src/app/build-server.ts:42` - API applies the correlation plugin.
- `checkout-surge-glm/apps/mock-erp/src/app/build-server.ts:31` - mock ERP applies the same plugin.
- `checkout-surge-glm/apps/load-orchestrator/src/app/build-server.ts:32` - load orchestrator applies the same plugin.
- `checkout-surge-glm/apps/worker/src/app/erp/mock-erp-http-client.ts:149` - worker forwards the canonical correlation header.

#### Verdict rationale

GLM is better on cross-service correlation plumbing because the request hook is reusable, consistently applied at service composition roots, and exposes a typed per-request field. Forge has the stronger length guard and preserves opaque caller IDs more faithfully, but its service-level wiring is more duplicated and easier to drift. This finding is deliberately narrower than C8, which grades general primitive strictness.

---

### C94 — Server-side outbound response contract validation (worse)

#### Reference behavior

Forge broadly validates server-produced response bodies against shared contract schemas before sending them onward. The buy route parses its response shape, demo-run creation parses the start response, status/read-model services parse dashboard recovery, queue, inventory, ERP, and run-history responses, and the web BFF validates upstream JSON before returning same-origin responses. That gives Forge a server-side contract guard even when a response is assembled from database rows, BullMQ counts, or upstream service JSON.

**References:**
- `checkout-forge/apps/api/src/routes/buy.ts:53` - buy response parsed before send.
- `checkout-forge/apps/api/src/services/demo-run-creation-service.ts:170` - demo-run start response parsed by the API service.
- `checkout-forge/apps/api/src/services/dashboard-recovery-service.ts:48` - dashboard recovery response parsed before return.
- `checkout-forge/apps/api/src/services/queue-health-service.ts:57` - queue health response parsed before return.
- `checkout-forge/apps/api/src/services/inventory-status-service.ts:28` - inventory status response parsed before return.
- `checkout-forge/apps/api/src/services/dashboard-run-summary-service.ts:72` - run-summary list response parsed before return.
- `checkout-forge/apps/web/src/app/api/control/load-runs/route.ts:99` - web BFF parses the upstream start-run response.

#### Compared behavior

GLM defines the relevant response schemas and its web API client does validate several responses after fetching them, but the API server often sends service result bodies directly. Multiple route handlers call `reply.status(result.statusCode).send(result.body)`, while services commonly rely on TypeScript return annotations or `satisfies` expressions for response bodies. GLM still performs runtime parsing in selected internal paths, such as realtime event projection and error-payload construction, but the server-side HTTP response emission path is less consistently guarded than Forge's.

**References:**
- `checkout-surge-glm/packages/contracts/src/demo-control.ts:159` - start-run response schema exists in contracts.
- `checkout-surge-glm/apps/api/src/app/routes/demo-run-start.ts:48` - route sends the service result body directly.
- `checkout-surge-glm/apps/api/src/app/services/demo-run-start-service.ts:498` - start-run service builds a typed response object rather than parsing the final body.
- `checkout-surge-glm/apps/api/src/app/routes/recovery.ts:17` - recovery route sends the service result body directly.
- `checkout-surge-glm/apps/api/src/app/services/recovery-service.ts:121` - recovery response uses a `satisfies` shape check.
- `checkout-surge-glm/apps/api/src/app/routes/queue.ts:16` - queue route sends the service result body directly.
- `checkout-surge-glm/apps/api/src/app/services/queue-health-service.ts:52` - queue health projection relies on a `Promise<QueueHealthResponse>` return type.
- `checkout-surge-glm/apps/web/lib/api-client.ts:468` - the web client validates the start-run response after fetching it.

#### Verdict rationale

GLM is worse on server-side outbound response validation. Contract schemas exist and some consumers validate what they fetch, but TypeScript annotations and `satisfies` clauses do not catch runtime drift from database data, queue state, fetch responses, or accidental object assembly changes before the API emits JSON. This is broader than C5's buy-route-specific response-surface issue: it is a repeated boundary discipline difference across the API server.

---

## Appendix — Method and caveats

- This consolidation covers the codebase areas listed in the introduction, from shared contracts through documentation fidelity.
- The report is based on static inspection. No code, builds, database migrations, or tests were executed while producing this consolidated file.
- Several findings are intentionally split even though they share files: GLM's contract vocabulary sourcing is better (C2), while its PostgreSQL CHECK/invariant enforcement is worse (C9, C16). Merging those into one verdict would hide important detail.
- Realtime findings are split by responsibility: contract typing and validation in C7, high-frequency event cost in C21, publication discipline in C45, SSE transport mechanics in C46, recovery/read-model semantics in C47, operator status projections in C48, and worker-produced milestone/lag signal semantics in C44.
- API-path evidence is consolidated into existing topics where appropriate: response headers and retry guidance into C5, Redis-first eligibility into C18, and queue/replay partial-state behavior into C19.
- Final-pass API-boundary findings are C93 and C94. They remain separate from C5 and C8 because C93 grades cross-service request-correlation wiring, while C94 grades repeated outbound response validation beyond the buy route.
- Demo-run lifecycle findings are consolidated by responsibility: one-active-run enforcement expanded C12, while lifecycle eligibility closure remains separate from the hot-path gate in C18 because it has the opposite verdict and a different responsibility boundary.
- Worker/ERP findings are covered in C39 through C44. Notification handling is kept separate from C33 because C33 grades finalization settlement semantics, while C43 grades downstream follow-up durability.
- Realtime/read-model findings are consolidated by responsibility: aggregation pressure in C21, inventory-status nuance in C24, consistency-lag recovery/cost issues in C44, and distinct realtime/read-model topics in C45 through C49.
- Load-orchestrator findings are consolidated into delivery-quality and measurement topics: k6-side business outcome classification expanded C34 because it feeds the same delivery-quality and unexpected-response judgment, while distinct load-orchestrator topics are C50 through C55.
- Frontend findings remain mostly distinct in C56 through C66. They intentionally do not merge into C46, C47, or C49, which grade API-side SSE/read-model mechanics and broader realtime/read-model tests rather than the browser client's recovery transport and UI surface.
- Access-governance findings are covered in C67 through C73. They intentionally do not merge into C63, which grades same-origin BFF mechanics and browser secret containment, or C62, which grades frontend admin feature completeness rather than server-side authorization and governance.
- Operational findings are consolidated by layer: reset/cleanup tooling details expanded C37; reverse-proxy SSE routing is C75, distinct from API-side stream gateway mechanics in C46; environment propagation is C78, distinct from in-process surge defaults in C28 and secret defaults in C71; health/smoke scripts are C79/C80, distinct from application readiness projections in C48.
- Testing-system findings are consolidated where they overlap existing quality topics: hard-property hot-path coverage expanded C26, frontend realtime/recovery tests expanded C66, and test-infrastructure isolation expanded C82 with a changed verdict. Distinct testing-system topics are C83 through C87.
- Documentation-fidelity findings are covered in C88 through C92. README/setup truthfulness is kept separate from runtime command implementation (C77, C79, C80), because the documentation finding grades whether the repository describes itself accurately.
- New consolidated codes start at `C1` and run through `C94`. Future consolidation should append new topics after `C94` unless a later finding is a true merge into one of these published topics.
