import { type CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";
import { eq } from "drizzle-orm";

import { parsePersistedAcceptedRunConfigSnapshot } from "../services/persisted-demo-run-state.js";
import type { RunRetryPolicyResolver } from "../services/run-retry-policy-resolver.js";

export class PostgresRunRetryPolicyResolver implements RunRetryPolicyResolver {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async resolve(runId: string) {
    const [row] = await this.db
      .select({ configSnapshot: demoRuns.configSnapshot })
      .from(demoRuns)
      .where(eq(demoRuns.id, runId))
      .limit(1);
    if (!row) return null;
    return parsePersistedAcceptedRunConfigSnapshot(
      row.configSnapshot,
      `demo run ${runId} retry policy`,
    ).backpressureConfig.retryPolicy;
  }
}
