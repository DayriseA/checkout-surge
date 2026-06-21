import { z } from "zod";
import {
  metricNameSchema,
  orderEventNameSchema,
  reservationDecisionSchema,
  reservationStatusSchema,
} from "./lifecycle.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const reservationThroughputSchema = z
  .object({
    windowSeconds: positiveIntegerSchema,
    successfulReservationCount: nonnegativeIntegerSchema,
    rate: nonnegativeNumberSchema,
    unit: z.literal("reservations_per_second"),
    measuredAt: isoTimestampSchema,
  })
  .strict();
export type ReservationThroughput = z.infer<typeof reservationThroughputSchema>;

export const soldOutPressureSchema = z
  .object({
    rejectionCount: nonnegativeIntegerSchema,
    latestObservedAt: isoTimestampSchema.nullable(),
  })
  .strict();
export type SoldOutPressure = z.infer<typeof soldOutPressureSchema>;

export const inventoryStatusSchema = z
  .object({
    saleOfferId: uuidSchema,
    allocatedStock: nonnegativeIntegerSchema,
    remainingStock: nonnegativeIntegerSchema,
    reservedStock: nonnegativeIntegerSchema,
    pendingPersistenceCount: nonnegativeIntegerSchema,
    expiredReservationCount: nonnegativeIntegerSchema,
    oldestPendingPersistenceAgeSeconds: nonnegativeNumberSchema,
    reservationThroughput: reservationThroughputSchema,
    soldOutPressure: soldOutPressureSchema,
    lastUpdatedAt: isoTimestampSchema,
  })
  .strict();
export type InventoryStatus = z.infer<typeof inventoryStatusSchema>;

export const terminalInventorySnapshotSchema = z
  .object({
    saleOfferId: uuidSchema,
    startingStock: nonnegativeIntegerSchema,
    remainingStock: nonnegativeIntegerSchema,
    reservedStock: nonnegativeIntegerSchema,
    acceptedReservations: nonnegativeIntegerSchema,
    soldOutRejections: nonnegativeIntegerSchema,
    pendingPersistenceCount: nonnegativeIntegerSchema,
    capturedAt: isoTimestampSchema,
    source: z.literal("redis"),
  })
  .strict();
export type TerminalInventorySnapshot = z.infer<typeof terminalInventorySnapshotSchema>;

export const inventoryUpdatedEventPayloadSchema = z
  .object({
    eventName: orderEventNameSchema.extract(["inventory.updated"]),
    saleOfferId: uuidSchema,
    allocatedStock: nonnegativeIntegerSchema,
    remainingStock: nonnegativeIntegerSchema,
    reservedStock: nonnegativeIntegerSchema,
    reservationCount: z.literal(1).optional(),
    reservedQuantity: positiveIntegerSchema.optional(),
    source: z.string().trim().min(1),
    occurredAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.source === "reservation" &&
      event.reservationCount === undefined &&
      event.reservedQuantity === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Reservation inventory events must include count and quantity.",
      });
    }

    if ((event.reservationCount === undefined) !== (event.reservedQuantity === undefined)) {
      context.addIssue({
        code: "custom",
        message: "Reservation inventory events must include both count and quantity.",
      });
    }
  });
export type InventoryUpdatedEventPayload = z.infer<typeof inventoryUpdatedEventPayloadSchema>;

export const securedReservationHoldSchema = z
  .object({
    id: uuidSchema,
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    quantity: positiveIntegerSchema,
    status: reservationStatusSchema.extract(["secured"]),
    reservationToken: z.string().trim().min(1),
    expiresAt: isoTimestampSchema,
    securedAt: isoTimestampSchema,
  })
  .strict();
export type SecuredReservationHold = z.infer<typeof securedReservationHoldSchema>;

const acceptedStockReservationDecisionSchema = z
  .object({
    outcome: reservationDecisionSchema.extract([
      "reservation_secured",
      "idempotent_replay",
      "reservation_pending_persistence",
    ]),
    reservation: securedReservationHoldSchema,
  })
  .strict();

const rejectedStockReservationDecisionSchema = z
  .object({
    outcome: reservationDecisionSchema.extract([
      "sold_out",
      "inventory_not_initialized",
      "idempotency_conflict",
      "quantity_invalid",
    ]),
    reservation: z.null(),
  })
  .strict();

export const stockReservationDecisionSchema = z.discriminatedUnion("outcome", [
  acceptedStockReservationDecisionSchema,
  rejectedStockReservationDecisionSchema,
]);
export type StockReservationDecision = z.infer<typeof stockReservationDecisionSchema>;

export const metricSampleSchema = z
  .object({
    metricName: metricNameSchema,
    value: z.number().finite(),
    unit: z.string().trim().min(1),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type MetricSample = z.infer<typeof metricSampleSchema>;
