# High-Load Tuning Notes

Reusable guidance for high-load k6 runs driven from a single generator host, whether that host is a developer machine, a CI runner, or a deployment target of unknown size.

This document is a reference, not a record. It states which limits matter, why they matter, and how to verify them. It deliberately contains no measurements from any particular machine: figures taken from one host do not transfer to another, and treating them as settings to copy is the most common way tuning advice goes wrong. Measure your own host and record the result alongside the run.

## Scope

This guide covers the load-generator side of a run: k6 capacity, the generator process's file-descriptor and network limits, and the k6 options that affect generator cost. It does not size the system under test's accept queue, CPU, memory, database, or worker capacity.

Generator-side headroom changes no duration, delay, or connection-establishment window on the server. Multi-second k6 `blocked` and `connecting` times are usually evidence of a real server-side capacity limit, not a generator setting to tune away. Confirm which side is saturated before changing anything here.

## Sources Reviewed

- Grafana k6: Running large tests (`https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/`)
- Grafana k6: Fine-tune OS (`https://grafana.com/docs/k6/latest/set-up/fine-tune-os/`)
- Grafana k6: Options reference (`https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/`)
- Docker Compose services reference (`https://docs.docker.com/reference/compose-file/services/`)

## k6 Generator Capacity

- A single k6 process can use all CPU cores and, with proper tuning and monitoring, can run roughly `30,000` to `40,000` simultaneous VUs. In some cases that can produce up to about `300,000` HTTP RPS.
- Those numbers are upper-end examples, not guarantees. The achievable rate depends on the script, protocol, response size, host and container limits, network path, and system under test.
- CPU should not be saturated. Grafana recommends keeping about `20%` idle CPU headroom. At `100%` CPU the generator itself throttles and distorts the response-time metrics it reports.
- Memory should be planned from measured per-VU usage. Grafana's baseline is about `1 MB` to `5 MB` per VU for simple tests.
- At `10,000` preallocated VUs that implies roughly `10 GB` to `50 GB` of possible generator RAM demand depending on script complexity. A simple script may land near the low end, but tens of gigabytes is not automatically excessive for a 10k-VU HTTP test.
- Keep physical RAM use below about `90%`. Swap makes performance erratic enough to invalidate load-test results.

### Capacity inside a container

Host-visible values are misleading under a cgroup. `nproc` and `/proc/meminfo` report the host, while the kernel enforces the cgroup limit. Read both before sizing a run:

```bash
nproc
grep -E 'MemTotal|MemAvailable|SwapTotal' /proc/meminfo
cat /sys/fs/cgroup/memory.max          # "max" means unlimited
cat /sys/fs/cgroup/cpu.max             # "max <period>" means unlimited
```

Distinguish an explicitly unlimited cgroup setting from a probe that simply failed. Normalizing CPU percentages against `nproc` when a finite quota is actually in force understates utilisation by exactly the ratio between them.

### What to sample during a run

A pre-flight snapshot is not enough, because the interesting values only move under load. Sampling once per second and keeping bounded extremes is usually sufficient:

- peak k6 RSS, and peak cgroup `memory.current`
- minimum host-visible `MemAvailable`, and peak cgroup swap
- final `memory.events` `high`, `max`, and `oom_kill` counters
- peak and mean CPU utilisation, normalized against the enforced quota
- the number of samples actually captured and their observed average interval

The last point matters: a summary drawn from three samples on a nominal one-second interval describes a stall in the sampler, not a quiet run. Record observation density next to the values it produced, and keep a sampled zero distinct from "no sample captured".

## Linux and Network Limits

OS and network limits matter for high-concurrency HTTP tests. Grafana's Linux large-test example uses:

- `sysctl -w net.ipv4.ip_local_port_range="1024 65535"`
- `sysctl -w net.ipv4.tcp_tw_reuse=1`
- `sysctl -w net.ipv4.tcp_timestamps=1`
- `ulimit -n 250000`

Practical notes:

- `ulimit -n` controls the process file-descriptor ceiling. k6 needs one descriptor per open connection, so this bounds concurrency directly.
- The local ephemeral port range can limit thousands of outbound connections, especially when many sockets sit in `TIME_WAIT` after a burst.
- Platform default ranges are materially narrower than Grafana's example. A common Linux default of `32768 60999` yields 28,232 ports, about 44% of the 64,512 that `1024 65535` would allow.
- `tcp_tw_reuse` lets the kernel reuse `TIME_WAIT` sockets for new outbound connections; it requires `tcp_timestamps=1`. A value of `2` restricts reuse to loopback, which is a meaningful difference when the target is reached over a bridge network rather than loopback.
- Namespaced service-level sysctls are separate from container `ulimits`. Setting `ulimits.nofile` does not change the local port range or `TIME_WAIT` behavior, and vice versa.
- Treat sysctl changes cautiously. Prove before-and-after impact on your own host rather than applying fixed values blindly.

### File-descriptor limits

Check the effective limit as the process that actually spawns k6 sees it, not as your interactive shell sees it. Soft and hard limits differ, and the soft limit is what applies:

```bash
ulimit -n      # soft
ulimit -Hn     # hard
cat /proc/<pid>/limits   # pid of the process that spawns k6
```

Two behaviors are worth knowing before adding configuration:

- Container images commonly ship a low soft `nofile` limit with a very high hard limit. The soft value alone does not tell you the ceiling available.
- Node.js raises its own soft limit toward the hard limit during startup, and child processes inherit the raised limit. A k6 process spawned from Node therefore often already has a high limit without any explicit configuration.

Where that holds, setting `ulimits.nofile` to anything below the inherited value is a no-op. Verify it on your own base images rather than assuming:

```bash
docker run --rm --entrypoint sh <image> -c 'ulimit -n; ulimit -Hn'
```

Any such implicit inheritance is worth rechecking whenever the spawning runtime changes, the base image changes, or an init system is introduced between the two — each can silently lower the limit k6 ends up with.

### Ephemeral ports and repeated surges

A single burst of N cold connections consumes N ephemeral ports, and those ports stay in `TIME_WAIT` for the duration of the timeout after the burst ends. Back-to-back runs are the case that exhausts a range: the second run starts against whatever the first left behind.

When measuring the effect of a wider range or of `tcp_tw_reuse`, run the pairs tightly back-to-back and read `TIME_WAIT` immediately after each, in the correct network namespace:

```bash
ss -tan state time-wait | wc -l
cat /proc/sys/net/ipv4/ip_local_port_range
cat /proc/sys/net/ipv4/tcp_tw_reuse
cat /proc/sys/net/ipv4/tcp_timestamps
```

Read the outcome as headroom, not as a rate improvement. A lower `TIME_WAIT` count under `tcp_tw_reuse=1` is observational; on its own it does not isolate how many sockets the kernel actually reused. The defensible claim is how many ports remained available for the next run.

Widening the range in a container also has a floor: keep the lower bound above any port the container itself listens on, or the service can lose its own listener to an ephemeral allocation.

### Tuning that does not help the generator

Two commonly cited items are worth ruling out explicitly, because they appear on most high-load checklists and cost time to re-evaluate:

- **TCP Fast Open.** k6's Go HTTP client provides no client-side support, so enabling `tcp_fastopen` on the generator does nothing for a k6 run. It is also structurally irrelevant to a one-request-per-VU shape, which has no repeated connection to accelerate.
- **Reverse-proxy tuning.** Header-buffer, worker, and keepalive settings on an Nginx or Caddy front end only matter if the generator's traffic actually traverses it. When k6 targets the service directly and the proxy serves only a dashboard or ingress path, proxy tuning is outside the load path entirely. Confirm the request path before tuning anything on it.

## Docker Compose

- Compose supports service-level `ulimits`, as either a single value or a soft/hard mapping.
- Compose `sysctls` apply per service network namespace. Setting them on one service does not affect any other.
- Container sysctls can prevent startup entirely under rootless Docker, Kubernetes safe-list policy, or managed platforms that disallow them. Kubernetes does not generally safe-list `tcp_tw_reuse`, so it may need cluster-level unsafe-sysctl permission even where the port range is allowed.
- Because rejection happens at container startup on the key itself, changing the *value* through an environment variable cannot serve as the escape hatch. Ship an override file that removes the block:

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.no-sysctls.yml up -d
  ```

  The override must use Compose's `!reset` tag. A plain `sysctls: []` merges rather than clearing, and would silently leave the original values in place. If a Compose implementation does not support the tag correctly, deploy from a copy with the blocks removed and confirm the resolved config.

- Verify any override with `docker compose config` rather than trusting the merge semantics.
- Services under test may have their own throughput limits. Tune those separately, based on observed bottlenecks, not together with generator settings.

## k6 Options

- `discardResponseBodies: true` avoids retaining response bodies when the script only counts outcomes. This is the single cheapest option for high-RPS runs whose assertions do not read the body.
- `systemTags` defaults include tags most scripts never consume, and every tag is repeated on every streamed JSON point. Narrowing it to only the tags you actually read keeps points identifiable while cutting stream volume substantially — in one measured 100-iteration probe, keeping only `scenario` preserved every emitted line while reducing the stream by about 46%. The saving scales with iteration count, so it matters most on exactly the runs that are hardest to handle.
- `--no-usage-report` stops a self-hosted k6 process from making an anonymous outbound usage-report request during teardown. Worth setting for reproducibility and for hosts without egress.
- Prefer classifying results from response *headers* over response bodies. Stable outcome headers let a script count accepted, rejected, and unexpected responses while still discarding bodies.
- `noConnectionReuse` and `noVUConnectionReuse` both default to `false`, meaning connection reuse is enabled by default.
- Reuse settings are inert under `per-vu-iterations` with one iteration per VU: each VU issues a single request and has no second request that could reuse a connection. N cold connections are the point of that shape, not a defect to configure away.
- Under `constant-arrival-rate`, VUs run multiple iterations and connection reuse is a live setting. Keep the defaults unless new-connection pressure is the explicit goal, since disabling reuse changes what the test measures as well as what it costs.
- `batch` and `batchPerHost` tune parallelism for `http.batch()` calls only. They are irrelevant to scripts whose iterations send a single request.

## Useful Runtime Checks

Persist these with each run, so a result can be interpreted later without re-deriving the environment it came from:

- `ulimit -n`, read from a child of the process that spawns k6, and that process's own `/proc/self/limits`, which k6 inherits
- `ip_local_port_range`, `tcp_tw_reuse`, and `tcp_timestamps`, from the generator's network namespace
- host-visible CPU and memory, cgroup memory and CPU limits, and whether those limits are explicitly unlimited
- sampled peak and mean CPU, peak process and cgroup memory, minimum available memory, peak swap, and memory pressure and OOM counters
- bounded k6 stderr
- the resolved execution plan, completed and dropped iterations, transport and application-response outcomes, and HTTP blocked/connecting/TLS/sending/waiting/receiving timings

A bounded summary is usually the right granularity: extremes and counters answer nearly every retrospective question, while a full time series costs storage on every run to answer few. Cross-check the summary against an independent view such as `docker stats` when validating a new host.
