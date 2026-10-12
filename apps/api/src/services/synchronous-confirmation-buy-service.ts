import {
  type BuyRequest,
  type BuyResponse,
  synchronousConfirmationDeadlineMs,
} from "@checkout-surge/contracts";
import type { OrderConfirmationWaiter } from "./order-confirmation-waiter.js";
import type { ReserveOrderService } from "./reserve-order-service.js";

/**
 * The buy path without the order queue: the normal reservation, then, for a winner of a
 * `synchronous_confirmation` run, a wait for the worker's confirmation of its order. Every other
 * request is answered at once, exactly as by the normal route. A wait that ends unconfirmed
 * returns the accepted answer of the queued mode; the order itself is untouched.
 */
export class SynchronousConfirmationBuyService {
  constructor(
    private readonly options: {
      reserveOrderService: Pick<ReserveOrderService, "reserveInRun">;
      waiter: Pick<OrderConfirmationWaiter, "wait">;
    },
  ) {}

  async buy(input: { request: BuyRequest; correlationId: string }): Promise<BuyResponse> {
    const deadlineAt = Date.now() + synchronousConfirmationDeadlineMs;
    const { response, comparisonMode } = await this.options.reserveOrderService.reserveInRun(input);
    if (
      response.outcome !== "reservation_secured" ||
      comparisonMode !== "synchronous_confirmation"
    ) {
      return response;
    }

    const confirmedAt = await this.options.waiter.wait(response.order.id, deadlineAt);
    if (!confirmedAt) return response;
    return {
      ...response,
      outcome: "order_confirmed",
      order: { ...response.order, status: "confirmed", confirmedAt: confirmedAt.toISOString() },
    };
  }
}
