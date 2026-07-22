import { z } from "zod";
import { orderSummarySchema, reservationSummarySchema } from "./entities.js";
import { orderStatusSchema, publicBuyOutcomeValues } from "./lifecycle.js";

export { publicBuyOutcomeValues } from "./lifecycle.js";

import {
  correlationIdSchema,
  idempotencyKeySchema,
  isoTimestampSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const loadRunIdHeaderName = "x-load-run-id" as const;
export const buyOutcomeHeaderName = "x-checkout-outcome" as const;

export const buyOutcomeHeaderValueSchema = z.enum(publicBuyOutcomeValues);
export type BuyOutcomeHeaderValue = z.infer<typeof buyOutcomeHeaderValueSchema>;

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

export const orderStatusParamsSchema = z
  .object({
    publicOrderId: z.string().trim().min(1),
  })
  .strict();
export type OrderStatusParams = z.infer<typeof orderStatusParamsSchema>;

export const orderStatusRequestSchema = orderStatusParamsSchema
  .extend({ correlationId: correlationIdSchema.optional() })
  .strict();
export type OrderStatusRequest = z.infer<typeof orderStatusRequestSchema>;

export const orderTimelineEntrySchema = z
  .object({
    eventName: z.string().trim().min(1),
    label: z.string().trim().min(1),
    occurredAt: isoTimestampSchema,
  })
  .strict();
export type OrderTimelineEntry = z.infer<typeof orderTimelineEntrySchema>;

export const orderStatusResponseSchema = z
  .object({
    correlationId: correlationIdSchema,
    publicOrderId: z.string().trim().min(1),
    saleOfferId: uuidSchema,
    reservation: z
      .object({
        id: uuidSchema,
        expiresAt: isoTimestampSchema,
      })
      .strict(),
    order: z
      .object({
        status: orderStatusSchema,
        queuedAt: isoTimestampSchema,
        processingAt: isoTimestampSchema.nullable(),
        confirmedAt: isoTimestampSchema.nullable(),
        failedAt: isoTimestampSchema.nullable(),
        failureCode: z.string().trim().min(1).nullable(),
        failureMessage: z.string().trim().min(1).nullable(),
      })
      .strict(),
    consistencyLagMs: z.number().min(0).nullable(),
    timeline: z.array(orderTimelineEntrySchema),
  })
  .strict();
export type OrderStatusResponse = z.infer<typeof orderStatusResponseSchema>;

export const acceptedReservationSummarySchema = reservationSummarySchema;
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
    ...rejectedResponseBaseShape,
  })
  .strict();

const runNotAcceptingTrafficRejectedResponseSchema = z
  .object({
    outcome: z.literal("run_not_accepting_traffic"),
    ...rejectedResponseBaseShape,
  })
  .strict();

const inventoryNotInitializedRejectedResponseSchema = z
  .object({
    outcome: z.literal("inventory_not_initialized"),
    ...rejectedResponseBaseShape,
  })
  .strict();

const idempotencyConflictRejectedResponseSchema = z
  .object({
    outcome: z.literal("idempotency_conflict"),
    ...rejectedResponseBaseShape,
  })
  .strict();

const quantityInvalidRejectedResponseSchema = z
  .object({
    outcome: z.literal("quantity_invalid"),
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
