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

- [ ] Scope/local docs explicitly state the one API maintenance authority, one web process, one load journal, and one worker runtime.
- [ ] The dashboard proxy/edge services are described as one ingress path, not as application replicas or extra authorities.
- [ ] Compose/config no longer implies supported horizontal or replica operation.
- [ ] Separate required service containers and non-root image behavior remain intact.
- [ ] No replica orchestration is added.
- [ ] Replica-coordination deletion is explicitly left to later implementation work.

## Verification

Inspect Compose/config rendering or focused static tests available in the repository, plus relevant Dockerfile declarations. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record exact inspection/test commands.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
