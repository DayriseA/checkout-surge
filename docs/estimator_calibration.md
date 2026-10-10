# Estimator Calibration Procedure

How to re-measure the four host-dependent allowances of the demo duration estimator on the host that will run Checkout-Surge, and how to turn the measurements into environment variables. It assumes no prior knowledge of the repository. The estimator's model itself is described in [The Buy Path](architecture.md#the-buy-path) (search for `sequential duration envelope`); this page only covers measuring its allowances.

## 1. What is calibrated and why it is safe

The API reads four variables at startup (see the [configuration reference](local_development.md#configuration-reference)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ESTIMATOR_JOB_OVERHEAD_MS` | `130` | Time a worker spends on one order beyond the declared ERP latency (queue claim, persistence, notification, job completion). |
| `ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS` | `15` | Delay between the last notification of a run and the run being finalized. |
| `ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN` | `1.25` | Multiplier on the `1/(1-p)` retry demand when the declared ERP error rate `p` is above zero. |
| `ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS` | `1` | Pause charged per retried ERP attempt; the mock ERP answers injected errors with `Retry-After: 1`. |

These values only change how pessimistic the admission estimate is. An over-estimate rejects configurations that would have fit under the 600-second occupancy ceiling; an under-estimate admits a run that may overstay it and be automatically reset at 900 seconds. Neither affects accounting, ERP confirmations or notifications. The defaults were measured on Docker 29.6.1-1 on Linux/WSL2, with 16 visible CPUs, 7,637 MiB RAM and about 1.2 GiB of swap already occupied, one worker and standard Compose resource settings.

Worker policy constants (dispatch margin, cooldowns, probes, deadlines) are versioned in code and are not part of this procedure. The estimator formula and the 30% supported error-rate bound are not changed by calibration either.

## 2. Prerequisites

- Linux or the repository's Dev Container, Docker with Compose v2, Node.js and pnpm as described in [Local Development](local_development.md#prerequisites), `pnpm install` done, and the shared contracts built once with `pnpm --filter @checkout-surge/contracts build` (the acceptance script imports `packages/contracts/dist`, which is git-ignored and not built by `pnpm install`).
- A `.env` at the repository root (`cp .env.example .env`). Leave the `ESTIMATOR_*` lines at their defaults for the measurement runs: the report compares the default estimate with the actual duration, and the rule in section 5 does not depend on the current values.
- Exactly one worker (the Compose default) with `ORDER_PROCESS_CONCURRENCY` at its default of `10`, the shared per-run hard cap. The worker refuses to start below it.
- A clean reference runtime. Its data is disposable; from the repository root:

  ```bash
  pnpm runtime:wipe
  pnpm runtime:setup
  pnpm runtime:up
  node scripts/run-with-env.mjs docker compose up -d --wait
  ```

- Nothing else running on the machine during the runs: no tests, builds, or other Compose projects (the isolated test PostgreSQL/Redis may stay up if memory allows; `pnpm test:infra:down` stops them otherwise).
- Record the host once before measuring: `nproc`, `free -m`, `docker info --format '{{.NCPU}} CPUs, {{.MemTotal}} bytes'`, OS/kernel and Docker version, and any cgroup limits applied to the containers. Each run report also stores the load orchestrator's own view under `detail.loadRunDiagnosticsSummary.generatorCapacity` (memory total/available, cgroup memory and CPU limits).

## 3. Measurement runs

Each run is one command that previews the estimate, starts the run, waits for settlement, reads durable evidence from PostgreSQL and Redis, tears the run down and writes one JSON report to the output directory:

```bash
pnpm runtime:acceptance <scenario> <output-directory>
```

The output directory is only where the report lands; `.cache/calibration` is a convenient git-ignored choice. The command exits nonzero if accounting is not exact; a failed report is not a calibration sample.

Run these scenarios sequentially, three times each, in this order. One repetition cannot show variance; three is enough to see it.

| Scenario | Allowance exercised | Configuration |
| --- | --- | --- |
| `original-incident` | Settlement; job overhead under declared-capacity dispatch with traffic and processing overlapping | 25 req/s for 60 s, stock 888, ERP 10/s at 250 ms, concurrency 5 |
| `duplicate-attempts` | Job overhead at low ERP latency | 200 buyers, stock 200, ERP 200/s at 50 ms, concurrency 5 |
| `concurrency-saturation-reference` | Job overhead at higher latency with all concurrency slots busy | A 10,000-buyer configuration, frozen for calibration: 10,000 buyers, stock 1,000, ERP 250/s at 150 ms, concurrency 10 |
| `admin-failure-path` | Retry demand margin and excess-attempt pause | Seeded admin preset: 15 req/s for 12 s, stock 200, ERP 30/s at 300 ms, 25% injected transient errors, concurrency 4 |

Each run lasts from a few seconds to under two minutes plus teardown; budget about 15 minutes for the twelve runs.

## 4. Numbers to read and where

All quantities are in the report JSON (`<scenario>-acceptance-<uuid>.json`). Paths are JSON paths from the report root; `latencyMs` is `run.configSnapshot.erpConfig.latencyMs`.

| Measured quantity | Where |
| --- | --- |
| Actual run duration, acceptance to finalization (s) | `estimateError.actualSeconds` |
| Default estimate (s) and its ratio to the actual | `estimateError.estimateSeconds`, `estimateError.estimateToActualRatio` |
| Mean full job duration (ms) and mean overhead beyond `latencyMs` | `calibration.meanJobMs`, `calibration.meanJobOverheadMs` (`orders.processing_at` to `confirmed_at` or `failed_at` over the `calibration.jobs` settled orders; `calibration.maxJobMs` is the slowest single order). They come from PostgreSQL because finalization removes the run's completed jobs from Redis. These order timestamps sit inside the job, so they leave out the job's pickup and acknowledgment; with one job per order, that is the job's service time. Only meaningful for the fixtures without injected errors: in `admin-failure-path`, each recovery execution moves `processing_at` forward, so a retried order counts only its last execution and the mean is neither a per-order nor a per-job cost. |
| Delay between the last notification and finalization (s) | `calibration.settlementDelaySeconds` (`durable.finalizedAt` minus `durable.lastNotificationAt`) |
| Stable-window throughput and capacity share (`original-incident`) | `stableWindow.confirmationsPerSecond`, `stableWindow.capacityResponseShare`; valid when `stableWindow.covered` is `true` |
| ERP attempts beyond one per confirmed order (`admin-failure-path`) | `calibration.excessAttempts` (`durable.attempts` length minus `durable.confirmed`) |
| Host view of the load generator | `detail.loadRunDiagnosticsSummary.generatorCapacity` |

The same numbers can be recomputed from the reference database while the run's rows are still present (they are purged by the teardown at the end of each command): `demo_runs.started_at` / `finalized_at`, `orders.processing_at` / `confirmed_at`, `simulated_notifications.recorded_at` and `erp_attempts.status` per `run_id`. The report is the primary source; the SQL is only a cross-check.

## 5. From measurements to variables

The direction is fixed: **the estimate must stay above every measured actual**. Accuracy is secondary to never under-estimating. Apply one rule per variable, using the values from all repetitions:

| Variable | Rule |
| --- | --- |
| `ESTIMATOR_JOB_OVERHEAD_MS` | At least the largest `calibration.meanJobOverheadMs` across the `duplicate-attempts`, `concurrency-saturation-reference` and `original-incident` runs, rounded up to the next 10 ms. Means, not `maxJobMs`: the estimator models throughput (`concurrency / (latency + overhead)`), and a single slow job does not lower a run's throughput by its own excess. |
| `ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS` | At least the largest `calibration.settlementDelaySeconds` across all runs plus a margin of one finalization poll interval (`DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS`, default 5 s), rounded up to a whole second. |
| `ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN` | The estimator plans `orders / (1 - p) × margin` ERP attempts. For `admin-failure-path` (`orders = 180`, `p = 0.25`) the default `1.25` plans 300 attempts, that is 120 modelled excess attempts against an unmargined expectation of 60. Choose the smallest margin (at least `1`) such that `180 / 0.75 × margin - 180` is at least the largest observed `calibration.excessAttempts`; keep `1.25` unless a run exceeds 120. |
| `ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS` | The pause the real ERP imposes after a transient error, in seconds. With the mock ERP it is `1` (`Retry-After: 1`); a deployment pointing the worker at another ERP uses that ERP's documented retry pause. |

Then check the whole. The `estimateError` block of a report is fixed at run time, so the estimate with the chosen values is only obtained by re-running the scenarios with those values in place (section 6); every resulting `estimateError.estimateToActualRatio` must be at least 1. Report the ratios as empirical observations on this host and these fixtures, never as a confidence interval.

If the numbers suggest values lower than the defaults, keep the defaults unless the deployment is rejecting configurations it needs; a more pessimistic estimate is the safe side.

## 6. Applying and re-checking

1. Set the four variables in the deployment's `.env` (they are passed to the API container by `docker-compose.yml`).
2. Recreate the API so it reads them: `pnpm runtime:up` (or `node scripts/run-with-env.mjs docker compose up -d api`).
3. Re-run the incident, the seeded public presets and the transient-error scenario once each; every command previews the estimate through `POST /demo/runs/estimate` and fails if the preview is not `admitted`:

   ```bash
   for scenario in original-incident preview-1k surge-5k surge-10k slow-erp-5k laggy-erp-5k concurrency-saturation-reference idempotency-check-200 public-custom admin-failure-path; do
     pnpm runtime:acceptance "$scenario" .cache/calibration-recheck || break
   done
   ```

4. Confirm in each report that `estimate.result.decision` is `admitted` and `estimateError.estimateToActualRatio` is at least 1. A ratio below 1 means an allowance is still too small: raise it and repeat from step 1.
5. Stop the runtime when done: `pnpm runtime:down`.

## 7. Recording the result

Paste the following into the deployment's own notes. Nothing from a deployment calibration is committed to this repository.

```text
Estimator calibration — <deployment name>
Host: <CPU count, memory, OS/kernel, Docker version, cgroup limits>
Commit: <git rev-parse HEAD>
Worker: one worker, ORDER_PROCESS_CONCURRENCY=<value>
Variables chosen:
  ESTIMATOR_JOB_OVERHEAD_MS=<ms>
  ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS=<s>
  ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN=<factor>
  ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS=<s>

Measurement runs (defaults in place):
| Scenario | Run | actualSeconds | meanJobOverheadMs | settlementDelaySeconds | excessAttempts |
| ... | 1..3 | | | | |

Re-check (chosen values in place):
| Scenario | actualSeconds | estimateSeconds | ratio |
| original-incident | | | |
| preview-1k | | | |
| surge-5k | | | |
| surge-10k | | | |
| slow-erp-5k | | | |
| laggy-erp-5k | | | |
| concurrency-saturation-reference | | | |
| idempotency-check-200 | | | |
| public-custom | | | |
| admin-failure-path | | | |
```
