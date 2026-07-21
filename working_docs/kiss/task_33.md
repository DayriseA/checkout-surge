# Task 33 — Give one component bounded ownership of the k6 child process

## Execution context

- **Execution order:** Task 33 of 45, in Phase 5 (repair ownership boundaries).
- **Dependencies:** Canonical transport evidence and the disposable journal policy must already be established. This task separates process lifecycle before Task 34 consolidates completion redelivery.
- **Standalone scope:** The requirements below do not depend on the audit. Inspect apps/load-orchestrator because earlier accounting work may have changed K6Runner.
- **Primary ownership boundary:** Load-orchestrator application/runtime boundary for spawning, observing, cancelling, reaping, and cleaning up one k6 child.
- **Working expectations:** Follow working_docs/quality_checklists.md. Keep process supervision explicit and small, keep HTTP completion delivery outside it, and test observable guarantees rather than incidental signal timing.

## Why this task exists

apps/load-orchestrator/src/application/k6-runner.ts is a large owner containing accepted execution state, script/work-directory setup, stdout parsing, live metrics, child handlers, cancellation escalation, journal persistence, and API completion retries. Child-process cleanup is required, but it is difficult to reason about while mixed with delivery state and compatibility logic.

## Required outcome

Create one child-process supervisor that owns a k6 process from spawn acceptance through observed exit and cleanup. Model execution lifecycle explicitly and separately from completion-delivery state.

Define one named, configured end-to-end cancellation bound from accepted cancellation through stopped traffic and observed child exit/reap, with an explicit default value. Internal graceful-stop and escalation intervals may divide that budget, but acceptance depends on the externally observable bound rather than a prescribed signal or timer sequence.

## Scope and implementation guidance

- Extract spawn, child identity, exit observation, stdout/stderr stream ownership, exact-run cancellation, bounded SIGTERM-to-SIGKILL escalation, reaping, and work-directory cleanup into one focused owner.
- Use a small explicit execution state model such as idle, starting/running, stopping, and exited. Do not add states that only mirror implementation callbacks.
- Preserve a single execution slot and exact current-run conflict behavior.
- Ensure concurrent abort/close/natural-exit calls share one termination operation and always observe the child exit.
- Let parsing/aggregation produce a canonical completion result after exit, but do not let the supervisor send or retry the API completion report.
- Keep TrafficExecutionService as the application facade for start/status/abort if useful; narrow K6Runner or replace it with explicit supervisor and completion coordinator interfaces.
- Refocus apps/load-orchestrator/test/load-orchestrator.test.ts so it proves bounded stop, escalation, no surviving/unreaped child, conflict behavior, and cleanup without requiring an exact internal signal/timer sequence.

## Retained behavior and non-goals

- Cancelling a run must promptly stop traffic so it cannot keep consuming inventory in the background.
- Graceful-stop failure must follow one bounded escalation path; shutdown must not claim success while the child may still run.
- Preserve script generation, k6 output parsing, bounded stdout/stderr diagnostics, live metric flushing, non-root/containerized k6, and one-execution capacity.
- Do not redesign durable completion redelivery here; Task 34 makes it single-owner after process state is separated.
- Do not add a general process manager, worker thread, or workflow engine.

## Acceptance criteria

- [ ] Exactly one component owns the child from spawn through exit/reap and work-directory disposition.
- [ ] Execution lifecycle state is explicit and does not contain API delivery/retry state.
- [ ] Abort, close, natural exit, spawn failure, and escalation cannot leave a running or unreaped child.
- [ ] Concurrent cancellation paths converge on one bounded operation.
- [ ] The named cancellation bound and default are documented/configured, and a behavior-level test proves traffic stops and child exit/reap is observed within that bound even when graceful stopping fails.
- [ ] Tests assert externally observable bounds and outcomes without pinning the precise signal or timer sequence.
- [ ] Obsolete child lifecycle fields and duplicated handlers are deleted from the former runner.

## Verification

- Run the focused load-orchestrator process lifecycle, cancellation, parser, live metrics, and service tests.
- Run pnpm --filter load-orchestrator type-check and pnpm type-check.
- Run k6 compatibility only if its normal prerequisites are available; record a skip clearly otherwise.
- Never run composition or characterization without explicit authorization.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** pending — record the named cancellation bound/default and how any escalation intervals fit within it without making their exact choreography contractual.
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
