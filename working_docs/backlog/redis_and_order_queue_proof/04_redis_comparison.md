# 04 — Redis Comparison

**Design:** sections 2.3, 3.1, 4, 5 · **Depends on:** 03

## Goal

A visitor starts one fixed preset and sees, side by side on the same workload, what the Redis layer buys: Redis decides the stock and turns buyers away without touching PostgreSQL, so the database's load stays low while the same answers are given.

## Scope

- **Mode without Redis:**
  - PostgreSQL decides the stock in one round trip. A sold-out answer writes nothing synchronously; its count is batched like the demo mode's counters.
  - A winner's stock decrement, order and delivery row commit in one transaction.
  - The order queue lives in PostgreSQL (a job table claimed with `FOR UPDATE SKIP LOCKED`), with a pickup latency comparable to BullMQ's.
  - The same idempotency, run fence, bookkeeping, live counters and teardown as the demo mode. Redis still carries notifications and the live feed; the label says "stock decision and order queue in PostgreSQL".
- **Comparison conditions** (owner decision, 2026-10-12, design section 3.1):
  - The stores stay on the API's Machine. No store distance, simulated or real.
  - Buy-only API processes only if measured necessary. The single process was measured pinned in both modes (2026-10-13), so both runs of the Redis comparison are now served by 2 buy-only processes (`node:cluster`, same image). One control process keeps every single-owner duty, so HD-11 holds; HD-51 needs an amendment (task 06).
  - Ordinary runs and the queue comparison keep their path and topology.
- **Database load capture** from PostgreSQL's own statistics and its container's CPU time, over the selling window (until every buyer is answered), shown in the panel built by task 03, with the winners' and turned-away buyers' waits as separate rows.
- **Preset** (supervisor decision, 2026-10-13, after the owner rejected stock 1): a 10,000-buyer spike for 500 units with the standard ERP, the Surge 10k shape.
- **Measurement** in the proof environment as in design section 5, recorded in the working notes.

## Out of Scope

- Slimming the Lua script, production topology changes, `CAPACITY_*` recalibration.

## Done When

- The preset runs end to end in the proof environment with the same answers and protections in both modes, and the panel reads clearly.
- The measured pairs agree, and the results are in the working notes.
- Tests cover the new behavior at the right boundaries, including that sold-out answers do not serialize.
- **Owner checkpoint B:** the owner validates the comparison, or asks for changes.

## Size Budget

About 1,100 production lines and 700 test lines. Going beyond is recorded and explained in the notes first.

## Working Notes

### Plan (2026-10-12; approved without the pool and the distance)

**Claim.** Same buyers, one unit and the same answers in both runs. With Redis, PostgreSQL does almost nothing for turned-away buyers. With the stock in PostgreSQL, every buyer costs it one transaction. The headline is database work. Response times are shown only if the measured pairs agree.

**Modes and routing.** The comparison is `redis`, with modes `redis` (run 1, the normal `/buy`) and `postgres` (run 2). Because these mode names differ from the queue comparison's, a run's comparison can be derived from its mode, with no new run column. `buyTargetBaseUrl` sends `postgres` runs to `POST /stock-in-postgres/buy`, which is bound to a new `PostgresStockBuyService`. Every other mode keeps its target. Task 03's chaining, slot and budget rules are reused unchanged.

**Fairness mapping.**

| Protection | Demo (Redis) | Stock in PostgreSQL |
| :-- | :-- | :-- |
| Stock decision | Lua script, 1 Redis round trip | plpgsql `reserve_stock_in_postgres()`, 1 prepared autocommit call |
| Idempotency | Redis key: replay or conflict, then promotion | Partial unique `(sale_offer_id, idempotency_key)` on `reservations`, read in the same call. A replay returns the durable rows. A concurrent duplicate (23505) is called again once and becomes a replay |
| Run fence | Eligibility key and `runSaleStatus` in Lua. Winners then take the shared terminal advisory lock and re-read `demo_runs` | Every call reads `demo_runs.status in (starting, active)`. Winners take the same shared terminal lock (xact) and re-read the status in a fresh snapshot before any write. No closure code is needed: the existing transitions (draining at completion, terminal at reset or failure) close the sale at the same moments |
| Durable record before "yes" | Reservation, order and 2 events in 1 transaction, then the BullMQ add, then promotion | The same 4 rows, plus the queue row and the decrement, in 1 transaction |
| Live counters | Lua updates stock, sold-out count and throughput on every answer | Each process keeps in-memory deltas and flushes them every 100 ms into the **same Redis counters**, through a Lua that drops the batch once the run is closed (the same fence). The dirty signals are the same (`observeSoldOut`, `scheduleInventory`). Every reader stays unchanged: dashboard, enrichment, finalization and reset |
| Order queue | BullMQ, with its global limiter | `postgres_order_queue`, with the same handler, pacing and concurrency (below) |
| Teardown and reset | Redis namespace and PostgreSQL purges | Unchanged. The new rows cascade with their orders and run |

**Extra work in each mode (inherent to its architecture).**

- **Redis mode:**
  - Every turned-away buyer runs about 20 Redis commands, a counter write among them.
  - A winner pays for keeping two stores consistent: the hold, the pending record, the BullMQ add and the promotion. That is about 3 Redis and 8 PostgreSQL round trips on a reserved connection.
- **PostgreSQL mode:**
  - Every buyer costs PostgreSQL one call: 3 index reads, with no write and no lock.
  - Winners serialize on the stock row until commit, and each sends a NOTIFY.
- **Tilts toward PostgreSQL** (they make the claim conservative, and are disclosed):
  - 1 round trip per winner instead of about 11;
  - no counter write per turned-away buyer;
  - no pending-persistence path, which cannot occur inside one transaction. As a consequence, a PostgreSQL error is answered 500 in this mode, where Redis mode answers 202 "pending".

**Hot path** (in `0000_baseline.sql`). The function's steps:

1. Read the stock row; if missing, answer `inventory_not_initialized`.
2. Read the run's status; if not accepting, answer `run_not_accepting_traffic`.
3. Look up idempotency; answer a replay or a conflict.
4. If `remaining < qty`, return `sold_out`. The transaction is read-only and writes nothing.
5. Take the shared lock and re-read the status. Then `UPDATE … WHERE remaining >= qty`, which answers `sold_out` when no row matches. Insert the rows and the queue row, then `pg_notify`.

plpgsql is needed for the fresh snapshot after the lock, which a single CTE cannot give. The holds, promotion and pending recovery of the archived Redis-shaped flow are not needed.

**PostgreSQL order queue** (worker, `PostgresOrderQueueConsumer`). It ports the claim idea of `24bb3dc5` and the trimmed skeleton of `966060ca`, without generations or renewals.

- **Wake-up:** LISTEN wakes the consumer at commit, so pickup is comparable to BullMQ's.
- **Claim:** `FOR UPDATE SKIP LOCKED`, with a 60 s lease.
- **Pacing:** `erpDispatchRateLimit(maxTps)` and the snapshot's concurrency, read via `PostgresRunConfigReader`. These are the BullMQ limiter's values. `pauseDelivery` is honoured.
- **Processing:** the consumer calls the BullMQ consumer's own `processJob`, so the dead-letter and recovery dispositions are the same.
- **Settlement:** success deletes the row. A throw reschedules it after 5 s, at most 3 times. Redelivery is safe under the handler's execution claim.
- **No periodic poll.** The consumer claims on a notification, on (re)listen, and on a timer for rescheduled rows only.
- **Dispatch scanner:** it skips `postgres` runs, because their job commits with the order and there is nothing to repair.
- **Retries after an ERP failure** still go through the shared recovery path, which republishes to BullMQ (Q5).

**Buyer pool and simulated distance: recommendation, do not build them for this claim** (Q1).

- **The headline is per-request work.** It does not depend on how many API processes produce the requests, or on their distance to the stores.
- **One API process has headroom.** The hosted API process sustains `CAPACITY_CONSTANT_ARRIVAL_SOLD_OUT_PER_SECOND` = 3,500/s in Redis mode, and answers 2,600/s on a stock-1 spike (`reference_runtime_measurements.md`). In the 2026-10-08 study, the PostgreSQL path cost the API about 10–25 % more CPU per answer. At 1,000/s, the PostgreSQL mode should therefore use about a third of the process. This is an estimate, not a measurement.
- **The connection pool does not cap turned-away buyers.** postgres.js pipelines up to 100 statements per connection (`max_pipeline`, checked in 3.4.9).
- **Distance is symmetric for a turned-away buyer.** Such a buyer makes 1 round trip in either mode, to PostgreSQL or to Redis. The distance would only lengthen the Redis-mode winner path, and there is 1 winner.
- **Cost if kept:** about +270 production and +70 test lines, a new container in production's core, and 30 more database connections.
- **The trigger:** add the pool only if the first measured pairs show the process saturating (k6 dropped iterations, or turned-away buyers' latency rising in PostgreSQL mode).
- **If the owner keeps both:**
  - **Pool:** a container `api-buy` with the same image, running a `node:cluster` primary that forks 3 workers on port 4001. Linux round-robin spreads k6's connections across them.
  - **Buy-only composition:** a `createBuyPath()` extracted from `index.ts` serves both buy routes and health. Pending persistence is left to the control process's recovery scheduler, so the control process keeps every HD-11 duty.
  - **Routing:** only the two Redis-comparison modes target `API_BUY_POOL_BASE_URL`.
  - **Distance:** a pinned toxiproxy in front of PostgreSQL and Redis, used by the pool only. Its latency is 1 ms per round trip, because the toxic takes whole milliseconds and 0.8 ms (measured on Fly) cannot be set. It is disclosed as simulated.
  - **Decisions:** HD-51 is amended for comparison runs.

**Database load capture.**

- **Source:** `pg_stat_database` deltas for the current database: transactions (`xact_commit + xact_rollback`) and busy time (`active_time`), plus the Redis CPU from `INFO cpu`.
- **When:** the start snapshot is taken just before the runner's start command, for Redis-comparison runs only. The end snapshot is taken at finalization.
- **Settle wait:** PostgreSQL publishes a backend's statistics up to 10 s after the connection goes idle (`PGSTAT_IDLE_INTERVAL`). A run with a start snapshot therefore finalizes no earlier than `trafficEndedAt + 12 s`, behind a new finalization blocker. Run 2 starts after that, so the two windows never overlap.
- **Storage:** `demo_runs.store_load` (jsonb). The history detail exposes `storeLoad {pgTransactions, pgBusyMs, redisCpuMs} | null`.
- **Cost:** 2 small queries and 2 `INFO` calls per run.
- **Visitor reading:** totals and per-buyer values, with the scope stated: the whole database, background included, the same in both runs.

**Preset.** `redis-comparison`, public:

- constant arrival of 1,000/s for 10 s;
- stock 1;
- ERP 100 ms and 20 TPS;
- concurrency 5.

The conservative estimate is about 25 s per run and 50 s for the pair, against the 600 s ceiling. With the boots and the 12 s settle waits, the pair should actually take about 2–3 min.

**Panel and takeaway.**

- **One panel, two specs.** `ComparisonReport` takes a spec per comparison: title, intro, mode labels, rows and takeaway. `readComparison` finds the first run by its comparison's first mode.
- **Rows** (all buyers in both runs):
  - buyers secured / turned away / without an expected answer;
  - units sold, of stock;
  - PostgreSQL transactions;
  - PostgreSQL busy time;
  - both of these per buyer;
  - Redis CPU time;
  - turned-away buyers' p95 and longest wait, kept only if stable.
- **Takeaway gate:** both runs completed, every buyer answered as expected, the same secured and turned-away counts, the load known in both runs, and PostgreSQL mode's extra transactions at least 0.9 × the turned-away count.
- **Takeaway text:**

  > Same {n} buyers and {s} unit, same answers: {a} secured, {r} turned away. With Redis deciding the stock, PostgreSQL ran {tA} transactions and was busy {bA}. With PostgreSQL deciding, it ran {tB}, about one per buyer, and was busy {bB}, while Redis used {cB} of CPU against {cA}. Redis keeps turned-away buyers off the database.

- **Disclosure:** the statistics' scope; that Redis still carries the live dashboard, its counters and the notifications; that run 1 is always the Redis run.

**Measurement (design §5).** One preset entry in `capacity-measurement.mjs`:

- 5 starts, with pair 1 discarded as warm-up.
- Per mode, the median and min–max of:
  - PostgreSQL transactions and busy time, totals and per buyer;
  - Redis CPU;
  - the answer counts;
  - the delivered rate (0 dropped iterations shows that one process kept up);
  - the turned-away buyers' p95 and longest wait.
- The per-pair ratio range. A difference is claimed only if all 4 pairs agree.
- `comparison-analysis.mjs` gains these metrics.
- For diagnosis only: one cgroup CPU sample of `api` and `postgres` (the documented `flyctl machine exec` loop), to check the busy time against the CPU.

**Ordinary runs and production stay unchanged.**

- `/buy`, the Lua script, `ReserveOrderService`'s behavior and every inventory reader are untouched. The hold factory is extracted, not changed.
- The runner target changes for `postgres` alone. A unit test covers every mode and null, and the startup replay site.
- The new columns are null for ordinary runs, and the partial index skips them.
- The finalization blocker applies only to runs with a start snapshot.
- The scanner filter excludes only `postgres` runs.
- The queue consumer queries nothing unless notified.
- There is no new app, secret or Machine config (without the pool), `CAPACITY_*` is untouched, and the CI deploy is unchanged.
- The edited baseline requires `--fresh-core`, as in task 03.

**Changes** (production / test lines, generated snapshot excluded):

| Item | Prod | Test |
| :-- | --: | --: |
| Contracts: comparison and modes, `comparisonOfMode`, `storeLoad` | 30 | 10 |
| DB schema and baseline: enum values, `postgres_run_stock`, `postgres_order_queue`, `reservations.idempotency_key`, `demo_runs.store_load` | 55 | – |
| DB stock function (SQL) and TS wrapper | 120 | 170 |
| DB counter-mirror Lua and store-load reader | 55 | 40 |
| Seed `redis-comparison` | 20 | 8 |
| API: `PostgresStockBuyService`, `BatchedInventoryCounts`, hold factory, route and target, stock row at launch, wiring | 190 | 120 |
| API: store-load start, settle blocker and end capture, history mapping | 60 | 50 |
| Worker: queue consumer, persistence, wiring, scanner filter | 200 | 130 |
| Web: per-comparison spec, Redis rows and takeaway, labels | 160 | 80 |
| Scripts: preset entry and analysis metrics | 25 | 20 |
| **Total** | **~915** | **~630** |
| Pool and proxy, if kept | +270 | +70 |

**Tests** (boundaries only):

- **The function:** every outcome; 50 concurrent calls on stock 5 give exactly 5 winners; replay and conflict; the fence after a terminal transition.
- **No serialization:** while an open transaction holds the stock row `FOR UPDATE`, 200 concurrent sold-out calls all answer before it releases, and no row is written.
- **The mirror Lua:** it applies a batch, and drops it once the run is closed.
- **The API:**
  - a `postgres` run through `/stock-in-postgres/buy` answers and then finalizes with consistent counts;
  - routing;
  - the settle blocker, with a fake clock;
  - the `storeLoad` mapping.
- **The worker:** one delivery per job; pacing; a failed delivery retried; the scanner skips `postgres` orders.
- **The web:** the takeaway gate and the Redis rows.
- **Scripts:** the analysis metrics.
- **The seed:** the count and the pair's fit under 600 s.

**Risks.**

- The single API process at 1,000/s in PostgreSQL mode is not measured. The first pairs check it.
- The whole-database delta includes background work (worker scanners, dashboard rebuilds, finalization reads) in both runs. It is reported, not subtracted.
- `active_time` is wall-clock execution time, not CPU.
- A counter batch that lands after closure (a reset mid-traffic, or a stalled process) is dropped. The sold-out count can then be short by up to 100 ms of answers, but finalization stays consistent, as in Redis mode.
- The live queue panel reads BullMQ only, so it shows 0 for `postgres` runs. Task 05 labels it.
- The baseline edit requires a fresh core in production (task 06).

**Open questions** (each with a recommendation):

1. **Pool and distance.** Not building them deviates from owner decisions §3 and §3.1, so it goes to the owner's review list. **Recommendation:** defer both, and measure on the ordinary topology first.
2. **Live counters.** They are mirrored into Redis. The alternative is PostgreSQL-native counters with mode-aware readers at 7 sites, as in the archived `7188b9ad`/`7e348eb3`: about +150 lines, and the dashboard's reads would load PostgreSQL. **Recommendation:** the mirror, disclosed.
3. **Statistics source.** `pg_stat_database` needs no production configuration, but costs a 12 s settle wait. `pg_stat_statements` is exact and per statement, but needs a preload library in production's PostgreSQL and adds a small overhead to every run (a production change). **Recommendation:** `pg_stat_database`.
4. **Redis CPU row.** **Recommendation:** show it, because it says where the work went.
5. **Recovery retries.** In PostgreSQL mode they go through BullMQ. They cannot happen on the preset (ERP error rate 0). Routing them to the PostgreSQL queue would cost about +50 lines. **Recommendation:** accept it and disclose it.
6. **Response times.** **Recommendation:** keep the row only if all 4 pairs agree. Decided at checkpoint B.
7. **Stock 1.** With a single winner, Redis mode's dual-write cost does not show. **Recommendation:** keep stock 1, because the claim is about turned-away buyers.

### Arbitrations (supervisor and owner, 2026-10-12)

- **Plan:** approved, without the buyer pool and the simulated distance.
- **Q1, owner:** no store distance, simulated or real; task 06 states that the stores share the API's Machine. Buy-only processes only if the measurement shows the single process saturating in the PostgreSQL mode: then stop and report before building, try 2, and 3 only if 2 are not enough. The Scope section above is updated.
- **Q2:** the batched counters go into the same Redis live counters. The panel's mechanism line says that Redis still carries the live dashboard's counters and the notifications in this mode.
- **Q3:** `pg_stat_database` deltas, with the settle wait.
- **Q4:** the Redis CPU row is shown.
- **Q5, accepted:** retries after an ERP failure go through the shared recovery path, which republishes to BullMQ, in both modes. The preset's ERP never fails (error rate 0), so this path is not reached on it.
- **Q6:** stock 1 is kept. **For task 06:** Redis makes each winner cost work that one store does not need: keeping Redis and PostgreSQL in step (the Lua hold and pending record, the BullMQ add, the promotion, and the recovery machinery behind them). A winner then makes about 3 Redis and 8 PostgreSQL round trips, against about 11 PostgreSQL round trips, which include the stock row and the queue job, when PostgreSQL decides. With one unit the preset has one winner, so this cost does not show in its figures; the narrative must say it.

### Implementation (2026-10-12)

**Deviation from the plan: no stored function.** The reviewed baseline keeps "no functions" (`migration-metadata.test.ts` asserts it; `docs/local_development.md` says so). The stock decision is therefore:
- for every buyer, one prepared, read-only statement (stock row, run status, idempotency key). Once the stock is gone it writes nothing and takes no lock;
- for a buyer who saw units left, a transaction: the run fence's shared lock, a fresh read of the run's status, the same rows as the Redis path plus the queue job, the stock decrement last, and the notification. The few buyers who read the last unit before the winner committed (at 1,000/s, a handful) wait on the stock row, find it empty and roll back: bounded, and inherent to a read-then-conditional-update (review L2).

The headline is unchanged: a turned-away buyer costs PostgreSQL one read-only statement. **Fairness point:** the plan's tilt toward PostgreSQL for winners (one round trip) is gone. A winner now makes about 11 PostgreSQL round trips (the decision read, then 10 in its transaction), against the Redis mode's 8 PostgreSQL and 3 Redis round trips, so winners are treated about evenly. The supervisor accepted the deviation.

**Size** (net lines against `865054e0`, comments and blank lines included, generated snapshot excluded): about 1,263 production and 841 test lines, against a plan of 915 and 630. The supervisor accepted it as is. Where it grew:
- the worker queue (pacing, lease, retry, LISTEN, wiring): about 281 against 200;
- the API buy path, with the stock decision in TypeScript instead of SQL: about 433 against about 310;
- the live-counter batch script and the store-load reading: about 136 against 55;
- the web panel and labels: about 180 against 160;
- the scripts: about 49 against 25.

**Public admission path (supervisor check).** HD-53 is superseded by HD-59: the public custom limits bind only the custom preset. A fixed public preset takes no override and no custom-run capacity admission; its VUs are resolved at admission (1,000/s × 4 s = 4,000, within the 10,000 caps). The capacity test classifies `redis-comparison` as expected to complete on both deployments, and an API test estimates and starts it as a public visitor (budget charged once, run 2 chained).

### Review fixes (2026-10-12)

The independent review (`scratchpad/review/task04-code-review.md`) found the comparison fair in both directions. Each finding was checked against the code first.

- **M1, M2, L1 (the PostgreSQL queue's failure handling):** fixed by aligning it with BullMQ's single attempt.
  - The retry machinery is gone: `retryLater`, the delivery counter and its column.
  - A failed delivery goes to the shared recovery path through `processJob`. Its row is deleted only once that disposition is recorded; if recording it fails, the row stays leased.
  - When nothing is claimable, the consumer wakes at the earliest lease expiry, and its one timer keeps the earliest wake-up.
  - The rate arithmetic and the job adapter moved from the worker's composition root into the consumer module.
  - New tests: redelivery after a lease expires; settling after a handoff, and keeping the row leased when the handoff fails.
- **L2:** the wording is corrected in code comments, `docs/architecture.md` and these notes (racing buyers, above).
- **L3:** traffic-completion enrichment flushes the batched counts before it closes the sale.
- **L4:** a store-load counter that went backwards now reads as unknown, not 0.
- **L6:** a failed initial LISTEN is retried every 5 s.
- **Simplify:** `postgres_run_stock.reserved_stock` is dropped (it was never read).
- **Tests:**
  - concurrent requests with one idempotency key give one reservation and two identical answers;
  - the startup replay test (task 03's, which exists for `synchronous_confirmation`) now also covers `postgres`.
- **L5, not taken:** the PostgreSQL run's Redis eligibility stays `accepting` so the counter batches apply. A `/buy` carrying that run's ID would sell from the Redis copy, but only the runner reaches the API, and it targets one route per run. This is defence in depth only.
- **Own finding, a fairness fix:**
  - Drizzle sends every query unprepared (`client.unsafe` with `prepare: false`), so PostgreSQL parsed and planned the hot statement for every buyer. The Redis script is cached by its SHA, and the plan promised "1 prepared call".
  - The decision read now goes through postgres.js's prepared statements. PostgreSQL's CPU in that mode fell from about 0.85 to about 0.48 cores (series 1 against series 2 below, on two different hosts).
  - The stock tests now give each test its own pool, because a prepared statement must not outlive the schema that the test reset recreates.
- **Commits:**
  - `ac97e4df` fix(db): drop the PostgreSQL queue's retry columns and the unread reserved stock
  - `9928f2de` fix(worker): deliver each PostgreSQL queue job once and redeliver it when its lease expires
  - `60ad6e35` fix(api): prepare the PostgreSQL stock decision and keep the batched counts and store load honest
  - `01c5b5b6` test(api): give each PostgreSQL stock test its own pool across schema resets
  - `26f4cb34` docs: describe the PostgreSQL stock mode's racing buyers and its queue's single attempt
- **Validation:**
  - Dev container: `pnpm type-check` and `pnpm test:unit` pass.
  - Fly test runner: the full `pnpm test` passes (the unit suites, `test:api` 379, and integration: db 82, worker 109, mock-erp 7).
- **Sizes** (against `865054e0`): about 1,274 production lines (+11 from the fixes) and 920 test lines (+79). The worker source did not shrink: the lease wake-up, the handoff tracking, the LISTEN retry and the moved adapter balance the removed retry code (+130/−111).

### Live runs and measurement (proof environment, 2026-10-12)

**End to end, as a public visitor** (deployed fresh at `26f4cb34`; also at `1bb4c80a` before the fixes). The pair was started from "Start Redis comparison" on `https://cs-proof-gate.fly.dev/demo`, with no sign-in:
- Both runs completed with identical answers: 1 secured, 9,999 turned away, none unexpected; 1 order confirmed.
- Watch followed run 1 to run 2. The panel and the takeaway read correctly on Watch and on both run reports.
- The live counters matched: "9,999 sold-out rejections recorded" and "0 of 1 left" in the PostgreSQL run.
- Run 2 started about 13 s after run 1's traffic ended (the 12 s settle wait). The pair took about 65 s.

**Measurement** (design §5):
- Two series of 5 starts, each with pair 1 discarded. Order: Redis first.
- Every run of both series completed: 10,000 of 10,000 requests, 0 failed, 0 dropped, 1 accepted, 9,999 sold out.
- Diagnosis only, not a collector: CPU was sampled every 0.5 s on the core, per container cgroup and on the API's main thread.
- **Series 2** is the code as shipped (prepared decision read). Pairs 2–5, median (min–max):

| Metric | With Redis | Stock in PostgreSQL | Ratio | Pairs |
| :-- | --: | --: | --: | :-- |
| PostgreSQL transactions | 657 (621–704) | 10,678 (10,652–10,697) | 16.3 (15.2–17.2) | all higher |
| PostgreSQL busy time | 185 ms (155–219) | 1,804 ms (1,675–2,212) | 10.3 (9.1–10.8) | all higher |
| … per buyer | 0.07 tx, 0.019 ms | 1.07 tx, 0.18 ms | | |
| Redis CPU time | 4.08 s (3.99–4.16) | 1.80 s (1.73–1.97) | 0.44 (0.43–0.47) | all lower |
| PostgreSQL container CPU (diagnosis) | 0.13–0.14 cores | 0.44–0.53 cores | about 3.5 | all higher |
| Turned-away buyers' p95 wait | 82 ms (48–235) | 440 ms (57–965) | 4.2 (1.2–9.3) | all higher |
| Turned-away buyers' average wait | 16 ms (9–48) | 128 ms (11–251) | 5.6 (1.2–11.8) | all higher |

- **Series 1** (before the fixes, unprepared decision read, on another core host), pairs 2–5:
  - transactions: 648 against 10,651 (16.5×);
  - busy time: 109 against 1,409 ms (13.2×);
  - Redis CPU: 2.85 against 1.23 s;
  - PostgreSQL container CPU: about 0.08 against 0.85 cores;
  - turned-away p95: 17 against 278 ms.
- **The claim holds in every pair of both series.** With the stock in PostgreSQL, every buyer costs it about one transaction: about 10,000 more per run, and 10–13 times the statement time. With Redis, PostgreSQL only does the winner's work and the background work.
- **Where the work goes, per turned-away buyer** (series 2, from the CPU deltas between modes): about 0.23 ms of Redis CPU (Lua), against about 0.34 ms of PostgreSQL CPU.
  - So Redis also does the work more cheaply. The main point remains that it keeps that work off the shared, durable database.
  - The container CPU ratio (about 3.5) is smaller than the busy-time ratio (about 10). Both include the same background work (worker scanners, dashboard reads, checkpointer), but `active_time` counts statement execution only.
- **Response times (L7):** in every pair of both series, turned-away buyers waited longer with the stock in PostgreSQL. The magnitude varies widely (p95 ratio 1.2 to 9.3), mostly through the API process's event-loop queue. Per the arbitration, the row stays, with neutral wording, and stays out of the takeaway.

**Did the single API process keep up in the PostgreSQL mode?** Yes, by the agreed criteria, but close to its ceiling.
- **k6 dropped iterations:** 0 in all 20 measured runs and in both end-to-end pairs. Every buyer was answered.
- **Turned-away latency:** it does not drift upward over a run. In the end-to-end PostgreSQL run before the fixes, the per-second mean ran at 0.3–1.0 s, then fell to 88 ms by the last second, as completions caught up with arrivals.
- **API main thread** (series 2): a mean of 0.83–0.89 of a core, with peaks of 0.91–0.99, in both modes:
  - Redis mode: 0.82–0.88 mean;
  - PostgreSQL mode: 0.83–0.89 mean;
  - on series 1's faster host: 0.57–0.64 with Redis, against 0.84–0.87 with PostgreSQL.
- **Reading:** at 1,000/s the single process runs near its ceiling in the PostgreSQL mode, and on the slower host in both modes. Its event loop queues briefly, which shows in turned-away latency, not in dropped arrivals.
- **Consequence:** the headline (database work) does not depend on this. No pool was built; the decision is the supervisor's.

**Machines:**
- Stopped: the proof core (`7817405c341208`), the runner (`89663dc6ed09e8`), the guard (`e822636c56e428`, still scheduled hourly) and the test runner (`859726b4e16938`).
- **The gate** (`822090c7037938`) was stopped three times, and each time public traffic woke it again through the Fly proxy within seconds (event source `proxy`). It wakes no core unless a visitor starts the demo.

### Checkpoint B summary

Rewritten on 2026-10-13 after the owner rejected stock 1. The stock-1 measurement is kept above under "Live runs and measurement": 16 times the transactions without Redis, in every pair.

**What was built.**
- **A public preset,** `redis-comparison`: 10,000 buyers released at once for 500 units, with the standard ERP (the Surge 10k shape). One start runs it twice in the same slot: first with Redis deciding the stock, then with PostgreSQL deciding it and holding the order queue. The budget is charged once.
- **The PostgreSQL mode keeps the Redis path's protections:** idempotency, the run fence, and the reservation, order and events recorded before "yes".
  - A turned-away buyer costs one prepared, read-only statement and writes nothing.
  - A winner commits its rows, its queue job and the stock decrement in one transaction, on a reserved connection, as the Redis mode's persistence does.
  - The worker delivers the PostgreSQL queue with BullMQ's pacing, concurrency and single attempt.
- **Buy-only pool.** Both runs are served by the same 2 buy-only API processes, and one control process keeps every HD-11 duty. Ordinary runs and the queue comparison are unchanged.
- **Store load over the selling window,** from the run's start until every buyer is answered:
  - PostgreSQL's transactions and busy time (`pg_stat_database`);
  - the CPU time of PostgreSQL's container, which PostgreSQL reads from its own cgroup, exactly;
  - Redis's CPU, recorded but not shown.
  - **The window understates the PostgreSQL mode, so it is conservative.** PostgreSQL publishes a busy connection's statistics about once a second, so up to the window's last second of transactions and busy time is left out, mostly the PostgreSQL mode's decision reads.
- **The panel** has one row each for:
  - transactions;
  - CPU time;
  - time in queries, waits for the stock row included;
  - winners' wait;
  - turned-away buyers' wait;
  - every buyer answered.

  It also discloses the shared Machine and the two buy-only processes.

  **The takeaway is stated only when every condition holds:**
  - both runs completed;
  - they sold the same units;
  - every buyer got an expected answer;
  - the load figures are known;
  - the measured directions hold: more transactions and CPU, and longer turned-away waits, without Redis, with winners not slower.

**The exploration that led to the preset.** 2 processes, selling window; ranges across pairs; waits are averages; Redis vs PostgreSQL. Details are in the sections below.

| Candidate | Transactions | Busy (s) | PG CPU (core-s) | Winners (s) | Turned away (s) | All answered (s) |
| :-- | --: | --: | --: | --: | --: | --: |
| A 5k/500 | 3.3–3.7k vs 5.4–7.7k | 7–8 vs 25–29 | 6.9–8.6 vs 6.4–12.1 | 2.9–3.8 vs 2.0–2.2 | 3.8–5.1 vs 4.1–5.3 | 5.5–6.7 vs 4.7–6.8 |
| B 10k/500 (chosen) | 3.5–4.4k vs 10.5–12.5k | 5.3–5.6 vs 31–34 | 6.9–8.6 vs 13.7–18.5 | 2.3–3.3 vs 2.2–2.3 | 4.1–4.2 vs 6.2–7.6 | 6.0–6.5 vs 8.2–10.5 |
| C 10k/100 (informational) | 1.55k vs 10.4–11.3k | 1.4–1.5 vs 11–13 | 2.9–3.1 vs 7.2–11.3 | 1.1–1.5 vs 0.8–0.9 | 1.9–2.3 vs 2.7–4.0 | 3.7 vs 4.6–6.5 |

**What the measured pairs show.**
- **Method:** proof environment at `af7b77cb`; 5 starts, the first pair dropped as warm-up, so 4 pairs. Median (min–max); the ratio is per pair, without Redis over with Redis.
- **Same answers in every run:** 500 secured, 9,500 turned away, 0 failed, 0 dropped, 500 orders confirmed.

| Figure | With Redis | Without Redis | Ratio | Pairs |
| :-- | --: | --: | --: | :-- |
| PostgreSQL transactions | 4,739 (4,613–4,881) | 12,058 (11,460–12,940) | 2.5 (2.5–2.7) | all higher |
| PostgreSQL CPU time | 11.1 s (10.6–11.5) | 18.5 s (10.4–22.2) | 1.7 (0.93–2.0) | mixed |
| Time in queries, stock-row waits included | 5.4 s (5.0–5.8) | 30.2 s (24.1–35.9) | 5.5 (4.8–6.2) | all higher |
| Winners' average wait | 2.5 s (1.9–2.5) | 2.1 s (2.0–2.5) | 0.84 (0.80–1.3) | mixed |
| Turned-away buyers' average wait | 4.8 s (4.3–5.2) | 7.3 s (4.9–9.4) | 1.6 (1.1–1.9) | all higher |
| Every buyer answered within | 7.4 s (6.4–7.8) | 9.8 s (6.1–10.9) | 1.3 (0.84–1.6) | mixed |
| Whole-run transactions (context) | 12,612 (12,488–12,739) | 23,484 (22,369–24,247) | 1.9 | all higher |

- **The ERP pace** was 17.7 orders per second with Redis, against 15.5 for the PostgreSQL queue. It is about 12 % slower, which affects only the whole run.
- **The mixed pair is pair 2.**
  - Its PostgreSQL run answered every buyer in 6.1 s, the fastest of all.
  - Over that shorter window, PostgreSQL's CPU came to 0.93 times the Redis run's: the order work, about 1.1–1.3 cores in both modes, dominates it.
  - Its winners waited 2.5 s against 1.9 s.
- **The panel's takeaway shows for 3 of the 4 pairs** (pair 2 shows the numbers alone). For pair 4, it reads:
  > Same 10,000 buyers, and the same 500 units sold in both runs. Without Redis, until every buyer was answered, PostgreSQL ran about 2.7 times the transactions and used about 1.5 times the CPU time. The turned-away buyers waited longer, 6.5 s on average against 5 s, while the winners were not slower, 2 s against 2.4 s: with Redis, a winner goes through two stores and the queue.

**The scanner fix and ordinary runs.**
- **Every run of the demo now publishes again only the queued orders whose job is missing.** The independent review confirmed that the repair guarantee is the same.
- **On an ordinary `surge-5k` run,** transactions went from 19,799 to 12,844 (−35 %), and orders published again from 2,381 to 0.

**The pool and the core Machine's CPU headroom.**
- **Each buy process's main thread** ran at 0.6–0.8 of a core, the control process at 0.06–0.27 and the cluster primary at about 0.15.
- **The measured containers** used 4.7–5.1 of the 6 vCPUs on average while buyers were answered, in both modes, with half-second peaks at 5.2–5.7. **About one vCPU is left,** so a third process would compete for the same CPUs.
- **The pool's production impact** is on the owner's review list (supervisor). HD-51 needs an amendment in task 06.

**A defect found and fixed before the measurement.**
- **Symptom:** in the PostgreSQL mode, 4 of 10 runs of the 10,000-buyer spike failed on one `500` answer.
- **Cause:** postgres.js raised `UNSAFE_TRANSACTION`. It reserves a pooled connection for `sql.begin` only when the `BEGIN` leaves room in the connection's pipeline, and the decision reads fill the pipelines.
- **Fix** (`d64a9655`): the winner's transaction now runs on a reserved connection, like the Redis mode's.
- **After the fix:** 0 errors in 8 runs, 3 confirmation pairs plus the measurement.

**Sizes.**
- **Measured:** about 1,677 net production and 1,115 test lines for task 04.
- **Accepted earlier:** 1,263 and 841, then the pool (about 270) and the scanner fix.
- **The rest** comes from the panel rework, the CPU capture, the transaction fix and the review fixes.

**Decision asked.** Validate the comparison live by starting "Redis comparison" on `https://cs-proof-gate.fly.dev/demo`.

**Recommendation:** validate it, with two adjustments to the takeaway gate:
- **Headline the transactions,** which held in every pair at 2.5–2.7 times, rather than the CPU.
  - Keep the CPU row, and state CPU in the takeaway only when it is higher. Its direction did not hold in 1 of 4 pairs, because the shared order work dominates a short window.
- **Drop "winners were not slower" from the gate.** It did not hold in 1 of 4 measured pairs, nor in 2 of 9 earlier pairs. State the winners' waits as numbers only.
- **As built,** the takeaway would be hidden on about one comparison in four.

**Open points.**
- The ERP pace of the PostgreSQL queue is about 12 % lower (whole run only).
- **Redis-mode duplicate inserts:** a few `reservations_pkey` duplicates appear in PostgreSQL's log during Redis-mode spikes. They take the existing recoverable-conflict path (`isRecoverableReservationConflict`) and change no answer. This is pre-existing and was not investigated.
- **Fairness points for task 06:**
  - the prepared hot statement;
  - the reserved connection per winner in both modes;
  - the shared Machine;
  - the conservative window.

### Re-tuning with units left: fairness check and exploration (2026-10-13, stopped before choosing)

Owner request, after checkpoint B: stock 1 hides the contention and the order work that a real flash sale puts on the database. Re-tune with units left.

**Fairness check under contention.** The PostgreSQL mode is a single stock row with a conditional decrement, a standard design.
- **The pre-check** is a prepared, read-only statement.
- **A buyer who sees units left** runs one transaction. The row lock is taken last, by the conditional `UPDATE … WHERE remaining_stock >= qty`, and held only until the commit.
- **The pool** is the same 10 connections as in the Redis mode. The winner's inserts use Drizzle, unprepared, like the Redis mode's persistence.
- **One avoidable cost, fixed** (`64c79d05`): the `NOTIFY` ran after the decrement, holding the row lock one round trip longer. It now runs before.
- **Inherent costs:** buyers racing for the last units insert their rows and roll back; and winners serialize on the row through their commit.

**Exploration.**
- **Method:** in the proof environment only, the seeded preset row was edited in place (`psql`, at `1ae73d47`; the seed restores it on the next core start). 2 pairs per candidate, with the Redis run first. ERP 100 ms and 20/s, concurrency 5.
- Every run completed: 0 failed, 0 dropped, 500 accepted, 500 orders confirmed.
- **Columns:**
  - **Tx / busy:** PostgreSQL transactions, and busy time in seconds.
  - **Winners / turned away:** average / p95 wait, in seconds.
  - **Sold out:** time until the stock sold out, in seconds.
  - **All answered:** time until every buyer was answered, in seconds.
  - **Main / PG CPU:** API main thread, and PostgreSQL CPU, in cores over the answering period.
  - **Pace:** the ERP pace, in orders per second.

| Run | Mode | Tx | Busy | Winners | Turned away | Sold out | All answered | Main | PG CPU | Pace |
| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| A1 (5k spike) | Redis | 19,385 | 12.0 | 4.3 / 7.2 | 7.8 / 10.8 | 0.70 | 11.0 | 0.86 | – | 16.9 |
| A1 | PostgreSQL | 18,157 | 17.9 | 3.0 / 4.7 | 11.2 / 12.6 | 0.53 | 12.9 | 0.94 | – | 15.4 |
| A2 | Redis | 19,038 | 11.0 | 2.7 / 5.0 | 6.7 / 8.8 | 2.34 | 9.1 | 0.89 | – | 18.3 |
| A2 | PostgreSQL | 17,171 | 14.4 | 1.6 / 3.0 | 5.9 / 6.5 | 0.83 | 6.8 | 0.95 | – | 15.9 |
| B1 (10k spike) | Redis | 19,648 | 11.2 | 3.7 / 5.9 | 9.0 / 13.5 | 0.56 | 13.7 | 0.82 | 1.23 | 17.4 |
| B1 | PostgreSQL | 22,093 | 14.2 | 2.1 / 3.6 | 7.6 / 10.9 | 0.74 | 11.5 | 0.88 | 1.29 | 15.7 |
| B2 | Redis | 19,645 | 11.7 | 3.7 / 5.6 | 6.3 / 10.7 | 0.56 | 11.1 | 0.82 | 1.14 | 17.5 |
| B2 | PostgreSQL | 21,840 | 14.0 | 1.9 / 3.2 | 5.9 / 8.2 | 0.50 | 8.4 | 0.84 | 1.35 | 15.8 |

(The PostgreSQL CPU sampler was not running during candidate A.)

**What it shows. This contradicts the expectation, so the work stopped here.**
- **The single API process is saturated in both modes, for both candidates.** Its main thread stays at 0.82–0.98 of a core for the whole answering period (7–13 s): the per-second samples are pinned from the spike's first second until the last answer. Every wait is dominated by that process, not by the store.
- **The database's work is not clearly higher without Redis:**
  - PostgreSQL ran 17,000–22,000 transactions in both modes. With the 5k spike it ran *fewer* without Redis.
  - Busy time is only about 20–60 % higher without Redis.
  - PostgreSQL CPU is about the same (1.1–1.35 cores).
- **Most of the Redis mode's PostgreSQL work is order work.** It comes to about 39 transactions per order.
  - **The likely main cause** (from the code, not separately measured): while the 500 orders wait for the ERP's pace (about 28 s), the worker's dispatch scanner re-publishes every queued order older than 1 s to BullMQ, up to 100 per second. Each re-publication is fenced by 3 PostgreSQL statements (lock, run check, unlock), so this could be up to about 8,000 transactions per run.
  - This repair loop exists only for the Redis mode's dual write; the PostgreSQL queue's job commits with its order.
  - The decision reads that the PostgreSQL mode adds (one per buyer) are of the same order of magnitude, so the totals come out about even.
- **Winners were answered faster without Redis in every pair:** p95 3.0–4.7 s, against 5.0–7.2 s.
  - Turned-away buyers: mixed with the 5k spike, faster without Redis with the 10k spike.
  - The stock sold out in about the same time (0.5–0.8 s); the single stock row did not visibly slow selling.
- Nothing was changed in the preset, the panel or the seed.

**Decision needed (supervisor or owner).**
- **The buyer pool, required by step 3** because the process is pinned (owner: 2 processes first).
- **The store-load scope, whatever the topology.** As measured, it mixes the selling phase with the order lifecycle, and it charges the Redis mode with the dispatch scanner's re-publication loop. Options:
  1. measure only the selling window (until every buyer is answered);
  2. treat the scanner's per-second re-assertion as a separate finding (it is an inefficiency of the demo's current design, also present in ordinary runs);
  3. both.
- **Whether stock 500 still serves the database-load claim.** It may instead serve a different, contention-centred claim.

### Scanner fix, buy-only pool and selling window, then the exploration again (2026-10-13, stopped before choosing)

Supervisor decisions after the stop above: fix the dispatch scanner first, build the buy-only pool (2 processes), headline the store load over the selling window, then explore A, B and the informational C again. Stop before choosing the preset.

**Dispatch scanner: a defect, fixed** (`5888c5da`).
- **What it did:** every scan (1 s) published again every queued order older than 1 s. Each publication ran its own fenced round on a reserved connection (lock, run check, unlock: 3 statements). BullMQ ignores a job ID it already holds, so the work bought nothing.
- **No decision requires it.** `docs/decisions/` has no entry on the scanner. `docs/architecture.md` asks it only to reassert orders whose immediate enqueue was lost.
- **Fix:** one existence check per scan (`HEXISTS` on each candidate's job hash, sent together), then the usual fenced publication only for the orders whose job is missing. The repair guarantee is unchanged: BullMQ ignores a job ID whose hash exists, so the old re-publication created a job exactly when the hash was missing, as the new check does. (A failed order goes through `order_recovery_jobs`, which the dispatch query excludes.)
- **Cost on one ordinary `surge-5k` run** (Redis path), transactions from start to teardown:

  | | Transactions | Scans with candidates | Orders published again |
  | :-- | --: | --: | --: |
  | Before | 19,799 | 27 | 2,381 |
  | After | 12,844 | 28 | 0 |

  The 6,955 saved transactions match 3 × 2,381.
- **Scope:** a defect fix for every run of the demo. For this comparison it is a fairness fix: the loop charged the Redis mode alone, because the PostgreSQL queue's job commits with its order.

**Buy-only pool** (`5baa2660`, `e4f13e0d`).
- **Shape:** an `api-buy` container in the core, from the same image, runs `dist/buy-server.js`. A `node:cluster` primary forks `API_BUY_PROCESSES` (2) processes on port 4001. Each process has the control API's pool sizes (10 PostgreSQL connections) and serves only the buy routes and health. Both modes use the same pool.
- **The control process keeps every HD-11 duty:** starts, resets, finalization, runner operations, and pending-persistence recovery. A buy process that meets a pending reservation leaves it to the control process's recovery scheduler.
- **Routing:** `buyTargetBaseUrl` sends only the Redis comparison's two runs to the pool (`API_BUY_POOL_PORT`). Ordinary runs and the queue comparison are unchanged.
- **Scheduling:** first measured with the default round-robin scheduling (A below, first table). The primary then hands each connection to a process over IPC, one at a time. Buyers waited seconds before their request reached a handler, while the handler itself took about 0.2 s. Switching to direct accept by each process (`SCHED_NONE`) changed little: the bound turned out to be elsewhere (see the reading).
- **For task 06:** HD-51 ("one API process stays") needs an amendment. For the Redis comparison's runs only, buyers are served by a pool of buy-only processes, while one control process keeps every run duty. HD-11 is unchanged.
- **Size:** about 320 net production lines across the three commits, including the 54-line container entry. `runtime/buy-path.ts` is mostly code moved out of `index.ts`.

**Selling window** (`9a2bca2f`).
- **The store load now closes** when the runner reports that every buyer is answered, instead of at finalization. Finalization no longer waits for statistics to settle (`storeLoadSettleMs` removed).
- **Caveat:** PostgreSQL publishes a busy connection's statistics about once a second, so up to the window's last second of PostgreSQL work is left out. This understates the PostgreSQL mode most, because its decision reads continue until the end.
- **Cross-check:** PostgreSQL's CPU (cgroup) is exact; it is given below in core-seconds over the same window.
- **Whole-run figures** (`pg_stat_database` sampled every 2 s, from the run start to finalization) are given as context only.

**Exploration.**
- **Method:**
  - proof environment at `e4f13e0d`; the preset row was edited in place (`psql`), with the Redis run first in each pair;
  - ERP 100 ms and 20/s, concurrency 5;
  - every run delivered every request, with 0 dropped.
- **Columns:**
  - **Tx / Busy:** PostgreSQL transactions, and busy time in seconds, over the selling window.
  - **PG core-s:** PostgreSQL CPU over the same window, in core-seconds.
  - **Winners / Turned away:** average / p95 wait, in seconds.
  - **Answered:** time until every buyer was answered, in seconds.
  - **Ctrl / Buy:** main-thread CPU, in cores over the window: the control process, then each buy process (the cluster primary stays at 0.00).
  - **Whole tx:** whole-run transactions, for context only.

A (5,000 spike, 500 units), first with round-robin scheduling:

| Run | Mode | Tx | Busy | Winners | Turned away | Answered | Buy | PG cores | Whole tx |
| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: |
| A1 | Redis | 4,296 | 5.7 | 2.7 / 4.2 | 4.9 / 6.3 | 6.5 | 0.60 / 0.60 | 1.31 | 12,683 |
| A1 | PostgreSQL | 4,939 | 29.2 | 2.5 / 3.7 | 4.9 / 5.3 | 5.8 | 0.61 / 0.66 | 1.46 | 17,545 |
| A2 | Redis | 3,629 | 5.1 | 2.4 / 4.1 | 3.9 / 5.4 | 5.6 | 0.60 / 0.61 | 1.25 | 12,796 |
| A2 | PostgreSQL | 6,813 | 31.6 | 2.4 / 3.7 | 6.7 / 8.1 | 8.3 | 0.69 / 0.60 | 1.75 | 18,468 |

With direct accept (all tables from here on):

| Run | Mode | Tx | Busy | PG core-s | Winners | Turned away | Answered | Ctrl | Buy | Whole tx |
| :-- | :-- | --: | --: | --: | --: | --: | --: | --: | --: | --: |
| A1 (5k / 500) | Redis | 3,334 | 6.9 | 6.9 | 2.9 / 4.2 | 3.8 / 5.4 | 5.5 | 0.26 | 0.64 / 0.67 | 12,895 |
| A1 | PostgreSQL | 5,437 | 24.5 | 6.4 | 2.2 / 3.4 | 4.1 / 4.2 | 4.7 | 0.08 | 0.54 / 0.62 | 17,204 |
| A2 | Redis | 3,675 | 7.8 | 8.6 | 3.8 / 6.1 | 5.1 / 6.5 | 6.7 | 0.27 | 0.60 / 0.56 | 12,719 |
| A2 | PostgreSQL | 7,687 | 29.3 | 12.1 | 2.0 / 3.1 | 5.3 / 6.6 | 6.8 | 0.08 | 0.68 / 0.62 | 18,370 |
| B1 (10k / 500) | Redis | 3,520 | 5.4 | 6.9 | 2.7 / 3.9 | 4.2 / 5.8 | 6.0 | 0.17 | 0.67 / 0.62 | 12,249 |
| B1 | PostgreSQL ¹ | 10,517 | 31.2 | 13.7 | 2.2 / 3.4 | 6.2 / 7.7 | 8.2 | 0.07 | 0.66 / 0.74 | 23,356 |
| B2 | Redis | 4,386 | 5.6 | 8.6 | 3.3 / 4.9 | 4.1 / 6.1 | 6.5 | 0.25 | 0.62 / 0.59 | 13,190 |
| B2 | PostgreSQL | 12,303 | 33.8 | 18.5 | 2.3 / 3.5 | 7.6 / 10.2 | 10.5 | 0.07 | 0.75 / 0.50 | 24,282 |
| B3 | Redis | 4,081 | 5.3 | 7.9 | 2.3 / 3.5 | 4.1 / 5.4 | 6.4 | 0.26 | 0.64 / 0.68 | 12,678 |
| B3 | PostgreSQL | 12,524 | 31.8 | 14.8 | 2.2 / 3.3 | 6.2 / 8.8 | 9.4 | 0.08 | 0.78 / 0.56 | 23,655 |
| C1 (10k / 100) | Redis | 1,552 | 1.5 | 3.1 | 1.5 / 1.7 | 2.3 / 3.5 | 3.7 | 0.18 | 0.63 / 0.61 | 2,687 |
| C1 | PostgreSQL | 10,367 | 10.9 | 7.2 | 0.9 / 1.1 | 2.7 / 4.3 | 4.6 | 0.06 | 0.72 / 0.78 | 11,789 |
| C2 | Redis | 1,547 | 1.4 | 2.9 | 1.1 / 1.3 | 1.9 / 3.4 | 3.7 | 0.12 | 0.76 / 0.75 | 2,801 |
| C2 | PostgreSQL | 11,266 | 13.2 | 11.3 | 0.8 / 1.0 | 4.0 / 5.7 | 6.5 | 0.06 | 0.68 / 0.70 | 12,020 |

¹ One response of 10,000 was unexpected, so the run failed. The cause was not captured: logs were not streamed during that series. A third B pair (B3), with logs streamed, and both C pairs had none. This must be explained before the full measurement.

**Reading.**
- **No process is pinned any more.** Each buy process's main thread runs at 0.5–0.8 of a core, the control process at 0.06–0.27, and the cluster primary at 0.
  - **The bound is now the core Machine itself.** The five measured containers use 4.3–5.0 of its 6 vCPUs on average over the window, with half-second peaks at 5.2–5.6, in both modes. PostgreSQL alone uses 0.8–1.3 cores even in the Redis mode, mostly order work.
  - **A third process would compete for the same CPUs, so it was not tried** (the step applied only if the processes stayed pinned).
- **Database work differs clearly and consistently in B and C:**
  - Over the selling window, PostgreSQL ran about 3× (B) and 7× (C) the transactions without Redis.
  - Its busy time was about 6× (B) and 8× (C) higher.
  - Its CPU was about 2× (B) and 2.3–3.9× (C) higher, in exact core-seconds.
  - Whole-run transactions were about 1.85× (B) and 4.3× (C) higher.
  - In A the difference is weaker: the CPU was even in one pair.
- **Waits now differ consistently in B and C, in opposite directions for the two kinds of buyer:**
  - **Turned-away buyers waited longer without Redis:** on average 6.2–7.6 s against 4.1–4.2 s (B), and 2.7–4.0 s against 1.9–2.3 s (C).
  - **Every buyer was answered later without Redis:** after 8.2–10.5 s against 6.0–6.5 s (B), and 4.6–6.5 s against 3.7 s (C).
  - **Winners were answered slightly faster without Redis in every pair:** 2.2–2.3 s against 2.3–3.3 s (B), and 0.8–0.9 s against 1.1–1.5 s (C).
  - **Why winners differ:** with Redis, a winner crosses two stores and the queue publication, while the turned-away buyers' Redis decisions take the same busy processes. Without Redis, the stock sells out in 0.24–0.41 s, and later readers are turned away by one read.
  - **The busy time includes lock waits.** Sampled activity shows the PostgreSQL mode's winners queuing on the stock row (`Lock`) while the row holder waits for its busy API process (`ClientRead`).
  - **In A, the waits are mixed.**
- **Candidate B looks the most promising for the database-load claim with units left.** C gives the largest ratios but little order work.

**Decision needed (supervisor or owner):**
- the preset (B, or C);
- whether the panel shows the winners' and turned-away buyers' waits separately, since their directions are opposite;
- the B1 unexpected response, to be explained first.

Nothing was changed in the seed, the preset or the panel.

### Preset B, the unexpected answer, the review fixes and the full measurement (2026-10-13)

Supervisor decisions after the exploration:
- **Preset:** B, public, with the 2-process pool for both runs.
- **Panel:** separate rows for winners' and turned-away buyers' waits; PostgreSQL CPU as the primary load figure; no Redis CPU row.
- **Takeaway:** gated on the measured directions, with a disclosure line.
- **Before the full measurement:** explain B1's unexpected answer, then apply the independent review's findings.

**The unexpected answer.**
- **Reproduction:** six B pairs at `e4f13e0d`, with the core's logs streamed (`R`). The PostgreSQL run failed on one `500` answer in pairs 1, 3 and 6.
- **The buy process logged the cause:** `UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1`.
- **Mechanism:**
  - In postgres.js 3.4.9, `execute()` calls the `onexecute` hook that marks a `sql.begin` connection as reserved only if the write succeeded and the pipeline still has room (`connection.js:173-177`).
  - In the PostgreSQL mode, thousands of prepared decision reads fill every pipeline. Now and then, a winner's `BEGIN` was pipelined onto an unreserved connection, and postgres.js refused the transaction at its `CommandComplete`.
  - The Redis mode was immune: its persistence already reserves a connection and sends `begin`/`commit` itself.
- **Fix** (`d64a9655`): the PostgreSQL mode's winner transaction does the same.
  - It is a defect fix, and also a fairness fix: both modes now pay one `reserve()` per winner.
  - **Test:** a pool with a one-query pipeline (`max_pipeline: 1`) makes the full-pipeline case certain. 40 concurrent buyers must all get an expected answer.
- **After the fix:** 3 confirmation pairs (`K`) and the 5 measurement starts had no error, with logs streamed.
- **What the reproduction pairs also showed** (before the fix):
  - transactions 2.3–2.9 times without Redis;
  - turned-away buyers waited longer in every pair;
  - winners were slower without Redis in 1 of 6 pairs.

**Review fixes** (independent review of `5888c5da..7b12ad05`). The scanner fix was confirmed: the repair guarantee is intact.
- **F2** (`e0676c9f`): the cluster primary logs a worker's exit and forks a new one after 1 s.
- **F3:** the `api-buy` health check calls `/health/live`, which opens no database or Redis connection.
- **F5:** scheduling is back to the default.
- **Least privilege:** `api-buy` no longer receives the control token and the cookie secret. The buy process fills them with throwaway values for the shared configuration.
- **F4** (`5f477c9b`):
  - For a PostgreSQL-stock run, the control process now flushes its own counts before closing the sale, then waits two intervals (200 ms) so every buy process's last batch lands.
  - **Test:** a batch added during that wait is counted, and the sale then closes.
- **F8** (`b8ee09e8`): only the BullMQ publisher has the presence check. The generic factory no longer defaults it to "every job missing".
- **F6** (`af7b77cb`): stale texts corrected.
- **F1, the pool's production impact:** recorded on the owner's review list by the supervisor.

**PostgreSQL CPU in the store load** (`11f6381e`).
- PostgreSQL reads its container's `cpu.stat` with `pg_read_file`. The application connects as the `postgres` superuser in the core and locally.
- It is exact, with no statistics lag, and null where unreadable.
- In the measurement it includes the window's start: the run's setup before the first buyer.

**Full measurement:** 5 starts at `af7b77cb`, the first pair dropped. Results are in the checkpoint B summary above.
- Per measured pair (2–5), transactions ratio 2.5 / 2.5 / 2.7 / 2.6; CPU ratio 0.93 / 2.0 / 1.5 / 1.9; turned-away average-wait ratio 1.1 / 1.8 / 1.3 / 1.9.
- **While buyers were answered,** the five measured containers averaged 4.7–5.1 vCPUs of the core's 6 in every run.
