# Task 02: Build a durable PostgreSQL-to-BullMQ order-dispatch handoff (transactional outbox or autonomous scanner)

## Execution context

- **Execution order:** This is task 2 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the context needed to work from the current checkout. No access to donor branches or the reference repository is expected.
- **Solution approach:** No previously evaluated implementation is prescribed for this task. Design the strongest solution justified by the current behavior, architecture, constraints, and non-goals.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P0
- **Area:** API / buy pipeline durability
- **Source:** independent review (high)
- **Solved elsewhere:** none — shared defect; Opus and GLM also commit durable rows before enqueue with no outbox or re-drive. Design fresh.
- **Locations:** `apps/api/src/services/reserve-order-service.ts:246`, `apps/api/src/services/reserve-order-service.ts:263`

The reservation, queued order, and initial events commit before the BullMQ enqueue, with no transactional outbox and no background scan for undispatched queued orders. If enqueue fails or the process dies in that window, the only repair is a later request with the same idempotency key; a buyer who never retries leaves a permanently queued order and the run drains to timeout. Fix with a transactional outbox or an autonomous scanner that re-drives queued orders without a job. Design together with entry 3 — they are one ownership problem.

## Working record

- **Status:** implementation complete.
- **Completed scope:** Added a worker-owned PostgreSQL queued-order dispatch scanner. It selects bounded, oldest-first orders whose status is still `queued` and whose age exceeds a configurable minimum, reconstructs validated `OrderProcessJob` payloads, and reasserts BullMQ jobs with deterministic `orderId` job IDs. The scanner starts and stops with the worker, prevents overlapping scans, isolates per-order publish failures, retries candidates on later scans, and exposes failure logging/reporting. Added worker BullMQ publisher, PostgreSQL adapter, config/env/Compose defaults, lifecycle wiring, and focused scanner/publisher/persistence/config tests.
- **Material decisions:** Chose autonomous worker scanner over API-owned outbox so committed rows remain recoverable after API crashes and API routes stay thin. The scanner intentionally does not alter reservation/idempotency or pending-hold behavior (Task 03 remains separate). A nonnegative minimum queued age avoids racing the immediate API enqueue while preserving eventual recovery; deterministic BullMQ identity makes races and repeated scans harmless.
- **Verification:** `pnpm --filter worker type-check`; `pnpm --filter worker build`; `pnpm --filter worker test:unit` (51 passed); `pnpm --filter worker test:integration` (24 passed, including the new PostgreSQL/BullMQ repeated-scan recovery workflow); `pnpm --filter worker lint`; root `pnpm lint`; Biome checks/formatting on changed worker files; root `pnpm type-check`; `git diff --check`. The first integration attempt was blocked until `docker-compose.test.yml` PostgreSQL/Redis were started, then passed. Root `pnpm format:check` still reports three unrelated pre-existing formatting violations outside this task.
- **Remaining follow-up:** No Task 03 reconciliation behavior was added. Broader cross-service topology verification remains owned by task 01/normal release checks.
