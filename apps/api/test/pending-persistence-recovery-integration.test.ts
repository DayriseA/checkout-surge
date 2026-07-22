import type { SecuredReservationHold } from "@checkout-surge/contracts";
import {
  createAbortableDatabaseConnection,
  createRedisClient,
  initializeInventory,
  inventoryKeys,
  reserveInventoryStock,
} from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { PendingPersistenceRecoveryService } from "../src/services/pending-persistence-recovery-service.js";

const hold: SecuredReservationHold = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000091",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000091",
  correlationId: "recovery-integration",
  quantity: 1,
  reservationToken: "recovery-integration-token",
  securedAt: "2026-06-20T00:00:00.000Z",
  expiresAt: "2026-06-20T00:15:00.000Z",
};

describe("pending-persistence recovery cancellation boundaries", () => {
  it("closes during an actual abortable PostgreSQL discovery statement", async () => {
    const databaseUrl = requireTestDatabaseUrl();
    const redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    let discoveryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });
    const service = new PendingPersistenceRecoveryService({
      redis,
      persistence: noOpPersistence(),
      audit: noOpAudit(),
      stockReservations: { promoteAccepted: async () => undefined },
      orderProcessJobPublisher: { enqueue: async () => undefined },
      listRunScopes: async (signal) => {
        const operation = createAbortableDatabaseConnection(databaseUrl, signal, { max: 1 });
        try {
          const query = operation.sql`select pg_sleep(30)`;
          discoveryStarted?.();
          await query;
          return [];
        } finally {
          await operation.close();
        }
      },
      closeDiscovery: async () => redis.disconnect(),
      idempotencyTtlSeconds: 1_800,
      discoveryTimeoutMs: 30_000,
      logger: createSilentLogger("api"),
    });

    const pass = service.runOnce();
    await started;

    await expect(within(Promise.all([pass, service.close()]))).resolves.toBeDefined();
  });

  it("disconnects an actual blocked Redis command in an exact direct attempt", async () => {
    const redisUrl = requireTestRedisUrl();
    const discoveryRedis = createRedisClient(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    const operationRedis = createRedisClient(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
    });
    const keys = inventoryKeys(hold.saleOfferId);
    await initializeInventory(discoveryRedis, { saleOfferId: hold.saleOfferId, allocatedStock: 1 });
    await reserveInventoryStock(discoveryRedis, {
      reservation: hold,
      idempotencyKey: "recovery-integration-key",
      idempotencyTtlSeconds: 1_800,
    });
    let promotionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      promotionStarted = resolve;
    });
    const durable = {
      reservation: hold,
      order: {
        id: "dddddddd-dddd-4ddd-8ddd-000000000091",
        publicOrderId: "ord_recovery_integration",
        reservationId: hold.id,
        saleOfferId: hold.saleOfferId,
        correlationId: hold.correlationId,
        quantity: hold.quantity,
        status: "queued" as const,
        queuedAt: hold.securedAt,
      },
    };
    const scopeClose = vi.fn(async () => operationRedis.disconnect());
    const service = new PendingPersistenceRecoveryService({
      redis: discoveryRedis,
      persistence: noOpPersistence(),
      audit: noOpAudit(),
      stockReservations: { promoteAccepted: async () => undefined },
      orderProcessJobPublisher: { enqueue: async () => undefined },
      listRunScopes: async () => [],
      openAttemptScope: async ({ signal }) => {
        const disconnect = () => operationRedis.disconnect();
        signal.addEventListener("abort", disconnect, { once: true });
        return {
          persistence: {
            persistSecuredReservation: async () => durable,
            getPersistedBuyByReservationId: async () => durable,
          },
          audit: noOpAudit(),
          stockReservations: {
            promoteAccepted: async () => {
              promotionStarted?.();
              await operationRedis.brpop("pending-persistence-recovery-never", 0);
            },
          },
          orderProcessJobPublisher: { enqueue: async () => undefined },
          close: async () => {
            signal.removeEventListener("abort", disconnect);
            await scopeClose();
          },
        };
      },
      closeDiscovery: async () => discoveryRedis.disconnect(),
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    try {
      const attempt = service.recoverReservation({
        reservation: hold,
        idempotencyKey: "recovery-integration-key",
      });
      await started;

      await expect(within(Promise.all([attempt, service.close()]))).resolves.toEqual([
        null,
        undefined,
      ]);
      expect(scopeClose).toHaveBeenCalledOnce();
    } finally {
      const inventoryKeysToDelete = await createRedisClient(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
      });
      try {
        const scopedKeys = await inventoryKeysToDelete.keys(`${keys.prefix}:*`);
        if (scopedKeys.length > 0) await inventoryKeysToDelete.unlink(...scopedKeys);
      } finally {
        inventoryKeysToDelete.disconnect();
        discoveryRedis.disconnect();
        operationRedis.disconnect();
      }
    }
  });
});

function noOpPersistence() {
  return {
    persistSecuredReservation: async () => {
      throw new Error("Unexpected persistence call.");
    },
    getPersistedBuyByReservationId: async () => null,
  };
}

function noOpAudit() {
  return {
    recordAttempt: async () => undefined,
    markResolved: async () => undefined,
    markExhausted: async () => undefined,
  };
}

function requireTestDatabaseUrl(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error("TEST_DATABASE_URL is required.");
  return value;
}

function requireTestRedisUrl(): string {
  const value = process.env.TEST_REDIS_URL;
  if (!value) throw new Error("TEST_REDIS_URL is required.");
  return value;
}

async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Recovery cancellation did not settle.")), 3_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
