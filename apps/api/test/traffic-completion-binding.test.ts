import {
  type AcceptedRunConfigSnapshot,
  emptyHttpTimingBreakdownSummary,
  type TrafficCompletionReport,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import {
  findTrafficCompletionBindingMismatch,
  findTrafficCompletionRedeliveryMismatch,
} from "../src/services/traffic-completion-binding.js";

describe("traffic completion binding", () => {
  it("binds the execution plan, planned count, and runner start to the accepted run", () => {
    const report = completionReport();
    const accepted = {
      runId: report.runId,
      configSnapshot: buyerSpikeSnapshot(),
      acceptedAt: new Date("2026-07-19T00:00:00.000Z"),
      trafficStartedAt: new Date(report.loadRunDiagnosticsSummary.startedAt),
    };

    expect(findTrafficCompletionBindingMismatch(accepted, report)).toBeNull();
    expect(
      findTrafficCompletionBindingMismatch(accepted, {
        ...report,
        transportAttemptCounts: { ...report.transportAttemptCounts, plannedRequests: 9 },
      }),
    ).toMatchObject({ field: "transportAttemptCounts.plannedRequests" });
  });

  it("rejects a runner start before API acceptance when activation has not been recorded", () => {
    const report = completionReport();

    expect(
      findTrafficCompletionBindingMismatch(
        {
          runId: report.runId,
          configSnapshot: buyerSpikeSnapshot(),
          acceptedAt: new Date("2026-07-19T00:00:00.001Z"),
          trafficStartedAt: null,
        },
        report,
      ),
    ).toMatchObject({ field: "loadRunDiagnosticsSummary.startedAt" });
  });

  it("binds steady-arrival rate, duration, and effective VUs", () => {
    const report = completionReport();
    const steadyReport: TrafficCompletionReport = {
      ...report,
      loadRunDiagnosticsSummary: {
        ...report.loadRunDiagnosticsSummary,
        executionPlan: {
          trafficMode: "steady-arrival-rate",
          ratePerSecond: 5,
          durationSeconds: 2,
          plannedEmittedAttempts: 10,
          startDelaySeconds: 0,
          preAllocatedVus: 3,
          maxVus: 6,
        },
      },
      trafficDeliverySummary: {
        ...report.trafficDeliverySummary,
        trafficMode: "steady-arrival-rate",
        plannedBuyers: null,
        scheduledRatePerSecond: 5,
        configuredDurationSeconds: 2,
        preAllocatedVUs: 3,
        maxVUs: 6,
      },
    };
    const snapshot: AcceptedRunConfigSnapshot = {
      ...buyerSpikeSnapshot(),
      trafficConfig: {
        mode: "steady-arrival-rate",
        ratePerSecond: 5,
        durationSeconds: 2,
        startDelaySeconds: 0,
        quantityPerAttempt: 1,
        k6Vus: { preAllocatedVus: 3, maxVus: 6 },
      },
    };

    expect(
      findTrafficCompletionBindingMismatch(
        {
          runId: report.runId,
          configSnapshot: snapshot,
          acceptedAt: new Date("2026-07-19T00:00:00.000Z"),
          trafficStartedAt: null,
        },
        steadyReport,
      ),
    ).toBeNull();
  });
});

describe("traffic completion redelivery", () => {
  it("accepts an exact redelivery against current persisted evidence", () => {
    const report = completionReport();
    const classifiedDelivery = trafficDeliverySummarySchema.parse({
      ...report.trafficDeliverySummary,
      trafficDeliveryStatus: "complete",
    });
    const existing = {
      exitCode: 0,
      errorMessage: null,
      transportAttemptCounts: report.transportAttemptCounts,
      httpSummary: report.httpSummary,
      trafficOutcomeSummary: report.trafficOutcomeSummary,
      trafficDeliverySummary: classifiedDelivery,
      httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
    };

    expect(
      findTrafficCompletionRedeliveryMismatch(
        { trafficStatus: "succeeded", trafficEndedAt: new Date(report.completedAt) },
        existing,
        report,
        classifiedDelivery,
      ),
    ).toBeNull();
  });

  it("rejects invalid persisted transport evidence with run and field context", () => {
    const report = completionReport();
    const classifiedDelivery = trafficDeliverySummarySchema.parse({
      ...report.trafficDeliverySummary,
      trafficDeliveryStatus: "complete",
    });

    expect(() =>
      findTrafficCompletionRedeliveryMismatch(
        { trafficStatus: "succeeded", trafficEndedAt: new Date(report.completedAt) },
        {
          exitCode: 0,
          errorMessage: null,
          transportAttemptCounts: { completedRequests: 10 },
          httpSummary: report.httpSummary,
          trafficOutcomeSummary: report.trafficOutcomeSummary,
          trafficDeliverySummary: classifiedDelivery,
          httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
          loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
        },
        report,
        classifiedDelivery,
      ),
    ).toThrow(/demo run 11111111-1111-4111-8111-111111111111.*transportAttemptCounts/);
  });
});

function completionReport(): TrafficCompletionReport {
  const completedAt = "2026-07-19T00:00:10.000Z";
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    status: "succeeded",
    exitCode: 0,
    transportAttemptCounts: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 4,
      soldOutResponses: 6,
      transportFailures: 0,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {
      acceptedResponses: 4,
      soldOutResponses: 6,
      unexpectedResponses: 0,
    },
    trafficDeliverySummary: {
      trafficMode: "buyer-spike",
      plannedBuyers: 10,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: 10,
      notes: [],
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: {
      startedAt: "2026-07-19T00:00:00.000Z",
      completedAt,
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      generatorCapacity: null,
      generatorUtilisation: null,
      networkDiagnostics: null,
      k6Version: null,
      executionPlan: {
        trafficMode: "buyer-spike",
        buyerCount: 10,
        duplicateEachBuyerAttempt: false,
        iterationsPerVu: 1,
        plannedEmittedAttempts: 10,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
      },
      stderrLines: [],
      stderrLineCountObserved: 0,
      stderrLineCountRetained: 0,
      stderrRetainedLineLimit: 50,
      stderrLineTruncationLength: 500,
      stderrLineTruncatedCount: 0,
      terminalMetricSources: {
        startedRequests: "summary_export",
        completedRequests: "summary_export",
        acceptedResponses: "summary_export",
        soldOutResponses: "summary_export",
        transportFailures: "summary_export" as const,
        unexpectedResponses: "summary_export",
        droppedIterations: "summary_export",
        completedIterations: "summary_export",
      },
      summaryExportWarnings: [],
    },
    completedAt,
    correlationId: "corr-redelivery",
  };
}

function buyerSpikeSnapshot(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 100,
      maxTps: 10,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2_000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}
