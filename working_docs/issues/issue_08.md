# Issue 08 - Write immutable summaries for admin-reset failed runs


## Recommended Order Rationale

This depends on Issue 07's unified terminal transition path. Once that path is reliable, reset can fail active runs while preserving run history consistently.

## Ownership Boundary

- API maintenance service
- Terminal demo run summary writer
- Run history persistence and tests

## Problem

`reset()` directly marks `starting`, `active`, and `draining` runs as `failed` with `failureReason: "admin_reset"`, but it does not insert `demo_run_summaries` or capture terminal inventory/business snapshots.

## Task

Route reset-owned terminal changes through the shared summary writer:

- Create `admin_reset` terminal summaries for in-progress runs made failed by reset.
- Capture the same terminal inventory and business outcome snapshots expected for other terminal paths.
- Preserve existing summaries for runs that are already terminal.

## Acceptance Criteria

- Every run made terminal by admin reset has exactly one immutable summary-backed history record.
- Existing terminal summaries are unchanged by reset.
- Run History shows reset-failed active runs with coherent terminal details.

## Tests

Add maintenance-service regression coverage for reset-failed active runs and unchanged existing terminal summaries.
