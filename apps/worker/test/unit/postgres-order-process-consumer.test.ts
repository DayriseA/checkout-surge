import type { PostgresOrderDeliveryClaim, SqlClient } from "@checkout-surge/db";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, expect, it, vi } from "vitest";
import { OrderNotFoundError } from "../../src/persistence/postgres-order-transition-persistence.js";
import { createPostgresOrderProcessConsumer } from "../../src/queue/postgres-order-process-consumer.js";

const claim: PostgresOrderDeliveryClaim = {
  publicationId: "recovery-order-3",
  deliveryGeneration: 9,
  job: {
    orderId: "11111111-1111-4111-8111-111111111111",
    runId: "44444444-4444-4444-8444-444444444444",
    reservationId: "22222222-2222-4222-8222-222222222222",
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    publicOrderId: "ord_pg",
    correlationId: "pg-test",
    quantity: 1,
    queuedAt: "2026-10-11T00:00:00.000Z",
    processingGeneration: 3,
  },
};
function setup() {
  vi.useFakeTimers();
  const delivery = {
    claim: vi.fn().mockResolvedValue([]).mockResolvedValueOnce([claim]),
    renew: vi.fn().mockResolvedValue(true),
    settle: vi.fn().mockResolvedValue(true),
  };
  const handler = { handle: vi.fn().mockResolvedValue(undefined) };
  const recovery = {
    recordRecoverable: vi.fn().mockResolvedValue(undefined),
    recordDeadLetter: vi.fn().mockResolvedValue(undefined),
    isTerminalResetRun: vi.fn().mockResolvedValue(false),
  };
  const consumer = createPostgresOrderProcessConsumer({
    delivery,
    handler,
    recovery,
    sql: (async () => []) as unknown as SqlClient,
    logger: createSilentLogger("worker"),
    concurrency: 1,
    scanIntervalMs: 10,
    leaseSeconds: 3,
    closeDeadlineMs: 50,
  });
  return { consumer, delivery, handler, recovery };
}
afterEach(() => vi.useRealTimers());

it("passes business generation and recovery identity, then settles the transport claim", async () => {
  const { consumer, handler, delivery } = setup();
  consumer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(handler.handle).toHaveBeenCalledWith(claim.job, {
    attemptNumber: 1,
    attemptsMade: 0,
    deliveryId: claim.publicationId,
    processingGeneration: 3,
    recoveryKey: `order:${claim.job.orderId}`,
  });
  expect(delivery.settle).toHaveBeenCalledWith(claim);
  await consumer.close();
});

it("retains a processing failure even when recovery handoff also fails", async () => {
  const { consumer, handler, delivery, recovery } = setup();
  handler.handle.mockRejectedValue(new Error("DB unavailable"));
  recovery.recordRecoverable.mockRejectedValue(new Error("Handoff unavailable"));
  consumer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.recordRecoverable).toHaveBeenCalledOnce();
  expect(delivery.settle).not.toHaveBeenCalled();
  await consumer.close();
});

it.each([
  false,
  true,
])("records missing orders unless reset already purged them (%s)", async (reset) => {
  const { consumer, handler, delivery, recovery } = setup();
  handler.handle.mockRejectedValue(new OrderNotFoundError(claim.job.orderId));
  recovery.isTerminalResetRun.mockResolvedValue(reset);
  consumer.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(recovery.recordDeadLetter).toHaveBeenCalledTimes(reset ? 0 : 1);
  expect(delivery.settle).toHaveBeenCalledWith(claim);
  await consumer.close();
});

it("renews active claims, bounds shutdown and never acknowledges after forced close", async () => {
  const { consumer, handler, delivery } = setup();
  let finish!: () => void;
  handler.handle.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  consumer.start();
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivery.claim).toHaveBeenCalledOnce();
  expect(delivery.renew).toHaveBeenCalledWith(claim, 3);
  const closed = consumer.close();
  await vi.advanceTimersByTimeAsync(50);
  await closed;
  expect(consumer.isRunning()).toBe(false);
  finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(delivery.settle).not.toHaveBeenCalled();
  expect(delivery.claim).toHaveBeenCalledOnce();
});
