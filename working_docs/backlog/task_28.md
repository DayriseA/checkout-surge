# Task 28: Scope dashboard state to the current run (new-run events must not relabel prior-scope projections)

## Execution context

- **Execution order:** This is task 28 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** web / dashboard state
- **Source:** independent review (medium)
- **Solved elsewhere:** none — cross-run dashboard contamination is a class all three branches share, each with a different mechanism.
- **Locations:** `apps/web/src/app/components/operator-dashboard.tsx:242`, `apps/api/src/services/dashboard-recovery-service.ts:70`

On a run-started event the reducer updates only the current-run pointer and recovery timestamp while retaining inventory, metrics, business outcomes, lag, and completion outcomes from the previous scope; only terminal events trigger recovery. A diagnostic confirmed the new run ID rendered alongside old-scope data. Reset or re-recover all projections on scope change.

## Implementation record

### Status

Implemented on 2026-07-13 at the web dashboard reducer/recovery-coordinator boundary. Shared contracts, API recovery ownership, and routes were unchanged.

### Decisions and completed scope

- The pure dashboard reconciliation layer now classifies each event as rejected, current-scope, or a demonstrably newer run scope before applying it.
- A fresh `run.started` or nonterminal `run.updated` can establish a new scope. The `run.updated` path repairs a missed `run.started`; when another run is displayed, the incoming `startedAt` must be strictly newer. When recovery is idle, the incoming start must not predate the recovery baseline. Inconsistent event/payload run IDs, terminal foreign-run events, older starts, and events older than `recoveredAt` remain rejected.
- On an accepted scope transition, the incoming run snapshot is installed while inventory, recent metrics, queue, ERP, business outcome, consistency lag, and recent completion outcomes synchronously reset to `null`/`[]`. The event occurrence time becomes the temporary baseline until recovery completes, preventing a stale-data flash and preserving timestamp ordering.
- Same-run lifecycle events retain all same-run projections. Existing terminal recovery behavior and Task 27 inventory/queue source-timestamp guards remain intact.
- Accepted scope transitions request `/dashboard/recovery` through the existing single-flight coordinator. Events or refresh requests during that read produce one serialized follow-up; no new route, API workflow, or recovery authority was introduced.
- Focused reducer tests cover idle/catalog projections to run start, run A to newer run B via a missed-start `run.updated`, same-run retention, complete immediate reset, and rejection of older-run revival. Hook coverage proves the reset is visible while recovery is unresolved and an event during that read results in one serialized follow-up.
- Review correction: the optional top-level lifecycle `runId` is checked against `event.run.runId` before all scope classification, so inconsistent same-run events and inconsistent proposed transitions leave state unchanged and cannot request recovery.
- Updated `docs/architecture.md` and `docs/cross_service_conventions.md` with the scope-transition, rejection, reset, and recovery rules.

### Verification

- `node ../../scripts/run-with-test-env.mjs pnpm exec vitest run --config vitest.config.ts test/dashboard-phase6.test.ts test/dashboard-hooks.test.tsx` from `apps/web`: 2 files, 20 tests passed.
- `pnpm type-check` from `apps/web`: passed (`next typegen` and TypeScript).
- `pnpm lint` from `apps/web`: passed (73 files checked, no fixes).
- `git diff --check`: passed.

Composition and characterization suites were not run, per repository instructions. No remaining blocker is known; the browser still depends on authoritative recovery after the intentionally empty transition state, as designed.
