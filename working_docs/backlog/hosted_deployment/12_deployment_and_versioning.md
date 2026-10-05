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

## Inputs from Task 09

- **Core lease around the update (deploy race found in the task 09 review).** `infra/fly/deploy.mjs` reads the core's state before the builds and updates from that read, with no lease and no re-read, so a visitor wake through the gate during the builds can be interrupted by the update. Fix:
  - after the builds, acquire the core lease; a 409 fails the script, to be re-run (same policy as the runner lease);
  - re-read the Machine under the lease and refuse anything other than `stopped` or `created`;
  - send the update with the `fly-machine-lease-nonce` header;
  - keep the lease through the wait for `stopped`, so a wake right after the update shows "updating", not "unavailable"; the TTL must cover the update plus that wait. Verify live that the lease survives the update;
  - release it in a `finally` (404 means already gone).
  - Verify live that a wake during the builds is refused or shows "updating".
- **Same stale read for the runner.** A run started during a runner deploy's build window would be updated mid-run (pre-existing, reachable while the core is awake). Same fix with the runner lease.
- **A redeploy under the same image label kept the old image (found and fixed in task 09).** Two deploys of a dirty tree on one commit pushed a new image under the same `<service>-<commit-sha>-dirty` tag, and the Machines API update with the unchanged image string kept the previous digest. `deploy.mjs` now appends a UTC build timestamp to the label of dirty builds only; clean commits keep `<service>-<commit-sha>`, and `COMMIT_SHA` is unchanged.
- `deploy.mjs` has no tests; add one only if this task extracts the deploy sequence anyway.
- HD-29's context and consequences say the deploy side of the lease is not implemented yet; update them when it is.

## Working Notes

_None yet._
