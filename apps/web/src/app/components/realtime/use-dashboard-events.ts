"use client";

import { type DashboardEvent, dashboardEventSchema } from "@checkout-surge/contracts";
import { useEffect, useRef, useState } from "react";
import { dashboardEventsUrl } from "../../lib/realtime";
import type { RealtimeConnectionStatus } from "../dashboard-panels";

interface EventSourceLike {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  close(): void;
}

type EventSourceConstructor = new (url: string) => EventSourceLike;

export interface UseDashboardEventsOptions {
  onEvent: (event: DashboardEvent) => void;
  onOpen: () => void;
  eventSourceConstructor?: EventSourceConstructor;
  url?: string;
}

export function useDashboardEvents({
  onEvent,
  onOpen,
  eventSourceConstructor,
  url = dashboardEventsUrl(),
}: UseDashboardEventsOptions): RealtimeConnectionStatus {
  const [status, setStatus] = useState<RealtimeConnectionStatus>("connecting");
  const eventCallbackRef = useRef(onEvent);
  const openCallbackRef = useRef(onOpen);
  eventCallbackRef.current = onEvent;
  openCallbackRef.current = onOpen;

  useEffect(() => {
    const Constructor = eventSourceConstructor ?? globalThis.EventSource;
    if (!Constructor) {
      setStatus("unsupported");
      return;
    }

    const source = new Constructor(url) as EventSourceLike;
    const handleOpen: EventListener = () => {
      setStatus("connected");
      openCallbackRef.current();
    };
    const handleError: EventListener = () => setStatus("disconnected");
    const handleMessage: EventListener = (rawEvent) => {
      const message = rawEvent as MessageEvent<unknown>;
      if (typeof message.data !== "string") return;
      let payload: unknown;
      try {
        payload = JSON.parse(message.data);
      } catch {
        return;
      }
      const parsed = dashboardEventSchema.safeParse(payload);
      if (parsed.success) eventCallbackRef.current(parsed.data);
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
  }, [eventSourceConstructor, url]);

  return status;
}
