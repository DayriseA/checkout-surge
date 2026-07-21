import type {
  DashboardEvent,
  DashboardRecoveryResponse,
  DemoRunSnapshot,
  RunDashboardEvent,
} from "@checkout-surge/contracts";
import type { BackendRead } from "./api";

export interface DashboardState {
  recovery: BackendRead<DashboardRecoveryResponse>;
  syncIssue: Extract<BackendRead<DashboardRecoveryResponse>, { status: "unavailable" }> | null;
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
  | {
      type: "refresh-completed";
      recovery: BackendRead<DashboardRecoveryResponse>;
      preserveAvailableRecoveryOnFailure?: boolean;
    }
  | { type: "event-received"; event: DashboardEvent; discard: boolean }
  | { type: "buffered-events-reconciled"; events: DashboardEvent[] };

export function createDashboardState(
  recovery: BackendRead<DashboardRecoveryResponse>,
): DashboardState {
  return {
    recovery,
    syncIssue: recovery.status === "unavailable" ? recovery : null,
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
      if (
        action.recovery.status === "unavailable" &&
        action.preserveAvailableRecoveryOnFailure &&
        state.recovery.status === "available"
      ) {
        return {
          ...state,
          syncIssue: action.recovery,
          isRefreshing: false,
        };
      }
      return {
        ...state,
        recovery: action.recovery,
        syncIssue: action.recovery.status === "unavailable" ? action.recovery : null,
        isRefreshing: false,
        eventWatermarks: eventWatermarksForRecovery(action.recovery),
        ...orderAdvisoryStateForRecovery(action.recovery),
      };
    case "event-received":
      return action.discard || state.isRefreshing
        ? { ...state, liveEventCount: state.liveEventCount + 1 }
        : applyDashboardEventToState(state, action.event);
    case "buffered-events-reconciled":
      return action.events.reduce((nextState, event) => {
        const liveEventCount = nextState.liveEventCount;
        return { ...applyDashboardEventToState(nextState, event), liveEventCount };
      }, state);
  }
}

const maximumBufferedOrderEvents = 20;
const maximumBufferedOrderLagEvents = 20;
const maximumBufferedRunEvents = 2;

/**
 * Coalesces live hints that race an authoritative read. The limits mirror the
 * reducer's visible order/lag windows, while replacement projections retain
 * only their newest pending value.
 */
export function bufferDashboardEvent(
  events: DashboardEvent[],
  event: DashboardEvent,
): DashboardEvent[] {
  if (event.type === "business.event.recorded") return events;

  const key = bufferedEventKey(event);
  const nextEvents = events.filter((candidate) => bufferedEventKey(candidate) !== key);
  nextEvents.push(event);

  const category = bufferedEventCategory(event);
  const limit =
    category === "order"
      ? maximumBufferedOrderEvents
      : category === "order-lag"
        ? maximumBufferedOrderLagEvents
        : category === "run"
          ? maximumBufferedRunEvents
          : null;
  if (limit === null) return nextEvents;

  const categoryEvents = nextEvents.filter(
    (candidate) => bufferedEventCategory(candidate) === category,
  );
  const retained = new Set(categoryEvents.slice(-limit));
  return nextEvents.filter(
    (candidate) => bufferedEventCategory(candidate) !== category || retained.has(candidate),
  );
}

export function bufferedEventsRequireAuthoritativeRecovery(
  recovery: BackendRead<DashboardRecoveryResponse>,
  events: DashboardEvent[],
): boolean {
  let reconciledRecovery = recovery;
  let recoveryRequired = false;

  for (const event of events) {
    recoveryRequired ||= shouldRequestAuthoritativeRecoveryAfterScopedEvent(
      reconciledRecovery,
      event,
    );
    reconciledRecovery = applyDashboardEvent(reconciledRecovery, event);
  }

  return recoveryRequired;
}

function bufferedEventKey(event: DashboardEvent): string {
  switch (event.type) {
    case "load.run.updated":
      return isTerminalRunStatus(event.run.status)
        ? `run-terminal:${event.run.runId}`
        : `run-scope:${event.run.runId}`;
    case "dashboard.metric.observed":
      return event.metricName === "order.consistency_lag"
        ? `order-lag:${event.eventId}`
        : `metric:${event.metricName}`;
    case "business.outcome.snapshot":
      return "business-outcome";
    case "order.status.updated":
      return `order:${event.orderId}`;
    case "business.event.recorded":
      return `business-event:${event.eventId}`;
  }
}

function bufferedEventCategory(
  event: DashboardEvent,
): "projection" | "run" | "order" | "order-lag" | "business-event" {
  if (event.type === "load.run.updated") return "run";
  if (event.type === "order.status.updated") return "order";
  if (isOrderLagMetric(event)) return "order-lag";
  if (event.type === "business.event.recorded") return "business-event";
  return "projection";
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

  if (event.type === "load.run.updated") {
    return applyRunLifecycleEvent(recovery, eventWatermarks, event);
  }

  const projection = dashboardEventProjection(event);
  const watermark = projectionWatermark(eventWatermarks, projection);
  const projectionObservedAt = dashboardEventObservedAt(event);
  if (watermark !== null && !isAfter(projectionObservedAt, watermark)) {
    return { recovery, eventWatermarks };
  }

  let nextRecovery: BackendRead<DashboardRecoveryResponse>;

  switch (event.type) {
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

function applyRunLifecycleEvent(
  recovery: Extract<BackendRead<DashboardRecoveryResponse>, { status: "available" }>,
  eventWatermarks: DashboardEventWatermarks,
  event: RunDashboardEvent,
): { recovery: BackendRead<DashboardRecoveryResponse>; eventWatermarks: DashboardEventWatermarks } {
  const currentRun = recovery.data.currentRun;
  // Lifecycle monotonicity is enforced by rank, not by the generic envelope
  // timestamp: a later-delivered nonterminal event must never regress an
  // already terminal run, and the two terminal states share one rank so
  // delivery order cannot switch between them.
  if (currentRun && runLifecycleRank(event.run.status) <= runLifecycleRank(currentRun.status)) {
    return { recovery, eventWatermarks };
  }
  return {
    recovery: {
      ...recovery,
      data: { ...recovery.data, currentRun: event.run },
    },
    eventWatermarks: advanceProjectionWatermark(
      eventWatermarks,
      "runLifecycle",
      durableRunLifecycleTimestamp(event.run) ?? event.occurredAt,
    ),
  };
}

type DemoRunLifecycleStatus = DemoRunSnapshot["status"];

function runLifecycleRank(status: DemoRunLifecycleStatus): number {
  switch (status) {
    case "starting":
      return 0;
    case "active":
      return 1;
    case "draining":
      return 2;
    case "completed":
    case "failed":
      return 3;
  }
}

function isTerminalRunStatus(status: DemoRunLifecycleStatus): boolean {
  return status === "completed" || status === "failed";
}

function durableRunLifecycleTimestamp(run: DemoRunSnapshot | null | undefined): string | null {
  if (!run) return null;
  switch (run.status) {
    case "starting":
      return run.startedAt;
    case "active":
      return run.trafficStartedAt;
    case "draining":
      return run.trafficEndedAt;
    case "completed":
    case "failed":
      return run.finalizedAt;
  }
}

function isMatchingTerminalRunSignal(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): event is RunDashboardEvent {
  if (!isRunDashboardEvent(event)) return false;
  if (event.runId !== undefined && event.runId !== event.run.runId) return false;
  if (!isTerminalRunStatus(event.run.status)) return false;
  const currentRun = recovery.currentRun;
  if (!currentRun || isTerminalRunStatus(currentRun.status)) return false;
  if (event.run.runId !== currentRun.runId) return false;
  if ((event.run.saleOfferId ?? null) !== (currentRun.saleOfferId ?? null)) return false;
  return runLifecycleRank(event.run.status) > runLifecycleRank(currentRun.status);
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
          inventory: {
            ...current.inventory,
            remainingStock: event.value,
            lastUpdatedAt: event.observedAt,
          },
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
        data: {
          ...current,
          queue: { ...current.queue, depth: event.value, updatedAt: event.observedAt },
        },
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
          {
            metricName: event.metricName,
            value: event.value,
            unit: event.unit,
            timestamp: event.observedAt,
          },
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
  // The run-lifecycle watermark comes from the durable transition timestamp of
  // the recovered run snapshot, not from the generic recovery-start time: a
  // recovery can read a still-draining run after finalization work has already
  // begun, so recoveredAt must not mask a later-committed terminal transition.
  const runLifecycleBaseline =
    recovery.status === "available"
      ? (durableRunLifecycleTimestamp(recovery.data.currentRun) ?? baseline)
      : null;
  return {
    runLifecycle: runLifecycleBaseline,
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
  if (eventScope === "rejected") {
    return isIdleRunHintBlockedByRecoveryWatermark(recovery.data, event);
  }
  if (eventScope === "new-run") return true;
  // Only a terminal signal that matches the recovered run and actually advances
  // its lifecycle justifies authoritative recovery; duplicate terminal events
  // for an already terminal (or idle) client must not start a recovery loop.
  return isMatchingTerminalRunSignal(recovery.data, event);
}

function isIdleRunHintBlockedByRecoveryWatermark(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): event is RunDashboardEvent {
  if (!isRunDashboardEvent(event) || recovery.currentRun !== null) return false;
  if (event.runId !== event.run.runId || isTerminalRunStatus(event.run.status)) return false;
  return Date.parse(event.occurredAt) < Date.parse(recovery.recoveredAt);
}

function classifyDashboardEventScope(
  recovery: DashboardRecoveryResponse,
  event: DashboardEvent,
): "rejected" | "current" | "new-run" {
  if (isRunDashboardEvent(event) && event.runId !== undefined && event.runId !== event.run.runId) {
    return "rejected";
  }
  // A matching terminal lifecycle signal committed after a stale recovery read
  // must not be masked by the generic recovery-start watermark.
  if (isMatchingTerminalRunSignal(recovery, event)) return "current";
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
        ? newestOrderStates(
            recovery.data.recentCompletionOutcomes.flatMap((outcome) => {
              const occurredAt = recoveredOrderStatusOccurredAt(outcome);
              return occurredAt
                ? [
                    {
                      orderId: outcome.orderId,
                      publicOrderId: outcome.publicOrderId,
                      status: outcome.orderStatus,
                      occurredAt,
                      correlationId: outcome.correlationId,
                    },
                  ]
                : [];
            }),
          )
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
      return outcome.processingAt;
    case "confirmed":
      return outcome.confirmedAt;
    case "failed":
      return outcome.failedAt;
  }
}

function applyOrderRealtimeEvent(state: DashboardState, event: DashboardEvent): DashboardState {
  if (event.type !== "order.status.updated" && !isOrderLagMetric(event)) return state;
  if (
    state.recovery.status !== "available" ||
    classifyDashboardEventScope(state.recovery.data, event) !== "current"
  )
    return state;
  if (state.seenOrderEventIds.includes(event.eventId)) return state;
  const seenOrderEventIds = [...state.seenOrderEventIds.slice(-99), event.eventId];
  if (isOrderLagMetric(event)) {
    const sample = {
      eventId: event.eventId,
      orderId: event.orderId,
      publicOrderId: event.publicOrderId,
      valueMs: event.value,
      observedAt: event.observedAt,
    };
    return {
      ...state,
      seenOrderEventIds,
      recentOrderLagSamples: [...state.recentOrderLagSamples, sample]
        .sort(
          (left, right) =>
            Date.parse(left.observedAt) - Date.parse(right.observedAt) ||
            left.eventId.localeCompare(right.eventId),
        )
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
    .sort(
      (left, right) =>
        Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
        left.orderId.localeCompare(right.orderId),
    )
    .slice(-20);
}

function lifecycleRank(status: RecentOrderState["status"]): number {
  return status === "queued" ? 0 : status === "processing" ? 1 : 2;
}

function isRunDashboardEvent(event: DashboardEvent): event is RunDashboardEvent {
  return event.type === "load.run.updated";
}

function isOrderLagMetric(event: DashboardEvent): event is Extract<
  DashboardEvent,
  { type: "dashboard.metric.observed" }
> & {
  metricName: "order.consistency_lag";
} {
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
      transportAccounting: null,
      recentCompletionOutcomes: [],
      recoveredAt: event.occurredAt,
    },
  };
}
