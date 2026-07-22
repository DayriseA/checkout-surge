import { afterEach, describe, expect, it, vi } from "vitest";
import { BusinessOutcomePublicationScheduler } from "../../src/business-outcome-publication-scheduler.js";

describe("BusinessOutcomePublicationScheduler", () => {
  it("coalesces a burst per scope and retains dirtiness observed during a read", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    let inFlight = 0;
    let maximumInFlight = 0;
    const publish = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      if (publish.mock.calls.length === 1) {
        await new Promise<void>((resolve) => (release = resolve));
      }
      inFlight -= 1;
    });
    const scheduler = createScheduler(publish);

    for (let index = 0; index < 100; index += 1) scheduler.markDirty(scope("first"));
    await vi.advanceTimersByTimeAsync(500);
    scheduler.markDirty(scope("during"));
    release?.();
    await vi.advanceTimersByTimeAsync(500);
    await scheduler.flush();

    expect(publish).toHaveBeenCalledTimes(2);
    expect(maximumInFlight).toBe(1);
    expect(publish.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ correlationId: "during" }),
    );
  });

  it("bounds independent instances per process and close flushes once", async () => {
    vi.useFakeTimers();
    const firstPublish = vi.fn().mockResolvedValue(undefined);
    const secondPublish = vi.fn().mockResolvedValue(undefined);
    const first = createScheduler(firstPublish);
    const second = createScheduler(secondPublish);
    first.markDirty(scope("first"));
    second.markDirty(scope("second"));
    await Promise.all([first.close(), second.close()]);
    expect(firstPublish).toHaveBeenCalledOnce();
    expect(secondPublish).toHaveBeenCalledOnce();
  });

  it("keeps run and sale scopes isolated", async () => {
    vi.useFakeTimers();
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = createScheduler(publish);
    scheduler.markDirty(scope("first"));
    scheduler.markDirty({
      ...scope("second"),
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await scheduler.flush();
    expect(publish).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("abandons later captured scopes when the close deadline expires", async () => {
    vi.useFakeTimers();
    let rejectFirst: (() => void) | undefined;
    const publish = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = () => reject(new Error("late projection failure"));
        }),
    );
    const scheduler = new BusinessOutcomePublicationScheduler({
      publish,
      onError: vi.fn(),
      closeTimeoutMs: 25,
    });
    scheduler.markDirty(scope("hung"));
    scheduler.markDirty({ ...scope("later"), saleOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const closing = scheduler.close();
    await vi.advanceTimersByTimeAsync(25);
    await expect(closing).resolves.toBeUndefined();
    rejectFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("reports and drops the oldest scope at the configured bound", async () => {
    const onDrop = vi.fn();
    const publish = vi.fn().mockResolvedValue(undefined);
    const scheduler = new BusinessOutcomePublicationScheduler({
      publish,
      onError: vi.fn(),
      onDrop,
      maxPendingScopes: 1,
    });
    scheduler.markDirty(scope("oldest"));
    scheduler.markDirty({
      ...scope("newest"),
      saleOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    await scheduler.flush();
    expect(onDrop).toHaveBeenCalledWith(scope("oldest"));
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ correlationId: "newest" }));
    await scheduler.close();
  });

  it("contains a rejected projection and continues the captured batch", async () => {
    const projectionError = new Error("projection unavailable");
    const onError = vi.fn();
    const publish = vi.fn().mockRejectedValueOnce(projectionError).mockResolvedValueOnce(undefined);
    const scheduler = new BusinessOutcomePublicationScheduler({ publish, onError });
    scheduler.markDirty(scope("failing"));
    scheduler.markDirty({
      ...scope("later"),
      saleOfferId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    await expect(scheduler.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(projectionError, scope("failing"));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ correlationId: "later" }));
    await expect(scheduler.close()).resolves.toBeUndefined();
  });
});

afterEach(() => vi.useRealTimers());

function createScheduler(publish: (scope: unknown) => Promise<unknown>) {
  return new BusinessOutcomePublicationScheduler({
    publish,
    onError: vi.fn(),
    windowMs: 500,
  });
}

function scope(correlationId: string) {
  return {
    runId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    correlationId,
  };
}
