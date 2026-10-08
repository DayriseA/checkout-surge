# 15a — Capacity Measurement

**Design:** section 1.2 · **Depends on:** 13c

## Goal

Each deployment's capacity is measured for both connection modes, the effect of stock is measured and explained, and a committed script lets anyone re-measure.

## Scope

- **Measurement script** (owner decision, 2026-10-08).
  - A small committed script starts a series of admin runs from given settings: mode, rate or buyers, duration, stock, VUs, ERP settings.
  - It waits for each run to end and reads the evidence each run already persists: dropped iterations, latency, arrival summary, generator utilisation, server reservation timing.
  - Node builtins only, so it also runs inside the hosted API container, where the control token stays on the Machine (13a method).
  - Core CPU and connection sampling (13a method) stays outside the script unless it is trivial to add.
  - Document the method in `docs/`, next to related material such as `docs/estimator_calibration.md`.
  - Write and check the script without heavy runs on the owner's workstation, which lacks the resources.
- **Stock effect** (owner decision, 2026-10-08). Find the break point at two extremes, then check mixes:
  1. **All sold out** (minimal stock): confirm the 13a figures with the script, once per mode.
  2. **All accepted** (stock at least the number of requests): bisect the rate as in 13a, with short runs (about 10 s) and the stock following the rate. Set the ERP to its fastest (concurrency 10, low latency, high TPS) so that draining the queue fits the 600 s estimate ceiling.
  3. **Mixes:** one or two, including stock 1,000 (the public maximum). Check that a simple additive model (the cost of accepted orders plus the cost of sold-out answers) predicts them. Add stock levels only if it does not.
  - Explain the mechanism from the code path and the measurements.
- **Per mode:** the constant-arrival capacity C (reused connections), the buyer-spike capacity C' (a new connection per buyer), and the latency near saturation. That latency sets the VU latency budget, since the VUs needed are about the rate times the latency.
- **Where.**
  - **Fly:** runs are driven by a subagent from the owner's workstation, on the live deployment, so visitors see "a run is in progress" meanwhile. Admin runs set explicit VUs, so that the current default allocation does not bias the results.
  - **Local:** the owner runs these in cloud sessions, each with its own VM, in parallel. The supervisor prepares the prompts, and the owner pastes the results back. Record each VM's CPU and memory; the local default comes from this measurement (owner decision).
- **Results.**
  - Record them in `docs/reference_runtime_measurements.md`, for hosted and local.
  - In the working notes below, propose for each deployment: C, C', the latency budget, and whether stock enters the model.
  - The same file says visitors see the explanatory estimate. No component renders it, so correct the doc (owner decision, 2026-10-08: do not display it).

## Out of Scope

- Admission code and VU allocation (15b), public limits and visitor explanations (15c).

## Done When

- The script and its method are committed.
- C, C' and the latency budget are measured on Fly and on a cloud VM, and the stock effect is measured and explained.
- The proposed values are in the working notes, ready for 15b.

## Open Points

- None.

## Inputs from Preparation (2026-10-08)

- **13a measured mostly sold-out answers.** Its capacity runs used 500 stock, so about 98 % of their requests were sold-out answers.
- **Accepted order** (`reserve-order-service.ts`), done synchronously before the API answers:
  - one Redis Lua call;
  - a reserved Postgres connection with a shared advisory lock;
  - one transaction (reservation, order, two order events);
  - a BullMQ job;
  - a Redis promote eval.
  - The API Postgres pool max is 10 (`apps/api/src/runtime/config.ts`), not overridden on Fly.
- **Sold-out answer:** the entry checks, then one counter HINCRBY and one HSET. No Postgres, no BullMQ.
- **Admin runs** have stock and ERP uncapped. The estimator (600 s ceiling) applies to every run, admin included, so a large stock needs a fast ERP.
- **Buyer spike:** VUs equal the buyers, so VUs cannot run out. The safety cutoff (k6 `maxDuration`) bounds the run.
- **Tooling.** `pnpm runtime:acceptance` starts runs through the admin API, but its fixtures are fixed (no rate, VU or stock parameter). 13a's scratch scripts were not committed.

## Inputs from Task 13a

- **Break point.**
  - Over reused connections (constant arrival), the hosted core answers about 3,200 requests per second, bounded by the single API process. 10 s runs were complete at 3,125 per second (twice), and at 3,500 per second all 10,000 VUs were in flight and iterations were dropped.
  - New connections per request (buyer spike) are answered at about 1,000 per second.
  - VU exhaustion breaks first: no failed request, timeout or connection error at any rate tried, up to 5,000 per second.
- **Connection modes.**
  - A buyer spike opens one connection per buyer (`per-vu-iterations`, one VU per buyer).
  - Constant arrival reuses each VU's connection, so the open connections equal the VUs in flight (10,004 at the cap).
- **Default VU allocation.**
  - `resolveConstantArrivalVus` (`packages/contracts/src/load.ts`): pre-allocated = rate, max = 2 × rate, capped at 10,000 (`maximumAutomaticallyDerivedVUs`). It applies whenever `k6Vus` is absent, which is always the case from the public form.
  - At 1,000 per second, the start latency transient (1 to 2 s) exhausts it: about 1 % dropped. 5,000 pre-allocated VUs kept runs complete up to 2,000 per second, and 10,000 up to 3,125.
  - Rule of thumb from the runs: the VUs needed equal the rate times the latency, and the latency climbs to about 3 s near saturation.
- **Generator memory.** About 225 kB per k6 VU; 2.8 to 3.0 GB at 10,000 VUs on the 16 GB runner.
- **ERP settings do not hold VUs.** A VU is released when the API answers the buy request, at reservation time. ERP latency and rate only stretch the asynchronous drain (worker and queue), not the traffic phase.
- **Latency.** 10 s runs at 1,000, 1,500 and 2,000 per second with enough VUs: p95 3.8, 5.2 and 8.3 s. At 2,750 and 3,125 per second: 11.8 to 12.8 s.

## Working Notes

### Script and method (2026-10-08, uncommitted)

**How an admin run with arbitrary settings starts (from the code).**

- `POST /demo/runs/start` with `x-control-service-token` and `x-demo-operator-mode: admin`, body `{ presetSlug: "custom", configOverride }`. The override replaces each of the four parts whole (`mergeConfigSnapshot`), so sending all four makes the edited `custom` preset irrelevant. Admin mode validates against `DEMO_MAX_*` only; the start still checks the 600 s estimate.
- `POST /demo/runs/estimate` takes the same body, validates it and returns the estimate without reserving anything.
- The start answers 202 only after the runner boot and the k6 start (seconds on Fly). While another run is nonterminal it answers 409 `run_conflict` with `conflictReason: active_run_exists`.
- `GET /admin/demo/runs/history/:runId` (control token) answers 404 until the terminal transition writes the run's summary row, then the whole admin detail. That is the terminal signal the script polls.
- A terminal run frees the slot: no reset is needed between runs. A run whose traffic report arrives, dropped iterations included, drains its orders before it turns terminal; only a start failure or a lost runner fails it at once.
- Persisted latency is average and p95 only (request duration p95, the k6 phases, server reservation timing). VUs actually in flight are not persisted: only the configured VUs and k6's `Insufficient VUs` stderr lines.
- Completed order jobs stay in Redis until an exact-run teardown (`DELETE /admin/demo/runs/:runId`) or retention cleanup; the order queue has no `removeOnComplete`. The teardown deletes the run's rows, its Redis state and its queue jobs, and removes it from run history.

**Auth.**

- Local: the token comes from `.env` through `scripts/run-with-env.mjs`, which also sets `API_BASE_URL=http://localhost:4000`; the API is published on loopback only with `docker-compose.dev.yml` (`pnpm runtime:up:debug`).
- Hosted: inside the core's API container `CONTROL_SERVICE_TOKEN` is in the environment; the API listens on `::` port 4000, so the script's default `http://127.0.0.1:4000` applies.

**Script:** `scripts/capacity-measurement.mjs`, Node builtins only.

- `node scripts/capacity-measurement.mjs <run-list.json> <results.jsonl>`; reads `CONTROL_SERVICE_TOKEN` and `API_BASE_URL`, never prints the token.
- Run list: a JSON array of flat entries, every field required (`label`, `mode`, rate/duration/`preAllocatedVus`/`maxVus` or `buyerCount`/`maxDurationSeconds`, `startDelaySeconds`, `startingStock`, `erpLatencyMs`, `erpMaxTps`, `erpErrorRate`, `orderProcessConcurrency`). A constant-arrival entry without VUs is refused.
- Flow: estimate every entry first (stop if one is invalid or not admitted); then per entry start (waiting while another run holds the slot), poll the admin detail every 5 s, append one JSON record, tear the run down, print one line with the teardown outcome.
- Test: `scripts/capacity-measurement.test.mjs` (in `test:scripts`): the mapping parses with `startDemoRunRequestSchema`, and missing VUs are refused.
- Checked: `pnpm test:scripts` (62 pass), Biome; control flow (estimate, 409 wait, 404 polling, record, teardown, missing token, unreachable API) against a throwaway fake API. Not run against a real stack.
- **Changed after the three sessions:** the printed line shows `completed X/planned (interrupted, unstarted)` instead of `sent started/planned`. Completion is judged from those counts, the operator bisects from the printed lines, and on Fly the printed lines were all that survived incident 1 (ca-ac-1000's interrupted count had to be inferred). Biome and the script test pass.

**Method:** `docs/capacity_measurement.md`, a procedure page next to `docs/estimator_calibration.md`; `docs/reference_runtime_measurements.md` is a record ("not guidance") and now links to it. Results go to the latter.

**Doc fix:** `docs/reference_runtime_measurements.md` no longer says visitors see the explanatory estimate; the column header says "explanatory" instead of "shown".

**Open questions.**

- Not verified (no `flyctl` in this phase): the 13 KB `flyctl machine exec` argument used to copy the script, whether a `setsid` background process outlives the exec call in the API container, and whether `/dev/shm` is writable there.
- The actual drain rate with ERP latency 0 and concurrency 10 is unmeasured; the plan assumes about the estimator's 77 orders per second.
- How long a teardown of a 20,000 to 40,000-order run takes (queue maintenance lists every retained job and removes the run's one by one); the script allows 120 s per call.
- "All sold out" uses stock 1, not 0: a zero-stock run is exercised only by estimator unit tests.

### Cloud VM A, constant arrival (2026-10-08, 23:00–23:30 UTC)

**Host:** KVM guest (Firecracker-style kernel `6.18.44-fc-v77`), 4 vCPU Intel Xeon 2.30 GHz, 16 GB, no swap. Docker 29.8.2, Compose v5.6.0, Node 22.22.0. Branch `tmp/15a-validation` at `6aba50e`. The whole stack, k6 included, shares the 4 vCPU. No `DEMO_MAX_*` raised. The script needed no fix.

All runs: start delay 0, ERP 0 ms / 1000 TPS / 0 % / concurrency 10, 10 s. Achieved = completed requests / dispatch duration. Mean = blocked + sending + waiting + receiving. Server = `reserveOrderService` average / p95. Gen = k6 CPU peak / mean %.

| Label | Rate | Stock | VUs | Status | Dropped | Sent (interrupted/unstarted) | Acc | Sold out | Achieved | Mean ms | p95 ms | Server ms | Gen % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| so-1000 | 1000 | 1 | 10k | complete | 0 | 10000 | 1 | 9999 | 1044 | 708 | 1298 | 4.8/50 | 93/54 |
| so-2000 | 2000 | 1 | 10k | complete | 0 | 20000 | 1 | 19999 | 2040 | 713 | 1833 | 6.9/50 | 84/51 |
| so-4000 | 4000 | 1 | 10k | failed | 1257 | 37935 (0/2065) | 1 | 37934 | 3606 | 1553 | 9390 | 113/500 | 92/56 |
| so-8000 | 8000 | 1 | 10k | failed | 22818 | 46215 (0/33785) | 1 | 46214 | 4309 | 1869 | 10291 | 66/250 | 89/57 |
| so-3000 | 3000 | 1 | 10k | warning | 0 | 29998 (0/2) | 1 | 29997 | 3053 | 554 | 3690 | 5.0/25 | 86/48 |
| so-3500 | 3500 | 1 | 10k | complete | 0 | 35000 | 1 | 34999 | 3556 | 872 | 5213 | 18/100 | 88/51 |
| so-3750 | 3750 | 1 | 10k | degraded | 0 | 36787 (0/713) | 1 | 36786 | 3325 | 1021 | 8410 | 19/100 | 89/51 |
| so-3500-r | 3500 | 1 | 10k | warning | 0 | 34983 (0/17) | 1 | 34982 | 3447 | 1119 | 8118 | 33/250 | 83/50 |
| so-sat-5625 | 5625 | 1 | 10k | failed | 10717 | 47303 (0/8947) | 1 | 47302 | 4675 | 1889 | 11030 | 154/1000 | 87/51 |
| ac-1000 | 1000 | 10000 | 10k | complete* | 0 | 10000 (2231/0) | 7764 | 0 | 790 | 18861 | 31057 | 18488/30000 | 84/11 |
| ac-2000 | 2000 | 20000 | 10k | failed | 8774 | 11228 (3735/8772) | 7487 | 0 | 772 | 20270 | 35569 | 21894/60000 | 82/9 |
| ac-625 | 625 | 6250 | 10k | warning | 0 | 6239 (0/11) | 6239 | 0 | 636 | 13643 | 21799 | 10509/30000 | 90/10 |
| ac-500 | 500 | 5000 | 10k | complete | 0 | 5000 | 5000 | 0 | 508 | 9184 | 14840 | 8899/30000 | 90/12 |
| ac-500-r | 500 | 5000 | 10k | complete | 0 | 5000 | 5000 | 0 | 508 | 10276 | 16346 | 8282/30000 | 92/13 |
| mix1k-3500 | 3500 | 1000 | 10k | failed | 10606 | 23259 (0/11741) | 1000 | 22259 | 2239 | 5574 | 15557 | 376/250 | 88/27 |
| mix1k-3750 | 3750 | 1000 | 10k | failed | 8936 | 24544 (0/12956) | 1000 | 23544 | 2382 | 4073 | 12508 | 298/500 | 86/29 |
| mix10k-1000 | 1000 | 10000 | 10k | complete* | 0 | 10000 (2315/0) | 7677 | 0 | 787 | 18744 | 31282 | 18207/30000 | 90/10 |
| mix10k-1500 | 1500 | 10000 | 10k | failed | 3656 | 11345 (1960/3655) | 8039 | 1345 | 954 | 18297 | 33733 | 16802/60000 | 89/10 |
| mix10k-2000 | 2000 | 10000 | 10k | failed | 8746 | 11255 (2198/8745) | 7799 | 1255 | 923 | 19638 | 35125 | 16185/30000 | 89/11 |
| confirm-3500 | 3500 | 1000 | 3500 | failed | 14866 | 20155 (0/14845) | 1000 | 19155 | 2020 | 1949 | 12477 | 322/250 | 71/20 |

\* Delivery status `complete` with over 2,200 interrupted requests (started, never answered).

**docker stats peaks** (CPU % of one core / memory): sold out: api 139 % / 478 MiB, k6 385 % / 3.7 GB, postgres 24 %, worker 33 %, redis 38 %. Accepted: api 101 %, k6 363 % / 2.3 GB, postgres 186 % / 286 MiB, worker 115 %, redis 55 %.

**Findings.**

- **C_s about 3,000 to 3,500 per second** (all sold out): 3,500 complete once, its repeat and 3,000 left 17 and 2 requests unstarted. The saturated run delivered about 4,675 per second in bursts.
- **Accepted orders cost about 18 times a sold-out answer.** The stack answers about 195 accepted orders per second. ac-500 counts as complete only because k6's 30 s graceful stop absorbs the backlog (mean latency 9 to 10 s). Redis reservation stays about 6 ms while the reservation service averages 8 to 18 s: queuing behind the API's Postgres pool of 10, with Postgres at 186 % CPU.
- **Additive model:** consistent with every run (stock 1,000 predicts 2,900; 3,500 and 3,750 failed; stock 10,000 predicts no complete rate, and 1,000 to 2,000 failed), but not positively confirmed at the predicted rate.
- **Latency budget:** mean iteration time at 3,500 per second was 0.87 s, then 1.12 s on the repeat.
- **The confirmation run was confounded:** it used stock 1,000 (supervisor's prompt), so it measured the stock effect, not the VU budget.
- **Interrupted requests are invisible to the delivery status and to `droppedIterations`.** ac-1000 and mix10k-1000 report `complete` with 0 dropped, yet over 2,200 requests each were interrupted. `droppedIterations` also misses requests the scheduler never started (so-3000, so-3750, ac-625), which do lower the status to `warning` or `degraded`. Completion must be read from the request counts.
- **Connections were not always reused:** `connecting` averaged up to 66 ms in sold-out runs. With 10,000 pre-allocated VUs and about 35,000 iterations, k6 rotates through fresh VUs, each opening its connection.

### Cloud VM B, buyer spike (2026-10-08)

**Host:** KVM guest, 4 vCPU Intel Xeon 2.80 GHz, 16 GB, no swap, kernel `6.18.44-fc-v77`, Docker 29.8.2, Compose v5.6.0, Node 22.22.0. No `DEMO_MAX_*` raised. The 40,000-buyer run was skipped (16 GB). The script needed no fix, and all 8 teardowns returned `deleted`.

All runs: 60 s cutoff, start delay 0, ERP 0 ms / 1000 TPS / 0 % / concurrency 10. Time to answer = p95 ÷ 0.95, then the k6 upper bound (k6 finish − first attempt). Rate = buyers ÷ that upper bound.

| Run | Buyers | Stock | Delivery | Complete | Sent (int/unst) | Accepted | Sold out | Time to answer (s) | Rate /s | Mean / p95 (s) | Connect avg/p95 (s) | Server avg/p95 | Gen % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| so-5000 | 5000 | 1 | complete | yes | 5000 (0/0) | 1 | 4999 | 3.36 / 5.79 | 863 | 2.07 / 3.19 | 0.42/0.66 | 83 ms / 1 s | 86/49 |
| so-10000-a | 10000 | 1 | complete | yes | 10000 (0/0) | 1 | 9999 | 2.37 / 8.67 | 1153 | 1.48 / 2.25 | 0.41/0.70 | 23 ms / 250 ms | 94/59 |
| so-10000-b | 10000 | 1 | complete | yes | 10000 (0/0) | 1 | 9999 | 4.15 / 6.82 | 1467 | 2.36 / 3.94 | 0.40/0.66 | 563 ms / 2.5 s | 91/61 |
| so-20000 | 20000 | 1 | complete | no: 45 transport failures | 20000 (0/0) | 1 | 19954 | 2.34 / 13.74 | 1455 | 1.06 / 2.23 | 0.72/1.92 | 44 ms / 250 ms | 94/64 |
| acc-5000 | 5000 | 5000 | complete | yes | 5000 (0/0) | 5000 | 0 | 30.3 / 32.3 | 155 | 16.5 / 28.8 | 0.33/0.62 | 15.0 s / 30 s | 88/10 |
| acc-10000 | 10000 | 10000 | complete; run failed `traffic_transport_major_loss` | no: 631 transport failures | 10000 (0/0) | 9369 | 0 | 62.8 / 62.5 | 160 | 31.5 / 59.7 | 0.52/0.86 | 29.7 s / 60 s | 90/9 |
| mix-s1000 | 10000 | 1000 | complete | yes | 10000 (0/0) | 1000 | 9000 | 12.2 / 16.4 | 611 | 6.99 / 11.6 | 0.42/0.86 | 533 ms / 10 s | 87/25 |
| mix-s5000 | 10000 | 5000 | complete | yes | 10000 (0/0) | 5000 | 5000 | 29.0 / 33.3 | 301 | 12.1 / 27.6 | 0.52/1.35 | 8.1 s / 30 s | 89/16 |

**docker stats peaks:** sold out: api 118 %, k6 388 % / 4.3 GB, postgres 23 %. Accepted: api 92 %, postgres 197 %, worker 116 %, k6 356 % / 2.2 GB.

**Findings.**

- **C′ sold out about 1,150 to 1,470 per second** (buyers ÷ k6 upper bound), bounded by the generator: k6 used 388 % of the 4 vCPU while the API stayed near one core. The doc's p95 ÷ 0.95 formula is not credible here, because dispatch (up to 9.7 s) took longer than answering. The method needs the k6 upper bound when dispatch dominates.
- **Real accepted throughput about 150 to 165 per second** (cloud A: about 195). PostgreSQL is the limit: Redis reservation averages 118 to 190 ms, while the reservation service averages 15 to 30 s. The worker drains orders during traffic and competes for the same database.
- **Additive model** (errors as (measured − predicted) / predicted, + = slower): consistent for stock 1,000 (predicted 12.7 s, measured 12.2 to 16.4 s: −4 to +29 %). It overpredicts stock 5,000 (34.8 s against 29.0 to 33.3 s: −17 to −4 %): the sold-out answers overlap with the PostgreSQL-bound orders instead of adding.
- **Transport failures.**
  - acc-10000: 631 buyers got no answer, yet all 10,000 reservations succeeded. Their p95 of 59.7 s matches k6's default 60 s request timeout. The run failed with `traffic_transport_major_loss`, but its failure explanation says "unidentified".
  - so-20000: 45 connection-level failures before reaching the API; the run completed.
- **Server reservation p95 values are bucket edges** (250 ms, 1 s, 2.5 s, 10 s, 30 s, 60 s), not true percentiles.
- **so-10000 repeats vary widely:** dispatch 7.3 s against 0.6 s, and server reservation averages of 23 ms against 563 ms.

### Fly (2026-10-08)

**Setup.**

- Core `863e11ceed4408` performance-6x / 12 GB (Node sees 6 AMD EPYC CPUs, 11.7 GiB), runner `807244c6672338` performance-8x / 16 GB, both as found, in `cdg`. Deployed version `176c517b`, whose `apps/`, `packages/` and `infra/` equal `tmp/15a-validation` (`6aba50e`); the script copied in matched it (sha256).
- Woken through the gate (`POST /__gate/start`) at 23:38:53 UTC (2026-10-07). Runs from 23:40:32 to 00:24:21. The core stopped on its own (idle stop requested 00:34:21, `stopped` 00:34:53): awake about 56 min. The runner ended `stopped`.
- Every run: start delay 0, ERP 0 ms / 1000 TPS / 0 % / concurrency 10; constant arrival 10 s at 10,000 VUs unless stated; buyer spikes with a 60 s cutoff.
- Core sampled every 0.5 s from the Machine namespace (`--no-container`, a `setsid` shell loop writing to the Machine's `/dev/shm`): `/proc/stat`, each container's `/sys/fs/cgroup/default/<container>/cpu.stat` and `memory.current` (per-container cgroups are readable), and `ss -Htn state established sport = :4000`.
- Core logs were streamed from 23:54 (`flyctl logs`, request lines dropped). `flyctl logs --no-tail` keeps only the last 100 lines, so nothing earlier is available.

**Fly-side unknowns, resolved.**

- **Copying:** the doc's `put()` works with a 13,064-character exec argument (Git Bash, flyctl 0.4.111); checksums matched.
- **Detaching:** `sh -c 'setsid … &'` returns in under a second and the process outlives the exec call (a 15 s probe, then whole run lists). The same holds with `--no-container`.
- **`/dev/shm`:** writable in the API container (64 MB tmpfs, root), separate from the Machine namespace's 5.9 GB `/dev/shm`. It is lost when the API container restarts, not only when the core stops (incident 1).

**Incidents.**

1. **The API container restarted during the saturated run** (`ca-so-5000`, 23:47:38). 12 s into the traffic the API's CPU fell from about 1.6 cores to about 0.01 for 8 s, with 10,003 connections still open; then its cgroup was recreated (restart policy `on-failure`, so the process exited non-zero or was killed). 6,801 requests failed with `connection reset by peer`. The script died with the container, and the records of ca-so-3500, ca-ac-250, ca-ac-500 and ca-ac-1000 were lost with `/dev/shm` (those runs were already torn down; their printed lines remain, below). No log covers the moment. Cause unknown; an event loop stalled at 0 % CPU fits a blocked synchronous write (for example pino to stdout under Fastify's two info lines per request), not verified. 13a's 5,000/s run had not restarted the API.
2. **Runner stop race.** A run started 1 s after the previous teardown failed with `load_orchestrator_unavailable`: Fly answered the runner start with 412 "machine still active, refusing to start", and the API does not retry it. The script stops its list on that error. From then on each run was a one-run list, started once the runner Machine read `stopped`; no further failure.
3. **Teardown refused.** ca-ac-750-r (`a571f4b5-45c7-44c1-9d27-d7ee76880751`) kept one `orders:process` job active (queue depth 0, active 1) from its drain on, although all 7,500 orders were confirmed. `DELETE` answered 409 `active_job` for 10 min, until the last retry at 00:24:51 (the script gives up after 60 s), so the run is still in history. Redis needs a password, so the job was not inspected. At the idle stop the worker logged "Closing worker runtime." but did not exit, and Fly killed it and web at the 30 s stop timeout: the stop took 32.6 s instead of about 11 s.

**Derived values.**

- **C<sub>s</sub> = 3,500/s** (complete twice; 3,750 left 1,536 unstarted). The saturated run's arrivals after its first second averaged about 3,650/s, in bursts of 2,274 to 4,999, before incident 1.
- **Real accepted throughput about 240/s:** 236 and 244 for ca-ac-750 and its repeat (answers ÷ first attempt to k6 end), 236 to 258 for the accepted buyer spikes, about 180 for ca-ac-1000 (7,280 answered in about 40 s, 2,720 interrupted). The bisection's 750/s (complete twice; 1,000 not) only reflects the 30 s graceful stop absorbing a 19 to 21 s p95. PostgreSQL peaks at 2.6 to 3.0 cores and the VM at 86 to 92 %, against about 50 % in sold-out runs, where the API peaks at 1.7 to 1.9 cores (mean about 1.05).
- **C′:** sold out 2,590 to 2,670/s by p95 ÷ 0.95 (1,540 to 1,900/s by the k6 upper bound; dispatch 0.7 to 1.1 s, so the p95 formula applies); accepted 244 to 258/s (236 to 247/s). Independent of N between 5,000 and 10,000.
- **Latency budget:** mean iteration at 3,500/s 1.28 to 1.29 s, so 2 s: 7,000 VUs left 1,207 unstarted. Twice the budget (14,000 VUs) is above the 10,000-VU cap and was not run. 10,000 VUs (2.9 s) held twice, so the budget that held is about 3 s.
- **Additive model, stock 1,000.**
  - Constant arrival: predicted 100 + 3,500 × (1 − 1,000 / 2,400) ≈ 2,125/s. 2,125 and 2,625 were complete and 3,125 was not (138 unstarted); 1,625 was complete on its repeat (the first run left 1 request unstarted at the start). The highest complete rate lies between 2,625 and 3,125, so the model is pessimistic by at least 500/s: accepted orders wait on the PostgreSQL pool while the event loop keeps answering sold-out requests. Fitted, an accepted order costs the API about 1/480 s, about 7 sold-out answers rather than 15.
  - Buyer spike (p95-based C′; errors as (measured − predicted) / predicted, + = slower): predicted 7.4 s for 10,000 buyers and stock 1,000, measured 9.6 s (+30 %); predicted 21.8 s for stock 5,000, measured 21.3 s (−2 %).
- **13a's buyer-spike figure of about 1,000/s came from its 500 accepted orders:** 10,000 buyers were answered at about 2,600/s with stock 1 and about 1,040/s with stock 1,000.
- **Drain:** 72 to 74 orders/s with ERP 0 ms and concurrency 10 (7,500 in 104 s, 10,000 in 136 s, traffic start to finalization), close to the estimator's 77. Teardowns of 10,000-order runs returned `deleted` within the script's 120 s.
- **Other:** ca-ac-1000 again shows delivery `complete` with 2,720 interrupted. Connection time stays small: constant arrival 0.5 to 4 ms average (78 ms once), buyer spike 110 to 230 ms average, p95 up to 1.0 s in the mixes. Generator CPU peaks at 78 to 91 %. The core VM never passed 92 %.

**Runs.** Achieved = completed ÷ dispatch duration; for buyer spikes, C′ = buyers ÷ (p95 ÷ 0.95). Mean = blocked + sending + waiting + receiving. Server = `reserveOrderService` average / p95 (p95 values are bucket edges). Core = VM % peak of 6 vCPU / API cores peak / PostgreSQL cores peak / open API connections peak, over traffic start to finalization. Rows marked † lost their record (incident 1): figures from the printed line, mean is the `waiting` average, and ca-ac-1000's interrupted count is inferred.

| Label | Mode | Rate or buyers | Stock | VUs | Delivery | Complete | Dropped | Sent/planned (int./unst.) | Accepted | Sold out | Achieved/s (BS: C′) | Mean / p95 ms | Connect avg / p95 ms | Server avg / p95 ms | Gen CPU % peak / mean | Core: VM % / API / PG / conns |
|---|---|--:|--:|--:|---|---|--:|---|--:|--:|--:|---|---|---|---|---|
| ca-so-3125 | CA | 3,125 | 1 | 10,000 | complete | yes | 0 | 31,250/31,250 (0/0) | 1 | 31,249 | 3,198 | 1,276 / 8,219 | 1.5 / 1.0 | 5 / 25 | 91 / 41 | 48 / 1.7 / 0.2 / 10,005 |
| ca-so-3500 † | CA | 3,500 | 1 | 10,000 | complete | yes | 0 | 35,000/35,000 | 1 | 34,999 | – | 1,270 / 8,760 | – | – | – | – |
| ca-so-3750 | CA | 3,750 | 1 | 10,000 | degraded | no | 1,537 | 35,964/37,500 (0/1,536) | 1 | 35,963 | 3,685 | 2,403 / 10,736 | 1.4 / 2.2 | 75 / 500 | 90 / 37 | 45 / 1.6 / 0.2 / 10,005 |
| ca-so-3500-r | CA | 3,500 | 1 | 10,000 | complete | yes | 0 | 35,000/35,000 (0/0) | 1 | 34,999 | 3,612 | 1,289 / 8,648 | 3.1 / 10.8 | 7 / 25 | 88 / 43 | 53 / 1.9 / 0.4 / 10,005 |
| ca-so-5000 | CA | 5,000 | 1 | 10,000 | failed (6,801 resets) | no | 11,463 | 38,537/50,000 (0/11,463) | 1 | 31,735 | 3,946 | 5,287 / 31,450 | 4.2 / 40.7 | 214 / 500 | 89 / 16 | 47 / 1.8 / 0.3 / 10,004 |
| ca-ac-250 † | CA | 250 | 2,500 | 10,000 | complete | yes | 0 | 2,500/2,500 | 2,500 | 0 | – | 1,190 / 1,690 | – | – | – | – |
| ca-ac-500 † | CA | 500 | 5,000 | 10,000 | complete | yes | 0 | 5,000/5,000 | 5,000 | 0 | – | 6,100 / 9,440 | – | – | – | – |
| ca-ac-1000 † | CA | 1,000 | 10,000 | 10,000 | complete | no | 0 | 10,000/10,000 (2,720/0) | 7,280 | 0 | – | 18,830 / 31,610 | – | – | – | 87 / 1.5 / 2.4 / 10,005 |
| ca-ac-750 | CA | 750 | 7,500 | 10,000 | complete | yes | 0 | 7,500/7,500 (0/0) | 7,500 | 0 | 768 | 13,667 / 20,795 | 0.6 / 0.6 | 8,693 / 30,000 | 90 / 10 | 89 / 1.4 / 2.7 / 7,505 |
| ca-ac-750-r | CA | 750 | 7,500 | 10,000 | complete | yes | 0 | 7,500/7,500 (0/0) | 7,500 | 0 | 772 | 12,128 / 19,428 | 0.5 / 0.6 | 8,625 / 30,000 | 91 / 10 | 90 / 1.4 / 2.8 / 7,505 |
| ca-mix1000-1625 | CA | 1,625 | 1,000 | 10,000 | warning | no | 0 | 16,249/16,250 (0/1) | 1,000 | 15,249 | 1,664 | 3,761 / 7,488 | 1.1 / 0.6 | 125 / 1,000 | 89 / 30 | 84 / 1.2 / 2.0 / 10,005 |
| ca-mix1000-1625-r | CA | 1,625 | 1,000 | 10,000 | complete | yes | 0 | 16,250/16,250 (0/0) | 1,000 | 15,250 | 1,664 | 3,786 / 7,451 | 1.0 / 1.1 | 135 / 2,500 | 91 / 27 | 86 / 1.5 / 1.9 / 10,459 |
| ca-mix1000-2125 | CA | 2,125 | 1,000 | 10,000 | complete | yes | 0 | 21,250/21,250 (0/0) | 1,000 | 20,250 | 2,172 | 4,684 / 11,756 | 20.6 / 1.9 | 179 / 25 | 89 / 26 | 84 / 1.3 / 1.9 / 10,005 |
| ca-mix1000-2625 | CA | 2,625 | 1,000 | 10,000 | complete | yes | 0 | 26,250/26,250 (0/0) | 1,000 | 25,250 | 2,680 | 3,552 / 11,646 | 0.9 / 0.5 | 127 / 25 | 88 / 31 | 85 / 1.2 / 2.1 / 10,005 |
| ca-mix1000-3125 | CA | 3,125 | 1,000 | 10,000 | warning | no | 138 | 31,112/31,250 (0/138) | 1,000 | 30,112 | 3,182 | 4,082 / 14,615 | 78.0 / 8.8 | 232 / 100 | 91 / 26 | 85 / 1.4 / 2.0 / 10,004 |
| ca-so-3500-vu7000 | CA | 3,500 | 1 | 7,000 | degraded | no | 1,206 | 33,793/35,000 (0/1,207) | 1 | 33,792 | 3,431 | 1,730 / 10,418 | 0.5 / 0.4 | 45 / 250 | 91 / 36 | 48 / 1.7 / 0.2 / 7,005 |
| bs-so-5000 | BS | 5,000 | 1 | 5,000 | complete | yes | 0 | 5,000/5,000 (0/0) | 1 | 4,999 | 2,591 | 1,189 / 1,833 | 110.5 / 203.6 | 55 / 500 | 79 / 48 | 35 / 1.3 / 0.1 / 5,004 |
| bs-so-10000 | BS | 10,000 | 1 | 10,000 | complete | yes | 0 | 10,000/10,000 (0/0) | 1 | 9,999 | 2,669 | 1,951 / 3,559 | 176.4 / 277.5 | 13 / 100 | 91 / 48 | 48 / 2.0 / 0.2 / 10,005 |
| bs-so-10000-r | BS | 10,000 | 1 | 10,000 | complete | yes | 0 | 10,000/10,000 (0/0) | 1 | 9,999 | 2,620 | 2,137 / 3,626 | 195.6 / 291.8 | 16 / 250 | 89 / 52 | 52 / 1.9 / 0.1 / 10,004 |
| bs-ac-5000 | BS | 5,000 | 5,000 | 5,000 | complete | yes | 0 | 5,000/5,000 (0/0) | 5,000 | 0 | 244 | 11,791 / 19,482 | 147.1 / 257.2 | 7,587 / 30,000 | 78 / 8 | 86 / 1.6 / 2.6 / 6,409 |
| bs-ac-10000 | BS | 10,000 | 10,000 | 10,000 | complete | yes | 0 | 10,000/10,000 (0/0) | 10,000 | 0 | 258 | 21,468 / 36,827 | 124.7 / 238.8 | 14,148 / 30,000 | 90 / 8 | 92 / 1.7 / 3.0 / 10,004 |
| bs-mix1000-10000 | BS | 10,000 | 1,000 | 10,000 | complete | yes | 0 | 10,000/10,000 (0/0) | 1,000 | 9,000 | 1,040 | 6,742 / 9,134 | 202.4 / 1,018.5 | 362 / 5,000 | 90 / 25 | 84 / 1.6 / 2.0 / 10,004 |
| bs-mix5000-10000 | BS | 10,000 | 5,000 | 10,000 | complete | yes | 0 | 10,000/10,000 (0/0) | 5,000 | 5,000 | 470 | 12,103 / 20,208 | 232.4 / 1,020.6 | 4,105 / 30,000 | 89 / 13 | 86 / 1.3 / 2.3 / 10,005 |

Buyer-spike time to answer, p95 ÷ 0.95 / k6 upper bound (s): bs-so-5000 1.93 / 3.25; bs-so-10000 3.75 / 6.03; bs-so-10000-r 3.82 / 5.27; bs-ac-5000 20.5 / 21.2; bs-ac-10000 38.8 / 40.4; bs-mix1000 9.6 / 11.8; bs-mix5000 21.3 / 23.4.

### Proposed values for 15b (2026-10-08)

All from runs with the fastest ERP, 10 s constant-arrival runs and 60 s cutoffs. A run counts as complete when every planned request started and completed with zero failed responses (transport failures plus unexpected responses; k6 counts a request with no reply as completed). Two gaps against that criterion: ca-so-3500 † (half of Fly's "complete twice" at 3,500/s) lost its record, so it has no failure count, and cloud A's table has no failure column. Results recorded in `docs/reference_runtime_measurements.md` (Capacity per connection mode); method fixes in `docs/capacity_measurement.md`.

| Value | Fly (core 6x, runner 8x) | Local (4 vCPU / 16 GB VM, whole stack) | Basis |
|---|--:|--:|---|
| C<sub>s</sub>, constant arrival, sold out | 3,500/s | 3,000/s | Fly: complete twice, 3,750 not. Local: see the caveats |
| C<sub>a</sub>, accepted throughput (the pool) | 240/s | 195/s | Fly 236 to 244 (CA), 236 to 258 (BS). Local: cloud A, CA |
| k, cost of an accepted order in sold-out answers, constant arrival | 7 (fitted) | 15 (C<sub>s</sub> / C<sub>a</sub>, not fitted) | Fly: see below |
| C′<sub>s</sub>, buyer spike, sold out | 2,600/s | 1,150/s | Fly: p95 ÷ 0.95 (dispatch 0.7 to 1.1 s, under half of it). Local: k6 upper bound, generator-bound |
| C′<sub>a</sub>, buyer spike, accepted | 240/s | 155/s | Fly 244 to 258 (p95), 236 to 247 (bound). Local 155 (acc-5000) / 150 (acc-10000, lossy: 9,369 answers in 62.5 s); 155 from the lossless run |
| Latency budget (VUs = rate × budget) | 3 s | 3 s, provisional | Fly: 10,000 VUs (2.9 s) held twice at 3,500/s, 7,000 (2 s) left 1,207 unstarted. Local: see the caveats |

On Fly, 3 s at C asks 10,500 VUs, above the 10,000 cap; the cap held twice there.

**Stock model (proposed): the additive form, with one fitted value.** A = min(stock, planned requests) is the number of orders a run can accept.

- **Constant arrival** (rate R, duration T): the run fits when R + (k − 1) × A / T ≤ C<sub>s</sub>; 15b's 80 % / 100 % classes apply to the left side. It must also pass the pool condition A ≤ C<sub>a</sub> × (T + 30 s): k6's graceful stop interrupts accepted orders the pool has not answered by then (ca-ac-1000 answered 7,280 in about 40 s, cloud A's ac-1000 7,764).
- **Buyer spike** (N buyers): time to serve = A / C′<sub>a</sub> + (N − A) / C′<sub>s</sub>, compared with the cutoff and with k6's 60 s request timeout, which fails any request unanswered after 60 s whatever the cutoff (cloud B's acc-10000: 631 failures at about 62 s).
- **Only Fly's k is fitted.** The stock-1,000 bracket (2,625 complete, 3,125 not) gives 4.75 < k ≤ 9.75; 13a's stock-500 runs (3,125 complete twice, 3,500 not) give k ≤ 8.5. k = 7 lies in both: an accepted order costs the API about 1/500 s, because it waits on the pool while the event loop keeps answering sold-out requests. Every other value is measured directly; with k = C<sub>s</sub> / C<sub>a</sub> the form is the plain additive model.

Error against each measured mix, with the values above. Error = (measured − predicted) / predicted: for times, + means the run was slower than predicted; for rates, + means a higher capacity than predicted. Where a rate is bracketed by a complete and a failed run, the error range spans the bracket.

| Mix | Predicted | Measured | Error |
|---|---|---|---|
| Fly CA, stock 1,000 | 2,900/s | complete 2,625, not 3,125 | −9 to +8 % |
| Fly CA, stock 500 (13a, earlier sessions) | 3,200/s | complete 3,125 twice, not 3,500 | −2 to +9 % |
| Fly CA, all accepted | 500/s (pool: 960/s) | complete 750 twice, not 1,000 | +50 to +100 % (pessimistic) |
| Fly BS 10,000, stock 1,000 | 7.6 s | 9.6 s (bound 11.8 s) | +26 % (p95), +55 % (bound) |
| Fly BS 10,000, stock 5,000 | 22.8 s | 21.3 s (bound 23.4 s) | −6 % (p95), +3 % (bound) |
| Fly BS all accepted, 5,000 / 10,000 | 20.8 / 41.7 s | 20.5 / 38.8 s (bound 21.2 / 40.4 s) | −2 / −7 % (p95), +2 / −3 % (bound) |
| Fly `surge-10k` (stock 500, 13a) | 5.74 s | 7.85 s on the 6x core (p95 7.46 s); 7.9 to 14.6 s over earlier runs and sizes | +37 %, up to +155 % on earlier runs |
| Local CA, stock 1,000 | 1,600/s | not complete at 3,500 or 3,750; nothing lower run | consistent, untested |
| Local CA, stock 10,000 | none (pool: 10,000 > 7,800) | 1,000, 1,500, 2,000 not complete | right verdict |
| Local CA, all accepted | 200/s (pool: 780/s) | complete 500 twice; 625 left 11 unstarted; 1,000 not | +150 to +213 % (pessimistic) |
| Local BS 10,000, stock 1,000 | 14.3 s | 12.2 s (p95) to 16.4 s (bound) | −15 % (p95), +15 % (bound) |
| Local BS 10,000, stock 5,000 | 36.6 s | 29.0 s (p95) to 33.3 s (bound) | −21 % (p95), −9 % (bound) |
| Local BS all accepted, 5,000 / 10,000 | 32.3 / 64.5 s | 32.3 / 62.5 s (bound; 10,000 lossy, 631 timeouts) | 0 / −3 % (bound), right verdict |

**Alternatives.**

- **Plain additive everywhere** (k = C<sub>s</sub> / C<sub>a</sub> on Fly too, nothing fitted): Fly CA predicts 2,140/s at stock 1,000 (+23 to +46 %) and 2,820/s at stock 500 (+11 to +24 %), errors as above. Simplest, but it would refuse visitor runs that complete.
- **One weight for both modes** (k = 7 in buyer spikes too): Fly BS stock 1,000 6.2 s against 9.6 (+56 %), stock 5,000 15.4 s against 21.3 (+38 %), errors as above. Rejected: optimistic.
- **Overlap** (accepted orders bound by the pool only, sold-out answers by the API only): Fly CA stock 1,000 predicts 3,500/s, but 3,125 failed; Fly BS stock 1,000 predicts 4.2 s against 9.6. Rejected: optimistic.
- **Ignore stock:** Fly CA at 3,125/s with stock 1,000 failed although C<sub>s</sub> is 3,500; the local all-accepted 10,000-buyer spike passes the 60 s timeout. Rejected.
- **Accepted cost spread over max(T, A / C<sub>a</sub>)** instead of T: it would predict Fly's all-accepted 750/s as complete. Not proposed: a third term for runs only admins can start (stock above the public 1,000).

**Noisy or confounded, and what it means for the values.**

- **Local VU budget not measured cleanly.** Cloud A's confirmation run used stock 1,000, so it measured the stock effect (14,845 unstarted), not the budget. The local 3 s is by analogy with Fly: mean iteration 0.87 to 1.12 s at 3,500/s (Fly 1.29 s), and 10,000 VUs (2.9 s) held once in two runs at 3,500/s. A run at 3,000/s, stock 1, 9,000 VUs would confirm it. k6 memory (about 225 kB per VU, 3.7 GB peak at 10,000 VUs on cloud A) is the other local limit (15b scope).
- **Local C<sub>s</sub> is noisy at 3,000 to 3,500.** 3,000 and the 3,500 repeat missed by 2 and 17 requests while VUs were not short (about 3,900 in flight at 3,500/s): the scheduler of a CPU-starved k6. 3,000 is the conservative reading; 15b's 80 % line (2,400) falls between the complete 2,000 and that 2-request miss.
- **Local k is not fitted.** No stock-1,000 constant-arrival rate below 3,500 was run. The saturated stock-1,000 runs answered 2,240 to 2,380/s against 3,600 to 4,700 sold out, which points to k of 13 or more on 4 vCPU (PostgreSQL and the worker take CPU from the API and k6), not 7. Keep 15 until a stock-1,000 bisection from 1,500/s fits it.
- **Local C′ is the generator's.** The two 10,000-buyer repeats dispatched in 7.3 and 0.6 s; by p95 ÷ 0.95 the fast one was answered at about 2,400/s. 1,150 is what a local run can count on, for the whole stack on 4 vCPU; a larger machine does better. 863/s at 5,000 buyers is lower because the bound includes k6's exit.
- **Local accepted throughput differs by VM and mode:** 195/s in constant arrival (cloud A, 2.3 GHz), 150 to 165/s in buyer spikes (cloud B, 2.8 GHz, where the connections also cost CPU). Hence one value per mode.
- **Fastest ERP everywhere.** The worker drained at full speed during the traffic and competed for PostgreSQL. Public runs (ERP at most 50 TPS) drain slower, so the accepted throughputs are probably conservative for them; not measured.
- **Fly buyer spikes are slower than the model at low stock:** +26 % at stock 1,000 (+55 % by k6's bound) and +37 % for `surge-10k` (up to +155 % on earlier runs), errors as above. An 80 % class (predicted time at most 80 % of the cutoff) covers a run up to 25 % slower than predicted, so both cases fall outside it. For 15b: a buyer spike also gets k6's 30 s graceful stop after its cutoff (`apps/load-orchestrator/src/application/k6-script.ts:23`), so comparing the time to serve with the cutoff alone is conservative; k6's 60 s request timeout still applies.
- **The budget was measured with stock 1.** With stock 1,000 on Fly, the mean iteration time was 3.6 to 4.7 s at 1,625 to 2,625/s, every mix with 10,000 VUs. Near C(S), rate × 3 s may run short: at 2,625/s Little's law gives about 9,500 VUs against 7,900 from the budget. Not measured at public rates; a run at 500/s, stock 1,000 and 1,500 VUs would settle the public case.
- **Constant-arrival model measured with 10 s runs only.** Accepted orders arrive first and the pool serves them within about A / C<sub>a</sub> s (4 s for 1,000 on Fly) whatever T is, so averaging their cost over a longer T flatters runs near C<sub>s</sub>. Using min(T, 10 s) in the stock term would keep long runs within the measured range.
- **Fly cross-checks are partial.** The saturated 5,000/s run restarted the API (incident 1): about 3,650/s before. The all-accepted 750/s "complete" depends on k6's 30 s graceful stop. ca-ac-1000's interrupted count is inferred. 13a's stock-500 runs came from earlier sessions on another deployed version.

### Done When check (2026-10-08)

- [ ] The script and its method are committed: written, run on three hosts and fixed, but not committed yet.
- [x] C, C′ and the latency budget are measured on Fly and on a cloud VM, and the stock effect is measured and explained, except the local VU budget, which is provisional (caveats above).
- [x] The proposed values are in the working notes, ready for 15b.
