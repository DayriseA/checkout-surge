import {
  emptyHttpTimingBreakdownSummary,
  type TrafficCompletionReport,
  trafficDeliverySummarySchema,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { findTrafficCompletionRedeliveryMismatch } from "../src/services/traffic-completion-binding.js";

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
      httpSummary: report.httpSummary,
      trafficOutcomeSummary: report.trafficOutcomeSummary,
      trafficDeliverySummary: classifiedDelivery,
      httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
      apiRequestLifecycleSummary: report.apiRequestLifecycleSummary,
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

  it("rejects old persisted lifecycle evidence with run and field context", () => {
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
          httpSummary: report.httpSummary,
          trafficOutcomeSummary: report.trafficOutcomeSummary,
          trafficDeliverySummary: classifiedDelivery,
          httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
          loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
          apiRequestLifecycleSummary: { completedRequests: 10, failedRequests: 0 },
        },
        report,
        classifiedDelivery,
      ),
    ).toThrow(/demo run 11111111-1111-4111-8111-111111111111.*apiRequestLifecycleSummary/);
  });
});

function completionReport(): TrafficCompletionReport {
  const completedAt = "2026-07-19T00:00:10.000Z";
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    status: "succeeded",
    exitCode: 0,
    httpSummary: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
      failedRequests: 0,
      acceptedResponses: 4,
      soldOutResponses: 6,
      unexpectedResponses: 0,
      failureRate: 0,
    },
    trafficOutcomeSummary: {
      acceptedResponses: 4,
      soldOutResponses: 6,
      unexpectedResponses: 0,
    },
    trafficDeliverySummary: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
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
        unexpectedResponses: "summary_export",
        droppedIterations: "summary_export",
        completedIterations: "summary_export",
      },
      summaryExportWarnings: [],
    },
    apiRequestLifecycleSummary: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
      failedRequests: 0,
    },
    completedAt,
    correlationId: "corr-redelivery",
  };
}
