# Task 09 — Record compatibility policy and intentional wipe

## Execution context

Task 9 of 45. Phase 2: make scope decisions that unlock deletion. Primary ownership boundary: concise product scope/domain/local-runtime documentation. Dependencies: this documented decision precedes later migration squashing and removal of legacy compatibility logic. This record is standalone. Follow the quality checklist by reading domain/convention docs first; do not make compatibility behavior changes in this decision record.

## Why this task exists

The accepted boundary appears pre-release and local, with no promised external database volume or load journal retention. Legacy normalizers and migration compatibility machinery should not imply an unstated upgrade promise.

## Required outcome

Verify the evidence. Unless real retained external data is evidenced, record the decision that data is disposable, provide one intentional runtime wipe path, and state that users rebuild rather than translate legacy local data. If retained external data evidence exists, stop and obtain an explicit product decision.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift: `docs/scope_and_caveats.md` is the single scope/non-goals authority; inspect `working_docs/project_description.md`, local runtime/readme/compose documentation, migration/journal docs, and actual volume configuration such as `docker-compose.yml`. Update only concise scope/domain/local documentation and point to one validated wipe/reset command or workflow. Confirm it is intentionally scoped/safe before documenting it. This task records policy only; later tasks squash migrations and remove compatibility branches.

## Retained behavior and non-goals

Retain truthful current product classifications, durable behavior within a running demo, and destructive-target safety. Do not wipe data as part of documenting policy, delete migrations/normalizers, or assume disposable data if actual users/environments retain external volumes or journals.

## Acceptance criteria

- [ ] Evidence for or against retained external DB volume/load-journal data is checked and recorded.
- [ ] If no retention evidence exists, scope/domain/local docs state disposable data and one intentional wipe path.
- [ ] Docs instruct rebuild rather than translation of legacy local data.
- [ ] If retention evidence exists, implementation stops pending explicit product direction.
- [ ] No compatibility deletion or migration squashing occurs in this task.

## Verification

Validate the documented wipe path through its safe preconditions or focused guard tests; inspect compose/runtime configuration and linked docs. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record results and any decision blocker.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
