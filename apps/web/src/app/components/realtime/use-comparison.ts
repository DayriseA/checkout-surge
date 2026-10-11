"use client";

import {
  type ComparisonDetailResponse,
  comparisonDetailResponseSchema,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendRead } from "../../lib/api";
import { readProxyJson } from "../../lib/client/proxy-json";
import { comparisonDetailProxyPath } from "../../lib/control-paths";
import { comparisonIsTerminal, comparisonReportMissing } from "../../lib/presentation/comparison";
import { createDashboardRecoveryRetryScheduler } from "./dashboard-recovery-retry";

// Parent reads share the public dashboard recovery budget. Live measurements use SSE.
const pollIntervalMs = 15_000;

interface ComparisonReadState {
  comparisonId: string;
  detail: ComparisonDetailResponse | null;
  unavailable: boolean;
  notFound: boolean;
  refreshing: boolean;
  retriesExhausted: boolean;
  retryScheduled: boolean;
}

export function useComparison(
  comparisonId: string,
  initialRead: BackendRead<ComparisonDetailResponse>,
) {
  const initialRef = useRef(initialRead);
  initialRef.current = initialRead;
  const [state, setState] = useState<ComparisonReadState>(() =>
    initialState(comparisonId, initialRead),
  );
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let nextReadAt = 0;
    const initial = initialRef.current;
    let detail =
      initial.status === "available" && initial.data.comparisonId === comparisonId
        ? initial.data
        : null;
    let terminal =
      comparisonReportMissing(initial) || (detail !== null && comparisonIsTerminal(detail));
    setState(initialState(comparisonId, initial));

    const retryScheduler = createDashboardRecoveryRetryScheduler({
      onRetry: () => void read(),
      onStateChange: (retry) => {
        if (!disposed)
          setState((previous) => ({
            ...previous,
            retriesExhausted: retry.exhausted,
            retryScheduled: retry.scheduled,
          }));
      },
    });

    function scheduleFailure(retryAfterMs = 0) {
      const minimumDelay = Math.max(pollIntervalMs, retryAfterMs);
      const retry = retryScheduler.schedule(minimumDelay);
      nextReadAt = Date.now() + (retry.delayMs ?? minimumDelay);
    }

    function schedulePoll() {
      nextReadAt = Date.now() + pollIntervalMs;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void read();
      }, pollIntervalMs);
    }

    async function read() {
      if (disposed || terminal || inFlight || Date.now() < nextReadAt) return;
      inFlight = true;
      if (pollTimer !== null) clearTimeout(pollTimer);
      pollTimer = null;
      retryScheduler.cancel();
      controller = new AbortController();
      setState((previous) => ({ ...previous, refreshing: true }));
      const result = await readProxyJson(
        comparisonDetailProxyPath(comparisonId),
        comparisonDetailResponseSchema.refine((value) => value.comparisonId === comparisonId),
        { signal: controller.signal },
      );
      if (disposed) return;
      inFlight = false;
      controller = null;
      if (result.status === "available") {
        detail = result.data;
        terminal = comparisonIsTerminal(detail);
        retryScheduler.reset();
        setState({
          comparisonId,
          detail,
          unavailable: false,
          notFound: false,
          refreshing: false,
          retriesExhausted: false,
          retryScheduled: false,
        });
        if (!terminal) schedulePoll();
      } else if (comparisonReportMissing(result)) {
        terminal = true;
        retryScheduler.reset();
        setState(initialState(comparisonId, result));
      } else {
        setState((previous) => ({ ...previous, unavailable: true, refreshing: false }));
        scheduleFailure(result.retryAfterMs);
      }
    }

    refreshRef.current = () => {
      if (disposed || terminal || inFlight || Date.now() < nextReadAt) return;
      retryScheduler.reset();
      void read();
    };
    if (!terminal) {
      if (initial.status === "loading") void read();
      else if (initial.status === "unavailable") scheduleFailure(initial.retryAfterMs);
      else schedulePoll();
    }

    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      controller?.abort();
      if (pollTimer !== null) clearTimeout(pollTimer);
      retryScheduler.cancel();
    };
  }, [comparisonId]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return {
    ...(state.comparisonId === comparisonId ? state : initialState(comparisonId, initialRead)),
    refresh,
  };
}

function initialState(
  comparisonId: string,
  read: BackendRead<ComparisonDetailResponse>,
): ComparisonReadState {
  return {
    comparisonId,
    detail:
      read.status === "available" && read.data.comparisonId === comparisonId ? read.data : null,
    unavailable: read.status === "unavailable" && !comparisonReportMissing(read),
    notFound: comparisonReportMissing(read),
    refreshing: false,
    retriesExhausted: false,
    retryScheduled: false,
  };
}
