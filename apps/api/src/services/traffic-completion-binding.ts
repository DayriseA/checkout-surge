import { isDeepStrictEqual } from "node:util";
import {
  deriveLoadExecutionPlan,
  httpTimingBreakdownSummarySchema,
  realLoadRunDiagnosticsSummarySchema,
  type TrafficCompletionReport,
  type TrafficDeliverySummary,
  trafficCompletionApiRequestLifecycleSummarySchema,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
} from "@checkout-surge/contracts";
import { z } from "zod";
import { parsePersistedAcceptedRunConfigSnapshot } from "./persisted-demo-run-state.js";
import { parsePersistedTrafficDeliverySummary } from "./traffic-delivery-classifier.js";

const persistedRedeliveryEvidenceSchema = z
  .object({
    httpSummary: trafficHttpSummarySchema,
    trafficDeliverySummary: trafficDeliverySummarySchema,
    httpTimingBreakdownSummary: httpTimingBreakdownSummarySchema,
    loadRunDiagnosticsSummary: realLoadRunDiagnosticsSummarySchema,
    apiRequestLifecycleSummary: trafficCompletionApiRequestLifecycleSummarySchema,
  })
  .strict();

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

  const snapshot = parsePersistedAcceptedRunConfigSnapshot(
    run.configSnapshot,
    `demo run ${run.runId}`,
  );
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
  classifiedTrafficDeliverySummary: TrafficDeliverySummary,
): TrafficCompletionMismatch | null {
  const parsedExisting = persistedRedeliveryEvidenceSchema.safeParse({
    httpSummary: existing.httpSummary,
    trafficDeliverySummary: existing.trafficDeliverySummary,
    httpTimingBreakdownSummary: existing.httpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: existing.loadRunDiagnosticsSummary,
    apiRequestLifecycleSummary: existing.apiRequestLifecycleSummary,
  });
  if (!parsedExisting.success) {
    const issues = parsedExisting.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid persisted finalization for demo run ${report.runId}: ${issues}`, {
      cause: parsedExisting.error,
    });
  }
  const persistedDelivery = parsePersistedTrafficDeliverySummary(
    parsedExisting.data.trafficDeliverySummary,
    `demo run ${report.runId} finalization`,
  );

  const comparisons: Array<[string, unknown, unknown]> = [
    ["status", report.status, run.trafficStatus],
    ["exitCode", report.exitCode ?? null, existing.exitCode],
    ["errorMessage", report.errorMessage ?? null, existing.errorMessage],
    ["httpSummary", report.httpSummary, parsedExisting.data.httpSummary],
    [
      "trafficOutcomeSummary",
      report.trafficOutcomeSummary,
      withoutCompletionEnrichment(existing.trafficOutcomeSummary),
    ],
    ["trafficDeliverySummary", classifiedTrafficDeliverySummary, persistedDelivery],
    [
      "httpTimingBreakdownSummary",
      report.httpTimingBreakdownSummary,
      parsedExisting.data.httpTimingBreakdownSummary,
    ],
    [
      "loadRunDiagnosticsSummary",
      report.loadRunDiagnosticsSummary,
      parsedExisting.data.loadRunDiagnosticsSummary,
    ],
    [
      "apiRequestLifecycleSummary",
      report.apiRequestLifecycleSummary,
      parsedExisting.data.apiRequestLifecycleSummary,
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
