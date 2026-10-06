# 13b — Documentation and Continuous Deployment

**Design:** sections 7.2, 8, 9 · **Depends on:** 01–12, 14

## Goal

`docs/` describes the hosted runtime and how to operate it, and GitHub Actions deploys with the same script as the workstation.

## Scope

- **Documentation.** Backlog and task files under `working_docs/backlog/` are cleaned up periodically (`working_docs/` itself persists), so persistent docs must not reference them, and everything still true in `design.md` that a reader or an operator needs moves into `docs/`.
  - Propose the file layout to the owner before writing.
  - Update the hosted-deployment boundary in `docs/runtime_topology.md` and the caveats in `docs/decisions/scope_and_caveats.md`, which still lists hosted deployment as a non-goal.
  - `docs/decisions/hosted_deployment.md` keeps the decisions; the new documentation describes behavior and links to entries instead of restating them.
  - Sizes and caps are being measured in 13a: point to where they are configured rather than quoting values. Leave the slow-stop point to 13a.
- **Operator notes,** including:
  - the manual core resize;
  - admin writes through `fly proxy 8080` from `localhost` are refused, because the core's web origin is the gate's public URL (operators use the gate, or call the API with the control token);
  - the token and secret rotation procedure (design 7.2);
  - freeing a lease left by a killed deploy, removing a `recreate` mark set by mistake, the runner recreate route;
  - the guard's logs (`component: guard`) as the only signal of a failed guard run.
- **GitHub Actions** (owner decision, 2026-10-06): deploy automatically on every push to `main`, calling `infra/fly/deploy.mjs all`.
  - No `--force`: the script waits for the core to sleep.
  - One deploy at a time; a queued deploy waits and is never cancelled mid-run, since a killed deploy leaves its lease until the TTL.
  - The Fly token is a repository secret that the owner creates and stores. Find the least-privileged token type that covers the three apps and the remote builder, and give the owner the exact commands.
  - Third-party actions are pinned by commit SHA.
  - The workflow is first exercised end to end in 13c.

## Out of Scope

- Measurement and tuning (13a), secret rotation and opening (13c), bot review (13d).

## Done When

- `docs/` describes the hosted runtime and its operation, with no reference to `working_docs/backlog/` or task numbers.
- The workflow is committed, and the owner has the commands to create and store its token.

## Open Points

- None.

## Working Notes

Work done on 2026-10-06, on branch `hosted/13b-docs-and-ci` (from `dev` at `743f9bb6`). No Fly mutation, nothing committed.

### Owner decisions (2026-10-06)

- **Token:** one organization deploy token, one-year expiry, repository secret `FLY_API_TOKEN`, created and stored by the owner; no `deploy.mjs` change (HD-50).
- **Workflow:** every push to `main`, GitHub's default concurrency queue (a newer push replaces a deploy still waiting; a running one is never cancelled), no `workflow_dispatch`, actions pinned by SHA, flyctl pinned to 0.4.111 (HD-49).
- **Incompatible changes:** deploy the commit from the workstation with `deploy.mjs all --fresh-core` before merging; the CI deploy carries the mark over (HD-48); if forgotten, set the mark by hand.
- **Docs:** layout approved: `docs/hosted_runtime.md`, `docs/hosted_operations.md`, updates to `runtime_topology.md`, `decisions/scope_and_caveats.md`, `repository_layout.md`, the README index, `automated_testing_infrastructure.md` and the `admin_access_protection.md` intro, and HD entries from HD-49. Actions minutes are mentioned informatively; the repository's visibility is not stated (private only during development).

### Token research

- A deploy token is limited to one app; the org deploy token (`fly tokens create org`, "Create org deploy tokens") manages all apps of one organization and is Fly's documented choice for multi-app pipelines. Sources: docs.fly.io/security/tokens, docs.fly.io/reference/deploy-tokens, docs.fly.io/flyctl/integrating, docs.fly.io/flyctl/tokens-create, docs.fly.io/launch/continuous-deployment-with-github-actions (deploy token plus `flyctl deploy --remote-only`, so remote builds work with scoped tokens).
- Joining several deploy tokens in one `FlyV1` header is undocumented: the comma bundle is meant for a root token plus its discharge tokens (superfly/macaroon docs). Rejected.
- Organization `personal` holds only the three demo apps (`flyctl apps list`, read-only).

### `deploy.mjs` in CI (checked, no change)

- **Auth.** `flyctl auth token` prints `cfg.Tokens.GraphQL()` (flyctl `internal/command/auth/token.go`); `FLY_API_TOKEN` replaces the file token in the config (`internal/config/config.go`, `applyEnv` after `applyFile`), so the script reads the CI token. The macaroons come without a scheme (fly-go `tokens/tokens.go`, `normalized(true, false)`), the same shape the workstation already sends as `Bearer …`. The deprecation warning goes to stderr, which the script ignores. Live proof: the first CI deploy (13c).
- **Version.** `actions/checkout` checks out the pushed commit and nothing writes into the work tree (no install: the script uses Node builtins only), so the version is the clean commit SHA.
- **Files.** The script never reads `infra/fly/core/core-secrets.env`; the `local_path` files (`delayed-stop.sh`, `Caddyfile.fly`) are tracked; `.dockerignore` excludes `**/*.env`.
- **Node.** `setup-node` installs Node 22, the version of the images (changed from `engines.node` in the review pass).
- **Duration.** The wait for an awake core is bounded by the idle stop or the guard's awake cap plus its hourly cadence, under GitHub's 6-hour default job limit.
- **Pins** (resolved with `gh api`): `actions/checkout` v7.0.1 `3d3c42e5…`, `actions/setup-node` v7.0.0 `82076278…`, `superfly/flyctl-actions/setup-flyctl` master `ed8efb33…` (2026-04-08; the only release tag, 1.5, dates from 2024). setup-node caches automatically only for npm, so nothing is cached here.
- `gh secret set` reads the value from stdin and trims the trailing newline (cli `pkg/cmd/secret/set/set.go`).

### What was written

- `.github/workflows/deploy.yml`.
- `docs/hosted_runtime.md` (behavior, from design sections 1–8) and `docs/hosted_operations.md` (runbook: deploys, CI token, rotation, resize, admin access, leases, recreation mark, guard logs).
- HD-49 (CI deploy policy) and HD-50 (CI token) in `docs/decisions/hosted_deployment.md`.
- Updates: `docs/runtime_topology.md` (hosted boundary), `docs/decisions/scope_and_caveats.md` (non-goal reworded, hosted caveat added), `docs/repository_layout.md` (gate, fly-machines, `infra/fly/`, workflow), `README.md` index, `docs/automated_testing_infrastructure.md`, `docs/admin_access_protection.md` intro; design section 8 refined.
- Every relative link and anchor in the changed docs resolves (scripted check). No code file changed, so no Biome or test run was needed (Biome ignores Markdown and YAML here).

### Findings for later tasks

- **Core resize (design 1.1 is stale).** Every deploy sends the full core config, so a `fly machine update --vm-size` is reverted by the next deploy, now on every push to `main`. The runbook documents the resize as a change of `guest` in `infra/fly/core/machine.json` plus a deploy. Unverified on Fly: whether a host that cannot fit the new size refuses the update (the deploy fails; revert) or the next start (the gate recovers the core elsewhere). The same applies to the runner size variables, which now change with a deploy, not "with no commit".
- **13a:** the caveat "The repository has no hosted benchmark workflow or published hosted result" in `docs/decisions/scope_and_caveats.md` was left for 13a, which publishes the hosted measurements.
- **13c:** the runbook's commands that touch Fly (the recreation-mark `curl` with the token read from stdin, the token and secret staging) were not run here. The runner-recreation call from the API container is described without a literal command, since `flyctl machine exec` quoting was not verified; add the exact command once run.
- **Pre-existing, not changed:** `docs/repository_layout.md` still says there is no ADR directory under `docs/`, although `docs/decisions/` exists.

### Cloud verification and review (2026-10-06)

- Cloud checks passed, except doc inaccuracies fixed in this pass: the core boot order (Redis gates only the API and the worker), the guard acting without a lease on a host that is not `ok`, the relocating page when no core is listed, the deploy failure messages (actual state, any role), the expected `Partial deployment: … undefined` after the first gate-only deploy on new apps, and `node-version: 22` in the workflow (the images use Node 22).
- Review R1 (lowering a cap can stop the API from starting on a fresh core) confirmed and fixed in the docs: a fresh core seeds the public policy from the `setup` container's `PUBLIC_CUSTOM_*` variables and from fixed seed values (`buildPublicRuntimePolicy`), so caps stay at or above the fixed values and the policy is lowered through `PUBLIC_CUSTOM_*` (owner, no seed code change).
- R2 (a pending run is not guaranteed to be the newest push, and each run deploys its triggering commit) accepted by the owner: merges to `main` are rare and deliberate. HD-49 and the runbook say so; no `ref: main`.
- C8 (`Bearer` header with macaroon tokens) rejected with evidence: the workstation deploys and the gate already send macaroon tokens as `Bearer …` successfully.
- Pre-existing task numbers and a broken backlog link elsewhere in `docs/` are left for a separate cleanup commit.
- No `timeout-minutes` on purpose: GitHub's 6-hour job limit bounds the wait.
