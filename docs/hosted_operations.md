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

The script compares the core's and the runner's versions at the end, even after a failed step.

| Message | Meaning and action |
| :-- | :-- |
| `The lease of Machine … is held; re-run the deploy.` | A wake, a recovery, the guard or a runner operation holds the lease. Re-run a little later. |
| `core Machine … is <state>; re-run, or use --force.` | A visitor woke the core between the wait and the lease. Re-run. |
| `runner Machine … is <state>; re-run, or use --force.` | A run is in progress. Re-run after it. |
| `Partial deployment: …` | The core and the runner run different commits, so every run is refused. Re-run `all`. On a new set of apps, the first gate-only deploy ends with `Partial deployment: … undefined` (exit 1), as expected: continue with `all`. |
| `Expected at most one <role> Machine, found …` | Two Machines carry the same role. For the core or the runner, a recovery is in progress or left one behind: re-run once it ends or the guard has cleaned up. For the gate or the guard, remove the extra Machine by hand. |
| `Deploy the gate first …`, `No runner Machine with a full config …` | A new set of apps: see [one-time setup](#one-time-setup). |

### Incompatible changes

A change that the existing core data cannot use, such as a rewritten database baseline, needs a fresh, empty core ([HD-48](decisions/hosted_deployment.md#hd-48-a-requested-fresh-core-stays-requested-until-a-wake-acts-on-it)):

1. Before merging, deploy the commit from the workstation with `node infra/fly/deploy.mjs all --fresh-core`. The core is marked `recreate=requested`, and the next visitor wake recreates it through the recovery path.
2. Merge into `main`. The CI deploy carries the mark over when no wake happened meanwhile, or finds a core that is already fresh.

If an incompatible change reached `main` without the mark, stop the core if it is awake (`flyctl machine stop <core id> -a checkout-surge-core`), then [set the mark by hand](#recreation-mark). The next wake recreates the core.

### Recreation mark

The mark lives in the core Machine's metadata. Change it while no deploy runs, since a deploy carries over the mark it finds. These commands send the operator's flyctl token in a header read from standard input, so the token never appears on a command line.

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

- **Check it:** `flyctl machine status <core id> -a checkout-surge-core -d` shows `"recreate": "requested"` under `metadata` while the mark is set.

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
| `RUNNER_FLY_API_TOKEN` | core (API) | runner | `core api runner operations` |
| `CORE_FLY_API_TOKEN` | core (API) | core | `core-idle-stop` |
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

---

## Resizing and Limits

- **Core.** Change `guest` in `infra/fly/core/machine.json` and deploy. The deploy updates the sleeping core, and a later recovery places the new core on a host that fits that size. Do not resize with `flyctl machine update --vm-size`: the next deploy sends the file again and reverts it. The core is pinned to its volume's host, so a host that cannot fit the new size makes Fly refuse the update or the next start. A refused update fails the deploy (a partial deployment for `all`): revert the size and deploy again. A refused start makes the gate recover the core on another host, fresh and empty.
- **Runner.** Set `RUNNER_CPU_KIND`, `RUNNER_CPUS` and `RUNNER_MEMORY_MB` in the API container of `infra/fly/core/machine.json`, make `guest` in `infra/fly/runner/machine.json` match, and deploy `all`. The API applies the size before the next run; the runner has no volume, so its resize is safe.
- **Run limits.** The `DEMO_MAX_*` deployment caps are API variables in the same container. The API refuses to start when the active public runtime policy exceeds one of them.
  - A fresh core (a recovery, or `--fresh-core`) seeds that policy from the `setup` container's `PUBLIC_CUSTOM_*` variables and from fixed seed values (`buildPublicRuntimePolicy` in `packages/db/src/scripts/seed.ts`). Lower the matching `PUBLIC_CUSTOM_*` variable in the `setup` container together with a cap, and never set a cap below a fixed seed value.
  - On the running core, the seed keeps the existing policy: lower it in the admin console before deploying lower caps.
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
- **No alerting.** These logs and the guard Machine's exits are the only signal of a failed guard run. Check them after rotating a token the guard holds, and when reviewing the demo's traffic.
- **Switches,** for demonstrations only, in the guard Machine's env: `GUARD_DRY_RUN=true` logs the plan without acting; `GUARD_CORE_MAX_AWAKE_SECONDS`, `GUARD_CORE_STARTUP_GRACE_SECONDS`, `GUARD_RUNNER_MAX_STARTED_SECONDS` and `GUARD_LEFTOVER_GRACE_SECONDS` override the thresholds. Set them in `infra/fly/gate/guard-machine.json` and deploy the gate from the workstation; the next deploy of `main` resets them.
- **Never change the guard with `flyctl machine update --skip-start`.** A guard updated with `skip_launch` is never started by Fly's scheduler again ([HD-41](decisions/hosted_deployment.md#hd-41-the-guard-is-deployed-without-skip_launch)).
