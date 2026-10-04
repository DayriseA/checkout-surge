import { coreActivityPath, coreIdleStatusPath } from "@checkout-surge/contracts";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { CoreIdleShutdown } from "../services/core-idle-stop.js";

export function registerCoreIdleRoutes(
  app: ApiFastifyInstance,
  options: { coreIdleShutdown: CoreIdleShutdown },
): void {
  app.get(coreIdleStatusPath, async () => options.coreIdleShutdown.status());

  app.post(coreActivityPath, async () => {
    options.coreIdleShutdown.recordActivity();
    return options.coreIdleShutdown.status();
  });
}
