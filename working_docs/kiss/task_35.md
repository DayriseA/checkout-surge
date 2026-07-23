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

- [x] One local coordinator serializes all queue maintenance used by reset and generated-run teardown.
- [x] The protocol has one pause/clean/resume lifecycle with a guaranteed finally path.
- [x] Only exact-run attributable jobs and durable/Redis state can be removed.
- [x] Retrying after any exposed partial failure is safe and cannot affect a successor or another run.
- [x] Focused concurrent and partial-failure measurements prove the local pause/clean/resume workflow deterministic, exactly attributable, and safe to retry before obsolete coordination machinery is deleted.
- [x] Replica-compensation convergence rescans are removed, or a retained rescan has a documented local recovery case and focused regression coverage.
- [x] Cross-replica ownership, duplicate leases/protocols, unnecessary receipts, error codes, tests, and docs are deleted.
- [x] Durable queue dispatch recovery and normal worker processing remain intact.

## Verification

- Run bullmq-demo-queue-maintenance, reset, targeted teardown, cleanup selection, worker queue, and API resource cleanup tests.
- Use focused BullMQ/PostgreSQL/Redis integration coverage for exact attribution and idempotent retry.
- Run pnpm --filter api type-check, pnpm --filter worker type-check, and pnpm type-check.
- Do not run composition or characterization without explicit user approval.

## Working record

- **Status:** implemented; verification complete
- **Completed scope:** `ProcessLocalDemoMaintenanceAuthority` remains the sole serializer for reset, retention, and direct teardown. Reset and teardown now share one `cleanRuns(runIds)` BullMQ protocol: skip an empty selection, pause only the order/notification queues not already paused, validate all selected active and removable-state jobs before mutation, fail closed on malformed selected payloads, remove only exact selected-run jobs, and attempt every locally introduced resume in `finally`. Admin reset passes exactly its fenced run IDs and no longer drains or cleans whole queues, so terminal/other generated runs and catalog/unscoped jobs survive. Removed the reset-specific cleaner, generated-run quiescence lease, separate preflight/clean wrappers, adapter active-lease/shutdown waiting, three-pass convergence rescan, `not_quiescent` state, broad `drain`/`clean` boundary methods, reset pending-count workaround, and their mechanism-specific tests. The adapter retains only a tiny process-local set of maintenance-introduced pauses whose resume is still failing; it clears entries only after a successful resume, retries them on an exact `cleanRuns` retry and during close, aggregates close/restoration errors, and does not touch genuine pre-existing pauses.
- **Teardown and receipt decision:** Exact teardown now orders work as terminal/generated identity inspection, exact queue pause/clean/resume, exact Redis deletion, and finally transactional durable identity revalidation plus graph deletion. No database transaction spans BullMQ or Redis calls. Queue, resume, Redis, and database failures surface while the run/sale-offer identity still exists, so repeating the same request is idempotent and cannot resolve against a successor. Successful durable deletion has no remaining external step; therefore `demo_run_teardown_receipts`, its schema/types/exports/index/baseline/snapshot state, receipt completion path, and receipt recovery tests were removed.
- **Rescan decision and concrete producer race:** No queue convergence rescan remains. The concrete local late-producer race was the worker's order-dispatch/order-recovery or notification scanner selecting a candidate before admin reset terminalized the run and publishing it after exact cleanup. Every generated-run publisher now enters a focused PostgreSQL publication fence using the same lock key as terminal transition: it holds a shared session advisory lock across fresh nonterminal run/sale identity and immutable-config validation and the awaited BullMQ add, while terminal/reset transition takes the exclusive lock. The two producer Queue connections have finite Redis request retries, so a producer outage releases the fence through a visible error and delegates safe retry to durable order/notification recovery; Worker/consumer connections retain their required blocking configuration. Add therefore completes before terminal cleanup or is refused after terminalization, and an abandoned add cannot execute after the fence is released. `PostgresRunConfigReader.read()` retains its prior broader semantics for non-publication consumers. Real PostgreSQL gated race tests prove both concurrent lock orderings; focused unit tests prove order recovery and notification paths delegate the add through the fence.
- **Focused verification:** Real PostgreSQL/Redis/BullMQ API maintenance coverage passed 3 files / 43 tests (`bullmq-demo-queue-maintenance`, focused reset/teardown/retention workflows, and API resource cleanup), including exact reset IDs, persistent restoration retry, final durable revalidation, and malformed ownership. Worker unit coverage passed 15 files / 96 tests. The complete worker integration boundary passed 7 files / 49 tests; its focused real PostgreSQL publication/config-reader cases include add-before-terminal-cleanup, terminal-before-add refusal, sale-identity/config rejection, and the generated notification-recovery path using the production fence. The earlier broader API and database migration/baseline verification remains applicable to unchanged portions.
- **Static verification:** Full `pnpm type-check` passed for all production packages plus strict test sources. API, worker, and DB package lint passed. Focused Biome check/write passed for all changed TypeScript and generated JSON files, and `git diff --check` passed. The repository-wide format check was also attempted; its only remaining error is a pre-existing import-order issue in unchanged `apps/api/src/runtime/pending-persistence-operation-factory.ts`, which this task did not alter. `pnpm test:infra:down` then removed the isolated PostgreSQL/Redis containers, network, and test volumes; temporary migration-generation directories were removed.
- **Remaining blockers or follow-up:** none
