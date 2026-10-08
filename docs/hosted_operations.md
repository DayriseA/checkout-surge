# Hosted Operations

Procedures for operating the hosted demo on Fly.io. How the hosted runtime behaves is in [Hosted Runtime](hosted_runtime.md), and the decisions behind it are in the [hosted deployment decision log](decisions/hosted_deployment.md).

---

## Before You Start

- Use flyctl logged in to the Fly organization that holds the apps (`flyctl auth login`), Node.js 22 or later, and a clone of the repository. Run commands from the repository root in a POSIX shell (Git Bash on Windows).
- The apps are `checkout-surge-gate`, `checkout-surge-core` and `checkout-surge-runner`, in the organization `personal`. Every flyctl command names its app with `-a`.
- `flyctl machine list -a <app>` lists an app's Machines; `flyctl machine status <id> -a <app> -d` also prints the Machine's config, metadata included. `flyctl logs -a <app>` streams an app's logs, and `--no-tail` prints the recent ones.
- Never print, write or commit a token or secret value. The commands below pass each value from the command that creates it to the command that stores it, through a pipe or a shell variable.

---

## Deploying

### Continuous deployment

`.github/workflows/deploy.yml` runs `node infra/fly/deploy.mjs all` on every push to `main` ([HD-49](decisions/hosted_deployment.md#hd-49-github-actions-deploys-every-push-to-main-with-the-workstations-script)).

- **Token.** It authenticates with the repository secret `FLY_API_TOKEN` ([CI token](#ci-token)).
- **Pinned tools.** Its actions are pinned by commit SHA and its flyctl version is pinned. Raise the flyctl version on purpose, after a workstation deploy with that version.
- **No `--force`.** When a visitor has the core awake, the deploy waits for the core to sleep. The wait is bounded by the idle stop or, failing that, by the guard's awake cap. A waiting deploy consumes runner minutes, which matters on a private repository.
- **Every push deploys.** The workflow has no path filter, so a documentation-only push to `main` also rebuilds and waits for the core to sleep. Batch such commits.
- **One at a time.** A running deploy is never cancelled, and a newer push replaces a deploy still waiting to start. The deploy left waiting is usually the newest push, but GitHub does not guarantee the order: if the hosted version lags `main`, re-run the latest run or push again.
- **Do not cancel a running deploy by hand.** A deploy killed while it holds a Machine lease leaves the lease until it expires ([freeing a lease](#freeing-a-lease)).
- **A failed deploy** fails the workflow run, and GitHub notifies the person who pushed. Read the run's log and the [failure messages](#when-a-deploy-fails), then use GitHub's "Re-run" only on the latest run of `main`: re-running an older run deploys that older commit, which stays live until the next push to `main`.

### From the workstation

```bash
node infra/fly/deploy.mjs <all|core|runner|gate> [--force] [--fresh-core] [--no-depot | --local-build]
```

The script uses the operator's flyctl session. Set `FLYCTL` to the flyctl executable when it is not on `PATH`.

- `all` is the normal target. Single-app targets remain, for example for a gate-only change; a core-only or runner-only deploy of a new commit ends with the partial-deployment failure on purpose.
- `--force` stops an awake core, and a running runner, instead of waiting: visitors lose their session, and a run in progress ends failed.
- `--fresh-core` marks the core for recreation ([incompatible changes](#incompatible-changes)).
- `--no-depot` uses Fly's previous remote builder during a Depot incident; `--local-build` builds with the local Docker engine, then pushes.

Workstation deploys stay available at any time, from any checked-out commit, without a commit to `main`. The hosted version then differs from `main` until the next push to `main` redeploys `main`.

A workstation deploy and a CI deploy must not overlap. Their leases make the second one fail, or wait for the core and then replace the first one's version. Check that no workflow run is in progress before deploying from the workstation.

### When a deploy fails

The script compares the core's and the runner's versions at the end, even after a failed step. A core marked for recreation counts at the version of the core config in the gate, which the next wake recreates it at; the log then reads `The core is marked for recreation: …`.

| Message | Meaning and action |
| :-- | :-- |
| `The lease of Machine … is held; re-run the deploy.` | A wake, a recovery, the guard or a runner operation holds the lease. Re-run a little later. |
| `core Machine … is <state>; re-run, or use --force.` | A visitor woke the core between the wait and the lease. Re-run. |
| `runner Machine … is <state>; re-run, or use --force.` | A run is in progress. Re-run after it. |
| `Partial deployment: …` | The core and the runner run different commits, so every run is refused. Re-run `all`. On a new set of apps, the first gate-only deploy ends with `Partial deployment: … undefined` (exit 1), as expected: continue with `all`. |
| `Expected at most one <role> Machine, found …` | Two Machines carry the same role. For the core or the runner, a recovery is in progress or left one behind: re-run once it ends or the guard has cleaned up. For the gate or the guard, remove the extra Machine by hand. |
| `Deploy the gate first …`, `No runner Machine with a full config …` | A new set of apps: see [one-time setup](#one-time-setup). |

### Incompatible changes

A change that the existing core data cannot use, such as a rewritten database baseline or a new rule for a status that readers re-derive from stored runs, needs a fresh, empty core ([HD-48](decisions/hosted_deployment.md#hd-48-a-requested-fresh-core-stays-requested-until-a-wake-acts-on-it)):

1. Before merging, deploy the commit from the workstation with `node infra/fly/deploy.mjs all --fresh-core`. The core is marked `recreate=requested`, and the next visitor wake recreates it through the recovery path.
2. Merge into `main`. The CI deploy carries the mark over when no wake happened meanwhile, or finds a core that is already fresh.

If an incompatible change reached `main` without the mark, stop the core if it is awake (`flyctl machine stop <core id> -a checkout-surge-core`), then [set the mark by hand](#recreation-mark). The next wake recreates the core.

### Recreation mark

The mark lives in the core Machine's metadata. Change it while no deploy runs, since a deploy carries over the mark it finds. When a full host refuses or reverts the deploy's core update, the script also sets `recreate_reason=capacity`, so visitors see the relocating page rather than the fresh-install page; a mark set by hand or with `--fresh-core` has no reason. The gate reads the reason only with the mark, and the next deploy drops a reason left without one. These commands send the operator's flyctl token in a header read from standard input, so the token never appears on a command line.

- **Set it,** for a fresh core at the next wake:

  ```bash
  flyctl auth token | sed 's/^/Authorization: Bearer /' | curl -sS -H @- -H 'Content-Type: application/json' \
    -X POST -d '{"value":"requested"}' \
    https://api.machines.dev/v1/apps/checkout-surge-core/machines/<core id>/metadata/recreate
  ```

- **Remove a mark set by mistake:**

  ```bash
  flyctl auth token | sed 's/^/Authorization: Bearer /' | curl -sS -H @- \
    -X DELETE https://api.machines.dev/v1/apps/checkout-surge-core/machines/<core id>/metadata/recreate
  ```

- **Check it:** `flyctl machine status <core id> -a checkout-surge-core -d` shows `"recreate": "requested"` under `metadata` while the mark is set, with `"recreate_reason": "capacity"` when the deploy set it for a full host.

---

## One-Time Setup

For a new set of apps:

1. Create the three apps with `flyctl apps create <app> -o <org>`. The app names are referenced in `infra/fly/`.
2. Give the gate its public addresses: `flyctl ips allocate-v4 --shared -a checkout-surge-gate` and `flyctl ips allocate-v6 -a checkout-surge-gate`. The core and the runner get none.
3. Stage each app's [secrets](hosted_runtime.md#secrets-and-tokens) with `flyctl secrets import --stage -a <app>`, fed straight from the command that generates or creates each value, as in the [rotation procedures](#rotating-secrets-and-tokens).
4. Deploy the gate first (`node infra/fly/deploy.mjs gate`), because a core deploy writes its config into the gate Machine. It ends with `Partial deployment: … undefined` (exit 1), as expected while no core or runner exists; then deploy `all`. The first deploy creates the Machines and the core's volume.

---

## CI Token

The deploy workflow authenticates with one organization deploy token, stored as the repository secret `FLY_API_TOKEN` ([HD-50](decisions/hosted_deployment.md#hd-50-the-ci-deploy-token-is-an-organization-deploy-token)). It is valid for one year.

- **Create and store** it from the repository root, in a shell logged in to both flyctl and the GitHub CLI:

  ```bash
  t=$(flyctl tokens create org -o personal -n "github-actions-<yyyymmdd>" -x 8760h) \
    && printf '%s' "$t" | gh secret set FLY_API_TOKEN; unset t
  ```

- **Check** that `gh secret list` shows `FLY_API_TOKEN` with today's date, and that `flyctl tokens list -s org -o personal` shows the token's name.
- **Renew it before it expires.** Nothing in the project warns ahead of time, and an expired token fails the deploy at its first Fly call. Create and store a new token the same way, with the new date in its name; the next deploy uses it. Then revoke the old one.
- **Revoke** a token while no deploy runs: `flyctl tokens list -s org -o personal`, then `flyctl tokens revoke <id>`.

---

## Rotating Secrets and Tokens

Machines read their app's secrets when they start, so a staged secret takes effect at each holder's next start, and nothing is redeployed.

- **Checking a change.** `flyctl secrets list -a <app>` shows every secret as `Staged`, always: deploys go through the Machines API, never through a Fly release. Compare the `DIGEST` column before and after instead. Never run `flyctl secrets deploy`.
- **Revocation completes a rotation.** A deploy token can read its app's secrets, so an old core-app or runner-app token can read the newly staged values until it is revoked.

### Machines API tokens

| Secret | Holder app (Machines) | Token for app | Current token name |
| :-- | :-- | :-- | :-- |
| `RUNNER_FLY_API_TOKEN` | core (API) | runner | `core-api-runner-20261007` |
| `CORE_FLY_API_TOKEN` | core (API) | core | `core-idle-stop-20261007` |
| `CORE_FLY_API_TOKEN` | gate (gate and guard) | core | `gate-core-wake` |
| `RUNNER_FLY_API_TOKEN` | gate (gate and guard) | runner | `guard-runner` |

Rotate one token at a time:

1. Pick a moment when the holder sleeps: the core stopped (the gate shows its start page) for a core secret; any moment for a gate secret.
2. Create a new deploy token with a dated name and stage it straight from the command output. For example, the guard's runner token:

   ```bash
   t=$(flyctl tokens create deploy -a checkout-surge-runner -n "guard-runner-<yyyymmdd>") \
     && printf 'RUNNER_FLY_API_TOKEN=%s\n' "$t" | flyctl secrets import --stage -a checkout-surge-gate; unset t
   ```

   The old token stays valid until step 5.
3. Let every holder restart: the core at its next wake; the gate by stopping its Machine (`flyctl machine stop <gate id> -a checkout-surge-gate`), which Fly Proxy starts again on the next request; the guard at its next hourly run.
4. Check each holder with the new token: a wake through the gate and the core's idle stop for core-app tokens, a run for the API's runner token, and a guard run without errors ([guard logs](#guard-logs-and-switches)).
5. Revoke the old token: `flyctl tokens list -a <token app>`, then `flyctl tokens revoke <id>`. A holder still running with it fails its Machines API calls until it restarts, which is why step 3 comes first.

### Grafana Cloud metrics token

The [cost alerts](#cost-alerts) query Fly's metrics with a read-only organization token, held only by the Grafana Cloud data source. It is not a Fly secret, so nothing on Fly restarts when it changes.

| Holder | Token type | Current token name |
| :-- | :-- | :-- |
| Grafana Cloud data source `Fly Prometheus` | read-only, organization `personal` | `grafana-cloud-<yyyymmdd>` |

- **What it can do.** Read everything in the organization: apps, Machines and their configs, metrics. It cannot change anything, and Fly never returns secret values.
- **Renew it before it expires,** one year after creation. An expired or revoked token makes every rule fail, and each sends a `DatasourceError` alert to its contact point. Create a new token as in [step 2 of the setup](#setting-up-grafana-cloud), paste it as the new value of the data source's `Authorization` header, and **Save & test**. Then revoke the old one: `flyctl tokens list -s org -o personal`, then `flyctl tokens revoke <id>`.

### `CONTROL_SERVICE_TOKEN`

It authenticates both directions between the core and the runner, so it changes on both apps together:

1. Make sure both sleep: the core and the runner `stopped`. Wait for the idle stop, or stop the core with `flyctl machine stop`; the runner stops at the end of each run.
2. Generate the value in a shell variable, stage it on both apps, then drop it:

   ```bash
   t=$(openssl rand -hex 32) \
     && printf 'CONTROL_SERVICE_TOKEN=%s\n' "$t" | flyctl secrets import --stage -a checkout-surge-core \
     && printf 'CONTROL_SERVICE_TOKEN=%s\n' "$t" | flyctl secrets import --stage -a checkout-surge-runner; unset t
   ```

3. The next wake starts the core with the new value, and the next run starts the runner with it. If one app started in between with the other value, every run fails until both have restarted: stop both and try again.
4. If you keep a local copy of the secrets, update it the same way, without printing it. Nothing on Fly reads it.

### Other core secrets

- **Admin passphrase, admin session secret, visitor cookie secret, Redis password with `REDIS_URL`.** Stage them on the core while it sleeps; they take effect at its next start. A new session or cookie secret invalidates existing admin sessions and visitor cookies.
- **Values.**
  - The admin passphrase is chosen by the owner, who needs it to sign in: read it into a shell variable with `read -rs` from a password manager. Avoid quotes, `#` and line breaks, which the import parses.
  - Generate the other values with `openssl rand -hex`, so they are URL-safe. The session secret and the cookie secret must differ, and the cookie secret takes at least 16 bytes; placeholder values are refused. A refused value keeps the web container unhealthy, and the gate shows the booting page until the guard stops the core.
  - PostgreSQL and Redis listen on `127.0.0.1` only, so the URLs use that host: `DATABASE_URL` as `postgresql://postgres:<password>@127.0.0.1:5432/checkout_surge`, `REDIS_URL` as `redis://:<password>@127.0.0.1:6379`, each with the password staged beside it.
- **PostgreSQL password with `DATABASE_URL`.** PostgreSQL applies its password only when it initializes an empty data directory. Stage both while the core sleeps, then [set the recreation mark](#recreation-mark): the next wake installs a fresh core with the new password, and hosted run history and admin edits are lost.

### Rotating every core secret at once

Use this procedure when every core secret must change, for example after they leaked. The new values go in with a fresh core, so PostgreSQL takes the new password. Hosted run history and admin edits are lost. The gate's tokens are rotated separately ([Machines API tokens](#machines-api-tokens)).

1. **Stage the secrets.**
   - Check that the core and the runner are `stopped` (`flyctl machine list -a checkout-surge-core`, and the same for the runner).
   - Note the digests of both apps (`flyctl secrets list`).
   - Then run the block below. It reads the [admin passphrase](#other-core-secrets) from the terminal, creates the core's two Machines API tokens, generates the other values, and stages them on the core, with `CONTROL_SERVICE_TOKEN` on the runner too. The values live only in the subshell. Nothing restarts.

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

   Check: every core digest and the runner's have changed; the core's and the runner's `CONTROL_SERVICE_TOKEN` digests are equal; and `flyctl tokens list -a <app>` shows the two new token names.
2. **Deploy a fresh core from the workstation,** right after step 1.
   - Deploy the commit that is, or is about to be, on `main`: set `ref` to `origin/main`, or to the branch about to be fast-forwarded into it.
   - To create or renew the [CI token](#ci-token) at the same time, create it in the same subshell, store it, and run the deploy with `FLY_API_TOKEN="$t"`, so the deploy proves the token before CI uses it.

   ```bash
   ( set -euo pipefail; ref=origin/main
     git fetch -q origin
     test -z "$(git status --porcelain)" && test "$(git rev-parse HEAD)" = "$(git rev-parse "$ref")"
     node infra/fly/deploy.mjs all --fresh-core )
   ```

   Check: the deploy prints `The next wake recreates the core fresh and empty` and `The core and the runner both run version …`.
3. **Push, if the deployed commit is not on `main` yet:** `git push origin <branch>:main`.
   - A fast-forward gives `main` the deployed commit. The CI deploy then carries the mark over ([incompatible changes](#incompatible-changes)), or finds the core already fresh.
   - A failed CI deploy is retried with GitHub's "Re-run" on the latest run ([continuous deployment](#continuous-deployment)).
   - Wait for the run to finish before the first wake. Otherwise the deploy waits for the core to sleep.
4. **Wake the core** from the gate's start page.
   - The fresh-install page shows, then the demo.
   - `flyctl machine list -a checkout-surge-core` lists a new core with a new volume and no `recreate` mark. The old core and its volume are gone.
5. **Verify.**
   - `COMMIT_SHA` matches on the core's API container and on the runner (`flyctl machine status <id> -a <app> -d`).
   - Sign in to `/admin` with the new passphrase.
   - A public preset run completes, and the runner returns to `stopped`. This proves the runner token, the control token in both directions, the cookie secret, and the database and Redis URLs.
   - With every tab closed, the core stops after the idle period (the core token).
   - The guard's next run is clean ([guard logs](#guard-logs-and-switches)).
6. **Revoke the old tokens** of the core's API: `flyctl tokens list -a checkout-surge-runner` and `-a checkout-surge-core`, then `flyctl tokens revoke <id>` for each old name. Only the stopped core held them, so revoking earlier is also safe; until it is done, the old tokens can read the new secrets.
7. **Remove local copies** of the secrets. Keep only the admin passphrase, in a password manager.

What can go wrong:

- **A visitor wakes the core between steps 1 and 2.** The old core starts with the new secrets on its old data: it either works, or shows the setup-failure page until the guard stops it. Step 2 waits for it to sleep, then sets the mark. A wake after step 2 is the recreation itself.
- **A bad value.** The fresh core's setup or web container fails ([values](#other-core-secrets)). Read `flyctl logs -a checkout-surge-core`, stop the core if it is up, stage the corrected secret, and wake again. A new `POSTGRES_PASSWORD` needs the [recreation mark](#recreation-mark) again.
- **Step 1 half applied** (the core imported, the runner failed). The control token digests differ, and every run fails. Run step 1 again, then revoke the extra tokens it created.
- **A full host refuses the deploy's update.** The script recreates the runner on another host and marks the core for recreation ([HD-55](decisions/hosted_deployment.md#hd-55-a-host-that-refuses-the-runners-new-config-relocates-the-runner-at-once), [HD-56](decisions/hosted_deployment.md#hd-56-a-core-whose-host-refuses-the-deploy-is-marked-for-a-fresh-recreation)). Any other failure is re-run ([when a deploy fails](#when-a-deploy-fails)).
- **The first run cannot start its runner, and the runner stays stuck.** [Recreate the runner](#runner-recreation) from the API container, then start again.
- **A mark set by mistake.** [Remove it](#recreation-mark) before any wake.
- **The wrong token revoked.** Create a new token for that holder and stage it as in [Machines API tokens](#machines-api-tokens).

---

## Resizing and Limits

- **Core.** Change `guest` in `infra/fly/core/machine.json` and deploy. The deploy updates the sleeping core, and a later recovery places the new core on a host that fits that size. Do not resize with `flyctl machine update --vm-size`: the next deploy sends the file again and reverts it. The core is pinned to its volume's host, so a host that cannot fit the new size makes Fly refuse the update or the next start. An update refused for capacity makes the deploy mark the core for recreation, and a refused start makes the gate recover it: either way the next wake recreates the core on another host, fresh and empty ([HD-56](decisions/hosted_deployment.md#hd-56-a-core-whose-host-refuses-the-deploy-is-marked-for-a-fresh-recreation)).
- **Runner.** Set `RUNNER_CPU_KIND`, `RUNNER_CPUS` and `RUNNER_MEMORY_MB` in the API container of `infra/fly/core/machine.json`, make `guest` in `infra/fly/runner/machine.json` match, and deploy `all`. The API applies the size before the next run; the runner has no volume, so its resize is safe.
- **Run limits.** The `DEMO_MAX_*` deployment caps are API variables in the same container. The API refuses to start when the active public runtime policy exceeds one of them.
  - A fresh core (a recovery, or `--fresh-core`) seeds that policy from the `setup` container's `PUBLIC_CUSTOM_*` variables and from fixed seed values (`buildPublicRuntimePolicy` in `packages/db/src/scripts/seed.ts`). Lower the matching `PUBLIC_CUSTOM_*` variable in the `setup` container together with a cap, and never set a cap below a fixed seed value.
  - On the running core, the seed keeps the existing policy: lower it in the admin console before deploying lower caps.
  - **Raising a public limit on the running core.** A new `PUBLIC_CUSTOM_*` value reaches only a fresh core, so after the deploy, edit the live policy to match:
    - **Admin console:** on [`/admin`](#admin-access), open **Public runtime policy**, change the fields under **Public custom limits** (for example **Max requests/sec** and **Max total requests**), click **Save public policy**, then confirm the change summary.
    - **API:** from the API container, with the control token ([straight to the API](#admin-access)), `GET http://127.0.0.1:4000/admin/demo/runtime-policy`, take its `policy`, remove `deploymentHardCaps`, change the limits under `publicCustomLimits`, and send it back as `PUT` with the body `{ "policy": ... }` and a JSON content type. The whole policy is replaced, so start from the current one.
    - Either way, the API refuses a limit above its deployment cap and answers with the new policy otherwise.
- **Public run budget.** The `PUBLIC_RUN_BUDGET_*` variables of the `setup` container bound how many public runs start per window, globally and per visitor cookie; admin runs are not counted. A client that drops its cookie counts as a new visitor, so the global value is the one that bounds cost. Like the `PUBLIC_CUSTOM_*` limits, they are seeded only on a fresh core. An admin console edit lasts until the next recovery, so change the file for a lasting value.

---

## Admin Access

- **Through the gate.** Open `/admin` on the gate's public URL and sign in with the admin passphrase. Wake the core from the gate's start page first.
- **Not through `flyctl proxy`.** `flyctl proxy 8080 -a checkout-surge-core` reaches the awake core's Caddy from `localhost`, but admin writes are refused there: the admin origin check expects the gate's URL (`WEB_ORIGIN`), not `http://localhost:8080`.
- **Straight to the API.** Operator calls to protected API routes carry the control token in the `x-control-service-token` header. Run them inside the core's API container (`flyctl machine exec <core id> -a checkout-surge-core --container api '<command>'`), where `CONTROL_SERVICE_TOKEN` is already set, so the token never leaves the Machine. Such calls do not count as activity, so the core can still go to sleep meanwhile ([HD-22](decisions/hosted_deployment.md#hd-22-known-limitation-short-operator-runs-are-not-counted)).

### Runner recreation

`POST /admin/demo/runner/recreate` (control token) recreates the runner as a capacity failure would, from the deployed runner config, and leaves the new runner stopped. It needs an awake core, answers 409 while the runner is not stopped, and otherwise answers 200 with the new runner's Machine ID and region. Call it from the API container as above, for example with a `node -e` script that posts to `http://127.0.0.1:4000/admin/demo/runner/recreate` with the header taken from `process.env.CONTROL_SERVICE_TOKEN`.

---

## Freeing a Lease

A deploy killed while it holds a Machine lease (a cancelled workflow run, a closed terminal) leaves the lease until it expires. Meanwhile, wakes show the updating page and deploys fail on it.

- `flyctl machine leases view <id> -a <app>` shows the lease, its owner and its expiry.
- `flyctl machine leases clear <id> -a <app>` frees it at once. Clear a lease only when you know its holder is gone, such as the deploy you just stopped: clearing a live holder's lease lets two clients act on the Machine at once.

---

## Guard Logs and Switches

- **Logs.** The guard logs in the gate app with `component: guard`: `flyctl logs -a checkout-surge-gate`. Each run logs `The guard started.` and, per app, `The guard checked the app.` with its action count. Every action logs `The guard acted.` or `Leased or changed since the plan; the guard skipped it.`. Errors read `The guard could not read the app.`, `The guard could not act.` or `The guard failed.`, and the run then exits non-zero (`flyctl machine status <guard id> -a checkout-surge-gate` shows its recent events, exits included).
- **No alerting.** These logs and the guard Machine's exits are the only direct signal of a failed guard run. Check them after rotating a token the guard holds, and when reviewing the demo's traffic. The [cost alerts](#cost-alerts) catch only its effect, a core or a runner left awake.
- **Switches,** for demonstrations only, in the guard Machine's env: `GUARD_DRY_RUN=true` logs the plan without acting; `GUARD_CORE_MAX_AWAKE_SECONDS`, `GUARD_CORE_STARTUP_GRACE_SECONDS`, `GUARD_RUNNER_MAX_STARTED_SECONDS` and `GUARD_LEFTOVER_GRACE_SECONDS` override the thresholds. Set them in `infra/fly/gate/guard-machine.json` and deploy the gate from the workstation; the next deploy of `main` resets them.
- **Never change the guard with `flyctl machine update --skip-start`.** A guard updated with `skip_launch` is never started by Fly's scheduler again ([HD-41](decisions/hosted_deployment.md#hd-41-the-guard-is-deployed-without-skip_launch)).

---

## Cost Alerts

Fly.io has no billing alerts and no spending cap, so runaway awake time would otherwise show only on the invoice. Alert rules in a Grafana Cloud free stack watch it and notify the owner ([HD-57](decisions/hosted_deployment.md#hd-57-cost-alerts-run-in-an-external-grafana-cloud-not-in-a-scheduled-github-workflow)). Fly's own Grafana at fly-metrics.net has alerting disabled.

### What they watch

- **Machine-time.** A running Machine reports `fly_instance_up` every 15 seconds, and a stopped one reports nothing. The number of samples over a window, times 15 seconds, is how long the app's Machines ran in it. Each Machine counts on its own, so two cores during a recovery count twice, as Fly bills them.
- **Core above 6 hours in 24 hours** (alert). That is twice the [guard](hosted_runtime.md#guard)'s awake cap and well above normal use, so one long visit never triggers it. Repeated re-waking ([HD-03](decisions/hosted_deployment.md#hd-03-accepted-risk-bots-can-keep-an-awake-core-up)) or a guard that stopped acting triggers it within the day.
- **Runner above 60 minutes in 24 hours** (alert). That is far above a normal day's runs, so only a runner left running or an unusual run volume triggers it.
- **Core at least 3 hours in the last 4 hours** (alert). It signals sustained heavy use that the guard is about to cap, or, if it keeps firing, a guard that failed to cap it. It reacts within hours, where the 24-hour rule may take the rest of the day.
- **Demo in use: core above 2 minutes in the last 10 minutes** (information). It tells the owner that someone is using the demo, on a channel that can be muted.
- **The watcher itself.** A failed query, such as an expired token, raises its own `DatasourceError` alert by default.

### Setting up Grafana Cloud

1. **Account and stack.** Create a free account at grafana.com and a stack in an EU region, then open the stack's Grafana.
2. **Token.** Create a read-only organization token, valid for one year, and copy it to the clipboard without showing it. The `tr` strips the trailing line break, which would otherwise break the header.
   - Windows (Git Bash):

     ```bash
     flyctl tokens create readonly -o personal -n "grafana-cloud-$(date +%Y%m%d)" -x 8760h | tr -d '\r\n' | clip.exe
     ```

   - macOS: the same command ending with `| tr -d '\n' | pbcopy`. Linux: ending with `| tr -d '\n' | xclip -selection clipboard`, or `| wl-copy` on Wayland.
   - After step 3, empty the clipboard (`printf '' | clip.exe`, or the same into `pbcopy` or `xclip -selection clipboard`) and delete the entry from any clipboard history (Windows: `Win+V`).
3. **Data source.** Connections → Data sources → Add new data source → Prometheus.
   - Name: `Fly Prometheus`. The name is edited with the pencil beside the title, and its check mark saves the name at once.
   - Prometheus server URL: `https://api.fly.io/prometheus/personal/`.
   - Authentication: no authentication.
   - HTTP headers: add the header `Authorization` and paste the token as its value. The value is the full command output, starting with `FlyV1 `; add no `Bearer`.
   - **Save & test** must report that the Prometheus API was queried successfully. A 401 usually means a stray line break or a truncated paste.
   - Leave the rest at its defaults. Under Alerting, "Manage alerts via Alerting UI" concerns rules stored in the data source itself, which Fly does not accept, so the alert rule list always shows "No rules found" under `Fly Prometheus`.
4. **Contact points.** Alerting → Notification configuration → Contact points.
   - **`owner-alerts`**, for alerts: a Discord integration posting to a dedicated channel, plus, with "Add contact point integration", an Email integration as a fallback.
     - Discord: in the channel's settings, Integrations → Webhooks → New Webhook, then copy its URL into the integration's "Webhook URL". Treat that URL as a secret: anyone who has it can post in the channel.
     - Email: on a free account, alert emails reach only users of the instance, so use the address of the account's own user.
   - **`owner-info`**, for information: a Discord integration only, posting to a separate channel that can be muted.
   - Use **Test** on each integration, then save.
   - Telegram works the same way instead of Discord: create a bot with @BotFather, then give the Telegram integration the bot token and the chat ID of the conversation it posts to. The bot token is a secret too.
5. **Alert rules.** Alerting → Alert rules → New alert rule, once per row. Each query uses data source `Fly Prometheus`, Code mode and type Instant.

   | Name | Query | Condition | Evaluation group | Contact point |
   | :-- | :-- | :-- | :-- | :-- |
   | `Core awake time (24h)` | `sum(count_over_time(fly_instance_up{app="checkout-surge-core"}[24h])) * 15 / 3600 or vector(0)` | is above `6` (hours) | `cost` | `owner-alerts` |
   | `Runner run time (24h)` | `sum(count_over_time(fly_instance_up{app="checkout-surge-runner"}[24h])) * 15 / 60 or vector(0)` | is above `60` (minutes) | `cost` | `owner-alerts` |
   | `Core awake 3h of last 4h` | `sum(count_over_time(fly_instance_up{app="checkout-surge-core"}[4h])) * 15 / 3600 or vector(0)` | is above or equal to `3` (hours) | `cost` | `owner-alerts` |
   | `Demo in use (info)` | `sum(count_over_time(fly_instance_up{app="checkout-surge-core"}[10m])) * 15 / 60 or vector(0)` | is above `2` (minutes) | `info` | `owner-info` |

   For every rule:
   - Folder: `Cost alerts`, created with "New folder" on the first rule. The folder is created at once.
   - Evaluation groups: `cost`, evaluated every 30 minutes, and `info`, evaluated every 10 minutes, each created with "New evaluation group" on its first rule. A 10-minute window evaluated every 10 minutes catches every wake, since the core stays awake at least 10 minutes.
   - Pending period: None. Grafana accepts only a pending period at least as long as the group's interval, or None, and a single evaluation already covers hours of data.
   - No data and error handling: keep both defaults. `or vector(0)` turns a window without any awake Machine into `0` instead of no data. Without it, a quiet period would leave the query empty and send a `DatasourceNoData` alert; set "Alert state if no data" to Normal if you ever drop it. Keep the error default (Error), which sends a `DatasourceError` alert when the query fails.
   - Summary: prefix it with `[Checkout-Surge]: `, or `[Checkout-Surge][info]: ` for the information rule, so a shared channel shows where a message comes from. For example, `[Checkout-Surge]: Core awake more than 6 h in the last 24 h`.
   - Type into the summary only once the field has the focus. Outside a field, Grafana reads letters as keyboard shortcuts: `g` then `e` opens Explore, and the unsaved rule is lost.
6. **Test.**
   - In the rule editor, **Preview alert rule condition** runs the query and shows the current value and whether the condition holds.
   - Use **Test** on a contact point to check the channel.
   - For an end-to-end check, lower one threshold to `0` on a day the core has woken, and save. A firing message arrives at the group's next evaluation. Restore the threshold, and a resolved message follows.
7. **Export.** Alert rules → the `Cost alerts` folder → Export, as YAML. Keep it as a backup of the rules; it holds the data source's UID but no token. This section stays the reference for rebuilding them.

### How notifications behave

- **One message per state change.** A rule sends one Firing message when its condition starts to hold, and one Resolved message when it stops. While it keeps firing, Grafana's default notification policy repeats the Firing message after its repeat interval, 4 hours by default.
- **24-hour and 4-hour rules** resolve only once the window has dropped back under the threshold, hours after the cause ends.
- **Demo in use** resolves 10 to 20 minutes after the core sleeps: the 10-minute window first has to drop to 2 minutes of awake time or less, which takes about 8 minutes after the stop, and the next evaluation can come up to 10 minutes later.
- **Watcher errors** go to the failing rule's contact point, so an expired token shows on both channels.

### Alternative: a scheduled GitHub Actions workflow

For a copy of the demo whose repository stays private, or for an owner who wants no extra account, a scheduled workflow can run the two 24-hour checks and open an issue. Change the organization slug and the app names to your own, and store a read-only token as the repository secret `FLY_METRICS_TOKEN`:

```bash
t=$(flyctl tokens create readonly -o personal -n "github-cost-watch-$(date +%Y%m%d)" -x 8760h) \
  && printf '%s' "$t" | gh secret set FLY_METRICS_TOKEN; unset t
```

Caveats:

- **60-day disable on public repositories.** GitHub disables scheduled workflows in a public repository after 60 days without activity. Pushes, merges and releases count; issue comments, stars and the workflow's own runs do not. Owners report a warning email beforehand, and the workflow is re-enabled from the Actions tab. Here, a keepalive commit to `main` would also deploy ([continuous deployment](#continuous-deployment)).
- **Hourly and late.** Scheduled runs are delayed at busy times, especially on the hour, and some are dropped. An alert can come an hour or two late.
- **Who is emailed.** A failed scheduled run notifies the user who last changed the `cron` line, subject to that user's notification settings. While a limit is exceeded, the workflow comments on its issue and fails every hour.
- **Minutes.** On a private repository, every run bills at least one minute of the plan's Actions quota.

Place it in `.github/workflows/` only in your own copy:

```yaml
name: Cost watch

on:
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:

permissions:
  issues: write

concurrency:
  group: cost-watch

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    env:
      FLY_METRICS_TOKEN: ${{ secrets.FLY_METRICS_TOKEN }}
      GH_TOKEN: ${{ github.token }}
      GH_REPO: ${{ github.repository }}
      PROMETHEUS_QUERY_URL: https://api.fly.io/prometheus/personal/api/v1/query
      CORE_APP: checkout-surge-core
      RUNNER_APP: checkout-surge-runner
      CORE_MAX_SECONDS: "21600" # 6 h
      RUNNER_MAX_SECONDS: "3600" # 60 min
    steps:
      - name: Check awake time
        run: |
          set -euo pipefail

          # Seconds the app's Machines ran over the last 24 hours. Any query error fails the job.
          awake_seconds() {
            printf 'Authorization: %s\n' "$FLY_METRICS_TOKEN" \
              | curl -fsS --max-time 30 -H @- "$PROMETHEUS_QUERY_URL" \
                  --data-urlencode "query=sum(count_over_time(fly_instance_up{app=\"$1\"}[24h])) * 15 or vector(0)" \
              | jq -er '.data.result[0].value[1] | tonumber | floor'
          }

          core=$(awake_seconds "$CORE_APP")
          runner=$(awake_seconds "$RUNNER_APP")
          message="Last 24 h: core awake $((core / 60)) min (limit $((CORE_MAX_SECONDS / 60))), runner running $((runner / 60)) min (limit $((RUNNER_MAX_SECONDS / 60)))."
          echo "$message"

          if (( core <= CORE_MAX_SECONDS && runner <= RUNNER_MAX_SECONDS )); then
            exit 0
          fi

          gh label create cost-alert --force --color B60205 --description "Hosted demo awake time over its limit"
          issue=$(gh issue list --label cost-alert --state open --limit 1 --json number --jq '.[0].number // empty')
          if [ -n "$issue" ]; then
            gh issue comment "$issue" --body "$message"
          else
            gh issue create --title "Hosted demo awake time over its limit" --label cost-alert --body "$message"
          fi
          echo "::error::$message"
          exit 1
```

It uses no third-party action: `curl`, `jq` and the GitHub CLI are preinstalled on GitHub's runners. Test it with **Run workflow** and a temporarily low limit.
