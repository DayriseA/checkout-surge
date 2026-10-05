# 09 — Gate

**Design:** sections 2.1, 2.2, 2.3, 2.4, 3.6, 7.2 · **Depends on:** 01, 07

## Goal

The gate is the only public address. It serves its own pages while the core is not ready, wakes the core on a deliberate visitor action, and relays everything once the core is ready.

## Scope

- **New gate app:** one TypeScript program in `apps/gate`, relaying through a proven proxy library, on a small Machine with Fly Proxy autostart and autostop, and the public `<gate-app>.fly.dev` address.
- **Authoritative core lookup** through the app name and the `role=core` metadata.
- **Pages:** stopped, booting, updating and setup failure, served for any URL.
- **Wake:** a POST from the start button, under a Fly lease on the core Machine.
- **Relay** of pages, API and SSE to the core's Caddy, targeting the Machine ID over 6PN.
- **Visitor IP trust chain:**
  - the gate uses `Fly-Client-IP` only and overwrites client-supplied forwarding headers;
  - the core's Caddy trusts only the gate's private address.
- **Token:** the gate's Machines API token for the core app.
- **Deploy script** extended to the gate image and Machine.

## Out of Scope

- Recovery, and the relocating and no-capacity pages (task 10).
- The guard (task 11).
- The session cookie against bots (task 13, conditional on evidence).

## Done When

- From the public URL: the start button leads to the booting page, then to the demo.
- A deep URL on a stopped core shows the gate page.
- The live dashboard works through the gate.
- A plain GET never wakes the core.
- Forged forwarding headers do not change the source the API sees.

## Open Points

- None.

## Working Notes

Work done on 2026-10-05, flyctl v0.4.111, org `personal`, region `cdg`, on branch `hosted/09-gate` (from `dev` at `bfe9241f`). Nothing is committed.

### What was built

- **Gate app (`apps/gate`),** a Fastify server wired into the workspace scripts (build, type-check, lint, `test:unit`) through Turborepo like the other apps:
  - `core-machine.ts`: finds the authoritative core (`role=core`, the `started` one, else the newest), maps the Machine state, and detects a setup failure from the `setup` container's events since the latest start.
  - `core-status.ts`: the status (ready with a relay target, or a page), the readiness probe of Caddy's `/health`, and a cache (10 s ready, 2 s otherwise, dropped on a failed relay or a start, a read in flight discarded). A ready core stays ready when the Fly read fails or the probe gets no answer (HD-28); status reads use a 3 s Machines API timeout.
  - `core-wake.ts`: the start under a 60 s lease, joined across simultaneous visitors; a held lease means "updating".
  - `relay-headers.ts`: drops client forwarding headers and sends one `X-Forwarded-For` from `Fly-Client-IP`, plus `X-Forwarded-Proto: https` and the visitor's `Host`.
  - `pages.ts`: stopped, booting (reloads every 3 s), updating, setup failure and unavailable pages; the gate-owned path `/__gate/start` and the same-site return path rule.
  - `server.ts`: the relay with `@fastify/reply-from` (raw bodies, retries off, 3 s connect timeout) and the gate pages (503, `no-store`).
- **Shared code.** `packages/fly-machines`: `FlyMachine` gains `private_ip` and `containers`, events gain `timestamp` (types only). `packages/contracts`: `gate` joins the service names for the logger.
- **Infra.**
  - `infra/fly/gate/machine.json` and `build.toml`; `infra/fly/deploy.mjs gate` builds the image from `docker/Dockerfile.node-service` (`SERVICE_NAME=gate`) and updates the gate in any state.
  - `infra/caddy/Caddyfile.fly`: trusts `fdaa::/16` as proxies and sends upstreams `X-Forwarded-For: {client_ip}` (settled, decision 1 below).
  - `infra/fly/core/machine.json`: `WEB_ORIGIN` is the gate's public URL.
  - `.dockerignore` excludes `**/*.env` (the core secrets file was in every remote build context).

### Fly state

- App `checkout-surge-gate`, Machine `873325c069dd38` (`shared-cpu-1x`, 256 MB, `role=gate`), shared IPv4 `66.241.124.226`, dedicated IPv6 `2a09:8280:1::1a7:9bfb:0`. Public URL: https://checkout-surge-gate.fly.dev.
- Secret `CORE_FLY_API_TOKEN` on the gate app: a deploy token for `checkout-surge-core` (`flyctl tokens create deploy -a checkout-surge-core -n gate-core-wake`), piped straight into `flyctl secrets set --stage`, with no local copy.
- Core and runner redeployed from this tree (version `bfe9241f…-dirty`, Depot remote builds) for the Caddyfile and `WEB_ORIGIN`; the gate image is 69 MB. Core Machine `8d14e3aee13038`, runner `8d3327ce259918`.
- 6PN addresses: gate `fdaa:ce:227b:a7b:4e6:39:ef79:2`, runner `fdaa:ce:227b:a7b:4e6:8978:121:2`, core `fdaa:ce:227b:a7b:5b7:448d:e737:2`.

### Done-when checks on Fly (2026-10-05)

All from the public URL, with curl and the desktop browser pane. Times are UTC.

**Plain GETs never wake the core: pass.** On a stopped core, `GET /demo`, `GET /demo/watch?run=1`, `GET /__gate/start`, `HEAD /admin` and `GET /api/core/idle-status` all answered the gate page (503), and the core stayed `stopped`. Next.js link prefetches (`?_rsc=`) sent by an open page also got the gate page. Plain HTTP is redirected to HTTPS (301) by Fly Proxy.

**A deep URL on a stopped core shows the gate page: pass** (same requests; the start button returns to the URL it was shown on).

**Start button, booting page, demo: pass.**

| Run | Start POST | Start sent to Fly | First demo page relayed (200) |
| :-- | :-- | :-- | :-- |
| curl, `return=/demo`, polling `/demo` every second | 02:04:32.9 (303 in 1.5 s) | 02:04:33.0 | 02:04:45.0 (+12.1 s) |
| Browser, from "Demo paused", "Back to the start page", "Start the demo" | 02:17:57.3 (303 in 1.6 s) | 02:17:57.4 | 02:18:08.3 (+11.0 s), after three booting reloads |

The first page request after a start takes about 2 s (the readiness probe times out while the Machine boots); later booting reloads take 40 ms.

**Live dashboard through the gate: pass.** A Preview 1k run started from `/demo` (public start, through the web's run-start route) moved the browser to `/watch`, which showed live updates over SSE ("Updates connected", charts moving) through to "Completed, all 500 available units were reserved without overselling" (run `ccf27cd3…`, started 02:05:55). Nine SSE connections opened and closed in a row through the gate were all accepted (200), so a closed visitor stream also closes upstream (the API caps 6 per source).

**Forged forwarding headers: pass.** The API's request log (`remoteAddress`, Fastify's `request.ip`) showed the workstation's public IPv4 address for `GET /dashboard/events` sent plain, with `X-Forwarded-For: 1.2.3.4`, `Fly-Client-IP: 5.6.7.8`, `X-Real-IP: 9.9.9.9`, `Forwarded: for=7.7.7.7` and `True-Client-IP: 6.6.6.6`, and over forced IPv4: the same address every time, never a forged value and never the gate's 6PN address. (The workstation has no IPv6, so IPv6 visitors were not tested.)

**Readiness probes are not activity: pass.** The last counted request was the `/demo` page load at about 02:06:58 (status 600 s right after). A browser tab stayed open on `/demo` through the gate: its recovery polling (15 s), readiness polling (60 s) and widget polling (30 s) were relayed every 15 s or so, each after the 10 s ready cache had expired, so the gate re-read the Machine and probed Caddy's `/health` about every 15 s. The deadline never moved (593, 533, 472, 411, 349, 289 s on minute reads). The API logged the idle stop at 02:17:00.18 (`idleSeconds: 602`), Fly recorded `stop` at 02:17:00.26 and `stopped` at 02:17:11.41. The gate answered the next polls with its page (503), and the tab showed "Demo paused" within one widget poll (02:17:39).

**Gate lifecycle.**

- A request on a stopped gate is answered in 4.3 to 4.9 s: Fly Proxy starts the Machine (1.4 s), Node listens 2.5 s later, then the request is served.
- Node uses 93 MB RSS (peak 102 MB) of 212 MB available on the 256 MB Machine.
- Redeploying a started gate (`deploy.mjs gate`): Fly replaced the config and left the Machine `stopped` (the script's wait for `stopped` passed); the next request started it again.
- Fly Proxy autostop: last request 02:21:19.9, "excess capacity, autostopping machine" at 02:26:54, so about 5.5 minutes without traffic.

**Left in place:** the gate deployed and autostopped, the core and the runner stopped (the core was stopped by hand at 02:18:32 after the last check).

### Validation (workstation)

- `pnpm exec biome check --write` on every touched file, then `pnpm lint`: clean.
- `turbo run type-check --continue`: every package passes except `mock-erp` (the known missing `node_modules` link to `@checkout-surge/db`); `pnpm type-check:test` fails only on the same `mock-erp` imports.
- Unit tests, run one package at a time: `gate` 21/21 (new), `api` 312/312, `contracts` 160/160, `fly-machines` 29/29, `logger` 8/8; `test:scripts` 60/60 (runtime image contract included). A full `pnpm test:unit` crashed the `worker` package's Node process at startup (`Assertion failed: (isolate_) != nullptr`, out of memory with parallel Turbo tasks); the worker is untouched.
- Not run here: `web` and `load-orchestrator` unit tests (untouched), API and integration tests (Docker). Nothing in this task changes a Docker-backed test.

### Minor choices

- **Gate-owned path.** `/__gate/start` is the only path the gate keeps; a GET on it is handled like any URL.
- **Unavailable page.** The design lists no page for a Machines API failure, a missing core Machine or a failed start; one generic "unavailable" page with a "Try again" link covers them.
- **Updating page.** Besides a held lease, a core Machine in `created` or `replacing` (a deploy writing its config) shows it.
- **Lease scope.** The wake holds the lease only around the start (60 s TTL, released at once), not until the core is ready.
- **Pages are static HTML** with a meta refresh for booting; no script.
- **Request logs.** Fastify logs every gate request (method, URL, status, time), useful for the bot review; they do not carry the visitor address.

### Decisions settled with the owner (2026-10-05)

1. **The core's Caddy trusts the whole 6PN range, not only the gate's address** (HD-32, design 2.4). A Machine's 6PN address follows its host and carries no app prefix, so the gate's /128 can go stale (written at deploy time or resolved at Caddy start), and every visitor would then silently share one SSE cap. Rejected as well: the organization's prefix only.
2. **A core whose setup failed is stopped by the guard on its first run** (input added to task 11). The API never starts in that case, so the idle stop never runs.
3. **The core secrets that reached Fly's builder cache are rotated before go-live** (HD-33, added to task 13's scope).

**Verified for HD-28 (2026-10-05).** From the gate Machine (`fly ssh console`, Node `net.connect`), a TCP connect to the stopped core's 6PN address on port 8080 got no answer at all: no refusal, still pending when the 30 s socket timeout fired. Relaying first and consulting Fly only on failure would make every request on a stopped core wait for a connect timeout.

**Decision log review (2026-10-05).** The owner reviewed the new entries: they were rewritten to record the why rather than the mechanics (new rule in `docs/decisions/README.md`), the `WEB_ORIGIN` entry was dropped (its operator limitation moved to task 13), and HD-25 was trimmed.

**External review (2026-10-05), arbitrated with the owner.**

- **Open redirect: confirmed, fixed.** The return path check only looked at the character after the leading `/`, so `/\t/evil.example/` or `/\t\evil.example` (browsers drop tabs and newlines and read a backslash as a slash) redirected to another site, `\r\n` made the redirect throw (500) after the wake had run, and the unavailable page's "Try again" link used the raw URL (`GET //evil.example/`). `safeReturnPath` now parses the value against a fixed base and keeps only the normalized path, query and fragment of a same-origin result, else `/`; every gate page goes through it. Tests cover the three payloads and the link.
- **The Machines API on the relay path: confirmed, changed (HD-28 rewritten).** When the status cache expired and the Fly read failed, the gate showed "unavailable" without trying a core that was serving, and the client's 30 s timeout made visitors wait. Now a ready core stays ready when the read fails or the probe gets no answer, and status reads time out after 3 s: the listing normally answers well under 200 ms from the gate (153 ms on a cold gate, about 40 ms warm), so 3 s only cuts off a failing API while bounding a visitor's wait. A background refresh was rejected (more code for little gain).
- **Deploy race: partially confirmed, deferred to task 12.** `deploy.mjs` reads the core's state before the builds and updates from that stale read, without the lease; a wake through the gate during the builds would be interrupted by the update (not reachable publicly before go-live). The same stale read affects a runner deploy during a run. Recorded in task 12 and in HD-29's consequences; no code change here.

**Review fixes on Fly (2026-10-05).** The gate was redeployed with both fixes. The deploy script pushed the new image under the same label (dirty tree, same commit), but the Machine kept the previous digest, so the first smoke check still showed the old behavior, and its start POST woke the core. The gate was then pinned to the new digest (`flyctl machine update --image …@sha256:8032d8e3… --skip-start`). `deploy.mjs` now gives dirty builds a unique, timestamped label. Smoke checks on the new image: `return=/\t/evil.example/`, `/\t\evil.example` and `//evil.example/` redirect to `/`; `/demo\r\nX-Evil: 1` redirects to `/demoX-Evil:%201` with no injected header (was a 500); `/demo?x=1` is kept; `GET //evil.example/` on the stopped core shows the stopped page with `return=%2F`. The core was stopped again afterwards.

### Inputs for later tasks

- **Task 10.** Two `role=core` Machines: the gate already prefers the `started` one, else the newest. A failed start currently shows the unavailable page; recovery replaces it with retries, the relocating and the no-capacity pages. The lease is held only around the start today.
- **Task 11.** Stop a failed-setup core (decision 2, recorded in task 11). The guard can live in the gate image (`apps/gate`) with the same Machines client; the gate app already has the core token as `CORE_FLY_API_TOKEN`.
- **Task 12.** `deploy.mjs gate` updates the gate in any state; the core and runner still refuse a non-stopped Machine. The gate's 6PN address is not needed by any deploy (decision 1).
- **Task 13.** The gate's request logs are the input for the bot review; add the visitor address (`Fly-Client-IP`) to them if the review needs it.

### Cloud verification (2026-10-05)

- A cloud agent ran the full suite on a clean install of the validation branch (before the review fixes): type-check, lint (578 files), unit tests including the gate (21), `test:scripts` (60/60), API tests (345) and integration tests (192) all pass. The local Compose topology, which has no gate, behaved as before: `/demo` rendered, a "Duplicate-click storm" run completed, no countdown appeared, and `/api/core/idle-status` returned `{"state":"disabled"}`.
- The review fixes and the HD-28 change touch only the gate and its unit tests (24/24), plus a two-line label fix in `deploy.mjs`, so no second cloud pass was run.
