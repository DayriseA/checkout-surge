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

- [x] Scope/domain docs state a clear per-order realtime presentation decision.
- [x] Default decision removes separate realtime per-order protocol/panel while retaining aggregate lag and durable diagnostic read, unless a documented product reason selects the bounded exception.
- [x] No recent-activity exception was selected; docs constrain any future reconsideration to a bounded, sampled, and rate-limited collection within the later shared projection.
- [x] Four gold signals and the no-storefront boundary remain explicit.
- [x] No protocol/component rewrite occurs in this task.

## Verification

Review updated scope/domain docs against current dashboard contracts/components and run no broad dashboard migration tests for this documentation-only decision unless a small documentation/static check exists. Do not run `pnpm test:composition` or `pnpm test:characterization` without explicit authorization. Record the decision and evidence reviewed.

## Working record

- Status: complete
- Completed scope: Recorded the presentation decision in `docs/scope_and_caveats.md`; aligned the durable diagnostic boundary in `docs/core_business_entities.md`; and marked the current mixed protocol versus accepted later target in `docs/load_generation_metrics_streaming.md`. No application code, contract, component, SSE protocol, test, dependency, or runtime behavior changed.
- Decisions: Later revisioned-projection work removes the separate per-order realtime status/lag protocol, browser per-order buffers, and live recent-activity panels/collections together. No recent-activity exception is selected. Aggregate consistency lag, all four dashboard gold signals, the focused durable `GET /orders/:publicOrderId/status` diagnostic, protected Run History drill-down, and the API-direct/no-storefront boundary remain. The docs explicitly identify the current per-order implementation as still present until that later migration.
- Verification: Direct file/heading checks passed for the new `Dashboard Recovery Model` and `5. Order` links. Focused searches confirmed the four gold signals and API-direct/no-storefront boundary remain explicit, the durable status route exists, and the current per-order contracts/publisher/components are still present and described as current implementation rather than already deleted. The documentation scan found no conflicting accepted-scope decision; architecture, cross-service, and repository-layout references describe the still-current implementation. `git diff --check` passed. No dedicated Markdown check exists in the root scripts, so no broader lint, runtime, or test lane was run for this documentation-only decision. An initial ad hoc Node link-parser attempt failed on an invalid regular expression before the successful direct link checks; it made no changes. The forbidden composition and characterization lanes were not run.
- Follow-up: The later dashboard revisioned-projection task owns protocol, contract, producer, reducer, component, and mechanism-specific test deletion. The later scope-document cleanup task separately owns removal of administrative metadata from `docs/scope_and_caveats.md`.
