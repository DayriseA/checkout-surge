import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  BusinessOutcomeSummary,
  PublicRuntimePolicy,
  TrafficConfig,
} from "@checkout-surge/contracts";
import {
  controlServiceTokenHeaderName,
  trafficExecutionStartPath,
} from "@checkout-surge/contracts";
import {
  createDatabaseConnection,
  createRedisClient,
  demoPresets,
  demoRunSummaries,
  demoRuns,
  products,
  publicRuntimePolicies,
} from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DemoRunService,
  DemoRunValidationError,
  HttpTrafficExecutionGateway,
  RedisPublicRunBudgetStore,
  validateAcceptedRunSnapshot,
  validatePublicRuntimePolicyUpdate,
} from "../src/services/demo-run-service.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPackageRoot = path.resolve(packageRoot, "../../packages/db");
const migrationsFolder = path.join(dbPackageRoot, "drizzle");

describe("demo-run service validation", () => {
  it("allows curated public presets to exceed public-custom caps while enforcing deployment caps", () => {
    expect(() =>
      validateAcceptedRunSnapshot(surge10kSnapshot(), publicRuntimePolicy(), {
        operatorMode: "public",
        enforcePublicCustomLimits: false,
      }),
    ).not.toThrow();
  });

  it("keeps public custom starts inside public-custom caps", () => {
    expect(() =>
      validateAcceptedRunSnapshot(surge10kSnapshot(), publicRuntimePolicy(), {
        operatorMode: "public",
        enforcePublicCustomLimits: true,
      }),
    ).toThrow(DemoRunValidationError);
  });

  it("rejects public runtime policy updates above deployment hard caps", () => {
    const policy = publicRuntimePolicy();
    policy.publicCustomLimits.maxTotalRequests = policy.deploymentHardCaps.maxTotalRequests + 1;

    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrow(
      "Accepted run configuration exceeds a configured cap.",
    );
    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrow(DemoRunValidationError);
  });

  it("rejects public custom defaults that exceed the updated public limits", () => {
    const policy = publicRuntimePolicy();
    policy.publicCustomLimits.maxBuyers = 100;

    expect(() => validatePublicRuntimePolicyUpdate(policy)).toThrow(DemoRunValidationError);
  });
});

describe("HTTP traffic execution gateway", () => {
  it("sends the validated start correlation ID in the load-orchestrator header", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          runId: "55555555-5555-4555-8555-555555555555",
          status: "active",
          startedAt: "2026-06-20T00:00:11.000Z",
          correlationId: "corr-start-delegation",
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const gateway = new HttpTrafficExecutionGateway({
      loadOrchestratorBaseUrl: "http://load.test",
      controlServiceToken: "test-token",
    });

    try {
      const response = await gateway.start({
        runId: "55555555-5555-4555-8555-555555555555",
        saleOfferId: "22222222-2222-4222-8222-222222222222",
        apiBaseUrl: "http://api.test",
        buyEndpointPath: "/buy",
        correlationId: "corr-start-delegation",
        configSnapshot: surge10kSnapshot(),
      });

      expect(response.correlationId).toBe("corr-start-delegation");
      expect(fetchMock).toHaveBeenCalledWith(
        `http://load.test${trafficExecutionStartPath}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            [correlationIdHeaderName]: "corr-start-delegation",
            [controlServiceTokenHeaderName]: "test-token",
          }),
        }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toMatchObject({
        correlationId: "corr-start-delegation",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("demo-run preset management", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedPresetFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("lists all presets while public listing remains scoped to public presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const publicPresets = await service.listPublicPresets();
    const adminPresets = await service.listAdminPresets();

    expect(publicPresets.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
    ]);
    expect(adminPresets.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
      "custom",
    ]);
  });

  it("saves only editable admin presets", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const snapshot = surge10kSnapshot();

    const updated = await service.saveAdminPreset({
      slug: "custom",
      display: {
        name: "Custom Saved",
        description: "Updated scratch preset.",
        sortOrder: 125,
        outcomeFocus: ["failure_path"],
      },
      ...snapshot,
    });

    await expect(
      service.saveAdminPreset({
        slug: "preview-1k",
        display: {
          name: "Preview Edited",
          description: "Should not persist.",
          sortOrder: 10,
          outcomeFocus: [],
        },
        ...snapshot,
      }),
    ).rejects.toMatchObject({ code: "preset_not_editable" });
    expect(updated.preset.slug).toBe("custom");
    expect(updated.preset.display.name).toBe("Custom Saved");
    expect(expectBuyerSpikeTrafficConfig(updated.preset.trafficConfig)).toMatchObject({
      buyerCount: 10_000,
    });
  });

  it("duplicates presets as editable admin copies and rejects duplicate slugs", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "Preview Copy",
      displayName: "Preview Copy",
    });

    await expect(
      service.duplicatePreset({
        sourceSlug: "preview-1k",
        targetSlug: "preview-copy",
      }),
    ).rejects.toMatchObject({ code: "preset_slug_conflict" });
    await expect(
      service.duplicatePreset({
        sourceSlug: "public-custom",
        targetSlug: "public-custom-copy",
      }),
    ).rejects.toMatchObject({ code: "preset_not_duplicable" });
    expect(created.preset.slug).toBe("preview-copy");
    expect(created.preset.visibility).toBe("admin");
    expect(created.preset.isEditable).toBe(true);
    expect(created.preset.isCustom).toBe(false);
    expect(created.preset.display.name).toBe("Preview Copy");
  });

  it("copies any source preset into the editable admin custom preset", async () => {
    const service = createPresetManagementService(requireConnection(connection));

    const copied = await service.copyPresetToCustom({ sourceSlug: "preview-1k" });

    expect(copied.preset.slug).toBe("custom");
    expect(copied.preset.visibility).toBe("admin");
    expect(copied.preset.isCustom).toBe(true);
    expect(copied.preset.display.name).toBe("Custom");
    expect(copied.preset.display.description).toBe("Scratch copy of Preview 1k.");
    expect(expectBuyerSpikeTrafficConfig(copied.preset.trafficConfig)).toMatchObject({
      buyerCount: 10_000,
    });
  });
});

describe("demo-run public runtime policy management", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    connection = null;
    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedStartFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("persists public budget, default, and limit updates while preserving deployment hard caps", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 2,
    };
    policy.publicCustomDefaults = {
      ...policy.publicCustomDefaults,
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 250,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 5,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 75,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    policy.publicCustomLimits = {
      ...policy.publicCustomLimits,
      maxBuyers: 500,
      maxStartingStock: 100,
    };

    const response = await service.updateAdminPublicRuntimePolicy(
      { policy, correlationId: "corr-policy-save" },
      "corr-policy-save",
    );
    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    const persistedPolicy = row?.policy as PublicRuntimePolicy | undefined;

    expect(response.correlationId).toBe("corr-policy-save");
    expect(response.policy.publicRunBudget.perVisitorMaxStarts).toBe(1);
    expect(response.policy.publicCustomDefaults.inventoryConfig.startingStock).toBe(75);
    expect(response.policy.publicCustomLimits.maxBuyers).toBe(500);
    expect(response.policy.deploymentHardCaps.maxBuyers).toBe(100_000);
    expect(persistedPolicy?.publicRunBudget.globalMaxStarts).toBe(2);
    expect(persistedPolicy?.deploymentHardCaps.maxTotalRequests).toBe(100_000);
  });

  it("rejects policy updates above deployment hard caps without changing the stored row", async () => {
    const service = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomLimits.maxTotalRequests = 100_001;

    await expect(
      service.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-reject"),
    ).rejects.toMatchObject({
      code: "public_limit_total_requests_exceeds_deployment_cap",
    });

    const [row] = await requireConnection(connection).db.select().from(publicRuntimePolicies);
    const persistedPolicy = row?.policy as PublicRuntimePolicy | undefined;
    expect(persistedPolicy?.publicCustomLimits.maxTotalRequests).toBe(10_000);
  });
});

describe("demo-run lifecycle start gating", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;
  let redis: ReturnType<typeof createRedisClient> | null = null;

  beforeEach(async () => {
    await connection?.close();
    redis?.disconnect();
    connection = null;
    redis = null;

    await resetTestDatabase({ databaseUrl: requireTestDatabaseUrl(), migrationsFolder });
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
    await seedStartFixtures(connection);
  });

  afterAll(async () => {
    await connection?.close();
    if (redis) {
      await redis.flushdb();
      redis.disconnect();
    }
  });

  it.each([
    "starting",
    "active",
    "draining",
  ] as const)("blocks a new start while another run is %s", async (status) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));
    await seedExistingRun(requireConnection(connection), {
      runId: existingRunId(status),
      status,
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toMatchObject({
      code: "demo_run_already_active",
      details: { status },
    });
  });

  it.each([
    "completed",
    "failed",
  ] as const)("allows a new start after the existing run is %s", async (status) => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));
    await seedExistingRun(requireConnection(connection), {
      runId: existingRunId(status),
      status,
    });

    const response = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-start",
    );

    expect(response.run.status).toBe("active");
    expect(response.run.trafficStatus).toBe("active");
    expect(response.run.saleOfferId).toBe("77777777-7777-4777-8777-777777777778");
  });

  it("keeps public custom overrides scoped to the accepted run snapshot", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    const response = await service.startRun(
      {
        presetSlug: "public-custom",
        operatorMode: "public",
        publicVisitorId: "visitor-1",
        configOverride: {
          trafficConfig: {
            mode: "buyer-spike",
            buyerCount: 321,
            duplicateEachBuyerAttempt: false,
            startDelaySeconds: 0,
            maxDurationSeconds: 3,
            quantityPerAttempt: 1,
          },
          inventoryConfig: {
            startingStock: 44,
            quantityPerCheckout: 1,
            reservationHoldMinutes: 15,
          },
          erpConfig: {
            latencyMs: 75,
            maxTps: 50,
            errorRate: 0,
            forcedOutage: false,
            requestTimeoutMs: 2000,
          },
        },
      },
      "corr-public-custom",
    );
    const publicCustomPreset = await readPresetRow(requireConnection(connection), "public-custom");

    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 321,
      maxDurationSeconds: 3,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(44);
    expect(publicCustomPreset.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 10_000,
    });
    expect(publicCustomPreset.inventoryConfig.startingStock).toBe(1000);
  });

  it("uses updated persisted public custom defaults for the next public custom start", async () => {
    const managementService = createPresetManagementService(requireConnection(connection));
    const policy = publicRuntimePolicyMutable();
    policy.publicCustomDefaults = {
      ...policy.publicCustomDefaults,
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 222,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 4,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 55,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
    };
    await managementService.updateAdminPublicRuntimePolicy({ policy }, "corr-policy-update");

    const startService = createStartService(requireConnection(connection), requireRedis(redis));
    const response = await startService.startRun(
      {
        presetSlug: "public-custom",
        operatorMode: "public",
        publicVisitorId: "visitor-defaults",
      },
      "corr-public-defaults",
    );

    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 222,
      maxDurationSeconds: 4,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(55);
  });

  it("allows admin run-scoped overrides for read-only public presets", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis));

    const response = await service.startRun(
      {
        presetSlug: "preview-1k",
        operatorMode: "admin",
        configOverride: {
          trafficConfig: {
            mode: "buyer-spike",
            buyerCount: 123,
            duplicateEachBuyerAttempt: true,
            startDelaySeconds: 0,
            maxDurationSeconds: 5,
            quantityPerAttempt: 1,
          },
          inventoryConfig: {
            startingStock: 33,
            quantityPerCheckout: 1,
            reservationHoldMinutes: 15,
          },
        },
      },
      "corr-admin-public-override",
    );
    const previewPreset = await readPresetRow(requireConnection(connection), "preview-1k");

    expect(response.run.operatorMode).toBe("admin");
    expect(expectBuyerSpikeTrafficConfig(response.run.configSnapshot.trafficConfig)).toMatchObject({
      buyerCount: 123,
      duplicateEachBuyerAttempt: true,
    });
    expect(response.run.configSnapshot.inventoryConfig.startingStock).toBe(33);
    expect(previewPreset.trafficConfig).toMatchObject({
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
    });
    expect(previewPreset.inventoryConfig.startingStock).toBe(1000);
  });

  it("does not consume public run budget for admin starts", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      publicRunBudgetStore: {
        consume: async () => {
          throw new Error("Admin starts should not consume public budget.");
        },
      },
    });

    const response = await service.startRun(
      { presetSlug: "preview-1k", operatorMode: "admin" },
      "corr-admin-budget-bypass",
    );

    expect(response.run.operatorMode).toBe("admin");
  });

  it("enforces updated public run-budget windows through Redis", async () => {
    const store = new RedisPublicRunBudgetStore(requireRedis(redis));
    const policy = publicRuntimePolicy();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 1,
      globalMaxStarts: 2,
    };

    await store.consume({
      policy,
      publicVisitorId: "visitor-budget-1",
      now: new Date("2026-06-20T00:00:00.000Z"),
    });
    await expect(
      store.consume({
        policy,
        publicVisitorId: "visitor-budget-1",
        now: new Date("2026-06-20T00:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "public_visitor_run_budget_exceeded" });

    await requireRedis(redis).flushdb();
    policy.publicRunBudget = {
      windowSeconds: 60,
      perVisitorMaxStarts: 10,
      globalMaxStarts: 2,
    };
    await store.consume({
      policy,
      publicVisitorId: "visitor-budget-2",
      now: new Date("2026-06-20T00:00:02.000Z"),
    });
    await store.consume({
      policy,
      publicVisitorId: "visitor-budget-3",
      now: new Date("2026-06-20T00:00:03.000Z"),
    });
    await expect(
      store.consume({
        policy,
        publicVisitorId: "visitor-budget-4",
        now: new Date("2026-06-20T00:00:04.000Z"),
      }),
    ).rejects.toMatchObject({ code: "public_run_budget_exceeded" });
  });

  it("writes a terminal summary when inventory initialization fails", async () => {
    const service = createStartService(requireConnection(connection), redisUnavailable());

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("Redis unavailable during initialization.");

    const summaries = await requireConnection(connection).db.select().from(demoRunSummaries);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      failureReason: "inventory_initialization_failed",
      terminalInventorySnapshot: null,
    });
    expect(summaries[0]?.httpSummary).toMatchObject({
      plannedRequests: 10_000,
      emittedRequests: 0,
    });
    expect(summaries[0]?.trafficDeliverySummary).toMatchObject({
      trafficDeliveryStatus: "failed",
      droppedIterations: 10_000,
    });
  });

  it("writes a terminal summary when load-orchestrator traffic start fails", async () => {
    const service = createStartService(requireConnection(connection), requireRedis(redis), {
      trafficExecutionGateway: {
        start: async () => {
          throw new Error("load orchestrator unavailable");
        },
      },
    });

    await expect(
      service.startRun({ presetSlug: "preview-1k", operatorMode: "admin" }, "corr-start"),
    ).rejects.toThrow("load orchestrator unavailable");

    const summaries = await requireConnection(connection).db.select().from(demoRunSummaries);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      runId: "77777777-7777-4777-8777-777777777777",
      status: "failed",
      failureReason: "load_orchestrator_start_failed",
    });
    expect(summaries[0]?.terminalInventorySnapshot).toMatchObject({
      saleOfferId: "77777777-7777-4777-8777-777777777778",
      startingStock: 1000,
      remainingStock: 1000,
      acceptedReservations: 0,
      source: "redis",
    });
  });
});

function surge10kSnapshot(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 10_000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1000,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 150,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 10,
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
}

function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for API tests.");
  }

  return databaseUrl;
}

function requireConnection(
  connection: ReturnType<typeof createDatabaseConnection> | null,
): ReturnType<typeof createDatabaseConnection> {
  if (!connection) {
    throw new Error("Test database connection was not initialized.");
  }

  return connection;
}

function requireTestRedisUrl(): string {
  const redisUrl = process.env.TEST_REDIS_URL;

  if (!redisUrl) {
    throw new Error("TEST_REDIS_URL is required for API demo-run tests.");
  }

  return redisUrl;
}

function requireRedis(
  redis: ReturnType<typeof createRedisClient> | null,
): ReturnType<typeof createRedisClient> {
  if (!redis) {
    throw new Error("Test Redis client was not initialized.");
  }

  return redis;
}

function createPresetManagementService(
  connection: ReturnType<typeof createDatabaseConnection>,
): DemoRunService {
  return new DemoRunService({
    db: connection.db,
    redis: {} as never,
    trafficExecutionGateway: {
      start: async () => ({
        runId: "unused",
        status: "active",
        startedAt: "unused",
        correlationId: "unused",
      }),
    },
    publicRunBudgetStore: { consume: async () => undefined },
    trafficMetricStore: {} as never,
    businessOutcomeReader: { read: async () => emptyBusinessOutcomeSummary() },
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger: createSilentLogger("api"),
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => "66666666-6666-4666-8666-666666666666",
  });
}

function createStartService(
  connection: ReturnType<typeof createDatabaseConnection>,
  redis: ReturnType<typeof createRedisClient>,
  overrides: {
    trafficExecutionGateway?: ConstructorParameters<
      typeof DemoRunService
    >[0]["trafficExecutionGateway"];
    publicRunBudgetStore?: ConstructorParameters<typeof DemoRunService>[0]["publicRunBudgetStore"];
  } = {},
): DemoRunService {
  const ids = [
    "77777777-7777-4777-8777-777777777777",
    "77777777-7777-4777-8777-777777777778",
    "77777777-7777-4777-8777-777777777779",
    "77777777-7777-4777-8777-777777777780",
  ];

  return new DemoRunService({
    db: connection.db,
    redis,
    trafficExecutionGateway: overrides.trafficExecutionGateway ?? {
      start: async (request) => ({
        runId: request.runId,
        status: "active",
        startedAt: "2026-06-20T00:00:11.000Z",
        correlationId: request.correlationId,
      }),
    },
    publicRunBudgetStore: overrides.publicRunBudgetStore ?? { consume: async () => undefined },
    trafficMetricStore: {} as never,
    businessOutcomeReader: { read: async () => emptyBusinessOutcomeSummary() },
    apiBaseUrl: "http://api.test",
    buyEndpointPath: "/buy",
    logger: createSilentLogger("api"),
    now: () => new Date("2026-06-20T00:00:10.000Z"),
    generateId: () => {
      const id = ids.shift();
      if (!id) {
        throw new Error("Start-service ID sequence exhausted.");
      }
      return id;
    },
  });
}

function redisUnavailable(): ReturnType<typeof createRedisClient> {
  return {
    hget: async () => {
      throw new Error("Redis unavailable during initialization.");
    },
    eval: async () => {
      throw new Error("Redis unavailable during cleanup.");
    },
    hgetall: async () => {
      throw new Error("Redis unavailable during snapshot capture.");
    },
    publish: async () => {
      throw new Error("Redis unavailable during event publication.");
    },
  } as unknown as ReturnType<typeof createRedisClient>;
}

function expectBuyerSpikeTrafficConfig(
  trafficConfig: TrafficConfig,
): Extract<TrafficConfig, { mode: "buyer-spike" }> {
  if (trafficConfig.mode !== "buyer-spike") {
    throw new Error(`Expected buyer-spike traffic config, received ${trafficConfig.mode}.`);
  }

  return trafficConfig;
}

async function readPresetRow(
  connection: ReturnType<typeof createDatabaseConnection>,
  slug: string,
): Promise<typeof demoPresets.$inferSelect> {
  const presets = await connection.db.select().from(demoPresets);
  const preset = presets.find((candidate) => candidate.slug === slug);

  if (!preset) {
    throw new Error(`Expected seeded preset ${slug}.`);
  }

  return preset;
}

function emptyBusinessOutcomeSummary(): BusinessOutcomeSummary {
  return {
    acceptedReservations: 0,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}

async function seedStartFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  await connection.db.insert(products).values({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sku: "START-GATING-001",
    slug: "start-gating-product",
    name: "Start Gating Product",
    isActive: true,
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
  await seedPresetFixtures(connection);
  await connection.db.insert(publicRuntimePolicies).values({
    id: "active",
    policy: publicRuntimePolicy(),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  });
}

async function seedExistingRun(
  connection: ReturnType<typeof createDatabaseConnection>,
  input: {
    runId: string;
    status: "starting" | "active" | "draining" | "completed" | "failed";
  },
): Promise<void> {
  await connection.db.insert(demoRuns).values({
    id: input.runId,
    presetId: "33333333-3333-4333-8333-333333333331",
    presetName: "Preview 1k",
    operatorMode: "admin",
    status: input.status,
    trafficStatus: trafficStatusForRunStatus(input.status),
    configSnapshot: surge10kSnapshot(),
    startedAt: new Date("2026-06-20T00:00:00.000Z"),
    ...(input.status === "draining" || input.status === "completed" || input.status === "failed"
      ? { trafficEndedAt: new Date("2026-06-20T00:00:05.000Z") }
      : {}),
    ...(input.status === "completed" || input.status === "failed"
      ? { finalizedAt: new Date("2026-06-20T00:00:06.000Z") }
      : {}),
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:06.000Z"),
  });
}

function trafficStatusForRunStatus(
  status: "starting" | "active" | "draining" | "completed" | "failed",
): "starting" | "active" | "succeeded" | "failed" {
  if (status === "starting" || status === "active") {
    return status;
  }
  if (status === "failed") {
    return "failed";
  }

  return "succeeded";
}

function existingRunId(status: "starting" | "active" | "draining" | "completed" | "failed") {
  const suffix = {
    starting: "1",
    active: "2",
    draining: "3",
    completed: "4",
    failed: "5",
  }[status];

  return `55555555-5555-4555-8555-55555555555${suffix}`;
}

async function seedPresetFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  const now = new Date("2026-06-20T00:00:00.000Z");
  const snapshot = surge10kSnapshot();

  await connection.db.insert(demoPresets).values([
    {
      id: "33333333-3333-4333-8333-333333333331",
      slug: "preview-1k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Preview 1k",
        description: "Preview run.",
        sortOrder: 10,
        outcomeFocus: ["happy_path"],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "33333333-3333-4333-8333-333333333335",
      slug: "public-custom",
      visibility: "public",
      isEditable: false,
      isCustom: true,
      display: {
        name: "Public Custom",
        description: "Public custom base.",
        sortOrder: 20,
        outcomeFocus: [],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "44444444-4444-4444-8444-444444444443",
      slug: "custom",
      visibility: "admin",
      isEditable: true,
      isCustom: true,
      display: {
        name: "Custom",
        description: "Editable scratch preset.",
        sortOrder: 120,
        outcomeFocus: [],
      },
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    },
  ]);
}

function publicRuntimePolicy(): PublicRuntimePolicy {
  return {
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: {
      ...surge10kSnapshot(),
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 500,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 10,
        quantityPerAttempt: 1,
      },
      erpConfig: {
        latencyMs: 100,
        maxTps: 100,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2000,
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 5,
        drainTimeoutSeconds: 300,
        pendingPersistenceRetryAfterSeconds: 30,
      },
    },
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 100,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "steady-arrival-rate"],
    },
    deploymentHardCaps: {
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}

function publicRuntimePolicyMutable() {
  const policy = publicRuntimePolicy();

  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    publicRunBudget: policy.publicRunBudget,
    publicCustomDefaults: policy.publicCustomDefaults,
    publicCustomLimits: policy.publicCustomLimits,
  };
}
