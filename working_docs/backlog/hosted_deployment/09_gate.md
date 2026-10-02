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

_None yet._
