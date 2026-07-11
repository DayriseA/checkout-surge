# Task 15: Scope the ERP circuit breaker per run (and honor snapshot breaker thresholds)

## Execution context

- **Execution order:** This is task 15 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** worker / resilience
- **Source:** independent review (medium) + comparison (worse)
- **Solved elsewhere:** the relevant implementation evidence is inlined below. A proven design selects a breaker by `runId` plus the accepted snapshot's breaker thresholds; retain this repository's stronger breaker state machine and adapt only its scoping, configuration, publication, and lifecycle.
- **Locations:** `apps/worker/src/index.ts:153`, `apps/worker/src/application/erp-circuit-breaker.ts:43`

The worker constructs a single circuit breaker for all orders with no run or config key, so one run's chaos configuration opens the breaker for unrelated runs and catalog orders (confirmed by a two-run probe). Thresholds come from process-level environment variables, not the run snapshot's backpressure config.

## Standalone implementation context

### Current behavior and ownership boundary

- `apps/worker/src/index.ts`, `startWorker()`, constructs exactly one `ErpCircuitBreaker` and places it inside `RunScopedBackpressureOrderConfirmation`. Consequently the semaphore is run-scoped but the breaker wrapped by it is shared by every job. Its `failureThreshold` and `resetTimeoutMs` come from `WorkerConfig.erpCircuitFailureThreshold` and `WorkerConfig.erpCircuitResetTimeoutMs`.
- `apps/worker/src/runtime/config.ts`, `WorkerConfig` and `loadWorkerConfig()`, source those fallback values from `ERP_CIRCUIT_FAILURE_THRESHOLD` (default `5`) and `ERP_CIRCUIT_RESET_TIMEOUT_MS` (default `10_000`). Keep these as catalog/no-snapshot fallback configuration; they must not override a run's immutable accepted snapshot.
- `apps/worker/src/application/erp-circuit-breaker.ts`, `ErpCircuitBreaker`, owns the strong state machine to preserve: `closed | open | half_open`, consecutive counted failures, reset timing, a single `halfOpenProbeInFlight`, dynamic `retryAfterMs`, non-counting of terminal/non-dependency failures through `isCountedFailure`, and best-effort `onStateChange` reporting. Do not replace it with a simpler breaker.
- `apps/worker/src/application/run-backpressure.ts`, `RunScopedBackpressureOrderConfirmation`, already receives both `RunConfigReader` and each `OrderProcessJob`. It reads `job.runId`, loads the accepted snapshot, and caches semaphores under `${runId}:${orderProcessConcurrency}`. This is the natural application-layer boundary at which to select both run-scoped concurrency and a run-scoped breaker. Infrastructure construction should remain in `startWorker()` and the HTTP/queue layers should remain unaware of breaker selection.
- `apps/worker/src/persistence/postgres-run-config-reader.ts`, `PostgresRunConfigReader.read(runId)`, reads `demo_runs.config_snapshot` and parses it with `acceptedRunConfigSnapshotSchema`. That immutable run record, not the current editable preset and not process environment, is the authority for run thresholds. A job without `runId`, or a job whose run snapshot cannot be found, follows the explicitly configured catalog/fallback breaker path.

### Contract and stored configuration that must agree

`packages/contracts/src/load.ts` currently defines `backpressureConfigSchema` with only:

```text
queueName
physicalQueueName
orderProcessConcurrency
drainTimeoutSeconds
pendingPersistenceRetryAfterSeconds
```

Add positive-integer `circuitBreakerFailureThreshold` and `circuitBreakerResetTimeoutMs` fields there so `AcceptedRunConfigSnapshot.backpressureConfig` is the typed source consumed by the worker. Propagate those fields through every producer of accepted snapshots: seeded preset JSON in `packages/db/src/scripts/seed.ts`, admin/public preset request and response schemas derived from the shared contract, preset editing/copying/merging in `apps/api/src/services/demo-run-service.ts`, and admin form serialization in `apps/web/src/app/components/admin-console.tsx`. Preset mutation and run creation already copy the entire `backpressureConfig`, so once parsing and UI construction retain the new fields, the accepted `demo_runs.config_snapshot` freezes them for the run.

Use the environment values as defaults when creating/migrating preset configuration and for the catalog fallback path only. Do not consult a mutable preset while processing an accepted run: a later preset edit must not change an existing run's breaker identity or thresholds.

### Reusable run/config-keyed mechanics

The useful proven mechanic is a selector/decorator with this shape:

```ts
private readonly runCircuitBreakers = new Map<
  string,
  { configKey: string; circuitBreaker: ErpCircuitBreaker }
>();

const configKey = JSON.stringify({
  failureThreshold: snapshot.backpressureConfig.circuitBreakerFailureThreshold,
  resetTimeoutMs: snapshot.backpressureConfig.circuitBreakerResetTimeoutMs,
});
```

For a job with both `runId` and a valid accepted snapshot, reuse the cached breaker only when that run's `configKey` matches; otherwise construct a new `ErpCircuitBreaker` with the snapshot values and replace that run's cache entry. For jobs without run scope/snapshot, use a separate fallback breaker configured from `WorkerConfig`. Never use the fallback breaker's state for a valid run, and never allow one run's open/half-open/failure count to affect another run.

Prefer a small run-scoped confirmation decorator or selector rather than adding maps to the pure state machine. Inject a breaker factory from `startWorker()` so the decorator can create `ErpCircuitBreaker` instances with the existing `HttpErpOrderConfirmation`, `isTemporaryErpDependencyError`, clock behavior, and state publisher. This preserves dependency composition in the worker composition root and keeps `ErpCircuitBreaker` single-purpose.

The config key is defensive even though accepted snapshots should be immutable: it prevents accidental reuse if test fixtures or repaired legacy data expose different thresholds for the same `runId`. Replacing an entry intentionally resets its old state; log/report this exceptional replacement if observability is useful.

### State schema and publication migration

`packages/contracts/src/erp.ts`, `erpCircuitBreakerSnapshotSchema`, currently publishes this state:

```text
state
consecutiveFailureCount
failureThreshold
resetTimeoutMs
openedAt
nextAttemptAt
halfOpenProbeInFlight
updatedAt
```

`packages/db/src/redis-erp-resilience.ts` stores it under the single key `checkout-surge:erp:circuit-breaker-snapshot`, and `apps/api/src/services/erp-status-service.ts` reads that one key to derive `circuit_open`, `circuit_half_open`, and dependency health. Once multiple breakers exist, letting them race to overwrite this key makes status nondeterministic and can display a catalog or old-run breaker as the active run's state.

Make scope explicit in the publication design. The preferred shape is a run-qualified Redis key (for example `checkout-surge:erp:circuit-breaker-snapshot:run:<runId>`) plus a distinct catalog/fallback key, with reader methods accepting the requested/active run scope. If the ERP status endpoint is intentionally active-run-only, resolve the active run before reading and document that behavior. Alternatively, a scoped envelope/collection is acceptable, but it must identify `runId` versus catalog unambiguously and avoid last-writer-wins semantics. Keep all existing snapshot fields so the dashboard does not lose the stronger state-machine diagnostics.

Update the shared contract, DB adapter, API state-reader interface/service tests, and any endpoint fixtures together. Delete or deliberately ignore the legacy unscoped Redis key during rollout/reset so stale global state cannot report a false outage. If reset/teardown helpers clear resilience keys, extend them to clear the run-qualified namespace. Do not introduce an unbounded permanent registry: evict breaker and published state when a run is terminal/reset, or use a bounded/TTL policy aligned with run/dashboard retention. Cache cleanup must not remove a breaker while jobs for that run can still retry.

### Caveats and non-goals

- Preserve the existing counted-failure classification: only temporary ERP dependency failures trip the breaker; terminal ERP responses and local persistence/reporting failures must not.
- Preserve single-flight half-open probing. A simpler implementation that admits every caller once the timeout elapses is a regression even if its run scoping is correct.
- Do not solve worker-wide BullMQ concurrency switching here. This task scopes the confirmation breaker and reads its two thresholds from the accepted snapshot; the existing run-scoped semaphore remains the concurrency mechanism.
- Do not move run configuration reads into the queue consumer, ERP HTTP client, or route layer. Reuse `RunConfigReader` at the application boundary and avoid duplicate reads within one confirmation when composing backpressure and breaker selection.
- Missing/invalid run configuration must have an explicit observable fallback policy. It must not silently merge the job into another run's breaker. Invalid accepted snapshots should continue to fail schema validation rather than being partially accepted.
- Multi-process workers do not share in-memory breaker state. This task fixes cross-run contamination within a worker process; a distributed breaker would require atomic shared state and is outside scope unless explicitly chosen as a broader follow-up.

## Focused verification

- Contract tests accept positive snapshot thresholds and reject zero, negative, fractional, missing, and unknown values according to the strict schema; preset/run fixtures and seed parsing include both new fields.
- A two-run unit probe uses different thresholds, opens run A, and proves run B still delegates and retains its own closed/failure state. A catalog job also remains independent of both runs.
- A snapshot-threshold test proves a run configured with threshold `2` opens after two counted failures even when the environment fallback is `5`, and proves its reset timeout controls `nextAttemptAt`/retry admission.
- Same `runId` plus the same threshold config reuses state; same `runId` plus a different config key replaces the breaker deterministically. Missing `runId` and missing snapshot exercise only the fallback breaker.
- Existing `ErpCircuitBreaker` unit coverage continues to prove one half-open probe at a time, close-on-success, reopen-on-failed-probe, dynamic retry delay, terminal-failure exclusion, and best-effort state reporting.
- Publication tests prove run-qualified snapshots cannot overwrite one another, catalog state is separate, active/requested-run status reads the intended key, and legacy/reset cleanup removes stale state.
- A lifecycle test proves terminal/reset cleanup does not leak cached breakers or Redis state and does not evict state while retryable jobs for that run are still outstanding.
