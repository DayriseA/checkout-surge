# Task 40: Give the API ownership of delivery-quality classification and reconcile k6 counters against durable evidence

## Execution context

- **Execution order:** This is task 40 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** API / finalization accounting
- **Source:** comparison (worse, three topics)
- **Solved elsewhere:** none required at implementation time. The relevant `checkout-forge` behavior, formulas, vocabulary, caveats, and Checkout Surge adaptation are inlined below.
- **Locations:** `packages/contracts/src/load.ts:134`, `apps/api/src/services/demo-run-finalization-service.ts`

The API completion contract requires the incoming report to already contain a traffic-delivery status and the finalizer trusts it, mapping only a stored `failed` to major shortfall. No unexpected-response terminal reason, no accepted-vs-durable reconciliation, and the completion report omits several delivery dimensions — so the run-control plane cannot independently detect a bad benchmark.

## Standalone reference findings

### API-owned delivery classification

The useful Forge implementation is `checkout-forge/apps/api/src/services/traffic-delivery-classifier.ts`. It exports `classifyTrafficDelivery()` and `withTrafficDeliveryStatus()` and deliberately derives status from counters rather than trusting the load runner's label:

```ts
export const warningShortfallRatio = 0.01;
export const failureShortfallRatio = 0.05;

requestShortfall =
  summary.requestShortfall ??
  Math.max(0, summary.plannedEmittedAttempts - summary.observedRequests);
shortfallRatio = requestShortfall / summary.plannedEmittedAttempts;

0                         => "complete"
0 < ratio <= 0.01         => "warning"
0.01 < ratio <= 0.05      => "degraded"
ratio > 0.05              => "failed"
```

If neither explicit shortfall nor observed-request evidence is available, Forge returns `null` rather than inventing a status. Its contract makes `plannedEmittedAttempts` positive, so division by zero is impossible. `DemoRunFinalizationService.observeTrafficReport()` normalizes the received summary with `withTrafficDeliveryStatus()` before persistence; `getTrafficSummaries()` normalizes again when reading stored data, which also protects rows written before the rule existed. Only authoritative `failed` maps to terminal reason `traffic_delivery_major_shortfall`; warning and degraded delivery can complete after business drain.

Forge tests in `apps/api/test/traffic-delivery-classifier.test.ts` pin the boundaries with a plan of 100: shortfalls 0, 1, 5, and 6 produce `complete`, `warning`, `degraded`, and `failed`. They also prove fallback derivation from `planned - observed` and no classification without observation evidence. `apps/api/test/load-metrics.api.test.ts` proves that dropped or unstarted iterations alone do not downgrade a run when request shortfall is zero. Those fields are diagnostics; request delivery is the quality input.

Checkout Surge currently does the opposite. `apps/load-orchestrator/src/application/k6-output-parser.ts::K6RunAccumulator.trafficDeliverySummary()` labels traffic in the producer using delivery ratios `< 1`, `< 0.95`, and `< 0.8`, and also forces `failed` for any unexpected response. `packages/contracts/src/load.ts::trafficDeliverySummarySchema` requires that producer label. `apps/api/src/services/demo-run-finalization-service.ts::deriveFailureReason()` parses and trusts it. The task must replace this authority flow, not merely duplicate the same producer calculation in the API.

### Unexpected responses are a separate terminal reason

Forge's `getTrafficOutcomeFailureReason()` returns the exact reason `traffic_outcome_unexpected_responses` whenever `K6TrafficOutcomeSummary.unexpectedResponses > 0`. This check is independent of traffic-delivery shortfall; an unexpected HTTP result is a correctness failure, not evidence that too few requests were emitted. The contract source is `packages/contracts/src/load.ts::k6TrafficOutcomeSummarySchema`, and the k6 counter source is `checkout_unexpected_responses` in the Forge load runner.

Checkout Surge already has the raw evidence at `TrafficHttpSummary.unexpectedResponses` and currently mirrors it into the untyped `trafficOutcomeSummary` object. Use the typed `httpSummary.unexpectedResponses` as the canonical input. Add `traffic_outcome_unexpected_responses` to the documented/typed failure-reason vocabulary if this task introduces a failure-reason schema; do not continue encoding this condition as `traffic_delivery_major_shortfall` or generic `traffic_failed`.

Preserve Surge's existing drain ownership: a quality failure still waits for accepted business work to settle before the immutable terminal summary is written. If business work itself exceeds the drain deadline, keep `business_drain_timeout` as the reason; otherwise use this precedence inside quality evaluation: unexpected responses, API-classified major shortfall, then actual traffic-process failure (`traffic_failed`). This avoids abandoning durable work merely because the benchmark response was bad.

### Duplicate-aware accepted-response reconciliation

Forge keeps raw response counts and unique durable records as different quantities. `checkout-forge/apps/api/src/services/accepted-reservation-accounting.ts` implements:

```ts
expectedDurableAcceptedReservations =
  completeDuplicateBuyerSpikeDelivery
    ? Math.ceil(acceptedResponseCount / 2)
    : acceptedResponseCount;
```

The duplicate collapse is allowed only when all of these are true:

- traffic mode is `buyer-spike` and `duplicateEachBuyerAttempt` is true;
- delivery says `trafficMode === "buyer-spike"`;
- `plannedEmittedAttempts === buyerCount * 2`;
- `completedIterations === buyerCount * 2`;
- `requestShortfall === 0`;
- `unstartedIterations` is either unavailable (`null`) or zero.

This guard matters. A complete idempotency-check run sends two requests with the same idempotency key per buyer, so both can be accepted HTTP responses while only one reservation/order exists. Forge's focused fixture uses 200 buyers, 400 emitted/completed requests, 100 accepted responses, and 50 durable confirmed orders; it completes successfully with 50 accepted reservations. `Math.ceil` also gives one unique reservation for a single observed accepted response, although a fully delivered duplicate fixture should normally produce an even count. Outside the fully evidenced duplicate case Forge does not guess that response pairs completed; it uses the raw accepted count.

Forge finalization obtains durable evidence from `DemoRunFinalizationRepository.getDrainState()`:

- `durableOrderCount = orderStatuses.length`;
- `pendingCount = pendingPersistenceCount`;
- `durableAcceptedEvidenceCount = durableOrderCount + pendingCount`;
- `unaccounted = max(0, expectedDurable - durableEvidence)`;
- `underreported = max(0, durableEvidence - expectedDurable)`.

Unaccounted responses keep the run draining and eventually fail with `api_request_lifecycle_accepted_response_accounting_timeout` (API lifecycle evidence) or `accepted_reservation_accounting_timeout` (k6 outcome evidence). Durable evidence exceeding the traffic counter is treated as telemetry underreporting and recorded as warning `k6_outcome_counter_underreported`, not as loss of durable work. A k6 count exceeding coherent API/durable evidence can be recorded as `k6_outcome_counter_overreported`. Forge also bounds accepted statuses by plan and stock, doubling stock capacity for a duplicate buyer-spike run.

For Surge, use the already typed sources instead of importing Forge repositories or its API lifecycle service:

- raw accepted responses: `demoRunFinalizations.httpSummary`, parsed by `trafficHttpSummarySchema`, field `acceptedResponses`;
- durable secured reservations and pending reconciliation: `readBusinessOutcomeSummary()` in `packages/db/src/business-outcome-dashboard.ts`, fields `acceptedReservations` and `pendingPersistenceCount`;
- durable orders: `queuedOrders + processingOrders + confirmedOrders + failedOrders`; do **not** add `retryingOrders`, because it is a diagnostic subset of processing orders and would double-count;
- run configuration: `acceptedRunConfigSnapshotSchema.parse(run.configSnapshot)`;
- delivery completeness: the enriched, API-normalized delivery summary described below.

At the settled boundary (`pendingPersistenceCount === 0`, no queued/processing/retrying orders, and notifications complete), require unique expected accepted responses to be accounted for by durable reservations/orders. Keep reservation and order comparisons visible rather than hiding inconsistencies behind one sum: every settled secured reservation should have one order, while pending persistence is only temporary evidence during drain. If expected accepted responses exceed durable evidence, remain draining until the existing deadline and then fail with the specific reason `accepted_response_accounting_timeout`. If durable reservations/orders exceed the expected traffic count, preserve the durable result, complete if all other conditions pass, and append a structured diagnostic warning such as `traffic_outcome_counter_underreported` with raw accepted responses, normalized expected count, reservation count, order count, and duplicate-normalization flag. Do not fail or create/delete records to make counters agree.

Donor caveat: Forge also reconciles an in-process `ApiRequestLifecycleSummary.completedResponsesByStatus` and uses reasons prefixed `api_request_lifecycle_*`. Surge's current `apiRequestLifecycleSummary` is an untyped producer JSON object containing only aggregate completed/failed counts, so those checks cannot be copied honestly. This task should reconcile the typed k6 HTTP summary against durable DB evidence. Introducing full API request-lifecycle instrumentation is outside scope.

### Rich delivery summary contract and data sources

Forge's `packages/contracts/src/load.ts::loadTrafficDeliverySummarySchema` carries:

```ts
{
  trafficMode,
  plannedBuyers,               // buyer spike only; otherwise null
  plannedEmittedAttempts,
  scheduledRatePerSecond,      // arrival-rate only; otherwise null
  configuredDurationSeconds,   // arrival-rate only; otherwise null
  preAllocatedVUs,             // arrival-rate only; otherwise null
  maxVUs,                      // arrival-rate only; otherwise null
  observedRequests,
  droppedIterations,
  completedIterations,
  unstartedIterations,
  requestShortfall,
  trafficDeliveryStatus        // API-derived; optional on input in Forge
}
```

Forge's `apps/load-orchestrator/src/load-runner.ts::summarizeTrafficDelivery()` takes plan fields from the accepted traffic config and concrete k6 execution plan, and terminal observations from summary-export metrics (with point-stream fallback). Its exact derived diagnostics are:

```ts
unstartedIterations =
  completedIterations === null || droppedIterations === null
    ? null
    : Math.max(0, planned - completedIterations - droppedIterations);

requestShortfall =
  observedRequests === null
    ? null
    : Math.max(0, planned - observedRequests);
```

Adapt the names to Surge's existing `plannedRequests` / `emittedRequests` vocabulary rather than renaming every consumer. Extend `TrafficDeliverySummary` with `trafficMode`, `plannedBuyers`, `scheduledRatePerSecond`, `configuredDurationSeconds`, `preAllocatedVUs`, `maxVUs`, `completedIterations`, `unstartedIterations`, and `requestShortfall`. Keep `droppedIterations`. Use nullable fields where a metric/mode does not supply evidence; zero means observed zero and must not mean unavailable.

The Surge producer sources are concrete:

- `apps/load-orchestrator/src/application/k6-script.ts::generateK6Script()` already constructs the scenario and knows buyer count, scheduled rate, duration, and the effective VU values (including fallback formulas). Return or pass a typed execution-plan summary to `K6RunAccumulator`; do not scrape the generated script.
- `K6RunAccumulator.observe()` already counts `http_reqs` and `dropped_iterations`; add the `iterations` terminal count at this boundary. Its `emittedRequests` is the observed-request count.
- Compute `unstartedIterations` and producer `requestShortfall` with the formulas above. The API must recompute authoritative shortfall from `plannedRequests` and `emittedRequests` even if the producer supplies `requestShortfall` or a legacy status.
- Buyer spike: `plannedBuyers = buyerCount`; scheduled rate, duration, and VU pool fields are `null` (the executor directly uses one VU per buyer).
- Steady arrival rate: `plannedBuyers = null`, `scheduledRatePerSecond = ratePerSecond`, `configuredDurationSeconds = durationSeconds`, and the VU fields are the exact effective values used in the k6 scenario.

## Required target behavior and ownership map

1. `@checkout-surge/contracts` owns the input and persisted shapes. The completion input must no longer require callers to classify quality. Prefer a distinct completion-input schema where `trafficDeliveryStatus` is optional/ignored and an authoritative stored/history schema where it is required. Add nullable rich delivery fields with defaults if legacy completion payload compatibility is required. Do not make the final run-history status optional.
2. The load orchestrator owns raw measurements and execution-plan facts only. It emits planned/emitted, outcome counters, iteration counters, and plan dimensions; it does not decide whether a run is warning/degraded/failed.
3. The API application layer owns classification. Add a small pure classifier beside the finalization service (or an equivalently focused API service), normalize before writing `demoRunFinalizations`, and normalize again when consuming existing rows. The shared thresholds are 1% warning ceiling and 5% degraded ceiling. Do not put formulas in `demo-run-routes.ts`.
4. `DemoRunFinalizationService` owns terminal precedence and durable reconciliation. Extend `decideFinalization()`/`deriveFailureReason()` rather than the route. Read `httpSummary`, normalized delivery, accepted config, and `BusinessOutcomeSummary` as typed values.
5. `PostgresTerminalDemoRunSummaryWriter` remains the atomic terminal writer. Persist the normalized delivery summary and any structured accounting warning through the existing `loadRunDiagnosticsSummary` JSON unless a typed diagnostics contract is introduced in the same narrow change.
6. Startup/admin-reset synthetic summaries in `demo-run-startup-reconciliation-service.ts`, `demo-maintenance-service.ts`, and `demo-run-service.ts` must populate valid enriched defaults from the run config. They are not real k6 observations: completed/emitted are zero, unstarted/request-shortfall equal the planned request count, and mode-specific plan fields still come from config.

## Compatibility and edge semantics

- Existing stored rows may contain only `{ plannedRequests, emittedRequests, droppedIterations, trafficDeliveryStatus, notes }`. Parsing/normalization must tolerate and enrich them with nullable defaults. Recompute their status from planned/emitted; never preserve a contradictory legacy producer label.
- Existing completion callers may still send `trafficDeliveryStatus` during rollout. Accepting but ignoring it is safer than allowing it to remain authoritative. New callers should omit it.
- The accepted configuration guarantees a positive real plan, but the current delivery schema accepts zero. Avoid `NaN`/division by zero: either tighten actual completion input to positive planned requests, or have the classifier return no classification and fail validation for a zero-plan real completion. Do not silently label zero/zero as a successful benchmark. Synthetic pre-start terminal summaries are built from a valid positive config plan.
- Clamp shortfall at zero so overshoot (`emittedRequests > plannedRequests`) remains `complete` for delivery classification. Preserve the overshoot counts for diagnostics; do not truncate observations.
- A nonzero `droppedIterations` or `unstartedIterations` is diagnostic only when request shortfall is zero. A nonzero unexpected-response count always produces its own correctness failure.
- Duplicate normalization is configuration- and completeness-dependent, never a general division of accepted responses. Do not halve steady-arrival runs, nonduplicate buyer spikes, or incomplete duplicate delivery.
- Finalization retries must remain idempotent: no duplicate summary, warning, event, reservation, or order may be created. Reconciliation is read-only accounting over existing evidence.

## Focused verification examples

1. Pure API classifier with `plannedRequests = 100`: emitted 100/99/95/94 produces complete/warning/degraded/failed. Explicitly cover overshoot and the zero-plan guard. Supply a forged incoming status opposite to the counters and prove the stored/history status follows counters.
2. Unexpected result: complete delivery, `unexpectedResponses = 1`, settled business state, successful k6 exit. Expect terminal `failed` with `traffic_outcome_unexpected_responses`, not major shortfall or generic traffic failure.
3. Major shortfall and drain: planned 100/emitted 90 plus a processing order remains draining; after that order settles and its notification exists, expect `traffic_delivery_major_shortfall` and the normalized failed delivery summary.
4. Duplicate idempotency run: 200 buyers, duplicate enabled, planned/emitted/completed 400, unstarted 0, shortfall 0, raw accepted responses 100, 50 secured reservations, 50 settled orders. Expect normalization to 50 unique accepts and successful completion with no accounting timeout.
5. Duplicate guard: use the same configuration with incomplete delivery. Prove the API does not blindly halve raw accepts. The result must remain draining/fail accounting as dictated by the available durable evidence, rather than falsely completing.
6. Missing durable evidence: 25 normalized accepted responses but only 20 reservations/orders. Before deadline expect draining with an accounting blocker; at deadline expect `accepted_response_accounting_timeout`.
7. Counter underreport: 24 normalized accepted responses but 25 coherent reservations/orders. Expect completion plus one `traffic_outcome_counter_underreported` warning; assert exact diagnostic counts and that durable rows are unchanged.
8. Rich summary, both modes: assert buyer-spike buyer count/null rate/null VUs, and steady-arrival scheduled rate/duration/effective preallocated/max VUs. Cover completed/dropped/unstarted/request-shortfall formulas and unavailable iteration evidence (`null`, not zero).
9. Compatibility: parse a legacy stored delivery summary, normalize its status, and expose all new nullable fields. Repeated finalization must still produce one immutable terminal summary and one terminal transition.

Run the focused contract, load-orchestrator accumulator, API finalization, and run-history tests, followed by the relevant package typechecks/lint. Infrastructure integration coverage is required for the durable reconciliation cases because their correctness depends on PostgreSQL reservation/order projections; no k6 process or browser is needed for those tests.

## Non-goals

- Do not add full API request-lifecycle instrumentation or copy Forge's `ApiRequestLifecycleService` and `api_request_lifecycle_*` checks.
- Do not change reservation, idempotency, inventory, queue, ERP, notification, or worker behavior to make telemetry counts agree.
- Do not create/delete durable records during reconciliation; durable evidence is authoritative and reconciliation is read-only.
- Do not move quality classification into HTTP routes, DB adapters, the terminal writer, or the web UI.
- Do not redesign all diagnostics JSON or all historical failure-reason storage beyond the vocabulary needed here.
- Do not fail solely because k6 dropped/unstarted iteration diagnostics are nonzero when the observed request shortfall is zero.

## Implementation record

- **Status:** Implemented on 2026-07-14.
- Contracts now distinguish compatible completion delivery evidence (legacy producer status accepted but optional) from authoritative stored/history delivery summaries (API status required), with nullable enriched plan and iteration fields and a positive-plan completion guard.
- The load orchestrator now emits raw request, iteration, and exact execution-plan evidence without classifying traffic quality. Synthetic API terminal paths use config-derived enriched summaries with zero emitted/completed/dropped observations and planned unstarted/request-shortfall counts.
- The API normalizes delivery on completion persistence and history/finalization reads using 1% warning and 5% degraded ceilings, a zero-plan guard, clamped shortfall, and overshoot-safe classification.
- Finalization now gives unexpected responses their own terminal reason, waits for business drain, conditionally normalizes fully evidenced duplicate buyer spikes, reconciles k6 accepted responses against PostgreSQL secured reservations and non-duplicated order totals, times missing evidence out as `accepted_response_accounting_timeout`, and records coherent counter underreporting as a structured diagnostic without mutating durable rows.
- PostgreSQL-backed tests cover exact duplicate normalization, the incomplete duplicate guard, missing-evidence draining/timeout, counter underreport preservation, unexpected-response precedence, legacy history normalization, and retry idempotency. Contract and load-orchestrator tests cover input/stored compatibility, classifier thresholds/zero-plan/overshoot, both traffic modes, and unavailable iteration evidence.
- Documentation was updated in `docs/load_generation_metrics_streaming.md` and `docs/core_business_entities.md`.
- Verification passed: `pnpm --filter @checkout-surge/contracts test:unit` (72 tests), focused load-orchestrator test file (71 passed, 1 skipped), `pnpm --filter api test:api` (353 tests, including PostgreSQL-backed finalization/history cases), package typechecks for contracts/load-orchestrator/API, and package lint for those three packages.
- `pnpm type-check:test` was also attempted. It remains red on pre-existing test-workspace errors outside this task (including dashboard admission mocks, worker/logger tests, missing web `server-only` declarations, and unrelated API fixture typing); Task 40-specific type errors were resolved and each changed package typecheck passes.
- Per repository instructions, `pnpm test:composition` and `pnpm test:characterization` were not run.
- Review cycle 1 tightened the authoritative stored/history schema so every enriched field has a stable nullable output key while completion evidence remains optional, pinned diagnostic-only dropped/unstarted behavior and contradictory producer-shortfall normalization, and proved repeated finalization leaves PostgreSQL reservation/order row counts unchanged while writing exactly one underreport warning.
