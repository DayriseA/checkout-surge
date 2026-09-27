import type { RunErpOutcomeSummary } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { RunErpOutcomeService } from "../../src/services/erp-status-service.js";

const now = new Date("2026-06-22T00:00:10.000Z");
const runId = "55555555-5555-4555-8555-555555555555";

describe("RunErpOutcomeService", () => {
  it("reads attempts at the supplied run scope", async () => {
    const readStatus = vi.fn().mockResolvedValue(erpReadModel());
    const service = new RunErpOutcomeService({
      attemptStatusReader: { readStatus },
      logger: createSilentLogger("api"),
      now: () => now,
    });

    const outcome = await service.getOutcomes({ runId });
    expect(outcome).toEqual({ runId, ...erpReadModel(), observedAt: now.toISOString() });
    expect(outcome).not.toHaveProperty("status");
    expect(outcome).not.toHaveProperty("reason");
    expect(readStatus).toHaveBeenCalledWith({ runId }, now, 60);
  });
});

function erpReadModel(): Omit<RunErpOutcomeSummary, "runId" | "observedAt"> {
  return {
    latestAttempt: null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount: 0,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    recentAttemptCoverage: "retained_history",
    attemptRetentionLimitPerOrder: 32,
    cumulativeOutcomeCounts: {
      capacityRejected: 0,
      temporarilyUnavailable: 0,
      uncertainResult: 0,
    },
  };
}
