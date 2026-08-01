// @vitest-environment jsdom

import {
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
} from "@checkout-surge/contracts";
import { act } from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { OperatorDashboard } from "../src/app/components/operator-dashboard.js";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry.js";
import type { PublicDemoSurface } from "../src/app/lib/api.js";

describe("dashboard hydration", () => {
  const originalTimezone = process.env.TZ;
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof hydrateRoot> | null = null;

  afterEach(() => {
    if (root) {
      root.unmount();
      root = null;
    }
    container?.remove();
    container = null;
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  });

  it("hydrates the start gate without recoverable errors", async () => {
    const surface = publicSurfaceFixture();

    const serverMarkup = renderToString(createElement(PublicDemoEntry, { surface }));

    const next = document.createElement("div");
    next.innerHTML = serverMarkup;
    document.body.appendChild(next);
    container = next;

    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(next, createElement(PublicDemoEntry, { surface }), {
        onRecoverableError: (error) => {
          recoverableErrors.push(error);
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(next.textContent).toContain("ready");
  });

  it("hydrates Watch timestamps when the server and browser timezones differ", async () => {
    const recovery = dashboardRecoveryFixture();

    process.env.TZ = "UTC";
    const serverMarkup = renderToString(
      createElement(OperatorDashboard, {
        initialRecovery: { status: "available", data: recovery, httpStatus: 200 },
      }),
    );
    expect(serverMarkup).toContain("Not yet available");
    expect(serverMarkup).not.toContain("Peak 0");
    expect(serverMarkup).not.toContain("0 remaining");

    const next = document.createElement("div");
    next.innerHTML = serverMarkup;
    document.body.appendChild(next);
    container = next;

    process.env.TZ = "America/New_York";
    const recoverableErrors: unknown[] = [];
    await act(async () => {
      root = hydrateRoot(
        next,
        createElement(OperatorDashboard, {
          initialRecovery: { status: "available", data: recovery, httpStatus: 200 },
        }),
        {
          onRecoverableError: (error) => {
            recoverableErrors.push(error);
          },
        },
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(recoverableErrors).toHaveLength(0);
    expect(next.textContent).toContain("12:00:10 AM UTC");
  });
});

function dashboardRecoveryFixture(): DashboardProjection {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    scopeId: "idle",
    revision: 1,
    correlationId: "corr-web-recovery",
    scope: null,
    currentRun: null,
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
    recentCompletionOutcomes: [],
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}

function publicSurfaceFixture(): PublicDemoSurface {
  return {
    presets: { status: "unavailable", reason: "fixture" },
    readiness: {
      status: "available",
      data: {
        service: "api",
        status: "ok",
        timestamp: "2026-06-20T00:00:10.000Z",
        uptimeSeconds: 10,
        checks: [{ name: "database_reachable", status: "ok" }],
      },
      httpStatus: 200,
    },
    runtimePolicy: { status: "unavailable", reason: "fixture" },
    recovery: { status: "available", data: dashboardRecoveryFixture(), httpStatus: 200 },
  };
}
