import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  demoPresets,
  demoRunSaleContexts,
  demoRuns,
  products,
  saleOffers,
  terminalDemoRunTransitionLockKey,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresGeneratedRunPublicationFence } from "../../src/persistence/postgres-generated-run-publication-fence.js";
import {
  type PersistedRunConfigCorruptionError,
  PostgresRunConfigReader,
} from "../../src/persistence/postgres-run-config-reader.js";
import { createOrderProcessJobPublisher } from "../../src/queue/bullmq-order-process-job-publisher.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const databaseUrl = process.env.TEST_DATABASE_URL;
const presetId = "57575757-1000-4000-8000-000000000001";
const runId = "57575757-1000-4000-8000-000000000002";
const productId = "57575757-1000-4000-8000-000000000003";
const saleOfferId = "57575757-1000-4000-8000-000000000004";

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

  it("retains its configuration-reader semantics after a generated run becomes terminal", async () => {
    await connection.db
      .update(demoRuns)
      .set({ status: "failed", trafficStatus: "failed", failureReason: "admin_reset" })
      .where(sql`${demoRuns.id} = ${runId}`);

    await expect(new PostgresRunConfigReader(connection.db).read(runId)).resolves.toEqual(
      configSnapshotFixture(),
    );
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

  it("refuses publication when the job sale identity does not match the generated run", async () => {
    const add = vi.fn();
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn() },
      undefined,
      new PostgresGeneratedRunPublicationFence(connection.db),
    );

    await expect(
      publisher.enqueue({
        ...runOrderJob(),
        saleOfferId: "57575757-1000-4000-8000-000000000099",
      }),
    ).rejects.toMatchObject({
      code: "generated_run_publication_rejected",
      runId,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("validates the immutable run configuration inside the publication fence", async () => {
    const snapshot = configSnapshotFixture();
    await connection.db.execute(
      sql`UPDATE ${demoRuns}
          SET config_snapshot = ${JSON.stringify({
            ...snapshot,
            inventoryConfig: { ...snapshot.inventoryConfig, quantityPerCheckout: 0 },
          })}::jsonb
          WHERE ${demoRuns.id} = ${runId}`,
    );
    const add = vi.fn();
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn() },
      undefined,
      new PostgresGeneratedRunPublicationFence(connection.db),
    );

    await expect(publisher.enqueue(runOrderJob())).rejects.toMatchObject({
      code: "persisted_run_config_invalid",
      runId,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("holds the shared publication lock through queue add before terminal cleanup can proceed", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");
    const terminalConnection = createDatabaseConnection(databaseUrl, { max: 1 });
    const events: string[] = [];
    let enterAdd: () => void = () => undefined;
    let releaseAdd: () => void = () => undefined;
    const addEntered = new Promise<void>((resolve) => {
      enterAdd = resolve;
    });
    const addReleased = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const add = vi.fn(async () => {
      events.push("add-entered");
      enterAdd();
      await addReleased;
      events.push("add-complete");
    });
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn() },
      undefined,
      new PostgresGeneratedRunPublicationFence(connection.db),
    );

    try {
      const publication = publisher.enqueue(runOrderJob());
      await addEntered;
      const terminalTransition = terminalConnection.db
        .transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`,
          );
          events.push("terminal-lock");
          await tx
            .update(demoRuns)
            .set({ status: "failed", trafficStatus: "failed", failureReason: "admin_reset" })
            .where(sql`${demoRuns.id} = ${runId}`);
        })
        .then(() => events.push("terminal-commit"));

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(["add-entered"]);
      releaseAdd();
      await publication;
      await terminalTransition;
      events.push("exact-cleanup");
      expect(events).toEqual([
        "add-entered",
        "add-complete",
        "terminal-lock",
        "terminal-commit",
        "exact-cleanup",
      ]);
    } finally {
      releaseAdd();
      await terminalConnection.close();
    }
  });

  it("refuses queue add when a concurrent terminal transition wins the publication lock", async () => {
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");
    const terminalConnection = createDatabaseConnection(databaseUrl, { max: 1 });
    let reportTerminalLocked: () => void = () => undefined;
    let releaseTerminal: () => void = () => undefined;
    const terminalLocked = new Promise<void>((resolve) => {
      reportTerminalLocked = resolve;
    });
    const terminalReleased = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const add = vi.fn();
    const publisher = createOrderProcessJobPublisher(
      { add, close: vi.fn() },
      undefined,
      new PostgresGeneratedRunPublicationFence(connection.db),
    );

    const terminalTransition = terminalConnection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(runId)}))`,
      );
      await tx
        .update(demoRuns)
        .set({ status: "completed", trafficStatus: "succeeded" })
        .where(sql`${demoRuns.id} = ${runId}`);
      reportTerminalLocked();
      await terminalReleased;
    });

    try {
      await terminalLocked;
      const refusedPublication = expect(publisher.enqueue(runOrderJob())).rejects.toMatchObject({
        code: "generated_run_publication_rejected",
        runId,
        saleOfferId,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(add).not.toHaveBeenCalled();

      releaseTerminal();
      await terminalTransition;
      await refusedPublication;
      expect(add).not.toHaveBeenCalled();
    } finally {
      releaseTerminal();
      await terminalTransition.catch(() => undefined);
      await terminalConnection.close();
    }
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
  await connection.db.insert(products).values({
    id: productId,
    sku: "worker-config-reader",
    slug: "worker-config-reader",
    name: "Worker config reader",
  });
  await connection.db.insert(saleOffers).values({
    id: saleOfferId,
    productId,
    name: "Worker config reader generated offer",
    allocatedStock: 10,
    saleStartsAt: new Date("2026-06-21T00:00:00.000Z"),
    saleEndsAt: new Date("2026-06-21T01:00:00.000Z"),
    purpose: "generated_run",
  });
  await connection.db.insert(demoRuns).values({
    id: runId,
    presetId,
    presetName: "Worker config reader",
    operatorMode: "admin",
    saleOfferId,
    configSnapshot,
  });
  await connection.db.insert(demoRunSaleContexts).values({
    runId,
    saleOfferId,
  });
}

function runOrderJob() {
  return {
    orderId: "57575757-1000-4000-8000-000000000005",
    publicOrderId: "ord-publication-fence",
    reservationId: "57575757-1000-4000-8000-000000000006",
    saleOfferId,
    correlationId: "corr-publication-fence",
    runId,
    quantity: 1,
    queuedAt: "2026-06-21T00:00:01.000Z",
    processingGeneration: 0,
  };
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
