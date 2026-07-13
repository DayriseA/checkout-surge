import type { TrafficCompletionReport } from "@checkout-surge/contracts";

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
  private readonly latencies: number[] = [];

  constructor(
    private readonly options: {
      runId: string;
      correlationId: string;
      plannedRequests: number;
      startedAt: Date;
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
      },
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
    const deliveryRatio = planned > 0 ? this.emittedRequests / planned : 1;
    const notes: string[] = [];

    if (this.unexpectedResponses > 0) {
      notes.push("unexpected_checkout_responses_observed");
    }
    if (this.droppedIterations > 0) {
      notes.push("k6_dropped_iterations_observed");
    }

    let trafficDeliveryStatus: "complete" | "warning" | "degraded" | "failed" = "complete";
    if (this.unexpectedResponses > 0 || deliveryRatio < 0.8) {
      trafficDeliveryStatus = "failed";
    } else if (deliveryRatio < 0.95) {
      trafficDeliveryStatus = "degraded";
    } else if (deliveryRatio < 1 || this.droppedIterations > 0) {
      trafficDeliveryStatus = "warning";
    }

    return {
      plannedRequests: planned,
      emittedRequests: this.emittedRequests,
      droppedIterations: this.droppedIterations,
      trafficDeliveryStatus,
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
