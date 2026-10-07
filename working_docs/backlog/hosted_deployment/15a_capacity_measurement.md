# 15a — Capacity Measurement

**Design:** section 1.2 · **Depends on:** 13c

## Goal

Each deployment's capacity is measured for both connection modes, the effect of stock is measured and explained, and a committed script lets anyone re-measure.

## Scope

- **Measurement script** (owner decision, 2026-10-08).
  - A small committed script starts a series of admin runs from given settings: mode, rate or buyers, duration, stock, VUs, ERP settings.
  - It waits for each run to end and reads the evidence each run already persists: dropped iterations, latency, arrival summary, generator utilisation, server reservation timing.
  - Node builtins only, so it also runs inside the hosted API container, where the control token stays on the Machine (13a method).
  - Core CPU and connection sampling (13a method) stays outside the script unless it is trivial to add.
  - Document the method in `docs/`, next to related material such as `docs/estimator_calibration.md`.
  - Write and check the script without heavy runs on the owner's workstation, which lacks the resources.
- **Stock effect** (owner decision, 2026-10-08). Find the break point at two extremes, then check mixes:
  1. **All sold out** (minimal stock): confirm the 13a figures with the script, once per mode.
  2. **All accepted** (stock at least the number of requests): bisect the rate as in 13a, with short runs (about 10 s) and the stock following the rate. Set the ERP to its fastest (concurrency 10, low latency, high TPS) so that draining the queue fits the 600 s estimate ceiling.
  3. **Mixes:** one or two, including stock 1,000 (the public maximum). Check that a simple additive model (the cost of accepted orders plus the cost of sold-out answers) predicts them. Add stock levels only if it does not.
  - Explain the mechanism from the code path and the measurements.
- **Per mode:** the constant-arrival capacity C (reused connections), the buyer-spike capacity C' (a new connection per buyer), and the latency near saturation. That latency sets the VU latency budget, since the VUs needed are about the rate times the latency.
- **Where.**
  - **Fly:** runs are driven by a subagent from the owner's workstation, on the live deployment, so visitors see "a run is in progress" meanwhile. Admin runs set explicit VUs, so that the current default allocation does not bias the results.
  - **Local:** the owner runs these in cloud sessions, each with its own VM, in parallel. The supervisor prepares the prompts, and the owner pastes the results back. Record each VM's CPU and memory; the local default comes from this measurement (owner decision).
- **Results.**
  - Record them in `docs/reference_runtime_measurements.md`, for hosted and local.
  - In the working notes below, propose for each deployment: C, C', the latency budget, and whether stock enters the model.
  - The same file says visitors see the explanatory estimate. No component renders it, so correct the doc (owner decision, 2026-10-08: do not display it).

## Out of Scope

- Admission code and VU allocation (15b), public limits and visitor explanations (15c).

## Done When

- The script and its method are committed.
- C, C' and the latency budget are measured on Fly and on a cloud VM, and the stock effect is measured and explained.
- The proposed values are in the working notes, ready for 15b.

## Open Points

- None.

## Inputs from Preparation (2026-10-08)

- **13a measured mostly sold-out answers.** Its capacity runs used 500 stock, so about 98 % of their requests were sold-out answers.
- **Accepted order** (`reserve-order-service.ts`), done synchronously before the API answers:
  - one Redis Lua call;
  - a reserved Postgres connection with a shared advisory lock;
  - one transaction (reservation, order, two order events);
  - a BullMQ job;
  - a Redis promote eval.
  - The API Postgres pool max is 10 (`apps/api/src/runtime/config.ts`), not overridden on Fly.
- **Sold-out answer:** the entry checks, then one counter HINCRBY and one HSET. No Postgres, no BullMQ.
- **Admin runs** have stock and ERP uncapped. The estimator (600 s ceiling) applies to every run, admin included, so a large stock needs a fast ERP.
- **Buyer spike:** VUs equal the buyers, so VUs cannot run out. The safety cutoff (k6 `maxDuration`) bounds the run.
- **Tooling.** `pnpm runtime:acceptance` starts runs through the admin API, but its fixtures are fixed (no rate, VU or stock parameter). 13a's scratch scripts were not committed.

## Inputs from Task 13a

- **Break point.**
  - Over reused connections (constant arrival), the hosted core answers about 3,200 requests per second, bounded by the single API process. 10 s runs were complete at 3,125 per second (twice), and at 3,500 per second all 10,000 VUs were in flight and iterations were dropped.
  - New connections per request (buyer spike) are answered at about 1,000 per second.
  - VU exhaustion breaks first: no failed request, timeout or connection error at any rate tried, up to 5,000 per second.
- **Connection modes.**
  - A buyer spike opens one connection per buyer (`per-vu-iterations`, one VU per buyer).
  - Constant arrival reuses each VU's connection, so the open connections equal the VUs in flight (10,004 at the cap).
- **Default VU allocation.**
  - `resolveConstantArrivalVus` (`packages/contracts/src/load.ts`): pre-allocated = rate, max = 2 × rate, capped at 10,000 (`maximumAutomaticallyDerivedVUs`). It applies whenever `k6Vus` is absent, which is always the case from the public form.
  - At 1,000 per second, the start latency transient (1 to 2 s) exhausts it: about 1 % dropped. 5,000 pre-allocated VUs kept runs complete up to 2,000 per second, and 10,000 up to 3,125.
  - Rule of thumb from the runs: the VUs needed equal the rate times the latency, and the latency climbs to about 3 s near saturation.
- **Generator memory.** About 225 kB per k6 VU; 2.8 to 3.0 GB at 10,000 VUs on the 16 GB runner.
- **ERP settings do not hold VUs.** A VU is released when the API answers the buy request, at reservation time. ERP latency and rate only stretch the asynchronous drain (worker and queue), not the traffic phase.
- **Latency.** 10 s runs at 1,000, 1,500 and 2,000 per second with enough VUs: p95 3.8, 5.2 and 8.3 s. At 2,750 and 3,125 per second: 11.8 to 12.8 s.

## Working Notes

_None yet._
