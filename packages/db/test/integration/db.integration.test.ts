import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { publicRuntimePolicySchema } from "@checkout-surge/contracts";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  getInventoryStatus,
  InventoryNotInitializedError,
  initializeInventory,
  inventoryKeys,
  reserveInventoryStock,
} from "../../src/index.js";
import { resetTestDatabase } from "../../src/testing.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const seededSaleOfferId = "22222222-2222-4222-8222-222222222222";
const reservationSecuredAt = "2026-06-20T12:00:00.000Z";
const reservationExpiresAt = "2026-06-20T12:15:00.000Z";

function buildReservationInput(options: {
  saleOfferId: string;
  sequence: number;
  quantity?: number;
  idempotencyKey?: string;
}) {
  const suffix = options.sequence.toString(16).padStart(12, "0");

  return {
    idempotencyKey: options.idempotencyKey ?? `reservation-attempt-${options.sequence}`,
    idempotencyTtlSeconds: 1800,
    reservation: {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
      saleOfferId: options.saleOfferId,
      correlationId: `corr-reservation-${options.sequence}`,
      runId: "99999999-9999-4999-8999-999999999999",
      quantity: options.quantity ?? 1,
      status: "secured" as const,
      reservationToken: `reservation-token-${options.sequence}`,
      securedAt: reservationSecuredAt,
      expiresAt: reservationExpiresAt,
    },
  };
}

function requireTestEnv(name: "TEST_DATABASE_URL" | "TEST_REDIS_URL"): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for database integration tests.`);
  }

  return value;
}

async function withDatabase<T>(
  fn: (sql: ReturnType<typeof createDatabaseConnection>["sql"]) => Promise<T>,
) {
  const connection = createDatabaseConnection(requireTestEnv("TEST_DATABASE_URL"), { max: 1 });

  try {
    return await fn(connection.sql);
  } finally {
    await connection.close();
  }
}

async function runSeedScript(): Promise<void> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

  await execFileAsync(command, ["exec", "tsx", "src/scripts/seed.ts"], {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: requireTestEnv("TEST_DATABASE_URL"),
      REDIS_URL: requireTestEnv("TEST_REDIS_URL"),
    },
  });
}

describe("database migrations, seed data, and reset behavior", () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(requireTestEnv("TEST_REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.connect();
    await redis.flushdb();
    await resetTestDatabase({ migrationsFolder });
  });

  afterAll(async () => {
    await redis.flushdb();
    redis.disconnect();
  });

  it("applies the initial schema and trigger-backed run sale ownership guards", async () => {
    const tableRows = await withDatabase(
      (sql) =>
        sql<{ table_name: string }[]>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('products', 'sale_offers', 'reservations', 'orders', 'demo_runs')
      `,
    );
    const triggerRows = await withDatabase(
      (sql) =>
        sql<{ tgname: string }[]>`
        SELECT tgname
        FROM pg_trigger
        WHERE tgname IN (
          'demo_run_sale_contexts_enforce_offer_purpose',
          'reservations_enforce_run_owned_sale_offer_attribution'
        )
      `,
    );

    expect(tableRows.map((row) => row.table_name).sort()).toEqual([
      "demo_runs",
      "orders",
      "products",
      "reservations",
      "sale_offers",
    ]);
    expect(triggerRows.map((row) => row.tgname).sort()).toEqual([
      "demo_run_sale_contexts_enforce_offer_purpose",
      "reservations_enforce_run_owned_sale_offer_attribution",
    ]);
  });

  it("seeds PostgreSQL demo rows and Redis inventory idempotently", async () => {
    await runSeedScript();
    await runSeedScript();

    const [counts] = await withDatabase(
      (sql) =>
        sql<
          {
            products: number;
            sale_offers: number;
            demo_presets: number;
            public_runtime_policies: number;
          }[]
        >`
        SELECT
          (SELECT count(*)::int FROM products) AS products,
          (SELECT count(*)::int FROM sale_offers) AS sale_offers,
          (SELECT count(*)::int FROM demo_presets) AS demo_presets,
          (SELECT count(*)::int FROM public_runtime_policies) AS public_runtime_policies
      `,
    );
    const [policyRow] = await withDatabase(
      (sql) =>
        sql<{ policy: unknown }[]>`
        SELECT policy
        FROM public_runtime_policies
        WHERE id = 'active'
      `,
    );
    const inventoryState = await redis.hgetall(`inventory:${seededSaleOfferId}:state`);

    expect(counts).toEqual({
      products: 1,
      sale_offers: 1,
      demo_presets: 8,
      public_runtime_policies: 1,
    });
    expect(() => publicRuntimePolicySchema.parse(policyRow?.policy)).not.toThrow();
    expect(inventoryState).toMatchObject({
      saleOfferId: seededSaleOfferId,
      allocatedStock: "1000",
      remainingStock: "1000",
      reservedStock: "0",
    });
  });

  it("initializes and resets only the targeted inventory namespace", async () => {
    const targetOfferId = "55555555-5555-4555-8555-555555555555";
    const otherOfferId = "66666666-6666-4666-8666-666666666666";
    const targetKeys = inventoryKeys(targetOfferId);
    const otherKeys = inventoryKeys(otherOfferId);
    const staleTargetIdempotencyKeys = Array.from({ length: 250 }, (_, index) =>
      targetKeys.idempotency(`old-key-${index}`),
    );
    const preservedOtherOfferKeys = Array.from({ length: 3 }, (_, index) =>
      otherKeys.idempotency(`keep-key-${index}`),
    );

    await initializeInventory(redis, {
      saleOfferId: targetOfferId,
      allocatedStock: 12,
      source: "integration-test",
      initializedAt: new Date("2026-06-20T10:00:00.000Z"),
    });
    const staleKeySetup = redis.pipeline();
    for (const key of staleTargetIdempotencyKeys) {
      staleKeySetup.set(key, "stale");
    }
    for (const key of preservedOtherOfferKeys) {
      staleKeySetup.set(key, "preserved");
    }
    await staleKeySetup.exec();
    await redis.hset(targetKeys.reservations, "old-reservation", "stale");

    const status = await initializeInventory(redis, {
      saleOfferId: targetOfferId,
      allocatedStock: 8,
      source: "generated-run",
      initializedAt: new Date("2026-06-20T11:00:00.000Z"),
    });

    expect(status).toMatchObject({
      saleOfferId: targetOfferId,
      allocatedStock: 8,
      remainingStock: 8,
      reservedStock: 0,
    });
    expect(await redis.exists(...staleTargetIdempotencyKeys)).toBe(0);
    expect(await redis.exists(targetKeys.reservations)).toBe(0);
    expect(await redis.mget(...preservedOtherOfferKeys)).toEqual([
      "preserved",
      "preserved",
      "preserved",
    ]);
    expect(await redis.llen(targetKeys.events)).toBe(1);
  });

  it("derives pending and expired status fields from Redis source collections", async () => {
    const saleOfferId = "77777777-7777-4777-8777-777777777777";
    const keys = inventoryKeys(saleOfferId);
    const now = new Date("2026-06-20T12:00:00.000Z");

    await initializeInventory(redis, {
      saleOfferId,
      allocatedStock: 20,
      initializedAt: new Date("2026-06-20T11:59:00.000Z"),
    });
    await redis.hset(keys.state, {
      remainingStock: "13",
      reservedStock: "7",
      pendingPersistenceCount: "99",
      expiredReservationCount: "99",
      oldestPendingPersistenceAgeSeconds: "99",
    });
    await redis.zadd(
      keys.pendingPersistence,
      now.getTime() - 4_500,
      "pending-oldest",
      now.getTime() - 1_000,
      "pending-newest",
    );
    await redis.zadd(
      keys.reservationExpirations,
      now.getTime() - 1,
      "expired",
      now.getTime() + 1,
      "active",
    );

    const status = await getInventoryStatus(redis, saleOfferId, now);

    expect(status).toMatchObject({
      allocatedStock: 20,
      remainingStock: 13,
      reservedStock: 7,
      pendingPersistenceCount: 2,
      expiredReservationCount: 1,
      oldestPendingPersistenceAgeSeconds: 4.5,
    });
  });

  it("rejects missing inventory state instead of fabricating zero stock", async () => {
    const missingSaleOfferId = "88888888-8888-4888-8888-888888888888";
    await redis.set(inventoryKeys(missingSaleOfferId).pendingPersistence, "orphaned-state");

    await expect(getInventoryStatus(redis, missingSaleOfferId)).rejects.toEqual(
      new InventoryNotInitializedError(missingSaleOfferId),
    );
  });

  it("atomically secures stock and writes the complete replayable hold", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000001";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 1, quantity: 2 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });

    const result = await reserveInventoryStock(redis, input);

    expect(result).toEqual({ outcome: "reservation_secured", reservation: input.reservation });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "3",
      reservedStock: "2",
      lastUpdatedAt: reservationSecuredAt,
    });
    expect(
      JSON.parse((await redis.hget(keys.reservations, input.reservation.id)) ?? "null"),
    ).toEqual(input.reservation);
    expect(await redis.zscore(keys.reservationExpirations, input.reservation.id)).toBe(
      new Date(reservationExpiresAt).getTime().toString(),
    );
    const idempotencyTtl = await redis.ttl(keys.idempotency(input.idempotencyKey));
    expect(idempotencyTtl).toBeGreaterThan(1790);
    expect(idempotencyTtl).toBeLessThanOrEqual(1800);
    expect(JSON.parse((await redis.get(keys.idempotency(input.idempotencyKey))) ?? "null")).toEqual(
      {
        status: "pending_persistence",
        quantity: input.reservation.quantity,
        reservation: input.reservation,
      },
    );
    expect(await redis.llen(keys.events)).toBe(2);
  });

  it("returns sold out without per-loser records or events", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000002";
    const keys = inventoryKeys(saleOfferId);
    const input = buildReservationInput({ saleOfferId, sequence: 2, quantity: 3 });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 2 });

    const result = await reserveInventoryStock(redis, input);

    expect(result).toEqual({ outcome: "sold_out", reservation: null });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "2",
      reservedStock: "0",
    });
    expect(await redis.exists(keys.idempotency(input.idempotencyKey))).toBe(0);
    expect(await redis.exists(keys.reservations, keys.reservationExpirations)).toBe(0);
    expect(await redis.llen(keys.events)).toBe(1);
    expect(await redis.hgetall(keys.reservationOutcomes)).toEqual({
      api_sold_out_decision: "1",
      api_sold_out_decision_latest_observed_at: reservationSecuredAt,
    });
  });

  it("returns inventory not initialized without creating side keys", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000003";
    const keys = inventoryKeys(saleOfferId);

    const result = await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId, sequence: 3 }),
    );

    expect(result).toEqual({ outcome: "inventory_not_initialized", reservation: null });
    expect(await redis.keys(`${keys.prefix}:*`)).toEqual([]);
  });

  it("returns pending for a pre-durable retry and replays after accepted promotion", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000004";
    const keys = inventoryKeys(saleOfferId);
    const firstInput = buildReservationInput({
      saleOfferId,
      sequence: 4,
      idempotencyKey: "replay-key",
    });
    await initializeInventory(redis, { saleOfferId, allocatedStock: 1 });
    const firstDecision = await reserveInventoryStock(redis, firstInput);
    expect(firstDecision).toEqual({
      outcome: "reservation_secured",
      reservation: firstInput.reservation,
    });

    const immediateRetry = await reserveInventoryStock(redis, {
      ...buildReservationInput({ saleOfferId, sequence: 40, idempotencyKey: "replay-key" }),
      reservation: {
        ...buildReservationInput({ saleOfferId, sequence: 40 }).reservation,
        quantity: 1,
      },
    });

    expect(immediateRetry).toEqual({
      outcome: "reservation_pending_persistence",
      reservation: firstInput.reservation,
    });
    expect(await redis.hget(keys.state, "reservedStock")).toBe("1");
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.llen(keys.events)).toBe(2);

    const idempotencyKey = keys.idempotency(firstInput.idempotencyKey);
    const ttlBeforePromotion = await redis.ttl(idempotencyKey);
    const record = JSON.parse((await redis.get(idempotencyKey)) ?? "null") as Record<
      string,
      unknown
    >;
    await redis.set(idempotencyKey, JSON.stringify({ ...record, status: "accepted" }), "KEEPTTL");
    const ttlAfterPromotion = await redis.ttl(idempotencyKey);
    expect(ttlAfterPromotion).toBeGreaterThan(ttlBeforePromotion - 5);
    expect(ttlAfterPromotion).toBeLessThanOrEqual(ttlBeforePromotion);

    const acceptedReplay = await reserveInventoryStock(redis, firstInput);
    expect(acceptedReplay).toEqual({
      outcome: "idempotent_replay",
      reservation: firstInput.reservation,
    });
    expect(await redis.hget(keys.state, "reservedStock")).toBe("1");
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.llen(keys.events)).toBe(2);
  });

  it("rejects an idempotency quantity conflict without changing stock", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000005";
    const keys = inventoryKeys(saleOfferId);
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });
    await reserveInventoryStock(
      redis,
      buildReservationInput({ saleOfferId, sequence: 5, idempotencyKey: "conflict-key" }),
    );

    const conflict = await reserveInventoryStock(
      redis,
      buildReservationInput({
        saleOfferId,
        sequence: 50,
        quantity: 2,
        idempotencyKey: "conflict-key",
      }),
    );

    expect(conflict).toEqual({ outcome: "idempotency_conflict", reservation: null });
    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "4",
      reservedStock: "1",
    });
    expect(await redis.hlen(keys.reservations)).toBe(1);
    expect(await redis.llen(keys.events)).toBe(2);
  });

  it("rejects invalid quantities before Redis without mutating inventory", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000006";
    const keys = inventoryKeys(saleOfferId);
    await initializeInventory(redis, { saleOfferId, allocatedStock: 5 });

    for (const [index, quantity] of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].entries()) {
      const input = buildReservationInput({ saleOfferId, sequence: 60 + index });
      const result = await reserveInventoryStock(redis, {
        ...input,
        reservation: { ...input.reservation, quantity },
      });
      expect(result).toEqual({ outcome: "quantity_invalid", reservation: null });
    }

    expect(await redis.hgetall(keys.state)).toMatchObject({
      remainingStock: "5",
      reservedStock: "0",
    });
    expect(await redis.exists(keys.reservations, keys.reservationExpirations)).toBe(0);
    expect(await redis.llen(keys.events)).toBe(1);
    expect(await redis.hget(keys.reservationOutcomes, "api_sold_out_decision")).toBe("0");
  });

  it("does not oversell under concurrent reservations and bounds event history", async () => {
    const saleOfferId = "10000000-0000-4000-8000-000000000007";
    const keys = inventoryKeys(saleOfferId);
    const clients = Array.from(
      { length: 8 },
      () => new Redis(requireTestEnv("TEST_REDIS_URL"), { maxRetriesPerRequest: 3 }),
    );
    await initializeInventory(redis, { saleOfferId, allocatedStock: 100 });

    try {
      const decisions = await Promise.all(
        Array.from({ length: 250 }, (_, index) =>
          reserveInventoryStock(
            clients[index % clients.length] ?? redis,
            buildReservationInput({ saleOfferId, sequence: 1000 + index }),
          ),
        ),
      );
      const securedCount = decisions.filter(
        (decision) => decision.outcome === "reservation_secured",
      ).length;
      const soldOutCount = decisions.filter((decision) => decision.outcome === "sold_out").length;

      expect({ securedCount, soldOutCount }).toEqual({ securedCount: 100, soldOutCount: 150 });
      expect(await redis.hgetall(keys.state)).toMatchObject({
        remainingStock: "0",
        reservedStock: "100",
      });
      expect(await redis.hlen(keys.reservations)).toBe(100);
      expect(await redis.zcard(keys.reservationExpirations)).toBe(100);
      expect(await redis.hget(keys.reservationOutcomes, "api_sold_out_decision")).toBe("150");
      expect(await redis.llen(keys.events)).toBe(100);
    } finally {
      for (const client of clients) {
        client.disconnect();
      }
    }
  });

  it("resets only business tables in the isolated test database", async () => {
    await resetTestDatabase({ migrationsFolder });

    const [counts] = await withDatabase(
      (sql) =>
        sql<{ products: number; demo_presets: number }[]>`
        SELECT
          (SELECT count(*)::int FROM products) AS products,
          (SELECT count(*)::int FROM demo_presets) AS demo_presets
      `,
    );

    expect(counts).toEqual({ products: 0, demo_presets: 0 });
  });
});
