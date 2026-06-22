import {
  type ErpCircuitBreakerSnapshot,
  erpCircuitBreakerSnapshotSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

export const erpCircuitBreakerSnapshotKey = "checkout-surge:erp:circuit-breaker-snapshot" as const;

export async function setErpCircuitBreakerSnapshot(
  redis: CheckoutSurgeRedis,
  snapshot: ErpCircuitBreakerSnapshot,
): Promise<void> {
  await redis.set(erpCircuitBreakerSnapshotKey, JSON.stringify(snapshot));
}

export async function getErpCircuitBreakerSnapshot(
  redis: CheckoutSurgeRedis,
): Promise<ErpCircuitBreakerSnapshot | null> {
  const raw = await redis.get(erpCircuitBreakerSnapshotKey);
  return raw ? erpCircuitBreakerSnapshotSchema.parse(JSON.parse(raw)) : null;
}
