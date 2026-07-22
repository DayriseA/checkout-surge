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
  reservationToken: "shared-reservation-token",
  securedAt: "2026-07-12T12:00:00.000Z",
  expiresAt: "2026-07-12T12:15:00.000Z",
};

interface DurableAcceptanceLiveRow {
  reservation: {
    id: string;
    saleOfferId: string;
    runId: string | null;
    correlationId: string;
    quantity: number;
    reservationToken: string;
    securedAt: Date;
    expiresAt: Date;
  };
  order: {
    id: string;
    publicOrderId: string;
    saleOfferId: string;
    reservationId: string;
    runId: string | null;
    correlationId: string;
    quantity: number;
    status: "queued" | "processing" | "confirmed" | "failed";
    failureCode: string | null;
    failureMessage: string | null;
    queuedAt: Date;
    processingAt: Date | null;
    confirmedAt: Date | null;
    failedAt: Date | null;
  };
}

const durableRow: DurableAcceptanceLiveRow = {
  reservation: {
    id: hold.id,
    saleOfferId: hold.saleOfferId,
    runId: hold.runId ?? null,
    correlationId: "winner-correlation",
    quantity: hold.quantity,
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

const matchingDurableRow: DurableAcceptanceLiveRow = {
  reservation: {
    ...durableRow.reservation,
    correlationId: hold.correlationId,
    securedAt: new Date(hold.securedAt),
    expiresAt: new Date(hold.expiresAt),
  },
  order: {
    ...durableRow.order,
    correlationId: hold.correlationId,
    queuedAt: new Date(hold.securedAt),
  },
};

describe("PostgresBuyPersistence uniqueness-race recovery", () => {
  it.each([
    {
      status: "confirmed",
      processingAt: new Date("2026-07-12T12:00:01.000Z"),
      confirmedAt: new Date("2026-07-12T12:00:02.000Z"),
      failedAt: null,
      failureCode: null,
      failureMessage: null,
    },
    {
      status: "failed",
      processingAt: new Date("2026-07-12T12:00:01.000Z"),
      confirmedAt: null,
      failedAt: new Date("2026-07-12T12:00:02.000Z"),
      failureCode: "erp_rejected",
      failureMessage: "Payment declined",
    },
  ] satisfies Array<
    Partial<DurableAcceptanceLiveRow["order"]>
  >)("projects a terminal $status row back to its immutable acceptance", async (terminalState) => {
    const persistence = new PostgresBuyPersistence(
      fakeDatabase(new Error("unused"), {
        ...durableRow,
        order: { ...durableRow.order, ...terminalState },
      }),
    );

    await expect(persistence.getPersistedBuyByReservationId(hold.id)).resolves.toEqual({
      reservation: {
        ...hold,
        correlationId: "winner-correlation",
        securedAt: "2026-07-12T11:59:59.123Z",
        expiresAt: "2026-07-12T12:14:59.123Z",
      },
      order: {
        id: durableRow.order.id,
        publicOrderId: durableRow.order.publicOrderId,
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

  it.each([
    "reservations_pkey",
    "reservations_reservation_token_unique",
  ])("returns the durable winner after a matching %s conflict", async (constraint_name) => {
    const error = Object.assign(new Error("unique violation"), { code: "23505", constraint_name });
    const persistence = new PostgresBuyPersistence(fakeDatabase(error, matchingDurableRow));

    await expect(persistence.persistSecuredReservation({ reservation: hold })).resolves.toEqual({
      reservation: hold,
      order: {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        publicOrderId: "ord_winner",
        saleOfferId: hold.saleOfferId,
        reservationId: hold.id,
        runId: hold.runId,
        correlationId: hold.correlationId,
        quantity: hold.quantity,
        status: "queued",
        queuedAt: hold.securedAt,
      },
    });
  });

  it("recovers when the database library wraps the PostgreSQL error as its cause", async () => {
    const postgresError = Object.assign(new Error("unique violation"), {
      code: "23505",
      constraint_name: "reservations_pkey",
    });
    const wrappedError = new Error("Failed query", { cause: postgresError });
    const persistence = new PostgresBuyPersistence(fakeDatabase(wrappedError, matchingDurableRow));

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
      "mismatched quantity",
      {
        ...matchingDurableRow,
        reservation: { ...matchingDurableRow.reservation, quantity: 99 },
      },
    ],
    [
      "reservations_pkey",
      "mismatched reservation correlation",
      {
        ...matchingDurableRow,
        reservation: {
          ...matchingDurableRow.reservation,
          correlationId: "different-correlation",
        },
      },
    ],
    [
      "reservations_pkey",
      "mismatched order correlation",
      {
        ...matchingDurableRow,
        order: { ...matchingDurableRow.order, correlationId: "different-correlation" },
      },
    ],
    ["reservations_reservation_token_unique", "missing durable buy", null],
    [
      "reservations_reservation_token_unique",
      "mismatched order reservation",
      {
        ...matchingDurableRow,
        order: {
          ...matchingDurableRow.order,
          reservationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
      },
    ],
    [
      "reservations_reservation_token_unique",
      "mismatched secured timestamp",
      {
        ...matchingDurableRow,
        reservation: {
          ...matchingDurableRow.reservation,
          securedAt: new Date("2026-07-12T11:59:59.999Z"),
        },
      },
    ],
    [
      "reservations_reservation_token_unique",
      "mismatched expiry timestamp",
      {
        ...matchingDurableRow,
        reservation: {
          ...matchingDurableRow.reservation,
          expiresAt: new Date("2026-07-12T12:14:59.999Z"),
        },
      },
    ],
    [
      "reservations_reservation_token_unique",
      "mismatched queued timestamp",
      {
        ...matchingDurableRow,
        order: {
          ...matchingDurableRow.order,
          queuedAt: new Date("2026-07-12T11:59:59.999Z"),
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
  row: DurableAcceptanceLiveRow | null,
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
