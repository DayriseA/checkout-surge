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
  eventWatermarks: DashboardEventWatermarks;
}

export interface DashboardEventWatermarks {
  runLifecycle: string | null;
  inventory: string | null;
  queue: string | null;
  businessOutcome: string | null;
  trafficBaseline: string | null;
  trafficByMetricName: Record<string, string>;
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
    eventWatermarks: eventWatermarksForRecovery(recovery),
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
      return {
        ...state,
        recovery: action.recovery,
        isRefreshing: false,
        eventWatermarks: eventWatermarksForRecovery(action.recovery),
      };
    case "event-received":
      return action.discard || state.isRefreshing
        ? { ...state, liveEventCount: state.liveEventCount + 1 }
        : applyDashboardEventToState(state, action.event);
  }
}

export function applyDashboardEventToState(
  state: DashboardState,
  event: DashboardEvent,
): DashboardState {
  const application = applyDashboardEventWithWatermarks(
    state.recovery,
    state.eventWatermarks,
    event,
  );
  return {
    ...state,
    recovery: application.recovery,
    eventWatermarks: application.eventWatermarks,
    liveEventCount: state.liveEventCount + 1,
  };
}

export function applyDashboardEvent(
  recovery: BackendRead<DashboardRecoveryResponse>,
  event: DashboardEvent,
): BackendRead<DashboardRecoveryResponse> {
  return applyDashboardEventWithWatermarks(recovery, eventWatermarksForRecovery(recovery), event)
    .recovery;
}

function applyDashboardEventWithWatermarks(
  recovery: BackendRead<DashboardRecoveryResponse>,
  eventWatermarks: DashboardEventWatermarks,
  event: DashboardEvent,
): { recovery: BackendRead<DashboardRecoveryResponse>; eventWatermarks: DashboardEventWatermarks } {
  if (recovery.status !== "available") {
    return { recovery, eventWatermarks };
  }

  const current = recovery.data;
  const eventScope = classifyDashboardEventScope(current, event);
  if (eventScope === "rejected") return { recovery, eventWatermarks };
  if (eventScope === "new-run" && canEstablishNewRunScope(current, event)) {
    const incomingRecovery = recoveryForIncomingRun(recovery, event);
    return {
      recovery: incomingRecovery,
      eventWatermarks: eventWatermarksForRecovery(incomingRecovery),
    };
  }

  const projection = dashboardEventProjection(event);
  const watermark = projectionWatermark(eventWatermarks, projection);
  if (watermark !== null && !isAfter(event.occurredAt, watermark)) {
    return { recovery, eventWatermarks };
  }

  let nextRecovery: BackendRead<DashboardRecoveryResponse>;

  switch (event.type) {
    case "run.started":
    case "run.updated":
    case "run.completed":
    case "run.failed":
      nextRecovery = {
        ...recovery,
        data: { ...current, currentRun: event.run },
      };
      break;
    case "inventory.updated":
      if (isOlderThan(event.inventory.lastUpdatedAt, current.inventory?.lastUpdatedAt)) {
        return { recovery, eventWatermarks };
      }
      nextRecovery = { ...recovery, data: { ...current, inventory: event.inventory } };
      break;
    case "queue.updated":
      if (isOlderThan(event.queue.updatedAt, current.queue?.updatedAt)) {
        return { recovery, eventWatermarks };
      }
      nextRecovery = { ...recovery, data: { ...current, queue: event.queue } };
      break;
    case "traffic.metric":
      nextRecovery = {
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
      break;
    case "business.outcome.updated":
      nextRecovery = {
        ...recovery,
        data: { ...current, businessOutcome: event.outcome, consistencyLag: event.consistencyLag },
      };
      break;
  }

  return {
    recovery: nextRecovery,
    eventWatermarks: advanceProjectionWatermark(eventWatermarks, projection, event.occurredAt),
  };
}

function isOlderThan(candidate: string, current: string | undefined): boolean {
  return current !== undefined && Date.parse(candidate) < Date.parse(current);
}

function isAfter(candidate: string, current: string): boolean {
  return Date.parse(candidate) > Date.parse(current);
}

type DashboardEventProjection =
  | "runLifecycle"
  | "inventory"
  | "queue"
  | "businessOutcome"
  | { trafficMetricName: string };

function dashboardEventProjection(event: DashboardEvent): DashboardEventProjection {
  switch (event.type) {
    case "run.started":
    case "run.updated":
    case "run.completed":
    case "run.failed":
      return "runLifecycle";
    case "inventory.updated":
      return "inventory";
    case "queue.updated":
      return "queue";
    case "business.outcome.updated":
      return "businessOutcome";
    case "traffic.metric":
      return { trafficMetricName: event.metricName };
  }
}

function projectionWatermark(
  watermarks: DashboardEventWatermarks,
  projection: DashboardEventProjection,
): string | null {
  return typeof projection === "string"
    ? watermarks[projection]
    : (watermarks.trafficByMetricName[projection.trafficMetricName] ?? watermarks.trafficBaseline);
}

function advanceProjectionWatermark(
  watermarks: DashboardEventWatermarks,
  projection: DashboardEventProjection,
  occurredAt: string,
): DashboardEventWatermarks {
  if (typeof projection === "string") {
    return { ...watermarks, [projection]: occurredAt };
  }
  return {
    ...watermarks,
    trafficByMetricName: {
      ...watermarks.trafficByMetricName,
      [projection.trafficMetricName]: occurredAt,
    },
  };
}

function eventWatermarksForRecovery(
  recovery: BackendRead<DashboardRecoveryResponse>,
): DashboardEventWatermarks {
  const baseline = recovery.status === "available" ? recovery.data.recoveredAt : null;
  return {
    runLifecycle: baseline,
    inventory: baseline,
    queue: baseline,
    businessOutcome: baseline,
    trafficBaseline: baseline,
    trafficByMetricName: {},
  };
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
  if (isRunDashboardEvent(event) && event.runId !== undefined && event.runId !== event.run.runId) {
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
      correlationId: recovery.data.correlationId,
      scope: {
        runId: event.run.runId,
        saleOfferId: event.run.saleOfferId ?? null,
      },
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
