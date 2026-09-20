import { z } from "zod";
import {
  idempotencyKeySchema,
  isoTimestampSchema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Processing generation of an order's durable control record (D04). Deliveries
 * whose generation does not match the control record are acknowledged without
 * work.
 */
export const processingGenerationSchema = nonnegativeIntegerSchema;
export type ProcessingGeneration = z.infer<typeof processingGenerationSchema>;

/**
 * Identity of one actual ERP call (D04/D05). Distinct by construction from the
 * stable order/idempotency identity, from the queue delivery identity, and from
 * correlation lineage: capacity deferrals do not consume delivery attempts and
 * must still leave every dispatched call auditable. The reference is recorded
 * before the HTTP request is sent so a crash cannot erase the existence of an
 * uncertain attempt.
 */
export const erpCallIdSchema = uuidSchema;
export type ErpCallId = z.infer<typeof erpCallIdSchema>;

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
 * Versioned engine-policy identity (D13). Engine constants live in a versioned
 * worker policy; its identity is persisted with each run and with estimator
 * decisions so later calibration can be attributed.
 */
export const enginePolicyIdentitySchema = z
  .object({
    name: z.string().trim().min(1),
    version: positiveIntegerSchema,
  })
  .strict();
export type EnginePolicyIdentity = z.infer<typeof enginePolicyIdentitySchema>;
