import { describe, expect, it, vi } from "vitest";
import { PostgresOrderDispatchPersistence } from "../../src/persistence/postgres-order-dispatch-persistence.js";

describe("Postgres order dispatch persistence", () => {
  it("selects only bounded, oldest queued orders and reconstructs jobs", async () => {
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        publicOrderId: "ord_dispatch",
        reservationId: "33333333-3333-4333-8333-333333333333",
        saleOfferId: "22222222-2222-4222-8222-222222222222",
        correlationId: "corr-dispatch",
        runId: null,
        quantity: 2,
        queuedAt: new Date("2026-06-21T00:00:00.000Z"),
      },
    ];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const persistence = new PostgresOrderDispatchPersistence({ select } as never);
    const queuedBefore = new Date("2026-06-21T00:00:05.000Z");

    await expect(
      persistence.findQueuedOrdersForDispatch({ queuedBefore, limit: 10 }),
    ).resolves.toEqual([
      {
        orderId: rows[0].id,
        publicOrderId: rows[0].publicOrderId,
        reservationId: rows[0].reservationId,
        saleOfferId: rows[0].saleOfferId,
        correlationId: rows[0].correlationId,
        quantity: rows[0].quantity,
        queuedAt: rows[0].queuedAt.toISOString(),
      },
    ]);

    expect(select).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(orderBy).toHaveBeenCalledOnce();
    expect(limit).toHaveBeenCalledWith(10);
  });
});
