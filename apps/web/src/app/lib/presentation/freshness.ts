import {
  type DemoRunSnapshot,
  dashboardLiveUpdateExpectedIntervalMs,
} from "@checkout-surge/contracts";

export type RealtimeConnectionStatus = "connecting" | "connected" | "disconnected" | "unsupported";

export const dashboardStaleAfterMs = 3 * dashboardLiveUpdateExpectedIntervalMs;

export type FreshnessState =
  | "connecting"
  | "unsupported"
  | "live"
  | "retained-fresh"
  | "stale"
  | "disconnected"
  | "not-applicable";

export interface Freshness {
  state: FreshnessState;
  observedAt: string;
  final: boolean;
}

export function dashboardUpdateExpected(projection: {
  queue: { depth: number; counts: { active: number } } | null;
  inventory: { pendingPersistenceCount: number } | null;
}): boolean {
  return (
    (projection.queue?.depth ?? 0) > 0 ||
    (projection.queue?.counts.active ?? 0) > 0 ||
    (projection.inventory?.pendingPersistenceCount ?? 0) > 0
  );
}

export function deriveFreshness(input: {
  transportStatus: RealtimeConnectionStatus;
  recoveredAt: string;
  now: Date;
  lifecycle: DemoRunSnapshot["status"] | null;
  updateExpected: boolean;
}): Freshness {
  const result = (state: FreshnessState): Freshness => ({
    state,
    observedAt: input.recoveredAt,
    final: input.lifecycle === "completed" || input.lifecycle === "failed",
  });

  if (input.lifecycle === null || input.lifecycle === "completed" || input.lifecycle === "failed") {
    return result("not-applicable");
  }
  if (input.transportStatus === "connecting") return result("connecting");
  if (input.transportStatus === "unsupported") return result("unsupported");
  if (input.transportStatus === "disconnected") return result("disconnected");
  if (!input.updateExpected) return result("retained-fresh");

  return result(
    input.now.getTime() - Date.parse(input.recoveredAt) >= dashboardStaleAfterMs ? "stale" : "live",
  );
}
