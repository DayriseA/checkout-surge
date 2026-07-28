# High-Load Tuning Notes

This document captures reusable guidance for local or single-machine high-load k6 runs.

## Sources Reviewed

- Grafana k6: Running large tests (`https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/`)
- Grafana k6: Fine-tune OS (`https://grafana.com/docs/k6/latest/set-up/fine-tune-os/`)
- Grafana k6: Options reference (`https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/`)
- Docker Compose services reference (`https://docs.docker.com/reference/compose-file/services/`)

## k6 Generator Capacity

- Grafana says a single k6 process can use all CPU cores and, with proper tuning and monitoring, can run roughly `30,000` to `40,000` simultaneous VUs. In some cases, that can produce up to about `300,000` HTTP RPS.
- Those numbers are upper-end examples, not guarantees. The achievable rate depends on the script, protocol, response size, host/container limits, network path, and system under test.
- CPU should not be saturated. Grafana recommends keeping about `20%` idle CPU headroom. If k6 is at `100%` CPU, the generator itself can throttle and distort response-time metrics.
- Memory should be planned from measured per-VU usage. Grafana gives a simple baseline of about `1 MB` to `5 MB` per VU for simple tests.
- At `10,000` preallocated VUs, that implies roughly `10 GB` to `50 GB` possible generator RAM demand depending on script complexity. A simple script may land near the low end, but `32 GB` is not automatically excessive for a 10k-VU HTTP test.
- Grafana recommends keeping physical RAM use below about `90%` and warns that swap can make performance erratic enough to invalidate load-test results.

Each real run persists a pre-flight `generatorCapacity` snapshot from the load-orchestrator namespace: host-visible `MemTotal`, `MemAvailable`, and `SwapTotal` in bytes, plus the cgroup memory limit and effective CPU quota in cores. The existing `nproc` value remains the host-visible CPU count; compare it with the cgroup quota when the container is CPU-limited. Nullable companion `cgroupMemoryLimitUnlimited` and `cgroupCpuQuotaUnlimited` fields distinguish an unlimited cgroup setting from an unavailable probe.

## Linux and Network Limits

OS/network limits matter for high-concurrency HTTP tests. Grafana's Linux large-test example uses:

- `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`
- `sysctl -w net.ipv4.tcp_tw_reuse=1`
- `sysctl -w net.ipv4.tcp_timestamps=1`
- `ulimit -n 250000`

Practical notes:

- `ulimit -n` controls the process file descriptor ceiling. For k6, this affects how many sockets/files the load generator can keep open.
- The local ephemeral port range can limit thousands of outbound connections, especially when many sockets enter `TIME_WAIT`.
- A previously inspected runtime had `net.ipv4.ip_local_port_range = 32768 60999`, about `28,232` ports.
- Namespaced service-level sysctls are separate from Docker Compose service-level `ulimits`. Setting `ulimits.nofile` does not change the local port range or TCP TIME_WAIT behavior.
- Treat sysctl changes cautiously and prove before/after impact rather than applying fixed values blindly.

### Reference runtime network namespace

The reference Compose runtime sets only the load-orchestrator network namespace's `net.ipv4.ip_local_port_range` and `net.ipv4.tcp_tw_reuse`, parameterized by `LOAD_ORCHESTRATOR_PORT_RANGE` and `LOAD_ORCHESTRATOR_TCP_TW_REUSE` with defaults `10240 65535` (55,296 ports) and `1`. The lower range bound remains above the service's port 4200 listener. Host-native runs and every other Compose service retain their platform values.

On the six-core reference Docker host on 2026-07-28, matched tightly back-to-back `surge-10k` pairs produced the following immediate post-run evidence:

| Pair | Persisted network diagnostics | First run TIME_WAIT | Second run TIME_WAIT | Second-run range use and headroom |
| --- | --- | ---: | ---: | --- |
| Platform defaults | `32768 60999`; reuse `2`; timestamps `1` | 9,958 (`2b6f2fff-d3b0-4207-a8c9-38fbe5106491`) | 19,960 (`e5a3e3a7-cee5-4ddf-a18e-00ecc5b39af4`) | 70.7% of 28,232; 8,272 ports |
| Compose defaults | `10240 65535`; reuse `1`; timestamps `1` | 10,016 (`cfbb106e-89aa-4898-ab99-b3e87da01dbc`) | 16,454 (`7e81980c-f53e-4af3-8646-ac597a426760`) | 29.8% of 55,296; 38,842 ports |

The second k6 process began 0.29 seconds after the first baseline measurement and 0.32 seconds after the first configured measurement. Every run planned, started, and completed all 10,000 requests with 1,000 accepted, 9,000 sold out, zero transport failures, zero unexpected responses, and all 1,000 accepted orders confirmed and notified. The configured pair therefore preserved business and transport behavior while the widened range increased measured post-pair headroom from 8,272 to 38,842 ports. The lower configured TIME_WAIT count is observational and does not by itself isolate how many sockets `tcp_tw_reuse=1` reused. Per-run `networkDiagnostics` persist the effective `ipLocalPortRange`, `tcpTwReuse`, and `tcpTimestamps` values with the traffic completion record.

Container sysctls can prevent startup under rootless Docker, Kubernetes safe-list policy, or managed platforms that disallow them. Kubernetes does not generally safe-list `tcp_tw_reuse`, so it may require cluster-level unsafe-sysctl permission even when the port range is allowed. Changing either environment value cannot avoid startup failure because the keys themselves are rejected. Use the verified escape hatch:

```bash
docker compose -f docker-compose.yml -f docker-compose.no-sysctls.yml up -d
```

Both the API and load-orchestrator `sysctls` blocks resolve absent under that override with Docker Compose v2.40.3. The override requires Compose's `!reset` tag; a plain empty sequence merges rather than clearing. If another Compose implementation does not support the tag, deploy from a copy of `docker-compose.yml` with the blocks removed.

This generator-side headroom changes no duration, delay, or connection-establishment window and does not alter the API namespace or its accept-queue ceiling. Multi-second k6 `blocked` and `connecting` signals remain evidence of real server-side capacity limits rather than values to tune away.

## Docker Compose

- Docker Compose supports service-level `ulimits`, with either a single value or a soft/hard mapping.
- For this project, the `load-orchestrator` service is the right first place to raise `nofile` because k6 owns high-volume traffic creation.
- API, worker, and ERP services may have their own throughput limits, but they should be tuned separately based on observed bottlenecks.

## k6 Options

- `discardResponseBodies: true` is enabled for generated checkout k6 scripts so k6 does not retain `/buy` response bodies while counting outcomes.
- `systemTags: ["scenario"]` keeps streamed JSON points identifiable while omitting unused default system tags, reducing the output k6 serializes and the load orchestrator parses.
- `--no-usage-report` prevents the self-hosted k6 process from making an anonymous outbound usage-report request during teardown.
- The API exposes stable checkout outcome and rejection-reason headers, so k6 can count accepted, sold-out, and unexpected responses without reading `/buy` response bodies.
- `noConnectionReuse` and `noVUConnectionReuse` affect connection reuse. Both default to `false`, meaning connection reuse is enabled by default.
- Disabling connection reuse would likely increase socket churn and should not be done for the 10k surge unless the explicit goal is to test new-connection pressure.
- `batch` and `batchPerHost` tune parallelism for `http.batch()` calls. They are not directly relevant to the current checkout script because each iteration sends one `http.post`, not a batch.

## Useful Runtime Checks

For a high-load replay, capture these before or during the run:

- `ulimit -n`
- `cat /proc/1/limits`
- `sysctl net.ipv4.ip_local_port_range`
- `sysctl net.ipv4.tcp_tw_reuse`
- `sysctl net.ipv4.tcp_timestamps`
- `/proc/meminfo`, `/sys/fs/cgroup/memory.max`, and `/sys/fs/cgroup/cpu.max` in the load-orchestrator namespace (captured automatically in run diagnostics, with cgroup v1 fallback)
- k6 stderr
- k6 summary metrics, especially dropped iterations and HTTP blocked/connecting/waiting times
