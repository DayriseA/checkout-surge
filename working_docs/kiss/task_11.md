# Task 11 — Decide per-order realtime presentation scope

## Execution context

Task 11 of 45. Phase 2: make scope decisions that unlock deletion. Primary ownership boundary: product scope/domain documentation for dashboard presentation. Dependencies: task 10 confirms local topology; this decision directs later dashboard deletion/revisioned-projection work but does not implement it. This record is standalone. Follow the quality checklist: retain required dashboard behavior and do not rewrite protocol layers in a documentation decision.

## Why this task exists

Individual per-order status/lag messages and panels add a separate realtime state protocol to a dashboard whose purpose is aggregate surge behavior. Their presentation value needs an explicit product choice before downstream deletion.

## Required outcome

Record an explicit decision. Recommended default: remove the separate per-order realtime protocol/panel; retain aggregate consistency lag and a focused durable diagnostic read. If recent activity is demonstrably valuable, permit only a bounded, sampled, rate-limited collection within the later shared projection.

## Scope and implementation guidance

Verify paths before editing because the checkout may drift: update concise `docs/scope_and_caveats.md` and applicable domain/dashboard documentation, and inspect current dashboard contracts/components/tests only to state the choice accurately. Record the rationale, retained diagnostic boundary, and constraints for any recent-activity exception. Preserve the four gold signals—request surge, queue depth, inventory drain, consistency lag—and the no-storefront boundary. Do not rewrite SSE, remove components, alter contracts, or add a realtime protocol in this task; later dashboard work follows the recorded choice.

## Retained behavior and non-goals

Retain aggregate consistency lag, focused durable per-order diagnostics, four gold signals, and the API-direct/no-storefront product boundary. Do not infer customer-facing order tracking, preserve an unbounded activity feed, or begin implementation deletion before the decision is recorded.

## Acceptance criteria

- [ ] Scope/domain docs state a clear per-order realtime presentation decision.
- [ ] Default decision removes separate realtime per-order protocol/panel while retaining aggregate lag and durable diagnostic read, unless a documented product reason selects the bounded exception.
- [ ] Any recent-activity exception is explicitly bounded, sampled, and rate-limited within a later shared projection.
- [ ] Four gold signals and the no-storefront boundary remain explicit.
- [ ] No protocol/component rewrite occurs in this task.

## Verification

Review updated scope/domain docs against current dashboard contracts/components and run no broad dashboard migration tests for this documentation-only decision unless a small documentation/static check exists. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record the decision and evidence reviewed.

## Working record

- Status: pending
- Completed scope: none
- Decisions: none
- Verification: not run
- Follow-up: none
