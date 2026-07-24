# Task 45 — Final simplification convergence audit and handoff

## Execution context

- **Position:** 45/45; final cross-cutting convergence and handoff task.
- **Dependencies:** All intended Phase 0–7 changes must be complete or explicitly recorded as blockers. This task may make only narrow residue fixes; it is not authorization for another broad refactor.
- **Standalone:** Verify that the final architecture has one clear owner for each retained guarantee and that removed mechanisms have not survived as dormant code, scripts, docs, or tests. Produce a handoff that states the intended design without depending on the audit document.
- **Checklist / working record:** Primary ownership is final architecture/residue audit and handoff evidence. Respect package and service ownership when fixing residue; routes stay thin and infrastructure remains composed explicitly. Record inspected locations, fixes/blockers, commands/results, and measurable reductions below.

## Why

Large simplification waves often leave dormant compatibility paths, duplicate owners, and stale documents that preserve the old mental model. A final check must assess authorities, state models, and supported modes—not merely diff size.

## Required outcome

Inspect the repository for listed residue, fix narrow confirmed remnants or record a concrete blocker, run root type-check/lint and required non-prohibited tests as the environment allows, and hand off the final architecture, retained guarantees, removals, and measured reductions. A blocker may be recorded for handoff, but this task and the overall plan must not be marked complete while that blocker prevents any required Task 01–44 outcome.

## Concrete scope and paths

Audit relevant source, contracts, scripts, tests, and docs for:

- cross-replica leases/attestation and other production-impossible coordination;
- legacy normalizers/compatibility reads;
- duplicate transport summaries;
- multiple repair owners or multiple K6 completion-delivery owners;
- mock ERP PostgreSQL persistence;
- mixed dashboard protocol, replay/delta reducers, and per-order realtime fan-out;
- redundant runtime triggers, dead scripts/wrappers, and obsolete tests/docs; and
- scope-page administrative metadata.

For confirmed narrow residue, delete or simplify it at its owning boundary and update the directly affected test/doc in the same change. If removal would alter an uncompleted required guarantee, leave it intact and record the exact blocker, owner, consequence, and follow-up rather than masking it. Do not reopen accepted product scope or add a replacement abstraction.

The handoff must explicitly state this intended architecture and retained guarantees: Redis atomic no-oversell and idempotency; durable records plus one bounded repair owner; durable queue recovery; ERP resilience and attempt evidence; declarative database invariant core; traffic/business completion split; one revisioned projection; durable diagnostics; proportionate security; one bounded child-process owner plus one durable completion path; independent non-root images; focused tests; and concise scope authority. State removals as well: replica coordination/attestation, legacy normalizers, duplicate transport facts, incident remediation residue, mock-ERP database boundary, mixed dashboard protocol, per-order realtime fan-out, redundant scripts, and scope administration metadata.

## Retained behaviour and non-goals

Retain the project’s demonstrated resilience boundaries and explicit opt-in validation lanes. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit user authorization, claim green checks that did not run, or make broad unrelated edits to chase every theoretical improvement.

## Acceptance

- [x] Listed residue categories have been searched and each is removed or intentionally retained with a requirement-based rationale; no blocker remains against a required plan outcome.
- [x] Any fixes are narrow and include directly relevant tests/docs.
- [x] `pnpm type-check`, `pnpm lint`, and `pnpm test:required` are run with exact outcomes when test infrastructure is available; otherwise `pnpm test` and all feasible focused gates run and each unavailable infrastructure lane (including `test:k6-compat`) has an exact skip reason.
- [x] Composition and characterization are left opt-in unless explicitly authorized.
- [x] Handoff lists final architecture, retained guarantees, removals, blockers, and a measurable reduction in authorities, states, or modes.
- [x] Final self-review confirms scope, phase boundary, ownership, contract consistency, vocabulary, and verification status.

## Focused verification

Run `pnpm type-check`, `pnpm lint`, and `pnpm test:required` after inspecting the current package scripts; if Docker/test infrastructure is unavailable, run `pnpm test` plus every feasible focused gate and record exactly why `pnpm test:k6-compat` could not run. Run targeted tests for any narrow residue fix. Record environmental failures separately from test failures. Do not run `pnpm test:composition` or `pnpm test:characterization` by default.

## Working record

### Status and audit boundary

- **Status:** complete; implementation, focused verification, required root gates, cleanup, and final review passed.
- The audit covered the current source, contracts, tests, 18 top-level runtime/test scripts, 11 live documents, package manifests, Compose wiring, the single database baseline and its metadata, and the completed Task 12–44 records relevant to the eight residue categories. Historical `working_docs/kiss/task_*.md` records retain truthful removed-mechanism names as history and are not runtime residue.
- The review began from commit `229320e18dee81630832018d30c462d427f53539` on `simplify`. The initial working tree was clean. No broad refactor, product-scope change, dependency change, migration change, or route/wire-shape change was made.

### Residue evidence and decisions

| Category | Inspected evidence | Finding and decision |
| --- | --- | --- |
| Cross-replica leases, attestation, and production-impossible coordination | Worker admission/config/queue and recovery persistence; API recovery/admin/maintenance owners; web/Caddy configuration; Compose; `docs/architecture.md`, `docs/runtime_topology.md`, and `docs/admin_access_protection.md`; searches for lease, attestation, pause-owner, replica, and advisory-lock symbols | No Redis admission lease, dashboard recovery budget store, admin-login Redis store, Caddy attestation, pause-owner key, or replica ownership protocol remains. Retained `ORDER_RECOVERY_LEASE_MS` is the restart-safe PostgreSQL order-recovery claim lease, not admission or replica scaling. Retained PostgreSQL advisory locks protect the global run/reset writer, terminal-versus-buy/publication fences, and the one test-database rebuild serializer. These are named correctness fences. The stale topology sentence suggesting other replica mechanisms were pending was replaced with this exact distinction. |
| Legacy normalizers and compatibility reads | Shared persisted-JSON contracts and DB JSON boundary; finalization/history/journal readers; Redis inventory reservation Lua; BullMQ failed-job disposition reader; run-history DTO exports; searches for legacy normalizers, migrations, old fields, compatibility aliases/defaults, and retired helper names | No persisted-JSON or execution-journal normalizer remains. Four narrow remnants were removed: missing Redis `inventoryScope` no longer defaults to `catalog`; non-JSON dead-letter marker text no longer becomes a disposition (current JSON `failedReason` and current progress metadata remain); ERP attempt persistence no longer accepts test-double-only `void`; and the anonymous `RunHistoryDetailResponse` compatibility alias was deleted in favor of the one explicit public DTO. Current metric identifier `traffic.scheduled_request_rate` is intentionally retained as the public metric vocabulary, not a second accepted payload shape. |
| Duplicate transport summaries | `packages/contracts/src/traffic-transport-counts.ts`, completion/report contracts, finalization/history/dashboard projections, accepted-response accounting, K6 parser/diagnostics, and web renderers; searches for `apiRequestLifecycleSummary`, retired emitted/unstarted/shortfall fields, and all transport summary names | `transportAttemptCounts` is the sole five-total attempt accounting object: planned, started, completed, interrupted, and unstarted. `httpSummary` contains HTTP response/status facts, while `trafficDeliverySummary` contains delivery quality and diagnostic classifications; neither duplicates the five totals. No `apiRequestLifecycleSummary` or retired reconstruction field remains. Retained started/completed source counters inside K6 terminal diagnostics are provenance used to validate the canonical totals, not another public accounting authority. |
| Multiple repair or completion-delivery owners | API composition, reservation/recovery/finalization services and operation factories; load-orchestrator composition, execution store, child supervisor, and delivery coordinator; class/construction searches | `PendingPersistenceRecoveryService` is the only production pending-persistence discovery/scheduling/retry/resolution owner and is composed once. Per-sale Redis state and the PostgreSQL audit are subordinate adapters; request-path direct recovery delegates to the same service; finalization only observes pending count. Durable order and notification queue recovery are separate named guarantees. `CompletionDeliveryCoordinator` is the sole production owner from `completion_pending` persistence through matching acknowledgement and is composed once. `K6ChildProcessSupervisor` owns child lifetime; `FileExecutionStore` owns the serialized journal; neither sends completion independently. |
| Mock ERP PostgreSQL persistence | `apps/mock-erp` manifest/source/tests, Compose dependencies/environment, readiness documentation, DB schema/baseline, and searches for Mock ERP database imports/config/tables | No database client, `DATABASE_URL`, readiness probe, confirmation table, migration, or maintenance edge remains in Mock ERP. It has only contracts/logger/Fastify/Zod runtime dependencies and process-local deterministic simulation state. |
| Mixed dashboard protocol, replay/delta reduction, and per-order fan-out | Dashboard projection contract, API recovery/scheduler/fan-out/routes, Redis dirty transport, worker transition publication, web projection state/hooks, runtime smoke, and live architecture/streaming/convention docs | One complete versioned, revisioned projection is served by HTTP recovery and SSE. Redis carries narrow projection-dirty signals; the API owns bounded latest-projection fan-out; the browser atomically compares complete candidates. No delta/event DTO, replay buffer/cursor, dedupe set, watermark, incremental reducer, snapshot scheduler, or worker per-order realtime publisher remains. The redundant `DashboardProjectionService.getRecovery()` compatibility entry point survived the earlier cutover and was removed; recovery and publication now call the sole `build()` assembler. Redis ownership documentation was corrected from “ephemeral dashboard realtime events” to projection-dirty signals. The `/dashboard/events` path is the current SSE route name, not a second event protocol. |
| Runtime triggers, dead wrappers/scripts, obsolete tests/docs, and incident residue | `packages/db/drizzle/0000_baseline.sql`, snapshot/journal, migration tests, source/test trigger search, all 18 scripts and their import/command/doc references, root command graph, live docs, and incident/remediation searches | The reviewed database has one baseline, zero production trigger functions, and zero production triggers. Trigger DDL found under API/worker tests is scoped fault injection and is removed by those tests. Every top-level script has an executable command, import, test, or documented opt-in owner; `run-in-compose.mjs` remains one small adapter for four genuinely distinct operations. Routine verification has one runtime smoke; recovery soak and composition/characterization remain distinct opt-in lanes. No incident-remediation owner/date/expiry scaffolding remains in live code/docs. Directly stale inventory/topology/dashboard wording was corrected. |
| Scope-page administrative metadata | Complete 31-line `docs/scope_and_caveats.md` plus ownership/status/review/expiry/same-change searches | The page contains only current decisions, short rationale, and authoritative links. It has no owner, status, review date, expiry, or same-change administrative fields. Product words such as payment-timeout expiry describe scope, not document administration. No change was needed. |

### Narrow fixes

- Deleted the forwarding-only `DashboardProjectionService.getRecovery()` method and migrated its workflow and test callers to `build()`. This restores the Task 37–40 intent that one assembler entry point owns recovery and live publication.
- Removed the Redis Lua `inventoryScope` default. A missing current-shape field now raises the existing contextual scope error before any inventory mutation; the integration test proves rejection and unchanged counters. `docs/redis_inventory_hot_path.md` now documents strict current shape.
- Changed `ErpAttemptPersistence.recordAttempt` from `Promise<boolean | void>` to `Promise<boolean>` and changed the sole permissive fake to return `true`. The production implementation already returned the freshness boolean, so this removes a test-only runtime mode without changing production behavior.
- Removed the BullMQ non-JSON dead-letter fallback. The current producer's JSON `failedReason` envelope remains the durable fallback when progress cannot be stored, and current structured progress remains accepted; malformed historical marker text is ignored. Focused coverage includes that rejected marker.
- Deleted the public run-history DTO compatibility schema/type aliases and migrated callers to `publicRunHistoryDetailResponseSchema` / `PublicRunHistoryDetailResponse`. The HTTP payload is unchanged.
- Updated the two stale architecture statements that still described pending replica simplification and raw realtime-event fan-out.

No blocker or deferred implementation remains.

### Measured convergence

This final pass removes five surviving modes or entry points:

1. dashboard projection assembly entry points: **2 → 1** (`build`);
2. missing-scope Redis inventory interpretations: **catalog fallback + strict current shape → strict current shape only**;
3. ERP attempt-persistence result modes: **boolean or void → boolean only**;
4. dead-letter failed-reason formats accepted by recovery: **current JSON plus arbitrary marker text → current JSON only** (with the separate current progress object retained);
5. public run-history schema/type names for one DTO: **2 → 1**.

Across production TypeScript in this pass, 26 lines were removed and 14 added, a net 12-line reduction; tests add explicit rejection evidence rather than preserving fixture-only success. Larger completed-plan reductions remain structurally visible: one reviewed migration baseline, 9 trigger functions and 22 production triggers reduced to zero, one pending-persistence repair owner, one completion-delivery owner, one dashboard projection/state protocol, one routine runtime smoke, 127 test files after the evidence-based Task 42–43 pruning, and no Mock ERP database boundary.

### Final architecture and retained guarantees

- **Checkout and repair:** Redis Lua owns atomic stock admission, no-oversell, idempotency, generated-run eligibility, and hold creation. PostgreSQL owns durable reservation/order/evidence records. One bounded `PendingPersistenceRecoveryService` repairs the Redis-to-PostgreSQL handoff; finalization observes but does not schedule that work.
- **Queue and ERP resilience:** Durable PostgreSQL order/notification recovery records and focused claim leases re-drive BullMQ publication. The worker validates durable identity, records every ERP attempt, applies bounded retries/circuit breaking, and retains operator-visible dead letters and notifications. Mock ERP remains a process-local simulator.
- **Database and completion:** Keys, foreign keys, unique indexes, checks, and explicit application workflow validation form the declarative invariant core; runtime triggers are absent. Traffic completion owns transport evidence/enrichment, while business finalization independently waits for durable business/inventory convergence and writes immutable history.
- **Dashboard and diagnostics:** One complete revisioned projection is the HTTP and SSE contract. Redis dirty signals coalesce source changes; one API assembler allocates/builds projections; bounded fan-out keeps only the latest replaceable projection; one browser state owner applies atomic scoped revision rules. Durable order, ERP, notification, run-history, transport, and K6 diagnostics remain available without per-order realtime fan-out.
- **Load execution:** One bounded child supervisor owns k6 process identity, output, cancellation, reap, and work-directory disposition. One strict atomic single-slot journal owns durable execution state. One completion coordinator owns persistence-first delivery and matching acknowledgement; there is no memory fallback or second retry loop.
- **Operations, security, and delivery:** The accepted topology is one instance of each application service. Security is proportionate: HMAC sessions, exact Origin checks, process-local bounded admin login limiting, protected control-service calls, non-root independent images, narrow service dependencies, and explicit health/readiness. Tests are focused at owning boundaries; composition and characterization remain explicit opt-in validation. `docs/scope_and_caveats.md` is the concise product-scope authority without lifecycle metadata.

### Confirmed removals

The final repository has no supported replica-coordination/attestation mode, legacy persisted-shape normalizer, duplicate transport-attempt accounting object, incident-remediation scaffold, Mock ERP database boundary, mixed dashboard delta/recovery protocol, per-order realtime fan-out, redundant runtime smoke wrapper, scope administration metadata, runtime database trigger, pending-persistence secondary scheduler, or K6 completion memory fallback/retry owner.

### Verification record

- `pnpm test:infra:up` — passed; dedicated PostgreSQL and Redis services became healthy.
- `pnpm --filter worker test:unit erp-confirmation-client.test.ts order-process-job-publisher.test.ts` — passed, 2 files / 23 tests.
- First `pnpm --filter api test:api dashboard-recovery-service.test.ts dashboard-projection-revision.test.ts demo-run-finalization-service.test.ts` — environmental prerequisite failure: stale shared `dist` artifacts could not resolve `@checkout-surge/contracts/testing`, and stale DB artifacts prevented three projection-dirty observations. It reported 3 failed files and 25 passed tests. No source assertion related to the change failed after rebuilding the owning packages.
- `pnpm --filter @checkout-surge/contracts build && pnpm --filter @checkout-surge/db build` — passed.
- Repeated focused API command — passed, 3 files / 55 tests.
- `pnpm --filter @checkout-surge/db test:integration db.integration.test.ts -t "rejects inventory state without the current scope field"` — passed, 1 selected / 63 skipped.
- `pnpm --filter @checkout-surge/contracts test:unit` — passed, 3 files / 112 tests.
- `pnpm --filter @checkout-surge/contracts build` — passed.
- `pnpm --filter web test:unit run-history.test.ts browser-workflows.test.ts` — passed, 2 files / 17 tests.
- First `pnpm type-check` — all 11 production/package tasks passed, then strict test-source checking found three remaining test spies typed against the deleted `getRecovery` entry point. The spies were migrated to `build`; `pnpm --filter api test:api dashboard-recovery-workflow.test.ts dashboard-routes.test.ts` passed, 2 files / 12 tests.
- Repeated exact `pnpm type-check` — passed all 11 package/build/type-check tasks and `tsconfig.test.json`.
- `pnpm lint` — passed, 422 files checked with no fixes.
- `pnpm test:required` — passed completely. The command ran 1,383 tests: environment safety 7, scripts 48, contracts unit 112, DB unit 54, logger unit 10, Mock ERP unit 62, load-orchestrator unit 135, worker unit 86, web unit 194, API 551, DB integration 72, worker integration 48, and Dockerized k6 compatibility 4. The k6 image built successfully and its 1 file / 4 tests passed.
- `pnpm test:composition` and `pnpm test:characterization` — intentionally not run; repository instructions keep both opt-in and the user did not authorize them.
- `pnpm test:infra:down` — passed; the dedicated PostgreSQL/Redis containers, volumes, and test network were removed. `docker compose --profile test-tools down --remove-orphans` removed the transient k6 compatibility network.
- `git diff --check` — passed. Final residue scans found none of the removed method/alias/fallback names. Final owner scans found one source definition and one production construction each for `PendingPersistenceRecoveryService` and `CompletionDeliveryCoordinator`. `git status --short --branch`, `git diff --stat`, `git diff --name-status`, and the complete diff were reviewed; the intended Task 45 changes are uncommitted and no generated build output is tracked.

### Final self-review

- **Scope and phase:** The change stayed inside the final residue/handoff boundary. It removes only confirmed forwarding, fallback, alias, and stale-document remnants; no Phase 0–7 product decision was reopened and no broad refactor was introduced.
- **Ownership and layering:** Routes remain thin contract-validation adapters. No infrastructure client moved or was created. Redis logic remains in the DB package, application workflow remains in its service, and cross-package callers use public contract exports.
- **Contract and vocabulary consistency:** The run-history wire payload is unchanged while its sole public schema/type name is explicit. Recovery callers and tests agree on `build`; ERP persistence agrees on boolean freshness; inventory state agrees on strict scope; current JSON/progress dead-letter formats agree with their producer. Existing error/status/correlation vocabulary is unchanged.
- **Retained guarantees:** Atomic no-oversell/idempotency, one bounded pending repair owner, durable queue recovery leases, advisory correctness fences, ERP evidence/resilience, declarative database invariants, traffic/business completion separation, one revisioned projection, durable diagnostics, one child supervisor/completion path, non-root images, proportionate security, focused tests, and concise scope authority remain intact.
- **Verification and hygiene:** All focused checks and required root gates passed. Composition/characterization remained opt-in as instructed. Test infrastructure and transient networks were removed, diff whitespace is clean, no blocker remains, and the working tree contains only the uncommitted reviewed Task 45 edits.
