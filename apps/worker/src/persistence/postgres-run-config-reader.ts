import {
  type AcceptedRunConfigSnapshot,
  acceptedRunConfigSnapshotSchema,
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

    if (!row) {
      return null;
    }

    const parsed = acceptedRunConfigSnapshotSchema.safeParse(row.configSnapshot);
    if (!parsed.success) {
      throw new PersistedRunConfigCorruptionError(runId, parsed.error);
    }

    return parsed.data;
  }
}

export class PersistedRunConfigCorruptionError extends Error {
  readonly code = "persisted_run_config_invalid";

  constructor(
    readonly runId: string,
    cause: unknown,
  ) {
    super(`Persisted configuration for demo run "${runId}" is invalid.`, { cause });
    this.name = "PersistedRunConfigCorruptionError";
  }
}
