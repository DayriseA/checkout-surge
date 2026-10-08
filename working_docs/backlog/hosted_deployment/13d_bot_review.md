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

_None yet._
