# 07 — Implement the paced adaptive admission policy

## Handoff

- Status: Complete (2026-09-20).
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

- [x] Define a versioned worker engine policy containing provisional initial/floor/ceiling rate, additive step, reduction factor, observation and rejection-wave windows, cooldown/backoff bounds, probe cadence and in-flight ceiling. These are internal constants, not scenario form controls. Record candidate values and rationale; final approval is task 20.
- [x] Implement a deterministic transition/permit API with injected clock and random source for bounded jitter. Return admitted/deferred state plus next eligibility/reason and a bounded snapshot for future projections.
- [x] Pace starts without accumulated burst credit. Idle time or outage must not grant a catch-up burst. Bound per-scope concurrency by the smaller of configured concurrency and policy ceiling; respect the global resource ceiling too.
- [x] Increase gradually only after the stable observation window and useful progress. On the first capacity response of a rejection wave, reduce once; coalesce simultaneous/subsequent responses within that wave. Late feedback from calls dispatched before the newest reduction must not undo it.
- [x] Feed `429` capacity into pacing/cooldown only, not availability failure count. Feed recognized unavailability, connection failures and timeouts into availability protection. Support bounded `Retry-After` guidance from task 04 and local capped backoff/jitter when absent or invalid.
- [x] During availability outage, admit only sparse probes and resume through a limited probe then gradual ramp. After opening, allow at most one probe per scope per 5 seconds, excluding already-dispatched calls, per D14.
- [x] Local result reuse, lookup and replayed success do not close the circuit, increase the rate or constitute latency-learning samples. Model lookup separately: small dedicated in-flight bound, availability-circuit protection, no capacity cooldown or rate pacing.
- [x] Keep state/window memory bounded and expose restart safety fields separately from learned rate/window state. Task 09 persists only safety state and restarts learning conservatively.

## Non-goals

Do not activate the policy on only some call paths, persist learned rates, read known TPS for live rate selection, promise optimal capacity discovery, or tune throughput by weakening the fixed acceptance targets. The full runtime remains on the existing protection until task 09 performs the coordinated switch.

## Acceptance and validation

- [x] Injected-clock tests prove start spacing, no idle burst, in-flight bounds, floor/ceiling, stable additive increase, one reduction per rejection wave and rejection of obsolete feedback.
- [x] Capacity never opens the availability circuit; availability limits probe cadence; valid cooldowns are honored without unbounded timers or allocation.
- [x] Lookup can progress during capacity cooldown but cannot flood an outage; local/replayed outcomes never teach false health.
- [x] Independent run/catalog scopes do not share learned state, while all consume the declared worker-wide resource limit.
- [x] Run focused admission/circuit/backpressure tests, `pnpm test:unit` and `pnpm type-check`. No real five-second waits are needed for deterministic policy tests.

Read [AGENTS](../../../AGENTS.md) and [quality checklists](../../../docs/quality_checklists.md). Keep policy independent of infrastructure, format/check touched supported files with Biome, and use the documented Linux/Dev Container execution path. No unsolicited composition/characterization or runtime tests. Report checks and provisional constants; deviations from D06/D14 require explicit user approval.

## Completion handoff

Implemented `adaptive-erp-admission-v1-provisional` as an infrastructure-independent worker application controller. The constants remain provisional until task 20:

| Constant | Candidate | Rationale |
| --- | ---: | --- |
| Initial / floor / ceiling rate | 2/s / 0.5/s / 20/s | Start conservatively, retain sparse forward progress, and leave calibration room above the 10/s acceptance fixture without reading its declared capacity. |
| Additive step / observation window | 1/s / 10 s | Require useful stable progress and ramp gradually rather than reacting to individual successes. |
| Reduction factor / rejection-wave window | 0.5 / 1 s | Cut pressure promptly while coalescing feedback from concurrently dispatched calls. |
| Capacity fallback / maximum cooldown | 1 s exponential base with 50–100% jitter / 60 s | Avoid synchronized retries while bounding scheduling guidance and state. |
| Availability failures / backoff | 3 / 5 s exponential base with 50–100% jitter, capped at 60 s | Tolerate isolated failures while delaying both confirmations and lookups, then switch to probes spaced by at least five seconds. |
| Probe cadence | 5 s | Meets D14's maximum of one post-open probe per scope every five seconds. |
| Per-scope / worker-wide in-flight ceiling | 10 / 20 | Bound a scope independently while preserving a shared process resource ceiling; configured concurrency can only lower the per-scope value. |
| Lookup in-flight ceiling | 2 per scope | Let reconciliation progress outside pacing/capacity cooldown without flooding an outage. |
| Deferred recheck / retained scope-state ceiling | 100 ms / 1,000 | Return a future scheduling decision without sleeping and keep process memory bounded. |

`tryAcquire({ scope, operation, configuredConcurrency })` returns an admitted permit or a deferred reason, future eligibility timestamp, and bounded current-scope snapshot. `feedback(permit, classifiedOutcome)` releases the in-flight reservation and applies capacity, availability, or useful-progress learning. Permit generations fence rate/circuit learning from feedback dispatched before the latest reduction, while bounded capacity and availability safety guidance from that feedback is still honored. Every capacity response restarts the stable observation window. Every availability failure sets a bounded availability retry time for confirmations and lookups, including failures before the circuit opens. A concurrent success may reset failure/backoff learning but never shortens an unexpired capacity or availability deadline. Local reuse does not acquire a permit, lookup success never teaches, and replayed dispatch success is explicitly non-teaching.

`AdaptiveErpAdmissionSafetyState` is the task-09 serialization boundary. It contains only the policy version and per-scope capacity cooldown, availability retry time, circuit-open marker/expiry, and next-probe time. Every unexpired deadline is restored independently; an open circuit stays open while any availability-retry, circuit-open, or next-probe deadline remains and restarts closed only after all three expire. Target rate, generation, observation progress, backoff counters, in-flight counts, and other learned state remain process-local and restart at the conservative initial values. Opening or recovering the availability circuit never raises a capacity-reduced rate, and retained scopes with pending pacing or safety deadlines are not evicted.

No runtime, adapter, or persistence wiring changed; task 09 owns the coordinated switch and safety-state persistence. Next: [08 — adaptive request deadlines](08_implement_bounded_adaptive_request_deadlines.md).
