import type { DashboardEvent, DashboardRecoveryResponse } from "@checkout-surge/contracts";
import type { BackendRead } from "./api";

export interface DashboardState {
  recovery: BackendRead<DashboardRecoveryResponse>;
  liveEventCount: number;
  isRefreshing: boolean;
}

export type DashboardStateAction =
  | { type: "snapshot-received"; recovery: BackendRead<DashboardRecoveryResponse> }
  | { type: "refresh-started" }
  | { type: "refresh-completed"; recovery: BackendRead<DashboardRecoveryResponse> }
  | { type: "event-received"; event: DashboardEvent; discard: boolean };

export function createDashboardState(
  recovery: BackendRead<DashboardRecoveryResponse>,
): DashboardState {
  return {
    recovery,
    liveEventCount: 0,
    isRefreshing: false,
  };
}

export function dashboardStateReducer(
  state: DashboardState,
  action: DashboardStateAction,
): DashboardState {
  switch (action.type) {
    case "snapshot-received":
      return createDashboardState(action.recovery);
    case "refresh-started":
      return { ...state, isRefreshing: true };
    case "refresh-completed":
      return { ...state, recovery: action.recovery, isRefreshing: false };
    case "event-received":
      return action.discard || state.isRefreshing
        ? { ...state, liveEventCount: state.liveEventCount + 1 }
        : {
            ...state,
            recovery: applyDashboardEvent(state.recovery, action.event),
            liveEventCount: state.liveEventCount + 1,
          };
  }
}

export function applyDashboardEvent(
  recovery: BackendRead<DashboardRecoveryResponse>,
  event: DashboardEvent,
): BackendRead<DashboardRecoveryResponse> {
  if (recovery.status !== "available" || !isDashboardEventInRecoveredScope(recovery.data, event)) {
    return recovery;
  }

  const current = recovery.data;
  switch (event.type) {
    case "run.started":
    case "run.updated":
    case "run.completed":
    case "run.failed":
      return {
        ...recovery,
        data: { ...current, currentRun: event.run, recoveredAt: event.occurredAt },
      };
    case "inventory.updated":
      return isOlderThan(event.inventory.lastUpdatedAt, current.inventory?.lastUpdatedAt)
        ? recovery
        : { ...recovery, data: { ...current, inventory: event.inventory } };
    case "queue.updated":
      return isOlderThan(event.queue.updatedAt, current.queue?.updatedAt)
        ? recovery
        : { ...recovery, data: { ...current, queue: event.queue } };
    case "traffic.metric":
      return {
        ...recovery,
        data: {
          ...current,
          recentMetrics: [
            ...current.recentMetrics.slice(-19),
            {
              metricName: event.metricName,
              value: event.value,
              unit: event.unit,
              timestamp: event.occurredAt,
            },
          ],
        },
      };
    case "business.outcome.updated":
      return {
        ...recovery,
        data: { ...current, businessOutcome: event.outcome, consistencyLag: event.consistencyLag },
      };
  }
}

function isOlderThan(candidate: string, current: string | undefined): boolean {
  return current !== undefined && Date.parse(candidate) < Date.parse(current);
}

export function shouldRequestAuthoritativeRecoveryAfterEvent(event: DashboardEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed";
}

function isDashboardEventInRecoveredScope(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): boolean {
  if (Date.parse(event.occurredAt) < Date.parse(recovery.recoveredAt)) return false;
  if (!matchesRecoveredRun(recovery.currentRun?.runId ?? null, event)) return false;
  return matchesRecoveredSaleOffer(recovery, event);
}

function matchesRecoveredRun(currentRunId: string | null, event: DashboardEvent): boolean {
  if (!event.runId) return true;
  if (currentRunId) return event.runId === currentRunId;
  return isRunDashboardEvent(event);
}

function matchesRecoveredSaleOffer(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): boolean {
  const eventSaleOfferId = dashboardEventSaleOfferId(event);
  if (!eventSaleOfferId || (isRunDashboardEvent(event) && recovery.currentRun === null))
    return true;
  const currentSaleOfferId = recoveredSaleOfferId(recovery);
  return currentSaleOfferId === null || eventSaleOfferId === currentSaleOfferId;
}

function recoveredSaleOfferId(recovery: DashboardRecoveryResponse): string | null {
  return (
    recovery.currentRun?.saleOfferId ??
    recovery.inventory?.saleOfferId ??
    recovery.recentCompletionOutcomes[0]?.saleOfferId ??
    null
  );
}

function dashboardEventSaleOfferId(event: DashboardEvent): string | null {
  switch (event.type) {
    case "run.started":
    case "run.updated":
    case "run.completed":
    case "run.failed":
      return event.run.saleOfferId ?? null;
    case "inventory.updated":
      return event.inventory.saleOfferId;
    case "business.outcome.updated":
      return event.saleOfferId;
    case "traffic.metric":
    case "queue.updated":
      return null;
  }
}

function isRunDashboardEvent(event: DashboardEvent): boolean {
  return event.type.startsWith("run.");
}
