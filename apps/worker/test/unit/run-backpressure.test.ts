import type { AcceptedRunConfigSnapshot, OrderProcessJob } from "@checkout-surge/contracts";
import { describe, expect, it, vi } from "vitest";
import type { OrderProcessDeliveryMetadata } from "../../src/application/order-process-job-handler.js";
import { RunScopedBackpressureOrderConfirmation } from "../../src/application/run-backpressure.js";

const job: OrderProcessJob = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_test_1",
  reservationId: "33333333-3333-4333-8333-333333333333",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  runId: "44444444-4444-4444-8444-444444444444",
  correlationId: "corr-worker-backpressure-test",
  quantity: 1,
  queuedAt: "2026-06-21T00:00:00.000Z",
};
const delivery: OrderProcessDeliveryMetadata = { attemptNumber: 1, attemptsMade: 0 };

describe("run-scoped order confirmation backpressure", () => {
  it("limits concurrent confirmations by the accepted run snapshot", async () => {
    const releases: Array<() => void> = [];
    let activeConfirmations = 0;
    let maxActiveConfirmations = 0;
    const inner = {
      confirm: vi.fn(async () => {
        activeConfirmations += 1;
        maxActiveConfirmations = Math.max(maxActiveConfirmations, activeConfirmations);
        await new Promise<void>((resolve) => releases.push(resolve));
        activeConfirmations -= 1;
      }),
    };
    const runConfigReader = {
      read: vi.fn().mockResolvedValue(
        runConfigSnapshot({
          backpressureConfig: {
            queueName: "orders:process",
            physicalQueueName: "orders-process",
            orderProcessConcurrency: 1,
            drainTimeoutSeconds: 300,
            pendingPersistenceRetryAfterSeconds: 30,
          },
        }),
      ),
    };
    const confirmation = new RunScopedBackpressureOrderConfirmation({
      inner,
      runConfigReader,
    });

    const first = confirmation.confirm(job, delivery);
    await vi.waitFor(() => expect(inner.confirm).toHaveBeenCalledTimes(1));
    const second = confirmation.confirm(
      {
        ...job,
        orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        publicOrderId: "ord_test_2",
      },
      delivery,
    );

    await Promise.resolve();
    expect(inner.confirm).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await vi.waitFor(() => expect(inner.confirm).toHaveBeenCalledTimes(2));
    expect(maxActiveConfirmations).toBe(1);

    releases[1]?.();
    await Promise.all([first, second]);
  });
});

function runConfigSnapshot(
  overrides: Partial<AcceptedRunConfigSnapshot> = {},
): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 30,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 1000,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 80,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
    },
    ...overrides,
  };
}
