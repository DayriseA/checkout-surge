import { z } from "zod";
import {
  demoPresetDisplaySchema,
  demoPresetSchema,
  demoRunSummaryShapeSchema,
} from "./entities.js";
import {
  erpAttemptHistoryRetentionLimit,
  erpCumulativeOutcomeCountsSchema,
  largestAllowedErpLatencyMs,
} from "./erp.js";
import { terminalInventorySnapshotSchema } from "./inventory.js";
import {
  demoRunStatusSchema,
  erpAttemptStatusSchema,
  operatorModeSchema,
  orderEventNameSchema,
  orderStatusSchema,
  trafficExecutionStatusSchema,
} from "./lifecycle.js";
import {
  acceptedErpRunConfigSchema,
  acceptedRunConfigSnapshotSchema,
  acceptedRunConfigWriteSchema,
  backpressureConfigSchema,
  erpRunConfigSchema,
  httpTimingBreakdownSummarySchema,
  inventoryConfigSchema,
  loadRunDiagnosticsSummarySchema,
  serverReservationTimingSummarySchema,
  trafficConfigSchema,
  trafficDeliverySummarySchema,
  trafficDeliverySummaryShape,
  trafficHttpSummarySchema,
} from "./load.js";
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
import {
  collectPublicRuntimePolicyMutableViolations,
  collectPublicRuntimePolicyViolations,
} from "./public-runtime-policy-validation.js";
import {
  internalRunFailureReasonSchema,
  publicRunFailureCategorySchema,
  runResultClassificationSchema,
  runResultOutcomeSchema,
  runResultSchema,
} from "./run-result.js";
import { runSignalTimelineHeadlineSchema, runSignalTimelineSummarySchema } from "./run-signals.js";
import { transportAttemptCountsSchema } from "./traffic-transport-counts.js";

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
    erpConfig: acceptedErpRunConfigSchema.optional(),
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

const demoRunSnapshotBaseShape = {
  runId: uuidSchema,
  presetId: uuidSchema,
  presetName: z.string().trim().min(1),
  operatorMode: operatorModeSchema,
  saleOfferId: uuidSchema.optional(),
  adminResetCompletedAt: isoTimestampSchema.optional(),
  configSnapshot: acceptedRunConfigSnapshotSchema,
  startedAt: isoTimestampSchema,
};

const nonterminalDemoRunSnapshotShape = {
  finalizedAt: z.never().optional(),
  failureCategory: z.never().optional(),
};

const failedDemoRunSnapshotSchema = z
  .object({
    ...demoRunSnapshotBaseShape,
    status: z.literal("failed"),
    trafficStatus: z.enum(["succeeded", "failed"]),
    trafficStartedAt: isoTimestampSchema.optional(),
    trafficEndedAt: isoTimestampSchema.optional(),
    finalizedAt: isoTimestampSchema,
    failureCategory: publicRunFailureCategorySchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.trafficEndedAt !== undefined && run.trafficStartedAt === undefined) {
      context.addIssue({
        code: "custom",
        path: ["trafficStartedAt"],
        message: "A traffic start timestamp is required when traffic has ended.",
      });
    }
    if (
      run.trafficStatus === "succeeded" &&
      (run.trafficStartedAt === undefined || run.trafficEndedAt === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["trafficStatus"],
        message: "Succeeded traffic requires both traffic lifecycle timestamps.",
      });
    }
  });

export const demoRunSnapshotSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...demoRunSnapshotBaseShape,
      ...nonterminalDemoRunSnapshotShape,
      status: z.literal("starting"),
      trafficStatus: z.literal("starting"),
      trafficStartedAt: z.never().optional(),
      trafficEndedAt: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...demoRunSnapshotBaseShape,
      ...nonterminalDemoRunSnapshotShape,
      status: z.literal("active"),
      trafficStatus: z.enum(["starting", "active"]),
      trafficStartedAt: isoTimestampSchema,
      trafficEndedAt: z.never().optional(),
    })
    .strict(),
  z
    .object({
      ...demoRunSnapshotBaseShape,
      ...nonterminalDemoRunSnapshotShape,
      status: z.literal("draining"),
      trafficStatus: z.enum(["succeeded", "failed"]),
      trafficStartedAt: isoTimestampSchema,
      trafficEndedAt: isoTimestampSchema,
    })
    .strict(),
  z
    .object({
      ...demoRunSnapshotBaseShape,
      status: z.literal("completed"),
      trafficStatus: z.literal("succeeded"),
      trafficStartedAt: isoTimestampSchema,
      trafficEndedAt: isoTimestampSchema,
      finalizedAt: isoTimestampSchema,
      failureCategory: z.never().optional(),
    })
    .strict(),
  failedDemoRunSnapshotSchema,
]);
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
    /** Durable sum of reservation quantities; acceptedReservations is a row count. */
    reservedUnits: nonnegativeIntegerSchema,
    /**
     * Durable count captured once at traffic-completion enrichment; 0 until then, so a live 0
     * means "not captured yet", not "no rejections". The live count during a run is
     * `inventory.soldOutPressure.rejectionCount`; finalization requires both to agree.
     */
    soldOutRejections: nonnegativeIntegerSchema,
    /** Live form of queueBacklogDefinition: accepted_awaiting_first_processing_start. */
    queuedOrders: nonnegativeIntegerSchema,
    processingOrders: nonnegativeIntegerSchema.default(0),
    retryingOrders: nonnegativeIntegerSchema.default(0),
    confirmedOrders: nonnegativeIntegerSchema,
    failedOrders: nonnegativeIntegerSchema,
    /** Permanent ERP rejections. Optional for immutable historical summaries. */
    businessRejectedOrders: nonnegativeIntegerSchema.optional(),
    /** Explicit administrative dispositions. Optional for immutable historical summaries. */
    administrativelyDisposedOrders: nonnegativeIntegerSchema.optional(),
    pendingPersistenceCount: nonnegativeIntegerSchema,
    notificationsRecorded: nonnegativeIntegerSchema,
  })
  .strict();
export type BusinessOutcomeSummary = z.infer<typeof businessOutcomeSummarySchema>;

/** Materialized business outcome state. Persisted summaries may not rely on wire defaults. */
export const materializedBusinessOutcomeSummarySchema = businessOutcomeSummarySchema.safeExtend({
  processingOrders: nonnegativeIntegerSchema,
  retryingOrders: nonnegativeIntegerSchema,
});

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

export const runHistorySummarySchema = demoRunSummaryShapeSchema
  .safeExtend({
    transportAttemptCounts: transportAttemptCountsSchema,
    httpSummary: trafficHttpSummarySchema,
    trafficDeliverySummary: trafficDeliverySummarySchema,
    serverReservationTimingSummary: serverReservationTimingSummarySchema,
    businessOutcomeSummary: businessOutcomeSummarySchema,
    terminalInventorySnapshot: terminalInventorySnapshotSchema.optional(),
    runSignalTimelineSummary: runSignalTimelineHeadlineSchema.nullable(),
  })
  .strict();
export type RunHistorySummary = z.infer<typeof runHistorySummarySchema>;

export const runHistoryListItemSchema = z
  .object({
    runId: uuidSchema,
    presetName: z.string().trim().min(1),
    occurredAt: isoTimestampSchema,
    overallDurationMs: nonnegativeNumberSchema.nullable(),
    resultOutcome: runResultOutcomeSchema,
    plannedAttempts: nonnegativeIntegerSchema,
    startingStock: nonnegativeIntegerSchema,
    uniqueReservations: nonnegativeIntegerSchema,
    soldOutRejections: nonnegativeIntegerSchema,
    confirmedOrders: nonnegativeIntegerSchema,
    failedOrders: nonnegativeIntegerSchema,
    convergenceDurationSeconds: nonnegativeNumberSchema.nullable(),
  })
  .strict();
export type RunHistoryListItem = z.infer<typeof runHistoryListItemSchema>;

export const runHistoryListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    pageSize: z.coerce.number().int().positive().max(50).default(10),
  })
  .strict();
export type RunHistoryListQuery = z.infer<typeof runHistoryListQuerySchema>;

export const runHistoryListResponseSchema = z
  .object({
    summaries: z.array(runHistoryListItemSchema),
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

export const adminRunHistoryDetailFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("orderId"), value: uuidSchema }).strict(),
  z.object({ kind: z.literal("publicOrderId"), value: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("correlationId"), value: correlationIdSchema }).strict(),
]);
export type AdminRunHistoryDetailFilter = z.infer<typeof adminRunHistoryDetailFilterSchema>;

export const adminRunHistoryCursorSchema = z
  .string()
  .regex(/^c[1-9]\d{0,6}$/)
  .refine((cursor) => {
    const offset = Number(cursor.slice(1));
    return Number.isSafeInteger(offset) && offset <= 1_000_000;
  });

export const adminRunHistoryDetailQuerySchema = z
  .object({
    filter: adminRunHistoryDetailFilterSchema.optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    cursor: adminRunHistoryCursorSchema.optional(),
  })
  .strict();
export type AdminRunHistoryDetailQuery = z.infer<typeof adminRunHistoryDetailQuerySchema>;

export const adminRunHistoryDetailHttpQuerySchema = z
  .object({
    filterKind: z.enum(["orderId", "publicOrderId", "correlationId"]).optional(),
    filterValue: z.string().trim().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(20),
    cursor: adminRunHistoryCursorSchema.optional(),
  })
  .strict()
  .superRefine((query, context) => {
    if ((query.filterKind === undefined) !== (query.filterValue === undefined)) {
      context.addIssue({
        code: "custom",
        path: [query.filterKind === undefined ? "filterKind" : "filterValue"],
        message: "Filter kind and value must be provided together.",
      });
    }
  })
  .transform(({ cursor, filterKind, filterValue, limit }, context) => {
    const query = adminRunHistoryDetailQuerySchema.safeParse({
      limit,
      ...(cursor ? { cursor } : {}),
      ...(filterKind && filterValue ? { filter: { kind: filterKind, value: filterValue } } : {}),
    });
    if (!query.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid protected run history query.",
      });
      return z.NEVER;
    }
    return query.data;
  });

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
    correlationId: correlationIdSchema,
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
    matchedCount: nonnegativeIntegerSchema,
    warningCount: nonnegativeIntegerSchema,
    limit: positiveIntegerSchema,
    truncated: z.boolean(),
    nextCursor: adminRunHistoryCursorSchema.optional(),
  })
  .strict();

export const runHistoryExceptionSummarySchema = z
  .object({
    maximumClassification: runResultClassificationSchema.nullable(),
    brokenInvariants: nonnegativeIntegerSchema,
    failedOrders: nonnegativeIntegerSchema,
    pendingWork: nonnegativeIntegerSchema,
    partialDelivery: nonnegativeIntegerSchema,
    generatorWarnings: nonnegativeIntegerSchema,
    truncatedCollections: nonnegativeIntegerSchema,
  })
  .strict();
export type RunHistoryExceptionSummary = z.infer<typeof runHistoryExceptionSummarySchema>;

const erpAttemptStatusCountsSchema = z
  .object({
    succeeded: nonnegativeIntegerSchema,
    failed: nonnegativeIntegerSchema,
    timedOut: nonnegativeIntegerSchema,
  })
  .strict();

export const runHistoryErpAttemptSummarySchema = z
  .object({
    totalCount: nonnegativeIntegerSchema,
    historyCoverage: z.literal("retained_history").optional(),
    attemptRetentionLimitPerOrder: z.literal(erpAttemptHistoryRetentionLimit).optional(),
    cumulativeOutcomeCounts: erpCumulativeOutcomeCountsSchema.optional(),
    byStatus: erpAttemptStatusCountsSchema,
    averageLatencyMs: nonnegativeNumberSchema.nullable(),
    p95LatencyMs: nonnegativeNumberSchema.nullable(),
  })
  .strict();

export const adminRunHistoryDetailResponseSchema = z
  .object({
    query: adminRunHistoryDetailQuerySchema,
    summary: runHistorySummarySchema,
    run: demoRunSnapshotSchema,
    overallDurationMs: nonnegativeNumberSchema.nullable(),
    exceptionSummary: runHistoryExceptionSummarySchema,
    internalFailureReason: internalRunFailureReasonSchema.optional(),
    httpTimingBreakdownSummary: httpTimingBreakdownSummarySchema,
    loadRunDiagnosticsSummary: loadRunDiagnosticsSummarySchema.nullable(),
    orders: runHistoryCollectionMetadataSchema
      .extend({
        records: z.array(runHistoryOrderOutcomeSchema),
      })
      .strict(),
    erpAttempts: runHistoryCollectionMetadataSchema
      .extend({
        historyCoverage: z.literal("retained_history").optional(),
        attemptRetentionLimitPerOrder: z.literal(erpAttemptHistoryRetentionLimit).optional(),
        records: z.array(runHistoryErpAttemptSchema),
      })
      .strict(),
    erpAttemptSummary: runHistoryErpAttemptSummarySchema,
    notifications: runHistoryCollectionMetadataSchema
      .extend({
        records: z.array(runHistoryNotificationSchema),
      })
      .strict(),
    eventTimeline: runHistoryCollectionMetadataSchema
      .extend({
        attemptHistoryCoverage: z.literal("retained_history").optional(),
        attemptRetentionLimitPerOrder: z.literal(erpAttemptHistoryRetentionLimit).optional(),
        records: z.array(runHistoryEventTimelineEntrySchema),
      })
      .strict(),
    runSignalTimelineSummary: runSignalTimelineSummarySchema.nullable(),
    timestamp: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.run.status === "failed" && value.internalFailureReason === undefined) {
      context.addIssue({
        code: "custom",
        path: ["internalFailureReason"],
        message: "Required for failed runs.",
      });
    }
    if (value.run.status !== "failed" && value.internalFailureReason !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["internalFailureReason"],
        message: "Only valid for failed runs.",
      });
    }
  });
export type AdminRunHistoryDetailResponse = z.infer<typeof adminRunHistoryDetailResponseSchema>;

const publicTerminalInventorySnapshotSchema = terminalInventorySnapshotSchema
  .omit({ saleOfferId: true, source: true })
  .strict();

const { notes: _internalDeliveryNotes, ...publicTrafficDeliverySummaryShape } =
  trafficDeliverySummaryShape;

const publicTrafficDeliverySummarySchema = z.object(publicTrafficDeliverySummaryShape).strict();

export const publicRunHistorySummarySchema = z
  .object({
    runId: uuidSchema,
    presetName: z.string().trim().min(1),
    status: demoRunStatusSchema,
    replayPossible: z.boolean(),
    failureCategory: publicRunFailureCategorySchema.optional(),
    startedAt: isoTimestampSchema.optional(),
    endedAt: isoTimestampSchema,
    transportAttemptCounts: transportAttemptCountsSchema,
    httpSummary: trafficHttpSummarySchema,
    trafficDeliverySummary: publicTrafficDeliverySummarySchema,
    serverReservationTimingSummary: serverReservationTimingSummarySchema,
    businessOutcomeSummary: businessOutcomeSummarySchema,
    terminalInventorySnapshot: publicTerminalInventorySnapshotSchema.optional(),
    runSignalTimelineSummary: runSignalTimelineHeadlineSchema.nullable(),
    capturedAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "failed" && value.failureCategory === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCategory"],
        message: "Required for failed summaries.",
      });
    }
    if (value.status !== "failed" && value.failureCategory !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failureCategory"],
        message: "Only valid for failed summaries.",
      });
    }
  });
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
    adminResetCompletedAt: isoTimestampSchema.optional(),
  })
  .strict();
export type PublicRunHistoryRun = z.infer<typeof publicRunHistoryRunSchema>;

export const publicRunHistoryDetailResponseSchema = z
  .object({
    summary: publicRunHistorySummarySchema,
    run: publicRunHistoryRunSchema,
    result: runResultSchema,
    overallDurationMs: nonnegativeNumberSchema.nullable(),
    plannedAttempts: nonnegativeIntegerSchema,
    httpTimingBreakdownSummary: httpTimingBreakdownSummarySchema,
    erpAttempts: runHistoryErpAttemptSummarySchema,
    runSignalTimelineSummary: runSignalTimelineSummarySchema.nullable(),
    timestamp: isoTimestampSchema,
  })
  .strict();
export type PublicRunHistoryDetailResponse = z.infer<typeof publicRunHistoryDetailResponseSchema>;

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
    maxErpErrorRate: percentageSchema,
    allowForcedOutage: z.boolean(),
    allowedTrafficModes: z
      .array(z.union([z.literal("buyer-spike"), z.literal("constant-arrival-rate")]))
      .min(1),
  })
  .strict();

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
export const publicRuntimePolicyMutableWriteSchema = publicRuntimePolicyMutableSchema.safeExtend({
  publicCustomDefaults: acceptedRunConfigWriteSchema,
  publicCustomLimits: publicCustomLimitsSchema.safeExtend({
    maxErpLatencyMs: nonnegativeIntegerSchema.max(largestAllowedErpLatencyMs),
  }),
});
export const publicRuntimePolicyPersistedSchema = publicRuntimePolicyMutableSchema.superRefine(
  (policy, context) => {
    for (const violation of collectPublicRuntimePolicyMutableViolations(policy)) {
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
    policy: publicRuntimePolicyMutableWriteSchema,
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
    erpConfig: acceptedErpRunConfigSchema,
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

export const deleteAllRunHistoryConfirmationToken = "DELETE";

export const adminDeleteRunHistoryRequestSchema = z
  .object({
    runIds: z.array(uuidSchema).min(1).optional(),
    deleteAllConfirmation: z.literal(deleteAllRunHistoryConfirmationToken).optional(),
    visibleFilter: jsonObjectSchema.optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const deletesSelectedRuns = Boolean(request.runIds?.length);
    const deletesAllRuns = request.deleteAllConfirmation === deleteAllRunHistoryConfirmationToken;

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
