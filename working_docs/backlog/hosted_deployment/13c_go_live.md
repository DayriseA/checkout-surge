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
- **Open the demo:** the portfolio link to the gate (added by the owner).

## Out of Scope

- Bot review (13d).

## Done When

- The demo is reachable from the portfolio link, with rotated secrets, deployed by GitHub Actions.

## Open Points

- None.

## Working Notes

_None yet._
