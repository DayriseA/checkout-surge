import {
  type AcceptedRunConfigSnapshot,
  arrivalRateSeriesLimit,
  type DashboardProjection,
  hasObservedRequestArrivals,
  liveTrafficMetricWindowSeconds,
} from "@checkout-surge/contracts";
import type { BackendRead, CompletedBackendRead } from "./api";

type UnavailableProjectionRead = Extract<
  BackendRead<DashboardProjection>,
  { status: "unavailable" }
>;

export interface DashboardProjectionState {
  recovery: BackendRead<DashboardProjection>;
  acceptedProjection: DashboardProjection | null;
  retainedTerminalRun: RetainedTerminalRun | null;
  latestRunStartedAt: string | null;
  syncIssue: UnavailableProjectionRead | null;
  isRefreshing: boolean;
  signalSamples: RunSignalLiveSample[];
}

export interface RetainedTerminalRun {
  runId: string;
  configSnapshot: AcceptedRunConfigSnapshot;
  terminalRecap: DashboardProjection;
}

export interface RunSignalLiveSample {
  recoveredAt: string;
  arrivalRatePerSecond: number | null;
  remainingStock: number | null;
  queueBacklog: number | null;
  confirmedOrderCount: number;
  settledOrderCount: number;
  failedOrderCount: number;
  pendingOrderCount: number;
}

export interface RequestSurgeProjection {
  arrivalRatePerSecond: number | null;
  arrivalRateIsPeak: boolean;
  arrivalWindowSeconds: number;
  responseCompletionRatePerSecond: number | null;
  attemptsDispatched: number | null;
  dispatchDurationSeconds: number | null;
  arrivalRateSeries: Array<{ windowStartedAt: string; ratePerSecond: number }>;
}

export function projectRequestSurge(projection: DashboardProjection): RequestSurgeProjection {
  // An arrival summary whose generator observed nothing carries zeros for a measurement it never
  // took, so it cannot stand in as terminal arrival evidence.
  const terminal =
    projection.requestArrivalSummary && hasObservedRequestArrivals(projection.requestArrivalSummary)
      ? projection.requestArrivalSummary
      : null;
  const liveArrival = findLatestMetric(
    projection,
    "traffic.request_arrival_rate",
    "requests_per_second",
  );
  const responseCompletion = findLatestMetric(
    projection,
    "traffic.response_completion_rate",
    "requests_per_second",
  );
  const dispatchProgress = findLatestMetric(projection, "traffic.attempts_dispatched", "requests");

  return {
    arrivalRatePerSecond: terminal?.peakArrivalRatePerSecond ?? liveArrival?.value ?? null,
    arrivalRateIsPeak: terminal !== null,
    // Live samples use the producer's shared aligned event-time window. Terminal summaries carry
    // their own explicit metadata and take precedence when present.
    arrivalWindowSeconds: terminal?.peakArrivalWindowSeconds ?? liveTrafficMetricWindowSeconds,
    responseCompletionRatePerSecond: responseCompletion?.value ?? null,
    attemptsDispatched:
      projection.transportAttemptCounts?.startedRequests ?? dispatchProgress?.value ?? null,
    dispatchDurationSeconds: terminal?.dispatchDurationSeconds ?? null,
    arrivalRateSeries:
      terminal?.arrivalRateSeries ??
      projection.recentMetrics
        .filter(
          (sample) =>
            sample.metricName === "traffic.request_arrival_rate" &&
            sample.unit === "requests_per_second",
        )
        .map((sample) => ({
          windowStartedAt: sample.timestamp,
          ratePerSecond: sample.value,
        })),
  };
}

export type DashboardProjectionStateAction =
  | { type: "initial-read-received"; recovery: BackendRead<DashboardProjection> }
  | { type: "refresh-started" }
  | {
      type: "refresh-completed";
      recovery: CompletedBackendRead<DashboardProjection>;
      preserveAvailableRecoveryOnFailure: boolean;
    }
  | { type: "live-projection-received"; projection: DashboardProjection };

export function createDashboardProjectionState(
  recovery: BackendRead<DashboardProjection>,
): DashboardProjectionState {
  const acceptedProjection = recovery.status === "available" ? recovery.data : null;
  return {
    recovery,
    acceptedProjection,
    retainedTerminalRun: acceptedProjection ? terminalRunFrom(acceptedProjection) : null,
    latestRunStartedAt: acceptedProjection?.currentRun?.startedAt ?? null,
    syncIssue: null,
    isRefreshing: false,
    signalSamples: acceptedProjection?.scope ? [toRunSignalLiveSample(acceptedProjection)] : [],
  };
}

export function dashboardProjectionStateReducer(
  state: DashboardProjectionState,
  action: DashboardProjectionStateAction,
): DashboardProjectionState {
  switch (action.type) {
    case "initial-read-received":
      return retainTerminalAcrossIdleRead(state, createDashboardProjectionState(action.recovery));
    case "refresh-started":
      return { ...state, isRefreshing: true };
    case "refresh-completed":
      if (action.recovery.status === "available") {
        return acceptProjection(state, action.recovery.data, false);
      }
      if (action.preserveAvailableRecoveryOnFailure && state.acceptedProjection !== null) {
        return {
          ...state,
          recovery: { status: "available", data: state.acceptedProjection, httpStatus: 200 },
          syncIssue: action.recovery,
          isRefreshing: false,
        };
      }
      return {
        ...state,
        recovery: action.recovery,
        syncIssue: null,
        isRefreshing: false,
      };
    case "live-projection-received":
      return acceptProjection(state, action.projection, true);
  }
}

export function shouldAcceptDashboardProjection(
  state: Pick<DashboardProjectionState, "acceptedProjection" | "latestRunStartedAt">,
  candidate: DashboardProjection,
): boolean {
  const current = state.acceptedProjection;
  if (current === null) {
    return candidate.currentRun === null || !isTerminal(candidate.currentRun.status);
  }

  if (candidate.scopeId === current.scopeId) {
    return candidate.revision > current.revision;
  }

  if (candidate.currentRun === null) {
    return Date.parse(candidate.recoveredAt) > Date.parse(current.recoveredAt);
  }

  if (isTerminal(candidate.currentRun.status)) {
    return false;
  }

  if (current.currentRun === null) {
    if (
      state.latestRunStartedAt !== null &&
      Date.parse(candidate.currentRun.startedAt) <= Date.parse(state.latestRunStartedAt)
    ) {
      return false;
    }
    return Date.parse(candidate.recoveredAt) > Date.parse(current.recoveredAt);
  }

  const latestRunStartedAt = state.latestRunStartedAt ?? current.currentRun.startedAt;
  return Date.parse(candidate.currentRun.startedAt) > Date.parse(latestRunStartedAt);
}

function acceptProjection(
  state: DashboardProjectionState,
  candidate: DashboardProjection,
  live: boolean,
): DashboardProjectionState {
  if (!shouldAcceptDashboardProjection(state, candidate)) {
    return live ? state : { ...state, isRefreshing: false };
  }

  return {
    ...state,
    recovery: { status: "available", data: candidate, httpStatus: 200 },
    acceptedProjection: candidate,
    retainedTerminalRun:
      candidate.currentRun === null ? state.retainedTerminalRun : terminalRunFrom(candidate),
    latestRunStartedAt: candidate.currentRun?.startedAt ?? state.latestRunStartedAt,
    syncIssue: null,
    isRefreshing: false,
    signalSamples: appendSignalSample(state, candidate),
  };
}

function retainTerminalAcrossIdleRead(
  previous: DashboardProjectionState,
  next: DashboardProjectionState,
): DashboardProjectionState {
  return next.acceptedProjection?.currentRun === null && previous.retainedTerminalRun
    ? { ...next, retainedTerminalRun: previous.retainedTerminalRun }
    : next;
}

function terminalRunFrom(projection: DashboardProjection): RetainedTerminalRun | null {
  const run = projection.currentRun;
  return run && isTerminal(run.status)
    ? {
        runId: run.runId,
        configSnapshot: run.configSnapshot,
        terminalRecap: projection,
      }
    : null;
}

function appendSignalSample(
  state: DashboardProjectionState,
  candidate: DashboardProjection,
): RunSignalLiveSample[] {
  if (candidate.scope === null) return [];
  const retained =
    state.acceptedProjection?.scopeId === candidate.scopeId ? state.signalSamples : [];
  return [...retained, toRunSignalLiveSample(candidate)].slice(-arrivalRateSeriesLimit);
}

function toRunSignalLiveSample(projection: DashboardProjection): RunSignalLiveSample {
  const outcome = projection.businessOutcome;
  const pendingOrderCount = outcome ? outcome.queuedOrders + outcome.processingOrders : 0;
  return {
    recoveredAt: projection.recoveredAt,
    arrivalRatePerSecond:
      findLatestMetric(projection, "traffic.request_arrival_rate", "requests_per_second")?.value ??
      null,
    remainingStock: projection.inventory?.remainingStock ?? null,
    queueBacklog: outcome?.queuedOrders ?? null,
    confirmedOrderCount: outcome?.confirmedOrders ?? 0,
    settledOrderCount: (outcome?.confirmedOrders ?? 0) + (outcome?.failedOrders ?? 0),
    failedOrderCount: outcome?.failedOrders ?? 0,
    pendingOrderCount,
  };
}

function isTerminal(status: NonNullable<DashboardProjection["currentRun"]>["status"]): boolean {
  return status === "completed" || status === "failed";
}

function findLatestMetric(
  projection: DashboardProjection,
  metricName: string,
  unit: string,
): DashboardProjection["recentMetrics"][number] | null {
  for (let index = projection.recentMetrics.length - 1; index >= 0; index -= 1) {
    const sample = projection.recentMetrics[index];
    if (sample?.metricName === metricName && sample.unit === unit) return sample;
  }
  return null;
}
