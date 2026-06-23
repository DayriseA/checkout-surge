import {
  acceptedRunConfigSnapshotSchema,
  type AcceptedRunConfigSnapshot,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import { eq } from "drizzle-orm";
import type { RunConfigReader } from "../application/run-config.js";

export class PostgresRunConfigReader implements RunConfigReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async read(runId: string): Promise<AcceptedRunConfigSnapshot | null> {
    const [row] = await this.db
      .select({ configSnapshot: demoRuns.configSnapshot })
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);

    return row ? acceptedRunConfigSnapshotSchema.parse(row.configSnapshot) : null;
  }
}
