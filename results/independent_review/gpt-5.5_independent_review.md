# Current-Branch Codebase Audit

Branch reviewed: `ai/gpt-5.5` at `01f71e4ab3a2`

Reviewer: `gpt-5.6-sol` at high effort — the fixed independent reviewer used for every branch in this series.

This report consolidates the eight review slices defined in `working_docs/codebase_audit/review_helper.md`. Finding codes in this document are permanent; slice-report codes are local working identifiers.

## Audit Summary

- 38 findings: 6 High, 25 Medium, 7 Low.
- 11 lower-confidence notes, excluded from finding totals.
- All eight slices were reviewed sequentially on the current branch and consolidated with cross-slice overlaps assigned one permanent finding code.
- Focused unit, contract, type-check, compose, and diagnostic checks were run as recorded in the appendix. PostgreSQL/Redis-backed suites were not run because the dedicated test services were unavailable; the audit did not start or mutate infrastructure.

## Findings Index

| Code | Finding | Severity | Slices |
| --- | --- | --- | --- |
| F1 | Pending Redis holds have no recovery path once run traffic closes | High | 1 |
| F2 | A PostgreSQL commit can permanently outrun the BullMQ handoff | High | 1 |
| F3 | Concurrent idempotent requests can create a false durable pending marker | Medium | 1 |
| F4 | Idempotent replays leak asynchronous terminal order state through `/buy` | Medium | 1 |
| F5 | Every generated-run loser is gated on PostgreSQL before Redis | Medium | 1 |
| F6 | Finalization discards an already-durable terminal inventory snapshot when Redis is unavailable | Medium | 2, 4 |
| F7 | Generated-run sale ownership can be invalidated after guarded insertion | Medium | 2 |
| F8 | Seed configuration can persist a self-contradictory public runtime policy | Medium | 2, 7 |
| F9 | The test-database reset guard accepts unrelated names containing `test` | Medium | 2, 7 |
| F10 | Test reset does not implement its documented schema-integrity repair | Low | 2, 8 |
| F11 | ERP-attempt persistence failures can exhaust BullMQ while leaving orders permanently processing | High | 3, 4 |
| F12 | Retained failed notification jobs defeat the recovery scanner | Medium | 3, 4 |
| F13 | The reference worker cannot honor the two largest public presets' accepted concurrency | Medium | 3, 7 |
| F14 | Concurrent duplicate ERP confirmations bypass idempotency | Medium | 3 |
| F15 | One global circuit breaker lets one ERP scope block every other scope | Medium | 3, 6 |
| F16 | A late start acknowledgement can resurrect a draining or terminal run | High | 4 |
| F17 | Admin reset can admit and lose business state after writing the terminal summary | High | 1, 4 |
| F18 | Lossy, unbounded load handoffs can strand the only run indefinitely | Medium | 4, 7 |
| F19 | Raw k6 point values are presented as live request and failure rates | Medium | 4, 5, 6 |
| F20 | The accepted traffic quantity is ignored during k6 generation | Low | 4, 6 |
| F21 | The reference runtime boots with public, known control credentials | High | 5, 7 |
| F22 | The API trusts an unauthenticated caller's visitor identity for public budgets | Medium | 5 |
| F23 | Inventory and queue dashboard events have no production publisher | Medium | 5 |
| F24 | A new-run event relabels projections retained from the previous scope | Medium | 5 |
| F25 | Out-of-order same-run live events can overwrite newer dashboard state | Medium | 5 |
| F26 | Public dashboard read and SSE paths have no resource limits | Medium | 5, 7 |
| F27 | Admin passphrase authentication permits unlimited online guesses | Medium | 5 |
| F28 | Browser proxy errors abandon the canonical correlation envelope | Medium | 5, 6 |
| F29 | Purchase rejections mislabel non-sold-out failures and alias run closure | Low | 1, 6 |
| F30 | Routine HTTP logs do not inherit the request correlation ID | Low | 6 |
| F31 | Load smoke tears down a run before business draining is complete | Medium | 7 |
| F32 | Old-run cleanup deletes terminal state outside generated-run ownership | Medium | 2, 7 |
| F33 | Old-run cleanup leaves permanent generated Redis namespaces behind | Medium | 2, 7 |
| F34 | Runtime policy overrides are sent to a process that does not consume them | Medium | 2, 7 |
| F35 | The root watch command omits every application unit suite | Low | 7, 8 |
| F36 | The automated suite never proves the deployed services work together | Medium | 8 |
| F37 | The coverage command excludes the highest-risk suites and enforces no floor | Low | 8 |
| F38 | Test-source type checking is broken outside the normal gates | Low | 8 |

## Findings

### F1 — Pending Redis holds have no recovery path once run traffic closes (High)

**Slices:** 1

A failed PostgreSQL write leaves a real, stock-consuming Redis hold. The only reconciliation path is another `/buy` request: generated-run requests first pass the durable gate at `apps/api/src/services/reserve-order-service.ts:159`, while Redis returns the stored pending record only after evaluating run eligibility at `packages/db/src/redis-stock-reservation.ts:121` and `packages/db/src/redis-stock-reservation.ts:138`. Traffic completion moves the run to `draining` and closes Redis eligibility at `apps/api/src/services/demo-run-service.ts:628` and `apps/api/src/services/demo-run-service.ts:641`; after that, the durable gate rejects retries before the reconciliation branch at `apps/api/src/services/reserve-order-service.ts:230`.

The diagnostic pending insert is best-effort and its failure is swallowed at `apps/api/src/services/reserve-order-service.ts:421`. Accepted-promotion failures are also swallowed at `apps/api/src/services/reserve-order-service.ts:389`. There is no autonomous reservation persistence/promotion scanner. A secured reservation can therefore remain absent from the durable ledger, or a durable order can retain a false pending sentinel, causing incorrect accounting or drain timeout. This violates the documented partial-failure behavior at `docs/redis_inventory_hot_path.md:67` and `docs/redis_inventory_hot_path.md:109`.

Suggested fix: add an autonomous, idempotent reconciliation owner for Redis pending holds or a durable outbox. It must reconcile already-secured run-owned holds after traffic closure without admitting new reservations, and finalization must explicitly block on/repair Redis pending state.

Test gap: `apps/api/test/reserve-order-service.test.ts:437` retries only while the run remains eligible. Add coverage that secures a pending hold, closes the run, restores PostgreSQL, and proves reconciliation completes without further stock consumption. Separately cover pending-row insertion and accepted-promotion failures.

### F2 — A PostgreSQL commit can permanently outrun the BullMQ handoff (High)

**Slices:** 1

The reservation, queued order, and initial events commit before enqueue at `apps/api/src/services/reserve-order-service.ts:246` and `apps/api/src/services/reserve-order-service.ts:263`. If enqueue fails or the process dies in that window, there is no transactional outbox or background scan. The first caller receives a generic failure after the durable state exists (`apps/api/src/services/reserve-order-service.ts:359`), and repair depends entirely on a later same-key request discovering the durable order and re-enqueuing at `apps/api/src/services/reserve-order-service.ts:213`.

A caller that does not retry can leave an order permanently `queued` with no job. The worker cannot progress it and the run eventually times out while draining.

Suggested fix: persist a dispatch outbox in the same PostgreSQL transaction and publish idempotently by `orderId`, or add an explicit scanner for undispatched queued orders with defined retry/finalization behavior.

Test gap: `apps/api/test/reserve-order-service.test.ts:392` and `apps/api/test/api.test.ts:2143` prove that a second client retry heals the state, but do not prove recovery without another `/buy` or after a process restart in the commit/publish window.

### F3 — Concurrent idempotent requests can create a false durable pending marker (Medium)

**Slices:** 1

Two simultaneous requests with one idempotency key can receive the same Redis hold and both observe no durable row at `apps/api/src/services/reserve-order-service.ts:213`. Both then attempt the non-idempotent insert at `apps/api/src/services/reserve-order-service.ts:280` and `apps/api/src/services/postgres-buy-persistence.ts:24`. After one commits, the other's uniqueness failure is treated as an outage and records `pending_reconciliation` at `apps/api/src/services/reserve-order-service.ts:284`. `recordPendingPersistence` unconditionally inserts or resets that status at `apps/api/src/services/postgres-buy-persistence.ts:158` and `apps/api/src/services/postgres-buy-persistence.ts:172`, despite the durable order now existing.

That false row is counted as pending at `packages/db/src/business-outcome-dashboard.ts:70`, so a correct run can drain to timeout. The losing caller can also receive a pending response while an order already exists.

Suggested fix: make durable persistence idempotent by reservation ID. On uniqueness conflict, re-read and validate the existing reservation/order; at minimum, re-read before writing a pending marker and refuse pending state when the matching order exists.

Test gap: the concurrent duplicate test at `apps/api/test/api.test.ts:2366` and `apps/api/test/api.test.ts:2392` does not assert the absence of `reservation_pending_persistence` rows. Add a barrier-controlled race test that forces both requests past the first durable lookup.

### F4 — Idempotent replays leak asynchronous terminal order state through `/buy` (Medium)

**Slices:** 1

The replay lookup reads the order's current row, including terminal status and timestamps, at `apps/api/src/services/postgres-buy-persistence.ts:133` and `apps/api/src/services/postgres-buy-persistence.ts:214`. The service returns it unchanged at `apps/api/src/services/reserve-order-service.ts:217` and `apps/api/src/services/reserve-order-service.ts:465`. A focused diagnostic confirmed that replaying a confirmed order returns `status: confirmed` and `confirmedAt`.

The synchronous buy endpoint therefore becomes an order-status endpoint depending on replay timing, leaking ERP success/failure and violating the fast-reservation/slow-confirmation split documented at `working_docs/delivery_constraints.md:22` and `docs/architecture.md:56`.

Suggested fix: persist or derive an immutable acceptance projection that stays `queued`, and expose current state only through asynchronous dashboard/order-status reads.

Test gap: `apps/api/test/reserve-order-service.test.ts:502` covers only a queued replay. Add confirmed and failed fixtures and assert that `/buy` never exposes terminal state, timestamps, or failure details.

### F5 — Every generated-run loser is gated on PostgreSQL before Redis (Medium)

**Slices:** 1

Every generated-run request awaits `GeneratedRunSaleGate` before Redis at `apps/api/src/services/reserve-order-service.ts:159`. The production gate performs a PostgreSQL query per attempt at `apps/api/src/services/generated-run-sale-gate.ts:10`, including sold-out requests. The `surge-10k` preset has 1,000 units for 10,000 buyers (`packages/db/src/scripts/seed.ts:232`), while the API pool defaults to 10 connections (`apps/api/src/runtime/config.ts:27`).

PostgreSQL becomes the first hot-path bottleneck for roughly 9,000 expected losers, conflicting with the 10,000-in-one-second target (`working_docs/delivery_constraints.md:9`) and Redis-first losing-path guidance (`docs/local_development.md:114`). The durable guard prevents stale-run acceptance, so the fix must retain that safety property.

Suggested fix: make Redis the per-request eligibility fence and close/fence it reliably during durable lifecycle transitions, for example with a versioned lifecycle token and repair behavior or a bounded fail-closed cache.

Test gap: no query-count or latency-budget test covers the actual `surge-10k` shape. Add a benchmark/assertion that sold-out volume does not cause one PostgreSQL read per attempt while stale/closed runs remain rejected.

### F6 — Finalization discards an already-durable terminal inventory snapshot when Redis is unavailable (Medium)

**Slices:** 2, 4

Traffic completion embeds a Redis-derived inventory snapshot in `demo_run_finalizations.traffic_outcome_summary` before moving the run to `draining` (`apps/api/src/services/demo-run-service.ts:570`, `apps/api/src/services/demo-run-service.ts:604`, `apps/api/src/services/demo-run-service.ts:611`). Finalization does not reuse it: it performs another live Redis read at `apps/api/src/services/demo-run-finalization-service.ts:156` and `apps/api/src/services/demo-run-finalization-service.ts:207`. Errors become `null` at `apps/api/src/services/demo-run-finalization-service.ts:227`, yet the immutable summary is still written with no inventory snapshot (`apps/api/src/services/demo-run-finalization-service.ts:167`, `apps/api/src/services/terminal-demo-run-transition.ts:96`).

A transient Redis outage during the final poll can therefore permanently remove run-history inventory detail even though PostgreSQL already holds the exact terminal snapshot. If initial capture also failed, sold-out accounting can remain zero (`apps/api/src/services/demo-run-service.ts:581`).

Suggested fix: persist a typed finalization snapshot or parse the copy in `trafficOutcomeSummary` as the fallback. If neither exists, surface missing accounting explicitly in terminal diagnostics/status.

Test gap: `apps/api/test/demo-run-finalization-service.test.ts:148` and `apps/api/test/demo-run-finalization-service.test.ts:207` cover healthy Redis and uniqueness, but not Redis loss after durable snapshot capture.

### F7 — Generated-run sale ownership can be invalidated after guarded insertion (Medium)

**Slices:** 2

`demo_runs.sale_offer_id` and `demo_run_sale_contexts.(run_id, sale_offer_id)` store ownership independently, with no constraint tying them together (`packages/db/src/schema.ts:198`, `packages/db/src/schema.ts:220`, `packages/db/src/schema.ts:239`). The context trigger checks `purpose = generated_run` only on context insertion (`packages/db/drizzle/0000_initial_schema.sql:455`); nothing guards later changes to `demo_runs.sale_offer_id` or to a context-owned offer's purpose. Attribution triggers then use the context, while the durable admission gate uses `demo_runs.sale_offer_id` (`packages/db/drizzle/0000_initial_schema.sql:478`, `apps/api/src/services/generated-run-sale-gate.ts:10`).

Although the normal creation transaction supplies matching IDs (`apps/api/src/services/demo-run-service.ts:708`, `apps/api/src/services/demo-run-service.ts:742`), a later contradictory write can make the gate approve Redis holds whose PostgreSQL rows are rejected, stranding secured stock in pending persistence. This breaks the documented one-run/one-generated-offer invariant (`docs/core_business_entities.md:383`, `docs/core_business_entities.md:412`).

Suggested fix: make one ownership representation authoritative. Otherwise add a deferred constraint trigger tying run and context offers, reject purpose changes while an offer is context-owned, and make admission query that same relationship.

Test gap: `packages/db/test/integration/db.integration.test.ts:331` checks trigger presence, not mismatched updates or purpose drift.

### F8 — Seed configuration can persist a self-contradictory public runtime policy (Medium)

**Slices:** 2, 7

The seed writes generic JSON without parsing shared contracts or applying the cross-field/cap checks used by admin updates (`packages/db/src/scripts/seed.ts:32`, `packages/db/src/scripts/seed.ts:104`, `packages/db/src/scripts/seed.ts:422`). Limits and deployment caps are independently configurable (`packages/db/src/scripts/seed.ts:436`, `packages/db/src/scripts/seed.ts:458`), but the default ERP TPS remains fixed at 100 (`packages/db/src/scripts/seed.ts:430`). For example, `PUBLIC_CUSTOM_MAX_ERP_MAX_TPS=50` persists a default above its own maximum. Environment parsing also accepts partial, decimal, zero, and negative integer values (`packages/db/src/scripts/env.ts:11`, `packages/db/src/scripts/env.ts:27`). Because the policy insert uses `onConflictDoNothing`, a corrected rerun does not repair it (`packages/db/src/scripts/seed.ts:146`).

Runtime setup can succeed while later policy reads fail schema parsing or the displayed default run is rejected.

Suggested fix: strictly parse and range-check environment values, parse seeded presets/policy through shared schemas, and run the same relational/default-vs-limit validation before seeding. Validate existing rows on reseed with actionable diagnostics.

Test gap: `packages/db/test/integration/db.integration.test.ts:370` covers default values only. API tests at `apps/api/test/demo-run-service.test.ts:57` validate admin updates, not seed-time environment combinations.

### F9 — The test-database reset guard accepts unrelated names containing `test` (Medium)

**Slices:** 2, 7

`resetTestDatabase()` truncates every business table with `CASCADE` (`packages/db/src/testing.ts:43`, `packages/db/src/testing.ts:60`) but accepts any database name containing the substring `test` (`packages/db/src/testing.ts:153`). A direct probe confirmed that `checkout_surge_latest` and `contest_production` pass. A misconfigured test URL can therefore erase an unrelated database, including dependent tables not explicitly listed, despite the documented `checkout_surge_test[_package]` convention (`docs/automated_testing_infrastructure.md:17`).

Suggested fix: require an anchored canonical name or an explicit sentinel stored inside the test database; consider avoiding `CASCADE` unless all affected relations are enumerated.

Test gap: `packages/db/test/integration/db.integration.test.ts:1400` proves the intended database resets, but has no accepted/rejected near-miss table.

### F10 — Test reset does not implement its documented schema-integrity repair (Low)

**Slices:** 2, 8

The testing contract says reset compares a migration journal and schema fingerprint, rebuilding drifted schemas (`docs/automated_testing_infrastructure.md:23`). The implementation only creates the database if missing, runs migrations, and truncates (`packages/db/src/testing.ts:43`, `packages/db/src/testing.ts:54`, `packages/db/src/testing.ts:63`). There is no fingerprint/rebuild path.

Drizzle will not recreate a dropped/modified trigger when its journal says the migration ran. Tests intentionally add/remove triggers (`apps/worker/test/integration/order-processing-workflow.test.ts:184`, `apps/api/test/api.test.ts:2444`), so interrupted cleanup can poison later suites, including hand-authored invariant triggers (`packages/db/drizzle/0000_initial_schema.sql:455`).

Suggested fix: implement fingerprint/rebuild behavior including hand-authored functions/triggers, or explicitly recreate the test schema on each safe reset and update the documentation.

Test gap: add a regression that changes an invariant trigger, calls reset, and verifies restoration.

### F11 — ERP-attempt persistence failures can exhaust BullMQ while leaving orders permanently processing (High)

**Slices:** 3, 4

The worker transitions an order to `processing` before calling ERP (`apps/worker/src/application/order-process-job-handler.ts:110`, `apps/worker/src/application/order-process-job-handler.ts:136`). Production classifies every `ErpAttemptPersistenceError` as retryable without failing the order (`apps/worker/src/index.ts:307`), and that branch rethrows without checking whether attempts remain or persisting a terminal transition (`apps/worker/src/application/order-process-job-handler.ts:139`, `apps/worker/src/application/order-process-job-handler.ts:158`). Non-circuit errors consume the finite BullMQ attempt budget (`apps/worker/src/queue/bullmq-order-process-consumer.ts:183`), which defaults to four (`apps/api/src/queue/bullmq-order-process-job-publisher.ts:32`).

If PostgreSQL is unavailable while ERP attempt history is recorded, the job eventually becomes `failed` while the order stays `processing`. This also affects ERP-accepted confirmations whose response cannot be persisted (`apps/worker/src/application/erp-confirmation-client.ts:250`). No recovery scanner resumes them, and finalization eventually records a drain timeout (`apps/api/src/services/demo-run-finalization-service.ts:189`, `apps/api/src/services/demo-run-finalization-service.ts:309`).

Suggested fix: move persistence-only failures to a durable reconciliation/outbox path that survives the ERP retry budget and eventually applies accepted confirmation, with an explicit manual/terminal policy for irrecoverable ambiguity.

Test gap: `apps/worker/test/unit/order-process-job-handler.test.ts:261` proves the max-attempt branch omits terminal transitions, but no BullMQ integration test exhausts attempts, restores PostgreSQL, and proves exactly one eventual confirmation/notification.

### F12 — Retained failed notification jobs defeat the recovery scanner (Medium)

**Slices:** 3, 4

Notification jobs use deterministic ID `${orderId}-email` and retain failed jobs (`apps/worker/src/queue/bullmq-notification-record-publisher.ts:31`, `apps/worker/src/queue/bullmq-notification-record-publisher.ts:36`). Re-adding an ID that still exists is deduplicated rather than queued. The consumer logs terminal failure but does not remove/retry the job (`apps/worker/src/queue/bullmq-notification-record-consumer.ts:40`). The scanner selects confirmed orders without notifications and counts any resolved publisher call as published (`apps/worker/src/persistence/postgres-notification-recovery-persistence.ts:15`, `apps/worker/src/application/notification-recovery-scanner.ts:55`).

After three failed attempts, every scan can report successful publication while no runnable work exists. Missing notifications block finalization (`apps/api/src/services/demo-run-finalization-service.ts:315`), so a temporary persistence problem can permanently fail the run.

Suggested fix: have recovery remove/retry matching failed jobs, use a fresh delivery ID while relying on database business uniqueness, or avoid retaining failed notification jobs. Count publication only after ensuring runnable work exists.

Test gap: `apps/worker/test/integration/order-processing-workflow.test.ts:560` begins with an empty queue. Add a real BullMQ test that exhausts and retains the deterministic job, runs recovery, and proves notification persistence.

### F13 — The reference worker cannot honor the two largest public presets' accepted concurrency (Medium)

**Slices:** 3, 7

Run-scoped backpressure is a semaphore inside a BullMQ worker (`apps/worker/src/application/run-backpressure.ts:18`), so it can reduce but never raise global concurrency. That ceiling is five in code and compose (`apps/worker/src/queue/bullmq-order-process-consumer.ts:36`, `apps/worker/src/runtime/config.ts:23`, `docker-compose.yml:116`). Seeded `surge-5k` and `surge-10k` snapshots request eight and ten (`packages/db/src/scripts/seed.ts:217`, `packages/db/src/scripts/seed.ts:235`).

The reference runtime therefore cannot execute the frozen policy it reports, materially changing ERP drain rate and reproducibility.

Suggested fix: define and validate a deployment worker-concurrency cap, run BullMQ at that cap, let the per-run semaphore apply accepted values below it, and expose the effective cap in readiness/config diagnostics.

Test gap: `apps/worker/test/unit/run-backpressure.test.ts:19` proves only reduction to one and bypasses BullMQ. Add composition coverage for an accepted value above the process ceiling plus a seed/runtime consistency assertion.

### F14 — Concurrent duplicate ERP confirmations bypass idempotency (Medium)

**Slices:** 3

`ConfirmationService.confirm` checks its completed-response map before awaiting the chaos decision (`apps/mock-erp/src/application/confirmation-service.ts:46`, `apps/mock-erp/src/application/confirmation-service.ts:55`) and stores the result only afterward (`apps/mock-erp/src/application/confirmation-service.ts:70`). Overlapping same-key requests both miss and can generate different confirmations. A barrier probe reproduced two decisions and two confirmation IDs for one key.

This breaks the retry invariant needed when a worker times out while ERP continues processing, representing duplicate downstream capture/fulfillment behavior.

Suggested fix: store an in-flight promise by key before the first await, retain successful results, remove failures for retry, and bind the key to a request fingerprint to reject conflicts.

Test gap: `apps/mock-erp/test/unit/mock-erp.test.ts:133` covers sequential replay only. Add barrier-controlled concurrency and same-key/different-payload tests.

### F15 — One global circuit breaker lets one ERP scope block every other scope (Medium)

**Slices:** 3, 6

The worker constructs one `ErpCircuitBreaker` for all orders (`apps/worker/src/index.ts:153`, `apps/worker/src/index.ts:173`), and its state has no run/config key (`apps/worker/src/application/erp-circuit-breaker.ts:43`). Once one run opens it, unrelated runs and catalog orders fail before their own ERP behavior is considered (`apps/worker/src/application/erp-circuit-breaker.ts:60`, `apps/worker/src/application/erp-confirmation-client.ts:161`). A two-run probe confirmed that run A can block healthy run B without calling its confirmation path.

Suggested fix: scope breaker state by `runId`, with a separate fallback/catalog scope, publish scoped or explicitly aggregated status, and clean up terminal scopes only after their work is settled.

Test gap: add two-run and run-versus-catalog isolation tests plus status-contract coverage.

### F16 — A late start acknowledgement can resurrect a draining or terminal run (High)

**Slices:** 4

`startRun()` persists `starting`, then awaits the orchestrator (`apps/api/src/services/demo-run-service.ts:474`, `apps/api/src/services/demo-run-service.ts:498`). The orchestrator attaches k6 completion handlers before returning start success (`apps/load-orchestrator/src/application/k6-runner.ts:63`, `apps/load-orchestrator/src/application/k6-runner.ts:79`), so a short run can complete—or an admin can reset—while the start call waits. Completion accepts `starting -> draining` (`apps/api/src/services/demo-run-service.ts:628`), but `updateRunAfterTrafficStart()` later updates by ID without an expected-status predicate and writes `active` (`apps/api/src/services/demo-run-service.ts:827`, `apps/api/src/services/demo-run-service.ts:835`).

This can resurrect a draining/completed/failed run while leaving terminal timestamps and an immutable summary, after which the finalizer ignores it and future starts remain blocked.

Suggested fix: compare-and-set the acknowledgement from exactly `starting`, under the run transition lock; when no row updates, return the authoritative state. Also validate response run/correlation identity.

Test gap: add a barrier-controlled start test that completes or resets before the gateway response resolves and proves no resurrection/summary contradiction.

### F17 — Admin reset can admit and lose business state after writing the terminal summary (High)

**Slices:** 1, 4

Reset captures business state and commits the immutable failed summary/status first (`apps/api/src/services/demo-maintenance-service.ts:65`, `apps/api/src/services/demo-maintenance-service.ts:81`), then closes Redis eligibility (`apps/api/src/services/demo-maintenance-service.ts:112`) and later cleans queues (`apps/api/src/services/demo-maintenance-service.ts:131`). A `/buy` can pass the durable gate before reset and reserve/persist/enqueue afterward (`apps/api/src/services/reserve-order-service.ts:159`, `apps/api/src/services/reserve-order-service.ts:175`, `apps/api/src/services/reserve-order-service.ts:263`). Queue cleanup may remove the new job, or work may continue after the run is declared reset.

Reset can thus report success while secured business state is absent from the immutable summary or a queued order loses its job. This is separate from F1: PostgreSQL/Redis may be healthy; the terminal transition itself is unfenced.

Suggested fix: share a lifecycle fence between admission and reset, close Redis before outcome capture, account for already-admitted operations, and clean queues only after the accepted set stabilizes.

Test gap: pause buys after the durable gate and at enqueue, invoke reset, and assert no post-summary state is admitted/lost and final accounting matches durable state.

### F18 — Lossy, unbounded load handoffs can strand the only run indefinitely (Medium)

**Slices:** 4, 7

API start delegation uses `fetch` without a deadline (`apps/api/src/services/demo-run-service.ts:196`), so a hung request leaves `starting`. Completion delivery is retried only five times and then discarded (`apps/load-orchestrator/src/application/k6-runner.ts:198`, `apps/load-orchestrator/src/application/k6-runner.ts:219`, `apps/load-orchestrator/src/application/k6-runner.ts:244`); its client also lacks a timeout (`apps/load-orchestrator/src/application/api-client.ts:36`). Shutdown does not track child k6 processes or pending completion delivery (`apps/load-orchestrator/src/index.ts:46`). The API has no traffic watchdog; periodic finalization scans only `draining`, and interrupted start/active recovery runs only at API startup (`apps/api/src/services/demo-run-finalization-service.ts:57`, `apps/api/src/index.ts:279`).

A transient outage, hung internal request, or orchestrator restart can wedge the only allowed run indefinitely, blocking starts until manual reset/API restart.

Suggested fix: add configured internal-request deadlines, durable/replayed completion delivery, graceful child tracking, and an API-owned traffic deadline derived from the accepted snapshot plus reporting grace.

Test gap: cover exhausted completion retries, never-settling fetch, shutdown with live k6, and automatic terminalization of overdue `starting`/`active` runs.

### F19 — Raw k6 point values are presented as live request and failure rates (Medium)

**Slices:** 4, 5, 6

Each parsed `http_reqs` point is forwarded directly as `traffic.scheduled_request_rate` with unit `requests`; `http_req_failed` is forwarded as a ratio without time-window aggregation (`apps/load-orchestrator/src/application/k6-output-parser.ts:47`, `apps/load-orchestrator/src/application/k6-output-parser.ts:54`). Tests pin a sample to `value: 1, unit: requests` (`apps/load-orchestrator/test/load-orchestrator.test.ts:368`, `apps/load-orchestrator/test/load-orchestrator.test.ts:397`), and the dashboard labels the latest point “HTTP request rate” (`apps/web/src/app/components/dashboard-panels.tsx:378`, `apps/web/src/app/components/dashboard-panels.tsx:398`).

The headline live rate can display one raw point rather than requests/second; failure rate likewise lacks a stable interval denominator.

Suggested fix: bucket points over explicit intervals, emit count/duration with an RPS unit and failed/total for the same interval, while keeping completion totals separate.

Test gap: add multi-point bucket tests and dashboard assertions that rendered values/units are genuinely rate-shaped.

### F20 — The accepted traffic quantity is ignored during k6 generation (Low)

**Slices:** 4, 6

The snapshot permits independent `trafficConfig.quantityPerAttempt` and `inventoryConfig.quantityPerCheckout` (`packages/contracts/src/load.ts:20`, `packages/contracts/src/load.ts:32`) without requiring equality. Generated buy bodies ignore the former and use the latter (`apps/load-orchestrator/src/application/k6-script.ts:33`, `apps/load-orchestrator/src/application/k6-script.ts:68`). A diagnostic with values three and seven emitted quantity seven.

A valid custom snapshot can describe one attempt quantity while consuming another. Seeds currently set both to one, limiting default impact.

Suggested fix: remove the duplicate field or add a shared equality refinement and consume the canonical traffic-owned value; validate existing persisted configuration.

Test gap: fixtures at `apps/load-orchestrator/test/load-orchestrator.test.ts:47` set both to one. Add mismatch rejection/generation tests.

### F21 — The reference runtime boots with public, known control credentials (High)

**Slices:** 5, 7

Production compose supplies checked-in fallback control, admin passphrase, and session secrets (`docker-compose.yml:3`, `docker-compose.yml:197`, `docker-compose.yml:201`). Services validate only non-empty values (`apps/api/src/runtime/config.ts:60`), and the web accepts/trims the configured passphrase and signing secret (`apps/web/src/app/lib/server/backend-proxy.ts:23`, `apps/web/src/app/lib/server/backend-proxy.ts:57`). Compose publishes API, mock ERP, orchestrator, and web ports to the host (`docker-compose.yml:86`, `docker-compose.yml:154`, `docker-compose.yml:177`, `docker-compose.yml:205`).

Running documented defaults gives repository readers credentials for admin reset, cleanup, history deletion, preset mutation, unsafe starts, and ERP chaos, bypassing the web session. This contradicts required/startup-validated secret documentation (`docs/local_development.md:353`).

Suggested fix: use required compose substitutions, reject documented placeholder/reused/weak values at every startup, and bind direct service ports to loopback or an opt-in debug profile.

Test gap: add a resolved-compose command-contract check proving absent/placeholders fail and web tests that reject placeholder passphrase/session secrets.

### F22 — The API trusts an unauthenticated caller's visitor identity for public budgets (Medium)

**Slices:** 5

The web creates a server-issued visitor cookie (`apps/web/src/app/api/demo/runs/start/route.ts:27`), but the API accepts `x-public-visitor-id` directly on unauthenticated calls (`apps/api/src/routes/demo-run-routes.ts:188`, `apps/api/src/routes/demo-run-routes.ts:208`). The budget store uses that caller-controlled string as its Redis key (`apps/api/src/services/demo-run-service.ts:125`). A direct caller can rotate values to bypass `perVisitorMaxStarts`; only the broader global window remains. The focused API test at `apps/api/test/api.test.ts:1471` pins this behavior, contrary to `docs/admin_access_protection.md:55`.

Suggested fix: authenticate/sign the web-to-API visitor assertion. For direct public starts, derive a server-owned limiter identity and reject/ignore caller-selected forwarding headers.

Test gap: prove unsigned direct headers are rejected/ignored, valid proxy claims stay stable, and header rotation cannot evade Redis enforcement.

### F23 — Inventory and queue dashboard events have no production publisher (Medium)

**Slices:** 5

Contracts and the client handle `inventory.updated` and `queue.updated` (`packages/contracts/src/dashboard-events.ts:16`, `apps/web/src/app/components/operator-dashboard.tsx:255`), but production `publishDashboardEvent` calls cover only traffic, run transitions, and business projections (`apps/api/src/services/demo-run-service.ts:533`, `packages/db/src/business-outcome-dashboard.ts:218`). Inventory mutation writes to a separate internal list with no bridge (`packages/db/src/redis-stock-reservation.ts:256`), and no queue producer exists.

Live inventory-drain and queue-pressure panels remain at HTTP recovery values until reconnect/manual/terminal recovery, undermining the realtime demo.

Suggested fix: publish bounded, best-effort run-scoped projections outside the reservation critical path after meaningful changes or via periodic sampling.

Test gap: synthetic client tests do not prove a real reservation or queue transition reaches Pub/Sub/SSE. Add producer-boundary and focused end-to-end tests.

### F24 — A new-run event relabels projections retained from the previous scope (Medium)

**Slices:** 5

Idle recovery scopes projections to the catalog offer (`apps/api/src/services/dashboard-recovery-service.ts:70`, `apps/api/src/services/dashboard-recovery-service.ts:142`). On `run.started`, the reducer updates only `currentRun` and `recoveredAt`, retaining inventory, metrics, business outcomes, lag, and completion outcomes (`apps/web/src/app/components/operator-dashboard.tsx:242`). Only terminal events request recovery (`apps/web/src/app/components/operator-dashboard.tsx:299`). A diagnostic confirmed the new run ID appears alongside old-scope data; F23 means some projections may never be replaced live.

Suggested fix: treat every run-scope transition as an authoritative recovery boundary, clearing scoped projections or rendering only projections carrying the matching scope ID.

Test gap: add an idle/catalog-to-`run.started` reducer/browser test proving old projections never render beneath the new run.

### F25 — Out-of-order same-run live events can overwrite newer dashboard state (Medium)

**Slices:** 5

The client rejects events older than the HTTP snapshot baseline (`apps/web/src/app/components/operator-dashboard.tsx:303`, `apps/web/src/app/components/operator-dashboard.tsx:318`), but applying live projections never advances a watermark (`apps/web/src/app/components/operator-dashboard.tsx:255`, `apps/web/src/app/components/operator-dashboard.tsx:287`). Asynchronous worker projection reads/publishes can complete out of order (`packages/db/src/business-outcome-dashboard.ts:223`). A diagnostic applied T+10 then T+5 and observed regression.

Suggested fix: keep per-projection run/sale scope and monotonic version/watermark, rejecting older events and recovering on gaps or ambiguity.

Test gap: add newer-then-older sequence tests for every event type and concurrent publisher coverage.

### F26 — Public dashboard read and SSE paths have no resource limits (Medium)

**Slices:** 5, 7

Every public SSE client enters an unbounded in-memory map and each event/heartbeat iterates all clients (`apps/api/src/realtime/dashboard-event-fanout.ts:30`, `apps/api/src/realtime/dashboard-event-fanout.ts:72`). The route has no global/source cap (`apps/api/src/routes/dashboard-routes.ts:26`). Public recovery is unthrottled and fans each request into seven PostgreSQL, Redis, BullMQ, and ERP projections (`apps/api/src/services/dashboard-recovery-service.ts:149`, `apps/api/src/services/dashboard-recovery-service.ts:185`).

An unauthenticated caller can consume sockets/memory/dependency capacity and make every publication O(attacker connections), competing with the buy path. The security design explicitly requires these limits (`docs/admin_access_protection.md:94`).

Suggested fix: add environment-validated global/source SSE caps and shared-store recovery rate limits/cache/coalescing; expose current/capped counts.

Test gap: add max-client rejection/release and recovery limiter tests, plus a proxy smoke check.

### F27 — Admin passphrase authentication permits unlimited online guesses (Medium)

**Slices:** 5

The session endpoint compares one header with the configured passphrase and issues a session on equality (`apps/web/src/app/api/admin/session/route.ts:6`, `apps/web/src/app/lib/server/backend-proxy.ts:23`). There is no attempt counter, delay, lockout, source limiter, or shared budget. Equality is not constant-time, unlike signed-cookie checks later in the module (`apps/web/src/app/lib/server/backend-proxy.ts:100`).

Attackers can make unlimited guesses against the credential controlling destructive and unsafe actions; this remains exploitable after F21's default credentials are fixed.

Suggested fix: add global and server-derived-source rate limits with an injected/shared store, escalating delay/auditable generic failures, constant-time digest comparison, and a minimum passphrase policy.

Test gap: `apps/web/test/admin-control-proxy.test.ts:194` covers correctness only. Add deterministic lockout/window and limiter-store failure tests.

### F28 — Browser proxy errors abandon the canonical correlation envelope (Medium)

**Slices:** 5, 6

The shared error shape requires `code`, `message`, optional `details`, `correlationId`, and `timestamp` (`docs/cross_service_conventions.md:98`, `packages/contracts/src/error.ts:4`). The web locally returns only `{code,message}` for configuration/session, JSON/contract, transport, and invalid-backend failures (`apps/web/src/app/lib/server/backend-proxy.ts:23`, `apps/web/src/app/lib/server/backend-proxy.ts:104`, `apps/web/src/app/lib/server/backend-proxy.ts:156`); visitor setup duplicates that incomplete constructor (`apps/web/src/app/lib/server/public-visitor.ts:12`). Backend requests do not forward a browser correlation ID, and reconstructed responses discard the backend `x-correlation-id` (`apps/web/src/app/lib/server/backend-proxy.ts:136`, `apps/web/src/app/lib/server/backend-proxy.ts:184`).

Browser failures have incompatible shapes, and operators cannot join local/proxy errors to logs even when the backend emitted a trace ID.

Suggested fix: adopt a correlation ID at the web route boundary, forward and preserve it, and use one helper validated by `ErrorPayload`; keep raw fetch exceptions only in correlated server logs.

Test gap: parse every local error through `errorPayloadSchema`, assert body/header identity agreement, and prove upstream IDs survive success/error proxying.

### F29 — Purchase rejections mislabel non-sold-out failures and alias run closure (Low)

**Slices:** 1, 6

The rejected buy union permits `sold_out`, `inventory_not_initialized`, `idempotency_conflict`, and `quantity_invalid` while forcing every branch to `simulatedStatus: "sold_out"` (`packages/contracts/src/buy.ts:56`). The service emits this for invalid quantities/conflicts (`apps/api/src/services/reserve-order-service.ts:497`), and tests explicitly accept the contradiction (`packages/contracts/test/contracts.test.ts:461`). Separately, canonical `run_not_accepting_traffic` is absent from the main decision vocabulary (`packages/contracts/src/lifecycle.ts:12`), so the service rewrites it to `outcome: inventory_not_initialized` (`apps/api/src/services/reserve-order-service.ts:182`) and returns 503 (`apps/api/src/routes/buy-routes.ts:100`).

Consumers can report request conflicts or a closed run as exhausted/missing inventory. Current k6 sold-out accounting uses `outcome`, limiting default benchmark impact.

Suggested fix: make discriminated branches enforce truthful outcome/reason/status combinations and expose `run_not_accepting_traffic` canonically with intentional HTTP semantics.

Test gap: replace the contradictory positive fixture with negative combination tests and API cases for every rejection.

### F30 — Routine HTTP logs do not inherit the request correlation ID (Low)

**Slices:** 6

API, orchestrator, and mock ERP hooks normalize correlation only onto a request property/response header (`apps/api/src/server.ts:60`, `apps/load-orchestrator/src/server.ts:39`, `apps/mock-erp/src/server.ts:29`), not `request.log`. Routine request logs such as mock ERP chaos changes therefore omit it (`apps/mock-erp/src/routes/chaos-routes.ts:27`), while explicit unhandled-error logging includes it (`apps/api/src/server.ts:94`).

Successful lifecycle logs and any request log that forgets a field cannot be queried by the returned correlation ID, although critical business logs often add it manually.

Suggested fix: bind a correlation child logger per request or configure Fastify request-log bindings from the normalized ID.

Test gap: capture structured logs for successful/failed requests in each service and assert every request-scoped record carries the response correlation ID.

### F31 — Load smoke tears down a run before business draining is complete (Medium)

**Slices:** 7

The load smoke declares success when traffic succeeds and one k6 metric appears (`scripts/runtime-smoke-load.mjs:33`, `scripts/runtime-smoke-load.mjs:111`), although traffic success only moves the run to `draining` (`apps/api/src/services/demo-run-service.ts:604`, `apps/api/src/services/demo-run-service.ts:628`) and queued/processing/retrying/pending/notification work may remain. Its `finally` block immediately deletes the run's durable graph and Redis inventory (`scripts/runtime-smoke-load.mjs:41`, `scripts/runtime-smoke-load.mjs:152`, `scripts/runtime-smoke-load.mjs:198`) without removing/cancelling BullMQ jobs.

A slow worker can process surviving jobs after their order/run disappears, and the smoke never proves asynchronous business completion.

Suggested fix: wait for terminal run status and assert business outcomes, then use API-owned run-scoped cleanup that coordinates PostgreSQL, BullMQ, and Redis and rejects active work.

Test gap: add a deliberately backlogged-worker smoke regression proving finalization is awaited and all owned state/jobs are removed.

### F32 — Old-run cleanup deletes terminal state outside generated-run ownership (Medium)

**Slices:** 2, 7

Cleanup is documented for generated demo runs (`docs/local_development.md:267`) but selects candidates only by terminality, age, and retention, without requiring generated ownership (`apps/api/src/services/demo-maintenance-service.ts:150`, `apps/api/src/services/demo-maintenance-service.ts:168`). The ownership join decides only which offer rows to remove (`apps/api/src/services/demo-maintenance-service.ts:177`); all selected runs/history are deleted (`apps/api/src/services/demo-maintenance-service.ts:191`). A test explicitly blesses deletion of a catalog-offer run (`apps/api/test/demo-maintenance-service.test.ts:362`, `apps/api/test/demo-maintenance-service.test.ts:398`).

Suggested fix: derive deletable runs by joining a matching context and generated-purpose offer before applying retention. If broader cleanup is intentional, expose it as an explicit separate mode.

Test gap: preserve catalog/malformed/missing-context runs in maintenance tests.

### F33 — Old-run cleanup leaves permanent generated Redis namespaces behind (Medium)

**Slices:** 2, 7

Generated initialization creates inventory and run-eligibility namespaces (`packages/db/src/redis-inventory.ts:102`, `packages/db/src/redis-inventory.ts:150`) whose inventory/reservations/outcomes/throughput have no namespace TTL. `cleanupOldRuns()` receives Redis but deletes only PostgreSQL rows (`apps/api/src/services/demo-maintenance-service.ts:52`, `apps/api/src/services/demo-maintenance-service.ts:176`). After the run/offer disappears, `inventory:{saleOfferId}:*` and `demo-run:{runId}:sale-eligibility` remain indefinitely.

Repeated runs leak Redis memory and make cleanup accounting misleading.

Suggested fix: add exact ownership-checked namespace deletion for selected `(runId,saleOfferId)` pairs with explicit retryable partial-failure handling; never use broad flush/wildcard deletion.

Test gap: maintenance integration tests at `apps/api/test/demo-maintenance-service.test.ts:324` assert only PostgreSQL. Verify generated keys disappear and preserved/catalog/active keys remain.

### F34 — Runtime policy overrides are sent to a process that does not consume them (Medium)

**Slices:** 2, 7

Compose puts cap/budget/custom-limit overrides on the API (`docker-compose.yml:62`, `docker-compose.yml:74`), but the API config loader does not read them (`apps/api/src/runtime/config.ts:20`); enforcement reads persisted policy (`apps/api/src/services/demo-run-service.ts:444`). Only the seed consumes these variables (`packages/db/src/scripts/seed.ts:426`), while the seed-owning `runtime-setup` receives none (`docker-compose.yml:241`, `docker-compose.yml:247`). Resolved-compose diagnostics confirmed the mismatch.

Valid `.env` overrides are silently ignored and default higher policy can remain exposed. This differs from F8, which covers invalid combinations when seed values do arrive.

Suggested fix: inject one policy environment map into `runtime-setup` or move initialization into an explicit API setup command; remove unused API copies and print/verify effective persisted policy.

Test gap: run setup with non-default safe values and assert the persisted policy/enforcement matches.

### F35 — The root watch command omits every application unit suite (Low)

**Slices:** 7, 8

Docs call `pnpm test:watch` the fast unit loop (`docs/automated_testing_infrastructure.md:66`), while `test:unit` includes contracts, logger, mock ERP, worker, web, and orchestrator (`package.json:21`). `test:watch` uses the root config (`package.json:24`), whose include covers only contracts/logger (`vitest.unit.config.ts:3`). `vitest list` found 31 tests exclusively in those packages.

Developers can change any application while a green advertised watcher never exercises it.

Suggested fix: use a Vitest workspace/projects config or Turbo-backed watchers for every application unit suite, excluding infrastructure tests.

Test gap: add a command-contract assertion comparing unit projects/files with watch discovery.

### F36 — The automated suite never proves the deployed services work together (Medium)

**Slices:** 8

The full test command composes package unit/API/integration targets but never starts or exercises the reference service topology (`package.json:20`, `package.json:23`); runtime checks are separate manual commands (`package.json:37`). Each major cross-service handoff stops at a substitute: API/BullMQ tests intentionally have no worker (`apps/api/test/api.test.ts:1932`); worker integration confirms through a mocked ERP (`apps/worker/test/integration/order-processing-workflow.test.ts:544`); ERP HTTP tests inject mocked `fetch` (`apps/worker/test/integration/order-processing-workflow.test.ts:660`); web route smoke stubs server reads (`apps/web/test/browser-workflows.test.ts:53`, `apps/web/test/browser-workflows.test.ts:317`).

Wrong compose URLs/tokens, startup wiring, queue consumption, event subscription, or response assumptions can break the demo while `pnpm test` remains green.

Suggested fix: add a deterministic isolated end-to-end correctness target with real services: tiny run/purchase, real worker/mock ERP, durable reservation/order/attempt/notification, final summary, correlation, recovery/history assertions. Keep load benchmarks separate and include this target in full verification.

Test gap: no existing test crosses the full API-to-worker-to-ERP-to-dashboard/history path, and runtime smokes are not in `pnpm test`.

### F37 — The coverage command excludes the highest-risk suites and enforces no floor (Low)

**Slices:** 8

`test:coverage` runs only contracts/logger/mock-ERP/worker/web/orchestrator unit configurations (`package.json:25`). It omits every API test, DB integration file, and worker integration file, excluding Redis Lua, PostgreSQL invariants, API concurrency/idempotency, and real BullMQ delivery. None of the invoked configs defines thresholds; for example worker unit selects only unit files (`apps/worker/vitest.unit.config.ts:3`), while omitted broader configs live at `apps/api/vitest.api.config.ts:3` and `packages/db/vitest.integration.config.ts:3`.

The command can pass with arbitrarily low coverage while excluding the highest-risk paths.

Suggested fix: rename it `test:coverage:unit` or merge isolated API/integration coverage, with deliberate package/changed-line floors for critical boundaries; do not substitute numeric coverage for F36.

Test gap: add a command-contract check enumerating required coverage projects and thresholds.

### F38 — Test-source type checking is broken outside the normal gates (Low)

**Slices:** 8

The repository exposes `type-check:test`, but normal `type-check` and `test` do not invoke it (`package.json:14`, `package.json:20`). Package configs compile source only (`apps/api/tsconfig.json:8`), while tests use `tsconfig.test.json:11`. On this branch `pnpm type-check:test` fails at `apps/api/test/reserve-order-service.test.ts:247` because an optional deferred callback narrows to non-callable `never`; the same file passes 18 Vitest tests because transpilation performs no type check.

The declared command is broken, and green normal gates allow test mocks/fixtures to drift from TypeScript interfaces.

Suggested fix: repair the callback with an explicitly typed deferred helper and require test-source type checking in standard verification/CI.

Test gap: add a root command-contract/required task running `type-check:test` with source checks and suites.

## Notes

### N1 — ERP attempt and event attribution relies mostly on application discipline

**Slices:** 2, 3

`erp_attempts` stores `order_id`, `run_id`, and `correlation_id` independently, without enforcing identity agreement, timestamp ordering, or status-appropriate error data (`packages/db/src/schema.ts:309`, `packages/db/src/schema.ts:329`). `order_events` likewise permits inconsistent order/reservation/offer/run/correlation attribution (`packages/db/src/schema.ts:341`). Current worker adapters validate durable identity before normal writes, so no ordinary corrupting path was identified; focused integrity tests would clarify and preserve this boundary.

### N2 — Process-local run state has no retention bound

**Slices:** 3, 7

Successful mock ERP confirmations remain indefinitely in an in-memory map (`apps/mock-erp/src/application/confirmation-service.ts:35`, `apps/mock-erp/src/application/confirmation-service.ts:77`), and run-scoped semaphores are never removed (`apps/worker/src/application/run-backpressure.ts:9`, `apps/worker/src/application/run-backpressure.ts:39`). Repeated hosted runs therefore grow both structures. Practical severity depends on run volume and idempotency-retention expectations; bounded lifecycle-aware cleanup needs coverage that active entries are never evicted early.

### N3 — Restart reconciliation freezes partial active-run outcomes as if they were final

**Slices:** 3, 4

Startup reconciliation terminalizes every `active` run and writes the current business projection to an immutable summary (`apps/api/src/services/demo-run-startup-reconciliation-service.ts:52`, `apps/api/src/services/demo-run-startup-reconciliation-service.ts:77`). It does not coordinate with separately running workers, so queued/processing/notification facts may change later. It also records zero emitted/completed traffic (`apps/api/src/services/demo-run-startup-reconciliation-service.ts:219`) even when business outcomes prove acceptance. The documented policy intentionally fails interrupted active runs, so this remains a note; authoritative history needs an explicit partial/unknown model or delayed settling.

### N4 — Internal traffic inputs are shape-valid but not bound to the accepted run

**Slices:** 4, 6

Metric ingestion accepts any shape-valid service-token payload without checking run existence or traffic-active status (`apps/api/src/services/demo-run-service.ts:528`). Completion stores supplied planned counts, identity, timestamps, and delivery classification without comparing them to the accepted snapshot/correlation (`apps/api/src/services/demo-run-service.ts:546`, `apps/api/src/services/demo-run-service.ts:580`). Contracts validate field shapes but not identity/arithmetic agreement (`packages/contracts/src/load.ts:119`, `packages/contracts/src/load.ts:145`). The current trusted client constructs these consistently; explicit binding would make stale or misrouted output fail closed.

### N5 — The admin bearer cookie is never marked `Secure`

**Slices:** 5

`createAdminSessionCookie()` always emits `HttpOnly; SameSite=Lax` but never `Secure` (`apps/web/src/app/lib/server/backend-proxy.ts:57`, `apps/web/src/app/lib/server/backend-proxy.ts:76`). The visitor cookie already uses a request-protocol-aware pattern (`apps/web/src/app/lib/server/public-visitor.ts:71`). This is a hardening gap for HTTPS deployments, but the reference runtime deliberately supports local HTTP, so the correct enforcement mode depends on deployment expectations.

### N6 — Cookie-only admin mutations have no explicit origin or CSRF assertion

**Slices:** 5

Protected proxies authorize solely with the signed cookie (`apps/web/src/app/lib/server/backend-proxy.ts:39`); mutating routes such as reset perform no `Origin`/CSRF check (`apps/web/src/app/api/admin/demo/reset/route.ts:10`). `SameSite=Lax` blocks common cross-site subrequests but not a hostile same-site sibling. Risk depends on deployment/domain isolation.

### N7 — Database enums duplicate canonical lifecycle vocabulary without a parity guard

**Slices:** 2, 6

`packages/db/src/schema.ts` independently redeclares sale-offer purpose, reservation/order/ERP statuses, event names, visibility/operator/run/traffic values (`packages/db/src/schema.ts:18`, `packages/db/src/schema.ts:72`). They currently match `packages/contracts/src/lifecycle.ts`, so no runtime drift exists. Prefer constructing from canonical arrays where migration tooling permits, or add exhaustive parity tests and a migration checklist.

### N8 — Lifecycle DTO schemas validate values but not state/timestamp coherence

**Slices:** 3, 4, 5, 6

`demoRunSnapshotSchema` makes lifecycle timestamps optional independently of state (`packages/contracts/src/demo.ts:94`); completion outcomes independently accept order/display/ERP statuses and terminal times (`packages/contracts/src/demo.ts:166`); ERP confirmation permits success without a confirmation ID or mixed success/error fields (`packages/contracts/src/erp.ts:48`). Inspected producers are coherent, so this is hardening rather than a demonstrated bad response. Discriminated unions/refinements and negative tests would enforce the advertised lifecycle.

### N9 — The infra-only shutdown command owns the entire runtime Compose project

**Slices:** 7

`infra:up` targets PostgreSQL/Redis, but `infra:down` runs unscoped `docker compose down`, identical to `runtime:down` (`package.json:30`, `package.json:31`, `package.json:33`). If a full runtime shares the project, this “infra-only” command stops every app/proxy. A scoped stop or explicit whole-project documentation would remove ambiguity.

### N10 — Smoke budget cleanup can decrement a different window than it consumed

**Slices:** 7

The smoke computes its budget window at process start (`scripts/runtime-smoke-load.mjs:10`), while the API consumes the current window later (`apps/api/src/services/demo-run-service.ts:125`). Crossing a boundary makes cleanup adjust earlier keys (`scripts/runtime-smoke-load.mjs:226`), leaving actual consumption and possibly decrementing other visitors' shared count. The timing window is narrow; an API-owned smoke identity or returned consumption token would make rollback exact.

### N11 — The only real k6 compatibility assertion is optional

**Slices:** 8

The always-run script check uses Node syntax and string checks (`apps/load-orchestrator/test/load-orchestrator.test.ts:110`, `apps/load-orchestrator/test/load-orchestrator.test.ts:127`); actual `k6 inspect` uses `it.skip` when no binary exists (`apps/load-orchestrator/test/load-orchestrator.test.ts:139`, `apps/load-orchestrator/test/load-orchestrator.test.ts:865`). This audit observed the disclosed skip. Portability is reasonable, but a mandatory k6-equipped release lane should catch import/options incompatibility before traffic starts.

## Appendix — Checked and found sound

- Slice 1 verified that the Redis Lua reservation operation atomically enforces stock and generated-run eligibility, keeps inventory arithmetic consistent, and does not oversell across distinct idempotency keys (`packages/db/src/redis-stock-reservation.ts:121`, `packages/db/src/redis-stock-reservation.ts:158`, `packages/db/src/redis-stock-reservation.ts:243`).
- Same-key quantity conflicts do not mutate stock, and successful replays do not inflate throughput (`packages/db/src/redis-stock-reservation.ts:139`, `packages/db/test/integration/db.integration.test.ts:1197`).
- Body/header run attribution mismatch is rejected before reservation work (`apps/api/src/routes/buy-routes.ts:45`).
- Sold-out decisions avoid per-request durable rows and Redis idempotency/event records; they update only bounded aggregate pressure (`packages/db/src/redis-stock-reservation.ts:234`).
- A genuine persistence failure returns an explicit pending response with `order: null` and `Retry-After` (`apps/api/src/services/reserve-order-service.ts:481`, `apps/api/src/routes/buy-routes.ts:37`).
- Queue publication occurs only after the reservation/order/events transaction commits, and the `/buy` route remains thin (`apps/api/src/services/postgres-buy-persistence.ts:24`, `apps/api/src/routes/buy-routes.ts:17`).
- Slice 2 verified that normal generated-run creation inserts the offer, run, and matching context transactionally, and that run-owned-row triggers reject mismatched/missing attribution on ordinary inserts.
- Order/reservation constraints enforce a secured backing reservation with matching offer, run, correlation, and quantity; ERP attempts are unique per order/attempt and have basic timing/range checks.
- Finalization/summary uniqueness is enforced, and terminal writes serialize competing finalization/reset paths with a run-scoped PostgreSQL advisory lock.
- Required public presets and the singleton policy are seeded; ordinary API updates validate mutable policy values and preserve deployment caps.
- Generated-run cleanup targets old terminal run contexts and excludes active/recent runs; Redis initialization deletes only the target sale-offer namespace.
- Slice 3 verified strict queue job identity, API/ERP separation, transactionally persisted order transitions/events, finite exponential backoff for ordinary ERP failures, and non-consuming circuit-open delays.
- Notification persistence rejects pre-confirmation writes and is idempotent at the database boundary; notification enqueue happens only after confirmation and cannot roll it back.
- Worker readiness checks PostgreSQL, Redis, both consumer loops, and both queue connections. Mock ERP TPS windows are run-scoped and take accepted run behavior.
- Slice 4 verified serialized sequential start gating; shell-safe k6 generation; stable duplicate-buyer keys; expected all-sold-out handling; separation of traffic completion from terminal finalization; blocker-aware normal finalization; advisory-lock/uniqueness protection for terminal summaries; and explicit traffic under-delivery classification.
- Slice 5 verified same-origin browser control routing, server-only private URLs/tokens, signed-session protection on dangerous proxies, public-custom non-persistence, public/admin preset enforcement, safe terminal-only run-history DTOs/deletion protection, and baseline/reconnect recovery behavior.
- SSE mechanics send reconnect/heartbeats, avoid per-client backlogs, and drop backpressured clients; F26 concerns admission limits. The dashboard side of F19 was confirmed without duplicating it.
- Slice 6 verified timezone-aware shared timestamps and DB columns; strict correlated queue/ERP payloads; contract-valid API/mock-ERP errors; shared-schema validation across core API/web success responses; safe package exports; and dependency-aware readiness vocabulary.
- Cross-service review reconfirmed F15, F19, F20, and N4 without duplicating them.
- Slice 7 verified all root/test/devcontainer compose configurations; separate runtime targets including a pinned k6 binary; service-DNS/proxy routing; explicit migration-before-seed setup; dependency-aware readiness; isolated test infra/Redis DB use; Turborepo upstream ordering; and the presence of documented command contracts and `surge-10k` runtime docs.
- Slice 8 found no committed `.only`, `.todo`, `xit`, or `xdescribe`; unit suites have no live infrastructure dependencies; integration projects serialize and isolate package databases/Redis DBs; API construction is dependency-injected; focused API/worker suites cover many real persistence/BullMQ boundaries. F36 concerns the missing full topology.

Verification so far:

- `pnpm --filter api exec vitest run test/reserve-order-service.test.ts --config vitest.api.config.ts` — 18 tests passed.
- A focused in-memory replay diagnostic confirmed terminal order-state leakage.
- PostgreSQL/Redis integration suites were not run for slice 1 because isolated test containers were not running; the audit did not start or mutate infrastructure.
- `pnpm --filter @checkout-surge/db type-check` and `pnpm --filter api type-check` passed for slice 2.
- Shared contract tests passed (25/25).
- A direct reset-guard probe confirmed unrelated database names containing `test` are accepted.
- DB integration was attempted for slice 2 but could not start because dedicated PostgreSQL/Redis ports 56432/6380 were unavailable; 36 tests did not reach assertions.
- `pnpm --filter worker test:unit` passed 46/46; `pnpm --filter mock-erp test:unit` passed 26/26.
- Focused diagnostics reproduced concurrent same-key ERP confirmations with different IDs and run B being blocked by run A's circuit breaker.
- Slice 3 integration suites were not run because isolated infrastructure was unavailable and the audit did not start it.
- `pnpm --filter load-orchestrator test:unit` passed 17 tests with one k6-binary test skipped; contracts passed 25/25; API and load-orchestrator type-checks passed.
- A generated-script diagnostic confirmed the accepted quantity mismatch. A direct API suite run passed 32 infrastructure-independent tests; 20 DB-backed cases could not start because `TEST_DATABASE_URL` was unset.
- Slice 5: web tests passed 46/46; API SSE fanout tests 3/3; focused visitor-header API test 1/1; contracts 25/25; web/API type-checks passed.
- Reducer diagnostics reproduced prior-scope retention and T+10-to-T+5 live-state regression. PostgreSQL-backed run-history tests were not run because isolated infrastructure was unavailable.
- Slice 6: contracts passed 25/25, logger 6/6, web proxy 16/16, focused API rejection 1/1; contracts/logger/web/API type-checks passed.
- Slice 7: root, test, and merged devcontainer `docker compose config --quiet` passed; resolved JSON confirmed policy vars absent from setup/present on API; root watch discovery found 31 contracts/logger-only tests.
- No mutating runtime, database, Redis, or load commands were used for slice 7.
- Slice 8: `pnpm test:unit` passed 166 tests with one conditional k6 skip; focused reservation tests passed 18/18; `pnpm type-check` passed all eight workspaces; `pnpm type-check:test` failed at `apps/api/test/reserve-order-service.test.ts:247` as reported in F38.
- PostgreSQL/Redis-backed slice-8 suites were statically reviewed but not run because the dedicated containers were not running.
