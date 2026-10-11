import type { OrderProcessJob } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { expect, it, vi } from "vitest";
import { createInlineOrderRecoveryScanner } from "../../src/application/inline-order-recovery-scanner.js";

it("stops discovery delivery on close without starting another owned recovery", async () => {
  let release = () => {};
  const recover = vi.fn(
    () =>
      new Promise<{ outcome: "order_confirmation_pending"; order: null }>((resolve) => {
        release = () => resolve({ outcome: "order_confirmation_pending", order: null });
      }),
  );
  const job = {
    orderId: "order-1",
    reservationId: "reservation",
    saleOfferId: "offer",
    runId: "run",
    correlationId: "trace",
  } as OrderProcessJob;
  const scanner = createInlineOrderRecoveryScanner({
    service: { recover },
    recovery: { findRecoverable: vi.fn().mockResolvedValue([{ job }]) },
    dispatch: {
      findQueuedOrdersForDispatch: vi.fn().mockResolvedValue([{ ...job, orderId: "order-2" }]),
    },
    logger: createSilentLogger("worker"),
    scanIntervalMs: 1000,
    batchSize: 10,
    minimumQueuedAgeMs: 0,
  });
  scanner.start();
  await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce());
  const closing = scanner.close();
  release();
  await closing;
  expect(recover).toHaveBeenCalledOnce();
});
