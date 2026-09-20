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
export const erpConfirmationLookupPath = "/confirmations/:idempotencyKey" as const;
export const erpConfirmationLookupParamsSchema = z
  .object({ idempotencyKey: idempotencyKeySchema })
  .strict();
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

export const erpChaosSafetyCapsSchema = z
  .object({
    maxLatencyMs: nonnegativeIntegerSchema,
    minMaxTps: z.number().int().positive(),
    maxErrorRate: percentageSchema,
    allowForcedOutage: z.boolean(),
  })
  .strict();
export type ErpChaosSafetyCaps = z.infer<typeof erpChaosSafetyCapsSchema>;

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

const erpConfirmationResponseBaseShape = {
  latencyMs: nonnegativeNumberSchema,
  timestamp: isoTimestampSchema,
};

export const erpConfirmationSucceededResponseSchema = z
  .object({
    ...erpConfirmationResponseBaseShape,
    status: z.literal("succeeded"),
    confirmationId: z.string().trim().min(1),
    httpStatus: z.literal(200),
    errorCode: z.never().optional(),
    errorMessage: z.never().optional(),
  })
  .strict();
export type ErpConfirmationSucceededResponse = z.infer<
  typeof erpConfirmationSucceededResponseSchema
>;

export const erpConfirmationFailedResponseSchema = z
  .object({
    ...erpConfirmationResponseBaseShape,
    status: z.literal("failed"),
    confirmationId: z.never().optional(),
    httpStatus: z.number().int().min(400).max(599),
    errorCode: z.string().trim().min(1),
    errorMessage: z.string().trim().min(1),
  })
  .strict();
export type ErpConfirmationFailedResponse = z.infer<typeof erpConfirmationFailedResponseSchema>;

export const erpConfirmationResponseSchema = z.discriminatedUnion("status", [
  erpConfirmationSucceededResponseSchema,
  erpConfirmationFailedResponseSchema,
]);
export type ErpConfirmationResponse = z.infer<typeof erpConfirmationResponseSchema>;

export const erpChaosStatusSchema = erpChaosConfigSchema
  .extend({
    defaultConfig: erpChaosConfigSchema,
    updatedAt: isoTimestampSchema,
    effectiveSafetyCaps: erpChaosSafetyCapsSchema,
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
    /** Edge-triggered clock: changes only when the breaker state changes. */
    lastChangedAt: isoTimestampSchema,
  })
  .strict();
export type ErpCircuitBreakerSnapshot = z.infer<typeof erpCircuitBreakerSnapshotSchema>;

export const erpDependencyStatusValues = ["healthy", "degraded", "unavailable"] as const;
export const erpDependencyStatusSchema = z.enum(erpDependencyStatusValues);

export const erpRetryPressureSchema = z
  .object({
    retryingJobCount: nonnegativeIntegerSchema,
    retryAttemptCount: nonnegativeIntegerSchema,
    inspectedJobCount: nonnegativeIntegerSchema,
    inspectionLimit: z.number().int().positive(),
    inspectionTruncated: z.boolean(),
  })
  .strict();

export const erpLatestAttemptSummarySchema = z
  .object({
    runId: uuidSchema.nullable(),
    status: erpAttemptStatusSchema,
    finishedAt: isoTimestampSchema,
  })
  .strict();
export type ErpLatestAttemptSummary = z.infer<typeof erpLatestAttemptSummarySchema>;

export const erpAttemptHistoryRetentionLimit = 32;

export const erpCumulativeOutcomeCountsSchema = z
  .object({
    capacityRejected: nonnegativeIntegerSchema,
    temporarilyUnavailable: nonnegativeIntegerSchema,
    uncertainResult: nonnegativeIntegerSchema,
    permanentRejected: nonnegativeIntegerSchema,
  })
  .strict();
export type ErpCumulativeOutcomeCounts = z.infer<typeof erpCumulativeOutcomeCountsSchema>;

export const runErpOutcomeSummarySchema = z
  .object({
    runId: uuidSchema,
    circuit: erpCircuitBreakerSnapshotSchema.nullable(),
    circuitReadStatus: z.enum(["available", "unavailable"]),
    latestAttempt: erpLatestAttemptSummarySchema.nullable(),
    recentAttemptWindowSeconds: z.number().int().positive(),
    recentAttemptCount: nonnegativeIntegerSchema,
    recentFailureCount: nonnegativeIntegerSchema,
    recentTimeoutCount: nonnegativeIntegerSchema,
    recentAttemptCoverage: z.literal("retained_history").optional(),
    attemptRetentionLimitPerOrder: z.literal(erpAttemptHistoryRetentionLimit).optional(),
    cumulativeOutcomeCounts: erpCumulativeOutcomeCountsSchema.optional(),
    observedAt: isoTimestampSchema,
  })
  .strict();
export type RunErpOutcomeSummary = z.infer<typeof runErpOutcomeSummarySchema>;

export const sharedErpProtectionStatusSchema = z
  .object({
    status: erpDependencyStatusSchema,
    reason: z.string().trim().min(1).nullable(),
    circuit: erpCircuitBreakerSnapshotSchema.nullable(),
    retryPressure: erpRetryPressureSchema,
    observedAt: isoTimestampSchema,
  })
  .strict();
export type SharedErpProtectionStatus = z.infer<typeof sharedErpProtectionStatusSchema>;
