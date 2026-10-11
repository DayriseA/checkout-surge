import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  buyResponseSchema,
  controlServiceTokenHeaderName,
  type SecuredReservationHold,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  getInventoryStatus,
  initializeInventory,
  markReservationPendingPersistence,
  orders,
  products,
  publicRuntimePolicies,
  reserveInventoryStock,
  saleOffers,
} from "@checkout-surge/db";
import {
  createPurchaseRunFixture,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "@checkout-surge/db/testing";
import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { buyerTimingFlushPath } from "../src/services/api-peer-protocol.js";
import { publicRuntimePolicyMutableFixture } from "./demo-administration-test-fixtures.js";

it("shares inventory and idempotency across actual buyer processes while control alone recovers pending holds", async () => {
  await resetTestDatabase();
  const connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 2 });
  const redisUrl = process.env.TEST_REDIS_URL;
  if (!redisUrl) throw new Error("TEST_REDIS_URL is required.");
  const redis = createRedisClient(redisUrl, { maxRetriesPerRequest: 3 });
  const children: ChildProcess[] = [];
  const runId = randomUUID();
  const saleOfferId = randomUUID();
  const productId = randomUUID();
  try {
    await redis.flushdb();
    await connection.db
      .insert(publicRuntimePolicies)
      .values({ policy: publicRuntimePolicyMutableFixture() });
    await connection.db.insert(products).values({
      id: productId,
      sku: "MULTIPROCESS-TEST",
      slug: "multiprocess-test",
      name: "Multi-process test",
    });
    await connection.db.insert(saleOffers).values({
      id: saleOfferId,
      productId,
      name: "Multi-process sale",
      allocatedStock: 3,
      saleStartsAt: new Date(Date.now() - 60_000),
      saleEndsAt: new Date(Date.now() + 60_000),
    });
    await createPurchaseRunFixture(connection.db, { runId, saleOfferId });
    await initializeInventory(redis, {
      run: { runId, status: "accepting" },
      saleOfferId,
      allocatedStock: 3,
    });
    const controlOrigin = `http://127.0.0.1:${await freePort()}`;
    const buyerOrigins = [
      `http://127.0.0.1:${await freePort()}`,
      `http://127.0.0.1:${await freePort()}`,
    ] as const;
    const baseEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      LOG_LEVEL: "warn",
      DATABASE_URL: requireTestDatabaseUrl(),
      REDIS_URL: redisUrl,
      PUBLIC_CLIENT_COOKIE_SECRET: "test-public-client-cookie-secret",
      CONTROL_SERVICE_TOKEN: "test-control-token",
      DEMO_RUN_FINALIZATION_POLL_INTERVAL_SECONDS: "60",
    };
    async function start(origin: string, extra: Record<string, string>) {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          "import { startApiServer } from './src/index.ts'; await startApiServer();",
        ],
        {
          cwd: process.cwd(),
          env: { ...baseEnv, HOST: "127.0.0.1", PORT: new URL(origin).port, ...extra },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(child);
      let output = "";
      child.stdout?.on("data", (data) => {
        output = (output + data).slice(-10_000);
      });
      child.stderr?.on("data", (data) => {
        output = (output + data).slice(-10_000);
      });
      await vi.waitFor(
        async () => {
          if (child.exitCode !== null) throw new Error(`API child exited: ${output}`);
          expect((await fetch(`${origin}/health/ready`)).status).toBe(200);
        },
        { timeout: 15_000, interval: 50 },
      );
    }
    await start(controlOrigin, {
      API_ROLE: "control",
      API_BUYER_BASE_URLS: buyerOrigins.join(","),
    });
    for (const origin of buyerOrigins)
      await start(origin, { API_ROLE: "buyer", API_CONTROL_BASE_URL: controlOrigin });
    expect(
      (
        await fetch(`${controlOrigin}/buy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404);
    for (const origin of buyerOrigins) {
      expect((await fetch(`${origin}/dashboard/recovery`)).status).toBe(404);
      expect(
        (await fetch(`${origin}/internal/reservations/recover`, { method: "POST" })).status,
      ).toBe(404);
    }
    const hold: SecuredReservationHold = {
      id: randomUUID(),
      runId,
      saleOfferId,
      quantity: 1,
      reservationToken: randomUUID(),
      correlationId: "cross-process-pending",
      securedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await reserveInventoryStock(redis, {
      reservation: hold,
      idempotencyKey: "shared-pending",
      idempotencyTtlSeconds: 1_800,
    });
    await markReservationPendingPersistence(redis, {
      reservation: hold,
      idempotencyKey: "shared-pending",
    });
    async function buy(origin: string, idempotencyKey: string) {
      const response = await fetch(`${origin}/buy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId, saleOfferId, quantity: 1, idempotencyKey }),
      });
      return { status: response.status, body: buyResponseSchema.parse(await response.json()) };
    }
    const recovered = await Promise.all(
      buyerOrigins.map((origin) => buy(origin, "shared-pending")),
    );
    for (const result of recovered) expect(result.body.outcome).toBe("reservation_secured");
    const durable = await connection.db.select().from(orders).where(eq(orders.runId, runId));
    expect(durable).toHaveLength(1);
    const accepted = await Promise.all(
      buyerOrigins.map((origin, index) => buy(origin, `distinct-${index}`)),
    );
    expect(
      accepted.every(
        (result) => result.status === 202 && result.body.outcome === "reservation_secured",
      ),
    ).toBe(true);
    expect((await buy(buyerOrigins[1], "sold-out")).body.outcome).toBe("sold_out");
    expect(await getInventoryStatus(redis, saleOfferId)).toMatchObject({
      remainingStock: 0,
      reservedStock: 3,
      pendingPersistenceCount: 0,
    });
    expect(await connection.db.select().from(orders).where(eq(orders.runId, runId))).toHaveLength(
      3,
    );
    for (const origin of buyerOrigins) {
      const response = await fetch(new URL(buyerTimingFlushPath, origin), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [controlServiceTokenHeaderName]: "test-control-token",
        },
        body: JSON.stringify({ runId }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mergeFailureGeneration: 0 });
    }
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited.finally(() => clearTimeout(timeout));
    }
    await redis.flushdb();
    redis.disconnect();
    await connection.close();
  }
}, 60_000);

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test TCP port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
