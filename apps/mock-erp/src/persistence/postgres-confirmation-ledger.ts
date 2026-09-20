import {
  type ErpConfirmationResponse,
  erpConfirmationResponseSchema,
  erpLookupIdentitySchema,
  erpLookupResultSchema,
} from "@checkout-surge/contracts";
import type { SqlClient } from "@checkout-surge/db";
import type {
  ConfirmationLedger,
  ConfirmationLedgerEntry,
} from "../application/confirmation-service.js";

interface LedgerRow {
  idempotencyKey: string;
  orderId: string;
  publicOrderId: string;
  reservationId: string;
  saleOfferId: string;
  runId: string | null;
  quantity: number;
  terminalResult: unknown;
}

export class PostgresConfirmationLedger implements ConfirmationLedger {
  constructor(private readonly sql: SqlClient) {}

  async find(idempotencyKey: string): Promise<ConfirmationLedgerEntry | null> {
    const [row] = await this.sql<LedgerRow[]>`
      SELECT
        idempotency_key AS "idempotencyKey",
        order_id AS "orderId",
        public_order_id AS "publicOrderId",
        reservation_id AS "reservationId",
        sale_offer_id AS "saleOfferId",
        run_id AS "runId",
        quantity,
        terminal_result AS "terminalResult"
      FROM erp_confirmation_ledger
      WHERE idempotency_key = ${idempotencyKey}
      LIMIT 1
    `;
    return row ? parseLedgerRow(row) : null;
  }

  async save(entry: ConfirmationLedgerEntry): Promise<{
    entry: ConfirmationLedgerEntry;
    inserted: boolean;
  }> {
    const inserted = await this.sql<{ idempotencyKey: string }[]>`
      INSERT INTO erp_confirmation_ledger (
        idempotency_key,
        order_id,
        public_order_id,
        reservation_id,
        sale_offer_id,
        run_id,
        quantity,
        terminal_result
      ) VALUES (
        ${entry.identity.idempotencyKey},
        ${entry.identity.orderId},
        ${entry.identity.publicOrderId},
        ${entry.identity.reservationId},
        ${entry.identity.saleOfferId},
        ${entry.identity.runId ?? null},
        ${entry.identity.quantity},
        ${JSON.stringify(entry.response)}::jsonb
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key AS "idempotencyKey"
    `;
    const canonical = await this.find(entry.identity.idempotencyKey);
    if (!canonical) {
      throw new Error(`ERP confirmation ledger row ${entry.identity.idempotencyKey} was not found.`);
    }
    return { entry: canonical, inserted: inserted.length === 1 };
  }
}

function parseLedgerRow(row: LedgerRow): ConfirmationLedgerEntry {
  const identity = erpLookupIdentitySchema.parse({
    orderId: row.orderId,
    publicOrderId: row.publicOrderId,
    reservationId: row.reservationId,
    saleOfferId: row.saleOfferId,
    ...(row.runId ? { runId: row.runId } : {}),
    idempotencyKey: row.idempotencyKey,
    quantity: row.quantity,
  });
  const response = erpConfirmationResponseSchema.parse(
    row.terminalResult,
  ) as ErpConfirmationResponse;
  const terminal = erpLookupResultSchema.parse({
    status: response.status === "succeeded" ? "succeeded" : "rejected",
    identity,
    result: response,
  });
  if (terminal.status === "unknown") {
    throw new Error(`ERP confirmation ledger row ${row.idempotencyKey} is not terminal.`);
  }
  return { identity: terminal.identity, response: terminal.result };
}
