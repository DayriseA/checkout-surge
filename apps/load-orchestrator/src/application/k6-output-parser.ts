import type {
  LoadExecutionPlan,
  LoadRunDiagnosticsSummary,
  TrafficCompletionReport,
} from "@checkout-surge/contracts";
import type { InitialLoadRunDiagnostics } from "./load-run-diagnostics.js";

export class BoundedStderrCollector {
  private pending = "";
  private pendingCarriageReturn = false;
  private pendingWasTruncated = false;
  private readonly lines: string[] = [];
  private observed = 0;
  private truncated = 0;
  push(chunk: string): void {
    let remainingChunk = chunk;
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      if (remainingChunk.startsWith("\n")) {
        this.rememberPending();
        remainingChunk = remainingChunk.slice(1);
      } else {
        this.append("\r");
      }
    }
    const segments = remainingChunk.split("\n");
    for (const [index, segment] of segments.entries()) {
      const isComplete = index < segments.length - 1;
      const endsWithCarriageReturn = segment.endsWith("\r");
      const normalized = endsWithCarriageReturn ? segment.slice(0, -1) : segment;
      this.append(normalized);
      if (isComplete) this.rememberPending();
      else if (endsWithCarriageReturn) this.pendingCarriageReturn = true;
    }
  }
  finish(): void {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.append("\r");
    }
    if (this.pending.length > 0 || this.pendingWasTruncated) this.rememberPending();
  }
  private append(value: string) {
    const remaining = 500 - this.pending.length;
    if (value.length > remaining) this.pendingWasTruncated = true;
    if (remaining > 0) this.pending += value.slice(0, remaining);
  }
  snapshot() {
    return {
      stderrLines: [...this.lines],
      stderrLineCountObserved: this.observed,
      stderrLineCountRetained: this.lines.length,
      stderrRetainedLineLimit: 50 as const,
      stderrLineTruncationLength: 500 as const,
      stderrLineTruncatedCount: this.truncated,
    };
  }
  private rememberPending() {
    this.observed += 1;
    if (this.pendingWasTruncated) this.truncated += 1;
    this.lines.push(this.pending);
    if (this.lines.length > 50) this.lines.shift();
    this.pending = "";
    this.pendingWasTruncated = false;
  }
}

export type K6Point = {
  type?: string;
  metric?: string;
  data?: {
    time?: string;
    value?: number;
  };
};

export class K6RunAccumulator {
  private emittedRequests = 0;
  private httpFailedRequests = 0;
  private acceptedResponses = 0;
  private soldOutResponses = 0;
  private unexpectedResponses = 0;
  private droppedIterations = 0;
  private completedIterations = 0;
  private observedCompletedIterations = false;
  private readonly latencies: number[] = [];

  constructor(
    private readonly options: {
      runId: string;
      correlationId: string;
      plannedRequests: number;
      startedAt: Date;
      diagnostics?: InitialLoadRunDiagnostics;
      executionPlan: LoadExecutionPlan;
      stderr?: BoundedStderrCollector;
    },
  ) {}

  observe(point: K6Point): void {
    if (point.type !== "Point" || !point.metric || !point.data) {
      return;
    }

    const value = Number(point.data.value);

    if (!Number.isFinite(value)) {
      return;
    }

    switch (point.metric) {
      case "http_reqs":
        this.emittedRequests += value;
        return;
      case "http_req_duration":
        this.latencies.push(value);
        return;
      case "http_req_failed":
        this.httpFailedRequests += value > 0 ? 1 : 0;
        return;
      case "checkout_reservation_accepted":
        this.acceptedResponses += value;
        return;
      case "checkout_sold_out":
        this.soldOutResponses += value;
        return;
      case "checkout_unexpected_response":
        this.unexpectedResponses += value;
        return;
      case "dropped_iterations":
        this.droppedIterations += value;
        return;
      case "iterations":
        this.completedIterations += value;
        this.observedCompletedIterations = true;
        return;
      default:
        return;
    }
  }

  completionReport(input: {
    status: "succeeded" | "failed";
    exitCode?: number;
    errorMessage?: string;
    completedAt: Date;
  }): TrafficCompletionReport {
    const failureRate =
      this.emittedRequests > 0 ? this.failedRequests() / Math.max(this.emittedRequests, 1) : 0;
    const trafficDeliverySummary = this.trafficDeliverySummary();
    const failedRequests = this.failedRequests();

    return {
      runId: this.options.runId,
      status: input.status,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      ...(input.errorMessage ? { errorMessage: input.errorMessage } : {}),
      httpSummary: {
        plannedRequests: this.options.plannedRequests,
        emittedRequests: this.emittedRequests,
        completedRequests: this.emittedRequests,
        failedRequests,
        acceptedResponses: this.acceptedResponses,
        soldOutResponses: this.soldOutResponses,
        unexpectedResponses: this.unexpectedResponses,
        ...(this.latencies.length > 0 ? { p95LatencyMs: percentile(this.latencies, 95) } : {}),
        failureRate,
      },
      trafficOutcomeSummary: {
        acceptedResponses: this.acceptedResponses,
        soldOutResponses: this.soldOutResponses,
        unexpectedResponses: this.unexpectedResponses,
      },
      trafficDeliverySummary,
      httpTimingBreakdownSummary: {
        p95LatencyMs: this.latencies.length > 0 ? percentile(this.latencies, 95) : null,
      },
      loadRunDiagnosticsSummary: {
        startedAt: this.options.startedAt.toISOString(),
        completedAt: input.completedAt.toISOString(),
        ...(this.options.diagnostics ?? {
          nproc: null,
          ulimitNofile: null,
          processMaxOpenFiles: null,
          networkDiagnostics: null,
          k6Version: null,
          executionPlan: this.options.executionPlan,
        }),
        ...(this.options.stderr?.snapshot() ?? {
          stderrLines: [],
          stderrLineCountObserved: 0,
          stderrLineCountRetained: 0,
          stderrRetainedLineLimit: 50 as const,
          stderrLineTruncationLength: 500 as const,
          stderrLineTruncatedCount: 0,
        }),
      } satisfies LoadRunDiagnosticsSummary,
      apiRequestLifecycleSummary: {
        completedRequests: this.emittedRequests,
        failedRequests,
      },
      completedAt: input.completedAt.toISOString(),
      correlationId: this.options.correlationId,
    };
  }

  private trafficDeliverySummary() {
    const planned = this.options.plannedRequests;
    const plan = this.options.executionPlan;
    const completedIterations = this.observedCompletedIterations ? this.completedIterations : null;
    const notes: string[] = [];

    if (this.droppedIterations > 0) {
      notes.push("k6_dropped_iterations_observed");
    }

    return {
      plannedRequests: planned,
      emittedRequests: this.emittedRequests,
      trafficMode: plan.trafficMode,
      plannedBuyers: plan.trafficMode === "buyer-spike" ? plan.buyerCount : null,
      scheduledRatePerSecond:
        plan.trafficMode === "steady-arrival-rate" ? plan.ratePerSecond : null,
      configuredDurationSeconds:
        plan.trafficMode === "steady-arrival-rate" ? plan.durationSeconds : null,
      preAllocatedVUs: plan.trafficMode === "steady-arrival-rate" ? plan.preAllocatedVus : null,
      maxVUs: plan.trafficMode === "steady-arrival-rate" ? plan.maxVus : null,
      droppedIterations: this.droppedIterations,
      completedIterations,
      unstartedIterations:
        completedIterations === null
          ? null
          : Math.max(0, planned - completedIterations - this.droppedIterations),
      requestShortfall: Math.max(0, planned - this.emittedRequests),
      notes,
    };
  }

  private failedRequests(): number {
    const nonSoldOutHttpFailures = Math.max(this.httpFailedRequests - this.soldOutResponses, 0);
    return Math.max(this.unexpectedResponses, nonSoldOutHttpFailures);
  }
}

export function parseK6JsonLine(line: string): K6Point | null {
  try {
    const parsed = JSON.parse(line) as K6Point;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function percentile(values: number[], percentileRank: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}
