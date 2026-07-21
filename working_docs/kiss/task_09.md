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

- [x] Evidence for or against retained external DB volume/load-journal data is checked and recorded.
- [x] If no retention evidence exists, scope/domain/local docs state disposable data and one intentional wipe path.
- [x] Docs instruct rebuild rather than translation of legacy local data.
- [x] No retained external-data evidence exists, so the stop condition was not triggered.
- [x] No compatibility deletion or migration squashing occurs in this task.

## Verification

Validate the documented wipe path through its safe preconditions or focused guard tests; inspect compose/runtime configuration and linked docs. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record results and any decision blocker.

## Working record

- Status: complete
- Completed scope: Recorded the authoritative compatibility decision in `docs/scope_and_caveats.md`; clarified domain durability in `docs/core_business_entities.md`; documented one selected-project reference-runtime wipe/rebuild workflow in `docs/local_development.md`; and kept README/runtime-topology mirrors concise.
- Decisions: The repository remains a pre-release local reference runtime. Durable business and load-execution behavior is retained within the current supported runtime/data shape, but legacy local PostgreSQL, Redis, and load-journal shapes have no in-place upgrade promise. After an incompatible pre-release change, users intentionally wipe and rebuild rather than translate legacy local state. This documentation decision does not remove current migrations or normalizers.
- Verification: No retained external-data blocker was found. `docker compose config --volumes` resolved only `checkout-surge-postgres-data`, `checkout-surge-redis-data`, and `checkout-surge-load-orchestrator-data`. Resolved Compose JSON gave all three project-prefixed names and no `external` flag; `COMPOSE_PROJECT_NAME=task09-evidence` changed each resolved name to that selected project. `docker compose --dry-run down --volumes --remove-orphans` reported removal only of the default project's three named volumes and performed no wipe. Source inspection confirmed `runtime:wipe` maps to that command, Compose mounts the orchestrator journal at `/var/lib/checkout-surge/load-orchestrator`, and host-native configuration instead defaults to `.checkout-surge/load-orchestrator`. Changed local Markdown targets/headings exist and `git diff --check`, `pnpm lint`, `pnpm type-check`, and `pnpm test:unit` passed. `pnpm format:check` found 52 formatting/import diagnostics in application/test files outside this documentation task; Biome ignores Markdown, and its focused check reported that none of these changed documentation files are processed. The forbidden composition and characterization lanes were not run.
- Follow-up: Tasks 12–14 own any migration squashing, legacy normalizer removal, or policy-storage simplification. If a retained external volume, hosted retention contract, or release-stability requirement is later accepted, revisit the compatibility classification before those deletions.
