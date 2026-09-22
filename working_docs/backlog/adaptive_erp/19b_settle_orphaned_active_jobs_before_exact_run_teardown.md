# 19b — Settle orphaned active queue jobs before exact-run teardown

## Handoff

- Status: Done on 2026-09-21 (harness-side fix only; see the completion notes below). [Task 20](20_calibrate_policy_and_obtain_approval.md) can rerun the restart scenario.
- Ownership: verification harness (`scripts/runtime-acceptance.mjs`, `scripts/runtime-smoke.mjs` teardown helpers) first; the API generated-run teardown boundary only if the harness cannot settle the race on its own. Worker recovery policy is not in scope.
- Origin: observed by [task 19a](19a_fix_recovery_publication_lease_starvation.md) on 2026-09-21 while rerunning `original-incident-restart`. It is a harness/cleanup defect, not an application accounting failure.

## Observed failure

First `original-incident-restart` run after the 19a fix, disposable Compose runtime `checkout-surge-gpt-55`, run `090eb1a4-c225-4096-b9c3-a46bd0e54bcb`:

- Every verification assertion passed: 1500 attempts, 888 reservations, 612 sold-out, 888 ledger results, 888 confirmed orders, 888 notifications, 0 outstanding, 0 unresolved; the run reached `completed` at 22:52:39 UTC (153.882 s).
- Exact-run teardown then failed three times, ending 22:52:47, with HTTP 409 `run_cleanup_conflict` / `active_job`: "has active work on orders:process; retry after it settles". The verifier recorded `status: failed` and left the completed run in the runtime.
- The blocking jobs were three initial deliveries (BullMQ job ID = order ID) left in the `active` list by the worker `SIGKILL` at about acceptance +65 s. Their orders had already been confirmed through recovery re-claims, so the jobs were terminal-order zombies. BullMQ's stalled-job handling (worker defaults: `stalledInterval` 30 s, `maxStalledCount` 1) moved them out of `active` at 22:52:54, seven seconds after the last teardown attempt; they completed as terminal acknowledgements.
- The immediate rerun passed (149.016 s), so the failure is timing-dependent.

## Cause

Three facts combine:

1. `GeneratedRunTeardownService` calls `queueMaintenance.cleanRuns([runId])` without a settlement deadline, so any `active` job attributed to the run is an immediate conflict (`apps/api/src/services/generated-run-teardown-service.ts`). The admin reset path passes a bounded settlement window instead (`admin-demo-reset-service.ts`).
2. `cleanExactJobs` treats every `active` job attributed to the run as live work, including a job whose order is already terminal (`apps/api/src/queue/bullmq-demo-queue-maintenance.ts`).
3. `teardownWithRetry` makes three attempts within a few seconds, far shorter than BullMQ's stalled-job detection after a killed worker (`scripts/runtime-smoke.mjs`).

## Implementation requirements and guardrails

- Prefer a harness-side fix: after a scenario that kills the worker, the verifier must wait, bounded by its cleanup deadline, until the queue holds no `active` job attributed to the run before calling teardown, or extend `teardownWithRetry` for `active_job` conflicts with a bounded poll that at least covers stalled-job detection. Either way the wait is explicit, logged, and never longer than the cleanup deadline.
- Do not weaken protection of live work: teardown must still refuse a run with an `active` job whose order is nonterminal. If the API boundary is changed, an `active` job may be treated as settled only when its order is durably `confirmed` or `failed`, and reset behavior (`admin_reset` history line, terminal fence) must stay unchanged.
- Do not change worker stalled-job settings, lock durations, recovery leases or the 19a scanner decision to make cleanup faster.
- Cleanup can never turn a failed verification into a pass, and a verification whose assertions passed must not be reported failed solely because cleanup raced stalled-job detection: keep the two outcomes distinguishable in the report (verification status vs cleanup status) if they are not already.
- Minimal, surgical diff; English only; apply `AGENTS.md` and `docs/quality_checklists.md`.

## Regression and acceptance

- [x] Unit test for the harness change in `scripts/runtime-smoke.test.mjs` or `scripts/runtime-acceptance.test.mjs` with injected clock/fetch: an `active_job` 409 that clears within the deadline leads to a successful teardown; one that persists past the deadline still fails cleanup.
- [x] If the API boundary changes: a service test in `apps/api/test/` proving an `active` job for a terminal order no longer blocks teardown while one for a nonterminal order still does. (Not applicable: the API boundary was not changed.)
- [x] `pnpm runtime:acceptance original-incident-restart .cache/task19b` passes three consecutive times with exact-run teardown, on an exclusively owned disposable runtime with the 19a worker deployed.
- [x] Remove the orphaned completed run `090eb1a4-c225-4096-b9c3-a46bd0e54bcb` from the disposable runtime if it is still present (or wipe the runtime), and note it in the handoff.
- [x] Record the fix, tests, commands and actual results here and in the task 19 recap.

## Completion notes (2026-09-21)

### Fix (harness only)

- `scripts/runtime-smoke.mjs`: `requestJson` now attaches `status` and the parsed `payload` to the error it throws for non-OK responses (message unchanged). `teardownWithRetry` treats an HTTP 409 whose `details.conflictReason` is `active_job` as a settlement wait instead of a failed attempt: it polls the same DELETE about once per second, bounded by `deadlineAt` (or a fixed 60 s when the caller passes none), logs the wait once when it starts, and fails cleanup with the deadline error plus the last conflict if the jobs never settle. Any other failure keeps the previous three-attempt behaviour, and the diagnostics still count every request made (for example "Teardown failed after 7 attempts").
- `scripts/runtime-acceptance.mjs`: the exact-run cleanup deadline is raised from 30 s to 60 s so the wait covers two BullMQ stalled-job intervals. `report.status` / `report.cleanup` handling is unchanged: a cleanup failure still marks the report failed and stays distinguishable through `report.cleanup`.
- `docs/local_development.md`: the smoke cleanup paragraph documents the active-job wait, since the routine smoke shares `teardownWithRetry` (its own 30 s cleanup budget is unchanged).
- Not changed: `apps/api` teardown/queue maintenance, worker stalled-job settings, lock durations, recovery leases, the 19a scanner decision, `prepareExactRunCleanup`.

### Tests

`scripts/runtime-smoke.test.mjs` gained: repeated `active_job` conflicts (4) followed by success resolve with the validated response and 1 s pauses; a persistent conflict stops at the injected deadline (2.5 s explicit and the 60 s default) with no request after it and an error naming the deadline and the conflict; an ordinary failure (409 other reason or 503) after active-job conflicts still gets exactly three attempts. Existing assertions unchanged.

### Commands and results

```bash
pnpm exec biome check --write scripts/runtime-smoke.mjs scripts/runtime-smoke.test.mjs scripts/runtime-acceptance.mjs   # passed, no fixes
node --test scripts/runtime-smoke.test.mjs scripts/runtime-acceptance.test.mjs                                          # 30 passed
pnpm type-check                                                                                                          # passed
pnpm runtime:wipe && pnpm runtime:setup && pnpm runtime:up                                                               # fresh checkout-surge-gpt-55 (orphaned run 090eb1a4 removed with the volumes)
pnpm runtime:acceptance original-incident-restart .cache/task19b                                                         # x3, sequential
```

Three consecutive `original-incident-restart` runs on the wiped disposable runtime `checkout-surge-gpt-55` with the current worker and harness: run `22b27c39` passed, 149.05 s; run `e53ef0b8` passed, 148.87 s; run `514158ee` passed, 133.868 s. All three reported `cleanup: exact-run-teardown-passed` with 888/888/888 reservations/confirmed/notifications and 0 outstanding. Run 3 reproduced the race: worker killed at 23:54:01 UTC, run `completed` at 23:55:10, `Exact-run teardown waiting for active jobs of run 514158ee-… to settle (up to 59908 ms)` logged, teardown succeeded at 23:55:35 (about 25 s after completion, about 94 s after the kill). Under the previous three-attempt teardown this run would have been recorded failed. Runs 1 and 2 did not hit the conflict. Evidence is in the ignored `.cache/task19b` directory; the runtime was left up and healthy with no run remaining.
