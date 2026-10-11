# 01 — Proof Environment

**Design:** section 6 · **Depends on:** the hosted deployment backlog done

## Goal

The agent can create, deploy, test and destroy a complete Checkout-Surge environment in the owner's `playground` Fly.io organization, without any way to affect production by mistake.

## Context

- The production app names (`checkout-surge-core`, `checkout-surge-runner`, `checkout-surge-gate`) are written into `infra/fly/deploy.mjs` and the Machine configurations under `infra/fly/`. Fly.io app names are unique across the platform, so the proof environment needs its own.
- `flyctl` on the laptop is logged in with the owner's full account, so the isolation rests on rules and on a check in code.

## Scope

- App names, organization and public address configurable per environment. Production stays the default and keeps its current behavior.
- Before any change, the deploy tooling checks that the target app belongs to the configured organization. It refuses a production app when the environment is not production.
- Secrets generated for the proof environment, kept out of git.
- One command each to create, deploy and destroy the environment.
- Docs for operating the proof environment.

## Out of Scope

- Any change to the production environment or its deploy workflow.

## Done When

- A full proof environment runs in `playground`, a demo run completes there, and the environment can be destroyed and recreated from scratch.
- A deliberate attempt to target a production app from the proof configuration is refused by the tooling.

## Open Points

- None.

## Working Notes

### Tooling preflight — 2026-10-11

- Read all project documents; the hosted deployment prerequisite is complete. This preflight does not satisfy this task's full-environment acceptance criteria, so its status remains `todo`.
- The checkout was clean on `codex/redis_and_order_queue` at `46251061`. Creating and deleting a disposable `codex/` branch succeeded; `dev` and `main` were untouched.
- Dev container: `checkout-surge-gpt-55-devcontainer-workspace-1` (`ec7cb4a0ff2b`), with the host checkout mounted at `/workspaces/checkout-surge`. Node 24.18.0, pnpm 10.33.2, Biome 2.5.0, Vitest 4.1.9, DinD Docker 29.6.1 and Compose 2.40.3 are available.
- Executed `node --test scripts/test-environment-safety.test.mjs` in the dev container: 8 tests passed. An ephemeral Alpine container also ran successfully inside DinD and was removed.
- The existing Docker credential helper fails on public image pulls (`error getting credentials`, exit 255). An isolated empty temporary Docker client configuration made the pull succeed without reading or changing existing credentials. Use a temporary `DOCKER_CONFIG` for public pulls and test infrastructure if the helper remains unavailable; this does not verify authenticated registry pulls.
- Docker Desktop exposes about 8.94 GiB RAM and 16 CPUs, shared with the workspace. The orchestrator grants only one heavy job at a time: dependency installation, builds, type checks, test suites, reference-runtime work or load generation. Run package validations sequentially with bounded workers; prefer remote Fly builds and Fly Machines for load experiments.
- Fly CLI 0.4.111 created `cs-proof-preflight-20261011-0614` explicitly in `playground-416`. Its organization was checked before every mutation. Two temporary Machines in `cdg`, each with one shared CPU and 256 MiB RAM, exercised public-image launch, remote command execution, a tiny Depot build and registry push, and launch/execution of the built image. Only an isolated scratch Dockerfile/config context was uploaded.
- Both Fly Machines and the application were destroyed; `flyctl apps list --org playground-416 --json` returned `[]` afterward. No Machines are retained. No production app or production secret was accessed.
- Windows Docker access and Fly's local CLI state require tool sandbox elevation; automatic review accepted those operations. Subagent dispatch, reporting and an independent `gpt-6.1-sol` reviewer were verified.
- Implementation starts with `gpt-6.1-sol`, without a Luna step. Adapt the orchestration workflow to the phase, keep one writer active, independently review significant code changes and arbitrate findings before requesting fixes.
- Remaining gates: task 02 ends with the owner's go/no-go; visitor-facing texts and the final proof require owner review; changes to `dev`, `main` or production require new explicit authorization. Full deployment, a completed demo run, environment recreation and executable production-target refusal remain task 01 work.

### Local implementation — 2026-10-11

- Ownership boundary: Fly operator tooling and hosted operating documentation only. No API, queue, Redis, topology or task 02 feature changes. Normal production names/configuration and CI invocation remain the defaults.
- Added `infra/fly/proof.json`, a proof-only configuration for `playground-416`, and create/deploy/destroy commands in `infra/fly/proof.mjs`. Config validation refuses production app names before any Fly lookup. Every existing target app is checked before any build or mutation; Machine mutations check again. Proof recovery copies, internal runner URL, gate/guard app pointers, public origins and build registries use the configured names.
- Credentials are newly generated, staged without printing, and saved separately under gitignored and Docker-excluded `.tmp/fly-proof/<gate-app>/`. Destroy removes local copies only after successful app removal. Incomplete creation without saved credentials requires destroy/recreate to avoid resetting a live database's passwords. Existing production secret files were never read.
- The first complete proof deploy bootstraps the gate before the core writes its recovery config; the production deploy sequence is unchanged. Subsequent proof deployments use the normal sleeping-core leases, runner handling and version handshake. Existing core/runner sizes, idle-stop and guard controls are preserved for task 01.
- Local validation results are recorded after execution below. No live Fly resources were changed by the implementation subagent. The live operator subsequently completed deployment, demo-run and destroy/recreate acceptance, recorded below.

- Validation in dev container `ec7cb4a0ff2b`, `/workspaces/checkout-surge`, user `codespace`: `pnpm exec biome check --write infra/fly/deploy.mjs infra/fly/environment.mjs infra/fly/environment.test.mjs infra/fly/proof.mjs infra/fly/proof.json package.json` passed; `node --test infra/fly/environment.test.mjs infra/fly/capacity-refusal.test.mjs` passed all 11 tests, including the final config-key safety fix. `pnpm exec turbo run type-check --concurrency=1` passed all 14 tasks (cache hits), followed by successful `pnpm type-check:test`. The new operator scripts are JavaScript and are verified by their executable tests; no application TypeScript changed.
- `git check-ignore .tmp/fly-proof/cs-proof-redis-queue-gate/core.env` confirmed the generated credential path is ignored. `git diff --check` passed. No dependencies were installed, test infrastructure started, images built or Fly resources changed. The staged preflight notes were preserved; no staging or commits were performed.
- Final self-review: changes remain inside task 01 operator tooling/documentation, generated configs agree with the three proof app names, production templates retain their values, and runtime application boundaries are untouched. At that local implementation checkpoint, live acceptance and independent review remained outstanding; both were subsequently completed.

- Independent review follow-up: ownership could change during long image builds after the initial three-app check. The deploy now checks the relevant app immediately before every remote build/push command and immediately before every local registry push. Two executable fake-CLI tests change ownership after the first image and prove the next remote build or local push is refused. Touched-file Biome passed and focused deployment tests passed all 13 tests. No TypeScript changed; the earlier successful typechecks remain applicable. No Fly mutation was performed.

### First live acceptance run — 2026-10-11

- Created the three proof apps in `playground-416`, deployed every image and passed the core/runner version handshake. The public gate returned 303 for a deliberate wake, then the normal homepage returned 200.
- Initial Machines: core `875e99b0567608` in `cdg`, 6 performance CPUs / 12 GiB; runner `825d19a7002508` in `cdg`, 8 performance CPUs / 16 GiB; gate `83727ec7914678`; scheduled guard `8901e6b644e168`. The normal idle-stop, runner shutdown and guard configuration were retained.
- Run `042bde02-157c-42ee-aa85-4abf3a9954eb`: 32 planned, started and completed requests; zero interrupted, unstarted or dropped requests; complete traffic delivery. All 32 HTTP responses were accepted, with zero failed requests, transport failures, timeouts or unexpected responses. Persisted totals showed 32 accepted reservations, reserved units, confirmed orders and notifications; zero failed orders or pending work; remaining stock 0, reserved stock 32, and zero broken invariants. Buyer p95 was 355.631 ms. The runner returned to `stopped`.
- Exact-run cleanup succeeded, deleting 45 Redis keys and 32 queue jobs. The initial scratch helper incorrectly sent JSON Content-Type on an empty DELETE body; correcting the helper and retrying cleanup succeeded. This was an operator helper error, not a product defect. Fly CLI exec returned CLI exit 0 even when the guest command exited 1, so the scratch host now requires an explicit final cleanup marker rather than trusting the CLI exit code alone.
- An actual invalid proof configuration targeting the production core was refused before Fly could run, verified with a missing Fly executable in the dev container. No production app or production secret was accessed.
- Raw local evidence: `.tmp/proof-deploy-01.log`, `.tmp/proof-smoke-01.ndjson` and `.tmp/proof-cleanup-01.ndjson`. These scratch files are not committed and contain no deliberately printed secret values.
- At the first-run checkpoint, destroy/recreate/redeploy and recreated-environment health were still pending, and task 02 had not started. The final acceptance below supersedes that partial state.

### Final live acceptance — 2026-10-11

- Task 01 acceptance is complete. Independent review accepted the implementation after the build-boundary ownership fix. Destroy succeeded and the scoped `playground-416` app listing was empty. Create then generated fresh credentials, and a second full deployment from scratch passed the version handshake. The recreated gate returned 303 for wake, then the normal homepage returned 200.
- Recreated run `53abf2ab-f124-47b8-bc8c-00715629632e` passed every assertion: 32 planned, started and completed requests, 32 accepted HTTP responses, and 32 durable reservations, reserved units, confirmed orders and notifications. HTTP failures, transport failures, timeouts, unexpected responses, interrupted/unstarted/dropped requests, failed orders, pending work and broken invariants were all zero. Remaining stock was 0 and reserved stock 32; buyer p95 was 312.419 ms. Runner `832525f7969008` returned to `stopped`. Exact teardown deleted 45 Redis keys and 32 queue jobs.
- Recreated Machines retained for reuse/reference: core `830d15b7939398` in `cdg`, performance-6 / 12 GiB; runner `832525f7969008`, performance-8 / 16 GiB; gate `89954ec6619478` and guard `801e93b6474e78`, each shared-1 / 256 MiB. The operator is stopping the core and gate; all four proof Machines are to remain stopped between work sessions. The guard retains its normal hourly schedule.
- Additional raw local evidence: `.tmp/proof-deploy-02.log` and `.tmp/proof-smoke-02.ndjson`. No production resources or secrets were accessed. Task 02 is now in progress; its prototypes have not yet been written, and its owner's go/no-go checkpoint remains mandatory.
