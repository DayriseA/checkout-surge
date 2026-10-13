# 01 — Proof Environment

**Design:** section 6 · **Depends on:** the hosted deployment backlog done

## Goal

The agent can create, deploy, test and destroy a complete Checkout-Surge environment in the owner's `playground` Fly.io organization, without any way to affect production by mistake.

## Context

- The production app names (`checkout-surge-core`, `checkout-surge-runner`, `checkout-surge-gate`) are written into `infra/fly/deploy.mjs` and the Machine configurations under `infra/fly/`. Fly.io app names are unique across the platform, so the proof environment needs its own.
- `flyctl` on the laptop is logged in with the owner's full account, so the isolation rests on rules and on a check in code.

## Scope

- App names, organization and public address configurable per environment. Production stays the default and keeps its current behavior.
- Before any change, the deploy tooling checks that the target app belongs to the configured organization. It refuses a production app when the environment is not production.
- Secrets generated for the proof environment, kept out of git.
- One command each to create, deploy and destroy the environment.
- Docs for operating the proof environment.

## Out of Scope

- Any change to the production environment or its deploy workflow.

## Done When

- A full proof environment runs in `playground`, a demo run completes there, and the environment can be destroyed and recreated from scratch.
- A deliberate attempt to target a production app from the proof configuration is refused by the tooling.

## Open Points

- None.

## Working Notes

### Choices (2026-10-12)

- **Ported from `add0343d`, trimmed.** `infra/fly/environment.mjs` holds the production default and loads a proof config (`infra/fly/proof.json`: organization, three app names, public origin). `deploy.mjs --environment <file>` uses it; without the flag nothing changes for production, which runs no organization check, so its CI deploy stays as it was.
- **Isolation.** A proof config outside `playground-416`, or naming a production app or origin, is refused before any Fly call. Then every Machines API call and every image build first reads the app (`GET /v1/apps/<app>`) and refuses an app outside the organization; a missing app fails closed. `proof.mjs` checks the same before every flyctl call on an existing app.
- **Machine configs** are renamed as text (production origin, then app names), so every reference follows, including the recovery copies written into the core and the gate.
- **New apps.** `deploy.mjs all` deploys the gate first when it has no Machine, since the core deploy writes into it. Production always has its gate, so its order is unchanged; the one-time setup doc lost its gate-only step.
- **Secrets.** `proof.mjs create` generates every value and one app-scoped deploy token per app (production has one per holder; not worth it for a disposable environment), stages them, and keeps the core's values in `infra/fly/proof-core.env` (ignored by git and the build context). `.tmp` joined `.dockerignore`, so old local files never reach a remote build.
- **Create runs from scratch only:** after a failure, `destroy` then `create`. This replaces the archived re-run logic.
- **Guard kept:** same topology as production, and it bounds a core left awake.
- **Dropped:** the stale archived `proof.json`, the per-image re-check between a local build and its push, and the fake-CLI ownership-change tests. `f3504059` (pinned images) builds on the later topology work and was not ported.

### Live verification (2026-10-12)

- `create`, then `deploy` of the working tree (`fa770df7…-dirty`): gate first, version handshake passed. The deployed configs name only `cs-proof-*` apps.
- Run `dc44e175-8a35-4c6a-86fb-00a21a9cd819`, public preset `preview-1k`, through the gate as a visitor: completed. 1,000 requests completed, 500 accepted, 500 sold out, 0 failures, 500 confirmed orders, every invariant held, runner in `cdg`, back to `stopped`.
- A proof config naming `checkout-surge-core` was refused before any Fly call (flyctl pointed at a missing executable); a config naming an absent app failed closed on the organization check.
- `destroy` removed the three apps and the local secrets file. `create` and `deploy` then rebuilt the environment from scratch, and run `4150bc68-3828-4beb-8aa9-c3f14fcef298` completed with the same results. The recreated gate refused TLS for about 10 s after the deploy, then answered.

### Resources kept (all stopped, `cdg`)

| App | Machine | Role | Size |
| :-- | :-- | :-- | :-- |
| `cs-proof-core` | `8e3e29b7730ee8` | core, volume `vol_rnzgk9y8qn80jd0r` (3 GB) | performance, 6 CPUs, 12 GB |
| `cs-proof-runner` | `89663dc6ed09e8` | runner | performance, 8 CPUs, 16 GB |
| `cs-proof-gate` | `822090c7037938` | gate | shared, 1 CPU, 256 MB |
| `cs-proof-gate` | `e822636c56e428` | guard, hourly | shared, 1 CPU, 256 MB |
