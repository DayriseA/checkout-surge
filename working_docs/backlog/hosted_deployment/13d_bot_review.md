# 13d — Bot Review

**Design:** section 2.5 · **Depends on:** 13c, plus a few days of real traffic

## Goal

The effect of real traffic is checked, and the bot decision is taken and recorded.

## Scope

- **Bot review:** check the gate logs and Fly metrics, then decide on the signed session cookie (design 2.5).
- **Guard:** check its logs (`component: guard`) and exit codes, the only signal of a failed run (input from task 11).
- **Per-container secrets:** Fly's multi-container documentation says app secrets reach every container, while `docs/hosted_runtime.md` says each core container gets only the secrets its config lists. Check on the live core by listing the environment variable names (never values) in a container that should not hold, for example, `DATABASE_URL` or `CORE_FLY_API_TOKEN` (Caddy, Mock ERP), then correct the docs or the config.
- **Runner start-wait errors:** revisit retrying them if they appear in logs (task 06 review).

## Out of Scope

- Everything listed as out of scope in `design.md`.

## Done When

- The bot review is done and its outcome recorded.

## Open Points

- None.

## Working Notes

_None yet._
