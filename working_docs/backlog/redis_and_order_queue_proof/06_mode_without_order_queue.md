# 06 — Mode Without the Order Queue

**Design:** sections 4, 5 · **Depends on:** 02, after the owner's go

## Goal

A run can call the ERP inside the buyer's request, paced at the ERP's rate, so that a visitor sees the buyer paying for the back office's slowness.

## Scope

- The ERP call inside the request has a deadline, stops on a reset, and never leaves an order stuck when the ERP fails.
- The accepted answer is given after the ERP confirms, and says so.
- The same protections as the demo's mode.

## Done When

- A run in this mode behaves as designed under a slow ERP, covered by tests.

## Open Points

- None.

## Working Notes

### Buyer latency evidence foundation (2026-10-11)

Task 06 first prepares accepted and sold-out HTTP reply wall latency evidence before inline confirmation or hosted calibration. The load generator measures the complete `http.post` call after preparing its body and options. It retains existing valid queued `202` replies and recognizes `200` only with the `order_confirmed` outcome. The API's inline-confirmation workflow is a later implementation slice; this foundation does not add that response to the API.

Each nonempty exported cohort carries count, average and p95 through the existing HTTP summary JSON. Accepted reply counts include successful idempotent repeats. An empty or unusable cohort stays unknown. A complete exported Trend whose count agrees with its selected outcome counter remains usable despite stdout or live dashboard loss; exact native raw-proof reconciliation is a separate campaign gate. No live latency semantics, extra throughput fields, or database columns change.

The pinned k6 2.0.0 binary must demonstrate exported Trend `count` and empty-cohort behavior before hosted calibration. A generated-script unit harness verifies classification and measurement wiring, not actual k6 aggregation behavior. The API persistence assertion is deferred to the later Task 06 integration slice because the completion/finalization test paths are frozen under the independent Task 05 review; existing persistence forwards the shared HTTP summary object intact.

Local validation used the existing Dev Container, serially with one test worker and no database infrastructure: touched TypeScript formatting/lint, contracts compilation, load-orchestrator source type-check, focused test type-check, all 164 contracts tests and all 214 load-orchestrator tests passed. The final job ran from 16:54:24 to 16:54:45 UTC (21 seconds); the container's reported available Linux memory was 6,317 MiB before and 6,251 MiB after, with no peak measurement. The first orchestrator run exposed three stale script-string assertions, updated in this slice. No local k6 executable was available, so the actual pinned-binary probe remains outstanding; no binary was downloaded and no image, reference/composition/characterization suite, or hosted campaign was run.
