import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  emptyHttpTimingBreakdownSummary,
  loadRunDiagnosticsSummarySchema,
  normalizeLegacyApiRequestLifecycleSummaryJson,
  normalizeLegacyLoadRunDiagnosticsSummaryJson,
  normalizeLegacyTrafficDeliverySummaryJson,
  normalizeLegacyTrafficHttpSummaryJson,
  type TrafficCompletionReport,
  type TrafficExecutionStartRequest,
  trafficCompletionReportSchema,
  trafficExecutionStartRequestSchema,
} from "@checkout-surge/contracts";
import { z } from "zod";
import { generateK6Script } from "./k6-script.js";

const durableExecutionSchema = z.preprocess(
  migrateLegacyExecutionJournal,
  z
    .object({
      request: trafficExecutionStartRequestSchema,
      state: z.enum(["accepted", "executing", "completion_pending", "completed"]),
      acceptedAt: z.string().datetime({ offset: true }),
      completion: trafficCompletionReportSchema.optional(),
    })
    .strict(),
);

export type DurableExecution = z.infer<typeof durableExecutionSchema>;

/** Atomic single-slot journal. The orchestrator deliberately owns at most one execution. */
export class FileExecutionStore {
  private readonly filePath: string;
  private writeChain = Promise.resolve();
  private acceptChain = Promise.resolve();

  constructor(directory: string) {
    this.filePath = path.join(directory, "execution.json");
  }

  async read(): Promise<DurableExecution | null> {
    try {
      return durableExecutionSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async accept(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    const operation = this.acceptChain.then(() => this.acceptOnce(request, acceptedAt));
    this.acceptChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async acceptOnce(
    request: TrafficExecutionStartRequest,
    acceptedAt: Date,
  ): Promise<{ execution: DurableExecution; created: boolean }> {
    const current = await this.read();
    if (current && current.state !== "completed") {
      if (current.request.runId === request.runId) return { execution: current, created: false };
      throw new ExecutionConflictError(current.request.runId);
    }
    const execution: DurableExecution = {
      request: trafficExecutionStartRequestSchema.parse(request),
      state: "accepted",
      acceptedAt: acceptedAt.toISOString(),
    };
    await this.write(execution);
    return { execution, created: true };
  }

  async update(execution: DurableExecution): Promise<void> {
    await this.write(durableExecutionSchema.parse(execution));
  }

  private async write(execution: DurableExecution): Promise<void> {
    const operation = this.writeChain.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(execution)}\n`, "utf8");
      const temporaryFile = await open(temporaryPath, "r");
      try {
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }
      await rename(temporaryPath, this.filePath);
      const directory = await open(path.dirname(this.filePath), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    this.writeChain = operation.catch(() => undefined);
    await operation;
  }
}

/**
 * Legacy journal read-boundary migration. Old completions recorded the retired
 * `emittedRequests`/`unstartedIterations`/`requestShortfall` transport names
 * and older diagnostics shapes; rewrite them to canonical transport counts and
 * terminal metric-source names before strict parsing. New completions are
 * written canonically and pass through unchanged.
 */
function migrateLegacyExecutionJournal(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const journal = value as Record<string, unknown>;
  const request = journal.request;
  const completion = journal.completion;
  if (!request || typeof request !== "object" || !completion || typeof completion !== "object")
    return value;
  const report = completion as Record<string, unknown>;

  const httpSummary = normalizeLegacyTrafficHttpSummaryJson(report.httpSummary);
  const plannedRequests = readLegacyPlannedRequests(httpSummary);
  const migratedCompletion: Record<string, unknown> = {
    ...report,
    httpSummary,
    trafficDeliverySummary: normalizeLegacyTrafficDeliverySummaryJson(
      report.trafficDeliverySummary,
    ),
    apiRequestLifecycleSummary: normalizeLegacyApiRequestLifecycleSummaryJson(
      report.apiRequestLifecycleSummary,
      plannedRequests,
    ),
  };

  const diagnosticsMigration = migrateLegacyDiagnostics(request, report.loadRunDiagnosticsSummary);
  if (diagnosticsMigration) {
    migratedCompletion.loadRunDiagnosticsSummary = diagnosticsMigration.diagnostics;
    const migratedTiming = migrateLegacyTiming(report.httpTimingBreakdownSummary);
    if (migratedTiming !== undefined) {
      migratedCompletion.httpTimingBreakdownSummary = migratedTiming;
    }
  } else {
    migratedCompletion.loadRunDiagnosticsSummary = normalizeLegacyLoadRunDiagnosticsSummaryJson(
      report.loadRunDiagnosticsSummary,
    );
  }

  return { ...journal, completion: migratedCompletion };
}

function readLegacyPlannedRequests(httpSummary: unknown): number {
  if (!httpSummary || typeof httpSummary !== "object" || Array.isArray(httpSummary)) return 0;
  const planned = (httpSummary as Record<string, unknown>).plannedRequests;
  return typeof planned === "number" && Number.isFinite(planned) && planned >= 0 ? planned : 0;
}

function migrateLegacyDiagnostics(
  request: unknown,
  diagnostics: unknown,
): { diagnostics: Record<string, unknown> } | null {
  if (!diagnostics || typeof diagnostics !== "object" || Array.isArray(diagnostics)) return null;
  const legacy = diagnostics as Record<string, unknown>;
  const parsedRequest = trafficExecutionStartRequestSchema.safeParse(request);
  if (!parsedRequest.success) return null;

  const timestampOnlyDiagnostics = parseTimestampOnlyDiagnostics(legacy);
  const fullLegacyDiagnostics = loadRunDiagnosticsSummarySchema.safeParse(legacy);
  if (
    !timestampOnlyDiagnostics &&
    (!fullLegacyDiagnostics.success ||
      "terminalMetricSources" in legacy ||
      "summaryExportWarnings" in legacy)
  )
    return null;

  const migratedDiagnostics = timestampOnlyDiagnostics
    ? {
        startedAt: timestampOnlyDiagnostics.startedAt,
        completedAt: timestampOnlyDiagnostics.completedAt,
        nproc: null,
        ulimitNofile: null,
        processMaxOpenFiles: null,
        networkDiagnostics: null,
        k6Version: null,
        executionPlan: generateK6Script(parsedRequest.data).executionPlan,
        stderrLines: [],
        stderrLineCountObserved: 0,
        stderrLineCountRetained: 0,
        stderrRetainedLineLimit: 50,
        stderrLineTruncationLength: 500,
        stderrLineTruncatedCount: 0,
        ...legacyTerminalEvidenceDefaults(),
      }
    : {
        ...fullLegacyDiagnostics.data,
        ...legacyTerminalEvidenceDefaults(),
      };
  return { diagnostics: migratedDiagnostics };
}

function parseTimestampOnlyDiagnostics(
  diagnostics: Record<string, unknown>,
): { startedAt: string; completedAt: string } | null {
  const keys = Object.keys(diagnostics);
  return keys.length === 2 &&
    keys.every((key) => key === "startedAt" || key === "completedAt") &&
    typeof diagnostics.startedAt === "string" &&
    typeof diagnostics.completedAt === "string"
    ? { startedAt: diagnostics.startedAt, completedAt: diagnostics.completedAt }
    : null;
}

function migrateLegacyTiming(value: unknown): typeof emptyHttpTimingBreakdownSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const timing = value as Record<string, unknown>;
  const keys = Object.keys(timing);
  if (keys.length === 0) return emptyHttpTimingBreakdownSummary;
  if (
    keys.length === 1 &&
    keys[0] === "p95LatencyMs" &&
    (timing.p95LatencyMs === null ||
      (typeof timing.p95LatencyMs === "number" &&
        Number.isFinite(timing.p95LatencyMs) &&
        timing.p95LatencyMs >= 0))
  )
    return emptyHttpTimingBreakdownSummary;
  return undefined;
}

function legacyTerminalEvidenceDefaults() {
  return {
    terminalMetricSources: {
      startedRequests: null,
      completedRequests: null,
      acceptedResponses: null,
      soldOutResponses: null,
      unexpectedResponses: null,
      droppedIterations: null,
      completedIterations: null,
    },
    summaryExportWarnings: [
      "summary_export_missing" as const,
      "k6_outcome_counter_summary_export_unavailable" as const,
    ],
  };
}

export class ExecutionConflictError extends Error {
  constructor(readonly currentRunId: string) {
    super(`Traffic execution ${currentRunId} already owns the execution slot.`);
    this.name = "ExecutionConflictError";
  }
}

export function withCompletion(
  execution: DurableExecution,
  completion: TrafficCompletionReport,
): DurableExecution {
  return { ...execution, state: "completion_pending", completion };
}
