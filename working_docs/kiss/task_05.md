# Task 05 — Retire the one-time terminal pending-persistence remediation subsystem

## Execution context

Task 5 of 45. Phase 1: remove unambiguous residue. Primary ownership boundary: incident-specific pending-persistence remediation service and operator surface. Dependencies: Phase 0 baseline must be trusted; preserve the separate general automatic repair path, which a later task consolidates. This record is standalone. Follow the quality checklist: business repair remains in an application service, routes stay thin, and composition owns infrastructure.

## Why this task exists

The subsystem exists for two historical terminal cases, not as the accepted ongoing repair authority: run `8da8a364-00ed-4732-8e03-399e17b9db4d`, sale `e38749c5-3550-4dee-977a-8718374adec1`, quantity 49; and run `598023fd-b68b-46c2-bf24-d13d0096a39f`, sale `5bbdecb8-f7c9-4358-8d96-4e66a60c3723`, quantity 49.

## Required outcome

Explicitly resolve each case or abandon/archive its outcome with durable evidence before removal. Use this task's Working record as the append-only decision/evidence location. Never blindly mutate either record. Then delete the one-time remediation service and tests, CLI, package script, runbook, exports, and documentation references.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift: search `pending-persistence-remediation`, `remediate-terminal-pending-persistence`, `maintenance:remediate-terminal-pending`, the corresponding API service/tests (currently including `apps/api/test/pending-persistence-remediation-service.test.ts`), scripts, runbooks, package exports, and docs. Before deleting the CLI, use its default dry-run mode (never `--apply`) against an explicitly selected reference runtime when that runtime is available and inspection is authorized; capture a sanitized result for each exact run/sale target in this Working record. If the runtime is unavailable, an operator must explicitly choose abandonment and record why the disposable local state no longer needs repair. If evidence indicates a live-data mutation beyond the task authority, leave the task pending and stop for explicit direction. Delete all incident-only references only after those two dispositions are recorded. Keep the general automatic interrupted Redis-to-PostgreSQL repair mechanism untouched.

## Retained behavior and non-goals

Retain bounded, observable, idempotent, run-scoped automatic repair and terminal finalization safeguards. Do not delete general recovery, silently alter historical sales, or fold a one-time remediation CLI into a generic framework.

## Acceptance criteria

- [ ] Both exact historical cases have an explicit resolved or abandoned/archived outcome.
- [ ] The Working record contains a sanitized dry-run result or an explicit operator-approved abandonment rationale for each target.
- [ ] No blind mutation was performed.
- [ ] Incident-specific service, tests, CLI, script, runbook, exports, and docs references are deleted.
- [ ] General automatic pending-persistence repair remains operational and covered.

## Verification

Run focused API tests for the retained general repair and search for retired identifiers/package script references. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record archival/resolution evidence and exact tests.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
