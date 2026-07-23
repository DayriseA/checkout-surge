import { dashboardEventsPath } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { dashboardEventsUrl } from "../src/app/lib/realtime.js";

describe("dashboard realtime URL", () => {
  it("uses the same-origin dashboard events path", () => {
    expect(dashboardEventsUrl()).toBe(dashboardEventsPath);
  });
});
