import { notificationRecordJobName } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import { createNotificationRecordPublisher } from "../../src/queue/bullmq-notification-record-publisher.js";

const orderJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_notification",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  correlationId: "corr-notification-publisher-test",
  runId: "55555555-5555-4555-8555-555555555555",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};

describe("notification-record job publisher", () => {
  it("refuses a late recovery publication after the generated run becomes terminal", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn().mockRejectedValue(new Error("generated run is terminal"));
    const publisher = createNotificationRecordPublisher(
      { add, close: vi.fn() },
      { publicationFence: { publish } },
    );

    await expect(
      publisher.publishForConfirmedOrder(orderJob, "2026-06-21T00:00:01.000Z"),
    ).rejects.toThrow("generated run is terminal");
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ runId: orderJob.runId, saleOfferId: orderJob.saleOfferId }),
    );
    expect(add).not.toHaveBeenCalled();
  });

  it("publishes a nonterminal generated-run notification with exact attribution", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const publisher = createNotificationRecordPublisher(
      { add, close: vi.fn() },
      {
        publicationFence: {
          publish: vi.fn(async ({ operation }) => operation({} as never)),
        },
      },
    );

    await publisher.publishForConfirmedOrder(orderJob, "2026-06-21T00:00:01.000Z");
    expect(add).toHaveBeenCalledWith(
      notificationRecordJobName,
      expect.objectContaining({ orderId: orderJob.orderId, runId: orderJob.runId }),
      expect.objectContaining({ jobId: `${orderJob.orderId}-email` }),
    );
  });
});
