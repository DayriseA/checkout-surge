import { z } from "zod";
import {
  demoPresetVisibilitySchema,
  demoRunStatusSchema,
  orderStatusSchema,
} from "./lifecycle.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const reservationSummarySchema = z
  .object({
    id: uuidSchema,
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    quantity: positiveIntegerSchema,
    reservationToken: z.string().trim().min(1).optional(),
    expiresAt: isoTimestampSchema,
    securedAt: isoTimestampSchema,
  })
  .strict();

export const orderSummarySchema = z
  .object({
    id: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    saleOfferId: uuidSchema,
    reservationId: uuidSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    quantity: positiveIntegerSchema,
    status: orderStatusSchema,
    failureCode: z.string().trim().min(1).optional(),
    failureMessage: z.string().trim().min(1).optional(),
    queuedAt: isoTimestampSchema,
    processingAt: isoTimestampSchema.optional(),
    confirmedAt: isoTimestampSchema.optional(),
    failedAt: isoTimestampSchema.optional(),
  })
  .strict();

export const demoPresetDisplaySchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1),
    sortOrder: z.number().int(),
    outcomeFocus: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export type DemoPresetDisplay = z.infer<typeof demoPresetDisplaySchema>;

export const demoPresetSchema = z
  .object({
    id: uuidSchema,
    slug: z.string().trim().min(1),
    visibility: demoPresetVisibilitySchema,
    isEditable: z.boolean(),
    isCustom: z.boolean(),
    display: demoPresetDisplaySchema,
    trafficConfig: jsonObjectSchema,
    inventoryConfig: jsonObjectSchema,
    erpConfig: jsonObjectSchema,
    backpressureConfig: jsonObjectSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type DemoPreset = z.infer<typeof demoPresetSchema>;

export const demoRunSummaryShapeSchema = z
  .object({
    id: uuidSchema,
    runId: uuidSchema,
    presetName: z.string().trim().min(1),
    status: demoRunStatusSchema,
    failureReason: z.string().trim().min(1).optional(),
    startedAt: isoTimestampSchema.optional(),
    endedAt: isoTimestampSchema,
    transportAttemptCounts: jsonObjectSchema,
    httpSummary: jsonObjectSchema,
    trafficDeliverySummary: jsonObjectSchema,
    businessOutcomeSummary: jsonObjectSchema,
    terminalInventorySnapshot: jsonObjectSchema.optional(),
    capturedAt: isoTimestampSchema,
  })
  .strict();
