# 20 — Calibrate policy constants and obtain explicit approval

## Handoff

- Status: Pending. This task contains a mandatory human approval gate.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 20 of 21. Execute after [19](19_complete_acceptance_matrix_and_runtime_verification.md); the complete acceptance matrix and isolated verification tooling must be available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7, D06, D08, D09, D11 and especially D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: bounded worker/estimator constant calibration and reproducible evidence. Structural algorithm/product decisions remain locked.

## Objective and non-negotiable targets

Freeze policy constants only after measurement against the pre-approved criteria below and explicit user approval. Passing functional tests does not by itself approve constants. No implementation agent may mark this task complete, advance to task 21 or advertise the full guarantee while approval is outstanding.

| Domain | Required target |
| --- | --- |
| Accounting | Exact acceptance-matrix totals; zero tolerance for duplicate effects/notifications or saturation-induced abandonment |
| Original incident | 888 confirmations and 888 notifications; settlement under 240 seconds on the documented local reference runtime |
| Stabilized throughput | Long fixture with ERP 10/s, latency 250 ms, concurrency 5: at least 8 confirmations/s after stabilization |
| Stabilized pressure | Same fixture without injected errors: at most 5% capacity responses over a stable 60-second window |
| Outage | After circuit opening, at most one probe per scope per 5 seconds, excluding already-dispatched calls |
| Estimator | All public presets and the incident remain admissible; empirical estimate error measured and reported without claiming a confidence interval |

Use an isolated runtime configured like the documented local reference; do not treat the user's active reference instance as permission to run destructive experiments.

## Repository entry points

The versioned worker engine/deadline policy from tasks 07–09, the API estimator and margins from tasks 15–16, task 19's explicit verification command and fixtures, `docs/reference_runtime_measurements.md`, and `docs/local_development.md`. Produce `working_docs/adaptive_erp_calibration_report.md` as evidence; it is not another numbered implementation task.

## Implementation work

- [ ] Capture environment: commit, OS/container topology, relevant CPU/memory limits, one-worker configuration, service/tool versions, effective deployment caps and verification invocation. Record whether this reproduces the documented local reference environment.
- [ ] Record exact fixture inputs, seeds, condition changes applied, expected/actual counts, elapsed acceptance-to-settlement timing, start/traffic/drain timings and cleanup outcome. Use new isolated run identities, never edit the incident records.
- [ ] Define stabilization/window measurement consistently before comparing candidates. Count capacity responses against actual capacity-consuming calls, with replay/lookup distinctions and already-dispatched outage calls explicitly accounted for. Do not cherry-pick quiet windows or suppress errors to pass.
- [ ] Measure the full target table, restart safety and estimate error using task 19's evidence. Report unsuccessful/inconclusive runs as such, including environment limitations; an eventual finish with excessive pressure fails.
- [ ] Adjust only policy constants: rate floor/ceiling/start/step/reduction and windows, bounded backoff/cooldown/probe settings, deadline window/percentile/factor/margin/bounds, retention constant if justified, and estimator overhead/error support/margins. Preserve AIMD, terminal-only ledger, conservative envelope, lifecycle, admission boundary and every numeric acceptance target.
- [ ] Resolve the idle-window behavior that tasks 07 and 09 deliberately deferred here and recorded in [09](09_wire_adaptive_runtime_and_restart_safety.md): the stable observation window measures elapsed time, so the first useful success after a long quiet period still earns one additive rate step. Decide from the measured pressure targets whether the window must instead require actual activity, and treat any change beyond constants as a structural decision needing separate explicit approval.
- [ ] Explain the throughput-versus-pressure trade-off and why chosen constants satisfy both, plus limits of observed estimator accuracy. Check deadline maximum remains at least deployment maximum ERP latency plus margin and retained history preserves protected evidence.
- [ ] Assign/freeze explicit engine and estimator versions, update affected fixtures/configuration references, and rerun relevant deterministic/boundary regressions after the final candidate. Ensure accepted-run evidence records the exact versions being measured.
- [ ] Publish the report with chosen constants, measured value and pass/fail per target, raw evidence references, commands, limitations and approval status. Request the user's explicit approval of this exact report/version set.

## Approval and completion rules

If any target fails, keep the task incomplete and report the evidence. Do not weaken a target, change algorithms, reject the incident to hide failure, lower the public burst, or call a configuration approved because it is recommended. A structural change needs a separate explicit user decision.

After submitting a passing candidate, mark the handoff as awaiting user approval and stop the sequential workflow. Task 21 stays blocked. Once the user explicitly approves, record the approval reference/date and exact approved versions/constants; do not invent or infer approval. Changing those constants after approval requires renewed evidence/approval.

## Acceptance and validation

- [ ] Every target has reproducible measured evidence and passes with the same proposed versions/constants; full matrix accounting remains exact.
- [ ] Report distinguishes local evidence from hosted production benchmarks and empirical error from a statistical guarantee.
- [ ] Focused policy/estimator tests, `pnpm type-check` and affected unit/API/integration lanes pass after final tuning. Use `pnpm test:infra:up` for isolated infrastructure and the explicit long verification command, not composition/characterization.
- [ ] The user has explicitly approved the report's frozen constants and versions. Without this item, this task is not complete even when all technical checks pass.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check touched supported files with Biome; inspect Markdown/links directly if ignored. Use Linux/Dev Container and isolated resources; preserve the reference runtime and incident. Report all actual/skipped checks. No unrelated optimization or production-readiness claim.

## Completion handoff

Deliver the measured constants/report and record the approval gate honestly. Only after explicit approval, hand off the approved evidence to [21 — authoritative documentation and closure](21_update_authoritative_docs_and_close_delivery.md).
