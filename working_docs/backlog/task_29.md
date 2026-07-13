# Task 29: Add an event watermark so out-of-order live events cannot regress dashboard state

## Execution context

- **Execution order:** This is task 29 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web / dashboard state
- **Source:** independent review (medium)
- **Solved elsewhere:** none — stale-data-wins ordering problems exist on all three branches in different forms.
- **Locations:** `apps/web/src/app/components/operator-dashboard.tsx:255`, `packages/db/src/business-outcome-dashboard.ts:223`

The client rejects events older than the HTTP snapshot baseline but never advances a watermark when applying live projections, and asynchronous worker projection reads/publishes can complete out of order. A diagnostic applied T+10 then T+5 and observed state regressing. Advance a per-projection watermark on every applied event.

## Implementation record

### Status

Completed on 2026-07-13 at the browser dashboard reducer boundary. No route, API, database, event-contract, or server response changes were made.

### Design and completed scope

- Added reducer-owned event watermarks for run lifecycle, inventory, queue, the atomic business-outcome plus consistency-lag projection, and traffic keyed by metric name. Watermarks are intentionally absent from `DashboardRecoveryResponse` and all server contracts.
- An event must have an `occurredAt` strictly newer than its projection watermark. Equal timestamps are first-wins because the current finalized event vocabulary has no trustworthy sequence or tie-break field. Traffic metric names have independent watermarks, so Task 30 can deliver rate, latency, and failure for one window timestamp without suppressing sibling metrics.
- Watermarks advance only after the projection is actually applied. Refresh-discarded, refresh-window, unavailable-baseline, foreign-run/sale-offer, stale-baseline, and inventory/queue source-older events leave them unchanged.
- Initial and completed authoritative recovery snapshots rebase every projection to `recoveredAt`. The Task 28 new-run transition clears old projections and rebases all watermarks to the incoming run event. Same-run lifecycle updates no longer rewrite the authoritative `recoveredAt` baseline and advance only the lifecycle watermark, preserving independent projection ordering.
- Preserved Task 27's `inventory.lastUpdatedAt` and `queue.updatedAt` guards and Task 28's scope classification, reset, and recovery triggering. Recovery remains authoritative and the existing serialized follow-up behavior remains unchanged.
- Documented the general browser ordering rule in `docs/cross_service_conventions.md` under Dashboard Real-Time Transport, while retaining metric-specific context in the load-generation streaming guide.

### Verification

- `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.config.ts test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx` from `apps/web`: 2 files, 27 tests passed. Coverage includes a T40 same-run lifecycle event followed by independent T20 inventory and T25 business-outcome projections against their own T10 baselines.
- `pnpm --filter web type-check`: passed; Next route types generated and TypeScript reported no errors.
- `pnpm --filter web lint`: passed; Biome checked 73 files with no fixes.
- `git diff --check`: passed.
- Composition and characterization suites were not run, per repository instructions and task scope.

### Caveats and follow-up

- Ordering uses producer `occurredAt`; equal timestamps deliberately retain the first applied finalized projection until a future contract adds a reliable sequence/tie-breaker.
- Traffic watermark keys are unbounded only by the contract's finite metric-name enum, and Task 30 can reuse the per-name boundary without changing client state shape.
