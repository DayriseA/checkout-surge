import {
  type AcceptedRunConfigSnapshot,
  materializedAcceptedRunConfigSnapshotSchema,
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

    const parsed = materializedAcceptedRunConfigSnapshotSchema.safeParse(row.configSnapshot);
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
    const detail = validationErrorDetail(cause);
    super(`Persisted configuration for demo run "${runId}" is invalid: ${detail}`, { cause });
    this.name = "PersistedRunConfigCorruptionError";
  }
}

function validationErrorDetail(cause: unknown): string {
  if (isValidationError(cause)) {
    return cause.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return `configSnapshot${path ? `.${path}` : ""}: ${issue.message}`;
      })
      .join("; ");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function isValidationError(
  value: unknown,
): value is Error & { issues: Array<{ path: PropertyKey[]; message: string }> } {
  if (!(value instanceof Error) || !("issues" in value) || !Array.isArray(value.issues)) {
    return false;
  }
  return value.issues.every(
    (issue) =>
      typeof issue === "object" &&
      issue !== null &&
      "path" in issue &&
      Array.isArray(issue.path) &&
      "message" in issue &&
      typeof issue.message === "string",
  );
}
