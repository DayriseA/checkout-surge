import { z } from "zod";
import { metricNameSchema, orderEventNameSchema } from "./lifecycle.js";
import {
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  uuidSchema,
} from "./primitives.js";

export const inventoryStatusSchema = z
  .object({
    saleOfferId: uuidSchema,
    allocatedStock: nonnegativeIntegerSchema,
    remainingStock: nonnegativeIntegerSchema,
    reservedStock: nonnegativeIntegerSchema,
    pendingPersistenceCount: nonnegativeIntegerSchema,
    expiredReservationCount: nonnegativeIntegerSchema,
    oldestPendingPersistenceAgeSeconds: nonnegativeNumberSchema,
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
    source: z.string().trim().min(1),
    occurredAt: isoTimestampSchema,
  })
  .strict();
export type InventoryUpdatedEventPayload = z.infer<typeof inventoryUpdatedEventPayloadSchema>;

export const metricSampleSchema = z
  .object({
    metricName: metricNameSchema,
    value: z.number().finite(),
    unit: z.string().trim().min(1),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type MetricSample = z.infer<typeof metricSampleSchema>;
