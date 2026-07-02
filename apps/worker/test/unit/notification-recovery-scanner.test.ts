import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { createNotificationRecoveryScanner } from "../../src/application/notification-recovery-scanner.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_recovery_test",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  runId: "55555555-5555-4555-8555-555555555555",
  correlationId: "corr-notification-recovery-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};

describe("notification recovery scanner", () => {
  it("retries publication for confirmed orders still missing notification records", async () => {
    const publishError = new Error("redis unavailable");
    const persistence = {
      findConfirmedOrdersMissingNotifications: vi.fn().mockResolvedValue([
        {
          job,
          confirmedAt: "2026-06-21T00:00:02.000Z",
        },
      ]),
    };
    const publisher = {
      publishForConfirmedOrder: vi
        .fn()
        .mockRejectedValueOnce(publishError)
        .mockResolvedValueOnce(undefined),
    };
    const reportPublishFailure = vi.fn();
    const scanner = createNotificationRecoveryScanner({
      persistence,
      publisher,
      logger: createSilentLogger("worker"),
      scanIntervalMs: 1000,
      batchSize: 25,
      reportPublishFailure,
    });

    await expect(scanner.scanOnce()).resolves.toEqual({
      candidates: 1,
      published: 0,
      failed: 1,
    });
    await expect(scanner.scanOnce()).resolves.toEqual({
      candidates: 1,
      published: 1,
      failed: 0,
    });

    expect(persistence.findConfirmedOrdersMissingNotifications).toHaveBeenCalledWith({
      limit: 25,
    });
    expect(publisher.publishForConfirmedOrder).toHaveBeenCalledTimes(2);
    expect(publisher.publishForConfirmedOrder).toHaveBeenCalledWith(
      job,
      "2026-06-21T00:00:02.000Z",
    );
    expect(reportPublishFailure).toHaveBeenCalledWith({
      error: publishError,
      orderId: job.orderId,
      saleOfferId: job.saleOfferId,
      runId: job.runId,
      correlationId: job.correlationId,
    });
  });
});
