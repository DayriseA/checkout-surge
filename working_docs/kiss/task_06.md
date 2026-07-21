# Task 06 — Remove confirmed dead routes, predicates, fetches, and placeholders

## Execution context

Task 6 of 45. Phase 1: remove unambiguous residue. Primary ownership boundary: each proven-unreachable route/client/script and its direct tests/docs. Dependencies: Phase 0 must provide a reliable baseline; this task must not delete behavior simply because it is uncommon. This record is standalone. Follow the quality checklist: keep routes thin, preserve application-service ownership, and delete tests only with the dead surface they pin.

## Why this task exists

The project carries dashboard/admin proxy and read-code candidates, placeholder scripts such as `scripts/not-implemented.mjs` and `scripts/no-tests-yet.mjs`, and related commands/docs/tests. Dead surface increases maintenance cost and makes the public demo boundary unclear.

## Required outcome

Delete only surfaces proven unreachable or unused, together with their direct tests, commands, and documentation. Preserve useful low-frequency behavior.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift. Start with reachability/usage proof using repository references, route registration, imports, package scripts, docs, and tests. Inspect candidate areas under `apps/web/src/app`, admin/dashboard proxy and backend-read code, `apps/api/src`, `scripts/not-implemented.mjs`, `scripts/no-tests-yet.mjs`, `package.json`, `docs/`, and their tests. Record evidence for every deletion (for example no route registration, no production import, and no documented supported workflow). Remove associated tests/docs only when they describe the deleted surface; retain a test if it protects a still-supported contract.

## Retained behavior and non-goals

Retain all documented gold signals, public/admin operations, focused diagnostic reads, and low-frequency but reachable workflows. Do not use file size, lack of recent edits, or lack of a direct test alone as proof of deadness.

## Acceptance criteria

- [ ] Every deleted surface has recorded reachability/usage proof.
- [ ] Confirmed dead routes, predicates, fetches, placeholders, commands, docs, and direct tests are removed together.
- [ ] No useful supported behavior is deleted solely for low frequency.
- [ ] Remaining route and composition boundaries retain their existing responsibilities.

## Verification

Run focused tests for affected remaining routes/components and repository searches for deleted identifiers. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record proof and commands per deletion group.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
