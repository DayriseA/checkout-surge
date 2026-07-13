# Task 21: Reuse the durable terminal inventory snapshot at finalization instead of a live Redis re-read

## Execution context

- **Execution order:** This is task 21 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** API / finalization
- **Source:** independent review (medium)
- **Solved elsewhere:** No donor checkout is required. The current branch already writes the needed durable snapshot; only the finalization read path must be adapted. The standalone implementation map is below.
- **Locations:** `apps/api/src/services/demo-run-finalization-service.ts:156`, `apps/api/src/services/demo-run-finalization-service.ts:227`, `apps/api/src/services/demo-run-service.ts:570`

Finalization ignores the durably-persisted Redis-derived inventory snapshot and performs a fresh live Redis read whose errors become `null` — a transient Redis outage during the final poll permanently strips inventory detail from the immutable run summary even though PostgreSQL holds the exact terminal snapshot.

## Standalone implementation context

### Durable value and exact JSON shape

- `apps/api/src/services/demo-run-service.ts`, `DemoRunService.recordTrafficCompletion()`, is the existing writer. Before changing the run to `draining`, it reads Redis once through `DemoRunService.captureTerminalInventorySnapshot()`. Inside the same PostgreSQL transaction as the traffic-completion record, it inserts the snapshot under `demo_run_finalizations.traffic_outcome_summary.terminalInventorySnapshot`:

  ```json
  {
    "terminalInventorySnapshot": {
      "saleOfferId": "<uuid>",
      "startingStock": 1000,
      "remainingStock": 125,
      "reservedStock": 875,
      "acceptedReservations": 875,
      "soldOutRejections": 42,
      "pendingPersistenceCount": 0,
      "capturedAt": "2026-06-20T00:00:05.000Z",
      "source": "redis"
    }
  }
  ```

- The surrounding `trafficOutcomeSummary` also preserves the load generator's original keys and adds `businessOutcomeAtTrafficCompletion`; do not assume the object contains only the two API-added keys. `packages/db/src/schema.ts` intentionally types `demoRunFinalizations.trafficOutcomeSummary` as a generic JSON object, so the snapshot is nested there rather than in a dedicated column. No migration is needed.
- The authoritative validator and TypeScript type are `terminalInventorySnapshotSchema` and `TerminalInventorySnapshot` in `packages/contracts/src/inventory.ts`. The schema is strict and requires all eight numeric/string fields shown above plus `source: "redis"`.
- `recordTrafficCompletion()` inserts `demoRunFinalizations` with `onConflictDoNothing` on `runId`. Therefore the first accepted traffic-completion report, including its snapshot and `capturedAt`, is the durable record to reuse; finalization must not recapture or timestamp it again.
- The same traffic-completion transaction upserts `demo_run_reservation_outcomes` for `api_sold_out_decision`. That row feeds the later, current `BusinessOutcomeSummary`; it is not a reason to reconstruct or modify the saved inventory snapshot.

### Current read/write flow and required adaptation

1. `DemoRunFinalizationService.finalizeRun()` in `apps/api/src/services/demo-run-finalization-service.ts` already selects `{ run: demoRuns, finalization: demoRunFinalizations }` with a left join.
2. `decideFinalization()` correctly reads the latest durable business outcome and waits for business-drain blockers (or the configured timeout).
3. Once ready, it currently calls `captureTerminalInventorySnapshot()`, which calls `getInventoryStatus()` against live Redis, substitutes the later finalization time for `capturedAt`, combines in later business counts, and returns `null` after logging when Redis is unavailable. This is the faulty path.
4. Read `input.finalization.trafficOutcomeSummary.terminalInventorySnapshot` from the row already passed to `decideFinalization()`, validate it with `terminalInventorySnapshotSchema`, and pass that exact validated value as `FinalizationDecision.terminalInventorySnapshot`. A small local extractor in `demo-run-finalization-service.ts` is sufficient. Treat an absent property as `null` for pre-snapshot/failed-capture rows; if the property is present, use the strict contract validator rather than silently reshaping it or falling back to Redis.
5. Remove the now-unused finalization-only recapture code: `captureTerminalInventorySnapshot()`, `readSoldOutRejections()`, and their imports of `getInventoryStatus`, `demoRunReservationOutcomes`, and Drizzle `and` if nothing else uses them. Keep the service's Redis dependency: `publishTerminalRunEvent()` still uses it, and its failure remains best-effort/logged.
6. `PostgresTerminalDemoRunSummaryWriter.write()` in `apps/api/src/services/terminal-demo-run-transition.ts` is already the correct persistence boundary. It writes the supplied value to `demo_run_summaries.terminal_inventory_snapshot`; `RunHistoryService` later exposes that summary. Neither component needs a behavior change.

Keep these two time-varying views distinct: `businessOutcome` is deliberately re-read from PostgreSQL at finalization after drain, while `terminalInventorySnapshot` is the immutable Redis-derived observation captured at traffic completion. Do not overwrite snapshot fields such as `acceptedReservations`, `soldOutRejections`, or `capturedAt` with later values.

### Backward compatibility, caveats, and non-goals

- Older finalization rows and traffic completions where the original Redis capture failed may have no nested `terminalInventorySnapshot`; preserve existing nullable summary behavior for those rows and still allow finalization to complete.
- Do not use a live-Redis fallback when the durable property is absent or invalid. A fallback recreates the outage/race bug and can attach state from a later point in time. Present-but-invalid JSON is durable-data corruption and should follow the repository's existing strict schema-validation behavior rather than being hidden by a fresh read.
- Do not add a `demo_run_finalizations.terminal_inventory_snapshot` column, change the traffic-completion payload contract, alter drain readiness/failure-reason logic, recalculate business outcomes, or change dashboard event publishing. Admin-reset and startup-reconciliation terminal snapshots are separate workflows and are outside this task.

### Focused verification

- Update `apps/api/test/demo-run-finalization-service.test.ts` at the service/persistence boundary. Seed `demoRunFinalizations.trafficOutcomeSummary` with a complete, distinctive `terminalInventorySnapshot`, then make the corresponding Redis inventory absent or observably different before `finalizeRun()`. After business work is settled, assert the run finalizes and `demoRunSummaries.terminalInventorySnapshot` exactly matches the durable nested object, including its original `capturedAt` and counts. This test must fail under the current live re-read implementation.
- Cover the legacy/failed-capture shape by seeding `trafficOutcomeSummary` without `terminalInventorySnapshot`; assert finalization still succeeds and the immutable summary stores `null`.
- Retain the existing assertions that the latest PostgreSQL `BusinessOutcomeSummary` is written after drain and that repeated finalization creates only one summary. Relevant checks are the API package's focused finalization-service test and its typecheck/lint commands; no Redis-driven behavioral assertion should be necessary for choosing the snapshot after the change.

## Implementation record

- **Status:** Completed on 2026-07-13.
- **Scope completed:** `DemoRunFinalizationService` now extracts `trafficOutcomeSummary.terminalInventorySnapshot` from the joined durable finalization row, returns `null` only when that property is absent, and uses `terminalInventorySnapshotSchema.parse()` when it is present. The validated durable value is carried through the readiness decision and written unchanged after the final PostgreSQL business-outcome and drain-blocker rereads. Finalization-only snapshot recapture and sold-out lookup code were removed; Redis inventory reads remain for both pending-count readiness checks, and Redis remains the terminal dashboard-event transport.
- **Regression coverage:** The service/persistence test seeds a distinctive durable snapshot whose counts, stock, and capture time differ from both live Redis and the latest PostgreSQL business outcome, then proves exact summary persistence and one-summary idempotence. Separate cases prove absent legacy/failed-capture data finalizes with `null` and present-but-invalid data fails strict validation without terminalizing the run.
- **Documentation:** Updated `docs/redis_inventory_hot_path.md` and `docs/core_business_entities.md` to distinguish the traffic-completion snapshot from the later PostgreSQL business-outcome read and to document absent-versus-invalid behavior.
- **Known pre-existing writer discrepancy / follow-up:** The current `DemoRunService.recordTrafficCompletion()` claims completion first and performs snapshot/outcome enrichment in a later transaction; duplicate completion handling can update that enrichment. This differs from the standalone context's same-transaction/first-enrichment-authoritative description. Per Task 21's ownership boundary, writer and duplicate-delivery behavior were not changed here. The repair is tracked in [Task 21 follow-up](./task_21_followup.md).
- **Verification:** `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-run-finalization-service.test.ts` passed (1 file, 14 tests). `pnpm --filter api test:api -- test/demo-run-finalization-service.test.ts` was interpreted by the wrapper as the full API suite and also passed (24 files, 249 tests). `pnpm --filter api lint` passed cleanly (67 files). `pnpm build:shared && pnpm --filter api type-check` passed: all three shared-package builds succeeded and API `tsc -p tsconfig.json --noEmit` exited 0. `git diff --check` passed.
- **Skipped:** The prohibited composition and characterization suites were not run by design.
