import {
  acceptedOrderSummarySchema,
  acceptedReservationSummarySchema,
  idempotencyKeySchema,
  securedReservationHoldSchema,
  uuidSchema,
} from "@checkout-surge/contracts";
import { z } from "zod";

export const pendingRecoveryPath = "/internal/reservations/recover";
export const buyerTimingFlushPath = "/internal/reservation-timing/flush";
export const pendingRecoveryRequestSchema = z
  .object({
    reservation: securedReservationHoldSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .strict();
export const pendingRecoveryResponseSchema = z
  .object({
    acceptance: z
      .object({ reservation: acceptedReservationSummarySchema, order: acceptedOrderSummarySchema })
      .strict()
      .nullable(),
  })
  .strict();
export const buyerTimingFlushRequestSchema = z
  .object({ runId: uuidSchema, activate: z.boolean().optional() })
  .strict();
export const buyerTimingFlushResponseSchema = z
  .object({
    bootId: uuidSchema,
    mergeFailureGeneration: z.number().int().nonnegative(),
    activatedRunId: uuidSchema.optional(),
    timingAvailable: z.boolean().optional(),
  })
  .strict();
