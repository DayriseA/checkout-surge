import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import { and, eq } from "drizzle-orm";
import type { GeneratedRunSaleGate } from "./reserve-order-service.js";

const saleAcceptingRunStatuses = new Set(["starting", "active"]);

export class PostgresGeneratedRunSaleGate implements GeneratedRunSaleGate {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async isAccepting(input: { runId: string; saleOfferId: string }): Promise<boolean> {
    const [run] = await this.db
      .select({ status: demoRuns.status })
      .from(demoRuns)
      .where(and(eq(demoRuns.id, input.runId), eq(demoRuns.saleOfferId, input.saleOfferId)))
      .limit(1);

    return Boolean(run && saleAcceptingRunStatuses.has(run.status));
  }
}
