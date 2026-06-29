import { z } from "zod";
import {
  demoPresetVisibilitySchema,
  demoRunStatusSchema,
  orderStatusSchema,
  reservationStatusSchema,
  saleOfferPurposeSchema,
} from "./lifecycle.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

export const productSchema = z
  .object({
    id: uuidSchema,
    sku: z.string().trim().min(1),
    slug: z.string().trim().min(1),
    name: z.string().trim().min(1),
    isActive: z.boolean(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type Product = z.infer<typeof productSchema>;

export const saleOfferSchema = z
  .object({
    id: uuidSchema,
    productId: uuidSchema,
    name: z.string().trim().min(1),
    allocatedStock: nonnegativeIntegerSchema,
    saleStartsAt: isoTimestampSchema,
    saleEndsAt: isoTimestampSchema,
    isActive: z.boolean(),
    purpose: saleOfferPurposeSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type SaleOffer = z.infer<typeof saleOfferSchema>;

export const reservationSummarySchema = z
  .object({
    id: uuidSchema,
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    runId: uuidSchema.optional(),
    quantity: positiveIntegerSchema,
    status: reservationStatusSchema,
    reservationToken: z.string().trim().min(1).optional(),
    expiresAt: isoTimestampSchema,
    securedAt: isoTimestampSchema,
  })
  .strict();
export type ReservationSummary = z.infer<typeof reservationSummarySchema>;

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
export type OrderSummary = z.infer<typeof orderSummarySchema>;

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
    trafficDeliverySummary: jsonObjectSchema,
    businessOutcomeSummary: jsonObjectSchema,
    terminalInventorySnapshot: jsonObjectSchema.optional(),
    capturedAt: isoTimestampSchema,
  })
  .strict();
export type DemoRunSummaryShape = z.infer<typeof demoRunSummaryShapeSchema>;
