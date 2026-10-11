import { z } from "zod";
import {
  confirmedOrderSummarySchema,
  failedOrderSummarySchema,
  pendingOrderSummarySchema,
} from "./buy.js";
import { correlationIdSchema, uuidSchema } from "./primitives.js";

export const inlineConfirmationPath = "/internal/orders/confirm" as const;
export const inlineConfirmationStatusPath = "/internal/orders/confirmation-status" as const;
export const inlineConfirmationProcessingWindowMs = 55_000;

// The worker loads securedAt from the durable reservation. Callers cannot choose a deadline.
export const inlineConfirmationRequestSchema = z
  .object({
    orderId: uuidSchema,
    reservationId: uuidSchema,
    saleOfferId: uuidSchema,
    runId: uuidSchema,
    correlationId: correlationIdSchema,
  })
  .strict();
export type InlineConfirmationRequest = z.infer<typeof inlineConfirmationRequestSchema>;

export const inlineConfirmationResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("order_confirmed"), order: confirmedOrderSummarySchema }).strict(),
  z
    .object({ outcome: z.literal("order_confirmation_failed"), order: failedOrderSummarySchema })
    .strict(),
  z
    .object({
      outcome: z.literal("order_confirmation_pending"),
      order: pendingOrderSummarySchema.nullable(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("order_confirmation_timed_out"),
      order: pendingOrderSummarySchema.nullable(),
    })
    .strict(),
]);
export type InlineConfirmationResult = z.infer<typeof inlineConfirmationResultSchema>;
