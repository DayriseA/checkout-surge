import {
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveryStatusPanel } from "../src/app/components/dashboard-panels.js";

describe("dashboard recovery retry UI", () => {
  it("shows initial unavailability without claiming a last-known-good projection", () => {
    const markup = renderToStaticMarkup(
      createElement(RecoveryStatusPanel, {
        recovery: { status: "unavailable", reason: "API restarting", httpStatus: 503 },
        realtimeStatus: "connected",
        liveProjectionCount: 0,
        hasSyncIssue: true,
        syncIssue: { status: "unavailable", reason: "API restarting", httpStatus: 503 },
        isRetryScheduled: true,
        retryAttempt: 2,
        retryDelayMs: 2_000,
      }),
    );

    expect(markup).not.toContain("Last-known-good projection");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("API restarting");
  });

  it("labels a failed refresh when a complete last-known-good projection is retained", () => {
    const markup = renderToStaticMarkup(
      createElement(RecoveryStatusPanel, {
        recovery: { status: "available", data: projectionFixture(), httpStatus: 200 },
        realtimeStatus: "connected",
        liveProjectionCount: 4,
        hasSyncIssue: true,
        syncIssue: { status: "unavailable", reason: "API restarting", httpStatus: 503 },
        isRetryScheduled: true,
        retryAttempt: 2,
        retryDelayMs: 2_000,
      }),
    );

    expect(markup).toContain("Last-known-good projection");
    expect(markup).toContain("Retry scheduled in 2s (attempt 2).");
    expect(markup).toContain("API restarting");
  });
});

function projectionFixture(): DashboardProjection {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    scopeId: "idle",
    revision: 1,
    correlationId: "corr-ui-recovery",
    scope: null,
    currentRun: null,
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
