import type {
  BackpressureConfig,
  DemoPresetDisplay,
  DemoPresetVisibility,
  ErpRunConfig,
  InventoryConfig,
  TrafficConfig,
} from "@checkout-surge/contracts";

const seedPresetIds = {
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

export interface SeedPreset {
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

export function buildSeedPresets(): SeedPreset[] {
  return [
    {
      id: seedPresetIds.previewPreset,
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
      id: seedPresetIds.surge5kPreset,
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
      id: seedPresetIds.surge10kPreset,
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
      id: seedPresetIds.slowErpPreset,
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
      id: seedPresetIds.laggyErpPreset,
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
      id: seedPresetIds.idempotencyPreset,
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
      id: seedPresetIds.publicCustomPreset,
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
      id: seedPresetIds.adminSmokePreset,
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
      }),
      inventoryConfig: inventoryConfig({ startingStock: 250 }),
      erpConfig: erpConfig({ latencyMs: 75, maxTps: 100, errorRate: 0 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 5 }),
      overwriteOnConflict: false,
    },
    {
      id: seedPresetIds.adminFailurePreset,
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
      }),
      inventoryConfig: inventoryConfig({ startingStock: 200 }),
      erpConfig: erpConfig({ latencyMs: 300, maxTps: 30, errorRate: 0.25 }),
      backpressureConfig: backpressureConfig({ orderProcessConcurrency: 4 }),
      overwriteOnConflict: false,
    },
    {
      id: seedPresetIds.adminCustomPreset,
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

export function buyerSpikeTraffic(options: {
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

/** Without explicit VUs: the API allocates them for the rate at admission. */
function constantArrivalTraffic(options: {
  ratePerSecond: number;
  durationSeconds: number;
  startDelaySeconds?: number;
}): TrafficConfig {
  return {
    mode: "constant-arrival-rate",
    ratePerSecond: options.ratePerSecond,
    startDelaySeconds: options.startDelaySeconds ?? 0,
    durationSeconds: options.durationSeconds,
    quantityPerAttempt: 1,
  };
}

export function inventoryConfig(options: { startingStock: number }): InventoryConfig {
  return {
    startingStock: options.startingStock,
  };
}

export function erpConfig(options: {
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

export function backpressureConfig(options: {
  orderProcessConcurrency: number;
}): BackpressureConfig {
  return {
    queueName: "orders:process",
    physicalQueueName: "orders-process",
    orderProcessConcurrency: options.orderProcessConcurrency,
  };
}
