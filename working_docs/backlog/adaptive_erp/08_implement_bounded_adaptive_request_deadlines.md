# 08 — Implement bounded adaptive request deadlines

## Handoff

- Status: Pending.
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

- [ ] Add a bounded observed-latency window and deterministic percentile/clamp calculation. Define startup/empty-window behavior using the provisional initial deadline, not zero or an invented successful sample.
- [ ] Count timeouts as censored observations at the deadline used for that call, allowing repeated timeouts to increase the deadline. Exclude local success reuse, lookup responses and replayed responses from the window.
- [ ] Make the client accept the chosen bounded deadline from the engine policy. Preserve durable intent before dispatch and uncertainty/reconciliation after timeout; do not infer no effect from AbortSignal completion.
- [ ] Validate on worker startup that maximum request deadline is at least the deployment's largest allowed ERP latency plus the policy margin. A mismatch fails configuration clearly instead of silently clamping below a supported scenario.
- [ ] Audit claim/lease duration, request cancellation, recovery selection and connection lifetime together so timeout growth cannot create overlapping same-order requests or unnecessary lease churn. An expired lease still reconciles the prior intent.
- [ ] Keep sample storage scope-isolated and bounded. Reset learned samples on restart while task 09 will honor persisted cooldown/circuit safety state.
- [ ] Add explicit duration/deadline telemetry needed for diagnosis without making every observation a new durable event. Do not expose internal knobs in forms.

## Runnable boundary and non-goals

Deliver the calculator, client integration seam and startup checks without a partial adaptive-dispatch switch; task 09 activates pacing/deadlines together for initial calls and replays. Keep any temporary old timeout input adapter explicit and remove it during task 12's final configuration cleanup. No business expiration, timeout-to-failure fallback or direct reading of the mock's future latency profile.

## Acceptance and validation

- [ ] Deterministic tests cover empty window, percentile/window eviction, clamp boundaries, censored timeouts and exclusion of lookup/replay samples.
- [ ] Startup rejects a deadline ceiling below supported deployment latency plus margin and accepts a coherent policy.
- [ ] A response later than the initial deadline retains uncertainty and eventually adopts one canonical confirmation; a maximum-deadline timeout never terminally fails the order.
- [ ] No overlap occurs when a lease expires or cancellation races a late response. Unit tests use injected clocks; HTTP/DB timing tests use small isolated fixtures.
- [ ] Run focused client/runtime/policy tests, `pnpm test:unit`, `pnpm type-check`, and `pnpm test:infra:up` plus relevant integration tests for the persistence/HTTP cases.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Format/check touched supported files with Biome; keep infrastructure construction in composition roots. Use Linux/Dev Container and isolated test resources, not the reference runtime. Do not run composition/characterization unless requested. Record actual/skipped checks and provisional calibration values; changing D08 requires explicit approval.

## Completion handoff

Deliver deadline policy and resource-bound tests. Record sample eligibility, startup invariant, cancellation/lease handling and temporary configuration adapter. Next: [09 — runtime wiring and restart safety](09_wire_adaptive_runtime_and_restart_safety.md).
