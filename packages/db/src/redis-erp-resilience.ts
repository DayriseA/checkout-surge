import {
  type ErpCircuitBreakerSnapshot,
  erpCircuitBreakerSnapshotSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

export const erpCircuitBreakerSnapshotKey = "checkout-surge:erp:circuit-breaker-snapshot" as const;
export const erpCircuitBreakerSnapshotCatalogKey =
  `${erpCircuitBreakerSnapshotKey}:catalog` as const;
const erpCircuitBreakerSnapshotRunPrefix = `${erpCircuitBreakerSnapshotKey}:run:` as const;
const dashboardSnapshotRetentionSeconds = 86_400;
// Keep both the EX value and its millisecond representation within JavaScript's
// safe-integer range while remaining far below Redis's signed 64-bit expiry limit.
const maximumSnapshotTtlSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);

export type ErpCircuitBreakerScope = { type: "catalog" } | { type: "run"; runId: string };

export function getErpCircuitBreakerSnapshotKey(scope: ErpCircuitBreakerScope): string {
  return scope.type === "catalog"
    ? erpCircuitBreakerSnapshotCatalogKey
    : `${erpCircuitBreakerSnapshotRunPrefix}${scope.runId}`;
}

export async function setErpCircuitBreakerSnapshot(
  redis: CheckoutSurgeRedis,
  snapshot: ErpCircuitBreakerSnapshot,
  scope: ErpCircuitBreakerScope = { type: "catalog" },
): Promise<void> {
  await redis.set(
    getErpCircuitBreakerSnapshotKey(scope),
    JSON.stringify(snapshot),
    "EX",
    getErpCircuitBreakerSnapshotTtlSeconds(snapshot),
  );
  await redis.del(erpCircuitBreakerSnapshotKey);
}

export function getErpCircuitBreakerSnapshotTtlSeconds(
  snapshot: Pick<ErpCircuitBreakerSnapshot, "resetTimeoutMs">,
): number {
  const roundedResetTimeoutSeconds = Math.ceil(snapshot.resetTimeoutMs / 1_000);
  if (
    !Number.isSafeInteger(roundedResetTimeoutSeconds) ||
    roundedResetTimeoutSeconds > Math.floor(maximumSnapshotTtlSeconds / 2)
  ) {
    return maximumSnapshotTtlSeconds;
  }
  const resetRetentionSeconds = roundedResetTimeoutSeconds * 2;
  return Math.max(dashboardSnapshotRetentionSeconds, resetRetentionSeconds);
}

export async function getErpCircuitBreakerSnapshot(
  redis: CheckoutSurgeRedis,
  scope: ErpCircuitBreakerScope = { type: "catalog" },
): Promise<ErpCircuitBreakerSnapshot | null> {
  const raw = await redis.get(getErpCircuitBreakerSnapshotKey(scope));
  return raw ? erpCircuitBreakerSnapshotSchema.parse(JSON.parse(raw)) : null;
}

export async function clearErpCircuitBreakerSnapshots(redis: CheckoutSurgeRedis): Promise<void> {
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${erpCircuitBreakerSnapshotKey}:*`,
      "COUNT",
      100,
    );
    cursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== "0");
  await redis.del(erpCircuitBreakerSnapshotKey);
}
