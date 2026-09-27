# Remove the permanent-rejection machinery

## Handoff

- Status: Done (uncommitted).
- Type: standalone task (not part of a backlog). Independent of [tests_cleaning](tests_cleaning/index.md), but run it after [16 part 3](tests_cleaning/16_part3_remove_remaining_dead_code.md) so the two do not edit the same files concurrently.
- Source: lead L7 of the tests_cleaning backlog. Owner decision (2026-09-26): the machinery is removed outside tests_cleaning (the "dedicated backlog" of the task 16 documents, delivered as this single standalone task). Its footprint was recorded in [16 part 1, lead L7](tests_cleaning/16_part1_remove_compatibility_code.md) and refreshed at `f13ebbdb` below. Owner decision Q6 (2026-09-27) assigned the `failedOrders` / `technicallyFailedOrders` redundancy to this task.
- Ownership: contracts, db schema and baseline, worker, Mock ERP, API, web, their tests and the documentation that describe permanent rejection.

## Objective

`erpPermanentRejectionCodeValues` (`packages/contracts/src/erp-outcomes.ts`) is empty by design: the Mock ERP emits no permanent rejection, so no order can terminalize as `business_rejection`, no ERP attempt can have the `permanent_rejection` disposition, and every business-rejection counter, retention exception and UI row is always zero or empty. It is an extension point for a hypothetical future ERP, which conflicts with the AGENTS.md rule against speculative flexibility (and with Q3 of task 16: contract values that no producer emits are removed).

Remove the concept end to end, so that the only terminal failure of an order is a non-transient technical failure. Behavior for every reachable ERP response stays identical.

## Owner decisions

The owner accepted the recommendation of P1, P2 and P3 (2026-09-27).

- **P1 — Order failure category.** Once `business_rejection` is gone, `orderFailureCategoryValues` holds only `technical`, so the order failure category carries no information (Q3). Recommendation: remove it entirely: `orderFailureCategoryValues` / `OrderFailureCategory` (`packages/contracts/src/lifecycle.ts` ~42-44), the `order_failure_category` enum and the `orders.failure_category` column (`packages/db/src/schema.ts` ~67-69, ~289; baseline and snapshot), the worker `category` field that writes it (`order-process-job-handler.ts` ~44, ~256-259; `postgres-order-transition-persistence.ts` ~172, ~343) and the dashboard query filter (`business-outcome-dashboard.ts` ~101, ~107). The technical failure code still distinguishes failures. No API or web field carries the order category. Alternative: keep the single-valued category as a label.
  - **Decision (2026-09-27):** accepted. Remove the order failure category entirely.
  - **Warning:** the `failureCategory` fields of the contracts, API and web (`packages/contracts/src/entities.ts`, `demo.ts`, `run-result.ts`, `apps/api/src/services/demo-run-projections.ts`, `run-history-service.ts`, the web presentation helpers) are the **run** failure category (`publicRunFailureCategorySchema`: `automatic_reset`, `operator`, `traffic`, …). They are unrelated and stay.
- **P2 — Failure counters.** Without business rejections, `technicallyFailedOrders` always equals `failedOrders` (Q6). Recommendation: keep `failedOrders` (computed from `orders.status = 'failed'`, used across API, web and runtime scripts; `scripts/runtime-acceptance.mjs` and `runtime-smoke.mjs` read no other failure counter) and remove both `businessRejectedOrders` and `technicallyFailedOrders` from the summary, list, run-result contracts, the DB dashboard query, and the UI rows that split failures into two kinds.
  - **Decision (2026-09-27):** accepted. Keep `failedOrders`; remove `businessRejectedOrders` and `technicallyFailedOrders`.
  - P1 and P2 are coupled: the `technicallyFailedOrders` query filters on `failure_category = 'technical'` (`business-outcome-dashboard.ts` ~107), so accepting P1 while rejecting P2 requires recomputing that counter from `orders.status` instead.
- **P3 — Delivery constraints wording.** `working_docs/delivery_constraints.md` (constraint 2) says "only a permanent rejection or a non-transient technical error fails an order". Recommendation: reword to "only a non-transient technical error fails an order". This is an owner document: confirm before editing.
  - **Decision (2026-09-27):** accepted. Reword constraint 2 as recommended.

## Footprint at `f13ebbdb`

Verify at HEAD before editing; the list is a starting point, not an exhaustive inventory. Search terms:

- Identifiers: `permanent_rejection`, `business_rejection`, `businessRejected`, `PermanentRejection`, `permanentRejection`, `permanentRejected`, `erp_permanent_rejection`; depending on P1/P2: `OrderFailureCategory`, `orderFailureCategory`, `order_failure_category`, `failure_category`, `technicallyFailed`. Do not search for bare `failureCategory`: it mostly matches the run failure category, which stays (see P1).
- Prose, case-insensitive: `permanent.?reject`, `permanently reject`, `business rejection`, `business-rejected`.
- Known unrelated hits, which stay: the load orchestrator's "permanently rejected" completion reports (`docs/architecture.md` ~18, ~49; `docs/load_generation_metrics_streaming.md` ~110; `apps/load-orchestrator/test/completion-delivery-coordinator.test.ts` ~252).

- Contracts: `packages/contracts/src/erp-outcomes.ts` (the empty code vocabulary and schema, the `permanent_rejection` disposition, the rejected branch of the ERP response and lookup schemas), `erp.ts` (~137, `permanentRejected` in `erpCumulativeOutcomeCountsSchema`), `lifecycle.ts` (`orderFailureCategoryValues`, P1), `demo.ts` (summary and list counters), `run-result.ts` (counters and derived sentences inputs).
- DB: `packages/db/src/schema.ts` (the `erp_outcome_disposition` value, the `order_failure_category` enum and `orders.failure_category` column per P1), `packages/db/drizzle/0000_baseline.sql` and `meta/0000_snapshot.json` (amend the baseline, Q1; no migration), `packages/db/src/business-outcome-dashboard.ts` (counters; `readCumulativeErpOutcomeCounts` `permanentRejected` ~38, ~48; the `failure_category` filter ~107).
- Worker: `apps/worker/src/application/erp-confirmation-client.ts`, `erp-reconciliation.ts`, `erp-resilience-policy.ts`, `order-process-admission.ts`, `order-process-job-handler.ts` (classification and the `permanent_rejection` terminal path); `apps/worker/src/persistence/postgres-erp-attempt-persistence.ts` (protected permanent-rejection attempt retention, cumulative permanent-rejection counter); `postgres-order-transition-persistence.ts` (order failure category, P1).
- Mock ERP: `apps/mock-erp/src/application/confirmation-service.ts` (~184, `isTerminalResponse` permanent-code check; ~107, the `rejected` lookup status) and `apps/mock-erp/src/persistence/postgres-confirmation-ledger.ts` (~94, maps a stored non-success to `rejected`).
- API: `apps/api/src/services/demo-run-projections.ts`, `run-history-service.ts` (business-rejection counters and the cumulative `permanentRejected` counter; not their run `failureCategory`).
- Web: `apps/web/src/app/components/dashboard-panels.tsx`, `live-technical-board.tsx`, `operator-dashboard.tsx`, `run-history-detail.tsx`, `run-history-list.tsx`; `apps/web/src/app/lib/presentation/run-result-presentation.ts` (business-rejection rows and split wording such as "business-rejected").
- Docs: `docs/core_business_entities.md` (~20, ~239, ~286, ~620, ~734: failure categories, terminal marker, split failure counters, retention, Mock ERP ledger), `docs/load_generation_metrics_streaming.md` (~78, "Live totals show confirmed, business-rejected, and technically failed orders separately"), `working_docs/delivery_constraints.md` (constraint 2, P3), `docs/cross_service_conventions.md` (~209 cumulative counters, ~289 retention exceptions), `docs/architecture.md` (~90 "Permanent rejection … remain terminal under D03", ~93 protected retention). Not related: the "permanently rejected" completion reports of the load orchestrator (`docs/architecture.md` ~18, ~49; `docs/load_generation_metrics_streaming.md` ~110) are a different mechanism and stay.
- Tests (26 files at `f13ebbdb`): contracts (`contracts`, `erp-outcomes`, `run-result`, `vocabulary`), db (`business-outcome-dashboard.integration`), worker (`erp-confirmation-client`), API (`api`, `dashboard-recovery-service`, `demo-maintenance-workflows`, `demo-run-finalization-service`, `erp-attempt-status-reader`, `run-history-service`, `unit/demo-run-projections`), web (`admin-controller-state`, `api-read-fallback`, `browser-workflows`, `dashboard-phase6`, `dashboard-projection-state`, `freshness`, `live-technical-board`, `public-run-summary`, `run-failure-explanation`, `run-history`, `run-presentation-state`, `run-result-presentation`, `watch-narrative`). Also affected, outside the identifier search above: `packages/db/test/unit/vocabulary-parity.test.ts` (~45, `order_failure_category`, P1), `apps/worker/test/integration/order-processing-workflow.test.ts` (`failureCategory: "technical"` order rows, P1), `apps/api/test/unit/erp-status-service.test.ts` (~123, `permanentRejected`). Run-level `failureCategory` hits in `apps/api/test/demo-run-service.test.ts`, `traffic-completion-service.test.ts`, `apps/web/test/dashboard-hooks.test.tsx`, `grace-period-notice.test.tsx` and `watch-composition.test.ts` are unrelated. Tasks 04, 08, 13 and 14 of tests_cleaning already replaced the unreachable fixtures with technical failures and zero business rejections; what remains are the zero-valued fields, the split labels and the vocabulary pins.

## Rules

- **Q1 — Schema changes amend the baseline.** Amend `schema.ts`, `0000_baseline.sql` and its snapshot; no migration. Keep the migration integration tests green, and check with `drizzle-kit generate` against a copy of the baseline that no schema change remains.
- **Q3 — Contract values that no producer emits are removed**, with the code that handles them, the docs and the tests.
- **D8 — Read validation stays.** Persisted readers keep validating the shape they read, with one fail-closed test per distinct reader; only the removed values leave the schemas.
- **Behavior preservation.** Every reachable ERP response is classified exactly as before: codes outside the empty permanent vocabulary already fall into the technical or transient paths. No change to retries, deferrals, cooldowns or the availability circuit.
- **No backward compatibility** (tests_cleaning index, project principle): no reader keeps tolerating the removed values.

## Procedure

1. Record the owner decisions P1–P3 above (done, 2026-09-27).
2. Verify the footprint at HEAD and post the concrete removal list (symbols, contract fields, enum values and columns, UI rows, docs, tests) in the completion handoff before editing.
3. Remove bottom-up: contracts, db schema and baseline, worker and Mock ERP, API, web, then docs. Update the tests at the boundary that owns each behavior; delete tests that only pin the removed vocabulary.
4. Run the repository search again; every remaining hit must have a current, unrelated meaning (for example the load-orchestrator completion rejection).

## Non-goals

- Changing how technical failures, capacity rejections, unavailability or timeouts are classified.
- Adding a real permanent-rejection path to the Mock ERP.
- Other dead code: [16 part 3](tests_cleaning/16_part3_remove_remaining_dead_code.md) owns it.

## Acceptance and validation

- The search terms above return only the known unrelated hits in `apps/*/src`, `packages/*/src`, `packages/db/drizzle`, `docs/`, `scripts/`, `working_docs/delivery_constraints.md` and the tests.
- `drizzle-kit generate` against a copy of the amended baseline reports no schema changes.
- No orphaned symbol, type member, enum value, column, UI row, fixture or documentation statement remains.
- Biome on touched files, `pnpm type-check`, `pnpm test:unit`, then `pnpm test:infra:up` and `pnpm test`.
- One commit, when the user asks.

Apply [AGENTS](../../AGENTS.md) and the [quality checklists](../../docs/quality_checklists.md).

## Completion handoff

- Date: 2026-09-27
- Commit:
- Owner decisions (P1–P3): all three recommendations accepted (2026-09-27): remove the order failure category, keep only `failedOrders`, reword delivery constraint 2.
- Removal list (posted before editing): `erpPermanentRejectionCodeValues`/schema, `permanent_rejection` ERP disposition, rejected ERP lookup branch, `OrderFailureCategory`/schema/values, `businessRejectedOrders` and `technicallyFailedOrders` summary/list/result fields, and cumulative `permanentRejected`; DB `erp_outcome_disposition.permanent_rejection`, `order_failure_category` enum, `orders.failure_category`, split dashboard queries and permanent attempt retention; worker classification, reconciliation, terminal handling and feedback; Mock ERP rejected lookup and terminal-code check; API projections; web business-rejection and split technical-failure rows and narratives. Update `docs/core_business_entities.md`, `docs/load_generation_metrics_streaming.md`, `docs/cross_service_conventions.md`, `docs/architecture.md`, and `working_docs/delivery_constraints.md`. Update affected contract, DB, worker, API and web tests listed in the footprint, plus DB vocabulary parity, worker order-processing integration and API ERP-status tests. Keep run-level `failureCategory` and load-orchestrator completion rejection.
- Checks run: Biome `check --write` on touched files (three transient I/O errors resolved by individual reruns), then `check` on all touched files passed; `pnpm type-check` passed (11 tasks and test types); `pnpm test:unit` passed (8 safety, 59 script, 1,543 package tests); `pnpm test:infra:up` passed (PostgreSQL and Redis healthy); `pnpm test` passed (the same unit tests, 333 API tests, 184 integration tests); `drizzle-kit generate` against a copy of the amended baseline reported no schema changes; final repository search found only the unrelated load-orchestrator completion rejection.
- Kept deliberately: run-level `failureCategory` and its public categories; load-orchestrator permanent API completion rejection and parked reports; existing technical, capacity, unavailability, timeout, retry, deferral, cooldown, and availability behavior. No unrelated dead code was changed.
