// @vitest-environment jsdom

import type { DashboardRecoveryResponse } from "@checkout-surge/contracts";
import { act } from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry.js";
import type { PublicDemoSurface } from "../src/app/lib/api.js";

describe("PublicDemoEntry hydration", () => {
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

  it("hydrates without recoverable errors when the server and browser timezones differ", async () => {
    const surface = publicSurfaceFixture();

    process.env.TZ = "UTC";
    const serverMarkup = renderToString(createElement(PublicDemoEntry, { surface }));

    const next = document.createElement("div");
    next.innerHTML = serverMarkup;
    document.body.appendChild(next);
    container = next;

    process.env.TZ = "America/New_York";

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
    expect(next.textContent).toContain("12:00:10 AM UTC");
  });
});

function publicSurfaceFixture(): PublicDemoSurface {
  const recovery: DashboardRecoveryResponse = {
    correlationId: "corr-web-recovery",
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
  return {
    presets: { status: "unavailable", reason: "fixture" },
    runtimePolicy: { status: "unavailable", reason: "fixture" },
    recovery: { status: "available", data: recovery, httpStatus: 200 },
  };
}
