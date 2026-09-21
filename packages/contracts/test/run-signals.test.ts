import { describe, expect, it } from "vitest";
import {
  deriveOversoldUnits,
  type RunRuntimeProgress,
  type RunSignalTimelineSummary,
  runRuntimeProgressSchema,
  runSignalBucketCount,
  runSignalTimelineSummarySchema,
} from "../src/index.js";

const anchoredAt = "2026-06-20T00:00:00.000Z";

describe("run runtime progress contract", () => {
  it("accepts nominal progress with a genuine zero rate inside a positive window", () => {
    const progress = runtimeProgressFixture({ confirmationRatePerSecond: 0 });
    expect(runRuntimeProgressSchema.parse(progress)).toEqual(progress);
  });

  it("rejects a status that disagrees with its read state", () => {
    expect(
      runRuntimeProgressSchema.safeParse(runtimeProgressFixture({ downstreamErpStatus: null }))
        .success,
    ).toBe(false);
    expect(
      runRuntimeProgressSchema.safeParse(
        runtimeProgressFixture({
          downstreamErpStatus: "erp_limiting",
          downstreamErpStatusReadStatus: "unavailable",
        }),
      ).success,
    ).toBe(false);
  });

  it("accepts an explicitly unavailable status read and an unavailable rate", () => {
    const progress = runtimeProgressFixture({
      confirmationRatePerSecond: null,
      downstreamErpStatus: null,
      downstreamErpStatusReadStatus: "unavailable",
    });
    expect(runRuntimeProgressSchema.parse(progress)).toEqual(progress);
  });

  it("rejects a measurable rate over a zero-length window", () => {
    expect(
      runRuntimeProgressSchema.safeParse(
        runtimeProgressFixture({ confirmationRateWindowSeconds: 0 }),
      ).success,
    ).toBe(false);
  });
});

function runtimeProgressFixture(overrides: Partial<RunRuntimeProgress> = {}): RunRuntimeProgress {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    outstandingOrders: 3,
    oldestOutstandingAgeSeconds: 12.5,
    confirmationRatePerSecond: 0.5,
    confirmationRateWindowSeconds: 10,
    downstreamErpStatus: "nominal",
    downstreamErpStatusReadStatus: "available",
    observedAt: "2026-06-20T00:00:30.000Z",
    ...overrides,
  };
}

describe("run signal timeline contract", () => {
  it("accepts completed terminal evidence", () => {
    expect(runSignalTimelineSummarySchema.parse(summaryFixture())).toEqual(summaryFixture());
  });

  it("accepts partial terminal evidence", () => {
    expect(
      runSignalTimelineSummarySchema.parse(
        summaryFixture({
          confirmationConvergence: {
            ...summaryFixture().confirmationConvergence,
            pendingAtCaptureCount: 1,
          },
          convergenceDurationSeconds: null,
        }),
      ).confirmationConvergence.pendingAtCaptureCount,
    ).toBe(1);
  });

  it("accepts empty anchored terminal evidence", () => {
    const summary = summaryFixture();
    const empty: RunSignalTimelineSummary = {
      ...summary,
      inventoryDrain: {
        startingStock: 10,
        remainingStock: 10,
        depletedAt: null,
        timeToDepletionSeconds: null,
        remainingStockSeries: summary.inventoryDrain.remainingStockSeries.map((sample) => ({
          ...sample,
          remainingStock: 10,
        })),
      },
      queueBacklog: {
        peakBacklog: 0,
        peakAtElapsedSeconds: null,
        backlogDrainedAt: null,
        drainDurationSeconds: null,
        drainDurationBoundary: "first_order_queued_to_final_backlog_zero",
        definition: "accepted_awaiting_first_processing_start",
        backlogSeries: summary.queueBacklog.backlogSeries.map((sample) => ({
          ...sample,
          backlog: 0,
        })),
      },
      confirmationConvergence: {
        confirmedOrderCount: 0,
        failedOrderCount: 0,
        pendingAtCaptureCount: 0,
        averageLagMs: null,
        p95LagMs: null,
        maxLagMs: null,
        boundary: "reservation_secured_to_order_confirmed",
        convergenceSeries: summary.confirmationConvergence.convergenceSeries.map((sample) => ({
          ...sample,
          cumulativeConfirmedOrderCount: 0,
          cumulativeSettledOrderCount: 0,
        })),
      },
      convergenceDurationSeconds: null,
    };

    expect(runSignalTimelineSummarySchema.parse(empty)).toEqual(empty);
  });

  it("rejects truncated, non-monotonic, and understated peak series", () => {
    const summary = summaryFixture();
    expect(
      runSignalTimelineSummarySchema.safeParse({
        ...summary,
        queueBacklog: { ...summary.queueBacklog, backlogSeries: [] },
      }).success,
    ).toBe(false);
    expect(
      runSignalTimelineSummarySchema.safeParse({
        ...summary,
        inventoryDrain: {
          ...summary.inventoryDrain,
          remainingStockSeries: summary.inventoryDrain.remainingStockSeries.map(
            (sample, index) => ({
              ...sample,
              remainingStock: index === 3 ? 11 : sample.remainingStock,
            }),
          ),
        },
      }).success,
    ).toBe(false);
    expect(
      runSignalTimelineSummarySchema.safeParse({
        ...summary,
        queueBacklog: { ...summary.queueBacklog, peakBacklog: 1 },
      }).success,
    ).toBe(false);
  });

  it("rejects bucket widths and coordinates that do not span the shared window", () => {
    const summary = summaryFixture();
    expect(
      runSignalTimelineSummarySchema.safeParse({
        ...summary,
        window: { ...summary.window, bucketWidthSeconds: 2 },
      }).success,
    ).toBe(false);
    expect(
      runSignalTimelineSummarySchema.safeParse({
        ...summary,
        queueBacklog: {
          ...summary.queueBacklog,
          backlogSeries: summary.queueBacklog.backlogSeries.map((sample, index) =>
            index === 3 ? { ...sample, elapsedSeconds: 4.5 } : sample,
          ),
        },
      }).success,
    ).toBe(false);
  });

  it("derives oversell from its authoritative inventory inputs", () => {
    expect(deriveOversoldUnits({ reservedUnits: 12, startingStock: 10 })).toBe(2);
    expect(deriveOversoldUnits({ reservedUnits: 8, startingStock: 10 })).toBe(0);
  });
});

function summaryFixture(
  overrides: Partial<RunSignalTimelineSummary> = {},
): RunSignalTimelineSummary {
  return { ...summaryFixtureBase(), ...overrides };
}

function summaryFixtureBase() {
  const elapsed = Array.from({ length: runSignalBucketCount }, (_, index) => index + 1);
  return {
    window: {
      anchoredAt,
      endedAt: "2026-06-20T00:02:00.000Z",
      bucketCount: runSignalBucketCount,
      bucketWidthSeconds: 1,
    },
    inventoryDrain: {
      startingStock: 10,
      remainingStock: 0,
      depletedAt: "2026-06-20T00:00:10.000Z",
      timeToDepletionSeconds: 10,
      remainingStockSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        remainingStock: Math.max(0, 10 - elapsedSeconds),
      })),
    },
    queueBacklog: {
      peakBacklog: 5,
      peakAtElapsedSeconds: 5,
      backlogDrainedAt: "2026-06-20T00:00:20.000Z",
      drainDurationSeconds: 19,
      drainDurationBoundary: "first_order_queued_to_final_backlog_zero" as const,
      definition: "accepted_awaiting_first_processing_start" as const,
      backlogSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        backlog: elapsedSeconds < 10 ? Math.min(5, elapsedSeconds) : 0,
      })),
    },
    confirmationConvergence: {
      confirmedOrderCount: 9,
      failedOrderCount: 1,
      pendingAtCaptureCount: 0,
      averageLagMs: 2_000,
      p95LagMs: 3_000,
      maxLagMs: 4_000,
      boundary: "reservation_secured_to_order_confirmed" as const,
      convergenceSeries: elapsed.map((elapsedSeconds) => ({
        elapsedSeconds,
        cumulativeConfirmedOrderCount: Math.min(9, elapsedSeconds),
        cumulativeSettledOrderCount: Math.min(10, elapsedSeconds),
      })),
    },
    convergenceDurationSeconds: 110,
  };
}
