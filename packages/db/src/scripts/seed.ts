import {
  acceptedErpRunConfigSchema,
  type PublicRuntimePolicyMutable,
  publicRuntimePolicyMutableWriteSchema,
  publicRuntimePolicyPersistedSchema,
} from "@checkout-surge/contracts";
import { sql } from "drizzle-orm";
import { createDatabaseConnection } from "../client.js";
import { demoPresets, products, publicRuntimePolicies } from "../schema.js";
import {
  backpressureConfig,
  buildSeedPresets,
  buyerSpikeTraffic,
  erpConfig,
  inventoryConfig,
} from "../seed-presets.js";
import { optionalIntegerEnv, optionalNumberEnv, requireEnv } from "./env.js";

const seedIds = {
  product: "11111111-1111-4111-8111-111111111111",
} as const;

const databaseUrl = requireEnv("DATABASE_URL");
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
} finally {
  await connection.close();
}

console.log("Seeded product, demo presets, and public runtime policy.");

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
