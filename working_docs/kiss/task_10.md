# Task 10 — Enforce one local single-instance topology

## Execution context

Task 10 of 45. Phase 2: make scope decisions that unlock deletion. Primary ownership boundary: local topology documentation and configuration declarations. Dependencies: task 09 records disposable-data policy; this decision precedes later deletion of replica coordination. This record is standalone. Follow the quality checklist: composition remains explicit, and this documentation/config task must not add hosted orchestration.

## Why this task exists

Hosted and horizontal coordination are outside the project's accepted product boundary, yet topology documentation/configuration can imply replica support and justify unnecessary distributed coordination.

## Required outcome

Make docs, configuration, and Compose unambiguous: the accepted local runtime has one API maintenance authority, one Next.js web application process, one load-orchestrator journal, and one worker runtime. The single Caddy dashboard-proxy/dashboard-edge ingress services may remain as routing boundaries; they are not extra web application replicas or application authorities. Preserve separate service containers and non-root images. Do not add replica orchestration.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift: inspect `docs/scope_and_caveats.md`, `working_docs/project_description.md`, README/local-run docs, `docker-compose.yml`, `docker-compose.dev.yml`, `docker-compose.test.yml`, service Dockerfiles, and runtime configuration. State that these are accepted local single-instance authorities, not a claim of generic production scalability. Remove ambiguous replica-oriented wording/config only where it contradicts the accepted scope; later tasks delete coordination mechanisms, so do not refactor them here. Ensure compose still names/separates API, web, worker, load-orchestrator, Redis, PostgreSQL, mock ERP, and the one permitted proxy/edge ingress path as currently required.

## Retained behavior and non-goals

Retain separate containers, non-root images, core durability, and ordinary local process controls. Do not introduce replicas, leader election, hosted deployment manifests, or a fake multi-instance test topology.

## Acceptance criteria

- [x] Scope/local docs explicitly state the one API maintenance authority, one web process, one load journal, and one worker runtime.
- [x] The dashboard proxy/edge services are described as one ingress path, not as application replicas or extra authorities.
- [x] Compose/config no longer implies supported horizontal or replica operation.
- [x] Separate required service containers and non-root image behavior remain intact.
- [x] No replica orchestration is added.
- [x] Replica-coordination deletion is explicitly left to later implementation work.

## Verification

Inspect Compose/config rendering or focused static tests available in the repository, plus relevant Dockerfile declarations. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact inspection/test commands.

## Working record

- Status: complete
- Completed scope: Declared the accepted single-instance authorities in `docs/scope_and_caveats.md`, `docs/runtime_topology.md`, `README.md`, `docs/local_development.md`, `working_docs/project_description.md`, and the related architecture, cross-service, access-protection, repository-layout, and load-generation documents. Added a concise root Compose contract comment. No application code, runtime mechanism, environment variable, Dockerfile, test, or service boundary changed.
- Decisions: The supported local runtime has one API process as the sole maintenance authority, one Next.js web process, one load-orchestrator process with one file journal, and one worker runtime, all in separate service containers. The one Caddy dashboard-proxy/dashboard-edge path is ingress only. PostgreSQL, Redis, Mock ERP, core durability, normal process controls, and non-root production images remain. Compose's generic `--scale` capability is not blocked, but scaled application services, hosted orchestration, and generic production scalability are outside the accepted contract. Existing shared-store, lease, and duplicate-tolerance mechanisms are described truthfully as retained implementation details; later simplification work owns deletion or replacement of replica-only coordination.
- Verification: `docker compose config --format json` passed and resolved exactly one `api`, `worker`, `web`, `load-orchestrator`, `mock-erp`, `postgres`, `redis`, and `dashboard-proxy`, with the three named durable volumes, one internal dashboard-edge network, and no `container_name` or `deploy.replicas`. `docker compose -f docker-compose.test.yml config --format json` passed and resolved only isolated PostgreSQL and Redis. `docker compose -f docker-compose.yml -f docker-compose.dev.yml -f .devcontainer/docker-compose.yml config --format json` passed and resolved one development command for each application service plus the editor workspace, with the expected Dev Container project name and no replica declarations. The existing `node --test scripts/runtime-image-contract.test.mjs` suite passed 8/8 tests, including separate production images and non-root direct entrypoints. `pnpm lint` passed for 410 files. `pnpm type-check` passed all 11 Turbo tasks and strict `tsconfig.test.json` compilation. `git diff --check` passed. Production Dockerfile inspection confirmed API/worker/Mock ERP, web, load orchestrator, DB setup, and runtime tooling retain `USER node`. The forbidden `pnpm test:composition` and `pnpm test:characterization` lanes were not run.
- Follow-up: Later simplification tasks should delete or replace coordination retained only for replica scenarios. Any future hosted or horizontal topology requires a separate explicit product decision and its own configuration and verification contract.
