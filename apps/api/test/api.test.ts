import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buyResponseSchema,
  dashboardRecoveryResponseSchema,
  errorPayloadSchema,
  healthResponseSchema,
  inventoryStatusSchema,
  livenessResponseSchema,
  type OrderSummary,
  type ReservationSummary,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  InventoryNotInitializedError,
  orderEvents,
  orders,
  products,
  reservations,
  saleOffers,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "../src/runtime/config.js";
import type { ApiFastifyInstance } from "../src/runtime/fastify.js";
import { buildApiServer } from "../src/server.js";
import {
  type InventoryStatusReader,
  InventoryStatusService,
} from "../src/services/inventory-status-service.js";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";
import {
  type BuyPersistence,
  ReserveOrderService,
  type SaleOfferEligibility,
} from "../src/services/reserve-order-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

const fixtureIds = {
  product: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOffer: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API tests.");
  }

  return databaseUrl;
}

function baseConfig() {
  return loadApiConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost/test",
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6380",
    LOG_LEVEL: "silent",
  });
}

async function buildTestServer(options: {
  persistence: BuyPersistence;
  inventoryReader?: InventoryStatusReader | null;
  readiness?: "ok" | "unavailable";
}): Promise<ApiFastifyInstance> {
  const inventoryReader =
    options.inventoryReader === undefined
      ? {
          getStatus: async (saleOfferId: string) => ({
            saleOfferId,
            allocatedStock: 10,
            remainingStock: 7,
            reservedStock: 3,
            pendingPersistenceCount: 1,
            expiredReservationCount: 2,
            oldestPendingPersistenceAgeSeconds: 4.5,
            lastUpdatedAt: "2026-06-20T00:00:00.000Z",
          }),
        }
      : options.inventoryReader;

  return buildApiServer({
    config: baseConfig(),
    logger: createSilentLogger("api"),
    readiness: {
      checks: async () => [
        {
          name: "database_reachable",
          status: options.readiness ?? "ok",
        },
        {
          name: "redis_url_configured",
          status: "ok",
        },
      ],
    },
    inventoryStatusService: new InventoryStatusService(inventoryReader),
    reserveOrderService: new ReserveOrderService({
      persistence: options.persistence,
      reservationHoldMinutes: 15,
    }),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

class AcceptingPersistence implements BuyPersistence {
  async getSaleOfferEligibility(): Promise<SaleOfferEligibility> {
    return {
      saleOfferId: fixtureIds.saleOffer,
      isAccepting: true,
    };
  }

  async persistSecuredReservation(input: {
    saleOfferId: string;
    runId?: string;
    quantity: number;
    correlationId: string;
    securedAt: Date;
    expiresAt: Date;
  }) {
    const reservation: ReservationSummary = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      saleOfferId: input.saleOfferId,
      correlationId: input.correlationId,
      ...(input.runId ? { runId: input.runId } : {}),
      quantity: input.quantity,
      status: "secured",
      reservationToken: "res_test",
      expiresAt: input.expiresAt.toISOString(),
      securedAt: input.securedAt.toISOString(),
    };
    const order: OrderSummary = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_test",
      saleOfferId: input.saleOfferId,
      reservationId: reservation.id,
      correlationId: input.correlationId,
      ...(input.runId ? { runId: input.runId } : {}),
      quantity: input.quantity,
      status: "queued",
      queuedAt: input.securedAt.toISOString(),
    };

    return { reservation, order };
  }
}

describe("API gateway routes", () => {
  const servers: ApiFastifyInstance[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function trackedServer(options: {
    persistence: BuyPersistence;
    inventoryReader?: InventoryStatusReader | null;
    readiness?: "ok" | "unavailable";
  }) {
    const server = await buildTestServer(options);
    servers.push(server);
    return server;
  }

  it("returns contract-valid liveness and readiness responses", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const live = await server.inject({ method: "GET", url: "/health/live" });
    const ready = await server.inject({ method: "GET", url: "/health/ready" });

    expect(live.statusCode).toBe(200);
    expect(() => livenessResponseSchema.parse(live.json())).not.toThrow();
    expect(ready.statusCode).toBe(200);
    expect(() => healthResponseSchema.parse(ready.json())).not.toThrow();
  });

  it("returns unavailable readiness with HTTP 503 when a dependency check fails", async () => {
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      readiness: "unavailable",
    });

    const ready = await server.inject({ method: "GET", url: "/health/ready" });
    const payload = healthResponseSchema.parse(ready.json());

    expect(ready.statusCode).toBe(503);
    expect(payload.status).toBe("unavailable");
    expect(payload.checks).toContainEqual({
      name: "database_reachable",
      status: "unavailable",
    });
  });

  it("returns a contract-valid dashboard recovery placeholder response", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({ method: "GET", url: "/dashboard/recovery" });
    const payload = dashboardRecoveryResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload.currentRun).toBeNull();
    expect(payload.inventory).toBeNull();
    expect(payload.queue).toBeNull();
    expect(payload.recentMetrics).toEqual([]);
  });

  it("returns the shared inventory status contract", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "GET",
      url: `/inventory/${fixtureIds.saleOffer}/status`,
    });
    const payload = inventoryStatusSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(payload).toMatchObject({
      saleOfferId: fixtureIds.saleOffer,
      allocatedStock: 10,
      remainingStock: 7,
      reservedStock: 3,
      pendingPersistenceCount: 1,
      expiredReservationCount: 2,
    });
  });

  it("returns a stable shared error when inventory is not initialized", async () => {
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      inventoryReader: {
        getStatus: async (saleOfferId) => {
          throw new InventoryNotInitializedError(saleOfferId);
        },
      },
    });

    const response = await server.inject({
      method: "GET",
      url: `/inventory/${fixtureIds.saleOffer}/status`,
    });
    const payload = errorPayloadSchema.parse(response.json());

    expect(response.statusCode).toBe(404);
    expect(payload.code).toBe("inventory_not_initialized");
    expect(payload.details).toEqual({ saleOfferId: fixtureIds.saleOffer });
  });

  it("rejects invalid inventory status sale offer IDs", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({ method: "GET", url: "/inventory/not-a-uuid/status" });
    const payload = errorPayloadSchema.parse(response.json());

    expect(response.statusCode).toBe(400);
    expect(payload.code).toBe("invalid_request");
  });

  it("returns shared error shape for invalid buy requests", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["x-correlation-id"]).toBeTruthy();
    expect(() => errorPayloadSchema.parse(response.json())).not.toThrow();
  });

  it("propagates request correlation IDs through headers and buy payloads", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      headers: {
        "x-correlation-id": "phase2-test-correlation",
      },
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "idem-1",
        quantity: 1,
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(202);
    expect(response.headers["x-correlation-id"]).toBe("phase2-test-correlation");
    expect(payload.correlationId).toBe("phase2-test-correlation");
    expect(payload.outcome).toBe("reservation_secured");
  });

  it("allows body correlation ID to set the final buy correlation when no header is supplied", async () => {
    const server = await trackedServer({ persistence: new AcceptingPersistence() });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        idempotencyKey: "idem-2",
        quantity: 1,
        correlationId: "body-correlation",
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.headers["x-correlation-id"]).toBe("body-correlation");
    expect(payload.correlationId).toBe("body-correlation");
  });
});

describe("API buy persistence", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await connection.db.insert(products).values({
      id: fixtureIds.product,
      sku: "API-TEST-SKU",
      slug: "api-test-product",
      name: "API Test Product",
      isActive: true,
    });
    await connection.db.insert(saleOffers).values({
      id: fixtureIds.saleOffer,
      productId: fixtureIds.product,
      name: "API Test Sale Offer",
      allocatedStock: 5,
      saleStartsAt: new Date("2026-01-01T00:00:00.000Z"),
      saleEndsAt: new Date("2035-01-01T00:00:00.000Z"),
      isActive: true,
      purpose: "catalog",
    });
  });

  afterEach(async () => {
    await connection?.close();
    connection = null;
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("persists a secured reservation, queued order, and initial events", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          "x-correlation-id": "persist-correlation",
        },
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "persist-idem-1",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());

      const [reservationRow] = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.id, payload.reservation?.id ?? ""))
        .limit(1);
      const [orderRow] = await connection.db
        .select()
        .from(orders)
        .where(eq(orders.id, payload.order?.id ?? ""))
        .limit(1);
      const events = await connection.db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.reservationId, payload.reservation?.id ?? ""));

      expect(response.statusCode).toBe(202);
      expect(payload.outcome).toBe("reservation_secured");
      expect(reservationRow?.status).toBe("secured");
      expect(reservationRow?.correlationId).toBe("persist-correlation");
      expect(orderRow?.status).toBe("queued");
      expect(orderRow?.reservationId).toBe(reservationRow?.id);
      expect(events.map((event) => event.eventName).sort()).toEqual([
        "order.queued",
        "reservation.secured",
      ]);
    } finally {
      await server.close();
    }
  });

  it("rejects missing sale offers without writing reservation records", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    const missingSaleOfferId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          "x-correlation-id": "missing-offer-correlation",
        },
        payload: {
          saleOfferId: missingSaleOfferId,
          idempotencyKey: "missing-offer-idem-1",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());
      const reservationRows = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.saleOfferId, missingSaleOfferId));

      expect(response.statusCode).toBe(409);
      expect(payload.outcome).toBe("inventory_not_initialized");
      if (payload.outcome !== "inventory_not_initialized") {
        throw new Error(`Expected missing offer rejection, received ${payload.outcome}.`);
      }
      expect(payload.reason).toBe("inventory_not_initialized");
      expect(payload.reservation).toBeNull();
      expect(payload.order).toBeNull();
      expect(reservationRows).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects inactive sale offers without writing reservation records", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    await connection.db
      .update(saleOffers)
      .set({ isActive: false })
      .where(eq(saleOffers.id, fixtureIds.saleOffer));

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
    });

    try {
      const response = await server.inject({
        method: "POST",
        url: "/buy",
        headers: {
          "x-correlation-id": "inactive-offer-correlation",
        },
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "inactive-offer-idem-1",
          quantity: 1,
        },
      });
      const payload = buyResponseSchema.parse(response.json());
      const reservationRows = await connection.db
        .select()
        .from(reservations)
        .where(eq(reservations.saleOfferId, fixtureIds.saleOffer));

      expect(response.statusCode).toBe(409);
      expect(payload.outcome).toBe("inventory_not_initialized");
      if (payload.outcome !== "inventory_not_initialized") {
        throw new Error(`Expected inactive offer rejection, received ${payload.outcome}.`);
      }
      expect(payload.reason).toBe("run_not_accepting_traffic");
      expect(payload.reservation).toBeNull();
      expect(payload.order).toBeNull();
      expect(reservationRows).toEqual([]);
    } finally {
      await server.close();
    }
  });
});
