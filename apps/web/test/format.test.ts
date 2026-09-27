import { afterEach, describe, expect, it } from "vitest";
import {
  formatCount,
  formatDurationMs,
  formatInstantUtc,
  formatWindowSeconds,
  formatWindowSecondsAdjective,
} from "../src/app/lib/presentation/format.js";

describe("formatInstantUtc", () => {
  const originalTimezone = process.env.TZ;

  afterEach(() => {
    if (originalTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimezone;
    }
  });

  it("renders a dated 24-hour UTC clock by default", () => {
    expect(formatInstantUtc("2026-08-03T14:32:05.000Z")).toBe("2026-08-03 14:32:05 UTC");
  });

  it("converts a non-Z offset to the same UTC wall clock", () => {
    // The genuinely risky input: an ISO string that already carries a zone other than UTC. A
    // formatter that pulled the calendar and clock fields out of the string instead of the
    // instant would report 16:32 and the wrong policy.
    expect(formatInstantUtc("2026-08-03T16:32:05+02:00")).toBe("2026-08-03 14:32:05 UTC");
    expect(formatInstantUtc("2026-08-03T09:32:05-05:00")).toBe("2026-08-03 14:32:05 UTC");
  });

  it("pushes a negative-offset instant onto the correct UTC calendar day", () => {
    // 19:00 on the 19th in New York is already the 20th in UTC; a viewer-local reading would
    // put this run on the previous day.
    expect(formatInstantUtc("2026-06-19T20:00:00-05:00")).toBe("2026-06-20 01:00:00 UTC");
  });

  it("produces identical text regardless of the host process timezone", () => {
    // The second instant is the hour Europe/Paris switches to daylight-saving time; a formatter
    // that read local accessors would drift there in exactly the zones that observe DST.
    const instants = [
      { iso: "2026-06-20T00:00:10.000Z", expected: "2026-06-20 00:00:10 UTC" },
      { iso: "2026-03-29T01:30:00.000Z", expected: "2026-03-29 01:30:00 UTC" },
    ];

    for (const { iso, expected } of instants) {
      process.env.TZ = "UTC";
      const utcText = formatInstantUtc(iso);
      expect(utcText).toBe(expected);

      process.env.TZ = "America/New_York";
      const newYorkText = formatInstantUtc(iso);

      process.env.TZ = "Australia/Sydney";
      const sydneyText = formatInstantUtc(iso);

      expect(newYorkText).toBe(utcText);
      expect(sydneyText).toBe(utcText);
    }
  });

  it("renders a compact clock-only variant for contexts that already fix the date", () => {
    expect(formatInstantUtc("2026-08-03T14:32:05.000Z", { variant: "timeOnly" })).toBe(
      "14:32:05 UTC",
    );
  });

  it("returns null for missing input instead of inventing an instant", () => {
    expect(formatInstantUtc(undefined)).toBeNull();
    expect(formatInstantUtc(null)).toBeNull();
  });
});

describe("formatDurationMs", () => {
  it("distinguishes missing input from zero", () => {
    expect(formatDurationMs(null)).toBeNull();
    expect(formatDurationMs(undefined)).toBeNull();
    expect(formatDurationMs(0)).toBe("0 ms");
  });

  it("rejects a negative interval rather than rendering a backwards duration", () => {
    expect(formatDurationMs(-1)).toBeNull();
  });

  it("renders sub-second values as whole milliseconds", () => {
    expect(formatDurationMs(1)).toBe("1 ms");
    expect(formatDurationMs(126.683)).toBe("127 ms");
    expect(formatDurationMs(847)).toBe("847 ms");
    expect(formatDurationMs(999)).toBe("999 ms");
  });

  it("rounds half up and lets a value cross the one-second boundary", () => {
    expect(formatDurationMs(999.4)).toBe("999 ms");
    expect(formatDurationMs(999.5)).toBe("1 s");
  });

  it("renders exactly one second as seconds", () => {
    expect(formatDurationMs(1_000)).toBe("1 s");
  });

  it("renders multi-second values with at most one useful decimal", () => {
    expect(formatDurationMs(1_499)).toBe("1.5 s");
    expect(formatDurationMs(12_000)).toBe("12 s");
    expect(formatDurationMs(28_449)).toBe("28.4 s");
    expect(formatDurationMs(14_487.6)).toBe("14.5 s");
    expect(formatDurationMs(11_028.779)).toBe("11 s");
  });

  it("drops a trailing .0 rather than implying spurious precision", () => {
    expect(formatDurationMs(12_010)).toBe("12 s");
    expect(formatDurationMs(12_040)).toBe("12 s");
    expect(formatDurationMs(12_050)).toBe("12.1 s");
  });

  it("switches to minutes and seconds at two minutes", () => {
    expect(formatDurationMs(119_900)).toBe("119.9 s");
    expect(formatDurationMs(120_000)).toBe("2 min 0 s");
    expect(formatDurationMs(128_000)).toBe("2 min 8 s");
  });

  it("switches to hours and minutes at one hour rather than counting minutes upward", () => {
    expect(formatDurationMs(3_599_000)).toBe("59 min 59 s");
    expect(formatDurationMs(3_600_000)).toBe("1 h 0 min");
    expect(formatDurationMs(3_600_000 + 8 * 60_000)).toBe("1 h 8 min");
  });
});

describe("formatCount", () => {
  it("groups large counts and admin hard caps identically", () => {
    expect(formatCount(100_000)).toBe("100,000");
    expect(formatCount(1_048_576)).toBe("1,048,576");
  });

  it("leaves small counts ungrouped", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });

  it("keeps a fractional value fractional rather than rounding it to a whole count", () => {
    // Load-bearing: the reservation-timing histogram bucket edges are declared in fractional
    // milliseconds and render through this formatter, so rounding to whole numbers would turn
    // the `≤ 0.25ms` bound into `≤ 0ms`.
    expect(formatCount(0.25)).toBe("0.25");
    expect(formatCount(0.75)).toBe("0.75");
    expect(formatCount(1.5)).toBe("1.5");
    expect(formatCount(1_234.5)).toBe("1,234.5");
  });

  it("returns null for missing input", () => {
    expect(formatCount(null)).toBeNull();
    expect(formatCount(undefined)).toBeNull();
  });
});

describe("formatWindowSeconds", () => {
  it("renders an integer width without inventing decimals", () => {
    expect(formatWindowSeconds(60)).toBe("60");
    expect(formatWindowSeconds(0)).toBe("0");
  });

  it("keeps a fractional width, which the tiered duration policy would have hidden", () => {
    expect(formatWindowSeconds(0.5)).toBe("0.5");
    expect(formatWindowSeconds(1.25)).toBe("1.25");
    expect(formatWindowSeconds(1.2345)).toBe("1.23");
  });

  it("groups a width at or above one thousand under the shared locale policy", () => {
    expect(formatWindowSeconds(1_000)).toBe("1,000");
    expect(formatWindowSeconds(86_400)).toBe("86,400");
  });
});

describe("formatWindowSecondsAdjective", () => {
  it("renders an integer width as an adjective", () => {
    expect(formatWindowSecondsAdjective(60)).toBe("60-second");
    expect(formatWindowSecondsAdjective(300)).toBe("300-second");
  });

  it("keeps a fractional width in the adjective form", () => {
    expect(formatWindowSecondsAdjective(0.5)).toBe("0.5-second");
    expect(formatWindowSecondsAdjective(1.2345)).toBe("1.23-second");
  });

  it("groups a large width exactly as the value form does", () => {
    expect(formatWindowSecondsAdjective(86_400)).toBe("86,400-second");
  });
});
