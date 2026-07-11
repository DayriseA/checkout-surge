# Task 75: Harden runtime images: non-root users, per-service packaging, smaller production images

## Execution context

- **Execution order:** This is task 75 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P4
- **Area:** deployment / images
- **Source:** donor comparison (Opus and GLM graded better; GPT at parity)
- **Locations:** root `Dockerfile`, service Dockerfiles to be introduced or retained, `docker-compose.yml`, `.dockerignore`, `apps/web/next.config.mjs`, and packaging metadata needed to make runtime artifacts complete

## Problem statement

The current root `Dockerfile` has one `workspace` stage that copies the entire repository, installs every workspace dependency, and runs `pnpm build` for every package. All five application runtime targets inherit that complete build workspace, including development dependencies and unrelated application output. They also run as the image default user (root). Only the Node services use direct `node` commands; web still invokes `pnpm --filter web start`. `runtime-setup` is likewise a filtered install/build tree rather than a production-only DB artifact.

Replace that shape with independently buildable, production-only artifacts for API, worker, mock ERP, load orchestrator, web, and DB setup. Runtime stages must contain only the target's runtime closure, run without root privileges, and invoke the final Node artifact directly. A source or build failure in an unrelated workspace must not be pulled into the target service's build graph.

## Solved elsewhere (verified donor evidence)

### Opus: explicit per-service production bundles

- `apps/api/Dockerfile`, `apps/worker/Dockerfile`, and `apps/mock-erp/Dockerfile` each use `build` and `runtime` stages. Their build commands are respectively `pnpm --filter "api..." build`, `pnpm --filter "worker..." build`, and `pnpm --filter "mock-erp..." build`, followed by `pnpm --filter <service> deploy --legacy --prod /app`. The runtime copies `/app` with `--chown=node:node`, selects the base image's `node` user, and runs `node dist/index.js`.
- `apps/load-orchestrator/Dockerfile` uses the same deploy bundle, copies `/usr/bin/k6` from a pinned `grafana/k6:1.8.0` stage to `/usr/local/bin/k6`, sets `K6_BINARY`, selects `USER node`, and runs `node dist/index.js`.
- `apps/web/Dockerfile` builds `pnpm --filter "web..." build`, copies Next's standalone tree plus `.next/static` into a clean runtime, selects `USER node`, and directly runs `node apps/web/server.js`.
- `packages/db/Dockerfile` builds only `@checkout-surge/db...`, deploys a production bundle, selects `USER node`, and directly runs migration then seed CLIs. Opus's exact command is `node dist/cli/migrate.js && node dist/cli/seed.js`; that path is donor-specific and is not valid in this target.
- Opus `docker-compose.yml` points every application and setup service at its own Dockerfile (`apps/<service>/Dockerfile` or `packages/db/Dockerfile`) rather than selecting targets from one root workspace image.

### GLM: cache priming and dependency-closure builds

- `docker/Dockerfile.node-service` parameterizes API, worker, and mock ERP with `SERVICE_NAME` and `EXPOSE_PORT`. It copies `pnpm-lock.yaml`, root `package.json`, and `pnpm-workspace.yaml`, runs `pnpm fetch`, then after source copy runs `pnpm install --frozen-lockfile --offline && pnpm --filter=${SERVICE_NAME}... build`, and emits `pnpm deploy --filter=${SERVICE_NAME} --prod --legacy /deploy`. This separates network/store population from source changes and prevents Turbo from building unrelated workspaces.
- `apps/load-orchestrator/Dockerfile`, `apps/web/Dockerfile`, and `packages/db/Dockerfile` repeat that `fetch`/offline-install pattern with target-specific filtered builds. The load image copies the pinned `grafana/k6:2.0.0` binary; the web image copies standalone output; the DB image contains only the DB dependency closure.
- GLM uses clean Alpine runtime stages and an explicit `app` user, and its compose file supplies service name/port build arguments to the shared Node-service Dockerfile.

### Donor caveats and target-specific adaptation

- Target package names are unscoped (`api`, `worker`, `mock-erp`, `load-orchestrator`, `web`) except for shared packages. Use the exact names from the target package manifests; do not copy GLM's `@checkout-surge/api`-style filters.
- Target TypeScript builds emit `dist/index.js`, not GLM's `dist/index.mjs`. Preserve the direct `node dist/index.js` entrypoint. The target web standalone entrypoint, once enabled, is `apps/web/server.js` because the monorepo layout is preserved.
- `apps/web/next.config.mjs` does not currently enable `output: "standalone"` or set an output tracing root. Add and verify both before adopting either donor's runtime copy paths. The tracing root must be the repository root so workspace dependencies are present. Copy `.next/static` separately; add `public/` only if it exists at implementation time.
- The target DB compiler uses `rootDir: src` and `outDir: dist`, so its CLIs are `dist/scripts/migrate.js` and `dist/scripts/seed.js`. Migration lookup defaults to `<cwd>/drizzle`. `packages/db/package.json` currently publishes only `dist`, so a deploy bundle will omit `drizzle/`; explicitly include/copy that directory and keep `WORKDIR /app`, or change the CLI/package contract coherently. Do not copy the donors' `dist/cli/*.js` or `.mjs` commands.
- Do not assume `pnpm deploy --legacy --prod` is sufficient merely because it succeeds. Confirm the bundle includes built workspace packages (`contracts`, `logger`, and `db` as applicable), service `dist`, production dependencies, and DB migrations. Keep `--legacy` unless the repository deliberately adopts `inject-workspace-packages`; changing that workspace-wide install mode is not part of this task.
- The existing target is Node 22 Bookworm slim and pins pnpm 10.33.2. Preserve that runtime family/version policy unless a separate decision changes it. Opus uses Node 24 Bookworm and GLM uses Node 22 Alpine; neither substitution is implied. Alpine changes libc and native-module compatibility. Current production manifests show no obvious native addon, but lockfile transitive dependencies and future additions must be checked before choosing a different libc/base. If native dependencies exist, build and runtime stages must share ABI/libc and runtime system libraries.
- A non-root declaration is not enough: copy artifacts with the runtime user's ownership and ensure every runtime write location is writable. This especially includes any Next cache/temp path and any future service-generated files. Prefer the base image's stable `node` user on Bookworm (and document its effective UID/GID); do not silently depend on a host UID. Compose has no bind mounts into application containers today, but any later mounted path must have compatible ownership. K6 must remain executable by the selected user. DB setup needs read access to migrations and network access, not filesystem write access.
- GLM's `pnpm fetch` layer improves dependency-download reuse, but its later `COPY . .` necessarily invalidates the offline install/build layer on source changes. Opus's `COPY . .` before install relies on a BuildKit cache mount but invalidates more layers. Prefer manifest/lockfile-first cache priming plus a persistent pnpm store cache, while recognizing that a root-context `COPY .` still changes for unrelated source. Keep `.dockerignore` effective (`node_modules`, `dist`, `.next`, `.turbo`, coverage, secrets); consider Turbo prune or equally explicit per-target build contexts only if needed to prevent unrelated files from invalidating target builds.
- `pnpm --filter <service>... build` decouples the execution graph, not automatically the Docker context/cache key. If adopting `turbo prune --docker`, validate its generated lockfile/manifests and deploy behavior with pnpm 10 rather than combining donor recipes blindly. Do not duplicate six subtly divergent install procedures without either a shared, auditable convention or a clear reason for service-specific Dockerfiles.
- A shared parameterized Node Dockerfile is acceptable for API/worker/mock ERP only if it cannot produce the wrong service artifact or entrypoint when arguments are absent. Require/validate the service selector rather than relying on a permissive default. Load orchestrator, web, and DB setup have materially different artifacts and should retain dedicated stages/files.

## Required implementation

1. Produce independent production images for `api`, `worker`, `mock-erp`, `load-orchestrator`, `web`, and DB `runtime-setup`. Compose must address those explicit Dockerfiles/stages and no application runtime may inherit the full workspace build image.
2. Build only the selected package and its transitive workspace dependencies. Structure dependency acquisition so unchanged lockfile/manifests reuse the package store; do not run the repository-wide `pnpm build` for an individual image.
3. Emit production-only runtime bundles. API, worker, mock ERP, and load orchestrator must directly execute their target `dist/index.js`. Web must use verified Next standalone output and directly execute its generated server. DB setup must directly execute the compiled migration and seed scripts and ship the complete migration artifact.
4. Run every application and setup runtime as a declared non-root user. Copy/chown files intentionally, retain executable permissions for k6, and make only necessary runtime paths writable.
5. Preserve the existing compose topology, ports, environment, health checks, dependency conditions, setup profile, and k6 ownership. This task changes image construction and runtime privilege/entrypoints, not service behavior.
6. Keep base images and external binary images pinned consistently with repository policy. Document any intentional digest/version or libc change and verify native dependency compatibility.

## Acceptance criteria

- Static inspection shows no application or setup runtime defaults to UID 0 and no runtime command uses pnpm, tsx, Turbo, or a shell except the DB's intentional ordered `migrate && seed` command.
- Each final image copies only a production artifact for its service dependency closure; it does not inherit build tools, workspace source, unrelated app outputs, or root development dependencies.
- Editing or breaking an unrelated workspace does not add that workspace to the selected filtered build graph. Dependency download/cache layers are keyed primarily by the lockfile/manifests, and `.dockerignore` excludes local build output and secrets.
- API, worker, mock ERP, and load orchestrator commands match the target's `dist/index.js`; web standalone paths match generated target layout; DB commands match `dist/scripts/*.js` and the runtime includes `drizzle/` at the lookup path.
- Compose resolves every service to the intended image definition and preserves current ports, health probes, environment variables, dependencies, and the `runtime-setup` profile behavior.
- The k6 binary remains pinned, present at `/usr/local/bin/k6`, executable by the runtime user, and selected through `K6_BINARY`.
- Relevant documentation/tests or lightweight policy checks cover the durable image contract where practical.

## Static verification guidance

Before any expensive build, review the Dockerfiles and rendered configuration mechanically:

- Use `docker compose config` only when Docker configuration validation is permitted; inspect each service's `build.dockerfile`, `target`, and `args`, plus environment/health/dependency preservation.
- Search final stages for `USER`, `CMD`/`ENTRYPOINT`, `COPY --from`, ownership, and absence of workspace-wide `pnpm build`, runtime `pnpm`, or `tsx`.
- Trace package manifests and Turbo `...` filter semantics to prove each service's workspace dependency closure. Inspect `pnpm-lock.yaml` for native/install-script packages whenever the base libc or architecture changes.
- Verify Next config and expected standalone copy paths, and verify DB compiler paths, package `files`, migration lookup, and copied `drizzle/` location.
- If Docker builds are authorized later, build each service independently with plain progress, inspect the final image user/config/files, and run compose health/smoke checks. Compare image sizes as evidence, not as a fixed byte threshold; reproducibility, completeness, and least privilege take precedence.

## Scope and non-goals

- In scope: Docker build/runtime stages, service packaging metadata required for complete deploy artifacts, Next standalone configuration, compose build wiring, `.dockerignore`, non-root ownership/permissions, pinned k6 transfer, and focused verification/documentation.
- Not in scope: changing application behavior, APIs, ports, environment vocabulary, health semantics, compose dependency topology, database schema/data, queue workflows, proxy routing, secrets policy, pnpm workspace injection policy, Node major/base-family migration, CI registry publishing, Kubernetes/hosted deployment manifests, or broad monorepo build-system refactoring.
- Do not add process supervisors, init systems, package managers, compilers, test dependencies, or debugging tools to final runtime images. Do not force read-only filesystems or arbitrary capability/seccomp changes without auditing application write behavior in a separate hardening task.
