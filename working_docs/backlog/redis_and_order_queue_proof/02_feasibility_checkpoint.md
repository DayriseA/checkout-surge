# 02 — Feasibility Checkpoint

**Design:** sections 2, 4, 5 · **Depends on:** 01

## Goal

The owner knows, from measurements in the proof environment, whether a configuration exists where each comparison shows its point fairly, and decides go or no-go.

## Scope

- **Prototypes on a throwaway branch:**
  - the three modes of design section 4;
  - the fairness rules of section 5, including equal protections and a PostgreSQL queue for the mode without Redis;
  - two or three API processes;
  - PostgreSQL and Redis at a realistic distance.
- **Measurements on Fly.io**, with the modes interleaved, repeated, and the spread reported. Start from the 2026-10-08 study's presets and adjust them.
- **For each comparison, a configuration a visitor can understand:** what differs, by how much, and why.
- **What each configuration needs in production:** Machines, processes, cost per month.

## Done When

- The owner has a report: the configurations found or not found, the measurements, what production would need, and a recommendation.
- The work stops here until the owner decides.

## Open Points

- The design's open points on distance and on what the presets show are explored here, not decided.

## Working Notes

### Checkpoint report — recommendation: GO to tasks 03–06, owner decision pending

Recommend **GO to tasks 03–06**, subject to the owner's explicit checkpoint decision, for two proposed fixed presets: Redis database offload at native store distance (1,000 arrivals/s for ten seconds, stock one), and queue buyer decoupling (5,000-buyer spike, stock 500, ERP 100 ms / 20 TPS). Each comparison passed six independently audited interleaved pairs. Redis reduced PostgreSQL CPU by a median 95.388% within pairs at approximately 0.8 ms protocol RTT. The queue reduced accepted-buyer wall-p95 from a median 33.748 s inline to 2.275 s queued, a median paired ratio of 14.919×, while ERP work continued after buyers were answered. These are bounded preset results; they do not prove universal Redis speed/capacity, a Lua ceiling, faster ERP processing, queue CPU efficiency or a minimum sixteen-CPU runner.

The report is complete for the feasibility checkpoint. Production topology, public/admin exposure and run-slot behavior remain owner decisions. **Work stops before task 03 until the owner chooses GO or NO-GO.** The recommendation does not deploy or authorize production changes.

#### What the prototype establishes

The lab compares demo versus no-Redis, and demo versus no-queue. One controller owns run setup, closure and teardown; three buy-only API processes serve requests; one worker/ERP authority owns downstream pacing and protection. This establishes buyer-path feasibility with several API processes. Production run control, realtime feeds, recovery and idle-stop coordination remain separate work.

Demo retains the actual Redis stock Lua and BullMQ order delivery. No-Redis uses an atomic PostgreSQL stock function and a leased PostgreSQL order queue. No-queue uses Redis stock and awaits ERP confirmation after releasing the durable admission session. Every mode reuses durable reservation/order/ERP boundaries. Inline confirmation failures and unresolved dispatched calls are reported explicitly; reconciliation of an uncertain inline call performs lookups only.

Hardware, API count, PostgreSQL pool limits, store distance, ERP capacity/protections and durable admission/lifecycle work stay equal within each pair. Different native statements and commits remain part of each architecture's real work. All modes share the observational counter collector: a 250 ms PostgreSQL snapshot plus mandatory fresh final flush. Redis Lua counters remain additional real Redis-path work. An intermediate observational flush failure is acceptable only if the final flush succeeds and exactly reconciles immutable request points and durable state; no claim of live observer fidelity follows. Notifications use the same durable inline handler in every experimental mode, without a notification queue or dashboard.

Each cell recreates its application processes, consistently including a cold API boundary. The initial stores share one separate Machine in Paris (`cdg`), with native distance and no added delay. Actual protocol RTT is measured before each run. Any later netem delay or pool change must be disclosed and held equal within the comparison; the retained configuration uses native distance, three APIs and a pool of ten; no added netem delay or pool change was selected.

#### Evidence and interpretation

Retained modes alternate AB/BA within pairs. Target six retained pairs per comparison, with the audited count and any limitations stated. Report every retained repetition, median/range and paired differences, plus all warmups, exclusions and failed cells with reasons. Calibration is separate from retained evidence.

A clean Redis speed claim requires complete planned delivery, correct run/mode attribution, exact final observer reconciliation, settled durable/stock/ERP/notification invariants, clean responses and usable CPU evidence. Account separately for planned, started, completed, interrupted (`max(0, started - completed)`), unstarted (`max(0, planned - started)`), excess (`max(0, started - planned)`), dropped iterations, transport failures and deadlines. Missing evidence stays unknown and invalidates the relevant claim. The constant-arrival driver caps extra executor iterations before HTTP; capped iterations are separate generator bookkeeping. Any positive dropped count, shortage, interruption or excess invalidates exact delivery. There is no count tolerance or refill of missed requests.

The recorded k6 HTTP duration excludes connection/blocking time. Full request wall time is reconstructed by matching immutable attempt start/result timestamps; dispatch profile and time to serve all buyers are also reported. Buyer response completion and durable ERP drain are separate outcomes. No-queue winner latency must be shown alongside all failed/deadline/unresolved counts, avoiding a conclusion drawn only from buyers who confirmed in time.

CPU is cumulative CPU-seconds divided by a common, explicitly stated dispatch window, with drain reported separately. Audit fresh, advancing store sample epochs and monotonic counters; missing samples are never zero. Report each API's utilization, PostgreSQL, Redis, the core lab container excluding Caddy, and the generator k6 cgroup, with actual CPU quotas and memory limits. PostgreSQL and Redis are distinct containers sharing the same two-CPU store Machine; their allocations are not independent Machine capacity. These counters do not measure whole-Machine CPU. Confirm generator dispatch/headroom before interpreting store throughput. One-second samples limit short-interval precision; interpolate only between real bracketing samples and leave uncovered drain endpoints unknown. Keep peaks from intervals wholly inside the common window separate from all-trace peaks, which include initialization and drain. The raw packet must contain the exact plan, images, actual Machine configuration/IDs, protocol RTT, compressed request points, summaries/logs, final evidence, CPU samples, checksums and matrix completion sentinel/count.

##### Calibration ledger: excluded from retained results

Paths below are under `.tmp/feasibility-results/`. These cells document calibration and excluded attempts, including a batch originally intended for retention; none is retained benchmark evidence.

| Raw packet | Boundary and exclusion |
| :-- | :-- |
| `smoke-redis/`, `smoke-queue/` | Four 32-request cells used only to validate paths, accounting and CPU probes; all are warmups. |
| `pilot-queue/` | One 5,000-request pair, stock 500, ERP 100 ms / 20 TPS; requests and business work reconciled. A synchronous Fly exec HTTP 408 lost the console completion sentinel. Preserve the artifacts as transport-affected calibration, excluded from retained evidence. |
| `pilot-redis/` | Native 2,500/s for 10 s: demo started/completed 24,999 of 25,000; no-Redis 24,393, with 607 reported drops. Generator/API/store pressure and overlapping export invalidate clean input and latency inference. |
| `screen-redis-1500/` | Native 1,500/s for 10 s: demo 15,000 requests; no-Redis 15,001, an explicit excess of one. No-Redis also saturated the generator during the common interior window and distorted arrivals. No count tolerance is applied. |
| `screen-redis-1000/` | Reviewed finite cap: exactly 10,000 HTTP requests per mode, with one/two capped generator iterations and captured completion. No-Redis still reached 7.630 of 8 CPU cores inside the common window, and an interior arrival bin fell to 873/s. Exact totals do not establish fair delivery timing. Excluded from retained performance evidence. |
| `screen-redis-1000-r16/` | Generator-only resize to sixteen CPUs: exact delivery, stable arrivals and generator headroom passed. Original +1 to +9 s comparative CPU coverage failed at the final no-Redis PostgreSQL endpoint. Preserve that original analysis and exclude the screen from retained results. It established coverage for the future fixed +1 to +8 s comparison window. |
| `retained-native-redis-r16/` | First continuous-VM batch aborted after seven of twelve cells; no `COMPLETE 12` exists. Recovery status is `FAILED`, requested 12 / completed 7. Preserve all seven completed-cell packets, failure evidence and partial-record index. Exclude the entire batch, including otherwise clean cells, from retained results. |
| `fresh-native-queue-r16/` | All twelve cells were captured, but the final demo cell had 499 notifications for 500 confirmed orders. Independent audit is `FAILED_EXCLUDED_ENTIRE_BATCH`, aggregate statistics `null`. Preserve the failed cell and all eleven positive cells unchanged; exclude the whole campaign. The original eventual notification outcome is unknown. |

The failed batch's pair-two no-Redis cell, `75c83eb5-6b58-408e-aad2-ac897931f05a`, recorded 9,823 started/completed requests: 8,228 sold-out answers, one winner and 1,594 transport/protocol failures. k6 stderr reported `connect: cannot assign requested address` for the core's IPv6 address on port 8080. The matrix's control `POST /runs` then failed with `EADDRNOTAVAIL` before cell eight. This strongly diagnoses local source-address/port allocation failure; exact port occupancy was not captured. It is not a clean no-Redis throughput result. Inspection found no active k6 process or controller-owned open run, so no orphan reset was needed. The partial index does not imply batch completion.
Independent failed-batch audit `.tmp/failed-retained-native-redis-r16-audit.json` verified all 63 per-run hashes and the source plan. Across the seven saved cells: 70,000 planned, 69,633 started/completed, 367 unstarted, zero interrupted and 3,176 transport failures; all seven winners were confirmed, notified and matched the ERP ledger. Pair two's no-Redis cell had 177 unstarted and 1,594 status-zero responses. Pair four's no-Redis cell `a05f9ac5-bea3-4261-bd64-30052ecd8ffc` had 190 unstarted and 1,582 status-zero responses. For each failed cell, k6 error code 1213 and stderr source-address warnings match those transport counts. The five otherwise clean positive cells remain excluded too; the remaining five planned cells were never produced.

##### Queue collector finding and separately registered replacement campaign

The original queue campaign's final demo pair-six run, `a05ae168-c98a-4c68-9628-99848fe3d18d`, had 500 orders, reservations, confirmed orders and ERP-ledger entries, but 499 notifications and 2,999 events. Queued, processing, failed, unresolved and escalated counts were all zero. The final snapshot at `2026-10-11T07:14:09.630Z` was only 20 ms after the last confirmation at `07:14:09.610Z`. The actual worker commits confirmation before awaiting the separate notification transaction. The old collector stopped on settled orders, then reset/tore down the run before requiring the complete notification invariant. Independent source review and real-worker tests confirm that this race is reachable; they do not establish the eventual outcome of the original missing notification. Its raw failure remains unchanged in `.tmp/fresh-native-queue-r16-audit.json`, and no original-campaign aggregate is retained.

The minimal repair extracts `collectDrainedEvidence(request, existingAbsoluteDeadline)` in `run-matrix.mjs` and keeps polling until all current correctness invariants pass, including notification totals, or the existing absolute deadline expires. The same 600,000 ms budget and one-second poll remain; expiry still produces invalid business evidence. Only the collector and its prototype tests changed. No application, recovery, topology, configuration or workload budget changed. Two real demo-worker tests used a PostgreSQL SHARE table lock, allowing SELECT while blocking the actual notification INSERT; PostgreSQL activity confirmed the block. Releasing it yielded a fresh complete snapshot; holding it beyond the test deadline kept business validity false. These checks passed 2/2, alongside 5/5 measurement checks and Biome in the dev container. The focused test infrastructure was removed. The repair received independent review before replacement execution.

The entire twelve-cell campaign is separately preregistered as `fresh-native-queue-r16-drain-v2`, not a selective rerun of the failed cell. Protocol: `.tmp/feasibility-operator/fresh-native-queue-r16-drain-v2/protocol.json`, registered `2026-10-11T07:21:01.726Z`; provenance verified `07:26:34.774Z`; execution granted `07:27:37.653Z`, before new load. The source plan SHA-256 remains `7995cb947b7d1f06797097e7c2675be269863f4742b5b44fa49854062fa5df48`, with the same interleaving, workload and strict gates. Only the runner image changes to `registry.fly.io/cs-feasibility-redis-queue-runner:lab-drain-v2-1791703403597`, digest `sha256:940abc4cd45e1f33520564c2caddaf686353d2fd2ea7cf4ccda6fa1f9e5b904a`. Host and guest collector SHA-256 both equal `5a57a56cfd460278701fa6b8b9afb3f8f2bc04042838fcdb78a6ba32428c751c`. Core/store image digest `sha256:404c711a2480048ef56c395ff0df40a7aa3f6b8fe018be70ef77019ddc30a8b8` and configuration remain frozen. New raw root: `.tmp/feasibility-results/fresh-native-queue-r16-drain-v2/`; the independent audit is `.tmp/fresh-native-queue-r16-drain-v2-audit.json`. The replacement results below are retained only after the full independent audit; the original failure remains excluded.

##### Fresh-runner operator policy — executed and audited for both comparisons

The replacement protocol was registered at `2026-10-11T06:20:04.6340192Z` in `.tmp/feasibility-operator/fresh-native-redis-r16/protocol.json`. It preserves the original workload and CPU-window rules but requires a stopped-then-started Fly runner before every cell, a distinct observed kernel boot UUID, that cell's actual `FEASIBILITY_MATRIX_COMPLETE 1` sentinel and complete local download/hash verification before the runner is stopped. All twelve Redis cells and all twelve replacement queue cells passed these checks, with twelve distinct boots within each campaign and no queue measurement boot equal to its validation boot. Core and store hardware remain unchanged and every cell still resets application processes. This matches the production fresh-runner boundary in [HD-07](../../../docs/decisions/hosted_deployment.md#hd-07-the-api-starts-and-stops-the-runner-for-each-run). No sysctl tuning, source feature change or added network delay is involved. A reviewed SFTP fast path was probed against the bounded downloader; per-file length, SHA-256 and completion-manifest gates remain mandatory. Each campaign consists of twelve verified individual completions; no synthetic `COMPLETE 12` is asserted.

##### Preregistered retained protocol

After the excluded screen, retain the generator at performance-16x / 32 GiB; retain native distance, 1,000/s for 10 s, stock one, three APIs, pool ten and 10,000 preallocated/maximum VUs in both modes. This isolates generator capacity before any distance or pool change. It does not predict success or select production topology.

For every retained constant-arrival cell, require all thirteen audit gates and exact 10,000 starts/completions, no excess/interruption/shortage or positive reported drops, clean responses, settled business work, final observer reconciliation and captured matrix completion. Two scopes are fixed before retained dispatch and applied to every mode and cell: comparative CPU means use +1 to +8 s, with every role/API genuinely bracketed; generator headroom retains +1 to +9 s, requiring the runner's own finite, monotonic and bracketed samples. The generator peak from intervals wholly inside its +1 to +9 s window must be at most 80% of actual allocation. A null PostgreSQL endpoint in that headroom-only analysis stays null and never supplies a PostgreSQL claim or a globally valid comparative window.

Each arrival bin at seconds 1–8 after the first request must be within ±5% of 1,000/s (950–1,050); at most 0.5% of starts may occur after +10 s (50 requests), and dispatch span must be at most 10.25 s. These are declared operational margins, not universal thresholds, and the timing margins do not relax exact request accounting. Counts and latency distributions still include every request. Preserve both explicitly scoped analyses, all calibration and failed cells.

The queue comparison's intended conclusion is buyer decoupling from back-office drain. Report actual ERP drain in both modes; the same declared capacity is a ceiling, not an identical realized service timeline. Do not claim the queue accelerates ERP processing. For native Redis comparisons, input-confounded latency differences do not establish a store speed gain. A clean, repeated reduction in PostgreSQL work at equally delivered load can support database offload; no generalized Redis speed claim follows. Any later equal netem delay or smaller pool is a separate, disclosed configuration.

#### Retained results

Redis audit: `.tmp/fresh-native-redis-r16-audit.json` (SHA-256 `a1194e80c25ef25fefa07ca064e46c84d2672aaec6124466d6fbd8159a138a62`), completed `2026-10-11T06:44:36.431Z`, `aggregateEligible: true`. All thirteen data gates and the registered CPU/profile gates passed under the cell 11 scope arbitration below. Totals are 120,000 planned, started and completed; 119,988 sold-out answers and twelve accepted/confirmed/notified/ERP-ledger orders; zero interrupted, unstarted, excess, transport failures, failed confirmations or unresolved confirmations. Raw and summary dropped-iteration metrics are absent in every cell, not measured zero; the gate is no reported positive drops plus exact immutable request accounting. Eleven capped boundary iterations are separate generator bookkeeping.

Every interior arrival bin at seconds 1–8 passed 950–1,050/s; no starts occurred after +10 s. Dispatch spans were 9.747–9.819 s. The highest runner peak inside the registered +1 to +9 s headroom scope was 44.1% of sixteen CPUs, below the 80% gate. The sixteen-CPU runner is a validated conservative configuration, not a proven minimum: no fresh-kernel eight-CPU retained comparison was run.

All summaries below use the usual median of six cells (mean of the two middle values), with full observed min–max ranges. Request percentiles use nearest-rank matched raw attempt timestamps; full wall time includes blocking/connection time. Ratios use paired no-Redis/demo values, not ratios of displayed medians. PostgreSQL ratios use unrounded interpolated cumulative counters over +1 to +8 s; one core means one CPU-second per second.

| Metric | Demo median [min–max] | No-Redis median [min–max] |
| :-- | --: | --: |
| PostgreSQL mean cores | 0.012489 [0.011840–0.016033] | 0.270745 [0.263214–0.278147] |
| All-request wall p50, ms | 4.200 [4.139–4.590] | 4.471 [4.351–4.673] |
| All-request and sold-out wall p95, ms | 15.854 [11.887–28.273] | 51.646 [30.665–132.700] |
| Single winner wall time per cell, ms | 179.440 [103.908–195.351] | 411.354 [340.896–458.726] |
| All buyers answered after first start, s | 9.7765 [9.750–9.792] | 9.7775 [9.767–9.830] |
| Last ERP confirmation after first buyer, s | 0.4075 [0.363–0.459] | 0.6605 [0.631–0.725] |
| PostgreSQL protocol RTT median, ms | 0.7995 [0.788–0.881] | 0.7785 [0.726–0.789] |
| Redis protocol RTT median, ms | 0.724 [0.691–0.836] | Not called by this mode |

The paired PostgreSQL no-Redis/demo ratio median is **21.685×**, range **17.182–22.325×**; the corresponding paired reduction is **95.388%**, range **94.180–95.521%**. The paired wall-p95 ratio median is **2.516×**, range **2.228–7.117×**. Buyer completion spans are similar because offered arrivals last about ten seconds. With only one winner per cell, winner timings are contextual rather than a stable winner-latency claim. CPU offload is the principal Redis claim; these are end-to-end application results at one native-distance configuration, not intrinsic store timings or an asymptotic ceiling.

The replacement queue comparison passed the strict preregistered protocol; full results and per-cell evidence appear below. It uses the unchanged source plan and workload, with the separately reviewed collector-only runner-image boundary recorded in the exclusion ledger. Its +1 to +20 s CPU window is context only; generator admission applies to all observed samples including initialization, with no retrospective exception. Redis cell 11's covered-window arbitration does not apply to this different queue rule.

##### Redis cell 11 CPU scope arbitration

No-Redis pair six, `2e687a5b-b119-4553-8481-a28fc8d55ad8`, retains its original `cpuObserved: false` and `missingSamples: 1`. Its missing probe is at `2026-10-11T06:40:53.864Z`, +10.501724 s after the first buyer (`06:40:43.362276344Z`), after the last response (`06:40:53.136634Z`) and outside both fixed CPU scopes. The comparison ends at `06:40:51.362276344Z` (+8 s); runner headroom ends at `06:40:52.362276344Z` (+9 s). Real samples at approximately `06:40:51.828Z` and `06:40:52.829Z` cover the relevant endpoints with no internal missing probe or gap. Under the originally registered covered-window rule, the root reviewer accepted those scoped comparisons. The auditor removed only an extra, unregistered global-zero-missing admission condition; no registered gate was relaxed and original runtime flags were not rewritten. Whole-trace and drain CPU remain incomplete, and this report does not claim that all runtime flags were green. Evidence: `.tmp/fresh-redis-cell11-cpu-scope-audit.json`.

#### Redis retained repetition detail

In the tables, D means demo and N means no-Redis. Every listed cell has 10,000 starts/completions, 9,999 sold-out answers, one accepted/confirmed/notified/ledger order and zero request/business failures.

| Pair / actual order | D run ID | N run ID | D / N PostgreSQL cores | N/D CPU ratio / reduction | D / N wall p95 ms | N/D wall p95 ratio | N−D wall p95 ms |
| :-- | :-- | :-- | --: | --: | --: | --: | --: |
| 1 / D→N | `be4b1763-4754-4bf5-8a8d-113bfd64b4dd` | `175ba7fc-e567-4b10-a8ef-5a12e5c96782` | 0.016033 / 0.275478 | 17.182× / 94.180% | 28.273 / 66.728 | 2.360× | 38.455 |
| 2 / N→D | `2f29db07-6f3d-4b41-b123-78e7be56eda6` | `e1cebb71-c000-40ef-9372-7e087f806e17` | 0.012186 / 0.267838 | 21.978× / 95.450% | 13.762 / 30.665 | 2.228× | 16.903 |
| 3 / D→N | `893759f1-88be-483a-824b-6f5e0faffa2a` | `2606e146-e3e8-49b2-aa47-69620df6d30a` | 0.011840 / 0.263214 | 22.231× / 95.502% | 15.948 / 71.267 | 4.469× | 55.319 |
| 4 / N→D | `40edf2e2-d8a7-4fcd-94e0-cf22bb9995cd` | `89a25fe3-aeca-4594-b9b3-698b3f100324` | 0.013175 / 0.278147 | 21.112× / 95.263% | 15.759 / 36.564 | 2.320× | 20.805 |
| 5 / D→N | `00de720d-929a-4d56-af07-79319b8a0e27` | `095a93b0-e715-4de0-ac4f-fa51a6557c6a` | 0.011976 / 0.267358 | 22.325× / 95.521% | 18.646 / 132.700 | 7.117× | 114.054 |
| 6 / N→D | `e173035a-a3f8-4e70-844b-0f25f48d42fb` | `2e687a5b-b119-4553-8481-a28fc8d55ad8` | 0.012792 / 0.273652 | 21.392× / 95.325% | 11.887 / 31.766 | 2.672× | 19.879 |


| Pair | D / N PostgreSQL CPU-seconds over seven seconds | N−D mean cores |
| :-- | --: | --: |
| 1 | 0.112233 / 1.928343 | 0.259444 |
| 2 | 0.085305 / 1.874868 | 0.255652 |
| 3 | 0.082879 / 1.842496 | 0.251374 |
| 4 | 0.092224 / 1.947031 | 0.264972 |
| 5 | 0.083829 / 1.871509 | 0.255383 |
| 6 | 0.089545 / 1.915566 | 0.260860 |

Mean CPU cores use the +1 to +8 s scope; runner peak is only +1 to +9 s. API columns show processes 0/1/2 individually, sharing the core allocation. PostgreSQL and Redis share the same two-CPU Machine. Core measures the lab container excluding Caddy; runner measures the matrix/k6 cgroup. These are not whole-Machine counters.

| Cell / mode | API mean cores 0 / 1 / 2 | Core / Redis mean cores | Runner interior peak % | Dispatch / all-buyer span s | Last confirmation s |
| :-- | --: | --: | --: | --: | --: |
| 1 / demo | 0.356 / 0.361 / 0.368 | 1.097 / 0.161 | 25.9 | 9.770 / 9.774 | 0.363 |
| 2 / no-redis | 0.378 / 0.357 / 0.362 | 1.177 / 0.009 | 27.3 | 9.765 / 9.769 | 0.691 |
| 3 / no-redis | 0.357 / 0.354 / 0.350 | 1.140 / 0.009 | 31.0 | 9.819 / 9.830 | 0.631 |
| 4 / demo | 0.341 / 0.353 / 0.359 | 1.061 / 0.167 | 25.4 | 9.789 / 9.792 | 0.407 |
| 5 / demo | 0.365 / 0.347 / 0.347 | 1.072 / 0.164 | 11.3 | 9.783 / 9.790 | 0.459 |
| 6 / no-redis | 0.362 / 0.361 / 0.358 | 1.158 / 0.008 | 26.8 | 9.764 / 9.767 | 0.725 |
| 7 / no-redis | 0.371 / 0.378 / 0.380 | 1.210 / 0.009 | 8.6 | 9.801 / 9.806 | 0.660 |
| 8 / demo | 0.346 / 0.349 / 0.338 | 1.042 / 0.156 | 28.0 | 9.747 / 9.750 | 0.423 |
| 9 / demo | 0.375 / 0.341 / 0.350 | 1.075 / 0.160 | 8.5 | 9.769 / 9.772 | 0.408 |
| 10 / no-redis | 0.350 / 0.353 / 0.361 | 1.137 / 0.009 | 22.2 | 9.768 / 9.781 | 0.661 |
| 11 / no-redis | 0.370 / 0.366 / 0.375 | 1.194 / 0.009 | 44.1 | 9.760 / 9.774 | 0.644 |
| 12 / demo | 0.354 / 0.360 / 0.349 | 1.072 / 0.156 | 17.2 | 9.775 / 9.779 | 0.403 |

Observed maximum resident/cgroup memory per cell, summarized as median [min–max] MiB: demo core 659.231 [650.758–667.848], runner 2361.111 [2112.758–2441.711], PostgreSQL 86.289 [78.730–91.051], Redis 15.903 [15.668–16.039]; no-Redis core 650.364 [640.848–656.824], runner 2330.829 [2153.230–2462.250], PostgreSQL 158.117 [151.879–162.207], idle Redis 15.497 [15.434–15.676]. These are maxima over observed samples, not guaranteed unsampled peaks. Individual API RSS is recorded as pages in raw CPU evidence; no MiB conversion is asserted without an evidenced page size.

#### Queue retained results and repetition detail

Independent authority: `.tmp/fresh-native-queue-r16-drain-v2-audit.json` (SHA-256 `5961a7c9ad3188767c4d92cf89a83e45677180ddca1faaccc9d9ddea22f72cbb`), audited `2026-10-11T07:56:02.218Z`, `ALL_TWELVE_ELIGIBLE` / `aggregateEligible: true`. Every cell passed all thirteen data gates, individual actual `COMPLETE 1`, verified export/plan/provenance, fresh boot, spike profile, strict all-observed runner headroom and covered +1 to +20 s role/API CPU context. All twelve stderr files are empty. There were no missing CPU probes. This is a new complete campaign; neither the original failed cell nor its eleven positive companions enter these aggregates.

Totals: 60,000 planned, started and completed requests; 54,000 sold-out answers and 6,000 winners, each durably confirmed, notified and matched to the ERP ledger. Interrupted, unstarted, excess, transport failures, failed/unresolved confirmations, failed/unresolved/escalated business work are all zero. Per cell: 5,000 requests, 4,500 sold-out and 500 winners; demo returns 202/`reservation_secured`, inline returns 200/`order_confirmed`, sold-out returns 409 in both. Raw and summary dropped/capped metrics are absent (`null`) in every cell, not measured zero. Internal ERP retries, deferrals and event-type breakdown are also `null`/unknown. Demo has 3,000 order events in each cell; no-queue pair one has 3,001, with 3,000 in each other cell. This does not identify a cause or prove zero internal retries.

Winner/timing medians and min–max below derive from the independent audit's unrounded `preciseTiming`, including nanosecond matched attempts; paired arithmetic precedes display rounding. All-request and sold-out percentiles use the audit's separately recorded raw-request percentile fields. Times are seconds unless stated otherwise. Every request is accounted for; there are no failed buyers omitted from the winner comparison.

| Metric | Demo median [min–max] | No-queue median [min–max] |
| :-- | --: | --: |
| Winner wall p95 | 2.275231 [2.198572–2.503101] | 33.747835 [33.489217–35.404437] |
| All buyers answered after first start | 2.820148 [2.671063–2.938040] | 35.110686 [34.821206–36.770221] |
| Last ERP confirmation after first buyer | 29.391846 [28.636468–29.493299] | 35.083379 [34.792384–36.743989] |
| ERP confirmation remaining after last buyer response | 26.516857 [25.965405–26.710697] | 0.000000 [0.000000–0.000000] |
| Dispatch span | 0.464420 [0.364773–0.548040] | 0.447209 [0.406892–0.493287] |
| All-request wall p95 | 2.435504 [2.224964–2.491624] | 22.038520 [21.730907–22.449654] |
| Sold-out wall p95 | 2.435097 [2.228073–2.498933] | 2.581364 [2.448564–2.817203] |

The paired no-queue/demo winner wall-p95 ratio is 14.919 [14.144–15.261]×; the paired difference is 31.472603 [31.263062–32.901336] s. The paired all-buyer serving ratio is 12.548 [11.879–13.261]× and difference 32.333183 [31.889988–33.997367] s. Last-ERP-confirmation ratios are 1.206 [1.183–1.251]× and differences 5.968767 [5.371852–7.380829] s. These are medians of six paired quantities, not ratios or differences of displayed mode medians.

The queue's point is that the buyer stops waiting while downstream processing drains. Both modes retain the same declared ERP ceiling and protections; actual drains differ, and the same ceiling does not imply identical realized service timelines. The observed drain difference is not evidence that queuing accelerates ERP processing. The +1 to +20 s CPU context overlaps queued drain in demo and buyer waiting inline, so it supports no CPU-efficiency comparison.

D means demo, N means no-queue; order is actual dispatch order. Winner percentiles and paired arithmetic use unrounded matched attempts.

| Pair / order | D run ID | N run ID | D / N winner wall p95 s | N/D ratio | N−D winner wall p95 s |
| :-- | :-- | :-- | --: | --: | --: |
| 1 / D→N | `349b4dac-119c-44a9-8f5e-78fc6ab57205` | `2fe3b5bd-687d-4776-b37f-00df2596ba09` | 2.503101 / 35.404437 | 14.144230× | 32.901336 |
| 2 / N→D | `06334a45-840a-43c6-814d-ac69d6c88182` | `08e178bb-93cc-4f95-8881-fb0b04cec4d5` | 2.226154 / 33.489217 | 15.043528× | 31.263062 |
| 3 / D→N | `76967fb1-cd14-477b-aada-576fd68fc98d` | `43fe0cac-90dc-47aa-af99-939b9c00f002` | 2.286798 / 33.710106 | 14.741184× | 31.423308 |
| 4 / N→D | `e6649cc0-c917-46ec-8b2d-adc89b902ad9` | `cd96b024-36f0-4b86-9415-be677ebc1696` | 2.263665 / 33.785564 | 14.925161× | 31.521899 |
| 5 / D→N | `21c5700c-ee30-4c38-8042-6d1ae2fbd7d2` | `f86e1c39-7f74-4500-9ee4-6805cc0a5955` | 2.292416 / 34.185924 | 14.912621× | 31.893509 |
| 6 / N→D | `a5eb3cc9-6b6f-40c9-8405-487c50fa45ac` | `62af9014-7475-4402-a1da-c7b29138644e` | 2.198572 / 33.552962 | 15.261250× | 31.354389 |

| Pair | D / N all-buyer span s | N/D / N−D all-buyer span | D / N last ERP confirmation s | N/D / N−D last ERP confirmation | D post-buyer ERP drain s |
| :-- | --: | --: | --: | --: | --: |
| 1 | 2.772854 / 36.770221 | 13.260785× / 33.997367 s | 29.363159 / 36.743989 | 1.251364× / 7.380829 s | 26.590305 |
| 2 | 2.931218 / 34.821206 | 11.879432× / 31.889988 s | 29.420532 / 34.792384 | 1.182589× / 5.371852 s | 26.489314 |
| 3 | 2.938040 / 35.029699 | 11.922812× / 32.091659 s | 29.482440 / 35.001965 | 1.187214× / 5.519525 s | 26.544400 |
| 4 | 2.782602 / 35.191673 | 12.647037× / 32.409071 s | 29.493299 / 35.164794 | 1.192298× / 5.671494 s | 26.710697 |
| 5 | 2.857693 / 35.575705 | 12.449098× / 32.718012 s | 29.062798 / 35.547277 | 1.223120× / 6.484478 s | 26.205105 |
| 6 | 2.671063 / 34.928358 | 13.076575× / 32.257295 s | 28.636468 / 34.902507 | 1.218813× / 6.266039 s | 25.965405 |

All 5,000 starts in every cell fall in the first one-second bin; dispatch spans are approximately 0.365–0.548 s. Strict runner all-trace peak, including initialization and drain, is at most 58.0% of sixteen CPUs, below 80%; this scope is broader than the Redis interior-window gate. The following means use only +1 to +20 s and are contextual. Core excludes Caddy, PostgreSQL/Redis share two Machine CPUs, APIs share six core CPUs, and runner is the matrix/k6 cgroup. Observed memory maxima are not guarantees about unsampled peaks.

| Cell / mode | API mean cores 0 / 1 / 2 | Core / PG / Redis / runner mean cores | Runner all-trace peak % | Max memory MiB core / PG / Redis / runner | RTT median ms PG / Redis |
| :-- | --: | --: | --: | --: | --: |
| 1 / demo | 0.111 / 0.103 / 0.097 | 0.960 / 0.416 / 0.053 / 0.226 | 50.1 | 666.750 / 193.211 / 17.406 / 1168.926 | 0.858 / 0.776 |
| 2 / no-queue | 0.121 / 0.132 / 0.105 | 1.529 / 0.426 / 0.034 / 0.170 | 49.3 | 834.418 / 229.500 / 18.664 / 1209.723 | 0.781 / 0.696 |
| 3 / no-queue | 0.113 / 0.116 / 0.123 | 1.509 / 0.409 / 0.041 / 0.222 | 50.8 | 838.355 / 235.789 / 18.355 / 1239.547 | 0.737 / 0.686 |
| 4 / demo | 0.115 / 0.080 / 0.110 | 0.949 / 0.382 / 0.056 / 0.248 | 50.8 | 676.070 / 234.605 / 17.723 / 1176.836 | 0.808 / 0.737 |
| 5 / demo | 0.111 / 0.114 / 0.110 | 0.959 / 0.418 / 0.066 / 0.250 | 50.6 | 691.859 / 239.238 / 18.598 / 1206.219 | 0.770 / 0.736 |
| 6 / no-queue | 0.126 / 0.093 / 0.116 | 1.508 / 0.410 / 0.028 / 0.234 | 48.0 | 837.102 / 253.484 / 18.723 / 1230.816 | 0.793 / 0.706 |
| 7 / no-queue | 0.140 / 0.138 / 0.139 | 1.589 / 0.366 / 0.037 / 0.193 | 48.9 | 840.438 / 269.434 / 18.199 / 1210.156 | 0.862 / 0.726 |
| 8 / demo | 0.110 / 0.107 / 0.094 | 0.912 / 0.395 / 0.065 / 0.180 | 47.8 | 688.461 / 255.988 / 17.973 / 1130.340 | 0.776 / 0.713 |
| 9 / demo | 0.116 / 0.098 / 0.105 | 0.915 / 0.424 / 0.057 / 0.254 | 57.6 | 703.484 / 253.012 / 18.355 / 1130.512 | 0.860 / 0.749 |
| 10 / no-queue | 0.124 / 0.133 / 0.107 | 1.535 / 0.356 / 0.045 / 0.170 | 48.4 | 839.129 / 275.621 / 18.020 / 1242.805 | 0.762 / 0.672 |
| 11 / no-queue | 0.111 / 0.132 / 0.133 | 1.527 / 0.402 / 0.037 / 0.187 | 47.1 | 853.852 / 269.398 / 16.754 / 1226.160 | 0.849 / 0.769 |
| 12 / demo | 0.106 / 0.089 / 0.092 | 0.885 / 0.431 / 0.063 / 0.313 | 58.0 | 697.297 / 257.336 / 18.047 / 1179.648 | 0.706 / 0.683 |

##### Queue provenance

Raw root: `.tmp/feasibility-results/fresh-native-queue-r16-drain-v2/`; cell directories use audit labels such as `queue-v2-cell-01-demo-pair1`, each containing its exact one-cell `plan.json` and run-ID directory. Every run `complete.json` authenticates the compressed raw points, logs, summary, final business/observer evidence, RTT and CPU samples. Each export verified fourteen files; every marker binds actual `FEASIBILITY_MATRIX_COMPLETE 1`, exact run/mode/pair, plan and boot UUID. Twelve distinct boots were verified, none equal to the pre-load validation boot. Marker paths are `.tmp/feasibility-operator/fresh-native-queue-r16-drain-v2/<cell-label>-verification.json`; full raw paths and boot UUIDs are in the audit. Protocol SHA-256: `cda8db5bd45f28a071b3bea002ff1183c3739f8a0cd3a57c0ebc0efdc6f8be68`; source plan SHA-256: `7995cb947b7d1f06797097e7c2675be269863f4742b5b44fa49854062fa5df48`. The runner-only collector source/image boundary and original excluded campaign remain recorded above. Core/stores and all guest allocations remained unchanged.

| Cell | One-cell plan SHA-256 | Verification-marker SHA-256 |
| :-- | :-- | :-- |
| 1 | `420c8cc482a6bb7ab8435fbfd0892c63ff954aeab7fd46cc648ef0ed3dcd6ce4` | `e892f27b4d5ec74db2fd15699eac3674663efca012d63cc0d484add93dd5f683` |
| 2 | `452015c3e84bb8fa4f07d55649ad18152154a950dc1fa4cb82289fe29fd3ceb4` | `35a67fa3ff97636c0fd004af5ebc39a8e15f454640ef6d8442bb28bd5d93afaf` |
| 3 | `1f11c9178e92d53e443926b0d2e85d0e4b22f95a7ed4ed595655918c92bc6ccc` | `3463d1dfa95a52f1894ddf60555df52bbcd28383d6bd1c114f08ebaebc008664` |
| 4 | `d9b44bf727510cb443a98383decd33f9dda8b92180707ae70bc9fc251249dc33` | `43b6edbe36ce6226b4fabcd6bab55c564f51947ae02e14104802b6f959e4166e` |
| 5 | `234094517399150ae3c120f155ba0a2ee1e25ca3b3ec2b577c54618c3637e3a6` | `38a5a8f6304e6b2364b57d2278c6655295da0cde2a834a64a2f6e1fc3c3af278` |
| 6 | `3bdcb7e5da3d24f6959ac98c3f0160b528c5aab19cddc198f203f635c9d606d6` | `f6f5e96265fa84320ca19238d5d7eefe0fd8600c40e1e58e14f6e7afa44c17f9` |
| 7 | `fcdad4ee0f554997e212f0a1d2e84c83c18333e394ce27a31d1db1af50aa0939` | `9a31f38edfcd829914bb7dd68a5a81ebf3a97db117c73424bf957a8b53bf63b1` |
| 8 | `cce60bc8badd9315e3f8be37ef99ee857de0120b13ac7596f2cdcc52eb216c16` | `584f57830dddd3255fffa66da1ce2e79e7f6093cc92505b6baf21d593af87d7d` |
| 9 | `b46a0394bf6855f772a985ce5ebef2d86969815823ff8d49accc780b496c1ae2` | `8e68ead54323535402fc6732d478246f5b64f1638ce33c1f17c5ee64b5ad6c1d` |
| 10 | `91efbccea7ad6f37d0bb99f7eec24a7914d04c6b7cf02acbea524dd4d40ebf11` | `18113cff4f1d5053ff310a1f4ca2fda9010129470c8eb8656a47e46962cc1162` |
| 11 | `9387181b38d8ab66d79c9de2f4bd128ce5e18d70ae71bf4f2f7524a52fe5a56a` | `468c9d77f5438009e336e7b8b90b42da226de03a6025521ba4f0ae2717cc604a` |
| 12 | `d383dfc5191eaa8723959771ba007401b5d4bee35acb1cb13d2e039556f953d1` | `219731d22067d2c61cbcea094630c96b9bd41f69f9005736cb543d3f710f3b1f` |

#### Evidence manifest and validation boundary

Original CPU/profile preregistration: `.tmp/feasibility-operator/retained-native-redis-r16-protocol.json`, `2026-10-11T06:06:07.0843986Z`. Fresh-kernel registration: `.tmp/feasibility-operator/fresh-native-redis-r16/protocol.json`, `2026-10-11T06:20:04.6340192Z`. Both reference source plan SHA-256 `5509357f97c595dd91f7e0f3430e1d72f5d72f857d8af9ce69805363ef36a55d`. Retained raw root: `.tmp/feasibility-results/fresh-native-redis-r16/`; each cell directory is its audit label (`cell-01-demo-pair1`, and so on), with its exact one-cell `plan.json` and run-ID subdirectory. Each run's `complete.json` authenticates raw compressed request points, summary/stdout/stderr, CPU samples, actual RTT and final durable/observer evidence. The independent audit rehashed those files and verified the run/plan/completion/boot mapping. The failed batch remains separately under `retained-native-redis-r16/`, excluded.

The per-cell plan and verification-marker SHA-256 values below anchor every cell's raw manifest and actual `COMPLETE 1`. Marker files are `.tmp/feasibility-operator/fresh-native-redis-r16/<cell-label>-verification.json`; their exact paths, boot UUIDs and full raw paths are also in `.tmp/fresh-native-redis-r16-audit.json`. No fabricated aggregate completion sentinel is used.

| Cell | One-cell plan SHA-256 | Verification-marker SHA-256 |
| :-- | :-- | :-- |
| 1 | `35fe4ee896d1c796a8d42ad5cd439910c47acf730ae918bb519a2ac5343884e9` | `bd7ce9afc9885ca06e2d4ecd2393328ca91082448ecf44bfe0690e00ad56f44f` |
| 2 | `c8bef76122e970b78327e377de6ac445592dd7ed199d9ec2e33b6b18878ce1f5` | `108c7fd1945f6d01244ce5c7750f61fe9772801b143000a2fa0ae4eddd654536` |
| 3 | `cd0103254005f73a25e2c4dba40cdb9c94fd2d5c6a8772835dde5020432801b4` | `a761112b6f4710e58973ccb9a47a416ca9b53e70e85348a9848f1af991ebebd5` |
| 4 | `c5598ffee69ee9cf1d1e331c96dab08420c080c4304431ada72229eb783f4688` | `6f84e4f0e63d59c62fafbf6e9d2e9b9e468d7fac8bbbb732e8e4b1df0846a54d` |
| 5 | `6a3c0023fe8efd37f861986be2ba15045ebd24e02d23a08f4aada40c1ca81871` | `be5b37fcba3e91f0555c2d4c7ef198a92a9397afb781fbf984c3fa085d025b04` |
| 6 | `f5ec82c55485a565ec588754bd691948bf0689566510b520ce5dafc5d5981edd` | `f843b210a23782f425918837b49d6f3a847ddfcfbfa4de1df110d6a15341bd25` |
| 7 | `cb6fa4c963c0eb9aa05f9975e4edf4e5d9051c86c8a4a05efc82dad6ffca61c4` | `f6355eb91cccb25ee26c8aebdf53a4fee6581b7b41222a2a60ca65087b807bed` |
| 8 | `8427ad8449eb3661db9b68609518a045cf61d790d0185c4ff6c9241a1a6004fb` | `e2db9d5b07b13136c46807e695abd1c846f9b89a9ba67660dc93548830aef558` |
| 9 | `b7c86d3db6b38fb0b90f387ed973ebceea87ff8fda02e6a07c1816b233d23ed7` | `62ae250ca6da286eb084a5ae075391569ad4f472cf80666262ab4917dc7be2ec` |
| 10 | `16194ef06cf7dfc5b8c2f60e1afc5ddc34039514be61d9c38ef9899daaf9665b` | `644cb3fa7a5b62d8e8f7e738cd49a537dc3cf10c3e823e4faca2abae2149c764` |
| 11 | `215e3edc437fe221f33c889fb76ff7013ba10a347c03f11c9e45cb3086fe56db` | `cb1648196fd6a1bf758b4e905de6ff416f4a6d65664ea55b70a8556f2f055825` |
| 12 | `d9b87e5d800cd23aa3a4ba9c0949ef06442f7c5bc675992975d845279c862e47` | `584ad7f37c1e51c2f3de1625f6d169cb337d9b199cc2fe579607375c5bc6074d` |

For the audited Redis campaign, all roles use the finite-cap Node image tag `lab-1791697489049`, with verified digest `sha256:404c711a2480048ef56c395ff0df40a7aa3f6b8fe018be70ef77019ddc30a8b8` in their respective `registry.fly.io/cs-feasibility-redis-queue-{core,stores,runner}` repositories. Full image/container manifests (including Caddy, PostgreSQL and Redis digests) are `.tmp/feasibility-operator/manifest-finite-cap.json` and `.tmp/feasibility-operator/manifest-runner16-stopped.json`; the former records the earlier eight-CPU runner, while the latter confirms its unchanged image and sixteen-CPU resize. Every retained cell independently confirms actual guest sizes.

| Role | Machine ID | Region / allocation |
| :-- | :-- | :-- |
| Core | `80727dc6452248` | `cdg`, performance six CPUs / 12,288 MiB |
| Shared stores | `843ed0a4292ee8` | `cdg`, performance two CPUs / 4,096 MiB |
| Runner | `8e3e29b77365d8` | `cdg`, performance sixteen CPUs / 32,768 MiB |

Store volume: `vol_4oj2jq65jgn0o99r`, 6 GiB, mounted only on the store Machine. Per-cell runtime-reported runner memory is 33,654,521,856 bytes; this observed OS total differs from configured guest memory and is preserved as separate provenance. PostgreSQL connection budget: 53 potential connections (thirty API, ten authority, ten ERP, three controller). Process accounting uses observed `CLK_TCK=100`.
Local prototype/measurement checks passed 16/16. Actual reconciliation checks passed 10/10 and uncertainty-policy checks passed 2/2 after rebuilding the worker package, so imports exercised the repaired policy. Serialized repository types initially passed; worker and test types passed after the actual TypeScript repair. The latest sixteen-CPU measurement configuration passed its five focused measurement checks, touched-file Biome and historical-analysis reproduction. These checks validate implementation/accounting boundaries; they do not replace retained hosted evidence. The isolated test infrastructure has been closed and removed. Composition and characterization suites were not run, as instructed.

The checkpoint does not prove an asymptotic Redis or PostgreSQL throughput ceiling. One controller and one worker/ERP authority keep downstream protection and maintenance ownership coherent; several buy-only API processes do not validate production distributed run control, UI, SSE, recovery or idle coordination. The prototype's notification handler uses durable idempotency but does not establish a production notification queue topology. Production adoption, preset exposure and production topology remain owner decisions.

#### Production needs and owner choices

Reproducing these presets would need three buy API processes with the same reservation and durable boundaries; a coherent authority for run setup, closure, maintenance and recovery; remote PostgreSQL and Redis at the same disclosed distance; one downstream protection/ERP authority; and a fresh runner per run. The tested pool budget is 53 potential PostgreSQL connections, including API, authority, ERP and controller pools. Equal protection, durable acceptance, idempotent notifications and lookup-only recovery for uncertain inline confirmation must survive production composition. The current prototype validates buyer paths, not distributed run control, UI/SSE, recovery or idle coordination; those remain implementation work after an owner's GO.

The retained conservative reference is six core CPUs / 12 GiB, two shared-store CPUs / 4 GiB and sixteen runner CPUs / 32 GiB. Sixteen is validated, not a measured minimum; reuse of the existing eight-CPU production runner without resizing would require separate validation. Full replacement pricing is $898.65 per explicit 720 running hours, or $12.48 for a hypothetical ten awake hours, before storage/build/rootfs and other charges. Reusing the six-CPU core while adding stores and resizing the eight-CPU runner adds approximately $374.44 / 720 hours or $5.20 / ten hours; the $74.89 store-only increment assumes no runner resize and is conditional. Runtime roles need not share awake time. The cost table below preserves the separate scenarios rather than choosing production topology.

The owner still chooses whether comparative topology applies to every run or only presets, whether the presets are public or admin-only, and how paired runs, the run slot, 600-second occupancy ceiling and automatic reset compose. No design decision is changed by this report. The proposed two presets make no need for a new simulated network constraint or further Lua-capacity hunt at this checkpoint.

#### Actual lab spend, elapsed work and final resource inventory

The independently reviewed captured-window **three-lab-VM list-price-equivalent compute bound is $2.084286674–$2.515613045 (approximately $2.08–$2.52)**, through inventory observation `2026-10-11T07:56:36.774Z`. This is neither an invoice nor a full-project/account spend total. Evidence: `.tmp/feasibility-compute-usage-bounds.json`, SHA-256 `f89da5c12ca2b459893341883ec4d40a6b7bc4412aec0a9e17d5c4b25c3aeb3d`, derived from the 285 events / 166 source captures and final v2 inventory using the primary Paris pricing inputs.

| Lab role | Observed awake-hour lower–upper bounds | Compute USD lower–upper bounds |
| :-- | --: | --: |
| Core | 1.8358–1.9411 | 0.572839–0.605689 |
| Stores | 1.8606–1.9806 | 0.193518–0.205999 |
| Runner | 1.7283–2.0478 | 1.317930–1.703926 |

Lower usage includes only contiguous actual started-to-stopping event pairs; unknown early boundaries contribute zero to that lower bound, not invented usage. The upper bound includes conservative possible-awake setup/gap intervals and deliberately prices all runner upper hours at sixteen CPUs, including its earlier eight-CPU phase. In particular, the missing 51.361-second start gap is included from the prior stopped event at `05:59:23.500Z` to observed started at `06:00:14.861Z`. Exact segments, missing gaps and source hashes remain in the bounds JSON. No host-log modification time is a billing timestamp. Exclusions include earlier unobserved usage, proof/guard compute, Depot builds, rootfs, provisioned volumes, snapshots, network, credits and taxes. Rootfs and build charges remain unknown, not zero; a missing persistent builder app does not mean zero Depot charges. Topology prices and hypothetical ten-hour scenarios below are separate from this captured usage bound.

The three lab Machines were read back stopped at `2026-10-11T07:56:28.587Z`. Scoped final inventory initiated at `07:56:36.774Z` confirmed all seven lab/proof VMs stopped. Exact final configurations and retained resource records are `.tmp/feasibility-operator/fresh-native-queue-r16-drain-v2/manifest-final-stopped.json`, `final-resource-inventory.json` and `final-closure-summary.json`. This supersedes the interim `07:17:47Z` inventory; resources are stopped and retained, not destroyed.

| App | Machine ID | Final state / guest allocation |
| :-- | :-- | :-- |
| `cs-feasibility-redis-queue-core` | `80727dc6452248` | stopped / performance, 6 CPUs, 12288 MiB |
| `cs-feasibility-redis-queue-stores` | `843ed0a4292ee8` | stopped / performance, 2 CPUs, 4096 MiB |
| `cs-feasibility-redis-queue-runner` | `8e3e29b77365d8` | stopped / performance, 16 CPUs, 32768 MiB |
| `cs-proof-redis-queue-core` | `830d15b7939398` | stopped / performance, 6 CPUs, 12288 MiB |
| `cs-proof-redis-queue-runner` | `832525f7969008` | stopped / performance, 8 CPUs, 16384 MiB |
| `cs-proof-redis-queue-gate` | `801e93b6474e78` | stopped / shared, 1 CPUs, 256 MiB |
| `cs-proof-redis-queue-gate` | `89954ec6619478` | stopped / shared, 1 CPUs, 256 MiB |

Retained volumes: lab `vol_4oj2jq65jgn0o99r` (6 GiB), proof `vol_4ql7lyd3do8xm9dr` (3 GiB), total 9 GiB and approximately **$1.35 per full month** even while stopped. The only recorded addresses belong to the proof gate: shared IPv4 and IPv6; no dedicated IPv4 was found. No persistent builder app was observed in the scoped organization inventory. Billed rootfs GB, available snapshot allowance/footprint and remote Depot usage/charges remain unknown and are additional exposure.

The proof guard remains on its existing hourly schedule, stopped at the checkpoint. Its last observed start was `07:40:01.369Z`; a nominal next wake at `08:40:01.369Z` is inferred from that schedule, not returned by the API. Stopped-at-checkpoint therefore does not imply zero ongoing compute. Actual lifecycle evidence is `.tmp/feasibility-operator/lifecycle-events-collected-with-v2.json` (166 captures, 285 events); early host-log gaps prevent an invoice claim. All measurements and accounting above concern scoped proof/lab resources, without a production mutation.

Report timestamp: `2026-10-11T07:59:59Z`. From task 02 branch creation at `2026-10-11T04:43:37Z` (Git reflog), orchestration elapsed **3 hours 16 minutes 22 seconds**. This excludes unmeasured pre-branch planning and is not continuous compute usage or billable labor.
#### Compute and retained storage costs

Verified 2026-10-11 against [Fly's current pricing](https://fly.io/pricing/), including its Paris multiplier of 1.134615385. The prices below are USD pay-as-you-go compute estimates, without discounts, credits, taxes, storage or transfer. The always-on scenario explicitly uses 720 hours. Fly bills started Machines by the second, so calendar-month totals vary. [Fly billing](https://docs.fly.io/about/billing)

| Lab role | Paris size | Running hour | 720 hours always on | Hypothetical 10 awake hours |
| :-- | :-- | --: | --: | --: |
| Core | performance-6x / 12 GiB | $0.312032 | $224.66 | $3.12 |
| Stores | performance-2x / 4 GiB | $0.104011 | $74.89 | $1.04 |
| Initial runner | performance-8x / 16 GiB | $0.416043 | $299.55 | $4.16 |
| Retained 16-CPU runner | performance-16x / 32 GiB | $0.832085 | $599.10 | $8.32 |
| Full replacement topology with initial 8-CPU runner | | $0.832085 | $599.10 | $8.32 |
| Full replacement topology with retained 16-CPU runner | | $1.248128 | $898.65 | $12.48 |

Ten awake hours is an explicit hypothetical, not measured usage or an invoice estimate. Core plus stores cost approximately $299.55 for 720 running hours, or $4.16 for 10 running hours. Runner time is separate: add `$0.416043 × awake hours` for eight CPUs or `$0.832085 × awake hours` for sixteen; it need not equal core awake time. Lab compute requires actual started intervals, including setup and calibration. Remote builder compute is separate, based on its own Machine configuration and usage; it is not lab awake time.

If production reuses an already adequate existing core and runner, the incremental separate-store compute is approximately $74.89 for 720 running hours or $1.04 for 10 running hours. That excludes existing core/runner costs and is conditional on their reuse without resizing. Full replacement totals instead price the complete proposed topology from scratch. Moving the runner from eight to sixteen CPUs adds approximately $299.55 for 720 running hours, or $4.16 for ten running hours. The static production configuration currently has a six-CPU core and an eight-CPU runner. Reusing that core while reproducing the retained sixteen-CPU generator therefore adds both the separate stores and the runner resize: approximately $374.44 per 720 running hours, or $5.20 for ten running hours, before storage and other charges. The $74.89 store-only scenario does not price that upgrade. Final production needs and any resizing remain pending; these scenarios do not select production topology.

Pricing proof: the saved primary HTML contains Paris multiplier `1.134615385` and performance-16x base hourly rate `0.7333632`. Their product is `$0.832085169512832` per hour, or `$599.10132204923904` for 720 hours, rounded to **$599.10**. Multiplying the rounded Markdown monthly base `$528.02` by rounded multiplier `1.135` instead yields `$599.3027`, explaining the inconsistent $599.30 estimate. The table uses unrounded source inputs throughout. Capture: `.tmp/feasibility-fly-pricing-2026-10-11.html`; extraction, SHA-256 and arithmetic: `.tmp/feasibility-pricing-evidence.json`.

The planned 6 GiB store volume costs approximately $0.90 per full month at $0.15 per provisioned GB-month, including while its Machine is stopped. Stopped rootfs is additional: `$0.15 × rootfs GB × stopped hours / 720`, summed over retained Machines. Actual rootfs sizes are unknown and this lab's workspace image is large. Snapshots cost $0.08 per stored GB-month above the organization's first 10 GB allowance, prorated; the available allowance and actual snapshot footprint are unknown. Remote builders and other retained resources require their actual usage/configuration. Same-region private transfer is free; other transfer and any optional addresses are separate. [Fly resource pricing](https://docs.fly.io/about/pricing)

#### Checkpoint decision

Recommend **GO to tasks 03–06** for the two bounded fixed presets described above, with the measured limitations and production decisions retained explicitly. Alternatively, the owner can choose **NO-GO** and stop the comparative feature. Task 02 delivers the report and recommendation; the owner has not yet selected either option. Stop here: tasks 03 and later remain `todo` until the owner's explicit GO. Production rollout is a later separate decision.

### Chronological implementation and calibration notes

The entries below preserve the state when they were written. Statements such as “no lab resources”, initial eight-CPU sizing and pending pre-hosted review describe earlier boundaries and are superseded by the report's later protocol and evidence inventory. They are not the final resource inventory or checkpoint result.

### Experimental composition — 2026-10-11

- Task 01 is preserved at `add0343d` on `codex/redis_and_order_queue`; throwaway implementation is on `codex/redis-order-queue-feasibility`. `origin/tmp/21-baseline-prototype` remains untouched (`4d474a70`). No phase 03–06 production feature, capacity, UI or settled decision is changed.
- Experiment code/operator instructions: `scripts/feasibility/README.md`. Buy-only API processes and a single controller/ERP authority avoid duplicating production singleton maintenance/pollers. This measures buyer-path concurrency only.
- All three paths reuse the actual reservation service and durable worker/ERP/notification boundaries. PostgreSQL stock is one atomic statement; queued publication reuses the existing reserved admission session, avoiding nested pool checkout. Inline ERP begins only after that session is released. Equal protections do not require equal commit counts.
- All modes share an observational 250 ms counter snapshot and mandatory final flush, reconciled against immutable k6 points. Native Redis counters are unchanged. Missing observer/request evidence or unresolved work invalidates clean speed conclusions. Stock/idempotency/holds/orders/ERP ledger remain independently authoritative.
- PostgreSQL queue polling is 10 ms, with 30 s generation-fenced leases; processing heartbeat is 5 s. Default three-API topology has 53 potential PostgreSQL connections (30 API, 10 authority, 10 ERP, 3 controller); two APIs have 43. Keep all budgets equal within paired comparisons.
- Planned separate lab apps are `cs-feasibility-redis-queue-core`, `cs-feasibility-redis-queue-stores`, and `cs-feasibility-redis-queue-runner`, exclusively in `playground-416`. Initial sizes are performance 6 CPU/12 GiB, 2 CPU/4 GiB and 8 CPU/16 GiB respectively. Both stores share one remote Machine. Start with real local-region RTT, then consider an equal disclosed store-egress netem delay only if needed and verify actual PostgreSQL/Redis RTT.
- Final local focused checks passed 14/14: real three-mode paths, concurrent stock, cross-process replay/conflict, pool-of-one admission, PG lease/stale acknowledgement, closed traffic/replay, inline undispatched deadline, ERP 401, real ledger reconciliation after a lost success response, reset during ERP, teardown, interleaving, accounting invalidation and organization/production-target guards. Touched-file Biome and serialized repository/test type checks passed. Independent review follows before Fly builds or mutations.
- No lab Fly resources have been created during implementation. Local test-only PostgreSQL/Redis use Compose project `cs-feasibility-test`; lifecycle and final cleanup are recorded with validation. No composition/characterization/reference-runtime load suite was run.
- Raw evidence stays in per-run compressed artifacts with checksums. `flyctl machine exec` can report host success for guest failure: require explicit completion sentinels/expected counts, and verify downloaded bounded chunks before marking a matrix complete.
- Still pending: independent review, actual Fly lab smoke, calibration, repeated interleaved retained configurations, cost/source verification against the actual final manifest, report and owner's go/no-go. Local checks are not hosted measurement evidence.

### Focused review repairs — 2026-10-11

- The no-queue post-deadline uncertainty endpoint now explicitly forbids ERP dispatch in the actual scheduled/reconciliation pipeline. Known ledger success is still adopted; unknown lookup remains durably escalated with no fresh POST or side effect. The optional policy defaults to existing queued behavior and is selected only by the experimental no-queue endpoint.
- CPU/memory probes now fall back to the cgroup-v1 combined/separate cpuacct and memory mounts already observed on Fly (HD-44), including the store-container shell sampler. CPU values use microseconds consistently and record the detected cgroup version.
- Rebuilt the affected worker package before the prototype tests so imported `dist` exercised the policy fix. Expanded focused prototype/measurement checks passed 16/16; actual reconciliation unit checks passed 10/10. Worker and test type checks, shell syntax and final touched-file Biome are the focused validation boundary for this repair. No Fly build, mutation or load was run.

### Finite constant-arrival cap — 2026-10-11

- A hosted 1,500/s × 10 s pilot delivered 15,000 demo requests and 15,001 PostgreSQL-only requests while otherwise passing correctness. The pinned k6 v2.0.0 timer/context boundary can schedule an extra iteration. Constant-arrival buyer code now caps only scenario iterations at the finite request target before request counting/HTTP, recording each capped extra separately. No duration, refill, VU, rate, hardware, pool or distance change is part of this fix; a shortage still fails exact delivery.
- Matrix records read the raw summary's nullable dropped/capped iteration counters. Absence stays `null`. Any reported positive dropped count invalidates the run even if HTTP started/completed equals the target; capped extras cannot compensate for a previously dropped slot. Prior raw history and calibration files are unchanged. Focused measurement tests and touched-file Biome validate this slice; no app TypeScript, Fly build/mutation or load is involved.
