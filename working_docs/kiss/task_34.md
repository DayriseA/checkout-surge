# Task 34 — Make one durable path own traffic-completion redelivery

## Execution context

- **Execution order:** Task 34 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** The k6 child supervisor must be separate from delivery state, transport reports must use one canonical shape, and the accepted pre-release policy must permit discarding old journal files during the documented wipe.
- **Standalone scope:** This file is authoritative without the audit. Verify the current execution-store schema and startup behavior before implementation.
- **Primary ownership boundary:** Load-orchestrator durable single-slot execution journal and idempotent delivery of one final completion report to the API.
- **Working expectations:** Read working_docs/quality_checklists.md. Retain durability with one authority, remove the replaced retry path in the same change, and test eventual/idempotent outcomes rather than internal retry choreography.

## Why this task exists

The load orchestrator currently combines an in-process send-with-backoff loop, a durable fsynced execution journal, pending in-memory persistence, startup redelivery, and legacy journal migrations. Multiple authorities can retry or represent the same final result, creating more race and test surface than the single local execution requires.

## Required outcome

Use one durable completion record and one delivery loop/coordinator from persistence through acknowledged API acceptance. The k6 child owner produces the result once; the durable owner persists it before delivery and marks it completed only after an idempotent API acknowledgement.

## Scope and implementation guidance

- Keep the atomic single-slot file journal, fsync/rename durability, states needed for accepted, executing, completion pending, and completed, and strict current-schema parsing.
- Introduce or clarify one completion-delivery owner that reads completion_pending at startup and during normal operation, performs bounded retries/backoff, and serializes delivery attempts.
- Remove SpawnK6Runner.sendCompletionWithRetry, completionRetry configuration, pendingPersistence memory fallback, overlapping deliveryAttempt paths, and duplicate retry timers once the durable owner covers them.
- Persist a completed child result before deleting its work directory or attempting the API call. A persistence failure must remain visible and must not be mislabeled delivered.
- Verify Task 13 already removed migrateLegacyExecutionJournal and all retired journal-field/diagnostic transformations. Do not reintroduce them while restructuring delivery; the supported recovery action for an old journal is the documented intentional wipe.
- Preserve semantic idempotency at the API completion boundary so restart/redelivery cannot apply terminal evidence twice or conflict with an identical prior report.
- Update apps/load-orchestrator/src/application/execution-store.ts, k6-runner/supervisor, startup composition, runtime config/env docs, and focused journal/delivery tests.

## Retained behavior and non-goals

- A succeeded, failed, or cancelled execution must eventually drive the correct API run outcome after transient delivery failure or orchestrator restart.
- One completion report is authoritative; retries may not produce conflicting terminal outcomes.
- Preserve the single file-journaled local execution boundary. Do not introduce a database, BullMQ queue, distributed lease, or retained event log for this purpose.
- Do not preserve old journal shapes, an optional no-store production mode, or exact internal retry timing assertions.
- Do not change API finalization or business-drain semantics.

## Acceptance criteria

- [ ] Exactly one component owns durable completion redelivery end to end.
- [ ] The completion is persisted before first send and survives process restart.
- [ ] Identical retry is idempotently accepted and cannot create two summaries or terminal transitions.
- [ ] The in-process runner retry loop, memory fallback, and their configuration/tests are deleted, and no legacy journal migration has returned.
- [ ] Journal state and process execution state are separate, small, and documented.
- [ ] Startup and shutdown cannot start competing delivery attempts.

## Verification

- Run focused execution-store, completion delivery, restart/redelivery, K6 runner/supervisor, and API completion idempotency tests.
- Run pnpm --filter load-orchestrator type-check, pnpm --filter api type-check, and pnpm type-check.
- Run relevant unit/integration tests without the full deployed topology.
- Do not run the slow composition or characterization suites unless explicitly authorized.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
