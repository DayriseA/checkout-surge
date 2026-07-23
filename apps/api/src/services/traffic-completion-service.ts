import {
  type DemoRunSnapshot,
  type TrafficCompletionReport,
  trafficCompletionReportSchema,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRunFinalizations,
  demoRuns,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { and, eq, inArray } from "drizzle-orm";
import type { DemoRunFinalizationController } from "./demo-run-finalization-service.js";
import { publishDemoRunSnapshot, readDemoRunSnapshot } from "./demo-run-snapshot-operations.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";
import {
  findTrafficCompletionBindingMismatch,
  findTrafficCompletionRedeliveryMismatch,
} from "./traffic-completion-binding.js";
import type { TrafficCompletionEnrichmentController } from "./traffic-completion-enrichment-service.js";
import { classifyTrafficDeliverySummary } from "./traffic-delivery-classifier.js";

export interface TrafficCompletionController {
  recordTrafficCompletion(input: TrafficCompletionReport): Promise<DemoRunSnapshot>;
}

/**
 * Accepts the load orchestrator's immutable traffic evidence and hands the
 * claimed draining run to enrichment and business finalization.
 */
export class TrafficCompletionService implements TrafficCompletionController {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      redis: CheckoutSurgeRedis;
      completionEnrichmentService: Pick<
        TrafficCompletionEnrichmentController,
        "completePendingEnrichment"
      >;
      finalizationService: Pick<DemoRunFinalizationController, "finalizeRun">;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
    },
  ) {}

  async recordTrafficCompletion(input: TrafficCompletionReport): Promise<DemoRunSnapshot> {
    const report = trafficCompletionReportSchema.parse(input);
    const classifiedTrafficDeliverySummary = classifyTrafficDeliverySummary(
      report.trafficDeliverySummary,
      report.transportAttemptCounts,
    );
    const now = this.now();
    const completionClaim = await this.options.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(demoRuns)
        .where(eq(demoRuns.id, report.runId))
        .limit(1)
        .for("update");
      if (!run) {
        throw new DemoRunValidationError("resource_not_found", "Demo run was not found.", {
          runId: report.runId,
        });
      }
      if (!run.saleOfferId) {
        throw new DemoRunValidationError("run_conflict", "Demo run has no sale offer.", {
          conflictReason: "sale_offer_missing",
          runId: report.runId,
        });
      }
      if (!run.startedAt) {
        throw new Error(`Current demo run ${run.id} has no startedAt timestamp.`);
      }

      const bindingMismatch = findTrafficCompletionBindingMismatch(
        {
          runId: run.id,
          configSnapshot: run.configSnapshot,
          acceptedAt: run.startedAt,
          trafficStartedAt: run.trafficStartedAt,
        },
        report,
      );
      if (bindingMismatch) throwCompletionMismatch(run.id, bindingMismatch);

      const [existing] = await tx
        .select()
        .from(demoRunFinalizations)
        .where(eq(demoRunFinalizations.runId, report.runId))
        .limit(1)
        .for("update");
      if (existing) {
        const redeliveryMismatch = findTrafficCompletionRedeliveryMismatch(
          run,
          existing,
          report,
          classifiedTrafficDeliverySummary,
        );
        if (redeliveryMismatch) throwCompletionMismatch(run.id, redeliveryMismatch);
        return { inserted: false };
      }
      if (
        !(["starting", "active"] as string[]).includes(run.status) ||
        !(["starting", "active"] as string[]).includes(run.trafficStatus)
      ) {
        throw new DemoRunValidationError(
          "traffic_report_rejected",
          "Demo run is not eligible for traffic completion ingestion.",
          { runId: report.runId, status: run.status, trafficStatus: run.trafficStatus },
        );
      }

      const [inserted] = await tx
        .insert(demoRunFinalizations)
        .values({
          runId: report.runId,
          exitCode: report.exitCode ?? null,
          errorMessage: report.errorMessage ?? null,
          transportAttemptCounts: report.transportAttemptCounts,
          httpSummary: report.httpSummary,
          trafficOutcomeSummary: report.trafficOutcomeSummary,
          trafficDeliverySummary: classifiedTrafficDeliverySummary,
          httpTimingBreakdownSummary: report.httpTimingBreakdownSummary,
          loadRunDiagnosticsSummary: report.loadRunDiagnosticsSummary,
          completionEnrichmentStatus: "pending",
          trafficSummaryReceivedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ runId: demoRunFinalizations.runId });
      const [claimedRun] = await tx
        .update(demoRuns)
        .set({
          status: "draining",
          trafficStatus: report.status,
          trafficStartedAt:
            run.trafficStartedAt ?? new Date(report.loadRunDiagnosticsSummary.startedAt),
          trafficEndedAt: new Date(report.completedAt),
          updatedAt: now,
        })
        .where(
          and(
            eq(demoRuns.id, report.runId),
            inArray(demoRuns.status, ["starting", "active"]),
            inArray(demoRuns.trafficStatus, ["starting", "active"]),
          ),
        )
        .returning({ id: demoRuns.id });
      if (!inserted || !claimedRun) {
        throw new DemoRunValidationError(
          "traffic_report_rejected",
          "Demo run completion could not claim the active traffic lifecycle.",
          { runId: report.runId },
        );
      }
      return { inserted: true };
    });

    await this.options.completionEnrichmentService.completePendingEnrichment(report.runId);

    const updatedRun = await readDemoRunSnapshot(this.options.db, report.runId);
    if (completionClaim.inserted) {
      await publishDemoRunSnapshot(this.options.redis, this.options.logger, {
        run: updatedRun,
        correlationId: report.correlationId,
        occurredAt: now,
      });
    }
    return (
      (await this.options.finalizationService.finalizeRun(report.runId, report.correlationId)) ??
      updatedRun
    );
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function throwCompletionMismatch(
  runId: string,
  mismatch: { field: string; expected?: unknown; actual?: unknown },
): never {
  throw new DemoRunValidationError(
    "traffic_report_rejected",
    "Traffic completion does not match the accepted demo run.",
    {
      runId,
      field: mismatch.field,
      ...(Object.hasOwn(mismatch, "expected") ? { expected: mismatch.expected } : {}),
      ...(Object.hasOwn(mismatch, "actual") ? { actual: mismatch.actual } : {}),
    },
  );
}
