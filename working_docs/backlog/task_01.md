# Task 01: Add an automated cross-service composition test (and the frozen-behavior characterization suite)

## Execution context

- **Execution order:** This is task 1 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3 — placed first: the safety net for the whole P0 tier
- **Area:** test strategy
- **Source:** independent review (medium)
- **Solved elsewhere:** none — a gap shared with Opus. The consolidation plan specifies the characterization scope: a representative 10k surge, sold-out-only traffic, duplicate/idempotent attempts, the active→draining→completed lifecycle, durable terminal summary plus history detail, and browser recovery after reconnect and finalization.
- **Locations:** `package.json:20`, `apps/api/test/api.test.ts:1932`, `apps/worker/test/integration/order-processing-workflow.test.ts:544`

The full test suite never starts the deployed service topology; every cross-service handoff stops at a substitute (API/BullMQ with no worker, worker with mocked ERP, web smoke with stubbed reads). Wrong compose URLs, tokens, or wiring break the demo while the suite stays green. This suite is also the safety net for the P0 spine work, which is why it leads the backlog.
