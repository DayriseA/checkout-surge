import type { DemoRunSnapshot } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  type CheckoutSurgeRedis,
  demoRuns,
  publishDashboardProjectionDirtySignal,
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

export async function publishDemoRunProjectionDirty(
  redis: CheckoutSurgeRedis,
  logger: CheckoutSurgeLogger,
  input: { run: DemoRunSnapshot; correlationId: string },
): Promise<void> {
  try {
    await publishDashboardProjectionDirtySignal(redis, {
      type: "dashboard.projection.dirty",
      correlationId: input.correlationId,
      ...(input.run.saleOfferId
        ? {
            scope: {
              runId: input.run.runId,
              saleOfferId: input.run.saleOfferId,
            },
          }
        : {}),
    });
  } catch (error) {
    logger.warn(
      { err: error, runId: input.run.runId },
      "Could not publish run projection dirty signal.",
    );
  }
}
