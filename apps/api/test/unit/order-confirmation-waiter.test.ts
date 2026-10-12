import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type OrderConfirmationReader,
  type OrderConfirmationState,
  OrderConfirmationWaiter,
} from "../../src/services/order-confirmation-waiter.js";

const confirmedAt = new Date("2026-10-12T10:00:30.000Z");

describe("order confirmation waiter", () => {
  let states: Map<string, OrderConfirmationState>;
  let read: Mock<OrderConfirmationReader["read"]>;
  let waiter: OrderConfirmationWaiter;

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    states = new Map();
    read = vi.fn(async (orderIds: readonly string[]) =>
      orderIds.flatMap((orderId) => {
        const state = states.get(orderId);
        return state ? [state] : [];
      }),
    );
    waiter = new OrderConfirmationWaiter({ reader: { read }, intervalMs: 250 });
  });

  afterEach(() => {
    waiter.close();
    vi.useRealTimers();
  });

  function queued(orderId: string) {
    states.set(orderId, { orderId, confirmedAt: null, runOpen: true });
  }

  it("checks every waiting order in one read per interval and answers each confirmation", async () => {
    const orderIds = Array.from({ length: 500 }, (_, index) => `order-${index}`);
    for (const orderId of orderIds) queued(orderId);
    const waits = orderIds.map((orderId) => waiter.wait(orderId, 45_000));

    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toHaveLength(500);

    states.set("order-7", { orderId: "order-7", confirmedAt, runOpen: true });
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(waits[7]).resolves.toEqual(confirmedAt);
    expect(read.mock.calls[1]?.[0]).toHaveLength(500);
    await vi.advanceTimersByTimeAsync(250);
    expect(read.mock.calls[2]?.[0]).toHaveLength(499);
  });

  it("ends a wait unconfirmed at its deadline, when its run is terminal, or when its order is gone", async () => {
    queued("deadline");
    queued("reset");
    const deadline = waiter.wait("deadline", 1_000);
    const reset = waiter.wait("reset", 45_000);
    const purged = waiter.wait("purged", 45_000);

    states.set("reset", { orderId: "reset", confirmedAt: null, runOpen: false });
    await vi.advanceTimersByTimeAsync(250);
    await expect(reset).resolves.toBeNull();
    await expect(purged).resolves.toBeNull();

    // A read that fails, or one that never returns, keeps the wait, still bounded by its deadline.
    read.mockRejectedValueOnce(new Error("database unavailable"));
    read.mockReturnValueOnce(new Promise(() => undefined));
    await vi.advanceTimersByTimeAsync(750);
    await expect(deadline).resolves.toBeNull();
  });

  it("stops reading once no request waits, and close releases every wait", async () => {
    queued("confirmed");
    queued("open");
    const confirmed = waiter.wait("confirmed", 45_000);
    states.set("confirmed", { orderId: "confirmed", confirmedAt, runOpen: true });
    await vi.advanceTimersByTimeAsync(250);
    await expect(confirmed).resolves.toEqual(confirmedAt);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledOnce();

    const open = waiter.wait("open", 45_000);
    waiter.close();
    await expect(open).resolves.toBeNull();
    // A request reaching the wait after shutdown began is answered at once.
    await expect(waiter.wait("open", 45_000)).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read).toHaveBeenCalledOnce();
  });
});
