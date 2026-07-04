# Phase 1–10 Consolidated Review Findings

This document merges the eight per-slice review files (`findings_slice_1.md` … `findings_slice_8.md`) into a single deduplicated list. Findings are grouped by severity (High → Medium → Low), followed by lower-confidence notes and an appendix of things that were checked and found sound.

Each finding is tagged with the originating slice(s). Two findings were reported in more than one slice and have been merged:

- **Sold-out 409s graded as k6 traffic failures** — reported as a product defect in Slice 4 (Finding 1) and as a masking test gap in Slice 8 (Finding 1). Merged into **Finding 1** below.
- **API readiness never probes Redis reachability** — reported in Slice 6 (F1) and cross-referenced from Slice 7 for its runtime/smoke impact. Merged into **Finding 9** below.

Related-but-distinct items (e.g. the two separate dead-schema findings, and the `requestFailureRate` upper-bound vs. its grading semantics) are kept separate and cross-referenced.

## Summary

| # | Finding | Severity | Source |
|---|---------|----------|--------|
| 1 | Expected `sold_out` / idempotency 409s graded as k6 traffic failures → flagship surge always finalizes `failed` (and the path is untested) | High | Slice 4 F1 + Slice 8 F1 |
| 2 | Run-scoped ERP behavior and worker backpressure are frozen into the run but never applied | High | Slice 3 F1 |
| 3 | Root `pnpm test:db:migrate` is a stale "not implemented" placeholder that errors out | High | Slice 7 F1 |
| 4 | Catalog (null-`runId`) buy against a live run's generated offer leaks a Redis hold | Medium | Slice 1 F1 |
| 5 | `demo_run_reservation_outcomes` is a dead durable table despite comments claiming active use | Medium | Slice 2 F1 |
| 6 | `orders:process` completed jobs are never trimmed → unbounded Redis growth during a surge | Medium | Slice 3 F2 |
| 7 | Traffic metrics are forwarded only once (after k6 exits) → no live in-run traffic telemetry | Medium | Slice 4 F2 |
| 8 | Live dashboard retains the previous run's order-outcome overlay across a run change | Medium | Slice 5 F1 |
| 9 | API readiness never probes Redis reachability; a down Redis is hidden as `degraded`/HTTP 200 | Medium | Slice 6 F1 + Slice 7 |
| 10 | `WEB_ORIGIN` is documented/compose-injected as the API CORS allow-list, but no CORS is implemented | Medium | Slice 7 F2 |
| 11 | Concurrent idempotent replay can return `reservation_secured` for an order that will never exist | Medium/Low | Slice 1 F2 |
| 12 | `PUBLIC_CUSTOM_*` env knobs are inert; the public runtime policy is hardcoded in the seed | Medium-low | Slice 7 F3 |
| 13 | Live `inventory.updated` publish is awaited inline on the winning hot path | Low | Slice 1 F3 |
| 14 | `clearRunLiveState` leaks the run's sale-eligibility Redis key on cleanup | Low/Medium | Slice 2 F2 |
| 15 | `resetTestDatabase` wipes with no guard that the target is actually a test database | Low | Slice 2 F3 |
| 16 | Seed is idempotent for durable rows but hard-resets Redis inventory | Low | Slice 2 F4 |
| 17 | Worker readiness reports `ok` even when the consumer is not consuming | Low | Slice 3 F3 |
| 18 | A persisted-transition failure can double-confirm at the (non-idempotent) Mock ERP | Low | Slice 3 F4 |
| 19 | Admin console cannot launch the admin-only / `Custom` presets it can create | Low | Slice 5 F2 |
| 20 | `formatClock` slices the ISO string as if it were always UTC | Low | Slice 5 F3 |
| 21 | Run-summary / finalization tables carry summary columns that are never written, read, or in the contract | Low | Slice 6 F2 |
| 22 | `requestFailureRate` is documented as `(0..1)` but only bounded below | Low | Slice 6 F3 |
| 23 | Unused contract exports add vocabulary surface with no consumer | Low/info | Slice 6 F4 |
| 24 | `runtime:smoke:load` permanently lowers the `admin-soak-steady` preset and never restores it | Low | Slice 7 F4 |
| 25 | The only real-k6 end-to-end test self-skips silently; parsers are otherwise validated only against canned JSON | Low-Medium | Slice 8 F2 |

---

## High

### Finding 1 — Expected `sold_out` / idempotency 409s are graded as k6 traffic failures, so the flagship surge (and any sold-out run) always finalizes `failed` — and the path is untested (High)

*Source: Slice 4 Finding 1 (product defect) + Slice 8 Finding 1 (masking test gap).*

**Where:**
- `apps/load-orchestrator/src/services/k6-script.ts:98-145` — the generated script issues `http.post(...)` with **no** `http.setResponseCallback(http.expectedStatuses(...))` override, no `check()`, and no custom unexpected-response counter.
- `apps/api/src/routes/buy-routes.ts:10-15` — `sold_out` → **HTTP 409** and `idempotency_conflict` → **HTTP 409**.
- `apps/load-orchestrator/src/services/k6-summary.ts:59-67` and `apps/load-orchestrator/src/services/k6-output.ts:13-17` — `http_req_failed` is taken verbatim as `requestFailureRate` / `traffic.failure_rate`.
- `apps/api/src/services/grade-traffic-delivery.ts:20-25,53-59,93-100` — `gradeByFailureRate(requestFailureRate)` is folded into the terminal grade via the *worse* of the delivery-ratio and failure-rate grades; a rate `> 0.25` grades `failed`, `> 0.05` `degraded`, `> 0.01` `warning`.
- `apps/api/src/services/run-finalization-service.ts:125-138` — `trafficDeliverySummary.status === "failed"` drives `failDrainingRun({ failureReason: "traffic_delivery_major_shortfall" })`.
- Presets that trip it: `packages/db/src/presets.ts` — `surge-5k` (5000 buyers / 500 stock), `surge-10k` (10000 buyers / 1000 stock), and any zero/low-starting-stock preset.
- Missing tests: `apps/load-orchestrator/test/unit/k6-script.test.ts` (asserts structure/injection safety but never response classification), `apps/api/test/unit/grade-traffic-delivery.test.ts` (grades an abstract `requestFailureRate` but never a sold-out-dominated run — and `:82-89` even encodes the failing behavior as correct), and there is **no** end-to-end "clean all-sold-out / zero-starting-stock" traffic test anywhere.

**What happens:** k6's built-in `http_req_failed` classifies any response outside `200–399` as a failed request, and the generated script never overrides it. The buy endpoint returns **409** for the two *expected business outcomes* of a surge — `sold_out` and `idempotency_conflict`. So for a run whose whole purpose is to oversubscribe limited stock, the majority of requests are counted as failures:

- `surge-5k`: ~500 secured (202) + ~4500 sold-out (409) ⇒ `requestFailureRate ≈ 0.9`.
- `surge-10k`: ~1000 secured + ~9000 sold-out ⇒ `requestFailureRate ≈ 0.9`.
- Zero-starting-stock demo: 100% `sold_out` ⇒ `requestFailureRate ≈ 1.0`.

k6 still exits `0` (the script defines no thresholds), so completion is `succeeded` → the run enters `draining` and the ~0.9 failure-rate summary is landed as finalization input. At finalization, `gradeByFailureRate(0.9)` → `failed`, `worst(complete, failed)` → `failed`, and the run finalizes **`failed` with `traffic_delivery_major_shortfall`** — even though delivery was exact (`deliveryRatio ≈ 1.0`) and every response was exactly what the demo intends.

This directly contradicts `docs/load_generation_metrics_streaming.md:45`: "Zero starting stock is a valid preset configuration for sold-out demonstrations. … k6 traffic correctness is based on the **unexpected-response counter staying at zero**." No such unexpected-response counter exists: `TrafficHttpSummary` (`packages/contracts/src/load.ts:134-157`) carries only k6's raw `failedRequests` / `requestFailureRate`, and grading treats that raw rate as a traffic-fidelity signal.

**Impact:** The two headline demos of a product literally named *checkout-surge* always finalize `failed` with a shortfall reason, and their immutable summary records a `failed` traffic-delivery status despite behaving perfectly. It also poisons the live view: `traffic.failure_rate` samples carry the per-request 0/1 where the last sold-out request is `1`, so the recovery/live "failure rate" reflects sold-out 409s as failures too. The missing regression test is what let the defect through, and the existing grading test actively encodes the wrong behavior as correct.

**Suggested fix (product):** Base traffic correctness on *unexpected* responses, per the doc. In the generated k6 script, classify each response against known `BuyResponse` statuses — treat `202` (`reservation_secured` / `reservation_pending_persistence`) and the expected `409`s (`sold_out`, `idempotency_conflict`) as expected, and count only genuinely unexpected results (5xx, timeouts, connection errors, unexpected statuses) into the failure signal (e.g. a custom counter, or `http.setResponseCallback(http.expectedStatuses({min:200,max:299}, 409))`). Surface that unexpected-response rate as the value grading folds in, so `gradeByFailureRate` reflects real traffic-fidelity failures rather than designed sold-outs.

**Suggested fix (tests):** Add focused regressions that pin the intended behavior:
- A `grade-traffic-delivery` case proving a run whose only "failures" are expected `sold_out` rejections grades `complete`, not `failed`.
- A `k6-script` assertion pinning which HTTP statuses count as delivered vs failed (today: none — it silently inherits the k6 default).
- An end-to-end (or ingest-level) "clean all-sold-out traffic" test feeding a sold-out-dominated summary through completion-ingest → finalization and asserting a non-failed terminal status.

---

### Finding 2 — Run-scoped ERP behavior and worker backpressure are frozen into the run but never applied (High)

*Source: Slice 3 Finding 1.*

**Where:**
- `apps/api/src/services/run-start-service.ts:168-187` (`#resolveEffectiveConfig` assembles `erp` + `backpressure` into the run config) and `:216-265` (`#provisionAndLaunch` freezes the whole `config` into the durable snapshot at `:239`, but delegates only `config.traffic` to the launcher at `:253`).
- `apps/mock-erp/src/services/erp-behavior.ts:56-68` — `ConfiguredErpBehavior.decide()` ignores its request argument (and therefore `runId`) and reads only the single global `ChaosControlStore`.
- `apps/mock-erp/src/index.ts:22-39` — one global chaos store + one behavior; no run-scoped override layer, no store keyed by run id.
- `apps/worker/src/index.ts:138-143` with `apps/worker/src/runtime/config.ts:37,85` — the BullMQ worker is constructed once with the static `ORDER_PROCESS_CONCURRENCY`; nothing re-reads a run's `backpressure.workerConcurrency`.
- Contract + presets defining this behavior: `packages/contracts/src/demo.ts:24-32`, `packages/db/src/presets.ts:62,85,109,155,179,202` (e.g. `surge-10k` = `latencyMs 800, maxTps 50, errorRate 0.1`).

**What happens:** Every preset carries a run-scoped `erp` block and an optional `backpressure.workerConcurrency`, and `RunStartService` freezes them into `demo_runs.config_snapshot`. But nothing ever applies them at run time:

- The API never pushes the run's `erp` config to the Mock ERP (no call to the Mock ERP chaos surface with run values, no run-keyed override store). The Mock ERP always decides from its **global** `ChaosControlStore` (seeded from `LATENCY_MS`/`MAX_TPS`/`ERROR_RATE`/`FORCED_OUTAGE`, all defaulting to fast/always-succeed).
- The worker's BullMQ concurrency is fixed at construction and never re-derived per run.

A full-repo search confirms `config_snapshot.erp` / `backpressureConfig` are only ever *stored* and *read back for display* (recovery reader, finalization traffic parse, preset editor UI) — never applied. This contradicts `docs/architecture.md:57` ("The worker … applies the active run's accepted backpressure policy, calls the mock ERP … with the run-scoped ERP behavior") and `docs/local_development.md:371`. The in-code "Phase 7" deferral comments (`erp-behavior.ts:9`, `mock-erp/index.ts:21`, `chaos-control-store.ts:13`, worker `config.ts:37`) are stale for a phase-1–10-complete product.

**Impact:** The headline demo is silently wrong. Starting `surge-10k` — advertised as "a slow and occasionally failing ERP" — runs against a fast, always-succeeding ERP: no simulated latency, no ~10% error rate, no TPS throttling, so the circuit breaker never trips, retry/backoff is never exercised, `order.retrying`/`order.delayed` never fire, and the queue-backpressure story never materializes. Public-custom ERP knobs (validated against `PUBLIC_CUSTOM_MAX_ERP_*` caps) and the admin `workerConcurrency` field are likewise inert.

**Suggested fix:** Apply the frozen run config when a run goes active — at minimum push the run's `erp` block onto the Mock ERP (a run-keyed override the behavior selects by request `runId`, or set the global controls for the single active run) and apply `backpressure.workerConcurrency` to the worker. If run-scoped ERP genuinely remains out of scope, correct `docs/architecture.md:57` and the preset descriptions so they stop promising behavior the runtime does not deliver.

---

### Finding 3 — Root `pnpm test:db:migrate` is a stale "not implemented" placeholder that errors out (High)

*Source: Slice 7 Finding 1.*

**Where:** `package.json:36` — `"test:db:migrate": "node scripts/not-implemented.mjs 'pnpm test:db:migrate' 'Task 1.3'"`.

**What happens:** The real implementation landed long ago in `packages/db/package.json:27` (`test:db:migrate` → `run-with-test-env.mjs tsx src/cli/migrate.ts`), and every other db passthrough at the root uses the `pnpm --filter @checkout-surge/db …` pattern (e.g. `maintenance:cleanup-runs` at `package.json:47`). But the root `test:db:migrate` was never re-pointed — it still runs the Task-1.3-era `not-implemented.mjs` guard, which prints `⛔  pnpm test:db:migrate is not implemented yet (target: Task 1.3).` and **exits 1** (verified by running it).

Meanwhile it is documented in three places as a working migration-authoring aid invoked at the root: `docs/local_development.md:275` and `:304-316` (which even walk the reader through recovering from a `@checkout-surge/db` TypeScript build failure — a state the placeholder can never reach), `docs/runtime_topology.md:81`, and `docs/automated_testing_infrastructure.md:70`.

**Impact:** A documented, contract-level root command is broken: anyone following the testing docs to rehearse a migration gets a hard failure and a misleading "not implemented (Task 1.3)" message.

**Suggested fix:** Replace the placeholder with the standard passthrough: `"test:db:migrate": "pnpm --filter @checkout-surge/db test:db:migrate"`.

---

## Medium

### Finding 4 — Catalog (null-`runId`) buy against a live run's generated offer leaks a Redis hold (Medium)

*Source: Slice 1 Finding 1.*

**Where:** `apps/api/src/services/reserve-order-service.ts:100-102` (eligibility check only runs when `request.runId` is set) and `:257-260` (a classified `ApiError` from persistence is re-thrown without releasing the hold), together with `apps/api/src/services/postgres-buy-persistence.ts:94-106` and the run-ownership trigger `enforce_run_owned_sale_offer_attribution` (`packages/db/drizzle/0001_run_ownership_triggers.sql:27-52`).

**What happens:**
1. The run-scoped sale-eligibility check (`#enforceRunSaleEligibility`) is the pre-gate guard that prevents securing a hold PostgreSQL will later reject. But it is only invoked for run-attributed traffic (`if (request.runId)`), so a buy with **no** `runId` skips it entirely.
2. A caller can send `POST /buy` with `saleOfferId` = an active run's generated offer and **no** `runId`. The Redis gate has live inventory for that offer, so it decrements stock and records the hold (`reserved`).
3. Durable persistence hits the run-ownership trigger: the offer is owned by a run but the order's `run_id` is `NULL`, so the trigger raises `check_violation`. `PostgresBuyPersistence` maps it to `ApiError(409, run_sale_offer_mismatch)`.
4. `#persistReservedHold` re-throws the `ApiError` (line 260) **without** marking the hold pending or releasing it. The Redis stock is now decremented with **no durable order and no pending sentinel** — a silently leaked hold.

This is exactly the failure `postgres-buy-persistence.ts:18-21` says the design avoids. Because `/buy` is public and the generated `saleOfferId` is surfaced to clients, a malicious or buggy caller can repeatedly drain a live run's stock without ever producing an order — corrupting the "no oversell / accurate accounting" invariant.

**Suggested fix:** Reject a buy whose target offer is a `generated_run` offer that the request's `runId` does not own *before* the Redis gate (extend the pre-gate check to treat a null `runId` against a run-owned offer as a mismatch), or compensate the Redis hold when the durable write is rejected by the ownership trigger.

**Test gap:** `reserve-order-service.test.ts:654` covers "skips the eligibility check for a catalog buy" but not the catalog-buy-against-a-run-offer case; no test asserts the hold is not leaked on an ownership-trigger rejection.

---

### Finding 5 — `demo_run_reservation_outcomes` is a dead durable table despite comments claiming it is the Phase 10 durable outcome record (Medium)

*Source: Slice 2 Finding 1.*

**Where:** `packages/db/src/schema.ts:342-357` (table + `reservation_outcome_aggregate` enum), migration `0000_past_red_wolf.sql:45`, plus assertive comments at `packages/db/src/redis-keys.ts:84` and `packages/db/src/order-outcomes.ts:11`.

**What:** The `demo_run_reservation_outcomes` table (and its dedicated enum, unique constraint, and cascade-delete handling in `run-cleanup.ts`) is **never written or read anywhere** — a full-repo search finds only the schema definition, the migration, the cleanup cascade comment, and tests; no INSERT/SELECT/UPDATE. Yet multiple comments assert it is actively used ("the durable run-outcome finalization lives in `demo_run_reservation_outcomes` (Phase 10)"). In reality the sold-out accounting it was meant to hold is captured elsewhere: `run-summary-writer.ts` copies the Redis `soldOutRejectionCount` into `demo_run_summaries.terminalInventorySnapshot` (JSON). No data loss, but the documented dedicated durable aggregate does not exist at runtime.

**Impact:** Doc-vs-implementation drift and dead schema. A reviewer trusting the comments would believe a normalized durable run-outcome record exists. Because Phase 10 is nominally complete, this is an oversight to resolve rather than deferred work.

**Suggested fix:** Either (a) have finalization actually persist the run's terminal aggregate into `demo_run_reservation_outcomes` as the comments claim, or (b) delete the unused table/enum/constraint and correct the three comments to point at `demo_run_summaries.terminalInventorySnapshot`. *(Related dead-schema item: Finding 21, unused summary columns.)*

---

### Finding 6 — `orders:process` completed jobs are never trimmed, so the completed set grows unbounded during the surge (Medium)

*Source: Slice 3 Finding 2.*

**Where:** `apps/api/src/services/order-process-queue.ts:47-57` — `defaultJobOptions` sets `attempts` and `backoff` but no `removeOnComplete`/`removeOnCount`. Contrast the notification queue, `apps/worker/src/adapters/record-notification-queue.ts:31-38`, which deliberately sets `removeOnComplete: true`.

**What happens:** BullMQ retains every completed job by default. The `orders:process` queue processes one job per accepted order, so a `surge-10k` run leaves ~10k completed job hashes in Redis, accumulating across runs. Only an explicit admin reset (`queue-cleaner.ts:41` `obliterate({ force: true })`) clears them — normal run completion and `maintenance:cleanup-runs` do not.

**Impact:** Redis memory growth precisely in the 10k-order surge scenario the product is built around, unbounded across runs until someone resets. Functionally the queue still works, but it is an asymmetric oversight versus the notification queue.

**Suggested fix:** Add a bounded `removeOnComplete` (count- or age-based window) to the `orders:process` `defaultJobOptions`, mirroring the notification queue's intent. If `completedCount` visibility is why they are kept, `removeOnComplete: { count: N }` preserves the recent-completions signal without the unbounded set.

---

### Finding 7 — Traffic metrics are forwarded only once, after k6 exits, so there is no live in-run traffic telemetry (Medium)

*Source: Slice 4 Finding 2.*

**Where:**
- `apps/load-orchestrator/src/services/traffic-run-service.ts:129-146` — `#runK6` `await`s the k6 process to completion, *then* `parseK6Output(result.output)` and a single `reporter.reportMetrics(samples)`.
- `apps/load-orchestrator/src/services/k6-runner.ts:55-74` — the runner reads the `--out json` file only **after** the process exits; no incremental read/tail during the run.
- `packages/db/src/load-metrics.ts:44-74` — `recordLatestLoadMetrics` keeps only the *latest* observation per metric.

**What happens:** k6 streams its JSON point file throughout the run, but the orchestrator reads it back only after k6 exits and forwards the whole batch in one POST at run end. The API's live latest-metrics projection is therefore written a single time, at completion. During the surge itself, `/dashboard/recovery`'s traffic metrics and the live traffic tiles have nothing to render for the current run. Business-side live events (inventory depletion, sold-outs) still stream live, so the gap is specifically the k6 traffic signals (request rate, latency, failure rate).

**Impact:** For the ~1-second buyer-spike the practical loss is small, but for longer steady/soak runs (`admin-soak-steady`) the live traffic panels stay empty for the whole run then jump to final values — undercutting the "watch it live" purpose. Intent/UX oversight rather than a hard contract breach.

**Suggested fix:** Stream metrics incrementally — tail the k6 JSON output file (or use a live `--out` sink) and forward parsed `traffic.*` samples in periodic batches while the run is active, rather than a single post-exit batch.

---

### Finding 8 — Live dashboard retains the previous run's order-outcome overlay across a run change (stale state shown as current) (Medium)

*Source: Slice 5 Finding 1.*

**Where:** `apps/web/src/lib/live-dashboard-state.ts` (`liveDashboardReducer` `"recovery"` case, ~lines 120-129; overlay fields in `LiveDashboardState`), `apps/web/src/components/live-dashboard.tsx` (single persistent mount), `apps/web/src/components/panels.tsx` (`RunOutcomesPanel`).

**Problem:** The `"recovery"` action re-baselines `snapshot`, `run`, and `latestTrafficMetrics` from the authoritative read but deliberately **keeps the entire live overlay** (`outcomes`, `hasOutcomeEvents`, `lastOrderEvent`, `reservationTimestamps`, `liveInventory`, `lastEventAt`). That holds *within a run*, but there is no run-change detection: the overlay is never reset when `recovery.run.id` changes. `LiveDashboard` mounts once with a `[]`-dependency `EventSource` effect, so a spectator on `/watch` across back-to-back runs never remounts, and the zeroing initializer only runs on mount.

Because each order-lifecycle event carries a full run-scoped `outcomes` snapshot, the overlay normally self-corrects on the new run's first `order.*` event. The failure case is a run that emits **no order events at all** — most notably a clean **sold-out-only run** (zero starting stock, or every buyer rejected): no reservations secured → no orders → no `order.*`/`notification.recorded` events. For that entire run the "Run outcomes" panel keeps showing the *previous* run's `confirmed`/`failed`/`notificationsRecorded` counts and `lastOrderEvent`, with `hasOutcomeEvents` still `true` so the "live-only" caveat is suppressed — pairing the previous run's `confirmed` against the current run's freshly-baselined `reservationsSecured`. `reservationTimestamps` has the same defect at smaller scale (previous run's ticks bleed into the new run's "Live (last 15s)" surge rate for up to `SURGE_WINDOW_MS`).

**Suggested fix:** In the `"recovery"` case, detect a run identity change (`action.recovery.run?.id !== state.run?.id`, treating null transitions as a change) and reset the overlay fields to their `initLiveDashboardState` values. `liveInventory` is already guarded by a `saleOfferId` match in `selectInventoryView`; the outcome/`lastOrderEvent`/surge fields are not and are the ones that mislead.

---

### Finding 9 — API readiness never probes Redis reachability; a down Redis is hidden as `degraded`/HTTP 200 (Medium)

*Source: Slice 6 Finding F1, with the runtime/smoke impact from Slice 7 ("already covered elsewhere").*

**Where:** `apps/api/src/services/readiness.ts:28-36` (and the design note at `:3-8`).

**What:** The API readiness checker probes PostgreSQL for real (`pingDatabase` → `unavailable`/503 on failure), but Redis is only checked for **configuration presence**: `checks.push({ name: "redis_url_configured", status: deps.redisUrlConfigured ? "ok" : "degraded" })`. There is no reachability probe. A configured-but-down Redis therefore yields `database_reachable: ok`, `redis_url_configured: ok`, `order_process_queue_reachable: degraded` (BullMQ ping fails but is treated as non-fatal). The aggregate is `degraded`, so `/health/ready` returns **HTTP 200 "ready"**, never `unavailable`/503.

**Why it matters:** Redis is the inventory hot-path authority — reservations, the inventory-status read, SSE fan-out, and the queue all depend on it. When Redis is down, *no buy can secure a reservation*, yet readiness reports ready. The readiness comment justifies the non-fatal queue probe ("the buy path survives a lost hand-off"), but that rationale holds only for a BullMQ outage, not a total Redis outage — and both currently surface through the same `degraded` signal. Runtime impact (Slice 7): because readiness stays green, the compose healthcheck, `pnpm health:check`, and `pnpm runtime:smoke` all pass while every buy returns 503.

**Suggested fix:** Add a real Redis reachability probe (e.g. `PING`) that reports `unavailable` when Redis is configured but unreachable, mirroring the PostgreSQL probe. Keep config-presence as the `degraded` branch only for the no-Redis-configured process mode.

---

### Finding 10 — `WEB_ORIGIN` is documented and compose-injected as the API realtime-CORS allow-list, but no code implements CORS (Medium)

*Source: Slice 7 Finding 2.*

**Where:** `docker-compose.yml:73` (api) and `:154` (web) inject `WEB_ORIGIN: http://localhost:8080`; `.env.example:26-28` documents it; `apps/web/.env.example:4` references it. Docs describe it as an enforced control: `docs/architecture.md:27`, `docs/local_development.md:96,356`, `docs/runtime_topology.md:140` ("API realtime CORS should allow the dashboard proxy origin").

**What happens:** `WEB_ORIGIN` (and any `webOrigin`) is **read nowhere in the codebase** — a full-repo grep finds only compose, env examples, and docs. The API registers **no** CORS plugin/handler (no `@fastify/cors`; `apps/api/src/server.ts` registers only correlation + error handlers; `/dashboard/events` sets no `Access-Control-*` handling). The documented "configure the debug-port CORS allow-list with `WEB_ORIGIN`; unset ⇒ wildcard" behavior does not exist; the value is inert.

**Impact:** The reference demo still works because the browser only reaches the API same-origin through the Caddy proxy. But this is misleading config + a false security claim: an operator who exposes the direct debug ports and relies on `WEB_ORIGIN` to restrict cross-origin browser access gets **no** protection, and setting/omitting it changes nothing.

**Suggested fix:** Either (a) implement it — register `@fastify/cors` in the API keyed on a parsed `WEB_ORIGIN` (comma-separated; unset ⇒ permissive dev default) and load it in `loadApiConfig`; or (b) if same-origin-through-proxy is the only intended model, remove `WEB_ORIGIN` from compose/`.env.example` and correct the three docs.

---

### Finding 11 — Concurrent idempotent replay can return `reservation_secured` for an order that will never exist (Medium/Low)

*Source: Slice 1 Finding 2.*

**Where:** `apps/api/src/services/reserve-order-service.ts:218-231` (`#replayResponse`) and the invariant in the comment at `:213-217`.

**What happens (TOCTOU race):** two concurrent buys share an idempotency key. The atomic gate accepts one (`reserved`, request A) and returns `replayed` to the other (request B, carrying A's reservation record). Their post-gate work races:
- Request A attempts the durable write, it **fails transiently**, so A calls `#markPending` and returns `reservation_pending_persistence`.
- Request B (`replayed`) calls `isReservationPending(A.reservationId)` to decide secured vs pending.

B's post-gate path is a single `ZSCORE`; A's is a full (failing) durable transaction followed by the pending `ZADD`. So B's `isReservationPending` very commonly runs **before** A has marked the hold pending, returns `false`, and B replies `#securedResponse` with `order: { id: A.orderId, status: queued }`. But A's order was never persisted and never will be — reconciliation (`pending-persistence-reconciler.ts:45-60`) only materializes a `reservation_pending_persistence` row, never an `orders`/`reservations` row. So B promises a queued order that will never process, confirm, or be readable via `GET /orders/:publicOrderId` — exactly what the `#replayResponse` comment says must not happen.

The window needs a concurrent same-key duplicate *and* a durable-write failure — both are exactly what the surge/idempotency demos stress; given the timing asymmetry, when both occur B usually gets the wrong answer.

**Suggested fix:** Make the replay's pending decision race-free — have the gate/record carry an explicit persistence-status flag flipped atomically, or resolve pending state from the durable order's existence rather than a sentinel the original writes only after its write has already failed.

**Test gap:** the pending-replay path is covered sequentially (`reserve-order-service.test.ts:367`), but there is no concurrent-duplicate-plus-durable-failure test.

---

### Finding 12 — `PUBLIC_CUSTOM_*` env knobs in `apps/api/.env.example` are inert; the public runtime policy is hardcoded in the seed (Medium-low)

*Source: Slice 7 Finding 3.*

**Where:** `apps/api/.env.example:45-57` documents 13 `PUBLIC_CUSTOM_*` variables under "Public custom-run caps". The actual policy is the hardcoded `DEFAULT_PUBLIC_RUNTIME_POLICY` in `packages/db/src/presets.ts:23-33`, seeded verbatim at `:258-261`.

**What happens:** No code reads any `PUBLIC_CUSTOM_*` variable — a repo grep finds only the env example and one explanatory comment (`presets.ts:12`). `loadApiConfig` does not read them and the seed does not consult env. So editing any `PUBLIC_CUSTOM_*` has **zero effect**; the public custom-run caps can only change by editing the seed constant (or later via the admin runtime-policy API). Secondary mismatch: `PUBLIC_CUSTOM_MAX_ERP_MAX_TPS=100` (`.env.example:56`) has no corresponding policy field — `DEFAULT_PUBLIC_RUNTIME_POLICY.erp` only carries `minMaxTps` (no upper `maxMaxTps`), so even the intent is unrepresentable.

**Impact:** Misleading configuration surface. An operator tuning `PUBLIC_CUSTOM_*` silently gets the hardcoded defaults. Same drift class as Finding 10.

**Suggested fix:** Either wire the public runtime policy seed to read `PUBLIC_CUSTOM_*` (with current values as fallbacks, validated against the deployment caps), or drop the block from `apps/api/.env.example` and note the seeded policy is the source of truth (admin-tunable at runtime). Reconcile the stray `MAX_ERP_MAX_TPS` either way.

---

## Low

### Finding 13 — Live `inventory.updated` publish is awaited inline on the winning hot path (Low)

*Source: Slice 1 Finding 3.*

**Where:** `apps/api/src/services/reserve-order-service.ts:155` — `#publishInventoryUpdated` is `await`ed before `#persistReservedHold` on every newly-`reserved` buy.

The publisher is best-effort and swallows its own failures (`dashboard-event-publisher.ts:25-34`), so awaiting it adds a serialized Redis `PUBLISH` round trip to each winning reservation before the durable write starts, purely for observability. Under the one-second surge this is one extra serialized round trip per accepted buy on the latency-critical winning path. Losing paths (sold-out/conflict) are unaffected, and the Lua gate already appends its own `inventory.updated` event, so nothing depends on this publish completing before the response.

**Suggested fix:** Fire it without blocking the reservation workflow (or after the durable commit) so it cannot add latency to the accepted hot path.

---

### Finding 14 — `clearRunLiveState` leaks the run's sale-eligibility Redis key on cleanup (Low/Medium)

*Source: Slice 2 Finding 2.*

**Where:** `packages/db/src/run-cleanup.ts:80-86` (`clearRunLiveState`); the missed key is `runSaleEligibilityKey(runId)` (`redis-keys.ts:107`, `run-sale-eligibility.ts`).

**What:** `clearRunLiveState` is documented as clearing "the ephemeral live Redis state a demo run leaves behind" and is used by maintenance cleanup (`cleanup-runs`) and the by-id smoke self-cleanup (`cleanup-run`). It unlinks the order-outcome aggregate and traffic-metrics keys and clears the offer's inventory namespace, but not `run:{runId}:sale-eligibility` (added later in Task 10.3b; the Task 8.3 helper predates it). So the eligibility hash lingers until its 24h TTL. Worse for the `runtime:smoke:load` by-id path: that run is deleted while still **non-terminal**, so its eligibility record is still `accepting=1` when destroyed.

**Impact:** Low — a leaked live-state key, not an oversell path (the inventory namespace is cleared, so any stray buy resolves `missing_inventory`, and run ids are never reused). But it contradicts the helper's stated ownership and is untested (`run-cleanup.test.ts` asserts only outcome/metrics keys).

**Suggested fix:** Add `runSaleEligibilityKey(runId)` to the `redis.unlink(...)` call in `clearRunLiveState`, and extend the cleanup test to assert the eligibility key is cleared.

---

### Finding 15 — `resetTestDatabase` performs `DROP SCHEMA` / `TRUNCATE` with no guard that the target is actually a test database (Low)

*Source: Slice 2 Finding 3.*

**Where:** `packages/db/src/testing/index.ts:94-115`.

**What:** `resetTestDatabase(connectionString)` unconditionally `TRUNCATE … RESTART IDENTITY CASCADE`s every table (or `DROP SCHEMA public CASCADE` on rebuild) against whatever connection string it is handed. Safety rests entirely on the comment "only ever call against TEST_DATABASE_URL" and on callers passing the test URL; there is no runtime assertion.

**Impact:** Low today (it is a `@checkout-surge/db/testing` export and current callers pass `TEST_DATABASE_URL`), but a destructive footgun: a future caller, or a mis-set `TEST_DATABASE_URL` pointing at the dev DB, would silently wipe development data.

**Suggested fix:** Add a cheap defensive check before the destructive statements — refuse to run unless the target database name matches an expected test pattern, or require an explicit `allowDestructive`/env opt-in — so an accidental non-test target fails loudly.

---

### Finding 16 — Seed is idempotent for durable rows but hard-resets Redis inventory (Low)

*Source: Slice 2 Finding 4.*

**Where:** `packages/db/src/seed.ts:24-54` — durable rows use `onConflictDoNothing` (idempotent), but `initializeInventoryState` (`seed.ts:48-51`, `inventory.ts:30-41`) unconditionally `HSET`s `remainingStock`/`reservedStock` back to the full allocation.

**What:** Re-running the seed leaves the product, catalog offer, presets, and policy untouched, but resets the seeded catalog offer's live Redis counters to a full 100/0. If the standalone seeded-catalog demo has already consumed some of that offer, the durable `reservations` rows remain while Redis is reset to full stock — the two diverge. The "is idempotent across repeated seeds" test (`schema.test.ts:113`) only re-seeds a fresh database, so it misses this asymmetry.

**Impact:** Low, bounded to the standalone catalog-offer demo (preset-driven runs use isolated generated offers). Still, "idempotent re-seed" is weaker than the comments imply.

**Suggested fix:** Decide the intended semantics and make them consistent — either make the Redis init conditional (skip when the namespace already exists), or document that re-seed deliberately re-baselines live inventory (and note the durable/live divergence for the catalog offer).

---

### Finding 17 — Worker readiness reports `order_process_worker_running: ok` even when the consumer is not consuming (Low)

*Source: Slice 3 Finding 3.*

**Where:** `apps/worker/src/adapters/order-process-worker.ts:88-90` (`isRunning()` → `Worker.isRunning()`) and `apps/worker/src/adapters/record-notification-worker.ts:61-63`, wired into readiness at `apps/worker/src/services/readiness.ts:49-56` and `apps/worker/src/index.ts:168-169`.

**What happens:** BullMQ's `Worker.isRunning()` only reflects that the worker object was started and not closed/paused; it does not reflect broker connectivity. The queue connection uses `maxRetriesPerRequest: null` (`index.ts:38`), so if Redis becomes unreachable the worker retries forever, consumes nothing, and `isRunning()` still returns `true`. `/health/ready` reports the worker loop healthy while it is stalled.

**Impact:** Low but exactly the "queue health reporting success while workers are not consuming" concern. An orchestrator or `health:check` gating on worker readiness sees green while orders pile up (the connection error is only logged, `index.ts:39-41`).

**Suggested fix:** Back the liveness signal with something reflecting actual consumption/broker reachability — gate on the queue connection status, or a lightweight periodic ping/heartbeat — so a disconnected consumer surfaces as `unavailable` (503) rather than `ok`.

---

### Finding 18 — A confirmation persisted-transition failure can double-confirm at the (non-idempotent) Mock ERP (Low)

*Source: Slice 3 Finding 4.*

**Where:** `apps/worker/src/services/process-order-service.ts:130-162` (ERP confirm at `:132`, then `markConfirmed` at `:158`); the Mock ERP confirmation has no idempotency (`apps/mock-erp/src/services/erp-confirmation-service.ts:48-96`; the request already carries `orderId` at `apps/worker/src/adapters/http-erp-client.ts:126-135` / `packages/contracts/src/erp.ts:10-18`).

**What happens:** `confirm()` calls the ERP (which "processes" and returns a fresh `erpReference`) and only afterward runs `markConfirmed`. If the process crashes, or `markConfirmed` throws (a transient Postgres blip), after a successful ERP call but before the confirmed status commits, the order stays `processing`; on redelivery the terminal-skip does not fire, so `confirm()` calls the ERP **again**. With no per-`orderId` dedup, the ERP confirms a second time (second `erpReference`, extra `erp_attempts` row). The durable order still ends confirmed once and stock/notifications are unaffected, but the downstream "business system" was told to fulfill the same order twice.

**Impact:** Low for this simulated demo and partly inherent to at-least-once delivery — but it is avoidable: the ERP request already carries a stable `orderId` usable as an idempotency key.

**Suggested fix:** Make the Mock ERP confirmation idempotent on `orderId` (return the prior result for a repeat). Alternatively, document the at-least-once/no-ERP-idempotency stance as an accepted non-goal.

---

### Finding 19 — Admin console cannot launch admin-only or `Custom` presets it can create (Low)

*Source: Slice 5 Finding 2.*

**Where:** `apps/web/src/components/run-controls.tsx` (hard-coded `PUBLIC_PRESETS`, lines 14-19), `apps/web/src/app/admin/page.tsx` (uses `<RunControls />` as the only run-start affordance, line 61).

**Problem:** The admin console's "Run controls" panel is the Task 7.4 `RunControls`, whose preset list is hard-coded to the four **public** presets (`preview-1k`, `surge-5k`, `surge-10k`, `idempotency-check-200`) — identical to the public home-page launcher. The admin preset-management panel lets an operator edit editable presets, duplicate into new **admin-only** presets, and copy into the persisted `Custom` scratch — but there is no UI to **start** an admin-only or `Custom` preset. The backend supports it (an authenticated admin start attaches operator-mode `admin`); the gap is purely the missing admin launcher UI.

**Suggested fix:** Drive the admin console's run controls from the actual preset list already fetched for the management panel (including admin-only and `Custom` presets), rather than the hard-coded public four — or add an explicit "start this preset" action to the preset-management rows.

---

### Finding 20 — `formatClock` slices the ISO string as if it were always UTC, but the timestamp schema permits an explicit offset (Low)

*Source: Slice 5 Finding 3.*

**Where:** `apps/web/src/components/panels.tsx` (`formatClock`, ~lines 279-282; used for `Traffic ended` / `Finalized` at 315-316).

**Problem:** `formatClock` renders the clocks with `iso.slice(11, 19)` and asserts "ISO is UTC so this stays deterministic." The shared schema is `z.string().datetime({ offset: true })` (`packages/contracts/src/common.ts`), which **permits** a non-`Z` offset (e.g. `...T12:00:00+02:00`); "services emit UTC `Z`" is a convention, not schema-enforced. If any producer ever emits an offset timestamp, the sliced substring is the offset-local wall-clock time mislabeled as UTC (and short/absent fractional seconds can even shift the slice window). Latent today because producers emit `Z`, but the display trusts a convention the type does not guarantee.

**Suggested fix:** Parse and format via `Date`/`Intl` in UTC (e.g. `new Date(iso)` then `getUTC*`), so the rendered clock is correct regardless of the incoming offset.

---

### Finding 21 — DB run-summary/finalization tables carry summary columns that are never written, read, or in the contract (Low)

*Source: Slice 6 Finding F2.*

**Where:** `packages/db/src/schema.ts:359-398` (`demoRunFinalizations`, `demoRunSummaries`); contract `packages/contracts/src/run-history.ts:88-96` (`demoRunSummarySchema`).

**What:** Several jsonb columns exist in the schema and initial migration but are never populated, consumed, or in the run-history contract (repo-wide search finds them only in `schema.ts` and `drizzle/0000_*.sql`):
- `demo_run_summaries`: `httpTimingBreakdownSummary`, `loadRunDiagnosticsSummary`, `apiRequestLifecycleSummary` — not written by `run-summary-writer.ts`, not selected by `run-history-reader.ts`.
- `demo_run_finalizations`: `trafficOutcomeSummary`, `trafficDeliverySummary`, `httpTimingBreakdownSummary`, `loadRunDiagnosticsSummary`, `apiRequestLifecycleSummary` — not written by `finalization-store.ts` (which sets only `exitCode`, `errorMessage`, `httpSummary`, `trafficSummaryReceivedAt`).

**Why it matters:** Dead schema and DB↔contract drift. Not a functional defect, but it signals either an abandoned richer-summary feature or cruft a reviewer keeps having to reconcile. *(Related dead-schema item: Finding 5.)*

**Suggested fix:** Either wire and expose these summaries through the contract, or remove the unused columns (and migration lines) so `demoRunSummarySchema` and the persisted shape agree.

---

### Finding 22 — `requestFailureRate` is documented as `(0..1)` but only bounded below (Low)

*Source: Slice 6 Finding F3.*

**Where:** `packages/contracts/src/load.ts:140` (`trafficHttpSummarySchema.requestFailureRate`) and `packages/contracts/src/run-history.ts:67` (`trafficDeliverySummarySchema.requestFailureRate`).

**What:** Both fields are `z.number().min(0)` with a doc comment describing a `(0..1)` rate, while the comparable ERP rate fields enforce the full range (`errorRate: z.number().min(0).max(1)` in `erp.ts:45`, `maxErrorRate` likewise). The upper bound is missing. Harmless in practice (the k6 summary parser always derives this from `http_req_failed`'s 0..1 rate and floors at 0), but the schema would silently accept a malformed over-range producer value.

**Suggested fix:** Add `.max(1)` to both fields for consistency with the ERP rate contracts, or relax the comment if over-range values are ever intentionally allowed. *(Distinct from Finding 1, which concerns how this value is graded, not its bounds.)*

---

### Finding 23 — Unused contract exports add vocabulary surface with no consumer (Low / informational)

*Source: Slice 6 Finding F4.*

**Where:** `packages/contracts/src/enums.ts:74-83` (`SIMULATED_PURCHASE_STATUSES` / `simulatedPurchaseStatusSchema` / `SimulatedPurchaseStatus`); `packages/contracts/src/load.ts:66-71` (`trafficSnapshotRefSchema` / `TrafficSnapshotRef`).

**What:** These are exported from contracts but have no consumer anywhere in `apps/` or the other `packages/` (verified by grep). `simulatedPurchaseStatusSchema` is described as the "derived, UI-facing simulated purchase status," but the web app derives its purchase/outcome view from `orderLifecyclePayloadSchema` / `OrderOutcomeSnapshot` instead. Not a bug, but exported-yet-unconsumed vocabulary invites drift and makes it ambiguous whether the UI is *supposed* to use it.

**Suggested fix:** Either wire these into the intended consumer, or drop them to keep the contract surface to what services actually use.

---

### Finding 24 — `runtime:smoke:load` permanently lowers the `admin-soak-steady` preset and never restores it (Low)

*Source: Slice 7 Finding 4.*

**Where:** `scripts/runtime-smoke-load.mjs:97-121` (step 3, "lower preset") — a read-modify-write `PUT` to `/api/dashboard/admin/presets/{slug}` overriding the preset's `traffic` + `erp` to a tiny shape (default `5/s for 8s`). The cleanup phase (`:208-234`) removes only the run's rows + Redis keys.

**What happens:** The smoke deliberately shrinks the editable `admin-soak-steady` preset to run quickly, but there is no restore step — after exit, the seeded "Admin Soak (Steady)" preset (seed default `steady_arrival 500/s for 120s`, `presets.ts:184-205`) stays overwritten. Step 2's reset happens *before* the lowering and uses `ON CONFLICT DO NOTHING` seeding, so it does not restore the value either.

**Impact:** Low and self-inflicted (dev/CI tool, editable-by-design preset), but it contradicts the script's own "clean up ONLY the rows and Redis keys that run created" contract (`:5-7`). An operator who later picks "Admin Soak (Steady)" silently gets a 5s run instead of the advertised 2-minute soak.

**Suggested fix:** Capture the preset's original `display`/`config` before the lowering `PUT` and restore it in a `finally`/cleanup step, or point the default `RUNTIME_SMOKE_LOAD_PRESET` at a throwaway preset created for the smoke and deleted afterward.

---

### Finding 25 — The only real-k6 end-to-end test self-skips silently; the k6 parsers are otherwise validated solely against hand-authored canned JSON (Low-Medium)

*Source: Slice 8 Finding 2.*

**Where:**
- `apps/load-orchestrator/test/integration/k6-run.test.ts:19-20,36` — `describe.skipIf(!k6Available)` guarded by a `spawnSync("k6", ["version"])` probe.
- `apps/load-orchestrator/test/unit/k6-output.test.ts:9-13` and `apps/load-orchestrator/test/unit/k6-summary.test.ts` — the streaming-line parser and `--summary-export` parser are exercised only against string literals the tests wrote themselves.

**What:** `k6-run.test.ts` is the single test that spawns the real k6 binary and proves its actual stdout/summary format parses into `traffic.*` samples plus a `succeeded` completion. When k6 is not on `PATH` (a fresh checkout, or any CI image without it) the whole describe block silently skips and the suite still reports green. Every other k6 test uses canned JSON hand-written to match the parser, so the real-format ⇄ parser contract is only checked when k6 happens to be installed.

**Impact:** No failing signal for two real regressions — a k6 output-format change and a k6-less runtime image (Slice 7 flags "k6 missing from the load-orchestrator container" as a risk). Severity is capped because the parsers are pure and reasonably covered structurally, and readiness has its own `k6_binary_executable` check; the gap is coverage visibility.

**Suggested fix:** Make the skip observable — gate the real-k6 suite behind an explicit CI flag (`REQUIRE_K6=1`) that turns the self-skip into a hard failure where k6 is expected, and/or add a runtime-image test asserting `k6 version` succeeds inside the load-orchestrator container so a k6-less image fails loudly.

---

## Lower-confidence notes (not full findings)

- **ERP timeout vs. admin latency cap mismatch** *(Slice 3).* The worker's `ERP_REQUEST_TIMEOUT_MS` defaults to 2000ms (`worker config.ts:81`) while the Mock ERP admin latency cap `ADMIN_MAX_LATENCY_MS` defaults to 5000ms (`mock-erp config.ts:107`). Global chaos latency set in (2000, 5000]ms turns "slow ERP" into universal timeouts (circuit opens) rather than slow-but-successful confirmations. All *preset* ERP latencies are ≤1200ms, so this only bites the global chaos knob — and only once Finding 2 is fixed — but the two bounds should be made coherent (or the interaction documented).

- **`run:catalog:order-outcomes` aggregate is never cleared** *(Slice 3).* Catalog (null-`runId`) traffic increments the `CATALOG_RUN_SCOPE` order-outcome hash (`packages/db/src/redis-keys.ts:76-87`, `order-outcomes.ts:67-77`), which carries no TTL and is not covered by run cleanup. Harmless (non-run scope) but an ever-growing key.

- **Rate-named metrics store per-request counter deltas, not rates** *(Slice 4).* `k6-output.ts:13-17` maps `http_reqs` → `traffic.scheduled_request_rate` and `http_req_failed` → `traffic.failure_rate`, but k6 JSON `Point`s carry the per-observation value (`http_reqs` = `1` per request; `http_req_failed` = `0`/`1`), not a windowed rate. Combined with `recordLatestLoadMetrics` keeping only the latest point, the stored "request rate" ends up `1` and "failure rate" the last request's `0`/`1`. Unless the dashboard derives a rate from a window, the projected rate values look meaningless.

- **`markTrafficFailed` sets `finalizedAt = trafficEndedAt`** *(Slice 4)* (`postgres-run-store.ts:116-130`). Defensible (a traffic-failed run terminalizes at traffic end), but it is the one path where `trafficEndedAt` and `finalizedAt` are the same instant; `markCompleted` keeps them distinct. Worth confirming history consumers never treat equal timestamps as "finalized == traffic ended" for other states.

---

## Appendix — Checked and found sound (not flagged)

Recorded so a later reviewer knows these areas were examined and judged correct.

**Reservation hot path & inventory (Slice 1):** the atomic Lua gate, oversell prevention, sold-out/idempotency cheap paths, run-attribution reconciliation, and pending-persistence handling are correct and well covered.

**Persistence, domain state, seeds (Slice 2):** cleanup FK ordering is child-before-parent and satisfies every FK including the composite run-ownership FKs and `orders → reservations` (no FK bug); the single-non-terminal-run constant-`TRUE` partial unique index is race-safe and correctly mapped to `RunAlreadyInProgressError`; unused reservation lifecycle state (`releasedAt`/`expiredAt`/`releaseReason`, statuses `rejected`/`released`/`expired`, `reconciled`) is consistent with the documented out-of-scope payment/reconciliation boundary; `demo_run_summaries`/`demo_run_finalizations` are write-once via `onConflictDoNothing` (no mutable-summary path).

**Worker, queue, ERP, notifications (Slice 3):** the order lifecycle (`queued → processing → confirmed | failed`), at-least-once idempotency (terminal-order skip, jobId dedup, idempotent notification recorder), the consecutive-failure circuit breaker + half-open single-probe, retry/deferral separation, and transition-before-side-effect ordering are correct and well covered.

**Run lifecycle, load orchestration, finalization (Slice 4):** the single-non-terminal-run guarantee (fast-path read + partial unique index, both covering `starting`/`active`/`draining`), k6 success mapped only to `draining` (not benchmark completion), finalization waiting on settled business work with a settle-timeout bound, guarded duplicate/concurrent finalization, startup reconciliation of stale `starting`/`active` runs (leaving `draining` for the poller), k6 inputs injected as JSON literals with an argv array (no shell interpolation), and faithful buyer-spike / steady-arrival translation.

**Dashboard, realtime, admin, run history (Slice 5):** admin proxy routes enforce the admin session server-side and attach the control-service token in exactly one place (privilege from the signed HttpOnly cookie, never the request body); no service token, passphrase, visitor secret, or private API/ERP URL reaches the browser; browser code only calls same-origin routes; public DTOs (`DemoRunView`, `DemoRunSummary`, `DashboardRecoveryResponse`) are Zod-parsed and carry no reservation tokens/idempotency keys; the recovery coordinator's discard/serialized-follow-up protocol prevents stale live events from overwriting a fresh recovery baseline. (Unauthenticated `/api/dashboard/recovery` and `/dashboard/events` are intentional public spectator surfaces carrying only public-safe projections.)

**Shared contracts, logging, vocabulary (Slice 6):** reservation vs order terms stay distinct end to end; lifecycle vocabulary does not drift across contract/DB (`pgEnum` reuses the tuples)/services/UI; event/metric/queue names are sourced from the contract in every producer; `correlationId` flows through response headers, per-request loggers, queue jobs, ERP requests, and persisted rows (the `runId` optional-vs-nullable bridge in `order-confirmation.ts` is correct); timestamps are consistently offset-aware / `timestamp withTimezone`; the error shape is uniform across API/mock-ERP/load-orchestrator; the `packages/logger` health/readiness builders map worst-status-wins and 503-on-`unavailable` correctly; private test helpers are not leaked through public exports (`packages/db` exposes them via a dedicated `testing/` entry point).

**Runtime, configuration, operations (Slice 7):** `docker compose config` validates; services run as separate processes; k6 is baked into the load-orchestrator image; `/dashboard/events` is routed to the API on the single origin; compose uses service-DNS URLs for service-to-service calls; `runtime:up` does not seed/mutate; the setup image is a DB-only target; per-package test DB/Redis isolation is correct; the cleanup CLIs preserve active + recent runs and only touch generated-run ownership.

**Test suite quality (Slice 8):** test isolation is sound (a cross-process file lock keyed on the per-package test DB name serialises every infra-touching suite; unit lanes are infra-free; no `.skip`/`.only`/`xit`/`TODO`/`FIXME` hiding unfinished work); high-risk invariants (no-oversell, idempotent replay/conflict, sold-out cheap path, notification-after-confirmation idempotency, cleanup ownership, public run budget) are exercised against real infrastructure with real concurrency; pure state machines use injected clocks/RNG and boundary values; API integration suites drive `buildApiServer` with injected dependencies (the `apps/api` file-parallelism is safe because each `test/api` file holds the DB-name lock for its lifetime); `http-erp-client` and web BFF tests use injected fetch doubles but still validate the real wire contract.
