import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecoveryStatusPanel } from "../src/app/components/dashboard-panels.js";

describe("dashboard recovery retry UI", () => {
  it("shows the unavailable reason and scheduled sync issue even while SSE is connected", () => {
    const markup = renderToStaticMarkup(
      createElement(RecoveryStatusPanel, {
        recovery: { status: "unavailable", reason: "API restarting", httpStatus: 503 },
        realtimeStatus: "connected",
        liveEventCount: 4,
        hasSyncIssue: true,
        isRetryScheduled: true,
        retryAttempt: 2,
        retryDelayMs: 2_000,
      }),
    );

    expect(markup).toContain("Live sync issue");
    expect(markup).toContain("Retry scheduled in 2s (attempt 2).");
    expect(markup).toContain("API restarting");
  });
});
