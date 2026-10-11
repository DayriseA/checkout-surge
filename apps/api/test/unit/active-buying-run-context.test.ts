import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ActiveBuyingRunContext,
  type BuyingRunContext,
} from "../../src/services/active-buying-run-context.js";
import { prepareBuyerRun } from "../../src/services/buyer-run-preparation.js";

const runId = randomUUID();
const saleOfferId = randomUUID();
const run: BuyingRunContext = { runId, saleOfferId, executionMode: "demo" };
const input = {
  request: { runId, saleOfferId, quantity: 1, idempotencyKey: "context-buy" },
  correlationId: "context-buy",
};

describe("authoritative buying context", () => {
  it("hydrates once and keeps current, unknown and stale buys off the context reader", async () => {
    const readCurrent = vi.fn(async () => run);
    const reserve = vi.fn(async () => ({
      outcome: "sold_out" as const,
      correlationId: "context-buy",
      timestamp: new Date().toISOString(),
      reservation: null,
      order: null,
    }));
    const context = new ActiveBuyingRunContext({
      reader: { readCurrent },
      services: { demo: { reserve } },
    });
    await context.hydrate();
    for (let index = 0; index < 10; index++) await context.reserve(input);
    await context.reserve({ ...input, request: { ...input.request, runId: randomUUID() } });
    await context.reserve({ ...input, request: { ...input.request, saleOfferId: randomUUID() } });
    expect(readCurrent).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledTimes(12);
    expect(reserve).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ runId }) }),
    );
  });

  it("rejects stale activation and propagates startup hydration failure", async () => {
    const readCurrent = vi.fn(async (): Promise<BuyingRunContext | null> => run);
    const context = new ActiveBuyingRunContext({
      reader: { readCurrent },
      services: { demo: { reserve: vi.fn() } },
    });
    await context.activate(runId);
    await expect(context.activate(randomUUID())).rejects.toThrow("current generated run");
    readCurrent.mockRejectedValueOnce(new Error("Database unavailable."));
    await expect(context.hydrate()).rejects.toThrow("Database unavailable.");
  });

  it("acknowledges activation even when timings are unknown, but propagates activation failure", async () => {
    const activate = vi.fn(async () => undefined);
    const flush = vi.fn(async () => {
      throw new Error("Timing flush unavailable.");
    });
    const bootId = randomUUID();
    await expect(prepareBuyerRun({ context: { activate }, runId, bootId, flush })).resolves.toEqual(
      {
        bootId,
        activatedRunId: runId,
        timingAvailable: false,
        mergeFailureGeneration: 0,
      },
    );
    activate.mockRejectedValueOnce(new Error("Wrong current run."));
    await expect(prepareBuyerRun({ context: { activate }, runId, bootId, flush })).rejects.toThrow(
      "Wrong current run.",
    );
    expect(flush).toHaveBeenCalledOnce();
  });
});
