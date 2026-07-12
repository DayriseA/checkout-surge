import type { SecuredReservationHold } from "@checkout-surge/contracts";
import type { CheckoutSurgeDatabase } from "@checkout-surge/db";
import { describe, expect, it } from "vitest";
import { PostgresBuyPersistence } from "../src/services/postgres-buy-persistence.js";

const hold: SecuredReservationHold = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  correlationId: "attempt-correlation",
  quantity: 2,
  status: "secured",
  reservationToken: "shared-reservation-token",
  securedAt: "2026-07-12T12:00:00.000Z",
  expiresAt: "2026-07-12T12:15:00.000Z",
};

const durableRow = {
  reservation: {
    id: hold.id,
    saleOfferId: hold.saleOfferId,
    runId: hold.runId ?? null,
    correlationId: "winner-correlation",
    quantity: hold.quantity,
    status: "secured" as const,
    reservationToken: hold.reservationToken,
    securedAt: new Date("2026-07-12T11:59:59.123Z"),
    expiresAt: new Date("2026-07-12T12:14:59.123Z"),
  },
  order: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    publicOrderId: "ord_winner",
    saleOfferId: hold.saleOfferId,
    reservationId: hold.id,
    runId: hold.runId ?? null,
    correlationId: "winner-correlation",
    quantity: hold.quantity,
    status: "queued" as const,
    failureCode: null,
    failureMessage: null,
    queuedAt: new Date("2026-07-12T11:59:59.456Z"),
    processingAt: null,
    confirmedAt: null,
    failedAt: null,
  },
};

describe("PostgresBuyPersistence uniqueness-race recovery", () => {
  it.each([
    "reservations_pkey",
    "reservations_reservation_token_unique",
  ])("returns the durable winner after a matching %s conflict", async (constraint_name) => {
    const error = Object.assign(new Error("unique violation"), { code: "23505", constraint_name });
    const persistence = new PostgresBuyPersistence(fakeDatabase(error, durableRow));

    await expect(persistence.persistSecuredReservation({ reservation: hold })).resolves.toEqual({
      reservation: {
        ...hold,
        correlationId: "winner-correlation",
        securedAt: "2026-07-12T11:59:59.123Z",
        expiresAt: "2026-07-12T12:14:59.123Z",
      },
      order: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        publicOrderId: "ord_winner",
        saleOfferId: hold.saleOfferId,
        reservationId: hold.id,
        runId: hold.runId,
        correlationId: "winner-correlation",
        quantity: hold.quantity,
        status: "queued",
        queuedAt: "2026-07-12T11:59:59.456Z",
      },
    });
  });

  it("recovers when the database library wraps the PostgreSQL error as its cause", async () => {
    const postgresError = Object.assign(new Error("unique violation"), {
      code: "23505",
      constraint_name: "reservations_pkey",
    });
    const wrappedError = new Error("Failed query", { cause: postgresError });
    const persistence = new PostgresBuyPersistence(fakeDatabase(wrappedError, durableRow));

    await expect(
      persistence.persistSecuredReservation({ reservation: hold }),
    ).resolves.toMatchObject({
      reservation: { id: hold.id },
      order: { id: durableRow.order.id, publicOrderId: durableRow.order.publicOrderId },
    });
  });

  it.each([
    ["non-unique failure", Object.assign(new Error("offline"), { code: "08006" }), durableRow],
    [
      "public-order constraint",
      Object.assign(new Error("unique"), {
        code: "23505",
        constraint_name: "orders_public_order_id_unique",
      }),
      durableRow,
    ],
    [
      "order-reservation constraint",
      Object.assign(new Error("unique"), {
        code: "23505",
        constraint_name: "orders_reservation_id_unique",
      }),
      durableRow,
    ],
  ])("preserves the original failure for a %s", async (_name, error, row) => {
    const persistence = new PostgresBuyPersistence(fakeDatabase(error, row));

    await expect(persistence.persistSecuredReservation({ reservation: hold })).rejects.toBe(error);
  });

  it.each([
    ["reservations_pkey", "missing durable buy", null],
    [
      "reservations_pkey",
      "mismatched durable buy",
      { ...durableRow, reservation: { ...durableRow.reservation, quantity: 99 } },
    ],
    ["reservations_reservation_token_unique", "missing durable buy", null],
    [
      "reservations_reservation_token_unique",
      "mismatched durable buy",
      {
        ...durableRow,
        order: {
          ...durableRow.order,
          reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
      },
    ],
  ])("rejects %s recovery for a %s", async (constraint_name, _name, row) => {
    const error = Object.assign(new Error("unique"), { code: "23505", constraint_name });
    const persistence = new PostgresBuyPersistence(fakeDatabase(error, row));

    await expect(persistence.persistSecuredReservation({ reservation: hold })).rejects.toBe(error);
  });
});

function fakeDatabase(
  transactionError: Error,
  row: typeof durableRow | null,
): CheckoutSurgeDatabase {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    limit: async () => (row ? [row] : []),
  };
  return {
    transaction: async () => {
      throw transactionError;
    },
    select: () => query,
  } as unknown as CheckoutSurgeDatabase;
}
