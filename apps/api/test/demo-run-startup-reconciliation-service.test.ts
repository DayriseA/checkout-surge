import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { DemoRunStartupReconciliationService } from "../src/services/demo-run-startup-reconciliation-service.js";

const drainingRun = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as never;

describe("DemoRunStartupReconciliationService", () => {
  it("repairs only startup-owned sale closure and completion enrichment", async () => {
    const closeRunSaleEligibility = vi.fn(async () => true);
    const completePendingEnrichment = vi.fn(async () => "completed" as const);
    const service = new DemoRunStartupReconciliationService({
      logger: createSilentLogger("api"),
      listDrainingRuns: async () => [drainingRun],
      closeRunSaleEligibility,
      completionEnrichmentService: { completePendingEnrichment },
    });

    await expect(service.reconcile()).resolves.toEqual({
      discoveredRunCount: 1,
      succeededRunCount: 1,
      failedRunCount: 0,
      closedSaleOfferCount: 1,
      completionEnrichedRunCount: 1,
      failures: [],
    });
    expect(closeRunSaleEligibility).toHaveBeenCalledOnce();
    expect(completePendingEnrichment).toHaveBeenCalledOnce();
  });

  it("isolates each draining run's startup-owned failures", async () => {
    const service = new DemoRunStartupReconciliationService({
      logger: createSilentLogger("api"),
      listDrainingRuns: async () => [drainingRun],
      closeRunSaleEligibility: async () => {
        throw new Error("redis unavailable");
      },
      completionEnrichmentService: { completePendingEnrichment: async () => "completed" },
    });

    await expect(service.reconcile()).resolves.toMatchObject({
      discoveredRunCount: 1,
      failedRunCount: 1,
      failures: [{ stages: ["eligibility_close"] }],
    });
  });
});
