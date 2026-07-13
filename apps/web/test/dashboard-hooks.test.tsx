// @vitest-environment jsdom

import type { DashboardEvent, DashboardRecoveryResponse } from "@checkout-surge/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboardEvents } from "../src/app/components/realtime/use-dashboard-events.js";
import { useDashboardRecovery } from "../src/app/components/realtime/use-dashboard-recovery.js";
import type { BackendRead } from "../src/app/lib/api.js";

class InjectedEventSource {
  static instances: InjectedEventSource[] = [];
  listeners = new Map<string, Set<EventListener>>();
  close = vi.fn();

  constructor(readonly url: string) {
    InjectedEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  cleanup();
  InjectedEventSource.instances = [];
  vi.unstubAllGlobals();
});

describe("useDashboardEvents", () => {
  it("validates frames, reports open/error, keeps one subscription, and cleans up listeners", () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const onOpen = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ onEvent }) =>
        useDashboardEvents({
          eventSourceConstructor: InjectedEventSource,
          onEvent,
          onOpen,
          url: "/events",
        }),
      { initialProps: { onEvent: firstCallback } },
    );
    const source = InjectedEventSource.instances[0];
    expect(source).toBeDefined();
    expect(result.current).toBe("connecting");

    act(() => source?.emit("message", new MessageEvent("message", { data: "{" })));
    act(() =>
      source?.emit(
        "message",
        new MessageEvent("message", { data: JSON.stringify({ type: "bad" }) }),
      ),
    );
    expect(firstCallback).not.toHaveBeenCalled();

    rerender({ onEvent: secondCallback });
    expect(InjectedEventSource.instances).toHaveLength(1);
    act(() => source?.emit("open", new Event("open")));
    expect(result.current).toBe("connected");
    expect(onOpen).toHaveBeenCalledOnce();
    act(() =>
      source?.emit(
        "message",
        new MessageEvent("message", { data: JSON.stringify(eventFixture()) }),
      ),
    );
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(eventFixture());
    act(() => source?.emit("error", new Event("error")));
    expect(result.current).toBe("disconnected");

    unmount();
    expect(source?.close).toHaveBeenCalledOnce();
    expect([...(source?.listeners.values() ?? [])].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
  });
});

describe("useDashboardRecovery", () => {
  it("serializes one follow-up when events and refresh requests arrive during recovery", async () => {
    const first = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(jsonResponse(recoveryFixture("2026-06-20T00:00:12.000Z")));
    vi.stubGlobal("fetch", fetchMock);
    const initialRecovery = available(recoveryFixture());
    const { result } = renderHook(() => useDashboardRecovery(initialRecovery));

    let firstRefresh!: Promise<void>;
    act(() => {
      firstRefresh = result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      result.current.applyEvent(eventFixture());
      void result.current.refresh();
      void result.current.refresh();
    });
    first.resolve(jsonResponse(recoveryFixture("2026-06-20T00:00:11.000Z")));
    await act(async () => firstRefresh);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.liveEventCount).toBe(1);
  });
});

function eventFixture(): DashboardEvent {
  return {
    type: "traffic.metric",
    eventId: "55555555-5555-4555-8555-555555555555",
    correlationId: "corr-live",
    occurredAt: "2026-06-20T00:00:11.000Z",
    metricName: "queue.depth",
    value: 3,
    unit: "jobs",
  };
}

function recoveryFixture(recoveredAt = "2026-06-20T00:00:10.000Z"): DashboardRecoveryResponse {
  return {
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recentCompletionOutcomes: [],
    recoveredAt,
  };
}

function available<T>(data: T): BackendRead<T> {
  return { status: "available", data, httpStatus: 200 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
