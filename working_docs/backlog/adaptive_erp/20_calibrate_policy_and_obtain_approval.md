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

Use the selected clean development runtime under the [current runtime and evidence rules](index.md#common-guardrails-and-reporting); the reference runtime may be wiped and reused. Document the current machine and effective configuration. The original machine and its stored data are not prerequisites, and historical measurements do not establish performance on a new host. Keep all numeric targets unchanged and report limitations or failures against them.

## Repository entry points

The declared-capacity queue dispatch from task 17b, the retained protection/deadline policy from tasks 07–09, the API estimator and margins from tasks 15–16 as revised by 17c, task 19's explicit verification command and fixtures, `docs/reference_runtime_measurements.md`, and `docs/local_development.md`. Produce `working_docs/adaptive_erp_calibration_report.md` as evidence; it is not another numbered implementation task.

## Implementation work

- [ ] Capture environment: commit, OS/container topology, relevant CPU/memory limits, one-worker configuration, service/tool versions, effective deployment caps and verification invocation. Record whether this reproduces the documented local reference environment.
- [ ] Record exact fixture inputs, seeds, condition changes applied, expected/actual counts, elapsed acceptance-to-settlement timing, start/traffic/drain timings and cleanup outcome. Use fresh run identities and the `original-incident` fixture; historical stored rows are not required. Export evidence before reset/teardown and retain failed/inconclusive results independently of disposable runtime data.
- [ ] Define stabilization/window measurement consistently before comparing candidates. Count capacity responses against actual capacity-consuming calls, with replay/lookup distinctions and already-dispatched outage calls explicitly accounted for. Do not cherry-pick quiet windows or suppress errors to pass.
- [ ] Measure the full target table, restart safety and estimate error using task 19's evidence. Report unsuccessful/inconclusive runs as such, including environment limitations; an eventual finish with excessive pressure fails.
- [ ] Resolve task [17c](17c_refit_estimator_to_declared_capacity.md)'s open acceptance criterion (estimates "no longer several times larger" than measurements; carried over by user decision, 2026-09-21). Estimator v2 gives 2.47x, 1.74x, 3.77x, 3.28x and 5.38x for task 17b's scenarios A, B, C, D and `surge-10k`. The sequential traffic + ERP sum is a minor contributor: `max(traffic, ERP)` would only move C from 30.4 s to about 25 s, D from 68.6 s to about 58.6 s and `surge-10k` from 163 s to about 135 s. The ratios come from three allowances, to be re-fitted here with repeated measurements rather than task 17b's single run per scenario: the fixed 15 s settlement overhead (finalization trailed the last notification by 1.3 to 4.3 s in task 17b, which dominates runs of 8 to 30 s); the full buyer-spike `maxDurationSeconds` budget (`surge-10k` reserves 120 s, its traffic ended at 13 s once stock sold out); and the transient-error allowance (demand margin 1.25 plus 1 s per excess attempt; scenario D had ten 503s against 33.75 modelled excess attempts). Stay above every measurement. Re-fitting the constants is in scope; replacing the traffic budget with a sell-out model or the sum with an overlap changes D11's envelope and needs the separate decision recorded in [carried-over follow-up 6](carried_over_follow_ups.md).
- [ ] Adjust only policy constants: the margin below declared ERP capacity and the limiter granularity (revised D06, task 17b), bounded backoff/cooldown/probe settings, deadline window/percentile/factor/margin/bounds, retention constant if justified, and estimator overhead/error support/margins. Preserve declared-capacity dispatch, terminal-only ledger, conservative envelope, lifecycle, admission boundary and every numeric acceptance target.
- [x] Not applicable since the 2026-09-21 revision of D06: the idle-window rate step deferred by tasks 07 and 09 disappeared with the learned rate removed in task 17b.
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

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check touched supported files with Biome; inspect Markdown/links directly if ignored. Use Linux/Dev Container and the selected clean runtime; preserve recorded evidence, not disposable database contents. Report all actual/skipped checks. No unrelated optimization or production-readiness claim.

## Completion handoff

Deliver the measured constants/report and record the approval gate honestly. Only after explicit approval, hand off the approved evidence to [21 — authoritative documentation and closure](21_update_authoritative_docs_and_close_delivery.md).
