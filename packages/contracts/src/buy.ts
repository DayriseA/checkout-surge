import { z } from "zod";
import { orderSummarySchema, reservationSummarySchema } from "./entities.js";
import {
  reservationDecisionSchema,
  reservationRejectReasonSchema,
  simulatedPurchaseStatusSchema,
} from "./lifecycle.js";
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
export type ReservationRejectedResponse = z.infer<typeof reservationRejectedResponseSchema>;

export const buyResponseSchema = z.discriminatedUnion("outcome", [
  reservationAcceptedResponseSchema,
  reservationPendingPersistenceResponseSchema,
  reservationRejectedResponseSchema,
]);
export type BuyResponse = z.infer<typeof buyResponseSchema>;
