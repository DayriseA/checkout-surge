import { describe, expect, it, vi } from "vitest";
import { PostgresOrderRecoveryPersistence } from "../../src/persistence/postgres-order-recovery-persistence.js";

describe("Postgres order recovery persistence", () => {
  it("stores raw scalar DLQ payloads without coupling claimed IDs to orders", async () => {
    const values = vi.fn().mockReturnThis();
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined);
    const db = {
      insert: vi.fn().mockReturnValue({ values, onConflictDoNothing }),
    } as never;
    const persistence = new PostgresOrderRecoveryPersistence(db);

    await persistence.recordDeadLetter({
      jobId: "missing-job",
      jobName: "invalid-name",
      queueName: "orders:process",
      payload: null,
      reason: "invalid_job_payload",
      attemptsMade: 0,
      observedAt: new Date("2026-06-22T00:00:00.000Z"),
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: null,
        queueName: "orders:process",
      }),
    );
    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("orderId");
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
  });

  it("does not let a retained original failed job overwrite a newer recovery publication", async () => {
    const existing = {
      status: "enqueued",
      nextAttemptAt: new Date("2026-06-21T00:00:00.000Z"),
      sourceJobId: "recovery-11111111-1111-4111-8111-111111111111-2",
      sourceDisposition: "recovery-11111111-1111-4111-8111-111111111111-2:1",
    };
    const limit = vi.fn().mockResolvedValue([existing]);
    const insert = vi.fn();
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit,
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      }),
      insert,
    } as never;
    const persistence = new PostgresOrderRecoveryPersistence(db);

    await persistence.recordRecoverable({
      job: {
        orderId: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_recovery",
        reservationId: "22222222-2222-4222-8222-222222222222",
        saleOfferId: "33333333-3333-4333-8333-333333333333",
        correlationId: "corr-recovery",
        quantity: 1,
        queuedAt: "2026-06-22T00:00:00.000Z",
      },
      delivery: { attemptNumber: 4, attemptsMade: 3, deliveryId: "original-job" },
      reason: "failed_queue_job_reconciliation",
      error: new Error("retained source"),
      sourceJobId: "original-job",
      sourceDisposition: "original-job:4",
    });

    expect(insert).not.toHaveBeenCalled();
  });
});
