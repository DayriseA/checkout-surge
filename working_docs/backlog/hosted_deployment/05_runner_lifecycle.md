# 05 — Runner Lifecycle

**Design:** sections 1.1, 1.3, 4.1, 4.2, 7.2, 8 · **Depends on:** 02, 04

## Goal

The API starts a freshly booted runner for every run and stops it when the run reaches a terminal state, with no manual step.

## Scope

- **New shared package `packages/fly-machines`,** with the Machines API client for the operations the API needs: read, start, stop, update and lease. It holds no business rule.
- **Runner host interface** with two implementations chosen by configuration: Fly, and local (runner always on, design section 1.3).
- **Runner operations owner:** one operation at a time, holding a Fly lease.
- **Start of a run:**
  1. Make sure the runner is stopped.
  2. Update its size from the API environment variables, and its `API_BASE_URL`.
  3. Start it.
  4. Read its boot ID and persist it with the run, together with the Machine identity.
- **Boot ID on every start or replay,** including the startup reconciliation path.
- **Stop:** fenced shutdown as soon as the run is terminal, with Fly `stop` as the fallback for an unreachable runner.
- **Abort:** a stopped runner counts as a confirmed abort.
- **Version handshake:** the API refuses a run when its commit differs from the runner's, and the UI shows a clear message.
- **Token:** the API's Machines API token for the runner app.

## Out of Scope

- Loss detection, capacity classification and runner recreation (task 06).
- Runner pre-start. It is a noted option, not a decision.

## Done When

- On Fly, launching `surge-10k` from the UI starts the runner, completes, and leaves the runner stopped.
- Two consecutive runs each get a fresh boot.
- An admin reset succeeds while the runner is stopped.
- A version mismatch refuses the run with the expected message.

## Open Points

- None.

## Inputs from Task 04

- Read the boot ID from `GET /traffic/control` before start and send it as `expectedBootId` on every start and replay, including startup reconciliation. Then make the field mandatory in the contract.
- Compare `status.bootId` with the persisted boot ID in the ambiguous-start recovery (`HttpTrafficExecutionGateway.recoverAmbiguousStart`).
- Map the 409 codes `runner_boot_mismatch` and `runner_stopping` explicitly. Today every 4xx start rejection becomes a generic 502 `load_orchestrator_unavailable`.
- Shutdown always answers 202 with an outcome. Retry `deferred_busy` within a bound (the runner may still be recording the acknowledgement of a report the API has just persisted), then fall back to Fly `stop`.
- Confirm a shutdown by waiting for the Machine to reach `stopped`: the connection may drop once the runner exits.
- Version handshake: never treat `unknown` as a match on Fly. The runner gets `COMMIT_SHA` from the deploy script; the API needs its own commit the same way (core Machine env set by the deploy script), which task 04 did not add.

## Working Notes

_None yet._
