import { dashboardEventsPath } from "@checkout-surge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { dashboardEventsUrl } from "../src/app/lib/realtime.js";

const originalEnv = { ...process.env };

describe("dashboard realtime URL", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("uses the same-origin dashboard events path by default", () => {
    delete process.env.NEXT_PUBLIC_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_DASHBOARD_EVENTS_URL;

    expect(dashboardEventsUrl()).toBe(dashboardEventsPath);
  });

  it("does not derive the browser SSE URL from the legacy public API base URL", () => {
    process.env.NEXT_PUBLIC_API_BASE_URL = "http://localhost:4000";
    delete process.env.NEXT_PUBLIC_DASHBOARD_EVENTS_URL;

    expect(dashboardEventsUrl()).toBe(dashboardEventsPath);
  });

  it("uses an explicit browser events endpoint override for direct API debug sessions", () => {
    process.env.NEXT_PUBLIC_DASHBOARD_EVENTS_URL = " http://localhost:4000/dashboard/events ";

    expect(dashboardEventsUrl()).toBe("http://localhost:4000/dashboard/events");
  });

  it("falls back to the same-origin path when the debug override is blank", () => {
    process.env.NEXT_PUBLIC_DASHBOARD_EVENTS_URL = "   ";

    expect(dashboardEventsUrl()).toBe(dashboardEventsPath);
  });
});
