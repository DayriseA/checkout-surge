import type { ReserveOrderService } from "./reserve-order-service.js";

/** The timing flush waits for service observations from already admitted buys. */
export class BuyerRequestDrain {
  private readonly requests = new Map<string, Set<Promise<unknown>>>();

  constructor(private readonly service: Pick<ReserveOrderService, "reserve">) {}

  reserve(
    input: Parameters<ReserveOrderService["reserve"]>[0],
  ): ReturnType<ReserveOrderService["reserve"]> {
    const runId = input.request.runId;
    const active = this.requests.get(runId) ?? new Set<Promise<unknown>>();
    const request = this.service.reserve(input).finally(() => {
      active.delete(request);
      if (active.size === 0) this.requests.delete(runId);
    });
    active.add(request);
    this.requests.set(runId, active);
    return request;
  }

  async drain(runId: string): Promise<void> {
    while (this.requests.has(runId)) {
      await Promise.allSettled([...(this.requests.get(runId) ?? [])]);
    }
  }
}
