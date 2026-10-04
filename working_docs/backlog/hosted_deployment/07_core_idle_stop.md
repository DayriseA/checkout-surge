# 07 — Core Idle Stop

**Design:** sections 1.3, 3.4, 7.2 · **Depends on:** 01

## Goal

The core goes to sleep on its own after 10 minutes without activity, and visitors see it coming.

## Scope

- **Idle-shutdown owner in the API:**
  - it tracks counted activity and owns the deadline;
  - it never stops the core while a run is nonterminal;
  - it stops its own Machine through the Machines API.
- **Off unless configured:** the local topology has no idle stop and shows no countdown (design section 1.3).
- **Endpoints:** a lightweight status endpoint and a "stay awake" action.
- **Countdown widget** on every page, including the run-in-progress state and the alert during the last 2 minutes.
- **"Demo paused" state** for a page left open on a stopped core.
- **Token:** the API's Machines API token for the core app.

## Out of Scope

- The guard's 3-hour cap (task 11) and the gate pages (task 09).

## Done When

- On Fly, an idle core stops about 10 minutes after the last counted request.
- It never stops during a nonterminal run.
- Healthchecks, widget polling and open SSE connections do not extend the deadline.
- "Stay awake" resets the deadline for every visitor.

## Open Points

- None.

## Working Notes

Work done on 2026-10-04, flyctl v0.4.111, org `personal`, region `cdg`, on branch `hosted/07-core-idle-stop` (from `dev` at `916960ec`). Nothing is committed.

### What was built

- **Contracts (`packages/contracts/src/core-idle.ts`).** `GET /core/idle-status` and `POST /core/activity`; `coreIdleStatusSchema` is `disabled`, `run_in_progress`, or `awake` with `sleepsInSeconds` (relative, so client clocks do not matter).
- **Idle-shutdown owner (`apps/api/src/services/core-idle-stop.ts`).** `CoreIdleShutdown` with two implementations chosen in `apps/api/src/index.ts`:
  - `disabledCoreIdleShutdown` (local): status `disabled`, activity and checks do nothing.
  - `CoreIdleStop` (Fly): holds the last activity time in memory (starting at API boot) and the run state from the latest check. The check runs on the existing 5 s finalization poll: it reads whether a `starting`, `active` or `draining` run exists; if so it counts that as activity and returns; otherwise, after 10 minutes without activity, it logs "No counted activity for 10 minutes; stopping the core Machine." and calls Fly `stop` on its own Machine (`FLY_APP_NAME`, `FLY_MACHINE_ID`). A check in progress is joined, not repeated. The status endpoint stays in memory (no database read).
- **Routes (`apps/api/src/routes/core-idle-routes.ts`).** The status route only reads; the activity route records activity and answers the new status. No authentication: through Caddy, only `/dashboard/events` reaches the API directly.
- **Counting (`apps/web/src/proxy.ts`, Next.js 16 Proxy, formerly Middleware).** Every visitor request except SSE goes through the web server, including pages that never call the API (the overview `/`, 404). The proxy reports each request to `POST /core/activity` in the background (`waitUntil`, errors swallowed) except `/health`, `/api/health/ready`, `/api/core/idle-status`, `/api/dashboard/recovery` and `/dashboard/events`; static assets are outside its matcher. The proxy reads `API_BASE_URL` from `process.env`, because Next documents that Proxy must not rely on shared modules or globals (the web server config lives in a global set by instrumentation). Requests made straight to the API (runner traffic, operator calls on port 4000, the API's own healthcheck) are never counted.
- **Widget (`apps/web/src/app/components/core-idle-countdown.tsx`),** in the root layout under the header, so it is on every page. It polls `/api/core/idle-status` every 30 s and counts down locally every second. States: awake ("The system is awake and will sleep after m:ss without activity.", "Stay awake" button, amber alert with "Going to sleep soon." at 2:00 or less), run in progress ("Run in progress, the system stays awake."), Demo paused ("The system went to sleep after a period without activity.", plain link to `/`, so the gate will get a full page load). `disabled` hides it and stops polling. A failed read shows "Demo paused" only after the core has been seen awake on that page, so a local API outage never shows it; polling continues, so the page recovers on its own when the core is woken again.
- **Web routes.** `GET /api/core/idle-status` and `POST /api/core/activity` (the stay-awake button) proxy to the API with the shared contract.
- **Config.** `CORE_IDLE_STOP_ENABLED` (`true`/`false`, default off) requires `CORE_FLY_API_TOKEN`, `FLY_APP_NAME` and `FLY_MACHINE_ID`. The idle time (10 minutes) is a constant, not configuration.
- **Infra.** Core `machine.json`: the API container gets `CORE_IDLE_STOP_ENABLED=true` and the `CORE_FLY_API_TOKEN` secret. No deploy script change.

### Minor choices

- **Own Machine by ID.** The API stops `FLY_MACHINE_ID` rather than looking up `role=core`. Design 3.6's metadata rule is for external callers; the API's own ID is exact even if two core Machines briefly exist during a recovery.
- **No lease.** The stop is sent without a lease, as design 7.2 lists no lease for this use. A stop blocks while another client holds the core lease (task 01 measurement); the client's 30 s timeout bounds it, and the next check retries.
- **Accepted race.** A run admitted between the idle decision and Fly's SIGINT is interrupted. The window measured about 170 ms on Fly, and can reach 30 s (the Machines client timeout) while another client holds the core lease, today only a deploy. Starts through the web are not protected inside it: the proxy's activity report is not guaranteed to reach the API first, and activity recorded after the decision cannot cancel it. The interrupted run is reconciled on the next wake (starting-run reconciliation or the runner-loss monitor). Closing it would mean running the check under the maintenance authority plus a permanent "stop committed" latch read by run starts; rejected after the task 07 review as disproportionate (coupling, and starts or resets blocked behind a stop that can hang).
- **Known limitation: short uncounted runs.** The end of a run is counted only when a 5 s poll sees it nonterminal. A run started straight on the API (operator, through `fly proxy` and the control token) that ends before the next poll is never counted, so an otherwise idle core can stop up to 10 minutes earlier than the rule says. Web starts are counted by the proxy, and no run is ever cut off by this. Accepted after the task 07 review.
- **Static assets and prefetches.** Assets under `/_next/static` are not reported (the page request already is). Link prefetches are reported; on Fly, an open page triggered none after its initial load (see below).

### Fly state

- Secret `CORE_FLY_API_TOKEN`: a deploy token for `checkout-surge-core` (`flyctl tokens create deploy -a checkout-surge-core -n core-idle-stop`), staged on the core app and given only to the API container; local copy appended to the gitignored `infra/fly/core/core-secrets.env`.
- Both apps deployed from this tree (version `916960ec…-dirty`, Depot remote builds, no build issue). Core Machine `8d14e3aee13038`, runner `8d3327ce259918`.
- **`FLY_APP_NAME` and `FLY_MACHINE_ID` are set in the API container** of the multi-container Machine (the API starts with both required).

### Done-when checks on Fly (2026-10-04, 00:37 to 01:18 UTC)

Through `fly proxy 8080` (Caddy) and `fly proxy 4000` (API, used to read the status without counting). The browser pane kept `/demo` open throughout: it polls `/api/dashboard/recovery` every 15 s, `/api/health/ready` every 60 s and the widget status every 30 s. Fly's container healthchecks ran all along.

**Session 1: idle stop, uncounted traffic, stay awake.**

| Time (UTC) | Event | Status |
| :-- | :-- | :-- |
| 00:37:01.7 | `fly machine start` | |
| 00:39:01 | first status read | awake, 489 s (countdown from API boot) |
| ~00:39:12 | `/demo` opened in the browser | reset to about 600 s |
| 00:39:40 to 00:43:14 | page open, `curl -N /dashboard/events` open (SSE), all polling and healthchecks running | deadline fixed at about 00:49:19 (578 → 365 s, 10 s per 10 s) |
| 00:43:22.99 | `POST /api/core/activity` (stay awake) | 600 s |
| 00:51:3x | widget shows the amber "Going to sleep soon" state | 1:43 left |
| 00:53:23.71 | API log: "No counted activity for 10 minutes", `idleSeconds: 601` | |
| 00:53:23.88 | Fly event `stop` (source user) | |
| 00:53:34.81 | Fly event `exit`, `requested_stop=true`, exit 0; Machine `stopped` | |
| after the stop | the open page shows "Demo paused." with "Back to the start page" | |

- **Idle stop: pass.** 600.7 s from the stay-awake request to the stop request; the Machine was `stopped` 11.8 s after the last counted request plus 600 s (the known delayed stop of PostgreSQL and Redis).
- **Healthchecks, widget polling, the page's recovery and readiness polling, and an open SSE connection did not extend the deadline: pass** (fixed deadline for 4 minutes, then for 10 minutes after the stay-awake request). The SSE stream was closed by the stop (`curl` exited at 00:53:24).
- **Stay awake resets the deadline: pass** (600 s right after the request, and the stop followed it by 600.7 s). The deadline is in the API, so it is the same for every visitor.
- **Page load counts: pass.** Opening `/demo` reset the countdown, which proves the proxy reports page requests on Fly (`process.env.API_BASE_URL` read at runtime).

**Session 2: no stop during a nonterminal run.**

| Time (UTC) | Event | Status |
| :-- | :-- | :-- |
| 00:55:18 | `fly machine start`; the open page went from "Demo paused" back to the countdown on its next poll | awake, 597 s at 00:55:28 |
| 01:04:20.6 | run `ec555696…` started straight on the API (port 4000, admin mode, control token, so not counted): preview-1k, constant arrival 5 req/s for 150 s | awake, 74 s at 01:04:12 |
| 01:04:22 | | run_in_progress |
| ~01:05:26 | idle deadline passes | run_in_progress, Machine `started` |
| 01:06:58.8 | run finalized `completed` (traffic ended 01:06:58.7); runner stopped | |
| 01:07:06 | | awake, 590 s (countdown restarted from the last check that saw the run) |

- **No stop during a nonterminal run: pass.** The idle deadline passed 1.5 minutes into the run; the core stayed up, and the widget showed "Run in progress, the system stays awake."
- **Countdown after the run:** restarted from 10 minutes when the run ended (see open decision 2).
- **Stop after the run: pass.** A run-history read through the web at about 01:07:08 counted as activity (status 593 s at 01:07:15). The API logged the idle stop at 01:17:10.25 (`idleSeconds: 603`, within the 5 s check interval); Fly recorded `stop` at 01:17:10.30 and `stopped` (exit 0, `requested_stop=true`) at 01:17:21.31.

### Validation (workstation)

- `pnpm exec biome check --write` on every touched file: clean.
- Type-check: `contracts` (build), `api` and `web` pass. `pnpm type-check` fails only in `mock-erp`: `Cannot find module '@checkout-surge/db'`, because `apps/mock-erp/node_modules/@checkout-surge/db` is missing in the local install (pre-existing; `pnpm install --offline` wanted to purge `node_modules`, which was not done).
- Unit tests: `api` 312/312 (new `core-idle-stop.test.ts`, config test), `web` 747/747 (new `core-idle-countdown.test.tsx`, `core-activity-proxy.test.ts`), `contracts` 160/160.
- Not run here (need Docker PostgreSQL/Redis): `apps/api/test/api.test.ts`, which only gained the `coreIdleShutdown` dependency. `PostgresNonterminalRunReader` has no database test; it was exercised on Fly (session 2).

### Open decisions

1. **Dashboard recovery polling is not counted.** The public demo page polls `/api/dashboard/recovery` every 15 s (`public-demo-entry.tsx`). Design 3.4 does not list it under "Not counted", but counting it would keep the core awake as long as any `/demo` tab stays open, and the "Demo paused" state could never happen there. Implemented as not counted (one entry in the proxy's list).
2. **A nonterminal run counts as activity.** Design 3.4 says the core stops after "no nonterminal run, and no counted activity for 10 minutes". Read literally, a run longer than the idle time watched only through SSE would let the core stop right after the run ends, while the visitor reads the result. Implemented: the countdown restarts at 10 minutes when the run ends.

### Inputs for later tasks

- **Task 09.** The gate's readiness probes must use an uncounted path: Caddy `/health` (served by web `/health`) or the API's `/health/ready`. Any other path through Caddy counts as activity. The "Demo paused" link is `/`, a full page load the gate can answer with its own page. `WEB_ORIGIN` does not matter to these routes. On a stopped core, the gate's HTML answer to `/api/core/idle-status` reads as a failure, so the widget shows "Demo paused".
- **Task 09.** While the core is stopped, the existing `/demo` page also shows its own "The demo backend isn't ready yet" notices next to "Demo paused".
- **Task 11.** The guard's 3-hour cap stays the backstop for an idle stop that fails (for example a revoked `CORE_FLY_API_TOKEN`: the check logs "Core idle stop check failed." every 5 s).
- **Rotation (7.2).** `CORE_FLY_API_TOKEN` is the core secret holding the core-app deploy token, given only to the API container.

### Cloud verification and review (2026-10-04)

- A cloud agent ran the full suite on a clean install of the validation branch: type-check (mock-erp included), lint, 1,643 unit tests, 345 API tests, and the integration tests all pass. A local Compose run (after the usual `runtime:setup` on a fresh database) returned `{"state":"disabled"}` from `/api/core/idle-status`, showed no widget, and completed a `/demo` run normally.
- An external review from another model family raised four findings, which were verified against the code and arbitrated:
  - the start/stop race: kept as an accepted risk, with its wording corrected above;
  - uncounted run ends: recorded above as a known limitation;
  - a trailing slash in `API_BASE_URL` made the proxy call `//core/activity` and silently stop counting: fixed by stripping trailing slashes, as the web configuration does;
  - a stale status response could briefly overwrite the widget after "stay awake": accepted, display only and corrected by the next poll.
