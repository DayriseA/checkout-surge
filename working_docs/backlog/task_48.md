# Task 48: Record a terminal marker on the final ERP attempt

## Execution context

- **Execution order:** This is task 48 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** worker / audit trail
- **Source:** comparison (worse)
- **Reference context:** Inlined below. This task is standalone; implementation does not require access to another repository or branch.
- **Locations:** `apps/worker/src/application/erp-confirmation-client.ts:187`

Per-call attempt coverage is good (status, attempt number, latency, error detail), but the attempt/event payload has no terminal flag and final order failure is persisted separately — terminality must be inferred by joining, making the audit trail less faithful. Small contract + writer change.

## Verified current behavior

- `apps/worker/src/queue/bullmq-order-process-consumer.ts::processJob()` is the production source of delivery metadata. It passes `attemptNumber = job.attemptsMade + 1`, the pre-delivery `attemptsMade`, and `maxAttempts = normalizeMaxAttempts(job.opts.attempts)`. `normalizeMaxAttempts()` converts a missing, zero, or negative BullMQ value to `1`, so production deliveries have a known positive maximum even though `OrderProcessDeliveryMetadata.maxAttempts` is optional for non-BullMQ callers and tests.
- `apps/worker/src/application/erp-confirmation-client.ts::ErpAttemptRecord` carries the job and delivery metadata plus status, HTTP/error detail, latency, and timestamps, but no finality/disposition. `HttpErpOrderConfirmation.confirm()` records every actual ERP response, timeout, invalid response, and request failure before throwing the corresponding typed error. A reusable previously successful attempt causes an early return and no duplicate attempt row. Circuit-open rejection occurs in the outer `ErpCircuitBreaker` and is not an ERP call, so it creates no attempt record.
- `apps/worker/src/application/order-process-job-handler.ts::createOrderProcessJobHandler()` makes the retry/fail decision after the client has recorded the attempt. A failure is retried when `shouldRetryWithoutFailingOrder` says so, or when it is temporary and `hasRemainingAttempts(delivery)` is true. `hasRemainingAttempts()` is true only when `maxAttempts` is defined and `attemptNumber < maxAttempts`; therefore an unknown maximum is treated as having no proven retry remaining and the order is failed. Non-temporary ERP rejections fail immediately even when a numeric retry budget remains.
- `apps/worker/src/index.ts::isTemporaryConfirmationFailure()` classifies timeout, request, invalid-response, retryable HTTP response, and circuit failures as temporary. `shouldRetryWithoutFailingOrder()` special-cases attempt-persistence and circuit failures so they do not fail the order. Persistence failures produce no durable attempt marker; circuit-open failures produce no ERP attempt at all.
- `apps/worker/src/persistence/postgres-erp-attempt-persistence.ts::PostgresErpAttemptPersistence.recordAttempt()` atomically inserts an `erpAttempts` row and an `erp.attempt.succeeded`/`erp.attempt.failed` `orderEvents` row. The JSON event payload already contains `erpAttemptStatus`, `attemptNumber`, `attemptsMade`, latency, and optional HTTP/error detail, but not `maxAttempts` or a terminal flag.
- `packages/db/src/schema.ts::erpAttempts` and `packages/db/drizzle/0000_initial_schema.sql` have no finality column. The existing unique index on `(order_id, attempt_number)` provides attempt identity; the order/run indexes support existing reads.
- `packages/contracts/src/demo.ts::runHistoryErpAttemptSchema` and `apps/api/src/services/run-history-service.ts::RunHistoryService.detail()` expose recent `erpAttempts` rows, but omit finality. The separately returned order outcome/event timeline can show an eventual `order.failed`, yet the timeline projection deliberately omits `orderEvents.payload`, so adding only a JSON field would not make the run-history attempt record self-describing.
- `packages/contracts/src/erp.ts::erpLatestAttemptSummarySchema` and `apps/api/src/services/erp-status-service.ts::PostgresErpAttemptStatusReader` also read the table for operational health. They do not need finality to preserve their current purpose, but must continue parsing after the schema change.

## Inlined reference behavior

The reference implements the useful core idea in `checkout-forge/apps/worker/src/services/order-processing-service.ts::OrderProcessingService.processOrder()` and `checkout-forge/apps/worker/src/persistence/order-processing-persistence.ts::OrderProcessingPersistence.recordFailedAttempt()`:

- It computes `attemptNumber = job.attemptsMade + 1` and `terminalAttempt = attemptNumber >= getMaxAttempts(job, backpressureConfig)`. `getMaxAttempts()` prefers the run-scoped retry policy, then BullMQ's `job.opts.attempts`, and normalizes a non-finite/non-positive value to `1`.
- A thrown processing error is recorded with `terminal: terminalAttempt`. A structured ERP rejection is recorded with `terminal: terminalAttempt || !result.retryable`, so a non-retryable business rejection is terminal before the numeric budget is exhausted.
- `recordFailedAttempt()` writes `{ attemptNumber, terminal, errorCode, errorMessage, latencyMs }` into the `erp.attempt.failed` event payload. In the same transaction, `terminal: true` also changes the order to `failed` and appends `order.failed`; `terminal: false` leaves it processing.
- Successful attempts do not carry the flag in the reference because success is intrinsically terminal for ERP confirmation. The reference also does not store `terminal` on its `erp_attempts` table. Thus the donor proves the disposition rule and event shape, but its exact persistence shape is too narrow for Surge's separate `erpAttempts` run-history read model.

## Target contract and semantics

Use one field name consistently, preferably `terminal`, with this meaning: **the worker decided that this ERP call ends normal confirmation attempts for the order under the delivery and error classification known when the attempt was recorded**. It is not a promise that an operator/manual replay or a later persistence-recovery delivery can never occur.

- A succeeded attempt is `terminal: true`, independent of the configured maximum. It is reusable by `findSuccessfulAttempt()` and no later ERP call is needed.
- A failed/timed-out temporary attempt is `terminal: false` only when `delivery.maxAttempts` is known and `delivery.attemptNumber < delivery.maxAttempts`; it is `true` when the budget is exhausted.
- A non-temporary ERP rejection (for example a non-retryable 4xx response under `isTemporaryErpConfirmationError()`) is `terminal: true` even when attempts remain.
- If `maxAttempts` is absent, match the handler's existing conservative behavior: no remaining attempt is proven, so a recorded failure is terminal. Do not invent infinity or silently default this application-level case differently from `hasRemainingAttempts()`.
- Attempt-persistence errors have no successfully committed attempt row/event and therefore no marker. Circuit-open deferrals are not ERP attempts and remain unrecorded here. Do not manufacture attempt history for either case.
- Persist the classification made for that attempt; do not derive it later from current order state or a mutable retry policy. The order transition is still authoritative for customer-visible order status.

Avoid duplicating retry arithmetic in unrelated layers. Extract a small application helper (or equivalent shared predicate) beside `OrderProcessDeliveryMetadata`/the ERP client so the attempt marker and `hasRemainingAttempts()` use identical known/unknown-max semantics. For response failures, combine that delivery predicate with the existing retryability classifier rather than introducing a second HTTP-status vocabulary.

## Target persistence and read paths

1. Extend `apps/worker/src/application/erp-confirmation-client.ts::ErpAttemptRecord` with required `terminal: boolean`. Populate it at every actual-attempt construction path: valid success/failed ERP responses through `toAttemptRecord()`, request timeout, invalid response, and transport/request failure. Unit tests should not rely on a later order join to establish the value.
2. Add `terminal`/`is_terminal` to `packages/db/src/schema.ts::erpAttempts` and a new forward Drizzle migration; do not edit `0000_initial_schema.sql` as the upgrade mechanism for existing databases. Make new writes explicit even if the column has a migration default.
3. In `PostgresErpAttemptPersistence.recordAttempt()`, write `record.terminal` to the attempt row and mirror `terminal: record.terminal` into the attempt event payload in the same transaction. Mirroring keeps low-level event audits self-contained, while the normalized column supports attempt-history reads without JSON extraction or an order join.
4. Add required `terminal: z.boolean()` to `packages/contracts/src/demo.ts::runHistoryErpAttemptSchema`; select it in `RunHistoryService.detail()` and map it in `toRunHistoryErpAttempt()`. This is the public read path that fulfills the task's standalone attempt-history goal.
5. `erpLatestAttemptSummarySchema`/`toLatestAttemptSummary()` may remain unchanged because the ERP health endpoint reports dependency health rather than audit disposition. If product/API expectations require finality there too, add it deliberately to both schema and mapper in the same change; do not accidentally expose it merely because the status reader currently selects whole rows.

The event timeline contract currently omits payload. Do not broaden `runHistoryEventTimelineEntrySchema` to expose arbitrary JSON just for this task: the typed `RunHistoryErpAttempt` is the safer public surface. A future typed event-payload union can expose `terminal` without weakening the strict timeline contract.

## Migration, backfill, indexing, and compatibility

- Existing rows have no perfectly authoritative terminal bit. A defensible backfill marks successful rows terminal; marks earlier failures before a later success nonterminal; and, for orders currently failed, marks only that order's latest failed/timed-out attempt terminal. Rows for queued/processing orders, interrupted transitions, or externally replayed histories are ambiguous. Prefer a staged nullable/backfill/constraint migration or explicitly document a conservative `false` default for ambiguous legacy rows; never claim the backfill reconstructs the original worker decision exactly.
- If the environment treats demo history as disposable and resets it during deployment, state that operational assumption and still use a forward migration. Do not rewrite migration history already applied elsewhere.
- No new index is needed for writing or returning the field. Keep `erp_attempts_order_attempt_unique`, `erp_attempts_order_id_idx`, and `erp_attempts_run_id_idx`; add a terminal-specific index only with a demonstrated query filtering by terminality.
- Adding a required field to the strict `RunHistoryErpAttempt` response changes fixtures and generated/handwritten consumers. Update contract tests, API run-history tests, and any web history fixtures/rendering in lockstep. For a rolling mixed-version deployment, first add the database column/default and tolerant optional/nullable response handling, deploy writers, backfill, then make the public field required. A single-version demo deployment can land these atomically.
- Preserve the `(order_id, attempt_number)` uniqueness and transaction atomicity. A duplicate/redelivered attempt must not create conflicting terminal values. This task does not redesign the existing recovery behavior when attempt persistence succeeds but the subsequent order transition fails.

## Focused verification

- ERP client unit tests use delivery metadata with remaining attempts, exhausted attempts, and absent `maxAttempts`; assert exact records for success, retryable 5xx, non-retryable 4xx, timeout, invalid response, and transport failure. Expected terminal values are respectively true; false/true by budget; true regardless of spare budget; and false/true by budget for the temporary error classes.
- Handler/retry tests prove the marker agrees with behavior: `terminal: false` failures are rethrown for retry without transitioning the order to failed, while terminal failures take the existing failed transition. Include the direct-call unknown-max case so it cannot diverge from `hasRemainingAttempts()`.
- Persistence integration coverage proves the attempt row and matching event payload receive the same boolean atomically for successful, retryable failed, terminal failed, and timed-out attempts; a transaction failure leaves neither artifact. Existing duplicate-attempt uniqueness remains enforced.
- Migration/schema coverage starts from the previous migration, applies the new one, verifies the backfill policy on representative successful/retried/failed histories, and confirms new rows cannot omit finality after the rollout stage chosen above.
- Contract/API tests prove run-history returns terminality directly on each attempt without consulting the order or event collection, accepts both `true` and `false`, rejects missing/non-boolean values once required, and preserves ordering/truncation/count behavior.
- Existing ERP status-reader tests still pass with the added database field and unchanged health response shape. No app or broad end-to-end suite is required for this focused worker/audit change.

## Scope and non-goals

- This task owns finality classification for actual ERP calls, its durable attempt-row/event representation, the typed run-history projection, migration/backfill policy, and tests at those boundaries.
- Preserve current retry counts, error retryability vocabulary, circuit-breaker behavior, order transition semantics, successful-attempt reuse, correlation/run identity, and transaction boundaries except for carrying the marker.
- Do not create attempt rows for circuit-open deferrals or persistence failures, change BullMQ retry policy, infer customer order status from the marker, expose arbitrary event JSON, add speculative indexes, redesign recovery for split attempt/order transactions, or broaden the ERP health endpoint without an explicit API requirement.
