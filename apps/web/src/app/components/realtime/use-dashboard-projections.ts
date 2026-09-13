"use client";

import {
  type DashboardProjection,
  dashboardEventsPath,
  dashboardProjectionSchema,
} from "@checkout-surge/contracts";
import { useEffect, useRef, useState } from "react";
import type { RealtimeConnectionStatus } from "../dashboard-panels";
import { createDashboardRecoveryRetryScheduler } from "./dashboard-recovery-retry";

const sseReplacementRetryPolicy = {
  initialDelayMs: 1_000,
  multiplier: 2,
  maximumDelayMs: 16_000,
  maximumAttempts: 5,
} as const;

export interface UseDashboardProjectionsOptions {
  onProjection: (projection: DashboardProjection) => void;
  onOpen: () => void;
  onDisconnect: () => void;
}

export interface DashboardTransportState {
  status: RealtimeConnectionStatus;
  reconnectExhausted: boolean;
}

export function useDashboardProjections({
  onProjection,
  onOpen,
  onDisconnect,
}: UseDashboardProjectionsOptions): DashboardTransportState {
  const [status, setStatus] = useState<RealtimeConnectionStatus>("connecting");
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const projectionCallbackRef = useRef(onProjection);
  const openCallbackRef = useRef(onOpen);
  const disconnectCallbackRef = useRef(onDisconnect);
  projectionCallbackRef.current = onProjection;
  openCallbackRef.current = onOpen;
  disconnectCallbackRef.current = onDisconnect;

  useEffect(() => {
    if (!globalThis.EventSource) {
      setStatus("unsupported");
      return;
    }

    let currentSource: EventSource | null = null;
    let connectionState: RealtimeConnectionStatus = "connecting";
    let notifiedThisOutage = false;
    let disposed = false;
    const replacementScheduler = createDashboardRecoveryRetryScheduler({
      onRetry: () => {
        if (!disposed) connect();
      },
      policy: sseReplacementRetryPolicy,
    });

    const detach = (source: EventSource) => {
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleError);
      source.removeEventListener("message", handleMessage);
    };

    const connect = () => {
      if (disposed) return;
      const source = new globalThis.EventSource(dashboardEventsPath);
      currentSource = source;
      connectionState = "connecting";
      source.addEventListener("open", handleOpen);
      source.addEventListener("error", handleError);
      source.addEventListener("message", handleMessage);
    };

    const handleOpen: EventListener = () => {
      if (connectionState === "connected") return;
      connectionState = "connected";
      notifiedThisOutage = false;
      setStatus("connected");
      setReconnectExhausted(false);
      replacementScheduler.reset();
      openCallbackRef.current();
    };

    const handleDisconnect = () => {
      if (notifiedThisOutage) return;
      notifiedThisOutage = true;
      connectionState = "disconnected";
      setStatus("disconnected");
      disconnectCallbackRef.current();
    };

    const handleError: EventListener = () => {
      const source = currentSource;
      if (!source) return;
      if (source.readyState !== globalThis.EventSource.CLOSED) {
        handleDisconnect();
        return;
      }
      detach(source);
      source.close();
      currentSource = null;
      handleDisconnect();
      setReconnectExhausted(!replacementScheduler.schedule().scheduled);
    };

    const handleMessage: EventListener = (rawEvent) => {
      const message = rawEvent as MessageEvent<unknown>;
      if (typeof message.data !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = dashboardProjectionSchema.safeParse(payload);
      if (parsed.success) projectionCallbackRef.current(parsed.data);
    };

    connect();

    return () => {
      disposed = true;
      replacementScheduler.cancel();
      const source = currentSource;
      if (source) {
        detach(source);
        source.close();
        currentSource = null;
      }
    };
  }, []);

  return { status, reconnectExhausted };
}
