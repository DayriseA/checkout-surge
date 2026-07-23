import {
  dashboardEventSchema,
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import { demoRuns } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import type { DashboardTrafficMetricStore } from "./dashboard-traffic-metric-store.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";

export const maximumPendingTrafficMetricBatches = 10;

export interface TrafficMetricIngestionController {
  ingest(input: LoadMetricIngestRequest): Promise<void>;
}

export class TrafficMetricIngestionService implements TrafficMetricIngestionController {
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperationCount = 0;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      store: Pick<DashboardTrafficMetricStore, "appendIfLive" | "publishIfLive">;
      logger: Pick<CheckoutSurgeLogger, "warn">;
    },
  ) {}

  async ingest(input: LoadMetricIngestRequest): Promise<void> {
    const request = loadMetricIngestRequestSchema.parse(input);
    if (this.pendingOperationCount >= maximumPendingTrafficMetricBatches) return;

    this.pendingOperationCount += 1;
    const operation = this.operationTail
      .then(() => this.ingestAdmitted(request))
      .finally(() => {
        this.pendingOperationCount -= 1;
      });
    this.operationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }

  private async ingestAdmitted(request: LoadMetricIngestRequest): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      const [run] = await tx
        .select({ status: demoRuns.status, trafficStatus: demoRuns.trafficStatus })
        .from(demoRuns)
        .where(eq(demoRuns.id, request.runId))
        .limit(1)
        .for("update");
      if (!run) {
        throw new DemoRunValidationError("resource_not_found", "Demo run was not found.", {
          runId: request.runId,
        });
      }
      if (
        !(["starting", "active"] as string[]).includes(run.status) ||
        !(["starting", "active"] as string[]).includes(run.trafficStatus)
      ) {
        throw new DemoRunValidationError(
          "traffic_report_rejected",
          "Demo run is not eligible for traffic metric ingestion.",
          { runId: request.runId, status: run.status, trafficStatus: run.trafficStatus },
        );
      }

      const retained = await this.options.store.appendIfLive(request);
      if (!retained) {
        throw new DemoRunValidationError(
          "traffic_report_rejected",
          "Demo run traffic metrics have been fenced.",
          { runId: request.runId, status: run.status, trafficStatus: run.trafficStatus },
        );
      }

      await this.publishAdvisoryEvents(request);
    });
  }

  private async publishAdvisoryEvents(request: LoadMetricIngestRequest): Promise<void> {
    const publications: Array<{ metricName: MetricSample["metricName"]; payload: string }> = [];
    for (const sample of request.samples) {
      try {
        const event = dashboardEventSchema.parse({
          type: "dashboard.metric.observed",
          runId: request.runId,
          correlationId: request.correlationId,
          metricName: sample.metricName,
          value: sample.value,
          unit: sample.unit,
          occurredAt: sample.timestamp,
          observedAt: sample.timestamp,
        });
        publications.push({ metricName: sample.metricName, payload: JSON.stringify(event) });
      } catch (error) {
        this.warnPublicationFailure(error, request, sample.metricName);
      }
    }

    try {
      const result = await this.options.store.publishIfLive(
        request.runId,
        publications.map(({ payload }) => payload),
      );
      if (result.outcome === "attempted") {
        for (const failure of result.failures) {
          const publication = publications[failure.index];
          if (publication) {
            this.warnPublicationFailure(failure.error, request, publication.metricName);
          }
        }
      }
    } catch (error) {
      for (const publication of publications) {
        this.warnPublicationFailure(error, request, publication.metricName);
      }
    }
  }

  private warnPublicationFailure(
    error: unknown,
    request: Pick<LoadMetricIngestRequest, "runId" | "correlationId">,
    metricName: MetricSample["metricName"],
  ): void {
    try {
      this.options.logger.warn(
        { err: error, runId: request.runId, correlationId: request.correlationId, metricName },
        "Could not publish traffic metric dashboard event.",
      );
    } catch {
      // Reporting an advisory publication failure must not redefine accepted retention.
    }
  }
}
