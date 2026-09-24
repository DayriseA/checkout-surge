// @vitest-environment jsdom

import {
  type DashboardProjection,
  dashboardEventsPath,
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  errorPayloadSchema,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchNarrative } from "../src/app/components/operator-dashboard.js";
import { useDashboardProjections } from "../src/app/components/realtime/use-dashboard-projections.js";
import { useDashboardRecovery } from "../src/app/components/realtime/use-dashboard-recovery.js";
import type { BackendRead } from "../src/app/lib/api.js";
import { deriveWatchComposition } from "../src/app/lib/presentation/watch-composition.js";

type ActiveRun = Extract<NonNullable<DashboardProjection["currentRun"]>, { status: "active" }>;
type DrainingRun = Extract<NonNullable<DashboardProjection["currentRun"]>, { status: "draining" }>;
type CompletedRun = Extract<
  NonNullable<DashboardProjection["currentRun"]>,
  { status: "completed" }
>;

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

afterEach(() => {
  cleanup();
  InjectedEventSource.instances = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useDashboardProjections", () => {
  it("automatically presents an operator-stopped run from the connected stream and rejects its old active frame", () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const active = dashboardProjectionSchema.parse(runProjection());
    const terminal = dashboardProjectionSchema.parse(
      runProjection({
        revision: 2,
        recoveredAt: "2026-06-20T00:00:12.000Z",
        currentRun: {
          ...activeRun(),
          status: "failed",
          trafficStatus: "failed",
          trafficEndedAt: "2026-06-20T00:00:12.000Z",
          finalizedAt: "2026-06-20T00:00:12.000Z",
          failureCategory: "operator",
        },
      }),
    );
    const { result } = renderHook(() => {
      const recovery = useDashboardRecovery(available(active));
      const transportStatus = useDashboardProjections({
        onProjection: recovery.applyProjection,
        onOpen: recovery.notifyRealtimeReopened,
        onDisconnect: recovery.notifyRealtimeDisconnected,
      });
      return {
        transportStatus,
        composition: deriveWatchComposition({
          recovery: recovery.recovery,
          retainedTerminalRun: null,
          latestCompletedRun: available(null),
          signalSamples: [],
          transportStatus: transportStatus.status,
          now: new Date("2026-06-20T00:00:12.000Z"),
        }),
      };
    });
    const source = InjectedEventSource.instances[0];
    act(() => source?.emit("open", new Event("open")));
    expect(result.current.transportStatus.status).toBe("connected");
    expect(result.current.composition.phase).toBe("active");
    act(() =>
      source?.emit("message", new MessageEvent("message", { data: JSON.stringify(terminal) })),
    );
    const composition = result.current.composition;
    expect(composition.phase).toBe("failed");
    expect(composition.presentation.state).toBe("failed");
    if (composition.phase !== "failed") throw new Error("Expected failed Watch composition");
    expect(composition.result.failureCategory).toBe("operator");
    const markup = renderToStaticMarkup(
      createElement(WatchNarrative, { composition, onRetry: () => undefined }),
    );
    expect(markup).toContain("stopped by an operator");
    act(() =>
      source?.emit("message", new MessageEvent("message", { data: JSON.stringify(active) })),
    );
    expect(result.current.composition.phase).toBe("failed");
    expect(result.current.transportStatus.status).toBe("connected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("presents a newer foreign terminal successor to an idle observer from the stream without a recovery read", () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const idle = dashboardProjectionSchema.parse(projectionFixture());
    const successorRunId = "22222222-2222-4222-8222-222222222222";
    const terminal = dashboardProjectionSchema.parse(
      runProjection({
        revision: 1,
        recoveredAt: "2026-06-20T00:00:12.000Z",
        currentRun: {
          ...terminalRun(successorRunId),
          saleOfferId: "55555555-5555-4555-8555-555555555555",
          startedAt: "2026-06-20T00:00:11.000Z",
          trafficStartedAt: "2026-06-20T00:00:11.000Z",
          trafficEndedAt: "2026-06-20T00:00:12.000Z",
        },
      }),
    );
    const settledIdle = dashboardProjectionSchema.parse(
      projectionFixture({ revision: 2, recoveredAt: "2026-06-20T00:00:13.000Z" }),
    );
    const { result } = renderHook(() => {
      const recovery = useDashboardRecovery(available(idle));
      const transportStatus = useDashboardProjections({
        onProjection: recovery.applyProjection,
        onOpen: recovery.notifyRealtimeReopened,
        onDisconnect: recovery.notifyRealtimeDisconnected,
      });
      return {
        transportStatus,
        composition: deriveWatchComposition({
          recovery: recovery.recovery,
          retainedTerminalRun: recovery.retainedTerminalRun,
          latestCompletedRun: available(null),
          signalSamples: [],
          transportStatus: transportStatus.status,
          now: new Date("2026-06-20T00:00:13.000Z"),
        }),
      };
    });
    const source = InjectedEventSource.instances[0];
    act(() => source?.emit("open", new Event("open")));
    expect(result.current.composition.phase).toBe("idle");
    act(() =>
      source?.emit("message", new MessageEvent("message", { data: JSON.stringify(terminal) })),
    );
    expect(result.current.composition.phase).toBe("completed");
    act(() =>
      source?.emit("message", new MessageEvent("message", { data: JSON.stringify(settledIdle) })),
    );
    const composition = result.current.composition;
    expect(composition.phase).toBe("completed");
    if (composition.phase !== "completed") throw new Error("Expected completed Watch composition");
    expect(composition.run.runId).toBe(successorRunId);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the same-origin stream, de-duplicates lifecycle transitions, parses frames, and cleans up", () => {
    vi.useFakeTimers();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    vi.stubGlobal("EventSource", InjectedEventSource);
    const { result, rerender, unmount } = renderHook(
      ({ onProjection }) =>
        useDashboardProjections({
          onProjection,
          onOpen,
          onDisconnect,
        }),
      { initialProps: { onProjection: firstCallback } },
    );
    const source = InjectedEventSource.instances[0];
    expect(source?.url).toBe(dashboardEventsPath);
    expect(result.current.status).toBe("connecting");

    act(() => source?.emit("message", new MessageEvent("message", { data: "{" })));
    expect(firstCallback).not.toHaveBeenCalled();

    rerender({ onProjection: secondCallback });
    expect(InjectedEventSource.instances).toHaveLength(1);
    act(() => source?.emit("open", new Event("open")));
    expect(result.current.status).toBe("connected");
    expect(onOpen).toHaveBeenCalledOnce();
    act(() => source?.emit("open", new Event("open")));
    expect(onOpen).toHaveBeenCalledOnce();

    const projection = projectionFixture();
    act(() =>
      source?.emit("message", new MessageEvent("message", { data: JSON.stringify(projection) })),
    );
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(projection);

    act(() => source?.emit("error", new Event("error")));
    expect(result.current.status).toBe("disconnected");
    expect(onDisconnect).toHaveBeenCalledOnce();
    act(() => source?.emit("error", new Event("error")));
    expect(onDisconnect).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(60_000));
    expect(InjectedEventSource.instances).toHaveLength(1);
    expect(source?.close).not.toHaveBeenCalled();

    act(() => source?.emit("open", new Event("open")));
    expect(result.current.status).toBe("connected");
    expect(onOpen).toHaveBeenCalledTimes(2);

    unmount();
    expect(source?.close).toHaveBeenCalledOnce();
    expect([...(source?.listeners.values() ?? [])].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
  });

  it("replaces a closed source with backoff and resets the budget after a successful open", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    vi.stubGlobal("EventSource", InjectedEventSource);
    const { result } = renderHook(() =>
      useDashboardProjections({ onProjection: vi.fn(), onOpen, onDisconnect }),
    );

    failClosed(0);
    expect(result.current.status).toBe("disconnected");
    expect(result.current.reconnectExhausted).toBe(false);
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(InjectedEventSource.instances[0]?.close).toHaveBeenCalledOnce();
    expectDetached(0);
    expect(InjectedEventSource.instances).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1_000));
    expect(InjectedEventSource.instances).toHaveLength(2);
    expect(InjectedEventSource.instances[1]?.url).toBe(dashboardEventsPath);

    failClosed(1);
    expectDetached(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(InjectedEventSource.instances).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1_000));
    expect(InjectedEventSource.instances).toHaveLength(3);

    act(() => InjectedEventSource.instances[2]?.emit("open", new Event("open")));
    expect(result.current.status).toBe("connected");
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(result.current.reconnectExhausted).toBe(false);

    failClosed(2);
    expect(onDisconnect).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(999));
    expect(InjectedEventSource.instances).toHaveLength(3);
    act(() => vi.advanceTimersByTime(1));
    expect(InjectedEventSource.instances).toHaveLength(4);
  });

  it("exhausts after the fifth failed replacement and stops application-managed attempts", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    vi.stubGlobal("EventSource", InjectedEventSource);
    const { result } = renderHook(() =>
      useDashboardProjections({ onProjection: vi.fn(), onOpen, onDisconnect }),
    );

    failClosed(0);
    for (const [index, delayMs] of replacementDelaysMs.entries()) {
      act(() => vi.advanceTimersByTime(delayMs));
      expect(InjectedEventSource.instances).toHaveLength(index + 2);
      expect(result.current.reconnectExhausted).toBe(false);
      failClosed(InjectedEventSource.instances.length - 1);
    }
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(result.current.reconnectExhausted).toBe(true);
    expect(result.current.status).toBe("disconnected");
    expect(onDisconnect).toHaveBeenCalledOnce();

    act(() => vi.advanceTimersByTime(60_000));
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(result.current.reconnectExhausted).toBe(true);
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("connects and resets the budget when the fifth replacement succeeds", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    vi.stubGlobal("EventSource", InjectedEventSource);
    const { result } = renderHook(() =>
      useDashboardProjections({ onProjection: vi.fn(), onOpen, onDisconnect }),
    );

    failClosed(0);
    for (const [index, delayMs] of replacementDelaysMs.entries()) {
      act(() => vi.advanceTimersByTime(delayMs));
      if (index < replacementDelaysMs.length - 1) {
        failClosed(InjectedEventSource.instances.length - 1);
      }
    }
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(result.current.reconnectExhausted).toBe(false);

    act(() => InjectedEventSource.instances[5]?.emit("open", new Event("open")));
    expect(result.current.status).toBe("connected");
    expect(result.current.reconnectExhausted).toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();

    failClosed(5);
    expect(onDisconnect).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1_000));
    expect(InjectedEventSource.instances).toHaveLength(7);
  });

  it("cancels the pending replacement timer and closes the source on unmount", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", InjectedEventSource);
    const onDisconnect = vi.fn();
    const { unmount } = renderHook(() =>
      useDashboardProjections({ onProjection: vi.fn(), onOpen: vi.fn(), onDisconnect }),
    );

    failClosed(0);
    unmount();
    act(() => vi.advanceTimersByTime(60_000));
    expect(InjectedEventSource.instances).toHaveLength(1);
    expect(InjectedEventSource.instances[0]?.close).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});

const replacementDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000];

function failClosed(index: number) {
  const source = InjectedEventSource.instances[index];
  if (!source) throw new Error(`Expected EventSource instance ${index}.`);
  act(() => {
    source.readyState = InjectedEventSource.CLOSED;
    source.emit("error", new Event("error"));
  });
}

function expectDetached(index: number) {
  const source = InjectedEventSource.instances[index];
  if (!source) throw new Error(`Expected EventSource instance ${index}.`);
  expect([...source.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
}

describe("useDashboardRecovery", () => {
  it("keeps initial loading fail-closed and performs one initial read without retry UI", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(projectionFixture()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery({ status: "loading" }), {
      wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
    });

    expect(result.current.recovery.status).toBe("loading");
    expect(result.current.hasSyncIssue).toBe(false);
    expect(result.current.syncIssue).toBeNull();
    expect(result.current.isRetryScheduled).toBe(false);
    expect(result.current.retryDelayMs).toBeNull();
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.recovery).toEqual(available(projectionFixture()));
  });

  it("retains Watch's last-known-good projection and schedules unavailable-read retry", async () => {
    vi.useFakeTimers();
    const initial = available(runProjection());
    const fetchMock = vi.fn().mockResolvedValue(errorResponse("API restarting", 503));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useDashboardRecovery(initial, { preserveAvailableRecoveryOnFailure: true }),
    );

    await act(async () => result.current.refresh());

    expect(result.current.recovery).toEqual(initial);
    expect(result.current.syncIssue).toMatchObject({
      status: "unavailable",
      reason: "API restarting",
      httpStatus: 503,
    });
    expect(result.current.isRetryScheduled).toBe(true);

    const live = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    act(() => result.current.applyProjection(live));
    expect(result.current.recovery).toEqual(available(live));
    expect(result.current.syncIssue).toBeNull();
    expect(result.current.isRetryScheduled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors Retry-After and converges without a reload", async () => {
    vi.useFakeTimers();
    const recovered = projectionFixture({ revision: 2, recoveredAt: "2026-06-20T00:00:30.000Z" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("Recovery limited", 429, "10"))
      .mockResolvedValueOnce(jsonResponse(recovered));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useDashboardRecovery({ status: "unavailable", reason: "API unavailable" }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.retryDelayMs).toBe(10_000);
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery).toEqual(available(recovered));
  });

  it("coalesces concurrent repairs and sends the paired known-scope hint", async () => {
    const inFlight = deferred<Response>();
    const followUp = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => inFlight.promise)
      .mockImplementationOnce(() => followUp.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initial = runProjection();
    const next = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    const newer = runProjection({ revision: 3, recoveredAt: "2026-06-20T00:00:13.000Z" });
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));

    let queued!: Promise<void>;
    let alsoQueued!: Promise<void>;
    act(() => {
      void result.current.refresh();
      queued = result.current.refresh();
      alsoQueued = result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/dashboard/recovery?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=44444444-4444-4444-8444-444444444444",
    );

    let queuedCallerSettled = false;
    let alsoQueuedCallerSettled = false;
    void alsoQueued.then(() => {
      alsoQueuedCallerSettled = true;
    });
    void queued.then(() => {
      queuedCallerSettled = true;
    });
    inFlight.resolve(jsonResponse(next));
    await act(async () => inFlight.promise);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      "/api/dashboard/recovery?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=44444444-4444-4444-8444-444444444444",
    );
    expect(queuedCallerSettled).toBe(false);
    expect(alsoQueuedCallerSettled).toBe(false);
    expect(result.current.recovery).toEqual(available(next));

    followUp.resolve(jsonResponse(newer));
    await act(async () => {
      await Promise.all([queued, alsoQueued]);
    });
    expect(queuedCallerSettled).toBe(true);
    expect(alsoQueuedCallerSettled).toBe(true);
    expect(result.current.recovery).toEqual(available(newer));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("requires a third read from a caller arriving during the shared follow-up", async () => {
    const requests = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let requestIndex = 0;
    const fetchMock = vi.fn(() => {
      const request = requests[requestIndex];
      requestIndex += 1;
      if (!request) throw new Error(`Unexpected fetch ${requestIndex}.`);
      return request.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const initial = runProjection();
    const second = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    const third = runProjection({ revision: 3, recoveredAt: "2026-06-20T00:00:13.000Z" });
    const fourth = runProjection({ revision: 4, recoveredAt: "2026-06-20T00:00:14.000Z" });
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));

    let sharedFollowUp!: Promise<void>;
    act(() => {
      void result.current.refresh();
      sharedFollowUp = result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    let sharedCallerSettled = false;
    void sharedFollowUp.then(() => {
      sharedCallerSettled = true;
    });
    requests[0]?.resolve(jsonResponse(second));
    await act(async () => requests[0]?.promise);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sharedCallerSettled).toBe(false);

    let lateCaller!: Promise<void>;
    act(() => {
      lateCaller = result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    requests[1]?.resolve(jsonResponse(third));
    await act(async () => sharedFollowUp);
    expect(sharedCallerSettled).toBe(true);
    expect(result.current.recovery).toEqual(available(third));

    let lateCallerSettled = false;
    void lateCaller.then(() => {
      lateCallerSettled = true;
    });
    await act(async () => Promise.resolve());
    expect(lateCallerSettled).toBe(false);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    requests[2]?.resolve(jsonResponse(fourth));
    await act(async () => lateCaller);
    expect(lateCallerSettled).toBe(true);
    expect(result.current.recovery).toEqual(available(fourth));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("requires a fresh disconnect read after an in-flight request and keeps the reconciliation policy", async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const next = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    const stillActive = runProjection({ revision: 3, recoveredAt: "2026-06-20T00:00:13.000Z" });
    const terminal = runProjection({
      revision: 4,
      recoveredAt: "2026-06-20T00:00:14.000Z",
      currentRun: terminalRun(),
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(jsonResponse(stillActive))
      .mockResolvedValueOnce(jsonResponse(terminal));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(runProjection())));

    let firstCaller!: Promise<void>;
    act(() => {
      firstCaller = result.current.refresh();
      void result.current.notifyRealtimeDisconnected();
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    first.resolve(jsonResponse(next));
    await act(async () => firstCaller);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("settles callers of a failed follow-up and leaves retries to the existing backoff", async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(errorResponse("Recovery unavailable", 503))
      .mockResolvedValueOnce(
        jsonResponse(runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const initial = runProjection();
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));

    let queued!: Promise<void>;
    act(() => {
      void result.current.refresh();
      queued = result.current.refresh();
    });
    first.resolve(errorResponse("Recovery unavailable", 503));
    await act(async () => first.promise);
    await act(async () => queued);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery.status).toBe("unavailable");

    await act(async () => vi.advanceTimersByTimeAsync(1_999));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.recovery.status).toBe("available");

    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("settles queued callers without starting the follow-up on unmount", async () => {
    const first = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => first.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initial = available(projectionFixture());
    const { result, unmount } = renderHook(() => useDashboardRecovery(initial));

    let inFlight!: Promise<void>;
    let queued!: Promise<void>;
    act(() => {
      inFlight = result.current.refresh();
      queued = result.current.refresh();
    });
    unmount();
    // Leave fetch pending: cleanup must settle callers independently of the network.
    await act(async () => {
      await Promise.all([inFlight, queued]);
    });
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.recovery).toEqual(initial);

    await act(async () => {
      first.resolve(
        jsonResponse(projectionFixture({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" })),
      );
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.recovery).toEqual(initial);
  });

  it("keeps reconciling successful nonterminal recoveries while disconnected", async () => {
    vi.useFakeTimers();
    let revision = 1;
    const fetchMock = vi.fn(() => {
      revision += 1;
      return Promise.resolve(
        jsonResponse(
          runProjection({
            revision,
            recoveredAt: `2026-06-20T00:00:${String(revision).padStart(2, "0")}.000Z`,
          }),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(runProjection())));

    await act(async () => result.current.notifyRealtimeDisconnected());
    for (let index = 0; index < 7; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(2_000));
    }

    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("clears disconnected reconciliation after a terminal recovery", async () => {
    vi.useFakeTimers();
    const terminal = runProjection({
      revision: 2,
      recoveredAt: "2026-06-20T00:00:12.000Z",
      currentRun: terminalRun(),
    });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(terminal));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(runProjection())));

    await act(async () => result.current.notifyRealtimeDisconnected());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears disconnected reconciliation when realtime reopens", async () => {
    vi.useFakeTimers();
    const next = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(next));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(runProjection())));

    await act(async () => result.current.notifyRealtimeDisconnected());
    act(() => result.current.notifyRealtimeReopened());
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears disconnected reconciliation on unmount", async () => {
    vi.useFakeTimers();
    const next = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(next));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useDashboardRecovery(available(runProjection())));

    await act(async () => result.current.notifyRealtimeDisconnected());
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("atomically compares a live projection racing an older HTTP response", async () => {
    const request = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initial = runProjection();
    const liveTerminal = runProjection({
      revision: 3,
      recoveredAt: "2026-06-20T00:00:13.000Z",
      currentRun: terminalRun(),
    });
    const staleRead = runProjection({
      revision: 2,
      recoveredAt: "2026-06-20T00:00:12.000Z",
      currentRun: drainingRun(),
    });
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));

    act(() => void result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => result.current.applyProjection(liveTerminal));
    expect(result.current.recovery).toEqual(available(liveTerminal));

    request.resolve(jsonResponse(staleRead));
    await act(async () => request.promise);
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.recovery).toEqual(available(liveTerminal));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recovers a coalesced reset result for an idle observer without accepting the foreign terminal", async () => {
    const resetRunId = "11111111-1111-4111-8111-111111111111";
    const read = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(read.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initial = projectionFixture();
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));
    const terminal = runProjection({
      currentRun: terminalRun(resetRunId),
      resetRecoveryRunId: resetRunId,
      revision: 2,
    });
    act(() => {
      result.current.applyProjection(terminal);
      result.current.applyProjection(terminal);
    });
    expect(result.current.recovery).toEqual(available(initial));
    expect(fetchMock).toHaveBeenCalledOnce();
    read.resolve(jsonResponse({ ...initial, revision: 2, resetRecoveryRunId: resetRunId }));
    await act(async () => read.promise);
    await waitFor(() =>
      expect(result.current.recovery).toMatchObject({
        data: { currentRun: null, resetRecovery: "ready", resetRecoveryRunId: resetRunId },
      }),
    );
  });

  it("recovers global incomplete reset state while retaining an older completed scope", async () => {
    const completedRunId = "11111111-1111-4111-8111-111111111111";
    const resetRunId = "22222222-2222-4222-8222-222222222222";
    const completed = runProjection({ currentRun: terminalRun(completedRunId) });
    const recovered = {
      ...completed,
      resetRecoveryRunId: resetRunId,
      resetRecovery: "incomplete" as const,
      revision: 2,
      recoveredAt: "2026-06-20T00:00:14.000Z",
    };
    const read = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(read.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(completed)));
    const foreignReset = runProjection({
      currentRun: {
        ...drainingRun(resetRunId),
        status: "failed",
        trafficStatus: "failed",
        finalizedAt: "2026-06-20T00:00:13.000Z",
        failureCategory: "operator",
      },
      resetRecoveryRunId: resetRunId,
      resetRecovery: "incomplete",
      revision: 2,
      recoveredAt: "2026-06-20T00:00:13.000Z",
    });

    act(() => result.current.applyProjection(foreignReset));
    expect(result.current.recovery).toEqual(available(completed));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/dashboard/recovery?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=44444444-4444-4444-8444-444444444444",
      expect.anything(),
    );

    read.resolve(jsonResponse(recovered));
    await act(async () => read.promise);
    await waitFor(() => expect(result.current.recovery).toEqual(available(recovered)));
    expect(result.current.retainedTerminalRun?.runId).toBe(completedRunId);
    expect(
      deriveWatchComposition({
        recovery: result.current.recovery,
        retainedTerminalRun: result.current.retainedTerminalRun,
        latestCompletedRun: available(null),
        signalSamples: result.current.signalSamples,
        transportStatus: "connected",
        now: new Date("2026-06-20T00:00:14.000Z"),
      }).phase,
    ).toBe("reset-recovery");
  });

  it("reads rejected reset frames once per reset identity and never ahead of a scheduled retry", async () => {
    vi.useFakeTimers();
    const resetRunId = "22222222-2222-4222-8222-222222222222";
    const initial = projectionFixture();
    const incomplete = {
      ...initial,
      resetRecovery: "incomplete" as const,
      resetRecoveryRunId: resetRunId,
      revision: 2,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("Recovery limited", 429, "10"))
      .mockResolvedValueOnce(jsonResponse(incomplete))
      .mockResolvedValueOnce(
        jsonResponse({ ...incomplete, resetRecovery: "ready" as const, revision: 3 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));
    const foreignClaim = runProjection({
      currentRun: terminalRun(resetRunId),
      resetRecovery: "incomplete",
      resetRecoveryRunId: resetRunId,
      revision: 2,
    });

    act(() => result.current.applyProjection(foreignClaim));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.retryDelayMs).toBe(10_000);

    act(() => result.current.applyProjection(foreignClaim));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery).toEqual(available(incomplete));

    act(() => result.current.applyProjection(foreignClaim));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() =>
      result.current.applyProjection({ ...foreignClaim, resetRecovery: "ready", revision: 3 }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.recovery).toMatchObject({
      data: { resetRecovery: "ready", resetRecoveryRunId: resetRunId },
    });
  });

  it("applies terminal projection immediately and remains quiet without polling", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const terminal = runProjection({
      revision: 2,
      recoveredAt: "2026-06-20T00:00:12.000Z",
      currentRun: terminalRun(),
    });
    const { result } = renderHook(() => useDashboardRecovery(available(runProjection())));

    act(() => result.current.applyProjection(terminal));
    expect(result.current.recovery).toEqual(available(terminal));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a scheduled retry and suppresses completion updates after unmount", async () => {
    vi.useFakeTimers();
    const request = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() =>
      useDashboardRecovery(available(projectionFixture())),
    );

    act(() => void result.current.refresh());
    unmount();
    request.resolve(errorResponse("down", 503));
    await act(async () => request.promise);
    await act(async () => vi.runAllTimersAsync());
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function projectionFixture(overrides: Partial<DashboardProjection> = {}): DashboardProjection {
  return {
    schema: dashboardProjectionSchemaName,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    scopeId: "idle",
    revision: 1,
    correlationId: "corr-web-recovery",
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
    runtimeProgress: null,
    ...overrides,
  };
}

function runProjection(overrides: Partial<DashboardProjection> = {}): DashboardProjection {
  const currentRun = overrides.currentRun ?? activeRun();
  const scope = scopeForRun(currentRun);
  return projectionFixture({
    scope,
    scopeId: dashboardProjectionScopeId(scope),
    currentRun,
    ...overrides,
  });
}

function activeRun(runId = "11111111-1111-4111-8111-111111111111"): ActiveRun {
  return {
    runId,
    presetId: "33333333-3333-4333-8333-333333333333",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId: "44444444-4444-4444-8444-444444444444",
    startedAt: "2026-06-20T00:00:00.000Z",
    trafficStartedAt: "2026-06-20T00:00:00.000Z",
    configSnapshot: previewRunConfigSnapshotFixture(),
  };
}

function drainingRun(runId?: string): DrainingRun {
  return {
    ...activeRun(runId),
    status: "draining",
    trafficStatus: "succeeded",
    trafficEndedAt: "2026-06-20T00:00:11.000Z",
  };
}

function terminalRun(runId?: string): CompletedRun {
  return {
    ...drainingRun(runId),
    status: "completed",
    trafficStatus: "succeeded",
    finalizedAt: "2026-06-20T00:00:12.000Z",
  };
}

function scopeForRun(run: NonNullable<DashboardProjection["currentRun"]>) {
  if (!run.saleOfferId) throw new Error(`Run ${run.runId} fixture requires a sale offer.`);
  return { runId: run.runId, saleOfferId: run.saleOfferId };
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

function errorResponse(message: string, status: number, retryAfter?: string): Response {
  return new Response(
    JSON.stringify(
      errorPayloadSchema.parse({
        code: status === 429 ? "dashboard_recovery_rate_limited" : "backend_unavailable",
        message,
        correlationId: "hook-recovery-error",
        timestamp: "2026-06-20T00:00:00.000Z",
      }),
    ),
    {
      status,
      headers: {
        "content-type": "application/json",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    },
  );
}
