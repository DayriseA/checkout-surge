# Task 41: Restore buy outcome headers and tighten the k6 request script (discard bodies, quantity source, correlation header)

## Execution context

- **Execution order:** This is task 41 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P2
- **Area:** contracts / load-orchestrator
- **Source:** comparison (worse, two topics) + independent review (low)
- **Standalone reference context:** the relevant reference behavior, exact vocabulary, adaptation decisions, and verification targets are inlined below; no other repository or branch is required.
- **Locations:** `packages/contracts/src/buy.ts:16`, `apps/api/src/routes/buy-routes.ts:37`, `apps/load-orchestrator/src/application/k6-script.ts:68`, `packages/contracts/src/load.ts:20`

The API emits no outcome headers (only `retry-after` on pending persistence), so the k6 script parses the response-body outcome on every request — heavier per-VU work and a direct regression from the baseline contract. The script also sends `quantity` from the inventory config's quantity-per-checkout while ignoring the traffic config's quantity-per-attempt (a diagnostic with values 3 and 7 emitted 7; seeds currently set both to 1), omits the correlation header, and cannot drop overscheduled work in-script.

## Inlined reference findings

The useful reference implementation has three deliberately small ownership points:

1. Its shared buy contract declares `buyOutcomeHeaderName = "x-checkout-outcome"` and `buyRejectionReasonHeaderName = "x-checkout-rejection-reason"`. It also declares schemas for the permitted header values. The outcome header vocabulary there is `reservation_secured | reservation_pending_persistence | reservation_rejected`; rejection reasons use the same domain rejection-reason schema as the JSON response.
2. Its thin `/buy` route validates the service result, derives the status, always writes `x-checkout-outcome` for a valid buy-domain response, and writes `x-checkout-rejection-reason` only for `reservation_rejected`. It then sends the unchanged validated JSON response. Correlation response-header production remains in the existing HTTP/correlation layer, so these classification headers do not replace `x-correlation-id`; pending-persistence retry behavior is likewise independent.
3. Its generated k6 script sets top-level `options.discardResponseBodies: true`, reads the two classification headers with a case-insensitive helper, sends the same per-request correlation ID in both the JSON body and `x-correlation-id`, and returns before `http.post()` when a steady-arrival iteration index is at or above `plannedEmittedAttempts`. The purchase option is typed as `quantity: 1`, so every reference attempt buys exactly one unit.

The exact reusable reference request is constructed as:

```js
http.post(apiBaseUrl + buyEndpointPath, JSON.stringify({
  runId,
  saleOfferId,
  quantity,
  idempotencyKey,
  correlationId,
}), {
  headers: {
    "content-type": "application/json",
    "x-correlation-id": correlationId,
    "x-load-run-id": runId,
  },
  tags: { runId, saleOfferId, trafficMode, attemptNumber },
});
```

The response classifier treats `202` plus `reservation_secured` or `reservation_pending_persistence` as accepted, and `409` plus `reservation_rejected` plus reason `sold_out` as sold out; anything else increments `checkout_unexpected_responses`. `readResponseHeader(response, headerName)` iterates over `response.headers`, compares `key.toLowerCase()` to the already-lowercase contract name, and returns `null` when absent. This is important because k6's response-header key casing must not become part of the contract.

For buyer-spike traffic, the reference derives identity from `exec.vu.idInTest - 1` and `exec.vu.iterationInScenario`: duplicate attempts retain one idempotency key per buyer but have unique correlation IDs and attempt numbers. For steady arrival, it derives identity from `exec.scenario.iterationInInstance`; when `globalIteration >= plannedEmittedAttempts`, identity is `null` and the default function returns without emitting an HTTP request. Otherwise the iteration gets a unique idempotency key and correlation ID.

## Checkout-Surge adaptation map

Do not copy the reference response vocabulary blindly. Checkout-Surge's `packages/contracts/src/buy.ts` already exposes the more granular body outcomes `reservation_secured`, `idempotent_replay`, `reservation_pending_persistence`, `sold_out`, `inventory_not_initialized`, `idempotency_conflict`, and `quantity_invalid`. Keep those response bodies and status mappings unchanged. Add and export the two header-name constants and header-value schemas beside the existing buy schemas, using Surge's current outcome and rejection vocabularies as the source of truth. The least surprising mapping is:

- `x-checkout-outcome`: the exact validated `response.outcome` for every response described by `buyResponseSchema`.
- `x-checkout-rejection-reason`: `response.reason` only for responses described by `reservationRejectedResponseSchema`; omit it for secured, replay, and pending-persistence responses.
- `x-correlation-id`: retain the route's existing normalized correlation response header and send that same per-attempt value as a request header from k6.
- `retry-after`: retain it only for `reservation_pending_persistence` exactly as today.

This preserves the public JSON contract while giving high-volume clients a body-free discriminator. Validation errors and other generic `ApiHttpError` responses are not `buyResponseSchema` outcomes and should not be assigned fabricated checkout outcome headers by an error handler.

In `apps/api/src/routes/buy-routes.ts`, set the classification headers only after `buyResponseSchema.parse()` succeeds, alongside status and `retry-after` selection. Keep the route thin: it should select headers/status from the validated service result, not recreate reservation decisions. Prefer imported contract constants over route-local string literals.

In `apps/load-orchestrator/src/application/k6-script.ts`:

- Add `discardResponseBodies: true` alongside `scenarios` in exported k6 `options`, then remove `response.json("outcome")` and its `try/catch` entirely.
- Embed the shared outcome/rejection header names into the generated source and use a case-insensitive response-header reader. Classify accepted responses from Surge's vocabulary: all legitimate `202` outcomes (`reservation_secured`, `idempotent_replay`, and `reservation_pending_persistence`) count as accepted. Count sold out only when status is `409`, outcome is `sold_out`, and the rejection reason is `sold_out`. Missing, contradictory, or all other status/header combinations count as unexpected.
- Preserve the existing `http.expectedStatuses(202, 409)` callback unless the task deliberately broadens expected HTTP behavior. Thus non-business failures such as `400`/`503` remain k6 HTTP failures as well as unexpected checkout responses; a sold-out `409` remains an expected business response.
- Build one per-attempt correlation ID, put it in the body, and add `[correlationIdHeaderName]: correlationId` to request headers. Keep `x-load-run-id`, `content-type`, and `accept` behavior. Do not send the run-level start-request correlation ID unchanged on every buy.
- Source request `quantity` from `input.configSnapshot.trafficConfig.quantityPerAttempt`, not `inventoryConfig.quantityPerCheckout`. The reference fixes quantity to literal `1`, but Surge intentionally has separate traffic and inventory fields and surfaces both in its UI/history. The smallest behavior-preserving repair is to honor the traffic field. A separate product decision may later constrain both contracts to literal `1`; do not silently collapse them in this task.
- Include `plannedRequests` in generated configuration and guard the steady-arrival request path before constructing/sending the request. Use the iteration identity that actually drives steady request IDs and return when it is greater than or equal to the plan. Buyer-spike already has an exact `vus * iterations` plan and does not require the cap, though using a harmless common cap is acceptable if duplicate-buyer identity semantics remain intact.

The current buyer-spike script deliberately uses one idempotency key per VU when duplicate attempts are enabled. Preserve that property: the two attempts must have the same idempotency key but different correlation IDs. Any identity refactor inspired by the reference must also preserve uniqueness for non-duplicate attempts and the existing single-process execution assumptions; do not introduce per-instance IDs that collide if distributed k6 execution is later enabled.

## Metrics and delivery caveats

Discarding bodies changes only client-side retention/parsing; the API must still return contract-valid JSON for ordinary callers. Header classification should continue feeding the existing Surge counter names `checkout_reservation_accepted`, `checkout_sold_out`, and `checkout_unexpected_response` unless a separate metrics-vocabulary task changes the parser and completion schemas together.

An in-script early return prevents an overscheduled HTTP request, but k6 can still count that invocation as a completed `iteration`; it does not automatically increment k6's `dropped_iterations`. Keep these concepts distinct in completion reporting: executor-capacity drops come from k6's `dropped_iterations`, emitted requests come from `http_reqs`, and the planned cap prevents `http_reqs` from exceeding `plannedRequests`. Do not add early-return iterations to accepted/sold-out/unexpected response counters because no response occurred. If exact observability of capped overschedule is required, it needs an explicit custom counter and coordinated parser/contract work, which is outside this focused repair.

Header/body disagreement must be classified as unexpected by k6, not repaired by falling back to body parsing. That makes regressions visible and preserves the performance benefit. The API route tests are the contract guard ensuring body and headers agree.

## Focused verification for implementation

No live services or load run are needed for this task. Add focused static/unit coverage at the changed boundaries:

- Contract tests: header constants have the exact lowercase wire names; header-value schemas accept every intended Surge outcome/reason and reject unrelated strings.
- API injection tests: secured, idempotent replay, pending persistence, and sold-out responses carry the exact outcome header; rejected responses carry the reason header; accepted responses omit the reason header; pending persistence still carries `retry-after`; correlation response behavior is unchanged.
- Generated-script tests: assert `discardResponseBodies: true`, the two classification header names, the request `x-correlation-id`, and the steady overschedule guard are present; assert `response.json(` is absent.
- Quantity regression: generate from a snapshot with `trafficConfig.quantityPerAttempt = 3` and `inventoryConfig.quantityPerCheckout = 7`, and assert the emitted request configuration uses `3`, not `7`.
- Classification static checks: assert generated source recognizes all three Surge `202` outcomes, requires both sold-out outcome and reason for the `409` sold-out counter, and has a case-insensitive header helper. Keep the existing Node syntax check for generated source. A k6 `inspect`/execution can remain optional environment coverage and is not required to prove this change.

## Scope and non-goals

This task owns shared buy-header vocabulary, thin API header production, and generated k6 request/classification behavior. It does not change reservation business decisions, status codes, response JSON shapes, inventory seeding, dashboard metric names, output-parser schemas, delivery-summary semantics, executor sizing, run attribution, or distributed k6 support. It must not move reservation logic into the route or create new infrastructure clients.

## Implementation record

- **Status:** Complete (2026-07-14).
- **Completed scope:** Added canonical buy outcome/rejection header constants, schemas, and types; emitted those headers only after `/buy` response validation; preserved correlation and pending `retry-after`; changed generated k6 traffic to discard bodies, classify strict status/header combinations case-insensitively, send per-attempt correlation headers, use `trafficConfig.quantityPerAttempt`, and cap steady-arrival HTTP emission at `plannedRequests`; updated focused tests and the authoritative load-generation documentation.
- **Material decisions:** The outcome header schema reuses the full lifecycle decision vocabulary, including defensive recognition of `idempotent_replay`, while `buyResponseSchema` remains unchanged and still rejects that public JSON outcome. Accepted service replays therefore continue to emit `reservation_secured` in both JSON and the header. The steady cap uses the existing globally unique `exec.scenario.iterationInTest` identity and is limited to steady-arrival mode; buyer-spike duplicate attempts retain one VU-scoped idempotency key and iteration-scoped correlation IDs. Distributed k6 execution remains unsupported as before.
- **Verification passed:** `pnpm --filter @checkout-surge/contracts test -- --run packages/contracts/test/contracts.test.ts` (2 files, 73 tests); `pnpm --filter @checkout-surge/contracts build`; `pnpm --filter load-orchestrator test:api` (72 passed, optional k6 inspect skipped); `pnpm --filter api exec node ../../scripts/run-with-test-env.mjs vitest run --config vitest.api.config.ts test/api.test.ts -t "API gateway routes"` (52 passed, 24 filtered/skipped); affected package type checks for `@checkout-surge/contracts`, `api`, and `load-orchestrator`; affected package lint commands; focused Biome format/check.
- **Skipped or remaining:** No live services or load run was needed. Optional k6 inspect was skipped because no runnable k6 binary was available. `test:composition` and `test:characterization` were not run as required. Repository-wide `pnpm type-check:test` was attempted but remains failing on pre-existing unrelated test typing issues across API, worker, web, logger, and load-orchestrator tests; none point to the Task 41 changes.
