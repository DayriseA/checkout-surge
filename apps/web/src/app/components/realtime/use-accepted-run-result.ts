"use client";

import { publicRunHistoryDetailResponseSchema } from "@checkout-surge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { readProxyJson } from "../../lib/client/proxy-json";
import { publicRunHistoryDetailProxyPath } from "../../lib/control-paths";
import {
  type AcceptedRunResult,
  acceptedRunResultFromRead,
} from "../../lib/presentation/accepted-run-result";
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

export function useAcceptedRunResult(initialResult?: AcceptedRunResult) {
  // Identity is only the lookup target, not the retained payload: re-rendering with the same
  // run's detail must not re-apply the initial result or restart scheduled retries.
  const initialIdentity = initialResult
    ? `${initialResult.status}:${initialResult.runId}:${initialResult.status === "available" ? initialResult.endedAt : ""}`
    : "none";
  const [result, setResult] = useState(initialResult);
  const [retryState, setRetryState] = useState(noScheduledRetry);
  const initialResultRef = useRef(initialResult);
  initialResultRef.current = initialResult;
  const appliedInitialIdentityRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const targetRef = useRef(initialResult?.runId);
  targetRef.current = initialResult?.runId;
  const requestRef = useRef<{
    runId: string;
    promise: ReturnType<typeof readAcceptedResult>;
  } | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const schedulerRef = useRef<ReturnType<typeof createDashboardRecoveryRetryScheduler> | null>(
    null,
  );
  if (schedulerRef.current === null) {
    schedulerRef.current = createDashboardRecoveryRetryScheduler({
      onRetry: () => void refreshRef.current(),
      onStateChange: (state) => {
        if (mountedRef.current) setRetryState(state);
      },
    });
  }

  const refresh = useCallback(async () => {
    const runId = targetRef.current;
    if (!mountedRef.current || !runId || result?.status === "available") return;
    const existing = requestRef.current;
    if (existing?.runId === runId) {
      await existing.promise;
      return;
    }

    schedulerRef.current?.cancel();
    const promise = readAcceptedResult(runId);
    const request = { runId, promise };
    requestRef.current = request;
    try {
      const read = await promise;
      if (!mountedRef.current || targetRef.current !== runId) return;
      const next = acceptedRunResultFromRead(runId, read);
      setResult(next);
      if (next.status === "available") schedulerRef.current?.reset();
      else schedulerRef.current?.schedule(read.status === "unavailable" ? read.retryAfterMs : 0);
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }, [result?.status]);
  refreshRef.current = refresh;

  useEffect(() => {
    if (appliedInitialIdentityRef.current === initialIdentity) return;
    appliedInitialIdentityRef.current = initialIdentity;
    const next = initialResultRef.current;
    schedulerRef.current?.reset();
    setResult(next);
    if (next && next.status !== "available") {
      schedulerRef.current?.schedule(next.status === "unavailable" ? next.retryAfterMs : 0);
    }
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      appliedInitialIdentityRef.current = null;
      schedulerRef.current?.reset();
    };
  }, []);

  const retryNow = useCallback(async () => {
    schedulerRef.current?.reset();
    await refreshRef.current();
  }, []);

  const retriesExhausted = retryState.exhausted && requestRef.current === null;
  return {
    result:
      result && result.status !== "available" && retriesExhausted
        ? ({ status: "unavailable", runId: result.runId } as const)
        : result,
    retryNow,
    retriesExhausted,
  };
}

function readAcceptedResult(runId: string) {
  return readProxyJson(
    publicRunHistoryDetailProxyPath(runId),
    publicRunHistoryDetailResponseSchema,
  );
}
