# Task 06: Make admin reset a fenced terminal transition (no admission or job cleanup after the summary is written)

## Execution context

- **Execution order:** This is task 6 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0
- **Area:** API / maintenance / lifecycle
- **Source:** independent review (high)
- **Solved elsewhere:** none — shared defect; Opus has the same reset-vs-normal-finalization race.
- **Locations:** `apps/api/src/services/demo-maintenance-service.ts:65`, `apps/api/src/services/demo-maintenance-service.ts:112`, `apps/api/src/services/reserve-order-service.ts:159`

Reset commits the immutable failed summary **before** closing Redis eligibility and cleaning queues, so a `/buy` that passed the durable gate can reserve, persist, and enqueue after the outcome was captured — and queue cleanup may then delete the new job. Reset reports success while secured business state is absent from the immutable summary. Sequence reset as: fence the terminal transition first (see entry 5), close admission, drain/clean, then write the summary. Reset **workflow completeness** (traffic aborter, ERP chaos reset, dashboard clear) is entry 34.

## Implementation record

- **Status:** Implemented the focused fenced reset lifecycle and race coverage.
- **Completed scope:** Admin reset now claims terminal status before closing Redis eligibility, refuses success when closure fails, drains/cleans queues, then rereads business state and inserts immutable summaries in one all-or-none transaction. Fenced `admin_reset` runs without a summary remain selectable so a later reset retries safely; reset calls are serialized by a process-wide static queue, and only a concurrent losing call coalesces no-candidate cleanup while an independent terminal-only reset still cleans. Generated-run persistence, lookup/materialization, and BullMQ enqueue now execute under one PostgreSQL session advisory admission lock (the same key as terminal claim), with commit-before-enqueue preserved on the reserved session; pending reconciliation uses the same wrapper. Split terminal claim and summary insertion while preserving atomic ordinary finalization semantics.
- **Decisions/deviations:** Persistence allows `starting`, `active`, and `draining` writes for normal in-flight traffic, but rejects `completed`/`failed` with truthful `run_terminal` error semantics while retaining definitive compensation classification. First-attempt reset diagnostics preserve prior statuses; retries omit unavailable prior fields, reuse the authoritative original `finalizedAt`, and record the later snapshot capture time separately. Queue/ERP/dashboard cancellation remains Task 34.
- **Verification:** `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-maintenance-service.test.ts test/demo-run-finalization-service.test.ts test/reserve-order-service.test.ts test/pending-persistence-reconciler.test.ts` (49 passed); `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/api.test.ts` (53 passed); final focused rerun `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/demo-maintenance-service.test.ts` (9 passed); `pnpm --filter api type-check` (passed); `pnpm exec biome check apps/api/src/services/demo-maintenance-service.ts apps/api/src/services/terminal-demo-run-transition.ts apps/api/src/services/postgres-buy-persistence.ts apps/api/src/services/reserve-order-service.ts apps/api/src/services/pending-persistence-reconciler.ts apps/api/test/demo-maintenance-service.test.ts` (passed); `git diff --check` (passed).
- **Blockers/follow-ups:** None known. The prohibited composition and characterization suites were not run.
