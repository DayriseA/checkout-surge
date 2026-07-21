# Task 35 — Collapse queue maintenance and generated-run teardown to one local protocol

## Execution context

- **Execution order:** Task 35 of 45, the final task in Phase 5 (repair ownership boundaries).
- **Dependencies:** The accepted topology is one API maintenance authority; cross-replica cleanup ownership has been removed; reset, retention cleanup, and targeted teardown now have focused workflow owners.
- **Standalone scope:** The target is fully described here if the audit is unavailable. Inspect the current queue-maintenance interface because Task 21 and Task 30 intentionally change it first.
- **Primary ownership boundary:** API queue-maintenance adapter and exact generated-run teardown workflow.
- **Working expectations:** Follow working_docs/quality_checklists.md. Preserve destructive safeguards and explicit infrastructure dependencies while deleting duplicate maintenance protocols.

## Why this task exists

Queue cleanup currently supports leases, pause ownership, convergence rescans, reset-specific and targeted-cleanup paths, post-commit ownership recovery, and durable teardown receipts. After accepting one local API maintenance authority and splitting maintenance workflows, much of that protocol exists only to coordinate authorities that no longer exist.

## Required outcome

Use one small, process-local, serialized queue maintenance boundary for reset and exact-run teardown. Pause the affected queues, perform exact attributable cleanup, and resume in try/finally. Keep durable database deletion transactional and make partial infrastructure failure explicit and safe to retry.

## Scope and implementation guidance

- Simplify apps/api/src/queue/bullmq-demo-queue-maintenance.ts and its interface to the minimum operations used by the focused reset/teardown workflows.
- Share one process-local serialization mechanism across maintenance calls. Do not use Redis leases, replica ownership records, FIFO lease recovery, or a second queue protocol.
- Pause only the owned order/notification queues required for coherent cleanup, and always attempt the defined resume path in finally.
- Remove only jobs exactly attributable to the selected run. Never use broad obliterate/clean behavior that can delete another run's work.
- Transactionally delete the selected durable graph after terminal/generated ownership checks. Keep any post-commit Redis/queue failure visible and make repeating the exact request idempotent.
- Remove convergence rescans that exist only to compensate for cross-replica pause ownership. Retain a rescan only if a focused exact-run failure/retry test demonstrates a remaining local correctness need, and document that concrete recovery case.
- Re-evaluate demo_run_teardown_receipts and similar schema/state. Remove them from the squashed baseline if they exist solely to coordinate replicas or duplicate idempotency already guaranteed by the authoritative deletion; retain only evidence with a concrete remaining recovery use.
- Delete reset-specific/teardown-specific queue wrappers, ownership error vocabulary, configuration, docs, and tests that no longer represent a possible local state.

## Retained behavior and non-goals

- Preserve terminal/generated ownership checks, exact-run traffic termination ordering, deterministic queue cleanup, and retry-visible failures.
- Preserve active and catalog-backed runs, other runs' jobs, shared queue availability after the operation, and correlation-aware logs.
- Do not replace BullMQ, remove durable PostgreSQL-to-BullMQ dispatch recovery, or weaken worker shutdown.
- Do not introduce a general distributed lock or maintenance workflow framework.
- Do not hide a resume failure or report success while cleanup state is ambiguous.

## Acceptance criteria

- [ ] One local coordinator serializes all queue maintenance used by reset and generated-run teardown.
- [ ] The protocol has one pause/clean/resume lifecycle with a guaranteed finally path.
- [ ] Only exact-run attributable jobs and durable/Redis state can be removed.
- [ ] Retrying after any exposed partial failure is safe and cannot affect a successor or another run.
- [ ] Focused concurrent and partial-failure measurements prove the local pause/clean/resume workflow deterministic, exactly attributable, and safe to retry before obsolete coordination machinery is deleted.
- [ ] Replica-compensation convergence rescans are removed, or a retained rescan has a documented local recovery case and focused regression coverage.
- [ ] Cross-replica ownership, duplicate leases/protocols, unnecessary receipts, error codes, tests, and docs are deleted.
- [ ] Durable queue dispatch recovery and normal worker processing remain intact.

## Verification

- Run bullmq-demo-queue-maintenance, reset, targeted teardown, cleanup selection, worker queue, and API resource cleanup tests.
- Use focused BullMQ/PostgreSQL/Redis integration coverage for exact attribution and idempotent retry.
- Run pnpm --filter api type-check, pnpm --filter worker type-check, and pnpm type-check.
- Do not run composition or characterization without explicit user approval.

## Working record

- **Status:** pending
- **Completed scope:** none
- **Material decisions or deviations:** none
- **Verification performed:** not run
- **Remaining blockers or follow-up:** none
