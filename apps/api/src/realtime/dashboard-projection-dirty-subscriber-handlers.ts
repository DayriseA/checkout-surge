import type { DashboardProjectionDirtySubscriberHandlers } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { DashboardProjectionPublicationScheduler } from "../services/dashboard-projection-publication-scheduler.js";
import { invalidDashboardDirtySignalMetadata } from "./invalid-dashboard-dirty-signal-metadata.js";

export function createDashboardProjectionDirtySubscriberHandlers(input: {
  projectionPublications: Pick<DashboardProjectionPublicationScheduler, "markDirty">;
  logger: CheckoutSurgeLogger;
}): DashboardProjectionDirtySubscriberHandlers {
  return {
    onDirty: (signal) => {
      input.projectionPublications.markDirty(signal);
    },
    onHandlerError: (error) => {
      input.logger.error({ err: error }, "Dashboard projection dirty handler failed.");
    },
    onInvalidMessage: (error, message) => {
      input.logger.warn(
        invalidDashboardDirtySignalMetadata(message, error),
        "Ignored invalid dashboard projection dirty signal from Redis Pub/Sub.",
      );
    },
  };
}
