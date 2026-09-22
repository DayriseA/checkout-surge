# 22 — Document a reproducible calibration procedure for the target host

## Handoff

- Status: Pending.
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

- [ ] Verify each command and report field named in the document against the current `scripts/runtime-acceptance.mjs`, `package.json` and fixtures before writing it. If a required quantity (for example per-job full duration or finalization delay) is not in the report, add the minimal field to the report rather than asking the reader to compute it from SQL, and cover it in `scripts/runtime-acceptance.test.mjs`.
- [ ] Execute the procedure once on the current host as written, to prove it is followable; record the resulting numbers in this task's completion notes, not in `docs/` (the document contains the method and the origin of the defaults, not this host's results).
- [ ] Link the document from `docs/local_development.md` and from `docs/reference_runtime_measurements.md`, and reference it from the `.env.example` comment block added by task 21.
- [ ] Mark the estimator ratios reported by task 17c/17b as the historical origin of the defaults in `calibration_criteria.md`; that file otherwise stays as the record of the pre-approved targets.

## Non-goals

- Changing the estimator formula, its version, or any default value. If the dry run on the current host suggests different defaults, record the numbers and leave the decision to the project owner.
- A generic benchmarking framework, dashboards or automation beyond the existing acceptance script.
- Calibrating worker policy constants.

## Acceptance and validation

- [ ] A reader can go from a clean clone to a set of variable values by following `docs/estimator_calibration.md` alone; the dry run on the current host confirms it.
- [ ] Every command and field in the document exists in the repository at the referenced commit.
- [ ] If the script was touched: `pnpm exec biome check --write scripts/runtime-acceptance.mjs scripts/runtime-acceptance.test.mjs`, `node --test scripts/runtime-acceptance.test.mjs`, and one real `pnpm runtime:acceptance original-incident <dir>` pass. Markdown and links inspected directly.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Do not run composition/characterization.

## Completion handoff

Record the dry-run host, commit, commands and measured values here, then hand off to [23 — authoritative documentation and closure](23_update_authoritative_docs_and_close_delivery.md).
