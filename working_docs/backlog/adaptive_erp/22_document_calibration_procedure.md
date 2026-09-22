# 22 — Document a reproducible calibration procedure for the target host

## Handoff

- Status: Done (2026-09-22).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 22 of 23. Execute after [21](21_make_estimator_constants_env_configurable.md); the environment variables it introduces are what this procedure tells the reader to set.
- Source: user decision, 2026-09-22 (see the scope revision in task 20). Replaces the calibration-report deliverable of the original task 20.
- Ownership: one authoritative document under `docs/`, a link from `docs/local_development.md` and `docs/reference_runtime_measurements.md`, and at most a minimal addition to `scripts/runtime-acceptance.mjs` if a required number is not already in its report.

## Why

The estimator defaults were measured on one developer machine. A deployment on different hardware should re-measure them, and the person doing it (a developer or an AI agent unfamiliar with the repository) must be able to follow a procedure end to end without reverse-engineering task documents. The procedure is the durable replacement for the one-off calibration report.

## Deliverable: `docs/estimator_calibration.md`

Write it for someone who has never opened this repository. Required sections, in this order:

1. **What is being calibrated and why it is safe.** The four variables from task 21, one sentence each. State plainly that they only change how pessimistic the admission estimate is: an over-estimate rejects configurations that would have fit under the occupancy ceiling, an under-estimate admits a run that may overstay it and be reset at 900 seconds; neither affects accounting, confirmations or notifications. State that the defaults were calibrated on the host recorded in task 17b (quote it) and that the worker policy constants are not part of this procedure.
2. **Prerequisites.** Linux/Dev Container, Docker, the clean runtime commands (`pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`), one worker, the `ORDER_PROCESS_CONCURRENCY` requirement, and how to record the host (CPU count, memory, cgroup limits; the run report's `generatorCapacity` block already captures part of it).
3. **Measurement runs.** The exact `pnpm runtime:acceptance <scenario> <ignored-output-dir>` invocations, in order, with the fixtures that exercise each allowance: at least `original-incident` (settlement and overlap), `duplicate-attempts` or another short low-latency fixture (per-job overhead at low ERP latency), `surge-10k-preset-reference` (per-job overhead at higher latency and full-concurrency dispatch), and a fixture with injected transient errors for the retry allowance. Say how many repetitions are reasonable (three is enough to see variance; one is not) and that runs are sequential on an otherwise idle machine.
4. **Numbers to read and where.** A table: measured quantity → where it is in the report JSON or which SQL query on `demo_runs`, `orders.confirmed_at`, `simulated_notifications.recorded_at`, `erp_attempts` gives it (reuse the task 17b queries). At minimum: per-job full duration at a given ERP latency, delay between last notification and finalization, `estimateError.estimateToActualRatio`, `stableWindow` throughput and capacity share, and the transient-error scenario's excess attempts versus modelled excess attempts.
5. **From measurements to variables.** One rule per variable, e.g. `ESTIMATOR_JOB_OVERHEAD_MS` ≥ max observed (full job duration − ERP latency) across runs, rounded up; `ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS` ≥ max observed finalization delay plus a stated margin; the demand margin and pause from the retry scenario. Make the direction explicit: **the estimate must stay above every measured actual**; accuracy is secondary to never under-estimating. Report the resulting ratios as empirical observations, never as a confidence interval.
6. **Applying and re-checking.** Set the variables in the deployment's `.env`, restart the API, re-run `original-incident` and the seeded public presets through the preview endpoint, and confirm that all public presets and the incident are still admitted and that every ratio is ≥ 1.
7. **Recording the result.** A short template (host, commit, variables chosen, per-fixture actual/estimate/ratio) to paste into the deployment's own notes. Nothing is committed to this repository from a deployment calibration.

Keep it to what is needed to execute the procedure. Prose about the estimator's model belongs in `docs/architecture.md` or task 23's documentation, not here; link instead.

## Implementation work

- [x] Verify each command and report field named in the document against the current `scripts/runtime-acceptance.mjs`, `package.json` and fixtures before writing it. If a required quantity (for example per-job full duration or finalization delay) is not in the report, add the minimal field to the report rather than asking the reader to compute it from SQL, and cover it in `scripts/runtime-acceptance.test.mjs`.
- [x] Execute the procedure once on the current host as written, to prove it is followable; record the resulting numbers in this task's completion notes, not in `docs/` (the document contains the method and the origin of the defaults, not this host's results).
- [x] Link the document from `docs/local_development.md` and from `docs/reference_runtime_measurements.md`, and reference it from the `.env.example` comment block added by task 21.
- [x] Mark the estimator ratios reported by task 17c/17b as the historical origin of the defaults in `calibration_criteria.md`; that file otherwise stays as the record of the pre-approved targets.

## Non-goals

- Changing the estimator formula, its version, or any default value. If the dry run on the current host suggests different defaults, record the numbers and leave the decision to the project owner.
- A generic benchmarking framework, dashboards or automation beyond the existing acceptance script.
- Calibrating worker policy constants.

## Acceptance and validation

- [x] A reader can go from a clean clone to a set of variable values by following `docs/estimator_calibration.md` alone; the dry run on the current host confirms it.
- [x] Every command and field in the document exists in the repository at the referenced commit.
- [x] If the script was touched: `pnpm exec biome check --write scripts/runtime-acceptance.mjs scripts/runtime-acceptance.test.mjs`, `node --test scripts/runtime-acceptance.test.mjs`, and one real `pnpm runtime:acceptance original-incident <dir>` pass. Markdown and links inspected directly.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Do not run composition/characterization.

## Completion handoff

Record the dry-run host, commit, commands and measured values here, then hand off to [23 — authoritative documentation and closure](23_update_authoritative_docs_and_close_delivery.md).

### Completion notes (dry run, 2026-09-22)

**Deliverables.** `docs/estimator_calibration.md` (new); links from `docs/local_development.md` (configuration table) and `docs/reference_runtime_measurements.md` (persisted diagnostics); `.env.example` and `apps/api/.env.example` comment blocks now name the document; `calibration_criteria.md` marks the task 17b/17c estimator rows as the historical origin of the task 21 defaults.

**Script addition.** `scripts/runtime-acceptance.mjs` gained one descriptive block, `report.calibration`, computed by the exported pure function `calibrationEvidence(durable, jobs, declaredLatencyMs)`: mean/max full queue-job duration and mean overhead beyond the declared ERP latency (BullMQ `processedOn`→`finishedOn`, read from Redis with one `EVAL` over `bull:orders-process:completed` before teardown), the finalization delay after the last notification (`durableEvidence` now also returns `lastNotificationAt` and `finalizedAt`), and `excessAttempts` (ERP attempts minus confirmed orders). Nothing is asserted on it. Covered by a new case in `scripts/runtime-acceptance.test.mjs`. The transient-error scenario reuses the already-supported seeded `admin-failure-path` preset (25% injected errors); no new fixture was added.

**Host and commit.** Dev container on Linux/WSL2 kernel 6.18.33.2, 16 visible CPUs, 8,935 MiB RAM (`free -m`), Docker 29.6.1-1, Node v24.18.0; one worker, `ORDER_PROCESS_CONCURRENCY=10`, `ESTIMATOR_*` at defaults. The load orchestrator's `generatorCapacity` reported 9,369,710,592 bytes total, 4 GiB swap, unlimited cgroup memory and CPU. Commit `060f282e` plus the uncommitted script change of this task (harness SHA-256 `302f258b…`). The isolated test PostgreSQL/Redis stayed up. Runtime rebuilt with `pnpm runtime:wipe`, `pnpm runtime:setup`, `pnpm runtime:up`, `docker compose up -d --wait`, then stopped with `pnpm runtime:down`.

**Measurement runs** (`pnpm runtime:acceptance <scenario> .cache/task22`, sequential, three repetitions in the documented order; all twelve `passed` with `exact-run-teardown-passed`; reports are git-ignored in `.cache/task22/`):

| Scenario | Correlation | actualSeconds | estimate (ratio) | jobs | meanJobMs | meanJobOverheadMs | settlementDelaySeconds | excessAttempts |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| original-incident | `ada4ac5b` | 96.268 | 168.474 (1.750) | 889 | 301.45 | 51.45 | 0.091 | 1 |
| original-incident | `bf0d2075` | 97.590 | 168.474 (1.726) | 888 | 299.68 | 49.68 | 2.571 | 0 |
| original-incident | `7c552519` | 99.052 | 168.474 (1.701) | 888 | 299.68 | 49.68 | 3.906 | 0 |
| duplicate-attempts | `ff5afb8e` | 7.605 | 33.2 (4.366) | 200 | 129.03 | 79.03 | 2.209 | 0 |
| duplicate-attempts | `c8989c7a` | 8.993 | 33.2 (3.692) | 200 | 121.70 | 71.70 | 3.905 | 0 |
| duplicate-attempts | `c45c839f` | 5.376 | 33.2 (6.176) | 200 | 122.69 | 72.69 | 0.283 | 0 |
| surge-10k-preset-reference | `140831be` | 29.523 | 163 (5.521) | 1000 | 261.10 | 111.10 | 1.435 | 0 |
| surge-10k-preset-reference | `c5893a6c` | 26.093 | 163 (6.247) | 1000 | 235.31 | 85.31 | 0.505 | 0 |
| surge-10k-preset-reference | `14304c44` | 32.412 | 163 (5.029) | 1000 | 273.99 | 123.99 | 2.464 | 0 |
| admin-failure-path | `03a4785f` | 80.752 | 179.25 (2.220) | 1161 | n/a | n/a | 4.976 | 55 |
| admin-failure-path | `1b2893d3` | 67.242 | 179.25 (2.666) | 1180 | n/a | n/a | 3.831 | 65 |
| admin-failure-path | `6ae05514` | 98.338 | 179.25 (1.823) | 1603 | n/a | n/a | 3.957 | 55 |

Stable window on the three incident runs: 9.367 / 9.383 / 9.367 confirmations per second, 0% capacity responses, `covered=true`. The `admin-failure-path` job timing is not a per-order cost (recovery re-publications after 503s inflate the job count), which the document states; its excess attempts (55–65) stay below the 120 modelled with the default 1.25 margin.

**Applying the section 5 rules to this host** gives job overhead ≥ 123.99 → 130 ms (unchanged default), settlement ≥ 4.976 + 5 → 10 s (default 15 s is more pessimistic and kept), demand margin 1.25 (unchanged), pause 1 s (mock `Retry-After: 1`). No default changes are proposed; the decision stays with the project owner per the non-goals.

**Re-check (section 6)** with the defaults in place, `pnpm runtime:acceptance <scenario> .cache/task22-recheck`, once each; all previews `admitted`, all runs `passed`:

| Scenario | actualSeconds | estimateSeconds | ratio |
| --- | ---: | ---: | ---: |
| original-incident | 98.301 | 168.474 | 1.714 |
| preview-1k | 9.480 | 55.5 | 5.854 |
| surge-5k | 21.314 | 118.4375 | 5.557 |
| surge-10k-preset-reference | 27.597 | 163 | 5.906 |
| idempotency-check-200 | 8.567 | 33.2 | 3.875 |
| public-custom | 5.293 | 29.6 | 5.592 |

One discrepancy found and fixed while executing the document: the host record lives at `detail.loadRunDiagnosticsSummary.generatorCapacity`, not under `detail.summary`.

**Review corrections (post dry run).** The prerequisites now require `pnpm --filter @checkout-surge/contracts build` after `pnpm install` (the acceptance script imports the git-ignored `packages/contracts/dist`, which a clean clone does not have). Section 5 states that a report's `estimateError` is fixed at run time, so ratios with the chosen values only come from the section 6 re-run; that re-run now also includes `admin-failure-path`, the only fixture exercising the retry allowances (not part of the re-check table above, which predates the addition; the measurement runs already cover it with the defaults in place). The document no longer quotes this host's run durations, only a generic time budget.

**Validation.** `pnpm exec biome check --write scripts/runtime-acceptance.mjs scripts/runtime-acceptance.test.mjs` (clean), `node --test scripts/runtime-acceptance.test.mjs` (4 passing), and the eighteen real `pnpm runtime:acceptance` runs above (including `original-incident`). No TypeScript file was touched, so `pnpm type-check` was not rerun. Composition/characterization not run. Markdown links inspected by hand.
