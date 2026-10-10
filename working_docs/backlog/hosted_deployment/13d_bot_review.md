# 13d — Bot Review

**Design:** section 2.5 · **Depends on:** 13c, plus a few days of real traffic

## Goal

The effect of real traffic is checked, and the bot decision is taken and recorded.

## Scope

- **Bot review:** check the gate logs and Fly metrics, then decide on the signed session cookie (design 2.5).
- **Guard:** check its logs (`component: guard`) and exit codes, the only signal of a failed run (input from task 11).
- **Per-container secrets:** Fly's multi-container documentation says app secrets reach every container, while `docs/hosted_runtime.md` says each core container gets only the secrets its config lists. Check on the live core by listing the environment variable names (never values) in a container that should not hold, for example, `DATABASE_URL` or `CORE_FLY_API_TOKEN` (Caddy, Mock ERP), then correct the docs or the config.
- **Runner start-wait errors:** revisit retrying them if they appear in logs (task 06 review).
- **Runner start retries** (owner decision, 2026-10-08). Search the core logs for "The runner Machine did not start." with `failure: "still_active"`. For each one, record how many 1 s retries it took and whether the start then succeeded. The live path was never reproduced on demand.
- **Redis growth** (owner decision, 2026-10-08). Completed order-process jobs stay in Redis: the order queue has no `removeOnComplete`, and only a run teardown (`DELETE /admin/demo/runs/:runId`) or the old-run retention cleanup removes them. A public run can leave up to 1,000 jobs, and Redis persists to the 3 GB volume (append-only file).
  - Check Redis memory and the volume's use.
  - Check whether the retention cleanup runs on its own or only on demand.
  - Then decide whether job retention needs a fix.

## Out of Scope

- Everything listed as out of scope in `design.md`.

## Done When

- The bot review is done and its outcome recorded.

## Open Points

- None.

## Working Notes

### Review (2026-10-10)

- **Bots (owner decision).** Bots cannot wake the core: only the start form wakes it. Once a visitor has woken it, bot requests can extend the awake time, but the guard's 3-hour cap bounds that, and the cost alerts would flag it.
  - Over the last days the owner woke the core and let it sleep on its own dozens of times. It always slept, and was never held awake.
  - **No signed session cookie.**
  - **No indexing:** the gate answers `/robots.txt` itself with `Disallow: /`, whatever the core's state (`f2cadda9`), because the owner's portfolio links to the demo.
  - The gate logs requests (path and status, no user agent or client address). `flyctl logs --no-tail` returns only the last 100 lines, so a longer review would need the Fly dashboard.
- **Guard.** Its run after the last deploy exited 0, with no OOM. Earlier events are cleared by each deploy.
- **Per-container secrets.** Checked live by listing variable names only. Each core container holds exactly the secrets its config lists:
  - Caddy: none;
  - Mock ERP: `DATABASE_URL`;
  - worker: `DATABASE_URL` and `REDIS_URL`;
  - web: the admin, session, control and cookie secrets.

  Fly honours the per-container `secrets` list, so `docs/hosted_runtime.md` is right and nothing changes.
- **Runner start-wait errors and `still_active` retries.** Not observed: the logs available hold only the last 100 lines. The retries are bounded in code (task 19). No change.
- **Redis growth.** Measured live: 10.8 MB, 3,763 keys, 2,701 completed order jobs, an AOF of 37 MB, and the volume 6 % used (Redis 37 MB, PostgreSQL 140 MB).
  - Completed order jobs and each run's inventory namespace outlive the run for no use. History reads PostgreSQL only.
  - The retention cleanup runs only on demand.
  - Owner decision: clean a run's Redis working state when it is finalized (task 22).
- Done.
