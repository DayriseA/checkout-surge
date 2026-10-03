# 02 — Runner on Fly

**Design:** sections 3.7, 4.5, 7.1, 10 · **Depends on:** 01

## Goal

The runner runs on its own Fly Machine, started by hand, and a real `surge-10k` run completes across the two Machines. This task closes the feasibility test.

## Scope

- **Fly app and Machine config** for the runner: no volume, performance 4 vCPU / 8 GB, restart policy `no`, `role=runner` metadata, no public address, no autostart.
- **Fly variant of the load-orchestrator image:** a `runtime-fly` target on top of `runtime`. Its root entrypoint raises `nofile`, sets `ip_local_port_range` and `tcp_tw_reuse`, then drops to `node`.
- **Networking:**
  - the load-orchestrator listens on IPv6;
  - the API derives the `apiBaseUrl` it gives the runner from its own 6PN address.
- **Manual wiring for now:** the API reaches the runner through a configured address, and the runner's `API_BASE_URL` is set by hand.
- **Runner secret** stored as a Fly secret.
- **Deploy script** extended to the runner image and Machine.
- **Feasibility checks:**
  - limits of the k6 process;
  - `ip_local_port_range` and `tcp_tw_reuse` take effect;
  - time from runner `start` to load-orchestrator ready;
  - the 10k IPv6 connection burst;
  - manual recreation of the runner.

## Out of Scope

- Runner start and stop driven by the API, boot IDs, loss detection and capacity handling.

## Done When

- A `surge-10k` run completes with a manually started runner.
- Its results are compared with `docs/reference_runtime_measurements.md` and recorded in the working notes.
- The feasibility verdict is written into `design.md`: the topology is confirmed, or the points to revisit are listed.

## Open Points

- None.

## Working Notes

Work done on 2026-10-03, flyctl v0.4.111, org `personal`, region `cdg`, on top of task 01. Nothing is committed yet.

### Fly resources

- App `checkout-surge-runner`: no public IP, no service, no volume.
- Runner Machine `853de7f4462758` (performance-4x, 8 GB, `role=runner` metadata, restart policy `no`), **stopped**. It is the recreated runner (check 5); the first runner `859942f41d7708` is destroyed.
- Secret `CONTROL_SERVICE_TOKEN`, staged (`fly secrets import --stage`) straight from the core's gitignored `infra/fly/core/core-secrets.env`. There is no separate local runner secrets file.
- Registry `registry.fly.io/checkout-surge-runner`: `load-orchestrator-<commit-sha>[-dirty]`.
- Core Machine `8d14e3aee13038` updated with the new API image and `LOAD_ORCHESTRATOR_BASE_URL`, **stopped**.

### What was built

- `runtime-fly` target in `apps/load-orchestrator/Dockerfile`, with `infra/fly/runner/load-orchestrator-entrypoint.sh`: raises `nofile` to 1,048,576 (soft and hard), writes `net.ipv4.ip_local_port_range` = `10240 65535` and `net.ipv4.tcp_tw_reuse` = `1`, reads both back and fails the start if refused, sets `HOME=/home/node`, then `setpriv` to `node`.
- `infra/fly/runner/machine.json`: a single-image Machine (no `containers`), `HOST=::`, port 4200, the Compose values of the load-orchestrator variables, and `API_BASE_URL` (see manual wiring).
- `infra/fly/runner/build.toml`: the minimal config `--build-only` needs, as for the core.
- `infra/fly/deploy.mjs <core|runner>`: task 01's `infra/fly/core/deploy.mjs`, moved and generalized instead of duplicated. Each target declares its app, images and optional volume; the config is read from `infra/fly/<target>/machine.json`; the Machine is found by `role` metadata. Image placeholders are replaced at the top level (runner) or per container (core). Core behavior is unchanged. Both the create and update paths ran for the runner; the core update path ran once.
- API: `apiBaseUrl` (the URL given to k6) falls back to `http://[$FLY_PRIVATE_IP]:$PORT` when `API_BASE_URL` is unset and `FLY_PRIVATE_IP` is set; otherwise unchanged (`apps/api/src/runtime/config.ts`, unit test in `runtime-config.test.ts`). `FLY_PRIVATE_IP` is present in the multi-container core's API container (checked with `machine exec`).
- Core `machine.json`: the API gets `LOAD_ORCHESTRATOR_BASE_URL`.

### Minor choices

- **Manual wiring through `.internal` names.** The API reaches the runner at `http://checkout-surge-runner.internal:4200`, and the runner's `API_BASE_URL` is `http://checkout-surge-core.internal:4000`. Both names resolve to the started Machines of each app over 6PN, so they survive a recreation with no edit. Task 05 replaces the runner's value with the core's 6PN address set before each start (design 4.1).
- **Runner image in the runner app's registry.** It needs its own `build.toml`, but no cross-app pull question arises.
- **Single-image runner Machine.** Fly injects all app secrets into a Machine without `containers` (the token was present in the Node process environment), so no per-container secrets list is needed.
- **Runs were triggered through the API** (`POST /demo/runs/start`, admin operator mode with the control token) over `fly proxy 4000:4000` to the core, and read back from `/admin/demo/runs/history/:runId`. The demo UI was not used.

### Feasibility checks

1. **Limits of the k6 process: pass.** `/proc/<k6 pid>/limits` during the burst (both runs): open files 1,048,576 soft and hard, max processes 31,637. The Node process has the same `nofile`. The persisted `ulimitNofile` is 1,048,576.
2. **`ip_local_port_range` and `tcp_tw_reuse`: pass.** Read on the runner and persisted in the run's `networkDiagnostics`: `10240 65535`, `tcp_tw_reuse` 1, `tcp_timestamps` 1. The runner's `somaxconn` is Fly's 4,096 (not needed on the generator). The load-orchestrator listens on `[::]:4200`, and the API reaches it over 6PN.
3. **Time from runner `start` to load-orchestrator ready** (three boots, `/health/ready` polled from inside the runner):
   - `fly machine start` returns in 2.3 to 2.6 s; Fly logs "Machine started in" 1.45 to 1.56 s;
   - Node listening 2.9 to 3.3 s after the start request;
   - ready 3.4 s, 6.8 s and 7.4 s after the start request. The slow boots lost 2 s on the first readiness probe: the runner's first request to the API timed out at its 2 s limit, and the next one answered in 56 ms. The cause (first 6PN connection or `.internal` resolution from a fresh VM) was not isolated.
4. **10k IPv6 burst across Machines: pass** (table below). The runner and the core ran on different hosts (different 6PN host prefixes).
5. **Manual recreation of the runner: pass.** Create a Machine from the old Machine's config (`skip_launch`): the request returned in 2.2 s and the Machine was `stopped` 6.7 s after it. Start to ready: 6.8 s. A `surge-10k` run on it completed (run 3). The old runner was then destroyed (`force`, 2.1 s).

### `surge-10k` results

Run 1 (`d267fafe…`) failed before any request: k6 exited on `stat /root/.config/k6/config.json: permission denied`, because `setpriv` keeps root's `HOME`. Fixed by setting `HOME` in the entrypoint. Runs 2 and 3 used the fixed image.

| | Run 2 (`c014011f…`, first runner) | Run 3 (`c1ee9aab…`, recreated runner) |
| :-- | --: | --: |
| Status | completed | completed |
| Planned / started / completed requests | 10,000 / 10,000 / 10,000 | 10,000 / 10,000 / 10,000 |
| Accepted / sold out | 500 / 9,500 | 500 / 9,500 |
| Transport failures / unexpected / dropped iterations | 0 / 0 / 0 | 0 / 0 / 0 |
| Confirmed / notified / failed orders | 500 / 500 / 0 | 500 / 500 / 0 |
| Peak arrival rate, dispatch duration | 4,431/s, 2.11 s | 6,295/s, 1.56 s |
| Request duration p95 | 7.25 s | 7.97 s |
| `waiting` avg / p95 | 4.59 s / 7.24 s | 5.02 s / 7.96 s |
| `blocked` avg / p95 | 291 ms / 570 ms | 298 ms / 430 ms |
| `connecting` avg / p95 | 288 ms / 555 ms | 296 ms / 422 ms |
| Server `reserveOrderService` avg | 140 ms | 159 ms |
| Stock depleted after | 0.76 s | 0.62 s |
| Backlog drain (ERP at 20 TPS) | 29.0 s | 28.8 s |
| Overall run duration | 34.6 s | 34.1 s |
| Peak k6 RSS, min MemAvailable | 2.28 GB, 5.6 GB of 7.9 GB | 2.31 GB, 5.6 GB |
| TIME_WAIT 2 s after k6 exit | 10,002 | 9,192 |

- **Runner resources** (sampled every 0.5 s on the runner): CPU at 96 to 99 % of the 4 vCPUs for about 2.2 s while k6 initializes its 10,000 VUs, 75 to 97 % during the dispatch, then 10 to 30 % while waiting for responses. Steal at most 3 %. Established connections peak at 10,003 and stay open until k6 exits; SYN_SENT peaked at 188.
- **Comparison with `docs/reference_runtime_measurements.md`.** Same transport behavior as the local reference: every request planned, started and completed, zero transport failures, zero unexpected responses, all accepted orders confirmed and notified. The preset changed since the reference (500 units instead of 1,000), hence 500 / 9,500. TIME_WAIT after a first run: 10,016 locally, 10,002 and 9,192 here. The reference records no latency or arrival-rate figures for `surge-10k`, so the 7 to 8 s p95 cannot be compared; `blocked` and `connecting` stay sub-second, so there is no multi-second connection-establishment signal, and the time is spent in `waiting` (the server-side queue of one API process). Core-side resource use during the burst was not measured.

### Other findings

- **`processMaxOpenFiles` is wrong on Fly.** The load-orchestrator reads `/proc/1/limits` (`load-run-diagnostics.ts`). In Compose PID 1 is Node; on a Fly Machine it is Fly's init, so every hosted run persists 10,240 soft and hard while k6 really has 1,048,576. Not changed here (the doc `k6_high_load_tuning.md` describes `/proc/1/limits`); a one-line switch to `/proc/self/limits` would fix it.
- **Generator CPU utilisation is unavailable on Fly.** The Machine has no cgroup CPU quota file at the probed paths, so `cgroupCpuQuota` and `cgroupCpuQuotaUnlimited` are null and the persisted peak and mean CPU are null. Each hosted run therefore counts 12 generator warnings (11 unavailable probes plus `k6_outcome_counter_summary_export_unavailable`) even when it is clean.
- **First push to a new registry repository.** The first runner deploy pushed successfully, then the Machine create failed with `MANIFEST_UNKNOWN` for the tag just pushed. Re-running the script (cached build) succeeded. It did not recur on later deploys. The script has no retry.
- **The runner is CPU-bound during VU initialization and dispatch** at 4 vCPUs. Results were clean, but the arrival rate (4.4k to 6.3k/s) is likely limited by the generator. A sizing question for task 13.
- `pnpm type-check` fails in `mock-erp` on this workstation: its `node_modules` has no `@checkout-surge/db` link (stale install, unrelated to this task). `api` and `load-orchestrator` type-check, and the API config unit tests pass.

### Not verified

- Local Compose build of the load-orchestrator after the Dockerfile change (no local Docker builds on this workstation). The `runtime` target is unchanged and `runtime-image-contract.test.mjs` passes (6/6).
- A run launched from the demo UI (runs were launched through the API).
- Core resource usage during the burst.

### Proposed design updates

- **10 Feasibility verdict: the topology is confirmed.** A manually started runner on its own performance-4x Machine ran `surge-10k` across hosts over 6PN IPv6 with zero transport failures, twice, including on a recreated runner. Points to revisit, none blocking: the generator is CPU-bound during VU initialization and dispatch (1.1, task 13), and two hosted evidence gaps (wrong `processMaxOpenFiles`, unavailable CPU utilisation).
- **4.5** The entrypoint also sets `HOME=/home/node`: `setpriv` keeps root's `HOME`, and k6 refuses to start when it cannot stat `$HOME/.config/k6`. Measured: k6 `nofile` 1,048,576 soft and hard; the sysctls take effect.
- **4.1** Runner timing: `start` to load-orchestrator ready 3.4 to 7.4 s (Node listens after about 3 s; the first API readiness probe from a fresh runner sometimes times out at 2 s). A `surge-10k` run leaves about 10,000 sockets in TIME_WAIT, so the fresh boot per run matters. Recreating from the old config takes about 7 s to `stopped`.
- **3.7** The API derives `apiBaseUrl` from `FLY_PRIVATE_IP`, which Fly sets in each container of a multi-container Machine; an explicit `API_BASE_URL` still wins.
- **7.1** The runner is a single-image Machine and gets all app secrets without a per-container list.
- **8** The deploy script is `infra/fly/deploy.mjs <core|runner>`. The runner image lives in the runner app's registry. A Machine create right after the first push to a new repository can fail with `MANIFEST_UNKNOWN`; re-running succeeds.

### Follow-up: hosted generator diagnostics

The owner asked to fix the wrong `processMaxOpenFiles` and the missing CPU utilisation inside this task.

- **`processMaxOpenFiles`** now comes from `/proc/self/limits`, the load-orchestrator's own limits. The field means the k6 process's limits (the UI labels it "k6 process open-files soft/hard limit"). Diagnostics are collected before k6 is spawned, and k6 inherits the limits of the Node process that spawns it, so this matches the field in Compose (where Node is PID 1) and on Fly (where PID 1 is Fly's init). `docs/k6_high_load_tuning.md` named `/proc/1/limits` in two places; both now describe the spawning process's limits.
- **CPU utilisation.** The cause differed from the assumption. Fly Machines use cgroup v1 with the CPU controller mounted only as `/sys/fs/cgroup/cpu,cpuacct` (no `cpu` alias), and no cgroup v2 `cpu.stat` at `/sys/fs/cgroup`. The root cgroup reports `cpu.cfs_quota_us` = -1. Two problems followed: the quota probe found nothing (so the capacity was unknown), and the sampler had no usage source.
  - Fix: the quota probe falls back to `cpu,cpuacct/cpu.cfs_quota_us` and `cpu.cfs_period_us`. On Fly that is an explicitly unlimited quota, so the existing rule normalizes against `nproc`. The rule "use `nproc` only when the probe explicitly reports an unlimited quota" (`docs/reference_runtime_measurements.md`) stays true. No "absent means unlimited" rule was added.
  - The sampler falls back to `cpu,cpuacct/cpuacct.usage` (nanoseconds) when `cpu.stat` is absent.
  - Behavior with a quota or with cgroup v2 is unchanged.
- **Tests.** There are unit tests for the combined-mount unlimited quota, for the `/proc/self/limits` source and for the v1 usage fallback. The "quota present" cases are the existing v2 and v1 tests, unchanged and passing. The sampler tests' read counts went from 6 to 7 per sample. The 22 unit tests that fail in `load-orchestrator` on this Windows workstation fail identically without these changes (process spawning).
- **Hosted check** with one `preview-1k` run (`8823165f…`) on runner `853de7f4462758`:
  - completed: 1,000 requests, 500 accepted, 500 sold out, 0 transport failures;
  - `processMaxOpenFiles` 1,048,576 / 1,048,576;
  - `cgroupCpuQuotaUnlimited` true;
  - CPU peak 37.8 % and mean 20.1 %.
  - Generator warnings dropped from 12 to 9. The remaining 9 are not CPU-related:
    - 5 cgroup v2 memory probes with no file on Fly's v1 layout: `memory.current`, `memory.swap.current` and the three `memory.events` counters;
    - 3 null `terminalMetricSources` (transport failures, unexpected responses, dropped iterations);
    - the `k6_outcome_counter_summary_export_unavailable` warning.

    The last 4 look tied to zero-valued k6 counters rather than to Fly, but that was not checked against a local run.
- **Memory probes (second follow-up).** The runner's cgroup v1 memory controller is mounted at `/sys/fs/cgroup/memory`. At the root it reads: `memory.limit_in_bytes` 9223372036854771712 (unlimited), `memory.usage_in_bytes` about 160 MB at idle (page cache included, like v2 `memory.current`), `memory.stat` with a `swap` line (0), `memory.failcnt` 0, and `memory.oom_control` with `oom_kill 0`. The sampler now falls back to them only when the v2 file is absent:
  - peak cgroup memory: from `memory.usage_in_bytes`;
  - peak swap: from the `swap` line of `memory.stat`;
  - the `max` event count: from `memory.failcnt` (charges refused at the memory limit, the v1 counterpart of the v2 `max` event);
  - the OOM-kill count: from the `oom_kill` line of `memory.oom_control`.
  - The `high` event count stays unavailable. cgroup v1 has no `memory.high` throttling boundary, so no v1 counter means the same thing.

  A unit test covers the v1 layout; the sampler tests pass (7/7) and type-check and Biome are clean. Hosted `preview-1k` run `523a1b3e…`:
  - completed: 1,000 requests, 0 transport failures;
  - peak cgroup memory 429 MB, swap 0, `max` 0, OOM kills 0, CPU peak 37.3 % and mean 19.6 %.
  - Generator warnings: 5. They are the `high` counter plus the 4 k6-related ones left for the owner's decision: 3 null `terminalMetricSources` and `k6_outcome_counter_summary_export_unavailable`.

### Cloud verification (2026-10-03)

Two cloud agents checked throwaway snapshots of this branch on Linux:

- `load-orchestrator` unit tests 166/166 and `api` unit tests 260/260 pass; `pnpm type-check` is clean. The 22 failures seen on the Windows workstation come from that environment.
- `docker compose build load-orchestrator api` builds the `runtime` target, not `runtime-fly`. `runtime:up`, `runtime:setup` and `runtime:smoke` pass with sysctls accepted; `runtime-image-contract.test.mjs` passes 6/6.
- On a clean local run, the k6 counters are also reported unavailable with `k6_outcome_counter_summary_export_unavailable`, so that defect predates the hosted work. It moves to task 14, together with the memory `high` counter that Fly does not provide.
