# Reference Runtime Measurements

This document records the generator-side measurements taken from Checkout-Surge's reference runtime, and the configuration decisions those measurements justify. It is a record of one environment, not guidance.

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

## Tuning deliberately not configured

TCP Fast Open is not configured: k6's Go client does not provide the required client-side support, and `buyer-spike` deliberately gives each VU one request, so it has no repeated connection to accelerate.

Caddy is the dashboard ingress only. k6 posts directly to `http://api:4000/buy`, so proxy header-buffer tuning is not part of the surge load path.

## Persisted per-run diagnostics

Each real run persists a pre-flight `generatorCapacity` snapshot from the load-orchestrator namespace: host-visible `MemTotal`, `MemAvailable`, and `SwapTotal` in bytes, plus the cgroup memory limit and effective CPU quota in cores. The existing `nproc` value remains the host-visible CPU count; compare it with the cgroup quota when the container is CPU-limited. Nullable companion `cgroupMemoryLimitUnlimited` and `cgroupCpuQuotaUnlimited` fields distinguish an unlimited cgroup setting from an unavailable probe.

While k6 is running, the load orchestrator samples generator resource use once per second and reduces it to the nullable `generatorUtilisation` block. It records peak k6 RSS, peak cgroup `memory.current`, minimum host-visible `MemAvailable`, peak cgroup swap, final `memory.events` `high`/`max`/`oom_kill` counters, and peak/mean CPU utilisation percentages. CPU is normalized against a finite cgroup quota when present, or against `nproc` only when the cgroup probe explicitly reports an unlimited quota; CPU percentages remain unavailable when quota probing is unavailable. `sampleCount` and the observed-average `effectiveIntervalMs` describe the observation density, with the configured interval retained for a single usable sample. The report stores no time series or derived warning, and `null` means no usable sample was captured; sampled zero-valued swap or pressure counters remain distinct.

Per-run `networkDiagnostics` persist the effective `ipLocalPortRange`, `tcpTwReuse`, and `tcpTimestamps` values with the traffic completion record.

The same `generatorCapacity` block is the host record that the [estimator calibration procedure](estimator_calibration.md) asks for when re-measuring the estimator allowances on a new host.

Authenticated operators can read these values in the **Generator diagnostics** panel on a run's `/run-history/[runId]` detail page. Public run detail does not expose the diagnostic block. When validating a new host, compare sampled utilisation independently with `docker stats load-orchestrator`; the run record intentionally stores a bounded summary rather than a time series.
