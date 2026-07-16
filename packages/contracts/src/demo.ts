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
  erpAttemptStatusSchema,
  operatorModeSchema,
  orderEventNameSchema,
  orderStatusSchema,
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
import { collectPublicRuntimePolicyViolations } from "./public-runtime-policy-validation.js";
import {
  queueStatusSchema,
  simulatedNotificationChannelSchema,
  simulatedNotificationStatusSchema,
} from "./queue.js";

export const publicPresetListPath = "/demo/presets/public" as const;
export const publicRuntimePolicyPath = "/demo/runtime-policy" as const;
export const startDemoRunPath = "/demo/runs/start" as const;
export const runHistoryPath = "/demo/runs/history" as const;
export const runHistoryDetailPathTemplate = "/demo/runs/history/:runId" as const;
export const adminRunHistoryDetailPathTemplate = "/admin/demo/runs/history/:runId" as const;
export const adminDemoResetPath = "/admin/demo/reset" as const;
export const adminMaintenanceCleanupRunsPath = "/admin/demo/runs/cleanup" as const;
export const adminGeneratedRunTeardownPathTemplate = "/admin/demo/runs/:runId" as const;
export const adminPresetListPath = "/admin/demo/presets" as const;
export const adminPresetSavePath = "/admin/demo/presets/save" as const;
export const adminPresetDuplicatePath = "/admin/demo/presets/duplicate" as const;
export const adminPresetCopyToCustomPath = "/admin/demo/presets/copy-to-custom" as const;
export const adminPublicRuntimePolicyPath = "/admin/demo/runtime-policy" as const;
export const demoRunOperatorModeHeaderName = "x-demo-operator-mode" as const;
export const publicVisitorIdHeaderName = "x-public-visitor-id" as const;

export function runHistoryDetailPath(runId: string): string {
  return `${runHistoryPath}/${encodeURIComponent(runId)}`;
}

export function adminRunHistoryDetailPath(runId: string): string {
  return `/admin/demo/runs/history/${encodeURIComponent(runId)}`;
}

export function adminGeneratedRunTeardownPath(runId: string): string {
  return `/admin/demo/runs/${encodeURIComponent(runId)}`;
}

export const demoPresetContractSchema = demoPresetSchema
  .extend({
    trafficConfig: trafficConfigSchema,
    inventoryConfig: inventoryConfigSchema,
    erpConfig: erpRunConfigSchema,
    backpressureConfig: backpressureConfigSchema,
  })
  .strict();
export type DemoPresetContract = z.infer<typeof demoPresetContractSchema>;

// Admin-only preset list item. Extends the general preset contract with a
// server-computed capability flag. `canArchive` is never trusted from clients;
// it is derived from persisted provenance (system/public/custom) and lifecycle.
export const adminPresetListItemSchema = demoPresetContractSchema
  .extend({ canArchive: z.boolean() })
  .strict();
export type AdminPresetListItem = z.infer<typeof adminPresetListItemSchema>;

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

export const completionOutcomeStatusValues = [
  "queued",
  "processing",
  "delayed",
  "retrying",
  "confirmed",
  "failed",
  "notification_recorded",
] as const;
export const completionOutcomeStatusSchema = z.enum(completionOutcomeStatusValues);
export type CompletionOutcomeStatus = z.infer<typeof completionOutcomeStatusSchema>;

const completionOutcomeOrderStatusSchema = z.enum(["queued", "processing", "confirmed", "failed"]);
const completionOutcomeErpAttemptStatusSchema = z.enum(["succeeded", "failed", "timed_out"]);

export const completionOutcomeSchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
    correlationId: correlationIdSchema,
    orderStatus: completionOutcomeOrderStatusSchema,
    displayStatus: completionOutcomeStatusSchema,
    queuedAt: isoTimestampSchema,
    processingAt: isoTimestampSchema.optional(),
    confirmedAt: isoTimestampSchema.optional(),
    failedAt: isoTimestampSchema.optional(),
    notificationRecordedAt: isoTimestampSchema.optional(),
    latestErpAttemptStatus: completionOutcomeErpAttemptStatusSchema.optional(),
    latestErpErrorCode: z.string().trim().min(1).optional(),
    latestEventAt: isoTimestampSchema,
  })
  .strict();
export type CompletionOutcome = z.infer<typeof completionOutcomeSchema>;

export const dashboardRecoveryResponseSchema = z
  .object({
    correlationId: correlationIdSchema,
    scope: z
      .object({
        runId: uuidSchema,
        saleOfferId: uuidSchema.nullable(),
      })
      .strict()
      .nullable(),
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
    recentCompletionOutcomes: z.array(completionOutcomeSchema).default([]),
    recoveredAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((recovery, context) => {
    if (recovery.currentRun === null && recovery.scope !== null) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Scope must be null when no current run is selected.",
      });
      return;
    }
    if (recovery.currentRun !== null && recovery.scope === null) {
      context.addIssue({
        code: "custom",
        path: ["scope"],
        message: "Scope must identify the selected current run.",
      });
      return;
    }
    if (recovery.currentRun === null || recovery.scope === null) return;
    if (recovery.scope.runId !== recovery.currentRun.runId) {
      context.addIssue({
        code: "custom",
        path: ["scope", "runId"],
        message: "Scope run ID must match the selected current run.",
      });
    }
    if (recovery.scope.saleOfferId !== (recovery.currentRun.saleOfferId ?? null)) {
      context.addIssue({
        code: "custom",
        path: ["scope", "saleOfferId"],
        message: "Scope sale offer ID must match the selected current run.",
      });
    }
  });
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

export const runHistoryListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(50).default(10),
  })
  .strict();
export type RunHistoryListQuery = z.infer<typeof runHistoryListQuerySchema>;

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

export const runHistoryDetailParamsSchema = z
  .object({
    runId: uuidSchema,
  })
  .strict();
export type RunHistoryDetailParams = z.infer<typeof runHistoryDetailParamsSchema>;

export const runHistoryOrderOutcomeSchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    quantity: positiveIntegerSchema,
    status: orderStatusSchema,
    failureCode: z.string().trim().min(1).optional(),
    queuedAt: isoTimestampSchema,
    processingAt: isoTimestampSchema.optional(),
    confirmedAt: isoTimestampSchema.optional(),
    failedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type RunHistoryOrderOutcome = z.infer<typeof runHistoryOrderOutcomeSchema>;

export const runHistoryErpAttemptSchema = z
  .object({
    attemptId: uuidSchema,
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    correlationId: correlationIdSchema,
    attemptNumber: positiveIntegerSchema,
    status: erpAttemptStatusSchema,
    terminal: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    errorCode: z.string().trim().min(1).optional(),
    latencyMs: nonnegativeIntegerSchema,
    startedAt: isoTimestampSchema,
    finishedAt: isoTimestampSchema,
  })
  .strict();
export type RunHistoryErpAttempt = z.infer<typeof runHistoryErpAttemptSchema>;

export const runHistoryNotificationSchema = z
  .object({
    notificationId: uuidSchema,
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    channel: simulatedNotificationChannelSchema,
    status: simulatedNotificationStatusSchema,
    recordedAt: isoTimestampSchema,
  })
  .strict();
export type RunHistoryNotification = z.infer<typeof runHistoryNotificationSchema>;

export const runHistoryEventTimelineEntrySchema = z
  .object({
    eventId: uuidSchema,
    eventName: orderEventNameSchema,
    source: z.string().trim().min(1),
    saleOfferId: uuidSchema,
    correlationId: correlationIdSchema,
    orderId: uuidSchema.optional(),
    publicOrderId: z.string().trim().min(1).optional(),
    occurredAt: isoTimestampSchema,
  })
  .strict();
export type RunHistoryEventTimelineEntry = z.infer<typeof runHistoryEventTimelineEntrySchema>;

const runHistoryCollectionMetadataSchema = z
  .object({
    totalCount: nonnegativeIntegerSchema,
    limit: positiveIntegerSchema,
    truncated: z.boolean(),
  })
  .strict();

export const adminRunHistoryDetailResponseSchema = z
  .object({
    summary: runHistorySummarySchema,
    run: demoRunSnapshotSchema,
    orders: runHistoryCollectionMetadataSchema
      .extend({
        records: z.array(runHistoryOrderOutcomeSchema),
      })
      .strict(),
    erpAttempts: runHistoryCollectionMetadataSchema
      .extend({
        records: z.array(runHistoryErpAttemptSchema),
      })
      .strict(),
    notifications: runHistoryCollectionMetadataSchema
      .extend({
        records: z.array(runHistoryNotificationSchema),
      })
      .strict(),
    eventTimeline: runHistoryCollectionMetadataSchema
      .extend({
        records: z.array(runHistoryEventTimelineEntrySchema),
      })
      .strict(),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type AdminRunHistoryDetailResponse = z.infer<typeof adminRunHistoryDetailResponseSchema>;

const publicTerminalInventorySnapshotSchema = terminalInventorySnapshotSchema
  .omit({ saleOfferId: true, source: true })
  .strict();

export const publicRunHistorySummarySchema = z
  .object({
    runId: uuidSchema,
    presetName: z.string().trim().min(1),
    status: demoRunStatusSchema,
    startedAt: isoTimestampSchema.optional(),
    endedAt: isoTimestampSchema,
    httpSummary: trafficHttpSummarySchema,
    trafficDeliverySummary: trafficDeliverySummarySchema.omit({ notes: true }).strict(),
    businessOutcomeSummary: businessOutcomeSummarySchema,
    terminalInventorySnapshot: publicTerminalInventorySnapshotSchema.optional(),
    capturedAt: isoTimestampSchema,
  })
  .strict();
export type PublicRunHistorySummary = z.infer<typeof publicRunHistorySummarySchema>;

export const publicRunHistoryRunSchema = z
  .object({
    runId: uuidSchema,
    presetName: z.string().trim().min(1),
    operatorMode: operatorModeSchema,
    status: demoRunStatusSchema,
    trafficStatus: trafficExecutionStatusSchema,
    configSnapshot: acceptedRunConfigSnapshotSchema,
    startedAt: isoTimestampSchema.optional(),
    trafficStartedAt: isoTimestampSchema.optional(),
    trafficEndedAt: isoTimestampSchema.optional(),
    finalizedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type PublicRunHistoryRun = z.infer<typeof publicRunHistoryRunSchema>;

const orderStatusCountsSchema = z
  .object({
    queued: nonnegativeIntegerSchema,
    processing: nonnegativeIntegerSchema,
    confirmed: nonnegativeIntegerSchema,
    failed: nonnegativeIntegerSchema,
  })
  .strict();
const erpAttemptStatusCountsSchema = z
  .object({
    succeeded: nonnegativeIntegerSchema,
    failed: nonnegativeIntegerSchema,
    timedOut: nonnegativeIntegerSchema,
  })
  .strict();

export const publicRunHistoryDetailResponseSchema = z
  .object({
    summary: publicRunHistorySummarySchema,
    run: publicRunHistoryRunSchema,
    orders: z
      .object({ totalCount: nonnegativeIntegerSchema, byStatus: orderStatusCountsSchema })
      .strict(),
    erpAttempts: z
      .object({
        totalCount: nonnegativeIntegerSchema,
        byStatus: erpAttemptStatusCountsSchema,
        averageLatencyMs: nonnegativeNumberSchema.nullable(),
        p95LatencyMs: nonnegativeNumberSchema.nullable(),
      })
      .strict(),
    notifications: z.object({ totalCount: nonnegativeIntegerSchema }).strict(),
    events: z.object({ totalCount: nonnegativeIntegerSchema }).strict(),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type PublicRunHistoryDetailResponse = z.infer<typeof publicRunHistoryDetailResponseSchema>;

// Compatibility aliases deliberately point at the narrowed anonymous DTO.
export const runHistoryDetailResponseSchema = publicRunHistoryDetailResponseSchema;
export type RunHistoryDetailResponse = PublicRunHistoryDetailResponse;

export const publicRunBudgetSchema = z
  .object({
    windowSeconds: positiveIntegerSchema,
    perVisitorMaxStarts: positiveIntegerSchema,
    globalMaxStarts: positiveIntegerSchema,
  })
  .strict();
export type PublicRunBudget = z.infer<typeof publicRunBudgetSchema>;

export const publicCustomLimitsSchema = z
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
    allowedTrafficModes: z
      .array(z.union([z.literal("buyer-spike"), z.literal("steady-arrival-rate")]))
      .min(1),
  })
  .strict();
export type PublicCustomLimits = z.infer<typeof publicCustomLimitsSchema>;

export const deploymentHardCapsSchema = z
  .object({
    maxBuyers: positiveIntegerSchema,
    maxTotalRequests: positiveIntegerSchema,
    maxRequestsPerSecond: positiveIntegerSchema,
    maxTrafficDurationSeconds: positiveIntegerSchema,
    maxTrafficStartDelaySeconds: nonnegativeIntegerSchema,
    maxPreAllocatedVus: positiveIntegerSchema,
    maxVus: positiveIntegerSchema,
  })
  .strict();
export type DeploymentHardCaps = z.infer<typeof deploymentHardCapsSchema>;

export const publicRuntimePolicyMutableSchema = z
  .object({
    isPublicRunBudgetEnforced: z.boolean(),
    publicRunBudget: publicRunBudgetSchema,
    publicCustomDefaults: acceptedRunConfigSnapshotSchema,
    publicCustomLimits: publicCustomLimitsSchema,
  })
  .strict();
export type PublicRuntimePolicyMutable = z.infer<typeof publicRuntimePolicyMutableSchema>;

const publicRuntimePolicyStructureSchema = publicRuntimePolicyMutableSchema
  .extend({
    deploymentHardCaps: deploymentHardCapsSchema,
  })
  .strict();
export type PublicRuntimePolicy = z.infer<typeof publicRuntimePolicyStructureSchema>;

export const publicRuntimePolicySchema = publicRuntimePolicyStructureSchema.superRefine(
  (policy, context) => {
    for (const violation of collectPublicRuntimePolicyViolations(policy)) {
      context.addIssue({
        code: "custom",
        message: violation.message,
        path: violation.path,
        params: {
          violationCode: violation.code,
          ...(violation.details ? { details: violation.details } : {}),
        },
      });
    }
  },
);

export const publicRuntimePolicyResponseSchema = z
  .object({
    id: z.literal("active"),
    policy: publicRuntimePolicySchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();
export type PublicRuntimePolicyResponse = z.infer<typeof publicRuntimePolicyResponseSchema>;

export const adminPublicRuntimePolicyResponseSchema = publicRuntimePolicyResponseSchema
  .extend({
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type AdminPublicRuntimePolicyResponse = z.infer<
  typeof adminPublicRuntimePolicyResponseSchema
>;

export const adminPublicRuntimePolicyUpdateRequestSchema = z
  .object({
    policy: publicRuntimePolicyMutableSchema,
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type AdminPublicRuntimePolicyUpdateRequest = z.infer<
  typeof adminPublicRuntimePolicyUpdateRequestSchema
>;

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

export const adminPresetListResponseSchema = z
  .object({
    presets: z.array(adminPresetListItemSchema),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type AdminPresetListResponse = z.infer<typeof adminPresetListResponseSchema>;

// Soft-archive operation. Active lists never expose raw archive timestamps;
// only this explicit archive response confirms the lifecycle result.
export const archiveAdminPresetRequestSchema = z
  .object({
    slug: z.string().trim().min(1),
  })
  .strict();
export type ArchiveAdminPresetRequest = z.infer<typeof archiveAdminPresetRequestSchema>;

export const archiveAdminPresetResponseSchema = z
  .object({
    slug: z.string().trim().min(1),
    archivedAt: isoTimestampSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type ArchiveAdminPresetResponse = z.infer<typeof archiveAdminPresetResponseSchema>;

export const adminPresetMutationResponseSchema = z
  .object({
    preset: demoPresetContractSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type AdminPresetMutationResponse = z.infer<typeof adminPresetMutationResponseSchema>;

export const duplicateDemoPresetRequestSchema = z
  .object({
    sourceSlug: z.string().trim().min(1),
    targetSlug: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type DuplicateDemoPresetRequest = z.infer<typeof duplicateDemoPresetRequestSchema>;

export const copyDemoPresetToCustomRequestSchema = z
  .object({
    sourceSlug: z.string().trim().min(1),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type CopyDemoPresetToCustomRequest = z.infer<typeof copyDemoPresetToCustomRequestSchema>;

export const adminDeleteRunHistoryRequestSchema = z
  .object({
    runIds: z.array(uuidSchema).min(1).optional(),
    deleteAllConfirmation: z.literal("DELETE_ALL_RUN_SUMMARIES").optional(),
    visibleFilter: jsonObjectSchema.optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const deletesSelectedRuns = Boolean(request.runIds?.length);
    const deletesAllRuns = request.deleteAllConfirmation === "DELETE_ALL_RUN_SUMMARIES";

    if (deletesSelectedRuns === deletesAllRuns) {
      context.addIssue({
        code: "custom",
        message:
          "Run History deletion requires either selected run IDs or the delete-all confirmation.",
        path: ["runIds"],
      });
    }
  });
export type AdminDeleteRunHistoryRequest = z.infer<typeof adminDeleteRunHistoryRequestSchema>;

export const adminDeleteRunHistoryResponseSchema = z
  .object({
    deletedSummaryCount: nonnegativeIntegerSchema,
    deletedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type AdminDeleteRunHistoryResponse = z.infer<typeof adminDeleteRunHistoryResponseSchema>;

export const adminDemoResetResponseSchema = z
  .object({
    failedRunCount: nonnegativeIntegerSchema,
    closedSaleOfferCount: nonnegativeIntegerSchema,
    cleanedQueueCount: nonnegativeIntegerSchema,
    cleanedJobCount: nonnegativeIntegerSchema,
    resetAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type AdminDemoResetResponse = z.infer<typeof adminDemoResetResponseSchema>;

export const adminMaintenanceCleanupRunsRequestSchema = z
  .object({
    keepLatest: positiveIntegerSchema.default(15),
    olderThanDays: positiveIntegerSchema.default(7),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type AdminMaintenanceCleanupRunsRequest = z.infer<
  typeof adminMaintenanceCleanupRunsRequestSchema
>;

export const adminMaintenanceCleanupRunsResponseSchema = z
  .object({
    deletedRunCount: nonnegativeIntegerSchema,
    deletedSaleOfferCount: nonnegativeIntegerSchema,
    preservedLatestCount: nonnegativeIntegerSchema,
    preservedActiveRunCount: nonnegativeIntegerSchema,
    cutoffBefore: isoTimestampSchema,
    cleanedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type AdminMaintenanceCleanupRunsResponse = z.infer<
  typeof adminMaintenanceCleanupRunsResponseSchema
>;

export const adminGeneratedRunTeardownParamsSchema = z.object({ runId: uuidSchema }).strict();
export type AdminGeneratedRunTeardownParams = z.infer<typeof adminGeneratedRunTeardownParamsSchema>;

const generatedRunTeardownCleanupSchema = z
  .object({
    redisKeysDeleted: nonnegativeIntegerSchema,
    queueJobsDeleted: nonnegativeIntegerSchema,
  })
  .strict();

export const adminGeneratedRunTeardownResponseSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("deleted"),
      runId: uuidSchema,
      saleOfferId: uuidSchema,
      cleanup: generatedRunTeardownCleanupSchema,
      cleanedAt: isoTimestampSchema,
      correlationId: correlationIdSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("already_absent"),
      runId: uuidSchema,
      cleanedAt: isoTimestampSchema,
      correlationId: correlationIdSchema,
    })
    .strict(),
]);
export type AdminGeneratedRunTeardownResponse = z.infer<
  typeof adminGeneratedRunTeardownResponseSchema
>;

export const trafficDeliveryStatusSummarySchema = z
  .object({
    status: trafficDeliveryStatusSchema,
    summary: trafficDeliverySummarySchema,
  })
  .strict();
export type TrafficDeliveryStatusSummary = z.infer<typeof trafficDeliveryStatusSummarySchema>;
