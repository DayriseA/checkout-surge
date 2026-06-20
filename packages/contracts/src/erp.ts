import { z } from "zod";
import { erpAttemptStatusSchema } from "./lifecycle.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  percentageSchema,
  uuidSchema,
} from "./primitives.js";

export const erpConfirmationRequestSchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    reservationId: uuidSchema,
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
    correlationId: correlationIdSchema,
    quantity: z.number().int().positive(),
  })
  .strict();
export type ErpConfirmationRequest = z.infer<typeof erpConfirmationRequestSchema>;

export const erpConfirmationResponseSchema = z
  .object({
    status: erpAttemptStatusSchema,
    confirmationId: z.string().trim().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    errorCode: z.string().trim().min(1).optional(),
    errorMessage: z.string().trim().min(1).optional(),
    latencyMs: nonnegativeNumberSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type ErpConfirmationResponse = z.infer<typeof erpConfirmationResponseSchema>;

export const erpChaosConfigSchema = z
  .object({
    latencyMs: nonnegativeIntegerSchema,
    maxTps: z.number().int().positive(),
    errorRate: percentageSchema,
    forcedOutage: z.boolean().default(false),
  })
  .strict();
export type ErpChaosConfig = z.infer<typeof erpChaosConfigSchema>;

export const erpChaosStatusSchema = erpChaosConfigSchema
  .extend({
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ErpChaosStatus = z.infer<typeof erpChaosStatusSchema>;
