import type { ErpAdmissionContext } from "../application/order-process-admission.js";

export function createOrderDeliveryPause(
  pauseBullMqDelivery: (durationMs: number) => Promise<void>,
): (durationMs: number, context: ErpAdmissionContext) => Promise<void> {
  return async (durationMs, context) => {
    if (!context.dispatch || context.dispatch.executionMode === "demo")
      await pauseBullMqDelivery(durationMs);
    // PostgreSQL work follows the same adaptive controller's durable cooldown.
  };
}
