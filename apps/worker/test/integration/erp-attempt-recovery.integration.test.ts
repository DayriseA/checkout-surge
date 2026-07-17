import type { OrderProcessJob } from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  erpAttempts,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ErpAttemptContradictionError,
  PostgresErpAttemptPersistence,
} from "../../src/persistence/postgres-erp-attempt-persistence.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const requireDatabaseUrl = () => {
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required for integration tests.");
  return databaseUrl;
};
const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  offer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  order: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;
const job: OrderProcessJob = {
  orderId: ids.order,
  publicOrderId: "ord_erp_attempt_recovery",
  reservationId: ids.reservation,
  saleOfferId: ids.offer,
  correlationId: "corr-erp-attempt-recovery",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
};

run("PostgreSQL ERP attempt delivery identity", () => {
  const connection = databaseUrl ? createDatabaseConnection(databaseUrl, { max: 4 }) : null;
  const requireConnection = () => {
    if (!connection) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return connection;
  };
  const persistence = connection ? new PostgresErpAttemptPersistence(connection.db) : null;
  const requirePersistence = () => {
    if (!persistence) throw new Error("TEST_DATABASE_URL is required for integration tests.");
    return persistence;
  };

  beforeEach(async () => {
    await resetTestDatabase({
      databaseUrl: requireDatabaseUrl(),
      migrationsFolder: "../../packages/db/drizzle",
    });
    await requireConnection().db.insert(products).values({
      id: ids.product,
      sku: "ERP-ATTEMPT-TEST",
      slug: "erp-attempt-test",
      name: "ERP Attempt Test",
    });
    await requireConnection()
      .db.insert(saleOffers)
      .values({
        id: ids.offer,
        productId: ids.product,
        name: "ERP Attempt Offer",
        allocatedStock: 10,
        saleStartsAt: new Date("2026-01-01"),
        saleEndsAt: new Date("2030-01-01"),
      });
    await requireConnection()
      .db.insert(reservations)
      .values({
        id: ids.reservation,
        saleOfferId: ids.offer,
        correlationId: job.correlationId,
        quantity: 1,
        status: "secured",
        reservationToken: "erp-attempt-token",
        securedAt: new Date("2026-06-22T00:00:00Z"),
        expiresAt: new Date("2026-06-22T00:15:00Z"),
      });
    await requireConnection()
      .db.insert(orders)
      .values({
        id: ids.order,
        publicOrderId: job.publicOrderId,
        saleOfferId: ids.offer,
        reservationId: ids.reservation,
        correlationId: job.correlationId,
        quantity: 1,
        status: "queued",
        queuedAt: new Date("2026-06-22T00:00:00Z"),
      });
  });
  afterAll(() => requireConnection().close());

  it("keeps original failure and recovery success attempt one distinct, replay-safe", async () => {
    const startedAt = new Date("2026-06-22T00:00:01Z");
    await requirePersistence().recordAttempt({
      job,
      delivery: { attemptNumber: 1, attemptsMade: 0, deliveryId: "original-job" },
      status: "failed",
      terminal: false,
      httpStatus: 503,
      errorCode: "ERP_UNAVAILABLE",
      errorMessage: "offline",
      latencyMs: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1),
    });
    const response = {
      status: "succeeded" as const,
      confirmationId: "recovery-confirmation",
      httpStatus: 200 as const,
      latencyMs: 1,
      timestamp: "2026-06-22T00:00:02.000Z",
    };
    const recovery = {
      job,
      delivery: {
        attemptNumber: 1,
        attemptsMade: 0,
        deliveryId: "recovery-dddddddd-dddd-4ddd-8ddd-dddddddddddd-1",
      },
      status: "succeeded" as const,
      terminal: true,
      httpStatus: 200,
      latencyMs: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 2),
      response,
    };
    await requirePersistence().recordAttempt(recovery);
    await requirePersistence().recordAttempt(recovery);
    await requirePersistence().recordAttempt({
      ...recovery,
      delivery: {
        ...recovery.delivery,
        deliveryId: "recovery-dddddddd-dddd-4ddd-8ddd-dddddddddddd-2",
      },
    });
    const attempts = await requireConnection()
      .db.select()
      .from(erpAttempts)
      .where(eq(erpAttempts.orderId, ids.order));
    const events = await requireConnection()
      .db.select()
      .from(orderEvents)
      .where(eq(orderEvents.orderId, ids.order));
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((attempt) => attempt.deliveryId))).toEqual(
      new Set(["original-job", "recovery-dddddddd-dddd-4ddd-8ddd-dddddddddddd-1"]),
    );
    expect(events).toHaveLength(2);
  });

  it("rejects a contradictory replay for one delivery identity", async () => {
    const startedAt = new Date("2026-06-22T00:00:01Z");
    const base = {
      job,
      delivery: { attemptNumber: 1, attemptsMade: 0, deliveryId: "recovery-contradiction" },
      status: "succeeded" as const,
      terminal: true,
      httpStatus: 200,
      latencyMs: 1,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 1),
      response: {
        status: "succeeded" as const,
        confirmationId: "one",
        httpStatus: 200 as const,
        latencyMs: 1,
        timestamp: "2026-06-22T00:00:02.000Z",
      },
    };
    await requirePersistence().recordAttempt(base);
    await expect(
      requirePersistence().recordAttempt({ ...base, httpStatus: 201 }),
    ).rejects.toBeInstanceOf(ErpAttemptContradictionError);
  });
});
