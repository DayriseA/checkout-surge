"use client";

import { type DashboardProjection, dashboardProjectionSchema } from "@checkout-surge/contracts";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BackendRead, CompletedBackendRead } from "../../lib/api";
import { readProxyJson } from "../../lib/client/proxy-json";
import { dashboardRecoveryProxyPath } from "../../lib/control-paths";
import {
  createDashboardProjectionState,
  type DashboardProjectionStateAction,
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
  const [state, dispatchState] = useReducer(
    dashboardProjectionStateReducer,
    initialRecovery,
    createDashboardProjectionState,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const requestRef = useRef<Promise<CompletedBackendRead<DashboardProjection>> | null>(null);
  const cancellationRef = useRef<Promise<true> | null>(null);
  const settleRequestRef = useRef<(() => void) | null>(null);
  const followUpRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(true);
  const realtimeDisconnectedRef = useRef(false);
  const hasLocalRecoveryActivityRef = useRef(false);
  const initialRecoveryIdentity = recoveryIdentity(initialRecovery);
  const initialRecoveryIdentityRef = useRef(initialRecoveryIdentity);
  const initialRecoveryRef = useRef(initialRecovery);
  initialRecoveryRef.current = initialRecovery;
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const recoveredResetIdentityRef = useRef<string | null>(null);
  // Reduce eagerly into the ref so a coalesced follow-up read starts from the
  // projection the previous read just accepted, even before React commits the render.
  const dispatch = useCallback((action: DashboardProjectionStateAction) => {
    stateRef.current = dashboardProjectionStateReducer(stateRef.current, action);
    dispatchState(action);
  }, []);
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

  const startRecoveryRequest = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    hasLocalRecoveryActivityRef.current = true;
    retrySchedulerRef.current?.cancel();
    reconcileSchedulerRef.current?.cancel();
    dispatch({ type: "refresh-started" });
    let completedRecovery: CompletedBackendRead<DashboardProjection> | null = null;
    const request = readProxyJson(
      recoveryPath(stateRef.current.acceptedProjection),
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
  }, [options.preserveAvailableRecoveryOnFailure, dispatch]);

  // Global freshness contract: while mounted, every caller awaits a recovery attempt
  // started after that call; an already-running read cannot satisfy it. At most one
  // request is in flight plus one pending batch — callers arriving during a request
  // share the single queued follow-up, which starts one fresh request once the
  // in-flight read settles. Callers arriving during the follow-up require a later
  // request. A queued caller resolves after its qualifying attempt even if that
  // attempt fails; further automatic retries stay with the existing schedulers.
  const performRecovery = useCallback(
    async function runRecovery(): Promise<void> {
      if (!mountedRef.current) return;
      const cancelled = cancellationRef.current;
      if (requestRef.current === null) {
        await Promise.race([startRecoveryRequest(), cancelled]);
        return;
      }
      if (followUpRef.current === null) {
        followUpRef.current = (async () => {
          while (requestRef.current !== null) {
            if ((await Promise.race([requestRef.current, cancelled])) === true) return;
            if (cancellationRef.current !== cancelled) return;
          }
          followUpRef.current = null;
          if (!mountedRef.current) return;
          await Promise.race([startRecoveryRequest(), cancelled]);
        })();
      }
      await followUpRef.current;
    },
    [startRecoveryRequest],
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
    [state, dispatch],
  );

  useEffect(() => {
    mountedRef.current = true;
    // Cancel callers, not the read: effect replay must still accept its response.
    cancellationRef.current = new Promise<true>((resolve) => {
      settleRequestRef.current = () => resolve(true);
    });
    return () => {
      mountedRef.current = false;
      settleRequestRef.current?.();
      settleRequestRef.current = null;
      followUpRef.current = null;
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
  }, [initialRecoveryIdentity, dispatch]);

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
