import { afterEach, describe, expect, it } from "vitest";
import { formatDashboardTime } from "../src/app/lib/dashboard-time.js";

describe("formatDashboardTime", () => {
  const originalTimezone = process.env.TZ;

  afterEach(() => {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  });

  it("formats a UTC midnight instant as a stable 12-hour UTC clock string", () => {
    process.env.TZ = "UTC";

    expect(formatDashboardTime("2026-06-20T00:00:10.000Z")).toBe("12:00:10 AM UTC");
  });

  it("returns the same exact text regardless of the host process timezone", () => {
    const iso = "2026-06-20T00:00:10.000Z";

    process.env.TZ = "UTC";
    const utcText = formatDashboardTime(iso);

    process.env.TZ = "America/New_York";
    const newYorkText = formatDashboardTime(iso);

    expect(utcText).toBe("12:00:10 AM UTC");
    expect(newYorkText).toBe("12:00:10 AM UTC");
    expect(newYorkText).toBe(utcText);
  });

  it("uses a 12-hour period that does not drift with the host timezone", () => {
    const iso = "2026-06-20T13:30:45.000Z";

    process.env.TZ = "UTC";
    const utcText = formatDashboardTime(iso);

    process.env.TZ = "America/New_York";
    const newYorkText = formatDashboardTime(iso);

    expect(utcText).toBe("01:30:45 PM UTC");
    expect(newYorkText).toBe("01:30:45 PM UTC");
  });
});
