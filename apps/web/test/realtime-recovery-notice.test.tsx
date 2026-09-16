// @vitest-environment jsdom

import {
  type DashboardProjection,
  dashboardEventsPath,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
} from "@checkout-surge/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorDashboard } from "../src/app/components/operator-dashboard.js";
import type { BackendRead } from "../src/app/lib/api.js";

class InjectedEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: InjectedEventSource[] = [];
  listeners = new Map<string, Set<EventListener>>();
  close = vi.fn();
  readyState = InjectedEventSource.CONNECTING;

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

const replacementDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000];
const interruptedNotice = "Live updates interrupted. Trying to reconnect...";
const exhaustedNotice =
  "Unable to restore live updates. Reload the page. If the problem persists, try again later.";

afterEach(() => {
  cleanup();
  InjectedEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("watch realtime recovery notice", () => {
  it("announces automatic reconnection without a reload action while a replacement is in flight", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", InjectedEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(recoveryFixture())),
    );
    render(createElement(OperatorDashboard, { initialRecovery: available(recoveryFixture()) }));

    expect(screen.queryByText(interruptedNotice)).toBeNull();

    failClosed(0);
    expect(screen.getByText(interruptedNotice)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();

    act(() => vi.advanceTimersByTime(1_000));
    expect(InjectedEventSource.instances).toHaveLength(2);
    expect(InjectedEventSource.instances[1]?.url).toBe(dashboardEventsPath);
    expect(screen.getByText(interruptedNotice)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
  });

  it("keeps the exhaustion message and Reload page action visible with Technical details collapsed", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", InjectedEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(recoveryFixture())),
    );
    render(createElement(OperatorDashboard, { initialRecovery: available(recoveryFixture()) }));

    exhaustStream();
    expect(InjectedEventSource.instances).toHaveLength(6);
    for (const details of document.querySelectorAll("details")) {
      expect(details.open).toBe(false);
    }
    expect(screen.getByText(exhaustedNotice)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();

    act(() => vi.advanceTimersByTime(60_000));
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(screen.getByText(exhaustedNotice)).toBeTruthy();
  });

  it("requests a full browser reload from the Reload page action", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", InjectedEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(recoveryFixture())),
    );
    const reload = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { reload } });
    vi.stubGlobal("window", navigationWindow);
    render(createElement(OperatorDashboard, { initialRecovery: available(recoveryFixture()) }));

    exhaustStream();
    screen.getByRole("button", { name: "Reload page" }).click();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps exhausted SSE attempts stopped when the HTTP Refresh button is used", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", InjectedEventSource);
    const fetchMock = vi.fn(async () => jsonResponse({ ...recoveryFixture(), revision: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(OperatorDashboard, { initialRecovery: available(recoveryFixture()) }));

    exhaustStream();
    await act(async () => Promise.resolve());
    const recoveryReadsBeforeRefresh = fetchMock.mock.calls.length;
    screen.getByRole("button", { name: "Refresh" }).click();
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(recoveryReadsBeforeRefresh + 1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(screen.getByText(exhaustedNotice)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
  });

  it("clears the interrupted notice after a replacement opens", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", InjectedEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(recoveryFixture())),
    );
    render(createElement(OperatorDashboard, { initialRecovery: available(recoveryFixture()) }));

    failClosed(0);
    expect(screen.getByText(interruptedNotice)).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    act(() => InjectedEventSource.instances[1]?.emit("open", new Event("open")));
    expect(screen.queryByText(interruptedNotice)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload page" })).toBeNull();
  });
});

function failClosed(index: number) {
  const source = InjectedEventSource.instances[index];
  if (!source) throw new Error(`Expected EventSource instance ${index}.`);
  act(() => {
    source.readyState = InjectedEventSource.CLOSED;
    source.emit("error", new Event("error"));
  });
}

function exhaustStream() {
  failClosed(0);
  for (const delayMs of replacementDelaysMs) {
    act(() => vi.advanceTimersByTime(delayMs));
    failClosed(InjectedEventSource.instances.length - 1);
  }
}

function available<T>(data: T): BackendRead<T> {
  return { status: "available", data, httpStatus: 200 };
}

function recoveryFixture(): DashboardProjection {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    scopeId: "idle",
    revision: 1,
    correlationId: "corr-watch-recovery",
    scope: null,
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    erp: null,
    systemStatus: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
    recoveredAt: "2026-06-20T00:00:10.000Z",
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
