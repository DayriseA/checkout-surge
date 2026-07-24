import {
  createDatabaseConnection,
  erpAttempts,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresErpAttemptStatusReader } from "../src/services/erp-status-service.js";

const ids = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservation: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  order: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
} as const;

describe("PostgresErpAttemptStatusReader", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase();
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedOrder(connection);
  });

  afterEach(async () => {
    await connection?.close();
    connection = null;
  });

  it("uses exact aggregate counts for recent ERP attempts beyond the read-model sample size", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    const firstAttemptStartedAt = new Date("2026-06-22T00:00:00.000Z");
    await connection.db.insert(erpAttempts).values(
      Array.from({ length: 125 }, (_, index) => {
        const attemptNumber = index + 1;
        const status: "succeeded" | "failed" | "timed_out" =
          attemptNumber % 5 === 0 ? "timed_out" : attemptNumber % 2 === 0 ? "failed" : "succeeded";
        const startedAt = new Date(firstAttemptStartedAt.getTime() + attemptNumber * 1000);
        const finishedAt = new Date(startedAt.getTime() + 25);

        return {
          orderId: ids.order,
          deliveryId: `status-reader-delivery-${attemptNumber}`,
          correlationId: "corr-erp-status-reader",
          attemptNumber,
          status,
          terminal: status === "succeeded",
          httpStatus: status === "succeeded" ? 200 : 503,
          latencyMs: 25,
          startedAt,
          finishedAt,
        };
      }),
    );

    const readModel = await new PostgresErpAttemptStatusReader(connection.db).readStatus(
      new Date("2026-06-22T00:03:00.000Z"),
      300,
    );

    expect(readModel.recentAttemptCount).toBe(125);
    expect(readModel.recentFailureCount).toBe(50);
    expect(readModel.recentTimeoutCount).toBe(25);
    expect(readModel.latestAttempt).toMatchObject({
      orderId: ids.order,
      attemptNumber: 125,
      status: "timed_out",
    });
  });
});

async function seedOrder(connection: ReturnType<typeof createDatabaseConnection>): Promise<void> {
  await connection.db.insert(products).values({
    id: ids.product,
    sku: "ERP-STATUS-READER-SKU",
    slug: "erp-status-reader-product",
    name: "ERP Status Reader Product",
    isActive: true,
  });
  await connection.db.insert(saleOffers).values({
    id: ids.saleOffer,
    productId: ids.product,
    name: "ERP Status Reader Sale Offer",
    allocatedStock: 125,
    saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
    saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
    isActive: true,
    purpose: "catalog",
  });
  await connection.db.insert(reservations).values({
    id: ids.reservation,
    saleOfferId: ids.saleOffer,
    correlationId: "corr-erp-status-reader",
    quantity: 1,
    reservationToken: "erp-status-reader-token",
    expiresAt: new Date("2026-06-22T00:15:00.000Z"),
    securedAt: new Date("2026-06-22T00:00:00.000Z"),
  });
  await connection.db.insert(orders).values({
    id: ids.order,
    publicOrderId: "ord_erp_status_reader",
    saleOfferId: ids.saleOffer,
    reservationId: ids.reservation,
    correlationId: "corr-erp-status-reader",
    quantity: 1,
    status: "queued",
    queuedAt: new Date("2026-06-22T00:00:00.000Z"),
  });
}
