import { z } from "zod";
import { erpConfirmationSucceededResponseSchema } from "./erp.js";
import {
  idempotencyKeySchema,
  isoTimestampSchema,
  positiveIntegerSchema,
  uuidSchema,
} from "./primitives.js";

/**
 * Closed shared ERP error-code vocabulary with its HTTP statuses:
 * `erp_capacity_exceeded` (429), `erp_forced_outage` (503),
 * `erp_injected_error` (503), and `erp_idempotency_conflict` (409, identity
 * contradiction). Only codes declared here may acquire a classification meaning.
 */
export const erpErrorCodeValues = [
  "erp_capacity_exceeded",
  "erp_forced_outage",
  "erp_injected_error",
  "erp_idempotency_conflict",
] as const;
export const erpErrorCodeSchema = z.enum(erpErrorCodeValues);
export type ErpErrorCode = z.infer<typeof erpErrorCodeSchema>;

/** Disposition classes for recognized ERP outcomes. */
export const erpOutcomeDispositionValues = [
  "succeeded",
  "capacity_rejected",
  "temporarily_unavailable",
  "uncertain_result",
  "technical_failure",
] as const;
export const erpOutcomeDispositionSchema = z.enum(erpOutcomeDispositionValues);
export type ErpOutcomeDisposition = z.infer<typeof erpOutcomeDispositionSchema>;

/**
 * Pure data mapping of every recognized shared error code to its disposition.
 * Connection failures and request timeouts carry no code: they are
 * `temporarily_unavailable` and `uncertain_result` respectively. The client
 * classifies opaque 5xx responses as uncertain and other contract failures as
 * technical failures.
 */
export const recognizedErpErrorCodeDispositions: Readonly<
  Record<ErpErrorCode, ErpOutcomeDisposition>
> = {
  erp_capacity_exceeded: "capacity_rejected",
  erp_forced_outage: "temporarily_unavailable",
  erp_injected_error: "temporarily_unavailable",
  erp_idempotency_conflict: "technical_failure",
};

/** Immutable request identity stored with a durable terminal ERP outcome. */
export const erpLookupIdentitySchema = z
  .object({
    orderId: uuidSchema,
    publicOrderId: z.string().trim().min(1),
    reservationId: uuidSchema,
    saleOfferId: uuidSchema,
    runId: uuidSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
    quantity: positiveIntegerSchema,
  })
  .strict();
export type ErpLookupIdentity = z.infer<typeof erpLookupIdentitySchema>;

/**
 * Canonical terminal result of an ERP confirmation. Success carries the
 * immutable identity.
 */
export const erpLookupResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      identity: erpLookupIdentitySchema,
      status: z.literal("succeeded"),
      result: erpConfirmationSucceededResponseSchema,
    })
    .strict(),
  /**
   * `unknown` means "no terminal record": never received, still processing, or
   * lost. When no ledger row exists the ERP cannot know the order, reservation,
   * sale offer, or quantity behind the key, so only the queried key (at most)
   * is echoed back. It is never evidence of no effect.
   */
  z
    .object({
      status: z.literal("unknown"),
      idempotencyKey: idempotencyKeySchema.optional(),
    })
    .strict(),
]);

export const erpLookupResponseSchema = z
  .object({
    lookup: erpLookupResultSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();
export type ErpLookupResponse = z.infer<typeof erpLookupResponseSchema>;

/**
 * Replay metadata: a replay that returns a stored result is flagged by
 * this response header, never inside the JSON body, so exact comparisons of
 * canonical results stay valid.
 */
export const erpReplayedResponseHeaderName = "x-erp-replayed" as const;
export const erpReplayedResponseHeaderValue = "true" as const;
