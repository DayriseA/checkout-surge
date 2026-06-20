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
} from "../../src/index.js";
import { resetTestDatabase } from "../../src/testing.js";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = path.join(packageRoot, "drizzle");
const seededSaleOfferId = "22222222-2222-4222-8222-222222222222";

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
