import type { DashboardProjection } from "@checkout-surge/contracts";
import type { BackendRead } from "./api";

type UnavailableProjectionRead = Extract<
  BackendRead<DashboardProjection>,
  { status: "unavailable" }
>;

export interface DashboardProjectionState {
  recovery: BackendRead<DashboardProjection>;
  acceptedProjection: DashboardProjection | null;
  latestRunStartedAt: string | null;
  syncIssue: UnavailableProjectionRead | null;
  isRefreshing: boolean;
  liveProjectionCount: number;
}

export type DashboardProjectionStateAction =
  | { type: "initial-read-received"; recovery: BackendRead<DashboardProjection> }
  | { type: "refresh-started" }
  | {
      type: "refresh-completed";
      recovery: BackendRead<DashboardProjection>;
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
    latestRunStartedAt: acceptedProjection?.currentRun?.startedAt ?? null,
    syncIssue: null,
    isRefreshing: false,
    liveProjectionCount: 0,
  };
}

export function dashboardProjectionStateReducer(
  state: DashboardProjectionState,
  action: DashboardProjectionStateAction,
): DashboardProjectionState {
  switch (action.type) {
    case "initial-read-received":
      return createDashboardProjectionState(action.recovery);
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
    latestRunStartedAt: candidate.currentRun?.startedAt ?? state.latestRunStartedAt,
    syncIssue: null,
    isRefreshing: false,
    liveProjectionCount: state.liveProjectionCount + (live ? 1 : 0),
  };
}

function isTerminal(status: NonNullable<DashboardProjection["currentRun"]>["status"]): boolean {
  return status === "completed" || status === "failed";
}
