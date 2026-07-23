# Task 37 — Establish one revisioned dashboard projection authority

## Execution context

- **Position:** 37/45; Phase 6, after Task 36 baseline evidence and before coalesced publication or browser migration.
- **Dependencies:** Task 36 must have pinned public behaviour and measured the existing delivery volume. The current recovery data must be sufficient to build a coherent UI view.
- **Standalone:** Build one server-owned, complete UI projection per run/offer scope, identified by scope and monotonic revision, and make it the only authoritative dashboard state source for both live and recovery paths.
- **Checklist / working record:** Primary ownership is the shared dashboard projection contract and its server-side builder/authority. `@checkout-surge/contracts` owns public schema/types; application services own assembly and revision allocation; HTTP/SSE routes only invoke those services. Record projection-size evidence, revision/order decisions, tests, and skipped checks below.

## Why

The current mixed delta-plus-recovery model requires browser reconstruction, watermarks, deduplication, and replay-like repair. A complete, revisioned projection makes the server the sole assembler of dashboard state and lets every consumer choose the newest coherent view.

## Required outcome

Introduce exactly one small projection schema and one builder/authority. The same scope ID and monotonic revision semantics must be used for a live view and a recovery read, and be safe across reconnect and process restart ordering.

## Concrete scope and paths

- `packages/contracts/src/**`: a versioned/dashboard projection schema containing scope identity, revision, lifecycle/outcome state, and the complete small UI model needed per run/offer.
- `apps/api/src/**`: dashboard projection builder, persistence/revision authority, recovery service and route integration, and producer adapters for existing aggregate readers.
- Existing dashboard event/recovery tests and fixtures.

The projection must contain the four dashboard gold signals (request surge, queue depth, inventory drain, and run/business outcomes), lifecycle/terminal data, and only UI data needed for coherent replacement. Use one explicit authority to allocate monotonically increasing revisions per scope; do not derive ordering from clocks or event arrival order. A process-local counter that resets on restart is insufficient. Use the smallest durable per-scope counter already compatible with the runtime (for example, a Redis atomic counter beside the projection) or a persistently allocated ordered restart epoch plus sequence, and name that storage/owner in the Working record. This ordering state is not an event log and must not grow per revision. Build the projection from the existing one-second load aggregate and coalesced inventory, queue, and business readers rather than adding raw-event subscriptions or duplicate stores. Define restart/reconnect behaviour: a returned projection is self-contained, revision comparisons are scoped, and an old connection cannot overwrite a newer recovered projection.

Measure representative serialized projection size against Task 36's frame baseline. If a full projection cannot meet the desired display cadence, select **revisioned invalidation plus one atomic projection read** as the sole normal protocol, document the measured evidence and threshold, and do not retain full-projection streaming alongside it. Otherwise use full-replacement projections as the sole target protocol. In either case, do not build an event replay system or a second state model.

## Retained behaviour and non-goals

Retain current server-side aggregation/coalescing and durable diagnostic reads. Do not migrate the web client yet, delete the existing reducer yet, add per-order live fan-out, introduce another projection builder, or alter reservation/queue/ERP ownership.

## Acceptance

- [x] One public projection contract has a scope ID and monotonic scoped revision.
- [x] One server authority builds the complete coherent UI model and owns revision allocation.
- [x] Live and recovery expose the same schema and ordering semantics.
- [x] Ordering is safe for reconnect and process restart; tests prove stale scoped data cannot win.
- [x] Revision allocation cannot reset or reuse an older value after API restart, and a focused restart test proves it.
- [x] Existing aggregation/readers are reused, not duplicated.
- [x] Projection-size evidence selects full streaming or sole revisioned invalidation-plus-read; no replay/second normal protocol is added.

## Focused verification

Run contract tests, projection-builder/service tests, recovery-route tests, and the focused ordering/restart scenarios. Repeat the bounded representative measurement for serialized size. Do not run composition or characterization lanes without explicit authorization.

## Working record

Completed 2026-07-23.

Contract and assembly:

- `dashboardProjectionSchema` is the one public wire shape. Its identity is `schema = "checkout-surge.dashboard-projection"` and `version = 1`. It contains the existing complete recovery UI model—run lifecycle/configuration, request metrics and terminal transport counts, inventory, queue, ERP, aggregate business outcomes, consistency lag, and current completion outcomes—plus only `scopeId` and `revision` ordering metadata. `dashboardRecoveryResponseSchema` is an exact schema alias, not a wrapper or nested copy, so the current browser can ignore the new metadata while Task 39 remains pending.
- Active scope IDs use the exact encoding `run/<runId>/sale-offer/<saleOfferId>`; the global no-current-run view uses the single scope ID `idle`. Comparisons are explicitly same-`scopeId` only. A higher revision from `idle` or another run cannot replace a run-scoped projection.
- `DashboardProjectionService` is the sole assembler. Recovery calls its compatibility `getRecovery()` adapter; Task 38 has the direct `build({ scope })` seam for live and terminal publication. Both return the same schema and allocate through the same authority. The service reuses the existing context, inventory, queue, ERP, traffic-metric, business-outcome, consistency-lag, completion-outcome, and transport-accounting readers. It adds no subscription, replay, raw-event reader, store, or per-order query.

Revision authority and ordering:

- `RedisDashboardProjectionRevisionAllocator` is the only revision allocator. Active-scope allocation is one Redis script that verifies the canonical generated-run inventory hash still exists and matches both run and sale-offer identity before incrementing `demo-run:<runId>:dashboard-projection-revision`. Idle uses the one permanent `INCR dashboard-projection:idle:revision` key. There is no TTL, process-local counter, fallback, revision history, or PostgreSQL state.
- Exact generated-run cleanup begins with one Redis script that retires the projection scope by deleting the canonical inventory state and revision key together, before scanning/unlinking the rest of that run's Redis namespace. Allocation and retirement therefore serialize in Redis: allocation either increments while the scope exists, or observes retirement and fails without recreating revision 1. If later Redis cleanup or durable deletion fails, the durable run remains retryable but its projection scope stays retired. Revisions are monotonic during a scope's lifetime; the one idle counter remains permanent.
- One API-process build queue serializes aggregate assembly because otherwise an earlier slow read can finish after a later read and receive the larger revision. Revision allocation occurs only after all aggregate reads for that build settle. The queue owns no revisions and is not a durability fallback; Redis remains the allocator. This is sufficient for the accepted one-API topology, whose shutdown drains requests before replacement. A focused test holds the first read, starts a second build, and proves the second cannot assemble or allocate ahead of it.
- Real-Redis tests construct a fresh projection service/client and prove revision 1 becomes revision 2 after restart, prove allocation after exact cleanup fails without recreating the counter, and race allocation against retirement to prove either the in-lifetime increment wins before cleanup or allocation observes retirement. Contract tests prove lower, duplicate, and higher foreign-scope projections cannot win the scoped comparison.

Protocol size decision:

- Engineering full-frame budget: **64 KiB serialized UTF-8**. This is a deliberately conservative application budget for one future SSE projection, not a Caddy hard limit. A target projection below that budget leaves ample implementation headroom; because Task 38 will publish at a bounded sub-second/one-second display cadence rather than raw-event cadence, an invalidation/read round trip would add another authority and request path without a demonstrated need.
- Command: `pnpm runtime:smoke:load -- --dashboard-delivery-baseline`.
- Fixture/window/counting remain Task 36's existing seeded `preview-1k` and common fixed 30,000 ms gate. Task 37 added a bounded sequence of at most six schema-validated reads, 500 ms apart, and selected the largest projection while the measured scope was active or draining with `Buffer.byteLength(JSON.stringify(projection), "utf8")`. The result reports sample count plus the selected sample's lifecycle, metric/outcome counts, queue presence and failed-job occupancy, and transport-count presence/value. Existing readers bound recovery to 20 recent metrics and 8 recent completion outcomes. This did not create another harness, exhaust the normal 12-read source allowance, or change the incremental SSE protocol.
- Observed representative serialized projection: **8,985 bytes**, **13.7%** of the 64 KiB engineering budget. All **6** bounded samples matched the active scope; the selected largest sample was `active` with **6** recent metrics, the reader-bound **8** recent completion outcomes, queue data present with **0** recent/total failed jobs, and no terminal transport counts yet. The fixed terminal transport-count object is small relative to the remaining measured headroom. The same run observed one scope, **1,122** raw Redis events, **1,124** SSE frames, and **1,122** data/contract-valid/run-attributable/dashboard updates. Task 36's accepted comparison baseline remains 1,043 raw events, 1,045 frames, and 1,043 updates. The measured size selects **full-replacement projection streaming as the sole target protocol**. No invalidation protocol, replay, or second projection transport was implemented.

Focused verification:

- `pnpm exec vitest run packages/contracts/test/contracts.test.ts packages/db/test/unit/redis-inventory-maintenance.test.ts` — passed, 101 tests.
- `pnpm build:shared` — passed.
- `pnpm test:infra:up` and `pnpm --filter @checkout-surge/db test:db:migrate` — focused PostgreSQL/Redis started and migrations rebuilt successfully.
- `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/dashboard-projection-revision.test.ts test/dashboard-recovery-service.test.ts test/dashboard-recovery-workflow.test.ts test/dashboard-routes.test.ts` — passed, 32 tests across the final focused files.
- `pnpm --filter @checkout-surge/db exec vitest run --config vitest.unit.config.ts test/unit/redis-inventory-maintenance.test.ts` — passed, 4 tests.
- `pnpm --filter web exec vitest run --config vitest.config.ts test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx test/dashboard-control-surface.test.ts test/admin-controller-state.test.tsx test/browser-workflows.test.ts test/public-demo-hydration.test.tsx` — passed, 95 tests across the focused compatibility files.
- `node --test scripts/runtime-smoke-load.test.mjs` — passed, 19 tests.
- `pnpm type-check` — passed all package and test TypeScript checks.
- `pnpm lint` — passed across 423 files.
- `pnpm exec biome check <all changed Biome-managed files>` and `git diff --check` — passed.
- `pnpm format:check` — all Task 37 files passed; the repository-wide command exited 1 only on the pre-existing import-order finding in `apps/api/src/runtime/pending-persistence-operation-factory.ts`, unchanged by this task.
- `docker compose config --quiet` — passed.
- `pnpm runtime:up` — rebuilt and started the reference runtime; the existing non-fatal Next.js Edge-runtime warnings remained.
- `pnpm runtime:setup` — migrations and seed completed.
- `pnpm runtime:smoke:load -- --dashboard-delivery-baseline` — passed with the size and delivery evidence above; exact generated-run teardown completed.
- `pnpm runtime:down` and `pnpm test:infra:down` — runtime containers stopped; focused test containers and volumes removed.

Task boundaries retained: the browser still consumes the incremental SSE protocol, the normal SSE publisher/cadence/backpressure behavior is unchanged, the old reducer and events remain, and no Task 38–40 delivery, migration, or deletion work was performed. Composition and characterization were not run because they are explicitly excluded.
