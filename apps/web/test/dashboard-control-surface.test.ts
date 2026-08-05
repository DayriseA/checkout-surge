import {
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  type DashboardProjection,
  type DemoPresetContract,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
  type ErpChaosStatus,
  type HealthResponse,
  type PublicPresetListResponse,
  type PublicRuntimePolicyResponse,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminAuthenticatedSurface } from "../src/app/components/admin/admin-authenticated-surface.js";
import { AdminRuntimePolicyView } from "../src/app/components/admin/admin-feature-views.js";
import { AdminSignInView } from "../src/app/components/admin/admin-sign-in.js";
import {
  derivePresetCardFacts,
  PublicDemoEntry,
  readinessPresentation,
} from "../src/app/components/public-demo-entry.js";
import { draftFromRuntimePolicy } from "../src/app/lib/admin-drafts.js";
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
    expect(markup).toContain("Build your own run");
    expect(markup).toContain("Start custom run");
    expect(markup.match(/Starting a bounded run uses the one shared demo runtime/g)?.length).toBe(
      2,
    );
    expect(markup).toContain("other visitors can&#x27;t start until it finishes");
    expect(markup).toContain("A successful start opens the live view.");
    expect(markup).toContain("Capacity (orders/second)");
    expect(markup.indexOf("Preview 1k")).toBeLessThan(markup.indexOf("Build your own run"));
    expect(markup).toContain("<form");
    expect(markup).toContain("<legend");
    expect(markup).toContain(">Buyers</legend>");
    expect(markup).toContain(">Stock</legend>");
    expect(markup).toContain(">Slow ERP</legend>");
    expect(markup).toContain("Advanced protection settings");
    expect(markup).toContain("Safety cutoff (seconds)");
    expect(markup).toContain("Start delay (seconds)");
    expect(markup).toContain("not the expected run duration");
    expect(markup).toContain("Unit: percent. Minimum: 0. Maximum: 25.");
    expect(markup).not.toContain("Worker concurrency");
    expect(markup).not.toContain("Retry attempts");
    expect(markup).not.toContain("Initial retry backoff");
    expect(markup).not.toContain("Drain timeout");
    expect(markup).not.toContain("Persistence retry delay");
    expect(markup).not.toContain("Circuit failure threshold");
    expect(markup).not.toContain("Circuit reset timeout");
    expect(markup).not.toContain("Reservation hold");
    expect(markup).not.toContain("ERP request timeout");
    expect(markup).toContain("Planned total attempts: 1,000");
    expect(markup).toContain("Up to 2 starts per visitor and 6 starts total every 5 minutes.");
    expect(markup).toContain(">ready<");
    expect(markup).not.toContain("database_reachable");
    expect(markup).not.toContain("Current run");
    expect(markup).not.toContain("Start gating");
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

  it("renders shared start rules from policy data without implying unenforced budgets", () => {
    const enforced = publicSurfaceFixture(null);
    if (enforced.runtimePolicy.status !== "available") throw new Error("Expected policy.");
    enforced.runtimePolicy.data.policy.publicRunBudget = {
      windowSeconds: 90,
      perVisitorMaxStarts: 4,
      globalMaxStarts: 12,
    };
    expect(renderToStaticMarkup(createElement(PublicDemoEntry, { surface: enforced }))).toContain(
      "Up to 4 starts per visitor and 12 starts total every 90 seconds.",
    );

    enforced.runtimePolicy.data.policy.isPublicRunBudgetEnforced = false;
    const unenforcedMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: enforced }),
    );
    expect(unenforcedMarkup).toContain("Public start budgets are not enforced right now.");
    expect(unenforcedMarkup).not.toContain("Up to 4 starts");
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
    expect(markup.indexOf("Preview 1k")).toBeLessThan(markup.indexOf("New Public Surge"));
  });

  it("renders comparable scenario facts and derives duplicate outcomes without extra sellout", () => {
    const surface = publicSurfaceFixture(null);
    if (surface.presets.status !== "available") throw new Error("Expected available presets.");
    const duplicatePreset: DemoPresetContract = {
      ...demoPresetFixture("preview-1k", "public", false),
      id: "99999999-9999-4999-8999-999999999998",
      slug: "idempotency-check-200",
      display: {
        name: "Duplicate-click storm",
        description: "200 buyers, every buyer clicks Buy twice.",
        sortOrder: 40,
        outcomeFocus: ["idempotency", "happy_path"],
      },
      trafficConfig: {
        ...configSnapshotFixture().trafficConfig,
        buyerCount: 200,
        duplicateEachBuyerAttempt: true,
      },
      inventoryConfig: {
        ...configSnapshotFixture().inventoryConfig,
        startingStock: 200,
      },
      erpConfig: {
        ...configSnapshotFixture().erpConfig,
        latencyMs: 50,
        maxTps: 200,
      },
    };
    const steadyPreset: DemoPresetContract = {
      ...demoPresetFixture("preview-1k", "public", false),
      id: "99999999-9999-4999-8999-999999999997",
      slug: "steady-public-surge",
      display: {
        name: "Steady public surge",
        description: "100 attempts per second for 10 seconds.",
        sortOrder: 50,
        outcomeFocus: ["queue_pressure"],
      },
      trafficConfig: {
        mode: "constant-arrival-rate",
        ratePerSecond: 100,
        startDelaySeconds: 0,
        durationSeconds: 10,
        quantityPerAttempt: 1,
      },
    };
    surface.presets.data.presets = [
      duplicatePreset,
      steadyPreset,
      {
        ...demoPresetFixture("preview-1k", "public", false),
        display: {
          name: "Preview 1k",
          description: "1,000 buyers rush 250 units.",
          sortOrder: 10,
          outcomeFocus: ["happy_path", "sold_out"],
        },
      },
    ];

    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));
    const duplicateFacts = derivePresetCardFacts(duplicatePreset);
    const steadyFacts = derivePresetCardFacts(steadyPreset);

    expect(markup.indexOf("Preview 1k")).toBeLessThan(markup.indexOf("Duplicate-click storm"));
    expect(markup).toContain("<h3");
    expect(markup).toContain("Recommended: start here");
    expect(markup).toContain("Start Preview 1k");
    expect(markup).toContain("Start Duplicate-click storm");
    expect(markup).toContain("Scenario");
    expect(markup).toContain("Everyone at once");
    expect(markup).toContain("Steady stream");
    expect(markup).not.toContain("buyer-spike");
    expect(markup).not.toContain("constant-arrival-rate");
    expect(markup).toContain("Simulated ERP capacity");
    expect(markup).toContain("200 orders/s");
    expect(markup).toContain("Simulated ERP delay per order");
    expect(markup).toContain("50 ms");
    expect(markup).toContain("Yes — every buyer sends the same request twice");
    expect(markup).toContain("The API safely replays the same accepted reservation");
    expect(markup).toContain("What to watch for");
    expect(markup).toContain("Duplicate clicks replay one reservation");
    expect(markup).toContain("Reservations confirm cleanly");
    expect(markup).not.toContain("happy_path");
    expect(markup).not.toContain(">idempotency<");
    expect(duplicateFacts.expectedSoldOutCount).toBe(0);
    expect(duplicateFacts.settlingCopy).toContain("2 s");
    expect(duplicateFacts.settlingCopy).toContain("actual time depends on the environment");
    expect(steadyFacts.duplicateAttempts).toBe("No");
  });

  it("handles only-public-custom, missing custom, and unavailable preset reads", () => {
    const onlyCustom = publicSurfaceFixture(null);
    if (onlyCustom.presets.status !== "available") throw new Error("Expected available presets.");
    onlyCustom.presets.data.presets = [demoPresetFixture("public-custom", "public", true)];
    const onlyCustomMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: onlyCustom }),
    );
    expect(onlyCustomMarkup).toContain("No curated public presets are currently available.");
    expect(onlyCustomMarkup).toContain("Start custom run");

    const noCustom = publicSurfaceFixture(null);
    if (noCustom.presets.status !== "available") throw new Error("Expected available presets.");
    noCustom.presets.data.presets = [demoPresetFixture("preview-1k", "public", false)];
    const noCustomMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: noCustom }),
    );
    expect(noCustomMarkup).not.toContain("Start custom run");

    const unavailable = publicSurfaceFixture(null);
    unavailable.presets = { status: "unavailable", reason: "Preset service offline" };
    const unavailableMarkup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: unavailable }),
    );
    expect(unavailableMarkup).toContain(
      "The demo backend isn&#x27;t ready yet — try again in a moment",
    );
    expect(unavailableMarkup).toContain(">Check again<");
    expect(unavailableMarkup).not.toContain("Preset service offline");
  });

  it("disables public starts while a run is active", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicDemoEntry, { surface: publicSurfaceFixture(runFixture("active")) }),
    );

    expect(markup).toContain("accepting checkout attempts");
    expect(markup).toContain("Watch live");
    expect(markup).toContain('href="/watch"');
    expect(markup).toContain("disabled");
  });

  it("renders initial recovery as neutral checking without error or retry controls", () => {
    const surface = publicSurfaceFixture(null);
    surface.recovery = { status: "loading" };
    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));

    expect(markup).toContain("checking availability");
    expect(markup).not.toContain("run in progress");
    expect(markup).not.toContain("Unavailable");
    expect(markup).not.toContain("Check again");
    expect(markup).not.toContain("Automatic retry");
    expect(markup).toContain("disabled");
  });

  it("shows failed readiness checks and blocks starts", () => {
    const surface = publicSurfaceFixture(null);
    surface.readiness = available({
      ...readinessFixture(),
      status: "unavailable",
      checks: [
        {
          name: "database_reachable",
          status: "unavailable",
          message: "PostgreSQL readiness check failed.",
        },
      ],
    });

    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));

    expect(markup).toContain(">backend not ready<");
    expect(markup).toContain("The demo backend isn&#x27;t ready yet — try again in a moment");
    expect(markup).not.toContain("database_reachable");
    expect(markup).not.toContain("PostgreSQL readiness check failed.");
    expect(markup).toContain("disabled");
  });

  it("blocks starts when the readiness read is unavailable", () => {
    const surface = publicSurfaceFixture(null);
    surface.readiness = { status: "unavailable", reason: "Readiness proxy offline" };

    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));

    expect(markup).toContain(">backend not ready<");
    expect(markup).toContain("The demo backend isn&#x27;t ready yet — try again in a moment");
    expect(markup).not.toContain("Readiness proxy offline");
    expect(markup).toContain("disabled");
  });

  it("blocks starts when readiness is degraded", () => {
    const surface = publicSurfaceFixture(null);
    surface.readiness = available({
      ...readinessFixture(),
      status: "degraded",
      checks: [
        {
          name: "order_process_queue_reachable",
          status: "degraded",
          message: "Queue connectivity is slow.",
        },
      ],
    });

    const markup = renderToStaticMarkup(createElement(PublicDemoEntry, { surface }));

    expect(markup).toContain(">backend not ready<");
    expect(markup).toContain("The demo backend isn&#x27;t ready yet — try again in a moment");
    expect(markup).not.toContain("order_process_queue_reachable");
    expect(markup).not.toContain("Queue connectivity is slow.");
    expect(markup).toContain("disabled");
  });

  it("keeps degraded and unavailable readiness state vocabulary distinct", () => {
    const degraded = readinessPresentation(
      available({ ...readinessFixture(), status: "degraded" }),
    );
    const unavailable = readinessPresentation(
      available({ ...readinessFixture(), status: "unavailable" }),
    );

    expect(degraded).toMatchObject({
      state: "infrastructure-degraded",
      label: "backend not ready",
    });
    expect(unavailable).toMatchObject({
      state: "infrastructure-unavailable",
      label: "backend not ready",
    });
  });

  it("renders only the admin sign-in gate for anonymous admin access", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminSignInView, {
        error: null,
        isPending: false,
        retryAfterMs: null,
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

  it("presents absent admin runtime policy evidence neutrally", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminRuntimePolicyView, {
        draft: null,
        isPending: false,
        notice: null,
        onRefresh: () => undefined,
        onSave: () => undefined,
        onUpdateDraft: () => undefined,
        runtimePolicy: { status: "unavailable", reason: "policy offline" },
      }),
    );

    expect(markup).toMatch(/bg-surface-muted[^>]*>.*not yet available/);
    expect(markup).not.toContain(">open</span>");
    expect(markup).not.toContain("bg-info-soft");
  });

  it("omits forced outage from dashboard policy editing even when compatibility fields are true", () => {
    const runtimePolicy = adminRuntimePolicyFixture();
    runtimePolicy.policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    runtimePolicy.policy.publicCustomLimits.allowForcedOutage = true;
    const markup = renderToStaticMarkup(
      createElement(AdminRuntimePolicyView, {
        draft: draftFromRuntimePolicy(runtimePolicy.policy),
        isPending: false,
        notice: null,
        onRefresh: () => undefined,
        onSave: () => undefined,
        onUpdateDraft: () => undefined,
        runtimePolicy: available(runtimePolicy),
      }),
    );

    expect(markup).not.toContain("runtime-policy-erpForcedOutage");
    expect(markup).not.toContain("runtime-policy-allowForcedOutage");
  });

  it("renders protected admin controls and disables starts while a run is draining", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminAuthenticatedSurface, {
        initialErpChaos: available(erpChaosFixture()),
        initialPresets: available(adminPresetListFixture()),
        initialRecovery: available(recoveryFixture(runFixture("draining"))),
        initialReadiness: available(readinessFixture()),
        initialRuntimePolicy: available(adminRuntimePolicyFixture()),
      }),
    );

    expect(markup).toContain("Inspection and starts");
    expect(markup).toContain("Public policy");
    expect(markup).toContain("Save Public Policy");
    expect(markup).toContain("Hard max buyers");
    // The fixture's hard caps are exactly 100,000. B10's criterion is about presentation, so
    // assert the grouped form actually reaches the markup rather than an ungrouped digit wall.
    expect(markup).toContain(">100,000<");
    expect(markup).not.toContain(">100000<");
    expect(markup).toContain("Start Admin Run");
    expect(markup).toContain("Save Preset");
    expect(markup).toContain("Copy to Custom");
    expect(markup).toContain('id="preset-erpForcedOutage"');
    expect(markup).toContain('id="erp-chaos-forcedOutage"');
    expect(markup).not.toContain('id="runtime-policy-erpForcedOutage"');
    expect(markup).not.toContain('id="runtime-policy-allowForcedOutage"');
    expect(markup).toContain("Reset Demo");
    expect(markup).toContain("ERP diagnostics");
    expect(markup).toContain("disabled");
  });
});

function publicSurfaceFixture(currentRun: DashboardProjection["currentRun"]): PublicDemoSurface {
  return {
    presets: available(publicPresetListFixture()),
    readiness: available(readinessFixture()),
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

function readinessFixture(): HealthResponse {
  return {
    service: "api",
    status: "ok",
    timestamp: "2026-06-20T00:00:10.000Z",
    uptimeSeconds: 10,
    checks: [{ name: "database_reachable", status: "ok" }],
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
        allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
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

function recoveryFixture(currentRun: DashboardProjection["currentRun"]): DashboardProjection {
  const scope = recoveryScope(currentRun);
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    scopeId: dashboardProjectionScopeId(scope),
    revision: 1,
    correlationId: "corr-web-recovery",
    scope,
    currentRun,
    inventory: null,
    recentMetrics: [],
    erp: null,
    systemStatus: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}

function recoveryScope(currentRun: DashboardProjection["currentRun"]) {
  if (!currentRun) return null;
  if (!currentRun.saleOfferId) {
    throw new Error(`Run ${currentRun.runId} fixture requires a sale offer.`);
  }
  return { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId };
}

function runFixture(status: "active" | "draining"): DashboardProjection["currentRun"] {
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
    effectiveSafetyCaps: {
      maxLatencyMs: 5000,
      minMaxTps: 1,
      maxErrorRate: 1,
      allowForcedOutage: true,
    },
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
