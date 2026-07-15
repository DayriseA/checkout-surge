# Task 49: Replace fixed-second TPS buckets in the mock ERP with a sliding one-second window

## Execution context

- **Execution order:** This is task 49 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** mock-ERP / simulation realism
- **Source:** comparison (worse)
- **Standalone implementation context:** inlined below. No donor checkout or branch access is required.
- **Locations:** `apps/mock-erp/src/application/chaos-control-service.ts:52`, `apps/mock-erp/src/runtime/config.ts:18`

Chaos knobs, live update/reset, and run-scoped overrides all work; the TPS limiter uses fixed wall-clock second buckets, which admits boundary bursts and is a weaker approximation of a rolling downstream bottleneck.

## Standalone implementation context

### What exists in this checkout

- `apps/mock-erp/src/application/chaos-control-service.ts` owns both `ErpChaosConfigStore` and `ChaosConfirmationDecisionProvider`. The provider resolves `request.erpConfig` over the live store fallback, parses the effective value with `erpChaosConfigSchema`, and keeps `tpsWindows: Map<string, TpsWindow>` where `TpsWindow` is `{ windowStartedAtMs, requestsInWindow }`.
- `ChaosConfirmationDecisionProvider.acceptWithinTpsLimit()` currently computes `Math.floor(this.now().getTime() / 1000) * 1000`, resets a scope's counter when that wall-clock second changes, increments it, and accepts while `requestsInWindow <= maxTps`. This permits the classic boundary burst: `maxTps` requests just before a second boundary and another `maxTps` just after it can all pass within a few milliseconds.
- Preserve the current scope contract in `resolveTpsScopeKey()`: `run:${request.runId}` for run traffic; `global` when a no-run request uses the live fallback; and `config:${serializeTpsConfigScope(config)}` for a no-run request carrying a materially different request-scoped config. `serializeTpsConfigScope()` includes `latencyMs`, `maxTps`, `errorRate`, and `forcedOutage`; changing this keying would merge behavior populations and is outside this task.
- Preserve the existing response vocabulary from `dependencyFailure()`: throttle is HTTP `429`, code `erp_capacity_exceeded`; forced outage is HTTP `503`, code `erp_forced_outage`; injected failure is HTTP `503`, code `erp_injected_error`. `ConfirmationService.confirm()` already checks its successful-confirmation idempotency map before calling the decision provider, so a replay must continue to bypass chaos and limiter state.
- `apps/mock-erp/src/runtime/config.ts::loadMockErpConfig()` already provides the typed/fail-fast configuration behavior that is useful in the donor: `MAX_TPS` and `ADMIN_MIN_MAX_TPS` go through `parsePositiveInteger()`, latency values through nonnegative-integer parsing, rates through `[0, 1]` parsing, booleans through strict `true`/`false` parsing, and the assembled default controls through `erpChaosConfigSchema`. The shared `packages/contracts/src/erp.ts::erpChaosConfigSchema` also requires `maxTps` to be a positive integer. Retain these guarantees and add focused missing assertions rather than replacing them with permissive coercion.

### Rolling-window algorithm to implement

Extract the limiter from `chaos-control-service.ts` into a small application-level boundary (for example `apps/mock-erp/src/application/tps-limiter.ts`) so the chaos provider remains orchestration. A `SlidingWindowTpsLimiter` should track accepted request instants per scope, not fixed bucket counters:

1. Obtain one millisecond timestamp for the acquisition from an injected clock. Prefer a monotonic elapsed-time source for the production default (for example `performance.now()`); wall time is not required for a relative one-second limit and can jump under clock synchronization. Keep the clock injectable so tests do not sleep. If the implementation retains the provider's existing `now: () => Date` option for compatibility, call it exactly once per acquisition and document that a backwards wall-clock jump can temporarily extend a window.
2. Read or create the scope's ordered queue of accepted timestamps. Remove timestamps for which `nowMs - acceptedAtMs >= 1_000`. Exact age `1_000ms` is expired; the active interval is `(nowMs - 1_000, nowMs]`.
3. If the remaining accepted count is already `>= maxTps`, reject without appending anything. Rejected attempts must not extend the throttle period or consume memory.
4. Otherwise append `nowMs` and accept. An injected-error request has consumed real downstream capacity and therefore remains in the queue.
5. Delete empty/stale scope entries and opportunistically prune other scopes whose newest accepted timestamp is at least one second old. Do this during normal acquisitions; do not add timers. This combines the reference algorithm with Opus's stale-scope pruning: each active scope retains at most its accepted arrivals for the last second, rejected arrivals are not retained, and the map retains only scopes active in the last second. Avoid repeated `Array.shift()` on a large queue if practical; a head index plus occasional compaction is sufficient.

This is an in-process simulation limiter. The check and append must remain synchronous with no `await` between them, which makes concurrent calls atomic within one Node.js event loop. It is deliberately not a distributed quota: multiple mock-ERP replicas each enforce their own cap, so aggregate capacity can reach approximately `replicaCount * maxTps`; process restarts forget history; and a reverse proxy or queue changes the arrival times observed by the limiter. Do not add Redis, sticky routing, proxy coordination, or persistence in this task. If deployment ever requires one logical ERP-wide cap, that is a separate distributed-limiter design with an explicit fail-open/fail-closed policy.

### Failure-order realism

Adopt the donor's fail-fast ordering inside `ChaosConfirmationDecisionProvider.decide()` while keeping this checkout's contracts and codes:

1. Resolve and schema-parse the effective config.
2. Return forced outage immediately with zero simulated wait and without consuming a TPS slot.
3. Acquire a TPS slot synchronously; return throttle immediately with zero simulated wait when denied.
4. For an admitted request, apply `latencyMs`, then evaluate `errorRate`, then succeed or return the injected error.

This models an unavailable dependency and a front-door capacity rejection as fast failures, while accepted work pays processing latency even if it later fails. It also makes concurrency deterministic because slot acquisition happens before the first asynchronous sleep. Do not change route/controller responsibilities or move chaos logic into HTTP handlers.

### Adaptation map

- Replace `TpsWindow`, `tpsWindows`, and `acceptWithinTpsLimit()` in `apps/mock-erp/src/application/chaos-control-service.ts` with an injected limiter dependency. Keep `resolveTpsScopeKey()`, `configsMatch()`, and `serializeTpsConfigScope()` as the source of scope identity.
- Wire the concrete sliding limiter only in the composition root, `apps/mock-erp/src/index.ts`; do not construct infrastructure in routes. A small synchronous limiter interface also allows direct deterministic unit tests.
- Keep `ErpChaosConfigStore` responsible for live update/reset and safety-cap validation. A global config update must affect the cap on the next request, but it must not clear run-scoped history. When a cap decreases, existing accepted timestamps still count until they expire; when it increases, the newly available slots can be used immediately.
- Keep `loadMockErpConfig()` and `erpChaosConfigSchema` as the validation boundary. There is intentionally no new `ADMIN_MAX_MAX_TPS` setting in this task; memory is bounded by accepted arrivals in the rolling second and active-scope pruning, not by inventing a new public config contract.
- Keep `apps/mock-erp/src/routes/chaos-routes.ts`, `apps/mock-erp/src/server.ts`, and public schemas/status payloads unchanged except for any dependency plumbing strictly required by the extracted limiter.

## Focused verification

Add unit coverage at the limiter/provider boundary in `apps/mock-erp/test/unit/` (the existing combined suite is `mock-erp.test.ts`; a dedicated limiter test file is acceptable):

- Cap semantics: allow exactly `maxTps`, reject the next request, and do not enqueue rejected attempts.
- Boundary burst: with cap `2`, accept twice at `999ms`; attempts at `1_000ms` must still be rejected. This is the regression that a fixed wall-clock bucket fails.
- Exact expiry: an acceptance at `0ms` no longer counts at `1_000ms`, while it still counts at `999ms`.
- Rolling recovery: stagger accepted timestamps and prove capacity returns one slot at a time, not as a full bucket reset.
- Scope isolation: retain coverage for two run IDs, global traffic, and distinct no-run config scopes.
- Dynamic caps: lowering the cap takes effect on the next acquisition without erasing history; raising it exposes only the additional capacity; a live global reset/update does not clear a run scope.
- State bounds: create stale scopes, advance beyond one second, trigger another acquisition, and verify stale entries are pruned (use a narrow read-only diagnostic on the limiter only if needed for a direct assertion).
- Failure ordering: forced outage and throttle do not call `sleep`; an admitted injected error does call it; outage does not consume a slot; an injected error does consume one.
- Concurrency: launch more distinct confirmations than the cap with `Promise.all` and an injected unresolved/controlled sleep; exactly `maxTps` calls are admitted and the rest receive the existing `429`/`erp_capacity_exceeded` result. Use distinct idempotency keys so `ConfirmationService` replay behavior does not invalidate the test.
- Configuration boundaries: explicitly reject `MAX_TPS` and `ADMIN_MIN_MAX_TPS` values of `0`, negative, fractional, nonnumeric, and non-finite forms, while preserving defaults and valid positive integers.

Run the mock-ERP unit suite, type-check, and lint after implementation. Preserve the scope and non-goals above even if broader production rate-limiting concerns are discovered.

## Implementation record

- **Status:** Completed on 2026-07-15.
- **Scope delivered:** Extracted a synchronous `TpsLimiter` boundary and monotonic-clock `SlidingWindowTpsLimiter`; wired the concrete limiter in the mock-ERP composition root; preserved existing TPS scope serialization and dependency failure vocabulary; reordered outage, admission, latency, and injected-error handling as specified.
- **State behavior:** The limiter retains accepted timestamps only, expires arrivals at age `>= 1_000ms`, uses indexed queues with periodic compaction, prunes inactive scopes during acquisitions, and preserves per-scope history across live cap updates and resets. It remains intentionally process-local and restart-ephemeral.
- **Verification:** `pnpm --filter mock-erp lint`, `pnpm --filter mock-erp type-check`, and `pnpm --filter mock-erp test:unit` pass. The unit suite contains 62 passing tests, including focused rolling-window, scope, dynamic-cap, pruning, failure-order, concurrency, and TPS environment-boundary coverage. Per repository guidance, `test:composition` and `test:characterization` were not run.
- **Documentation:** Updated `docs/admin_access_protection.md`, `docs/local_development.md`, `docs/runtime_topology.md`, and `docs/repository_layout.md` to replace fixed-bucket claims with the process-local rolling-window behavior and reset limitations.
- **Remaining issues:** None identified within Task 49 scope.
