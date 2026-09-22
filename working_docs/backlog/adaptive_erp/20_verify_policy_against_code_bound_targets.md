# 20 — Verify the policy against code-bound targets

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 20 of 23. Execute after [19](19_complete_acceptance_matrix_and_runtime_verification.md), [19a](19a_fix_recovery_publication_lease_starvation.md) and [19b](19b_settle_orphaned_active_jobs_before_exact_run_teardown.md); `pnpm runtime:acceptance` and its fixtures must be available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7, D06, D08, D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: one verification pass of the worker policy on a clean runtime and a short evidence recap. No code change is expected; a failure becomes a follow-up fix task, not a tuning exercise.

## Scope revision (user decision, 2026-09-22)

This task replaces the original "calibrate policy constants and obtain explicit approval" task. The project owner decided that:

- Fitting constants to one developer machine has no value: nobody knows the hardware the repository will be deployed on. Host-dependent constants become environment-configurable in [task 21](21_make_estimator_constants_env_configurable.md), and [task 22](22_document_calibration_procedure.md) documents how to re-measure them on a target host.
- The mandatory formal approval gate and the calibration report are dropped. A recap of the changes, validation results and any remaining issues is sufficient for routine task handoff. Any separately required owner decisions still apply. D14's "calibration may adjust constants only" rule stays as a guardrail; D14's report/approval mechanism is superseded.
- This task keeps only the targets that test the **code** — the dispatch, protection and settlement logic against a mock ERP whose capacity and latency are simulated — and are therefore expected to hold on any host that is not itself the bottleneck.

## Targets to verify

| Domain | Target | Evidence source |
| --- | --- | --- |
| Accounting | Exact acceptance-matrix totals; zero duplicate effects/notifications; zero saturation-induced abandonment | `assertAcceptance` in `scripts/runtime-acceptance.mjs` on every scenario run |
| Original incident | 888 confirmations and 888 notifications | `original-incident` fixture |
| Stabilized throughput | ERP 10/s, latency 250 ms, concurrency 5: at least 8 confirmations/s after stabilization | `original-incident` (888 orders at about 9.5/s give a drain longer than the 60-second window); confirmations per window in the run report |
| Stabilized pressure | Same fixture, no injected errors: at most 5% capacity (`429`) responses over a stable 60-second window, counted against capacity-consuming calls only | `capacityResponseShare` in the same run report |
| Outage | After the circuit opens, at most one probe per scope per 5 seconds, excluding already-dispatched calls | `finite-outage` fixture; `probeEvidence` assertion |
| Restart safety | Killing the worker mid-run loses no accepted work and settles exactly | `original-incident-restart` fixture |
| Admission | All public presets and the incident remain admissible under the current estimator | Preview/start on the seeded presets |

Not targets here (host-bound, moved to task 22 as measurements to record): the 240-second incident settlement time, the estimator's empirical error ratios, and the throughput/pressure trade-off explanation. The script's existing `< 240 s` incident assertion stays as a coarse sanity bound; if it fails on a clearly slower host while accounting is exact, report it as an environment limitation rather than a policy failure.

## Implementation work

- [ ] Wipe and rebuild the clean development runtime per the [runtime and evidence rules](index.md#common-guardrails-and-reporting). Record commit, host topology (CPU, memory, container limits), one-worker configuration and tool versions once, at the top of the recap.
- [ ] Run `pnpm runtime:acceptance <scenario> <ignored-output-dir>` for each fixture in the table above, sequentially, with fresh run identities. Export the reports before teardown.
- [ ] Fill a pass/fail line per target with the measured value and the report file it came from. An inconclusive run is reported as inconclusive, never re-run until it passes.
- [ ] If a target fails, do not tune constants to make it pass: open a follow-up task (`20a_…`) describing the failure and its evidence, as 19a and 19b did.
- [ ] Record the recap in this document's completion section. No separate calibration report file.

## Non-goals

- Changing any constant in `apps/worker/src/application/erp-resilience-policy.ts`, `packages/contracts/src/processing-control.ts` or `apps/api/src/services/demo-duration-estimator.ts`. Worker policy constants stay hardcoded and versioned (`declared-capacity-erp-dispatch` v2); estimator constants are handled by task 21.
- Repeated-measurement fitting, confidence claims or a production benchmark.
- Resolving [carried-over follow-up 6](carried_over_follow_ups.md) (D11 envelope shape). It remains an open owner decision.

## Acceptance and validation

- [ ] Every target in the table has a measured value and a pass/fail/inconclusive status backed by an exported report.
- [ ] Full-matrix accounting is exact on every run.
- [ ] `pnpm type-check`, `pnpm test:infra:up` and `pnpm test` pass on the verified commit (no code change expected; if a follow-up fix was needed, its task records its own checks).

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Use Linux/Dev Container and the selected clean runtime; do not run composition/characterization. Report all actual/skipped checks.

## Completion handoff

Record the environment, the per-target table and the report locations here, then hand off to [21 — make estimator constants environment-configurable](21_make_estimator_constants_env_configurable.md).
