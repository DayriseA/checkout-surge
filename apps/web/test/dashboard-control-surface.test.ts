import {
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  type DashboardRecoveryResponse,
  type DemoPresetContract,
  demoRunSnapshotSchema,
  type ErpChaosStatus,
  type PublicPresetListResponse,
  type PublicRuntimePolicyResponse,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminAuthenticatedSurface } from "../src/app/components/admin/admin-authenticated-surface.js";
import { AdminSignInView } from "../src/app/components/admin/admin-sign-in.js";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry.js";
import type { BackendRead, PublicDemoSurface } from "../src/app/lib/api.js";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("dashboard control surface", () => {
  it("renders the public visitor entry with curated and bounded custom starts", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: publicSurfaceFixture(null) }),
    );

    expect(markup).toContain("Curated surge presets");
    expect(markup).toContain("Preview 1k");
    expect(markup).not.toContain("Forced outage");
    expect(markup).toContain("Public custom");
    expect(markup).toContain("Start Public Custom");
    expect(markup).toContain("ERP max TPS");
  });

  it("follows response visibility and never exposes forced outage on public custom", () => {
    const surface = publicSurfaceFixture(null);
    if (surface.presets.status !== "available" || surface.runtimePolicy.status !== "available") {
      throw new Error("Expected available fixture reads.");
    }
    surface.presets.data.presets = [
      demoPresetFixture("custom", "admin", true),
      demoPresetFixture("public-custom", "public", true),
      demoPresetFixture("preview-1k", "public", false),
    ];
    surface.runtimePolicy.data.policy.publicCustomLimits.allowForcedOutage = true;
    surface.runtimePolicy.data.policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));
    expect(markup).toContain("Preview 1k");
    expect(markup).not.toContain(">Custom<");
    expect(markup).not.toContain("Forced outage");
  });

  it("renders an explicit empty state when no curated public presets are available", () => {
    const surface = publicSurfaceFixture(null);
    if (surface.presets.status !== "available") throw new Error("Expected available presets.");
    surface.presets.data.presets = [];
    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));
    expect(markup).toContain("No curated public presets are currently available.");
  });

  it("renders reordered and newly-added public presets from response data", () => {
    const surface = publicSurfaceFixture(null);
    if (surface.presets.status !== "available") throw new Error("Expected available presets.");
    const added = {
      ...demoPresetFixture("preview-1k", "public", false),
      id: "99999999-9999-4999-8999-999999999999",
      slug: "new-public-surge",
      display: {
        ...demoPresetFixture("preview-1k", "public", false).display,
        name: "New Public Surge",
      },
    };
    surface.presets.data.presets = [
      demoPresetFixture("public-custom", "public", true),
      added,
      demoPresetFixture("preview-1k", "public", false),
    ];
    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));
    expect(markup.indexOf("New Public Surge")).toBeLessThan(markup.indexOf("Preview 1k"));
  });

  it("handles only-public-custom, missing custom, and unavailable preset reads", () => {
    const onlyCustom = publicSurfaceFixture(null);
    if (onlyCustom.presets.status !== "available") throw new Error("Expected available presets.");
    onlyCustom.presets.data.presets = [demoPresetFixture("public-custom", "public", true)];
    const onlyCustomMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: onlyCustom }),
    );
    expect(onlyCustomMarkup).toContain("No curated public presets are currently available.");
    expect(onlyCustomMarkup).toContain("Start Public Custom");

    const noCustom = publicSurfaceFixture(null);
    if (noCustom.presets.status !== "available") throw new Error("Expected available presets.");
    noCustom.presets.data.presets = [demoPresetFixture("preview-1k", "public", false)];
    const noCustomMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: noCustom }),
    );
    expect(noCustomMarkup).not.toContain("Start Public Custom");

    const unavailable = publicSurfaceFixture(null);
    unavailable.presets = { status: "unavailable", reason: "Preset service offline" };
    const unavailableMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: unavailable }),
    );
    expect(unavailableMarkup).toContain("Preset service offline");
  });

  it("disables public starts while a run is active", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: publicSurfaceFixture(runFixture("active")) }),
    );

    expect(markup).toContain("run in progress");
    expect(markup).toContain("disabled");
  });

  it("labels unavailable recovery separately from an active run and retains manual retry", () => {
    const surface = publicSurfaceFixture(null);
    surface.recovery = {
      status: "unavailable",
      reason: "Authoritative run state is loading.",
    };
    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));

    expect(markup).toContain("availability unavailable");
    expect(markup).not.toContain("run in progress");
    expect(markup).toContain("Retry recovery");
    expect(markup).toContain("disabled");
  });

  it("renders only the admin sign-in gate for anonymous admin access", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminSignInView, {
        error: null,
        isPending: false,
        onPassphraseChange: () => undefined,
        onSignIn: () => undefined,
        passphrase: "",
      }),
    );

    expect(markup).toContain("Protected operator surface");
    expect(markup).toContain("Sign In");
    expect(markup).not.toContain("Reset Demo");
    expect(markup).not.toContain("Start Admin Run");
    expect(markup).not.toContain("Save Public Policy");
  });

  it("renders protected admin controls and disables starts while a run is draining", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminAuthenticatedSurface, {
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
      { ...demoPresetFixture("preview-1k", "public", false), canArchive: false },
      { ...demoPresetFixture("custom", "admin", true), canArchive: false },
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
    correlationId: "corr-web-recovery",
    scope: currentRun
      ? { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId ?? null }
      : null,
    currentRun,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    recentCompletionOutcomes: [],
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}

function runFixture(status: "active" | "draining"): DashboardRecoveryResponse["currentRun"] {
  return demoRunSnapshotSchema.parse({
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public",
    status,
    trafficStatus: status === "active" ? "active" : "succeeded",
    configSnapshot: configSnapshotFixture(),
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-06-20T00:00:00.000Z",
    trafficStartedAt: "2026-06-20T00:00:00.000Z",
    ...(status === "draining" ? { trafficEndedAt: "2026-06-20T00:00:10.000Z" } : {}),
  });
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
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  };
}
