import { z } from "zod";
import { erpAttemptStatusSchema } from "./lifecycle.js";
import {
  correlationIdSchema,
  idempotencyKeySchema,
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  percentageSchema,
  uuidSchema,
} from "./primitives.js";

export const erpConfirmationPath = "/confirmations" as const;
export const erpChaosStatusPath = "/chaos" as const;
export const erpChaosResetPath = "/chaos/reset" as const;
export const erpResilienceStatusPath = "/erp/status" as const;
export const controlServiceTokenHeaderName = "x-control-service-token" as const;

export const erpChaosConfigSchema = z
  .object({
    latencyMs: nonnegativeIntegerSchema,
    maxTps: z.number().int().positive(),
    errorRate: percentageSchema,
    forcedOutage: z.boolean().default(false),
  })
  .strict();
export type ErpChaosConfig = z.infer<typeof erpChaosConfigSchema>;

export const erpConfirmationRequestSchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    reservationId: uuidSchema,
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
    erpConfig: erpChaosConfigSchema.optional(),
    correlationId: correlationIdSchema,
    quantity: z.number().int().positive(),
  })
  .strict();
export type ErpConfirmationRequest = z.infer<typeof erpConfirmationRequestSchema>;

export const erpConfirmationResponseStatusValues = ["succeeded", "failed"] as const;
export const erpConfirmationResponseStatusSchema = z.enum(erpConfirmationResponseStatusValues);
export type ErpConfirmationResponseStatus = z.infer<typeof erpConfirmationResponseStatusSchema>;

export const erpConfirmationResponseSchema = z
  .object({
    status: erpConfirmationResponseStatusSchema,
    confirmationId: z.string().trim().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    errorCode: z.string().trim().min(1).optional(),
    errorMessage: z.string().trim().min(1).optional(),
    latencyMs: nonnegativeNumberSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type ErpConfirmationResponse = z.infer<typeof erpConfirmationResponseSchema>;

export const erpChaosStatusSchema = erpChaosConfigSchema
  .extend({
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ErpChaosStatus = z.infer<typeof erpChaosStatusSchema>;

export const erpCircuitStateValues = ["closed", "open", "half_open"] as const;
export const erpCircuitStateSchema = z.enum(erpCircuitStateValues);
export type ErpCircuitState = z.infer<typeof erpCircuitStateSchema>;

export const erpCircuitBreakerSnapshotSchema = z
  .object({
    state: erpCircuitStateSchema,
    consecutiveFailureCount: nonnegativeIntegerSchema,
    failureThreshold: z.number().int().positive(),
    resetTimeoutMs: nonnegativeIntegerSchema,
    openedAt: isoTimestampSchema.nullable(),
    nextAttemptAt: isoTimestampSchema.nullable(),
    halfOpenProbeInFlight: z.boolean(),
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ErpCircuitBreakerSnapshot = z.infer<typeof erpCircuitBreakerSnapshotSchema>;

export const erpDependencyStatusValues = ["healthy", "degraded", "unavailable"] as const;
export const erpDependencyStatusSchema = z.enum(erpDependencyStatusValues);
export type ErpDependencyStatus = z.infer<typeof erpDependencyStatusSchema>;

export const erpRetryPressureSchema = z
  .object({
    retryingJobCount: nonnegativeIntegerSchema,
    retryAttemptCount: nonnegativeIntegerSchema,
    inspectedJobCount: nonnegativeIntegerSchema,
    inspectionLimit: z.number().int().positive(),
    inspectionTruncated: z.boolean(),
  })
  .strict();
export type ErpRetryPressure = z.infer<typeof erpRetryPressureSchema>;

export const erpLatestAttemptSummarySchema = z
  .object({
    orderId: uuidSchema,
    runId: uuidSchema.nullable(),
    attemptNumber: z.number().int().positive(),
    status: erpAttemptStatusSchema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    errorCode: z.string().trim().min(1).nullable(),
    errorMessage: z.string().trim().min(1).nullable(),
    latencyMs: nonnegativeIntegerSchema,
    finishedAt: isoTimestampSchema,
  })
  .strict();
export type ErpLatestAttemptSummary = z.infer<typeof erpLatestAttemptSummarySchema>;

export const erpConfirmationDelaySchema = z
  .object({
    processingOrderCount: nonnegativeIntegerSchema,
    oldestProcessingAgeSeconds: nonnegativeNumberSchema.nullable(),
    recentConfirmedCount: nonnegativeIntegerSchema,
    averageConfirmationDelayMs: nonnegativeNumberSchema.nullable(),
  })
  .strict();
export type ErpConfirmationDelay = z.infer<typeof erpConfirmationDelaySchema>;

export const erpResilienceStatusSchema = z
  .object({
    status: erpDependencyStatusSchema,
    reason: z.string().trim().min(1).nullable(),
    circuit: erpCircuitBreakerSnapshotSchema.nullable(),
    retryPressure: erpRetryPressureSchema,
    latestAttempt: erpLatestAttemptSummarySchema.nullable(),
    recentAttemptWindowSeconds: z.number().int().positive(),
    recentAttemptCount: nonnegativeIntegerSchema,
    recentFailureCount: nonnegativeIntegerSchema,
    recentTimeoutCount: nonnegativeIntegerSchema,
    confirmationDelay: erpConfirmationDelaySchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type ErpResilienceStatus = z.infer<typeof erpResilienceStatusSchema>;
