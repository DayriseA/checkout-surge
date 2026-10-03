# Docker Build Pruning

**Status:** in progress · implementation done and validated on a standard Docker daemon; only the owner's remote Fly builder check of the two `runtime-fly` targets remains before merge · **Independent of** the hosted deployment backlog (`working_docs/backlog/hosted_deployment/`), but it must preserve the build contract that backlog relies on (see "Contract to Preserve").

> **Obsolete requirement (owner decision):** the 32 GB VFS disk acceptance is abandoned. The owner no longer uses the VFS environment (too slow, runs out of space), so there will be no VFS validation and none is required to complete this task. The VFS context in "Problem" is kept as background only.

## Problem

Building the reference runtime images fills a 32 GB disk in environments whose Docker storage driver is VFS (observed in Codex Cloud on 2026-10-03). VFS has no copy-on-write: every image layer is stored as a full copy of the filesystem, so layer count and layer size multiply.

The four service/setup Dockerfiles currently do the same thing in their `build` stage; the root tooling build inherits the equivalent full-workspace installation from `workspace-install`:

1. nine separate `COPY <workspace>/package.json` instructions (one layer each);
2. `pnpm fetch` of the whole lockfile;
3. `COPY . .` of the whole repository;
4. `pnpm install --frozen-lockfile --offline` of the **whole workspace** (every app, including Next.js and its native dependencies), then a filtered build and `pnpm deploy` of one package.

The final images are already small. The waste is in the intermediate layers: each of the seven production builds installs the entire workspace.

## Goal

Each production image installs and builds only its own workspace package and that package's internal workspace dependencies, using `turbo prune --docker`. Existing root `devDependencies` remain available as build tools: pruning does not remove them, and changing the root manifest is out of scope. Reduce intermediate disk usage (the former goal of building on the 32 GB VFS environment is obsolete, see the notice above). Preserve the final image contract defined below; byte-for-byte reproducible builds are not required.

## Scope

### Files to change

- `docker/Dockerfile.node-service` (images `api`, `worker`, `mock-erp`; targets `runtime` and `runtime-fly`)
- `apps/load-orchestrator/Dockerfile` (targets `runtime` and `runtime-fly`)
- `apps/web/Dockerfile` (target `runtime`)
- `packages/db/Dockerfile` (target `runtime`, the setup image: migrations and seed)
- `Dockerfile` at the repository root: add `runtime-tools-prune` immediately before `runtime-tools-build`, and change `runtime-tools-build` to use the pruned workspace. Keep `node-base`, `workspace-install`, `development-workspace` and the final `runtime-tools` stage unchanged.
- `scripts/runtime-image-contract.test.mjs`: update the assertions that match lines you change, keeping every invariant they protect, and add the turbo version check described below
- `.dockerignore`: exclude the root `out` directory (owner-approved follow-up, see "Required build pattern")

No other persisted file changes, except this task file. The temporary API source edit used for cache validation must be restored exactly before handoff. Keep validation reports outside the Docker build context.

### Required build pattern

Apply this pattern to each production build. `<pkg>` is the workspace package name: `${SERVICE_NAME}` (`api`, `worker`, `mock-erp`) in `docker/Dockerfile.node-service`, `load-orchestrator`, `web`, `@checkout-surge/db`, and `@checkout-surge/contracts` for `runtime-tools-build`.

1. **`prune` stage** (`runtime-tools-prune` in the root `Dockerfile`).
   - `FROM node:${NODE_VERSION}` in the four service/setup Dockerfiles. In the root `Dockerfile`, use `FROM node-base AS runtime-tools-prune` to reuse its unchanged Node/pnpm setup.
   - `WORKDIR /build`, then install Turbo in its own layer before copying sources: `RUN npm install -g turbo@2.9.18`. Use exactly `2.9.18`: it is the version resolved in `pnpm-lock.yaml`. This layer stays cached across source changes, so Turbo is not downloaded again on every rebuild. The service/setup prune stages do not enable pnpm: `turbo prune` produces identical output without it. The root `runtime-tools-prune` stage inherits the unchanged pnpm setup from `node-base`.
   - `COPY . .`, then run the installed binary: `turbo prune <pkg> --docker`. This step needs no network access.
   - `turbo prune` writes into `out/` without cleaning it, so `.dockerignore` excludes the root `out` directory: a stale local `out/` must not be merged into the pruned output.
   - In `docker/Dockerfile.node-service`, declare the existing `ARG SERVICE_NAME` in both the `prune` and `build` stages. Keep its validation (`api|worker|mock-erp`, exit 64) in `prune`, before running turbo.
2. **`build` stage, dependency layer** (`runtime-tools-build` in the root `Dockerfile`).
   - Same base, `WORKDIR /build`, and the same pnpm setup and `PNPM_HOME`/`PATH` environment as today. Preserve the web build's `NEXT_TELEMETRY_DISABLED=1`.
   - In the root `Dockerfile`, use `FROM node-base AS runtime-tools-build` and override its inherited working directory with `WORKDIR /build`. It must no longer inherit from `workspace-install` or `development-workspace`.
   - Use one manifest copy: `COPY --from=prune /build/out/json/ ./` (from `runtime-tools-prune` in the root file). Verified with turbo `2.9.18`: `out/json/` already contains the pruned `pnpm-lock.yaml` and `pnpm-workspace.yaml`. Do not copy those files again from `out/`.
   - Then run `pnpm fetch --store-dir=/pnpm/store` and `pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store`, both with the existing cache mount `--mount=type=cache,id=checkout-surge-pnpm-store,target=/pnpm/store`.
   - This layer must not depend on source files, so a source-only change keeps it cached.
3. **`build` stage, source layer.**
   - `COPY --from=prune /build/out/full/ ./` (from `runtime-tools-prune` in the root file).
   - Then `COPY tsconfig.base.json ./` from the build context: every package's `tsconfig.json` extends it, and turbo does not include it. Turbo `2.9.18` already includes `turbo.json` in `out/full/`.
   - If a build step fails because another root-level file is missing, copy that file explicitly too and list it in the Working Notes.
4. **`build` stage, build and package.**
   - Keep the existing commands unchanged: `pnpm --filter="<pkg>..." build`, then `pnpm --filter="<pkg>" deploy --legacy --prod /deploy` where it exists today. The root tooling build is the explicit exception: preserve `pnpm --filter="@checkout-surge/contracts" build` without `...`, followed by its existing deploy command.
   - The web image keeps building with `pnpm --filter="web..." build` and copying `.next/standalone` and `.next/static`. `apps/web/next.config.mjs` resolves the tracing root as `../..` from its own folder, so keep `/build` as the workspace root.
5. **Final `runtime`, `runtime-fly` and `runtime-tools` stages: unchanged.** Same base, `WORKDIR`, `ENV`, artifact copy sources and destinations, k6 binary copy, state directory creation, `USER`, `ENTRYPOINT` and `CMD`.

Do not add Dockerfile build arguments, stages or command flags beyond this pattern. Redeclaring `SERVICE_NAME` in the two independent stages preserves the existing argument, rather than adding a new one. CLI flags used for validation below are permitted.

### Turbo version check

Add a test to `scripts/runtime-image-contract.test.mjs` that reads the resolved turbo version from the root importer in `pnpm-lock.yaml` and asserts that each of the five scoped Dockerfiles installs `turbo@<resolved-version>` and runs an executable `turbo prune <pkg> --docker`. Check every occurrence of `turbo@` in those files, and require both the install and the prune command in each file so the test cannot pass after their removal. This prevents the Dockerfiles from drifting when turbo is upgraded.

## Contract to Preserve

The hosted deployment builds these images with Fly's remote builder (`infra/fly/deploy.mjs`), using the repository root as the build context:

`fly deploy --build-only --push --dockerfile <path> --build-target <target> [--build-arg SERVICE_NAME=<service>]`

Docker Compose (`docker-compose.yml`) and the Dev Container (`.devcontainer/docker-compose.yml`) use the same files. Therefore, all of the following must stay exactly as they are:

- **Dockerfile paths:** `docker/Dockerfile.node-service`, `apps/load-orchestrator/Dockerfile`, `apps/web/Dockerfile`, `packages/db/Dockerfile`, `Dockerfile`.
- **Target names:**
  - `runtime` in the four service/setup Dockerfiles; the root `Dockerfile` has no `runtime` target;
  - `runtime-fly` in `docker/Dockerfile.node-service` and `apps/load-orchestrator/Dockerfile`, still defined as `FROM runtime AS runtime-fly`;
  - `runtime-tools` and `development-workspace` in the root `Dockerfile`.
- **Build argument:** `SERVICE_NAME`, with values `api`, `worker`, `mock-erp`.
- **Files copied from the build context into `runtime-fly`:** `infra/fly/core/api-entrypoint.sh` and `infra/fly/runner/load-orchestrator-entrypoint.sh`. These are outside every pruned workspace: keep copying them from the build context, exactly as today.
- **Image contents and configuration:**
  - Node services: `/app/dist/index.js` and production-only `node_modules`.
  - Web: `apps/web/server.js` plus `.next/static`.
  - Setup image: `dist/scripts/migrate.js`, `dist/scripts/seed.js` and `drizzle/`.
  - Load-orchestrator: `/usr/local/bin/k6` and `/var/lib/checkout-surge/load-orchestrator`, owned by `node`.
  - `runtime-tools`: `packages/contracts/` and `scripts/`.
  - All images: the same `USER`, `ENTRYPOINT`, `CMD`, `ENV` and `WORKDIR` values, and the same ownership and permissions on runtime artifacts and writable state directories.
- **Workspace graph:** `api` depends on `@checkout-surge/fly-machines`; the pruned `api` workspace must contain it.

### Image equivalence definition

Equivalence means preserving the runtime configuration, required artifacts, operational scripts, permissions and behavior described in this contract. It is established by construction plus targeted checks, not by a full filesystem comparison:

- the final stages are unchanged, and dependency versions cannot change because they are installed with `--frozen-lockfile` from a pruned lockfile that is an exact subset of the current one;
- the remaining risk is a file missing from the pruned workspace, which either fails the build or fails `runtime:smoke`;
- the targeted checks in Validation step 4 cover configuration, artifacts and permissions.

Layer history, timestamps, package-manager layout reflecting the reduced workspace, and ordinary generated build differences (including Next.js build IDs and their asset names) may differ. These allowances do not permit changing application source, dependency versions, runtime configuration or behavior.

## Out of Scope

- The root `Dockerfile` stages `node-base`, `workspace-install` and `development-workspace`: the Dev Container keeps the full workspace.
- Anything under `infra/`, `working_docs/` (except this file), `docker-compose*.yml`, `.devcontainer/`, `.dockerignore` (except the root `out` entry, an owner-approved follow-up), application code, and `package.json`/`pnpm-lock.yaml`.
- Changing base images, Node or pnpm versions, or the k6 version.
- Fly builds and deployments. The repository owner verifies the two `runtime-fly` targets with Fly's remote builder before merging.

## Stop Conditions

Stop and report, without working around the problem, if:

- `pnpm install --frozen-lockfile` fails with the pruned lockfile. Do not drop `--frozen-lockfile`, do not regenerate the lockfile, and do not switch to another pruning approach.
- Keeping an item of "Contract to Preserve" would require changing a file listed in "Out of Scope".
- A final image violates the image equivalence definition above. Allowed generated/packaging differences alone are not a stop condition.

Missing infrastructure is a validation limitation, not permission to change the pruning design. Complete implementation and available non-destructive checks, record the missing prerequisites and pending checks, and report "implementation complete, validation pending". Do not mark the task done until the required validation passes.

## Validation Environment

- Use a dedicated disposable Docker daemon and a uniquely named disposable Compose project. Global pruning and project volume deletion are authorized only in that environment; never perform them on a shared development daemon or the user's normal runtime project.
- If no disposable daemon is available, do not run the destructive validation steps. Follow the validation-pending rule above.
- Before editing, record the baseline commit with `git rev-parse HEAD`. Rebuilding the baseline is allowed to compare its images with the pruned ones.
- **Obsolete (owner decision):** there is no VFS / 32 GB disk acceptance environment anymore. A standard Docker daemon is the validation environment.
- Use one validation shell with process-only environment variables. Set a unique `COMPOSE_PROJECT_NAME`, set `COMPOSE_FILE=docker-compose.yml`, and clear inherited `COMPOSE_PROFILES` so the build list is controlled below. Generate distinct temporary values for `CONTROL_SERVICE_TOKEN`, `ADMIN_DASHBOARD_PASSPHRASE`, `ADMIN_SESSION_SECRET` and `PUBLIC_CLIENT_COOKIE_SECRET`, each using `node:crypto.randomBytes(32).toString("hex")`. Export/set them in that shell; do not print them, commit them, or overwrite an existing `.env`. Shell values override the blank example values loaded by the pnpm runtime wrappers. See `docs/local_development.md` for the runtime environment contract.
- If container sysctls are rejected, use the existing override for all subsequent Compose and pnpm runtime commands: on POSIX, set `COMPOSE_PATH_SEPARATOR=:` and `COMPOSE_FILE=docker-compose.yml:docker-compose.no-sysctls.yml`; on PowerShell, set `$env:COMPOSE_PATH_SEPARATOR = ";"` and `$env:COMPOSE_FILE = "docker-compose.yml;docker-compose.no-sysctls.yml"`. Record its use. Do not edit either Compose file.

## Validation

Run all of these and record each result, or its explicit pending status, in the Working Notes:

1. **Repository checks:** format/check the touched test file with `pnpm exec biome check --write scripts/runtime-image-contract.test.mjs`, then `pnpm exec biome check scripts/runtime-image-contract.test.mjs`. Run `node --test scripts/runtime-image-contract.test.mjs` and `git diff --check`.
2. **Cold production builds:**
   - Start from a cleared cache, only on the disposable daemon: `docker compose --profile setup --profile tools down --volumes --remove-orphans`, then `docker system prune -af` and `docker builder prune -af`.
   - Before the build, record the storage driver (`docker info --format "{{.Driver}}"`) and the free space of the filesystem holding Docker data.
   - Build all seven production images in one sequential command, with no cleanup in between: `docker compose --parallel 1 --profile setup --profile tools --progress plain build`. The two profiles include the profile-gated `runtime-setup` and `runtime-tools` images.
   - After the build, record the free space again and `docker system df`.
   - This step passes when all seven images build. **Obsolete (owner decision):** the former 32 GB VFS disk acceptance no longer applies.
3. **Local Fly variants:**
   - `docker build --progress=plain -t checkout-surge-pruning-api-fly:validation -f docker/Dockerfile.node-service --target runtime-fly --build-arg SERVICE_NAME=api .`;
   - `docker build --progress=plain -t checkout-surge-pruning-load-fly:validation -f apps/load-orchestrator/Dockerfile --target runtime-fly .`.

   These two variants are checked separately from the seven-image disk batch. Their local builds do not replace the owner's remote Fly builder check before merging. No Fly CLI build, push or deployment is authorized by this task.
4. **Image equivalence:**
   - Configuration: for the seven images (Compose tags `<COMPOSE_PROJECT_NAME>-<service>`) and both Fly variant tags, check with `docker image inspect` that `Config.User`, `Config.Entrypoint`, `Config.Cmd`, `Config.Env` and `Config.WorkingDir` match the unchanged final Dockerfile stages.
   - Artifacts and permissions: in inspection containers with an overridden entrypoint (so no application starts), check the items listed under "Image contents and configuration" in "Contract to Preserve", their owner, and that both Fly entrypoint scripts exist and are executable.
   - Workspace graph: the pruned `api` workspace contains `@checkout-surge/fly-machines`. Temporary inspection of the prune stage is allowed without adding a stage or target.
5. **Runtime:**
   1. `pnpm runtime:wipe`
   2. `pnpm runtime:up`. On the empty database, the API may exit or remain unhealthy and Compose may return nonzero while dependent services wait. If logs show missing schema/unseeded runtime policy, continue to setup; do not treat that expected bootstrap failure as an implementation failure. Other causes, including missing secrets, must be resolved before continuing.
   3. `pnpm runtime:setup`
   4. `pnpm runtime:up`
   5. Wait for all long-running services to be healthy, then `pnpm runtime:smoke`. Confirm the smoke runs inside `runtime-tools` (the API is running), so this validates the tooling image as well as the service runtime.
   6. `pnpm runtime:down`

6. **Cache:** after a successful API build, temporarily add a harmless comment to one tracked file in `apps/api/src`; a timestamp-only change is insufficient. Rebuild with `docker compose --parallel 1 --progress plain build api` without pruning, and confirm the dependency `pnpm install` step is reported as `CACHED` while source copying/building is invalidated. Restore the exact original source contents even if the check fails, and record the relevant build log result.

Clean up the disposable runtime project with `docker compose --profile setup --profile tools down --volumes --remove-orphans` after validation. Do not delete resources from other daemons/projects. Review the final diff against `docs/quality_checklists.md` before handoff.

Do not run `pnpm test:composition` or `pnpm test:characterization`.

## Done When

- All validation steps pass and the Working Notes record each result and the baseline commit. Missing build, runtime or cache results leave validation pending. The 32 GB VFS disk acceptance is obsolete and not required.
- The owner's remote Fly builder check of the two `runtime-fly` targets passes before merge.
- The final images meet the image equivalence definition and the checks in step 4.
- The change is limited to the files listed in "Files to change".
- The temporary cache-test source edit has been restored, and the unchanged root development stages and all final runtime stages remain intact.

## Working Notes

- **Baseline:** `f6141bcb5348f69aa8a53bf07a1ad9745b9be60c`.
- **Implementation (`40d2f17`):** every production build prunes its workspace with Turbo `2.9.18` (`--docker`) in a `prune` stage (`runtime-tools-prune` in the root `Dockerfile`), copies `out/json/` once, runs `pnpm fetch` then `pnpm install --frozen-lockfile --offline` in one cache-mounted RUN, then copies `out/full/` and the explicit root configuration files. In `docker/Dockerfile.node-service`, `SERVICE_NAME` is declared in both stages and its `api|worker|mock-erp` validation (exit 64) runs before Turbo in the same RUN. Final `runtime`, `runtime-fly` and `runtime-tools` stages and the root development stages are unchanged. The guard test reads the resolved Turbo version from the root importer of `pnpm-lock.yaml` and checks every `turbo@` occurrence in the five Dockerfiles.
- **Additional root file:** the web build also copies `vitest.coverage.config.ts` next to `tsconfig.base.json`. The Next.js build type-checks `apps/web/vitest.config.ts`, which imports this root file, and Turbo does not include it in `out/full/`. No other root file was needed.
- **Validation of `40d2f17` on a standard Docker daemon (overlayfs):** all seven Compose images (`docker compose --profile setup --profile tools build`) and both `runtime-fly` variants build. Image configuration (`User`, `Entrypoint`, `Cmd`, `Env`, `WorkingDir`), file lists, owners and permissions match the baseline images; only pnpm metadata files and the Next.js build ID differ. Runtime cycle passed: `pnpm runtime:wipe`, `pnpm runtime:up` (expected bootstrap failure on the empty database), `pnpm runtime:setup`, `pnpm runtime:up` with all services healthy, `pnpm runtime:smoke` inside the `runtime-tools` image, `pnpm runtime:down`. After a source-only change in `apps/api/src`, the dependency `pnpm install` layer stayed `CACHED`. Contract test 7/7, Biome and `git diff --check` clean.
- **Follow-up fixes (owner-approved after review):**
  1. Turbo is installed with `RUN npm install -g turbo@2.9.18` before `COPY . .`, and the prune step runs the installed `turbo prune <pkg> --docker`, so a source change no longer downloads Turbo again. The corepack line was removed from the four service/setup prune stages: the prune output (`out/json`, `out/full`, pruned `pnpm-lock.yaml`, contents and file modes) is identical to the `pnpm dlx` output with corepack for all seven scopes. The prune step also succeeds with networking disabled. The guard test now requires the pinned install and the executable prune command in each file.
  2. `.dockerignore` excludes the root `out` directory. Without it, a stale root `out/full/stale/file` reached the pruned output.
- **Follow-up validation (standard Docker daemon, overlayfs):** Biome, contract test 7/7 and `git diff --check` clean; the guard test fails when one Dockerfile's Turbo version drifts, or when the prune command or the install is removed. All seven Compose images and both `runtime-fly` variants build; `SERVICE_NAME=bogus` still fails with the validation message (exit 64). The seven image configurations are unchanged. After a source-only change in `apps/api/src`, the Turbo install and dependency `pnpm install` layers are `CACHED` with no Turbo download, while the prune, source copy and build steps run again; the source edit was restored. With a stale root `out/full/stale/file`, the prune stage contains no stale file.
- **Remaining:** the owner's remote Fly builder check of the two `runtime-fly` targets before merge.
