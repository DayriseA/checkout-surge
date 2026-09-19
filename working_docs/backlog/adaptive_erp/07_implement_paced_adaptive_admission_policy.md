# 07 — Implement the paced adaptive admission policy

## Handoff

- Status: Pending.
- Branch: `feat/adaptive-erp-and-admission`.
- Sequence: 07 of 21. Execute after [06](06_bound_attempt_history_and_preserve_aggregates.md); durable retry/reconciliation is already available.
- Source: [implementation plan](../../adaptive_erp_processing_implementation_plan.md), Phase 3, section 6.1, D05–D07 and D14. Baseline: `ee4d4135460a04b4de0e8bb8d031e8b45ad99e58`.
- Ownership: small deterministic worker application policy. Live wiring and restart persistence are task 09.

## Objective and fixed rules

Implement additive increase/multiplicative decrease with evenly paced starts, bounded in-flight work, capacity cooldown and a separate availability circuit. The supported topology has one worker process and one authority per actual quota scope: `run:<id>` or `catalog`, with a worker-wide in-flight ceiling above the per-scope ceiling. Do not imply that independent gates support multiple replicas.

The controller must never read declared mock capacity, scenario error rate or future profile segments. Worker concurrency is a resource ceiling, not permission to exceed downstream cadence. Denied permits return a future eligibility decision; they do not sleep, hold a connection or create an ERP attempt.

## Repository entry points

`apps/worker/src/application/{order-process-admission,erp-circuit-breaker,run-backpressure,run-config}.ts`, the explicit outcome interface from task 04, `apps/worker/src/runtime/config.ts`, and unit tests for admission, circuit breaker and backpressure. A narrowly scoped new policy module under worker application is appropriate; no generic scheduling framework or new service is needed.

## Implementation work

- [ ] Define a versioned worker engine policy containing provisional initial/floor/ceiling rate, additive step, reduction factor, observation and rejection-wave windows, cooldown/backoff bounds, probe cadence and in-flight ceiling. These are internal constants, not scenario form controls. Record candidate values and rationale; final approval is task 20.
- [ ] Implement a deterministic transition/permit API with injected clock and random source for bounded jitter. Return admitted/deferred state plus next eligibility/reason and a bounded snapshot for future projections.
- [ ] Pace starts without accumulated burst credit. Idle time or outage must not grant a catch-up burst. Bound per-scope concurrency by the smaller of configured concurrency and policy ceiling; respect the global resource ceiling too.
- [ ] Increase gradually only after the stable observation window and useful progress. On the first capacity response of a rejection wave, reduce once; coalesce simultaneous/subsequent responses within that wave. Late feedback from calls dispatched before the newest reduction must not undo it.
- [ ] Feed `429` capacity into pacing/cooldown only, not availability failure count. Feed recognized unavailability, connection failures and timeouts into availability protection. Support bounded `Retry-After` guidance from task 04 and local capped backoff/jitter when absent or invalid.
- [ ] During availability outage, admit only sparse probes and resume through a limited probe then gradual ramp. After opening, allow at most one probe per scope per 5 seconds, excluding already-dispatched calls, per D14.
- [ ] Local result reuse, lookup and replayed success do not close the circuit, increase the rate or constitute latency-learning samples. Model lookup separately: small dedicated in-flight bound, availability-circuit protection, no capacity cooldown or rate pacing.
- [ ] Keep state/window memory bounded and expose restart safety fields separately from learned rate/window state. Task 09 persists only safety state and restarts learning conservatively.

## Non-goals

Do not activate the policy on only some call paths, persist learned rates, read known TPS for live rate selection, promise optimal capacity discovery, or tune throughput by weakening the fixed acceptance targets. The full runtime remains on the existing protection until task 09 performs the coordinated switch.

## Acceptance and validation

- [ ] Injected-clock tests prove start spacing, no idle burst, in-flight bounds, floor/ceiling, stable additive increase, one reduction per rejection wave and rejection of obsolete feedback.
- [ ] Capacity never opens the availability circuit; availability limits probe cadence; valid cooldowns are honored without unbounded timers or allocation.
- [ ] Lookup can progress during capacity cooldown but cannot flood an outage; local/replayed outcomes never teach false health.
- [ ] Independent run/catalog scopes do not share learned state, while all consume the declared worker-wide resource limit.
- [ ] Run focused admission/circuit/backpressure tests, `pnpm test:unit` and `pnpm type-check`. No real five-second waits are needed for deterministic policy tests.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep policy independent of infrastructure, format/check touched supported files with Biome, and use the documented Linux/Dev Container execution path. No unsolicited composition/characterization or runtime tests. Report checks and provisional constants; deviations from D06/D14 require explicit user approval.

## Completion handoff

Deliver the policy and deterministic tests. Record version, provisional constants, permit/feedback interface and safety-state serialization boundary. Next: [08 — adaptive request deadlines](08_implement_bounded_adaptive_request_deadlines.md).
