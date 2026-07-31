import { describe, expect, it } from "vitest";
import {
  dashboardStaleAfterMs,
  dashboardUpdateExpected,
  deriveFreshness,
} from "../src/app/lib/presentation/freshness.js";

const recoveredAt = "2026-07-30T12:00:00.000Z";

describe("dashboard delivery freshness", () => {
  it.each([
    [
      "live while connected work is updating inside the guard",
      input({ nowMs: dashboardStaleAfterMs - 1 }),
      "live",
    ],
    ["stale at the guard boundary", input({ nowMs: dashboardStaleAfterMs }), "stale"],
    [
      "retained-fresh when a connected run has no update-producing work",
      input({ nowMs: 120_000, updateExpected: false }),
      "retained-fresh",
    ],
    [
      "connecting without claiming a disconnect",
      input({ nowMs: 120_000, transportStatus: "connecting" }),
      "connecting",
    ],
    [
      "unsupported live updates without claiming a disconnect",
      input({ nowMs: 120_000, transportStatus: "unsupported" }),
      "unsupported",
    ],
    [
      "disconnected even when the projection is recent",
      input({ nowMs: 1_000, transportStatus: "disconnected" }),
      "disconnected",
    ],
    [
      "not applicable after completion",
      input({ lifecycle: "completed", nowMs: 120_000 }),
      "not-applicable",
    ],
  ] as const)("%s", (_name, freshnessInput, expected) => {
    expect(deriveFreshness(freshnessInput).state).toBe(expected);
  });

  it.each([
    ["queue depth", { queueDepth: 1, activeJobs: 0, pendingPersistence: 0 }, true],
    ["active jobs", { queueDepth: 0, activeJobs: 1, pendingPersistence: 0 }, true],
    [
      "pending inventory persistence",
      { queueDepth: 0, activeJobs: 0, pendingPersistence: 1 },
      true,
    ],
    ["no work", { queueDepth: 0, activeJobs: 0, pendingPersistence: 0 }, false],
  ])("expects updates for %s", (_name, values, expected) => {
    expect(
      dashboardUpdateExpected({
        queue: {
          depth: values.queueDepth,
          counts: { active: values.activeJobs },
        },
        inventory: {
          pendingPersistenceCount: values.pendingPersistence,
        },
      }),
    ).toBe(expected);
  });
});

function input(
  overrides: Partial<Parameters<typeof deriveFreshness>[0]> & { nowMs?: number } = {},
): Parameters<typeof deriveFreshness>[0] {
  const { nowMs = 1_000, ...rest } = overrides;
  return {
    transportStatus: "connected",
    recoveredAt,
    now: new Date(Date.parse(recoveredAt) + nowMs),
    lifecycle: "active",
    updateExpected: true,
    ...rest,
  };
}
