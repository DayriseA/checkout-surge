# 16 — Project operational progress and settled history

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 16 of 21. Execute after [15](15_enforce_estimate_preview_and_start_admission.md); accepted estimates, durable operational state and truthful settlement exist.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 7, D01, D02, D06, D09 and D13. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: API projection/read services, worker status publication, bounded DB readers and shared dashboard/history contracts.

## Objective and fixed rules

Expose why accepted work is waiting and whether business settlement is actually complete. Do not derive business success from traffic completion, queue emptiness, elapsed time or a healthy-looking breaker alone. Durable control/order/notification records own obligations; controller telemetry describes current protection, not business truth.

Keep lifecycle statuses unchanged. Show waiting reasons, uncertainty and intervention separately. Distinguish confirmed, permanent business-rejected and administratively disposed totals, and distinguish over accepted estimate from over occupancy ceiling. Neither warning terminalizes a run.

## Repository entry points

`apps/api/src/services/{erp-status-service,run-history-service,demo-run-finalization-service}.ts`, existing dashboard snapshot/projection services, `apps/api/src/realtime/dashboard-projection-fanout.ts`, `apps/api/src/routes/{dashboard-routes,erp-routes}.ts`, `packages/db/src/{business-outcome-dashboard,run-signal-timeline,redis-erp-resilience}.ts`, `packages/contracts/src/{erp,run-result,run-signals,demo}.ts`, and task 09's worker status boundary. Inspect existing SSE/recovery/history tests and readers before changing payloads.

## Implementation work

- [ ] Project counts waiting by operational reason, unresolved calls, interventions, outstanding orders, oldest outstanding age and last progress from durable evidence. A row whose reason changed must not remain counted in two categories.
- [ ] Expose observed confirmation rate, controller target/pacing, current bounded in-flight work, capacity cooldown and circuit/probe state with observation/window timestamps. Observed successful business progress and controller target are different measures.
- [ ] Keep retained recent attempts distinct from cumulative counters from task 06. Report unavailable/stale/truncated telemetry explicitly rather than interpreting missing samples as zero failures, zero obligations or healthy status.
- [ ] Carry accepted estimate, actual elapsed/settlement timing, bottleneck and version evidence into run views/history. Preserve immutable final reports at settlement; old history without an estimate remains readable without invented metadata.
- [ ] Project traffic-finished/business-draining, intervention and administrative-reset-in-progress truthfully. Include reset disposition counts and authorized resume/reset context without exposing a new public per-order feed or confidential operator details.
- [ ] Preserve bounded public queries, pagination/retention and existing SSE initial-snapshot, reconnect and missed-update recovery. Integrate through current projection fanout rather than adding a parallel realtime stream or unbounded attempt subscription.
- [ ] Align final order/notification counts with task 10's settlement predicate and task 11's administrative result. No read-model race may present completed while required work remains unresolved.
- [ ] Coordinate contracts, producers and consumers so the repository stays runnable. Keep web presentation-only adapters minimal here; tasks 17–18 own the complete UX.

## Acceptance and validation

- [ ] API/projection tests cover local/capacity/availability waiting, uncertainty, intervention, sparse probes, resumed progress, overrun and late settlement.
- [ ] Final counts agree with durable records; traffic completion cannot masquerade as business completion and administrative disposition is not a business rejection.
- [ ] Pruned history, stale controller status and absent legacy estimate metadata render explicit coverage/availability rather than fabricated precision.
- [ ] Bounded public reads and SSE reconnect/recovery behavior remain intact. Contract tests validate changed payloads.
- [ ] Run focused DB/API/projection tests, `pnpm type-check`, `pnpm test:infra:up`, `pnpm test:api` and affected integration tests. Test timestamps with injected clocks instead of long waits.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep projection workflows in services and infrastructure in composition roots; format/check touched supported files with Biome. Use Linux/Dev Container execution and isolated test resources. No composition/characterization or reference-runtime mutation without request. Report actual/skipped checks; do not change the locked lifecycle or public scope.

## Completion handoff

Deliver bounded operational/history projections and their tests. Record field semantics, rate windows, availability/truncation behavior, version evidence and SSE compatibility. Next: [17 — dashboard admission preview](17_build_dashboard_estimate_and_admission_flow.md).
