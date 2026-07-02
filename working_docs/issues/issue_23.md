# Issue 23 - Refresh stale local runtime documentation


## Recommended Order Rationale

End with docs cleanup after runtime behavior decisions in Issue 22, so the local development guide reflects the final command and readiness contracts.

## Ownership Boundary

- Local development documentation
- Runtime health/readiness examples

## Problem

The local development guide has stale runtime guidance:

- The clean wipe-and-rebuild recipe stops after `pnpm runtime:wipe` and `pnpm runtime:setup`, leaving application services stopped until `pnpm runtime:up`.
- Health-check examples list old readiness check names that no longer match API and worker readiness code.

## Task

Update `docs/local_development.md`:

- Include `pnpm runtime:up` in the clean wipe-and-rebuild flow.
- Refresh readiness response examples and check-name tables to match implemented API and worker readiness.
- Keep the docs aligned with the outcome of Issue 22.

## Acceptance Criteria

- Following the wipe/rebuild recipe starts the full local runtime again.
- Readiness troubleshooting references current check names.
- No stale DB-only setup claims remain if Issue 22 changes that contract.

## Tests

Docs-only change. Verify referenced package scripts and readiness check names against current code before handing back.
