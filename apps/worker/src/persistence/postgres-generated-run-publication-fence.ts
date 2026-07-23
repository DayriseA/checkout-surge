import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import {
  type CheckoutSurgeDatabase,
  createDatabase,
  demoRunSaleContexts,
  demoRuns,
  type SqlClient,
  saleOffers,
  terminalDemoRunTransitionLockKey,
} from "@checkout-surge/db";
import { and, eq, inArray } from "drizzle-orm";
import type { GeneratedRunPublicationFence } from "../application/generated-run-publication-fence.js";
import { parsePersistedRunConfig } from "./postgres-run-config-reader.js";

type DatabaseWithClient = CheckoutSurgeDatabase & { $client: SqlClient };

export class PostgresGeneratedRunPublicationFence implements GeneratedRunPublicationFence {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async publish<T>(input: {
    runId: string;
    saleOfferId: string;
    operation: (snapshot: AcceptedRunConfigSnapshot) => Promise<T>;
  }): Promise<T> {
    const client = (this.db as DatabaseWithClient).$client;
    const reservedClient = await client.reserve();
    Object.defineProperty(reservedClient, "options", { value: client.options });
    const reservedDb = createDatabase(reservedClient as unknown as SqlClient);
    const lockKey = terminalDemoRunTransitionLockKey(input.runId);
    let locked = false;

    try {
      await reservedClient`select pg_advisory_lock_shared(hashtext(${lockKey}))`;
      locked = true;
      const [row] = await reservedDb
        .select({ configSnapshot: demoRuns.configSnapshot })
        .from(demoRuns)
        .innerJoin(
          demoRunSaleContexts,
          and(
            eq(demoRunSaleContexts.runId, demoRuns.id),
            eq(demoRunSaleContexts.saleOfferId, demoRuns.saleOfferId),
          ),
        )
        .innerJoin(
          saleOffers,
          and(
            eq(saleOffers.id, demoRunSaleContexts.saleOfferId),
            eq(saleOffers.purpose, "generated_run"),
          ),
        )
        .where(
          and(
            eq(demoRuns.id, input.runId),
            eq(demoRuns.saleOfferId, input.saleOfferId),
            eq(demoRunSaleContexts.saleOfferId, input.saleOfferId),
            inArray(demoRuns.status, ["starting", "active", "draining"]),
          ),
        )
        .limit(1);

      if (!row) {
        throw new GeneratedRunPublicationRejectedError(input.runId, input.saleOfferId);
      }

      return await input.operation(parsePersistedRunConfig(input.runId, row.configSnapshot));
    } finally {
      try {
        if (locked) {
          await reservedClient`select pg_advisory_unlock_shared(hashtext(${lockKey}))`;
        }
      } finally {
        reservedClient.release();
      }
    }
  }
}

export class GeneratedRunPublicationRejectedError extends Error {
  readonly code = "generated_run_publication_rejected";

  constructor(
    readonly runId: string,
    readonly saleOfferId: string,
  ) {
    super(`Demo run "${runId}" is terminal, missing, or does not own sale offer "${saleOfferId}".`);
    this.name = "GeneratedRunPublicationRejectedError";
  }
}
