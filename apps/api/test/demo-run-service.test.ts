import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AcceptedRunConfigSnapshot,
  BusinessOutcomeSummary,
  PublicRuntimePolicy,
  TrafficConfig,
} from "@checkout-surge/contracts";
import { createDatabaseConnection, demoPresets } from "@checkout-surge/db";
import { resetTestDatabase } from "@checkout-surge/db/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  DemoRunService,
  DemoRunValidationError,
  validateAcceptedRunSnapshot,
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

function expectBuyerSpikeTrafficConfig(
  trafficConfig: TrafficConfig,
): Extract<TrafficConfig, { mode: "buyer-spike" }> {
  if (trafficConfig.mode !== "buyer-spike") {
    throw new Error(`Expected buyer-spike traffic config, received ${trafficConfig.mode}.`);
  }

  return trafficConfig;
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
