import { randomUUID } from "node:crypto";
import { automaticRunResetDeadlineSeconds } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoComparisons, demoRuns } from "@checkout-surge/db";
import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import type { AdminDemoResetService } from "./admin-demo-reset-service.js";
import { incompleteAdminResetPredicate } from "./incomplete-admin-reset.js";

export class AutomaticRunResetService {
  private pending: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      resetWorkflow: Pick<AdminDemoResetService, "reset" | "hasPendingAutomaticResetCleanup">;
      now?: () => Date;
    },
  ) {}

  check(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pending ??= this.checkDeadline().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pending;
  }

  private async checkDeadline(): Promise<void> {
    const now = this.options.now?.() ?? new Date();
    const [run] = await this.options.db
      .select({ id: demoRuns.id })
      .from(demoRuns)
      .where(
        or(
          and(
            inArray(demoRuns.status, ["starting", "active", "draining"]),
            lte(
              sql`coalesce(${demoRuns.comparisonAcceptedAt}, ${demoRuns.startedAt})`,
              new Date(now.getTime() - automaticRunResetDeadlineSeconds * 1000).toISOString(),
            ),
          ),
          and(incompleteAdminResetPredicate(), eq(demoRuns.failureReason, "auto_reset")),
        ),
      )
      .limit(1);
    const [overdueParent] = await this.options.db
      .select({ id: demoComparisons.id })
      .from(demoComparisons)
      .where(
        and(
          inArray(demoComparisons.state, ["running", "cleanup_pending"]),
          lte(
            demoComparisons.acceptedAt,
            new Date(now.getTime() - automaticRunResetDeadlineSeconds * 1000),
          ),
        ),
      )
      .limit(1);
    if (
      run ||
      overdueParent ||
      (await this.options.resetWorkflow.hasPendingAutomaticResetCleanup())
    ) {
      await this.options.resetWorkflow.reset(randomUUID(), "auto_reset");
    }
  }
}
