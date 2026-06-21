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
  type CheckoutSurgeRedis,
  createDatabaseConnection,
  createRedisClient,
  getInventoryStatus,
  InventoryNotInitializedError,
  initializeInventory,
  isRunSaleEligible,
  markReservationPendingPersistence,
  orderEvents,
  orders,
  products,
  promoteReservationIdempotencyToAccepted,
  reservations,
  reserveInventoryStock,
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
  type StockReservationGateway,
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
  stockReservations?: StockReservationGateway;
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
            reservationThroughput: {
              windowSeconds: 60,
              successfulReservationCount: 6,
              rate: 0.1,
              unit: "reservations_per_second" as const,
              measuredAt: "2026-06-20T00:00:10.000Z",
            },
            soldOutPressure: {
              rejectionCount: 4,
              latestObservedAt: "2026-06-20T00:00:09.000Z",
            },
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
      stockReservations: options.stockReservations ?? new AcceptingStockReservations(),
      reservationHoldMinutes: 15,
      idempotencyTtlSeconds: 1800,
      pendingPersistenceRetryAfterSeconds: 30,
      generateId: deterministicIdGenerator(),
    }),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

function createRedisStockReservations(redis: CheckoutSurgeRedis): StockReservationGateway {
  return {
    isRunSaleEligible: (input) => isRunSaleEligible(redis, input),
    reserve: (input) => reserveInventoryStock(redis, input),
    markPendingPersistence: (input) => markReservationPendingPersistence(redis, input),
    promoteAccepted: (input) =>
      promoteReservationIdempotencyToAccepted(redis, input).then(() => undefined),
  };
}

class AcceptingPersistence implements BuyPersistence {
  private readonly persisted = new Map<
    string,
    { reservation: ReservationSummary; order: OrderSummary }
  >();

  async persistSecuredReservation(input: {
    reservation: import("@checkout-surge/contracts").SecuredReservationHold;
  }) {
    const hold = input.reservation;
    const reservation: ReservationSummary = {
      ...hold,
      status: "secured",
    };
    const order: OrderSummary = {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_test",
      saleOfferId: hold.saleOfferId,
      reservationId: reservation.id,
      correlationId: hold.correlationId,
      ...(hold.runId ? { runId: hold.runId } : {}),
      quantity: hold.quantity,
      status: "queued",
      queuedAt: hold.securedAt,
    };

    const result = { reservation, order };
    this.persisted.set(reservation.id, result);
    return result;
  }

  async getPersistedBuyByReservationId(reservationId: string) {
    return this.persisted.get(reservationId) ?? null;
  }
}

class AcceptingStockReservations implements StockReservationGateway {
  async isRunSaleEligible(): Promise<boolean> {
    return true;
  }

  async reserve(input: Parameters<StockReservationGateway["reserve"]>[0]) {
    return { outcome: "reservation_secured" as const, reservation: input.reservation };
  }

  async markPendingPersistence(): Promise<void> {}

  async promoteAccepted(): Promise<void> {}
}

function deterministicIdGenerator(): () => string {
  const ids = ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"];
  const firstId = ids[0];
  if (!firstId) {
    throw new Error("A deterministic test ID is required.");
  }
  let index = 0;
  return () => ids[index++ % ids.length] ?? firstId;
}

describe("API gateway routes", () => {
  const servers: ApiFastifyInstance[] = [];

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function trackedServer(options: {
    persistence: BuyPersistence;
    stockReservations?: StockReservationGateway;
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
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 6,
        rate: 0.1,
        unit: "reservations_per_second",
      },
      soldOutPressure: {
        rejectionCount: 4,
        latestObservedAt: "2026-06-20T00:00:09.000Z",
      },
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

  it("fails closed for a run-scoped request without Redis eligibility", async () => {
    const stockReservations = new AcceptingStockReservations();
    stockReservations.isRunSaleEligible = async () => false;
    const server = await trackedServer({
      persistence: new AcceptingPersistence(),
      stockReservations,
    });

    const response = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        saleOfferId: fixtureIds.saleOffer,
        runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        idempotencyKey: "run-without-eligibility",
        quantity: 1,
      },
    });
    const payload = buyResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(503);
    expect(payload).toMatchObject({
      outcome: "inventory_not_initialized",
      reason: "run_not_accepting_traffic",
      reservation: null,
      order: null,
    });
  });

  it("requires Redis configuration for production composition", () => {
    expect(() => loadApiConfig({ DATABASE_URL: "postgresql://localhost/test" })).toThrow(
      "REDIS_URL is required.",
    );
  });
});

describe("API buy persistence", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: CheckoutSurgeRedis | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis ??= createRedisClient(process.env.TEST_REDIS_URL ?? "redis://localhost:6380", {
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
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
    await initializeInventory(redis, { saleOfferId: fixtureIds.saleOffer, allocatedStock: 5 });
  });

  afterEach(async () => {
    await connection?.close();
    connection = null;
  });

  afterAll(async () => {
    await connection?.close();
    await redis?.flushdb();
    redis?.disconnect();
  });

  it("persists a secured reservation, queued order, and initial events", async () => {
    if (!connection) {
      throw new Error("Test database connection was not initialized.");
    }

    if (!redis) {
      throw new Error("Test Redis connection was not initialized.");
    }
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
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
      expect(reservationRow?.id).toBe(payload.reservation?.id);
      expect(reservationRow?.reservationToken).toBe(payload.reservation?.reservationToken);
      expect(reservationRow?.securedAt.toISOString()).toBe(payload.reservation?.securedAt);
      expect(reservationRow?.expiresAt.toISOString()).toBe(payload.reservation?.expiresAt);
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

  it("rejects uninitialized inventory without PostgreSQL writes", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    const missingSaleOfferId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
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

      expect(response.statusCode).toBe(503);
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

  it("keeps sold-out requests on Redis without PostgreSQL writes", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }

    await redis.hset(`inventory:${fixtureIds.saleOffer}:state`, "remainingStock", "0");

    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
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
      expect(payload.outcome).toBe("sold_out");
      if (payload.outcome !== "sold_out") {
        throw new Error(`Expected sold-out rejection, received ${payload.outcome}.`);
      }
      expect(payload.reason).toBe("sold_out");
      expect(payload.reservation).toBeNull();
      expect(payload.order).toBeNull();
      expect(reservationRows).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("preserves a failed durable write as pending and replays without consuming stock", async () => {
    if (!redis) {
      throw new Error("Test Redis connection was not initialized.");
    }
    const gateway = createRedisStockReservations(redis);
    const failingPersistence: BuyPersistence = {
      persistSecuredReservation: async () => {
        throw new Error("simulated PostgreSQL failure");
      },
      getPersistedBuyByReservationId: async () => null,
    };
    const server = await buildTestServer({
      persistence: failingPersistence,
      stockReservations: gateway,
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "pending-persistence-idem",
          quantity: 2,
        },
      };
      const first = await server.inject(request);
      const replay = await server.inject(request);
      const firstPayload = buyResponseSchema.parse(first.json());
      const replayPayload = buyResponseSchema.parse(replay.json());
      const status = await getInventoryStatus(redis, fixtureIds.saleOffer);

      expect(first.statusCode).toBe(202);
      expect(first.headers["retry-after"]).toBe("30");
      expect(firstPayload.outcome).toBe("reservation_pending_persistence");
      expect(replayPayload.outcome).toBe("reservation_pending_persistence");
      expect(replayPayload.reservation?.id).toBe(firstPayload.reservation?.id);
      expect(replayPayload.order).toBeNull();
      expect(status).toMatchObject({
        remainingStock: 3,
        reservedStock: 2,
        pendingPersistenceCount: 1,
      });
    } finally {
      await server.close();
    }
  });

  it("returns the durable reservation and order for an accepted replay without duplicates", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "accepted-replay-idem",
          quantity: 1,
        },
      };
      const firstPayload = buyResponseSchema.parse((await server.inject(request)).json());
      const replayPayload = buyResponseSchema.parse((await server.inject(request)).json());
      const reservationRows = await connection.db.select().from(reservations);
      const orderRows = await connection.db.select().from(orders);

      expect(firstPayload.outcome).toBe("reservation_secured");
      expect(replayPayload.outcome).toBe("idempotent_replay");
      if (
        firstPayload.outcome !== "reservation_secured" ||
        replayPayload.outcome !== "idempotent_replay"
      ) {
        throw new Error("Expected secured and idempotent replay outcomes.");
      }
      expect(replayPayload.reservation.id).toBe(firstPayload.reservation.id);
      expect(replayPayload.order.id).toBe(firstPayload.order.id);
      expect(reservationRows).toHaveLength(1);
      expect(orderRows).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("maps an idempotency quantity conflict without changing Redis or PostgreSQL", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: createRedisStockReservations(redis),
    });

    try {
      await server.inject({
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "conflicting-api-idem",
          quantity: 1,
        },
      });
      const conflict = await server.inject({
        method: "POST",
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "conflicting-api-idem",
          quantity: 2,
        },
      });
      const payload = buyResponseSchema.parse(conflict.json());

      expect(conflict.statusCode).toBe(409);
      expect(payload.outcome).toBe("idempotency_conflict");
      expect(await connection.db.select().from(reservations)).toHaveLength(1);
      expect(await connection.db.select().from(orders)).toHaveLength(1);
      expect(await getInventoryStatus(redis, fixtureIds.saleOffer)).toMatchObject({
        remainingStock: 4,
        reservedStock: 1,
      });
    } finally {
      await server.close();
    }
  });

  it("heals Redis promotion on retry after PostgreSQL already committed", async () => {
    if (!connection || !redis) {
      throw new Error("Test infrastructure was not initialized.");
    }
    const redisGateway = createRedisStockReservations(redis);
    let promotionAttempts = 0;
    const gateway: StockReservationGateway = {
      ...redisGateway,
      promoteAccepted: async (input) => {
        promotionAttempts += 1;
        if (promotionAttempts === 1) {
          throw new Error("simulated Redis promotion failure");
        }
        await redisGateway.promoteAccepted(input);
      },
    };
    const server = await buildTestServer({
      persistence: new PostgresBuyPersistence(connection.db),
      stockReservations: gateway,
    });

    try {
      const request = {
        method: "POST" as const,
        url: "/buy",
        payload: {
          saleOfferId: fixtureIds.saleOffer,
          idempotencyKey: "promotion-recovery-idem",
          quantity: 1,
        },
      };
      const firstPayload = buyResponseSchema.parse((await server.inject(request)).json());
      const replayPayload = buyResponseSchema.parse((await server.inject(request)).json());

      expect(firstPayload.outcome).toBe("reservation_secured");
      expect(replayPayload.outcome).toBe("idempotent_replay");
      expect(await connection.db.select().from(reservations)).toHaveLength(1);
      expect(await connection.db.select().from(orders)).toHaveLength(1);
      expect((await getInventoryStatus(redis, fixtureIds.saleOffer)).pendingPersistenceCount).toBe(
        0,
      );
    } finally {
      await server.close();
    }
  });
});
