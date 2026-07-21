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

- [x] Both exact historical cases have an explicit resolved or abandoned/archived outcome.
- [x] The Working record contains a sanitized dry-run result or an explicit operator-approved abandonment rationale for each target.
- [x] No blind mutation was performed.
- [x] Incident-specific service, tests, CLI, script, runbook, exports, and docs references are deleted.
- [x] General automatic pending-persistence repair remains operational and covered.

## Verification

Run focused API tests for the retained general repair and search for retired identifiers/package script references. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record archival/resolution evidence and exact tests.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none

### 2026-07-21 operator disposition

- Operator decision: explicitly abandon and archive both historical cases. The operator confirmed that these UUIDs describe incidental local development runs and that retaining or recovering their disposable state is not a product requirement.
- Runtime evidence: no local reference-runtime containers or project named volumes are present in the current workspace. The isolated test infrastructure is not the historical runtime and was not treated as evidence for either case. No replacement runtime was created because fresh state could not establish the disposition of historical records.
- Case `8da8a364-00ed-4732-8e03-399e17b9db4d` / sale `e38749c5-3550-4dee-977a-8718374adec1`: abandoned and archived without repair. The historical local state is unavailable and explicitly not required to survive.
- Case `598023fd-b68b-46c2-bf24-d13d0096a39f` / sale `5bbdecb8-f7c9-4358-8d96-4e66a60c3723`: abandoned and archived without repair. The historical local state is unavailable and explicitly not required to survive.
- Mutation evidence: no dry-run or apply command was run against any PostgreSQL or Redis runtime, and no historical record was mutated.

### 2026-07-21 completion

- Status: completed
- Completed scope: deleted the incident-specific remediation application service, targeted CLI, dedicated unit suite, remediation-only finalization integration case, root package command, API export, operator runbook, and live documentation references. The change removes 763 lines and adds only this eight-line disposition record plus this completion record.
- Decisions: retained `PendingPersistenceReconciler`, its API composition, startup recovery, finalization integration, Redis/PostgreSQL handoff behavior, and their focused tests without modification. No replacement remediation command, generic framework, route, state, or compatibility path was introduced. Historical references in completed `working_docs/kiss` task records remain as audit history; no retired identifier remains in application code, packages, scripts, user documentation, or `package.json`.
- Verification: `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/pending-persistence-reconciler.test.ts test/demo-run-startup-reconciliation-service.test.ts test/demo-run-finalization-service.test.ts` passed 3 files / 48 tests. `pnpm type-check` passed all 11 Turbo tasks and the strict root test-source compilation. `pnpm exec biome check apps/api/src/index.ts apps/api/test/demo-run-finalization-service.test.ts package.json` passed. The retired-identifier search across `apps`, `packages`, `docs`, `scripts`, and `package.json`, `git diff --check`, and explicit `package.json` parsing passed. Composition and characterization tests were not run, per repository guidance.
- Follow-up: the later planned consolidation of the retained general automatic repair path remains Task 22 and is outside this deletion.
