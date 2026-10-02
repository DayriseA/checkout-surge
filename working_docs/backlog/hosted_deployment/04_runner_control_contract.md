# 04 — Runner Control Contract

**Design:** sections 1.3, 4.2, 4.3, 8 · **Depends on:** none

## Goal

The load-orchestrator gains the identity and self-termination behavior that a per-run lifecycle needs. Everything here is testable locally, without Fly.

## Scope

- **Boot ID.**
  - The load-orchestrator generates a boot ID at process start and exposes it.
  - Every start or replay carries the expected boot ID, and a mismatch is rejected.
- **Fenced shutdown:** a `shutdown(runId, bootId)` endpoint. The process exits only when the request matches its current boot.
- **Self-exit:**
  - after 3 minutes with no execution and no completion report awaiting acknowledgement;
  - at a maximum lifetime derived from `automaticRunResetDeadlineSeconds` plus a small margin.
- **Off unless configured:** both self-exit timers are disabled by default, so the local topology keeps a long-lived load-orchestrator (design section 1.3).
- **Version:** the load-orchestrator exposes its commit SHA.
- **Contracts:** boot ID and version fields in the runner control contracts.

## Out of Scope

- The API side: the operations owner, boot-ID persistence and the version handshake (task 05).

## Done When

- Tests cover the boot-ID mismatch rejection, the fenced shutdown and both self-exit timers.
- A local Compose run still works.

## Open Points

- None.

## Working Notes

_None yet._
