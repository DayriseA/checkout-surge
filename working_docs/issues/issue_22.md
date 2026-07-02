# Issue 22 - Resolve runtime setup Docker target mismatch

Status: Fixed


## Recommended Order Rationale

Leave Docker/docs contract cleanup until after product behavior fixes. This can be implemented independently once the desired runtime setup contract is confirmed.

## Ownership Boundary

- Dockerfile runtime targets
- Package runtime scripts
- Runtime topology documentation

## Problem

Docs say `runtime:setup` uses a DB-only Docker target so seed changes do not rebuild application bundles. The Dockerfile has `runtime-setup` inherit from `workspace`, and `workspace` runs `pnpm build` for the whole monorepo.

## Task

Choose and implement the intended contract:

- If DB-only setup is intended, split a real setup target that copies only files needed by `@checkout-surge/db` migrations/seeds and required workspace dependencies.
- If full workspace build is intentional, update docs to remove the DB-only claim.

## Acceptance Criteria

- `pnpm runtime:setup` behavior matches documentation.
- Seed/setup changes do not unexpectedly rebuild the whole app workspace if DB-only remains the contract.
- Docker target names remain clear for local operators.

## Tests

Run or document the relevant Docker build/setup command if feasible. If not feasible locally, state the skipped verification reason in the implementation handoff.
