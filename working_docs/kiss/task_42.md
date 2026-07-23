# Task 42 — Prune tests by authoritative behavioural evidence

## Execution context

- **Position:** 42/45; Phase 7, after replaced mechanisms and their tests can be identified.
- **Dependencies:** Task 03 must have made the full root `pnpm type-check` gate green, and Tasks through 41 must identify deleted protocol/tooling paths and required runtime checks. If the root type-check is red, this task is blocked; do not prune tests against an untrusted baseline.
- **Standalone:** Simplify the suite by retaining the cheapest authoritative evidence for each required guarantee, removing tests that only pin deleted mechanisms and redundant cross-layer duplicates; no numeric line target applies.
- **Checklist / working record:** Primary ownership is test inventory and pruning across existing suites. Behavioural tests remain at the boundary they protect; shared fakes only through public testing entry points. Record the guarantee-to-authoritative-test inventory, deleted mechanism tests, retained multilayer rationale, gates, and skipped checks below.

## Why

Test code is a maintainability surface, but an arbitrary size quota would reward weak coverage. The correct reduction follows removal of states and mechanisms while preserving proof of the resilience story.

## Required outcome

Inventory and retain the least costly authoritative tests for: no oversell, idempotent replay, durable queue handoff, ERP backoff/circuit behaviour, run accounting, gold projection behaviour, destructive target guards, and observed P0 regressions. Delete mechanism-specific and redundant cross-layer tests only after identifying what still proves each outcome.

Evaluate and record whether these evidence-based decisions made the suite materially smaller and reduced its maintenance burden. Use concrete before/after evidence such as retired mechanism tests, duplicate scenarios, fixtures, harnesses, runtime, or reliability; these observations explain the result and are not numeric acceptance targets. If the reduction is not material, record why the retained tests protect distinct required guarantees rather than deleting assertions to manufacture a reduction.

## Concrete scope and paths

- Existing `**/*.test.*`, `**/*.spec.*`, browser/integration suites, fixtures, test helpers, root test scripts, and test documentation affected by removed code.
- Public test-helper entry points when a retained cross-package helper is genuinely shared.

For each retained guarantee, document one primary test location, boundary, runtime cost, and why it is authoritative. Keep multiple layers only where they prove distinct contracts—for example, a contract schema plus a Redis/PostgreSQL handoff integration—not merely the same UI result twice. Remove tests with deleted delta/replay/fan-out, command-graph, compatibility, or other retired mechanisms in the same change. Remove duplicate cross-layer scenarios after comparing their failure boundary; do not replace them with opaque generic test frameworks. Preserve explicit observed P0 regressions, including C1/dashboard convergence where applicable.

## Retained behaviour and non-goals

Retain confidence in all listed guarantees, focused integration at Redis/PostgreSQL/queue/worker boundaries, and required gates. Do not set a test-line quota, mass-delete assertions, run prohibited slow suites, or use test splitting alone as evidence of simplification. Do not reopen numeric size-target debate because an observed count is above or below a proposal; revisit it only when a concrete delivery constraint requires a new testing tradeoff.

## Acceptance

- [x] A guarantee-to-cheapest-authoritative-test inventory covers all required behaviours and observed P0 regressions.
- [x] Tests for deleted mechanisms are removed with their implementation.
- [x] Remaining multilayer tests have documented distinct boundary value.
- [x] No line-count target or assertion quota is used.
- [x] Required gates pass, and retained suite runtime/reliability is recorded.
- [x] The working record evaluates material suite reduction through mechanism/duplicate deletion and records the resulting maintenance-burden change without treating a count as a quota.
- [x] The full root `pnpm type-check` passes before and after pruning; no accepted test-source errors are hidden.

## Focused verification

Run affected package/unit/contract/integration/browser tests and the repository's required non-prohibited gates. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization; record them as opt-in when relevant.

## Working record

Completed on 2026-07-23. The following inventory was written before pruning and then qualified with the measured final suite results.

### Guarantee-to-cheapest-authoritative-test inventory

| Required guarantee | Primary retained test and boundary | Approximate cost | Why this is authoritative | Distinct retained multilayer evidence |
| :-- | :-- | :-- | :-- | :-- |
| No oversell | `packages/db/test/integration/db.integration.test.ts` — concurrent calls through the real Redis reservation script | Shared file: 35.65 s | Redis owns the scarcity decision; this test observes the real atomic boundary and final inventory rather than a service fake. | API generated-buy bounded-pool coverage is retained for the different connection/admission deadlock contract, not as a second oversell assertion. |
| Idempotent replay | `packages/db/test/integration/db.integration.test.ts` — pending-to-accepted and accepted replay through real Redis | Shared file: 35.65 s | It proves the stock/idempotency authority returns the same hold without decrementing stock twice. | `apps/api/test/reserve-order-service.test.ts` retains workflow evidence that a durable replay is returned/re-enqueued without re-persisting; worker persistence tests protect downstream terminal replay. |
| Durable PostgreSQL-to-BullMQ handoff | `apps/worker/test/integration/order-dispatch-recovery.test.ts` — a committed queued order missed by the API is recovered into BullMQ | File: 1.39 s | It crosses the exact crash boundary the durability claim names: PostgreSQL remains authoritative when the first enqueue never happened. | The API real-BullMQ scenario retains immediate deterministic enqueue/job identity, and worker consumer integration retains physical queue consumption. Those are producer and consumer contracts, not duplicate recovery outcomes. |
| ERP backoff and circuit behavior | `apps/worker/test/integration/order-processing-workflow.test.ts` — transient ERP retry and circuit-open delayed delivery through the real worker persistence/queue workflow | File: 15.14 s | It proves retry attempts, delayed delivery, and durable order state at the worker/ERP boundary rather than only timer math. | `apps/worker/test/unit/erp-circuit-breaker.test.ts` retains the cheap state-machine classification contract; the integration cases prove BullMQ attempt accounting and durable effects. |
| Run accounting | `packages/contracts/test/contracts.test.ts` — canonical transport equations and response/outcome projection schemas | Contracts lane tests: 1.01 s; real-k6 interruption case: 6.17 s | Contracts own `planned = started + unstarted` and `started = completed + interrupted`, so invalid accounting is rejected at the shared boundary. The k6 case independently proves a started-but-interrupted attempt populates the same canonical object. | API traffic-completion binding/finalization tests retain immutable persistence and duplicate-aware business reconciliation; web Run History tests retain only presentation of that accepted evidence. |
| Four gold signals and projection behavior | `apps/web/test/dashboard-phase6.test.ts` — one complete projection renders request surge, queue depth, inventory drain, and run/business outcome/lag | File: 102 ms | The browser consumes only complete projections, and this is the cheapest test of the public signal mapping. | API projection/recovery tests retain coherent assembly from PostgreSQL, Redis, BullMQ, and worker-derived readers; Redis dirty-signal and SSE fan-out tests retain delivery rather than UI interpretation. |
| Destructive target guards | `scripts/test-environment-safety.test.mjs` — command-wrapper target/environment/port/credential checks | Lane: 163 ms | The wrapper is the first destructive-command admission boundary and proves exact allowlisting before spawning. | DB helper unit tests retain the independently enforced import boundary; `test-database-reset.integration.test.ts` retains connected-database identity and advisory-lock release against real PostgreSQL. |
| C1/new-run dashboard convergence | `apps/web/test/dashboard-projection-state.test.ts` — deterministic `start t0 -> idle recovery t1 -> committed projection t2` comparison | File: 16 ms | It directly encodes the observed ordering regression in the sole browser projection state owner. | Hook/browser tests retain the separate one-read stream lifecycle and rendered convergence contracts. |
| Generated-buy bounded-pool deadlock regression | `apps/api/test/generated-buy-pool-admission.test.ts` — `N` simultaneous accepted buys using a PostgreSQL pool of size `N` | File: 599 ms | It recreates the observed pool-exhaustion topology and proves no nested in-admission checkout can strand all callers. | No duplicate is retained; ordinary buy service/Redis tests cover correctness but cannot prove pool liveness. |
| Recovery availability and last-known-good behavior | `apps/web/test/browser-workflows.test.ts` — failed refresh retains the labelled Watch projection | File: 3.48 s | It verifies the user-visible warning and preserved data at the composed browser boundary. | Hook tests retain single-flight/retry scheduling and initial fail-closed behavior; the duplicate static rendering fixture was removed. |
| Terminal projection convergence | `apps/web/test/dashboard-hooks.test.tsx` — terminal same-scope projection applies immediately and remains quiet without polling | File: 154 ms | It proves the stream/recovery coordinator cannot strand the terminal state after traffic becomes quiet. | Browser workflow state-race coverage retains the distinct stale HTTP response versus newer terminal stream ordering contract. |
| Bounded in-fence inventory read and fence release | `apps/api/test/demo-run-finalization-service.test.ts` — controllable read timeout/cancellation followed by a successful second finalization | Shared file: 15.71 s | It observes the PostgreSQL advisory fence from a second connection and proves timeout releases the transaction/lock while the Redis read remains inside the fence. | The operation-factory unit test retains only adapter cleanup/disconnect on abort; it does not duplicate transaction/fence correctness. |

### Pruning decisions and rationale

- Deleted `scripts/test-command-graph.test.mjs` and removed it from `test:scripts`. Its seven tests parsed manifests, Turbo JSON, Vitest configuration text, and TypeScript configuration to maintain a second representation of the command graph. The executable root commands, package configurations, root type-check, and focused script tests remain authoritative. `docs/automated_testing_infrastructure.md` now states that boundary explicitly.
- Deleted `apps/web/test/dashboard-recovery-ui.test.ts`. Its two static-markup cases duplicated initial-unavailable and labelled last-known-good behavior already covered by the recovery hook, dashboard control surface, and composed browser workflow. No reusable fixture or harness depended on the file.
- Removed legacy-journal, emitted-era transport, retired timing/diagnostic, old policy, old dashboard delta, and old realtime URL negative fixtures from contracts, load orchestrator, API persistence readers/finalization/history/classification, web hooks/smoke, and worker run-config tests. Current strict persisted-shape failures remain through missing-current-field and malformed-current-value cases with contextual errors.
- Removed three real-infrastructure scenarios from `apps/api/test/api.test.ts`: route-level no-oversell, accepted replay plus status read, and confirmed/failed replay plus status history. The real Redis integration owns no-oversell/idempotency; the API service and header test own public replay semantics; `OrderStatusService` and worker persistence own terminal status/history. Keeping all three layers in one API scenario repeated the same durable rows and response facts without a distinct failure boundary.
- Removed the flaky stale-child-callback test from `load-orchestrator.test.ts`. It raced observing a pushed completion report with internal execution-slot cleanup and asserted callback identity mechanics. Retained tests already prove the public one-slot conflict, bounded cancel/reap, natural completion, shutdown, durable persistence, retry, and cleanup contracts.
- Kept the natural-completion shutdown test because it protects a distinct durable-delivery contract, but corrected its wait point from the pre-removal `cleanupStarted` flag to the observable missing work directory. This eliminated a separate asynchronous assertion race without weakening the outcome.
- Corrected `k6-compat.test.ts` to assert interrupted-at-termination counts only on canonical `transportAttemptCounts`; it no longer expects duplicate totals on HTTP and delivery projections. This is retained real-k6 evidence, not a compatibility fixture.
- Removed the two bare-key deletes from `packages/db/src/redis-erp-resilience.ts`. The exported base constant remains the prefix for current `:catalog` and `:run:<id>` keys, while repository search confirms no current reader or writer uses the bare pre-scope key. Current scoped set/get/TTL/clear behavior is unchanged; deleting an obsolete disposable Redis shape is no longer a hidden side effect or an untested compatibility path.
- Kept focused Redis/PostgreSQL/BullMQ/worker integration, dashboard C1/gold/terminal/last-known-good coverage, generated-buy bounded-pool liveness, destructive guards, and the bounded in-fence/fence-release regression unchanged.

### Concrete before/after evidence and maintenance impact

- Before pruning: 130 test files and 53,955 test lines. After pruning: 128 test files and 52,802 test lines. These observations are evidence of the affected surface, not an acceptance target.
- The two deleted files remove one command-graph mirror and one duplicate static UI fixture. Scenario or assertion pruning touched 13 retained test files: six API files, the main load-orchestrator suite, two web files, one worker integration file, the contracts suite, the DB integration suite, and the runtime-smoke script suite. `k6-compat.test.ts` changed separately to repair canonical accounting; the main load-orchestrator suite also received the observable cleanup-wait correction. No new fixture directory, fake framework, snapshot format, or generic harness was introduced.
- The final repository diff removes 1,182 lines and adds 86, for a net reduction of 1,096 lines. This is recorded as evidence, not used as an acceptance target.
- The first pre-pruning `pnpm test` attempt stopped after 32.581 s at the stale-child-callback race before reaching API or integration tiers, so there is no honest green before-runtime comparison. The first post-pruning attempt exposed the separate cleanup-flag assertion race after 31.092 s. After waiting on the observable directory result, the load-orchestrator unit lane passed three consecutive times (135 tests; 6.88 s, 11.06 s, and 10.82 s), and the full root suite passed in 183.740 s.
- The material maintenance reduction comes from fewer historical shapes, fewer duplicated real-infrastructure setup/mutation/assertion blocks, one fewer command-parsing authority, and removal of two timing-sensitive internal-mechanism cases—not from compressing assertions or setting a numeric quota.

### Verification and gates

- Parent-provided clean pre-change baseline: root `pnpm type-check` passed all 11 Turbo tasks plus `tsc -p tsconfig.test.json --noEmit`.
- `pnpm type-check` after pruning passed all 11 Turbo tasks plus the root test-source compiler.
- `pnpm test` passed in 183.740 s against isolated PostgreSQL/Redis: contracts 112, logger 10, DB unit 54, Mock ERP 62, worker unit 86, load orchestrator unit 135, web unit 198, API 551, worker integration 48, and DB integration 72 tests. The Node environment/script lanes passed 7 and 52 tests respectively.
- `pnpm --filter load-orchestrator test:unit` passed three consecutive standalone runs, 135 tests each.
- `pnpm test:k6-compat` initially exposed the stale duplicate accounting expectations, then passed 4 tests in the rebuilt pinned k6 container; final command wall time was 40.468 s and the real interruption scenario took 6.17 s.
- `pnpm lint` passed across 420 files. Focused Biome checks and `git diff --check` passed.
- `pnpm format:check` checked the Task 42 files successfully but remains repository-wide red on the pre-existing untouched import ordering in `apps/api/src/runtime/pending-persistence-operation-factory.ts`.
- Isolated test infrastructure was started with `pnpm test:infra:up` and removed with `pnpm test:infra:down`; the empty Compose network created by the one-off k6 compatibility container was also removed.
- `pnpm test:composition` and `pnpm test:characterization` were not run because repository instructions prohibit them without explicit authorization. The unified runtime smoke was not run because Task 42 changed test evidence rather than runtime behavior; its complete script unit boundary passed through `pnpm test`.

Correction cycle 1 removed the unscoped ERP circuit-key compatibility deletes and reran the focused scoped-state integration boundary. Repository search found only the base constant declaration, current catalog/run key construction, and scoped-prefix scan. The focused `isolates scoped ERP circuit snapshots` DB integration test passed (1 test, 63 skipped; 3.10 s Vitest duration), DB package type-check and lint passed, focused Biome passed, the root `pnpm type-check` passed all 11 Turbo tasks plus the test-source compiler, and `git diff --check` passed. No current documentation describes the bare key or promises its cleanup, so no additional `docs/` update was needed; the testing-documentation change above remains the only current claim affected by this task.

### Final self-review

- Scope stayed within test inventory/pruning, one test reliability correction, the root script list, directly affected testing documentation, and removal of two inseparable obsolete bare-key Redis cleanup calls. Current scoped ERP resilience behavior and ownership boundaries did not change.
- Shared contracts remain the accounting/schema authority, DB/Redis/BullMQ integrations remain at their real infrastructure boundaries, routes/services were not broadened, and no infrastructure client or generic test framework was added.
- Required error/status vocabulary, public projection behavior, correlation handling, durable queue/ERP recovery, and destructive guards retain authoritative coverage.
