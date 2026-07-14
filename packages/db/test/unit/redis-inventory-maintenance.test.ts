import { describe, expect, it, vi } from "vitest";
import type { CheckoutSurgeRedis } from "../../src/redis.js";
import { deleteGeneratedRunRedisState } from "../../src/redis-inventory.js";

const runId = "55555555-5555-4555-8555-555555555554";
const saleOfferId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4";

describe("generated-run Redis cleanup", () => {
  it("is an idempotent no-op when the namespace is absent", async () => {
    const scan = vi.fn().mockResolvedValue(["0", []]);
    const unlink = vi.fn().mockResolvedValue(0);

    await deleteGeneratedRunRedisState(redisStub({ scan, unlink }), { runId, saleOfferId });

    expect(scan).toHaveBeenCalledWith("0", "MATCH", `inventory:${saleOfferId}:*`, "COUNT", 100);
    expect(unlink).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(
      `demo-run:${runId}:sale-eligibility`,
      `demo-run:${runId}:traffic-metrics`,
      `demo-run:${runId}:traffic-metrics-reset-fence`,
    );
  });

  it("scans multiple pages and unlinks dynamic inventory children plus eligibility", async () => {
    const dynamicKey = `inventory:${saleOfferId}:idempotency:dynamic-request`;
    const scan = vi
      .fn()
      .mockResolvedValueOnce(["17", [`inventory:${saleOfferId}:state`, dynamicKey]])
      .mockResolvedValueOnce(["0", [`inventory:${saleOfferId}:events`]]);
    const unlink = vi.fn().mockResolvedValue(1);

    await deleteGeneratedRunRedisState(redisStub({ scan, unlink }), { runId, saleOfferId });

    expect(scan).toHaveBeenNthCalledWith(
      2,
      "17",
      "MATCH",
      `inventory:${saleOfferId}:*`,
      "COUNT",
      100,
    );
    expect(unlink).toHaveBeenNthCalledWith(1, `inventory:${saleOfferId}:state`, dynamicKey);
    expect(unlink).toHaveBeenNthCalledWith(2, `inventory:${saleOfferId}:events`);
    expect(unlink).toHaveBeenNthCalledWith(
      3,
      `demo-run:${runId}:sale-eligibility`,
      `demo-run:${runId}:traffic-metrics`,
      `demo-run:${runId}:traffic-metrics-reset-fence`,
    );
  });

  it("surfaces UNLINK failures", async () => {
    const failure = new Error("Redis UNLINK failed");
    const scan = vi.fn().mockResolvedValue(["0", [`inventory:${saleOfferId}:state`]]);
    const unlink = vi.fn().mockRejectedValue(failure);

    await expect(
      deleteGeneratedRunRedisState(redisStub({ scan, unlink }), { runId, saleOfferId }),
    ).rejects.toBe(failure);
  });

  it("validates both generated-run identifiers before scanning", async () => {
    const scan = vi.fn();
    const unlink = vi.fn();
    const redis = redisStub({ scan, unlink });

    await expect(
      deleteGeneratedRunRedisState(redis, { runId: "invalid", saleOfferId }),
    ).rejects.toThrow();
    await expect(
      deleteGeneratedRunRedisState(redis, { runId, saleOfferId: "invalid" }),
    ).rejects.toThrow();
    expect(scan).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});

function redisStub(input: {
  scan: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
}): CheckoutSurgeRedis {
  return input as unknown as CheckoutSurgeRedis;
}
