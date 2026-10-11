import {
  type DatabaseConnection,
  PostgresOrderDelivery,
  PostgresStockReservations,
} from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { PostgresBuyPersistence } from "../services/postgres-buy-persistence.js";
import type { ReserveOrderService } from "../services/reserve-order-service.js";
import { createSessionBoundBuyAcceptance } from "../services/session-bound-buy-acceptance.js";
import { createReserveOrderService } from "./create-reserve-order-service.js";

/** Infrastructure is shared; the mutable admission-session wrapper belongs to one request. */
export function createPostgresReserveOrderService(
  database: DatabaseConnection,
  options: Omit<
    ConstructorParameters<typeof ReserveOrderService>[0],
    | "persistence"
    | "stockReservations"
    | "orderProcessJobPublisher"
    | "soldOutObservations"
    | "recordRedisReservationTiming"
  >,
  logger: CheckoutSurgeLogger,
): Pick<ReserveOrderService, "reserve"> {
  const persistence = new PostgresBuyPersistence(database.db);
  const stockReservations = new PostgresStockReservations(database.sql);
  const delivery = new PostgresOrderDelivery(database.sql);
  return {
    reserve: (input) => {
      const acceptance = createSessionBoundBuyAcceptance({
        persistence,
        publish: (session, job) => delivery.publish(session, job),
      });
      return createReserveOrderService(
        {
          ...options,
          persistence: acceptance.persistence,
          orderProcessJobPublisher: acceptance.publisher,
          stockReservations,
          soldOutObservations: {
            observeSoldOut: (request) =>
              options.dashboardSourceDirtyScheduler?.scheduleInventory(request),
          },
          recordRedisReservationTiming: false,
        },
        logger,
      ).reserve(input);
    },
  };
}
