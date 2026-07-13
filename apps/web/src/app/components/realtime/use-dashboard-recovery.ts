"use client";

import {
  type DashboardEvent,
  type DashboardRecoveryResponse,
  dashboardRecoveryResponseSchema,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { BackendRead } from "../../lib/api";
import { readProxyJson } from "../../lib/client/proxy-json";
import { dashboardRecoveryProxyPath } from "../../lib/control-paths";
import {
  createDashboardState,
  dashboardStateReducer,
  shouldRequestAuthoritativeRecoveryAfterEvent,
} from "../../lib/dashboard-state";

export function useDashboardRecovery(initialRecovery: BackendRead<DashboardRecoveryResponse>) {
  const [state, dispatch] = useReducer(
    dashboardStateReducer,
    initialRecovery,
    createDashboardState,
  );
  const requestRef = useRef<Promise<void> | null>(null);
  const eventDiscardedRef = useRef(false);
  const followUpRequestedRef = useRef(false);
  const initialRecoveryIdentityRef = useRef(recoveryIdentity(initialRecovery));

  const refresh = useCallback(async (): Promise<void> => {
    if (requestRef.current) {
      followUpRequestedRef.current = true;
      await requestRef.current;
      return;
    }

    dispatch({ type: "refresh-started" });
    const request = (async () => {
      const recovery = await readProxyJson(
        dashboardRecoveryProxyPath,
        dashboardRecoveryResponseSchema,
      );
      dispatch({ type: "refresh-completed", recovery });
    })();
    requestRef.current = request;

    try {
      await request;
    } finally {
      requestRef.current = null;
      const shouldFollowUp = eventDiscardedRef.current || followUpRequestedRef.current;
      eventDiscardedRef.current = false;
      followUpRequestedRef.current = false;
      if (shouldFollowUp) {
        await refresh();
      }
    }
  }, []);

  const applyEvent = useCallback(
    (event: DashboardEvent) => {
      const discard = requestRef.current !== null;
      if (discard) eventDiscardedRef.current = true;
      dispatch({ type: "event-received", event, discard });
      if (!requestRef.current && shouldRequestAuthoritativeRecoveryAfterEvent(event)) {
        void refresh();
      }
    },
    [refresh],
  );

  useEffect(() => {
    const nextIdentity = recoveryIdentity(initialRecovery);
    if (initialRecoveryIdentityRef.current === nextIdentity) return;
    initialRecoveryIdentityRef.current = nextIdentity;
    dispatch({ type: "snapshot-received", recovery: initialRecovery });
  }, [initialRecovery]);

  return {
    recovery: state.recovery,
    isRefreshing: state.isRefreshing,
    liveEventCount: state.liveEventCount,
    refresh,
    applyEvent,
  };
}

function recoveryIdentity(recovery: BackendRead<DashboardRecoveryResponse>): string {
  return recovery.status === "available"
    ? `${recovery.data.currentRun?.runId ?? "idle"}:${recovery.data.recoveredAt}`
    : `unavailable:${recovery.httpStatus ?? "none"}:${recovery.reason}`;
}
