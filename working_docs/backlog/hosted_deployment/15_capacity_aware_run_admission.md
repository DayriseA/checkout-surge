# 15 — Capacity-Aware Run Admission

**Design:** sections 1.2, 2.3 · **Depends on:** 13c

## Goal

A run is admitted only when it is expected to complete, or, for the owner, after a warning and a confirmation. Visitors can use what the hardware sustains, and the demo explains why a run would fail.

## Scope

- **Default VU allocation** for constant arrival: today pre-allocated = rate and max = 2 × rate (`resolveConstantArrivalVus`), which drops iterations at 1,000 per second while the hosted core sustains about 3,000 (HD-53). Check the effect on local runs (more VUs means more memory and more open connections on the workstation).
- **Feasibility model.** Classify a run as expected to complete, at the limit, or expected to fail, from what actually exhausts VUs:
  - the rate against a per-deployment capacity, separately for the two connection modes (new connection per buyer, reused connections);
  - the duration, which matters only above that capacity (the backlog grows every second);
  - the VUs available;
  - the starting stock, if measurements show it matters (owner's past local experience suggests it does): measure its effect on latency and capacity and explain the mechanism (writes per accepted order against cheap sold-out answers).
  - ERP settings do not hold VUs; they only stretch the drain and the occupancy, which the estimator already bounds.
- **Behavior.** Public custom runs: only runs expected to complete are accepted, with a clear message otherwise. Admin runs: a warning and a confirmation, never a refusal, so the owner can push to failure on purpose.
- **Capacity per deployment.** A configuration value per deployment (hosted measured on Fly with the 13a method; local to be measured), not a hard-coded constant.
- **Then raise the public limits** from the admin console, measured on Fly.
- **Optional:** the conservative occupancy estimate is 1.7 to 4 times the actual duration, which blocks the next run longer than needed.
- **Visitor-facing explanations.** Enrich the informative sections of the demo with what 13a and this task found: the single API process's capacity, buyer spike against constant arrival (new against reused connections), why a slow ERP fills the queue without slowing purchases, and what makes a run fail. Figures come from measurements; the text explains the mechanisms.

## Out of Scope

- A multi-process API (HD-51).

## Done When

- The model, its thresholds and messages are settled with the owner and implemented.
- Public limits are raised to measured values, and the visitor-facing explanations are updated.

## Open Points

- The model's shape, the thresholds ("complete" alone, or also a latency bound), and the messages: settled with the owner when the task starts.

## Inputs from Task 13a

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

## Working Notes

_None yet._
