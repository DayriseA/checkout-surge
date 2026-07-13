import type {
  DashboardEvent,
  DashboardRecoveryResponse,
  RunDashboardEvent,
} from "@checkout-surge/contracts";
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
  if (recovery.status !== "available") {
    return recovery;
  }

  const current = recovery.data;
  const eventScope = classifyDashboardEventScope(current, event);
  if (eventScope === "rejected") return recovery;
  if (eventScope === "new-run" && canEstablishNewRunScope(current, event)) {
    return recoveryForIncomingRun(recovery, event);
  }

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

export function shouldRequestAuthoritativeRecoveryAfterScopedEvent(
  recovery: BackendRead<DashboardRecoveryResponse>,
  event: DashboardEvent,
): boolean {
  if (recovery.status !== "available") return false;
  const eventScope = classifyDashboardEventScope(recovery.data, event);
  if (eventScope === "rejected") return false;
  return eventScope === "new-run" || shouldRequestAuthoritativeRecoveryAfterEvent(event);
}

function classifyDashboardEventScope(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): "rejected" | "current" | "new-run" {
  if (
    isRunDashboardEvent(event) &&
    event.runId !== undefined &&
    event.runId !== event.run.runId
  ) {
    return "rejected";
  }
  if (Date.parse(event.occurredAt) < Date.parse(recovery.recoveredAt)) return "rejected";

  const currentRunId = recovery.currentRun?.runId ?? null;
  const eventRunId = dashboardEventRunId(event);
  if (eventRunId !== null && eventRunId !== currentRunId) {
    return canEstablishNewRunScope(recovery, event) ? "new-run" : "rejected";
  }

  return matchesRecoveredSaleOffer(recovery, event) ? "current" : "rejected";
}

function dashboardEventRunId(event: DashboardEvent): string | null {
  return isRunDashboardEvent(event) ? event.run.runId : (event.runId ?? null);
}

function canEstablishNewRunScope(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): event is RunDashboardEvent & { type: "run.started" | "run.updated" } {
  if (event.type !== "run.started" && event.type !== "run.updated") return false;
  if (!["starting", "active", "draining"].includes(event.run.status)) return false;

  const currentStartedAt = recovery.currentRun?.startedAt;
  if (!recovery.currentRun) {
    return (
      event.run.startedAt !== undefined &&
      Date.parse(event.run.startedAt) >= Date.parse(recovery.recoveredAt)
    );
  }
  if (!currentStartedAt || !event.run.startedAt) return false;
  return Date.parse(event.run.startedAt) > Date.parse(currentStartedAt);
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

function isRunDashboardEvent(event: DashboardEvent): event is RunDashboardEvent {
  return event.type.startsWith("run.");
}

function recoveryForIncomingRun(
  recovery: Extract<BackendRead<DashboardRecoveryResponse>, { status: "available" }>,
  event: RunDashboardEvent & { type: "run.started" | "run.updated" },
): BackendRead<DashboardRecoveryResponse> {
  return {
    ...recovery,
    data: {
      currentRun: event.run,
      inventory: null,
      recentMetrics: [],
      queue: null,
      erp: null,
      businessOutcome: null,
      consistencyLag: null,
      recentCompletionOutcomes: [],
      recoveredAt: event.occurredAt,
    },
  };
}
