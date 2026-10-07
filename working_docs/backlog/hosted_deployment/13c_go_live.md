# 13c — Go-Live

**Design:** sections 7.2, 8 · **Depends on:** 13a, 13b, plus the external prerequisite

## Goal

The demo runs with fresh secrets, is deployed by GitHub Actions, and is opened to visitors.

## Scope

- **Rotate the core secrets** (HD-33): until task 09 fixed `.dockerignore`, the local core secrets file went into every remote build context and sits in Fly's builder cache.
  - Rotate `CONTROL_SERVICE_TOKEN` (core and runner together), the admin and cookie secrets, the PostgreSQL and Redis passwords with their URLs, and the Fly API tokens the local file holds, following design 7.2.
  - Use a fresh core (`--fresh-core`, owner decision, 2026-10-06) so PostgreSQL initializes with the new password. This drops the development run history; the owner gives the go at the moment.
- **Review the public run budget** (`PUBLIC_RUN_BUDGET_*`) before opening: it bounds how many runs visitors can start, hence the cost (not reviewed in 13a).
- **First deploy through GitHub Actions** (13b's workflow), from a merge into `main`.
- **Open the demo:** the gate URL is public and shareable. The portfolio link is the owner's separate project, not part of this backlog (owner, 2026-10-07).

## Out of Scope

- Bot review (13d).

## Done When

- The demo is reachable at the gate URL, with rotated secrets, deployed by GitHub Actions, and cost alerts are in place.

## Open Points

- None.

## Working Notes

### Owner decisions (2026-10-07)

- **Public run budget:** daily window. `PUBLIC_RUN_BUDGET_WINDOW_SECONDS=86400`, `PUBLIC_RUN_BUDGET_PER_VISITOR_MAX_STARTS=15`, `PUBLIC_RUN_BUDGET_GLOBAL_MAX_STARTS=30`, in the `setup` env of `infra/fly/core/machine.json`, so the fresh core and every later recovery seed them.
- **Fresh core:** a workstation `deploy.mjs all --fresh-core` of the `dev` HEAD before the merge, run with the new CI token (block D). It proves the token (HD-50) before `main`, and puts the mark and the gate's recovery config on the target commit.
- **Secrets and CI token:** the owner runs blocks S and D. The admin passphrase is owner-chosen and kept only in a password manager.
- **Gate tokens** (`gate-core-wake`, `guard-runner`): not rotated. They were never in the local secrets file.
- **Revocation:** the two old core-held tokens are revoked after step 7's verification, in the same session.
- **Local secrets file:** deleted after go-live.
- **Merge:** fast-forward `git push origin dev:main`, so `main` gets the `dev` SHA. A GitHub PR merge or rebase would create a new SHA.
- **Fly billing alert** set before the portfolio link. Calendar reminder around 2027-09 to renew the CI token (one-year expiry, no warning).
- **Doc commits after go-live** are batched: every push to `main` deploys.

### Secret inventory

| App | Secret | Read by | Rotated | Generated as |
| :-- | :-- | :-- | :-- | :-- |
| core | `CONTROL_SERVICE_TOKEN` | `api`, `web` | yes (HD-33) | `openssl rand -hex 32`, same value on the runner |
| core | `ADMIN_DASHBOARD_PASSPHRASE` | `web` | yes | owner-chosen, `read -rs` |
| core | `ADMIN_SESSION_SECRET`, `PUBLIC_CLIENT_COOKIE_SECRET` | `web`; `api`, `web` | yes | `openssl rand -hex 32` each (must differ) |
| core | `POSTGRES_PASSWORD`, `DATABASE_URL` | `postgres` (at initialization only); `setup`, `mock-erp`, `api`, `worker` | yes, with the fresh core | `openssl rand -hex 24`, embedded in the URL |
| core | `REDIS_PASSWORD`, `REDIS_URL` | `redis` (`--requirepass`); `api`, `worker` | yes | `openssl rand -hex 24`, embedded in the URL |
| core | `RUNNER_FLY_API_TOKEN` | `api` | yes; revoke `core api runner operations` | `flyctl tokens create deploy -a checkout-surge-runner -n core-api-runner-<date>` |
| core | `CORE_FLY_API_TOKEN` | `api` (idle stop) | yes; revoke `core-idle-stop` | `flyctl tokens create deploy -a checkout-surge-core -n core-idle-stop-<date>` |
| runner | `CONTROL_SERVICE_TOKEN` | load-orchestrator | yes, with the core | the core's value |
| gate | `CORE_FLY_API_TOKEN`, `RUNNER_FLY_API_TOKEN` | gate and guard | no | — |
| GitHub | `FLY_API_TOKEN` | deploy workflow | new | `flyctl tokens create org -o personal -n github-actions-<date> -x 8760h` |

PostgreSQL most likely trusts loopback connections: the image runs `initdb` without `--auth`, and every client uses `127.0.0.1`. So the password probably protects nothing inside the core. This does not change the plan. Optional check on the fresh core (the file holds no secret): `flyctl machine exec <core id> -a checkout-surge-core --container postgres "grep -v '^#' /persistent/postgres/pg_hba.conf"`.

### Public run budget: cost bounds for the chosen values

- **How the budget works:**
  - Fixed windows aligned on epoch time, so the budget resets at 00:00 UTC. It is counted in Redis.
  - Only public runs count.
  - The per-visitor cap binds only honest visitors, since a client without the cookie gets a new visitor ID. The global cap of 30 runs per day is the bound.
  - Runs are serialized (one nonterminal run), so two visitors at 15 each use up the day.
- **Runner** ($0.416/h while running; it stays up through draining, HD-08):

  | Runs per day | Runner time per run | Per day | Per month (30.4 days) |
  | :-- | :-- | :-- | :-- |
  | 30 presets, short | about 40 s | 20 min, $0.14 | about $4 |
  | 30 presets, long | about 2.5 min | 1.25 h, $0.52 | about $16 |
  | 30 worst-case public custom | about 10.5 min (600 s occupancy ceiling plus boot) | 5.25 h, $2.18 | about $66 |
  | 30 stuck runs | 930 s maximum lifetime (absolute bound) | 7.75 h, $3.22 | about $98 |

- **Core** ($0.312/h awake): not bounded by the budget.
  - The core stays up only while counted activity continues (10-min idle stop).
  - A wake lasts at most about 4 h: the guard's 3 h cap plus its hourly cadence.
  - A new start-button POST can wake it again (HD-03).
  - Kept awake all month by a deliberate actor, it costs about $228, for an abuse ceiling of about $244 to $294 per month. The Fly billing alert is the backstop.
- **Realistic visit:** 15–20 min of core plus a couple of runs, about $0.10–0.15.

### Verification of the budget seed (2026-10-07, no Fly)

I used a throwaway Vitest file in `apps/api/test/unit`, run once and then deleted.
- It imported the real `packages/db/src/scripts/seed.ts` with the `setup` env of `machine.json`, against a mocked database client that captured the inserted policy. The contracts `dist` was rebuilt first.
- It then ran `resolveEffectivePublicRuntimePolicy`, the API's startup check, against caps parsed by the real `loadApiConfig` from the `api` env of `machine.json`.

Results:
- **Seeded budget:** `{"windowSeconds":86400,"perVisitorMaxStarts":15,"globalMaxStarts":30}`, with enforcement on. The startup resolution accepted it, and the public rate limit stayed 500.
- **Caps:** occupancy 600, buyers 10,000, total requests 100,000, 10,000 per second, 300 s, 30 s, 10,000 pre-allocated and max VUs.
- **Negative controls:** `PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND=20000` is refused by the same resolution. Without the window variable, the seed falls back to 300 s.

### Pre-flight (step 1, 2026-10-07 09:50 UTC)

- **Git:**
  - `origin/main` `c8006d72` is an ancestor of `dev` `0afac553`, so a fast-forward is possible.
  - The workflow is not on `main` yet, so there are no runs.
  - `gh secret list` is empty.
- **Fly:**
  - All Machines are `stopped` in `cdg`: core `8d4070aed50068` (metadata `role` only, no mark), runner `d8d3976b666498`, guard `8d40d9fee36ee8`, gate `873325c069dd38`.
  - All run `743f9bb…-dirty`. No leases are held on the core or the runner.
  - Fly tokens: `core-idle-stop` and `gate-core-wake` (core app), `core api runner operations` and `guard-runner` (runner app). There is no org token.
- **Digest baseline:** recorded outside the repository (secret digests are not committed); compare `flyctl secrets list` digests after block S.
- **Workstation:** OpenSSL 3.5.3, Node 22.20.0, `flyctl` on `PATH` (logged in as the owner), and `gh` logged in with the `repo` and `workflow` scopes.

### Procedure

The procedure runs in Git Bash at the repository root.

| # | Step | Who | Irreversible | Check |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Pre-flight (above). | agent | no | as above |
| 2 | Budget commit (`hosted/13c-go-live`), merged into `dev` and pushed. | coordinator | no | `origin/dev` holds it |
| 3 | Check that the core and the runner are `stopped` (`flyctl machine list -a checkout-surge-core`, same for the runner), then run **block S**. | owner | no; re-runnable, each run leaves two tokens to revoke | The 10 core digests and the runner's changed. The core and runner `CONTROL_SERVICE_TOKEN` digests are equal. `flyctl tokens list -a …` shows the two new names |
| 4 | **Block D**, right after block S. | owner | the mark is removable until the first wake (`DELETE` call, hosted operations) | `gh secret list` shows `FLY_API_TOKEN`. The org token list shows `github-actions-<date>`. The deploy prints "The next wake recreates the core fresh and empty" and "both run version <dev SHA>". `flyctl machine status <core id> -a checkout-surge-core -d` shows `"recreate": "requested"` |
| 5 | `git push origin dev:main` | owner, or the agent with the owner's OK | yes: publishes the workflow and triggers a deploy | `gh run list --workflow deploy.yml -L 1`, then `gh run watch <id> --exit-status`. The log ends "both run version <dev SHA>"; the mark is still set |
| 6 | First wake: open `https://checkout-surge-gate.fly.dev` and press start, after step 5 has finished. | owner | **yes:** the old core, its volume and the run history are destroyed | "Installing a fresh demo", then the demo. The gate logs show "Recreated the core Machine". `machine list` shows a new core ID and volume and no mark. History reads "No runs yet" |
| 7 | **Verify.** <br>(a) Core and runner `COMMIT_SHA` = the dev SHA. <br>(b) `/admin` sign-in with the new passphrase. <br>(c) A public preset run completes with counters, and the runner returns to `stopped`. <br>(d) The page shows the daily budget. <br>(e) With the tabs closed, the core is `stopped` within about 10 min (new `CORE_FLY_API_TOKEN`). <br>(f) Optional `pg_hba` check. | agent read-only for (a), (e), (f); owner or the agent with the OK for (b), (c) | no | each item |
| 8 | Revoke the old tokens: `flyctl tokens list -a checkout-surge-runner`, then `flyctl tokens revoke <id of "core api runner operations">`; `flyctl tokens list -a checkout-surge-core`, then `flyctl tokens revoke <id of "core-idle-stop">`. | owner, or the agent with the OK | yes | `REVOKED AT` set on exactly those two; `gate-core-wake` and `guard-runner` untouched |
| 9 | `rm infra/fly/core/core-secrets.env` | owner | yes | the file is gone |
| 10 | Guard: after its next hourly pass, `flyctl logs -a checkout-surge-gate --no-tail` (component `guard`) and `flyctl machine status 8d40d9fee36ee8 -a checkout-surge-gate`. | agent | no | "The guard started." and "checked the app", no errors, exit 0; the old core volume deleted |
| 11 | Fly billing alert, then the portfolio link to `https://checkout-surge-gate.fly.dev`. | owner | opens the demo | the link reaches the gate's start page |
| 12 | Working notes and backlog status, on `dev`, merged to `main` later in one batch. | agent and coordinator | no | — |

**Block S** (step 3):

```bash
( set -euo pipefail; d=$(date +%Y%m%d)
  read -rsp 'Admin passphrase: ' ap; echo
  ct=$(openssl rand -hex 32); ss=$(openssl rand -hex 32); cs=$(openssl rand -hex 32)
  pg=$(openssl rand -hex 24); rp=$(openssl rand -hex 24)
  rt=$(flyctl tokens create deploy -a checkout-surge-runner -n "core-api-runner-$d")
  it=$(flyctl tokens create deploy -a checkout-surge-core -n "core-idle-stop-$d")
  printf '%s\n' "CONTROL_SERVICE_TOKEN=$ct" "ADMIN_DASHBOARD_PASSPHRASE=$ap" \
    "ADMIN_SESSION_SECRET=$ss" "PUBLIC_CLIENT_COOKIE_SECRET=$cs" \
    "POSTGRES_PASSWORD=$pg" "DATABASE_URL=postgresql://postgres:$pg@127.0.0.1:5432/checkout_surge" \
    "REDIS_PASSWORD=$rp" "REDIS_URL=redis://:$rp@127.0.0.1:6379" \
    "RUNNER_FLY_API_TOKEN=$rt" "CORE_FLY_API_TOKEN=$it" \
    | flyctl secrets import --stage -a checkout-surge-core
  printf 'CONTROL_SERVICE_TOKEN=%s\n' "$ct" | flyctl secrets import --stage -a checkout-surge-runner )
```

**Block D** (step 4). It runs from a clean checkout of `dev` at `origin/dev`:

```bash
( set -euo pipefail
  git fetch -q origin
  test -z "$(git status --porcelain)" && test "$(git rev-parse HEAD)" = "$(git rev-parse origin/dev)"
  t=$(flyctl tokens create org -o personal -n "github-actions-$(date +%Y%m%d)" -x 8760h)
  printf '%s' "$t" | gh secret set FLY_API_TOKEN
  FLY_API_TOKEN="$t" node infra/fly/deploy.mjs all --fresh-core )
```

The subshells drop every variable at exit. `printf` is a shell builtin, so no value reaches a process list or a command line.

### Order constraints

- **The CI token exists before step 5.** Otherwise the first run fails at its first Fly call; "Re-run" works once the secret is set.
- **Blocks S and D run back to back, and D finishes before step 5.** A workstation deploy and a CI deploy must not overlap.
- **`CONTROL_SERVICE_TOKEN`** is staged on both apps in block S while both sleep. The runner starts only through the new core.
- **Revocation (step 8)** would be safe any time after block S: the only holder of the two old tokens is the core's `api` container, and any start reads the new values. It waits for step 7 so the new tokens are proven first. Until then, the old tokens can read the new secrets.
- **Wake (step 6) after step 5 has finished.** Otherwise the CI deploy waits for the core to sleep, spending Actions minutes on the private repository.

### If a visitor wakes the core mid-procedure

The demo is not linked yet, and the start button needs a POST.

- **Between blocks S and D:** the old core starts with the new secrets on its old data. It probably works (loopback trust), or it shows the setup-failure page and the guard stops it. Block D then waits for it to sleep and sets the mark.
- **After block D:** the wake recreates the core at the target commit with the new secrets, which is the goal. The CI deploy then just updates the fresh core.
- **During a deploy's lease:** the gate shows the "updating" page; retry.

### Risks and recovery

- **Block S, a bad value.** Setup or web fails on the fresh core (setup-failure page, or booting until the guard).
  - Read `flyctl logs -a checkout-surge-core`.
  - Re-stage the faulty secret while the core sleeps (`flyctl machine stop <id> -a checkout-surge-core` if needed), then wake.
  - A new `POSTGRES_PASSWORD` needs the mark again.
- **Block S, half applied** (core imported, runner failed): the digests differ and every run fails. Re-run block S, then revoke the extra tokens it created.
- **Block D, the org token refused.** This is an HD-50 finding. Deploy with the owner's session (`node infra/fly/deploy.mjs all --fresh-core`) and settle the token before step 5.
- **A mark set by mistake:** remove it with the `DELETE` metadata call before any wake.
- **Step 5, a failed CI deploy** (lease held, partial deployment): use "Re-run" on the latest run only. Clear a stuck lease only when its holder is gone (`flyctl machine leases view` / `leases clear`).
- **Step 6, recovery problems.**
  - If the new core never becomes healthy, it is removed and the old one kept, still marked; read the gate logs and fix the secrets.
  - A no-capacity page means retry later.
  - The loss of run history is accepted and cannot be undone.
- **Code rollback:** push a revert to `main`, or deploy the previous commit from the workstation. Secrets need no rollback: stage new values.
- **Step 8, the wrong token revoked.** If `gate-core-wake` is revoked, the gate can no longer wake the core. Create a new gate core token, stage it on the gate, and stop the gate Machine.

### Go-live log (2026-10-07)

Times are UTC. I checked the facts read-only on Fly and GitHub at about 16:00.

- **Block S** (about 12:52) staged every secret.
  - All 10 core digests and the runner's changed, and the `CONTROL_SERVICE_TOKEN` digests are equal on the core and the runner.
  - New tokens: `core-api-runner-20261007` (runner app) and `core-idle-stop-20261007` (core app).
- **Block D** (about 12:57) created `github-actions-20261007` (org token, expires 2027-10-07) and stored `FLY_API_TOKEN`.
  - The deploy with that token built every image.
  - Fly then refused the runner update for host memory (409, "could not reserve resource … insufficient memory"). The deploy stopped cleanly with consistent versions.
  - The owner approved destroying the stopped runner. `deploy.mjs all --fresh-core` was re-run with the owner's session: OK at `d81384b2`, mark set, new runner `875e99b0504198`.
- **`git push origin dev:main`** (fast-forward to `d81384b2`).
  - The first Actions run (`37627219858`, 13:16) failed on the same runner update, refused this time for host CPU (409 "insufficient CPUs").
  - The versions stayed consistent ("both run version d81384b2…").
  - The org token is proven for the builds and for Machines API authentication from GitHub.
- **First wake:** the core was recreated in about 45 s.
  - New core `863e11ceed4408` (created 13:27) on volume `vol_vz8l0zn2n7q1y8qv`.
  - The old core `8d4070aed50068` and its volume are gone.
- **Admin sign-in** with the new passphrase: OK.
- **First admin `preview-1k`:** failed with 503 `load_orchestrator_unavailable`.
  - Cause: the API's pre-start runner update was refused or reverted for capacity, outside the relocation path (fixed by task 17).
  - Unblocked with `POST /admin/demo/runner/recreate` from the API container. The new runner `807244c6672338` (cdg) was created 13:38.
  - `preview-1k` then completed, and the runner returned to `stopped`.
- **Idle stop** at 13:56: the core stopped itself, which proves the new `core-idle-stop-20261007` token.
- **Revoked** `core api runner operations` and `core-idle-stop` at 14:01. `gate-core-wake` and `guard-runner` are unchanged.
- **Local secrets file** deleted by the owner (`infra/fly/core/` no longer holds it).
- **Guard** passes at 13:47, 14:47 and 15:47: no actions, exit 0. The old volume is gone.
- **Current state:** core, runner, gate and guard are all `stopped` and all at `d81384b2`. `main` is `d81384b2`, and its only deploy run failed (see above).

### Remaining

1. **The batched push to `main`:** this documentation batch plus task 17's fix (`5e6f48bc` on `dev`), by fast-forward. Then check that the CI run succeeds, and run task 17's manual verification on Fly.
2. **A Fly billing alert** (owner).
3. **The portfolio link** to the gate (owner), after 1 and 2.

### Closure (2026-10-07)

- Cost alerts: Grafana Cloud free stack with four rules (core 24 h and 4 h, runner 24 h, demo in use) on Discord plus email and an informational Discord channel; documented in `docs/hosted_operations.md` (Cost Alerts) and HD-57. Fly has no billing alerts or caps.
- Verified after the task 17 deploy (`176c517b`): a public `preview-1k` completed; the runner took the run settings in place.
- Done. The portfolio link is out of scope (owner's separate project).
