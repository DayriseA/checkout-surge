# Task 21 follow-up: Make traffic-completion enrichment first-write authoritative and safe to finalize

## Execution context

- **Execution order:** This is an immediate follow-up to Task 21 and should be completed before Task 22. Task 21 made normal finalization reuse the durable inventory snapshot, which makes the correctness of the writer and its enrichment-completeness boundary authoritative.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No donor branch or reference repository is required.
- **Solution approach:** Design the strongest solution justified by the current completion-delivery, admission-closing, and finalization workflows. The invariants below are requirements; the suggested implementation considerations are not a mandatory design.
- **Working expectations:** Verify all recorded locations and flow descriptions against the current checkout. Preserve the ownership boundaries and non-goals below. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this document as the durable implementation and handoff record. Preserve the original requirements, and record status, completed scope, material decisions or deviations, verification, and remaining blockers or follow-up work.

## Task details

- **Priority:** P1
- **Area:** API / traffic-completion durability / finalization
- **Source:** Task 21 implementation review
- **Solved elsewhere:** No. Task 9 made completion delivery durable and re-drivable, Task 10 made Redis admission close immediately after the durable draining transition, and Task 21 made finalization reuse the stored snapshot. Their combined current flow exposes the gap described here.
- **Primary locations:** `apps/api/src/services/demo-run-service.ts`, `apps/api/src/services/demo-run-finalization-service.ts`, `apps/api/test/demo-run-service.test.ts`, `apps/api/test/demo-run-finalization-service.test.ts`

`DemoRunService.recordTrafficCompletion()` currently exposes a run as `draining` before traffic-completion enrichment is durably complete. It first inserts the authoritative raw completion report and transitions the run to `draining` in one PostgreSQL transaction, then closes Redis admission, reads business outcomes and Redis inventory, and updates the finalization row in a later transaction. Duplicate deliveries reconstruct the first report but repeat the enrichment reads and update.

This creates two correctness risks:

1. A background finalization poll can observe the committed `draining` run and raw finalization row before enrichment finishes. Because an absent nested inventory snapshot is valid for legacy or failed-capture rows, Task 21 can legitimately persist `null` into the immutable run summary even though the original completion handler is about to persist a snapshot.
2. A duplicate or concurrent completion delivery can recapture later Redis state and overwrite `terminalInventorySnapshot`, `capturedAt`, `businessOutcomeAtTrafficCompletion`, and the sold-out reservation-outcome enrichment. The first accepted terminal observation is therefore not reliably authoritative.

## Required invariants

### Durable completion and enrichment state

- Keep the first accepted completion report authoritative. A conflicting duplicate must never replace its exit status, error, HTTP summary, delivery summary, diagnostics, or completion time.
- Represent whether enrichment is still pending or has durably concluded. Do not infer pending state merely from an absent `terminalInventorySnapshot`: legacy rows and completed capture attempts where Redis was unavailable legitimately have no snapshot.
- A run with pending completion enrichment must not be terminalized or receive a `demo_run_summaries` row. Pending enrichment is an incomplete finalization input, not a business-drain timeout condition.
- Preserve compatibility for rows created before the new completion marker/state. A migration or read rule must classify existing completed rows safely rather than leaving them permanently pending.

### First-enrichment authority

- Once completion enrichment has durably concluded, its `terminalInventorySnapshot` must be immutable. Duplicate delivery may re-drive sale closure, reconciliation, finalization, event publication, and acknowledgement, but it must not reread Redis to replace the saved snapshot or its original `capturedAt`.
- Preserve `businessOutcomeAtTrafficCompletion` as the outcome paired with that first completed enrichment. Normal finalization must continue to read the later PostgreSQL `BusinessOutcomeSummary` independently after business drain.
- Keep the durable `api_sold_out_decision` outcome consistent with the authoritative snapshot used for enrichment. A duplicate must not replace it with a later Redis counter merely because redelivery occurred later.
- A completed Redis capture failure remains an explicit no-snapshot result and finalizes as `null`; it must not silently become a later successful observation on duplicate delivery. A crash before an enrichment attempt durably concludes remains pending and must be safely repairable by redelivery.

### Concurrency, crash recovery, and acknowledgement

- Make concurrent same-run completion deliveries converge through a database lock, compare-and-set, or equivalently strong per-run serialization. A read-then-unconditional-update sequence is insufficient.
- Preserve Task 10's fail-closed admission behavior. Redis sale admission must remain closed before inventory snapshotting/finalization, and no retry may reopen it.
- Do not hold a PostgreSQL transaction open across a Redis call merely to simulate cross-system atomicity. PostgreSQL and Redis cannot share a transaction; model the intermediate state explicitly and make every transition idempotent.
- Preserve Task 9's durable acknowledgement contract: the orchestrator retains and retries its report until the API has completed all required re-drivable work. A crash after the initial claim, after Redis closure, after enrichment, or before terminal finalization must be recoverable without changing already-authoritative data.
- Startup and periodic recovery must not strand an enrichment-pending run if the request that claimed completion disappears before acknowledgement.

## Implementation considerations

- Prefer a small, explicit completion-enrichment boundary rather than expanding `DemoRunService.recordTrafficCompletion()` with more interleaved orchestration. Keep HTTP routes and composition roots unchanged except for necessary dependency wiring.
- An explicit durable pending/completed marker can distinguish an in-progress claim from legacy or failed-capture absence. If this requires a schema change, use a journaled migration with a safe existing-row backfill and update Drizzle schema/types consistently. A nested marker may avoid a column but still needs strict ownership, concurrency, and compatibility rules.
- Keep Task 21's snapshot extractor semantics intact once enrichment is complete: absent means `null`, present means strict `terminalInventorySnapshotSchema` validation, and there is no finalization-time Redis fallback.
- Do not rely on process-local flags or timing assumptions between `recordTrafficCompletion()` and `finalizeReadyRuns()`; API replicas and background polling may run concurrently.

## Focused verification

- Pause the first completion handler after its initial claim but before enrichment, run `finalizeReadyRuns()` or `finalizeRun()`, and prove the run remains non-terminal with no summary. Release enrichment and prove finalization writes the exact durable snapshot.
- Exercise concurrent conflicting completion deliveries. Assert first-report fields win, only one authoritative enrichment is committed, and the snapshot, `capturedAt`, traffic-completion business outcome, and sold-out aggregate cannot be overwritten by the later delivery.
- After enrichment commits, mutate or remove the corresponding Redis inventory and redeliver the completion report. Assert Redis is not recaptured and the stored finalization and terminal summary retain the original snapshot exactly.
- Inject failure after the initial claim/Redis closure but before enrichment persistence. Redelivery must repair the pending state and complete normally without reopening admission.
- Inject failure after enrichment commits but before finalization/acknowledgement. Redelivery must reuse the committed enrichment, create at most one summary, and complete acknowledgement safely.
- Make the first completed Redis capture attempt fail, then restore Redis before redelivery. Assert enrichment remains completed without a snapshot and the summary stores `null`, proving a retry does not attach later state.
- Retain existing first-report-wins, sale-closure, late-admission, latest-final-business-outcome, strict-invalid-snapshot, and one-summary idempotence coverage.
- Run the focused API service/persistence tests, shared build if package declarations are stale, API typecheck, API lint, and `git diff --check`. Do not run composition or characterization suites unless explicitly requested.

## Non-goals

- Do not revert Task 21 to a live Redis read or add a finalization-time fallback.
- Do not redesign the load-orchestrator outbox/journal, completion HTTP payload, or acknowledgement protocol beyond what is necessary to preserve the existing Task 9 contract.
- Do not change business-drain readiness, terminal failure precedence, traffic-delivery classification, or the later PostgreSQL business-outcome calculation.
- Do not change admin-reset, startup-interruption, or early-failure snapshot workflows except where shared compatibility logic is strictly required.
- Do not fold in Task 40's traffic-quality reconciliation, Task 57's broad JSON-column typing, or unrelated schema cleanup.

## Implementation record

- **Status:** Completed on 2026-07-13.
- **Scope completed:** Added an explicit `completion_enrichment_status` (`pending` / `completed`) to `demo_run_finalizations`. New traffic-completion claims explicitly start pending; the migration and schema default classify all pre-change and compatibility inserts as completed. Pending rows are excluded from the finalization poll and guarded in direct finalization before reconciliation or timeout logic, so they cannot terminalize or receive summaries.
- **Enrichment boundary:** Added `TrafficCompletionEnrichmentService`. It re-closes Redis admission before any capture, performs Redis and business-outcome reads without an open PostgreSQL transaction, strips API-owned enrichment keys from the raw traffic outcome, and uses a PostgreSQL compare-and-set from pending to completed. The winning transaction persists the nested snapshot/business outcome and matching `api_sold_out_decision` aggregate together. A Redis capture error deliberately concludes with no snapshot; other failures leave the row pending.
- **First-write and retry behavior:** `DemoRunService` still claims the first raw report with `ON CONFLICT DO NOTHING`, then delegates enrichment. Duplicate/concurrent delivery can re-drive closure, enrichment when pending, finalization, event publication, and acknowledgement, but completed enrichment skips Redis/business recapture. The compare-and-set makes the first durably concluded enrichment immutable even when attempts observed different Redis states.
- **Recovery:** Startup repair invokes pending completion enrichment for draining runs before pending-persistence reconciliation. The periodic lifecycle pass repairs all pending enrichment before polling ready finalizations. Both paths retain fail-closed admission behavior.
- **Migration:** Added journaled migration `0006_traffic_completion_enrichment_state.sql` and updated the Drizzle schema/journal. The default `completed` value safely backfills existing finalization rows; the production completion-claim insert is the sole path that explicitly requests `pending`. The DB migration integration test now proves a row created before the column is added becomes completed and adjusts the existing deliberate replay test to replay migrations 0004-0006 together.
- **Focused regression coverage:** Added coverage for paused claim versus direct/polled finalization, concurrent conflicting deliveries with distinct Redis observations, first-report authority, immutable snapshot/business outcome/sold-out aggregate after Redis mutation and redelivery, request redelivery repairing a pre-persistence enrichment failure, separate periodic repair of abandoned pending work, real terminal-writer retry after enrichment committed and the Redis inventory was removed, completed Redis capture failure remaining `null` after Redis restoration, startup recovery ordering, legacy compatibility, strict invalid snapshots, and one-summary idempotence.
- **Missing-inventory closure compatibility:** Re-driving closure continues only for the narrowly safe `InventoryNotInitializedError`: absent inventory cannot admit a buy, pending capture concludes as no-snapshot, and completed enrichment remains re-drivable without recapture. Redis connection failures and all other closure errors still propagate because fail-closed state cannot be established.
- **Documentation:** Updated architecture, core entity, and Redis hot-path documentation with the explicit state, compare-and-set ownership, no-transaction-across-Redis boundary, recovery behavior, and completed no-snapshot semantics.
- **Verification:** `pnpm test:db:migrate` passed. Focused API service/persistence tests passed (3 files, 66 tests). The focused DB integration file passed (1 file, 43 tests). `pnpm build:shared`, `pnpm --filter api type-check`, `pnpm --filter @checkout-surge/db type-check`, and API/DB lint passed. `git diff --check` passed.
- **Skipped / known issues:** The prohibited composition and characterization suites were not run. Root `pnpm type-check:test` still reports unrelated pre-existing errors in other API, load-orchestrator, and worker tests; the initially reported errors in this task's modified test file were corrected, and a filtered rerun reported no errors for the Task 21 follow-up test files. No remaining Task 21 follow-up blocker is known.
