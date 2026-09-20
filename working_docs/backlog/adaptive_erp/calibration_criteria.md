# D14 Calibration criteria and provisional policy parameters

Recorded by task 01 before any constant is chosen, as required by decision D14 and task 01's calibration-criteria checkbox. Task 20 owns measurement, calibration, and the mandatory explicit user-approval gate; no constant listed here is final before that approval.

## Pre-approved measurable criteria (D14)

| Domain | Target | Measurement basis |
| --- | --- | --- |
| Accounting | Acceptance-matrix totals exact; zero tolerance for duplicates or saturation-induced abandonment. | Durable business totals per scenario in the acceptance matrix (plan section 11). |
| Original incident | 888 confirmations and 888 notifications; settlement under 240 seconds on the documented local reference runtime. | Fixture `original-incident` (`packages/contracts/src/acceptance-fixtures.ts`): 25 req/s, 60 s, 1,500 attempts, stock 888, ERP 10/s at 250 ms, concurrency 5. |
| Stabilized throughput | Long fixture at 10/s ERP capacity, 250 ms latency, concurrency 5: at least 8 confirmations/s after stabilization. | A dedicated long stabilized-throughput calibration fixture with exactly these D14 conditions, supplied by the calibration task (task 20); measured after stabilization over a stable 60 s window. Not covered by the small task 01 fixtures. |
| Stabilized pressure | Same long fixture without injected errors: at most 5% capacity responses over a stable 60 s window. | ERP 429 (`erp_capacity_exceeded`) share of dispatched calls in the stable window of the same task 20 fixture. |
| Outage | After the circuit opens: at most one probe per scope every 5 seconds, excluding already-dispatched calls. | Fixture `finite-outage` profile segment; probe accounting per downstream scope. |
| Estimator | Public presets and the incident fixture admissible; estimate error measured on fixtures and reported without a confidence-interval claim. | Fixture set in `acceptanceScenarioFixtures()`; exact expected counts are the accounting baseline. |

Sanity envelopes before margins (documentation only, not estimator logic): incident conservative base `60 + 888/10 = 148.8 s`; `surge-10k` `120 + 1000/250 = 124 s`. Both must remain admissible after supported calibrated margins.

## Provisional policy parameters (frozen only at task 20)

| Parameter | Domain | Source decision | Current status |
| --- | --- | --- | --- |
| Rate floor, rate ceiling, additive step, multiplicative reduction factor | AIMD launch pacing | D06 | To be calibrated in task 07; provisional until task 20. |
| Observation window and rejection-wave window lengths | AIMD feedback coalescing | D06 | To be calibrated in task 07; provisional until task 20. |
| `Retry-After` policy maximum and capped-cooldown value | Capacity/unavailability cooldowns | D06 | To be calibrated in task 07; provisional until task 20. |
| Outage probe cadence (criterion: at most one per scope per 5 s) | Availability circuit | D06/D14 | Provisional until task 20. |
| Initial, minimum, and maximum request deadline; window size; percentile; factor; margin | Bounded adaptive deadlines | D08 | To be calibrated in task 08; provisional until task 20. |
| 5000 ms deployment ERP latency ceiling (contracts constant bounding accepted latency; the maximum request deadline must cover it plus the margin) | Bounded adaptive deadlines | D08 | Initial value (user decision, 2026-09-20), introduced in task 08; provisional until task 20. |
| 32 retained ERP attempts per order | Bounded attempt history | D09 | Initial constant; provisional until task 20. |
| 600-second inclusive demo-occupancy ceiling (`estimatedDemoOccupancyCeilingSeconds` in `packages/contracts/src/estimate.ts`) | Admission envelope | D11 | Initial value; provisional until task 20. |
| Latency overhead floor; conservative margins for adaptation, persistence, and notification overhead | Estimator envelope | D11 | To be measured in task 14; provisional until task 20. |
| Transient-error demand factor `1/(1-p)` margin and the policy-maximum `p` | Estimator error assumptions | D11 | To be calibrated in task 14; provisional until task 20. |
| Policy and estimator identity versions (`enginePolicyIdentitySchema` names/versions) | Versioning | D13/D12 | Assigned when the owning tasks activate the code they version. |

Calibration may adjust these constants only; it may not change the algorithms, weaken a target, or suppress errors to pass (D14). The throughput and pressure targets pull in opposite directions by design; the task 20 report must explain the chosen trade-off. See [the execution index](index.md) and [task 20](20_calibrate_policy_and_obtain_approval.md) for the approval gate.
