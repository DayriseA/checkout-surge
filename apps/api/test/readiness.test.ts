import { describe, expect, it, vi } from "vitest";
import { createBoundedInfrastructureReadinessCheck } from "../src/runtime/readiness.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("bounded infrastructure readiness", () => {
  it("coalesces concurrent callers and starts fresh checks after settlement", async () => {
    const firstOperation = createDeferred();
    const secondOperation = createDeferred();
    const dependencyChecks = [
      "database_reachable",
      "redis_reachable",
      "order_process_queue_reachable",
    ].map((name) => {
      const check = vi.fn(async () => {
        await (check.mock.calls.length === 1 ? firstOperation.promise : secondOperation.promise);
      });
      return { name, check };
    });
    const readiness = createBoundedInfrastructureReadinessCheck(dependencyChecks, 2_000);

    const firstChecksPromise = readiness.checks();
    const concurrentChecksPromise = readiness.checks();

    expect(dependencyChecks.every(({ check }) => check.mock.calls.length === 1)).toBe(true);

    firstOperation.resolve();
    const [firstChecks, concurrentChecks] = await Promise.all([
      firstChecksPromise,
      concurrentChecksPromise,
    ]);

    expect(concurrentChecks).toEqual(firstChecks);
    expect(concurrentChecks).not.toBe(firstChecks);
    expect(concurrentChecks[0]).not.toBe(firstChecks[0]);
    const expectedLaterChecks = firstChecks.map((check) => ({ ...check }));
    (firstChecks[0] as { message?: string }).message = "caller-local mutation";
    expect(concurrentChecks[0]).not.toHaveProperty("message");

    const laterChecksPromise = readiness.checks();
    expect(dependencyChecks.every(({ check }) => check.mock.calls.length === 2)).toBe(true);
    secondOperation.resolve();

    await expect(laterChecksPromise).resolves.toEqual(expectedLaterChecks);
  });

  it("starts checks concurrently and returns unavailable when dependencies never settle", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const aborted: string[] = [];
    try {
      const readiness = createBoundedInfrastructureReadinessCheck(
        ["database_reachable", "redis_reachable", "order_process_queue_reachable"].map((name) => ({
          name,
          check: async (signal: AbortSignal) => {
            started.push(name);
            signal.addEventListener("abort", () => aborted.push(name), { once: true });
            await new Promise<never>(() => undefined);
          },
        })),
        100,
      );

      const checksPromise = readiness.checks();
      expect(started).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(100);

      await expect(checksPromise).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "database_reachable", status: "unavailable" }),
          expect.objectContaining({ name: "redis_reachable", status: "unavailable" }),
          expect.objectContaining({
            name: "order_process_queue_reachable",
            status: "unavailable",
          }),
        ]),
      );
      expect(aborted).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
