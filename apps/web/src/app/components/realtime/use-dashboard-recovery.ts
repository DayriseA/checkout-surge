"use client";

import { type DashboardProjection, dashboardProjectionSchema } from "@checkout-surge/contracts";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BackendRead, CompletedBackendRead } from "../../lib/api";
import { readProxyJson } from "../../lib/client/proxy-json";
import { dashboardRecoveryProxyPath } from "../../lib/control-paths";
import {
  createDashboardProjectionState,
  dashboardProjectionStateReducer,
  shouldAcceptDashboardProjection,
} from "../../lib/dashboard-projection-state";
import {
  createDashboardRecoveryRetryScheduler,
  type DashboardRecoveryRetryState,
} from "./dashboard-recovery-retry";

const noScheduledRetry: DashboardRecoveryRetryState = {
  attempt: 0,
  delayMs: null,
  exhausted: false,
  scheduled: false,
};

export function useDashboardRecovery(
  initialRecovery: BackendRead<DashboardProjection>,
  options: { preserveAvailableRecoveryOnFailure?: boolean } = {},
) {
  const [state, dispatch] = useReducer(
    dashboardProjectionStateReducer,
    initialRecovery,
    createDashboardProjectionState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef<Promise<CompletedBackendRead<DashboardProjection>> | null>(null);
  const acceptedProjectionRef = useRef(state.acceptedProjection);
  acceptedProjectionRef.current = state.acceptedProjection;
  const mountedRef = useRef(true);
  const realtimeDisconnectedRef = useRef(false);
  const hasLocalRecoveryActivityRef = useRef(false);
  const initialRecoveryIdentity = recoveryIdentity(initialRecovery);
  const initialRecoveryIdentityRef = useRef(initialRecoveryIdentity);
  const initialRecoveryRef = useRef(initialRecovery);
  initialRecoveryRef.current = initialRecovery;
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const recoveredResetIdentityRef = useRef<string | null>(null);
  const [retryState, setRetryState] = useState(noScheduledRetry);
  const retrySchedulerRef = useRef<ReturnType<typeof createDashboardRecoveryRetryScheduler> | null>(
    null,
  );
  if (retrySchedulerRef.current === null) {
    retrySchedulerRef.current = createDashboardRecoveryRetryScheduler({
      onRetry: () => void refreshRef.current(),
      onStateChange: (nextState) => {
        if (mountedRef.current) setRetryState(nextState);
      },
    });
  }
  const reconcileSchedulerRef = useRef<ReturnType<
    typeof createDashboardRecoveryRetryScheduler
  > | null>(null);
  if (reconcileSchedulerRef.current === null) {
    reconcileSchedulerRef.current = createDashboardRecoveryRetryScheduler({
      onRetry: () => void refreshRef.current(),
    });
  }

  const performRecovery = useCallback(
    async function runRecovery(): Promise<void> {
      if (!mountedRef.current) return;
      if (requestRef.current) {
        await requestRef.current;
        return;
      }

      hasLocalRecoveryActivityRef.current = true;
      retrySchedulerRef.current?.cancel();
      reconcileSchedulerRef.current?.cancel();
      dispatch({ type: "refresh-started" });
      let completedRecovery: CompletedBackendRead<DashboardProjection> | null = null;
      const request = readProxyJson(
        recoveryPath(acceptedProjectionRef.current),
        dashboardProjectionSchema,
      ).catch(
        (error: unknown): CompletedBackendRead<DashboardProjection> => ({
          status: "unavailable",
          reason: error instanceof Error ? error.message : "Dashboard recovery request failed.",
        }),
      );
      requestRef.current = request;

      try {
        completedRecovery = await request;
        if (!mountedRef.current) return;
        dispatch({
          type: "refresh-completed",
          recovery: completedRecovery,
          preserveAvailableRecoveryOnFailure: options.preserveAvailableRecoveryOnFailure === true,
        });
        if (completedRecovery.status === "available") {
          retrySchedulerRef.current?.reset();
          reconcileSchedulerRef.current?.reset();
          const acceptedProjection = shouldAcceptDashboardProjection(
            stateRef.current,
            completedRecovery.data,
          )
            ? completedRecovery.data
            : stateRef.current.acceptedProjection;
          if (
            realtimeDisconnectedRef.current &&
            requiresDisconnectedReconciliation(acceptedProjection)
          ) {
            reconcileSchedulerRef.current?.schedule(2_000);
          }
        } else if (completedRecovery.status === "unavailable") {
          retrySchedulerRef.current?.schedule(completedRecovery.retryAfterMs);
        }
      } finally {
        requestRef.current = null;
      }
    },
    [options.preserveAvailableRecoveryOnFailure],
  );

  const refresh = useCallback(() => performRecovery(), [performRecovery]);
  refreshRef.current = refresh;

  const applyProjection = useCallback(
    (projection: DashboardProjection) => {
      if (shouldAcceptDashboardProjection(state, projection)) {
        hasLocalRecoveryActivityRef.current = true;
        retrySchedulerRef.current?.reset();
      } else if (projection.resetRecoveryRunId) {
        // A foreign terminal cannot establish a live scope. Recover global reset
        // state/result identity through the ordinary single-flight read instead,
        // once per reset identity and never ahead of a scheduled retry backoff.
        const resetIdentity = `${projection.resetRecovery}:${projection.resetRecoveryRunId}`;
        if (
          resetIdentity !== recoveredResetIdentityRef.current &&
          retrySchedulerRef.current?.state().scheduled !== true
        ) {
          recoveredResetIdentityRef.current = resetIdentity;
          void refreshRef.current();
        }
      }
      dispatch({ type: "live-projection-received", projection });
    },
    [state],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      retrySchedulerRef.current?.reset();
      reconcileSchedulerRef.current?.reset();
    };
  }, []);

  useEffect(() => {
    if (!hasLocalRecoveryActivityRef.current) {
      const nextRecovery = initialRecoveryRef.current;
      if (initialRecoveryIdentityRef.current !== initialRecoveryIdentity) {
        initialRecoveryIdentityRef.current = initialRecoveryIdentity;
        dispatch({ type: "initial-read-received", recovery: nextRecovery });
      }
      if (nextRecovery.status === "loading") {
        void refreshRef.current();
      } else if (nextRecovery.status === "unavailable") {
        retrySchedulerRef.current?.schedule(nextRecovery.retryAfterMs);
      } else {
        retrySchedulerRef.current?.reset();
      }
    }
  }, [initialRecoveryIdentity]);

  const retryNow = useCallback(async (): Promise<void> => {
    retrySchedulerRef.current?.reset();
    await refresh();
  }, [refresh]);
  const notifyRealtimeDisconnected = useCallback(async (): Promise<void> => {
    realtimeDisconnectedRef.current = true;
    await refresh();
  }, [refresh]);
  const notifyRealtimeReopened = useCallback((): void => {
    realtimeDisconnectedRef.current = false;
    reconcileSchedulerRef.current?.reset();
  }, []);
  const hasInitialRetryWait =
    !hasLocalRecoveryActivityRef.current &&
    initialRecovery.status === "unavailable" &&
    initialRecovery.retryAfterMs !== undefined;
  const retryAfterLive =
    hasInitialRetryWait || retrySchedulerRef.current?.state().scheduled === true;
  const recovery = withLiveRetryAfter(state.recovery, retryAfterLive);
  const syncIssue = state.syncIssue ? withLiveRetryAfter(state.syncIssue, retryAfterLive) : null;

  return {
    recovery,
    isRefreshing: state.isRefreshing,
    isRetryScheduled: retryState.scheduled,
    retryAttempt: retryState.attempt,
    retryDelayMs: retryState.delayMs,
    retriesExhausted: retryState.exhausted,
    syncIssue,
    hasSyncIssue: state.syncIssue !== null,
    signalSamples: state.signalSamples,
    retainedTerminalRun: state.retainedTerminalRun,
    refresh,
    retryNow,
    notifyRealtimeDisconnected,
    notifyRealtimeReopened,
    applyProjection,
  };
}

function requiresDisconnectedReconciliation(projection: DashboardProjection | null): boolean {
  const status = projection?.currentRun?.status;
  return status !== undefined && status !== "completed" && status !== "failed";
}

function withLiveRetryAfter<T extends BackendRead<unknown>>(read: T, retryScheduled: boolean): T {
  if (retryScheduled || read.status !== "unavailable" || read.retryAfterMs === undefined) {
    return read;
  }
  const { retryAfterMs: _expiredRetryAfterMs, ...withoutRetryAfter } = read;
  return withoutRetryAfter as T;
}

function recoveryIdentity(recovery: BackendRead<DashboardProjection>): string {
  if (recovery.status === "available") {
    return `${recovery.data.scopeId}:${recovery.data.revision}`;
  }
  if (recovery.status === "loading") return "loading";
  return `unavailable:${recovery.httpStatus ?? "none"}:${recovery.reason}`;
}

function recoveryPath(projection: DashboardProjection | null): string {
  if (projection === null || projection.scope === null) return dashboardRecoveryProxyPath;
  const query = new URLSearchParams({
    knownRunId: projection.scope.runId,
    knownSaleOfferId: projection.scope.saleOfferId,
  });
  return `${dashboardRecoveryProxyPath}?${query.toString()}`;
}
