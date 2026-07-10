# Consolidated Codebase Audit — glm-5.2

Branch reviewed: `ai/glm-5.2` at `c07e0de15be8`

Reviewer: `gpt-5.6-sol` at high effort — the fixed independent reviewer used for every branch in this series.

This report consolidates the eight slice reports (`slice_1.md` … `slice_8.md`) produced against `working_docs/codebase_audit/review_helper.md`. Findings reported independently by multiple slices are merged into a single entry with the union of their slice references and evidence; codes are renumbered sequentially in document order. Findings are grouped by severity. Where slices disagreed (the replay-versus-eligibility ordering in F11, and the notification-settlement question in N6), the disagreement was resolved by direct code and documentation reading during consolidation, and only the verified conclusion is recorded.

## Audit Summary

- 54 findings: 9 High, 36 Medium, 9 Low.
- 6 lower-confidence notes, excluded from finding totals.
- All eight slices were reviewed on the current branch and consolidated with cross-slice overlaps merged by root cause under one permanent finding code.
- Per-slice validation is recorded in the closing appendix; the two cross-slice disagreements (F11 and N6) were resolved by direct read-only code and documentation verification during consolidation.

## Findings index

| Code | Finding | Severity | Slices |
| --- | --- | --- | --- |
| F1 | k6 traffic can start before the run is buyable | High | 1, 4 |
| F2 | Draining and terminal runs can remain buyable | High | 1, 4 |
| F3 | Some post-gate failures leave secured holds invisible and return 500 | High | 1 |
| F4 | Run-start failures can strand a blocking run or create a terminal run with no history | High | 2, 4 |
| F5 | A single lost completion POST strands a run as active forever | High | 4 |
| F6 | Drain timeout can mark unsettled business work completed | High | 4 |
| F7 | An open circuit permanently fails work that should remain buffered | High | 3 |
| F8 | Redelivery after ERP success can confirm the same order twice | High | 3 |
| F9 | Production service processes accept committed control secrets | High | 7 |
| F10 | A transient enqueue failure permanently strands a durable queued order | Medium | 1, 3 |
| F11 | Idempotency replay bypasses run eligibility | Medium | 1 |
| F12 | Every sold-out request performs a synchronous realtime publication | Medium | 1, 5 |
| F13 | Configurable reservation holds can outlive the fixed idempotency window | Medium | 1, 7 |
| F14 | Startup reconciliation freezes in-flight outcomes and destroys Redis-only sold-out accounting | Medium | 2, 4 |
| F15 | Generated run-sale ownership can be mutated into an invalid state | Medium | 2 |
| F16 | PostgreSQL accepts impossible order and ERP histories | Medium | 2, 3 |
| F17 | Documented public-custom, runtime-policy, and admin preset-save surfaces are unreachable or inert end-to-end | Medium | 2, 5, 6, 7 |
| F18 | Destructive test-reset primitives do not verify their target | Medium | 2, 7, 8 |
| F19 | Exhausted queue jobs leave durable orders permanently processing — and the tests bless it | Medium | 3, 4, 8 |
| F20 | Run-scoped backpressure is applied after jobs are already in flight and fails open | Medium | 3 |
| F21 | A throwing half-open probe wedges the circuit indefinitely | Medium | 3 |
| F22 | Queue health reports success when no worker is consuming | Medium | 3, 7 |
| F23 | The mock ERP TPS bucket leaks state across runs | Medium | 3 |
| F24 | Reset and recovery do not stop the active k6 process | Medium | 4 |
| F25 | Every HTTP 409 is classified as expected traffic | Medium | 4 |
| F26 | Reconnect recovery leaves most live panels stale | Medium | 5 |
| F27 | The global realtime feed is applied without run or sale-offer scoping | Medium | 5 |
| F28 | The dashboard ignores the authoritative traffic metrics | Medium | 5 |
| F29 | Documented deployment safety caps are compile-time constants | Medium | 5, 7 |
| F30 | Public callers can apply custom overrides to curated presets outside public-custom policy | Medium | 5 |
| F31 | Run History has no pagination, arbitrary detail, or usable admin deletion UI | Medium | 5 |
| F32 | The admin login endpoint has no online-guessing protection | Medium | 5 |
| F33 | The web type-check can consume stale or missing contract artifacts | Medium | 6, 7 |
| F34 | Reachable HTTP errors bypass the canonical error contract | Medium | 5, 6 |
| F35 | Run IDs are logged as correlation IDs during finalization and reset | Medium | 6 |
| F36 | The realtime schema accepts contradictory and untraceable business events | Medium | 5, 6 |
| F37 | `runtime:up` can report healthy before the database schema exists | Medium | 7 |
| F38 | Compose discards most documented service configuration overrides | Medium | 7 |
| F39 | Host-native service and database commands do not load `.env` | Medium | 7 |
| F40 | Worker readiness stays green when PostgreSQL or Redis is unreachable | Medium | 7 |
| F41 | `.env.test` cannot override the committed test defaults | Medium | 7 |
| F42 | `type-check:test` succeeds without checking any test code | Medium | 7, 8 |
| F43 | The root full-suite command omits the only real-k6 integration lane | Medium | 7, 8 |
| F44 | Integration locks cannot recover after an interrupted test process | Medium | 8 |
| F45 | Known races make the fast unit lane nondeterministic and skip the web suite | Medium | 8 |
| F46 | Idempotency keys are effectively unbounded | Low | 1, 6 |
| F47 | `preview-1k` does not implement the documented buyer spike | Low | 2, 7 |
| F48 | Short/final metric windows use the full polling interval | Low | 4 |
| F49 | An invalid visitor cookie permanently blocks public starts in that browser | Low | 5 |
| F50 | Curated start buttons remain enabled while another run is in progress | Low | 5 |
| F51 | Public and terminal DTO schemas do not enforce their advertised boundary invariants | Low | 5, 6 |
| F52 | Run-start privilege remains a required, ignored request-body field | Low | 5, 6 |
| F53 | The order-read API keeps a local schema and does not validate its response | Low | 6 |
| F54 | Several service URLs are not validated at startup | Low | 7 |

## High-severity findings

### F1 — k6 traffic can start before the run is buyable (High)

**Slices:** 1, 4

The start handshake is ordered backwards. The API delegates to the load orchestrator before it marks the run `active` or writes the Redis eligibility payload (`apps/api/src/app/services/demo-run-start-service.ts:435`, `apps/api/src/app/services/demo-run-start-service.ts:462`, `apps/api/src/app/services/demo-run-start-service.ts:470`). The orchestrator marks its execution active and invokes `runToCompletion()` before returning its 202 response (`apps/load-orchestrator/src/app/services/traffic-execution-service.ts:293`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:299`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:310`), and in production the synchronous child-process runner spawns k6 before that async method first yields. All seeded traffic configurations use a zero-second start delay, including the 5k/10k buyer spikes (`packages/db/src/seed-data.ts:111`, `packages/db/src/seed-data.ts:133`). There is therefore no happens-before relationship between the first `/buy` calls and installation of the eligibility key: early valid requests receive `not_initialized` even though the start was accepted.

Several adjacent failure paths compound this. If `setRunEligibilityActive` throws, the error is only logged and the already-active run is returned with no retry or repair, so every request in a one-second run can fail eligibility while the dashboard reports an active run (`apps/api/src/app/services/demo-run-start-service.ts:475`). A very short run can submit its completion report while the database still says `starting`; ingestion stores the report but refuses the `active -> draining` transition (`apps/api/src/app/services/traffic-completion-ingestion-service.ts:155`, `apps/api/src/app/services/traffic-completion-ingestion-service.ts:160`), and nothing replays the missed transition after the start path later activates the run. The service also ignores `markRunActive()`'s `transitioned` result, so a concurrent reset can win the transition while the start request still returns an `active` response (`apps/api/src/app/services/demo-run-start-service.ts:465`, `apps/api/src/app/services/demo-run-start-service.ts:498`).

Use an explicit two-phase prepare/activate handshake: prepare the script/process without releasing traffic, commit durable `active` state and the required Redis eligibility projection, then release k6. Treat eligibility installation as a prerequisite whose failure fails the start and compensates the prepared run, and require the guarded active transition to succeed before returning 202.

Test gap: the API start tests use a stub orchestrator and the orchestrator tests do not coordinate against API activation. Add a test that models the orchestrator issuing a buy before `startRun()` returns, a failing eligibility write, a start/reset race, and a real cross-service zero-delay start, asserting no generated request observes `not_initialized` after an accepted start.

### F2 — Draining and terminal runs can remain buyable (High)

**Slices:** 1, 4

Traffic-completion ingestion changes the durable run from `active` to `draining` but does not close the Redis `acceptingTraffic` gate (`apps/api/src/app/services/traffic-completion-ingestion-service.ts:155`, `apps/api/src/app/services/traffic-completion-ingestion-service.ts:161`). Eligibility is cleared only after finalization has read settlement state, written the immutable summary, and transitioned the run to terminal (`apps/api/src/app/services/run-finalization-service.ts:405`, `apps/api/src/app/services/run-finalization-service.ts:416`). The hot-path Lua gate accepts any fresh request while the hash still says `acceptingTraffic = 1` (`packages/db/src/inventory/reservation-gate.ts:213`, `packages/db/src/inventory/reservation-gate.ts:233`). Anyone who retained the returned run and sale-offer IDs can therefore create new reservations throughout the drain window, and a fresh reservation can race between the finalizer's settled reads and the eventual eligibility clear, producing an order after the immutable summary has already captured zero queued/processing work. The terminal inventory reads race those same writes, so the supposedly terminal snapshot can combine values from different instants.

Terminal cleanup is also lossy. If the Redis `DEL` fails after the database transition, the error is logged and swallowed (`apps/api/src/app/services/run-finalization-service.ts:417`). Subsequent poller passes select only draining runs (`apps/api/src/app/services/run-finalization-service.ts:198`), so the now-terminal run is never selected to retry cleanup; startup reconciliation has the same best-effort, no-retry pattern (`apps/api/src/app/services/run-lifecycle-service.ts:101`). Post-summary orders and stock movements can be absent from run history and leave terminal inventory/business counts permanently inconsistent.

Close fresh-buy eligibility atomically with (or immediately before) the `active -> draining` transition, before settlement is evaluated. Persist enough reconciliation intent to retry Redis closure until confirmed, and have startup/periodic reconciliation remove eligibility for every durable non-accepting run, including already-terminal rows. Redis must remain the cheap request-time gate, but its projection cannot be a one-shot best-effort side effect. Note the replay interaction: the Lua script resolves stored idempotency records before eligibility (`packages/db/src/inventory/reservation-gate.ts:194`), so closing the gate stops fresh keys but not replays. That is acceptable only for same-run retries; F11 confirms the replay branch never compares the stored run ID to the request, so pair this change with F11's run-matched replay check to keep legitimate drain-window retries working while wrong-run replays fail closed.

Test gap: existing eligibility tests manually clear the key before buying (`apps/api/tests/buy-run-eligibility.integration.test.ts:139`); none exercise lifecycle ownership. Add tests that ingest traffic completion and immediately attempt a fresh buy, race finalization against a late fresh request, and inject Redis cleanup failures followed by a reconciliation pass, asserting stock and durable rows remain unchanged.

### F3 — Some post-gate failures leave secured holds invisible and return 500 (High)

**Slices:** 1

Once the Lua gate returns `secured`, the service performs a PostgreSQL ownership lookup before entering the `try` that handles durable persistence failure (`apps/api/src/app/services/reserve-order-service.ts:512`, `apps/api/src/app/services/reserve-order-service.ts:516`, `apps/api/src/app/services/reserve-order-service.ts:538`). A database outage at that lookup escapes as an internal error even though Redis has already decremented stock and stored the hold/idempotency record. Even when the durable transaction itself fails, the follow-up pending-sentinel write is awaited outside its own recovery block (`apps/api/src/app/services/reserve-order-service.ts:546`, `apps/api/src/app/services/reserve-order-service.ts:561`); if Redis becomes unavailable after the successful gate command, that error also escapes and the durable pending ledger is never attempted. The gate atomically writes the reservation hold and idempotency record but creates no provisional pending-persistence entry (`packages/db/src/inventory/reservation-gate.ts:257`, `packages/db/src/inventory/reservation-gate.ts:287`).

In both cases the client receives 500 instead of the documented `reservation_pending_persistence`, while operator pending counters and the durable pending ledger can both remain empty. Finalization can then consider the run settled and produce a summary that omits an actually secured Redis unit. Recovery depends on the same client retrying before the idempotency record expires, which is not an adequate reconciliation mechanism.

Make the pending state atomic with acceptance: the gate can create a provisional pending entry in the same Lua operation and the successful durable path can clear it. Alternatively, add a durable outbox/reconciler and encompass every operation after `secured` in a failure boundary — a second best-effort Redis command alone cannot close the crash window. The redundant ownership read should be removed or folded into the durable transaction; Redis already verified the run/offer pair.

Test gap: the current partial-failure tests mock only `createSecuredReservationWithOrder` (`apps/api/tests/buy-pending-persistence.integration.test.ts:42`). Add tests for a throwing `findRunSaleOwnership`, a failure between the gate and sentinel write, and process termination immediately after Lua success, each proving the hold is discoverable for reconciliation and finalization does not report it as settled.

### F4 — Run-start failures can strand a blocking run or create a terminal run with no history (High)

**Slices:** 2, 4

`createDemoRun` commits the generated offer, `starting` run, and ownership context before seeding Redis (`packages/db/src/run-lifecycle/run-creation.ts:204`, `packages/db/src/run-lifecycle/run-creation.ts:241`, `packages/db/src/run-lifecycle/run-creation.ts:254`). Its own contract notes that a seed failure leaves a starting run the caller must fail (`packages/db/src/run-lifecycle/run-creation.ts:188`), but the thrown error carries no created IDs, and the caller's generic catch only logs and returns 503 without compensating (`apps/api/src/app/services/demo-run-start-service.ts:404`, `apps/api/src/app/services/demo-run-start-service.ts:417`, `apps/api/src/app/services/demo-run-start-service.ts:432`). The durable `starting` row remains the current run and blocks every subsequent start until an admin reset or API restart reconciles it.

The next failure boundary is also incomplete. When the orchestrator returns a structured rejection, the service does know the IDs but only calls `failRun()` (`apps/api/src/app/services/demo-run-start-service.ts:438`, `apps/api/src/app/services/demo-run-start-service.ts:444`); it does not deactivate the generated offer, tear down Redis state, or write the required immutable failure summary. This contradicts the domain rule that traffic-start failures have a summary-backed history record (`docs/core_business_entities.md:579`) and the public run-summary contract that every terminal run has one summary-backed history record (`packages/contracts/src/run-summary.ts:404`).

Make run establishment return a durable handle even when Redis seeding fails, or throw a typed error carrying `runId`/`saleOfferId`, then route every post-commit start failure through one idempotent abort/compensation operation that fails the run, deactivates the offer, writes the honest failure summary, closes durable and Redis eligibility, and clears owned Redis state.

Test gap: the run-creation suite covers a PostgreSQL rollback but never makes Redis seeding fail (`packages/db/tests/run-creation.integration.test.ts:159`); the API suite covers a structured orchestrator rejection and asserts only the run status (`apps/api/tests/demo-run-start.integration.test.ts:365`). Add fault-injected Redis-seed and delegation-timeout tests asserting no blocking run remains and exactly one failure summary exists.

### F5 — A single lost completion POST strands a run as active forever (High)

**Slices:** 4

The completion handoff is a one-shot, best-effort HTTP request. Network errors, timeouts, and non-2xx responses are only logged and never retried (`apps/load-orchestrator/src/app/k6/api-traffic-completion-sink.ts:59`, `apps/load-orchestrator/src/app/k6/api-traffic-completion-sink.ts:66`, `apps/load-orchestrator/src/app/k6/api-traffic-completion-sink.ts:72`), after which the orchestrator considers its execution terminal. The API moves `active -> draining` only when this POST arrives (`apps/api/src/app/services/traffic-completion-ingestion-service.ts:155`), and the finalization poller selects only rows already in `draining` (`packages/db/src/run-lifecycle/run-finalization.ts:157`, `packages/db/src/run-lifecycle/run-finalization.ts:168`), so the drain timeout cannot recover an `active` row with no `trafficEndedAt`. One transient failure after k6 exits — or an orchestrator restart/death mid-run — leaves the run active indefinitely, blocks every subsequent start, keeps sale eligibility open, and never creates history.

There is a related durability inversion on the receiver: if the finalization-input insert fails, ingestion catches the error, can still transition the run to draining, and returns `accepted: true` (`apps/api/src/app/services/traffic-completion-ingestion-service.ts:133`, `apps/api/src/app/services/traffic-completion-ingestion-service.ts:150`, `apps/api/src/app/services/traffic-completion-ingestion-service.ts:197`). That run later times out as failed despite a successful traffic run.

Make completion delivery durable and acknowledged: persist an orchestrator-side outbox/report before considering the execution handed off, retry with idempotency until the API confirms the report is stored and draining is established, and make the API ack reflect durable insertion. As a backstop, reconcile old `active` runs against an orchestrator status/report endpoint or an explicit active-run timeout.

Test gap: the current test explicitly proves a throwing completion sink is swallowed and the execution still becomes `succeeded` without asserting API lifecycle recovery (`apps/load-orchestrator/tests/traffic-execution-service.unit.test.ts:347`). Add network-drop, non-2xx, orchestrator-restart, and database-insert-failure tests spanning both services.

### F6 — Drain timeout can mark unsettled business work completed (High)

**Slices:** 4

The finalizer correctly computes settlement from queued orders, processing orders, and pending reconciliation (`apps/api/src/app/services/run-finalization-service.ts:234`, `apps/api/src/app/services/run-finalization-service.ts:238`). Once the drain timeout fires, however, it bypasses that gate (`apps/api/src/app/services/run-finalization-service.ts:243`, `apps/api/src/app/services/run-finalization-service.ts:256`) and derives terminal status solely from traffic delivery (`apps/api/src/app/services/run-finalization-service.ts:263`, `apps/api/src/app/services/run-finalization-service.ts:279`). Complete HTTP delivery thus produces lifecycle `completed` even while orders are processing or pending persistence. The summary is written before those orders finish and is immutable/first-writer-wins (`apps/api/src/app/services/run-finalization-service.ts:354`, `packages/db/src/run-lifecycle/run-finalization.ts:207`), so later worker transitions cannot correct its counts. A new run is then allowed while old business work is still executing, and run history labels the timed-out run `completed` despite explicitly unresolved work. F19's stranded processing orders are the most likely way to reach this timeout.

An unsettled drain timeout should be a distinct terminal failure such as `business_drain_timeout`, with residual order/queue/pending counts captured for explanation; alternatively, keep the run draining until explicit operator recovery. Traffic quality should remain a separate field and must not turn an unsettled business timeout into completion.

Test gap: the existing integration test locks in the current result for a processing order (`apps/api/tests/run-finalization.integration.test.ts:410`, `apps/api/tests/run-finalization.integration.test.ts:424`). Replace it and add tests proving late worker updates cannot make a completed immutable artifact stale.

### F7 — An open circuit permanently fails work that should remain buffered (High)

**Slices:** 3

The circuit wrapper returns a synthetic failed result when the breaker denies a call (`apps/worker/src/app/erp/resilience.ts:104`, `apps/worker/src/app/erp/resilience.ts:110`). `circuit_open` is classified as terminal rather than retryable (`apps/worker/src/app/erp/resilience.ts:48`, `apps/worker/src/app/erp/resilience.ts:55`), so the processor stops its retry loop and transitions the order to durable `failed` (`apps/worker/src/app/services/order-process-service.ts:265`, `apps/worker/src/app/services/order-process-service.ts:280`, `apps/worker/src/app/services/order-process-service.ts:282`). During half-open recovery, one call is admitted as the probe while every other picked-up order receives `circuit_open` and is finalized failed.

This contradicts the documented outage invariant that orders remain in BullMQ while the circuit is open until the reset window and a healthy probe allow processing to resume (`docs/architecture.md:99`, `docs/architecture.md:101`). A short ERP outage can permanently fail the entire queued backlog without a single ERP call. The existing integration suite encodes the defect by asserting the third order becomes failed with `circuit_open` (`apps/worker/tests/erp-resilience.integration.test.ts:438`, `apps/worker/tests/erp-resilience.integration.test.ts:453`) and that an order arriving before recovery is failed rather than delayed (`apps/worker/tests/erp-resilience.integration.test.ts:496`, `apps/worker/tests/erp-resilience.integration.test.ts:501`).

Do not treat an open circuit as a terminal business result. Pause or rate-limit consumption until the reset instant, or move denied jobs to a delayed/retryable state without exhausting a small fixed attempt budget; only a real terminal ERP response should drive `processing -> failed`. Note F21 makes this worse: a wedged half-open breaker permanently fails every picked-up order.

Test gap: add an integration test with a queued backlog that opens the circuit, proves denied orders remain waiting/delayed and non-terminal, advances through one half-open probe, and confirms the backlog after recovery.

### F8 — Redelivery after ERP success can confirm the same order twice (High)

**Slices:** 3

The worker performs the external ERP call before it durably records the attempt (`apps/worker/src/app/services/order-process-service.ts:223`, `apps/worker/src/app/services/order-process-service.ts:227`, `apps/worker/src/app/services/order-process-service.ts:232`). A process crash, lost database connection, or transaction failure after the ERP applies the confirmation but before `recordErpAttempt` commits causes the processor to throw; BullMQ re-drives the job under its three-attempt producer policy (`packages/contracts/src/queue.ts:112`, `apps/api/src/app/queue/orders-process-queue.ts:44`). Because the failed transaction left no attempt row, `nextErpAttemptNumber` returns the same number (`apps/worker/src/app/persistence/order-transition-persistence.ts:156`) and the worker calls the ERP again.

Neither side provides an idempotency barrier: the request carries order identity and an attempt number but no confirmation idempotency contract (`packages/contracts/src/erp.ts:55`), and the mock ERP applies latency/throttling/outcome behavior on every request without storing or replaying a prior order outcome (`apps/mock-erp/src/app/services/erp-behavior-service.ts:147`, `apps/mock-erp/src/app/services/erp-behavior-service.ts:183`, `apps/mock-erp/src/app/services/erp-behavior-service.ts:216`). A real confirmation boundary could apply the same business side effect twice, while the durable ERP history shows only the later call.

Make ERP confirmation idempotent on a stable business key, preferably `orderId` or a dedicated confirmation idempotency key, and have the mock ERP replay the first applied result for that key. Keep the worker's attempt number as retry metadata, not side-effect identity.

Test gap: add a failure-injection test that lets the ERP apply success, aborts before the attempt transaction commits, redelivers the job, and proves the ERP applies one confirmation while the order reaches one terminal state.

### F9 — Production service processes accept committed control secrets (High)

**Slices:** 7

The API, Mock ERP, and load orchestrator all fall back to the committed `change-me-shared-control-token`; the API also falls back to the committed public-client cookie secret (`apps/api/src/app/config.ts:128-130`, `apps/mock-erp/src/app/config.ts:128`, `apps/load-orchestrator/src/app/config.ts:146`). These credentials protect reset, maintenance, chaos, run-start, and internal-ingestion surfaces. The shared Node runtime image sets `NODE_ENV=production` (`docker/Dockerfile.node-service:59-60`), but none of those composition roots rejects an unset or sentinel credential before listening (`apps/api/src/index.ts:30-31`, `apps/mock-erp/src/index.ts:26-27`, `apps/load-orchestrator/src/index.ts:30-31`). Only the web process performs production secret validation (`apps/web/lib/config.ts:172-199`, invoked at `apps/web/instrumentation.ts:15-18`), which does not make independently deployed API/ERP/orchestrator processes fail closed.

This is especially risky because the local Compose topology publishes all direct service ports (`docker-compose.yml:63-64`, `docker-compose.yml:93-94`, `docker-compose.yml:145-146`) and the repository anticipates the Dockerfiles being reused for hosted deployment (`docs/runtime_topology.md:214-218`). A missed environment variable leaves privileged direct-service endpoints protected by a public, known token.

Centralize sentinel/strength validation in a shared server-side helper and invoke it from every protected service composition root. Keep the local reference runtime opt-in explicit (for example the existing `ALLOW_INSECURE_SECRETS=1`), but never let a production service listen with a missing or sentinel control token.

Test gap: current production-secret tests cover only web (`apps/web/tests/config.test.ts:65-141`). Add config/startup tests for each process under production, local-opt-in, and real-secret cases.

## Medium-severity findings

### F10 — A transient enqueue failure permanently strands a durable queued order (Medium)

**Slices:** 1, 3

After the reservation/order transaction commits, `queue.add` failures are logged and swallowed, and the service still returns `reservation_secured` (`apps/api/src/app/services/reserve-order-service.ts:268`, `apps/api/src/app/services/reserve-order-service.ts:270`, `apps/api/src/app/services/reserve-order-service.ts:544`). There is no transactional outbox or scanner comparing durable queued orders with BullMQ. A client retry does not repair the handoff: an idempotent replay that finds the existing order returns immediately without attempting enqueue (`apps/api/src/app/services/reserve-order-service.ts:397`).

The order remains `queued` in PostgreSQL with no BullMQ job, so no worker can advance it. The run stays draining until timeout and can then finalize with a stranded queued order. Queue health still looks normal because the missing job is not part of BullMQ backlog counts.

Persist a queue-outbox record in the same transaction as the queued order and have a dispatcher retry idempotent publication, or run a repair loop over durable queued orders with deterministic `jobId = orderId`. Replays should be allowed to ensure the job exists without duplicating work.

Test gap: the current test explicitly treats a throwing producer plus an unqueued durable order as success (`apps/api/tests/buy-queue-handoff.integration.test.ts:301`). Replace it with a failure-then-recovery test proving the accepted order eventually appears in BullMQ and is processed exactly once.

### F11 — Idempotency replay bypasses run eligibility (Medium)

**Slices:** 1

The Lua script reads and returns an idempotency replay/conflict before it checks the owning run and accepting-traffic fields, and the replay branch matches on stored quantity only — the stored record's `runId` is decoded but never compared to the request's `runId` (`packages/db/src/inventory/reservation-gate.ts:194-211`; eligibility follows at `packages/db/src/inventory/reservation-gate.ts:219`). The service layer does not compensate: the replay branch computes a durable run attribution via `resolveDurableRunId`, but a mismatch yields `null` rather than a rejection (`apps/api/src/app/services/reserve-order-service.ts:301-311`), and `reconcileLateDuplicate` never reads that attribution when a durable order already exists — it immediately returns `securedResponse` built from the stored facts with `idempotentReplay=true` (`apps/api/src/app/services/reserve-order-service.ts:397-401`). A request using a wrong `runId` but the same sale offer, key, and quantity therefore receives the original run's reservation token and public order ID. Clearing eligibility for a draining/closed run likewise has no effect on already-accepted keys until their TTL expires.

This is a confirmed documentation-versus-implementation inversion, not an ambiguous design choice. Both authoritative docs specify eligibility before idempotency: `docs/architecture.md` step 3 validates eligibility "failing closed when the run/sale pair is missing, mismatched, or no longer accepting traffic" before step 4's Lua idempotency/stock check (`docs/architecture.md:49-50`), and `docs/redis_inventory_hot_path.md:31` says the API checks eligibility and accepting status "before using one Redis Lua operation for the stock decision." The Issue 20 refactor folded eligibility into the Lua script but placed it after the idempotency lookup. The gate header's claim of "matching the documented rule" refers only to the key-scoping rule (`saleOfferId + idempotencyKey`, `docs/redis_inventory_hot_path.md:57`), which is real but orthogonal: scoping determines which requests are duplicates; it says nothing about skipping eligibility for them. The behavior does not double-decrement stock, but it violates fail-closed run attribution and can make a closed run appear to continue accepting successful requests.

One legitimate product concern survives from the current ordering: a buyer accepted just before traffic close who retries just after it holds a real secured reservation, and the idempotency contract's unqualified replay promise (`docs/redis_inventory_hot_path.md:59`) makes bouncing that same-run retry with `not_initialized` undesirable. The fix that satisfies both the documented contract and that retry expectation is to compare the stored record's `runId` to the request `runId` inside the replay branch: wrong-run requests fail closed as `not_initialized`, same-run replays keep working through the drain window, and fresh keys remain governed by the eligibility gate (see F2). Document the resulting closed-run replay policy explicitly rather than leaving it to Lua statement ordering.

Test gap: current wrong-run and closed-run tests use fresh idempotency keys (`packages/db/tests/reservation-gate.integration.test.ts:281`, `packages/db/tests/reservation-gate.integration.test.ts:291`). Add matching-key replay and conflict cases after changing the request run and after clearing eligibility, at both gate and HTTP boundaries, asserting a wrong-run replay is rejected and a same-run replay still resolves.

### F12 — Every sold-out request performs a synchronous realtime publication (Medium)

**Slices:** 1, 5

The atomic gate correctly keeps sold-out accounting to one aggregate hash update, but the service then awaits `publishSoldOutPressure` for every losing request before returning (`apps/api/src/app/services/reserve-order-service.ts:477`). That publisher directly awaits the realtime transport rather than the background scheduler used by secured/order publications (`apps/api/src/app/services/inventory-drain.ts:101`, `apps/api/src/app/services/inventory-drain.ts:109`), and generates one Pub/Sub/SSE event per loser.

This contradicts the documented design that the sold-out path emits no per-loser dashboard events and flushes aggregate pressure periodically (`docs/architecture.md:52`, `docs/architecture.md:105`). In the headline 10,000-request spike, the majority of requests are expected losers; adding an awaited Redis publish plus subscriber/SSE fan-out to each one increases latency and event-loop/Redis load exactly where the design calls for the cheapest path.

Remove per-request sold-out publication. Periodically read/coalesce the existing `api_sold_out_decision` counter and publish bounded deltas, or let recovery reads surface the aggregate. Merely moving each event to the scheduler avoids response latency but still creates an unbounded fan-out storm.

Test gap: the realtime integration test currently requires one event per sold-out request (`apps/api/tests/inventory-drain-realtime.integration.test.ts:149`). Replace it with tests proving a blocked realtime publisher cannot delay a sold-out response and that a burst produces a bounded number of dashboard events while the Redis aggregate remains exact.

### F13 — Configurable reservation holds can outlive the fixed idempotency window (Medium)

**Slices:** 1, 7

Accepted idempotency records always expire after 3,600 seconds (`packages/db/src/inventory/reservation-gate.ts:51`), while `RESERVATION_HOLD_MINUTES` accepts any positive integer with no upper bound relative to that TTL (`apps/api/src/app/config.ts:117`). The code comment claims the idempotency TTL is intentionally longer than the configured hold, but the configuration validator does not enforce the invariant.

With a hold of 61 minutes or more, the same sale offer/key/quantity can be retried after the idempotency key expires while the first reservation is still within its hold. Lua treats it as a fresh request and consumes stock again, so one logical duplicate creates a second reservation and order.

Derive the idempotency TTL from the accepted hold duration plus a safety margin, or reject configurations whose hold is not strictly shorter than the retention window, making the relationship explicit in one configuration/schema boundary.

Test gap: no configuration or integration test uses a hold longer than one hour. Add a short test-only TTL/clock variant proving a retry throughout the configured hold always replays and never decrements stock twice.

### F14 — Startup reconciliation freezes in-flight outcomes and destroys Redis-only sold-out accounting (Medium)

**Slices:** 2, 4

Startup reconciliation immediately fails every `starting`/`active` run and inserts its immutable summary from a point-in-time PostgreSQL read: it counts reservations/orders before the transaction (`packages/db/src/run-lifecycle/run-lifecycle.ts:193`, `packages/db/src/run-lifecycle/run-lifecycle.ts:207`) and writes a first-writer-wins summary with those counts, hard-coded `soldOutRejections: 0`, no terminal inventory snapshot, empty ERP attempts, and zero notifications (`packages/db/src/run-lifecycle/run-lifecycle.ts:230`, `packages/db/src/run-lifecycle/run-lifecycle.ts:246`, `packages/db/src/run-lifecycle/run-lifecycle.ts:256`). The application service then deletes all inventory keys for the reconciled offer (`apps/api/src/app/services/run-lifecycle-service.ts:101`, `apps/api/src/app/services/run-lifecycle-service.ts:111`).

Two distinct losses follow. First, an API restart during an active surge can have an exact sold-out aggregate and terminal counters in Redis, but recovery records zero and then destroys the only remaining source — run history permanently understates losing-path pressure and lacks a terminal inventory snapshot. Second, an interrupted active run can have queued/processing orders that workers continue completing after the restart; because the summary is immutable, history permanently records the pre-completion snapshot as the final business outcome, and the reconciliation comment calls the zero traffic facts honest even though traffic may already have been delivered and the orchestrator may still be running (`packages/db/src/run-lifecycle/run-lifecycle.ts:239`).

Move interrupted-run finalization to an application workflow that closes fresh traffic promptly but captures Redis drain signals and inventory before the database transaction and before teardown, persists the sold-out aggregate in `demo_run_reservation_outcomes`, and defers the immutable summary until durable business work settles or an explicit interruption-failure timeout fires — reusing the normal finalization pipeline with an interruption reason. Immediate summary creation is reasonable only for a `starting` run proven to have no accepted work. Fall back to zero/null only when Redis is genuinely unavailable.

Test gap: recovery tests seed sold-out data for the live recovery read (`apps/api/tests/recovery.integration.test.ts:193`) but the startup-reconciliation tests never combine that data with a restart (`apps/api/tests/recovery.integration.test.ts:474`), and current startup recovery tests use empty runs. Add restart tests for an active run with nonzero sold-out pressure, queued/processing orders, pending persistence, ERP attempts, and later confirmations.

### F15 — Generated run-sale ownership can be mutated into an invalid state (Medium)

**Slices:** 2

The database stores the run's offer twice: `demo_runs.sale_offer_id` and `demo_run_sale_contexts.sale_offer_id` are independent foreign keys (`packages/db/src/schema.ts:322`, `packages/db/src/schema.ts:354`) with nothing enforcing agreement. The purpose trigger validates a generated offer only when the context row is inserted or its offer ID changes (`packages/db/migrations/0000_burly_random.sql:278`, `packages/db/migrations/0000_burly_random.sql:304`); there is no reverse guard preventing a referenced offer from later changing from `generated_run` to `catalog`.

The invalid transition is demonstrated at the storage boundary: the maintenance test changes a context-owned generated offer to `catalog`, and the cleanup code then preserves the now-invalid run forever because it trusts the mutable purpose (`packages/db/tests/run-maintenance.integration.test.ts:304`, `packages/db/tests/run-maintenance.integration.test.ts:319`, `packages/db/tests/run-maintenance.integration.test.ts:326`). Changing `demo_runs.sale_offer_id` can likewise make lifecycle/reset/cleanup operate on a different offer than the ownership context and its business rows.

Enforce one authoritative `(run_id, sale_offer_id)` relationship: a deferred constraint trigger can require `demo_runs.sale_offer_id` to match its context once establishment completes, and a trigger on `sale_offers` should reject changing `purpose` away from `generated_run` while a context references it. Maintenance should resolve ownership through `demo_run_sale_contexts`, not a second mutable pointer.

Test gap: existing trigger tests cover context insertion and run-attributed writes only (`packages/db/tests/triggers.integration.test.ts:72`, `packages/db/tests/triggers.integration.test.ts:91`). Add tests rejecting purpose mutation and run/context offer divergence, plus a cleanup test proving ownership cannot drift.

### F16 — PostgreSQL accepts impossible order and ERP histories (Medium)

**Slices:** 2, 3

An order has separate `sale_offer_id`, `reservation_id`, `correlation_id`, `run_id`, and `quantity` columns, but its only reservation relationship is the foreign key to the reservation ID (`packages/db/src/schema.ts:207`, `packages/db/src/schema.ts:211`, `packages/db/src/schema.ts:214`). The database does not require those identity fields to match the referenced reservation or require that reservation to be `secured`, and does not tie order status to its timestamps: a `confirmed` order may have a null `confirmed_at`, a state current tests routinely create (`apps/api/tests/recovery.integration.test.ts:183`, `apps/api/tests/recovery.integration.test.ts:190`). A rejected/released reservation can back a confirmed order.

ERP attempts have a foreign key to the order and a unique attempt number, but their `run_id` and correlation are independent of the parent, `attempt_number` may be zero/negative, and `latency_ms`/`finished_at` are nullable regardless of outcome (`packages/db/src/schema.ts:241`, `packages/db/src/schema.ts:245`, `packages/db/src/schema.ts:246`, `packages/db/src/schema.ts:251`). Finalization counts orders and attempts by their standalone `run_id` values (`packages/db/src/run-lifecycle/run-recovery.ts:116`, `packages/db/src/run-lifecycle/run-finalization.ts:326`), so an inconsistent child row is counted in the wrong run or makes an impossible confirmation appear successful.

The normal API/worker adapters currently write coherent rows, but PostgreSQL is the durable source of truth and the schema exports allow other adapters, migrations, tests, or maintenance code to bypass those assumptions. Add composite/constraint-trigger enforcement for order-to-reservation identity and secured status, positive quantity/attempt checks, status/timestamp coherence, and parent-derived ERP run/correlation identity — or remove duplicated child identity fields and derive them through joins.

Test gap: the trigger suite checks a generated order's run against its sale context, not its referenced reservation (`packages/db/tests/triggers.integration.test.ts:123`). Add integrity tests rejecting cross-offer/cross-run/cross-correlation orders, terminal orders without matching timestamps, orders backed by non-secured reservations, and incomplete or misattributed ERP attempts.

### F17 — Documented public-custom, runtime-policy, and admin preset-save surfaces are unreachable or inert end-to-end (Medium)

**Slices:** 2, 5, 6, 7

Three layers of the documented public-custom/policy contract are each missing their half, so the documented product flows cannot be performed at all:

**Seeding and environment defaults are inert.** The contract says the singleton policy is seeded from environment-backed defaults and updatable via protected admin controls (`packages/contracts/src/demo-control.ts:271`); the API env template exposes public budget variables (`apps/api/.env.example:40`) and the configuration reference exposes budget and `PUBLIC_CUSTOM_*` variables (`docs/local_development.md:427`). In practice `seedDemoData` constructs one hard-coded policy object (`packages/db/src/seed-data.ts:255`), makes it insert-only on re-seed (`packages/db/src/seed-data.ts:402`), and the setup container receives only database and Redis URLs (`docker-compose.yml:214`, `docker-compose.yml:219`). Changing a documented environment limit — for example lowering the global public-start budget below the hard-coded six — has no effect.

**No service boundary exists.** The persistence layer has only a policy getter (`packages/db/src/run-lifecycle/public-runtime-policy.ts:31`); there is no update persistence function, API route, shared request/response DTO, or dashboard control, and `publicCustomDefaults` has no consumer outside seed data (`apps/api/src/app/services/demo-run-start-service.ts:283-305`, `apps/api/src/app/services/demo-run-start-service.ts:348-382`). Admins cannot perform the documented protected policy update.

**The UI flows are unreachable.** The public picker removes the `public-custom` definition and renders slug-only starts (`apps/web/components/demo-picker.tsx:13-24`, `apps/web/components/demo-picker.tsx:31-46`); the public server action accepts only a preset slug even though the server API client can carry a run-scoped configuration (`apps/web/app/actions.ts:41-50`, `apps/web/lib/api-client.ts:400-438`). There is no public custom form or policy/defaults reader anywhere in `apps/web`. On the admin side, a protected `PUT /api/admin/presets/:slug` proxy exists but no component calls it; preset management offers only duplicate and copy-to-Custom, with saving explicitly deferred in source (`apps/web/components/admin/preset-actions.tsx:19-29`, `apps/web/components/admin/preset-actions.tsx:35-98`). The public bounded-custom demo and the core admin save workflow are marked complete in planning/docs but only exist as handcrafted direct API requests.

Create one validated environment-to-policy default builder, pass its variables to the setup job, and seed the parsed value only when the singleton is missing. Add public-safe runtime-policy/defaults and admin policy-update contracts with API and same-origin routes; the update path must validate against injected deployment hard caps (see F29). Render a bounded `public-custom` form on `/` submitting a non-persistent `runScopedConfig`, and add a cap-aware admin editor calling the existing save proxy for editable admin presets only.

Test gap: the seed test pins the hard-coded value (`packages/db/tests/seed.integration.test.ts:183`, `packages/db/tests/seed.integration.test.ts:230`), and existing override tests exercise only a handcrafted API request. Add environment-override and authenticated-update tests including rejection above deployment caps, plus web/API tests for reading defaults, starting a bounded custom run, rejecting out-of-policy values, non-persistence of public changes, read-only preset save rejection, and saved admin values being what a later start freezes.

### F18 — Destructive test-reset primitives do not verify their target (Medium)

**Slices:** 2, 7, 8

`resetTestDatabase` unconditionally truncates every application table on whatever `DrizzleDb` it receives, and `flushRedisDb` unconditionally runs `FLUSHDB` on whatever Redis client it receives (`packages/db/src/reset.ts:108`, `packages/db/src/reset.ts:117`). Both are public package exports (`packages/db/src/index.ts:119`) whose comments claim test-only safety but which have no runtime guard.

The command wrapper is only a partial backstop: it rejects the literal ports `5432` and `6379` (`scripts/run-with-test-env.mjs:72`, `scripts/run-with-test-env.mjs:87`) rather than verifying an approved test host/database name/Redis index. URLs using default ports with no explicit port, remote infrastructure, or alternate production ports pass, and the per-package database/index rewrite happens only after that weak check (`scripts/run-with-test-env.mjs:127`, `scripts/run-with-test-env.mjs:149`). A misconfigured test URL can create/truncate databases or flush a logical Redis DB on the wrong server; direct callers bypass even the port check.

Make destructive helpers require verified target metadata rather than opaque clients: check `current_database()` against an explicit test-name allowlist, require `NODE_ENV=test` plus an opt-in token, and validate the Redis URL/host/logical DB before connection construction. The wrapper should compare normalized endpoints against development/production URLs and reject default-port omissions.

Test gap: current reset tests prove only that truncation and `FLUSHDB` work on valid isolated fixtures (`packages/db/tests/reset.integration.test.ts:32`, `packages/db/tests/reset.integration.test.ts:47`). Add refusal tests for development URLs, no-explicit-port URLs, unexpected database names, Redis DB 0, and direct helper invocation without the test opt-in.

### F19 — Exhausted queue jobs leave durable orders permanently processing — and the tests bless it (Medium)

**Slices:** 3, 4, 8

Unexpected exceptions are deliberately rethrown for BullMQ to retry, but after the queue's fixed attempt budget is exhausted there is no durable compensation path. The processor has already moved the order to `processing`; it finalizes only when the confirmer returns a result and explicitly leaves a persistently throwing order non-terminal (`apps/worker/src/app/services/order-process-service.ts:197`, `apps/worker/src/app/services/order-process-service.ts:204`), and the worker's `failed` event handler only logs (`apps/worker/src/index.ts:151`, `apps/worker/src/index.ts:163`).

This violates the documented `queued -> processing -> confirmed | failed` lifecycle (`working_docs/project_planning.md:307`, `working_docs/project_planning.md:311`) and keeps run finalization waiting until its drain timeout — after which F6 can label the run `completed` with a stranded processing order and no durable ERP-attempt explanation. The strongest real-BullMQ integration test explicitly asserts the broken business result: after all retries, the job is failed but the order remains `processing` with no terminal event and no ERP attempt (`apps/worker/tests/order-async-pipeline.integration.test.ts:333`, `apps/worker/tests/order-async-pipeline.integration.test.ts:352`, `apps/worker/tests/order-async-pipeline.integration.test.ts:358`), so the suite stays green.

Introduce a durable dead-letter reconciliation workflow: on final job exhaustion, record a stable infrastructure failure outcome and transition the still-processing order to `failed` idempotently once PostgreSQL is available; if the failure is database unavailability itself, retain a retryable reconciliation record rather than a one-shot event callback.

Test gap: change the exhaustion test to require the durable failed order, `order.failed` timeline event, failure metadata, and no duplicate terminal transition on redelivery, keeping the transient-throw-then-success scenario (`apps/worker/tests/order-async-pipeline.integration.test.ts:294`) as the retry regression test. Add temporary-database-failure-then-recovery coverage.

### F20 — Run-scoped backpressure is applied after jobs are already in flight and fails open (Medium)

**Slices:** 3

The BullMQ worker starts at the global `ORDER_PROCESS_CONCURRENCY` (`apps/worker/src/index.ts:137`, `apps/worker/src/index.ts:141`). Only after BullMQ invokes each processor does the service load the accepted run snapshot and mutate the worker's shared concurrency/breaker settings (`apps/worker/src/app/services/order-process-service.ts:113`, `apps/worker/src/app/services/order-process-service.ts:123`, `apps/worker/src/app/services/order-process-service.ts:128`). When a run accepted a cap of one but the global default is five, BullMQ can dispatch five jobs before the first resolver call finishes; lowering the worker property does not cancel already-active processors.

Resolution also fails open: a snapshot-read exception is logged and swallowed (`apps/worker/src/app/services/order-process-service.ts:130`, `apps/worker/src/app/services/order-process-service.ts:132`), and a missing or unparseable snapshot selects global defaults (`apps/worker/src/app/services/run-behavior-resolver.ts:66`, `apps/worker/src/app/services/run-behavior-resolver.ts:77`). A transient PostgreSQL error can make a forced-outage run confirm successfully under healthy global settings, or let a cap-controlled run overload the ERP.

Install the accepted run policy before releasing its traffic/jobs, or gate actual ERP calls with a run-scoped semaphore/rate limiter acquired after the snapshot resolves. Resolver errors for run-attributed jobs should retry/fail closed rather than silently substituting global behavior.

Test gap: current run-scoped tests call `service.process` sequentially and assert only that an applier spy was invoked (`apps/worker/tests/run-scoped-behavior.integration.test.ts:204`, `apps/worker/tests/run-scoped-behavior.integration.test.ts:216`). Add a real-queue concurrency test proving the observed ERP in-flight maximum never exceeds the accepted run cap, plus a resolver-failure test proving no ERP call occurs under fallback behavior.

### F21 — A throwing half-open probe wedges the circuit indefinitely (Medium)

**Slices:** 3

When the reset window elapses, `allow()` moves the breaker to `half_open` and marks its sole probe in flight (`apps/worker/src/app/erp/circuit-breaker.ts:159`, `apps/worker/src/app/erp/circuit-breaker.ts:165`). That flag is released only by `recordSuccess` or `recordFailure` (`apps/worker/src/app/erp/circuit-breaker.ts:179`, `apps/worker/src/app/erp/circuit-breaker.ts:191`), but the confirmer wrapper awaits the inner client without a `catch`/`finally` (`apps/worker/src/app/erp/resilience.ts:104`, `apps/worker/src/app/erp/resilience.ts:118`). If the admitted probe throws, neither method is called and every later `allow()` sees `probeInFlight` and returns false forever (`apps/worker/src/app/erp/circuit-breaker.ts:169`, `apps/worker/src/app/erp/circuit-breaker.ts:176`).

Unexpected confirmer throws are an explicitly supported path elsewhere in the worker, so this is within the port contract. The slice-3 reviewer reproduced the sequence with the shipped modules: open the breaker, advance past the reset timeout, make the half-open probe throw, advance the clock again — the breaker remains `half_open` and every later result is `circuit_open`. In production only a worker restart recovers, and while wedged, F7 permanently fails every picked-up order.

Wrap an admitted call so a throw records a failed probe before rethrowing to BullMQ, clearing the in-flight flag and reopening the breaker with a fresh reset instant.

Test gap: existing tests cover only result-returning probes (`apps/worker/tests/erp-resilience.unit.test.ts:162`) and direct manual release of the probe flag (`apps/worker/tests/circuit-breaker.unit.test.ts:178`). Add wrapper-level tests for a throwing closed-state call and a throwing half-open probe followed by a successful recovery cycle.

### F22 — Queue health reports success when no worker is consuming (Medium)

**Slices:** 3, 7

`GET /queue/status` returns 200 whenever the API's producer-side Queue object is wired; it reports Redis job counts but has no consumer heartbeat/running field (`apps/api/src/app/services/queue-health-service.ts:96`, `apps/api/src/app/services/queue-health-service.ts:104`). The integration test explicitly enqueues two jobs with no worker running and still expects 200 (`apps/api/tests/queue-health.integration.test.ts:105`, `apps/api/tests/queue-health.integration.test.ts:114`). The only consumer-running signal lives on the worker's separate health port and is never combined with the operator-facing queue projection (`apps/worker/src/app/services/readiness-service.ts:57`, `apps/worker/src/app/services/readiness-service.ts:63`).

An offline worker therefore looks like a healthy queue whose waiting depth happens to be growing; an empty queue with no worker is indistinguishable from a functioning pipeline. Runtime smoke/monitoring and dashboard users receive success while accepted orders have no consumer.

Publish a timestamped worker heartbeat/consumer count into shared Redis and include its freshness in the API queue response, or aggregate the worker readiness endpoint at a trusted server-side health boundary, deriving degraded/unavailable when no fresh consumer exists. See also F40 for the worker's own readiness gaps.

Test gap: add tests for no consumer, stale heartbeat, active consumer, and consumer loss after jobs have accumulated.

### F23 — The mock ERP TPS bucket leaks state across runs (Medium)

**Slices:** 3

The ERP behavior service owns one mutable `throttleMaxTps` and one token bucket for the entire process (`apps/mock-erp/src/app/services/erp-behavior-service.ts:122`, `apps/mock-erp/src/app/services/erp-behavior-service.ts:131`). A request changes only the bucket's capacity provider according to its run-scoped config and does not select or reset state by `runId` (`apps/mock-erp/src/app/services/erp-behavior-service.ts:137`, `apps/mock-erp/src/app/services/erp-behavior-service.ts:143`); the bucket is reset only by the global admin chaos-reset operation (`apps/mock-erp/src/app/services/erp-behavior-service.ts:239`, `apps/mock-erp/src/app/services/erp-behavior-service.ts:242`).

One run's accepted `maxTps` behavior therefore depends on traffic from an earlier run or on catalog/diagnostic calls. The slice-3 reviewer reproduced this with a frozen clock and two distinct run IDs each carrying `maxTps: 1`: the first run's first request confirmed while the second run's first request was immediately `throttled` because it inherited the exhausted bucket. A newly started run can spend its retry budget before fractional tokens refill, and raising a later run's cap begins with the prior smaller token balance.

Key limiter state by run identity (with bounded terminal-run eviction), or explicitly reset it on a safe, authenticated run-lifecycle handoff, keeping a separate bucket for global diagnostic/catalog behavior.

Test gap: add a test alternating distinct run IDs at a fixed clock asserting each begins with independent capacity, plus a same-run test retaining the shared cap within that run.

### F24 — Reset and recovery do not stop the active k6 process (Medium)

**Slices:** 4

Admin reset force-fails the database run, clears the order queue, and deletes live Redis state, but never contacts the load orchestrator (`apps/api/src/app/services/reset-service.ts:282`, `apps/api/src/app/services/reset-service.ts:309`, `apps/api/src/app/services/reset-service.ts:322`). Startup reconciliation has the same ownership gap. The orchestrator exposes only start and status routes (`apps/load-orchestrator/src/app/routes/run-control.ts:40`, `apps/load-orchestrator/src/app/routes/run-control.ts:75`), while its spawned execution continues independently (`apps/load-orchestrator/src/app/services/traffic-execution-service.ts:310`).

Reset returns success and the failed status permits a new run immediately, even though the old k6 process may continue sending thousands of requests. Old requests fail closed after Redis teardown, but they still consume API/listener capacity and can overlap the next benchmark, corrupting its delivery and latency story. An API restart can likewise fail an active run and allow a replacement while the old load continues.

Add an idempotent orchestrator cancellation endpoint and make the runner own a kill/abort handle. Reset and interrupted-run recovery should request cancellation, wait for a terminal traffic acknowledgement within a bounded timeout, record the result, and only then release the one-run gate (or clearly fail closed).

Test gap: add an end-to-end reset-during-active-traffic test proving no old requests occur after reset completes and no replacement starts while cancellation is unresolved.

### F25 — Every HTTP 409 is classified as expected traffic (Medium)

**Slices:** 4

The generated k6 script marks the entire 409 status class as expected without inspecting the response code (`apps/load-orchestrator/src/app/k6/script-generator.ts:161`, `apps/load-orchestrator/src/app/k6/script-generator.ts:165`). The API uses 409 not only for the expected sold-out result but also for `not_initialized` and `idempotency_conflict`, which the Redis gate explicitly distinguishes (`packages/db/src/inventory/reservation-gate.ts:22`, `packages/db/src/inventory/reservation-gate.ts:27`). Traffic delivery then treats `http_req_failed.count` as the unexpected-response count (`apps/api/src/app/services/traffic-completion-ingestion-service.ts:126`).

A run where every request hits missing eligibility, a wrong run/sale pair, or idempotency conflicts can therefore show zero unexpected responses and `complete` delivery as long as k6 emitted the planned number of requests. This masks F1 and other correctness failures as a clean benchmark.

Parse the small buy response and record a custom outcome/check metric: only documented expected business outcomes (notably `sold_out`, plus successful reservation/replay responses) should be non-failures; treat `not_initialized`, run mismatch, malformed responses, and unexpected idempotency conflicts as traffic failures.

Test gap: the real-k6 test passes a bare 409 stub and labels it sold-out (`apps/load-orchestrator/tests/k6-roundtrip.integration.test.ts:165`, `apps/load-orchestrator/tests/k6-roundtrip.integration.test.ts:169`); the script unit test asserts only that 409 appears (`apps/load-orchestrator/tests/script-generator.unit.test.ts:126`). Add separate real-script cases for sold-out, not-initialized, idempotency conflict, and an arbitrary 409.

### F26 — Reconnect recovery leaves most live panels stale (Medium)

**Slices:** 5

The browser's recovery operation refreshes only `state.recovery`. `LiveWatch` accepts inventory, queue, and ERP as one-time server-rendered props (`apps/web/components/watch/live-watch.tsx:55-69`), and `recovery-complete` replaces only the recovery object (`apps/web/lib/dashboard-state.ts:307-315`). An SSE gap can lose absolute `inventory.updated` or `queue.depth` events and ERP/consistency-lag updates permanently: reconnect invokes `fetchDashboardRecovery`, but the inventory, queue, ERP, and lag panels keep their pre-disconnect values (`apps/web/components/watch/live-watch.tsx:78-111`, `apps/web/components/watch/live-watch.tsx:133-139`). The first EventSource open also deliberately skips recovery (`apps/web/components/realtime/use-dashboard-events.ts:85-94`), leaving a race between the server-side reads and the browser subscription.

This contradicts the intended latest-state model and can make a reconnected dashboard claim stock or queue depth is unchanged after the backend has moved on. The existing recovery test pins the defect: after discarding an inventory event and completing two recovery reads, it expects the old remaining stock to stay displayed (`apps/web/tests/live-watch-recovery.test.tsx:292-324`).

Make the client recovery result cover every displayed latest-state projection — either one aggregate same-origin snapshot or refetching recovery, inventory, queue, ERP, and consistency lag together. Subscribe first, then establish an initial authoritative baseline, preserving the discard/follow-up window while the baseline is in flight.

Test gap: add reconnect and initial-open race tests that advance every panel from backend truth after missed events; do not assert that discarded inventory remains stale.

### F27 — The global realtime feed is applied without run or sale-offer scoping (Medium)

**Slices:** 5

All API and worker events share one Redis channel and SSE stream, and the browser subscribes to every event name (`apps/web/components/realtime/use-dashboard-events.ts:83-109`). Although business and metric events carry `runId` and/or `saleOfferId`, `handleEvent` dispatches every valid event unconditionally (`apps/web/components/watch/live-watch.tsx:96-103`), and the reducer applies inventory, order, ERP, notification, and lag events without comparing their identity to `recovery.currentRun.runId` or the watched sale offer (`apps/web/lib/dashboard-state.ts:328-425`). Even a terminal event for an unrelated run triggers a recovery.

Catalog traffic, a late event from the previous run, or another producer's run-attributed event can drain the displayed stock, inflate current-run counters, or replace the current run's consistency-lag signal.

Track the authoritative current `runId` and watched `saleOfferId` in the client model and reject mismatched run-scoped events before reduction. Treat intentionally global signals such as total queue depth explicitly rather than implicitly accepting every optional/missing `runId`, and trigger terminal recovery only for the current run's events.

Test gap: tests construct only events for the same `RUN`/`SALE` fixture (`apps/web/tests/dashboard-state.test.ts:247-365`; `apps/web/tests/live-watch-integration.test.tsx:95-151`). Add negative reducer/integration tests for a previous run, a catalog/null-run order, and a different sale offer.

### F28 — The dashboard ignores the authoritative traffic metrics (Medium)

**Slices:** 5

The recovery contract supplies the latest request-rate, HTTP latency, and failure-rate snapshot, and the SSE contract publishes the corresponding `traffic.*` events. The web state has no traffic view model: `initialWatchState` discards `recovery.data.trafficMetrics` and the reducer's default branch explicitly ignores those events as future work (`apps/web/lib/dashboard-state.ts:264-286`, `apps/web/lib/dashboard-state.ts:427-433`). `RequestSurgePanel` instead calculates attempts only from reservation events received since the page loaded (`apps/web/components/watch/request-surge-panel.tsx:12-21`, `apps/web/components/watch/request-surge-panel.tsx:36-80`).

A viewer who opens `/watch` after the one-second spike, refreshes during draining, or misses Pub/Sub frames sees `0` and "No buyer traffic observed yet" even when recovery contains a completed 10,000-request burst. The count also omits idempotent replays and non-sold-out/non-secured outcomes, so it is not an HTTP request count. Session-local hints become the dashboard's headline traffic truth, hiding under-delivery, latency, and unexpected failures.

Add a traffic view model seeded from `DashboardRecoveryResponse.trafficMetrics`, reconcile the three traffic event variants by run ID, and render scheduled/actual request rate, latency, and failure rate separately from reservation outcomes.

Test gap: add a mid-run/after-spike initial-load test and a reconnect test where no live traffic event is replayed but recovered metrics still render.

### F29 — Documented deployment safety caps are compile-time constants (Medium)

**Slices:** 5, 7

The operational contract says dangerous-control caps come from environment variables validated at startup (`docs/admin_access_protection.md:94-108`), and the configuration reference presents seven `DEMO_MAX_*` values as API safety caps (`docs/local_development.md:417-423`); the contract comments likewise describe deployment hard caps as environment-backed (`packages/contracts/src/demo-control.ts:203-205`, `packages/contracts/src/demo-control.ts:305-315`). The API configuration parses none of them — `parseConfig` has no buyer, request, duration, start-delay, or VU cap fields and ends at run finalization timing (`apps/api/src/app/config.ts:8-69`, `apps/api/src/app/config.ts:107-143`). Run start validates against the compile-time `DEFAULT_DEMO_TRAFFIC_HARD_CAPS` (`apps/api/src/app/services/demo-run-start-service.ts:319-345`), and admin preset save uses the same constant (`apps/api/src/app/services/preset-management-service.ts:61-92`).

A deployment operator can lower these environment values believing they bound public and admin traffic, but the API still accepts snapshots up to the hardcoded defaults (100,000 buyers/requests, 10,000 requests per second/VUs, 300 seconds). The failure is silent: startup validation succeeds, saves above the configured limit succeed, and starts accept them. This defeats the server-side backstop against an admin typo, compromised session, or undersized deployment, and the related public-policy seeding defaults are hardcoded too (see F17).

Parse and validate `DemoTrafficHardCaps` in the API composition root, inject the result into preset management and run start, and eliminate direct use of the default constant outside config construction/tests. Reject policy updates above the injected caps and validate relationships such as `maxVus >= preAllocatedVus`.

Test gap: no current test can exercise a non-default deployment cap because the services have no such dependency. Add config tests for every variable and API integration tests that set a lower-than-default cap and reject both a save and a start above it.

### F30 — Public callers can apply custom overrides to curated presets outside public-custom policy (Medium)

**Slices:** 5

The route correctly derives a public principal unless a valid service token accompanies the admin header (`apps/api/src/app/routes/demo-run-start.ts:26-47`), but the start service merges `input.runScopedConfig` into every preset before validation (`apps/api/src/app/services/demo-run-start-service.ts:319-345`). The stricter persisted public-runtime-policy limits are applied only when the selected slug is exactly `public-custom` (`apps/api/src/app/services/demo-run-start-service.ts:348-367`); non-custom public presets are constrained only by the much larger deployment hard caps.

This violates the server-side invariant that public configuration is accepted only through the bounded `public-custom` flow. Any public-boundary path that can submit the shared start contract with a valid signed visitor identity can take a curated preset and replace its traffic, inventory, ERP, and backpressure configuration — turning a safe curated start into a 100,000-buyer or high-chaos run up to `DEFAULT_DEMO_TRAFFIC_HARD_CAPS` (whose values are themselves not deployment-tunable; see F29).

For a public principal, reject `runScopedConfig` unless the resolved preset is `public-custom`, then always validate the accepted custom configuration against the active policy. Admin principals may retain hard-cap-bounded overrides.

Test gap: current override coverage exercises only `public-custom` (`apps/api/tests/demo-run-start.integration.test.ts:514-566`). Add a test submitting an otherwise-valid override against `preview-1k` expecting a stable 403/400, plus public-custom acceptance and admin override tests.

### F31 — Run History has no pagination, arbitrary detail, or usable admin deletion UI (Medium)

**Slices:** 5

The public reader always requests one fixed endpoint with no cursor/page parameters (`apps/web/lib/api-client.ts:352-369`), while the contract hard-limits it to the newest 25 and defers older history (`packages/contracts/src/run-summary.ts:456-474`). The page renders all rows as inert text with expanded outcomes for only the first three; no run links or arbitrary detail route exist (`apps/web/app/run-history/page.tsx:61-105`), and the API registers only list GET plus deletion mutations, not an individual detail GET (`apps/api/src/app/routes/run-history.ts:35-79`).

Admin-protected delete proxy routes exist (`apps/web/app/api/admin/run-history/[runId]/route.ts:16-28`, `apps/web/app/api/admin/run-history/delete/route.ts:18-36`), but neither `/run-history` nor `/admin` renders controls that call them (`apps/web/app/run-history/page.tsx:19-46`, `apps/web/app/admin/page.tsx:61-76`). Older retained summaries become inaccessible after 25 runs, arbitrary completed-run detail is unavailable, and the documented one/selected/all deletion workflow — including delete-all confirmation — cannot be used from the admin surface.

Add cursor pagination and an individual public-safe summary-detail endpoint/page linking every row by run ID. Add an authenticated admin management view with one/selected/all deletion and explicit confirmation for all, refreshing the public-safe list after success.

Test gap: cover page traversal, detail DTO parsing, anonymous deletion rejection at the browser boundary, selection behavior, and the delete-all confirmation value.

### F32 — The admin login endpoint has no online-guessing protection (Medium)

**Slices:** 5

`POST /api/admin/login` parses and compares every submitted passphrase and immediately returns 401 on a mismatch (`apps/web/app/api/admin/login/route.ts:24-53`). There is no attempt budget, delay, lockout, shared limiter, or caller identity at this route, and the reference Caddy configuration applies no rate limiting before forwarding all non-SSE traffic to the web service (`infra/caddy/Caddyfile:12-25`).

The passphrase is the sole human credential guarding reset, destructive cleanup, ERP outages, preset mutation, and history deletion. An internet-facing deployment permits unlimited online guessing; a compromised passphrase grants all those controls even though downstream service tokens remain hidden.

Add a server-side login-attempt limiter keyed by a deployment-trusted client identity plus a global window, with conservative failure responses and successful-login reset semantics. Use an injected/shared store for multi-instance deployments and document trusted-proxy header handling.

Test gap: existing admin-access tests cover cryptographic session behavior only. Add tests for threshold enforcement, window expiry, distinct principals, global protection, and fail-closed behavior when the limiter is unavailable.

### F33 — The web type-check can consume stale or missing contract artifacts (Medium)

**Slices:** 6, 7

`apps/web/tsconfig.json:4-13` declares a local `compilerOptions.paths` containing only `@/*`. TypeScript replaces rather than deep-merges the root `paths` object, so the effective web configuration loses the source mappings for `@checkout-surge/contracts`, `@checkout-surge/logger`, and `@checkout-surge/db` defined at `tsconfig.json:20-27` (`tsc --showConfig` confirmed only the `@/*` mapping). The web program consequently resolves `@checkout-surge/contracts` through the package manifest, whose public type entry is the ignored build artifact `packages/contracts/dist/index.d.ts` (`packages/contracts/package.json:6-15`).

`turbo.json:11-14` neither makes `type-check` depend on dependency builds nor includes dependency sources as inputs. On a clean checkout `dist` is absent; in the audited workspace it was stale, and `pnpm --filter @checkout-surge/web type-check` reported dozens of current contract exports as missing. A cached web type-check can also stay green after a contract source change because contract sources are not task inputs.

Restore the shared source mappings in the web config alongside `@/*`, or if package artifacts are intentionally required, make type-check depend on `^build` with explicit outputs/inputs and ensure a clean checkout works.

Test gap: add a clean-worktree command-contract test that removes generated outputs, changes a shared type, and proves the web type-check both runs and observes the change.

### F34 — Reachable HTTP errors bypass the canonical error contract (Medium)

**Slices:** 5, 6

The canonical error schema restricts `code` to the shared vocabulary and requires `message`, `correlationId`, and `timestamp` (`packages/contracts/src/errors.ts:85-129`). The SSE route instead uses an untyped `string` helper and emits `realtime_not_configured` and `realtime_at_capacity` (`apps/api/src/app/routes/dashboard.ts:63-77`), neither of which appears in `ERROR_CODES` (`packages/contracts/src/errors.ts:26-72`); a direct schema probe confirmed the actual 503 body is rejected by `ErrorPayloadSchema`.

The same-origin admin boundary has a second incompatible family: anonymous and malformed requests return `{ ok: false, code, message }` without trace/time fields, while proxy failures return only `{ ok: false, reason }` (`apps/web/lib/admin-proxy.ts:15-47`; examples at `apps/web/app/api/admin/runs/start/route.ts:24-31` and `apps/web/app/api/admin/run-history/delete/route.ts:18-28`). Clients receive incompatible error payloads depending on which hop rejected the same logical action, and web-local failures have no correlation ID for support or audit tracing.

Add the SSE availability codes to the shared vocabulary (or map them to an existing stable code), construct every API response with a shared error builder, and give the web boundary a canonical-error adapter that adopts/generates and forwards `x-correlation-id`.

Test gap: the SSE test asserts only the local string (`apps/api/tests/dashboard-realtime.integration.test.ts:205-215`) and the proxy tests pin the non-canonical shape (`apps/web/tests/admin-proxy.test.ts:42-52`, `apps/web/tests/admin-proxy.test.ts:63-80`). Add parse assertions for every non-2xx API and same-origin route branch, including unreachable and non-JSON upstream failures.

### F35 — Run IDs are logged as correlation IDs during finalization and reset (Medium)

**Slices:** 6

`withCorrelationId` always binds its second argument under the canonical `correlationId` field (`packages/logger/src/logger.ts:65-71`). The finalization service repeatedly passes `run.runId` to it for failures, terminal transitions, realtime publication, and completion (`apps/api/src/app/services/run-finalization-service.ts:200-208`, `apps/api/src/app/services/run-finalization-service.ts:397-423`, `apps/api/src/app/services/run-finalization-service.ts:434-485`). The reset service does the same with `current.runId` even though it holds the originating admin-request correlation at `options.correlationId` (`apps/api/src/app/services/reset-service.ts:268-291`, `apps/api/src/app/services/reset-service.ts:296-304`).

Those log lines claim a run UUID is a request trace ID. During admin reset this discards the actual cross-service trace; during background finalization it fabricates a correlation. Searching by the correlation returned to the operator misses the destructive reset/finalization logs, while searching the fabricated value can group unrelated background work as one request.

Use the request correlation ID for reset logs and keep `runId` as its own structured field; background poller work should use the base logger plus `runId` or an explicitly named operation ID.

Test gap: logger tests verify only the generic child helper (`packages/logger/tests/logger.test.ts:68-89`). Add service-level log-capture tests proving reset preserves the supplied correlation and poller logs do not bind a run ID as a correlation.

### F36 — The realtime schema accepts contradictory and untraceable business events (Medium)

**Slices:** 5, 6

`DashboardRealtimeEventSchema` discriminates on `event`, but every order event reuses the same payload schema (`packages/contracts/src/dashboard-events.ts:125-148`) whose `toStatus` is any order status (`packages/contracts/src/lifecycle.ts:145-154`), and the same broad run payload is reused for all five `run.*` events (`packages/contracts/src/dashboard-events.ts:173-198`, `packages/contracts/src/dashboard-events.ts:79-85`). The contract accepts an `order.queued` event with `toStatus: "confirmed"` and a `run.completed` event with `status: "active"` — both confirmed by direct `safeParse` probes. The envelope also makes `correlationId` optional for every event (`packages/contracts/src/dashboard-events.ts:94-97`), including correlated business facts, and independently repeats `runId` in envelope and payload without checking equality.

The Redis fanout and browser both trust this schema as their validation gate (`apps/api/src/app/dashboard-realtime/fanout.ts:104-123`, `apps/web/components/realtime/use-dashboard-events.ts:127-137`), so a producer regression can be schema-valid, reach browsers, increment the wrong live counters, and lose its trace/run attribution.

Give each lifecycle event a payload with the matching literal status, require `correlationId` for correlated business facts, and refine repeated run IDs (and repeated metric timestamps/names) to agree, keeping correlation optional only for genuinely aggregate/background signals.

Test gap: existing tests cover unknown event names and wrong delivery vocabulary but not these relational invariants (`packages/contracts/tests/schemas.test.ts:269-349`). Add negative contract tests for event/status mismatch, envelope/payload run mismatch, and missing business correlation.

### F37 — `runtime:up` can report healthy before the database schema exists (Medium)

**Slices:** 7

README and the local runtime guide tell a new user to run `pnpm runtime:up` before `pnpm runtime:setup` (`README.md:86-95`, `docs/local_development.md:59-69`). `runtime:up` uses Compose `--wait` (`package.json:31`), and API health must reach `/health/ready` (`docker-compose.yml:95-100`) before the load orchestrator, web, and Caddy start (`docker-compose.yml:142-144`, `docker-compose.yml:177-180`, `docker-compose.yml:198-202`). On a fresh PostgreSQL volume the API deliberately survives missing lifecycle tables during startup reconciliation (`apps/api/src/app/services/run-lifecycle-service.ts:85-100`), but readiness executes only `select 1` (`apps/api/src/app/services/readiness-service.ts:18-33`), which succeeds on an unmigrated database.

Compose therefore marks the API healthy and brings up the full runtime even though every table-backed API read fails: `runtime:up --wait` reports a healthy topology before setup has installed the schema, and the dashboard becomes reachable in a broken, not-ready-for-demo state.

Preserve the non-mutating `runtime:up` boundary, but make bootstrap explicit and truthful: document `runtime:setup` before `runtime:up` for a first boot, or add a schema/migration-version readiness check so `--wait` cannot succeed pre-setup (in which case the quick-start order must be reversed to avoid the command blocking before users reach setup).

Test gap: add a clean-volume bootstrap smoke test proving the exact documented command sequence and a readiness test for an empty but reachable database.

### F38 — Compose discards most documented service configuration overrides (Medium)

**Slices:** 7

Compose only passes a small fixed environment subset into each container: API receives connection URLs, orchestrator URL, CORS origin, host, and port (`docker-compose.yml:79-87`); worker receives URLs, host, and health port (`docker-compose.yml:109-115`); Mock ERP only the shared token/logging plus host/port (`docker-compose.yml:59-62`); load orchestrator only the API URL plus host/port (`docker-compose.yml:137-141`). Compose variable substitution does not forward the rest of the host/root `.env`.

A concrete correctness failure is `PUBLIC_CLIENT_COOKIE_SECRET`: Compose gives the configured value to web (`docker-compose.yml:161-164`) but not the API, even though the API verifies web-signed visitor IDs with that same secret (`apps/api/src/app/config.ts:41-48`, `apps/api/src/app/config.ts:129-130`). Replacing the sentinel as instructed makes web and API disagree, breaking authenticated visitor attribution and public run starts. More broadly, documented and parsed container settings — `API_LISTEN_BACKLOG`, PostgreSQL pool sizes, SSE limits, worker concurrency/retry/circuit settings, Mock ERP behavior/caps, orchestrator timeouts/gates — always use code defaults in the reference runtime (`apps/api/src/app/config.ts:117-140`, `apps/worker/src/app/config.ts:100-107`, `apps/mock-erp/src/app/config.ts:113-127`, `apps/load-orchestrator/src/app/config.ts:143-160`), with no warning when users put documented values into `.env`.

Map every supported container-runtime setting explicitly with `${VAR:-default}` (or reviewed service-specific `env_file` inputs with the same precedence and secret rules), keeping per-app examples aligned.

Test gap: static Compose validation proves syntax only. Add a Compose contract test that injects sentinel overrides and asserts the rendered `docker compose config` contains them.

### F39 — Host-native service and database commands do not load `.env` (Medium)

**Slices:** 7

The host-native guide promises that `dev`, migration, and seed commands automatically load the root `.env` through `scripts/run-with-env.mjs` (`docs/local_development.md:20-24`), and per-app environment examples repeat that contract (`apps/api/.env.example:5-8`, `apps/worker/.env.example:5-7`). The root `dev:*` commands directly invoke filtered package scripts without the loader (`package.json:24-28`), those app scripts directly run `tsx` (`apps/api/package.json:7-10`, `apps/worker/package.json:7-10`, `apps/mock-erp/package.json:7-10`, `apps/load-orchestrator/package.json:7-10`), and DB migrate/seed invoke Node directly (`packages/db/package.json:20-26`).

The documented clean workflow (`cp .env.example .env` then a host-native backend command) fails unless the shell already exports the same variables. A direct probe from the API package with `DATABASE_URL`, `REDIS_URL`, and `CONTROL_SERVICE_TOKEN` unset printed `{}`, confirming pnpm does not load the root file for filtered scripts; API/worker then fail required-variable parsing and DB migrate/seed fail their URL requirement.

Wrap each package's host-native entry point with the loader (letting its working directory participate in app-specific env precedence), or introduce a single root launcher that resolves the target package before loading files.

Test gap: add subprocess command-contract tests from a clean environment placing marker values in temporary root/app env files and asserting each dev/migrate/seed entry point receives the documented precedence.

### F40 — Worker readiness stays green when PostgreSQL or Redis is unreachable (Medium)

**Slices:** 7

Worker readiness names its checks `database_url_configured` and `redis_url_configured` and marks them `ok` solely when a URL string and client object exist (`apps/worker/src/app/services/readiness-service.ts:25-46`); it never executes a PostgreSQL query or Redis ping. Its queue-consumer check only calls BullMQ's process-local `isRunning()` (`apps/worker/src/app/services/readiness-service.ts:57-63`), which says the Worker object has not been paused/closed, not that a dependency round trip succeeds. The composition root creates lazy clients and the BullMQ worker before starting the health server (`apps/worker/src/index.ts:39-47`, `apps/worker/src/index.ts:137-185`).

If PostgreSQL or Redis becomes unavailable after container startup, `/health/ready` can keep returning HTTP 200 while no orders can be consumed or persisted. Compose and both health scripts trust that endpoint (`docker-compose.yml:125-130`, `scripts/health-check.mjs:23-32`, `scripts/runtime-smoke.mjs:47-56`), so operators receive an all-green runtime while queued orders cannot progress — compounding F22's producer-side blindness.

Probe PostgreSQL and Redis with bounded real round trips and expose consumer connectivity/ready state rather than object lifecycle. Queue storage and durable order storage are required dependencies for this worker; decide separately whether a transient ERP outage is degraded or unavailable.

Test gap: existing readiness tests use empty object stubs and assert only check names/schema (`apps/worker/tests/readiness-service.unit.test.ts:50-97`), pinning the false positive. Add integration tests that disconnect each dependency after constructing the worker and assert readiness becomes 503.

### F41 — `.env.test` cannot override the committed test defaults (Medium)

**Slices:** 7

The test infrastructure contract says `.env.test.example` is the baseline and optional `.env.test` overrides ports or credentials (`docs/automated_testing_infrastructure.md:22`, `docs/automated_testing_infrastructure.md:115-119`; also `.env.test.example:1-8`). The loader applies the example first and the override second, using `applyIfUndefined` both times (`scripts/run-with-test-env.mjs:58-70`). Since the example already defines every standard key, later `.env.test` values are always ignored unless a key is absent from the committed example.

This breaks the documented `TEST_POSTGRES_HOST_PORT` workflow and can direct a test command at the default port/project even when the contributor deliberately configured an isolated alternative. At best tests fail to connect; at worst another checkout's test service listening on the default port receives the destructive test setup (compounding F18).

Build a fresh file-derived environment in low-to-high precedence order (example, then `.env.test`, then the original shell environment), or add an explicit overwrite mode for the local override before restoring shell values.

Test gap: there are no tests for either env-loader script. Add loader subprocess tests covering shell > `.env.test` > `.env.test.example` precedence, package URL rewriting, malformed URLs, and isolation rejection.

### F42 — `type-check:test` succeeds without checking any test code (Medium)

**Slices:** 7, 8

The root command is `turbo type-check:test` (`package.json:14`) and Turbo defines the task (`turbo.json:16-19`), but no workspace package defines a `type-check:test` script — package script blocks include only source `type-check` (`apps/api/package.json:7-11`, `apps/web/package.json:7-13`, `packages/db/package.json:20-26`, `packages/contracts/package.json:19`), and their TypeScript configs include only `src` (`apps/api/tsconfig.json:7`, `packages/contracts/tsconfig.json:7`). Running `pnpm type-check:test` on this branch exits 0 with Turbo warning `No tasks were executed as part of this run` and `0 total` — confirmed independently by both the slice-7 and slice-8 audits.

The command is documented as a real repository check (`docs/local_development.md:291-294`), so CI/reviewers get a false green while test-only TypeScript errors — drifting fixtures, mocks, and helper APIs — remain undiscovered. Vitest transpilation is not a substitute for static type checking.

Add test-aware tsconfigs and `type-check:test` scripts (including Vitest/Node types and source aliases) to every package that owns tests, or replace the Turbo task with explicit root test tsconfig projects.

Test gap: add a command-contract check that fails when a required Turbo task resolves to zero package tasks.

### F43 — The root full-suite command omits the only real-k6 integration lane (Medium)

**Slices:** 7, 8

`pnpm test` runs unit, API, worker, and DB integration lanes but never invokes the existing `test:load-orchestrator` command (`package.json:19`, `package.json:40-43`), and the root unit config explicitly excludes every `*.integration.test.ts` (`vitest.config.ts:28-44`), so `apps/load-orchestrator/tests/k6-roundtrip.integration.test.ts` is not picked up indirectly. That file contains the repository's only real generated-script/k6/output roundtrip guarantees and explicitly says a missing k6 must fail loudly rather than silently pass (`apps/load-orchestrator/tests/k6-roundtrip.integration.test.ts:1-16`).

The standalone command is also mismatched with the reference environment: it searches the host `PATH` (`apps/load-orchestrator/tests/k6-roundtrip.integration.test.ts:34`), while the reference design installs k6 only in the load-orchestrator image (`apps/load-orchestrator/Dockerfile:4`, `apps/load-orchestrator/Dockerfile:51`). During the audit, `pnpm test:load-orchestrator` failed both tests because k6 was absent from the workspace host. A normal green `pnpm test` therefore says nothing about the real k6 boundary, and the dedicated command is not runnable in the documented reference setup; a script-generation or expected-409 metric regression (see F25) can survive all standard automated checks.

Run the small functional round trip inside the pinned load-orchestrator image and make that containerized lane an explicit required verification command — either included in `pnpm test` or a clearly defined separate required command, with any convenience skip explicit in the overall test summary (the file already offers `LOAD_ORCHESTRATOR_SKIP_K6` as an explicit opt-out).

Test gap: add a root command-contract test that enumerates/invokes every registered integration lane.

### F44 — Integration locks cannot recover after an interrupted test process (Medium)

**Slices:** 8

Every API integration-test file calls `setupApiIntegrationEnv()` at module load and acquires a per-database file lock before it can register tests (`apps/api/tests/helpers.ts:63`, `apps/api/tests/helpers.ts:70`). The lock file records the owner PID, but the `EEXIST` path never reads that PID or checks whether the owner still exists; it simply polls for up to 120 seconds (`packages/db/src/reset.ts:69`, `packages/db/src/reset.ts:71`, `packages/db/src/reset.ts:74`, `packages/db/src/reset.ts:88`). The only normal cleanup is each file's `afterAll` teardown (`apps/api/tests/helpers.ts:86`), so a killed Vitest worker, terminal interruption, crash, or OOM leaves a permanent lock.

This happened during the audit: `/tmp/checkout-surge-test-checkout_surge_test_api.lock` contained a dead PID, after which `pnpm test:api` spent 120 seconds waiting and began reporting many files as `(0 test)`. Vitest is also left at default file parallelism (`vitest.integration.config.ts:22`, `vitest.integration.config.ts:26`), so many workers can wait on the same stale lock and fail in waves. A prior interrupted run makes the advertised full suite unusable until someone knows to delete an undocumented file in `/tmp`.

Serialize each package's integration files in Vitest (`fileParallelism: false` or a single worker), acquire/release the package lock once in global setup/teardown, and make the lock recover stale owners using a verified PID/lease strategy, registering cleanup for process signals where practical.

Test gap: add a focused test that acquires the lock in a child process, exits without release, and proves the next process can safely reclaim it.

### F45 — Known races make the fast unit lane nondeterministic and skip the web suite (Medium)

**Slices:** 8

The load orchestrator marks an execution `succeeded`/`failed` before awaiting its traffic-completion report (`apps/load-orchestrator/src/app/services/traffic-execution-service.ts:228`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:257`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:262`), and its unit test waits only for that earlier terminal state before immediately expecting one report (`apps/load-orchestrator/tests/traffic-execution-service.unit.test.ts:292`, `apps/load-orchestrator/tests/traffic-execution-service.unit.test.ts:312`). The audit reproduced the race directly: the root unit lane finished with 585 passes and this one failure (`expected [] to have a length of 1`); the slice-1 audit observed the same timing-sensitive failure once on first run.

A second known flake mutates a random signed visitor value by replacing its last character with `0` (`packages/contracts/tests/admin-access.test.ts:94`, `packages/contracts/tests/admin-access.test.ts:97`); since `signVisitorId()` generates a random UUID (`packages/contracts/src/admin-access.ts:91`), the derived HMAC already ends in `0` about one run in sixteen, making the alleged tampering a no-op. Both flakes are acknowledged in the repository's own notes (`working_docs/implementation_notes/phase-10.md:43`). Additionally, `test:unit` joins the root and web lanes with `&&` (`package.json:20`), so either backend flake prevents the entire (healthy, 202/202) frontend suite from running.

Expose/await a completion promise or poll the completion sink before asserting the report, without arbitrary sleeps. For signature tampering, use a fixed visitor ID and deterministically toggle the final nibble so the value always changes. Keep the web lane independently visible in orchestration so one package's failure does not erase another package's results.

## Low-severity findings

### F46 — Idempotency keys are effectively unbounded (Low)

**Slices:** 1, 6

The shared `IdempotencyKey` schema requires only a non-empty string (`packages/contracts/src/common.ts:36`), and `/buy` passes it directly into both the Redis key name and the JSON idempotency value (`packages/contracts/src/buy.ts:87`, `packages/db/src/inventory/reservation-gate.ts:287`, `packages/db/src/inventory/reservation-gate.ts:444`). Fastify's overall body limit is the only practical ceiling. Large accepted keys consume their size twice in Redis for an hour and add command/key parsing cost to the critical path — an avoidable memory/latency amplification vector when repeated across available stock.

Set a small explicit UTF-8 byte/character limit (for example 128 or 256), document the allowed format, and keep the same shared schema across k6 and the API. Add contract and route tests for the maximum and over-limit cases.

### F47 — `preview-1k` does not implement the documented buyer spike (Low)

**Slices:** 2, 7

The runtime contract says `preview-1k`, `surge-5k`, and `surge-10k` are buyer-spike presets (`docs/runtime_topology.md:182`). The seed defines `preview-1k` as `steady-arrival-rate` at 1,000 requests per second for one second (`packages/db/src/seed-data.ts:81`, `packages/db/src/seed-data.ts:88`, `packages/db/src/seed-data.ts:90`), exercising scheduler-driven arrival traffic rather than the concurrent buyer-spike behavior advertised by the public preset progression.

Choose one contract and align seed, UI copy, and docs — most plausibly change `preview-1k` to a buyer spike with `buyerCount: 1000`, retaining a separate admin steady-arrival preset for calm smoke validation.

Test gap: the seed test verifies only canonical traffic modes and the idempotency preset's 200 attempts (`packages/db/tests/seed.integration.test.ts:124`). Add an exact public-preset contract table test covering slug, visibility/editability, traffic mode, planned attempts, starting stock, and duplication semantics for all five public presets.

### F48 — Short/final metric windows use the full polling interval (Low)

**Slices:** 4

Every streamed metric flush is told its samples cover exactly `metricStreamIntervalMs / 1000`, including the immediate flush when the k6 promise wins the race and the final flush after exit (`apps/load-orchestrator/src/app/services/traffic-execution-service.ts:205`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:209`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:216`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:226`). The aggregator divides the observed request count by that fixed duration (`apps/load-orchestrator/src/app/k6/metrics-aggregator.ts:71`, `apps/load-orchestrator/src/app/k6/metrics-aggregator.ts:77`). A one-second buyer spike that exits after 200 ms has its final window reported as a full second, under-reporting the live request rate by 5x; non-integral polling delays similarly distort intermediate windows. The immutable total request count remains correct.

Track elapsed monotonic time per reader flush or derive the span from k6 sample timestamps, with a defined minimum duration for same-instant bursts. Add fake-clock tests for a run completing before the first polling interval and a short final partial window.

### F49 — An invalid visitor cookie permanently blocks public starts in that browser (Low)

**Slices:** 5

`resolveVisitorId` claims it replaces a missing or unverifiable cookie, but it returns any existing cookie without verification (`apps/web/app/actions.ts:22-38`), never calling the available `verifyVisitorCookie` helper (`apps/web/lib/visitor-id.ts:45-54`). The API correctly rejects the forwarded malformed/stale signature, and subsequent attempts keep forwarding the same value. A truncated cookie, signing-secret rotation, or conflicting same-name cookie leaves that visitor receiving 403 on every public start until they manually clear cookies or the one-year cookie expires — a fail-closed posture with a broken recovery path, not a budget bypass.

Verify the existing value server-side with the current secret and, if invalid, issue a fresh signed visitor cookie before forwarding.

Test gap: current tests verify the helper in isolation but never the action's existing-cookie branch (`apps/web/tests/admin-access.test.ts:127-149`). Add coverage for valid reuse, malformed replacement, secret-rotation replacement, and signing unavailable.

### F50 — Curated start buttons remain enabled while another run is in progress (Low)

**Slices:** 5

The standalone Load-Run Controls panel reads recovery and disables its `preview-1k` trigger for `starting`, `active`, or `draining` (`apps/web/components/run-start-panel.tsx:48-70`, `apps/web/components/run-start-panel.tsx:78-100`). The primary curated cards do not read recovery and always render enabled `LoadRunTrigger`s, with a comment explicitly relying on the API rejecting an overlap (`apps/web/components/demo-picker.tsx:13-20`, `apps/web/components/demo-picker.tsx:22-46`). The API remains safe, but the main public controls disagree with server lifecycle state: users can click a prominent start and receive a rejection while a smaller duplicate control on the same page is disabled.

Pass the authoritative recovery state into the picker (or share a single start-control model) and disable every start affordance consistently. Add a component test rendering active and draining recovery snapshots asserting all curated triggers are disabled; existing picker tests cover only list filtering and button presence.

### F51 — Public and terminal DTO schemas do not enforce their advertised boundary invariants (Low)

**Slices:** 5, 6

The public preset response is an array of the generic preset definition (`packages/contracts/src/demo-control.ts:81-88`, `packages/contracts/src/demo-control.ts:585-598`), so it accepts `visibility: "admin"` and `isEditable: true` despite being the schema the browser trusts for the public-only list; the service filters correctly at query time (`apps/api/src/app/services/preset-management-service.ts:143-162`), but the contract would not catch a projection regression. Similarly, `DemoRunSummarySchema.status` uses the entire run lifecycle and `PublicRunSummaryDetailSchema` is a direct alias (`packages/contracts/src/run-summary.ts:404-435`, `packages/contracts/src/run-summary.ts:437-445`); direct probes confirmed Run History accepts an `active` summary, a failed summary with no reason, and a completed summary with a failure reason.

Define boundary-specific schemas: literal-public/read-only presets and a completed/failed discriminated union for summaries with coherent failure fields. Keep the implementation filters, but make the shared consumer boundary independently fail closed. Add negative tests for admin/editable rows in the public response and every non-terminal history status.

### F52 — Run-start privilege remains a required, ignored request-body field (Low)

**Slices:** 5, 6

The contract says privilege is derived from the trusted proxy/header and "never read from the body," yet `StartDemoRunRequestSchema` requires `operatorMode` (`packages/contracts/src/demo-control.ts:132-152`). The API parses the field and then ignores it in favor of the token/header-derived option (`apps/api/src/app/routes/demo-run-start.ts:26-47`, `apps/api/src/app/services/demo-run-start-service.ts:258-263`), so public and admin clients must send a privilege-looking field that is semantically meaningless (`apps/web/lib/api-client.ts:432-438`, `apps/web/components/admin/admin-run-start.tsx:33-42`), and a body containing only run intent fails validation.

This is not an escalation vulnerability — the server correctly ignores the value — but it makes the public contract misleading and encourages future code to treat an untrusted field as meaningful. Remove `operatorMode` from the request schema/type, keeping it only in trusted service options and the frozen response/snapshot. Update contract/API/web tests to prove an admin header plus token works with an intent-only body and a browser cannot assert privilege in JSON.

### F53 — The order-read API keeps a local schema and does not validate its response (Low)

**Slices:** 6

`GET /orders/:publicOrderId` has a stable cross-service HTTP response, but its schema is locally declared in the API service pending a promotion that never happened (`apps/api/src/app/services/order-query-service.ts:25-49`). The route sends the service object directly (`apps/api/src/app/routes/orders.ts:12-28`), the service never parses its constructed result through the local schema (`apps/api/src/app/services/order-query-service.ts:51-83`), consumers outside the API cannot import the contract from `@checkout-surge/contracts`, and the only schema tests import the private service module (`apps/api/tests/order-read-response-schema.unit.test.ts:1-12`).

Move the response schema/type and path constant into `packages/contracts`, return a parsed contract object at the service/route boundary, and update tests to import the public package, adding an HTTP response parse assertion covering every lifecycle status. This removes the sole production `z.object` schema found under the apps.

### F54 — Several service URLs are not validated at startup (Low)

**Slices:** 7

The load orchestrator correctly rejects a missing or invalid `API_BASE_URL` (`apps/load-orchestrator/src/app/config.ts:98-107`), but other services do not: API `LOAD_ORCHESTRATOR_BASE_URL` parsing silently replaces malformed input with localhost (`apps/api/src/app/config.ts:146-159`); the worker accepts any nonempty `DATABASE_URL`, `REDIS_URL`, and `MOCK_ERP_BASE_URL` string (`apps/worker/src/app/config.ts:45-51`, `apps/worker/src/app/config.ts:92-100`); web service URL getters return arbitrary strings (`apps/web/lib/config.ts:113-135`).

A typo can boot successfully, sometimes pass readiness (see F40), and fail only when a run is delegated, a job is processed, or an SSR/proxy request executes. The API fallback is especially confusing in a container because `localhost:4200` points back into the API container rather than at the Compose load-orchestrator service.

Validate required URL schemes/hosts in each composition root and throw a key-specific startup error; do not silently replace an explicitly malformed value with a default. Add config tests for malformed schemes, prohibited paths/credentials, container DNS URLs, and trailing-slash normalization.

## Notes — lower-confidence observations

### N1 — Run-summary immutability and JSON contract validity are application conventions

**Slices:** 2, 6

The unique constraint prevents duplicate summary rows and `writeRunSummary` uses first-write-wins insertion (`packages/db/src/run-lifecycle/run-finalization.ts:213`, `packages/db/src/run-lifecycle/run-finalization.ts:237`), but PostgreSQL does not prevent `UPDATE`, does not limit summary status to terminal values, and has no constraints validating the JSONB sub-summaries. The read adapter casts every JSONB field without parsing through `DemoRunSummarySchema` (`packages/db/src/run-lifecycle/run-finalization.ts:415`, `packages/db/src/run-lifecycle/run-finalization.ts:426`), so an out-of-band mutation would be returned by the public history endpoint as if valid. No current application path updates a summary, so this remains hardening rather than a confirmed behavior bug. Consider an update-rejection trigger and runtime parsing at write/read boundaries (see also F51 for the schema-side half of this boundary).

### N2 — Re-seeding resets catalog counters without reconciling related Redis keys

**Slices:** 2, 7

Every seed run overwrites the baseline catalog offer's live state back to full stock (`packages/db/src/seed-data.ts:413`, `packages/db/src/inventory/redis-keys.ts:171`), but `seedInventoryState` only `HSET`s the state hash (`packages/db/src/inventory/redis-keys.ts:191`); it does not remove existing reservation, expiry, pending-persistence, outcome, or idempotency keys. Re-running setup after manual/catalog activity could produce full counters alongside stale holds/replays. The run-scoped buy flow does not make catalog offers eligible, which limits present impact. If catalog inventory remains a supported seeded surface, make setup insert-only for existing Redis state or perform an explicit guarded full reset of owned keys.

### N3 — Terminal execution states accumulate for the lifetime of the orchestrator

**Slices:** 4

The process-local `runs` map adds or replaces state on every start and never evicts terminal entries (`apps/load-orchestrator/src/app/services/traffic-execution-service.ts:78`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:293`, `apps/load-orchestrator/src/app/services/traffic-execution-service.ts:320`). A long-lived public orchestrator can grow without bound, though each entry is small and the intended retention period for the debug status endpoint is undocumented. Define a bounded terminal-state TTL/LRU or persist status elsewhere if long-term lookup is required.

### N4 — The run snapshot duplicates starting stock without an equality invariant

**Slices:** 6

`DemoRunConfigSnapshotSchema` carries both top-level `startingStock` and `inventoryConfig.startingStock` (`packages/contracts/src/demo-control.ts:95-100`) and accepts different values. The creation path deliberately copies the same value into both (`apps/api/src/app/services/demo-run-start-service.ts:385-396`), but finalization/reset read the top-level copy (`apps/api/src/app/services/run-finalization-service.ts:130-134`, `apps/api/src/app/services/reset-service.ts:114-118`). If stored JSON or a future producer diverges, terminal inventory history can report a different starting allocation from the accepted inventory config while still parsing successfully. Prefer one field, or add a schema refinement and a negative contract test.

### N5 — Three reserved ERP metric names have no metric-sample or realtime-event shape

**Slices:** 6

The canonical vocabulary reserves `erp.circuit_open`, `erp.failure_rate`, and `erp.confirmation_latency` (`packages/contracts/src/vocabularies.ts:192-214`), but `MetricSampleSchema` covers only traffic, queue, inventory, and consistency-lag samples (`packages/contracts/src/load.ts:144-223`), and `DASHBOARD_EVENT_NAMES` has no `erp.*` metric events (`packages/contracts/src/dashboard-events.ts:39-67`). Current ERP health is exposed through a separate projection, so this may be an intentionally reserved future vocabulary. Either add the missing sample/event contracts and producers or document these names as summary/projection labels.

### N6 — Notification settlement is an adjudicated tradeoff; only the phase-plan checklist is stale

**Slices:** 3, 8

The slices disagreed on whether notification-less finalization is an open requirements conflict or an accepted design. Consolidation reading resolves it as the latter. `docs/core_business_entities.md:484` is not a passive acknowledgement — it explicitly states "Run finalization therefore does NOT wait for notifications in its settled gate," defines `notificationsRecorded` as a point-in-time best-effort count rather than a settled guarantee, and cites its own adjudication trail ("Issue 12, Finding 15"); the issue backlog was subsequently resolved and cleaned (commit `c07e0de`). The contradicting text lives in the phase-plan test checklist (`working_docs/project_planning.md:922`, "missing required notifications"), which predates that decision, and in the project description's tracking language (`working_docs/project_description.md:59`, `working_docs/project_description.md:112`). Post-adjudication entity documentation outranks a stale planning checklist, so the finalization suite's assertion that a confirmed order with no notification may finalize as completed (`apps/api/tests/run-finalization.integration.test.ts:891-913`) tests the intended behavior, matching the slice-3 assessment of an accepted best-effort tradeoff.

Remaining action is housekeeping only: update the phase-plan checklist and project-description wording to match the adjudicated behavior so future reviewers are not judged against the obsolete requirement.

## Appendix — Checked and found sound

**Reservation hot path (slice 1).** The stock decision, decrement, reserved-stock increment, hold write, expiry score, event write, and accepted idempotency record are one Redis Lua operation in the reference single-Redis topology; concurrent unique requests cannot oversell in the tested topology, including multi-unit all-or-nothing behavior. A fresh sold-out decision writes no PostgreSQL rows, per-request idempotency data, holds, or hot-path inventory events, and the Redis sold-out aggregate remains exact. Body/header `runId` disagreement is rejected before the reservation service and the buy route stays thin. When the durable transaction is the only failure, the response is `reservation_pending_persistence` with the hold preserved, and late duplicate reconciliation does not decrement stock again. Reservation, order, and opening order-event rows are written transactionally before queue publication; final ERP confirmation is not leaked into the synchronous buy response. Queue jobs use durable `orderId` as the BullMQ job ID and carry run, sale, reservation, quantity, and correlation identity. Infrastructure construction stays in the composition root, and the production listener uses the configured `API_LISTEN_BACKLOG` (default 8192).

**Persistence, domain state, and seeds (slice 2).** The generated-run context has unique ownership on both `run_id` and `sale_offer_id`. Hand-authored triggers reject catalog offers at context creation and reject missing/mismatched `run_id` values for generated-offer reservations, orders, pending-persistence rows, order events, and notifications. ERP attempts are append-only and unique by `(order_id, attempt_number)`; normal worker transitions conditionally enforce `queued -> processing -> confirmed | failed`. Traffic finalizations and run summaries are unique per run with first-write-wins semantics. Normal finalization captures the Redis sold-out total, includes it in the terminal summary, and copies it to a durable run outcome aggregate. Seeded presets and the policy parse against their shared schemas; editable admin presets and direct policy edits survive re-seeding while read-only public presets are restored to code definitions; public presets are non-editable rows and duplicate/copy operations target editable admin rows. Maintenance cleanup preserves active runs and the newest retention window, deletes the generated-run subtree in foreign-key-safe order, and skips catalog offers. Admin reset captures current Redis inventory/sold-out state before teardown and preserves history.

**Worker, queue, mock ERP, and notifications (slice 3).** The API does not call `POST /confirm`; the production ERP HTTP client is constructed only in the worker composition root. Normal transition adapters commit each status change with its matching `OrderEvent` in one transaction. The in-service retry delay is exponential and capped as documented. The breaker opens after its configured threshold, admits one result-returning half-open probe, and closes after a successful probe in the tested topology. Run-scoped latency, error rate, forced outage, and TPS values are carried on worker-to-ERP requests and override retained global chaos values in the ordinary resolved-snapshot path. Mock ERP chaos mutations are service-token gated and cap-validated. Notification rows and timeline events are written transactionally only after a fresh durable `confirmed` transition; failed and already-terminal orders create no notifications, and notification failures do not roll back confirmation. Realtime publications occur only after durable writes and are caught as best-effort.

**Run lifecycle and load orchestration (slice 4).** The load orchestrator stays free of database/Redis business lifecycle ownership. Generated k6 scripts use validated numeric configuration; the child process is spawned with an argv array and `shell: false`. Buyer-spike and steady-arrival modes map to the documented k6 executors with stable duplicate-versus-unique idempotency keys. Ordinary overlapping starts are prevented by a durable current-run query plus a partial unique-index backstop. Traffic completion is conceptually separated from benchmark completion; normal pre-timeout finalization waits for queued/processing orders and pending-persistence reconciliation. `trafficEndedAt` and `finalizedAt` are stored separately; traffic delivery quality is represented separately from lifecycle status, and major under-delivery produces an explainable terminal failure. Terminal snapshots include starting, remaining, reserved, accepted, sold-out, pending-persistence, capture-time, and Redis-source metadata when live state is available. Durable accepted-reservation counts come from unique reservation rows, not duplicate accepted HTTP responses.

**Dashboard, admin, and run history (slice 5).** Browser control calls use same-origin Next.js routes/server actions; backend URLs and control tokens remain server-side. Every inspected unsafe mutation proxy checks the signed admin session before forwarding, and the owning API/Mock ERP routes independently require the service token; the browser request body does not grant privilege. Admin session and visitor cookies are `HttpOnly`, production-secure, same-site; web production startup rejects unset/sentinel secrets absent the explicit local opt-in. Public preset reads filter at the service boundary and mutation enforces read-only rows server-side. Public run budgets are enforced atomically in Redis from the persisted policy and fail closed for a missing/invalid visitor identity. The public run-history payload contains no reservation tokens, idempotency keys, raw event payloads, private headers, or credentials. SSE frames are contract-validated in both the API fanout and the browser hook; events received during an in-flight recovery read are discarded with a serialized follow-up. `/watch`, `/admin`, `/run-history`, `/about`, and the public picker are distinct surfaces, and terminal summaries are not promoted into current-run recovery.

**Shared contracts and logging (slice 6).** Reservation and order lifecycle vocabularies are distinct and canonical, with PostgreSQL enums derived from those arrays. Queue producer/consumer identity and job payloads share one contract. Worker-to-ERP requests carry the canonical correlation header and parse responses through the shared schema. Service-boundary timestamps use the strict offset-aware ISO schema with UTC `Z` producers. API, Mock ERP, and load-orchestrator hooks consistently adopt/generate and echo `x-correlation-id`, and normal Fastify validation/internal/not-found errors use the shared shape. Health/liveness responses share one schema and builder with correct severity precedence. Dashboard recovery keeps traffic execution vocabulary separate from delivery quality and lifecycle. Load metrics ingestion and finalization use shared request schemas parsed on both sides. No private test helper leaks through the contracts or logger public entry points.

**Runtime and operations (slice 7).** The reference runtime defines PostgreSQL, Redis, API, worker, Mock ERP, load orchestrator, web, and Caddy as separate Compose processes. The load-orchestrator Dockerfile copies a pinned k6 binary and its readiness path probes executability. Caddy routes only `/dashboard/events` directly to the API with streaming flush and sends all other browser traffic to web; Compose uses service DNS for internal calls. `runtime:up` does not run migrations or seeds implicitly. Development and automated-test Compose projects, ports, and named volumes are distinct by default. Test helpers use per-package databases/logical Redis DBs with `FLUSHDB`; the only `FLUSHALL` is isolated inside the explicit dedicated-test-infrastructure reset. Runtime reset and maintenance scripts delegate destructive behavior to service-token-protected API workflows. Runtime smoke checks cover expected processes, direct readiness, dashboard proxy/SSE reachability, in-container k6 execution, and merged Dev Container configuration. Docker build contexts exclude local env files and runtime images use non-root users. The public `surge-10k` contract remains documented as the target, with local host limits described separately.

**Test suite quality (slice 8).** Redis reservation coverage uses real isolated Redis for concurrency, idempotency, late duplicate reconciliation, pending persistence, sold-out accounting, attribution, and eligibility. Worker integration coverage uses real PostgreSQL and BullMQ/Redis across enqueue, pickup, retry, terminal persistence, resilience, notifications, and realtime. DB integration coverage exercises migrations, constraints/triggers, seeds, lifecycle/finalization uniqueness, public budgets, reset safety, and maintenance ownership against isolated infrastructure. Frontend tests cover authorization boundaries, proxy behavior, recovery/realtime ordering, SSE parsing into rendered state, run controls, and key panels. Skips are not broadly hiding unfinished work — the only conditional skip is the explicit `LOAD_ORCHESTRATOR_SKIP_K6` opt-out. Test infrastructure separates package databases and Redis logical DBs and injects dependencies rather than importing production startup clients.

## Appendix — Verification performed across slices

- Focused API hot-path, Redis inventory, run-start/completion/finalization, recovery, admin reset, preset, and run-history integration suites passed against isolated test infrastructure (slices 1, 2, 4).
- `pnpm test:worker` passed 50/50 (real PostgreSQL + BullMQ/Redis); 71 focused worker/mock-ERP unit tests passed; two read-only reproductions confirmed the F21 half-open wedge and F23 cross-run token-bucket leak (slice 3).
- 50 focused load-orchestrator unit tests passed; the two real-k6 roundtrip tests were not runnable on hosts without a `k6` binary (slices 4, 8; see F43).
- `pnpm --filter @checkout-surge/web test:unit` passed 202/202; web build and type-check passed after regenerating dependency artifacts (slice 5; see F33).
- Contract/logger type-checks and 303 focused contract/logger/API-boundary tests passed; direct schema probes confirmed F34, F36, F51, and N4 acceptance behavior (slice 6).
- Compose config validation passed for all three compose file combinations; `pnpm type-check:test` exited 0 with zero tasks (F42); a host-native env-inheritance probe confirmed F39 (slice 7).
- `pnpm test:integration` passed 127/127; `pnpm test:unit` failed nondeterministically at the completion-report assertion (F45); `pnpm test:api` was blocked by a stale lock from a dead PID (F44) (slice 8).
- Full containerized runtime commands (`runtime:up`, `runtime:setup`, `runtime:smoke`, `runtime:smoke:load`) were not run by any slice: the audits were report-only and avoided mutating shared runtime state.
- During consolidation, the two cross-slice disagreements were resolved by direct read-only code/documentation verification (no tests or runtime executed): the F11 replay-before-eligibility inversion was confirmed against `packages/db/src/inventory/reservation-gate.ts`, `apps/api/src/app/services/reserve-order-service.ts` (`resolveDurableRunId`, `reconcileLateDuplicate`), `docs/architecture.md`, and `docs/redis_inventory_hot_path.md`; the N6 notification question was confirmed as adjudicated via `docs/core_business_entities.md:484` (Issue 12, Finding 15) against the stale `working_docs/project_planning.md:922` checklist.
