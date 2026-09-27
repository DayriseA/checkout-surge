import { z } from "zod";
import {
  idempotencyKeySchema,
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Processing generation of an order's durable control record. Deliveries
 * whose generation does not match the control record are acknowledged without
 * work.
 */
export const processingGenerationSchema = nonnegativeIntegerSchema;

/**
 * Identity of one actual ERP call. Distinct by construction from the
 * stable order/idempotency identity, from the queue delivery identity, and from
 * correlation lineage: capacity deferrals do not consume delivery attempts and
 * must still leave every dispatched call auditable. The reference is recorded
 * before the HTTP request is sent so a crash cannot erase the existence of an
 * uncertain attempt.
 */
export const erpCallIdSchema = uuidSchema;

export const erpCallReferenceSchema = z
  .object({
    erpCallId: erpCallIdSchema,
    orderId: uuidSchema,
    idempotencyKey: idempotencyKeySchema,
    processingGeneration: processingGenerationSchema,
    dispatchedAt: isoTimestampSchema,
  })
  .strict();
export type ErpCallReference = z.infer<typeof erpCallReferenceSchema>;

/**
 * The declared-capacity ERP dispatch engine-policy identity. The worker policy
 * derives its version string from it.
 */
export const erpDispatchEnginePolicyIdentity = {
  name: "declared-capacity-erp-dispatch",
  version: 2,
} as const;

/** Small native windows bound sliding-window pressure. */
export const erpDispatchSafetyMargin = 0.05;
export const erpDispatchMinimumWindowMs = 20;
export const catalogErpDispatchLimits = { maxTps: 100, concurrency: 10 } as const;

export function erpDispatchRateLimit(maxTps: number): { max: number; duration: number } {
  const effectiveRate = maxTps * (1 - erpDispatchSafetyMargin);
  // Smallest burst whose rounded-up duration reaches the minimum window.
  const max = Math.floor(((erpDispatchMinimumWindowMs - 1) * effectiveRate) / 1_000) + 1;
  return { max, duration: Math.ceil((max * 1_000) / effectiveRate) };
}
