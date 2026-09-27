import { isDeepStrictEqual } from "node:util";
import {
  deriveLoadExecutionPlan,
  httpTimingBreakdownSummarySchema,
  realLoadRunDiagnosticsSummarySchema,
  type TrafficCompletionReport,
  type TrafficDeliverySummary,
  trafficDeliverySummarySchema,
  trafficHttpSummarySchema,
  transportAttemptCountsSchema,
} from "@checkout-surge/contracts";
import { z } from "zod";
import {
  parsePersistedAcceptedRunConfigSnapshot,
  parsePersistedState,
} from "./persisted-demo-run-state.js";
import { parsePersistedTrafficDeliverySummary } from "./traffic-delivery-classifier.js";

const persistedRedeliveryEvidenceSchema = z
  .object({
    transportAttemptCounts: transportAttemptCountsSchema,
    httpSummary: trafficHttpSummarySchema,
    trafficDeliverySummary: trafficDeliverySummarySchema,
    httpTimingBreakdownSummary: httpTimingBreakdownSummarySchema,
    loadRunDiagnosticsSummary: realLoadRunDiagnosticsSummarySchema,
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
    transportAttemptCounts: unknown;
    httpSummary: unknown;
    trafficOutcomeSummary: Record<string, unknown>;
    trafficDeliverySummary: unknown;
    httpTimingBreakdownSummary: unknown;
    loadRunDiagnosticsSummary: unknown;
  },
  report: TrafficCompletionReport,
  classifiedTrafficDeliverySummary: TrafficDeliverySummary,
): TrafficCompletionMismatch | null {
  const parsedExisting = parsePersistedState(
    persistedRedeliveryEvidenceSchema,
    {
      transportAttemptCounts: existing.transportAttemptCounts,
      httpSummary: existing.httpSummary,
      trafficDeliverySummary: existing.trafficDeliverySummary,
      httpTimingBreakdownSummary: existing.httpTimingBreakdownSummary,
      loadRunDiagnosticsSummary: existing.loadRunDiagnosticsSummary,
    },
    `demo run ${report.runId}`,
    "finalization",
  );
  const persistedDelivery = parsePersistedTrafficDeliverySummary(
    parsedExisting.trafficDeliverySummary,
    parsedExisting.transportAttemptCounts,
    `demo run ${report.runId} finalization`,
  );

  const comparisons: Array<[string, unknown, unknown]> = [
    ["status", report.status, run.trafficStatus],
    ["exitCode", report.exitCode ?? null, existing.exitCode],
    ["errorMessage", report.errorMessage ?? null, existing.errorMessage],
    [
      "transportAttemptCounts",
      report.transportAttemptCounts,
      parsedExisting.transportAttemptCounts,
    ],
    ["httpSummary", report.httpSummary, parsedExisting.httpSummary],
    [
      "trafficOutcomeSummary",
      report.trafficOutcomeSummary,
      withoutCompletionEnrichment(existing.trafficOutcomeSummary),
    ],
    ["trafficDeliverySummary", classifiedTrafficDeliverySummary, persistedDelivery],
    [
      "httpTimingBreakdownSummary",
      report.httpTimingBreakdownSummary,
      parsedExisting.httpTimingBreakdownSummary,
    ],
    [
      "loadRunDiagnosticsSummary",
      report.loadRunDiagnosticsSummary,
      parsedExisting.loadRunDiagnosticsSummary,
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
