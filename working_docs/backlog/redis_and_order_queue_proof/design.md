# Redis and Order Queue Proof — Working Design

Working design for the project that adds live comparative runs to Checkout-Surge. It records what is known and decided so far (2026-10-09). Open points are listed in section 7 and are not decided.

## 1. Purpose

Show visitors, on one or two fixed presets, what two architectural choices of the demo buy, measured live on the same hardware:

- **The order queue.** An accepted order is handed to a queue, and the worker sends it to the ERP at the ERP's pace. Without it, the buyer waits for the back office before hearing "you got it".
- **The Redis layer.** Redis decides the stock and answers turned-away buyers without touching PostgreSQL, and it holds the order queue. Without it, PostgreSQL does both.

The comparison must be fair enough to convince an informed reviewer. A strawman baseline would undo the demonstration.

## 2. Starting Point: the 2026-10-08 Study

A cloud session measured a throwaway baseline against the demo system. The prototype, run lists, raw results and analysis are on the branch `tmp/21-baseline-prototype`. Keep that branch until this project ends.

### 2.1 Setup

- **Host:** 4 vCPU Xeon 2.8 GHz, 16 GB, with k6 on the same VM. Median of 2 runs per cell.
- **Baseline:** `API_BUY_PATH_MODE=baseline`.
  - One PostgreSQL conditional update decided the stock and created the reservation and the order.
  - The ERP was called inside the buyer's request, paced at the declared ERP rate × 0.95, with no lock or connection held during the call. A second statement confirmed the order.
  - Same HTTP answers, pool of 10 connections.
- **"No ERP"** means the mock ERP at 0 ms and 1,000 TPS.

### 2.2 Results

| Preset | Demo + ERP | Baseline + ERP | Demo, no ERP | Baseline, no ERP |
|---|---|---|---|---|
| Surge 5k: accepted p95 / every buyer answered | 6.9 s / 9.1 s | 26.8 s / 28.5 s | 6.6 s / 10.1 s | 3.3 s / 6.2 s |
| Slow ERP (5 TPS): complete runs, failed requests | 2/2, 0 | 0/2, 220 timed out at 60 s | 2/2, 0 | 2/2, 0 |
| 300/s × 10 s, stock 1,000, ERP 20 TPS: complete runs | 2/2 | 0/2, 250 interrupted | 2/2 | 2/2 |

**Probe** (2,500/s × 10 s, stock 1, no ERP). Neither system was complete, and the single API process was at 86–99 % in both.

| | Answers per second | PostgreSQL CPU |
|---|---|---|
| Demo | about 1,460–1,520 | 7–9 % |
| Baseline | about 1,180–1,390 | 50–63 % |

### 2.3 What the arbitration established (2026-10-09)

- **The measurements are sound.** The analysis script reproduces every table from the raw files. Caveats: two runs per cell, modes run in blocks, CPU sampled every 2 s.
- **The order queue makes a large, repeatable difference.** The gaps are 5 to 10 times, in every repetition.
  - In Slow ERP without the queue, 220 of 500 winners failed at 60 s, yet all 500 orders were confirmed later.
  - Nothing crashed, and the ERP was not flooded, because its rate was respected. The buyer pays for the back office's slowness. That is the honest claim, not "the system crashes".
- **Redis gives no speed gain at the current scale.**
  - The single API process is the bottleneck: about 0.6 ms per answer, against 0.2–0.4 ms of store work.
  - A sold-out answer costs PostgreSQL little. An update that matches no row writes nothing: about 0.37 ms of PostgreSQL CPU, against 0.17 ms in Redis, whose Lua script runs about 20 commands.
  - The pool of 10 connections caps PostgreSQL's concurrency.
  - Winners pay Redis plus the same PostgreSQL work.
- **The baseline was unfair to winners.** It skipped idempotency, the run fence, the bookkeeping rows and the live counters: about 2 commits per order, against about 6 in the demo. Its faster winners measure the cost of the demo's safety work, not Redis against PostgreSQL. For turned-away buyers the comparison was fair, and the gaps were within the noise.
- **What Redis measurably buys:** it keeps turned-away buyers off the database (7–9 % against 50–63 % for the same answers). A speed gap needs the database to be the bottleneck:
  - several API processes sharing one database;
  - a database at a network distance with a bounded connection pool (a pool of 10 with 5 ms round trips gives about 2,000 statements per second);
  - a database busy with other work.
- **Redis has its own ceiling:** one thread. With the current Lua script it is estimated at 5,000–6,000 sold-out answers per second on one core. This is not measured.
- **Prototype defects** that a real build must avoid:
  - no deadline on the ERP retry loop;
  - an ERP 4xx error leaves the order in `processing`;
  - a stock table created at runtime and never torn down;
  - a confirmed order answered as `queued`;
  - no idempotency.

## 3. Owner Decisions (2026-10-09)

- **Separate project.** It is not part of the hosted deployment backlog, and it starts when that backlog is done. Meanwhile, the hosted demo's texts are aligned with what it shows today: the claims about Redis are reworded, and a short "known limits" section closes the overview page.
- **A fair comparison.** Every mode has the same protections: idempotency, the run fence and the bookkeeping. The version without Redis keeps an order queue, in PostgreSQL, so that only Redis differs.
- **A realistic distance.** PostgreSQL sits at a realistic network distance, as in production, and Redis at the same distance. This can be a separate machine or a simulated network latency (section 7).
- **Connection limits** are tightened only if needed. If they are, the narrative says so openly, as a simulation of the real-world scale that the demo stands for.
- **Several API processes**, two or three, enough to reach the Redis script's ceiling. This replaces HD-51 and touches every single-process assumption (HD-11).
- **A mode without the order queue**, to show that the buyer pays for the back office's slowness.
- **One or two fixed presets only.** The comparative modes are offered only through presets tuned until they show the point. They are never available in custom runs, public or admin. Calibration is limited to those presets, and the admission estimator needs no model of the comparative modes.
- **A feasibility checkpoint.** Before building the feature, prototypes find a configuration that shows the point. The work then stops for the owner's go or no-go.
- **Autonomous work** (section 6). An AI agent runs the project on the owner's laptop, on its own branches and in its own Fly.io environment. The owner joins near the end for the final review.

## 4. Modes

| Mode | Stock decision and sold-out answers | Order queue | ERP call |
|---|---|---|---|
| Demo (today) | Redis | Redis (BullMQ) | Worker, after the answer |
| Without Redis | PostgreSQL | PostgreSQL | Worker, after the answer |
| Without the order queue | Redis | None | Inside the buyer's request, paced at the ERP's rate |

- Every mode has the same protections and the same HTTP answers. One exception: without the order queue, the accepted answer is given after the ERP confirms, and must say so.
- A mode is a property of the run, set only by a comparative preset.

## 5. Fairness Rules

- Same hardware, same presets, same API processes, same connection pools, and the same network distance to every store.
- Same protections, the same durable record before "yes", and the same order lifecycle and teardown.
- Each comparison is measured repeatedly, with the modes interleaved rather than in blocks, and the spread is reported.
- Any simulated constraint (latency, a smaller pool) is stated in the visitor-facing text.

## 6. Environment and Autonomous Work

- **Where:** the owner's laptop, where `flyctl` is logged in with the owner's full account. Isolation therefore rests on rules and on a check in code, not on the token.
- **Fly.io:**
  - Only the owner's `playground` organization (confirm its slug with `flyctl orgs list`).
  - Never touch the production apps `checkout-surge-core`, `checkout-surge-runner` and `checkout-surge-gate`, or any app outside `playground`.
  - Every `flyctl` or Machines API call names its app or organization explicitly.
  - The proof environment's deploy tooling checks, before any change, that the target app belongs to `playground`, and refuses otherwise.
- **Secrets:** generated for the proof environment. Never read or reuse the production secrets (`infra/fly/core/core-secrets.env`).
- **Git:**
  - Work on the project's own branches. Never push to `dev` or `main`, and never merge into them.
  - Merge `dev` into the project's branches regularly.
  - The CI deploy runs only on a push to `main`, so these branches never deploy production.
- **Costs:** Machines are stopped or destroyed when not in use. The agent records its spending in the task notes and stops if it nears the owner's budget (section 7).
- **Decisions:** the agent records each choice and its reason in the task notes. A choice that changes the owner's decisions above, the fairness rules, or production is not taken alone: it goes to the owner's review list in the README.
- **Stop and report:**
  - any action that would touch production;
  - the budget limit;
  - the feasibility checkpoint;
  - a result that puts the project itself in question.

## 7. Open Points

- **Distance:**
  - separate machines for PostgreSQL and Redis, or a simulated latency on the core;
  - which round-trip time stands for "production" (same data center, or across zones).
- **Production topology:** whether the production demo moves to several API processes and remote stores for every run, or only for comparative runs, and what that costs per month.
- **Presets:**
  - what the presets show: response times, turned-away buyers answered per second, database load, or several of these;
  - whether they are public or admin-only;
  - how two chained runs fit the run slot, the 600 s occupancy ceiling and the automatic reset.
- **Run history:** how runs that fail by design (the mode without the order queue) read, without polluting public aggregates or capacity calibration.
- **Redis script:** whether to slim the stock Lua script to raise Redis's ceiling.
- **Load generator:** the runner size needed beyond 2,500 requests per second (it peaked at 90 % CPU there).
- **Budget:** the owner's spending limit for the proof environment.
