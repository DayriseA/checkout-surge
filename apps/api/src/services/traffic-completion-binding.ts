import { isDeepStrictEqual } from "node:util";
import {
  acceptedRunConfigSnapshotSchema,
  deriveLoadExecutionPlan,
  type TrafficCompletionReport,
  type TrafficDeliverySummary,
} from "@checkout-surge/contracts";

export interface TrafficCompletionMismatch {
  field: string;
  expected?: unknown;
  actual?: unknown;
}

export interface AcceptedTrafficCompletionBinding {
  runId: string;
  configSnapshot: unknown;
  acceptedAt: Date;
  trafficStartedAt: Date | null;
}

export function findTrafficCompletionBindingMismatch(
  run: AcceptedTrafficCompletionBinding,
  report: TrafficCompletionReport,
): TrafficCompletionMismatch | null {
  if (report.runId !== run.runId) {
    return { field: "runId", expected: run.runId, actual: report.runId };
  }

  const snapshot = acceptedRunConfigSnapshotSchema.parse(run.configSnapshot);
  const expectedPlan = deriveLoadExecutionPlan(snapshot.trafficConfig);
  const reportedPlan = report.loadRunDiagnosticsSummary.executionPlan;
  if (!isDeepStrictEqual(reportedPlan, expectedPlan)) {
    return {
      field: "loadRunDiagnosticsSummary.executionPlan",
      expected: expectedPlan,
      actual: reportedPlan,
    };
  }

  const expectedPlannedRequests = expectedPlan.plannedEmittedAttempts;
  if (report.httpSummary.plannedRequests !== expectedPlannedRequests) {
    return {
      field: "httpSummary.plannedRequests",
      expected: expectedPlannedRequests,
      actual: report.httpSummary.plannedRequests,
    };
  }
  if (report.trafficDeliverySummary.plannedRequests !== expectedPlannedRequests) {
    return {
      field: "trafficDeliverySummary.plannedRequests",
      expected: expectedPlannedRequests,
      actual: report.trafficDeliverySummary.plannedRequests,
    };
  }

  const reportedStartedAt = Date.parse(report.loadRunDiagnosticsSummary.startedAt);
  if (run.trafficStartedAt) {
    if (run.trafficStartedAt.getTime() !== reportedStartedAt) {
      return {
        field: "loadRunDiagnosticsSummary.startedAt",
        expected: run.trafficStartedAt.toISOString(),
        actual: report.loadRunDiagnosticsSummary.startedAt,
      };
    }
  } else if (reportedStartedAt < run.acceptedAt.getTime()) {
    return {
      field: "loadRunDiagnosticsSummary.startedAt",
      expected: { notBefore: run.acceptedAt.toISOString() },
      actual: report.loadRunDiagnosticsSummary.startedAt,
    };
  }

  return null;
}

export function findTrafficCompletionRedeliveryMismatch(
  run: { trafficStatus: unknown; trafficEndedAt: Date | null },
  existing: {
    exitCode: unknown;
    errorMessage: unknown;
    httpSummary: unknown;
    trafficOutcomeSummary: Record<string, unknown>;
    trafficDeliverySummary: unknown;
    httpTimingBreakdownSummary: unknown;
    loadRunDiagnosticsSummary: unknown;
    apiRequestLifecycleSummary: unknown;
  },
  report: TrafficCompletionReport,
  normalizedTrafficDeliverySummary: TrafficDeliverySummary,
): TrafficCompletionMismatch | null {
  const comparisons: Array<[string, unknown, unknown]> = [
    ["status", report.status, run.trafficStatus],
    ["exitCode", report.exitCode ?? null, existing.exitCode],
    ["errorMessage", report.errorMessage ?? null, existing.errorMessage],
    ["httpSummary", report.httpSummary, existing.httpSummary],
    [
      "trafficOutcomeSummary",
      report.trafficOutcomeSummary,
      withoutCompletionEnrichment(existing.trafficOutcomeSummary),
    ],
    ["trafficDeliverySummary", normalizedTrafficDeliverySummary, existing.trafficDeliverySummary],
    [
      "httpTimingBreakdownSummary",
      report.httpTimingBreakdownSummary,
      existing.httpTimingBreakdownSummary,
    ],
    [
      "loadRunDiagnosticsSummary",
      report.loadRunDiagnosticsSummary,
      existing.loadRunDiagnosticsSummary,
    ],
    [
      "apiRequestLifecycleSummary",
      report.apiRequestLifecycleSummary,
      existing.apiRequestLifecycleSummary,
    ],
    ["completedAt", report.completedAt, run.trafficEndedAt?.toISOString()],
  ];
  for (const [field, actual, expected] of comparisons) {
    if (!isDeepStrictEqual(actual, expected)) return { field };
  }
  return null;
}

function withoutCompletionEnrichment(value: Record<string, unknown>): Record<string, unknown> {
  const {
    businessOutcomeAtTrafficCompletion: _businessOutcomeAtTrafficCompletion,
    terminalInventorySnapshot: _terminalInventorySnapshot,
    ...orchestratorOutcome
  } = value;
  return orchestratorOutcome;
}
