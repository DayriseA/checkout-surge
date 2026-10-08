# Capacity Measurement Procedure

How to measure, on the host that runs Checkout-Surge, how many checkout requests per second the stack answers in each connection mode, how the starting stock changes that, and how high the request latency climbs near saturation. `scripts/capacity-measurement.mjs` starts the runs and collects their evidence; the operator chooses the runs. The results are host-specific: record them with the host in [Reference Runtime Measurements](reference_runtime_measurements.md), as observations rather than a benchmark.

## 1. What is measured

- **C, constant arrival.** k6's `constant-arrival-rate` executor reuses each VU's connection, so the API serves requests over established connections. C is the highest rate at which a short run is complete (criterion below) when the VUs are not the limit.
- **C′, buyer spike.** The `per-vu-iterations` executor gives each buyer its own VU and one request, so every request opens a new connection. C′ is the number of buyers answered per second.
- **Latency near saturation.** A constant-arrival VU is busy for the whole request, so the VUs a run needs are about its rate times the request latency (Little's law). The latency at rates close to C sets how many VUs a run needs.
- **Stock effect.** Each request either reserves a unit or is answered sold out. An accepted order makes the API run a Redis reservation, a PostgreSQL transaction on its connection pool (`API_POSTGRES_POOL_MAX`, 10 by default) and a queue publish before it answers; a sold-out answer touches Redis only. The two kinds of requests can therefore cost the API different amounts, and C and C′ are measured at both extremes before mixes are checked.
- **Criterion.** A run counts as complete when every planned request started and completed, and none failed: in `requests`, planned = started = completed, with no unstarted and no interrupted request, and `responses.failedRequests` = 0. The failed count matters because k6 counts a request that got no reply (status 0) as completed; `failedRequests` holds those transport failures plus unexpected responses. Judge completion from these counts only. In the version first measured, the delivery status did not count interrupted requests: an all-accepted run read `complete` while k6's graceful stop had interrupted over a fifth of its requests. `droppedIterations` misses both interrupted and unstarted requests: it stayed at 0 for runs whose scheduler never started some requests.

## 2. The script

`node scripts/capacity-measurement.mjs <run-list.json> <results.jsonl>` uses Node.js builtins only, so the same file runs from a clone or copied alone into the API container. It reads `CONTROL_SERVICE_TOKEN` and `API_BASE_URL` (default `http://127.0.0.1:4000`) from the environment and never prints the token. It:

1. maps every entry of the run list to an admin start on the `custom` preset, replacing the whole configuration with the entry's settings;
2. asks the API's estimate endpoint about every entry before anything starts, and stops if one is invalid or above the occupancy ceiling;
3. for each entry in order, starts the run (waiting while another run holds the run slot), waits for it to end, reads its admin run detail, appends one JSON record to the results file, tears the run down and prints one line: the completed, interrupted and unstarted request counts and the failed count that decide completion, the answers, the p95 and the teardown's outcome.

The teardown (`DELETE /admin/demo/runs/<runId>`) deletes the run's rows and Redis state, completed queue jobs included, so every run starts from the same state and the stores do not grow over a series. The run disappears from run history; its evidence lives in the results file. If a teardown fails, the script prints the run's line and stops the series with a failure exit code, since the next run would not start from the same state; the run's record is already in the results file. Stopping the script during a run leaves that run to finish on its own, without a record or a teardown.

### Run list

A JSON array; every field is required, so no default shapes a measurement.

| Field | Meaning |
| --- | --- |
| `label` | Name of the run in the output |
| `mode` | `constant-arrival-rate` or `buyer-spike` |
| `ratePerSecond`, `durationSeconds` | Constant arrival only |
| `preAllocatedVus`, `maxVus` | Constant arrival only: explicit k6 VUs |
| `buyerCount`, `maxDurationSeconds` | Buyer spike only: buyers and safety cutoff (k6 `maxDuration`) |
| `startDelaySeconds` | Delay before the traffic starts |
| `startingStock` | Units for sale |
| `erpLatencyMs`, `erpMaxTps`, `erpErrorRate` | Mock ERP settings |
| `orderProcessConcurrency` | Worker concurrency for the run (at most 10) |

```json
[
  {
    "label": "ca-sold-out-3000",
    "mode": "constant-arrival-rate",
    "ratePerSecond": 3000,
    "durationSeconds": 10,
    "preAllocatedVus": 10000,
    "maxVus": 10000,
    "startDelaySeconds": 0,
    "startingStock": 1,
    "erpLatencyMs": 0,
    "erpMaxTps": 1000,
    "erpErrorRate": 0,
    "orderProcessConcurrency": 10
  },
  {
    "label": "spike-accepted-5000",
    "mode": "buyer-spike",
    "buyerCount": 5000,
    "maxDurationSeconds": 60,
    "startDelaySeconds": 0,
    "startingStock": 5000,
    "erpLatencyMs": 0,
    "erpMaxTps": 1000,
    "erpErrorRate": 0,
    "orderProcessConcurrency": 10
  }
]
```

### Record

Each line of the results file is one run, copied from its admin run detail:

| Field | Content |
| --- | --- |
| `host` | CPU count, CPU model and memory of the machine the script runs on |
| `config`, `conservativeEstimateSeconds` | The accepted configuration and its admission estimate |
| `status`, `deliveryStatus`, `failureReason`, `failureDiagnostic` | Outcome, delivery classification and failure reason (`virtual_user_limit` when k6 ran out of VUs and left too many requests unsent, `interrupted_requests` when too many answers arrived after k6 stopped listening) |
| `times` | Run start, traffic start and end, finalization, overall duration |
| `requests`, `droppedIterations`, `completedIterations` | Planned, started, completed, interrupted and unstarted requests; k6 iterations |
| `responses` | Accepted and sold-out answers, transport failures, unexpected responses, request-duration p95 |
| `httpTimings` | Average and p95 of k6's `blocked`, `connecting`, `sending`, `waiting` and `receiving` phases |
| `serverReservationTiming` | Server-side reservation timings (Redis reservation, whole reservation service) |
| `arrival` | First attempt, peak arrival rate, dispatch duration and the per-second arrival series |
| `vus` | Configured VUs and the number of k6 `Insufficient VUs` warnings |
| `generator` | The load generator's host capacity, CPU and memory use, and k6's start and completion times |
| `business` | Reservations, confirmed and failed orders, notifications |

The persisted evidence keeps averages and p95 only, and does not record how many VUs were busy. Mean VUs in flight follow from Little's law: achieved rate times the mean iteration time, blocked + sending + waiting + receiving (`blocked` already includes `connecting` and `tlsHandshaking`). The script samples nothing on the core either; sample CPU and connections outside it when needed (section 3).

## 3. Running it

### On the local stack

Prerequisites as in [Local Development](local_development.md#prerequisites): Linux, Docker with Compose v2, Node.js 22 and pnpm, `pnpm install` done, and a `.env` copied from `.env.example` with the four secrets set. Keep the machine otherwise idle. The runtime's data is disposable; from the repository root:

```bash
pnpm runtime:wipe
pnpm runtime:setup
pnpm runtime:up:debug   # the loopback-only override publishes the API on 127.0.0.1:4000
node scripts/run-with-env.mjs docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --wait
mkdir -p .cache/capacity   # write the run list here, for example .cache/capacity/runs.json
node scripts/run-with-env.mjs node scripts/capacity-measurement.mjs .cache/capacity/runs.json .cache/capacity/results.jsonl
```

`run-with-env.mjs` supplies `CONTROL_SERVICE_TOKEN` and `API_BASE_URL` from `.env`. The load generator runs on the same machine as the API, PostgreSQL, Redis and the worker, so a local result is the capacity of the whole stack on that machine; check `generator.utilisation` for a saturated generator. To sample the containers during a run, `docker stats --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'` in another terminal is enough.

### On the hosted deployment

The script runs inside the core's API container, where `CONTROL_SERVICE_TOKEN` is already set, so the token never leaves the Machine ([Admin Access](hosted_operations.md#admin-access)). The container's `/dev/shm` holds the files: a writable 64 MB tmpfs, far more than a series needs. It is wiped whenever the API container restarts, not only when the core stops, and a run that pushes the core past its capacity can restart it. From the repository root on the workstation:

```bash
core=<core Machine ID>   # flyctl machine list -a checkout-surge-core
put() {
  flyctl machine exec "$core" -a checkout-surge-core --container api \
    "node -e \"require('fs').writeFileSync('/dev/shm/$(basename "$1")',Buffer.from('$(base64 -w0 "$1")','base64'))\""
}
put scripts/capacity-measurement.mjs
put .cache/capacity/runs.json
flyctl machine exec "$core" -a checkout-surge-core --container api \
  "sh -c 'setsid node /dev/shm/capacity-measurement.mjs /dev/shm/runs.json /dev/shm/results.jsonl > /dev/shm/capacity.log 2>&1 < /dev/null &'"
flyctl machine exec "$core" -a checkout-surge-core --container api "cat /dev/shm/capacity.log"
flyctl machine exec "$core" -a checkout-surge-core --container api "cat /dev/shm/results.jsonl" > .cache/capacity/results.jsonl
```

- `put()` passes the file inside the exec argument; a 13 KB script copies intact this way (compare checksums). The `setsid` start returns in under a second, and the script outlives the exec call. Read the log until the last run's line appears.
- Copy the results file out (the last command) after every run, as soon as its line appears in the log. If the API container restarts, the script dies with it and the records in `/dev/shm` are lost; the runs they describe were already torn down, so run history no longer holds their evidence either.
- The core must be awake. A nonterminal run counts as activity, so a series keeps it awake; it stops 10 minutes after the last run when nothing else is active.
- Visitors see a run in progress meanwhile. If a visitor's run holds the slot, the script waits for it to end.
- The load generator is the runner Machine, so `generator` in each record describes the runner, and `host` the core. To sample the core during a run, read `/proc/stat`, each container's `/sys/fs/cgroup/default/<container>/cpu.stat` and `memory.current`, and the open API connections (`ss -Htn state established sport = :4000`) from `flyctl machine exec "$core" -a checkout-surge-core --no-container`, in a `setsid` background loop as above. That loop runs in the Machine's own namespace, whose `/dev/shm` is separate from the API container's and survives its restarts.

## 4. Measurement plan

### ERP settings

Every run, admin runs included, must pass the 600 s occupancy ceiling of the admission estimate, which adds the order drain to the traffic: start delay + traffic duration (the safety cutoff for a buyer spike) + orders × (ERP latency + `ESTIMATOR_JOB_OVERHEAD_MS`) / concurrency + `ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS`, when the declared ERP rate is not the tighter bound. Use the fastest ERP in every run so a large stock still fits: `erpLatencyMs` 0, `erpMaxTps` 1000, `erpErrorRate` 0, `orderProcessConcurrency` 10. With the default allowances (130 ms, 15 s) that drains about 77 orders per second (72 to 74 measured on the hosted core), so a run fits with at most about (585 − start delay − traffic duration) × 77 orders: about 44,000 for a 10 s constant-arrival run, about 40,000 for a buyer spike with a 60 s cutoff. The preflight refuses a list with a run above the ceiling. The drain also sets how long an all-accepted run holds the slot: about orders / 77 seconds after its traffic.

No request waits on the ERP: a VU is released when the API answers, at reservation time. The worker, however, starts draining orders during the traffic and competes with the API for PostgreSQL and CPU, so the ERP settings shape the measured phase too. Keep them fixed across a series.

### Host record

Record once per host, before measuring: the instance type, `nproc`, `lscpu | grep 'Model name'`, `free -m`, `uname -r` and the Docker version; on Fly, the core and runner Machine sizes (`guest` in `infra/fly/core/machine.json` and `infra/fly/runner/machine.json`). Each record repeats the script host's CPU and memory and the generator's own view.

### Runs

Constant-arrival runs last 10 s with explicit VUs at the VU cap, all pre-allocated (`preAllocatedVus` = `maxVus` = `DEMO_MAX_VUS`, 10,000 by default), so VUs run out only when the backlog is real. Buyer spikes use a 60 s safety cutoff, well above the time to answer them. k6's request timeout is also 60 s, so a request still unanswered after 60 s fails whatever the cutoff: an all-accepted 10,000-buyer spike on a 4 vCPU machine took about 62 s and lost 631 requests that way.

1. **All sold out** (`startingStock` 1).
   - Constant arrival: bisect the rate (below), then one saturated run at about 1.5 times the lowest rate that was not complete. Once every VU is busy, k6 starts an iteration only when an answer frees a VU, so the arrival series after the first seconds is the API's throughput.
   - Buyer spike: one run at each of a few buyer counts (for example 5,000 and 10,000, up to `DEMO_MAX_BUYERS`), each repeated once.
2. **All accepted** (stock equal to the planned requests: `ratePerSecond × durationSeconds`, or `buyerCount`). The same runs as above, with the stock following the rate. In constant arrival, the bisection's result is not a capacity: k6's 30 s graceful stop absorbs a backlog of accepted orders, so a 10 s run can be complete at two to three times the rate the API answers them. What these runs measure is the accepted throughput (section 5).
3. **Mixes.** One or two stock levels between the extremes, including 1,000. Predict each from the extremes with the additive model (section 5) and measure it the same way. Add stock levels only where the prediction misses by more than the run-to-run spread of the extremes.

**Bisection.** Keep the highest complete rate L and the lowest rate H that was not complete. Start from earlier figures for the host if there are any, otherwise from 1,000 per second, doubling until a run is not complete. Run (L + H) / 2, rounded to 125 per second, and stop when H − L is at most 250 per second; then repeat L once. The operator picks each next run from the printed lines, with one short run list per step.

## 5. From results to C, C′ and the latency budget

- **C** is L at the end of the all-sold-out bisection (C<sub>s</sub>), cross-checked by the steady arrival rate of the saturated run.
- **Accepted throughput** (C<sub>a</sub> for constant arrival, C′<sub>a</sub> for a buyer spike): accepted answers divided by the time from the first attempt to k6's completion (`responses.acceptedResponses` / (`generator.k6CompletedAt` − `arrival.firstAttemptStartedAt`)), from the all-accepted runs, including those whose last requests were interrupted. It is the pace at which the API's PostgreSQL pool answers orders. A constant-arrival run answers its accepted orders only until k6's graceful stop ends, so it can be complete only if S ≤ C<sub>a</sub> × (T + 30 s); past that, the remaining requests are interrupted.
- **C′.** C′ = N / the time to answer N buyers, which has two estimates:
  - **p95 / 0.95** (`responses.p95LatencyMs`). When every buyer arrives within a dispatch much shorter than the time to answer them all, the latencies spread evenly up to that time. Use it when `arrival.dispatchDurationSeconds` is under about half of p95 / 0.95 (on the hosted core: dispatch 0.7 to 1.1 s against 1.9 to 3.8 s).
  - **k6's upper bound**, `generator.k6CompletedAt` − `arrival.firstAttemptStartedAt`. It also counts k6's exit (0.7 to 2.3 s more than p95 / 0.95 on the hosted runner), so N / it is a lower bound for C′. Use it when the dispatch takes about as long as answering, or longer: a latency then no longer counts from the first arrival, and p95 / 0.95 overstates C′. On a 4 vCPU machine running k6 beside the stack, dispatch took up to 9.7 s, p95 / 0.95 gave 2.3 to 4.2 s and the bound 5.8 to 13.7 s; such a run measures the load generator, so check `generator.utilisation`.

  `httpTimings.connecting` should stay small beside the time: a multi-second `connecting` p95 means connections queue before the API reads them. C′ should not depend on N; report it for both extremes (C′<sub>s</sub>, C′<sub>a</sub>) with the estimate used. For all-accepted spikes, which take tens of seconds, the two estimates agree within a few percent.
- **Additive model.** An accepted order costs the API 1/C<sub>a</sub> seconds and a sold-out answer 1/C<sub>s</sub>.
  - Constant arrival, stock S over a run of T seconds: the accepted orders take S / (T × C<sub>a</sub>) of each second, and the rest serves sold-out answers, so the predicted highest complete rate is S/T + C<sub>s</sub> × (1 − S / (T × C<sub>a</sub>)), within the pool limit above.
  - Buyer spike, N buyers and stock S: the predicted time to answer them is S / C′<sub>a</sub> + (N − S) / C′<sub>s</sub>.
  - A mix only tests the model when the accepted share is large enough for the prediction to differ from C<sub>s</sub> by more than the spread, so add a mix with about half the requests accepted next to the 1,000-unit one.
  - In constant arrival the model can be pessimistic: accepted orders wait on the PostgreSQL pool while the API keeps answering sold-out requests, so an accepted order may cost fewer than C<sub>s</sub> / C<sub>a</sub> sold-out answers (about 7 instead of 15 on the hosted core). Written with that cost k, the prediction is C<sub>s</sub> − (k − 1) × S/T; bisect the mix and let its L and H bracket k.
- **Latency budget.** At the highest complete constant-arrival rate with stock 1, the mean iteration time is the sum of the `httpTimings` averages, blocked + sending + waiting + receiving (`blocked` already includes `connecting` and `tlsHandshaking`), and VUs needed ≈ rate × that time. The start transient needs a margin above the mean: on the hosted core, a 2 s budget (mean 1.3 s) left 1,207 requests unstarted, while 2.9 s held. Choose the budget, then confirm it: one run at C with stock 1 and `preAllocatedVus` = `maxVus` = C × budget must be complete. Stock 1 keeps it a test of the VU budget alone, since accepted orders lower the capacity and raise the mean iteration time (3.6 to 4.7 s with stock 1,000 on the hosted core, against 1.3 s). The p95 is much higher than the mean near saturation; it shows the start transient, not the VUs needed on average.
- **Stock effect.** Stock matters when C<sub>a</sub> and C<sub>s</sub> (or C′<sub>a</sub> and C′<sub>s</sub>) differ by more than the spread; the model then says how much a given stock lowers the capacity.

## 6. Recording the results

Add the host to [Capacity per connection mode](reference_runtime_measurements.md#capacity-per-connection-mode): the host record and the run settings, then for each mode C<sub>s</sub> or C′<sub>s</sub>, the accepted throughput, the stock-1,000 results against the model, the latency budget that held and the bottleneck, each with how many runs support it. Record figures and mechanisms, not one row per run: keep the per-run rows with the measurement's own notes, and the results files out of the repository (`.cache/` is git-ignored).

Then set the values in the deployment's API environment, where capacity-aware admission and the default constant-arrival VUs read them: `CAPACITY_CONSTANT_ARRIVAL_SOLD_OUT_PER_SECOND` (C<sub>s</sub>), `CAPACITY_CONSTANT_ARRIVAL_ACCEPTED_PER_SECOND` (C<sub>a</sub>), `CAPACITY_CONSTANT_ARRIVAL_ACCEPTED_ORDER_COST` (k), `CAPACITY_BUYER_SPIKE_SOLD_OUT_PER_SECOND` (C′<sub>s</sub>), `CAPACITY_BUYER_SPIKE_ACCEPTED_PER_SECOND` (C′<sub>a</sub>) and `CAPACITY_VU_LATENCY_BUDGET_SECONDS` ([local defaults](local_development.md); hosted values in `infra/fly/core/machine.json`).
