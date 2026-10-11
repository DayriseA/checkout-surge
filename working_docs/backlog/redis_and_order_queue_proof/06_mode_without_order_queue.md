# 06 — Mode Without the Order Queue

**Design:** sections 4, 5 · **Depends on:** 02, after the owner's go

## Goal

A run can call the ERP inside the buyer's request, paced at the ERP's rate, so that a visitor sees the buyer paying for the back office's slowness.

## Scope

- The ERP call inside the request has a deadline, stops on a reset, and never leaves an order stuck when the ERP fails.
- The accepted answer is given after the ERP confirms, and says so.
- The same protections as the demo's mode.

## Done When

- A run in this mode behaves as designed under a slow ERP, covered by tests.

## Open Points

- None.

## Working Notes

### Buyer latency evidence foundation (2026-10-11)

Task 06 first prepares accepted and sold-out HTTP reply wall latency evidence before inline confirmation or hosted calibration. The load generator measures the complete `http.post` call after preparing its body and options. It retains existing valid queued `202` replies and recognizes `200` only with the `order_confirmed` outcome. The API's inline-confirmation workflow is a later implementation slice; this foundation does not add that response to the API.

Each nonempty exported cohort carries count, average and p95 through the existing HTTP summary JSON. Accepted reply counts include successful idempotent repeats. An empty or unusable cohort stays unknown. A complete exported Trend whose count agrees with its selected outcome counter remains usable despite stdout or live dashboard loss; exact native raw-proof reconciliation is a separate campaign gate. No live latency semantics, extra throughput fields, or database columns change.

An actual k6 binary must demonstrate exported Trend `count` and empty-cohort behavior before hosted calibration; the later primitive check is recorded below. A generated-script unit harness verifies classification and measurement wiring, not actual k6 aggregation behavior. The API persistence assertion is deferred to the later Task 06 integration slice because the completion/finalization test paths are frozen under the independent Task 05 review; existing persistence forwards the shared HTTP summary object intact.

Local validation used the existing Dev Container, serially with one test worker and no database infrastructure: touched TypeScript formatting/lint, contracts compilation, load-orchestrator source type-check, focused test type-check, all 164 contracts tests and all 214 load-orchestrator tests passed. The final job ran from 16:54:24 to 16:54:45 UTC (21 seconds); the container's reported available Linux memory was 6,317 MiB before and 6,251 MiB after, with no peak measurement. The first orchestrator run exposed three stale script-string assertions, updated in this slice. No local k6 executable was available, so the actual pinned-binary probe remains outstanding; no binary was downloaded and no image, reference/composition/characterization suite, or hosted campaign was run.

### ERP HTTP processing budget foundation (2026-10-11)

The existing ERP HTTP client accepts an optional absolute processing deadline and cancellation signal. It checks before configuration, after awaited configuration, and after awaited durable dispatch intent. A local stop before fetch sends no POST and records no fabricated HTTP outcome; an already-created intent remains unresolved. Actual HTTP waits use the shorter of the adaptive timeout and remaining processing time, and caller cancellation aborts the request. An interrupted dispatched request remains uncertain; a late canonical success and its special persistence-recovery semantics remain usable. Status lookup accepts the same narrow optional budget. Default queued callers retain their existing behavior.

This slice does not select the durable deadline, activate the inline mode, change scanners, or add a public response. The later worker authority must derive the deadline from original reservation acceptance and integrate cancellation/recovery; it must not treat a pre-fetch stop as observed downstream latency or turn elapsed buyer time into a business failure.

Serial Dev Container checks passed from 17:24:59 to 17:25:07 UTC: touched-file Biome, worker source and focused-test types, and 71 unit checks across the ERP client (42), reconciliation (12), and resilience policy (17), with a 1.90-second test duration. No infrastructure or cloud job was needed. Independent review and the supervisor's final two-file pass found no actionable defect. Reusable checks remain under ignored `.tmp/phase06-deadline/`.

### Actual k6 Trend export primitive (2026-10-11)

A one-iteration, no-HTTP probe ran from 17:27:09 to 17:27:10 UTC using only the cached load-orchestrator image `sha256:1f74bb9985e0778716a6b4e12c2e5ee9be28419edc3561bf7748be55a197a16c`. Its executable identifies as `k6 v2.0.0+dirty`, commit `8c3be52cc1-dirty`, Go `1.26.3`, Linux/amd64, SHA-256 `8867ca8641c4d8b46716b030e639b632e6c485687b8822de2ef45c15d1348e9c`. With the same `summaryTrendStats` as the generated script, samples of 12 and 28 ms exported count 2, average 20 ms and p95 27.2 ms; the unobserved sold-out Trend was absent while its initialized counter was zero. No zero latency sample was added.

The disposable container had no network, one CPU and a 256 MiB memory cap, a read-only root filesystem, and was removed with explicit absence verification. Peak memory was not measured. This establishes the actual binary's export behavior, not HTTP, application, load, capacity, or hosted image provenance. The rebuilt pinned runner's executable version and fingerprint must still be read back before the hosted calibration freeze. The probe, raw export log and checked summary remain under ignored `.tmp/phase06-k6-probe/`; the raw log SHA-256 is `6b96621cbefed2b1efec4ec0b832358f30e9afc7a59f8a343edab51a78244412`.

### API inline-confirmation foundation (2026-10-11)

`ReserveOrderService` now accepts either its real queued publisher or an inline confirmation port. Inline skips the service's three ORDER publication branches. It awaits the entire reservation workflow before confirmation, including admission/pending lock release, stock promotion and direct recovery cleanup. An accepted persistence response establishes canonical identity; its queued order shape is never confirmation evidence. A hold without durable order persistence returns `order_confirmation_pending` with `order: null` and does not call the worker. A retry retains the original reservation identity.

Public confirmed replies require a durable confirmed order and `confirmedAt`, and use `200 order_confirmed`. Unresolved, elapsed-window and durable-failure replies retain reservation/order identity with `503 order_confirmation_pending`, `504 order_confirmation_timed_out` and `502 order_confirmation_failed`, respectively. Failure requires durable failed status and `failedAt`; transport failure alone never establishes it. Existing queued `202` and stock rejection behavior stay unchanged. Public confirmation outcomes are separate from stock-decision vocabulary.

The prepared worker protocol is authenticated with the shared control-token header. `POST /internal/orders/confirm` carries only canonical `orderId`, `reservationId`, `saleOfferId`, `runId` and request `correlationId`. The worker must load original `securedAt` from durable storage and apply the shared 55-second processing window. The API transport uses only the remaining original window and performs no automatic retry. After expiry it uses `GET /internal/orders/confirmation-status` with the same fields as query parameters and a one-second status-read allowance. That endpoint must read durable state only, with no ERP processing or POST. Both worker endpoints return the shared `InlineConfirmationResult` as a successful protocol response, including typed pending/timeout/failure outcomes; HTTP/transport errors remain unresolved at the API. Already-terminal durable results remain readable after the processing deadline.

This foundation is intentionally unwired. It does not add a run mode, worker routes, worker execution, runtime configuration, comparison preset or public controls. `PendingPersistenceRecoveryService.materializeAndEnqueue` still owns a separate publication: mode-aware bypass, handoff after attempt/session close and durable lookup-only worker fallback must be integrated before activation. The existing five-second direct-recovery HTTP request remains separate from the later confirmation wait. No end-to-end inline readiness is claimed.

Serial validation in the existing Dev Container passed touched-file Biome, contracts build/types, API source and focused-test types, all 166 contract tests and 67 focused API tests from 17:33:49 to 17:34:15 UTC (26 seconds). An additional HTTP-availability assertion passed with the 15-case adapter/route suite at 17:35:00 UTC, bringing the unique focused API total to 68. Independent review and the supervisor's final twelve-file pass found no actionable defect. No database/Redis infrastructure, image build, hosted run or composition/characterization suite was used. Reusable checks remain under ignored `.tmp/phase06-api-confirmation/`.

### Worker inline-confirmation foundation (2026-10-11)

The trusted run vocabulary and fresh-database baseline now include `without_order_queue`. An optional service on the existing worker health listener implements the authenticated confirmation and durable-status protocol. Its PostgreSQL reader validates canonical order/reservation/run identity, loads original reservation acceptance and keeps terminal results readable after the processing window. Confirmation coalesces live callers and uses the existing handler, adaptive admission, declared ERP quota and durable processing-control claims, with matching generations in the job and delivery. No physical ORDER queue is used; successful orders retain the common BullMQ notification publication.

The service derives its 55-second budget from original `securedAt`, propagates cancellation/deadline through dispatch and reconciliation, and never treats a fulfilled handler or transport error as business confirmation. Unknown dispatched outcomes remain lookup-only during a buyer retry. A buyer disconnect, run cancellation or service close immediately aborts owned work and releases the buyer wait without awaiting durable settlement. Status is read-only. A stable future deferral sleeps until eligibility; a live lease is observed at bounded intervals because its owner can settle or release it before expiry. This avoids both needless polling during capacity waits and a stale lease hiding an early durable confirmation.

Cumulative affected validation passed 95 unique worker unit cases, three contract vocabulary cases and four actual integration cases, with source/focused-test types, touched-file Biome and whitespace checks. The integrations use PostgreSQL with a one-connection pool, real HTTP to a simulated ERP, the shared dispatch gate and actual common notification publication. An ERP HTTP callback performs SQL through that same pool, proving the processing path does not retain its connection across HTTP. They cover durable identity/deadline/terminal replay, capacity deferral and generations, cancellation with retained uncertainty and fresh-service lookup-only recovery, and immediate buyer retry while the previous handler still holds a lease beyond the original deadline.

Validation ran serially in the existing Dev Container. The final lease correction ran from 18:02:02 to 18:02:23 UTC, passing seven selected service cases and the new integration; unchanged previously green scopes were deliberately skipped. Memory samples were PostgreSQL 81.24 MiB of 512 MiB and Redis 5.195 MiB of 128 MiB, not peaks. Disposable one-CPU stores used a private network, no published ports and temporary filesystems; containers and network were explicitly absent on exit. Earlier fixture/timing failures were corrected without changing production retry policy; the final correction's first run exposed a test-only timer-mock isolation failure, fixed before the green run. Independent review and the supervisor's final correction pass were clear. Checks remain under ignored `.tmp/phase06-inline-worker/`.

This is still a foundation: real worker/API composition, durable background lookup recovery, pending-persistence publication bypass and post-session handoff, reset cancellation, and the full completion/finalization evidence test are the next integration slices. Trusted seeded runs and local HTTP do not establish hosted load or capacity readiness. No image build, hosted workload, reference/composition/characterization suite or production action was performed.
