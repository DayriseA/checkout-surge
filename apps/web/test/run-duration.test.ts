import { describe, expect, it } from "vitest";
import { deriveOverallRunDuration } from "../src/app/lib/presentation/run-duration.js";

describe("overall run duration", () => {
  it("measures a completed run from acceptance to terminal finalization", () => {
    const duration = deriveOverallRunDuration({
      startedAt: "2026-06-20T00:00:00.000Z",
      endedAt: "2026-06-20T00:00:10.000Z",
    });

    expect(duration).toEqual({ state: "measured", text: "10 s" });
  });

  it("measures a failed run from the same boundaries as a completed one", () => {
    // A failed run still reached a terminal transition, so its finalization timestamp is a real
    // end boundary rather than a missing one.
    const duration = deriveOverallRunDuration({
      startedAt: "2026-06-20T00:00:00.000Z",
      endedAt: "2026-06-20T00:00:02.400Z",
    });

    expect(duration.state).toBe("measured");
    expect(duration.text).toBe("2.4 s");
  });

  it("refuses to fabricate a duration for an interrupted record with no end boundary", () => {
    const duration = deriveOverallRunDuration({ startedAt: "2026-06-20T00:00:00.000Z" });

    expect(duration.state).toBe("no-recorded-end");
    expect(duration.text).toBe("— no recorded end");
    expect(duration.text).not.toContain("0 ms");
  });

  it("reports a missing start boundary distinctly from a missing end boundary", () => {
    const duration = deriveOverallRunDuration({ endedAt: "2026-06-20T00:00:10.000Z" });

    expect(duration.state).toBe("no-recorded-start");
    expect(duration.text).toBe("— no recorded start");
  });

  it("treats a record with neither boundary as having no recorded start", () => {
    expect(deriveOverallRunDuration({}).state).toBe("no-recorded-start");
    expect(deriveOverallRunDuration({ startedAt: null, endedAt: null }).state).toBe(
      "no-recorded-start",
    );
  });

  it("rejects unparseable and inverted boundaries instead of showing a zero", () => {
    expect(
      deriveOverallRunDuration({ startedAt: "nonsense", endedAt: "2026-06-20T00:00:10.000Z" })
        .state,
    ).toBe("no-recorded-start");
    expect(
      deriveOverallRunDuration({
        startedAt: "2026-06-20T00:00:10.000Z",
        endedAt: "2026-06-20T00:00:00.000Z",
      }),
    ).toEqual({
      state: "unusable-boundary",
      text: "— unusable lifecycle boundary",
    });
  });

  it("keeps a zero-length but fully recorded run distinct from a missing boundary", () => {
    const duration = deriveOverallRunDuration({
      startedAt: "2026-06-20T00:00:00.000Z",
      endedAt: "2026-06-20T00:00:00.000Z",
    });

    expect(duration).toEqual({ state: "measured", text: "0 ms" });
  });

  it("uses the human duration tiers for a long drain", () => {
    expect(
      deriveOverallRunDuration({
        startedAt: "2026-06-20T00:00:00.000Z",
        endedAt: "2026-06-20T00:02:08.000Z",
      }).text,
    ).toBe("2 min 8 s");
  });
});
