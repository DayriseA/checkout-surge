# Task 16 — Converge outcome and error vocabulary

## Execution context

Task 16 of 45, Phase 3. Primary ownership is `@checkout-surge/contracts` for public schemas/types and API runtime error handling for error/correlation vocabulary. DB enum/schema and worker/web are consumers. Follow the checklist: preserve thin routes, use services for workflows, and change every producer/consumer with a vocabulary cutover.

## Why

Overlapping buy outcomes, mechanical error-code variants, and single-value enums/tables make callers translate distinctions that do not change behavior, HTTP status, or UI.

## Required outcome

Audit contract buy/error/lifecycle/dashboard vocabularies, API runtime errors/routes/services, DB enums, worker, and web. Retain only values that alter behavior, status, operator meaning, or UI. Remove mechanical duplicate codes, overlapping outcome names, and single-value enum/table machinery where a plain invariant/literal is clearer. API owns error and correlation vocabulary; update all producers, consumers, tests, and docs together.

## Scope and concrete current paths

- `packages/contracts/src/buy.ts`, `error.ts`, `lifecycle.ts`, `dashboard-events.ts`, `entities.ts`, `demo.ts`, index exports, and vocabulary tests.
- `apps/api/src/runtime/errors.ts`, routes/services, correlation plumbing, and API tests.
- `packages/db/src/schema.ts`, Drizzle baseline/meta, vocabulary-parity tests; `apps/load-orchestrator/src/` outcome/error producers and tests; worker outcome/error producers and web displays/tests.

## Retained behavior and non-goals

Do not collapse correctness failures, authorization/validation distinctions, retry decisions, correlation IDs, or UI states that are materially different. This is not permission to alter transport accounting (task 15), load-process lifecycle or completion-redelivery ownership (tasks 33–34), or database invariants (task 17). Prefer explicit literal invariants only when the removed enum/table had one possible value.

## Acceptance

- [ ] Each retained value has a documented behavior/status/UI consequence and one canonical owner.
- [ ] Duplicate/overlapping values and single-value machinery are removed from contracts, API and load-orchestrator runtime, DB, worker, web, docs, and tests.
- [ ] API errors retain stable correlation behavior and routes only map validated service failures to HTTP responses.
- [ ] DB constraints and contract validators use the reduced vocabulary consistently.
- [ ] Focused tests distinguish retained correctness failures rather than merely snapshotting renamed strings.

## Focused verification

Run `pnpm --filter @checkout-surge/contracts test:unit`, `pnpm --filter @checkout-surge/db test:unit`, `pnpm --filter api test:api`, worker/web affected tests, and package type-checks. Run DB integration tests if enum/schema changes. Do not run composition or characterization suites.

## Working record

### Retained-vocabulary matrix

| Distinction | Canonical owner | Consequence that requires retaining it | Removed terms / replacement |
| --- | --- | --- | --- |
| Public buy outcome: `reservation_secured`, `reservation_pending_persistence`, `sold_out`, `run_not_accepting_traffic`, `inventory_not_initialized`, `idempotency_conflict`, `quantity_invalid` | Contracts; API maps outcome to HTTP | Changes HTTP status, `Retry-After`, retry/ambiguity handling, or k6 accepted/sold-out accounting | Remove duplicate response `reason`, `x-checkout-rejection-reason`, and buy `simulatedStatus`; use `outcome` once. Internal Redis `idempotent_replay` remains a stock decision but projects publicly as `reservation_secured`. |
| Durable reservation fact | DB row plus contracts | Row existence proves a secured hold and remains distinct from the order; `reservation.secured` remains a produced timeline fact | Remove unproduced `rejected`, `released`, and `expired` durable statuses/events and the copied `status: secured` field; a reservation row/hold is secured by construction. |
| Order lifecycle: `queued`, `processing`, `confirmed`, `failed` | Contracts and DB | Drives worker transitions, retry/finality, timestamps, diagnostics, dashboard and Run History UI | Remove `customerStatus`/simulated-purchase copies; consumers use order `status`. |
| Request/auth/lookup HTTP categories: `invalid_request`, `operator_mode_required`, `admin_passphrase_required`, `control_token_required`, `admin_session_required`, `admin_origin_required`, `public_visitor_forbidden`, `resource_not_found`, `inventory_not_initialized`, `preset_operation_not_allowed`, `public_override_not_allowed` | API/web producers constrained by contracts | Selects 400 correction, 401 authentication, 403 authorization/origin, or 404 lookup behavior; `inventory_not_initialized` is 404 for the inventory-status lookup, while its separate buy-outcome use is documented above | One resource lookup code replaces resource-specific not-found codes; semantic preset restrictions share one 400 action category. |
| Rate/capacity HTTP categories: `admin_login_rate_limited`, `dashboard_recovery_rate_limited`, `dashboard_sse_source_limit_exceeded`, `public_run_budget_exceeded`, `dashboard_recovery_unavailable`, `dashboard_sse_at_capacity` | Web/API admission boundaries constrained by contracts | 429 means the caller/source or global fixed window must back off; 503 means process-local recovery concurrency or total realtime capacity is unavailable, or the recovery deadline expired. `Retry-After` is emitted where the admission policy has one; exact recovery failure is `details.reason` | Local recovery capacity and timeout share `dashboard_recovery_unavailable` with `at_capacity` or `timed_out` details. Fixed-window exhaustion remains `dashboard_recovery_rate_limited`; the removed Redis limiter has no separate unavailable mode. |
| Domain-conflict HTTP categories: `run_conflict`, `preset_conflict`, `traffic_report_rejected`, `run_cleanup_conflict`, `idempotency_conflict`, `load_orchestrator_run_mismatch`, `traffic_execution_conflict` | API, Mock ERP, and load-orchestrator boundaries constrained by contracts | 409 preserves state/ownership/idempotency conflicts that must not be retried as a new valid mutation; exact grouped cause is retained in structured details | Active/reset/missing-sale run conflicts, preset slug/archive conflicts, and cleanup conflicts use one category per caller action rather than mechanical variants. |
| Validation HTTP categories: `invalid_run_configuration`, `invalid_runtime_policy`, `invalid_chaos_configuration` | API/Mock ERP constrained by contracts; validation modules own cause details | 400 identifies which submitted configuration must change; accepted-run/runtime-policy failures retain `details.violationCode` and `details.path`, while chaos failures retain cap/actual evidence in fields such as `details.latencyMs.maximum`/`actual` | Deployment/public/default policy permutations are not public error codes; Mock ERP cap failures share one chaos category without discarding their structured limits. |
| Dependency/server HTTP categories: `service_misconfigured`, `backend_unavailable`, `service_unavailable`, `invalid_backend_response`, `internal_error`, `inventory_unavailable`, `queue_status_unavailable`, `load_orchestrator_unavailable`, `load_orchestrator_abort_unconfirmed`, `load_orchestrator_start_ambiguous`, `traffic_termination_unconfirmed` | Owning API/web/load boundary constrained by contracts | Distinguishes operator configuration, safe 500, 502 invalid/unconfirmed upstream results, and retryable 503 readiness/availability; start/abort ambiguity prevents unsafe lifecycle guesses | Mechanical upstream response variants share action-oriented unavailable/unconfirmed categories without exposing infrastructure bodies. |
| Correlation ID | API plus logger transport convention; contracts validate bodies | Header/body agreement and cross-service tracing across API, mock ERP, load orchestrator, and web BFF | No replacement or weakening. |
| Sale purpose `catalog` / `generated_run`; preset visibility `public` / `admin`; operator mode `public` / `admin` | Contracts and DB; API authorizes | Selects run ownership/eligibility, public listing/edit restrictions, visitor budget enforcement, and privileged controls | Retained because these values change authorization and inventory admission, not presentation wording. |
| Demo-run lifecycle `starting`, `active`, `draining`, `completed`, `failed` | Contracts and DB; API owns transitions | Gates new-run conflicts, metric/completion admission, finalization, teardown, and current/history UI | No collapse: each state changes allowed workflows or terminal UI. |
| Traffic execution lifecycle `not_started`, `starting`, `active`, `succeeded`, `failed` | Contracts; load orchestrator owns execution and API records it | Controls start replay, abort/completion redelivery, draining admission, and traffic UI independently from business finalization | Kept distinct from demo-run lifecycle because traffic can be terminal while business work drains. |
| Traffic enrichment `pending` / `completed` and delivery quality `complete`, `warning`, `degraded`, `failed` | Contracts and API finalization | Enrichment gates terminalization/redelivery; delivery quality changes Run History/operator interpretation without changing run lifecycle | Retained as workflow state and derived evidence, not duplicate HTTP outcomes. |
| ERP attempt `succeeded`, `failed`, `timed_out`; recovery job `pending`, `enqueued`, `escalated`, `resolved`; pending persistence `pending_reconciliation`, `reconciled` | Contracts and DB; worker/API recovery owners | Changes retry/finality, recovery scanning/escalation, durable hold convergence, diagnostics, and finalization blockers | These internal durable states remain separate from public HTTP error codes. |
| Completion display `queued`, `processing`, `delayed`, `retrying`, `confirmed`, `failed`, `notification_recorded` | Contracts; DB projection derives, web renders | `delayed`/`retrying` depend on timing/attempt evidence and `notification_recorded` depends on the specific notification timestamp; each changes operator UI | Retained derived UI vocabulary while the removed `customerStatus` copy carried no independent state. |
| Durable event names `reservation.secured`, `order.queued`, `order.processing`, `order.confirmed`, `order.failed`, `notification.recorded`, `inventory.updated`, `erp.attempt.failed`, `erp.attempt.succeeded`; realtime categories `load.run.updated`, `dashboard.metric.observed`, `order.status.updated`, `business.event.recorded`, `business.outcome.snapshot` | Contracts; producer services | Selects append-only timeline semantics, realtime union validation, reducer routing, recovery behavior, and operator diagnostics | Unproduced reservation events and generic status-to-event helpers are removed. |
| Metric categories `traffic.scheduled_request_rate`, `traffic.latency`, `traffic.failure_rate`, `queue.depth`, `inventory.remaining`, `inventory.sold_out_rejection`, `order.consistency_lag` | Contracts; API/load/worker producers and web reducer | Selects unit/schema, aggregation/watermark, dashboard signal, and final interpretation | Retained because each names a different measured quantity and reducer slot. |
| Queue identity | Queue constants in contracts | Semantic/physical names select real BullMQ resources and dashboard dimensions | Remove single-value `queueNameValues`/enum machinery; validate the existing literal directly. |
| Simulated notification record | DB row plus notification job/event contracts | Row existence and `recordedAt` prove the only implemented simulated follow-up; it contributes to finalization/history | Remove single-value `recorded` status and unimplemented channel variants; notification row/job is the specific recorded-email workflow. |
| Durable sold-out aggregate | DB run-scoped sold-out-count row | Preserves Redis losing-path count until final summary/reset | Replace generic `demoRunReservationOutcome` name/source enums and columns with one run-keyed sold-out count record; Redis provenance is inherent in this specific capture path. |
| Operational/internal diagnostics | Owning DB/worker/load module | Changes retry, recovery, lifecycle, or operator diagnosis inside that owner | Do not merge persistence reasons, worker diagnostic codes, PostgreSQL codes, or Zod issue codes into public HTTP error vocabulary. |

### Implemented cutover

- Buy contracts and API responses now carry the public decision once as `outcome`. The rejection-reason header/body fields and simulated purchase status are removed. Redis still owns `idempotent_replay` as a persistence-control result, while the API and generated k6 script accept only the public `reservation_secured` projection.
- Reservation rows, Redis holds, accepted idempotency records, and order-event payloads no longer copy `status: secured`. The unproduced rejected/released/expired reservation schemas, enums, events, columns, constraints, indexes, and generic event helpers are removed. The produced `reservation.secured` event remains.
- Order status is the one downstream lifecycle vocabulary. `customerStatus` is removed from order reads and realtime events, and durable event payloads no longer copy the status already expressed by `order.<transition>`.
- The canonical HTTP error tuple is reduced to client/operator action categories. Direct accepted-run validation emits `invalid_run_configuration`; runtime-policy definition validation emits `invalid_runtime_policy`; both preserve the exact internal violation code and path in `details`. API, Mock ERP, load orchestrator, and web BFF producers use the reduced tuple. Persistence, retry, PostgreSQL, worker, and validation-library diagnostics remain locally owned.
- Every demo-run preset mutation route maps service validation at the HTTP boundary. Public fixed-window budget exhaustion is 429; grouped run, preset, cleanup, and dashboard-recovery categories retain exact causes in `details`. Removed one-off codes include the preset slug, missing run sale offer, and dashboard capacity variants.
- Queue schemas validate the existing queue-name literal directly. Notification jobs and rows represent the specific recorded simulated-email fact without channel/status fields. Run History renders only its recorded timestamp.
- The notification unique index and ORM relationship both express at most one notification row per order.
- The generic reservation-outcome aggregate is replaced by one `demo_run_sold_out_counts` row per run. Redis uses the `inventory:{saleOfferId}:sold-out` hash with `count` and `latest_observed_at`; DB source/outcome/id columns and enums are removed.
- The empty-database `0000` baseline and snapshot were updated in place. Reservation/order attribution triggers now treat reservation row existence as the secured backing fact while retaining correlation, offer, run, and quantity integrity.
- Correlation plumbing was intentionally unchanged. Contract and API tests continue to require response-header/body agreement and proxy rejection of inconsistent upstream envelopes.
- Architecture, entity, cross-service convention, Redis hot-path, and prior working-record documentation now describe the reduced vocabulary.

### Verification record

- `pnpm type-check` — passed all eight packages and root test fixtures.
- `pnpm lint` — passed (397 files). Biome check on all 72 changed TypeScript/TSX files passed. The repository-wide format check still reports unrelated pre-existing formatting diagnostics in unchanged files, so only the Task 16 change set was formatted.
- `pnpm --filter @checkout-surge/contracts test:unit` — 109 passed.
- `pnpm --filter @checkout-surge/db test:unit` — 49 passed.
- `pnpm --filter @checkout-surge/db test:integration` — 77 passed.
- `pnpm --filter @checkout-surge/db test:db:migrate` — passed against the fresh baseline.
- `pnpm --filter load-orchestrator test:unit` — 124 passed.
- `pnpm --filter worker test:unit` — 91 passed.
- `pnpm --filter worker test:integration` — 47 passed.
- `pnpm --filter web test:unit` — 239 passed.
- `pnpm --filter mock-erp test:unit` — 65 passed.
- Focused API policy suite — 74 passed.
- Focused API public runtime-policy route mapping — 1 passed (88 skipped), including canonical 404 response parsing and response header/body correlation.
- Focused API preset/budget route mapping — 5 passed (83 skipped), including response header/body correlation and structured details.
- Focused dashboard route suite — 7 passed.
- Focused demo-run and maintenance service suites after grouped-cause corrections — 103 passed.
- `pnpm --filter api test:api` — 477 passed; only the three known pre-existing uniqueness-race durable-winner tests failed (`reservations_pkey`, `reservations_reservation_token_unique`, and the wrapped-cause variant).
- The full API result above is the initial Task 16 run; after the review correction pass, the affected route/service suites were rerun rather than claiming a new fully passing full-suite command.
- `git diff --check` — passed.
- Forbidden composition and characterization suites were not run.

### Acceptance review

- [x] Each retained value has a documented behavior/status/UI consequence and one canonical owner.
- [x] Duplicate/overlapping values and single-value machinery are removed from contracts, API and load-orchestrator runtime, DB, worker, web, docs, and tests.
- [x] API errors retain stable correlation behavior and routes only map validated service failures to HTTP responses.
- [x] DB constraints and contract validators use the reduced vocabulary consistently.
- [x] Focused tests distinguish retained correctness failures and validate that retired public fields/codes are rejected.
