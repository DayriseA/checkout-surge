import { randomUUID } from "node:crypto";
import { automaticRunResetDeadlineSeconds } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import { and, eq, inArray, lte, or } from "drizzle-orm";
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
              demoRuns.startedAt,
              new Date(now.getTime() - automaticRunResetDeadlineSeconds * 1000),
            ),
          ),
          and(incompleteAdminResetPredicate(), eq(demoRuns.failureReason, "auto_reset")),
        ),
      )
      .limit(1);
    if (run || (await this.options.resetWorkflow.hasPendingAutomaticResetCleanup())) {
      await this.options.resetWorkflow.reset(randomUUID(), "auto_reset");
    }
  }
}
