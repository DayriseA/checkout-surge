"use client";

import {
  type DashboardProjection,
  dashboardEventsPath,
  dashboardProjectionSchema,
} from "@checkout-surge/contracts";
import { useEffect, useRef, useState } from "react";
import type { RealtimeConnectionStatus } from "../dashboard-panels";

export interface UseDashboardProjectionsOptions {
  onProjection: (projection: DashboardProjection) => void;
  onOpen: () => void;
  onDisconnect: () => void;
}

export function useDashboardProjections({
  onProjection,
  onOpen,
  onDisconnect,
}: UseDashboardProjectionsOptions): RealtimeConnectionStatus {
  const [status, setStatus] = useState<RealtimeConnectionStatus>("connecting");
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

    const source = new globalThis.EventSource(dashboardEventsPath);
    let connectionState: RealtimeConnectionStatus = "connecting";
    const handleOpen: EventListener = () => {
      if (connectionState === "connected") return;
      connectionState = "connected";
      setStatus("connected");
      openCallbackRef.current();
    };
    const handleError: EventListener = () => {
      if (connectionState === "disconnected") return;
      connectionState = "disconnected";
      setStatus("disconnected");
      disconnectCallbackRef.current();
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

    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleError);
    source.addEventListener("message", handleMessage);
    return () => {
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleError);
      source.removeEventListener("message", handleMessage);
      source.close();
    };
  }, []);

  return status;
}
