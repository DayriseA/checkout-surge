# 12 — Deployment and Versioning

**Design:** sections 3.6, 7.2, 8 · **Depends on:** 09, 10

## Goal

One command safely deploys one commit to the three apps.

## Scope

- **Complete the deploy script** started in tasks 01, 02 and 09:
  - update stopped Machines without starting them, from a freshly read full config;
  - hold the core lease during the update;
  - wait for an awake core to sleep, or interrupt it with `--force`;
  - verify the core and runner versions at the end.
- **Fresh-core command** for incompatible changes, through the recovery path.
- **Rotation procedure** for the Machines API tokens and for `CONTROL_SERVICE_TOKEN`, documented.

## Out of Scope

- GitHub Actions (task 13).

## Done When

- Deploying on a stopped core updates everything and starts nothing.
- Deploying on an awake core waits, and `--force` interrupts the session.
- The gate shows the updating page while the script holds the lease.
- A partial deployment is reported by the script and refused by the version handshake.

## Open Points

- None.

## Working Notes

_None yet._
