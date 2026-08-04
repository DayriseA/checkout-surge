import { z } from "zod";
import {
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  nonnegativeNumberSchema,
} from "./primitives.js";

export const runSignalBucketCount = 120 as const;
export const queueBacklogDefinition = "accepted_awaiting_first_processing_start" as const;
export const queueBacklogDrainDurationBoundary =
  "first_order_queued_to_final_backlog_zero" as const;
export const confirmationLagBoundary = "reservation_secured_to_order_confirmed" as const;

const elapsedSampleShape = {
  elapsedSeconds: nonnegativeNumberSchema,
};

const inventoryDrainHeadlineSchema = z
  .object({
    startingStock: nonnegativeIntegerSchema,
    remainingStock: nonnegativeIntegerSchema,
    depletedAt: isoTimestampSchema.nullable(),
    timeToDepletionSeconds: nonnegativeNumberSchema.nullable(),
  })
  .strict();

const queueBacklogHeadlineSchema = z
  .object({
    peakBacklog: nonnegativeIntegerSchema,
    peakAtElapsedSeconds: nonnegativeNumberSchema.nullable(),
    backlogDrainedAt: isoTimestampSchema.nullable(),
    drainDurationSeconds: nonnegativeNumberSchema.nullable(),
    drainDurationBoundary: z.literal(queueBacklogDrainDurationBoundary),
    definition: z.literal(queueBacklogDefinition),
  })
  .strict();

const confirmationConvergenceHeadlineSchema = z
  .object({
    confirmedOrderCount: nonnegativeIntegerSchema,
    failedOrderCount: nonnegativeIntegerSchema,
    pendingAtCaptureCount: nonnegativeIntegerSchema,
    averageLagMs: nonnegativeNumberSchema.nullable(),
    p95LagMs: nonnegativeNumberSchema.nullable(),
    maxLagMs: nonnegativeNumberSchema.nullable(),
    boundary: z.literal(confirmationLagBoundary),
  })
  .strict();

const runSignalWindowSchema = z
  .object({
    anchoredAt: isoTimestampSchema,
    endedAt: isoTimestampSchema,
    bucketCount: z.literal(runSignalBucketCount),
    bucketWidthSeconds: z.number().positive().finite(),
  })
  .strict()
  .superRefine((window, context) => {
    if (Date.parse(window.endedAt) < Date.parse(window.anchoredAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "must not precede the first checkout attempt",
      });
    }
  });

export const runSignalTimelineHeadlineSchema = z
  .object({
    window: runSignalWindowSchema,
    inventoryDrain: inventoryDrainHeadlineSchema,
    queueBacklog: queueBacklogHeadlineSchema,
    confirmationConvergence: confirmationConvergenceHeadlineSchema,
    convergenceDurationSeconds: nonnegativeNumberSchema.nullable(),
  })
  .strict();
export type RunSignalTimelineHeadline = z.infer<typeof runSignalTimelineHeadlineSchema>;

/**
 * PostgreSQL-derived signals use 120 buckets from the first checkout attempt
 * through the later of dispatch completion or retained reservation/order
 * activity. Request arrival remains producer-emitted in fixed one-second
 * windows and is intentionally carried by the traffic-delivery summary.
 */
export const runSignalTimelineSummarySchema = runSignalTimelineHeadlineSchema
  .extend({
    inventoryDrain: inventoryDrainHeadlineSchema
      .extend({
        remainingStockSeries: z.array(
          z.object({ ...elapsedSampleShape, remainingStock: nonnegativeIntegerSchema }).strict(),
        ),
      })
      .strict(),
    queueBacklog: queueBacklogHeadlineSchema
      .extend({
        backlogSeries: z.array(
          z.object({ ...elapsedSampleShape, backlog: nonnegativeIntegerSchema }).strict(),
        ),
      })
      .strict(),
    confirmationConvergence: confirmationConvergenceHeadlineSchema
      .extend({
        convergenceSeries: z.array(
          z
            .object({
              ...elapsedSampleShape,
              cumulativeConfirmedOrderCount: nonnegativeIntegerSchema,
              cumulativeSettledOrderCount: nonnegativeIntegerSchema,
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict()
  .superRefine((summary, context) => {
    const expectedLength = summary.window.bucketCount;
    const expectedWindowSeconds =
      (Date.parse(summary.window.endedAt) - Date.parse(summary.window.anchoredAt)) / 1_000;
    const series = [
      summary.inventoryDrain.remainingStockSeries,
      summary.queueBacklog.backlogSeries,
      summary.confirmationConvergence.convergenceSeries,
    ];
    if (series.some((samples) => samples.length !== expectedLength)) {
      context.addIssue({
        code: "custom",
        path: ["window", "bucketCount"],
        message: "must equal the length of every derived signal series",
      });
    }
    if (
      Math.abs(
        expectedWindowSeconds - summary.window.bucketWidthSeconds * summary.window.bucketCount,
      ) > 0.001
    ) {
      context.addIssue({
        code: "custom",
        path: ["window", "bucketWidthSeconds"],
        message: "must span the complete anchored window across every bucket",
      });
    }
    if (
      series.some((samples) =>
        samples.some(
          (sample, index) =>
            Math.abs(
              sample.elapsedSeconds -
                runSignalBucketElapsedSeconds(index, summary.window.bucketWidthSeconds),
            ) > 0.001,
        ),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["window", "bucketWidthSeconds"],
        message: "must match every derived sample's elapsed coordinate",
      });
    }
    if (
      summary.inventoryDrain.remainingStockSeries.some(
        (sample, index, samples) =>
          index > 0 && sample.remainingStock > (samples[index - 1]?.remainingStock ?? 0),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["inventoryDrain", "remainingStockSeries"],
        message: "remaining stock must be monotonic",
      });
    }
    if (
      summary.queueBacklog.backlogSeries.some(
        (sample) => sample.backlog > summary.queueBacklog.peakBacklog,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["queueBacklog", "peakBacklog"],
        message: "must be at least every retained backlog sample",
      });
    }
    if (
      summary.confirmationConvergence.convergenceSeries.some((sample, index, samples) => {
        const previous = samples[index - 1];
        return (
          sample.cumulativeConfirmedOrderCount > sample.cumulativeSettledOrderCount ||
          (previous !== undefined &&
            (sample.cumulativeConfirmedOrderCount < previous.cumulativeConfirmedOrderCount ||
              sample.cumulativeSettledOrderCount < previous.cumulativeSettledOrderCount))
        );
      })
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmationConvergence", "convergenceSeries"],
        message: "confirmation and settlement totals must be monotonic",
      });
    }
  });
export type RunSignalTimelineSummary = z.infer<typeof runSignalTimelineSummarySchema>;

export function toRunSignalTimelineHeadline(
  summary: RunSignalTimelineSummary,
): RunSignalTimelineHeadline {
  const { remainingStockSeries: _remainingStockSeries, ...inventoryDrain } = summary.inventoryDrain;
  const { backlogSeries: _backlogSeries, ...queueBacklog } = summary.queueBacklog;
  const { convergenceSeries: _convergenceSeries, ...confirmationConvergence } =
    summary.confirmationConvergence;
  return runSignalTimelineHeadlineSchema.parse({
    window: summary.window,
    inventoryDrain,
    queueBacklog,
    confirmationConvergence,
    convergenceDurationSeconds: summary.convergenceDurationSeconds,
  });
}

export function deriveOversoldUnits(evidence: {
  reservedUnits: number;
  startingStock: number;
}): number {
  return Math.max(0, evidence.reservedUnits - evidence.startingStock);
}

export function runSignalBucketElapsedSeconds(index: number, bucketWidthSeconds: number): number {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isFinite(bucketWidthSeconds) ||
    bucketWidthSeconds <= 0
  ) {
    throw new RangeError("Run signal bucket coordinates must be nonnegative and finite.");
  }
  return (index + 1) * bucketWidthSeconds;
}
