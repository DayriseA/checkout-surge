# Task 09: Make load-completion delivery durably owned (outbox with idempotent acknowledgement, or an API traffic watchdog)

## Execution context

- **Execution order:** This is task 9 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0
- **Area:** load-orchestrator / API handoff
- **Source:** independent review (medium, run-stranding) + comparison (worse)
- **Solved elsewhere:** none — shared defect; all three branches deliver the completion signal through a lossy handoff that alone can move the run out of active. The reference keeps a stronger delivery posture (GPT abandons the terminal report after five retries), but no branch has durable ownership; design fresh.
- **Locations:** `apps/api/src/services/demo-run-service.ts:196`, `apps/load-orchestrator/src/application/k6-runner.ts:244`, `apps/api/src/services/demo-run-finalization-service.ts:57`

The API's start delegation has no deadline; completion delivery retries five times then logs and discards the only handoff that can move the run to draining (and then deletes its work directory); orchestrator shutdown tracks neither child k6 processes nor pending deliveries; and the API has no traffic watchdog for starting/active runs. A transient outage or orchestrator restart can wedge the only allowed run indefinitely. Fix with a durable completion outbox plus idempotent ingest, and/or an API-side watchdog that reconciles execution evidence independently. Design the orchestrator control surface once — the cancellation endpoint (entry 33) and the reset traffic-aborter (entry 34) share it.
