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
  const requestRef = useRef<Promise<CompletedBackendRead<DashboardProjection>> | null>(null);
  const acceptedProjectionRef = useRef(state.acceptedProjection);
  acceptedProjectionRef.current = state.acceptedProjection;
  const mountedRef = useRef(true);
  const hasLocalRecoveryActivityRef = useRef(false);
  const initialRecoveryIdentity = recoveryIdentity(initialRecovery);
  const initialRecoveryIdentityRef = useRef(initialRecoveryIdentity);
  const initialRecoveryRef = useRef(initialRecovery);
  initialRecoveryRef.current = initialRecovery;
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
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

  const performRecovery = useCallback(
    async function runRecovery(): Promise<void> {
      if (!mountedRef.current) return;
      if (requestRef.current) {
        await requestRef.current;
        return;
      }

      hasLocalRecoveryActivityRef.current = true;
      retrySchedulerRef.current?.cancel();
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

  return {
    recovery: state.recovery,
    isRefreshing: state.isRefreshing,
    isRetryScheduled: retryState.scheduled,
    retryAttempt: retryState.attempt,
    retryDelayMs: retryState.delayMs,
    retriesExhausted: retryState.exhausted,
    syncIssue: state.syncIssue,
    hasSyncIssue: state.syncIssue !== null,
    liveProjectionCount: state.liveProjectionCount,
    signalSamples: state.signalSamples,
    refresh,
    retryNow,
    applyProjection,
  };
}

function recoveryIdentity(recovery: BackendRead<DashboardProjection>): string {
  if (recovery.status === "available") {
    return `${recovery.data.scopeId}:${recovery.data.revision}`;
  }
  if (recovery.status === "loading") return "loading";
  return `unavailable:${recovery.httpStatus ?? "none"}:${recovery.reason}`;
}

function recoveryPath(projection: DashboardProjection | null): string {
  if (projection?.scope === null || projection === null) return dashboardRecoveryProxyPath;
  const query = new URLSearchParams({
    knownRunId: projection.scope.runId,
    knownSaleOfferId: projection.scope.saleOfferId,
  });
  return `${dashboardRecoveryProxyPath}?${query.toString()}`;
}
