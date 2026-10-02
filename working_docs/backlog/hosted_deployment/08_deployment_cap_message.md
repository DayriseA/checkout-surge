# 08 — Deployment-Cap Message

**Design:** section 1.2 · **Depends on:** none

## Goal

A visitor who hits a hosting limit understands that it is a deliberate hosting choice, not an input mistake.

## Scope

- **API:** check that it refuses to start when the persisted public policy exceeds the deployment caps, and add the check if it is missing.
- **Web:** a message for `*_exceeds_deployment_cap` rejections only. It explains the hosting reason and invites the user to run the project locally or on larger infrastructure.

## Out of Scope

- Choosing the cap values (task 13).

## Done When

- A deployment-cap rejection shows the hosting message.
- Invalid input never shows it.

## Open Points

- None.

## Working Notes

_None yet._
