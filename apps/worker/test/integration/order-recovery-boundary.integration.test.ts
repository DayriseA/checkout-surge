import type { OrderProcessJob } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  orderDeadLetters,
  orderRecoveryJobs,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
  offer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccccd",
  order: "dddddddd-dddd-4ddd-8ddd-ddddddddddde",
} as const;
const job: OrderProcessJob = {
  orderId: ids.order,
  publicOrderId: "ord_recovery_boundary",
  reservationId: ids.reservation,
  saleOfferId: ids.offer,
  correlationId: "corr-recovery-boundary",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
  processingGeneration: 0,
};

run("PostgreSQL durable order recovery boundary", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 4 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  let now = new Date("2026-06-22T00:00:00.000Z");
  const persistence = connection
    ? new PostgresOrderRecoveryPersistence(connection.db, () => now)
    : null;
  const requirePersistence = () => {
    if (!persistence) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return persistence;
  };

  beforeEach(async () => {
    await resetTestDatabase({
      databaseUrl: databaseUrl ?? "",
      migrationsFolder: "../../packages/db/drizzle",
    });
    const db = requireConnection().db;
    await db.insert(products).values({
      id: ids.product,
      sku: "RECOVERY-BOUNDARY",
      slug: "recovery-boundary",
      name: "Recovery Boundary",
    });
    await db.insert(saleOffers).values({
      id: ids.offer,
      productId: ids.product,
      name: "Recovery Boundary Offer",
      allocatedStock: 10,
      saleStartsAt: new Date("2026-01-01"),
      saleEndsAt: new Date("2030-01-01"),
    });
    await db.insert(reservations).values({
      id: ids.reservation,
      saleOfferId: ids.offer,
      correlationId: job.correlationId,
      quantity: 1,
      reservationToken: "recovery-boundary-token",
      securedAt: now,
      expiresAt: new Date("2026-06-22T00:15:00.000Z"),
    });
    await db.insert(orders).values({
      id: ids.order,
      publicOrderId: job.publicOrderId,
      saleOfferId: ids.offer,
      reservationId: ids.reservation,
      correlationId: job.correlationId,
      quantity: 1,
      status: "processing",
      queuedAt: now,
      processingAt: now,
    });
  });
  afterAll(() => connection?.close());

  it("claims one lease at a time and resolves after a restart-safe replay", async () => {
    await requirePersistence().recordRecoverable({
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 1,
        deliveryId: "source-job",
      },
      sourceJobId: "source-job",
      sourceDisposition: "source-job:1",
      reason: "erp_local_persistence_unavailable",
      error: new Error("database unavailable"),
    });
    await expect(requirePersistence().findRecoverable({ limit: 10, now })).resolves.toHaveLength(1);
    await expect(
      requirePersistence().claimForPublication({
        recoveryKey: `order:${ids.order}`,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ attempt: 1, processingGeneration: 1 });
    now = new Date("2026-06-22T00:00:31.000Z");
    await requirePersistence().recordRecoverable({
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        maxAttempts: 1,
        deliveryId: "retained-source",
      },
      sourceJobId: "retained-source",
      sourceDisposition: "retained-source:1",
      reason: "failed_queue_job_reconciliation",
      error: new Error("retained source replay"),
    });
    await expect(
      requirePersistence().claimForPublication({
        recoveryKey: `order:${ids.order}`,
        now,
        leaseMs: 30_000,
      }),
    ).resolves.toMatchObject({ attempt: 2, processingGeneration: 2 });
    await requirePersistence().markResolved({ recoveryKey: `order:${ids.order}` });
    await expect(requirePersistence().findRecoverable({ limit: 10, now })).resolves.toHaveLength(0);
    const [row] = await requireConnection()
      .db.select()
      .from(orderRecoveryJobs)
      .where(eq(orderRecoveryJobs.recoveryKey, `order:${ids.order}`));
    expect(row).toMatchObject({ status: "resolved", attempts: 2 });
  });

  it("deduplicates poison DLQ records by queue/job/name", async () => {
    const input = {
      jobId: "poison-boundary-job",
      jobName: "wrong-name",
      queueName: "orders:process",
      payload: { invalid: true },
      reason: "invalid_job_payload",
      attemptsMade: 2,
      observedAt: now,
    };
    await requirePersistence().recordDeadLetter(input);
    await requirePersistence().recordDeadLetter(input);
    const rows = await requireConnection()
      .db.select()
      .from(orderDeadLetters)
      .where(eq(orderDeadLetters.jobId, input.jobId));
    expect(rows).toHaveLength(1);
  });
});
