import {
  dashboardProjectionSchema,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  type CheckoutSurgeRedis,
  createRedisClient,
  dashboardProjectionRevisionKey,
  deleteGeneratedRunRedisState,
  initializeInventory,
} from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DashboardProjectionService,
  RedisDashboardProjectionRevisionAllocator,
} from "../src/services/dashboard-recovery-service.js";

const runId = "81111111-1111-4111-8111-111111111111";
const saleOfferId = "82222222-2222-4222-8222-222222222222";
const scope = { runId, saleOfferId };
const revisionKey = dashboardProjectionRevisionKey(runId);
const cleanupRedis = createRedisClient(requireTestRedisUrl(), {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

describe("dashboard projection revision restart ordering", () => {
  beforeEach(async () => {
    await deleteGeneratedRunRedisState(cleanupRedis, scope);
    await initializeInventory(cleanupRedis, {
      saleOfferId,
      allocatedStock: 250,
      run: { runId, status: "accepting" },
    });
  });
  afterEach(async () => deleteGeneratedRunRedisState(cleanupRedis, scope));
  afterAll(async () => {
    cleanupRedis.disconnect();
  });

  it("uses one schema and allocates a newer revision from a fresh service and Redis client", async () => {
    const firstService = projectionService();
    const recoveryProjection = await firstService.build({ correlationId: "recovery-1" });

    const restartedService = projectionService();
    const liveProjection = await restartedService.build({
      correlationId: "live-2",
      scope,
    });

    expect(dashboardProjectionSchema.parse(recoveryProjection).scopeId).toBe(
      dashboardProjectionScopeId(scope),
    );
    expect(dashboardProjectionSchema.parse(liveProjection).scopeId).toBe(
      dashboardProjectionScopeId(scope),
    );
    expect(recoveryProjection.revision).toBe(1);
    expect(liveProjection.revision).toBe(2);
  });

  it("retires allocation with exact Redis cleanup and never recreates revision one", async () => {
    const redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const allocator = new RedisDashboardProjectionRevisionAllocator(redis);

    await expect(allocator.allocate(scope)).resolves.toBe(1);
    await deleteGeneratedRunRedisState(cleanupRedis, scope);

    await expect(allocator.allocate(scope)).rejects.toThrow(/scope.*retired/i);
    await expect(cleanupRedis.get(revisionKey)).resolves.toBeNull();
    redis.disconnect();
  });

  it("serializes a concurrent allocation and exact cleanup at the Redis retirement fence", async () => {
    const redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    const allocator = new RedisDashboardProjectionRevisionAllocator(redis);

    try {
      const [allocation, cleanup] = await Promise.allSettled([
        allocator.allocate(scope),
        deleteGeneratedRunRedisState(cleanupRedis, scope),
      ]);

      expect(cleanup.status).toBe("fulfilled");
      if (allocation.status === "fulfilled") {
        expect(allocation.value).toBe(1);
      } else {
        expect(allocation.reason).toBeInstanceOf(Error);
        expect((allocation.reason as Error).message).toMatch(/scope.*retired/i);
      }
      await expect(allocator.allocate(scope)).rejects.toThrow(/scope.*retired/i);
      await expect(cleanupRedis.get(revisionKey)).resolves.toBeNull();
    } finally {
      redis.disconnect();
    }
  });
});

function projectionService(): DashboardProjectionService {
  return new DashboardProjectionService({
    logger: createSilentLogger("api"),
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    openOperation: async () => {
      const redis = createRedisClient(requireTestRedisUrl(), {
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      });
      return operation(redis);
    },
  });
}

function operation(redis: CheckoutSurgeRedis) {
  const unavailable = async () => {
    throw new Error("not needed by revision integration");
  };
  return {
    dependencies: {
      contextReader: {
        readContext: async () => ({ currentRun: runSnapshot(), saleOfferId }),
      },
      businessOutcomeReader: { read: unavailable },
      consistencyLagReader: { read: unavailable },
      inventoryStatusService: { getStatus: unavailable },
      queueStatusService: { getStatus: unavailable },
      sharedErpProtectionService: { getStatus: unavailable },
      runErpOutcomeService: { getOutcomes: unavailable },
      trafficMetricReader: { readRecent: async () => [] },
      transportObservationReader: { read: async () => null },
      revisionAllocator: new RedisDashboardProjectionRevisionAllocator(redis),
    },
    close: () => redis.disconnect(),
  };
}

function runSnapshot() {
  return demoRunSnapshotSchema.parse({
    runId,
    presetId: "83333333-3333-4333-8333-333333333333",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId,
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt: "2026-07-23T11:59:00.000Z",
    trafficStartedAt: "2026-07-23T11:59:01.000Z",
  });
}

function requireTestRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error("TEST_REDIS_URL is required.");
  return url;
}
