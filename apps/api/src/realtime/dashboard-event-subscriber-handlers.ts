import type { DashboardEventSubscriberHandlers } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { DashboardProjectionPublicationScheduler } from "../services/dashboard-projection-publication-scheduler.js";
import type { DashboardEventFanout } from "./dashboard-event-fanout.js";
import { invalidDashboardEventMetadata } from "./invalid-dashboard-event-metadata.js";

export function createDashboardEventSubscriberHandlers(input: {
  fanout: Pick<DashboardEventFanout, "publish">;
  projectionPublications: Pick<DashboardProjectionPublicationScheduler, "markDirty">;
  logger: CheckoutSurgeLogger;
}): DashboardEventSubscriberHandlers {
  return {
    onEvent: (event) => {
      // Legacy delivery remains until Task 39. Projection publication treats
      // the already-validated event only as a coalesced dirtiness signal.
      input.fanout.publish(event);
      input.projectionPublications.markDirty(event);
    },
    onHandlerError: (error) => {
      input.logger.error({ err: error }, "Dashboard event fan-out failed.");
    },
    onInvalidMessage: (error, message) => {
      input.logger.warn(
        invalidDashboardEventMetadata(message, error),
        "Ignored invalid dashboard realtime event from Redis Pub/Sub.",
      );
    },
  };
}
