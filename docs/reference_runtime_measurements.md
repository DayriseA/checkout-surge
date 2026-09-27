# Reference Runtime Measurements


These measurements used the pre-2026-09-23 preset configurations (surge stocks 250 / 750 / 1,000 and ERP 200–250 TPS).
This document records the measurements taken from Checkout-Surge's reference runtime — generator-side network/resource limits and the adaptive-ERP acceptance observations — and the configuration decisions those measurements justify. It is a record of one environment, not guidance.

For the reusable, host-neutral version of this material — which limits matter, why, and how to verify them on any host — see [High-Load Tuning Notes](k6_high_load_tuning.md). Server-side connection capacity is owned by [Scope and Caveats](scope_and_caveats.md#connection-establishment-ceiling).

Every figure below is indicative for this environment only. Prefer changes that are neutral-to-positive on any host, and record the deployed host's effective characteristics with each run instead of assuming they match these values.

## Reference measurement environment

Measurements came from a development container on a developer's personal WSL2 machine, with Docker running inside the development container:

```text
nproc                    6
MemTotal                 7 GB (~5 GB available with the stack up)
ip_local_port_range      32768 60999   (28,232 ports)
tcp_tw_reuse             2             (loopback only)
tcp_timestamps           1
net.core.somaxconn       4096          (before the API alignment)
container nofile         1024 soft / 1048576 hard
```

The API container's `net.core.somaxconn` once capped its requested `backlog: 8192` at 4096. Following every generator-side recommendation would not have prevented that cap; it is a system-under-test boundary, recorded in [Scope and Caveats](scope_and_caveats.md#connection-establishment-ceiling).

## File-descriptor limit

The reference runtime's k6 file-descriptor limit is satisfied implicitly, not through project configuration. Containers start with a soft `nofile` limit of 1024 and a hard limit of 1048576. Node raises its own soft limit to that hard limit during startup, and k6 inherits 1048576 because the load orchestrator spawns it as a child of that Node process.

The behavior was verified against the container bases used by the project:

```bash
$ docker run --rm --entrypoint sh alpine:3 -c 'ulimit -n; ulimit -Hn'
1024
1048576

$ docker run --rm --entrypoint sh node:22-bookworm-slim -c \
    'node -e "console.log(require(\"fs\").readFileSync(\"/proc/self/limits\",\"utf8\").split(\"\n\").find(l=>l.startsWith(\"Max open files\")))"'
Max open files            1048576              1048576              files

$ docker run --rm --entrypoint sh node:22-bookworm-slim -c \
    'node -e "require(\"child_process\").execFile(\"sh\",[\"-lc\",\"ulimit -n\"],(e,o)=>console.log(o.trim()))"'
1048576
```

Adding `ulimits.nofile` to the Compose service at any value below 1048576 would therefore be a no-op, and is intentionally omitted. The persisted `ulimitNofile` diagnostic is representative of k6 for the same reason: `collectLoadRunDiagnostics` runs `sh -lc 'ulimit -n'` as another child of the same Node process, so it observes the limit k6 inherits.

This depends on implicit Node runtime behavior. Recheck or configure the limit explicitly if the orchestrator stops spawning k6 from Node, its base runtime changes, or an init/runtime lowers the limit.

## Reference runtime network namespace

The reference Compose runtime sets only the load-orchestrator network namespace's `net.ipv4.ip_local_port_range` and `net.ipv4.tcp_tw_reuse`, parameterized by `LOAD_ORCHESTRATOR_PORT_RANGE` and `LOAD_ORCHESTRATOR_TCP_TW_REUSE` with defaults `10240 65535` (55,296 ports) and `1`. The lower range bound remains above the service's port 4200 listener. Host-native runs and every other Compose service retain their platform values.

On the six-core reference Docker host on 2026-07-28, matched tightly back-to-back `surge-10k` pairs produced the following immediate post-run evidence:

| Pair | Persisted network diagnostics | First run TIME_WAIT | Second run TIME_WAIT | Second-run range use and headroom |
| --- | --- | ---: | ---: | --- |
| Platform defaults | `32768 60999`; reuse `2`; timestamps `1` | 9,958 (`2b6f2fff-d3b0-4207-a8c9-38fbe5106491`) | 19,960 (`e5a3e3a7-cee5-4ddf-a18e-00ecc5b39af4`) | 70.7% of 28,232; 8,272 ports |
| Compose defaults | `10240 65535`; reuse `1`; timestamps `1` | 10,016 (`cfbb106e-89aa-4898-ab99-b3e87da01dbc`) | 16,454 (`7e81980c-f53e-4af3-8646-ac597a426760`) | 29.8% of 55,296; 38,842 ports |

The second k6 process began 0.29 seconds after the first baseline measurement and 0.32 seconds after the first configured measurement. Every run planned, started, and completed all 10,000 requests with 1,000 accepted, 9,000 sold out, zero transport failures, zero unexpected responses, and all 1,000 accepted orders confirmed and notified. The configured pair therefore preserved business and transport behavior while the widened range increased measured post-pair headroom from 8,272 to 38,842 ports. The lower configured TIME_WAIT count is observational and does not by itself isolate how many sockets `tcp_tw_reuse=1` reused.

Container sysctls can prevent startup under rootless Docker, Kubernetes safe-list policy, or managed platforms that disallow them. Kubernetes does not generally safe-list `tcp_tw_reuse`, so it may require cluster-level unsafe-sysctl permission even when the port range is allowed. Changing either environment value cannot avoid startup failure because the keys themselves are rejected. Use the verified escape hatch:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-sysctls.yml up -d
```

Both the API and load-orchestrator `sysctls` blocks resolve absent under that override with Docker Compose v2.40.3. The override requires Compose's `!reset` tag; a plain empty sequence merges rather than clearing. If another Compose implementation does not support the tag, deploy from a copy of `docker-compose.yml` with the blocks removed.

This generator-side headroom changes no duration, delay, or connection-establishment window and does not alter the API namespace or its accept-queue ceiling. Multi-second k6 `blocked` and `connecting` signals remain evidence of real server-side capacity limits rather than values to tune away.

## Adaptive ERP acceptance observations

These are local observations of the dispatch, protection and settlement behaviour described in [Architecture](architecture.md#4-downstream-slowness-and-tps-exhaustion). They are a reproducible demonstration on one host, not a hosted benchmark, a statistical confidence claim, or a throughput guarantee. Every number below is a single observation per scenario unless stated otherwise.

**Environment.** Dev container on Linux/WSL2 (`6.18.33.2-microsoft-standard-WSL2`, x86_64), 16 logical CPUs, 9,369,710,592 bytes RAM (8.73 GiB), 4 GiB swap; no explicit CPU or memory limit on any runtime container. Node `v24.18.0`, pnpm `10.33.2`, Docker `29.6.1-1`, Compose `v2.40.3`. One worker container with `ORDER_PROCESS_CONCURRENCY=10`. Dispatch engine `declared-capacity-erp-dispatch` v2, all four `ESTIMATOR_*` variables at their defaults. Measured on 2026-09-22 against the `feat/adaptive-erp-and-admission` branch.

**Fixture and command.** The runtime was rebuilt clean (`pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`), then each scenario was run once, sequentially, with a fresh run identity:

```bash
pnpm runtime:acceptance <scenario> <output-dir>
```

Each run exits non-zero unless the harness's own accounting assertions pass, so the totals below are assertions rather than post-hoc readings. The generated JSON reports are deliberately not committed; they live under a git-ignored `.cache/` directory, with their correlation IDs and SHA-256 hashes recorded in the [verification handoff](../working_docs/backlog/adaptive_erp/20_verify_policy_against_code_bound_targets.md) that produced them.

| Scenario | Planned attempts | Reservations = canonical ledger effects = confirmed orders = notifications | Sold out | Duplicate HTTP replays | Accepted-to-settlement (s) | Admission estimate (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `original-incident` | 1500 | 888 | 612 | 0 | 95.816 | 168.474 |
| `finite-outage` | 200 | 200 | 0 | 0 | 81.304 | 70.2 |
| `original-incident-restart` | 1500 | 888 | 612 | 0 | 134.104 | 168.474 |
| `preview-1k` | 1000 | 250 | 750 | 0 | 12.478 | 55.5 |
| `surge-5k` | 5000 | 750 | 4250 | 0 | 21.088 | 118.4375 |
| `surge-10k-preset-reference` | 10000 | 1000 | 9000 | 0 | 29.261 | 163 |
| `idempotency-check-200` | 400 | 200 | 0 | 200 | 5.440 | 33.2 |
| `public-custom` | 500 | 100 | 400 | 0 | 6.482 | 29.6 |

On every run, planned attempts equal started and completed attempts, and failed orders, outstanding orders, unresolved ERP calls, interrupted requests, dropped iterations, transport failures and unexpected responses were all zero. No duplicate external effect or duplicate notification was observed.

**Pacing and downstream pressure.** On `original-incident` (declared 10 TPS, 250 ms ERP latency, concurrency 5) the 60-second stable window starting 10 seconds after the first confirmation POST recorded 563 confirmations, that is 9.383 confirmations per second, and 0 capacity (`429`) responses out of 562 capacity-consuming POSTs. Three repetitions of the same fixture on the same host recorded 9.367 / 9.383 / 9.367 confirmations per second with 0% capacity responses each time.

**Outage behaviour.** On `finite-outage`, the Mock ERP service was really stopped and restarted. After the availability circuit opened, zero failed probe completions were observed in the interval before the service returned, which satisfies the "at most one probe per scope per five seconds" bound; a successful lookup then adopted the canonical result. Zero observed probes bounds the probe rate from above but does not measure the spacing between positive probes.

**Restart behaviour.** On `original-incident-restart`, the worker container was killed mid-run with three externally accepted but locally unresolved ERP calls frozen. After restart the run still settled at exactly 888 reservations, 888 canonical ledger effects, 888 confirmations and 888 notifications, with zero outstanding orders and zero unresolved calls, and the configured queue rate/concurrency limits were restored.

**Estimate error.** The admission estimate is intentionally pessimistic and is compared with the actual duration only after the fact; it is never a prediction. Across the eight runs above the reports' `estimateError.estimateToActualRatio` ranged from 0.863 to 6.103, or from 1.256 to 6.103 excluding `finite-outage`. `finite-outage` is the one run whose actual duration (81.304 s) exceeded its estimate (70.2 s), because a finite injected outage is not modelled by the estimator. The separate calibration repetitions (three per fixture, different runs) recorded ratios from 1.701 to 6.247. An overrun terminates nothing and fails no order; a run that settles normally releases its occupancy slot through ordinary finalization, and the automatic reset 900 seconds after acceptance is the elapsed-time fallback for a run that is still nonterminal. Re-measuring the four `ESTIMATOR_*` allowances on another host is covered by the [estimator calibration procedure](estimator_calibration.md).

## Tuning deliberately not configured

TCP Fast Open is not configured: k6's Go client does not provide the required client-side support, and `buyer-spike` deliberately gives each VU one request, so it has no repeated connection to accelerate.

Caddy is the dashboard ingress only. k6 posts directly to `http://api:4000/buy`, so proxy header-buffer tuning is not part of the surge load path.

## Persisted per-run diagnostics

Terminal public and administrator reports expose a shared, public-safe failure diagnostic derived from saved evidence. A major delivery shortfall with a retained k6 `Insufficient VUs` warning matching the recorded constant-arrival-rate maximum is explained as a virtual-user limit. Other traffic failures explicitly retain an unidentified cause; warnings alone never change the run verdict. Watch reads the displayed terminal run's saved report with bounded retries and uses the same explanation. Raw stderr remains administrator-only, available next to the explanation and in Generator diagnostics. The result separates unsent attempts, interrupted attempts, transport failures, and settled business outcomes; unrelated evidence gaps and contradictions remain visible.

Each real run persists a pre-flight `generatorCapacity` snapshot from the load-orchestrator namespace: host-visible `MemTotal`, `MemAvailable`, and `SwapTotal` in bytes, plus the cgroup memory limit and effective CPU quota in cores. The existing `nproc` value remains the host-visible CPU count; compare it with the cgroup quota when the container is CPU-limited. Nullable companion `cgroupMemoryLimitUnlimited` and `cgroupCpuQuotaUnlimited` fields distinguish an unlimited cgroup setting from an unavailable probe.

While k6 is running, the load orchestrator samples generator resource use once per second and reduces it to the nullable `generatorUtilisation` block. It records peak k6 RSS, peak cgroup `memory.current`, minimum host-visible `MemAvailable`, peak cgroup swap, final `memory.events` `high`/`max`/`oom_kill` counters, and peak/mean CPU utilisation percentages. CPU is normalized against a finite cgroup quota when present, or against `nproc` only when the cgroup probe explicitly reports an unlimited quota; CPU percentages remain unavailable when quota probing is unavailable. `sampleCount` and the observed-average `effectiveIntervalMs` describe the observation density, with the configured interval retained for a single usable sample. The report stores no time series or derived warning, and `null` means no usable sample was captured; sampled zero-valued swap or pressure counters remain distinct.

Per-run `networkDiagnostics` persist the effective `ipLocalPortRange`, `tcpTwReuse`, and `tcpTimestamps` values with the traffic completion record.

The same `generatorCapacity` block is the host record that the [estimator calibration procedure](estimator_calibration.md) asks for when re-measuring the estimator allowances on a new host.

Authenticated operators can read these values in the **Generator diagnostics** panel on a run's `/run-history/[runId]` detail page. Public run detail does not expose the diagnostic block. When validating a new host, compare sampled utilisation independently with `docker stats load-orchestrator`; the run record intentionally stores a bounded summary rather than a time series.
