# 21 — Make the host-dependent estimator constants environment-configurable

## Handoff

- Status: Done (2026-09-22).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 21 of 23. Execute after [20](20_verify_policy_against_code_bound_targets.md).
- Source: user decision, 2026-09-22 (see the scope revision in task 20). Related: D11 (conservative envelope, unchanged) and D13 (versioned engine policy, unchanged).
- Ownership: API runtime configuration (`apps/api/src/runtime/config.ts`), the estimator's constant injection, `.env.example` files, and the API config/estimator tests. No contract, worker, web or database change.

## Why

`apps/api/src/services/demo-duration-estimator.ts` hardcodes allowances that were fitted to measurements taken on one developer machine (task 17b; the exact host is recorded in that task's completion notes and must be quoted, not assumed). Anyone deploying the repository on other hardware would have to edit source code to correct them. The fix is to read them from the environment with the current values as defaults, and to say where the defaults come from.

## What becomes configurable

| Constant | Current default | Why it is host- or deployment-dependent | Proposed variable |
| --- | --- | --- | --- |
| `latencyOverheadFloorMs` | 130 | Per-job overhead beyond ERP latency (queue, DB, worker) measured locally | `ESTIMATOR_JOB_OVERHEAD_MS` |
| `settlementOverheadSeconds` | 15 | Delay between the last notification and run finalization, measured locally | `ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS` |
| `transientErrorDemandMargin` | 1.25 | Margin on the `1/(1-p)` retry demand, fitted locally | `ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN` |
| `perExcessAttemptPauseSeconds` | 1 | Anchored to the mock ERP's `Retry-After: 1`; a real ERP may differ | `ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS` |

`supportedMaximumErrorRate` (0.3) stays hardcoded: it is a policy bound on what the estimator supports, not a measurement. Variable names are a proposal; keep them consistent with the existing `DEMO_MAX_*` style if a better prefix fits the file.

## Implementation work

- [x] Parse the four variables in `apps/api/src/runtime/config.ts` next to `DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS`, with the current values as defaults and the existing positive-number parsing/error style. Reject non-positive values; the margin must be at least 1.
- [x] Inject the parsed constants into the estimator instead of reading the module-level object: `estimateDemoDuration` (and `estimateAcceptedDemoRun` through it) receives the constants from the composed API config. Keep the pure-function shape; do not create a class or a global.
- [x] Keep `conservativeDurationEstimatorConstants` as the exported default object so the unit tests and the defaults have one source of truth. Replace its "provisional until task 20" comment with a note that the defaults were measured on the host recorded in task 17b and are meant to be re-measured per deployment (task 22 owns the procedure).
- [x] Add the four variables to `.env.example` and `apps/api/.env.example` with a comment block stating: the defaults were calibrated on a developer dev container (quote task 17b's recorded host), they only make the estimate more or less pessimistic and never affect accounting, and a deployment should re-run the calibration procedure in `docs/` (task 22) on the target host before relying on them.
- [x] Update the estimator's `provisional_declared_capacity_v2` assumption text so it no longer references task 20 or "provisional"; state that allowances are deployment-configured defaults with no confidence claim.
- [x] Tests: `apps/api/test/runtime-config.test.ts` (defaults and one invalid value per variable is enough), `apps/api/test/unit/demo-duration-estimator.test.ts` (existing expectations still hold with the injected defaults; one case showing a changed constant changes the estimate).

## Non-goals

- Making worker policy constants (`erp-resilience-policy.ts`, `processing-control.ts`) configurable. They describe behavior toward the ERP contract, not the host, and stay versioned in code.
- Changing the estimator formula, D11's sequential envelope ([carried-over follow-up 6](carried_over_follow_ups.md)) or the estimator identity version. Configuring a default is not a new estimator version.
- Runtime-mutable or per-run overrides; deployment restart is the only way values change, like `DEMO_MAX_*`.

## Acceptance and validation

- [x] With no variables set, every existing estimator and API test passes unchanged.
- [x] Each variable is read, validated and documented in both `.env.example` files with the calibration-origin note.
- [x] `pnpm exec biome check --write <touched files>`, `pnpm type-check`, `pnpm --filter api test:unit`, and `pnpm test:infra:up` then `pnpm test:api` pass.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md): routes stay thin, configuration parsing stays in the runtime config module, injection happens at the composition root.

## Completion handoff

Record the final variable names, defaults and touched files here, then hand off to [22 — document the calibration procedure](22_document_calibration_procedure.md), which references these variables.

### Completion notes

Variables (API only, read once at startup, restart to change), with the current constants as defaults:

| Variable | Default | Validation |
| --- | --- | --- |
| `ESTIMATOR_JOB_OVERHEAD_MS` | 130 | finite number > 0 |
| `ESTIMATOR_SETTLEMENT_OVERHEAD_SECONDS` | 15 | finite number > 0 |
| `ESTIMATOR_TRANSIENT_ERROR_DEMAND_MARGIN` | 1.25 | finite number >= 1 |
| `ESTIMATOR_EXCESS_ATTEMPT_PAUSE_SECONDS` | 1 | finite number > 0 |

Decimal values are accepted (a new `parsePositiveNumber` helper sits next to `parsePositiveInteger`; a `parseDemandMargin` wrapper adds the `>= 1` rule). Blank or unset values fall back to the defaults, so behaviour without variables is unchanged. `supportedMaximumErrorRate` (0.3) stays hardcoded.

Design: `estimateDemoDuration(input, ceilingSeconds, constants = conservativeDurationEstimatorConstants)` and `estimateAcceptedDemoRun(snapshot, policy, constants = ...)` take the allowances as an optional third parameter typed `DurationEstimatorConstants` (exported by the estimator module). `DemoRunLifecycleService` receives a required `estimatorConstants` option that `apps/api/src/index.ts` fills from `config.estimatorConstants`; both the preview and start call sites pass it. `PublicRuntimePolicy` and the contracts package are unchanged; the estimator formula and identity are unchanged. The `provisional_declared_capacity_v2` assumption code is kept (contract vocabulary); only its detail text changed.

Touched files: `apps/api/src/runtime/config.ts`, `apps/api/src/services/demo-duration-estimator.ts`, `apps/api/src/services/demo-duration-admission-service.ts`, `apps/api/src/services/demo-run-service.ts`, `apps/api/src/index.ts`, `apps/api/test/runtime-config.test.ts`, `apps/api/test/unit/demo-duration-estimator.test.ts`, `apps/api/test/demo-run-service.test.ts`, `.env.example`, `apps/api/.env.example`, `docker-compose.yml` (API service env passthrough, mirroring `DEMO_MAX_ESTIMATED_OCCUPANCY_SECONDS`), `docs/local_development.md` (environment table), `docs/architecture.md` (estimator paragraph).

Validation: `biome check --write` on touched files, `pnpm type-check`, `pnpm --filter api test:unit` (9 tests) and `pnpm test:api` (51 files, 667 tests) all pass with no variables set.

Next: [22 — document the calibration procedure](22_document_calibration_procedure.md). The `.env.example` comment blocks already point deployments at the `docs/` procedure task 22 will write.
