import {
  automaticRunResetDeadlineSeconds,
  type ComparisonDetailResponse,
  type ComparisonStage,
  comparisonDetailResponseSchema,
  comparisonStageRoles,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoComparisons, demoRuns } from "@checkout-surge/db";
import { eq, inArray } from "drizzle-orm";
import { toDemoRunSnapshot } from "./demo-run-projections.js";
import type { RunHistoryController } from "./run-history-service.js";

export interface ComparisonReader {
  detail(comparisonId: string, signal: AbortSignal): Promise<ComparisonDetailResponse | null>;
}

export class ComparisonReadService implements ComparisonReader {
  constructor(
    private readonly options: {
      open: (signal: AbortSignal) => {
        db: CheckoutSurgeDatabase;
        history: Pick<RunHistoryController, "detail">;
        close(): Promise<void>;
      };
      now?: () => Date;
    },
  ) {}

  async detail(
    comparisonId: string,
    signal: AbortSignal,
  ): Promise<ComparisonDetailResponse | null> {
    const operation = this.options.open(signal);
    try {
      const [parent] = await operation.db
        .select()
        .from(demoComparisons)
        .where(eq(demoComparisons.id, comparisonId))
        .limit(1);
      if (!parent) return null;
      const rows = await operation.db
        .select()
        .from(demoRuns)
        .where(
          inArray(
            demoRuns.id,
            parent.children.map((child) => child.runId),
          ),
        );
      const stages: ComparisonStage[] = [];
      for (const [index, child] of parent.children.entries()) {
        signal.throwIfAborted();
        const role = comparisonStageRoles[index];
        if (!role) throw new Error("Comparison has an invalid stage.");
        const base = { role, runId: child.runId, executionMode: child.executionMode };
        const row = rows.find((run) => run.id === child.runId && run.comparisonId === parent.id);
        if (!row) {
          stages.push({
            ...base,
            availability: index > parent.currentStage ? "not_run" : "unavailable",
          });
        } else if (row.status === "completed" || row.status === "failed") {
          const detail = await operation.history.detail(child.runId);
          stages.push(
            detail
              ? { ...base, availability: "available", detail }
              : { ...base, availability: "unavailable" },
          );
        } else {
          stages.push({ ...base, availability: "pending", run: toDemoRunSnapshot(row) });
        }
      }
      const current = parent.children[parent.currentStage];
      if (!current) throw new Error("Comparison has no current stage.");
      return comparisonDetailResponseSchema.parse({
        comparisonId: parent.id,
        acceptedAt: parent.acceptedAt.toISOString(),
        autoResetAt: new Date(
          parent.acceptedAt.getTime() + automaticRunResetDeadlineSeconds * 1000,
        ).toISOString(),
        state: parent.state,
        currentStage: parent.currentStage,
        currentRunId: current.runId,
        terminalReason: parent.terminalReason,
        currentFailureReason: rows.find((row) => row.id === current.runId)?.failureReason ?? null,
        terminalAt: parent.terminalAt?.toISOString() ?? null,
        stages,
        timestamp: (this.options.now?.() ?? new Date()).toISOString(),
      });
    } finally {
      await operation.close();
    }
  }
}
