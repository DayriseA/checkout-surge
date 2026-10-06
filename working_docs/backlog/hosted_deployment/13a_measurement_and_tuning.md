# 13a — Measurement and Tuning

**Design:** sections 1.1, 1.2 · **Depends on:** 01–12, 14

## Goal

`surge-10k` is measured on Fly with the final setup, and the owner settles Machine sizes and the `DEMO_MAX_*` caps from that evidence.

## Scope

- **Measure** `surge-10k` on Fly and compare it with the local reference (`docs/reference_runtime_measurements.md`).
- **Runner size** (owner decision, 2026-10-06): measure the current performance-4x / 8 GB first, then performance-8x / 16 GB. Try performance-6x / 12 GB only if 8x improves arrival rate or latency.
  - The runner saturates its 4 vCPU while k6 creates its 10,000 VUs and during dispatch (task 02).
  - Fly's performance presets include 6x, 10x, 12x and 14x besides 1, 2, 4, 8 and 16 (pricing page, checked 2026-10-03). RAM is free between 2 and 8 GB per vCPU; the increment (256 MB or 2 GB) is unverified. Billing is per vCPU plus RAM above 2 GB per vCPU, per second while running: performance-4x / 8 GB is about $0.18 per hour, performance-6x / 12 GB about $0.28 per hour (US base rates; Europe carries a markup).
- **Core size:** watch the core's metrics during the runs, and propose a resize only if it saturates. The core is resized manually (design 1.1).
- **Caps:** propose `DEMO_MAX_*` values from the measurements, including constant-arrival runs (design 1.2). The values are the owner's decision.
- **Slow core stop** (input from task 12 below): find the container, then propose fixing its shutdown or accepting the 30 s worst case. The owner decides.
- Record the settled sizes and caps in their configuration, and their reasons where the inclusion rule of `docs/decisions/` calls for it.

## Out of Scope

- Documentation and GitHub Actions (13b), secret rotation and opening (13c), bot review (13d).

## Done When

- Sizes and caps are settled with the owner and recorded.
- The slow stop is understood, and fixed or accepted.

## Open Points

- None.

## Inputs from Task 12

- **Slow core stop with a run starting (observed, not fixed).** A `deploy.mjs core --force` stopped the core while a public run start was in flight (the API had just started the runner). The core VM shut down only at its 30 s stop timeout instead of the usual 11 s: an application process kept retrying Redis (`ioredis` `ECONNREFUSED 127.0.0.1:6379`) after Redis had stopped on its 10 s delay. Which container did not exit on SIGINT is unknown (the earlier log lines had rotated out). Find it, and decide whether its shutdown needs fixing or whether the 30 s worst case is accepted; the idle stop meets it only through its accepted race with a run start (HD-21).

## Working Notes

### Measurements (2026-10-06, 06:06 to 06:54 UTC)

**Setup.**

- Deployed version `810fa78…-dirty` (the application code of `HEAD`): core `8d4070aed50068` (performance-4x / 8 GB, cdg), runner `d8d3976b666498` (cdg).
- Every run was a public run through the gate (`POST /api/demo/runs/start` with a visitor cookie, as the demo page sends it). The figures come from its public run report.
- The runner size was switched through the API's `RUNNER_CPUS` and `RUNNER_MEMORY_MB`: the stopped core's config was rewritten through the Machines API under the core lease, with its images unchanged. The API then resized the runner at the next run start (design 1.1). The variables were removed again at the end, and the last run brought the runner back to performance-4x / 8 GB.
- Sampled during each run:
  - core: VM-wide `/proc/stat`, plus each container's cgroup v2 `cpu.stat` and `memory.current`, every 0.5 s (`flyctl machine exec --no-container`);
  - runner: `/proc/stat`, `MemAvailable` and the k6 `VmRSS`, every 0.25 s, from its start. Some samplings started late or failed, because an exec right after the runner's start was refused.
- The scratch scripts are not committed.

**`surge-10k`** (10,000 buyers, 500 units, ERP 20 TPS). Every run `completed` with delivery `complete`: 10,000 requests started and completed, 0 transport failures, 0 unexpected responses, 500 accepted and 9,500 sold out, 500 orders confirmed and notified.

| Run | Runner | Dispatch | Peak arrival (1 s window) | p95 | `waiting` avg / p95 | `connecting` avg / p95 | Runner CPU ≥ 90 % | k6 RSS / min. available | Core VM peak; > 50 % for | API cores peak / mean | Overall |
| :-- | :-- | --: | --: | --: | --: | --: | --: | :-- | :-- | :-- | --: |
| R1 | 4x / 8 GB | 1.25 s | 8,008/s | 9.52 s | 6.23 / 9.52 s | 246 / 490 ms | 3.2 s | – / 5.59 GB | 92 %; 10.9 s | 1.50 / 1.03 | 39.6 s |
| R2 | 4x / 8 GB | 1.82 s | 6,323/s | 8.61 s | 5.62 / 8.59 s | 234 / 443 ms | 3.7 s | – / 5.57 GB | 87 %; 10.9 s | 1.74 / 1.01 | 35.1 s |
| R13 | 4x / 8 GB | 1.26 s | 8,005/s | 9.69 s | 6.39 / 9.68 s | 221 / 354 ms | not sampled | 2.27 / 5.45 GB | 94 %; 12.5 s | 1.26 / 1.00 | 40.4 s |
| R10 | 6x / 12 GB | 1.66 s | 5,140/s | 10.17 s | 6.82 / 10.17 s | 263 / 736 ms | not sampled | 2.21 / 9.61 GB | 96 %; 15.1 s | 1.36 / 0.91 | 39.7 s |
| R11 | 6x / 12 GB | 1.01 s | 9,765/s | 10.10 s | 6.40 / 10.08 s | 188 / 294 ms | 2.1 s | 2.18 / 9.61 GB | 86 %; 13.0 s | 1.86 / 0.94 | 37.0 s |
| R5 | 8x / 16 GB | 0.74 s | 8,810/s | 11.76 s | 8.45 / 11.76 s | 233 / 1,027 ms | 1.6 s | 2.17 / 13.72 GB | 93 %; 13.0 s | 1.62 / 1.04 | 41.3 s |
| R6 | 8x / 16 GB | 0.91 s | 9,159/s | 9.68 s | 6.60 / 9.67 s | 270 / 1,019 ms | not sampled | – | 89 %; 12.0 s | 1.61 / 0.98 | 33.4 s |

- The p95 is the request duration; the reports keep only the average and the p95.
- The peak per 1 s window depends on where the dispatch falls against the second boundary (R10: 3,971 then 5,140), so the dispatch duration is the better generator figure.
- "API cores mean" is over the intervals where the core VM was more than 50 % busy.

**Constant arrival** (`public-custom`, 1,000 VUs preallocated and maximum, the public limits):

| Run | Runner | Traffic | Outcome | Started | Dropped | p95 | Runner | Core VM peak; API peak / mean |
| :-- | :-- | :-- | :-- | --: | --: | --: | :-- | :-- |
| R3 | 4x | 1,000/s for 10 s | `completed`, delivery `degraded` | 9,568 of 10,000 | 433 (4.3 %) | 2.91 s | not sampled | 89 %; 1.39 / 0.93 |
| R7 | 8x | 1,000/s for 10 s | `failed`, delivery `failed`, diagnostic `virtual_user_limit` (1,000) | 9,479 of 10,000 | 521 (5.2 %) | 3.15 s | CPU peak 36 %, k6 0.34 GB | 89 %; 1.29 / 0.94 |
| R8 | 8x | 800/s for 12 s | `completed`, delivery `degraded` | 9,418 of 9,600 | 183 (1.9 %) | 2.98 s | CPU peak 35 %, k6 0.35 GB | 90 %; 1.32 / 0.89 |

- Connections are reused (`connecting` p95 1 ms), and 0 transport failures occurred.
- The drops fall in the first two seconds. Arrivals per second were 406, 718, 761, then a steady 1,000 (R7), and 785, 617, then a steady 800 (R8). A latency transient at the start exhausts the 1,000 VUs; after it, the core keeps up with 800 to 1,000 requests per second.

**Findings.**

- **The latency is the core's, whatever the runner.** `waiting` (server time) makes up almost all of the request duration, and the p95 stays between 8.6 and 11.8 s on every runner size. The core answers the 10,000 requests over about 10 s, about 1,000 per second. Constant arrival starts dropping iterations at that same rate.
- **A larger runner sharpens the burst, nothing else.** Dispatch takes 1.25 to 1.82 s on 4x, 1.01 to 1.66 s on 6x, and 0.74 to 0.91 s on 8x. The sharper burst does not lower the latency. On 8x, the `connecting` p95 doubles to about 1 s, because more connections reach the API's accept queue at once.
- **The 4x runner is CPU-bound for 3.2 to 3.7 s per `surge-10k`:** about 2 s of k6 VU initialization, then the dispatch at 70 to 100 %. On 8x, VU initialization takes about 1.1 s at 95 %, and the dispatch runs at 70 to 80 %, so the generator no longer saturates while it sends. Steal stayed at 3 % or less, except one 0.25 s sample at 17 % (R2).
- **Runner memory is not a constraint.** The k6 RSS is 2.2 to 2.3 GB for 10,000 VUs on every size, about 225 kB per VU, and the 4x runner kept at least 5.45 GB available. Constant arrival with 1,000 VUs used 0.35 GB.
- **The core is close to saturation, but its limit is the single API process.**
  - During a `surge-10k`, the core VM is 86 to 96 % busy at peak, and more than 50 % busy for 11 to 15 s (mean about 80 %).
  - Per container: the API about 1.0 core (its one event loop; 1.3 to 1.9 at peak with GC and libuv threads), PostgreSQL 0.9 to 1.2, the worker 0.6 to 1.1, Redis 0.2 to 0.4. The core keeps at least 7.1 GB of memory available.
  - More vCPUs would not lift the single event loop, which sets the throughput under the single-API-process contract; they would only add headroom for the other containers.
- **Comparison with the local reference** (`docs/reference_runtime_measurements.md`). The transport and business behavior are the same as locally: every request planned, started and completed, zero transport failures and unexpected responses, every accepted order confirmed and notified. The local reference records no latency or arrival figures for `surge-10k`, so the p95 has no local counterpart. `connecting` stays under a second (p95 0.29 to 1.03 s), so there is no multi-second connection-establishment signal.

**Costs.** Fly pricing page, read 2026-10-06: performance CPUs cost $0.000012732 per vCPU-second, 2 GB per vCPU included, and Europe carries a ×1.1346 markup.

- Hourly in cdg: 4x / 8 GB $0.208, 6x / 12 GB $0.312, 8x / 16 GB $0.416.
- A `surge-10k` keeps the runner up about 41 s from start to exit: $0.0024 on 4x, $0.0036 on 6x, $0.0047 on 8x.
- The core (4x) costs $0.208 per awake hour.
- This session: the core awake for about 40 min, and 13 runner boots, about $0.18.

**Current caps.** The core config sets no `DEMO_MAX_*`, so the API uses its defaults:

- 100,000 buyers and total requests;
- 10,000 requests per second;
- 300 s duration and 30 s start delay;
- 10,000 preallocated and maximum VUs;
- 600 s occupancy.

The seeded public policy (10,000 buyers and requests, 1,000 requests per second, 120 s, 10 s, 1,000 VUs) is below them.

- **A buyer spike runs one k6 VU per buyer** (`per-vu-iterations` with `vus: buyerCount`), and `DEMO_MAX_VUS` does not apply to it. At about 225 kB per VU, 100,000 buyers need about 22 GB, more than the runner has at any size measured. That is the one cap the hosted runtime cannot honor.
- **A rate above the core's capacity harms nothing.** The run ends `degraded` or `failed` with the virtual-user-limit diagnostic, and a short burst at a high rate is what `surge-10k` itself is.
- **Total requests do not grow the database.** Sold-out decisions are counted rather than stored, and stored reservations and orders are bounded by the stock. The occupancy ceiling bounds the run's duration.

### Owner decisions on the first checkpoint (2026-10-06)

- **Slow stop:** read the captured logs and investigate, report the cause and the fix options; no fix before the owner decides.
- **Extra runs:**
  - one `surge-10k` on a performance-8x / 16 GB core, to see whether relieving CPU contention lowers latency;
  - two to three more `surge-10k` runs on a 6x runner, to settle 6x against 8x.
- **Architecture:** the single API process stays for this release. A multi-process API is a possible later project, on its own branch and environment. A decision entry is drafted below.
- **Caps and public policy:** deferred until the runner and core sizes are settled. The cap analysis above stands as input only.

### Extra measurements (2026-10-06, 08:10 to 08:23 UTC)

Same setup and sampling. The core size was changed like the runner variables (Machines API, under the core lease, images unchanged). The 8x core was started with `flyctl machine start` rather than through the gate, so a capacity refusal could not trigger a core recovery. It was back to performance-4x / 8 GB afterwards.

| Run | Core | Runner | Dispatch | Peak arrival | p95 | `waiting` avg / p95 | `connecting` p95 | Runner CPU ≥ 90 % | k6 RSS | Core VM peak; > 50 % for | API cores peak / mean |
| :-- | :-- | :-- | --: | --: | --: | --: | --: | --: | --: | :-- | :-- |
| R21 | 4x | 6x / 12 GB | 0.97 s | 7,533/s | 13.85 s | 9.55 / 13.85 s | 1,026 ms | 2.4 s | 2.32 GB | 93 %; 18.2 s | 1.26 / 0.86 |
| R22 | 4x | 6x | 0.98 s | 7,598/s | 13.34 s | 7.16 / 13.34 s | 258 ms | 1.6 s | 2.28 GB | 95 %; 20.3 s | 1.91 / 0.75 |
| R23 | 4x | 6x | 1.21 s | 9,179/s | 11.75 s | 7.57 / 11.75 s | 303 ms | 1.9 s | 2.33 GB | 91 %; 16.1 s | 1.94 / 0.87 |
| R24 | **8x / 16 GB** | 4x | 1.36 s | 5,935/s | 8.47 s | 5.73 / 8.45 s | 1,015 ms | not sampled | 2.36 GB | 61 % of 8 vCPU; 4.7 s | 1.69 / 1.35 |

Every run `completed` with delivery `complete`: 10,000 requests started and completed, 0 transport failures, 500 accepted, 500 confirmed.

- **Runner, all `surge-10k` runs.**
  - Dispatch: 4x 1.25, 1.26, 1.82 s; 6x 0.97, 0.98, 1.01, 1.21, 1.66 s; 8x 0.74, 0.91 s.
  - Runner CPU during the dispatch itself, after k6's VU initialization at 94 to 99 %: 4x 70 to 100 %, 6x 74 to 91 %, 8x 62 to 82 %.
  - 6x gets most of the gain over 4x, and runs close to saturation while it dispatches. 8x is about 20 % faster again, with clear headroom.
  - Latency does not follow the runner size. The p95 of this second session (11.8 to 13.9 s on 6x) is higher than the first session's (10.1 to 10.2 s on 6x, 8.6 to 11.8 s overall). Run-to-run and session-to-session variance of the core dominates.
- **Core 8x (one run).**
  - The p95 was 8.47 s, the lowest of all `surge-10k` runs, but within the 4x-core range for the same 4x runner (8.61 to 9.69 s, first session).
  - The API got more CPU: 1.35 cores on average while the core was busy, against about 1.0 on the 4x core. PostgreSQL reached 1.9 cores (1.2 on 4x).
  - The VM peaked at 61 % of 8 vCPU. Contention relief therefore helps a little at most, for twice the core's hourly cost ($0.416 instead of $0.208 per awake hour). The single API process still bounds the throughput.

### Proposed sizes (caps deferred)

- **Runner: performance-8x / 16 GB, or 6x / 12 GB as the close alternative.**
  - 8x dispatches a `surge-10k` in 0.74 to 0.91 s with the generator at 62 to 82 % CPU, so the arrival profile cannot be read as a generator limit.
  - 6x dispatches in about 1.0 s (median of five; 0.97 to 1.66 s), at 74 to 91 % CPU, close to saturation.
  - Per `surge-10k`: $0.0047 on 8x, $0.0036 on 6x, $0.0024 on 4x.
  - Latency and business results are the same at every size.
- **Core: keep performance-4x / 8 GB.** The 8x core gave at most a small latency gain for twice the awake cost, and the single API process sets the throughput (decision draft below).
- **Recording, once settled:** in `infra/fly/core/machine.json` (core `guest`, plus `RUNNER_CPUS` and `RUNNER_MEMORY_MB` when they differ from the API defaults of 4 and 8192) and in the runner `guest` of `infra/fly/runner/machine.json`, because every deploy sends these files. Design 1.1's "resized manually" and "no commit" wording is updated at the same time.
- **`docs/decisions/scope_and_caveats.md`:** see the final wording under "Wrap-up" below.

### Slow core stop

**The container is the API.** In every slow stop, Fly's container events show:

- caddy, web (130), mock-erp and worker exiting within 0.1 s;
- PostgreSQL and Redis exiting cleanly 10 s later (`delayed-stop.sh`);
- the API exiting only when Fly kills it at the 30 s stop timeout (`api exited 137`). The Machine is `stopped` about 31 s after the request.

**Slow and fast stops observed (2026-10-06).**

| Stop (UTC) | How | Before the stop | API | Stopped after |
| :-- | :-- | :-- | :-- | --: |
| 06:14:44 | `flyctl machine stop` while a run start was in flight | constant arrival 1,000/s earlier | 137 at +30 s | 31.0 s |
| 06:24:24 | `flyctl machine stop` | constant arrival 800/s, 36 s before | 137 at +30 s | 31.0 s |
| 06:29:08 | `flyctl machine stop` | `surge-10k`, 31 s before | 137 at +30 s | 31.0 s |
| 06:43:17 | the API's own idle stop | `surge-10k`, 10 min before | 137 at +30 s | 30.9 s |
| 08:19:16 | `flyctl machine stop` | three `surge-10k` | 137 at +30 s | 31.1 s |
| 08:22:02 | `flyctl machine stop` (8x core) | one `surge-10k` | 137 at +30 s | 31.0 s |
| 08:12:01 | `flyctl machine stop` | `preview-1k`, 35 s before | 0 at once | 11.4 s |
| 06:53:23 | `flyctl machine stop` | no run since boot | 0 at once | 11.0 s |
| 03:44:42 (task 12) | `flyctl machine stop` | no run since boot | 0 at once | 11.1 s |

Task 14's stops by hand after a `surge-10k` (2026-10-05) also took 31 to 32 s.

**What the API waits on: zombie healthcheck processes, which only Fly's init can reap.**

- **Logs.** In every slow stop, the API logs "Closing API server." within 30 ms of the signal, then nothing more. It logs no error and no Redis or PostgreSQL retry, even after the databases stop.
- **Live inspection.** SIGINT sent to the API process alone after three `surge-10k` runs, from the Machine namespace with the Machine running:
  - within 1 s, the API's main thread had exited: zombie state, all file descriptors closed;
  - its last thread slept in the kernel's `zap_pid_ns_processes`, the wait of a dying PID-namespace init for every other process of its namespace;
  - Fly kept the container `unhealthy`, not exited.
- **The other processes of that namespace** were eight zombie `node` processes in the API container's cgroup, whose parent is Fly's init (host PID 1), outside the namespace.
- **They are the API healthchecks** (`node -e "fetch('http://127.0.0.1:4000/health/ready')…"`, every 2 s, 3 s timeout) that timed out while a burst saturated the API:
  - they started 5 s apart, at 26, 31, 36, 90, 95, 100, 150 and 155 s after boot;
  - that is 0.3 to 11 s after the first request of the three runs (first requests at 25.7, 89.1 and 149.2 s after boot);
  - each timed-out check is left unreaped by Fly's init.
- **Why the API cannot exit.** When the API, PID 1 of its container's PID namespace, exits, the kernel waits until every process of that namespace has gone. A zombie goes only when its parent reaps it, and here the parent is Fly's init. The API therefore stays a zombie until Fly tears the container down at the stop timeout, and Fly reports 137.
- **Other containers.** None has zombies: their healthchecks never time out. The databases' delayed stop is unaffected.
- **Why some stops are fast.** A `preview-1k` (1,000 requests) or no run never makes an API check time out, so those stops take 11 s. One `surge-10k` (2 to 3 timed-out checks) or a constant-arrival run at 800 to 1,000/s is enough to cause one. My first isolated SIGINT tests, which exited in under 1 s, followed `preview-1k` runs, hence the earlier wrong reading.
- **The application's shutdown is not at fault:** the API finishes its close in under a second.
- **Task 12's case** (a forced deploy 1 s after a run start, on a core freshly booted with no burst yet, and the API still retrying Redis after Redis stopped) does not fit this mechanism. It points to a second, rarer cause: a run start in flight keeps the API's close waiting. That case is not separately reproduced. The 06:14 reproduction followed a constant-arrival run, so its zombies explain it.

**Impact today.**

- Every session that ran a `surge-10k`, or a constant-arrival run that saturates the API, ends with a 31 s stop instead of 11 s, idle stop included.
- That adds about 20 s of core time ($0.001). A visitor waking the core in that window waits up to 30 s more, because the gate waits for a `stopping` core. A deploy waits 20 s more.
- No data risk: PostgreSQL and Redis stop cleanly at 10 s, before the kill.
- About 3 zombie PIDs per burst accumulate while the core is up. That is harmless within the guard's 3-hour awake cap.

**Fix options (owner decision; nothing implemented).**

1. **Make the healthcheck command end before Fly's timeout.** The API check's `fetch` gets its own deadline below Fly's 3 s timeout, for example `AbortSignal.timeout(2000)`. Fly's timeout could also rise to about 5 s for margin under CPU contention.
   - A check then always exits by itself, as every passing check already does (those are reaped normally), so no zombie remains.
   - Config only (`infra/fly/core/machine.json`), effective at the next deploy.
   - The API still reads `unhealthy` during a burst, as today; nothing acts on that state after boot. The same pattern suits the other `node -e` checks (worker, mock-erp, web), which have not timed out so far.
   - Relies on Fly's init reaping checks that exit in time, which is what it does today.
   - Verify with a `surge-10k` then a stop (expect 11 s and no zombie in the API cgroup).
2. **Raise only the API check's timeout well above any saturation** (for example 30 s).
   - Simplest config change.
   - Fragile: a longer saturation, such as a long constant-arrival run, can still exceed it, and a hung API at boot is detected later.
3. **Use a check that spawns no process in the container.** For example an HTTP container healthcheck run by Fly's init, if Fly supports it for containers and `depends_on: healthy` honors it.
   - Removes the cause entirely.
   - Support and behavior are unverified.
4. **Shorten the Machine's stop timeout** (30 s to, say, 15 s).
   - Caps the slow stop at about 16 s.
   - The databases still stop cleanly at 10 s, with about 5 s of margin before the kill.
   - The zombies remain, and a slow PostgreSQL checkpoint past the margin would be killed (crash recovery at the next start; data safe in the WAL).
5. **Accept** the 31 s stop after a saturating session, and document it.

These would not help:

- a shutdown deadline in the API, which already exits in under a second;
- an init process such as tini as the container's PID 1, which cannot reap processes whose parent is Fly's init outside the namespace.

Reporting the unreaped timed-out exec checks to Fly is worth doing whichever option is chosen.

**Recommendation:** option 1, with a Fly timeout of about 5 s. It is the smallest change, it removes the cause, and it keeps today's health semantics. If the owner wants the rarer in-flight-start variant (task 12) settled too, that needs its own reproduction on a core with no burst yet.

### Decision entries, final drafts (inserted as HD-51 to HD-54)

Each line in italics says why the entry meets the inclusion rule; it is not part of the entry.

#### HD-NN Hosted throughput is bounded by the single API process; the core is sized for headroom

*Inclusion: a larger core looks like the way to faster runs, and a multi-process API like an obvious improvement.*

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:**
  - Measured on Fly, the single API process sets the hosted throughput:
    - about 1,000 requests per second for a buyer spike, where every buyer opens a new connection;
    - about 3,200 per second for constant arrival over reused connections, where 10,000 VUs were all in flight at 3,500 per second and the run dropped iterations, without a failed request or a connection error.
  - The API's event loop runs at about one core, while PostgreSQL, the worker and Redis share the rest of the core Machine. On 4 vCPU the VM reached 86 to 93 % during a burst.
  - Measured interleaved in one session, a 6 vCPU core gave the API about 25 % more CPU and left 15 to 30 % of the VM free, but the latency stayed within the run-to-run spread. An 8 vCPU core, measured once, gave no clear gain either.
- **Decision:** Keep one API process, the sole maintenance authority, for this release. The core gets 6 vCPU for the burst's headroom, not for throughput, and the hosted run limits take the single process's throughput as given.
- **Consequences:**
  - The core costs about half as much again per awake hour as on 4 vCPU, for headroom rather than speed.
  - The burst latency, and any rate above the process's throughput, change only with a multi-process API.
  - Admin runs above that rate degrade or fail their delivery, with the virtual-user-limit diagnostic, without harming the infrastructure. The deployment caps stay generous on purpose, so the owner can push admin runs to failure.
- **Rejected alternatives:**
  - Several API processes (a cluster or replicas): they break the single-maintenance-authority contract that run starts, resets and runner operations rely on ([HD-11](#hd-11-runner-operations-and-run-starts-are-serialized-in-process)). Possible later, as a separate project on its own branch and environment.
  - A larger core as the throughput lever: the single event loop cannot use more vCPUs.
  - Keeping 4 vCPU: the cheapest and with the same results, but the burst leaves the VM almost no headroom.

#### HD-NN Core healthchecks end on their own, before Fly's check timeout

*Inclusion: the check's own deadline looks redundant next to Fly's timeout, and removing it brings the slow stop back.*

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:**
  - Fly's init runs each container's exec healthcheck as a process inside the container. When a check exceeds Fly's timeout, Fly abandons it without reaping it, and the zombie stays in the container's PID namespace.
  - When the container's main process exits, the kernel waits for every process of that namespace, so the container ends only when Fly tears it down at the Machine's stop timeout.
  - Measured: the API's check timed out during every 10,000-buyer burst. Every later stop, idle stop included, then took 31 s instead of 11 s, and ended with the API killed.
- **Decision:** Each Node healthcheck of the core aborts its own request before Fly's check timeout, so it always exits by itself and is reaped.
- **Consequences:**
  - The API still reads unhealthy during a burst, as before; nothing acts on that state after boot.
  - The fix relies on Fly reaping checks that exit in time, as it does for every passing check. Verified: no zombie after bursts, and stops back to about 11 s.
  - The PostgreSQL and Redis checks are not Node checks and have never timed out; they are left as they are.
- **Rejected alternatives:**
  - A longer Fly timeout alone: a longer saturation still exceeds it, and a hung service at boot is detected later.
  - A shutdown deadline in the application: the API already exits in under a second; the wait is in the kernel.
  - An init process such as tini as the container's PID 1: it cannot reap processes whose parent is Fly's init.
  - A shorter Machine stop timeout: it only shortens the wait, and leaves less margin for the databases' delayed stop.
- **Code:** the `healthchecks` of `infra/fly/core/machine.json`.

#### HD-NN The runner has 8 vCPU so the generator does not saturate while it dispatches

*Inclusion: a smaller runner gives the same latency and business results, so downsizing it looks like a free saving.*

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:** On a 4 vCPU runner, k6 saturates its CPU while it initializes 10,000 VUs and dispatches them: the burst leaves in 1.25 to 1.82 s. The latency is set by the core whatever the runner size.
- **Decision:** The runner has 8 vCPU, with the smallest memory Fly allows for them. The burst leaves in 0.74 to 1.35 s, with the generator at 62 to 82 % CPU while it sends.
- **Consequences:** The arrival profile cannot be read as a generator limit. A run costs about half a cent instead of a quarter. k6 uses about 2.3 GB for 10,000 VUs.
- **Rejected alternatives:**
  - 4 vCPU: the cheapest, but CPU-bound during the dispatch.
  - 6 vCPU: dispatch about 1.0 s, at up to 91 % CPU, so still close to saturation.
- **Code:** `RUNNER_CPUS` and `RUNNER_MEMORY_MB` in `infra/fly/core/machine.json`, and the runner `guest` in `infra/fly/runner/machine.json`.

#### HD-NN Visitors' constant-arrival rate is limited to 500 per second, below what the hardware sustains

*Inclusion: the hosted core sustains about 3,000 requests per second over reused connections, so the 500 limit looks needlessly low.*

- **Status:** accepted
- **Date:** 2026-10-06
- **Context:**
  - A visitor's custom run must always complete.
  - The public form sends no VU setting, so k6 pre-allocates as many VUs as the rate per second and may grow to twice that.
  - At 1,000 per second, the latency jump in the first two seconds exhausted those VUs, and about 1 % of the iterations were dropped. At 500 per second, every measured run was complete.
  - With 5,000 or more pre-allocated VUs, runs were complete up to about 3,000 per second.
- **Decision:** The public constant-arrival rate limit is 500 per second, until the default VU allocation is made capacity-aware. The public VU limits stay at their defaults: they bind only callers who set VUs explicitly.
- **Consequences:**
  - A visitor's constant-arrival run lasts at least 20 s at the 10,000-request limit.
  - Raising the limit needs the default VU allocation changed first, or the form to send a VU setting; a later run-admission task owns that.
  - The value comes from the setup container's environment, so it applies to a fresh core; an existing core keeps its policy until an admin edits it.
- **Rejected alternatives:**
  - 1,000 per second with the default allocation: about 1 % of a run dropped, so the delivery verdict is not clean.
  - Raising only the public VU limits: the form does not use them.
- **Code:** the `setup` container env (`PUBLIC_CUSTOM_*`) in `infra/fly/core/machine.json`; `resolveConstantArrivalVus` in `packages/contracts/src/load.ts`.

### Owner decisions on the second checkpoint (2026-10-06)

- Runner: performance-8x / 16 GB, recorded in config.
- Slow stop: option 1, the healthcheck's own deadline.
- Core: one more measurement, 6x / 12 GB interleaved with 4x / 8 GB, all with the runner at 8x.
- Caps and public policy: still deferred.

### Implementation (uncommitted)

- **`infra/fly/runner/machine.json`:** `guest` set to performance 8 vCPU / 16,384 MB.
- **`infra/fly/core/machine.json`:**
  - the API env gets `RUNNER_CPUS=8` and `RUNNER_MEMORY_MB=16384`, so the API keeps the runner at the deployed size and recreates it at that size;
  - the four `node -e` healthchecks (mock-erp, api, worker, web) pass `signal: AbortSignal.timeout(2000)` to their `fetch`. Each check then exits by itself within about 2 s, below Fly's check timeout (3 s; 5 s for web).
  - Only the API's check was seen timing out, but the other three are the same command and would leave the same zombie, blocking their own container's exit, the day their service is slow during a burst. The PostgreSQL and Redis checks (`pg_isready`, `redis-cli`) are left as they are: they are not Node, and never timed out.
  - Fly's timeouts are unchanged: 2 s plus Node's start-up fits under 3 s, and the verification below left no zombie.
- **`design.md`:** 1.1 (sizes live in the repository's Machine configs, which every deploy sends whole; runner 8x; core pending; the measured summary), the topology sketch, the decision summary's "Sizes" row, and 3.1 (the healthcheck workaround).
- **Deployed** with `deploy.mjs all`, not `core`: the working tree is a new version (`743f9bb…-dirty`), and a core-only deploy would have left the runner on the previous version, so the version handshake would refuse every run. `all` also applies the runner's new `guest`.
  - Builds and updates 08:31 to 08:41 UTC, the core asleep, so no `--force`.
  - Output: "The core and the runner both run version 743f9bb…-dirty", exit 0.

### Verification and interleaved core measurement (2026-10-06, 08:41 to 08:55 UTC)

The runner was 8x / 16 GB throughout, with the same sampling as before. The core size was switched on the stopped Machine (Machines API, under the core lease). The 6x core was started with `flyctl machine start`, so a capacity refusal could not trigger a recovery. Sequence: core 4x, 6x, 4x, 6x, two `surge-10k` runs each.

| Run | Core | Dispatch | Peak arrival | p95 | `waiting` avg / p95 | `connecting` p95 | Core VM peak; > 50 % for | API cores peak / mean | Overall |
| :-- | :-- | --: | --: | --: | --: | --: | :-- | :-- | --: |
| R25 | 4x / 8 GB | 1.06 s | 5,114/s | 10.64 s | 6.53 / 10.64 s | 1,044 ms | 92 %; 16.6 s | 1.39 / 0.89 | 41.0 s |
| R26 | 4x | 1.35 s | 5,734/s | 9.36 s | 5.62 / 9.36 s | 300 ms | 86 %; 11.4 s | 2.01 / 1.00 | 36.9 s |
| R27 | 6x / 12 GB | 0.88 s | 9,957/s | 9.31 s | 6.08 / 9.31 s | 1,017 ms | 85 %; 10.4 s | 1.53 / 1.17 | 35.6 s |
| R28 | 6x | 1.09 s | 6,150/s | 8.52 s | 5.50 / 8.52 s | 257 ms | 69 %; 8.8 s | 2.17 / 1.21 | 36.1 s |
| R29 | 4x | 0.82 s | 6,967/s | 10.56 s | 6.84 / 10.50 s | 372 ms | 93 %; 13.0 s | 1.43 / 0.95 | 41.1 s |
| R30 | 4x | 0.85 s | 9,735/s | 9.46 s | 6.45 / 9.46 s | 1,030 ms | 90 %; 13.5 s | 1.30 / 0.90 | 36.4 s |
| R31 | 6x | 1.09 s | 9,681/s | 11.50 s | 7.85 / 11.49 s | 311 ms | 82 %; 12.0 s | 1.54 / 1.17 | 35.9 s |
| R32 | 6x | 0.88 s | 5,893/s | 8.19 s | 5.63 / 8.19 s | 1,047 ms | 74 %; 9.4 s | 1.58 / 1.19 | 36.3 s |

- Every run `completed` with delivery `complete`, 0 transport failures and 500 confirmed. k6 used 2.2 to 2.3 GB, and the 8x runner kept at least 13.6 GB available.
- The VM percentages are of the core's own vCPU count.
- **4x core:** p95 9.36 to 10.64 s (mean 10.0 s); `waiting` average 6.36 s; the VM peaks at 86 to 93 %; the API averages 0.94 cores.
- **6x core:** p95 8.19 to 11.50 s (mean 9.38 s); `waiting` average 6.27 s; the VM peaks at 69 to 85 %; the API averages 1.19 cores.
- The 6x core gives the API about 25 % more CPU, and the VM keeps 15 to 30 % headroom instead of about 10 %. The latency gain is small and inside the run-to-run spread (the ranges overlap).
- Cost: a 6x core is $0.312 per awake hour against $0.208, so about $0.10 more per hour awake; a few hours a month comes to cents. The resize to 6x and back was accepted on the core's host each time.
- The 8x runner dispatched in 0.82 to 1.35 s this session, slower than the earlier 0.74 and 0.91 s, so dispatch varies too. The runner was at 90 % or more for only 0.5 to 2.1 s, mostly k6 VU initialization.

**Slow stop fixed (verified on Fly).** After each pair of `surge-10k` runs, before the stop, there were zero zombie processes in every core container (api, worker, web, mock-erp, caddy, postgres, redis). The API's check did fail during the bursts: the API had 1 to 3 `unhealthy` events per pair. It now failed within its own deadline instead of timing out.

| Stop (UTC) | Core | API | Stopped after |
| :-- | :-- | :-- | --: |
| 08:44:31 | 4x, after R25 and R26 | exited 0 at +0.1 s | 11.4 s |
| 08:47:58 | 6x, after R27 and R28 | exited 0 at +0.1 s | 11.7 s |
| 08:51:08 | 4x, after R29 and R30 | exited 0 at +0.1 s | 11.8 s |
| 08:54:12 | 6x, after R31 and R32 | exited 0 at +0.1 s | 11.9 s |

Before the fix, every stop after a `surge-10k` took 31 s, and the API was killed (137). The rarer case from task 12 (a stop while a run start is in flight, on a core with no burst yet) is out of scope and not reproduced.

**Core size recommendation: performance-6x / 12 GB.** It is not a throughput lever (draft HD entry above): the single API process still bounds latency, and the latency gain is not established. It does give the burst the headroom the core lacks at 4x, where it runs at 86 to 93 % with the API sharing four vCPUs with PostgreSQL and the worker, for about $0.10 per awake hour. Keeping 4x / 8 GB remains defensible if cost matters more than headroom: the results are the same. The config still says 4x / 8 GB, as asked, until the owner decides.

### Owner decisions on the third checkpoint (2026-10-06)

- Core: performance-6x / 12 GB, for headroom rather than throughput. Recorded in the core `guest`, in design 1.1 and in the decision summary's "Sizes" row.
- The three decision entries are turned into final drafts (above).
- Next: caps and public policy, measured on the final hardware.
  - Caps must stay at or above the fixed seed values of `buildPublicRuntimePolicy`: no seed code change.
  - The public policy is set through `PUBLIC_CUSTOM_*` in the `setup` container's env. Go-live uses a fresh core, so that env is what visitors get.
- Every public preset is run once on the final hardware.

### Final hardware deployed (2026-10-06, 08:58 to 09:08 UTC)

`deploy.mjs all` with the core `guest` at 6x / 12 GB, on a sleeping core. Output: "The core and the runner both run version 743f9bb…-dirty", exit 0. Each 6x start since then was done with `flyctl machine start`, so a capacity refusal could not trigger a gate recovery, then the gate was used as usual.

### Public constant arrival on the final hardware (09:11 to 09:16 UTC)

Core 6x / 12 GB, runner 8x / 16 GB, `public-custom` with 1,000 VUs preallocated and maximum (the public limits).

| Run | Traffic | Outcome | Started | Dropped | p95 | `waiting` avg | Core VM peak | Runner CPU peak |
| :-- | :-- | :-- | --: | --: | --: | --: | --: | --: |
| R33 | 1,000/s for 10 s | `completed`, delivery `degraded` | 9,690 of 10,000 | 311 (3.1 %) | 2.42 s | 276 ms | 73 % | 33 % |
| R35 | 1,000/s for 10 s | `completed`, delivery `complete` | 10,000 | 0 | 1.49 s | 160 ms | 70 % | 31 % |
| R34 | 500/s for 20 s | `completed`, delivery `complete` | 10,000 | 0 | 0.99 s | 106 ms | 74 % | 30 % |
| R36 | 500/s for 20 s | `completed`, delivery `complete` | 10,000 | 0 | 1.11 s | 115 ms | 69 % | 31 % |

- At 1,000/s, a run still sometimes drops iterations in its first two seconds (R33: arrivals 227, 885, 804, then 1,000), when a latency transient exhausts the 1,000 VUs. On the 4x core both such runs had dropped 4 to 5 %.
- At 500/s, both runs were complete, with a p95 around 1 s.
- More VUs at 1,000/s (about 3,000) is above the public limit, so it needs an admin run, which this agent cannot start (commands in the checkpoint report).
- The stop after these four runs: 11.8 s, no zombie.

### Every public preset on the final hardware (09:17 to 09:30 UTC)

**Method.**

- One public run per preset, each on a freshly started core followed by a timed stop.
- Core: VM-wide and per-container CPU and memory every 0.5 s, sampled in the background on the VM (`/dev/shm`, since `/tmp` is read-only in the Machine namespace) for the whole run: from 2 s before the start to 5 s after the terminal state, ERP drain included.
- Runner: CPU, available memory and k6 RSS every 0.25 s while k6 lives. It covers the start and the traffic, then the runner idles until finalization.
- Order queue depth: the report's queue backlog series (orders accepted and awaiting their first processing).
- Live stream: one SSE connection to `/dashboard/events` through the gate for the whole run.
- Estimate: the public estimate endpoint, called just before the start.
- CPU is in cores, and memory is the container cgroup's `memory.current`, given as peak / mean over the sampled window.

| Preset | Outcome; delivery | Accepted / sold out; confirmed = notified | Dispatch; p95 | Queue peak; drain | Actual occupancy vs conservative (explanatory) estimate | Core VM peak / mean (6 vCPU) | API CPU; mem | Worker CPU; mem | PostgreSQL CPU; mem | Redis CPU; mem | Runner CPU peak / mean (8 vCPU); k6 RSS | SSE | Stop |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | --: |
| `preview-1k` | completed; complete | 500 / 500; 500 | 0.20 s; 3.23 s | 487; 27.3 s | 34.6 s vs 71.3 s (30.0 s) | 76 / 24 % | 1.54 / 0.24; 257 / 199 MB | 1.27 / 0.43; 211 / 188 MB | 1.55 / 0.46; 276 / 230 MB | 0.54 / 0.06; 93 / 83 MB | 45 / 6 %; 0.26 GB | up; longest gap 3.6 s | 11.7 s |
| `surge-5k` | completed; complete | 500 / 4,500; 500 | 0.61 s; 5.34 s | 495; 28.5 s | 34.9 s vs 121.3 s (80.0 s) | 84 / 26 % | 1.56 / 0.30; 323 / 244 MB | 1.20 / 0.42; 200 / 190 MB | 1.47 / 0.48; 396 / 247 MB | 0.73 / 0.08; 86 / 71 MB | 94 / 9 %; 1.09 GB | up; 6.2 s | 11.7 s |
| `surge-10k` | completed; complete | 500 / 9,500; 500 | 1.20 s; 7.46 s | 500; 29.4 s | 39.8 s vs 161.3 s (120.0 s) | 76 / 26 % | 1.68 / 0.33; 422 / 289 MB | 1.14 / 0.40; 211 / 195 MB | 1.45 / 0.43; 296 / 231 MB | 0.42 / 0.09; 95 / 87 MB | 99 / 16 %; 2.21 GB | up; 3.3 s | 11.6 s |
| `slow-erp-5k` | completed; complete | 500 / 4,500; 500 | 0.49 s; 5.69 s | 500; 107.7 s | 117.1 s vs 200.3 s (100.0 s) | 65 / 16 % | 1.65 / 0.18; 321 / 224 MB | 0.76 / 0.26; 207 / 189 MB | 1.11 / 0.27; 283 / 236 MB | 0.68 / 0.05; 98 / 89 MB | 96 / 11 %; 1.11 GB | up; 4.2 s | 11.6 s |
| `laggy-erp-5k` | completed; complete | 500 / 4,500; 500 | 0.66 s; 5.20 s | 500; 104.8 s | 112.1 s vs 208.0 s (113.0 s) | 71 / 17 % | 1.54 / 0.18; 341 / 225 MB | 1.03 / 0.26; 187 / 184 MB | 1.42 / 0.29; 382 / 268 MB | 0.68 / 0.05; 101 / 90 MB | 96 / 12 %; 1.17 GB | up; 4.4 s | 11.7 s |
| `idempotency-check-200` | completed; complete | 200 / 0; 200 (400 requests, 200 replays) | 1.32 s; 1.16 s | 196; 11.9 s | 19.7 s vs 36.5 s (11.0 s) | 79 / 20 % | 1.56 / 0.22; 236 / 201 MB | 1.08 / 0.31; 205 / 188 MB | 1.43 / 0.38; 253 / 186 MB | 0.20 / 0.04; 88 / 87 MB | not sampled | up; 7.2 s | 11.6 s |

- **Every run is clean.** Every planned request started and completed, with 0 transport failures, 0 unexpected responses and 0 pending persistence. Every accepted order was confirmed and notified, none failed, and the result is `completed-successfully`.
- **The ERP-bound presets.**
  - The queue drains linearly at the ERP's pace: `slow-erp-5k` from 500 to 58 over about 100 s (5 confirmations per second); `laggy-erp-5k` from 495 to 55 (about 4.7 per second: 5 workers at 1 s per call).
  - During the drain the core is mostly idle: VM mean 16 to 17 % against 24 to 26 % for the short presets. The worker averages 0.26 cores, PostgreSQL 0.27 to 0.29.
  - Redis stays at about 90 to 100 MB, and the core keeps at least 11.2 GB available. No container grows during the drain: the peaks are at the burst.
- **The live stream stays up for every run.** The SSE connection through the gate stayed open from before the start to after the terminal state; we closed it. The longest silence was 3.3 to 7.2 s.
- **Occupancy against the estimate** (to record, not applied to `docs/estimator_calibration.md`). The conservative estimate is the one admission uses; the explanatory one is shown to the visitor.

  | Preset | Actual (s) | Conservative estimate (s) | Ratio | Explanatory (s) |
  | :-- | --: | --: | --: | --: |
  | `preview-1k` | 34.6 | 71.3 | 2.06 | 30.0 |
  | `surge-5k` | 34.9 | 121.3 | 3.48 | 80.0 |
  | `surge-10k` | 39.8 | 161.3 | 4.05 | 120.0 |
  | `slow-erp-5k` | 117.1 | 200.3 | 1.71 | 100.0 |
  | `laggy-erp-5k` | 112.1 | 208.0 | 1.86 | 113.0 |
  | `idempotency-check-200` | 19.7 | 36.5 | 1.85 | 11.0 |

  The conservative estimate is always above the actual, so nothing is under-admitted. For the two ERP presets, the explanatory estimate is close (100 against 117 s, 113 against 112 s). Each figure is one run on this host.
- **Stops.** Every stop took 11.6 to 11.7 s, with the API exiting 0 and no zombie: the healthcheck fix holds on the final hardware.
- **This session's `surge-10k` on the final hardware:** p95 7.46 s, dispatch 1.20 s.

### Caps and public policy proposal (not applied)

**What the values must admit.**

- **Presets.** The public presets reach at most 10,000 buyers and 10,000 requests (`surge-10k`), 120 s maximum duration (`surge-10k`) and no start delay. The admin presets reach at most 20 requests per second, 12 s and 60 VUs.
- **Fixed seed values** (`buildPublicRuntimePolicy`, no code change):
  - an occupancy ceiling of 600 s, so `DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS` must stay 600, its maximum;
  - public custom defaults of a 5,000-buyer spike over at most 80 s, so the public buyer, total-request and duration limits must stay at or above 5,000, 5,000 and 80 s.
- **Ordering.** Caps must be at or above the public limits, or the API refuses to start.

**Caps (`DEMO_MAX_*`, API env in `infra/fly/core/machine.json`).**

- `DEMO_MAX_BUYERS`: from 100,000 (default) to **10,000**.
  - A buyer spike runs one k6 VU per buyer, and `DEMO_MAX_VUS` does not bound it. k6 uses 2.2 to 2.3 GB per 10,000 VUs, so 100,000 buyers (about 22 GB) cannot run on the 16 GB runner.
  - 10,000 is the measured `surge-10k` and the public buyer limit. 20,000 would fit (about 4.5 GB) but is unmeasured.
- The others keep their defaults:
  - `DEMO_MAX_VUS` and `DEMO_MAX_PRE_ALLOCATED_VUS` 10,000: memory measured as above;
  - `DEMO_MAX_REQUESTS_PER_SECOND` 10,000: a rate above the core's about 1,000/s only degrades or fails the run's delivery, with the virtual-user-limit diagnostic, and a 10,000/s burst is what `surge-10k` is;
  - `DEMO_MAX_TOTAL_REQUESTS` 100,000: sold-out decisions are counted, not stored, so the database does not grow with it, and the occupancy ceiling bounds the run;
  - `DEMO_MAX_TRAFFIC_DURATION_SECONDS` 300 and `DEMO_MAX_TRAFFIC_START_DELAY_SECONDS` 30: harmless, and both admit every preset and the public limits;
  - `DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS` 600: required by the seed.
- Option for the owner: set all eight explicitly in `machine.json`, so the hosted caps are readable in one place. The minimal change sets only `DEMO_MAX_BUYERS`.

**Public policy (`PUBLIC_CUSTOM_*` in the `setup` container env, effective on a fresh core).**

- The one measured problem is constant arrival at the public maximum: 1,000/s with 1,000 VUs, which on the final hardware ended `degraded` once and `complete` once. Two answers:
  - **A (measured):** `PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND=500`, VU limits unchanged. Both 500/s runs were complete with a p95 around 1 s, and nothing else changes. Visitors lose the 1,000/s setting, which this core sustains only at the edge.
  - **B (needs an admin measurement):** keep 1,000/s and raise `PUBLIC_CUSTOM_MAX_PRE_ALLOCATED_VUS` and `PUBLIC_CUSTOM_MAX_VUS` to 3,000 (about 0.7 GB of k6 memory). Extra VUs absorb the start transient, but the latency still rises with the queue. It is proposed only if admin runs at 1,000/s with 3,000 VUs come out complete.
- The other public limits are unchanged:
  - 10,000 buyers and total requests (measured, and at or above the 5,000 seed default);
  - 120 s duration (at or above 80 s);
  - 10 s start delay;
  - stock up to 1,000;
  - ERP latency up to 2,000 ms, ERP rate 1 to 50/s, error rate up to 0.25.

  The estimator's 600 s ceiling already refuses combinations that would not drain in time, such as large stock at a low ERP rate. Each public preset's conservative estimate is 36 to 208 s, well under 600 s.
- The public run budget (`PUBLIC_RUN_BUDGET_*`) was not in scope.

### Owner decisions on the fourth checkpoint (2026-10-06)

- **Caps:** all eight `DEMO_MAX_*` written explicitly in the API env: `DEMO_MAX_BUYERS=10000`, the other seven at their code defaults. Admin caps stay generous on purpose: the owner may push admin runs to failure, and the core, not the VUs, is the limit.
- **Public policy goal:** a visitor's run always completes. Find the highest constant-arrival rate that stays `complete` with generous VUs, then propose the public limits.
- **Admin ladder authorized** (control token read inside the API container, never printed): 10 s runs with 5,000 pre-allocated and 10,000 max VUs, at 1,000, then 1,500, then 2,000 per second, stopping at the first run that is not `complete`; at most 4 runs.

### Admin ladder on the final hardware (2026-10-06, 10:20 to 10:28 UTC)

Core 6x / 12 GB, runner 8x / 16 GB, admin `custom` preset. The run was started from inside the API container (`admin-start.js`; the token never left the container). The public run report was readable for admin runs, so no admin report was read.

Sampling as before, plus the number of established connections on the API port. Core figures are over the busy window; CPU in cores, as peak / mean.

| Run | Rate | Result | Started | Dropped | p95 | `waiting` avg / p95 | `connecting` p95 | Open API connections (peak) | Core VM peak / mean | API | PostgreSQL | Worker | Runner CPU peak; k6 RSS |
| :-- | --: | :-- | --: | --: | --: | --: | --: | --: | :-- | :-- | :-- | :-- | :-- |
| L1 | 1,000/s | `completed`, `complete` | 10,000 | 0 | 3.83 s | 1.55 / 3.83 s | 5 ms | 5,005 | 85 / 47 % | 1.53 / 0.59 | 1.97 / 0.85 | 1.13 / 0.74 | 93 %; 1.30 GB |
| L2 | 1,500/s | `completed`, `complete` | 15,000 | 0 | 5.15 s | 1.35 / 5.15 s | 2 ms | 5,005 | 75 / 38 % | 1.55 / 0.49 | 1.32 / 0.62 | 1.04 / 0.62 | 92 %; 1.54 GB |
| L3 | 2,000/s | `completed`, `complete` | 20,000 | 0 | 8.30 s | 1.57 / 8.29 s | 2 ms | 5,005 | 81 / 44 % | 1.73 / 0.66 | 1.87 / 0.70 | 1.07 / 0.65 | 99 %; 1.54 GB |

- All three were complete, so the ladder stopped at 2,000/s after three runs; no confirmation run was needed.
- Arrivals held the scheduled rate every second.
- 0 transport failures, 500 orders confirmed in each run. PostgreSQL memory peaked at 440 to 551 MB.
- **The 5,000 pre-allocated VUs were enough at every rate:** the open connections peaked at 5,005 (one per VU), so k6 never needed the extra VUs up to 10,000. With enough VUs, a 10 s constant arrival queues on the core instead of dropping: the latency grows with the rate (p95 3.8, 5.2, 8.3 s), and the run stays complete.

**What a visitor really sends (found in the code).**

- The public custom form (`apps/web/src/app/components/public-demo-entry.tsx`) never sends `k6Vus`. A visitor's constant-arrival run uses the automatic derivation: pre-allocated = rate, max = 2 × rate (`resolveConstantArrivalVus`).
- The public VU limits (`PUBLIC_CUSTOM_MAX_PRE_ALLOCATED_VUS`, `PUBLIC_CUSTOM_MAX_VUS`) apply only to an explicit `k6Vus`, that is to callers of the API, not to the form.
- So the visitor case was measured as such, with public runs and no `k6Vus`:

| Run | Rate | VUs (derived) | Result | Dropped | p95 |
| :-- | --: | :-- | :-- | --: | --: |
| A1 | 1,000/s for 10 s | 1,000 / 2,000 | `completed`, delivery `warning` | 81 (0.8 %) | 2.33 s |
| A2 | 1,000/s for 10 s | 1,000 / 2,000 | `completed`, delivery `warning` | 85 (0.9 %) | 2.41 s |
| A3 | 500/s for 20 s | 500 / 1,000 | `completed`, `complete` | 0 | 0.53 s |
| A4 | 500/s for 20 s | 500 / 1,000 | `completed`, `complete` | 0 | 0.66 s |

At 1,000/s, the visitor's run loses about 1 % of its iterations in the first two seconds, while k6 grows its VUs beyond the 1,000 pre-allocated ones. At 500/s, it is complete: two runs here, plus two earlier at 500/s with 1,000 / 1,000 VUs.

### Public policy proposal (not applied; awaiting the owner's OK)

- **`PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND=500`** (from 1,000). It is the highest rate measured complete for the form's own VU derivation (4 of 4 runs), with a p95 under 1.2 s.
- **`PUBLIC_CUSTOM_MAX_PRE_ALLOCATED_VUS` and `PUBLIC_CUSTOM_MAX_VUS` stay at 1,000** (the defaults). They bind only API callers who set `k6Vus`. At 500/s, 1,000 covers the form's derivation (500 / 1,000), and 1,000 / 1,000 was measured complete. Larger values are not needed by the form.
- All other public limits unchanged (10,000 buyers and requests, 120 s, 10 s delay, stock 1,000, ERP limits). They admit every preset and the seed's fixed defaults.
- **Set in the `setup` container env of `infra/fly/core/machine.json`.** It takes effect on a fresh core only (go-live, task 13c). The running core keeps its seeded policy until it is recreated or edited in the admin UI.
- **Alternative needing code (a separate task, owner's call):** keep 1,000/s, or more, for visitors by pre-allocating more VUs in the automatic derivation, or by having the form send `k6Vus`. The ladder shows 5,000 pre-allocated VUs keep runs complete up to 2,000/s on this core (k6 1.3 to 1.5 GB).

### Caps applied and deployed (2026-10-06, 10:33 UTC)

- **`infra/fly/core/machine.json`, API env:**
  - `DEMO_MAX_BUYERS=10000`;
  - `DEMO_MAX_TOTAL_REQUESTS=100000`;
  - `DEMO_MAX_REQUESTS_PER_SECOND=10000`;
  - `DEMO_MAX_TRAFFIC_DURATION_SECONDS=300`;
  - `DEMO_MAX_TRAFFIC_START_DELAY_SECONDS=30`;
  - `DEMO_MAX_PRE_ALLOCATED_VUS=10000`;
  - `DEMO_MAX_VUS=10000`;
  - `DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS=600`.
- **Deploy.** `deploy.mjs all` on a sleeping core, after the ladder: "The core and the runner both run version 743f9bb…-dirty", exit 0.
- **Deployed configs read back:**
  - core 6x / 12 GB, with the eight caps and `RUNNER_CPUS=8` / `RUNNER_MEMORY_MB=16384` in the API env, and the API check carrying its 2 s deadline;
  - runner 8x / 16 GB;
  - `setup` env empty (no `PUBLIC_CUSTOM_*` yet).
- **One wake to check that the API accepts the persisted public policy under the new caps:** every container healthy, `/demo` 200. The stop took 11.4 s.

### Where the hosted setup breaks: admin bisection (2026-10-06, 10:43 to 10:48 UTC)

Owner-authorized, same method, at most 6 runs: constant arrival for 10 s at the VU caps (10,000 pre-allocated and maximum), core 6x / 12 GB, runner 8x / 16 GB. Bisection from 5,000/s until the gap between complete and not complete was 500/s or less.

| Run | Rate | Result | Started / planned | Dropped | p95 | `waiting` avg | Failures (HTTP, transport, unexpected, interrupted) | Open API connections | Core VM peak / mean | API / PostgreSQL / worker cores (peak / mean) | Runner CPU peak / mean; k6 RSS | Arrivals per second |
| :-- | --: | :-- | :-- | --: | --: | --: | :-- | --: | :-- | :-- | :-- | :-- |
| B1 | 5,000/s | `failed`, delivery `failed`, `virtual_user_limit` (10,000) | 35,560 / 50,000 | 14,441 | 14.43 s | 3.56 s | 0, 0, 0, 0 | 10,004 | 81 / 48 % | 1.49/0.78, 1.56/0.71, 1.25/0.67 | 100/37 %; 3.04 GB | 6,124, 4,506, 2,098, then about 3,200 |
| B2 | 3,500/s | `failed`, delivery `failed`, `virtual_user_limit` (10,000) | 32,048 / 35,000 | 2,952 | 14.30 s | 3.82 s | 0, 0, 0, 0 | 10,004 | 75 / 50 % | 1.54/0.81, 1.43/0.73, 1.06/0.68 | 100/37 %; 2.85 GB | 4,242, 3,501, 3,498, then down to about 2,700 to 3,200 |
| B3 | 2,750/s | `completed`, `complete` | 27,500 / 27,500 | 0 | 11.75 s | 3.51 s | 0, 0, 0, 0 | 10,005 | 78 / 44 % | 1.38/0.66, 1.39/0.67, 1.10/0.63 | 100/32 %; 2.81 GB | 2,750 steady |
| B4 | 3,125/s | `completed`, `complete` | 31,250 / 31,250 | 0 | 12.80 s | 3.49 s | 0, 0, 0, 0 | 10,003 | 77 / 40 % | 1.71/0.63, 1.34/0.61, 1.22/0.55 | 100/33 %; 2.86 GB | 3,125 steady |
| B5 | 3,125/s (confirmation) | `completed`, `complete` | 31,250 / 31,250 | 0 | 12.24 s | 3.24 s | 0, 0, 0, 0 | 10,004 | 77 / 46 % | 1.36/0.73, 1.39/0.67, 1.05/0.64 | 99/33 %; 2.85 GB | 3,125 steady |

- Every run confirmed its 500 orders. The stop after the bisection took 13.0 s, with the API exiting 0 and no zombie.
- **Breaking point.** Highest complete rate 3,125/s (twice); lowest not complete 3,500/s; gap 375/s.
- **What broke first: VU exhaustion, nothing else.**
  - No failed request, transport failure, timeout, unexpected response or interrupted request in any run.
  - The core VM never passed 81 %. `connecting` p95 stayed at 90 ms or less, so the 10,000 concurrent connections were accepted without connection errors.
  - Above about 3,200/s, all 10,000 VUs were busy (open connections 10,004). k6 could not start new iterations, and the arrival rate fell to what the core returned.
- **The binding limit is the core's throughput, expressed through the VU cap.**
  - With keep-alive connections, the single API process answers about 3,200 requests per second: at 5,000/s the achieved rate settled there, with 10,000 requests in flight and about 3 s of waiting (10,000 / 3.1 s).
  - Below that rate the queue stays bounded and the run completes, with a p95 of about 12 s from the start transient. Above it, the backlog grows by the difference every second, and the 10,000-VU cap turns that backlog into dropped iterations.
  - More VUs would only let a short run finish with a longer queue; the throughput would not change.
- **Comparison with a buyer spike.** The about 1,000 requests per second of a `surge-10k` comes from one new connection per buyer. A constant-arrival run reuses its connections, so the same core answers about three times more.
- **The runner is not the limit.** It reaches 100 % CPU only while k6 initializes the 10,000 VUs (mean 32 to 37 %), with k6 at 2.8 to 3.0 GB of its 16 GB.

**What it means for visitors.**

- A public run sends at most 10,000 requests, so any run at 1,000/s or more lasts 10 s or less.
- The core itself would complete a visitor run up to about 3,000/s with enough VUs.
- The public form, however, sends no `k6Vus`: k6 pre-allocates as many VUs as the rate per second and may grow to twice that. The start transient (the first 1 to 2 s, when the API's latency jumps) then drops about 1 % of iterations at 1,000/s (A1, A2), and none at 500/s (A3, A4).
- So the visitor's limit is the form's VU derivation, not the hardware:
  - **Without code change:** a public rate limit of 500/s keeps every measured visitor run complete.
  - **With a small code change (separate task):** derive more pre-allocated VUs for constant arrival (for example 10 per unit of rate, up to the VU cap), or let the form send `k6Vus`. That would make up to about 2,500/s (a 4 s run of 10,000 requests) safe on this hardware, on the evidence of B3 to B5.
- `PUBLIC_CUSTOM_*` is not written yet.

### Wrap-up (owner decisions of the sixth checkpoint, 2026-10-06)

**Public limits.** All twelve `PUBLIC_CUSTOM_*` are now in the `setup` container env of `infra/fly/core/machine.json`, with the variable names and defaults of `buildPublicRuntimePolicy` in `packages/db/src/scripts/seed.ts`:

- `PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND=500`;
- every other one at its seed default: total requests 10,000, buyers 10,000, duration 120 s, start delay 10 s, pre-allocated VUs 1,000, max VUs 1,000, stock 1,000, ERP latency 2,000 ms, ERP rate 1 to 50, error rate 0.25.

The setup image sets none of these as image `ENV`, so the container env applies. The public run budget (`PUBLIC_RUN_BUDGET_*`) is unchanged and left to the seed defaults.

**Verification without Fly** (a throwaway Vitest file in `apps/api/test/unit`, run once, then deleted; not committed):

- **Seed side:** the real compiled seed (`packages/db/dist/scripts/seed.js`, current with its source) ran with the setup env of `machine.json`, against a fake database that captured its inserts. Its own `publicRuntimePolicyPersistedSchema` parse passed.
- **API startup side:**
  - The caps were parsed by the API's real `loadApiConfig` from the API env of `machine.json`: occupancy 600, buyers 10,000, total requests 100,000, 10,000 per second, 300 s, 30 s, 10,000 pre-allocated and max VUs.
  - `resolveEffectivePublicRuntimePolicy(seeded policy, caps)`, the function the API's startup validation calls, accepted the policy, and `collectPublicRuntimePolicyViolations` returned no violation. The resolved public limits included 500 per second, with the fixed 600 s occupancy ceiling.
- **Presets:**
  - `collectAcceptedRunConfigSnapshotViolations`, the run-start validation, returned no violation for any of the ten seeded presets as they are started (public presets in public mode, `public-custom` with the public limits enforced, admin presets in admin mode).
  - It also returned none for every public preset with the public custom limits enforced as well.
- **Edge checks:**
  - a public custom constant-arrival run at 500 per second has no violation, and one at 501 per second gets `public_request_rate_exceeded`;
  - negative control: the same seed with `PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND=20000` is refused by the startup resolution with `public_limit_request_rate_exceeds_deployment_cap`.

**Deployed and read back** (`deploy.mjs all`, core asleep, exit 0, "The core and the runner both run version 743f9bb…-dirty"):

- the core is 6x / 12 GB, with the twelve `PUBLIC_CUSTOM_*` in its setup env (500 per second), and the eight caps plus `RUNNER_CPUS` and `RUNNER_MEMORY_MB` in its API env;
- the gate's copy of the core config (`/fly/core-machine.json`, used for recovery) carries the same guest, setup env and caps;
- the runner is 8x / 16 GB.

The running core keeps the policy it was seeded with (1,000 per second) until a fresh core is created (go-live) or an admin edits it.

**`docs/reference_runtime_measurements.md`:** new section "Hosted Fly.io observations" (environment, public presets, `surge-10k`, constant arrival). It has no task numbers and no backlog references.

**Proposed wording for `docs/decisions/scope_and_caveats.md`** (for the supervisor to apply). The sentence "The repository has no hosted benchmark workflow or published hosted result." becomes:

> The repository has no hosted benchmark workflow. A few runs on the Fly.io deployment are recorded as observations, not a benchmark, in [Reference Runtime Measurements](../reference_runtime_measurements.md#hosted-flyio-observations).

### Inputs for a later task: capacity-aware run admission

- **Break point.**
  - Over reused connections (constant arrival), the hosted core answers about 3,200 requests per second, bounded by the single API process. 10 s runs were complete at 3,125 per second (twice), and at 3,500 per second all 10,000 VUs were in flight and iterations were dropped.
  - New connections per request (buyer spike) are answered at about 1,000 per second.
  - VU exhaustion breaks first: no failed request, timeout or connection error at any rate tried, up to 5,000 per second.
- **Connection modes.**
  - A buyer spike opens one connection per buyer (`per-vu-iterations`, one VU per buyer).
  - Constant arrival reuses each VU's connection, so the open connections equal the VUs in flight (10,004 at the cap).
  - Admission would need to treat the two modes separately.
- **Default VU allocation.**
  - `resolveConstantArrivalVus` (`packages/contracts/src/load.ts`): pre-allocated = rate, max = 2 × rate, capped at 10,000 (`maximumAutomaticallyDerivedVUs`). It applies whenever `k6Vus` is absent, which is always the case from the public form (`apps/web/src/app/components/public-demo-entry.tsx`).
  - At 1,000 per second, the start latency transient (1 to 2 s) exhausts it: about 1 % dropped. 5,000 pre-allocated VUs kept runs complete up to 2,000 per second, and 10,000 up to 3,125.
  - Rule of thumb from the runs: the VUs needed equal the rate times the latency, and the latency climbs to about 3 s near saturation.
- **Generator memory.** About 225 kB per k6 VU; 2.8 to 3.0 GB at 10,000 VUs on the 16 GB runner.
- **Occupancy estimate over-conservatism** (conservative estimate over actual, one run each on the final hardware): `preview-1k` 2.06, `surge-5k` 3.48, `surge-10k` 4.05, `slow-erp-5k` 1.71, `laggy-erp-5k` 1.86, `idempotency-check-200` 1.85. The explanatory estimate is close for the ERP-bound presets (100 against 117 s, 113 against 112 s).
- **ERP settings do not hold VUs.** A VU is released when the API answers the buy request, at reservation time; ERP latency and rate only stretch the asynchronous drain (worker and queue), not the traffic phase. `slow-erp-5k` and `laggy-erp-5k` used the same VUs and connections as `surge-5k` and drained over about 105 s with the core mostly idle.
- **Latency figures for admission messaging.** 10 s runs at 1,000, 1,500 and 2,000 per second with enough VUs: p95 3.8, 5.2 and 8.3 s. At 2,750 and 3,125 per second: 11.8 to 12.8 s.

### Refused or left open

- Reading an admin run report from inside the API container (with the container's control token, never printed) was refused (Production Reads). It was not needed: the runner was sampled directly.
- Reading the captured core logs was refused at first, then authorized by the owner for the slow stop (2026-10-06). They were read filtered by time window, with secret-looking values masked.
- Admin runs were refused to this agent at first. The owner then authorized the constant-arrival ladder and bisection (8 admin runs, 2026-10-06), started from inside the API container with its own token. Their public reports were readable, so no admin report was read. 20,000 buyers in a buyer spike remain unmeasured.
- The task 12 variant of the slow stop (a run start in flight on a core with no burst yet) is not separately reproduced.
- Diagnostic only, reverted: `NODE_DEBUG=net,http` was set on the API container for one `preview-1k` and a stop (08:10 to 08:12), then removed.
- **For the supervisor to apply:**
  - the four decision entry drafts (numbering and insertion into `docs/decisions/hosted_deployment.md`);
  - the `scope_and_caveats.md` wording.
- **Not filled in:** the hosted figures for `docs/estimator_calibration.md` (its empty rows) are noted above, as asked, and the doc is not edited.
- **Running core:** it still holds its seeded public policy (1,000 per second). The 500 per second limit applies from the fresh core at go-live (13c).
- **Later task:** raising the visitors' rate needs the default VU allocation changed (inputs above).
- **Not reviewed:** the public run budget (`PUBLIC_RUN_BUDGET_*`).

### Cloud verification and review (2026-10-06)

- **Cloud test (no Fly):** JSON and env names, Node healthchecks (exit on their own in about 2 s against a silent server), fresh-core seed plus API startup validation with the deployed caps (500/s accepted, values above a cap refused), all ten presets admitted, `pnpm test:unit` green. Doc gaps found and fixed: the 5,000-VU claim in HD-53, two figures missing from the measurements section, a pre-existing broken backlog link in `docs/reference_runtime_measurements.md`.
- **Adversarial review:** no configuration defect; HD-51 overstated that only a multi-process API changes throughput (fixed: limited to what was observed).
- **Arbitration:** all of the above confirmed, plus small figure scopings (CPU ranges, k6 memory per mode, cost wording) and the buyer-cap reason added to HD-51.
- **Decision-log audit (owner request):** the log had drifted into how-it-works, runbook, measurement and work-log content. The README now states the purpose, what does not belong there and where it goes, and allows in-place editorial trims; `AGENTS.md` and this backlog's README point to its inclusion test. HD-51 to HD-54 follow the new rules. Trimming HD-01 to HD-50 is a separate cleanup commit; HD-33 is withdrawn after the 13c rotation.
- `MOCK_ERP_BASE_URL` in the API container (unused, pre-existing) goes to that cleanup commit.
