# Task 52: Add the public order-status lookup endpoint

## Execution context

- **Execution order:** This is task 52 of 81. Task numbers encode the intended implementation order and cross-task dependencies.
- **Standalone scope:** This task contains the relevant findings previously gathered from evaluated donor branches and the reference project. No access to those branches or repositories is expected.
- **Guidance, not prescription:** Embedded donor and reference findings are comparative evidence and implementation inspiration, not mandatory designs. They were judged better than the alternatives available during the earlier evaluation, which does not mean they are the best possible solution. Validate them against the current checkout and task constraints; adapt them, correct inconsistencies, or choose a clearly stronger approach when justified.
- **Working expectations:** Verify recorded locations and current-branch claims against the current checkout because line numbers and implementation details may have drifted. Preserve the stated priority, ownership boundary, dependencies, and non-goals. Follow `working_docs/quality_checklists.md`, add or update tests at the changed boundary, and run the relevant checks before handoff.
- **Working record:** Use this task document as the durable implementation and handoff record. Preserve the original requirements, and record the current status, completed scope, material decisions or deviations with their rationale, verification performed or skipped, and any remaining blockers or follow-up work. Keep updates concise, factual, and useful to future implementers and reviewers.

## Task details

- **Priority:** P3
- **Area:** API / contracts
- **Source:** comparison (**missing** — the only topic graded outright missing on this branch)
- **Solved elsewhere:** `checkout-forge` supplies the concrete route, durable read, response schema, and end-to-end success example described below. Adapt those semantics to `checkout-surge`; do not depend on the reference repository at implementation time.
- **Locations:** `packages/contracts/src/buy.ts`, `packages/contracts/src/index.ts`, `apps/api/src/routes/order-status-routes.ts` (new), `apps/api/src/services/order-status-service.ts` (new or equivalently focused reader), `apps/api/src/server.ts`, `apps/api/src/index.ts`, `packages/contracts/test/contracts.test.ts`, `apps/api/test/api.test.ts` (plus a focused service test if the reader is independently unit-tested)

No comparable order-status route or shared response contract currently exists. Coordinate with task 13 so `/buy` replays remain an acceptance surface and this endpoint is the sole public surface for mutable downstream order progress.

## Standalone reference implementation context

### Public contract and HTTP semantics

The reference defines `orderStatusRequestSchema`, `orderTimelineEntrySchema`, `orderStatusResponseSchema`, and their inferred types in `checkout-forge/packages/contracts/src/buy-flow.ts`. The request object contains a non-empty `publicOrderId` and an optional correlation ID. The response is:

```ts
{
  correlationId: string;
  publicOrderId: string;
  saleOfferId: UUID;
  reservation: {
    id: UUID;
    status: "secured" | "rejected" | "released" | "expired";
    expiresAt: ISO timestamp;
  };
  order: {
    status: "queued" | "processing" | "confirmed" | "failed";
    queuedAt: ISO timestamp;
    processingAt?: ISO timestamp | null;
    confirmedAt?: ISO timestamp | null;
    failedAt?: ISO timestamp | null;
    failureCode?: string | null;
    failureMessage?: string | null;
  };
  customerStatus:
    | "reservation_secured"
    | "processing"
    | "confirmed"
    | "failed";
  consistencyLagMs: number | null;
  timeline: Array<{
    eventName: string;
    label: string;
    occurredAt: ISO timestamp;
  }>;
}
```

The reference's `checkout-forge/apps/api/src/routes/order-status.ts`, `registerOrderStatusRoutes`, registers `GET /orders/:publicOrderId/status`. It takes the request correlation ID, calls `OrderPersistence.getOrderStatusResponse({ publicOrderId, correlationId })`, and returns:

- `200` with the contract above when the order and its reservation exist.
- `404` with the normal error envelope when no complete read model exists: code `order_not_found`, message `Order status was not found`, details `{ publicOrderId }`, the current request correlation ID, and an ISO timestamp.

There is no authentication, mutation, Redis read, queue interaction, retry header, or special success status. The request correlation ID is request-scoped: it comes from the current lookup, not the correlation ID persisted on the order. In `checkout-surge`, the global `onRequest` hook in `apps/api/src/server.ts` already normalizes the inbound header, stores `request.correlationId`, and emits the response header; use that value in both success and error bodies. Throw `ApiHttpError` from `apps/api/src/runtime/errors.ts` for the not-found case so the existing error handler creates and validates the standard `ErrorPayload`. Validate route params and the success result with shared Zod schemas.

### Durable data flow in the reference

`checkout-forge/apps/api/src/persistence/order-persistence.ts`, `OrderPersistence.getOrderStatusResponse`, performs this read:

1. Select one `orders` row by the unique `orders.publicOrderId`; return `null` if absent.
2. Select its `reservations` row by `order.reservationId`; return `null` if absent.
3. Select all `orderEvents` for `order.id`, ascending by `occurredAt`.
4. Map database `Date` values to ISO strings, derive the customer status and consistency lag, then parse the assembled object with `orderStatusResponseSchema` before returning it.

The precise derivations are:

- `customerStatus` is `"reservation_secured"` only while the durable order status is `"queued"`; otherwise it is the order status (`processing`, `confirmed`, or `failed`). This vocabulary already matches `checkout-surge/packages/contracts/src/lifecycle.ts`, `simulatedPurchaseStatusSchema`, for these four states.
- `consistencyLagMs` is `confirmedAt - queuedAt` in milliseconds only for a confirmed order; it is `null` for queued, processing, and failed orders. Do not substitute current age, processing latency, ERP latency, or failure latency.
- The timeline preserves every persisted order event in chronological order. `eventName` is the stored name, `occurredAt` is its ISO timestamp, and the reference gives friendly labels only to `reservation.secured` (`Reservation secured`) and `order.queued` (`Order queued`); all other names fall back to the raw event name. This fallback is deliberate and avoids inventing copy for later lifecycle events.
- The response intentionally omits internal order UUID, reservation token, quantities, run ID, persisted correlation IDs, event payload/source, ERP attempt details, notification data, and inventory counts.

`checkout-forge/apps/api/test/thin-vertical-slice.api.test.ts`, in the read-path test around the injected `/orders/{publicOrderId}/status` request, validates the response with the shared schema and proves a freshly accepted order returns `200`, the lookup correlation ID, the public order/sale offer/reservation identities, reservation `secured`, order `queued`, customer status `reservation_secured`, and the ordered timeline `reservation.secured`, `order.queued`.

## Required adaptation to `checkout-surge`

### Shared contract

- Add the order-status request/params, timeline-entry, and response schemas and inferred public types to `packages/contracts/src/buy.ts` (or a purpose-named contract module exported by `packages/contracts/src/index.ts`). Follow this repository's convention of `.strict()` object schemas.
- Reuse `correlationIdSchema`, `isoTimestampSchema`, and `uuidSchema` from `packages/contracts/src/primitives.ts`; `reservationStatusSchema` and `orderStatusSchema` from `packages/contracts/src/lifecycle.ts`; and use `simulatedPurchaseStatusSchema.extract(["reservation_secured", "processing", "confirmed", "failed"])` for the reference wire field `customerStatus`. Keep that exact field name for reference compatibility; do not add a parallel `simulatedStatus` alias merely because `/buy` uses that name.
- Preserve nullable lifecycle/failure properties in the status response. Unlike the acceptance-shaped `OrderSummary`, this read model should present the current durable state explicitly; returning `null` for unset `processingAt`, `confirmedAt`, `failedAt`, `failureCode`, and `failureMessage` is the clearest reference-compatible representation.
- Keep `timeline.eventName` as a non-empty string rather than narrowing it to `orderEventNameSchema`: durable rows and future event vocabulary should remain readable without making this endpoint fail during a rolling contract change.

### Reader/service and route composition

- Add a focused injected reader/service. A suitable shape is `OrderStatusService.getStatus({ publicOrderId, correlationId }): Promise<OrderStatusResponse | null>`, backed by `CheckoutSurgeDatabase`. Keep Drizzle queries and response assembly out of the route. Do not expand `ReserveOrderService`; it owns the reservation workflow, not status reads. Reusing `PostgresBuyPersistence` is also discouraged because it currently owns acceptance persistence and replay lookup, while this response is a mutable read model.
- Query the existing `orders`, `reservations`, and `orderEvents` tables from `packages/db/src/schema.ts`. Their current columns already provide every response field: `orders.publicOrderId/saleOfferId/reservationId/status/queuedAt/processingAt/confirmedAt/failedAt/failureCode/failureMessage`, `reservations.id/status/expiresAt`, and `orderEvents.orderId/eventName/occurredAt`. `orders.publicOrderId` is uniquely indexed and `orders.reservationId` is a non-null foreign key, so a joined order/reservation query is appropriate; an absent join result is not found. Read timeline events with `eq(orderEvents.orderId, order.id)` and `asc(orderEvents.occurredAt)`. Add a deterministic secondary order such as event ID only if tests can create equal timestamps and stable ordering matters.
- Parse the assembled success object with the shared response schema at the service boundary. A database/query failure must propagate to the standard `500 internal_error`; do not collapse infrastructure errors into `404`.
- Add a thin `registerOrderStatusRoutes` route module following `apps/api/src/routes/inventory-routes.ts`: parse `{ publicOrderId }`, call the injected service with `request.correlationId`, validate/send `200`, and throw a `404 ApiHttpError` with `details.publicOrderId` on `null`.
- Extend `BuildApiServerOptions` and the registration block in `apps/api/src/server.ts` with the service dependency. Construct the PostgreSQL-backed service in the composition root `apps/api/src/index.ts` from the existing `connection.db`, then pass it to `buildApiServer`. Update test server builders/fakes for the new required dependency rather than creating a database client inside the route or service module.

### Relationship to task 13

Task 13 makes durable `/buy` replays project the original acceptance: queued order, stable acceptance timestamp, and no terminal fields. This task must read the live durable row and therefore may return processing, confirmed, failed, terminal timestamps, and failure details. Both paths share `publicOrderId`, but they serve different purposes. Do not implement status lookup by replaying `/buy`, calling `ReserveOrderService.reserve`, using the idempotency key, or projecting `getPersistedBuyByReservationId`; and do not weaken task 13's acceptance-only replay contract while adding this endpoint.

## Focused verification

- In `packages/contracts/test/contracts.test.ts`, parse representative queued, processing, confirmed, and failed responses. Assert strict rejection of malformed IDs/timestamps, negative `consistencyLagMs`, unknown status values, and leaked/internal fields where useful. Cover the chosen customer-facing field name and its exact four-value vocabulary.
- Add a focused reader/service test for: missing public ID returns `null`; missing/inconsistent reservation is treated as not found if the fixture can represent it; queued maps to `reservation_secured`; confirmed computes `confirmedAt - queuedAt`; failed retains failure code/message but has `consistencyLagMs: null`; dates serialize to ISO; events are chronological and labels use the two friendly cases plus raw-name fallback.
- In `apps/api/test/api.test.ts`, buy an order (or seed the same durable rows), then `GET /orders/{publicOrderId}/status` with an explicit correlation header. Assert `200`, the echoed correlation ID in body and header, shared-schema validation, current order/reservation fields, and the two initial timeline entries in order.
- Advance separate durable orders through processing/confirmed and failed using the existing persistence/worker test mechanisms, then assert this endpoint exposes the live terminal state while an idempotent `/buy` replay remains queued/acceptance-shaped per task 13. For confirmed, assert the exact lag calculation; for failed, assert failure fields and null lag.
- Assert an unknown public order ID returns `404` with the repository error schema, `code: "order_not_found"`, `details.publicOrderId`, and the current correlation ID. Also cover invalid/blank parameter input according to the params schema as `400 invalid_request`; unexpected database failure remains `500 internal_error`.
- Run the contracts tests and API unit/integration tests that cover the reader and route, followed by the repository's relevant typecheck/lint commands. Integration tests requiring PostgreSQL should be reported explicitly if the environment cannot run them.

## Scope and non-goals

This task owns the public order-status contract, a PostgreSQL-backed read service, the thin GET route, dependency composition, and focused tests. It does not change `/buy` response/replay shaping (task 13); reservation, idempotency, Redis, queue publication, worker transitions, ERP retries, notification behavior, inventory status, dashboard/run-history contracts, database schema/indexes, or event production. Do not add polling, SSE/web UI, authentication, cancellation/refund behavior, event-sourced state reconstruction, or an endpoint keyed by internal order/reservation IDs. Do not expose reservation tokens, event payloads, internal UUIDs, run attribution, or operational failure detail beyond the order's existing public failure code/message. Preserve the current fast-reservation/slow-processing boundary: this is a read-only view of already durable state.

## Implementation record

- **Status:** Complete on 2026-07-15.
- Added strict shared params/request, timeline, and response contracts plus the canonical `order_not_found` error code. The response keeps nullable lifecycle/failure fields explicit and leaves stored event names open for rolling vocabulary changes.
- Added an injected PostgreSQL-backed `OrderStatusService`, thin public route, server dependency, and production composition. Reads inner-join the required reservation, propagate query failures, parse the assembled response at the service boundary, and use the current lookup correlation ID.
- Equal-timestamp events use a stable semantic tie-break (`reservation.secured`, then `order.queued`, then other events by creation time/ID) so the initial timeline is deterministic without changing chronological ordering or discarding future names. Friendly labels are limited to the two initial events; other names remain raw.
- A missing joined reservation maps to not found by construction. The existing non-null foreign key and secured-reservation trigger prevent a normal inconsistent fixture, so that impossible database fixture was not forced by disabling constraints.
- Preserved Task 13 acceptance-shaped `/buy` replays while integration coverage proves this endpoint exposes confirmed/failed live state, confirmed lag, and complete chronological processing/terminal timelines without duplicating initial events. Updated architecture, business-entity, and Redis hot-path documentation.
- **Verification:** contracts unit tests passed (88); focused PostgreSQL service tests passed (5); the corrected terminal route/API/PostgreSQL integration passed (1, 78 skipped by name filter), while the other three unchanged focused route/API checks had passed before correction; contracts and API production builds/type-check passed; changed-file Biome lint/format and `git diff --check` passed. Repository-wide test-source type-check still reports its existing unrelated errors and no Task 52 paths. A full API run encountered the pre-existing/flaky `dashboard-traffic-metric-store` retention/reset race; that exact test passed immediately in isolation. Composition and characterization suites were not run per repository instructions.
- **Remaining issues:** None for Task 52.
