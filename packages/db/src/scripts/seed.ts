import {
  acceptedErpRunConfigSchema,
  type BackpressureConfig,
  type DemoPresetDisplay,
  type DemoPresetVisibility,
  type ErpRunConfig,
  type InventoryConfig,
  type PublicRuntimePolicyMutable,
  publicRuntimePolicyMutableWriteSchema,
  publicRuntimePolicyPersistedSchema,
  type TrafficConfig,
} from "@checkout-surge/contracts";
import { eq, sql } from "drizzle-orm";
import { createDatabaseConnection } from "../client.js";
import { createRedisClient } from "../redis.js";
import { initializeInventory } from "../redis-inventory.js";
import { demoPresets, products, publicRuntimePolicies, saleOffers } from "../schema.js";
import { optionalIntegerEnv, optionalNumberEnv, requireEnv } from "./env.js";

const seedIds = {
  product: "11111111-1111-4111-8111-111111111111",
  baselineSaleOffer: "22222222-2222-4222-8222-222222222222",
  previewPreset: "33333333-3333-4333-8333-333333333331",
  surge5kPreset: "33333333-3333-4333-8333-333333333332",
  surge10kPreset: "33333333-3333-4333-8333-333333333333",
  idempotencyPreset: "33333333-3333-4333-8333-333333333334",
  publicCustomPreset: "33333333-3333-4333-8333-333333333335",
  slowErpPreset: "33333333-3333-4333-8333-333333333336",
  laggyErpPreset: "33333333-3333-4333-8333-333333333337",
  adminSmokePreset: "44444444-4444-4444-8444-444444444441",
  adminFailurePreset: "44444444-4444-4444-8444-444444444442",
  adminCustomPreset: "44444444-4444-4444-8444-444444444443",
} as const;

const baselineAllocatedStock = 1000;
const saleStartsAt = new Date("2026-01-01T00:00:00.000Z");
const saleEndsAt = new Date("2035-01-01T00:00:00.000Z");

interface SeedPreset {
  id: string;
  slug: string;
  visibility: DemoPresetVisibility;
  isEditable: boolean;
  isCustom: boolean;
  isSystem: boolean;
  display: DemoPresetDisplay;
  trafficConfig: TrafficConfig;
  inventoryConfig: InventoryConfig;
  erpConfig: ErpRunConfig;
  backpressureConfig: BackpressureConfig;
  overwriteOnConflict: boolean;
}

const databaseUrl = requireEnv("DATABASE_URL");
const redisUrl = requireEnv("REDIS_URL");
const now = new Date();
const seededPublicRuntimePolicy = buildPublicRuntimePolicy();

const connection = createDatabaseConnection(databaseUrl, { max: 1 });

try {
  await connection.db.transaction(async (tx) => {
    await tx
      .insert(products)
      .values({
        id: seedIds.product,
        sku: "CS-LAUNCH-PASS-001",
        slug: "launch-pass",
        name: "Checkout Surge Launch Pass",
        isActive: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: products.id,
        set: {
          sku: "CS-LAUNCH-PASS-001",
          slug: "launch-pass",
          name: "Checkout Surge Launch Pass",
          isActive: true,
          updatedAt: now,
        },
      });

    await tx
      .insert(saleOffers)
      .values({
        id: seedIds.baselineSaleOffer,
        productId: seedIds.product,
        name: "Launch Pass Baseline Catalog Offer",
        allocatedStock: baselineAllocatedStock,
        saleStartsAt,
        saleEndsAt,
        isActive: true,
        purpose: "catalog",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: saleOffers.id,
        set: {
          productId: seedIds.product,
          name: "Launch Pass Baseline Catalog Offer",
          allocatedStock: baselineAllocatedStock,
          saleStartsAt,
          saleEndsAt,
          isActive: true,
          purpose: "catalog",
          updatedAt: now,
        },
      });

    for (const preset of buildSeedPresets()) {
      acceptedErpRunConfigSchema.parse(preset.erpConfig);
      const values = {
        id: preset.id,
        slug: preset.slug,
        visibility: preset.visibility,
        isEditable: preset.isEditable,
        isCustom: preset.isCustom,
        isSystem: preset.isSystem,
        display: preset.display,
        trafficConfig: preset.trafficConfig,
        inventoryConfig: preset.inventoryConfig,
        erpConfig: preset.erpConfig,
        backpressureConfig: preset.backpressureConfig,
        createdAt: now,
        updatedAt: now,
      };

      if (preset.overwriteOnConflict) {
        await tx
          .insert(demoPresets)
          .values(values)
          .onConflictDoUpdate({
            target: demoPresets.slug,
            set: {
              visibility: preset.visibility,
              isEditable: preset.isEditable,
              isCustom: preset.isCustom,
              isSystem: preset.isSystem,
              display: preset.display,
              trafficConfig: preset.trafficConfig,
              inventoryConfig: preset.inventoryConfig,
              erpConfig: preset.erpConfig,
              backpressureConfig: preset.backpressureConfig,
              updatedAt: now,
            },
          });
        continue;
      }

      // Mutable seeded admin presets intentionally keep their operator-tuned
      // configuration on reseed. Only the system provenance marker is repaired
      // so a reserved canonical slug can never remain falsely non-system. The
      // conditional update (setWhere) ensures an already-system row is a true
      // no-op on reseed, so routine runtime:setup does not bump updated_at or
      // make an unchanged operator-edited admin preset appear newly updated.
      await tx
        .insert(demoPresets)
        .values(values)
        .onConflictDoUpdate({
          target: demoPresets.slug,
          set: {
            isSystem: preset.isSystem,
            updatedAt: now,
          },
          setWhere: sql`${demoPresets.isSystem} = false`,
        });
    }

    await tx
      .insert(publicRuntimePolicies)
      .values({
        id: "active",
        policy: seededPublicRuntimePolicy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: publicRuntimePolicies.id,
      });
  });

  const [activeOffer] = await connection.db
    .select({
      id: saleOffers.id,
      allocatedStock: saleOffers.allocatedStock,
    })
    .from(saleOffers)
    .where(eq(saleOffers.id, seedIds.baselineSaleOffer))
    .limit(1);

  if (!activeOffer) {
    throw new Error("Seeded baseline sale offer was not found after PostgreSQL seed.");
  }

  await seedRedisInventory(redisUrl, {
    saleOfferId: activeOffer.id,
    allocatedStock: activeOffer.allocatedStock,
  });
} finally {
  await connection.close();
}

console.log("Seeded PostgreSQL demo baseline and Redis inventory.");

function buildSeedPresets(): SeedPreset[] {
  return [
    {
      id: seedIds.previewPreset,
      slug: "preview-1k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Preview 1k",
        description: "1,000 buyers rush 500 units. Standard ERP.",
        sortOrder: 10,
        outcomeFocus: ["sold_out", "queue_pressure", "run_history"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 1000, maxDurationSeconds: 30 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.surge5kPreset,
      slug: "surge-5k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Surge 5k",
        description:
          "5,000 buyers rush 500 units. Same stock and ERP as Preview 1k: only the crowd grows.",
        sortOrder: 20,
        outcomeFocus: ["sold_out", "queue_pressure", "run_history"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 80 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.surge10kPreset,
      slug: "surge-10k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Surge 10k",
        description:
          "10,000 buyers rush 500 units. Same stock and ERP: the ERP does the same work whatever the crowd size.",
        sortOrder: 30,
        outcomeFocus: ["sold_out", "queue_pressure", "run_history"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 10_000, maxDurationSeconds: 120 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.slowErpPreset,
      slug: "slow-erp-5k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Slow ERP",
        description:
          "5,000 buyers rush 500 units while the ERP accepts only 5 orders per second. Orders queue up and drain at its pace.",
        sortOrder: 32,
        outcomeFocus: ["downstream_capacity", "queue_pressure", "sold_out"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 80 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 5, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.laggyErpPreset,
      slug: "laggy-erp-5k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Laggy ERP",
        description:
          "5,000 buyers rush 500 units while each ERP call takes one second. Bounded workers cap the calls in flight.",
        sortOrder: 34,
        outcomeFocus: ["downstream_latency", "queue_pressure", "sold_out"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 80 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 1000, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.idempotencyPreset,
      slug: "idempotency-check-200",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Duplicate-click storm",
        description: "200 buyers, every buyer clicks Buy twice.",
        sortOrder: 40,
        outcomeFocus: ["idempotency", "happy_path"],
      },
      trafficConfig: buyerSpikeTraffic({
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
        maxDurationSeconds: 11,
      }),
      inventoryConfig: inventoryConfig({ startingStock: 200 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.publicCustomPreset,
      slug: "public-custom",
      visibility: "public",
      isEditable: false,
      isCustom: true,
      isSystem: true,
      display: {
        name: "Public Custom",
        description: "Read-only base for bounded run-scoped public custom starts.",
        sortOrder: 50,
        outcomeFocus: ["happy_path", "sold_out", "failure_path"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 80 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.adminSmokePreset,
      slug: "admin-smoke-constant",
      visibility: "admin",
      isEditable: true,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Admin Smoke Constant",
        description: "Small constant-arrival run for local dashboard and worker checks.",
        sortOrder: 100,
        outcomeFocus: ["happy_path", "run_history"],
      },
      trafficConfig: constantArrivalTraffic({
        ratePerSecond: 20,
        durationSeconds: 10,
        preAllocatedVus: 10,
        maxVus: 50,
      }),
      inventoryConfig: inventoryConfig({ startingStock: 250 }),
      erpConfig: erpConfig({ latencyMs: 75, maxTps: 100, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: false,
    },
    {
      id: seedIds.adminFailurePreset,
      slug: "admin-failure-path",
      visibility: "admin",
      isEditable: true,
      isCustom: false,
      isSystem: true,
      display: {
        name: "Admin Failure Path",
        description: "Run with controlled ERP errors for failed order and retry demonstrations.",
        sortOrder: 110,
        outcomeFocus: ["failure_path", "run_history"],
      },
      trafficConfig: constantArrivalTraffic({
        ratePerSecond: 15,
        durationSeconds: 12,
        preAllocatedVus: 10,
        maxVus: 60,
      }),
      inventoryConfig: inventoryConfig({ startingStock: 200 }),
      erpConfig: erpConfig({ latencyMs: 300, maxTps: 30, errorRate: 0.25 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 4 }),
      overwriteOnConflict: false,
    },
    {
      id: seedIds.adminCustomPreset,
      slug: "custom",
      visibility: "admin",
      isEditable: true,
      isCustom: true,
      isSystem: true,
      display: {
        name: "Custom",
        description: "Persisted admin scratch preset for operator experiments.",
        sortOrder: 120,
        outcomeFocus: ["happy_path", "sold_out", "failure_path", "run_history"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 80 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: false,
    },
  ];
}

function buyerSpikeTraffic(options: {
  buyerCount: number;
  duplicateEachBuyerAttempt?: boolean;
  startDelaySeconds?: number;
  maxDurationSeconds: number;
}): TrafficConfig {
  return {
    mode: "buyer-spike",
    buyerCount: options.buyerCount,
    duplicateEachBuyerAttempt: options.duplicateEachBuyerAttempt ?? false,
    startDelaySeconds: options.startDelaySeconds ?? 0,
    maxDurationSeconds: options.maxDurationSeconds,
    quantityPerAttempt: 1,
  };
}

function constantArrivalTraffic(options: {
  ratePerSecond: number;
  durationSeconds: number;
  preAllocatedVus: number;
  maxVus: number;
  startDelaySeconds?: number;
}): TrafficConfig {
  return {
    mode: "constant-arrival-rate",
    ratePerSecond: options.ratePerSecond,
    startDelaySeconds: options.startDelaySeconds ?? 0,
    durationSeconds: options.durationSeconds,
    quantityPerAttempt: 1,
    k6Vus: {
      preAllocatedVus: options.preAllocatedVus,
      maxVus: options.maxVus,
    },
  };
}

function inventoryConfig(options: { startingStock: number }): InventoryConfig {
  return {
    startingStock: options.startingStock,
  };
}

function erpConfig(options: {
  latencyMs: number;
  maxTps: number;
  errorRate: number;
  forcedOutage?: boolean;
}): ErpRunConfig {
  return {
    latencyMs: options.latencyMs,
    maxTps: options.maxTps,
    errorRate: options.errorRate,
    forcedOutage: options.forcedOutage ?? false,
  };
}

function backpressureConfig(options: { orderProcessConcurrency: number }): BackpressureConfig {
  return {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency: options.orderProcessConcurrency,
  };
}

function buildPublicRuntimePolicy(): PublicRuntimePolicyMutable {
  const policy = publicRuntimePolicyMutableWriteSchema.parse({
    estimatedDemoOccupancyCeilingSeconds: 600,
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: optionalIntegerEnv("PUBLIC_RUN_BUDGET_WINDOW_SECONDS", 300),
      perVisitorMaxStarts: optionalIntegerEnv("PUBLIC_RUN_BUDGET_PER_VISITOR_MAX_STARTS", 2),
      globalMaxStarts: optionalIntegerEnv("PUBLIC_RUN_BUDGET_GLOBAL_MAX_STARTS", 6),
    },
    publicCustomDefaults: {
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 80 }),
      inventoryConfig: inventoryConfig({ startingStock: 500 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 20, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
    },
    publicCustomLimits: {
      maxTotalRequests: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_TOTAL_REQUESTS", 10_000),
      maxBuyers: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_BUYERS", 10_000),
      maxRequestsPerSecond: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_REQUESTS_PER_SECOND", 1000),
      maxTrafficDurationSeconds: optionalIntegerEnv(
        "PUBLIC_CUSTOM_MAX_TRAFFIC_DURATION_SECONDS",
        120,
      ),
      maxTrafficStartDelaySeconds: optionalIntegerEnv(
        "PUBLIC_CUSTOM_MAX_TRAFFIC_START_DELAY_SECONDS",
        10,
      ),
      maxPreAllocatedVus: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_PRE_ALLOCATED_VUS", 1000),
      maxVus: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_VUS", 1000),
      maxStartingStock: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_STARTING_STOCK", 1000),
      maxErpLatencyMs: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_ERP_LATENCY_MS", 2000),
      minErpMaxTps: optionalIntegerEnv("PUBLIC_CUSTOM_MIN_ERP_MAX_TPS", 1),
      maxErpMaxTps: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_ERP_MAX_TPS", 50),
      maxErpErrorRate: optionalNumberEnv("PUBLIC_CUSTOM_MAX_ERP_ERROR_RATE", 0.25),
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
    },
  });
  return publicRuntimePolicyPersistedSchema.parse(policy);
}

async function seedRedisInventory(
  redisUrl: string,
  offer: { saleOfferId: string; allocatedStock: number },
): Promise<void> {
  const redis = createRedisClient(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  try {
    await redis.connect();
    await initializeInventory(redis, { ...offer, source: "seed" });
  } finally {
    redis.disconnect();
  }
}
