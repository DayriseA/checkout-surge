import { z } from "zod";
import { metricSampleSchema } from "./inventory.js";
import { trafficDeliveryStatusSchema, trafficExecutionStatusSchema } from "./lifecycle.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  percentageSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";
import { orderProcessBullMqQueueName, orderProcessQueueName } from "./queue.js";

export const trafficExecutionStartPath = "/traffic/start" as const;
export const trafficExecutionStatusPath = "/traffic/status/:runId" as const;
export const internalLoadMetricIngestPath = "/internal/load/metrics" as const;
export const internalTrafficCompletionPath = "/internal/load/completion" as const;

export const buyerSpikeTrafficConfigSchema = z
  .object({
    mode: z.literal("buyer-spike"),
    buyerCount: positiveIntegerSchema,
    duplicateEachBuyerAttempt: z.boolean().default(false),
    startDelaySeconds: nonnegativeIntegerSchema.default(0),
    maxDurationSeconds: positiveIntegerSchema,
    quantityPerAttempt: positiveIntegerSchema.default(1),
  })
  .strict();
export type BuyerSpikeTrafficConfig = z.infer<typeof buyerSpikeTrafficConfigSchema>;

export const steadyArrivalTrafficConfigSchema = z
  .object({
    mode: z.literal("steady-arrival-rate"),
    ratePerSecond: positiveIntegerSchema,
    startDelaySeconds: nonnegativeIntegerSchema.default(0),
    durationSeconds: positiveIntegerSchema,
    quantityPerAttempt: positiveIntegerSchema.default(1),
    k6Vus: z
      .object({
        preAllocatedVus: positiveIntegerSchema,
        maxVus: positiveIntegerSchema,
      })
      .strict()
      .optional(),
  })
  .strict();
export type SteadyArrivalTrafficConfig = z.infer<typeof steadyArrivalTrafficConfigSchema>;

export const trafficConfigSchema = z.discriminatedUnion("mode", [
  buyerSpikeTrafficConfigSchema,
  steadyArrivalTrafficConfigSchema,
]);
export type TrafficConfig = z.infer<typeof trafficConfigSchema>;

export const inventoryConfigSchema = z
  .object({
    startingStock: nonnegativeIntegerSchema,
    quantityPerCheckout: positiveIntegerSchema.default(1),
    reservationHoldMinutes: positiveIntegerSchema,
  })
  .strict();
export type InventoryConfig = z.infer<typeof inventoryConfigSchema>;

export const erpRunConfigSchema = z
  .object({
    latencyMs: nonnegativeIntegerSchema,
    maxTps: positiveIntegerSchema,
    errorRate: percentageSchema,
    forcedOutage: z.boolean().default(false),
    requestTimeoutMs: positiveIntegerSchema,
  })
  .strict();
export type ErpRunConfig = z.infer<typeof erpRunConfigSchema>;

export const orderProcessConcurrencyHardCap = 10;

export const retryPolicySchema = z
  .object({
    maxAttempts: positiveIntegerSchema,
    initialBackoffMs: nonnegativeIntegerSchema,
  })
  .strict();

export const backpressureConfigSchema = z
  .object({
    queueName: z.literal(orderProcessQueueName),
    physicalQueueName: z.literal(orderProcessBullMqQueueName),
    orderProcessConcurrency: positiveIntegerSchema.max(orderProcessConcurrencyHardCap),
    retryPolicy: retryPolicySchema,
    drainTimeoutSeconds: positiveIntegerSchema,
    pendingPersistenceRetryAfterSeconds: positiveIntegerSchema,
    circuitBreakerFailureThreshold: positiveIntegerSchema,
    circuitBreakerResetTimeoutMs: positiveIntegerSchema,
  })
  .strict();
export type BackpressureConfig = z.infer<typeof backpressureConfigSchema>;

export const acceptedRunConfigSnapshotSchema = z
  .object({
    trafficConfig: trafficConfigSchema,
    inventoryConfig: inventoryConfigSchema,
    erpConfig: erpRunConfigSchema,
    backpressureConfig: backpressureConfigSchema,
  })
  .strict();
export type AcceptedRunConfigSnapshot = z.infer<typeof acceptedRunConfigSnapshotSchema>;

export const trafficExecutionStartRequestSchema = z
  .object({
    runId: uuidSchema,
    saleOfferId: uuidSchema,
    apiBaseUrl: z.string().url(),
    buyEndpointPath: z.string().startsWith("/"),
    correlationId: correlationIdSchema,
    configSnapshot: acceptedRunConfigSnapshotSchema,
  })
  .strict();
export type TrafficExecutionStartRequest = z.infer<typeof trafficExecutionStartRequestSchema>;

export const trafficExecutionStartResponseSchema = z
  .object({
    runId: uuidSchema,
    status: trafficExecutionStatusSchema.extract(["starting", "active"]),
    startedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type TrafficExecutionStartResponse = z.infer<typeof trafficExecutionStartResponseSchema>;

export const trafficExecutionStatusResponseSchema = z
  .object({
    runId: uuidSchema,
    state: z.enum(["accepted", "executing", "completion_pending", "completed", "unknown"]),
    acceptedAt: isoTimestampSchema.optional(),
    correlationId: correlationIdSchema,
    observedAt: isoTimestampSchema,
  })
  .strict();
export type TrafficExecutionStatusResponse = z.infer<typeof trafficExecutionStatusResponseSchema>;

export const trafficCompletionAcknowledgementSchema = z
  .object({
    runId: uuidSchema,
    acknowledged: z.literal(true),
    correlationId: correlationIdSchema,
  })
  .strict();
export type TrafficCompletionAcknowledgement = z.infer<
  typeof trafficCompletionAcknowledgementSchema
>;

export const trafficHttpSummarySchema = z
  .object({
    plannedRequests: nonnegativeIntegerSchema,
    emittedRequests: nonnegativeIntegerSchema,
    completedRequests: nonnegativeIntegerSchema,
    failedRequests: nonnegativeIntegerSchema,
    acceptedResponses: nonnegativeIntegerSchema,
    soldOutResponses: nonnegativeIntegerSchema,
    unexpectedResponses: nonnegativeIntegerSchema,
    p95LatencyMs: nonnegativeNumberSchema.optional(),
    failureRate: percentageSchema,
  })
  .strict();
export type TrafficHttpSummary = z.infer<typeof trafficHttpSummarySchema>;

export const trafficDeliverySummarySchema = z
  .object({
    plannedRequests: nonnegativeIntegerSchema,
    emittedRequests: nonnegativeIntegerSchema,
    droppedIterations: nonnegativeIntegerSchema,
    trafficDeliveryStatus: trafficDeliveryStatusSchema,
    notes: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export type TrafficDeliverySummary = z.infer<typeof trafficDeliverySummarySchema>;

export const trafficCompletionReportSchema = z
  .object({
    runId: uuidSchema,
    status: trafficExecutionStatusSchema.extract(["succeeded", "failed"]),
    exitCode: z.number().int().optional(),
    errorMessage: z.string().trim().min(1).optional(),
    httpSummary: trafficHttpSummarySchema,
    trafficOutcomeSummary: jsonObjectSchema,
    trafficDeliverySummary: trafficDeliverySummarySchema,
    httpTimingBreakdownSummary: jsonObjectSchema,
    loadRunDiagnosticsSummary: jsonObjectSchema,
    apiRequestLifecycleSummary: jsonObjectSchema,
    completedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type TrafficCompletionReport = z.infer<typeof trafficCompletionReportSchema>;

export const loadMetricIngestRequestSchema = z
  .object({
    runId: uuidSchema,
    correlationId: correlationIdSchema,
    samples: z.array(metricSampleSchema).min(1),
    raw: jsonObjectSchema.optional(),
    observedAt: isoTimestampSchema,
  })
  .strict();
export type LoadMetricIngestRequest = z.infer<typeof loadMetricIngestRequestSchema>;
