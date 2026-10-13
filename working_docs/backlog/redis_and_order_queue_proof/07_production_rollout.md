# 07 — Production Rollout

**Design:** sections 3, 3.1, 6 · **Depends on:** 06

## Goal

The project reaches production after the owner's review, without downtime for visitors.

## Scope

- The owner reviews the project in the proof environment.
- The merges into `dev`, then `main`, are done by the owner or with the owner's approval.
- Deploy production and check it live: both comparison presets complete and show their point on the production hardware, and ordinary runs behave as before.
- Destroy the proof environment, or keep it stopped, as the owner decides.
- Delete `tmp/21-baseline-prototype`, and decide the fate of the archived branch `codex/redis-order-queue-feasibility`.

## Done When

- Production runs the comparisons, and the proof environment is cleaned up.

## Open Points

- None.

## Working Notes

### Rollout runbook (proposed)

Prepared read-only on 2026-10-13 from `git diff origin/main...HEAD`. `origin/main` (`dcb3941f`) is an ancestor of `origin/dev` (3 docs commits ahead), which is an ancestor of this branch, so every merge can fast-forward. Every step that touches Fly.io, GitHub or a shared branch is the owner's, or needs the owner's yes.

**1. What changes in production.**
- **Core Machine** (`infra/fly/core/machine.json`; `guest` unchanged: 6 performance vCPUs, 12 GB, so the cost per awake hour is unchanged and no new Machine or app):
  - New `api-buy` container (API image, `dist/buy-server.js`, 2 processes on port 4001, `on-failure` restart, `/health/live` check). Secrets: `DATABASE_URL` and `REDIS_URL` only, which the core app already holds. Idle: about 3 Node processes and 4 Redis connections; during a Redis comparison: up to about 2 cores and 20 more PostgreSQL connections (HD-63).
  - API container: new env `API_BUY_POOL_PORT=4001` (not a secret).
  - PostgreSQL: `shared_preload_libraries=pg_prewarm`, `pg_prewarm.autoprewarm=on`. A tiny `autoprewarm.blocks` file on the volume, written every 300 s and at the clean stop.
- **Schema.** `0000_baseline.sql` is amended in place (2 enums, 3 `demo_runs` columns, `demo_presets.comparison`, `reservations.idempotency_key` with a partial unique index, tables `postgres_run_stock` and `postgres_order_queue`), with the journal's `when` unchanged. On the current production volume, drizzle sees the baseline as applied and runs nothing, so the seed (which writes `comparison`) and the new code would fail. **A fresh core is mandatory** (HD-05, HD-48), and it wipes the hosted run history, admin edits and the live public runtime policy (reseeded from the `setup` env).
- **Secrets: nothing to stage.** No new secret; the pool deliberately receives neither `CONTROL_SERVICE_TOKEN` nor `PUBLIC_CLIENT_COOKIE_SECRET` (it fills throwaway values). `FLY_API_TOKEN` (CI) was created around 2026-10-06 for one year.
- **Images.** Core: API (comparisons, PostgreSQL stock mode, store load, recovery grace of 10 s before a fresh Redis hold is due), worker (PostgreSQL order queue; the dispatch scanner republishes only orders whose job is missing), web (restructured site, comparison panels), setup (baseline, two public presets). Runner: k6 script records per-outcome waits and `200 order_confirmed`. Gate: one sentence on the sleeping page.
- **Ordinary runs** keep one API process and the `CAPACITY_*` values. They do see the recovery grace and the scanner fix (both reduce work) and the new k6 fields.
- **Deploy tooling.** `deploy.mjs` now loads `environment.mjs`; without `--environment` it targets production with no organization check. This rollout is the first production use of the edited script.

**2. Sequence.**

0. **Release candidate (agent, then owner).** Task 06 closed after checkpoint D2, the tree committed and pushed. Full suite on the final commit: `infra/fly/test-runner/run.sh claude/redis-queue-comparisons`. Deploy it to the proof environment (`node infra/fly/proof.mjs deploy`, no fresh core needed there) and the owner reviews it at `https://cs-proof-gate.fly.dev`.
1. **Branch → `dev` (owner merges).** `gh pr create --base dev --head claude/redis-queue-comparisons`. Any merge method; a push to `dev` deploys nothing.
2. **PR `dev` → `main` for review only (owner).** `gh pr create --base main --head dev`. Do not press merge yet: `main` must move only after step 3.
3. **Fresh-core deploy from the workstation (owner, at a quiet time).** From a clean worktree, since the shared tree may hold another agent's edits and a dirty tree deploys a `-dirty` version:
   ```bash
   git fetch origin && git worktree add ../cs-release origin/dev && cd ../cs-release
   gh run list --workflow deploy.yml --limit 3     # nothing queued or in progress
   node infra/fly/deploy.mjs all --fresh-core      # no --force: it waits for an awake core to sleep
   ```
   Expect `The next wake recreates the core fresh and empty` and `The core and the runner both run version <sha>`. `flyctl machine status <core id> -a checkout-surge-core -d` shows `"recreate": "requested"`.
4. **Land `main` (owner):** `git push origin <sha>:main`, the commit deployed in step 3, as a fast-forward (GitHub then marks the PR merged). A merge commit also works: CI carries the mark over, or meets a core already fresh. Nobody else pushes to `main` between steps 3 and 5.
5. **CI deploy.** `deploy.yml` runs `node infra/fly/deploy.mjs all` (runner, core, gate) without `--force` and cannot request a fresh core; that is why step 3 comes first (HD-49). It leaves the runner untouched (same config), rewrites the core config with the mark carried over, and updates the gate. Follow it with `gh run watch`, and wake nothing until it ends.

**Visitors meanwhile.** The old demo keeps working until a deploy acts: each deploy waits for the core to sleep. While a deploy holds the core lease (a few minutes), a wake shows the "updating" page with a retry button. The first wake after step 3 shows the fresh-install page, typically under a minute (longer with the new image pulls), then the new demo with an empty history. No other downtime.

**3. Verification in production (owner, or the agent with the owner's yes).**
- Wake at `https://checkout-surge-gate.fly.dev`. `flyctl machine list -a checkout-surge-core` shows one new core without the mark, and `flyctl volumes list -a checkout-surge-core` one new volume. `COMMIT_SHA` matches on the core's API container and the runner. Every container is healthy, `api-buy` included, and the core's logs (`flyctl logs -a checkout-surge-core --no-tail`) show no repeated buy-process exits.
- **As a visitor** (3 of the 30 daily global starts): one ordinary preset (Surge 10k: completes, p95 in the hosted "about 8 to 14 s"), then each comparison. Check for each: both runs complete, Watch follows run 2 with its Comparison tab, both run reports show the panel with its takeaway, and history lists both runs with their mode.
- **Figures** (ranges from tasks 03 and 04):
  - Queue: 500/500 orders confirmed in both runs; every buyer answered within about 4.7–5.4 s with the queue against 27–28.5 s without; ERP about 17–18.5/s.
  - Redis, first comparison after a wake (cold): transactions about 4.4–4.7k against 11.2–12.7k; turned-away wait 6.3–6.4 s against 7.4–11.9 s; every buyer answered 8.9–9.4 s against 9.8–14.0 s; winners about equal.
- **Idle stop and `pg_prewarm`.** Close every tab: the core stops after the idle period. The first boot had no block list, as expected. Wake again: the logs show `autoprewarm successfully prewarmed N of N previously-loaded blocks`. Then close the tabs again, and check that the next guard run is clean (`flyctl logs -a checkout-surge-gate`).
- **Home figures** (`apps/web/src/app/lib/presentation/measured-figures.ts`). The owner decided at D1 to refresh them after this deploy. If production falls inside the ranges above, the proof figures stay true ("on a copy of this demo", same Machines and sizes). If they fall outside, run the task 03/04 series on production (admin starts, `scripts/capacity-measurement.mjs` in the API container; about an hour of core time for the 4 cold Redis pairs) and update the file with its method sentence. That change goes branch → `dev` → `main`, and its CI deploy needs no fresh core (no schema change); it waits for the core to sleep.

**4. Rollback.**
- **Triggers:** the fresh core ends on the setup-failure page, or never becomes healthy, after one retry wake; an ordinary run fails, or the partial-deployment message persists after a re-run; a comparison fails twice (failed run or unexpected answers); `api-buy` crash-loops and disturbs the core; the idle stop does not happen. Figures outside the ranges alone are not a trigger: investigate, or refresh the figures.
- **It needs a fresh core too.** The old code finds the new baseline already applied, so it would run on new-schema data, and the two comparison presets would remain public as plain presets.
- **Steps (owner):** `git worktree add ../cs-rollback dcb3941f`, then from it `node infra/fly/deploy.mjs all --fresh-core` (add `--force` only if visitors may lose a session). Then land a revert on `main` promptly: `git revert` of the merged range on a branch, PR → `dev` → `main`. Until the revert lands, a push of the new code to `main` would put it on old-schema data without a mark. History is wiped again.

**5. Cleanup after success (owner's choice).**
- **Proof environment:** `node infra/fly/proof.mjs destroy` removes the apps, volume, tokens and `infra/fly/proof-core.env`. Kept stopped, it costs its 3 GB volume and the hourly guard. *Recommendation:* destroy it; `create` rebuilds it in one command when needed.
- **`cs-test-runner`:** about $3/month for its 20 GB volume while stopped, and the documented path for heavy suites (never on the owner's Windows host). *Recommendation:* keep it stopped.
- **`codex/redis-order-queue-feasibility`:** *recommendation:* tag it (`git tag archive/redis-order-queue-feasibility origin/codex/redis-order-queue-feasibility && git push origin --tags`), then delete the branch; `review_2026-10-12.md` holds its lessons. Also decide on `codex/redis_and_order_queue`, which is on the remote too.
- **`tmp/21-baseline-prototype`:** delete it (`git push origin --delete tmp/21-baseline-prototype`).
- **This branch:** delete it locally and remotely after `main` contains it, and remove the `../cs-release` worktree.

**6. Risks and open questions.**
- **History wipe (HD-05).** It is expected and cosmetic. *Recommendation:* deploy at a quiet time; there is nothing to save.
- **The release candidate is not final yet** (task 06 is open, and web edits continue). *Recommendation:* freeze it, run the full suite and redeploy it to the proof environment (step 0) before step 1.
- **First production run of the edited `deploy.mjs`.** Its production path is unchanged by design and tested, but unproven on `personal`. *Recommendation:* run step 3 from the workstation, never first from CI, and read its log. The documented failure table in `docs/hosted_operations.md` applies.
- **Production host differs from the proof host** (figures, or a full host). A full host marks the core for recreation anyway (HD-56), which this rollout wants. *Recommendation:* judge figures against the ranges, not the medians.
- **Merge method for `dev` → `main`.** *Recommendation:* fast-forward to the commit deployed in step 3, so the hosted version is exactly `main`.
- **Measured figures.** Is a production measurement series worth about an hour of core time when production matches the proof ranges? *Recommendation:* refresh only if production falls outside them.
- **Flyctl version.** CI pins 0.4.111. *Recommendation:* check `flyctl version` on the workstation before step 3 and use the same version.

### Rollout result (2026-10-13)

Owner's go given on 2026-10-13; the owner chose not to refresh the measured figures unless production fell outside the ranges.

- **Merges.** PR #8 (branch into `dev`, merge commit `f17e0998`) and PR #9 (`dev` into `main`, closed by fast-forwarding `main` to `f17e0998`).
- **Deploy.** The owner ran `node infra/fly/deploy.mjs all --fresh-core` from a clean worktree of `origin/dev` (flyctl 0.4.111, as in CI): runner, core, gate and guard at `f17e0998`, the core marked for recreation. The CI deploy on the push to `main` succeeded and kept the mark. The first wake installed a fresh core in about a minute.
- **Verification as a visitor, on the fresh (cold) core:**
  - Redis comparison: 500 / 9,500 in both runs; without Redis, PostgreSQL transactions ×3.5, CPU ×2.4, time in queries ×7.1, turned-away wait ×1.6, every buyer answered ×1.3, winners ×0.8. Within the task 04 ranges. Watch moved from run 1 to run 2 and opened the Comparison tab.
  - Queue comparison: every buyer answered within 5.3 s against 27.9 s, winners' p95 3.5 s against 26.6 s, 500 of 500 orders confirmed in both runs at about 18 per second. Within the task 03 ranges. The home page's figures stay.
  - Surge 10k: 500 of 500 confirmed, none oversold, converged in 26.9 s.
  - Idle stop: the core stopped by itself about ten minutes after the last run. The next wake started normally. The core's config carries `shared_preload_libraries=pg_prewarm` with autoprewarm and the `api-buy` container; the startup "prewarmed" line was out of reach of Fly's 100-line log buffer, and was verified on the proof environment with the same config.
- **Cleanup.** The proof environment (`cs-proof-*`) is destroyed. `cs-test-runner` stays stopped in `playground-416` for future work (about $3/month for its volume). The branches `claude/redis-queue-comparisons`, `codex/redis-order-queue-feasibility`, `codex/redis_and_order_queue` and `tmp/21-baseline-prototype` are deleted, without a tag (owner).
