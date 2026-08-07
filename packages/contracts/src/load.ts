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
import {
  type TransportAttemptCounts,
  transportAttemptCountsSchema,
} from "./traffic-transport-counts.js";

export const trafficExecutionStartPath = "/traffic/start" as const;
export const trafficExecutionAbortPath = "/traffic/current/abort" as const;
export const trafficExecutionStatusPath = "/traffic/status/:runId" as const;
export const internalLoadMetricIngestPath = "/internal/load/metrics" as const;
export const internalTrafficCompletionPath = "/internal/load/completion" as const;

/** Live traffic metrics use aligned producer event-time windows of this width. */
export const liveTrafficMetricWindowSeconds = 1 as const;

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

export const constantArrivalTrafficConfigSchema = z
  .object({
    mode: z.literal("constant-arrival-rate"),
    ratePerSecond: positiveIntegerSchema,
    startDelaySeconds: nonnegativeIntegerSchema.default(0),
    durationSeconds: positiveIntegerSchema,
    quantityPerAttempt: positiveIntegerSchema.default(1),
    k6Vus: k6VusSchema.optional(),
  })
  .strict();
export type ConstantArrivalTrafficConfig = z.infer<typeof constantArrivalTrafficConfigSchema>;

export const maximumAutomaticallyDerivedVUs = 10_000;

export interface ResolvedConstantArrivalVus {
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
    ...resolveConstantArrivalVus(traffic),
  };
}

export function resolveConstantArrivalVus(
  trafficConfig: Pick<ConstantArrivalTrafficConfig, "ratePerSecond" | "k6Vus">,
): ResolvedConstantArrivalVus {
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
  constantArrivalTrafficConfigSchema,
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
const materializedConstantArrivalTrafficConfigSchema =
  constantArrivalTrafficConfigSchema.safeExtend({
    startDelaySeconds: nonnegativeIntegerSchema,
    quantityPerAttempt: positiveIntegerSchema,
  });
export const materializedAcceptedRunConfigSnapshotSchema = z
  .object({
    trafficConfig: z.discriminatedUnion("mode", [
      materializedBuyerSpikeTrafficConfigSchema,
      materializedConstantArrivalTrafficConfigSchema,
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

export const trafficCompletionAcknowledgementSchema = z
  .object({
    runId: uuidSchema,
    acknowledged: z.literal(true),
    correlationId: correlationIdSchema,
  })
  .strict();

export const trafficHttpSummarySchema = z
  .object({
    failedRequests: nonnegativeIntegerSchema,
    acceptedResponses: nonnegativeIntegerSchema,
    soldOutResponses: nonnegativeIntegerSchema,
    transportFailures: nonnegativeIntegerSchema,
    unexpectedResponses: nonnegativeIntegerSchema,
    p95LatencyMs: nonnegativeNumberSchema.optional(),
    failureRate: percentageSchema,
  })
  .strict()
  .superRefine((summary, context) => {
    if (summary.failedRequests !== summary.unexpectedResponses + summary.transportFailures) {
      context.addIssue({
        code: "custom",
        path: ["failedRequests"],
        message: "must equal unexpectedResponses plus transportFailures",
      });
    }
  });
export type TrafficHttpSummary = z.infer<typeof trafficHttpSummarySchema>;

export const arrivalRateSeriesLimit = 120 as const;

export const requestArrivalSummarySchema = z
  .object({
    firstAttemptStartedAt: isoTimestampSchema.nullable(),
    peakArrivalRatePerSecond: nonnegativeNumberSchema,
    peakArrivalWindowSeconds: z.number().positive().finite(),
    dispatchDurationSeconds: nonnegativeNumberSchema,
    arrivalRateSeries: z
      .array(
        z
          .object({
            windowStartedAt: isoTimestampSchema,
            ratePerSecond: nonnegativeNumberSchema,
          })
          .strict(),
      )
      .max(arrivalRateSeriesLimit),
    arrivalWindowCountObserved: nonnegativeIntegerSchema,
    arrivalWindowCountRetained: nonnegativeIntegerSchema,
    arrivalSeriesLimit: z.literal(arrivalRateSeriesLimit),
  })
  .strict()
  .superRefine((summary, context) => {
    if (
      summary.arrivalWindowCountRetained !== summary.arrivalRateSeries.length ||
      summary.arrivalWindowCountObserved < summary.arrivalWindowCountRetained
    ) {
      context.addIssue({
        code: "custom",
        path: ["arrivalRateSeries"],
        message: "arrival window counts are inconsistent",
      });
    }
    if (
      summary.arrivalRateSeries.some(
        (sample) => sample.ratePerSecond > summary.peakArrivalRatePerSecond,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["peakArrivalRatePerSecond"],
        message: "must be at least every retained arrival rate",
      });
    }
  });
export type RequestArrivalSummary = z.infer<typeof requestArrivalSummarySchema>;

export const emptyRequestArrivalSummary: RequestArrivalSummary = {
  firstAttemptStartedAt: null,
  peakArrivalRatePerSecond: 0,
  peakArrivalWindowSeconds: 1,
  dispatchDurationSeconds: 0,
  arrivalRateSeries: [],
  arrivalWindowCountObserved: 0,
  arrivalWindowCountRetained: 0,
  arrivalSeriesLimit: arrivalRateSeriesLimit,
};

/**
 * Every finished run carries an arrival summary, including one whose load generator never started
 * a checkout attempt. The empty summary is an absence of observation, not a measured peak of zero
 * attempts per second, so readers must qualify it before presenting any of its values.
 */
export function hasObservedRequestArrivals(summary: RequestArrivalSummary): boolean {
  return summary.arrivalWindowCountObserved > 0 || summary.firstAttemptStartedAt !== null;
}

/** Real completion input. Quality is classified by the API, not the caller. */
export const trafficCompletionDeliverySummarySchema = z
  .object({
    trafficMode: z.enum(["buyer-spike", "constant-arrival-rate"]),
    plannedBuyers: positiveIntegerSchema.nullable(),
    scheduledRatePerSecond: positiveIntegerSchema.nullable(),
    configuredDurationSeconds: positiveIntegerSchema.nullable(),
    preAllocatedVUs: positiveIntegerSchema.nullable(),
    maxVUs: positiveIntegerSchema.nullable(),
    droppedIterations: nonnegativeIntegerSchema,
    completedIterations: nonnegativeIntegerSchema.nullable().optional(),
    requestArrivalSummary: requestArrivalSummarySchema,
    notes: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();
export type TrafficCompletionDeliverySummary = z.infer<
  typeof trafficCompletionDeliverySummarySchema
>;

/** Field map of the authoritative persisted/history delivery summary. */
export const trafficDeliverySummaryShape = {
  trafficMode: z.enum(["buyer-spike", "constant-arrival-rate"]).nullable(),
  plannedBuyers: positiveIntegerSchema.nullable(),
  scheduledRatePerSecond: positiveIntegerSchema.nullable(),
  configuredDurationSeconds: positiveIntegerSchema.nullable(),
  preAllocatedVUs: positiveIntegerSchema.nullable(),
  maxVUs: positiveIntegerSchema.nullable(),
  droppedIterations: nonnegativeIntegerSchema,
  completedIterations: nonnegativeIntegerSchema.nullable(),
  requestArrivalSummary: requestArrivalSummarySchema,
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
        trafficMode: z.literal("constant-arrival-rate"),
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
    if (value.trafficMode === "constant-arrival-rate" && value.maxVus < value.preAllocatedVus)
      context.addIssue({
        code: "custom",
        path: ["maxVus"],
        message: "must be greater than or equal to preAllocatedVus",
      });
  });
export type LoadExecutionPlan = z.infer<typeof loadExecutionPlanSchema>;

const nullablePositiveIntegerSchema = positiveIntegerSchema.nullable();
const nullableNonnegativeIntegerSchema = nonnegativeIntegerSchema.nullable();
const nullablePositiveNumberSchema = z.number().positive().finite().nullable();

export const terminalMetricSourceSchema = z.enum(["summary_export", "point_stream"]);
export type TerminalMetricSource = z.infer<typeof terminalMetricSourceSchema>;

export const terminalMetricSourcesSchema = z
  .object({
    startedRequests: terminalMetricSourceSchema.nullable(),
    completedRequests: terminalMetricSourceSchema.nullable(),
    acceptedResponses: terminalMetricSourceSchema.nullable(),
    soldOutResponses: terminalMetricSourceSchema.nullable(),
    transportFailures: terminalMetricSourceSchema.nullable(),
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

export const reservationTimingMeasurementSchema = httpTimingPhaseSummarySchema
  .extend({
    sampleCount: nonnegativeIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.averageMs === null) !== (value.p95Ms === null)) {
      context.addIssue({
        code: "custom",
        message: "averageMs and p95Ms must be present together",
      });
    }
    const hasMeasurement = value.averageMs !== null && value.p95Ms !== null;
    if (value.sampleCount > 0 !== hasMeasurement) {
      context.addIssue({
        code: "custom",
        message: "sampleCount and timing values must be present together",
      });
    }
  });
export type ReservationTimingMeasurement = z.infer<typeof reservationTimingMeasurementSchema>;

export const serverReservationTimingSummarySchema = z
  .object({
    redisAtomicReservation: reservationTimingMeasurementSchema,
    reserveOrderService: reservationTimingMeasurementSchema,
  })
  .strict();
export type ServerReservationTimingSummary = z.infer<typeof serverReservationTimingSummarySchema>;

const emptyReservationTimingMeasurement: ReservationTimingMeasurement = {
  sampleCount: 0,
  averageMs: null,
  p95Ms: null,
};

export const emptyServerReservationTimingSummary: ServerReservationTimingSummary = {
  redisAtomicReservation: emptyReservationTimingMeasurement,
  reserveOrderService: emptyReservationTimingMeasurement,
};

export const redisAtomicReservationP95TargetMs = 1;

export function deriveRecordedReplyCount(
  counts: TransportAttemptCounts,
  transportFailures: number,
): number {
  return Math.max(counts.completedRequests - transportFailures, 0);
}

export const fastReservationTargetSchema = z
  .object({
    operation: z.literal("redis_atomic_reservation"),
    percentile: z.literal("p95"),
    thresholdMs: z.literal(redisAtomicReservationP95TargetMs),
    startEvent: z.literal("stock_reservation_gateway_call_started"),
    endEvent: z.literal("stock_reservation_decision_received"),
  })
  .strict();
export type FastReservationTarget = z.infer<typeof fastReservationTargetSchema>;

export const fastReservationTargetEvaluationSchema = z
  .object({
    target: fastReservationTargetSchema,
    observedP95Ms: nonnegativeNumberSchema.nullable(),
    observedSampleCount: nonnegativeIntegerSchema,
    expectedResponseCount: nonnegativeIntegerSchema,
    verdict: z.enum(["pass", "fail", "qualified"]),
    qualification: z.enum(["measurement_unavailable", "incomplete_server_observation"]).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.verdict === "qualified") !== (value.qualification !== null)) {
      context.addIssue({
        code: "custom",
        path: ["qualification"],
        message: "qualification must be present only for a qualified verdict",
      });
    }
  });
export type FastReservationTargetEvaluation = z.infer<typeof fastReservationTargetEvaluationSchema>;

const fastReservationTarget: FastReservationTarget = {
  operation: "redis_atomic_reservation",
  percentile: "p95",
  thresholdMs: redisAtomicReservationP95TargetMs,
  startEvent: "stock_reservation_gateway_call_started",
  endEvent: "stock_reservation_decision_received",
};

export function evaluateFastReservationTarget(
  summary: ServerReservationTimingSummary,
  expectedResponseCount: number,
): FastReservationTargetEvaluation {
  const parsedSummary = serverReservationTimingSummarySchema.parse(summary);
  const parsedExpectedResponseCount = nonnegativeIntegerSchema.parse(expectedResponseCount);
  const observed = parsedSummary.redisAtomicReservation;
  const service = parsedSummary.reserveOrderService;

  if (observed.p95Ms === null || service.sampleCount === 0) {
    return fastReservationTargetEvaluationSchema.parse({
      target: fastReservationTarget,
      observedP95Ms: observed.p95Ms,
      observedSampleCount: observed.sampleCount,
      expectedResponseCount: parsedExpectedResponseCount,
      verdict: "qualified",
      qualification: "measurement_unavailable",
    });
  }

  if (
    observed.sampleCount !== service.sampleCount ||
    service.sampleCount !== parsedExpectedResponseCount
  ) {
    return fastReservationTargetEvaluationSchema.parse({
      target: fastReservationTarget,
      observedP95Ms: observed.p95Ms,
      observedSampleCount: observed.sampleCount,
      expectedResponseCount: parsedExpectedResponseCount,
      verdict: "qualified",
      qualification: "incomplete_server_observation",
    });
  }

  return fastReservationTargetEvaluationSchema.parse({
    target: fastReservationTarget,
    observedP95Ms: observed.p95Ms,
    observedSampleCount: observed.sampleCount,
    expectedResponseCount: parsedExpectedResponseCount,
    verdict: observed.p95Ms <= redisAtomicReservationP95TargetMs ? "pass" : "fail",
    qualification: null,
  });
}

export const generatorUtilisationSchema = z
  .object({
    peakK6RssBytes: nullableNonnegativeIntegerSchema,
    peakCgroupMemoryBytes: nullableNonnegativeIntegerSchema,
    minimumHostMemAvailableBytes: nullableNonnegativeIntegerSchema,
    peakCpuUtilisationPercent: nonnegativeNumberSchema.nullable(),
    meanCpuUtilisationPercent: nonnegativeNumberSchema.nullable(),
    peakCgroupSwapBytes: nullableNonnegativeIntegerSchema,
    finalMemoryEventsHighCount: nullableNonnegativeIntegerSchema,
    finalMemoryEventsMaxCount: nullableNonnegativeIntegerSchema,
    finalMemoryEventsOomKillCount: nullableNonnegativeIntegerSchema,
    sampleCount: positiveIntegerSchema,
    effectiveIntervalMs: positiveIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const {
      sampleCount: _sampleCount,
      effectiveIntervalMs: _effectiveIntervalMs,
      ...metrics
    } = value;
    if (Object.values(metrics).every((entry) => entry === null))
      context.addIssue({
        code: "custom",
        message: "all-unavailable generator utilisation must be null",
      });
  });
export type GeneratorUtilisation = z.infer<typeof generatorUtilisationSchema>;

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
    generatorCapacity: z
      .object({
        memTotalBytes: nullablePositiveIntegerSchema,
        memAvailableBytes: nullablePositiveIntegerSchema,
        swapTotalBytes: nullableNonnegativeIntegerSchema,
        cgroupMemoryLimitBytes: nullablePositiveIntegerSchema,
        cgroupMemoryLimitUnlimited: z.boolean().nullable(),
        cgroupCpuQuota: nullablePositiveNumberSchema,
        cgroupCpuQuotaUnlimited: z.boolean().nullable(),
      })
      .strict()
      .superRefine((value, context) => {
        for (const [field, unlimitedField] of [
          ["cgroupMemoryLimitBytes", "cgroupMemoryLimitUnlimited"],
          ["cgroupCpuQuota", "cgroupCpuQuotaUnlimited"],
        ] as const) {
          if (
            (value[field] !== null && value[unlimitedField] !== false) ||
            (value[field] === null && value[unlimitedField] === false)
          )
            context.addIssue({
              code: "custom",
              path: [unlimitedField],
              message: "must be false exactly when the paired finite value is available",
            });
        }
        if (Object.values(value).every((entry) => entry === null))
          context.addIssue({
            code: "custom",
            message: "all-unavailable generator capacity must be null",
          });
      })
      .nullable(),
    generatorUtilisation: generatorUtilisationSchema.nullable(),
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

const loadRunDiagnosticProbes = [
  (summary: LoadRunDiagnosticsSummary) => summary.nproc !== null,
  (summary: LoadRunDiagnosticsSummary) => summary.ulimitNofile !== null,
  // Intentionally listed twice: the UI shows soft and hard limits as two rows from this one nullable object.
  (summary: LoadRunDiagnosticsSummary) => summary.processMaxOpenFiles !== null,
  (summary: LoadRunDiagnosticsSummary) => summary.processMaxOpenFiles !== null,
  (summary: LoadRunDiagnosticsSummary) => summary.generatorCapacity?.memTotalBytes != null,
  (summary: LoadRunDiagnosticsSummary) => summary.generatorCapacity?.memAvailableBytes != null,
  (summary: LoadRunDiagnosticsSummary) => summary.generatorCapacity?.swapTotalBytes != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorCapacity?.cgroupMemoryLimitBytes != null ||
    summary.generatorCapacity?.cgroupMemoryLimitUnlimited === true,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorCapacity?.cgroupCpuQuota != null ||
    summary.generatorCapacity?.cgroupCpuQuotaUnlimited === true,
  (summary: LoadRunDiagnosticsSummary) => summary.generatorUtilisation?.peakK6RssBytes != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.peakCgroupMemoryBytes != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.minimumHostMemAvailableBytes != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.peakCpuUtilisationPercent != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.meanCpuUtilisationPercent != null,
  (summary: LoadRunDiagnosticsSummary) => summary.generatorUtilisation?.peakCgroupSwapBytes != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.finalMemoryEventsHighCount != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.finalMemoryEventsMaxCount != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.generatorUtilisation?.finalMemoryEventsOomKillCount != null,
  (summary: LoadRunDiagnosticsSummary) => summary.networkDiagnostics?.ipLocalPortRange != null,
  (summary: LoadRunDiagnosticsSummary) => summary.networkDiagnostics?.tcpTwReuse != null,
  (summary: LoadRunDiagnosticsSummary) => summary.networkDiagnostics?.tcpTimestamps != null,
  (summary: LoadRunDiagnosticsSummary) => summary.k6Version !== null,
  (summary: LoadRunDiagnosticsSummary) => summary.terminalMetricSources?.startedRequests != null,
  (summary: LoadRunDiagnosticsSummary) => summary.terminalMetricSources?.completedRequests != null,
  (summary: LoadRunDiagnosticsSummary) => summary.terminalMetricSources?.acceptedResponses != null,
  (summary: LoadRunDiagnosticsSummary) => summary.terminalMetricSources?.soldOutResponses != null,
  (summary: LoadRunDiagnosticsSummary) => summary.terminalMetricSources?.transportFailures != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.terminalMetricSources?.unexpectedResponses != null,
  (summary: LoadRunDiagnosticsSummary) => summary.terminalMetricSources?.droppedIterations != null,
  (summary: LoadRunDiagnosticsSummary) =>
    summary.terminalMetricSources?.completedIterations != null,
];

export function countUnavailableLoadRunDiagnosticProbes(
  summary: LoadRunDiagnosticsSummary | null,
): number {
  return summary
    ? loadRunDiagnosticProbes.filter((isAvailable) => !isAvailable(summary)).length
    : loadRunDiagnosticProbes.length;
}

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
