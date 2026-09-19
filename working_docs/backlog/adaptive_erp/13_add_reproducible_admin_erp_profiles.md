# 13 — Add reproducible admin ERP profiles

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 13 of 21. Execute after [12](12_retire_scenario_engine_controls.md); adaptive processing and truthful lifecycle are already in place.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 5, D05, D06 and D10. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: scenario contracts/presets, mock ERP condition resolution, accepted snapshot transport and isolated fixtures.

## Objective and fixed rules

Demonstrate response-driven adaptation under changing conditions in one run. Introduce only three predefined versioned admin profiles: capacity decrease then recovery, finite outage, and latency increase then recovery. No general chaos platform, free segment editor or public outage/profile control.

A profile has identity/version, base `erpConfig`, ordered finite segments (offset from anchor, duration, latency/capacity/outage overrides), and a recovery tail equal to the base. Anchor is durable run acceptance time plus configured start delay. A restart must not restart the profile timeline.

## Repository entry points

`packages/contracts/src/{demo,erp,testing,index}.ts`, existing scenario seeds in `packages/db/`, `apps/api/src/services/demo-run-service.ts`, `apps/worker/src/application/{run-config,erp-confirmation-client}.ts`, `apps/mock-erp/src/application/{confirmation-service,chaos-control-service,tps-limiter}.ts`, their runtime composition and tests, and preset visibility/presentation in `apps/web/`. Reuse task 01's named fixtures and task 03's ledger.

## Implementation work

- [ ] Define the three small finite profiles with stable identities/versions, valid ordered segment boundaries, base conditions and recovery tail. Keep definitions in the shared contract/scenario boundary, not in controller policy.
- [ ] Persist selected profile identity and acceptance-derived anchor in the accepted run evidence. Worker requests transport identity, base config and anchor, never a freshly computed restart-relative origin. No selected profile means constant behavior.
- [ ] Resolve effective conditions in the mock when each confirmation request is admitted; keep those conditions fixed for that request through its simulated latency. A segment boundary does not retroactively change a running request.
- [ ] Preserve terminal ledger lookup/replay semantics. Replaying a canonical result must not generate a new confirmation or apply fresh chaos to the stored result; status lookup remains outside TPS/chaos latency/error injection.
- [ ] Ensure the live controller receives observed responses/timing only, not future segments or declared capacity. Profile transport must not become a shortcut that sets a supposedly learned rate or deadline.
- [ ] Apply admin-only preset visibility/authorization and existing deployment caps. Public presets stay constant and forced outage remains unavailable publicly. Do not silently convert arbitrary custom profiles into supported input.
- [ ] Use an injected clock and seeded random source for reproducible fixture errors. Expose bounded profile/anchor/effective-condition evidence sufficient to align changes with observed adaptation, without feeding future conditions into the controller.
- [ ] Verify that the mock requires no persisted profile-progress state: accepted anchor plus immutable versioned definition reconstructs the timeline after worker/mock restart.

## Acceptance and validation

- [ ] Boundary tests cover before/at/after each segment, recovery tail, delayed traffic start and restart without shifting the timeline.
- [ ] One live finite fixture experiences lower capacity then recovery without worker reconfiguration; backlog remains retained and progresses with bounded pressure.
- [ ] Latency/outage profiles exercise uncertainty/probes and converge without duplicate external effects. Existing constant-scenario behavior and public restrictions remain unchanged.
- [ ] Canonical ledger reuse is independent of the current profile segment; the same accepted identity remains canonical across restart.
- [ ] Run focused contracts/mock/worker/preset tests, `pnpm test:unit`, `pnpm type-check`, and `pnpm test:infra:up` plus isolated integration cases where service persistence/restart matters. Keep routine tests small; long throughput experiments belong to tasks 19–20.

Apply [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep routes thin and construction in composition roots; format/check touched supported files with Biome. Use the documented Linux/Dev Container path and isolated resources. Do not run composition/characterization or change the reference incident. Report checks and profile versions; changing D10's scope requires explicit user approval.

## Completion handoff

Deliver profiles, transport/resolution and reproducibility tests. Record profile ids/versions, anchor ownership, scenario evidence and controller isolation. Next: [14 — duration estimation](14_implement_conservative_duration_estimator.md).
