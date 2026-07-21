# Task 45 — Final simplification convergence audit and handoff

## Execution context

- **Position:** 45/45; final cross-cutting convergence and handoff task.
- **Dependencies:** All intended Phase 0–7 changes must be complete or explicitly recorded as blockers. This task may make only narrow residue fixes; it is not authorization for another broad refactor.
- **Standalone:** Verify that the final architecture has one clear owner for each retained guarantee and that removed mechanisms have not survived as dormant code, scripts, docs, or tests. Produce a handoff that states the intended design without depending on the audit document.
- **Checklist / working record:** Primary ownership is final architecture/residue audit and handoff evidence. Respect package and service ownership when fixing residue; routes stay thin and infrastructure remains composed explicitly. Record inspected locations, fixes/blockers, commands/results, and measurable reductions below.

## Why

Large simplification waves often leave dormant compatibility paths, duplicate owners, and stale documents that preserve the old mental model. A final check must assess authorities, state models, and supported modes—not merely diff size.

## Required outcome

Inspect the repository for listed residue, fix narrow confirmed remnants or record a concrete blocker, run root type-check/lint and required non-prohibited tests as the environment allows, and hand off the final architecture, retained guarantees, removals, and measured reductions. A blocker may be recorded for handoff, but this task and the overall plan must not be marked complete while that blocker prevents any required Task 01–44 outcome.

## Concrete scope and paths

Audit relevant source, contracts, scripts, tests, and docs for:

- cross-replica leases/attestation and other production-impossible coordination;
- legacy normalizers/compatibility reads;
- duplicate transport summaries;
- multiple repair owners or multiple K6 completion-delivery owners;
- mock ERP PostgreSQL persistence;
- mixed dashboard protocol, replay/delta reducers, and per-order realtime fan-out;
- redundant runtime triggers, dead scripts/wrappers, and obsolete tests/docs; and
- scope-page administrative metadata.

For confirmed narrow residue, delete or simplify it at its owning boundary and update the directly affected test/doc in the same change. If removal would alter an uncompleted required guarantee, leave it intact and record the exact blocker, owner, consequence, and follow-up rather than masking it. Do not reopen accepted product scope or add a replacement abstraction.

The handoff must explicitly state this intended architecture and retained guarantees: Redis atomic no-oversell and idempotency; durable records plus one bounded repair owner; durable queue recovery; ERP resilience and attempt evidence; declarative database invariant core; traffic/business completion split; one revisioned projection; durable diagnostics; proportionate security; one bounded child-process owner plus one durable completion path; independent non-root images; focused tests; and concise scope authority. State removals as well: replica coordination/attestation, legacy normalizers, duplicate transport facts, incident remediation residue, mock-ERP database boundary, mixed dashboard protocol, per-order realtime fan-out, redundant scripts, and scope administration metadata.

## Retained behaviour and non-goals

Retain the project’s demonstrated resilience boundaries and explicit opt-in validation lanes. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit user authorization, claim green checks that did not run, or make broad unrelated edits to chase every theoretical improvement.

## Acceptance

- [ ] Listed residue categories have been searched and each is removed or intentionally retained with a requirement-based rationale; no blocker remains against a required plan outcome.
- [ ] Any fixes are narrow and include directly relevant tests/docs.
- [ ] `pnpm type-check`, `pnpm lint`, and `pnpm test:required` are run with exact outcomes when test infrastructure is available; otherwise `pnpm test` and all feasible focused gates run and each unavailable infrastructure lane (including `test:k6-compat`) has an exact skip reason.
- [ ] Composition and characterization are left opt-in unless explicitly authorized.
- [ ] Handoff lists final architecture, retained guarantees, removals, blockers, and a measurable reduction in authorities, states, or modes.
- [ ] Final self-review confirms scope, phase boundary, ownership, contract consistency, vocabulary, and verification status.

## Focused verification

Run `pnpm type-check`, `pnpm lint`, and `pnpm test:required` after inspecting the current package scripts; if Docker/test infrastructure is unavailable, run `pnpm test` plus every feasible focused gate and record exactly why `pnpm test:k6-compat` could not run. Run targeted tests for any narrow residue fix. Record environmental failures separately from test failures. Do not run `pnpm test:composition` or `pnpm test:characterization` by default.

## Working record

Pending — residue inventory, narrow fixes/blockers, command outcomes, measurable reductions, and final handoff remain to be recorded.
