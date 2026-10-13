import type { BuyPersistence } from "../src/services/reserve-order-service.js";

export const passThroughRunLocks: Pick<
  BuyPersistence,
  "withRunAdmissionLock" | "withRunPendingPersistenceLock"
> = {
  async withRunAdmissionLock({ operation }) {
    return operation(this as BuyPersistence, { comparisonMode: null });
  },
  async withRunPendingPersistenceLock({ operation }) {
    return operation(this as BuyPersistence, "admissible");
  },
};
