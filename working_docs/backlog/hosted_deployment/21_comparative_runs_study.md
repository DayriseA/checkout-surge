# 21 — Comparative Runs Study

**Design:** none · **Depends on:** 15d

## Goal

The owner can decide, with measured numbers, whether to build live comparative runs: the same traffic against the system without its Redis layer and queue, then with them.

## Context

- Owner idea (2026-10-08): on a few fixed presets, show live why an in-memory decision layer and asynchronous processing matter. First run the traffic against a system without them, then the same traffic against the demo's system.
- **The baseline must be credible.** It is the same system with the Redis layer and the queue removed:
  - the stock is decided in PostgreSQL by an atomic conditional update;
  - the ERP is called inside the buyer's request.
  
  A strawman would undo the demonstration for an informed reviewer.
- Implementing the comparison is a separate project after this backlog. This task is only the study.

## Scope

- **Design the baseline path.** Say where it would live (a run mode in the API), and why it is a fair "without" design.
- **Measure the gap** with a throwaway prototype or a benchmark on a cloud VM, on two or three fixed presets. Do it both with the ERP's latency and with the ERP removed, so the share of each layer is known.
- **Estimate the work:**
  - the run mode;
  - the presets;
  - chaining the two runs;
  - a side-by-side report;
  - the texts;
  - the tests.
- **Report to the owner** for a go or no-go.

## Out of Scope

- Building the feature.

## Done When

- The owner has the design, the measured gap and the estimate, and has decided.

## Open Points

- None.

## Working Notes

### Study (2026-10-08, cloud VM: 4 vCPU Xeon 2.8 GHz, 16 GB, k6 on the same VM)

- **Prototype** on `tmp/21-baseline-prototype` (throwaway, never merged): `API_BUY_PATH_MODE=baseline`. One PostgreSQL conditional update decides the stock and creates the reservation and order; the ERP is called inside the buyer's request, paced at the declared ERP rate × 0.95, with no lock or connection held during the call; a second statement confirms the order. Same HTTP answers, pool of 10.
- **Measured** (median of 2 runs; "no ERP" = mock ERP at 0 ms and 1,000 TPS):

| Preset | Demo + ERP | Baseline + ERP | Demo, no ERP | Baseline, no ERP |
|---|---|---|---|---|
| Surge 5k: accepted p95 / every buyer answered | 6.9 s / 9.1 s | 26.8 s / 28.5 s | 6.6 s / 10.1 s | 3.3 s / 6.2 s |
| Slow ERP (5 TPS): complete runs, failed requests | 2/2, 0 | 0/2, 220 timed out at 60 s | 2/2, 0 | 2/2, 0 |
| 300/s × 10 s, stock 1,000, ERP 20 TPS: complete runs | 2/2 | 0/2, 250 interrupted | 2/2 | 2/2 |

- **Probe** (2,500/s × 10 s, stock 1, no ERP; neither complete): demo about 1,460–1,520 answers/s with PostgreSQL CPU 7–9 %; baseline about 1,180–1,390/s with PostgreSQL CPU 50–63 %. The single API process was at 86–99 % in both.

### Arbitration (2026-10-09)

- **Measurements sound:** the branch's analysis script reproduces every table from the raw files. Two runs per cell, modes run in blocks, CPU sampled every 2 s.
- **The queue result is solid:** gaps of 5 to 10 times, in every repetition. In Slow ERP without the queue, 220 of 500 winners failed at 60 s, yet all 500 orders were confirmed later. Nothing crashed and the ERP was not flooded (its rate was respected): the buyer pays for the back office's slowness.
- **Redis gives no speed gap at this scale.**
  - The single API process is the bottleneck (about 0.6 ms per answer against 0.2–0.4 ms of store work).
  - A sold-out answer costs PostgreSQL little: an update matching no row writes nothing. It costs about 0.37 ms of PostgreSQL CPU against 0.17 ms in Redis; the Lua script runs about 20 commands.
  - The pool of 10 caps PostgreSQL's concurrency.
  - Winners pay Redis plus the same PostgreSQL work in the demo.
- **The baseline was unfair to winners:** it skipped idempotency, the run fence, the bookkeeping rows and the live counters (about 2 commits per order against about 6 in the demo). Its faster winners in the no-ERP cells measure the cost of the demo's safety work, not Redis against PostgreSQL. For turned-away buyers the comparison was fair, and the gaps are within the noise.
- **What Redis buys, measured:** it keeps turned-away buyers off the database (PostgreSQL at 7–9 % against 50–63 % for the same answers). A speed gap needs the database to be the bottleneck: several API processes, a remote database, or a database busy with other work.
- **Probe rate:** about 1,500/s against about 3,000/s in 15a. Part is the metric: the study divides by the time to k6's exit, and 15a by the dispatch window only, which gives 2,519–2,589/s here. Part is a slower host of the same class as 15a's VM B. The instrumentation does not explain it.
- **Published claims** that these results contradict or do not support (corrected in 16b):
  - `apps/web/src/app/page.tsx` around lines 216 and 222;
  - `working_docs/project_description.md` lines 15, 37 and 39;
  - `working_docs/delivery_constraints.md` line 10.

### Owner decision (2026-10-09)

- **No comparative feature in this backlog.** It becomes a separate, later project, designed after this backlog. Owner's outline:
  - **Equal protections on both sides:** idempotency, run fence, bookkeeping.
  - **A queue in PostgreSQL for the version without Redis**, so that only Redis differs.
  - **The database at a realistic distance:** a separate machine or simulated network latency, with Redis at the same distance.
  - **Connection limits** used only if needed, and stated openly in the narrative as a simulation of the real-world scale.
  - **Two or three API processes** (HD-51), enough to reach the Redis script's ceiling, an estimate of about 5,000–6,000 sold-out answers per second on one core. A bigger load generator, and a recalibrated capacity model.
  - **A mode without the order queue**, to show that the buyer pays for the back office's slowness.
- **Now:** the narrative is aligned with what the demo shows, in 16b. That covers the Redis claims and a "known limits and planned work" section at the very end of the overview page.
- Done.
