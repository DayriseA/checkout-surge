import type {
  AdminPresetListResponse,
  AdminPublicRuntimePolicyResponse,
  DashboardRecoveryResponse,
  DemoPresetContract,
  ErpChaosStatus,
  PublicPresetListResponse,
  PublicRuntimePolicyResponse,
} from "@checkout-surge/contracts";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminConsole, type AdminConsoleProps } from "../src/app/components/admin-console.js";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry.js";
import type { BackendRead, PublicDemoSurface } from "../src/app/lib/api.js";

const AdminConsoleForTest = AdminConsole as ComponentType<AdminConsoleProps>;

describe("dashboard control surface", () => {
  it("renders the public visitor entry with curated and bounded custom starts", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: publicSurfaceFixture(null) }),
    );

    expect(markup).toContain("Curated surge presets");
    expect(markup).toContain("Preview 1k");
    expect(markup).toContain("Public custom");
    expect(markup).toContain("Start Public Custom");
    expect(markup).toContain("ERP max TPS");
  });

  it("disables public starts while a run is active", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: publicSurfaceFixture(runFixture("active")) }),
    );

    expect(markup).toContain("run in progress");
    expect(markup).toContain("disabled");
  });

  it("renders only the admin sign-in gate for anonymous admin access", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminConsoleForTest, { autoCheckSession: false }),
    );

    expect(markup).toContain("Protected operator surface");
    expect(markup).toContain("Sign In");
    expect(markup).not.toContain("Reset Demo");
    expect(markup).not.toContain("Start Admin Run");
    expect(markup).not.toContain("Save Public Policy");
  });

  it("renders protected admin controls and disables starts while a run is draining", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminConsoleForTest, {
        autoCheckSession: false,
        initialAuthenticated: true,
        initialErpChaos: available(erpChaosFixture()),
        initialPresets: available(adminPresetListFixture()),
        initialRecovery: available(recoveryFixture(runFixture("draining"))),
        initialRuntimePolicy: available(adminRuntimePolicyFixture()),
      }),
    );

    expect(markup).toContain("Inspection and starts");
    expect(markup).toContain("Public policy");
    expect(markup).toContain("Save Public Policy");
    expect(markup).toContain("Hard max buyers");
    expect(markup).toContain("Start Admin Run");
    expect(markup).toContain("Save Preset");
    expect(markup).toContain("Copy to Custom");
    expect(markup).toContain("Reset Demo");
    expect(markup).toContain("ERP diagnostics");
    expect(markup).toContain("disabled");
  });
});

function publicSurfaceFixture(
  currentRun: DashboardRecoveryResponse["currentRun"],
): PublicDemoSurface {
  return {
    presets: available(publicPresetListFixture()),
    runtimePolicy: available(publicRuntimePolicyFixture()),
    recovery: available(recoveryFixture(currentRun)),
  };
}

function available<T>(data: T): BackendRead<T> {
  return { status: "available", data, httpStatus: 200 };
}

function publicPresetListFixture(): PublicPresetListResponse {
  return {
    presets: [
      demoPresetFixture("preview-1k", "public", false),
      demoPresetFixture("public-custom", "public", true),
    ],
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function adminPresetListFixture(): AdminPresetListResponse {
  return {
    presets: [
      demoPresetFixture("preview-1k", "public", false),
      demoPresetFixture("custom", "admin", true),
    ],
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function publicRuntimePolicyFixture(): PublicRuntimePolicyResponse {
  return {
    id: "active",
    policy: {
      isPublicRunBudgetEnforced: true,
      publicRunBudget: {
        windowSeconds: 300,
        perVisitorMaxStarts: 2,
        globalMaxStarts: 6,
      },
      publicCustomDefaults: configSnapshotFixture(),
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
    },
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function adminRuntimePolicyFixture(): AdminPublicRuntimePolicyResponse {
  return {
    ...publicRuntimePolicyFixture(),
    correlationId: "corr-admin-policy",
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function recoveryFixture(
  currentRun: DashboardRecoveryResponse["currentRun"],
): DashboardRecoveryResponse {
  return {
    currentRun,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recentCompletionOutcomes: [],
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}

function runFixture(status: "active" | "draining"): DashboardRecoveryResponse["currentRun"] {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public",
    status,
    trafficStatus: status === "active" ? "active" : "succeeded",
    configSnapshot: configSnapshotFixture(),
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-06-20T00:00:00.000Z",
  };
}

function erpChaosFixture(): ErpChaosStatus {
  return {
    latencyMs: 50,
    maxTps: 100,
    errorRate: 0,
    forcedOutage: false,
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function demoPresetFixture(
  slug: string,
  visibility: "public" | "admin",
  isCustom: boolean,
): DemoPresetContract {
  return {
    id:
      slug === "custom"
        ? "44444444-4444-4444-8444-444444444444"
        : slug === "public-custom"
          ? "55555555-5555-4555-8555-555555555555"
          : "33333333-3333-4333-8333-333333333333",
    slug,
    visibility,
    isEditable: visibility === "admin",
    isCustom,
    display: {
      name:
        slug === "custom" ? "Custom" : slug === "public-custom" ? "Public Custom" : "Preview 1k",
      description: "Preset fixture.",
      sortOrder: slug === "custom" ? 100 : 10,
      outcomeFocus: [],
    },
    ...configSnapshotFixture(),
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function configSnapshotFixture() {
  return {
    trafficConfig: {
      mode: "buyer-spike" as const,
      buyerCount: 1000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 250,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 80,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process" as const,
      physicalQueueName: "orders-process" as const,
      orderProcessConcurrency: 5,
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
  };
}
