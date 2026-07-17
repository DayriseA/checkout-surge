# Task 80: Scope the infra-only shutdown command to the infra services

## Execution context

- **Execution order:** This is task 80 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P4 (hardening note)
- **Area:** developer tooling
- **Source:** independent review (note)
- **Locations:** `package.json:31`

The infra-up command targets only PostgreSQL and Redis, but infra-down runs an unscoped `docker compose down` identical to runtime-down, stopping every app/proxy service sharing the project.

## Implementation record

- **Status:** Complete.
- **Completed scope:** `infra:down` now uses the same `docker-compose.yml` plus `docker-compose.dev.yml` file set as `infra:up` and passes `postgres redis` to Compose's scoped `down` command. It removes only those development service containers and does not pass a volume-removal flag, so named PostgreSQL and Redis volumes remain intact. `runtime:down` remains the unscoped full-runtime shutdown command.
- **Command contract:** `scripts/test-command-graph.test.mjs` now fixes the exact infra up/down commands, asserts that infra shutdown has no volume-removal flag, and preserves its explicit distinction from `runtime:down`.
- **Documentation audit:** `docs/runtime_topology.md` and `docs/local_development.md` already state that `infra:down` stops only development PostgreSQL and Redis, so no documentation wording changed; the implementation was brought into agreement with the existing contract.
- **Verification:** `node --test scripts/test-command-graph.test.mjs` passed 6/6; `pnpm test:scripts` passed 55/55; `pnpm exec biome check package.json scripts/test-command-graph.test.mjs` passed; `docker compose -f docker-compose.yml -f docker-compose.dev.yml config --services` rendered the merged topology; `docker compose --dry-run -f docker-compose.yml -f docker-compose.dev.yml down postgres redis` targeted only the PostgreSQL and Redis containers and reported the expected inability to remove the still-used shared network; `git diff --check` passed. The dry run did not stop or remove any live resource. The prohibited composition and characterization suites were not run, and application/type/integration suites were not run because this change is confined to root command wiring and its static script contract.
- **Remaining blockers/follow-up:** None for Task 80.
