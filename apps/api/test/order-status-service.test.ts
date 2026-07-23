import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDatabaseConnection,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrderStatusService } from "../src/services/order-status-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFolder = path.resolve(packageRoot, "../../packages/db/drizzle");
const ids = {
  product: "11111111-1111-4111-8111-111111111111",
  saleOffer: "22222222-2222-4222-8222-222222222222",
  reservation: "33333333-3333-4333-8333-333333333333",
  order: "44444444-4444-4444-8444-444444444444",
} as const;
const queuedAt = new Date("2026-07-15T10:00:00.000Z");
const processingAt = new Date("2026-07-15T10:01:00.000Z");
const confirmedAt = new Date("2026-07-15T10:02:00.000Z");
const failedAt = new Date("2026-07-15T10:03:00.000Z");
type DurableOrderStatus = "queued" | "processing" | "confirmed" | "failed";

function requireTestDatabaseUrl(): string {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required for order-status service tests.");
  }

  return process.env.TEST_DATABASE_URL;
}

describe("OrderStatusService", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await connection.db.insert(products).values({
      id: ids.product,
      sku: "ORDER-STATUS-SKU",
      slug: "order-status-product",
      name: "Order Status Product",
    });
    await connection.db.insert(saleOffers).values({
      id: ids.saleOffer,
      productId: ids.product,
      name: "Order Status Offer",
      allocatedStock: 1,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await connection?.close();
    connection = null;
  });

  it("returns null when the public order ID is missing", async () => {
    const service = new OrderStatusService(requireConnection().db);

    await expect(
      service.getStatus({ publicOrderId: "ord_missing", correlationId: "lookup-correlation" }),
    ).resolves.toBeNull();
  });

  it("maps a queued order and deterministically orders equal-timestamp initial events", async () => {
    await seedOrder("queued");
    const service = new OrderStatusService(requireConnection().db);

    const status = await service.getStatus({
      publicOrderId: "ord_service_test",
      correlationId: "current-lookup-correlation",
    });

    expect(status).toMatchObject({
      correlationId: "current-lookup-correlation",
      publicOrderId: "ord_service_test",
      saleOfferId: ids.saleOffer,
      reservation: {
        id: ids.reservation,
        expiresAt: "2026-07-15T10:15:00.000Z",
      },
      order: {
        status: "queued",
        queuedAt: queuedAt.toISOString(),
        processingAt: null,
        confirmedAt: null,
        failedAt: null,
        failureCode: null,
        failureMessage: null,
      },
      consistencyLagMs: null,
    });
    expect(status?.timeline).toEqual([
      {
        eventName: "reservation.secured",
        label: "Reservation secured",
        occurredAt: queuedAt.toISOString(),
      },
      {
        eventName: "order.queued",
        label: "Order queued",
        occurredAt: queuedAt.toISOString(),
      },
    ]);
  });

  it.each([
    {
      durableStatus: "processing" as const,
      terminalEventName: null,
      consistencyLagMs: null,
    },
    {
      durableStatus: "failed" as const,
      terminalEventName: "order.failed" as const,
      consistencyLagMs: null,
    },
  ])("maps a coherent $durableStatus lifecycle and later-event raw labels", async ({
    durableStatus,
    terminalEventName,
    consistencyLagMs,
  }) => {
    await seedOrder(durableStatus);
    const service = new OrderStatusService(requireConnection().db);
    const status = await service.getStatus({
      publicOrderId: "ord_service_test",
      correlationId: `${durableStatus}-lookup`,
    });

    expect(status).toMatchObject({
      correlationId: `${durableStatus}-lookup`,
      consistencyLagMs,
      order: {
        status: durableStatus,
        processingAt: processingAt.toISOString(),
        confirmedAt: null,
        failedAt: durableStatus === "failed" ? failedAt.toISOString() : null,
        failureCode: durableStatus === "failed" ? "erp_rejected" : null,
        failureMessage: durableStatus === "failed" ? "ERP rejected the order" : null,
      },
    });
    expect(status?.timeline).toEqual([
      {
        eventName: "reservation.secured",
        label: "Reservation secured",
        occurredAt: queuedAt.toISOString(),
      },
      {
        eventName: "order.queued",
        label: "Order queued",
        occurredAt: queuedAt.toISOString(),
      },
      {
        eventName: "order.processing",
        label: "order.processing",
        occurredAt: processingAt.toISOString(),
      },
      ...(terminalEventName
        ? [
            {
              eventName: terminalEventName,
              label: terminalEventName,
              occurredAt: failedAt.toISOString(),
            },
          ]
        : []),
    ]);
  });

  it("keeps durable confirmed status and consistency lag queryable without realtime fan-out", async () => {
    await seedOrder("confirmed");
    const service = new OrderStatusService(requireConnection().db);

    await expect(
      service.getStatus({
        publicOrderId: "ord_service_test",
        correlationId: "durable-diagnostic-lookup",
      }),
    ).resolves.toMatchObject({
      correlationId: "durable-diagnostic-lookup",
      consistencyLagMs: 120_000,
      order: {
        status: "confirmed",
        processingAt: processingAt.toISOString(),
        confirmedAt: confirmedAt.toISOString(),
        failedAt: null,
      },
      timeline: [
        {
          eventName: "reservation.secured",
          occurredAt: queuedAt.toISOString(),
        },
        {
          eventName: "order.queued",
          occurredAt: queuedAt.toISOString(),
        },
        {
          eventName: "order.processing",
          occurredAt: processingAt.toISOString(),
        },
        {
          eventName: "order.confirmed",
          occurredAt: confirmedAt.toISOString(),
        },
      ],
    });
  });

  function requireConnection(): NonNullable<typeof connection> {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    return connection;
  }

  async function seedOrder(status: DurableOrderStatus): Promise<void> {
    const db = requireConnection().db;
    await db.insert(reservations).values({
      id: ids.reservation,
      saleOfferId: ids.saleOffer,
      correlationId: "persisted-reservation-correlation",
      quantity: 1,
      reservationToken: "order-status-token",
      securedAt: queuedAt,
      expiresAt: new Date("2026-07-15T10:15:00.000Z"),
    });
    await db.insert(orders).values({
      id: ids.order,
      publicOrderId: "ord_service_test",
      saleOfferId: ids.saleOffer,
      reservationId: ids.reservation,
      correlationId: "persisted-reservation-correlation",
      quantity: 1,
      status,
      queuedAt,
      ...(status === "queued" ? {} : { processingAt }),
      ...(status === "confirmed" ? { confirmedAt } : {}),
      ...(status === "failed"
        ? {
            failedAt,
            failureCode: "erp_rejected",
            failureMessage: "ERP rejected the order",
          }
        : {}),
    });
    const events: Array<typeof orderEvents.$inferInsert> = [
      {
        id: "77777777-7777-4777-8777-777777777777",
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        correlationId: "persisted-reservation-correlation",
        eventName: "order.queued",
        source: "api",
        occurredAt: queuedAt,
        createdAt: new Date("2026-07-15T10:00:00.001Z"),
      },
      {
        id: "88888888-8888-4888-8888-888888888888",
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        correlationId: "persisted-reservation-correlation",
        eventName: "reservation.secured",
        source: "api",
        occurredAt: queuedAt,
        createdAt: new Date("2026-07-15T10:00:00.002Z"),
      },
    ];

    if (status !== "queued") {
      events.push({
        id: "99999999-9999-4999-8999-999999999999",
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        correlationId: "persisted-reservation-correlation",
        eventName: "order.processing",
        source: "worker",
        occurredAt: processingAt,
      });
    }

    if (status === "confirmed" || status === "failed") {
      events.push({
        id:
          status === "confirmed"
            ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        orderId: ids.order,
        reservationId: ids.reservation,
        saleOfferId: ids.saleOffer,
        correlationId: "persisted-reservation-correlation",
        eventName: status === "confirmed" ? "order.confirmed" : "order.failed",
        source: "worker",
        occurredAt: status === "confirmed" ? confirmedAt : failedAt,
      });
    }

    await db.insert(orderEvents).values(events);
  }
});
