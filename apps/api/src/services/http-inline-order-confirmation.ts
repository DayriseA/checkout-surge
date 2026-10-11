import {
  controlServiceTokenHeaderName,
  type InlineConfirmationResult,
  inlineConfirmationPath,
  inlineConfirmationProcessingWindowMs,
  inlineConfirmationRequestSchema,
  inlineConfirmationResultSchema,
  inlineConfirmationStatusPath,
} from "@checkout-surge/contracts";
import type { InlineOrderConfirmation } from "./reserve-order-service.js";

// After expiry, only a short durable status read is allowed; it must never process ERP work.
const expiredStatusReadAllowanceMs = 1_000;

export class HttpInlineOrderConfirmation implements InlineOrderConfirmation {
  constructor(
    private readonly options: {
      baseUrl: string;
      controlServiceToken: string;
      now?: () => number;
    },
  ) {}

  async confirm(
    input: Parameters<InlineOrderConfirmation["confirm"]>[0],
  ): Promise<InlineConfirmationResult> {
    const request = inlineConfirmationRequestSchema.parse({
      orderId: input.order.id,
      reservationId: input.reservation.id,
      saleOfferId: input.order.saleOfferId,
      runId: input.order.runId,
      correlationId: input.correlationId,
    });
    const remainingMs =
      Date.parse(input.reservation.securedAt) +
      inlineConfirmationProcessingWindowMs -
      (this.options.now ?? Date.now)();
    const statusOnly = remainingMs <= 0;
    const url = new URL(
      statusOnly ? inlineConfirmationStatusPath : inlineConfirmationPath,
      this.options.baseUrl,
    );
    if (statusOnly) url.search = new URLSearchParams(request).toString();
    const signal = AbortSignal.timeout(
      statusOnly ? expiredStatusReadAllowanceMs : Math.ceil(remainingMs),
    );
    try {
      const response = await fetch(url, {
        method: statusOnly ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-correlation-id": input.correlationId,
          [controlServiceTokenHeaderName]: this.options.controlServiceToken,
        },
        ...(statusOnly ? {} : { body: JSON.stringify(request) }),
        signal,
      });
      if (!response.ok) throw new Error(`Worker confirmation returned HTTP ${response.status}.`);
      const result = inlineConfirmationResultSchema.parse(await response.json());
      if (
        result.order &&
        (result.order.id !== input.order.id ||
          result.order.publicOrderId !== input.order.publicOrderId ||
          result.order.reservationId !== input.reservation.id ||
          result.order.saleOfferId !== input.order.saleOfferId ||
          result.order.runId !== input.order.runId ||
          result.order.correlationId !== input.order.correlationId ||
          result.order.quantity !== input.order.quantity ||
          result.order.queuedAt !== input.order.queuedAt)
      )
        throw new Error("Worker confirmation identity did not match the durable acceptance.");
      return result;
    } catch {
      return {
        outcome:
          statusOnly || signal.aborted
            ? "order_confirmation_timed_out"
            : "order_confirmation_pending",
        order: input.order,
      };
    }
  }
}
