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
  recentOrderStates: RecentOrderState[];
  recentOrderLagSamples: RecentOrderLagSample[];
  seenOrderEventIds: string[];
}

export interface RecentOrderState {
  orderId: string;
  publicOrderId: string;
  status: "queued" | "processing" | "confirmed" | "failed";
  occurredAt: string;
  correlationId: string;
}

export interface RecentOrderLagSample {
  eventId: string;
  orderId: string;
  publicOrderId: string;
  valueMs: number;
  observedAt: string;
}

export interface DashboardEventWatermarks {
  runLifecycle: string | null;
  inventory: string | null;
  queue: string | null;
  businessOutcome: string | null;
  metricBaseline: string | null;
  metricByName: Record<string, string>;
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
    ...orderAdvisoryStateForRecovery(recovery),
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
        ...orderAdvisoryStateForRecovery(action.recovery),
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
  const orderState = applyOrderRealtimeEvent(state, event);
  if (orderState !== state) {
    return { ...orderState, liveEventCount: state.liveEventCount + 1 };
  }
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
  if (event.type === "order.status.updated" || isOrderLagMetric(event)) {
    return { recovery, eventWatermarks };
  }

  const projection = dashboardEventProjection(event);
  const watermark = projectionWatermark(eventWatermarks, projection);
  const projectionObservedAt = dashboardEventObservedAt(event);
  if (watermark !== null && !isAfter(projectionObservedAt, watermark)) {
    return { recovery, eventWatermarks };
  }

  let nextRecovery: BackendRead<DashboardRecoveryResponse>;

  switch (event.type) {
    case "load.run.updated":
      nextRecovery = {
        ...recovery,
        data: { ...current, currentRun: event.run },
      };
      break;
    case "dashboard.metric.observed":
      {
        const metricApplication = applyMetricObservation(recovery, event);
        if (!metricApplication.applied) return { recovery, eventWatermarks };
        nextRecovery = metricApplication.recovery;
      }
      break;
    case "business.outcome.snapshot":
      nextRecovery = {
        ...recovery,
        data: { ...current, businessOutcome: event.outcome, consistencyLag: event.consistencyLag },
      };
      break;
    case "business.event.recorded":
      return { recovery, eventWatermarks };
  }

  return {
    recovery: nextRecovery,
    eventWatermarks: advanceProjectionWatermark(eventWatermarks, projection, projectionObservedAt),
  };
}

function dashboardEventObservedAt(event: DashboardEvent): string {
  return event.type === "dashboard.metric.observed" ? event.observedAt : event.occurredAt;
}

function isOlderThan(candidate: string, current: string | undefined): boolean {
  return current !== undefined && Date.parse(candidate) < Date.parse(current);
}

function applyMetricObservation(
  recovery: Extract<BackendRead<DashboardRecoveryResponse>, { status: "available" }>,
  event: Extract<DashboardEvent, { type: "dashboard.metric.observed" }>,
): { applied: boolean; recovery: BackendRead<DashboardRecoveryResponse> } {
  const current = recovery.data;
  if (event.metricName === "inventory.remaining") {
    if (!current.inventory || current.inventory.saleOfferId !== event.saleOfferId) {
      return { applied: false, recovery };
    }
    if (isOlderThan(event.observedAt, current.inventory.lastUpdatedAt)) {
      return { applied: false, recovery };
    }
    return {
      applied: true,
      recovery: {
        ...recovery,
        data: {
          ...current,
          inventory: { ...current.inventory, remainingStock: event.value, lastUpdatedAt: event.observedAt },
        },
      },
    };
  }
  if (event.metricName === "inventory.sold_out_rejection") {
    if (!current.inventory || current.inventory.saleOfferId !== event.saleOfferId) {
      return { applied: false, recovery };
    }
    if (isOlderThan(event.observedAt, current.inventory.lastUpdatedAt)) {
      return { applied: false, recovery };
    }
    return {
      applied: true,
      recovery: {
        ...recovery,
        data: {
          ...current,
          inventory: {
            ...current.inventory,
            soldOutPressure: { rejectionCount: event.value, latestObservedAt: event.observedAt },
            lastUpdatedAt: event.observedAt,
          },
        },
      },
    };
  }
  if (event.metricName === "queue.depth") {
    if (!current.queue || current.queue.name !== event.queueName) {
      return { applied: false, recovery };
    }
    if (isOlderThan(event.observedAt, current.queue.updatedAt)) {
      return { applied: false, recovery };
    }
    return {
      applied: true,
      recovery: {
        ...recovery,
        data: { ...current, queue: { ...current.queue, depth: event.value, updatedAt: event.observedAt } },
      },
    };
  }
  if (event.metricName === "order.consistency_lag") return { applied: false, recovery };
  return {
    applied: true,
    recovery: {
      ...recovery,
      data: {
        ...current,
        recentMetrics: [
          ...current.recentMetrics.slice(-19),
          { metricName: event.metricName, value: event.value, unit: event.unit, timestamp: event.observedAt },
        ],
      },
    },
  };
}

function isAfter(candidate: string, current: string): boolean {
  return Date.parse(candidate) > Date.parse(current);
}

type DashboardEventProjection =
  | "runLifecycle"
  | "inventory"
  | "queue"
  | "businessOutcome"
  | { metricName: string };

function dashboardEventProjection(event: DashboardEvent): DashboardEventProjection {
  switch (event.type) {
    case "load.run.updated":
      return "runLifecycle";
    case "business.outcome.snapshot":
      return "businessOutcome";
    case "dashboard.metric.observed":
      return { metricName: event.metricName };
    case "order.status.updated":
    case "business.event.recorded":
      return "businessOutcome";
  }
}

function projectionWatermark(
  watermarks: DashboardEventWatermarks,
  projection: DashboardEventProjection,
): string | null {
  if (typeof projection === "string") return watermarks[projection];
  return watermarks.metricByName[projection.metricName] ?? watermarks.metricBaseline;
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
    ...(projection.metricName.startsWith("inventory.") ? { inventory: occurredAt } : {}),
    ...(projection.metricName === "queue.depth" ? { queue: occurredAt } : {}),
    metricByName: {
      ...watermarks.metricByName,
      [projection.metricName]: occurredAt,
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
    metricBaseline: baseline,
    metricByName: {},
  };
}

export function shouldRequestAuthoritativeRecoveryAfterEvent(event: DashboardEvent): boolean {
  return event.type === "load.run.updated" && ["completed", "failed"].includes(event.run.status);
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
): event is RunDashboardEvent {
  if (event.type !== "load.run.updated") return false;
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
    case "load.run.updated":
      return event.run.saleOfferId ?? null;
    case "business.outcome.snapshot":
      return event.saleOfferId;
    case "order.status.updated":
      return event.saleOfferId;
    case "dashboard.metric.observed":
      return "saleOfferId" in event ? event.saleOfferId : null;
    case "business.event.recorded":
      return event.saleOfferId ?? null;
  }
}

function orderAdvisoryStateForRecovery(
  recovery: BackendRead<DashboardRecoveryResponse>,
): Pick<DashboardState, "recentOrderStates" | "recentOrderLagSamples" | "seenOrderEventIds"> {
  return {
    recentOrderStates:
      recovery.status === "available"
        ? newestOrderStates(recovery.data.recentCompletionOutcomes.flatMap((outcome) => {
            const occurredAt = recoveredOrderStatusOccurredAt(outcome);
            return occurredAt
              ? [{
                  orderId: outcome.orderId,
                  publicOrderId: outcome.publicOrderId,
                  status: outcome.orderStatus,
                  occurredAt,
                  correlationId: outcome.correlationId,
                }]
              : [];
          }))
        : [],
    recentOrderLagSamples: [],
    seenOrderEventIds: [],
  };
}

function recoveredOrderStatusOccurredAt(
  outcome: DashboardRecoveryResponse["recentCompletionOutcomes"][number],
): string | null {
  switch (outcome.orderStatus) {
    case "queued":
      return outcome.queuedAt;
    case "processing":
      // processingAt is optional in the recovery contract. queuedAt is a conservative fallback:
      // it cannot make an incomplete processing record appear newer than its actual transition.
      return outcome.processingAt ?? outcome.queuedAt;
    case "confirmed":
      return outcome.confirmedAt ?? null;
    case "failed":
      return outcome.failedAt ?? null;
  }
}

function applyOrderRealtimeEvent(state: DashboardState, event: DashboardEvent): DashboardState {
  if (event.type !== "order.status.updated" && !isOrderLagMetric(event)) return state;
  if (state.recovery.status !== "available" || classifyDashboardEventScope(state.recovery.data, event) !== "current") return state;
  if (state.seenOrderEventIds.includes(event.eventId)) return state;
  const seenOrderEventIds = [...state.seenOrderEventIds.slice(-99), event.eventId];
  if (isOrderLagMetric(event)) {
    const sample = { eventId: event.eventId, orderId: event.orderId, publicOrderId: event.publicOrderId, valueMs: event.value, observedAt: event.observedAt };
    return {
      ...state,
      seenOrderEventIds,
      recentOrderLagSamples: [...state.recentOrderLagSamples, sample]
        .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt) || left.eventId.localeCompare(right.eventId))
        .slice(-20),
    };
  }
  const existing = state.recentOrderStates.find((order) => order.orderId === event.orderId);
  if (existing && lifecycleRank(event.status) <= lifecycleRank(existing.status)) {
    return { ...state, seenOrderEventIds };
  }
  const next = {
    orderId: event.orderId,
    publicOrderId: event.publicOrderId,
    status: event.status,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
  };
  return {
    ...state,
    seenOrderEventIds,
    recentOrderStates: newestOrderStates([
      ...state.recentOrderStates.filter((order) => order.orderId !== event.orderId),
      next,
    ]),
  };
}

function newestOrderStates(states: RecentOrderState[]): RecentOrderState[] {
  return [...states]
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.orderId.localeCompare(right.orderId))
    .slice(-20);
}

function lifecycleRank(status: RecentOrderState["status"]): number {
  return status === "queued" ? 0 : status === "processing" ? 1 : 2;
}

function isRunDashboardEvent(event: DashboardEvent): event is RunDashboardEvent {
  return event.type === "load.run.updated";
}

function isOrderLagMetric(
  event: DashboardEvent,
): event is Extract<DashboardEvent, { type: "dashboard.metric.observed" }> & { metricName: "order.consistency_lag" } {
  return event.type === "dashboard.metric.observed" && event.metricName === "order.consistency_lag";
}

function recoveryForIncomingRun(
  recovery: Extract<BackendRead<DashboardRecoveryResponse>, { status: "available" }>,
  event: RunDashboardEvent,
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
