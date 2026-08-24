import {
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
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
      store: Pick<DashboardTrafficMetricStore, "appendIfLive" | "publishDirtyIfLive">;
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

      const outcome = await this.options.store.appendIfLive(request);
      if (outcome === "fenced") {
        throw new DemoRunValidationError(
          "traffic_report_rejected",
          "Demo run traffic metrics have been fenced.",
          { runId: request.runId, status: run.status, trafficStatus: run.trafficStatus },
        );
      }

      if (outcome === "appended") await this.publishProjectionDirtySignal(request);
    });
  }

  private async publishProjectionDirtySignal(request: LoadMetricIngestRequest): Promise<void> {
    try {
      const result = await this.options.store.publishDirtyIfLive(request.runId, {
        type: "dashboard.projection.dirty",
        correlationId: request.correlationId,
      });
      if (result.outcome === "failed") this.warnPublicationFailure(result.error, request);
    } catch (error) {
      this.warnPublicationFailure(error, request);
    }
  }

  private warnPublicationFailure(
    error: unknown,
    request: Pick<LoadMetricIngestRequest, "runId" | "correlationId">,
  ): void {
    try {
      this.options.logger.warn(
        { err: error, runId: request.runId, correlationId: request.correlationId },
        "Could not publish traffic metric projection dirty signal.",
      );
    } catch {
      // Reporting an advisory publication failure must not redefine accepted retention.
    }
  }
}
