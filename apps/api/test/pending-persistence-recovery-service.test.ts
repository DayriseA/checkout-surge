import type { SecuredReservationHold } from "@checkout-surge/contracts";
import { inventoryKeys } from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  PendingPersistenceDiscoveryDeadlineError,
  PendingPersistenceRecoveryService,
} from "../src/services/pending-persistence-recovery-service.js";

const hold: SecuredReservationHold & { runId: string } = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlationId: "recovery-test",
  quantity: 1,
  reservationToken: "res_recovery",
  securedAt: "2026-06-20T00:00:00.000Z",
  expiresAt: "2026-06-20T00:15:00.000Z",
};

/** Models the `ZADD key [XX] score member` shape the pending readers use. */
function parseZaddArguments(...args: (string | number)[]) {
  const condition = args[0] === "XX" || args[0] === "NX" ? String(args[0]) : undefined;
  const [score, member] = condition ? args.slice(1) : args;
  return { condition, score: Number(score), member: String(member) };
}

function pendingRedis() {
  const keys = inventoryKeys(hold.saleOfferId);
  const record = {
    ...hold,
    idempotencyKey: "recovery-key",
    recoveryAttemptCount: 0,
    recoveryStatus: "pending",
    nextRecoveryAt: hold.securedAt,
    recoveryDeadlineAt: undefined as string | undefined,
  };
  let score: number | null = Date.parse(hold.securedAt);
  return {
    record,
    removeCursor() {
      score = null;
    },
    get score() {
      return score;
    },
    redis: {
      zrange: vi.fn(async (key: string) =>
        key === keys.pendingPersistence && score !== null ? [hold.id] : [],
      ),
      zrangebyscore: vi.fn(async (key: string, _minimum: string, maximum: number) =>
        key === keys.pendingPersistence && score !== null && score <= maximum ? [hold.id] : [],
      ),
      zscore: vi.fn(async (key: string, id: string) =>
        key === keys.pendingPersistence && id === hold.id && score !== null ? String(score) : null,
      ),
      zadd: vi.fn(async (_key: string, ...args: (string | number)[]) => {
        const command = parseZaddArguments(...args);
        if (command.member !== hold.id) return 0;
        const exists = score !== null;
        if (command.condition === "XX" && !exists) return 0;
        score = command.score;
        return exists ? 0 : 1;
      }),
      hget: vi.fn(async (key: string, id: string) => {
        if (id !== hold.id) return null;
        if (key === keys.pendingPersistenceRecords) return JSON.stringify(record);
        if (key === keys.reservations) return JSON.stringify(hold);
        return null;
      }),
      eval: vi.fn(async (...args: unknown[]) => {
        if (score === null) return "removed";
        record.recoveryAttemptCount = Number(args[5]);
        record.recoveryStatus = String(args[6]);
        record.nextRecoveryAt = String(args[7]);
        record.recoveryDeadlineAt = String(args[8]);
        score = Number(args[10]);
        return record.recoveryStatus === "exhausted" ? "exhausted" : "deferred";
      }),
    },
  };
}

function pendingRedisFor(reservations: SecuredReservationHold[]) {
  const states = new Map(
    reservations.map((reservation) => [
      reservation.id,
      {
        reservation,
        record: {
          ...reservation,
          idempotencyKey: `recovery-key-${reservation.id}`,
          recoveryAttemptCount: 0,
          recoveryStatus: "pending",
          nextRecoveryAt: reservation.securedAt,
          recoveryDeadlineAt: undefined as string | undefined,
        },
        score: Date.parse(reservation.securedAt),
      },
    ]),
  );
  const stateForKey = (key: string) =>
    [...states.values()].find((state) => {
      const keys = inventoryKeys(state.reservation.saleOfferId);
      return key === keys.pendingPersistence || key === keys.pendingPersistenceRecords;
    });
  return {
    states,
    redis: {
      zrangebyscore: vi.fn(async (key: string, _minimum: string, maximum: number) => {
        const state = stateForKey(key);
        return state && state.score <= maximum ? [state.reservation.id] : [];
      }),
      zscore: vi.fn(async (key: string, id: string) => {
        const state = states.get(id);
        return state && key === inventoryKeys(state.reservation.saleOfferId).pendingPersistence
          ? String(state.score)
          : null;
      }),
      hget: vi.fn(async (key: string, id: string) => {
        const state = states.get(id);
        if (!state) return null;
        const keys = inventoryKeys(state.reservation.saleOfferId);
        if (key === keys.pendingPersistenceRecords) return JSON.stringify(state.record);
        if (key === keys.reservations) return JSON.stringify(state.reservation);
        return null;
      }),
      zadd: vi.fn(async (_key: string, ...args: (string | number)[]) => {
        const command = parseZaddArguments(...args);
        const state = states.get(command.member);
        // Cursor presence is the map entry here, so an unknown member covers the `XX` guard.
        if (!state) return 0;
        state.score = command.score;
        return 0;
      }),
      eval: vi.fn(async (...args: unknown[]) => {
        const id = String(args[4]);
        const state = states.get(id);
        if (!state) return "removed";
        state.record.recoveryAttemptCount = Number(args[5]);
        state.record.recoveryStatus = String(args[6]);
        state.record.nextRecoveryAt = String(args[7]);
        state.record.recoveryDeadlineAt = String(args[8]);
        state.score = Number(args[10]);
        return state.record.recoveryStatus === "exhausted" ? "exhausted" : "deferred";
      }),
    },
  };
}

function persisted(reservation: SecuredReservationHold = hold) {
  return {
    reservation,
    order: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      publicOrderId: "ord_recovery",
      saleOfferId: reservation.saleOfferId,
      reservationId: reservation.id,
      correlationId: reservation.correlationId,
      ...(reservation.runId ? { runId: reservation.runId } : {}),
      quantity: reservation.quantity,
      status: "queued" as const,
      queuedAt: reservation.securedAt,
    },
  };
}

function audit() {
  return {
    recordAttempt: vi.fn(async () => undefined),
    markResolved: vi.fn(async () => undefined),
    markExhausted: vi.fn(async () => undefined),
  };
}

describe("PendingPersistenceRecoveryService", () => {
  it("is the run-scoped owner that materializes, deterministically enqueues, and promotes", async () => {
    const pending = pendingRedis();
    const durable = persisted();
    const persistSecuredReservation = vi.fn(async () => durable);
    const enqueue = vi.fn(async () => undefined);
    const promoteAccepted = vi.fn(async () => undefined);
    const recoveryAudit = audit();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await expect(service.runOnce()).resolves.toMatchObject({
      discovered: 1,
      attempted: 1,
      resolved: 1,
    });
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ reservationId: hold.id }));
    expect(promoteAccepted).toHaveBeenCalledOnce();
    expect(recoveryAudit.recordAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 1 }),
    );
    expect(recoveryAudit.markResolved).toHaveBeenCalledOnce();
  });

  it("uses deterministic bounded backoff and leaves an exhausted hold visible", async () => {
    const pending = pendingRedis();
    const recoveryAudit = audit();
    let now = new Date(hold.securedAt);
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => {
          throw new Error("postgres unavailable");
        }),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 60,
      maxAttempts: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 4_000,
      pollIntervalMs: 100,
      logger: createSilentLogger("api"),
      now: () => now,
    });

    await service.runOnce();
    expect(pending.record).toMatchObject({
      recoveryAttemptCount: 1,
      recoveryStatus: "pending",
      nextRecoveryAt: "2026-06-20T00:00:01.000Z",
    });

    now = new Date("2026-06-20T00:00:00.500Z");
    await expect(service.runOnce()).resolves.toMatchObject({ attempted: 0 });
    now = new Date("2026-06-20T00:00:01.000Z");
    await service.runOnce();
    expect(pending.record.nextRecoveryAt).toBe("2026-06-20T00:00:03.000Z");
    now = new Date("2026-06-20T00:00:03.000Z");
    await service.runOnce();

    expect(pending.record).toMatchObject({ recoveryAttemptCount: 3, recoveryStatus: "exhausted" });
    expect(recoveryAudit.markExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: hold, attemptCount: 3 }),
    );
  });

  it("caps exponential backoff and exhausts exactly at the max-attempt boundary", async () => {
    const pending = pendingRedis();
    const recoveryAudit = audit();
    let now = new Date(hold.securedAt);
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => {
          throw new Error("postgres unavailable");
        }),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 60,
      maxAttempts: 5,
      initialBackoffMs: 1_000,
      maxBackoffMs: 1_500,
      logger: createSilentLogger("api"),
      now: () => now,
    });

    for (const expectedNext of [
      "2026-06-20T00:00:01.000Z",
      "2026-06-20T00:00:02.500Z",
      "2026-06-20T00:00:04.000Z",
      "2026-06-20T00:00:05.500Z",
    ]) {
      await service.runOnce();
      expect(pending.record.nextRecoveryAt).toBe(expectedNext);
      now = new Date(expectedNext);
    }
    await service.runOnce();

    expect(pending.record).toMatchObject({ recoveryAttemptCount: 5, recoveryStatus: "exhausted" });
    expect(recoveryAudit.markExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 5 }),
    );
  });

  it("coalesces concurrent scheduler and request attempts for one reservation", async () => {
    const pending = pendingRedis();
    const durable = persisted();
    const persistSecuredReservation = vi.fn(async () => durable);
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    const [, replay] = await Promise.all([
      service.runOnce(),
      service.recoverReservation({ reservation: hold, idempotencyKey: "recovery-key" }),
    ]);

    expect(replay).toEqual(durable);
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
  });

  it("does not let request replay bypass the stored next-attempt time", async () => {
    const pending = pendingRedis();
    const durable = persisted();
    const recoveryAudit = audit();
    const persistSecuredReservation = vi.fn(async () => durable);
    let now = new Date(hold.securedAt);
    pending.record.nextRecoveryAt = "2026-06-20T00:00:05.000Z";
    await pending.redis.zadd("pending", Date.parse(pending.record.nextRecoveryAt), hold.id);
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => now,
    });

    await expect(
      service.recoverReservation({ reservation: hold, idempotencyKey: "recovery-key" }),
    ).resolves.toBeNull();
    await expect(
      service.recoverReservation({ reservation: hold, idempotencyKey: "recovery-key" }),
    ).resolves.toBeNull();
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(recoveryAudit.recordAttempt).not.toHaveBeenCalled();

    now = new Date(pending.record.nextRecoveryAt);
    await expect(
      service.recoverReservation({ reservation: hold, idempotencyKey: "recovery-key" }),
    ).resolves.toEqual(durable);
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(recoveryAudit.recordAttempt).toHaveBeenCalledOnce();
  });

  it("uses an exact reservation lookup for request replay beyond a scheduler page", async () => {
    const pending = pendingRedis();
    const durable = persisted();
    pending.redis.zrange.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => `earlier-${index}`),
    );
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => durable),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await expect(
      service.recoverReservation({ reservation: hold, idempotencyKey: "recovery-key" }),
    ).resolves.toEqual(durable);
    expect(pending.redis.zrange).not.toHaveBeenCalled();
    expect(pending.redis.zscore).toHaveBeenCalledWith(expect.any(String), hold.id);
  });

  it("keeps Redis pending when attempt or resolution audit persistence fails", async () => {
    const pending = pendingRedis();
    const promoteAccepted = vi.fn(async () => undefined);
    const recoveryAudit = audit();
    recoveryAudit.recordAttempt.mockRejectedValueOnce(new Error("audit unavailable"));
    const persistSecuredReservation = vi.fn(async () => persisted());
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await service.runOnce();
    expect(persistSecuredReservation).not.toHaveBeenCalled();
    expect(promoteAccepted).not.toHaveBeenCalled();
    expect(pending.record).toMatchObject({ recoveryAttemptCount: 0, recoveryStatus: "pending" });

    pending.record.nextRecoveryAt = hold.securedAt;
    await pending.redis.zadd("pending", Date.parse(hold.securedAt), hold.id);
    recoveryAudit.markResolved.mockRejectedValueOnce(new Error("resolution audit unavailable"));
    await service.runOnce();
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(promoteAccepted).not.toHaveBeenCalled();
    expect(pending.record).toMatchObject({ recoveryAttemptCount: 1, recoveryStatus: "pending" });
  });

  it("persists durable resolution before removing the Redis cursor", async () => {
    const pending = pendingRedis();
    const calls: string[] = [];
    const durable = persisted();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        getPersistedBuyByReservationId: vi.fn(async () => null),
        persistSecuredReservation: vi.fn(async () => {
          calls.push("materialize");
          return durable;
        }),
      },
      audit: {
        recordAttempt: vi.fn(async () => {
          calls.push("audit_attempt");
        }),
        markResolved: vi.fn(async () => {
          calls.push("audit_resolved");
        }),
        markExhausted: vi.fn(async () => undefined),
      },
      stockReservations: {
        promoteAccepted: vi.fn(async () => {
          calls.push("redis_promoted");
        }),
      },
      orderProcessJobPublisher: {
        enqueue: vi.fn(async () => {
          calls.push("enqueued");
        }),
      },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await service.runOnce();
    expect(calls).toEqual([
      "audit_attempt",
      "materialize",
      "enqueued",
      "audit_resolved",
      "redis_promoted",
    ]);
  });

  it("keeps a promotion failure discoverable and converges from existing durable rows", async () => {
    const pending = pendingRedis();
    const durable = persisted();
    let durableExists = false;
    let now = new Date(hold.securedAt);
    const persistSecuredReservation = vi.fn(async () => {
      durableExists = true;
      return durable;
    });
    const promoteAccepted = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("redis promotion unavailable"))
      .mockResolvedValue(undefined);
    const recoveryAudit = audit();
    const markDirty = vi.fn();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => (durableExists ? durable : null)),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      businessOutcomeUpdates: { markDirty },
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => now,
    });

    await service.runOnce();
    expect(pending.record).toMatchObject({ recoveryAttemptCount: 1, recoveryStatus: "pending" });
    expect(recoveryAudit.recordAttempt).toHaveBeenCalledTimes(2);
    expect(promoteAccepted).toHaveBeenCalledOnce();

    now = new Date(pending.record.nextRecoveryAt);
    await service.runOnce();
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(promoteAccepted).toHaveBeenCalledTimes(2);
    expect(recoveryAudit.markResolved).toHaveBeenCalledTimes(2);
    expect(markDirty).toHaveBeenCalledTimes(2);
  });

  it("keeps resolved audit truth when promotion applied but its response was lost", async () => {
    const pending = pendingRedis();
    const durable = persisted();
    const recoveryAudit = audit();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => durable),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: {
        promoteAccepted: vi.fn(async () => {
          pending.removeCursor();
          throw new Error("promotion response lost");
        }),
      },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await expect(service.runOnce()).resolves.toMatchObject({ resolved: 1, deferred: 0 });
    expect(recoveryAudit.recordAttempt).toHaveBeenCalledOnce();
    expect(recoveryAudit.markResolved).toHaveBeenCalledOnce();
    expect(recoveryAudit.markExhausted).not.toHaveBeenCalled();
  });

  it("does not overwrite resolved audit with exhaustion after concurrent cursor removal", async () => {
    const pending = pendingRedis();
    const recoveryAudit = audit();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: {
        promoteAccepted: vi.fn(async () => {
          pending.removeCursor();
          throw new Error("concurrent resolution");
        }),
      },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      maxAttempts: 1,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await expect(service.runOnce()).resolves.toMatchObject({ resolved: 1, exhausted: 0 });
    expect(recoveryAudit.recordAttempt).toHaveBeenCalledOnce();
    expect(recoveryAudit.markResolved).toHaveBeenCalledOnce();
    expect(recoveryAudit.markExhausted).not.toHaveBeenCalled();
  });

  it("uses fresh time after a slow failed operation when deciding exhaustion", async () => {
    const pending = pendingRedis();
    let now = new Date(hold.securedAt);
    const recoveryAudit = audit();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => {
          now = new Date("2026-06-20T00:00:01.000Z");
          throw new Error("slow postgres failure");
        }),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 1,
      pollIntervalMs: 10,
      logger: createSilentLogger("api"),
      now: () => now,
    });

    await expect(service.runOnce()).resolves.toMatchObject({ exhausted: 1 });
    expect(pending.record.recoveryStatus).toBe("exhausted");
    expect(recoveryAudit.markExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ exhaustedAt: new Date("2026-06-20T00:00:01.000Z") }),
    );
  });

  it("refreshes time before admitting each record in a pass", async () => {
    const secondHold: SecuredReservationHold & { runId: string } = {
      ...hold,
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      saleOfferId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      correlationId: "second-recovery-test",
    };
    const pending = pendingRedisFor([hold, secondHold]);
    let now = new Date(hold.securedAt);
    const recoveryAudit = audit();
    const persistSecuredReservation = vi.fn(
      async ({ reservation }: { reservation: SecuredReservationHold }) => persisted(reservation),
    );
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation,
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: {
        enqueue: vi.fn(async () => {
          now = new Date("2026-06-20T00:00:01.000Z");
        }),
      },
      listRunScopes: async () => [
        { runId: hold.runId, saleOfferId: hold.saleOfferId },
        { runId: secondHold.runId, saleOfferId: secondHold.saleOfferId },
      ],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 1,
      pollIntervalMs: 10,
      logger: createSilentLogger("api"),
      now: () => now,
    });

    await expect(service.runOnce()).resolves.toMatchObject({
      discovered: 2,
      attempted: 1,
      resolved: 1,
      exhausted: 1,
    });
    expect(persistSecuredReservation).toHaveBeenCalledOnce();
    expect(recoveryAudit.markExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: secondHold, attemptCount: 0 }),
    );
  });

  it("honors a persisted deadline across restart/config changes and exhausts truthfully", async () => {
    const pending = pendingRedis();
    const firstAudit = audit();
    const failingPersistence = {
      persistSecuredReservation: vi.fn(async () => {
        throw new Error("postgres unavailable");
      }),
      getPersistedBuyByReservationId: vi.fn(async () => null),
    };
    const first = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: failingPersistence,
      audit: firstAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 60,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });
    await first.runOnce();
    expect(pending.record.recoveryDeadlineAt).toBe("2026-06-20T00:01:00.000Z");

    const restartAudit = audit();
    const restarted = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: failingPersistence,
      audit: restartAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 3_600,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:01:00.000Z"),
    });
    await restarted.runOnce();

    expect(failingPersistence.persistSecuredReservation).toHaveBeenCalledOnce();
    expect(restartAudit.recordAttempt).not.toHaveBeenCalled();
    expect(restartAudit.markExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ attemptCount: 1, exhaustedAt: new Date("2026-06-20T00:01:00Z") }),
    );
    expect(pending.record.recoveryStatus).toBe("exhausted");
  });

  it("creates zero-attempt durable exhaustion evidence when first seen after the window", async () => {
    const pending = pendingRedis();
    const recoveryAudit = audit();
    const persistence = {
      persistSecuredReservation: vi.fn(async () => persisted()),
      getPersistedBuyByReservationId: vi.fn(async () => null),
    };
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence,
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 30,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:30.000Z"),
    });

    await expect(service.runOnce()).resolves.toMatchObject({ attempted: 0, exhausted: 1 });
    expect(persistence.persistSecuredReservation).not.toHaveBeenCalled();
    expect(recoveryAudit.recordAttempt).not.toHaveBeenCalled();
    expect(recoveryAudit.markExhausted).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: hold, attemptCount: 0 }),
    );
  });

  it("keeps Redis authoritatively exhausted when exhaustion audit is unavailable", async () => {
    const pending = pendingRedis();
    const recoveryAudit = audit();
    recoveryAudit.markExhausted.mockRejectedValueOnce(new Error("audit unavailable"));
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: recoveryAudit,
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
      idempotencyTtlSeconds: 1_800,
      recoveryWindowSeconds: 30,
      pollIntervalMs: 10,
      logger: createSilentLogger("api"),
      now: () => new Date("2026-06-20T00:00:30.000Z"),
    });

    await expect(service.runOnce()).resolves.toMatchObject({ exhausted: 1 });
    expect(pending.record).toMatchObject({ recoveryAttemptCount: 0, recoveryStatus: "exhausted" });
  });

  it("cancels a first tick that has not run on close", async () => {
    const pending = pendingRedis();
    const callbacks: Array<() => void> = [];
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return timer;
    });
    const cancelSchedule = vi.fn();
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [],
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      schedule,
      cancelSchedule,
    });

    service.start();
    await service.close();
    expect(cancelSchedule).toHaveBeenCalledWith(timer);
    expect(callbacks).toHaveLength(1);
  });

  it("reschedules after a failed pass", async () => {
    const pending = pendingRedis();
    const callbacks: Array<() => void> = [];
    const schedule = vi.fn((callback: () => void) => {
      callbacks.push(callback);
      return { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
    });
    const listRunScopes = vi
      .fn<() => Promise<Array<{ runId: string; saleOfferId: string }>>>()
      .mockRejectedValueOnce(new Error("scope read failed"))
      .mockResolvedValue([]);
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes,
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      schedule,
      cancelSchedule: vi.fn(),
    });

    service.start();
    callbacks[0]?.();
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledTimes(2));
    expect(listRunScopes).toHaveBeenCalledOnce();
    await service.close();
  });

  it("aborts a hung scope query at the discovery deadline and admits a later pass", async () => {
    const pending = pendingRedis();
    let scopeReadCount = 0;
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => {
          throw new Error("postgres unavailable");
        }),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async (signal) => {
        scopeReadCount += 1;
        if (scopeReadCount > 1) {
          return [{ runId: hold.runId, saleOfferId: hold.saleOfferId }];
        }
        return new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => reject(signal.reason);
          signal.addEventListener("abort", rejectForAbort, { once: true });
          if (signal.aborted) rejectForAbort();
        });
      },
      idempotencyTtlSeconds: 1_800,
      discoveryTimeoutMs: 10,
      maxAttempts: 1,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    await expect(service.runOnce()).rejects.toBeInstanceOf(
      PendingPersistenceDiscoveryDeadlineError,
    );
    await expect(service.runOnce()).resolves.toMatchObject({ attempted: 1, exhausted: 1 });
    expect(scopeReadCount).toBe(2);
  });

  it("normalizes close-triggered discovery cancellation but still surfaces an unrelated failure", async () => {
    const pending = pendingRedis();
    let discoveryStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async (signal) => {
        discoveryStarted?.();
        return new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => reject(signal.reason);
          signal.addEventListener("abort", rejectForAbort, { once: true });
          if (signal.aborted) rejectForAbort();
        });
      },
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
    });
    const pass = service.runOnce();
    await started;

    await expect(Promise.all([pass, service.close()])).resolves.toBeDefined();

    const unexpected = new Error("unrelated discovery failure");
    let secondStarted: (() => void) | undefined;
    const secondReady = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const failingService = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async (signal) => {
        secondStarted?.();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(unexpected), { once: true });
        });
      },
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
    });
    const failingPass = failingService.runOnce();
    await secondReady;
    const failingClose = failingService.close();

    await expect(failingPass).rejects.toBe(unexpected);
    await expect(failingClose).rejects.toMatchObject({ errors: [unexpected] });
  });

  it("caps distinct direct attempts and drains admitted work during close", async () => {
    const reservations = [
      hold,
      {
        ...hold,
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        saleOfferId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
      {
        ...hold,
        id: "11111111-1111-4111-8111-111111111111",
        saleOfferId: "22222222-2222-4222-8222-222222222222",
      },
    ];
    const pending = pendingRedisFor(reservations);
    const openedReservationIds: string[] = [];
    const closedScopes: string[] = [];
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [],
      openAttemptScope: async ({ signal }) => {
        let reservationId = "";
        return {
          persistence: {
            persistSecuredReservation: vi.fn(async () => persisted()),
            getPersistedBuyByReservationId: async (inputReservationId) => {
              reservationId = inputReservationId;
              openedReservationIds.push(inputReservationId);
              return new Promise<never>((_resolve, reject) => {
                const rejectForAbort = () => reject(signal.reason);
                signal.addEventListener("abort", rejectForAbort, { once: true });
                if (signal.aborted) rejectForAbort();
              });
            },
          },
          audit: audit(),
          stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
          orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
          close: async () => {
            closedScopes.push(reservationId);
          },
        };
      },
      idempotencyTtlSeconds: 1_800,
      maxConcurrentDirectAttempts: 2,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    const recoveries = reservations.map((reservation) =>
      service.recoverReservation({
        reservation,
        idempotencyKey: `recovery-key-${reservation.id}`,
      }),
    );
    await vi.waitFor(() => expect(openedReservationIds).toHaveLength(2));
    await expect(recoveries[2]).resolves.toBeNull();

    await expect(Promise.all([service.close(), ...recoveries])).resolves.toBeDefined();
    expect(new Set(openedReservationIds).size).toBe(2);
    expect(closedScopes).toHaveLength(2);
  });

  it("waits for an active pass during close", async () => {
    const pending = pendingRedis();
    let releaseScopes: (() => void) | undefined;
    const scopesBlocked = new Promise<void>((resolve) => {
      releaseScopes = resolve;
    });
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => {
        await scopesBlocked;
        return [];
      },
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
    });
    const pass = service.runOnce();
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);
    releaseScopes?.();
    await Promise.all([pass, closing]);
    expect(closed).toBe(true);
  });

  it("cancels an active attempt, drains it, and rejects new admission during close", async () => {
    const pending = pendingRedis();
    const scopeClose = vi.fn(async () => undefined);
    const closeDiscovery = vi.fn(async () => undefined);
    const listRunScopes = vi.fn(async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }]);
    const getPersistedBuyByReservationId = vi.fn(
      async (_reservationId: string, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          const rejectForAbort = () => reject(signal?.reason);
          signal?.addEventListener("abort", rejectForAbort, { once: true });
          if (signal?.aborted) rejectForAbort();
        }),
    );
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes,
      openAttemptScope: async ({ signal }) => ({
        persistence: {
          persistSecuredReservation: vi.fn(async () => persisted()),
          getPersistedBuyByReservationId: (reservationId) =>
            getPersistedBuyByReservationId(reservationId, signal),
        },
        audit: audit(),
        stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
        orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
        close: scopeClose,
      }),
      closeDiscovery,
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    const pass = service.runOnce();
    await vi.waitFor(() => expect(getPersistedBuyByReservationId).toHaveBeenCalledOnce());
    const firstClose = service.close();
    expect(service.close()).toBe(firstClose);
    await expect(Promise.all([pass, firstClose])).resolves.toBeDefined();
    await expect(service.runOnce()).resolves.toEqual({
      discovered: 0,
      attempted: 0,
      materialized: 0,
      resolved: 0,
      deferred: 0,
      exhausted: 0,
    });
    await expect(
      service.recoverReservation({ reservation: hold, idempotencyKey: "recovery-key" }),
    ).resolves.toBeNull();
    expect(closeDiscovery).toHaveBeenCalledOnce();
    expect(scopeClose).toHaveBeenCalledOnce();
    expect(listRunScopes).toHaveBeenCalledOnce();
  });

  it("surfaces an unexpected attempt-scope cleanup failure during close", async () => {
    const pending = pendingRedis();
    const cleanupError = new Error("attempt scope cleanup failed");
    let attemptStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      attemptStarted = resolve;
    });
    const service = new PendingPersistenceRecoveryService({
      redis: pending.redis as never,
      persistence: {
        persistSecuredReservation: vi.fn(async () => persisted()),
        getPersistedBuyByReservationId: vi.fn(async () => null),
      },
      audit: audit(),
      stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
      orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
      listRunScopes: async () => [],
      openAttemptScope: async ({ signal }) => ({
        persistence: {
          persistSecuredReservation: vi.fn(async () => persisted()),
          getPersistedBuyByReservationId: async () => {
            attemptStarted?.();
            return new Promise<never>((_resolve, reject) => {
              const rejectForAbort = () => reject(signal.reason);
              signal.addEventListener("abort", rejectForAbort, { once: true });
              if (signal.aborted) rejectForAbort();
            });
          },
        },
        audit: audit(),
        stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
        orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
        close: async () => {
          throw cleanupError;
        },
      }),
      idempotencyTtlSeconds: 1_800,
      logger: createSilentLogger("api"),
      now: () => new Date(hold.securedAt),
    });

    const attempt = service.recoverReservation({
      reservation: hold,
      idempotencyKey: "recovery-key",
    });
    await started;
    const closing = service.close();

    await expect(attempt).rejects.toBe(cleanupError);
    await expect(closing).rejects.toMatchObject({ errors: [cleanupError] });
  });

  it("interrupts a subordinate attempt at the persisted deadline", async () => {
    vi.useFakeTimers();
    try {
      const pending = pendingRedis();
      const scopeClose = vi.fn(async () => undefined);
      let scopeCount = 0;
      const service = new PendingPersistenceRecoveryService({
        redis: pending.redis as never,
        persistence: {
          persistSecuredReservation: vi.fn(async () => persisted()),
          getPersistedBuyByReservationId: vi.fn(async () => null),
        },
        audit: audit(),
        stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
        orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
        listRunScopes: async () => [{ runId: hold.runId, saleOfferId: hold.saleOfferId }],
        openAttemptScope: async ({ signal }) => {
          scopeCount += 1;
          const scopeAudit = audit();
          return {
            persistence: {
              persistSecuredReservation: vi.fn(async () => persisted()),
              getPersistedBuyByReservationId: vi.fn(
                async () =>
                  new Promise<never>((_resolve, reject) => {
                    const rejectForAbort = () => reject(signal.reason);
                    signal.addEventListener("abort", rejectForAbort, { once: true });
                    if (signal.aborted) rejectForAbort();
                  }),
              ),
            },
            audit: scopeAudit,
            stockReservations: { promoteAccepted: vi.fn(async () => undefined) },
            orderProcessJobPublisher: { enqueue: vi.fn(async () => undefined) },
            close: scopeClose,
          };
        },
        idempotencyTtlSeconds: 1_800,
        recoveryWindowSeconds: 1,
        pollIntervalMs: 10,
        logger: createSilentLogger("api"),
        now: () => new Date(hold.securedAt),
      });

      const pass = service.runOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pass).resolves.toMatchObject({ exhausted: 1 });
      expect(pending.record.recoveryStatus).toBe("exhausted");
      expect(scopeCount).toBe(2);
      expect(scopeClose).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
