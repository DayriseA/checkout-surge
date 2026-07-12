import {
  type ErpConfirmationRequest,
  type ErpConfirmationResponse,
  erpConfirmationResponseSchema,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, erpConfirmationResults } from "@checkout-surge/db";
import { eq, sql } from "drizzle-orm";
import {
  assertFingerprint,
  type ConfirmationLedger,
  confirmationFingerprint,
} from "./confirmation-service.js";

/** PostgreSQL-backed first-write-wins ERP ledger. */
export class PostgresConfirmationLedger implements ConfirmationLedger {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async get(request: ErpConfirmationRequest): Promise<ErpConfirmationResponse | null> {
    const [row] = await this.db
      .select()
      .from(erpConfirmationResults)
      .where(eq(erpConfirmationResults.idempotencyKey, request.idempotencyKey))
      .limit(1);
    if (!row) return null;
    assertFingerprint(row.requestFingerprint, request);
    return erpConfirmationResponseSchema.parse(row.response);
  }

  async remember(
    request: ErpConfirmationRequest,
    response: ErpConfirmationResponse,
  ): Promise<ErpConfirmationResponse> {
    const fingerprint = confirmationFingerprint(request);
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(erpConfirmationResults)
        .where(eq(erpConfirmationResults.idempotencyKey, request.idempotencyKey))
        .limit(1);
      if (existing) {
        assertFingerprint(existing.requestFingerprint, request);
        return erpConfirmationResponseSchema.parse(existing.response);
      }
      const inserted = await tx
        .insert(erpConfirmationResults)
        .values({
          idempotencyKey: request.idempotencyKey,
          orderId: request.orderId,
          requestFingerprint: fingerprint,
          response,
          confirmationId: response.confirmationId ?? "unknown",
          httpStatus: response.httpStatus ?? 200,
          processedAt: new Date(response.timestamp),
        })
        .onConflictDoNothing({ target: erpConfirmationResults.idempotencyKey })
        .returning({ id: erpConfirmationResults.id });
      if (inserted.length > 0) return response;
      const [canonical] = await tx
        .select()
        .from(erpConfirmationResults)
        .where(eq(erpConfirmationResults.idempotencyKey, request.idempotencyKey))
        .limit(1);
      if (!canonical) throw new Error("ERP ledger insert disappeared before replay.");
      assertFingerprint(canonical.requestFingerprint, request);
      return erpConfirmationResponseSchema.parse(canonical.response);
    });
  }

  async perform(
    request: ErpConfirmationRequest,
    produce: () => Promise<ErpConfirmationResponse>,
  ): Promise<ErpConfirmationResponse> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${request.idempotencyKey}))`);
      const [existing] = await tx
        .select()
        .from(erpConfirmationResults)
        .where(eq(erpConfirmationResults.idempotencyKey, request.idempotencyKey))
        .limit(1);
      if (existing) {
        assertFingerprint(existing.requestFingerprint, request);
        return erpConfirmationResponseSchema.parse(existing.response);
      }
      const response = await produce();
      if (response.status !== "succeeded") return response;
      const inserted = await tx
        .insert(erpConfirmationResults)
        .values({
          idempotencyKey: request.idempotencyKey,
          orderId: request.orderId,
          requestFingerprint: confirmationFingerprint(request),
          response,
          confirmationId: response.confirmationId ?? "unknown",
          httpStatus: response.httpStatus ?? 200,
          processedAt: new Date(response.timestamp),
        })
        .onConflictDoNothing({ target: erpConfirmationResults.idempotencyKey })
        .returning({ id: erpConfirmationResults.id });
      if (inserted.length > 0) return response;
      const [canonical] = await tx
        .select()
        .from(erpConfirmationResults)
        .where(eq(erpConfirmationResults.idempotencyKey, request.idempotencyKey))
        .limit(1);
      if (!canonical) throw new Error("ERP ledger insert disappeared before replay.");
      assertFingerprint(canonical.requestFingerprint, request);
      return erpConfirmationResponseSchema.parse(canonical.response);
    });
  }
}
