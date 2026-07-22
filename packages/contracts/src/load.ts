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
import { transportAttemptCountsSchema } from "./traffic-transport-counts.js";

export const trafficExecutionStartPath = "/traffic/start" as const;
export const trafficExecutionAbortPath = "/traffic/current/abort" as const;
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

const k6VusSchema = z
  .object({
    preAllocatedVus: positiveIntegerSchema,
    maxVus: positiveIntegerSchema,
  })
  .strict()
  .refine((value) => value.maxVus >= value.preAllocatedVus, {
    path: ["maxVus"],
    message: "maxVus must be greater than or equal to preAllocatedVus.",
  });

export const steadyArrivalTrafficConfigSchema = z
  .object({
    mode: z.literal("steady-arrival-rate"),
    ratePerSecond: positiveIntegerSchema,
    startDelaySeconds: nonnegativeIntegerSchema.default(0),
    durationSeconds: positiveIntegerSchema,
    quantityPerAttempt: positiveIntegerSchema.default(1),
    k6Vus: k6VusSchema.optional(),
  })
  .strict();
export type SteadyArrivalTrafficConfig = z.infer<typeof steadyArrivalTrafficConfigSchema>;

export const maximumAutomaticallyDerivedVUs = 10_000;

export interface ResolvedSteadyArrivalVus {
  preAllocatedVus: number;
  maxVus: number;
}

/**
 * Resolves the immutable executor identity represented by an accepted traffic
 * configuration. Both the API admission boundary and load orchestrator use
 * this helper so completion evidence cannot drift from script generation.
 */
export function deriveLoadExecutionPlan(traffic: TrafficConfig): LoadExecutionPlan {
  if (traffic.mode === "buyer-spike") {
    const iterationsPerVu = traffic.duplicateEachBuyerAttempt ? 2 : 1;
    return {
      trafficMode: traffic.mode,
      buyerCount: traffic.buyerCount,
      duplicateEachBuyerAttempt: traffic.duplicateEachBuyerAttempt,
      iterationsPerVu,
      plannedEmittedAttempts: traffic.buyerCount * iterationsPerVu,
      startDelaySeconds: traffic.startDelaySeconds,
      maxDurationSeconds: traffic.maxDurationSeconds,
    };
  }

  return {
    trafficMode: traffic.mode,
    ratePerSecond: traffic.ratePerSecond,
    durationSeconds: traffic.durationSeconds,
    plannedEmittedAttempts: traffic.ratePerSecond * traffic.durationSeconds,
    startDelaySeconds: traffic.startDelaySeconds,
    ...resolveSteadyArrivalVus(traffic),
  };
}

export function resolveSteadyArrivalVus(
  trafficConfig: Pick<SteadyArrivalTrafficConfig, "ratePerSecond" | "k6Vus">,
): ResolvedSteadyArrivalVus {
  if (trafficConfig.k6Vus) {
    return { ...trafficConfig.k6Vus };
  }

  const preAllocatedVus = Math.min(trafficConfig.ratePerSecond, maximumAutomaticallyDerivedVUs);
  return {
    preAllocatedVus,
    maxVus: Math.max(
      preAllocatedVus,
      Math.min(trafficConfig.ratePerSecond * 2, maximumAutomaticallyDerivedVUs),
    ),
  };
}

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

/** Materialized accepted-run state. Persisted snapshots may not rely on wire defaults. */
const materializedBuyerSpikeTrafficConfigSchema = buyerSpikeTrafficConfigSchema.safeExtend({
  duplicateEachBuyerAttempt: z.boolean(),
  startDelaySeconds: nonnegativeIntegerSchema,
  quantityPerAttempt: positiveIntegerSchema,
});
const materializedSteadyArrivalTrafficConfigSchema = steadyArrivalTrafficConfigSchema.safeExtend({
  startDelaySeconds: nonnegativeIntegerSchema,
  quantityPerAttempt: positiveIntegerSchema,
});
export const materializedAcceptedRunConfigSnapshotSchema = z
  .object({
    trafficConfig: z.discriminatedUnion("mode", [
      materializedBuyerSpikeTrafficConfigSchema,
      materializedSteadyArrivalTrafficConfigSchema,
    ]),
    inventoryConfig: inventoryConfigSchema.safeExtend({
      quantityPerCheckout: positiveIntegerSchema,
    }),
    erpConfig: erpRunConfigSchema.safeExtend({
      forcedOutage: z.boolean(),
    }),
    backpressureConfig: backpressureConfigSchema,
  })
  .strict();

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

/** Materialized start request stored in the durable execution journal. */
export const materializedTrafficExecutionStartRequestSchema =
  trafficExecutionStartRequestSchema.safeExtend({
    configSnapshot: materializedAcceptedRunConfigSnapshotSchema,
  });

export const trafficExecutionStartResponseSchema = z
  .object({
    runId: uuidSchema,
    status: trafficExecutionStatusSchema.extract(["starting", "active"]),
    startedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type TrafficExecutionStartResponse = z.infer<typeof trafficExecutionStartResponseSchema>;

export const trafficExecutionAbortRequestSchema = z
  .object({
    runId: uuidSchema.optional(),
    reason: z.string().trim().min(1).max(500).optional(),
    correlationId: correlationIdSchema.optional(),
  })
  .strict();
export type TrafficExecutionAbortRequest = z.infer<typeof trafficExecutionAbortRequestSchema>;

export const trafficExecutionAbortOutcomeSchema = z.enum(["no_current_run", "current_run_aborted"]);
export const trafficExecutionAbortResponseSchema = z
  .object({
    outcome: trafficExecutionAbortOutcomeSchema,
    requestedRunId: uuidSchema.optional(),
    abortedRunId: uuidSchema.optional(),
    observedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === "current_run_aborted" && !value.abortedRunId) {
      context.addIssue({ code: "custom", path: ["abortedRunId"], message: "required" });
    }
    if (value.outcome === "no_current_run" && value.abortedRunId) {
      context.addIssue({ code: "custom", path: ["abortedRunId"], message: "not allowed" });
    }
    if (value.requestedRunId && value.abortedRunId && value.requestedRunId !== value.abortedRunId) {
      context.addIssue({
        code: "custom",
        path: ["abortedRunId"],
        message: "must match requestedRunId",
      });
    }
  });
export type TrafficExecutionAbortResponse = z.infer<typeof trafficExecutionAbortResponseSchema>;

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
    failedRequests: nonnegativeIntegerSchema,
    acceptedResponses: nonnegativeIntegerSchema,
    soldOutResponses: nonnegativeIntegerSchema,
    unexpectedResponses: nonnegativeIntegerSchema,
    p95LatencyMs: nonnegativeNumberSchema.optional(),
    failureRate: percentageSchema,
  })
  .strict();
export type TrafficHttpSummary = z.infer<typeof trafficHttpSummarySchema>;

/** Real completion input. Quality is classified by the API, not the caller. */
export const trafficCompletionDeliverySummarySchema = z
  .object({
    trafficMode: z.enum(["buyer-spike", "steady-arrival-rate"]),
    plannedBuyers: positiveIntegerSchema.nullable(),
    scheduledRatePerSecond: positiveIntegerSchema.nullable(),
    configuredDurationSeconds: positiveIntegerSchema.nullable(),
    preAllocatedVUs: positiveIntegerSchema.nullable(),
    maxVUs: positiveIntegerSchema.nullable(),
    droppedIterations: nonnegativeIntegerSchema,
    completedIterations: nonnegativeIntegerSchema.nullable().optional(),
    notes: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export type TrafficCompletionDeliverySummary = z.infer<
  typeof trafficCompletionDeliverySummarySchema
>;

/** Field map of the authoritative persisted/history delivery summary. */
export const trafficDeliverySummaryShape = {
  trafficMode: z.enum(["buyer-spike", "steady-arrival-rate"]).nullable(),
  plannedBuyers: positiveIntegerSchema.nullable(),
  scheduledRatePerSecond: positiveIntegerSchema.nullable(),
  configuredDurationSeconds: positiveIntegerSchema.nullable(),
  preAllocatedVUs: positiveIntegerSchema.nullable(),
  maxVUs: positiveIntegerSchema.nullable(),
  droppedIterations: nonnegativeIntegerSchema,
  completedIterations: nonnegativeIntegerSchema.nullable(),
  notes: z.array(z.string().trim().min(1)),
  trafficDeliveryStatus: trafficDeliveryStatusSchema,
} as const;

/** Authoritative persisted/history shape. The API-derived status is always present. */
export const trafficDeliverySummarySchema = z.object(trafficDeliverySummaryShape).strict();
export type TrafficDeliverySummary = z.infer<typeof trafficDeliverySummarySchema>;

export const loadExecutionPlanSchema = z
  .discriminatedUnion("trafficMode", [
    z
      .object({
        trafficMode: z.literal("buyer-spike"),
        buyerCount: positiveIntegerSchema,
        duplicateEachBuyerAttempt: z.boolean(),
        iterationsPerVu: positiveIntegerSchema,
        plannedEmittedAttempts: positiveIntegerSchema,
        startDelaySeconds: nonnegativeIntegerSchema,
        maxDurationSeconds: positiveIntegerSchema,
      })
      .strict(),
    z
      .object({
        trafficMode: z.literal("steady-arrival-rate"),
        ratePerSecond: positiveIntegerSchema,
        durationSeconds: positiveIntegerSchema,
        plannedEmittedAttempts: positiveIntegerSchema,
        startDelaySeconds: nonnegativeIntegerSchema,
        preAllocatedVus: positiveIntegerSchema,
        maxVus: positiveIntegerSchema,
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    const expected =
      value.trafficMode === "buyer-spike"
        ? value.buyerCount * value.iterationsPerVu
        : value.ratePerSecond * value.durationSeconds;
    if (value.plannedEmittedAttempts !== expected)
      context.addIssue({
        code: "custom",
        path: ["plannedEmittedAttempts"],
        message: "must match the resolved plan",
      });
    if (
      value.trafficMode === "buyer-spike" &&
      value.iterationsPerVu !== (value.duplicateEachBuyerAttempt ? 2 : 1)
    )
      context.addIssue({
        code: "custom",
        path: ["iterationsPerVu"],
        message: "must match duplicateEachBuyerAttempt",
      });
    if (value.trafficMode === "steady-arrival-rate" && value.maxVus < value.preAllocatedVus)
      context.addIssue({
        code: "custom",
        path: ["maxVus"],
        message: "must be greater than or equal to preAllocatedVus",
      });
  });
export type LoadExecutionPlan = z.infer<typeof loadExecutionPlanSchema>;

const nullablePositiveIntegerSchema = positiveIntegerSchema.nullable();
const nullableNonnegativeIntegerSchema = nonnegativeIntegerSchema.nullable();

export const terminalMetricSourceSchema = z.enum(["summary_export", "point_stream"]);
export type TerminalMetricSource = z.infer<typeof terminalMetricSourceSchema>;

export const terminalMetricSourcesSchema = z
  .object({
    startedRequests: terminalMetricSourceSchema.nullable(),
    completedRequests: terminalMetricSourceSchema.nullable(),
    acceptedResponses: terminalMetricSourceSchema.nullable(),
    soldOutResponses: terminalMetricSourceSchema.nullable(),
    unexpectedResponses: terminalMetricSourceSchema.nullable(),
    droppedIterations: terminalMetricSourceSchema.nullable(),
    completedIterations: terminalMetricSourceSchema.nullable(),
  })
  .strict();
export type TerminalMetricSources = z.infer<typeof terminalMetricSourcesSchema>;

export const summaryExportWarningSchema = z.enum([
  "summary_export_missing",
  "summary_export_invalid",
  "summary_export_read_failed",
  "k6_outcome_counter_point_stream_fallback_used",
  "k6_outcome_counter_summary_export_unavailable",
]);
export type SummaryExportWarning = z.infer<typeof summaryExportWarningSchema>;

export const httpTimingPhaseSummarySchema = z
  .object({
    averageMs: nonnegativeNumberSchema.nullable(),
    p95Ms: nonnegativeNumberSchema.nullable(),
  })
  .strict();
export type HttpTimingPhaseSummary = z.infer<typeof httpTimingPhaseSummarySchema>;

export const httpTimingBreakdownSummarySchema = z
  .object({
    blocked: httpTimingPhaseSummarySchema.nullable(),
    connecting: httpTimingPhaseSummarySchema.nullable(),
    tlsHandshaking: httpTimingPhaseSummarySchema.nullable(),
    sending: httpTimingPhaseSummarySchema.nullable(),
    waiting: httpTimingPhaseSummarySchema.nullable(),
    receiving: httpTimingPhaseSummarySchema.nullable(),
  })
  .strict();
export type HttpTimingBreakdownSummary = z.infer<typeof httpTimingBreakdownSummarySchema>;
export const emptyHttpTimingBreakdownSummary: HttpTimingBreakdownSummary = {
  blocked: null,
  connecting: null,
  tlsHandshaking: null,
  sending: null,
  waiting: null,
  receiving: null,
};

export const loadRunDiagnosticsSummarySchema = z
  .object({
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema,
    nproc: nullablePositiveIntegerSchema,
    ulimitNofile: nullablePositiveIntegerSchema,
    processMaxOpenFiles: z
      .object({ soft: positiveIntegerSchema, hard: positiveIntegerSchema })
      .strict()
      .superRefine((value, context) => {
        if (value.hard < value.soft)
          context.addIssue({
            code: "custom",
            path: ["hard"],
            message: "must be greater than or equal to soft",
          });
      })
      .nullable(),
    networkDiagnostics: z
      .object({
        ipLocalPortRange: z.string().trim().min(1).nullable(),
        tcpTwReuse: nullableNonnegativeIntegerSchema,
        tcpTimestamps: nullableNonnegativeIntegerSchema,
      })
      .strict()
      .superRefine((value, context) => {
        if (value.ipLocalPortRange !== null) {
          const match = /^([0-9]+) ([0-9]+)$/.exec(value.ipLocalPortRange);
          const start = Number(match?.[1]);
          const end = Number(match?.[2]);
          if (
            !match ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start <= 0 ||
            start > end ||
            end > 65_535
          )
            context.addIssue({
              code: "custom",
              path: ["ipLocalPortRange"],
              message: "must be a valid two-integer TCP port range",
            });
        }
        if (
          value.ipLocalPortRange === null &&
          value.tcpTwReuse === null &&
          value.tcpTimestamps === null
        )
          context.addIssue({
            code: "custom",
            message: "all-unavailable network diagnostics must be null",
          });
      })
      .nullable(),
    k6Version: z.string().trim().min(1).nullable(),
    executionPlan: loadExecutionPlanSchema,
    stderrLines: z.array(z.string().max(500)).max(50),
    stderrLineCountObserved: nonnegativeIntegerSchema,
    stderrLineCountRetained: nonnegativeIntegerSchema,
    stderrRetainedLineLimit: z.literal(50),
    stderrLineTruncationLength: z.literal(500),
    stderrLineTruncatedCount: nonnegativeIntegerSchema,
    terminalMetricSources: terminalMetricSourcesSchema.optional(),
    summaryExportWarnings: z.array(summaryExportWarningSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.stderrLineCountRetained !== value.stderrLines.length ||
      value.stderrLineCountObserved < value.stderrLineCountRetained ||
      value.stderrLineTruncatedCount > value.stderrLineCountObserved
    ) {
      context.addIssue({
        code: "custom",
        path: ["stderrLines"],
        message: "stderr counts are inconsistent",
      });
    }
    if (Date.parse(value.startedAt) > Date.parse(value.completedAt))
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "must not precede startedAt",
      });
  });
export type LoadRunDiagnosticsSummary = z.infer<typeof loadRunDiagnosticsSummarySchema>;

/** Strict diagnostics emitted by a real load-orchestrator completion. */
export const realLoadRunDiagnosticsSummarySchema = loadRunDiagnosticsSummarySchema.safeExtend({
  terminalMetricSources: terminalMetricSourcesSchema,
  summaryExportWarnings: z.array(summaryExportWarningSchema),
});
export type RealLoadRunDiagnosticsSummary = z.infer<typeof realLoadRunDiagnosticsSummarySchema>;

export const trafficCompletionReportSchema = z
  .object({
    runId: uuidSchema,
    status: trafficExecutionStatusSchema.extract(["succeeded", "failed"]),
    exitCode: z.number().int().optional(),
    errorMessage: z.string().trim().min(1).optional(),
    transportAttemptCounts: transportAttemptCountsSchema,
    httpSummary: trafficHttpSummarySchema,
    trafficOutcomeSummary: jsonObjectSchema,
    trafficDeliverySummary: trafficCompletionDeliverySummarySchema,
    httpTimingBreakdownSummary: httpTimingBreakdownSummarySchema,
    loadRunDiagnosticsSummary: realLoadRunDiagnosticsSummarySchema,
    completedAt: isoTimestampSchema,
    correlationId: correlationIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.loadRunDiagnosticsSummary.completedAt !== value.completedAt)
      context.addIssue({
        code: "custom",
        path: ["loadRunDiagnosticsSummary", "completedAt"],
        message: "must match completedAt",
      });

    const plan = value.loadRunDiagnosticsSummary.executionPlan;
    const delivery = value.trafficDeliverySummary;
    const expectedDeliveryIdentity =
      plan.trafficMode === "buyer-spike"
        ? {
            trafficMode: plan.trafficMode,
            plannedBuyers: plan.buyerCount,
            scheduledRatePerSecond: null,
            configuredDurationSeconds: null,
            preAllocatedVUs: null,
            maxVUs: null,
          }
        : {
            trafficMode: plan.trafficMode,
            plannedBuyers: null,
            scheduledRatePerSecond: plan.ratePerSecond,
            configuredDurationSeconds: plan.durationSeconds,
            preAllocatedVUs: plan.preAllocatedVus,
            maxVUs: plan.maxVus,
          };
    const executionPlanMismatches: Array<[string, unknown, unknown]> = [
      [
        "transportAttemptCounts.plannedRequests",
        value.transportAttemptCounts.plannedRequests,
        plan.plannedEmittedAttempts,
      ],
      ...Object.entries(expectedDeliveryIdentity).map(
        ([field, expected]) =>
          [
            `trafficDeliverySummary.${field}`,
            delivery[field as keyof typeof delivery],
            expected,
          ] as [string, unknown, unknown],
      ),
    ];
    for (const [path, actual, expected] of executionPlanMismatches) {
      if (actual !== expected) {
        context.addIssue({
          code: "custom",
          path: path.split("."),
          message: "must match the reported execution plan",
        });
      }
    }
  });
export type TrafficCompletionReport = z.infer<typeof trafficCompletionReportSchema>;

/** Materialized completion stored in the durable execution journal. */
export const materializedTrafficCompletionReportSchema = trafficCompletionReportSchema.safeExtend({
  trafficDeliverySummary: trafficCompletionDeliverySummarySchema.safeExtend({
    completedIterations: nonnegativeIntegerSchema.nullable(),
    notes: z.array(z.string().trim().min(1)),
  }),
});

export const loadMetricIngestRequestSchema = z
  .object({
    runId: uuidSchema,
    correlationId: correlationIdSchema,
    samples: z.array(metricSampleSchema).min(1).max(100),
    raw: jsonObjectSchema.optional(),
    observedAt: isoTimestampSchema,
  })
  .strict();
export type LoadMetricIngestRequest = z.infer<typeof loadMetricIngestRequestSchema>;
