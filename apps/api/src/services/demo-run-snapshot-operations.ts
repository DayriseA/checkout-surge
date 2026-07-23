import type { DemoRunSnapshot } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRuns,
  publishDashboardEvent,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { toDemoRunSnapshot } from "./demo-run-projections.js";
import { DemoRunValidationError } from "./demo-run-validation-error.js";

export async function readDemoRunSnapshot(
  db: CheckoutSurgeDatabase,
  runId: string,
): Promise<DemoRunSnapshot> {
  const [run] = await db.select().from(demoRuns).where(eq(demoRuns.id, runId)).limit(1);
  if (!run) {
    throw new DemoRunValidationError("resource_not_found", "Demo run was not found.", { runId });
  }
  return toDemoRunSnapshot(run);
}

export async function publishDemoRunSnapshot(
  redis: CheckoutSurgeRedis,
  logger: CheckoutSurgeLogger,
  input: { run: DemoRunSnapshot; correlationId: string; occurredAt: Date },
): Promise<void> {
  try {
    await publishDashboardEvent(redis, {
      type: "load.run.updated",
      runId: input.run.runId,
      correlationId: input.correlationId,
      run: input.run,
      occurredAt: input.occurredAt.toISOString(),
    });
  } catch (error) {
    logger.warn({ err: error, runId: input.run.runId }, "Could not publish run dashboard event.");
  }
}
