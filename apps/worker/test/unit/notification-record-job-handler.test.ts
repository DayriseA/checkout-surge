import type { NotificationRecordJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import { createNotificationRecordJobHandler } from "../../src/application/notification-record-job-handler.js";

const job: NotificationRecordJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  runId: "55555555-5555-4555-8555-555555555555",
  correlationId: "corr-notification-record-test",
  recipientPlaceholder: "customer@example.test",
  confirmedAt: "2026-06-21T00:00:00.100Z",
};

describe("notification-record job handler", () => {
  it("ignores a missing order only when its reset run is terminal", async () => {
    const missingOrder = Object.assign(new Error("missing"), {
      name: "NotificationOrderNotFoundError",
    });
    const persistence = {
      record: vi.fn().mockRejectedValue(missingOrder),
      isTerminalResetRun: vi.fn().mockResolvedValue(true),
    };
    const publishBusinessOutcomeUpdate = vi.fn();
    const handler = createNotificationRecordJobHandler({
      persistence,
      logger: createSilentLogger("worker"),
      publishBusinessOutcomeUpdate,
    });

    await expect(handler.handle(job)).resolves.toBeUndefined();
    expect(publishBusinessOutcomeUpdate).not.toHaveBeenCalled();

    persistence.isTerminalResetRun.mockResolvedValue(false);
    await expect(handler.handle(job)).rejects.toBe(missingOrder);
  });

  it("keeps a durable notification record successful when dashboard publication fails", async () => {
    const publishError = new Error("dashboard publish unavailable");
    const logger = createSilentLogger("worker");
    vi.spyOn(logger, "child").mockReturnValue(logger as never);
    const logError = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    const persistence = {
      record: vi.fn().mockResolvedValue({ recorded: true }),
    };
    const handler = createNotificationRecordJobHandler({
      persistence,
      logger,
      publishBusinessOutcomeUpdate: vi.fn().mockRejectedValue(publishError),
    });

    await expect(handler.handle(job)).resolves.toBeUndefined();

    expect(persistence.record).toHaveBeenCalledWith(job);
    expect(logError).toHaveBeenCalledWith(
      {
        err: publishError,
        orderId: job.orderId,
        saleOfferId: job.saleOfferId,
        runId: job.runId,
        correlationId: job.correlationId,
      },
      "Notification record succeeded but dashboard business outcome publication failed.",
    );
  });
});
