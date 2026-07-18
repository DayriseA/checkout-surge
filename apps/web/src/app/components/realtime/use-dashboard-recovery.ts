"use client";

import {
  type DashboardEvent,
  type DashboardRecoveryResponse,
  dashboardRecoveryResponseSchema,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { BackendRead } from "../../lib/api";
import { readProxyJson } from "../../lib/client/proxy-json";
import { dashboardRecoveryProxyPath } from "../../lib/control-paths";
import {
  createDashboardState,
  dashboardStateReducer,
  shouldRequestAuthoritativeRecoveryAfterScopedEvent,
} from "../../lib/dashboard-state";
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

const activeRunPollIntervalMs = 30_000;

export function useDashboardRecovery(initialRecovery: BackendRead<DashboardRecoveryResponse>) {
  const [state, dispatch] = useReducer(
    dashboardStateReducer,
    initialRecovery,
    createDashboardState,
  );
  const requestRef = useRef<Promise<BackendRead<DashboardRecoveryResponse>> | null>(null);
  const eventDiscardedRef = useRef(false);
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

  const refresh = useCallback(async (): Promise<void> => {
    if (!mountedRef.current) return;
    if (requestRef.current) {
      await requestRef.current;
      return;
    }

    hasLocalRecoveryActivityRef.current = true;
    retrySchedulerRef.current?.cancel();
    dispatch({ type: "refresh-started" });
    let completedRecovery: BackendRead<DashboardRecoveryResponse> | null = null;
    const request = readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema).catch(
      (error: unknown): BackendRead<DashboardRecoveryResponse> => ({
          status: "unavailable",
          reason: error instanceof Error ? error.message : "Dashboard recovery request failed.",
      }),
    );
    requestRef.current = request;

    try {
      completedRecovery = await request;
      if (!mountedRef.current) return;
      dispatch({ type: "refresh-completed", recovery: completedRecovery });
      if (completedRecovery.status === "available") {
        retrySchedulerRef.current?.reset();
      } else {
        retrySchedulerRef.current?.schedule(completedRecovery.retryAfterMs);
      }
    } finally {
      requestRef.current = null;
      if (mountedRef.current && completedRecovery?.status === "available") {
        const shouldFollowUp = eventDiscardedRef.current;
        eventDiscardedRef.current = false;
        if (shouldFollowUp) {
          await refreshRef.current();
        }
      }
    }
  }, []);
  refreshRef.current = refresh;

  const applyEvent = useCallback(
    (event: DashboardEvent) => {
      const discard = requestRef.current !== null;
      if (discard) eventDiscardedRef.current = true;
      const shouldRecover = shouldRequestAuthoritativeRecoveryAfterScopedEvent(
        state.recovery,
        event,
      );
      dispatch({ type: "event-received", event, discard });
      if (!requestRef.current && shouldRecover) {
        void refresh();
      }
    },
    [refresh, state.recovery],
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
        dispatch({ type: "snapshot-received", recovery: nextRecovery });
      }
      if (nextRecovery.status === "unavailable") {
        retrySchedulerRef.current?.schedule(nextRecovery.retryAfterMs);
      } else {
        retrySchedulerRef.current?.reset();
      }
    }
  }, [initialRecoveryIdentity]);

  const currentRunStatus =
    state.recovery.status === "available" ? state.recovery.data.currentRun?.status : undefined;
  const recoveryPollIdentity =
    state.recovery.status === "available" ? state.recovery.data.recoveredAt : undefined;
  useEffect(() => {
    if (
      recoveryPollIdentity === undefined ||
      (currentRunStatus !== "starting" &&
        currentRunStatus !== "active" &&
        currentRunStatus !== "draining")
    ) {
      return;
    }
    const timer = setTimeout(() => void refreshRef.current(), activeRunPollIntervalMs);
    return () => clearTimeout(timer);
  }, [currentRunStatus, recoveryPollIdentity]);

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
    hasSyncIssue: state.recovery.status === "unavailable",
    liveEventCount: state.liveEventCount,
    recentOrderStates: state.recentOrderStates,
    recentOrderLagSamples: state.recentOrderLagSamples,
    refresh,
    retryNow,
    applyEvent,
  };
}

function recoveryIdentity(recovery: BackendRead<DashboardRecoveryResponse>): string {
  return recovery.status === "available"
    ? `${recovery.data.currentRun?.runId ?? "idle"}:${recovery.data.recoveredAt}`
    : `unavailable:${recovery.httpStatus ?? "none"}:${recovery.reason}`;
}
