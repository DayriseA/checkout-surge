import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import { createDatabaseConnection, demoPresets, demoRuns } from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  type PersistedRunConfigCorruptionError,
  PostgresRunConfigReader,
} from "../../src/persistence/postgres-run-config-reader.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;
const presetId = "57575757-1000-4000-8000-000000000001";
const runId = "57575757-1000-4000-8000-000000000002";

describe.skipIf(!databaseUrl)("PostgresRunConfigReader", () => {
  let connection: ReturnType<typeof createDatabaseConnection>;

  beforeEach(async () => {
    if (!databaseUrl) {
      throw new Error("TEST_DATABASE_URL is required for run-config reader integration tests.");
    }

    await connection?.close();
    await resetTestDatabase({ databaseUrl, migrationsFolder });
    connection = createDatabaseConnection(databaseUrl, { max: 1 });
    await seedRun(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("reads a valid contract-shaped persisted snapshot", async () => {
    await expect(new PostgresRunConfigReader(connection.db).read(runId)).resolves.toEqual(
      configSnapshotFixture(),
    );
  });

  it("rejects malformed legacy JSON with an identifiable corruption error", async () => {
    await connection.db.execute(
      sql`UPDATE ${demoRuns}
          SET config_snapshot = ${JSON.stringify({ trafficConfig: { mode: "legacy" } })}::jsonb
          WHERE ${demoRuns.id} = ${runId}`,
    );

    await expect(new PostgresRunConfigReader(connection.db).read(runId)).rejects.toMatchObject({
      name: "PersistedRunConfigCorruptionError",
      code: "persisted_run_config_invalid",
      runId,
      message: expect.stringMatching(new RegExp(`${runId}.*configSnapshot\\.trafficConfig`)),
      cause: expect.any(Error),
    } satisfies Partial<PersistedRunConfigCorruptionError>);
  });

  it("rejects a stored snapshot that relies on a wire default", async () => {
    const snapshot = configSnapshotFixture();
    const { quantityPerCheckout: _defaulted, ...incompleteInventoryConfig } =
      snapshot.inventoryConfig;
    await connection.db.execute(
      sql`UPDATE ${demoRuns}
          SET config_snapshot = ${JSON.stringify({
            ...snapshot,
            inventoryConfig: incompleteInventoryConfig,
          })}::jsonb
          WHERE ${demoRuns.id} = ${runId}`,
    );

    await expect(new PostgresRunConfigReader(connection.db).read(runId)).rejects.toMatchObject({
      name: "PersistedRunConfigCorruptionError",
      code: "persisted_run_config_invalid",
      runId,
      message: expect.stringMatching(
        new RegExp(`${runId}.*configSnapshot\\.inventoryConfig\\.quantityPerCheckout`),
      ),
      cause: expect.any(Error),
    } satisfies Partial<PersistedRunConfigCorruptionError>);
  });
});

async function seedRun(connection: ReturnType<typeof createDatabaseConnection>): Promise<void> {
  const configSnapshot = configSnapshotFixture();
  await connection.db.insert(demoPresets).values({
    id: presetId,
    slug: "worker-config-reader",
    visibility: "admin",
    isEditable: true,
    display: {
      name: "Worker config reader",
      description: "Run configuration persistence fixture.",
      sortOrder: 57,
      outcomeFocus: ["worker"],
    },
    ...configSnapshot,
  });
  await connection.db.insert(demoRuns).values({
    id: runId,
    presetId,
    presetName: "Worker config reader",
    operatorMode: "admin",
    configSnapshot,
  });
}

function configSnapshotFixture(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 10,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 10,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 25,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2_000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}
