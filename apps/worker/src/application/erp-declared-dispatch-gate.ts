import { erpDispatchRateLimit } from "@checkout-surge/contracts";
import type { ErpAdmissionContext } from "./order-process-admission.js";

export interface ErpDeclaredDispatchGate {
  tryAcquire(
    context: ErpAdmissionContext,
  ): Promise<{ admitted: true } | { admitted: false; nextEligibleAtMs: number }>;
}

/** One worker owns the non-BullMQ POST quota; lookups never enter this gate. */
export function createErpDeclaredDispatchGate(
  options: { now?: () => number } = {},
): ErpDeclaredDispatchGate {
  let window: { scope: string; until: number; used: number } | undefined;
  return {
    async tryAcquire(context) {
      const configuration = context.dispatch;
      // The demo already draws from BullMQ's declared-capacity limiter.
      if (!configuration || configuration.executionMode === "demo") return { admitted: true };
      const now = options.now?.() ?? Date.now();
      const limit = erpDispatchRateLimit(configuration.maxTps);
      if (!window || window.scope !== context.scope || now >= window.until) {
        window = { scope: context.scope, until: now + limit.duration, used: 0 };
      }
      if (window.used >= limit.max) return { admitted: false, nextEligibleAtMs: window.until };
      window.used += 1;
      return { admitted: true };
    },
  };
}
