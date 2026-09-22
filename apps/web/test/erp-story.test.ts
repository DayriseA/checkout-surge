import type { RunErpOutcomeSummary } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { deriveRunErpStory } from "../src/app/lib/presentation/erp-story.js";

describe("simulated-ERP story", () => {
  const withFailures = "Recent simulated-ERP calls include failures or timeouts";

  it.each([
    {
      name: "no failures or timeouts",
      failures: 0,
      timeouts: 0,
      expected: "Recent simulated-ERP calls succeeded",
    },
    { name: "a failure", failures: 1, timeouts: 0, expected: withFailures },
    { name: "a timeout", failures: 0, timeouts: 1, expected: withFailures },
    // An all-failed window must not read as the ERP coping.
    { name: "only failures", failures: 5, timeouts: 0, expected: withFailures },
  ])("reads a run with $name as $expected", ({ failures, timeouts, expected }) => {
    expect(
      deriveRunErpStory(
        runErp({
          recentAttemptCount: 5,
          recentFailureCount: failures,
          recentTimeoutCount: timeouts,
        }),
      ),
    ).toBe(expected);
  });

  it.each([
    { name: "a missing run summary", erp: null },
    { name: "a run with no calls", erp: runErp({ recentAttemptCount: 0 }) },
  ])("reports $name as field-specific absence without an error tone", ({ erp }) => {
    expect(deriveRunErpStory(erp)).toBe("No recent simulated-ERP activity");
  });
});

function runErp(overrides: Partial<RunErpOutcomeSummary> = {}): RunErpOutcomeSummary {
  const runId = "11111111-1111-4111-8111-111111111111";
  const recentAttemptCount = overrides.recentAttemptCount ?? 5;

  return {
    runId,
    // The latest attempt and the windowed counts are read from the same attempt table, so a run
    // with attempts inside the window always has a latest one.
    latestAttempt:
      recentAttemptCount > 0
        ? { runId, status: "succeeded", finishedAt: "2026-06-20T00:00:10.500Z" }
        : null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    observedAt: "2026-06-20T00:00:11.000Z",
    ...overrides,
  };
}
