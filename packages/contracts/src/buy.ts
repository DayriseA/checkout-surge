import { z } from "zod";
import { orderSummarySchema, reservationSummarySchema } from "./entities.js";
import { simulatedPurchaseStatusSchema } from "./lifecycle.js";
import {
  correlationIdSchema,
  idempotencyKeySchema,
  isoTimestampSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const loadRunIdHeaderName = "x-load-run-id" as const;

export const buyRequestSchema = z
  .object({
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
    quantity: positiveIntegerSchema.default(1),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type BuyRequest = z.infer<typeof buyRequestSchema>;

export const acceptedReservationSummarySchema = reservationSummarySchema.extend({
  status: z.literal("secured"),
});
export type AcceptedReservationSummary = z.infer<typeof acceptedReservationSummarySchema>;

export const acceptedOrderSummarySchema = orderSummarySchema
  .omit({
    failureCode: true,
    failureMessage: true,
    processingAt: true,
    confirmedAt: true,
    failedAt: true,
  })
  .extend({ status: z.literal("queued") });
export type AcceptedOrderSummary = z.infer<typeof acceptedOrderSummarySchema>;

export const reservationAcceptedResponseSchema = z
  .object({
    outcome: z.literal("reservation_secured"),
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
    reservation: acceptedReservationSummarySchema,
    order: acceptedOrderSummarySchema,
    simulatedStatus: simulatedPurchaseStatusSchema.extract(["reservation_secured"]),
  })
  .strict();
export type ReservationAcceptedResponse = z.infer<typeof reservationAcceptedResponseSchema>;

export const reservationPendingPersistenceResponseSchema = z
  .object({
    outcome: z.literal("reservation_pending_persistence"),
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
    reservation: reservationSummarySchema,
    order: z.null(),
    simulatedStatus: simulatedPurchaseStatusSchema.extract(["reservation_secured"]),
    retryAfterSeconds: positiveIntegerSchema,
  })
  .strict();
export type ReservationPendingPersistenceResponse = z.infer<
  typeof reservationPendingPersistenceResponseSchema
>;

const rejectedResponseBaseShape = {
  correlationId: correlationIdSchema,
  timestamp: isoTimestampSchema,
  reservation: z.null(),
  order: z.null(),
} as const;

const soldOutRejectedResponseSchema = z
  .object({
    outcome: z.literal("sold_out"),
    reason: z.literal("sold_out"),
    simulatedStatus: z.literal("sold_out"),
    ...rejectedResponseBaseShape,
  })
  .strict();

const runNotAcceptingTrafficRejectedResponseSchema = z
  .object({
    outcome: z.literal("run_not_accepting_traffic"),
    reason: z.literal("run_not_accepting_traffic"),
    simulatedStatus: z.literal("sale_not_active"),
    ...rejectedResponseBaseShape,
  })
  .strict();

const inventoryNotInitializedRejectedResponseSchema = z
  .object({
    outcome: z.literal("inventory_not_initialized"),
    reason: z.literal("inventory_not_initialized"),
    simulatedStatus: z.null(),
    ...rejectedResponseBaseShape,
  })
  .strict();

const idempotencyConflictRejectedResponseSchema = z
  .object({
    outcome: z.literal("idempotency_conflict"),
    reason: z.literal("idempotency_conflict"),
    simulatedStatus: z.null(),
    ...rejectedResponseBaseShape,
  })
  .strict();

const quantityInvalidRejectedResponseSchema = z
  .object({
    outcome: z.literal("quantity_invalid"),
    reason: z.literal("quantity_invalid"),
    simulatedStatus: z.null(),
    ...rejectedResponseBaseShape,
  })
  .strict();

const rejectedResponseVariants = [
  soldOutRejectedResponseSchema,
  runNotAcceptingTrafficRejectedResponseSchema,
  inventoryNotInitializedRejectedResponseSchema,
  idempotencyConflictRejectedResponseSchema,
  quantityInvalidRejectedResponseSchema,
] as const;

export const reservationRejectedResponseSchema = z.discriminatedUnion(
  "outcome",
  rejectedResponseVariants,
);
export type ReservationRejectedResponse = z.infer<typeof reservationRejectedResponseSchema>;

export const buyResponseSchema = z.discriminatedUnion("outcome", [
  reservationAcceptedResponseSchema,
  reservationPendingPersistenceResponseSchema,
  ...rejectedResponseVariants,
]);
export type BuyResponse = z.infer<typeof buyResponseSchema>;
