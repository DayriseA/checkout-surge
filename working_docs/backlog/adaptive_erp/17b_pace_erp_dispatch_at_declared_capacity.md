# 17b — Pace ERP dispatch at the declared capacity with the queue's native rate limit

## Handoff

- Status: Pending.
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
- Dispatch must be evenly spaced, not bursty. The mock ERP counts accepted arrivals over a sliding 1-second window (`apps/mock-erp/src/application/tps-limiter.ts`), so a coarse "N per 1000 ms" window that releases N jobs at once and N more just after the boundary gets rejected. Choose the limiter granularity accordingly and prove it with a test against the mock's limiter.
- A small safety margin below the declared capacity is the only pacing constant. Keep it provisional until task 20 and record it in [calibration criteria](calibration_criteria.md).
- A `429` pauses delivery natively for the `Retry-After` duration (existing parsing, capped maximum and fallback unchanged) and never fails or abandons an order. The order that received the `429` keeps today's durable deferral: that path, resumed by the recovery scanner within a second, is fine for a rare event. It is no longer used as the pacing clock.
- Availability handling keeps its semantics: unavailability, connection errors and timeouts feed the circuit only; probes are the only traffic while it is open, at most one per scope every 5 seconds. Pausing delivery natively during an availability backoff is allowed if it preserves the probe rule and reduces churn, but it is not required.
- Request deadlines (D08), bounded attempt history (D09), reconciliation (D05), terminal technical failures (D03) and the durable claim, generation fencing and publication fence (D04) are out of scope and must keep passing their tests.
- Decide which process applies the limits and keep a single owner. Applying them where the run is accepted, before traffic starts, avoids a window where the first jobs are delivered unlimited; the pacing constant must still be defined once, next to the engine-policy identity in contracts. After a worker or API restart the limits must be re-applied from the accepted snapshot (revised D07), and they must return to the catalog default when the run becomes terminal or is reset.

## Repository entry points

`apps/worker/src/application/adaptive-erp-admission-policy.ts` (rate, observation windows, `nextStartAtMs`, pacing deferral: to remove; cooldown, circuit, in-flight and deadline parts: to keep), `apps/worker/src/application/order-process-admission.ts`, `apps/worker/src/application/erp-reconciliation.ts` (durable deferral), `apps/worker/src/application/order-process-job-handler.ts`, `apps/worker/src/queue/bullmq-order-process-consumer.ts`, `apps/worker/src/application/order-recovery-scanner.ts`, `apps/worker/src/index.ts`, `apps/api/src/queue/bullmq-order-process-job-publisher.ts`, `apps/api/src/services/demo-run-service.ts` and the terminal-transition and reset services if the API owns the limits, `packages/contracts/src/processing-control.ts` (engine-policy identity), `apps/worker/test/integration/bullmq-order-process-admission.test.ts`, and the completion notes of tasks 05, 07 and 09.

## Implementation work

- [ ] Write first a throughput test that fails on the current code: real queue on the isolated test Redis, a stub ERP with a declared capacity, a backlog, and an assertion that confirmations per second track the declared capacity from the start and do not depend on backlog size (5 orders and 300 orders drain at the same rate).
- [ ] Apply the queue rate limit and global concurrency from the accepted run snapshot, with the single owner chosen above; re-apply on restart; return to the catalog default at run terminality and reset.
- [ ] Pause delivery natively on a capacity response for the `Retry-After` duration; keep the durable deferral of the affected order.
- [ ] Remove the learned-rate machinery and everything only it needed: rate state, observation and rejection-wave windows, additive step, reduction factor, floor, ceiling, `nextStartAtMs`, the pacing denial reason and its waiting-reason vocabulary if nothing else uses it, their persistence fields if any, and their tests. Keep the file focused on what remains (cooldown, availability circuit, in-flight safety, deadlines) and rename it if its name becomes misleading.
- [ ] Update the shared engine-policy identity so that the name and version persisted with each run truthfully describe the new policy. `demo_runs.engine_policy_name` and `engine_policy_version` are text columns, so no migration is expected.
- [ ] Extend the tests: evenly spaced dispatch stays within the mock's sliding window at 10/s, 100/s and 250/s declared; a single `429` pauses delivery for `Retry-After` and throughput returns to the declared rate immediately afterwards; a restart re-applies the limits; limits return to the default after a terminal run and after a reset; exact accounting is unchanged in the existing workflow, restart and recovery suites.
- [ ] Measure on the reference runtime. User decision (2026-09-21, index guardrails): it may be wiped and used as the isolated clean runtime (`pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`; stop it afterwards). Replay the four task 15 scenarios with the request bodies in "Measurement requests" below, plus the seeded `surge-10k` preset, and record the same table as task 15 with confirmations per 10-second window and the share of `429` responses. One run per scenario is enough; this dev container has limited RAM and CPU, so report the numbers as measured and tune nothing to reach a figure.
- [ ] Update `docs/architecture.md` and any other authoritative document that describes AIMD pacing, and this backlog's index.

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

- [ ] The throughput test fails before the change and passes after it. With available work and a healthy ERP, confirmations per second are close to `min(declared capacity less the margin, concurrency / latency)` from the first seconds, independent of backlog size.
- [ ] A healthy steady run produces at most 5% capacity responses (D14 pressure target) and no order is failed or abandoned because of saturation.
- [ ] Measured on the reference runtime: the 60-order scenario at 5/s finishes in roughly 15 s and the 300-buyer spike at 100/s in a few seconds after traffic ends, instead of 55 s and 112 s; the incident yields 888 confirmations and 888 notifications near `60 + 888/10 = 149 s` and under 240 s. If a gap remains, quantify it and say whether it follows backlog size (code) or machine load (environment).
- [ ] No learned-rate code, constant or test remains; a repository search for the removed symbols is classified in the completion notes.
- [ ] Run Biome on touched files, `pnpm type-check`, `pnpm test:unit`, `pnpm test:infra:up`, `pnpm test:api` and `pnpm test:integration` (use `--concurrency=1`: the DB dirty-signal Pub/Sub test is flaky when packages run in parallel). Do not run `pnpm test:composition` or `pnpm test:characterization`.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). All artifacts in English. Report executed and skipped checks honestly. If the queue's native limits turn out to be incompatible with a guarantee listed under "What stays", stop and hand off with the evidence instead of rebuilding a custom pacing mechanism.

## Completion handoff

Deliver the native rate limiting, the removal of the learned-rate machinery, the tests and the measurements. Record the limit owner, the limiter granularity and margin chosen, the catalog default, the restart and terminal behaviour, the measured table, and the removed symbols. Next: [17c — re-fit the estimator to declared-capacity dispatch](17c_refit_estimator_to_declared_capacity.md).
