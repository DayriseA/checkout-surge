# Task 39: Fix rejected-buy classification: stop forcing sold-out, add the missing decision vocabulary

## Execution context

- **Execution order:** This is task 39 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P1
- **Area:** API / contracts
- **Source:** independent review (low, but user-facing correctness) + comparison (worse)
- **Solved elsewhere:** the reference presentation vocabulary (it includes a sale-not-active status and does not map non-stock failures to sold-out).
- **Locations:** `packages/contracts/src/buy.ts:56`, `apps/api/src/services/reserve-order-service.ts:182`, `packages/contracts/src/lifecycle.ts:59`

Every rejected-buy branch is forced to a sold-out presentation status — including invalid quantities and idempotency conflicts — and the run-not-accepting-traffic decision is rewritten to inventory-not-initialized because the canonical decision vocabulary lacks the value. Consumers report request conflicts or a closed run as exhausted/missing inventory. Extend the vocabulary and align the presentation mapping with the reference.

## Standalone implementation context

### What the reference actually does

The useful donor is `checkout-forge`; its response shape is not a drop-in replacement for Checkout Surge, but its separation between a decision/reason and a customer-facing status is the behavior to preserve.

In `checkout-forge/packages/contracts/src/domain.ts`, the relevant enums are:

```ts
export const reservationRejectionReasonSchema = z.enum([
  "sold_out",
  "sale_not_active",
  "duplicate_request",
  "invalid_quantity",
]);

export const customerOrderStatusSchema = z.enum([
  "sold_out",
  "sale_not_active",
  "reservation_secured",
  "processing",
  "confirmed",
  "failed",
  "reservation_expired",
]);
```

Its `packages/contracts/src/buy-flow.ts` rejection contract deliberately restricts the presentation field to the two customer lifecycle states:

```ts
export const reservationRejectedResponseSchema = z.object({
  outcome: z.literal("reservation_rejected"),
  correlationId: correlationIdSchema,
  reason: reservationRejectionReasonSchema,
  reservationStatus: z.literal("rejected"),
  customerStatus: customerOrderStatusSchema.extract(["sold_out", "sale_not_active"]),
  rejectedAt: isoTimestampSchema,
});
```

`checkout-forge/apps/api/src/services/reserve-order-service.ts` maps an ineligible run/sale to a rejection with `reason: "sale_not_active"`, maps only Redis `sold_out` to `reason: "sold_out"`, and builds `customerStatus` from that reason:

```ts
if (!saleOffer) {
  return createRejectedResponse({
    correlationId: options.correlationId,
    reason: "sale_not_active",
    rejectedAt: now,
  });
}

// Redis decision switch:
case "inventory_not_initialized":
  throw new ApiHttpError(503, { code: "inventory_not_initialized", /* ... */ });
case "idempotency_conflict":
  throw new ApiHttpError(409, { code: "idempotency_conflict", /* ... */ });
case "sold_out":
  return createRejectedResponse({
    correlationId: options.correlationId,
    reason: "sold_out",
    rejectedAt: now,
  });

function createRejectedResponse(options: {
  correlationId: string;
  reason: "sold_out" | "sale_not_active";
  rejectedAt: Date;
}): ReservationRejectedResponse {
  return {
    outcome: "reservation_rejected",
    correlationId: options.correlationId,
    reason: options.reason,
    reservationStatus: "rejected",
    customerStatus: options.reason,
    rejectedAt: options.rejectedAt.toISOString(),
  };
}
```

The Forge route returns a presentation rejection as HTTP 409. Invalid inventory state remains a 503 error and an idempotency conflict remains a 409 error; neither is relabeled as sold out. Forge contract/API tests explicitly cover both rejected presentation values and the error cases. Copy the classification principle, not Forge's `reservation_rejected` envelope, header conventions, or exception-based control flow.

### Current Checkout Surge contracts and bug

`packages/contracts/src/lifecycle.ts` currently has `run_not_accepting_traffic` in `reservationRejectReasonValues`, but omits it from `reservationDecisionValues`:

```ts
export const reservationRejectReasonValues = [
  "sold_out",
  "inventory_not_initialized",
  "quantity_invalid",
  "run_not_accepting_traffic",
  "idempotency_conflict",
] as const;

export const reservationDecisionValues = [
  "reservation_secured",
  "sold_out",
  "inventory_not_initialized",
  "idempotent_replay",
  "idempotency_conflict",
  "quantity_invalid",
  "reservation_pending_persistence",
] as const;

export const simulatedPurchaseStatusValues = [
  "sold_out",
  "reservation_secured",
  "processing",
  "confirmed",
  "failed",
  "reservation_expired",
] as const;
```

The stock boundary is already more precise than the public buy response: `StockReservationDecision` and Redis can return `{ outcome: "run_not_accepting_traffic", reservation: null }`. However, `packages/contracts/src/buy.ts` does not permit that outcome and requires every rejection to carry the literal presentation value `sold_out`:

```ts
export const reservationRejectedResponseSchema = z
  .object({
    outcome: reservationDecisionSchema.extract([
      "sold_out",
      "inventory_not_initialized",
      "idempotency_conflict",
      "quantity_invalid",
    ]),
    reason: reservationRejectReasonSchema,
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
    reservation: z.null(),
    order: z.null(),
    simulatedStatus: simulatedPurchaseStatusSchema.extract(["sold_out"]),
  })
  .strict();
```

Consequently, `apps/api/src/services/reserve-order-service.ts` rewrites both the pre-Redis generated-run gate rejection and the atomic Redis rejection:

```ts
return this.rejectedResponse(
  "inventory_not_initialized",
  "run_not_accepting_traffic",
  input.correlationId,
  now,
);
```

The common helper then applies the second misclassification to every rejected response:

```ts
return buyResponseSchema.parse({
  outcome,
  reason,
  correlationId,
  timestamp: now.toISOString(),
  reservation: null,
  order: null,
  simulatedStatus: "sold_out",
});
```

Finally, `apps/api/src/routes/buy-routes.ts::buyStatusCode()` currently has no `run_not_accepting_traffic` arm. Existing mappings are 202 for accepted/replay/pending, 400 for `quantity_invalid`, 503 for `inventory_not_initialized`, and 409 for `sold_out` and `idempotency_conflict`.

There is currently no web component consuming `simulatedStatus` in this repository. Its only in-repo producers are `ReserveOrderService`, and its direct assertions are in the contracts and API tests. It is nevertheless a public contract field and must be treated as consumer-visible.

## Required target behavior

Keep Checkout Surge's existing outcome-per-decision envelope. Extend it so the response preserves the source decision and so the presentation field describes only a simulated customer lifecycle state. Do not replace the entire response with Forge's envelope.

Use this source-to-presentation mapping:

| Source decision | Response `outcome` | Response `reason` | `simulatedStatus` | HTTP | Meaning |
| --- | --- | --- | --- | --- | --- |
| `sold_out` | `sold_out` | `sold_out` | `sold_out` | 409 | Actual stock exhaustion only |
| `run_not_accepting_traffic` (from either generated-run gate) | `run_not_accepting_traffic` | `run_not_accepting_traffic` | `sale_not_active` | 409 | The run/sale is closed, unknown, mismatched, or otherwise ineligible for traffic |
| `inventory_not_initialized` | `inventory_not_initialized` | `inventory_not_initialized` | `null` | 503 | Operational inventory readiness failure, not a customer lifecycle state |
| `idempotency_conflict` | `idempotency_conflict` | `idempotency_conflict` | `null` | 409 | Request conflict, not stock exhaustion |
| `quantity_invalid` | `quantity_invalid` | `quantity_invalid` | `null` | 400 | Request validation/decision failure, not stock exhaustion |

Accepted, replay, and pending-persistence mappings remain unchanged: their `simulatedStatus` stays `reservation_secured` and their HTTP status stays 202.

Concrete response examples (timestamps and IDs abbreviated) are:

```json
{
  "outcome": "run_not_accepting_traffic",
  "reason": "run_not_accepting_traffic",
  "correlationId": "...",
  "timestamp": "...",
  "reservation": null,
  "order": null,
  "simulatedStatus": "sale_not_active"
}
```

```json
{
  "outcome": "idempotency_conflict",
  "reason": "idempotency_conflict",
  "correlationId": "...",
  "timestamp": "...",
  "reservation": null,
  "order": null,
  "simulatedStatus": null
}
```

The explicit `null` is preferred over omitting `simulatedStatus`: it keeps the strict response shape stable while expressing that no simulated lifecycle presentation applies.

## Ownership and implementation boundaries

- `@checkout-surge/contracts` owns the public vocabulary and schema. Add `run_not_accepting_traffic` to `reservationDecisionValues`, add `sale_not_active` to `simulatedPurchaseStatusValues`, include the new decision in the rejected-response outcome set, and make rejected `simulatedStatus` accept exactly `sold_out | sale_not_active | null`. Do not broaden it to arbitrary strings.
- `ReserveOrderService` owns source-decision-to-response presentation mapping. Preserve `run_not_accepting_traffic` from both the pre-Redis `GeneratedRunSaleGate` and the atomic stock gateway. Prefer a small exhaustive helper/switch (for example, returning the exact `sold_out`, `sale_not_active`, or `null` value) over a default that can silently classify a future decision as sold out.
- `buy-routes.ts` owns HTTP transport mapping. Add an explicit `run_not_accepting_traffic` case returning 409. Keep the route thin; do not move business classification into it.
- Redis and `@checkout-surge/db` already return the precise `run_not_accepting_traffic` source decision. Do not rename that internal decision to `sale_not_active`, and do not modify stock, counters, persistence, or queue behavior for this task.
- No frontend work is required because there is no current component consumer. If a presentation component is introduced or found during implementation, render `sale_not_active` with human text such as “Sale not active”, render `null` as a neutral request/availability failure derived from `reason`, and never fall back to “Sold out.” Status must not be conveyed by color alone; preserve visible text and appropriate live-region semantics for asynchronously updated feedback.

## Compatibility and defensive behavior

- Adding enum members is schema-additive, but changing `simulatedStatus` for inventory, quantity, and idempotency failures is an intentional semantic correction. Consumers that assumed every rejection was sold out must be updated or allowed to use `reason`; do not preserve the lie for compatibility.
- Keeping `simulatedStatus` present and nullable minimizes wire-shape churn. Document/type the nullability so TypeScript consumers must handle it.
- An older consumer may not recognize `run_not_accepting_traffic` or `sale_not_active`. Its safe fallback is a generic “Request not accepted” / “Sale unavailable” state, never `sold_out`. Do not add a second legacy outcome field or emit different responses based on client version in this task.
- Contract parsing and mapping must fail closed on an unknown future decision. Use exhaustive switches (`never` checking where practical); do not use `_ => "sold_out"`, truthiness, or substring matching.
- Preserve correlation ID and timestamp behavior, the `reservation: null` / `order: null` rejection invariant, and the existing error-status distinction. This task changes classification only.

## Focused verification

Update tests at the owning boundaries:

1. In `packages/contracts/test/contracts.test.ts`, prove the rejected schema accepts all five rows in the table with their exact presentation values, especially `run_not_accepting_traffic` + `sale_not_active` and the three `null` cases. Prove invalid cross-pairs such as `idempotency_conflict` + `sold_out` are rejected if the contract is modeled as a discriminated union/refinement rather than merely a broad union of independently valid fields. Assert the new lifecycle enum members.
2. In `apps/api/test/reserve-order-service.test.ts`, cover both run-closure sources: `GeneratedRunSaleGate.isAccepting() === false` must bypass Redis and return the precise sale-not-active presentation; a stock gateway `run_not_accepting_traffic` result must produce the same response. Add focused cases for sold out, inventory uninitialized, quantity invalid, and idempotency conflict so only sold out presents as sold out.
3. In the buy route/API tests, assert exact HTTP status and parsed body for each rejection class. Replace the existing “compatible API response” expectation that currently requires `inventory_not_initialized` for an atomic run rejection. Preserve assertions that rejected paths create no reservation/order and do not enqueue.
4. Run the contracts test/typecheck and the focused API service/route tests, then the repository's relevant lint/typecheck commands. Redis/PostgreSQL integration coverage is only needed if an existing integration assertion is updated; no new infrastructure behavior is introduced.

## Non-goals

- Do not copy Forge's whole buy envelope, response headers, or `ApiHttpError` architecture.
- Do not change reservation atomicity, run eligibility, idempotency semantics, durable persistence, queue publication, or sold-out metrics/counters.
- Do not rename the internal `run_not_accepting_traffic` decision to the presentation term `sale_not_active`.
- Do not add UI solely for this vocabulary correction or broaden the task into general error-response redesign.
