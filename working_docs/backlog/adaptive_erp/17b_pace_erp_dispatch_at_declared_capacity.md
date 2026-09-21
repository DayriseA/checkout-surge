# 17b — Pace ERP dispatch at the declared capacity with the queue's native rate limit

## Handoff

- Status: Implemented, reviewed and measured. One acceptance criterion is left unchecked for the project owner's acknowledgement: at high declared rates the reference runtime is bounded by `concurrency / full job time` (about 56/s and 43/s for the spike and `surge-10k`, matching the measured 54.94/s and 42.94/s), not by the dispatch rate limit and not by backlog size. Orchestrator disposition: not a pacing defect; carry the full-job-time bound into task 17c.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: inserted between 17 and 18 (user decision, 2026-09-21). Execute after [17](17_build_dashboard_estimate_and_admission_flow.md); [17c](17c_refit_estimator_to_declared_capacity.md) follows and depends on this task's measurements.
- Source: revised D06 and D07 in the [implementation plan](../../adaptive_erp_processing_implementation_plan.md), the "Current path" section below (from a read-only code review at commit `a17b43c8`), the measurements in [task 15](15_implement_conservative_duration_estimator.md), and D14.
- Ownership: worker ERP admission and its wiring, the order-process queue limits, the shared engine-policy identity, their tests, and the architecture documentation of this area.

## Why

The original D06 made the worker discover the ERP's capacity from responses alone: start at 2 launches/s, gain 1/s per 10-second window, never exceed 20/s, never read the declared capacity. On top of that, an order denied for pacing completes its queue delivery and is only brought back by the 1-second recovery scanner, so real throughput sits near one launch per second (60 orders against a 5/s ERP took 55 s). The project owner revised D06 on 2026-09-21: the demo follows the common industry case where the downstream limit is known and the client is configured with it. The custom pacing machinery is replaced by what the queue library already provides.

What stays, because it fixed the original incident and is standard practice: no order is ever abandoned because the ERP is saturated; every ERP call is idempotent and reconcilable (D04, D05); `Retry-After` is honoured; the availability circuit separates an outage from saturation; non-transient errors fail the order (D03); durable ownership and restart safety (D07).

## Current path being replaced

Verified by reading the code at commit `a17b43c8`; re-check line numbers, the worker has not changed since `088a66ff`.

- The API publishes an immediate BullMQ job per order with `attempts: 1` (`apps/api/src/queue/bullmq-order-process-job-publisher.ts`). The worker consumer sets a concurrency but no limiter (`apps/worker/src/queue/bullmq-order-process-consumer.ts`).
- The handler claims durable ownership, then `ScheduledErpOrderConfirmation.confirm` asks the admission controller (`apps/worker/src/application/erp-reconciliation.ts`, `order-process-admission.ts`). The controller checks the worker-wide in-flight ceiling (20), the per-run concurrency (at most 10), the availability circuit, the capacity cooldown, then the next permitted launch time, and on admission sets `nextStartAtMs = now + ceil(1000 / rate)` with no accumulated credit (`adaptive-erp-admission-policy.ts`).
- A denial is persisted as an absolute due time and waiting reason, clears the processing lease and publication owner (`apps/worker/src/persistence/postgres-order-recovery-persistence.ts`), and the handler returns successfully: the delivery completes, no delayed job exists, and `apps/worker/test/integration/bullmq-order-process-admission.test.ts` asserts zero delayed jobs.
- The only wake-up is the order recovery scanner: `setInterval` every `ORDER_RECOVERY_SCAN_INTERVAL_MS` (1000), up to `ORDER_RECOVERY_BATCH_SIZE` (100) due orders, each claimed, fenced and republished sequentially as a new immediate job with a new generation (`apps/worker/src/application/order-recovery-scanner.ts`, `apps/worker/src/runtime/config.ts`). A batch reaches admission within a few milliseconds, one order launches, the rest are deferred again, and nothing wakes them at the next slot. Throughput stays near one launch per scan and falls as the backlog shrinks. The existing workflow test calls `scanOnce` by hand near `nextAttemptAt`, so it never exercised the production timer.
- The mock ERP answers `429`, forced outage and injected errors with `Retry-After: 1` (`apps/mock-erp/src/routes/confirmation-routes.ts`); the client forwards it and the policy applies it up to its maximum. An ordinary injected `503` therefore asks for a 1-second pause; the 5-second figure is the fallback backoff and the open-circuit probe cadence.

## Objective and fixed rules

- The accepted run's declared ERP capacity (`erpConfig.maxTps` in the accepted snapshot) is the dispatch rate, from the first second. It is enforced by the order-process queue's native rate limit. BullMQ 5.79.1 is installed and provides `queue.setGlobalRateLimit(max, duration)`, `queue.setGlobalConcurrency(n)`, `queue.rateLimit(ms)` and `worker.rateLimit(ms)`; verify their exact semantics against that version before relying on them.
- The per-run `orderProcessConcurrency` is enforced by the queue's native global concurrency, so a job is never delivered only to be denied for concurrency.
- Only one nonterminal run exists at a time, so queue-wide limits are per-run limits. Orders outside a run (the `catalog` scope) share the same queue and the same ERP: define one default limit for the queue when no run is active and say where it lives.
- Dispatch must respect the mock's sliding one-second quota; small native bursts are allowed when their worst-case sliding-window count stays within declared capacity (review-cycle-1 clarification). The mock ERP counts accepted arrivals over a sliding 1-second window (`apps/mock-erp/src/application/tps-limiter.ts`), so a coarse "N per 1000 ms" window that releases N jobs at once and N more just after the boundary gets rejected. Choose the limiter granularity accordingly and prove it with a test against the mock's limiter.
- A small safety margin below the declared capacity is the only pacing constant. Keep it provisional until task 20 and record it in [calibration criteria](calibration_criteria.md).
- A `429` pauses delivery natively for the `Retry-After` duration (existing parsing, capped maximum and fallback unchanged) and never fails or abandons an order. The order that received the `429` keeps today's durable deferral: that path, resumed by the recovery scanner within a second, is fine for a rare event. It is no longer used as the pacing clock.
- Availability handling keeps its semantics: unavailability, connection errors and timeouts feed the circuit only; probes are the only traffic while it is open, at most one per scope every 5 seconds. Pausing delivery natively during an availability backoff is allowed if it preserves the probe rule and reduces churn, but it is not required.
- Request deadlines (D08), bounded attempt history (D09), reconciliation (D05), terminal technical failures (D03) and the durable claim, generation fencing and publication fence (D04) are out of scope and must keep passing their tests.
- Decide which process applies the limits and keep a single owner. Applying them where the run is accepted, before traffic starts, avoids a window where the first jobs are delivered unlimited; the pacing constant must still be defined once, next to the engine-policy identity in contracts. After a worker or API restart the limits must be re-applied from the accepted snapshot (revised D07), and they must return to the catalog default when the run becomes terminal or is reset.

## Repository entry points

`apps/worker/src/application/adaptive-erp-admission-policy.ts` (rate, observation windows, `nextStartAtMs`, pacing deferral: to remove; cooldown, circuit, in-flight and deadline parts: to keep), `apps/worker/src/application/order-process-admission.ts`, `apps/worker/src/application/erp-reconciliation.ts` (durable deferral), `apps/worker/src/application/order-process-job-handler.ts`, `apps/worker/src/queue/bullmq-order-process-consumer.ts`, `apps/worker/src/application/order-recovery-scanner.ts`, `apps/worker/src/index.ts`, `apps/api/src/queue/bullmq-order-process-job-publisher.ts`, `apps/api/src/services/demo-run-service.ts` and the terminal-transition and reset services if the API owns the limits, `packages/contracts/src/processing-control.ts` (engine-policy identity), `apps/worker/test/integration/bullmq-order-process-admission.test.ts`, and the completion notes of tasks 05, 07 and 09.

## Implementation work

- [x] Write first a throughput test that fails on the current code: real queue on the isolated test Redis, a stub ERP with a declared capacity, a backlog, and an assertion that confirmations per second track the declared capacity from the start and do not depend on backlog size (5 orders and 300 orders drain at the same rate).
- [x] Apply the queue rate limit and global concurrency from the accepted run snapshot, with the single owner chosen above; re-apply on restart; return to the catalog default at run terminality and reset.
- [x] Pause delivery natively on a capacity response for the `Retry-After` duration; keep the durable deferral of the affected order.
- [x] Remove the learned-rate machinery and everything only it needed: rate state, observation and rejection-wave windows, additive step, reduction factor, floor, ceiling, `nextStartAtMs`, the pacing denial reason and its waiting-reason vocabulary if nothing else uses it, their persistence fields if any, and their tests. Keep the file focused on what remains (cooldown, availability circuit, in-flight safety, deadlines) and rename it if its name becomes misleading.
- [x] Update the shared engine-policy identity so that the name and version persisted with each run truthfully describe the new policy. `demo_runs.engine_policy_name` is text and `engine_policy_version` is integer, so no migration is needed.
- [x] Extend the tests: evenly spaced dispatch stays within the mock's sliding window at 10/s, 100/s and 250/s declared; a single `429` pauses delivery for `Retry-After` and throughput returns to the declared rate immediately afterwards; a restart re-applies the limits; limits return to the default after a terminal run and after a reset; exact accounting is unchanged in the existing workflow, restart and recovery suites.
- [x] Measure on the reference runtime. User decision (2026-09-21, index guardrails): it may be wiped and used as the isolated clean runtime (`pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`; stop it afterwards). Replay the four task 15 scenarios with the request bodies in "Measurement requests" below, plus the seeded `surge-10k` preset, and record the same table as task 15 with confirmations per 10-second window and the share of `429` responses. One run per scenario is enough; this dev container has limited RAM and CPU, so report the numbers as measured and tune nothing to reach a figure.
- [x] Update `docs/architecture.md` and any other authoritative document that describes AIMD pacing, and this backlog's index.

## Measurement requests

Start each run through `POST /demo/runs/start`. Scenario A (60 orders, ERP 5/s at 200 ms, concurrency 5; task 15 measured 55.16 s to the last confirmation):

```json
{
  "presetSlug": "public-custom",
  "configOverride": {
    "trafficConfig": { "mode": "constant-arrival-rate", "ratePerSecond": 10, "durationSeconds": 10, "startDelaySeconds": 0, "quantityPerAttempt": 1 },
    "inventoryConfig": { "startingStock": 60, "quantityPerCheckout": 1, "reservationHoldMinutes": 15 },
    "erpConfig": { "latencyMs": 200, "maxTps": 5, "errorRate": 0, "forcedOutage": false },
    "backpressureConfig": { "queueName": "orders:process", "physicalQueueName": "orders-process", "orderProcessConcurrency": 5, "pendingPersistenceRetryAfterSeconds": 30 }
  }
}
```

Check the body against the current strict request schema before use. Replacements for the other scenarios:

| Scenario | Replacements | Task 15 last confirmation |
| --- | --- | --- |
| B: incident | Traffic rate 25, duration 60; stock 888; ERP latency 250, max TPS 10 | 196.33 s |
| C: spike | Traffic `{"mode":"buyer-spike","buyerCount":300,"duplicateEachBuyerAttempt":true,"startDelaySeconds":0,"maxDurationSeconds":10,"quantityPerAttempt":1}`; stock 300; ERP latency 50, max TPS 100; concurrency 10 | 112.46 s |
| D: errors | ERP latency 100, max TPS 10, error rate 0.2 | 79.03 s |

Read timings from PostgreSQL as task 15 did: `demo_runs` (`started_at`, finalization), `orders.confirmed_at`, `simulated_notifications.recorded_at`, `erp_attempts` (status and disposition counts). Confirmations per 10-second window:

```sql
SELECT floor(extract(epoch FROM (o.confirmed_at - r.started_at)) / 10)::int AS bucket, count(*) AS confirmations
FROM orders o JOIN demo_runs r ON r.id = o.run_id
WHERE r.id = :run_id AND o.confirmed_at IS NOT NULL
GROUP BY 1 ORDER BY 1;
```

## Non-goals

No estimator change (task 17c), no dashboard change, no About copy (task 17c), no adaptive limiter, no new queue, service or replica, no change to deadlines, circuit constants or D14 targets, no final calibration (task 20).

## Acceptance and validation

- [ ] The throughput test fails before the change and passes after it. Functional integration evidence passes; reference-runtime C and surge remain below the ERP-only high-rate envelope because global concurrency also covers full durable job execution (see phase 2 results). With available work and a healthy ERP, confirmations per second are close to `min(declared capacity less the margin, concurrency / latency)` from the first seconds, independent of backlog size.
- [x] A healthy steady run produces at most 5% capacity responses (D14 pressure target) and no order is failed or abandoned because of saturation.
- [x] Measured on the reference runtime: the 60-order scenario at 5/s finishes in roughly 15 s and the 300-buyer spike at 100/s in a few seconds after traffic ends, instead of 55 s and 112 s; the incident yields 888 confirmations and 888 notifications near `60 + 888/10 = 149 s` and under 240 s. If a gap remains, quantify it and say whether it follows backlog size (code) or machine load (environment).
- [x] No learned-rate code, constant or test remains; a repository search for the removed symbols is classified in the completion notes.
- [x] Run Biome on touched files, `pnpm type-check`, `pnpm test:unit`, `pnpm test:infra:up`, `pnpm test:api` and `pnpm test:integration` (use `--concurrency=1`: the DB dirty-signal Pub/Sub test is flaky when packages run in parallel). Do not run `pnpm test:composition` or `pnpm test:characterization`.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). All artifacts in English. Report executed and skipped checks honestly. If the queue's native limits turn out to be incompatible with a guarantee listed under "What stays", stop and hand off with the evidence instead of rebuilding a custom pacing mechanism.

## Completion handoff

Deliver the native rate limiting, the removal of the learned-rate machinery, the tests and the measurements. Record the limit owner, the limiter granularity and margin chosen, the catalog default, the restart and terminal behaviour, the measured table, and the removed symbols. Next: [17c — re-fit the estimator to declared-capacity dispatch](17c_refit_estimator_to_declared_capacity.md).

## Implementation notes (reviewed; phase 2 measurements below)

The API is the sole writer of configured limits. `DemoRunQueueLimits` reads the current nonterminal accepted snapshot and serializes queue writes; run acceptance awaits it before inventory initialization and traffic start. API startup invokes the same operation, and API-owned terminal transitions and resets invoke it after durable state changes. Services receive explicit ports; the BullMQ adapter reuses the API publisher's queue. The existing finalization polling tick also synchronizes limits, including when there is no draining run. The fallback catalog policy is 100 TPS and concurrency 10, defined beside `declared-capacity-erp-dispatch` v2 in `packages/contracts/src/processing-control.ts`. Catalog traffic during an active run shares that run's queue limits. Configured-limit updates leave an in-progress native Retry-After pause intact until expiry, including when returning to catalog defaults.

Review-cycle-1 granularity uses the smallest native burst whose `duration = ceil(max × 1000 / effectiveRate)` reaches the provisional 20 ms minimum, with effective rate equal to declared capacity less the provisional 5% margin. Both constants are defined once in contracts. At declared 10/100/250 TPS (catalog default 100), settings are 1/106 ms, 2/22 ms, and 5/22 ms. Contract tests prove `(floor(1000 / duration) + 2) × max - 1 <= declared capacity`: worst-case sliding-second arrivals are 10/93/234. Theoretical rates are 9.43/90.91/227.27 per second; at 250 TPS, rounding loses approximately 4.31% of 237.5/s effective capacity, versus the rejected one-job design's hard 200/s ceiling. The 20 ms minimum is limiter granularity, not another pacing knob. Both values remain provisional in `calibration_criteria.md` until task 20. Integration tests now require at least 80% of declared throughput (8/80/200 per second) in addition to zero sliding-window rejections. This prevents a regression to about 60/s at high declared capacities from passing. The full review-cycle integration run measured 9.35/88.13/221.60 per second with zero sliding-window rejections, giving approximately 9–14% measured headroom over the 8/80/200 floors. At 250 declared, the remaining approximately 2.5% gap below the 227.27/s mathematical ceiling is execution overhead in this container; the known configured rounding loss is already quantified above. No further tuning or custom pacing was introduced.

Queue-start timing does not assert identical ERP-arrival timing after variable database work. The production-boundary capacity regression checks the full Retry-After pause and exact actual-call/business totals; the real native-queue tests measure dispatch throughput and mock sliding-window safety.

A 429 persists cooldown safety and invokes native `queue.rateLimit(remainingCooldownMs)` from the worker, using the existing publisher queue. It is a transient pause, not a configured-limit write. The affected order retains its durable deferral and its delivery completes normally; no `Worker.RateLimitError` is thrown. After expiry, the configured rate resumes immediately. Existing capped Retry-After parsing, fallback, and availability/probe handling remain; no optional native availability pause was added. In-flight safety and adaptive deadlines remain in renamed `erp-resilience-policy.ts`.

Restart interpretation explicitly approved by the orchestrator: API restart reapplies the accepted snapshot or catalog defaults. Worker restart reuses BullMQ's retained Redis metadata; it neither writes limits nor gates/fails startup on them. A new-consumer test proves rate and concurrency enforcement when limits predate the consumer. The existing API finalization poll now idempotently synchronizes limits from PostgreSQL even when no draining runs remain. A failed synchronization after a terminal commit is logged without failing the transition; the next successful poll restores the catalog default. If Redis metadata is lost while the API remains up, unlimited delivery lasts until that next successful tick: normally one configured poll interval (default five seconds) plus I/O latency once dependencies are reachable. The same serialized owner reads current truth inside each operation, so a stale terminal/poll callback cannot overwrite an accepted successor after its own pre-traffic synchronization. Native pause enforcement also needs limiter metadata; persisted scope cooldowns and durable order deferral still protect recoverability and Retry-After, with possible extra 429 responses and no saturation-induced abandonment.

Installed BullMQ 5.79.1 evidence (`node_modules/.pnpm/bullmq@5.79.1/node_modules/bullmq/dist/esm/`): `classes/queue.js` setters store `max`, `duration`, and `concurrency` in queue metadata. `commands/moveToActive-11.lua` reads global max without requiring `WorkerOptions.limiter`, tests limiter TTL before claiming a job, then independently checks global concurrency. `commands/includes/prepareJobForProcessing.lua` increments the counter and sets expiry only on the first job of a fixed window. Both `classes/queue.js` and `classes/worker.js` implement `rateLimit(ms)` as a limiter-key SET to `Number.MAX_SAFE_INTEGER` with PX expiry; they do not throw or change the current job's state. The ordinary completion path releases active concurrency. Waiting queue jobs need no delayed-job entry, so the zero-delayed assertions remain valid where they describe that behavior rather than application pacing.

Removed-symbol classification: executable worker code and tests no longer contain `nextStartAtMs`, `targetRatePerSecond`, `initialRatePerSecond`, `floorRatePerSecond`, `ceilingRatePerSecond`, `additiveStepPerSecond`, `reductionFactor`, `observationWindowMs`, `rejectionWaveWindowMs`, rate-observation state, reduction generations, or the `pacing` admission denial. `local_admission` is retained: reconciliation, in-flight safety, and bounded scope-state denials still use that persisted vocabulary. No dedicated pacing persistence fields existed, so no migration is needed. Historical tasks 07/09 and superseded D06 text retain historical evidence. Estimator `adaptive_pacing` vocabulary and its assumed ramp remain task 17c's explicit non-goal; task 17b changes only its imported shared engine identity. The web estimate fixture still accepts a historical v1 identity; dashboard/About copy remains out of scope.

The real PostgreSQL/BullMQ throughput regression uses the production one-second recovery timer, the mock's sliding-window limiter, declared capacity 10/s, and backlogs of 5 and 300. Before removal, native queue limits were already supplied by the fixture but both cases produced only 2 first-second confirmations, failing thresholds of 5 and 8 respectively. After removal, both cases meet first-second and whole-drain throughput bounds of 8–10/s with zero 429s and all orders confirmed. Tests also cover native 10/100/250 TPS sliding-window safety, retained limits across consumer replacement, native pause without an exception, API reapplication, and terminal/reset defaults. These are functional integration checks, not reference-runtime measurements.

### Reference-runtime measurements (phase 2, 2026-09-21)

Exactly one run per scenario, in A/B/C/D/surge-10k order. The reference runtime was wiped, seeded and rebuilt with `pnpm runtime:wipe`, `pnpm runtime:setup`, and `pnpm runtime:up`. Each body was validated against the current strict `startDemoRunRequestSchema` locally and again against the built runtime contracts before one authenticated admin-mode `POST /demo/runs/start`. The first four requests use `public-custom` with the task's exact overrides; surge uses the actual seeded preset without overrides. Between runs, the repository's `resetRuntime` client called `/admin/demo/reset` and `/chaos/reset`; all reset responses were HTTP 200. No database mutation, second run, or parameter tuning was used for measurement.

Environment: Docker 29.6.1-1 on Linux/WSL2, 16 visible CPUs, 7,637 MiB RAM, about 1.2 GiB swap already occupied; one worker and standard Compose resource settings. Images were rebuilt from the reviewed working tree based on `064a506a37d9759dc94ab717d7aa19d8f129a9c8`. Isolated test PostgreSQL/Redis were temporarily stopped to reduce pressure, then restored healthy afterward. All reference services stayed healthy with no OOM kills. During surge startup, a Docker sample observed the load orchestrator at 1.925 GiB / 158% CPU and the API at 172% CPU. These are single-machine observations, not final task-20 calibration or confidence bounds.

Seconds below are from `demo_runs.started_at`, matching task 15. The declared ideal rate uses the configured ERP latency alone, without an added worker/persistence overhead floor. In particular the seeded surge is concurrency-limited to `10 / 0.150 = 66.67/s`, not 250/s.

| Scenario | N | Declared r = min(cap, C/L) | Traffic end | Last confirmation | Last notification | Finalized | ERP attempts | Confirmations / notifications | 429 share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: 60 orders, ERP 5/s @200 ms, C=5 | 60 | 5/s | 10.121 | 13.926 | 13.933 | 15.252 | 61 (one 429) | 60 / 60 | 1.6393% |
| B: incident, ERP 10/s @250 ms, C=5 | 888 | 10/s | 60.083 | 95.036 | 95.044 | 96.693 | 888 | 888 / 888 | 0.0000% |
| C: 300 buyers + duplicates, ERP 100/s @50 ms, C=10 | 300 | 100/s | 3.154 | 5.639 | 5.646 | 8.075 | 300 | 300 / 300 | 0.0000% |
| D: 60 orders, ERP 10/s @100 ms, p=0.2, C=5 | 60 | 10/s | 10.100 | 18.170 | 18.178 | 20.894 | 70 (ten 503s) | 60 / 60 | 0.0000% |
| Seeded surge-10k: 1000 orders, ERP 250/s @150 ms, C=10 | 1000 | 66.67/s | 12.969 | 25.978 | 25.984 | 30.319 | 1000 | 1000 / 1000 | 0.0000% |

Every run ended `completed` with traffic `succeeded`, zero failed orders, no unstarted/interrupted HTTP requests, and exact confirmation/notification counts. All five run rows persisted `declared-capacity-erp-dispatch`, version `2`. ERP attempt rows match the cumulative durable attempt counters: 2,308 successes, one capacity rejection, ten recognized availability responses; no retained-history truncation affects these counts.

| Scenario | Run ID | Redis during run: max / duration / concurrency | Redis after terminal |
| --- | --- | --- | --- |
| A | `1ceb48e4-c975-4da1-9a79-b06a55383b5e` | 1 / 211 ms / 5 | 2 / 22 ms / 10 (catalog default) |
| B | `bb43fa55-ea73-4f3e-bb91-f0e25fd910f5` | 1 / 106 ms / 5 | 2 / 22 ms / 10 (catalog default) |
| C | `05be9d1c-58c4-4b5f-8873-53d74ec60634` | 2 / 22 ms / 10 | 2 / 22 ms / 10 (catalog default) |
| D | `9b712286-cd72-40f0-acea-9e23eb18a628` | 1 / 106 ms / 5 | 2 / 22 ms / 10 (catalog default) |
| surge | `4d0a3c0b-a3f9-4475-b3d5-1919ee6088f4` | 5 / 22 ms / 10 | 2 / 22 ms / 10 (catalog default) |

The after-terminal values were observed directly in Redis after PostgreSQL terminality; the measurement polled run state every two seconds. Configured limits were not inferred from source constants.

| Scenario | Confirmations in consecutive 10-second buckets (bucket 0 starts at run acceptance) | ERP status / disposition / HTTP status: count |
| --- | --- | --- |
| A | 41, 19 | `succeeded / succeeded / 200`: 60; `failed / capacity_rejected / 429`: 1 |
| B | 91, 93, 94, 94, 94, 94, 94, 93, 93, 48 | `succeeded / succeeded / 200`: 888 |
| C | 300 | `succeeded / succeeded / 200`: 300 |
| D | 42, 18 | `succeeded / succeeded / 200`: 60; `failed / temporarily_unavailable / 503`: 10 |
| surge | 275, 443, 282 | `succeeded / succeeded / 200`: 1000 |

Acceptance verdicts:

- **Accounting and saturation safety: pass in all five runs.** 2,308 confirmations and notifications, no failed/abandoned orders. A's one 429 completed through durable recovery; D's ten 503s also retained all work.
- **A duration: pass.** Last confirmation 13.926 s, versus roughly 15 s expected and task 15's 55.16 s (41.234 s faster). Finalization was 15.252 s.
- **C duration: pass.** Last confirmation 5.639 s, 2.485 s after traffic ended, versus task 15's 112.46 s (106.821 s faster).
- **Incident accounting and <240 s settlement: pass.** B produced 888/888; last confirmation 95.036 s and finalization 96.693 s. This is 53.764 s faster than the 148.8 s sum-of-phases reference because traffic and ERP work overlap, not an unexplained favorable backlog effect: 560 confirmations were already complete by 60 s. The reference sum is conservative rather than an expected sequential runtime.
- **Stable throughput/pressure at D14 conditions: pass in the measured B window.** Between seconds 10 and 70, 563 confirmations and 563 calls yield 9.383/s and zero 429s, meeting >=8/s and <=5%. Whole-run healthy capacity-response shares are A 1.6393%, B/C/surge 0%. D also has zero 429s, but intentionally injected availability errors.
- **Near-declared ERP-only high-rate envelope: partial, left unchecked.** C completed about 54.94 jobs/s over its active queue span, versus the margin-adjusted ERP-only envelope of 95/s. Surge completed about 42.94/s, versus `min(237.5, 10/0.150) = 66.67/s`. These are approximately 42% and 36% shortfalls. No code was changed or rate tuned to hide them.

The high-rate gap is explained at the observed boundary by full-job service time under native global concurrency: C averaged 177.78 ms per queue job with 9.77/10 active slots, and surge averaged 231.71 ms with 9.95/10 slots. Their ERP calls averaged only 75.89 ms and 167.51 ms respectively; the rest includes durable claims, persistence, notifications/publication and queue completion. Thus `10 / fullJobLatency` predicts ceilings of about 56.25/s and 43.16/s, close to observed active-job rates. This is per-job I/O/processing cost and contention in this environment, not the removed recovery scanner acting as a backlog-size pacing clock. C's first/last 100-confirmation groups accelerated from about 49/s to 69/s; surge's from about 35/s to 47/s as traffic/backlog subsided. B stayed at 93–94 confirmations per complete ten-second bucket through its drain. One run per scenario cannot isolate fixed workflow I/O cost from hardware/load sensitivity; no claim of a pure machine-only cause or universal high-rate guarantee is made. The broader envelope criterion remains for orchestrator disposition; task 17c should use the measured full-job overhead rather than simply `C / ERP latency`.

Evidence is kept outside the repository in `/home/codespace/task17b-evidence/phase2/`: exact validated bodies, each start response/accepted snapshot, run IDs, progress samples, SQL-derived measurement JSON, attempt/bucket counts, raw completed queue-job timing, container samples, build/reset/shutdown logs and targeted validation output. These measurements complete the requested phase, but do not mark the unmet broad high-rate criterion as passed. Next handoff remains [17c — re-fit the estimator to declared-capacity dispatch](17c_refit_estimator_to_declared_capacity.md).

The reference runtime was stopped with `pnpm runtime:down` after evidence collection; its volumes were preserved. Only the isolated PostgreSQL/Redis test containers were restarted, and both are healthy.

### Phase 1 validation

- Biome on all 35 touched TypeScript files: passed, no outstanding fixes. Markdown is outside the configured Biome formatter; its diff was reviewed without imposing line-length limits.
- `pnpm type-check`: passed all 11 workspace tasks and test TypeScript checks.
- `pnpm test:unit`: passed environment safety (7), script tests (54), and all 11 workspace tasks; worker 131, contracts 188, DB 60, mock ERP 64, logger 8, API estimator 8, load orchestrator 178, web 813. The existing non-failing React `act(...)` warning remains unchanged.
- `pnpm test:infra:up`: isolated PostgreSQL and Redis healthy.
- `pnpm test:api --concurrency=1`: passed 50 files / 653 tests; all four workspace tasks successful. The flag is forwarded to Turbo, serializing packages.
- `pnpm test:integration --concurrency=1`: passed all six workspace tasks; worker 10 files / 108 tests, DB 6 files / 83 tests, mock ERP 1 file / 6 tests. Workflow, restart, recovery, and native-limit checks all pass.
- Intermediate failures were resolved: new required-port test doubles and one optional Redis URL caused initial type-check failures; the new reset fixture initially reused a single-connection pool for both its session fence and workflow, causing a timeout; one API expectation hard-coded the superseded engine identity; the old workflow minimum-ERP-arrival-spacing assertion ignored variable database work before HTTP. The corrected workflow checks a full Retry-After pause, one capacity response, exact actual-call totals, and exact confirmed-order totals. Native queue spacing is tested separately against the mock limiter.
- Reference runtime measurement, composition, and characterization were intentionally not run, as required by the phase boundary. No commits or staging.

### Review cycle 1

Finding A replaces one-job windows with bounded native bursts, adds the provisional minimum-window constant and its rounding-loss documentation, and adds both a worst-case sliding-second unit proof and integration throughput floors. Finding B reuses the existing API finalization polling path: no new timer, pending state, or retry mechanism. The terminal writer logs a post-commit synchronization failure and returns the committed result. A real PostgreSQL/Redis regression fails the terminal apply once, verifies the terminal state and stale limits, then calls the production polling path and verifies catalog defaults without another run or restart.

At review cycle 1, reference-runtime acceptance boxes were left unchecked; phase 2 verdicts above now govern them. Prior phase-1 validation above describes the previous iteration. Review-cycle-1 observations are functional isolated-infrastructure tests, not reference-runtime measurements.

| Declared TPS | Native max / duration | Theoretical TPS | Observed TPS | Required floor | Sliding-window rejections |
| --- | --- | --- | --- | --- | --- |
| 10 | 1 / 106 ms | 9.43 | 9.35 | 8 | 0 |
| 100 (also catalog default) | 2 / 22 ms | 90.91 | 88.13 | 80 | 0 |
| 250 | 5 / 22 ms | 227.27 | 221.60 | 200 | 0 |

Review-cycle-1 validation: Biome, full type-check, and full unit suite pass (contracts 192 tests; worker 131). Isolated PostgreSQL/Redis are healthy. The serial API suite passes 50 files / 654 tests, including terminal-update failure healed by the production polling path. Full serial integration passes all six workspace tasks: worker 10 files / 108 tests, DB 6 files / 83 tests, mock ERP 1 file / 6 tests, including both 5/300-order throughput regressions and exact recovery accounting. An initial focused test load caught an extra closing brace introduced while editing the test; it was corrected before these passing checks. The existing non-failing React `act(...)` warning remains; no unrelated issues were changed. Runtime measurements had not yet run at review cycle 1; phase 2 results above are now authoritative. Composition and characterization remain unrun. No staging or commits.

### Review cycle 2 minor corrections and targeted validation

The corrected conservative sliding-second bound is `(floor(1000 / duration) + 2) × max - 1`, yielding 10/93/234 at 10/100/250 declared TPS. BullMQ `prepareJobForProcessing.lua` starts integer-millisecond `PEXPIRE` on the first job only; `getRateLimitTTL.lua` blocks positive TTL and clears a limited key at TTL zero. The leading window can therefore contribute `max - 1` late arrivals after its first arrival has left the sliding second. The deterministic 5/22 ms example dispatches one at 0 ms, four at 21 ms, and five at each 22 ms boundary through 1012 ms: 234 remain in `(12, 1012]`. The mock expires arrivals whose age is >=1000 ms and rejects only when the existing accepted count is already >=maxTps, so exactly ten arrivals are accepted at a ten-TPS limit. Unit tests verify both endpoint behaviors and the corrected bound for 10/100/250 plus catalog; an arithmetic check found no violations for integer capacities 1–250. No limiter configuration changed.

The obsolete application-pacing paragraph in architecture section 4 was replaced with native rate/global concurrency, durable resilience and immediate return to the configured rate. Related outage wording now correctly distinguishes confirmation cooldown checks from queue delivery limits; a docs search found no remaining claim that capacity responses reduce a learned paced rate.

Targeted validation only, as requested: Biome passed the touched TypeScript test; contracts unit tests passed 9 files / 194 tests; full type-check passed 11 workspace tasks plus test types; `git diff --check` passed. Markdown was reviewed without imposed line-length limits. Full unit/API/integration suites were not rerun for these test/documentation-only corrections; their prior review-cycle passes remain recorded above. No composition or characterization suite ran. No staging or commits.
