import {
  erpConfirmationResponseSchema,
  erpLookupIdentitySchema,
  erpLookupResultSchema,
  isDestructiveResetReason,
} from "@checkout-surge/contracts";
import { type SqlClient, terminalDemoRunTransitionLockKey } from "@checkout-surge/db";
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
  runId: string;
  quantity: number;
  terminalResult: unknown;
}

export class PostgresConfirmationLedger implements ConfirmationLedger {
  constructor(private readonly sql: SqlClient) {}

  async find(idempotencyKey: string): Promise<ConfirmationLedgerEntry | null> {
    return this.findUsing(this.sql, idempotencyKey);
  }

  private async findUsing(
    sql: SqlClient,
    idempotencyKey: string,
  ): Promise<ConfirmationLedgerEntry | null> {
    const [row] = await sql<LedgerRow[]>`
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
    // The decision/latency has already completed. Hold only this short save under
    // reset's shared terminal fence, so a late ERP decision cannot repopulate its purge.
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock_shared(hashtext(${terminalDemoRunTransitionLockKey(entry.identity.runId)}))`;
      const [run] = await tx<{ status: string; failureReason: string | null }[]>`
        select status, failure_reason as "failureReason" from demo_runs where id=${entry.identity.runId}
      `;
      if (run?.status === "failed" && isDestructiveResetReason(run.failureReason)) {
        throw new Error("ERP ledger save rejected for a destructively reset run.");
      }
      // TransactionSql is callable like SqlClient here; every read stays on tx,
      // including the canonical result read, with no nested pool checkout.
      return this.saveUsing(tx as unknown as SqlClient, entry);
    });
  }

  private async saveUsing(
    sql: SqlClient,
    entry: ConfirmationLedgerEntry,
  ): Promise<{
    entry: ConfirmationLedgerEntry;
    inserted: boolean;
  }> {
    const inserted = await sql<{ idempotencyKey: string }[]>`
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
        ${entry.identity.runId},
        ${entry.identity.quantity},
        ${JSON.stringify(entry.response)}::jsonb
      )
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING idempotency_key AS "idempotencyKey"
    `;
    const canonical = await this.findUsing(sql, entry.identity.idempotencyKey);
    if (!canonical) {
      throw new Error(
        `ERP confirmation ledger row ${entry.identity.idempotencyKey} was not found.`,
      );
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
    runId: row.runId,
    idempotencyKey: row.idempotencyKey,
    quantity: row.quantity,
  });
  const response = erpConfirmationResponseSchema.parse(row.terminalResult);
  const terminal = erpLookupResultSchema.parse({
    status: response.status,
    identity,
    result: response,
  });
  if (terminal.status === "unknown") {
    throw new Error(`ERP confirmation ledger row ${row.idempotencyKey} is not terminal.`);
  }
  return { identity: terminal.identity, response: terminal.result };
}
