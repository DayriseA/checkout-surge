import { describe, expect, it, vi } from "vitest";
import { PostgresErpAttemptPersistence } from "../../src/persistence/postgres-erp-attempt-persistence.js";

const job = {
  orderId: "11111111-1111-4111-8111-111111111111",
  publicOrderId: "ord_attempt",
  reservationId: "22222222-2222-4222-8222-222222222222",
  saleOfferId: "33333333-3333-4333-8333-333333333333",
  correlationId: "corr-attempt",
  quantity: 1,
  queuedAt: "2026-06-22T00:00:00.000Z",
  processingGeneration: 0,
};

const record = {
  job,
  delivery: { attemptNumber: 1, attemptsMade: 0, maxAttempts: 1 },
  status: "succeeded" as const,
  operation: "dispatched_confirmation" as const,
  replayed: true,
  terminal: true,
  httpStatus: 200,
  latencyMs: 4,
  startedAt: new Date("2026-06-22T00:00:00.000Z"),
  finishedAt: new Date("2026-06-22T00:00:00.004Z"),
  response: {
    status: "succeeded" as const,
    confirmationId: "erp-confirmation",
    httpStatus: 200 as const,
    latencyMs: 4,
    timestamp: "2026-06-22T00:00:00.004Z",
  },
};

function chain<T>(value: T) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(value),
  };
}

function databaseWithTransaction<T>(transaction: T) {
  const runTransaction = async <R>(callback: (tx: T) => Promise<R>): Promise<R> =>
    callback(transaction);
  return {
    transaction: vi.fn(runTransaction),
  } as never;
}

describe("Postgres ERP attempt persistence", () => {
  it("writes the local response and idempotency key, then replays the same attempt", async () => {
    const attemptInsert = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ id: "attempt-id" }]),
    };
    const eventInsert = { values: vi.fn().mockResolvedValue(undefined) };
    let selectCalls = 0;
    const existing = {
      status: "succeeded",
      terminal: true,
      httpStatus: 200,
      errorCode: null,
      errorMessage: null,
      confirmationId: "erp-confirmation",
      idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
      response: {
        timestamp: record.response.timestamp,
        latencyMs: record.response.latencyMs,
        httpStatus: record.response.httpStatus,
        confirmationId: record.response.confirmationId,
        status: record.response.status,
      },
    };
    const tx = {
      select: vi.fn(() => chain(selectCalls++ < 6 ? [] : [existing])),
      insert: vi.fn().mockReturnValueOnce(attemptInsert).mockReturnValueOnce(eventInsert),
    };
    const db = databaseWithTransaction(tx);
    const persistence = new PostgresErpAttemptPersistence(db);

    await expect(persistence.recordAttempt(record)).resolves.toBe(true);
    await expect(persistence.recordAttempt(record)).resolves.toBe(false);

    expect(attemptInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "erp-confirmation:11111111-1111-4111-8111-111111111111",
        response: record.response,
        terminal: true,
      }),
    );
    expect(eventInsert.values).toHaveBeenCalledOnce();
    expect(eventInsert.values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          terminal: true,
          operation: "dispatched_confirmation",
          replayed: true,
        }),
      }),
    );
  });

  it("rejects a replay whose terminal classification contradicts the durable attempt", async () => {
    const tx = {
      select: vi.fn(() =>
        chain([
          {
            status: "succeeded",
            terminal: true,
            httpStatus: 200,
            errorCode: null,
            errorMessage: null,
            confirmationId: record.response.confirmationId,
            idempotencyKey: `erp-confirmation:${job.orderId}`,
            response: record.response,
          },
        ]),
      ),
    };
    const db = databaseWithTransaction(tx);
    const persistence = new PostgresErpAttemptPersistence(db);

    await expect(persistence.recordAttempt({ ...record, terminal: false })).rejects.toThrow(
      "contradictory ERP attempt",
    );
  });
});
