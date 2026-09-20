# 08 — Implement bounded adaptive request deadlines

## Handoff

- Status: Complete (2026-09-20).
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 08 of 21. Execute after [07](07_implement_paced_adaptive_admission_policy.md); use task 04's client/reconciliation boundary and task 07's versioned policy.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 3, section 6.3, D05, D07, D08 and D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: worker deadline policy, ERP client resource bounds and startup validation.

## Objective and fixed rules

Use observed latency to bound each request without confusing network deadlines with business expiry. The formula is `clamp(percentile(window) * factor + margin, minimum, maximum)`. Initial deadline, window size, percentile, factor, margin and bounds are versioned engine constants, not accepted scenario knobs. Samples and learned deadline state are not persisted across restart.

A timeout remains an uncertain external result, including at the maximum deadline. Late canonical success dominates the local timeout. Never start a parallel confirmation for the same order to catch up.

## Repository entry points

`apps/worker/src/application/erp-confirmation-client.ts`, the policy introduced in task 07, `apps/worker/src/runtime/{config,worker-runtime,readiness}.ts`, `apps/worker/src/application/run-config.ts`, worker environment examples, and deployment/configuration boundaries defining allowed ERP latency. Inspect `packages/contracts/src/erp.ts` and existing worker client/runtime tests. Keep the mock's scenario latency independent of the worker's learning inputs.

## Implementation work

- [x] Add a bounded observed-latency window and deterministic percentile/clamp calculation. Define startup/empty-window behavior using the provisional initial deadline, not zero or an invented successful sample.
- [x] Count timeouts as censored observations at the deadline used for that call, allowing repeated timeouts to increase the deadline. Exclude local success reuse, lookup responses and replayed responses from the window.
- [x] Make the client accept the chosen bounded deadline from the engine policy. Preserve durable intent before dispatch and uncertainty/reconciliation after timeout; do not infer no effect from AbortSignal completion.
- [x] Define the deployment's largest allowed ERP latency as one exported contracts constant, initial value 5000 ms, provisional until task 20 (user decision, 2026-09-20; no such bound exists today). Enforce it on acceptance/write paths for `erpConfig.latencyMs`, profile segment latency overrides, and as the upper bound of the editable `publicCustomLimits.maxErpLatencyMs`. History readers must keep parsing earlier snapshots. Verify seeded presets and acceptance fixtures stay within it. The worker imports the constant; it does not read the database policy at startup.
- [x] Validate on worker startup that maximum request deadline is at least the deployment's largest allowed ERP latency plus the policy margin. A mismatch fails configuration clearly instead of silently clamping below a supported scenario.
- [x] Audit claim/lease duration, request cancellation, recovery selection and connection lifetime together so timeout growth cannot create overlapping same-order requests or unnecessary lease churn. An expired lease still reconciles the prior intent.
- [x] Keep sample storage scope-isolated and bounded. Reset learned samples on restart while task 09 will honor persisted cooldown/circuit safety state.
- [x] Add explicit duration/deadline telemetry needed for diagnosis without making every observation a new durable event. Do not expose internal knobs in forms.

## Runnable boundary and non-goals

Deliver the calculator, client integration seam and startup checks without a partial adaptive-dispatch switch; task 09 activates pacing/deadlines together for initial calls and replays. Keep any temporary old timeout input adapter explicit and remove it during task 12's final configuration cleanup. No business expiration, timeout-to-failure fallback or direct reading of the mock's future latency profile.

## Acceptance and validation

- [x] Deterministic tests cover empty window, percentile/window eviction, clamp boundaries, censored timeouts and exclusion of lookup/replay samples.
- [x] Startup rejects a deadline ceiling below supported deployment latency plus margin and accepts a coherent policy.
- [x] A response later than the initial deadline retains uncertainty and eventually adopts one canonical confirmation; a maximum-deadline timeout never terminally fails the order.
- [x] No overlap occurs when a lease expires or cancellation races a late response. Unit tests use injected clocks; HTTP/DB timing tests use small isolated fixtures.
- [x] Run focused client/runtime/policy tests, `pnpm test:unit`, `pnpm type-check`, and `pnpm test:infra:up` plus relevant integration tests for the persistence/HTTP cases.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check touched supported files with Biome; keep infrastructure construction in composition roots. Use Linux/Dev Container and isolated test resources, not the reference runtime. Do not run composition/characterization unless requested. Record actual/skipped checks and provisional calibration values; changing D08 requires explicit approval.

## Completion handoff

Deliver deadline policy and resource-bound tests. Record sample eligibility, startup invariant, cancellation/lease handling and temporary configuration adapter. Next: [09 — runtime wiring and restart safety](09_wire_adaptive_runtime_and_restart_safety.md).

Implemented the request-deadline portion of `adaptive-erp-admission-v1-provisional` without activating adaptive dispatch. The provisional constants are: initial 2000 ms, 100-sample window, nearest-rank p95, factor 1.5, 500 ms margin, 500 ms minimum, 6000 ms maximum and 5000 ms processing-lease headroom. State is isolated by `run:<id>` or `catalog`, capped at 1000 least-recently-used scopes, and process-local; restart therefore returns to the empty-window initial deadline.

Only actual, non-replayed confirmation responses and confirmation timeouts are eligible samples. Timeouts contribute the deadline used for that call rather than elapsed wall time. Local reuse, lookup and replay observations are explicitly ignored. The ERP client now accepts a selected deadline, records it on its in-process outcome, and logs duration/deadline/disposition/replay fields; observations did not become a new durable event stream.

The exported provisional deployment limit is 5000 ms. Dedicated write/acceptance schemas enforce it for run ERP configuration, confirmation request configuration, profile bases/segment overrides, preset writes/copies, run acceptance, public policy writes and mock-ERP configuration. Seed construction and acceptance fixtures parse through those boundaries. Seed policy construction then also parses through the pre-existing persisted-policy semantic schema, so restricted limits cannot exclude their configured defaults. Existing history/snapshot schemas remain permissive and a regression test parses an earlier snapshot above the new write ceiling.

Startup requires the 6000 ms maximum deadline to be at least the 5000 ms deployment limit plus the 500 ms policy margin. The complete ownership audit covers claim, admission, durable-intent persistence, HTTP deadline and outcome persistence. There is no lease heartbeat or renewal during that interval, and an expired owner can reconcile `unknown` and authorize a same-key replay. Startup therefore also requires `ORDER_RECOVERY_LEASE_MS` to cover the 6000 ms maximum deadline plus 5000 ms of versioned ownership headroom, for an 11000 ms minimum. The existing 30000 ms default and example satisfy it. Durable intent still fences an immediate second dispatch; cancellation stays uncertain; after the supported late response settles, an expired lease retains the prior intent and lookup adopts the single canonical confirmation without replay. Fake-timer tests prove cancellation at the selected deadline, and the worker DB/HTTP reconciliation fixture proves one POST across timeout, late canonical completion and subsequent lease recovery. No heartbeat, persistence-schema or recovery-selection change was needed.

The temporary adapter remains explicit: task 09 will pass the adaptive deadline, while unwired runtime calls still fall back to the accepted snapshot `requestTimeoutMs` and then `ERP_REQUEST_TIMEOUT_MS`; task 12 removes those legacy inputs. No form exposes the policy constants.

Validation completed:

- `pnpm exec biome check --write <touched supported files>`: passed; final touched-file check recorded after this note.
- `pnpm type-check`: passed all 11 workspace tasks plus test TypeScript checking.
- `pnpm test:unit`: passed 7 environment-safety tests, 54 script tests and all 10 package tasks (1434 package tests). A pre-existing non-failing React `act(...)` warning remains in `web/test/browser-workflows.test.ts`.
- `pnpm test:infra:up`: isolated PostgreSQL and Redis became healthy.
- `pnpm test:api`: 50 files and 621 tests passed.
- Focused worker integration (`erp-attempt-recovery` and `postgres-processing-control`): 2 files and 33 tests passed; includes timeout/late-canonical/expired-lease reconciliation with exactly one POST.
- Focused API preset/run/runtime-policy tests: 3 files and 57 tests passed.
- Focused DB seed integration: 1 selected test passed (65 skipped by the name filter); invalid environment/default-limit semantic rejection did not mutate the active policy.
- Focused mock-ERP ledger integration: 1 file and 6 tests passed, including a real caller-abort-before-late-canonical-success case.
- `pnpm test:composition` and `pnpm test:characterization` were intentionally not run as prohibited. The full unrelated integration matrix was not run; the persistence, lease, cancellation, canonical-result and HTTP ledger boundaries relevant to this task were run directly.
