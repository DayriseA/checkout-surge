import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { SqlClient } from "@checkout-surge/db";
import type { OrderProcessJobPublisher } from "./order-process-job-publisher.js";
import type { PostgresBuyPersistence } from "./postgres-buy-persistence.js";
import type { BuyPersistence } from "./reserve-order-service.js";

/** Create once per request/recovery attempt; publication uses its admission session. */
export function createSessionBoundBuyAcceptance(options: {
  persistence: PostgresBuyPersistence;
  publish(session: SqlClient, job: OrderProcessJob): Promise<void>;
}): { persistence: BuyPersistence; publisher: OrderProcessJobPublisher } {
  let session: SqlClient | undefined;
  const withSession = async <T>(reserved: SqlClient, operation: () => Promise<T>) => {
    session = reserved;
    try {
      return await operation();
    } finally {
      session = undefined;
    }
  };
  return {
    persistence: {
      persistSecuredReservation: (input) => options.persistence.persistSecuredReservation(input),
      getPersistedBuyByReservationId: (id) =>
        options.persistence.getPersistedBuyByReservationId(id),
      withRunPendingPersistenceLock: (input) =>
        options.persistence.withRunPendingPersistenceLockAndSession({
          reservation: input.reservation,
          operation: (operations, disposition, reserved) =>
            withSession(reserved, () => input.operation(operations, disposition)),
        }),
      withRunAdmissionLock: (input) =>
        options.persistence.withRunAdmissionLockAndSession({
          reservation: input.reservation,
          operation: (operations, reserved) =>
            withSession(reserved, () => input.operation(operations)),
        }),
    },
    publisher: {
      enqueue: async (job) => {
        if (!session) throw new Error("Publication requires this request's admission session.");
        await options.publish(session, job);
      },
    },
  };
}
