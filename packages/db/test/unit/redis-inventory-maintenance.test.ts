import { describe, expect, it, vi } from "vitest";
import type { CheckoutSurgeRedis } from "../../src/redis.js";
import { deleteGeneratedRunRedisState } from "../../src/redis-inventory.js";

const runId = "55555555-5555-4555-8555-555555555554";
const saleOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";

describe("generated-run Redis cleanup", () => {
  it("is an idempotent no-op when the namespace is absent", async () => {
    const evalCommand = vi.fn().mockResolvedValue(0);
    const scan = vi.fn().mockResolvedValue(["0", []]);
    const unlink = vi.fn().mockResolvedValue(0);

    await expect(
      deleteGeneratedRunRedisState(redisStub({ eval: evalCommand, scan, unlink }), {
        runId,
        saleOfferId,
      }),
    ).resolves.toEqual({ deletedKeyCount: 0 });

    expect(evalCommand).toHaveBeenCalledWith(
      expect.any(String),
      2,
      `inventory:${saleOfferId}:state`,
      `demo-run:${runId}:dashboard-projection-revision`,
      runId,
      saleOfferId,
    );
    expect(scan).toHaveBeenCalledWith("0", "MATCH", `inventory:${saleOfferId}:*`, "COUNT", 100);
    expect(unlink).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(
      `demo-run:${runId}:sale-eligibility`,
      `demo-run:${runId}:traffic-metrics`,
      `demo-run:${runId}:traffic-metrics-pinned`,
      `demo-run:${runId}:traffic-metric-batches`,
      `demo-run:${runId}:traffic-metrics-reset-fence`,
      `demo-run:${runId}:reservation-timing`,
      `demo-run:${runId}:reservation-timing-fence`,
    );
  });

  it("scans multiple pages and unlinks dynamic inventory children plus eligibility", async () => {
    const dynamicKey = `inventory:${saleOfferId}:idempotency:dynamic-request`;
    const evalCommand = vi.fn().mockResolvedValue(2);
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["17", [dynamicKey]])
      .mockResolvedValueOnce(["0", [`inventory:${saleOfferId}:events`]]);
    const unlink = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(5);

    await expect(
      deleteGeneratedRunRedisState(redisStub({ eval: evalCommand, scan, unlink }), {
        runId,
        saleOfferId,
      }),
    ).resolves.toEqual({ deletedKeyCount: 9 });

    expect(scan).toHaveBeenNthCalledWith(
      2,
      "17",
      "MATCH",
      `inventory:${saleOfferId}:*`,
      "COUNT",
      100,
    );
    expect(unlink).toHaveBeenNthCalledWith(1, dynamicKey);
    expect(unlink).toHaveBeenNthCalledWith(2, `inventory:${saleOfferId}:events`);
    expect(unlink).toHaveBeenNthCalledWith(
      3,
      `demo-run:${runId}:sale-eligibility`,
      `demo-run:${runId}:traffic-metrics`,
      `demo-run:${runId}:traffic-metrics-pinned`,
      `demo-run:${runId}:traffic-metric-batches`,
      `demo-run:${runId}:traffic-metrics-reset-fence`,
      `demo-run:${runId}:reservation-timing`,
      `demo-run:${runId}:reservation-timing-fence`,
    );
  });

  it("surfaces UNLINK failures", async () => {
    const failure = new Error("Redis UNLINK failed");
    const evalCommand = vi.fn().mockResolvedValue(2);
    const scan = vi.fn().mockResolvedValue(["0", [`inventory:${saleOfferId}:state`]]);
    const unlink = vi.fn().mockRejectedValue(failure);

    await expect(
      deleteGeneratedRunRedisState(redisStub({ eval: evalCommand, scan, unlink }), {
        runId,
        saleOfferId,
      }),
    ).rejects.toBe(failure);
  });

  it("validates both generated-run identifiers before scanning", async () => {
    const evalCommand = vi.fn();
    const scan = vi.fn();
    const unlink = vi.fn();
    const redis = redisStub({ eval: evalCommand, scan, unlink });

    await expect(
      deleteGeneratedRunRedisState(redis, { runId: "invalid", saleOfferId }),
    ).rejects.toThrow();
    await expect(
      deleteGeneratedRunRedisState(redis, { runId, saleOfferId: "invalid" }),
    ).rejects.toThrow();
    expect(evalCommand).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});

function redisStub(input: {
  eval: ReturnType<typeof vi.fn>;
  scan: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
}): CheckoutSurgeRedis {
  return input as unknown as CheckoutSurgeRedis;
}
