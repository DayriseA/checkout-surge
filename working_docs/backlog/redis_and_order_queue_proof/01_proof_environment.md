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

_None yet._
