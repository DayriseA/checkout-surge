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

- **Status:** implemented; verification complete
- **Completed scope:** Extracted `K6ChildProcessSupervisor` as the single owner of spawn, child/run identity, stdout/stderr, close/error observation, exact-run cancellation, bounded graceful-to-forced termination, exit/reap observation, metric drain/discard, summary ingestion, and temporary work-directory cleanup. Reduced `SpawnK6Runner` to preparation, durable journal coordination, completion persistence, and the retained completion-delivery/retry boundary for Task 34. Preserved exact-run replay/conflict behavior and cancellation journal semantics.
- **Material decisions or deviations:** Added the single runtime setting `K6_CANCELLATION_TIMEOUT_MS` with a 10,000 ms default and a validated 15,000 ms maximum, keeping it below the API gateway's 20,000 ms abort deadline and within Node's safe timer range. The supervisor uses a small `idle | starting | running | stopping | exited` lifecycle separate from journal/delivery states and publishes starting identity before asynchronous work-directory setup. The current implementation divides the configured budget between graceful and forced termination internally; abort acknowledgement waits for observed exit/reap but not metric delivery, summary/completion work, or cleanup. Cancellation shutdown joins supervisor-owned disposition without awaiting discarded metric work; natural-completion shutdown finishes canonical stdout/metric/summary result construction before disposition and joins the coordinator's existing durable completion persistence/delivery operation. Tests do not make signal choreography contractual.
- **Verification performed:** Focused load-orchestrator service/lifecycle coverage passed 98 tests; `pnpm --filter load-orchestrator test:unit` passed 4 files / 131 tests; `pnpm --filter load-orchestrator type-check`; full `pnpm type-check`; `pnpm --filter load-orchestrator lint`; focused Biome check of all changed load-orchestrator TypeScript files; `git diff --check`. Host-native k6 compatibility was skipped because `k6` is not installed; no composition or characterization suite was run.
- **Remaining blockers or follow-up:** Task 34 still owns consolidation of durable completion redelivery; this task deliberately retained the existing coordinator-side delivery mechanism behind the new supervisor result boundary.
