import { randomUUID } from "node:crypto";
import {
  createDatabaseConnection,
  createRedisClient,
  deleteGeneratedRunRedisState,
  demoRuns,
  getPostgresInventoryStatus,
  initializeInventory,
  PostgresStockReservations,
  products,
  saleOffers,
  terminalDemoRunTransitionLockKey,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryStatusReader } from "../src/runtime/inventory-status-reader.js";
import { createTerminalInventoryReadOperation } from "../src/runtime/terminal-inventory-read-operation.js";

let connection: ReturnType<typeof createDatabaseConnection>;
let redis: ReturnType<typeof createRedisClient>;
let scope: { runId: string; saleOfferId: string };

beforeEach(async () => {
  await resetTestDatabase();
  connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
  redis = createRedisClient(requireRedisUrl(), { lazyConnect: true });
  scope = { runId: randomUUID(), saleOfferId: randomUUID() };
  const productId = randomUUID();
  await connection.db
    .insert(products)
    .values({ id: productId, sku: productId, slug: productId, name: "Inventory read" });
  await connection.db.insert(saleOffers).values({
    id: scope.saleOfferId,
    productId,
    name: "Inventory read",
    allocatedStock: 3,
    saleStartsAt: new Date(),
    saleEndsAt: new Date(Date.now() + 60_000),
  });
  await createPurchaseRunFixture(connection.db, scope);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteGeneratedRunRedisState(redis, scope);
  redis.disconnect();
  await connection.close();
});

describe("mode-aware inventory reads", () => {
  it.each([
    "demo",
    "without_redis",
  ] as const)("reads the actual %s owner and reuses explicit context", async (executionMode) => {
    await connection.db.update(demoRuns).set({ executionMode }).where(eq(demoRuns.id, scope.runId));
    if (executionMode === "demo") {
      await initializeInventory(redis, {
        saleOfferId: scope.saleOfferId,
        allocatedStock: 3,
        run: { runId: scope.runId, status: "accepting" },
      });
    } else {
      await new PostgresStockReservations(connection.sql).initialize({
        ...scope,
        allocatedStock: 3,
      });
    }
    const reader = createInventoryStatusReader(connection.db, redis);
    const select = vi.spyOn(connection.db, "select");
    expect(await reader.getStatus(scope.saleOfferId)).toMatchObject({
      remainingStock: 3,
      reservedStock: 0,
    });
    expect(select).toHaveBeenCalledOnce();
    select.mockClear();
    expect(await reader.getStatus(scope.saleOfferId, { ...scope, executionMode })).toMatchObject({
      remainingStock: 3,
      reservedStock: 0,
    });
    expect(select).not.toHaveBeenCalled();
    if (executionMode === "without_redis") {
      expect(await redis.exists(`inventory:${scope.saleOfferId}:state`)).toBe(0);
    }
  });

  it("reads PostgreSQL under the actual terminal transaction with a pool of one", async () => {
    await new PostgresStockReservations(connection.sql).initialize({ ...scope, allocatedStock: 3 });
    const read = createTerminalInventoryReadOperation({
      redisUrl: requireRedisUrl(),
      timeoutMs: 1000,
    });
    await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(scope.runId)}))`,
      );
      const controller = new AbortController();
      const deadline = setTimeout(
        () => controller.abort(new Error("Terminal read timed out")),
        1000,
      );
      try {
        expect(
          await read.read({
            ...scope,
            executionMode: "without_redis",
            db: tx,
            observedAt: new Date(),
            signal: controller.signal,
          }),
        ).toMatchObject({ remainingStock: 3, pendingPersistenceCount: 0 });
        await tx.execute(sql`select 1`);
      } finally {
        clearTimeout(deadline);
      }
    });
  });
  it.each([
    false,
    true,
  ])("recovers transaction writes and timeout policy after a stalled read (abort=%s)", async (abort) => {
    await new PostgresStockReservations(connection.sql).initialize({ ...scope, allocatedStock: 3 });
    const read = createTerminalInventoryReadOperation(
      { redisUrl: requireRedisUrl(), timeoutMs: 30 },
      {
        createRedis: vi.fn(),
        readInventory: vi.fn(),
        readPostgresInventory: async (db, saleOfferId, observedAt) => {
          // Inject delay at the operation's real database boundary, under its timeout.
          await db.execute(sql`select pg_sleep(0.2)`);
          return getPostgresInventoryStatus(db, saleOfferId, observedAt);
        },
      },
    );
    await connection.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '2500', true)`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${terminalDemoRunTransitionLockKey(scope.runId)}))`,
      );
      const controller = new AbortController();
      const deadline = abort
        ? setTimeout(() => controller.abort(new Error("Read aborted")), 10)
        : undefined;
      try {
        await expect(
          read.read({
            ...scope,
            executionMode: "without_redis",
            db: tx,
            observedAt: new Date(),
            signal: controller.signal,
          }),
        ).rejects.toThrow();
      } finally {
        clearTimeout(deadline);
      }
      const [policy] = await tx.execute<{ timeout: string }>(
        sql`select current_setting('statement_timeout') as timeout`,
      );
      expect(policy?.timeout).toBe("2500ms");
      await tx
        .update(saleOffers)
        .set({ name: "Timeout recovered" })
        .where(eq(saleOffers.id, scope.saleOfferId));
      expect(await getPostgresInventoryStatus(tx, scope.saleOfferId)).toMatchObject({
        remainingStock: 3,
      });
    });
    const [committed] = await connection.db
      .select({ name: saleOffers.name })
      .from(saleOffers)
      .where(eq(saleOffers.id, scope.saleOfferId));
    expect(committed?.name).toBe("Timeout recovered");
  });
});

function requireRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error("TEST_REDIS_URL is required.");
  return url;
}
