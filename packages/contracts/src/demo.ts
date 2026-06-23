import { z } from "zod";
import {
  demoPresetDisplaySchema,
  demoPresetSchema,
  demoRunSummaryShapeSchema,
} from "./entities.js";
import { erpResilienceStatusSchema } from "./erp.js";
import { inventoryStatusSchema, terminalInventorySnapshotSchema } from "./inventory.js";
import {
  demoRunStatusSchema,
  operatorModeSchema,
  trafficDeliveryStatusSchema,
  trafficExecutionStatusSchema,
} from "./lifecycle.js";
import {
  acceptedRunConfigSnapshotSchema,
  backpressureConfigSchema,
  erpRunConfigSchema,
  inventoryConfigSchema,
  trafficConfigSchema,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "./load.js";
import {
  correlationIdSchema,
  isoTimestampSchema,
  jsonObjectSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";
import { queueStatusSchema } from "./queue.js";

export const demoPresetContractSchema = demoPresetSchema
  .extend({
    trafficConfig: trafficConfigSchema,
    inventoryConfig: inventoryConfigSchema,
    erpConfig: erpRunConfigSchema,
    backpressureConfig: backpressureConfigSchema,
  })
  .strict();
export type DemoPresetContract = z.infer<typeof demoPresetContractSchema>;

export const publicPresetListResponseSchema = z
  .object({
    presets: z.array(demoPresetContractSchema),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type PublicPresetListResponse = z.infer<typeof publicPresetListResponseSchema>;

export const demoRunConfigOverrideSchema = z
  .object({
    trafficConfig: trafficConfigSchema.optional(),
    inventoryConfig: inventoryConfigSchema.optional(),
    erpConfig: erpRunConfigSchema.optional(),
    backpressureConfig: backpressureConfigSchema.optional(),
  })
  .strict();
export type DemoRunConfigOverride = z.infer<typeof demoRunConfigOverrideSchema>;

export const startDemoRunRequestSchema = z
  .object({
    presetSlug: z.string().trim().min(1),
    operatorMode: operatorModeSchema,
    publicVisitorId: z.string().trim().min(1).optional(),
    configOverride: demoRunConfigOverrideSchema.optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type StartDemoRunRequest = z.infer<typeof startDemoRunRequestSchema>;

export const demoRunSnapshotSchema = z
  .object({
    runId: uuidSchema,
    presetId: uuidSchema,
    presetName: z.string().trim().min(1),
    operatorMode: operatorModeSchema,
    status: demoRunStatusSchema,
    trafficStatus: trafficExecutionStatusSchema,
    saleOfferId: uuidSchema.optional(),
    configSnapshot: acceptedRunConfigSnapshotSchema,
    startedAt: isoTimestampSchema.optional(),
    trafficStartedAt: isoTimestampSchema.optional(),
    trafficEndedAt: isoTimestampSchema.optional(),
    finalizedAt: isoTimestampSchema.optional(),
    failureReason: z.string().trim().min(1).optional(),
  })
  .strict();
export type DemoRunSnapshot = z.infer<typeof demoRunSnapshotSchema>;

export const startDemoRunResponseSchema = z
  .object({
    run: demoRunSnapshotSchema,
    recovery: z.object({ establishedAt: isoTimestampSchema }).strict(),
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type StartDemoRunResponse = z.infer<typeof startDemoRunResponseSchema>;

export const businessOutcomeSummarySchema = z
  .object({
    acceptedReservations: nonnegativeIntegerSchema,
    soldOutRejections: nonnegativeIntegerSchema,
    queuedOrders: nonnegativeIntegerSchema,
    processingOrders: nonnegativeIntegerSchema.default(0),
    retryingOrders: nonnegativeIntegerSchema.default(0),
    confirmedOrders: nonnegativeIntegerSchema,
    failedOrders: nonnegativeIntegerSchema,
    pendingPersistenceCount: nonnegativeIntegerSchema,
    notificationsRecorded: nonnegativeIntegerSchema,
  })
  .strict();
export type BusinessOutcomeSummary = z.infer<typeof businessOutcomeSummarySchema>;

export const consistencyLagSummarySchema = z
  .object({
    confirmedOrderCount: nonnegativeIntegerSchema,
    pendingConfirmationCount: nonnegativeIntegerSchema,
    averageLagMs: nonnegativeNumberSchema.nullable(),
    p95LagMs: nonnegativeNumberSchema.nullable(),
    maxLagMs: nonnegativeNumberSchema.nullable(),
    oldestPendingAgeSeconds: nonnegativeNumberSchema.nullable(),
    measuredAt: isoTimestampSchema,
  })
  .strict();
export type ConsistencyLagSummary = z.infer<typeof consistencyLagSummarySchema>;

export const dashboardRecoveryResponseSchema = z
  .object({
    currentRun: demoRunSnapshotSchema.nullable(),
    inventory: inventoryStatusSchema.nullable(),
    recentMetrics: z
      .array(
        z
          .object({
            metricName: z.string().trim().min(1),
            value: z.number().finite(),
            unit: z.string().trim().min(1),
            timestamp: isoTimestampSchema,
          })
          .strict(),
      )
      .default([]),
    queue: queueStatusSchema.nullable(),
    erp: erpResilienceStatusSchema.nullable(),
    businessOutcome: businessOutcomeSummarySchema.nullable(),
    consistencyLag: consistencyLagSummarySchema.nullable(),
    recoveredAt: isoTimestampSchema,
  })
  .strict();
export type DashboardRecoveryResponse = z.infer<typeof dashboardRecoveryResponseSchema>;

export const runHistorySummarySchema = demoRunSummaryShapeSchema
  .extend({
    httpSummary: trafficHttpSummarySchema,
    trafficDeliverySummary: trafficDeliverySummarySchema,
    businessOutcomeSummary: businessOutcomeSummarySchema,
    terminalInventorySnapshot: terminalInventorySnapshotSchema.optional(),
  })
  .strict();
export type RunHistorySummary = z.infer<typeof runHistorySummarySchema>;

export const runHistoryListResponseSchema = z
  .object({
    summaries: z.array(runHistorySummarySchema),
    page: positiveIntegerSchema,
    pageSize: positiveIntegerSchema,
    totalCount: nonnegativeIntegerSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type RunHistoryListResponse = z.infer<typeof runHistoryListResponseSchema>;

export const publicRuntimePolicySchema = z
  .object({
    isPublicRunBudgetEnforced: z.boolean(),
    publicRunBudget: z
      .object({
        windowSeconds: positiveIntegerSchema,
        perVisitorMaxStarts: positiveIntegerSchema,
        globalMaxStarts: positiveIntegerSchema,
      })
      .strict(),
    publicCustomDefaults: acceptedRunConfigSnapshotSchema,
    publicCustomLimits: z
      .object({
        maxTotalRequests: positiveIntegerSchema,
        maxBuyers: positiveIntegerSchema,
        maxRequestsPerSecond: positiveIntegerSchema,
        maxTrafficDurationSeconds: positiveIntegerSchema,
        maxTrafficStartDelaySeconds: nonnegativeIntegerSchema,
        maxPreAllocatedVus: positiveIntegerSchema,
        maxVus: positiveIntegerSchema,
        maxStartingStock: positiveIntegerSchema,
        maxErpLatencyMs: nonnegativeIntegerSchema,
        minErpMaxTps: positiveIntegerSchema,
        maxErpMaxTps: positiveIntegerSchema,
        maxErpErrorRate: z.number().min(0).max(1),
        allowForcedOutage: z.boolean(),
        allowedTrafficModes: z.array(
          z.union([z.literal("buyer-spike"), z.literal("steady-arrival-rate")]),
        ),
      })
      .strict(),
    deploymentHardCaps: z
      .object({
        maxBuyers: positiveIntegerSchema,
        maxTotalRequests: positiveIntegerSchema,
        maxRequestsPerSecond: positiveIntegerSchema,
        maxTrafficDurationSeconds: positiveIntegerSchema,
        maxTrafficStartDelaySeconds: nonnegativeIntegerSchema,
        maxPreAllocatedVus: positiveIntegerSchema,
        maxVus: positiveIntegerSchema,
      })
      .strict(),
  })
  .strict();
export type PublicRuntimePolicy = z.infer<typeof publicRuntimePolicySchema>;

export const publicRuntimePolicyResponseSchema = z
  .object({
    id: z.literal("active"),
    policy: publicRuntimePolicySchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type PublicRuntimePolicyResponse = z.infer<typeof publicRuntimePolicyResponseSchema>;

export const saveDemoPresetRequestSchema = z
  .object({
    slug: z.string().trim().min(1),
    display: demoPresetDisplaySchema,
    trafficConfig: trafficConfigSchema,
    inventoryConfig: inventoryConfigSchema,
    erpConfig: erpRunConfigSchema,
    backpressureConfig: backpressureConfigSchema,
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type SaveDemoPresetRequest = z.infer<typeof saveDemoPresetRequestSchema>;

export const adminDeleteRunHistoryRequestSchema = z
  .object({
    runIds: z.array(uuidSchema).optional(),
    deleteAllConfirmation: z.literal("DELETE_ALL_RUN_SUMMARIES").optional(),
    visibleFilter: jsonObjectSchema.optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type AdminDeleteRunHistoryRequest = z.infer<typeof adminDeleteRunHistoryRequestSchema>;

export const trafficDeliveryStatusSummarySchema = z
  .object({
    status: trafficDeliveryStatusSchema,
    summary: trafficDeliverySummarySchema,
  })
  .strict();
export type TrafficDeliveryStatusSummary = z.infer<typeof trafficDeliveryStatusSummarySchema>;
