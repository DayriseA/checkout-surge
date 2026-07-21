# Task 15 — Establish canonical transport-attempt evidence

## Execution context

Task 15 of 45, Phase 3, after tasks 12–14 are complete. Amend the single DB baseline from task 12 in place and rely on task 13 having removed all legacy readers. This is a cross-boundary atomic cutover: `@checkout-surge/contracts` owns the canonical evidence shape; load orchestration produces it; API services bind/finalize/history/recovery consume it; DB persists it; web renders derived projections. No route owns accounting.

## Why

`httpSummary`, `trafficDeliverySummary`, and `apiRequestLifecycleSummary` copy transport facts and require synchronization validation. The supposed API lifecycle evidence is client-produced, so its name overstates what was observed.

## Required outcome

Define one canonical transport-attempt evidence object preserving:

```text
planned = started + unstarted
started = completed + interrupted
```

HTTP outcome/timing is a projection with no copied transport totals. Delivery-quality and dashboard labels derive from canonical evidence plus durable business counts. Remove `apiRequestLifecycleSummary` unless real server instrumentation is added. Cut over orchestrator parser/report, contracts, API binding/finalization/history/recovery, DB baseline, web displays, and tests together; no compatibility mode is allowed under task 09.

## Scope and concrete current paths

- `packages/contracts/src/load.ts`, `traffic-transport-counts.ts`, `demo.ts`, dashboard/event contracts and tests.
- `apps/load-orchestrator/src/` parser, report, completion delivery, and journal call sites.
- API `traffic-completion-binding.ts`, enrichment/finalization/history/recovery services and delivery classifier/plan tests.
- `packages/db/src/schema.ts`, JSON persistence/migration baseline, and `apps/web/src/app/` run/dashboard label derivation, displays, and tests.
- Worker integration fixtures that construct or assert terminal completion reports, especially `apps/worker/test/integration/order-processing-workflow.test.ts`; production worker code need not change unless repository search finds a real consumer.
- Before deploying the atomic cutover, confirm that no load execution is active and intentionally clear disposable persisted journal/database state through the wipe policy and baseline established by tasks 09 and 12. Do not translate an in-flight or old-shape report into the new contract.

## Retained behavior and non-goals

Preserve accepted, sold-out, unexpected, HTTP timing/outcome reporting, duplicate-aware durable reconciliation, and the two equations. Do not fabricate server lifecycle instrumentation or retain old input/output fields. Vocabulary pruning belongs to task 16 unless inseparable from deleting duplicate evidence.

## Acceptance

- [ ] One canonical contract carries all planned/started/completed/interrupted transport totals and enforces both equations.
- [ ] HTTP projection contains outcomes/timing only; no delivery or API-lifecycle copy duplicates those totals.
- [ ] Delivery-quality and dashboard labels are deterministically derived from canonical evidence plus durable counts.
- [ ] Producers, DB persistence, API consumers, and web displays cut over together without legacy readers.
- [ ] Cutover evidence records that no load execution was active and that disposable old-shape journal/database state was intentionally cleared rather than translated.
- [ ] Worker and other cross-package fixtures/consumers found by repository search use only the canonical report.
- [ ] Focused tests cover accepted/sold-out/unexpected/timing, interruptions, and duplicate-aware reconciliation.

## Focused verification

Run contracts unit tests, affected load-orchestrator tests, `pnpm --filter api test:api`, DB unit/integration tests when persistence changes, worker/web affected tests, and affected package type-checks. Do not run composition or characterization suites.

## Working record

Pending — name the canonical type and owner, removed copies, derivation rules, migration/baseline decision, tests run, and remaining task-16 vocabulary follow-up.
