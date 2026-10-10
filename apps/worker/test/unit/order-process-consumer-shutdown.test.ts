import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBullMqOrderProcessConsumer } from "../../src/queue/bullmq-order-process-consumer.js";

// BullMQ's worker, reduced to the calls close() makes. pause() waits for the active
// jobs, so a job that never settles keeps it pending forever.
const worker = vi.hoisted(() => ({
  pause: vi.fn<() => Promise<void>>(),
  close: vi.fn<(force?: boolean) => Promise<void>>(),
}));

vi.mock("bullmq", () => ({
  Worker: class {
    pause = worker.pause;
    close = worker.close;
    on() {
      return this;
    }
  },
}));

function createConsumer() {
  return createBullMqOrderProcessConsumer({
    connection: {},
    concurrency: 1,
    handler: { handle: async () => undefined },
    logger: createSilentLogger("worker"),
    recovery: {
      recordRecoverable: async () => undefined,
      recordDeadLetter: async () => undefined,
    },
    closeDeadlineMs: 5_000,
  });
}

describe("order-processing consumer shutdown", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("force-closes the worker when an active job outlasts the shutdown deadline", async () => {
    vi.useFakeTimers();
    worker.pause.mockReturnValue(new Promise(() => undefined));
    worker.close.mockResolvedValue(undefined);
    let closed = false;

    const closing = createConsumer()
      .close()
      .then(() => {
        closed = true;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;

    expect(worker.close).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("closes once the active jobs settle, or as soon as waiting for them fails", async () => {
    worker.close.mockResolvedValue(undefined);
    worker.pause.mockResolvedValueOnce(undefined);
    worker.pause.mockRejectedValueOnce(new Error("Redis unavailable"));

    await createConsumer().close();
    await createConsumer().close();

    expect(worker.close.mock.calls).toEqual([[true], [true]]);
  });
});
