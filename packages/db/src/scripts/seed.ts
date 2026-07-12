import { eq, sql } from "drizzle-orm";
import { createDatabaseConnection } from "../client.js";
import { createRedisClient } from "../redis.js";
import { initializeInventory } from "../redis-inventory.js";
import {
  type DemoPresetVisibility,
  demoPresets,
  type JsonRecord,
  products,
  publicRuntimePolicies,
  saleOffers,
} from "../schema.js";
import { optionalIntegerEnv, optionalNumberEnv, requireEnv } from "./env.js";

const seedIds = {
  product: "11111111-1111-4111-8111-111111111111",
  baselineSaleOffer: "22222222-2222-4222-8222-222222222222",
  previewPreset: "33333333-3333-4333-8333-333333333331",
  surge5kPreset: "33333333-3333-4333-8333-333333333332",
  surge10kPreset: "33333333-3333-4333-8333-333333333333",
  idempotencyPreset: "33333333-3333-4333-8333-333333333334",
  publicCustomPreset: "33333333-3333-4333-8333-333333333335",
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
  display: JsonRecord;
  trafficConfig: JsonRecord;
  inventoryConfig: JsonRecord;
  erpConfig: JsonRecord;
  backpressureConfig: JsonRecord;
  overwriteOnConflict: boolean;
}

const databaseUrl = requireEnv("DATABASE_URL");
const redisUrl = requireEnv("REDIS_URL");
const now = new Date();
const circuitBreakerFailureThreshold = optionalIntegerEnv("ERP_CIRCUIT_FAILURE_THRESHOLD", 5);
const circuitBreakerResetTimeoutMs = optionalIntegerEnv("ERP_CIRCUIT_RESET_TIMEOUT_MS", 10_000);

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
      const values = {
        id: preset.id,
        slug: preset.slug,
        visibility: preset.visibility,
        isEditable: preset.isEditable,
        isCustom: preset.isCustom,
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

      await tx.insert(demoPresets).values(values).onConflictDoNothing({
        target: demoPresets.slug,
      });
    }

    await tx
      .insert(publicRuntimePolicies)
      .values({
        id: "active",
        policy: buildPublicRuntimePolicy(),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: publicRuntimePolicies.id,
      });

    await tx
      .update(demoPresets)
      .set({
        backpressureConfig: sql`coalesce(${demoPresets.backpressureConfig}, '{}'::jsonb)
          || CASE WHEN coalesce(${demoPresets.backpressureConfig}, '{}'::jsonb) ? 'circuitBreakerFailureThreshold'
            THEN '{}'::jsonb ELSE jsonb_build_object('circuitBreakerFailureThreshold', ${circuitBreakerFailureThreshold}::int) END
          || CASE WHEN coalesce(${demoPresets.backpressureConfig}, '{}'::jsonb) ? 'circuitBreakerResetTimeoutMs'
            THEN '{}'::jsonb ELSE jsonb_build_object('circuitBreakerResetTimeoutMs', ${circuitBreakerResetTimeoutMs}::int) END`,
        updatedAt: now,
      })
      .where(
        sql`NOT (coalesce(${demoPresets.backpressureConfig}, '{}'::jsonb) ? 'circuitBreakerFailureThreshold')
          OR NOT (coalesce(${demoPresets.backpressureConfig}, '{}'::jsonb) ? 'circuitBreakerResetTimeoutMs')`,
      );

    await tx
      .update(publicRuntimePolicies)
      .set({
        policy: sql`jsonb_set(
          ${publicRuntimePolicies.policy},
          '{publicCustomDefaults}',
          coalesce(${publicRuntimePolicies.policy} -> 'publicCustomDefaults', '{}'::jsonb)
            || jsonb_build_object(
              'backpressureConfig',
              coalesce(${publicRuntimePolicies.policy} #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb)
                || CASE WHEN coalesce(${publicRuntimePolicies.policy} #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb) ? 'circuitBreakerFailureThreshold'
                  THEN '{}'::jsonb ELSE jsonb_build_object('circuitBreakerFailureThreshold', ${circuitBreakerFailureThreshold}::int) END
                || CASE WHEN coalesce(${publicRuntimePolicies.policy} #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb) ? 'circuitBreakerResetTimeoutMs'
                  THEN '{}'::jsonb ELSE jsonb_build_object('circuitBreakerResetTimeoutMs', ${circuitBreakerResetTimeoutMs}::int) END
            ),
          true
        )`,
        updatedAt: now,
      })
      .where(
        sql`NOT (coalesce(${publicRuntimePolicies.policy} #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb) ? 'circuitBreakerFailureThreshold')
          OR NOT (coalesce(${publicRuntimePolicies.policy} #> '{publicCustomDefaults,backpressureConfig}', '{}'::jsonb) ? 'circuitBreakerResetTimeoutMs')`,
      );
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
      display: {
        name: "Preview 1k",
        description: "One-second public preview with visible scarcity and fast drain.",
        sortOrder: 10,
        outcomeFocus: ["happy_path", "sold_out"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 1000, maxDurationSeconds: 2 }),
      inventoryConfig: inventoryConfig({ startingStock: 250 }),
      erpConfig: erpConfig({ latencyMs: 80, maxTps: 250, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.surge5kPreset,
      slug: "surge-5k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Surge 5k",
        description: "Scarcity run for several thousand simultaneous synthetic buyers.",
        sortOrder: 20,
        outcomeFocus: ["sold_out", "queue_pressure", "run_history"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 5000, maxDurationSeconds: 2 }),
      inventoryConfig: inventoryConfig({ startingStock: 750 }),
      erpConfig: erpConfig({ latencyMs: 120, maxTps: 200, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 8 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.surge10kPreset,
      slug: "surge-10k",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Surge 10k",
        description: "Public showcase target with approximately 10,000 one-second attempts.",
        sortOrder: 30,
        outcomeFocus: ["sold_out", "queue_pressure", "run_history"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 10_000, maxDurationSeconds: 2 }),
      inventoryConfig: inventoryConfig({ startingStock: 1000 }),
      erpConfig: erpConfig({ latencyMs: 150, maxTps: 250, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 10 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.idempotencyPreset,
      slug: "idempotency-check-200",
      visibility: "public",
      isEditable: false,
      isCustom: false,
      display: {
        name: "Idempotency Check 200",
        description: "Duplicate-attempt run that should replay accepted reservation outcomes.",
        sortOrder: 40,
        outcomeFocus: ["idempotency", "happy_path"],
      },
      trafficConfig: buyerSpikeTraffic({
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
        maxDurationSeconds: 5,
      }),
      inventoryConfig: inventoryConfig({ startingStock: 200 }),
      erpConfig: erpConfig({ latencyMs: 50, maxTps: 200, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.publicCustomPreset,
      slug: "public-custom",
      visibility: "public",
      isEditable: false,
      isCustom: true,
      display: {
        name: "Public Custom",
        description: "Read-only base for bounded run-scoped public custom starts.",
        sortOrder: 50,
        outcomeFocus: ["happy_path", "sold_out", "failure_path"],
      },
      trafficConfig: buyerSpikeTraffic({ buyerCount: 500, maxDurationSeconds: 10 }),
      inventoryConfig: inventoryConfig({ startingStock: 100 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 150, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: true,
    },
    {
      id: seedIds.adminSmokePreset,
      slug: "admin-smoke-steady",
      visibility: "admin",
      isEditable: true,
      isCustom: false,
      display: {
        name: "Admin Smoke Steady",
        description: "Small steady-arrival run for local dashboard and worker checks.",
        sortOrder: 100,
        outcomeFocus: ["happy_path", "run_history"],
      },
      trafficConfig: steadyArrivalTraffic({
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
      display: {
        name: "Admin Failure Path",
        description: "Run with controlled ERP errors for failed order and retry demonstrations.",
        sortOrder: 110,
        outcomeFocus: ["failure_path", "run_history"],
      },
      trafficConfig: steadyArrivalTraffic({
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
      display: {
        name: "Custom",
        description: "Persisted admin scratch preset for operator experiments.",
        sortOrder: 120,
        outcomeFocus: ["happy_path", "sold_out", "failure_path", "run_history"],
      },
      trafficConfig: steadyArrivalTraffic({
        ratePerSecond: 10,
        durationSeconds: 10,
        preAllocatedVus: 5,
        maxVus: 25,
      }),
      inventoryConfig: inventoryConfig({ startingStock: 100 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 50, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 3 }),
      overwriteOnConflict: false,
    },
  ];
}

function buyerSpikeTraffic(options: {
  buyerCount: number;
  duplicateEachBuyerAttempt?: boolean;
  startDelaySeconds?: number;
  maxDurationSeconds: number;
}): JsonRecord {
  return {
    mode: "buyer-spike",
    buyerCount: options.buyerCount,
    duplicateEachBuyerAttempt: options.duplicateEachBuyerAttempt ?? false,
    startDelaySeconds: options.startDelaySeconds ?? 0,
    maxDurationSeconds: options.maxDurationSeconds,
    quantityPerAttempt: 1,
  };
}

function steadyArrivalTraffic(options: {
  ratePerSecond: number;
  durationSeconds: number;
  preAllocatedVus: number;
  maxVus: number;
  startDelaySeconds?: number;
}): JsonRecord {
  return {
    mode: "steady-arrival-rate",
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

function inventoryConfig(options: { startingStock: number }): JsonRecord {
  return {
    startingStock: options.startingStock,
    quantityPerCheckout: 1,
    reservationHoldMinutes: optionalIntegerEnv("RESERVATION_HOLD_MINUTES", 15),
  };
}

function erpConfig(options: {
  latencyMs: number;
  maxTps: number;
  errorRate: number;
  forcedOutage?: boolean;
}): JsonRecord {
  return {
    latencyMs: options.latencyMs,
    maxTps: options.maxTps,
    errorRate: options.errorRate,
    forcedOutage: options.forcedOutage ?? false,
    requestTimeoutMs: optionalIntegerEnv("ERP_REQUEST_TIMEOUT_MS", 2000),
  };
}

function backpressureConfig(options: { orderProcessConcurrency: number }): JsonRecord {
  return {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency: options.orderProcessConcurrency,
    drainTimeoutSeconds: optionalIntegerEnv("DEMO_RUN_DRAIN_TIMEOUT_SECONDS", 300),
    pendingPersistenceRetryAfterSeconds: optionalIntegerEnv(
      "PENDING_PERSISTENCE_RETRY_AFTER_SECONDS",
      30,
    ),
    circuitBreakerFailureThreshold,
    circuitBreakerResetTimeoutMs,
  };
}

function buildPublicRuntimePolicy(): JsonRecord {
  return {
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: optionalIntegerEnv("PUBLIC_RUN_BUDGET_WINDOW_SECONDS", 300),
      perVisitorMaxStarts: optionalIntegerEnv("PUBLIC_RUN_BUDGET_PER_VISITOR_MAX_STARTS", 2),
      globalMaxStarts: optionalIntegerEnv("PUBLIC_RUN_BUDGET_GLOBAL_MAX_STARTS", 6),
    },
    publicCustomDefaults: {
      trafficConfig: buyerSpikeTraffic({ buyerCount: 500, maxDurationSeconds: 10 }),
      inventoryConfig: inventoryConfig({ startingStock: 100 }),
      erpConfig: erpConfig({ latencyMs: 100, maxTps: 100, errorRate: 0 }),
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
      maxErpMaxTps: optionalIntegerEnv("PUBLIC_CUSTOM_MAX_ERP_MAX_TPS", 100),
      maxErpErrorRate: optionalNumberEnv("PUBLIC_CUSTOM_MAX_ERP_ERROR_RATE", 0.25),
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "steady-arrival-rate"],
    },
    deploymentHardCaps: {
      maxBuyers: optionalIntegerEnv("DEMO_MAX_BUYERS", 100_000),
      maxTotalRequests: optionalIntegerEnv("DEMO_MAX_TOTAL_REQUESTS", 100_000),
      maxRequestsPerSecond: optionalIntegerEnv("DEMO_MAX_REQUESTS_PER_SECOND", 10_000),
      maxTrafficDurationSeconds: optionalIntegerEnv("DEMO_MAX_TRAFFIC_DURATION_SECONDS", 300),
      maxTrafficStartDelaySeconds: optionalIntegerEnv("DEMO_MAX_TRAFFIC_START_DELAY_SECONDS", 30),
      maxPreAllocatedVus: optionalIntegerEnv("DEMO_MAX_PRE_ALLOCATED_VUS", 10_000),
      maxVus: optionalIntegerEnv("DEMO_MAX_VUS", 10_000),
    },
  };
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
