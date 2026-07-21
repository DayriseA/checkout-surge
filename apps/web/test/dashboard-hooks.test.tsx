// @vitest-environment jsdom

import {
  type DashboardEvent,
  type DashboardRecoveryResponse,
  dashboardEventsPath,
  demoRunSnapshotSchema,
  errorPayloadSchema,
} from "@checkout-surge/contracts";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
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
  vi.useRealTimers();
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
        }),
      { initialProps: { onEvent: firstCallback } },
    );
    const source = InjectedEventSource.instances[0];
    expect(source).toBeDefined();
    expect(source?.url).toBe(dashboardEventsPath);
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
    act(() => source?.emit("open", new Event("open")));
    expect(result.current).toBe("connected");
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(InjectedEventSource.instances).toHaveLength(1);

    unmount();
    expect(source?.close).toHaveBeenCalledOnce();
    expect([...(source?.listeners.values() ?? [])].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
  });
});

describe("useDashboardRecovery", () => {
  it("keeps the initial retry at one second during Strict Mode effect replay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(recoveryFixture()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(
      () =>
        useDashboardRecovery({
          status: "unavailable",
          reason: "API starting",
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
      },
    );

    expect(result.current.isRetryScheduled).toBe(true);
    expect(result.current.retryAttempt).toBe(1);
    expect(result.current.retryDelayMs).toBe(1_000);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps an unavailable reason visible, schedules one retry, and resets after success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("API restarting", 503))
      .mockResolvedValueOnce(jsonResponse(recoveryFixture("2026-06-20T00:00:13.000Z")));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(recoveryFixture())));

    await act(async () => result.current.refresh());
    expect(result.current.recovery).toMatchObject({
      status: "unavailable",
      reason: "API restarting",
    });
    expect(result.current.hasSyncIssue).toBe(true);
    expect(result.current.isRetryScheduled).toBe(true);
    expect(result.current.retryAttempt).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery.status).toBe("available");
    expect(result.current.hasSyncIssue).toBe(false);
    expect(result.current.isRetryScheduled).toBe(false);
    expect(result.current.retryAttempt).toBe(0);
  });

  it("retains a Watch snapshot and exposes one separate sync issue after refresh failure", async () => {
    vi.useFakeTimers();
    const initialRecovery = available(recoveryFixture());
    const fetchMock = vi.fn().mockResolvedValue(errorResponse("API restarting", 503));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useDashboardRecovery(initialRecovery, { preserveAvailableRecoveryOnFailure: true }),
    );

    await act(async () => result.current.refresh());

    expect(result.current.recovery).toEqual(initialRecovery);
    expect(result.current.syncIssue).toMatchObject({
      status: "unavailable",
      reason: "API restarting",
      httpStatus: 503,
    });
    expect(result.current.hasSyncIssue).toBe(true);
    expect(result.current.isRetryScheduled).toBe(true);
  });

  it("honors Retry-After for 429 recovery and converges to idle without a reload", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("Recovery limited", 429, "10"))
      .mockResolvedValueOnce(jsonResponse(recoveryFixture("2026-06-20T00:00:30.000Z")));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useDashboardRecovery({ status: "unavailable", reason: "Authoritative state loading" }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.recovery).toMatchObject({
      status: "unavailable",
      httpStatus: 429,
      retryAfterMs: 10_000,
    });
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery).toEqual(available(recoveryFixture("2026-06-20T00:00:30.000Z")));
  });

  it("polls an active run at a bounded cadence and converges when it becomes terminal", async () => {
    vi.useFakeTimers();
    const run = runFixture("22222222-2222-4222-8222-222222222222", "2026-06-20T00:00:00.000Z");
    const activeRecovery = {
      ...recoveryFixture(),
      scope: { runId: run.runId, saleOfferId: run.saleOfferId ?? null },
      currentRun: run,
    };
    const terminalRecovery = recoveryFixture("2026-06-20T00:00:40.000Z");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(terminalRecovery));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(activeRecovery)));

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.recovery).toEqual(available(terminalRecovery));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not turn ordinary buffered events into a follow-up after a failed read retries", async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const retry = deferred<Response>();
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => retry.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(recoveryFixture())));

    act(() => {
      void result.current.refresh();
      void result.current.refresh();
      result.current.applyEvent(eventFixture());
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    first.resolve(errorResponse("still down", 503));
    await act(async () => first.promise);
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.isRetryScheduled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    retry.resolve(jsonResponse(recoveryFixture("2026-06-20T00:00:13.000Z")));
    await act(async () => retry.promise);
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.isRefreshing).toBe(false);
  });

  it("cancels scheduled retry and suppresses completion updates after unmount", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() =>
      useDashboardRecovery(available(recoveryFixture())),
    );
    act(() => void result.current.refresh());
    unmount();
    pending.resolve(errorResponse("down", 503));
    await act(async () => pending.promise);
    await act(async () => vi.runAllTimersAsync());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps a locally scheduled retry authoritative across later prop status changes", async () => {
    vi.useFakeTimers();
    const recovered = recoveryFixture("2026-06-20T00:00:20.000Z");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("local recovery unavailable", 503))
      .mockResolvedValueOnce(jsonResponse(recovered));
    vi.stubGlobal("fetch", fetchMock);
    const initial = available(recoveryFixture());
    const { result, rerender } = renderHook(({ recovery }) => useDashboardRecovery(recovery), {
      initialProps: { recovery: initial as BackendRead<DashboardRecoveryResponse> },
    });

    await act(async () => result.current.refresh());
    expect(result.current.isRetryScheduled).toBe(true);
    rerender({
      recovery: {
        status: "unavailable",
        reason: "stale prop snapshot",
        httpStatus: 502,
      },
    });
    expect(result.current.recovery).toMatchObject({
      status: "unavailable",
      reason: "local recovery unavailable",
    });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery).toEqual(available(recovered));
    expect(result.current.isRetryScheduled).toBe(false);
  });

  it("cancels an already scheduled retry on unmount", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(errorResponse("API restarting", 503));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() =>
      useDashboardRecovery(available(recoveryFixture())),
    );

    await act(async () => result.current.refresh());
    expect(result.current.isRetryScheduled).toBe(true);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("coalesces duplicate refreshes and reconciles ordinary events without a follow-up", async () => {
    const first = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => first.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initialRecovery = available(recoveryFixture());
    const { result } = renderHook(() => useDashboardRecovery(initialRecovery));

    let firstRefresh!: Promise<void>;
    act(() => {
      firstRefresh = result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    act(() => {
      result.current.applyEvent(queueDepthEvent("2026-06-20T00:00:12.000Z", 7));
      void result.current.refresh();
      void result.current.refresh();
    });
    first.resolve(
      jsonResponse({
        ...recoveryFixture("2026-06-20T00:00:11.000Z"),
        queue: queueFixture("2026-06-20T00:00:11.000Z"),
      }),
    );
    await act(async () => firstRefresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.isRefreshing).toBe(false);
    expect(result.current.liveEventCount).toBe(1);
    expect(result.current.recovery).toMatchObject({
      status: "available",
      data: { queue: { depth: 7, updatedAt: "2026-06-20T00:00:12.000Z" } },
    });
  });

  it("bounds a mixed sustained stream and defers trailing-read convergence to 30 seconds", async () => {
    vi.useFakeTimers();
    const first = deferred<Response>();
    const trailing = deferred<Response>();
    const run = runFixture("11111111-1111-4111-8111-111111111111", "2026-06-20T00:00:00.000Z");
    const drainingRun = demoRunSnapshotSchema.parse({
      ...run,
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:11.000Z",
    });
    const terminalRun = demoRunSnapshotSchema.parse({
      ...drainingRun,
      status: "completed",
      finalizedAt: "2026-06-20T00:00:12.000Z",
    });
    const initial = available({
      ...recoveryFixture(),
      scope: { runId: run.runId, saleOfferId: run.saleOfferId ?? null },
      currentRun: run,
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => trailing.promise)
      .mockResolvedValueOnce(
        jsonResponse({
          ...recoveryFixture("2026-06-20T00:01:31.000Z"),
          scope: { runId: run.runId, saleOfferId: run.saleOfferId ?? null },
          currentRun: terminalRun,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(initial));

    act(() => void result.current.refresh());
    expect(fetchMock).toHaveBeenCalledOnce();
    act(() => {
      applyMixedEventBurst(result.current.applyEvent, run, 0);
      result.current.applyEvent(runEventFixture(terminalRun));
    });
    first.resolve(
      jsonResponse({
        ...recoveryFixture("2026-06-20T00:00:30.000Z"),
        scope: { runId: run.runId, saleOfferId: run.saleOfferId ?? null },
        currentRun: drainingRun,
        queue: queueFixture("2026-06-20T00:00:30.000Z"),
      }),
    );
    await act(async () => first.promise);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => {
      applyMixedEventBurst(result.current.applyEvent, run, 100);
      result.current.applyEvent(runEventFixture(terminalRun));
    });
    trailing.resolve(
      jsonResponse({
        ...recoveryFixture("2026-06-20T00:00:31.000Z"),
        scope: { runId: run.runId, saleOfferId: run.saleOfferId ?? null },
        currentRun: drainingRun,
        queue: queueFixture("2026-06-20T00:00:31.000Z"),
      }),
    );
    await act(async () => trailing.promise);
    await act(async () => Promise.resolve());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.recovery).toMatchObject({
      status: "available",
      data: {
        currentRun: { status: "completed" },
        queue: { depth: 104 },
        recentMetrics: [expect.objectContaining({ metricName: "traffic.latency", value: 109 })],
      },
    });
    expect(result.current.recentOrderStates).toHaveLength(20);
    expect(result.current.recentOrderStates.at(-1)?.orderId).toBe(uuidFor(1_124));
    expect(result.current.recentOrderLagSamples).toHaveLength(20);
    expect(result.current.recentOrderLagSamples.at(-1)?.eventId).toBe(uuidFor(3_124));

    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("converges with exactly one recovery when a matching terminal event predates the recovery watermark", async () => {
    const baseRun = runFixture("11111111-1111-4111-8111-111111111111", "2026-06-20T00:00:00.000Z");
    const drainingRun = demoRunSnapshotSchema.parse({
      runId: baseRun.runId,
      presetId: baseRun.presetId,
      presetName: baseRun.presetName,
      operatorMode: baseRun.operatorMode,
      status: "draining",
      trafficStatus: "succeeded",
      saleOfferId: baseRun.saleOfferId,
      startedAt: baseRun.startedAt,
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
      trafficEndedAt: "2026-06-20T00:00:11.000Z",
      configSnapshot: baseRun.configSnapshot,
    });
    // Finalization captured t0 before the t1 recovery read; the terminal
    // commit landed after that stale read.
    const finalizationAttemptT0 = "2026-06-20T00:00:12.000Z";
    const recoveryStartT1 = "2026-06-20T00:00:30.000Z";
    const terminalEvent: DashboardEvent = {
      type: "load.run.updated",
      runId: drainingRun.runId,
      correlationId: "corr-terminal-overlap",
      occurredAt: finalizationAttemptT0,
      run: demoRunSnapshotSchema.parse({
        ...drainingRun,
        status: "completed",
        finalizedAt: finalizationAttemptT0,
      }),
    };
    const staleRecovery = {
      ...recoveryFixture(recoveryStartT1),
      scope: { runId: drainingRun.runId, saleOfferId: drainingRun.saleOfferId ?? null },
      currentRun: drainingRun,
    };
    const authoritativeIdle = recoveryFixture("2026-06-20T00:00:31.000Z");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(authoritativeIdle));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(staleRecovery)));

    act(() => result.current.applyEvent(terminalEvent));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.recovery).toEqual(available(authoritativeIdle)));
    expect(result.current.isRefreshing).toBe(false);

    // Convergence is stable: a duplicate terminal signal must not loop recovery.
    act(() => result.current.applyEvent(terminalEvent));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.recovery).toEqual(available(authoritativeIdle));
  });

  it("coalesces an overlapping idle new-run hint into one recovery that reveals the run", async () => {
    const startCapturedAtT0 = "2026-06-20T00:00:20.000Z";
    const idleRecoveryCompletedAtT1 = "2026-06-20T00:00:30.000Z";
    const eventDeliveredAtT2 = "2026-06-20T00:00:31.000Z";
    const newRun = runFixture("22222222-2222-4222-8222-222222222222", startCapturedAtT0);
    const overlappingEvent: DashboardEvent = {
      ...runEventFixture(newRun),
      occurredAt: startCapturedAtT0,
    };
    const idleRecovery = recoveryFixture(idleRecoveryCompletedAtT1);
    const authoritativeRecovery = {
      ...recoveryFixture(eventDeliveredAtT2),
      scope: { runId: newRun.runId, saleOfferId: newRun.saleOfferId ?? null },
      currentRun: newRun,
    };
    const request = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDashboardRecovery(available(idleRecovery)));

    act(() => {
      result.current.applyEvent(overlappingEvent);
      result.current.applyEvent(overlappingEvent);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(result.current.recovery).toEqual(available(idleRecovery));
    expect(result.current.isRefreshing).toBe(true);

    request.resolve(jsonResponse(authoritativeRecovery));
    await waitFor(() => expect(result.current.recovery).toEqual(available(authoritativeRecovery)));
    expect(result.current.isRefreshing).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();

    act(() => result.current.applyEvent(overlappingEvent));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("clears old-run projections immediately and serializes recovery after a new-run event", async () => {
    const first = deferred<Response>();
    const newRun = runFixture("22222222-2222-4222-8222-222222222222", "2026-06-20T00:01:00.000Z");
    const authoritativeRecovery = {
      ...recoveryFixture("2026-06-20T00:01:02.000Z"),
      scope: { runId: newRun.runId, saleOfferId: newRun.saleOfferId },
      currentRun: newRun,
    };
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(jsonResponse(authoritativeRecovery));
    vi.stubGlobal("fetch", fetchMock);
    const oldRecovery = {
      ...recoveryFixture(),
      currentRun: runFixture("11111111-1111-4111-8111-111111111111", "2026-06-20T00:00:00.000Z"),
      recentMetrics: [
        {
          metricName: "queue.depth",
          value: 7,
          unit: "jobs",
          timestamp: "2026-06-20T00:00:10.000Z",
        },
      ],
    };
    const { result } = renderHook(() => useDashboardRecovery(available(oldRecovery)));

    act(() => result.current.applyEvent(runEventFixture(newRun)));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(result.current.recovery.status).toBe("available");
    if (result.current.recovery.status !== "available") {
      throw new Error("Expected the incoming run snapshot to remain available.");
    }
    expect(result.current.recovery.data.currentRun).toEqual(newRun);
    expect(result.current.recovery.data.recentMetrics).toEqual([]);
    expect(result.current.isRefreshing).toBe(true);

    act(() => result.current.applyEvent(eventFixture()));
    first.resolve(jsonResponse(authoritativeRecovery));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.liveEventCount).toBe(2);
  });
});

function eventFixture(): DashboardEvent {
  return {
    type: "dashboard.metric.observed",
    correlationId: "corr-live",
    occurredAt: "2026-06-20T00:00:11.000Z",
    observedAt: "2026-06-20T00:00:11.000Z",
    metricName: "queue.depth",
    value: 3,
    unit: "jobs",
    queueName: "orders:process",
  };
}

function applyMixedEventBurst(
  applyEvent: (event: DashboardEvent) => void,
  run: NonNullable<DashboardRecoveryResponse["currentRun"]>,
  offset: number,
) {
  for (let index = 0; index < 5; index += 1) {
    const observedAt = eventTime(offset + index);
    applyEvent(queueDepthEvent(observedAt, offset + index));
    applyEvent({
      type: "dashboard.metric.observed",
      runId: run.runId,
      correlationId: `corr-latency-${offset + index}`,
      occurredAt: observedAt,
      observedAt,
      metricName: "traffic.latency",
      value: offset + index + 5,
      unit: "ms",
    });
  }

  for (let index = 0; index < 25; index += 1) {
    const identity = offset + index;
    const occurredAt = eventTime(identity + 10);
    const orderId = uuidFor(1_000 + identity);
    const transitionEventId = uuidFor(2_000 + identity);
    applyEvent({
      type: "order.status.updated",
      eventId: transitionEventId,
      orderId,
      publicOrderId: `ord-${identity}`,
      saleOfferId: run.saleOfferId ?? "44444444-4444-4444-8444-444444444444",
      runId: run.runId,
      correlationId: `corr-order-${identity}`,
      occurredAt,
      eventName: "order.processing",
      previousStatus: "queued",
      status: "processing",
      customerStatus: "processing",
      attemptNumber: 1,
      attemptsMade: 0,
    });
    const confirmedAt = eventTime(identity + 40);
    applyEvent({
      type: "dashboard.metric.observed",
      eventId: uuidFor(3_000 + identity),
      confirmedTransitionEventId: transitionEventId,
      orderId,
      publicOrderId: `ord-${identity}`,
      saleOfferId: run.saleOfferId ?? "44444444-4444-4444-8444-444444444444",
      runId: run.runId,
      correlationId: `corr-lag-${identity}`,
      occurredAt: confirmedAt,
      observedAt: confirmedAt,
      metricName: "order.consistency_lag",
      value: 10,
      unit: "ms",
      startedAt: new Date(Date.parse(confirmedAt) - 10).toISOString(),
      confirmedAt,
    });
  }
}

function queueDepthEvent(observedAt: string, value: number): DashboardEvent {
  return {
    type: "dashboard.metric.observed",
    correlationId: `corr-queue-${value}`,
    occurredAt: observedAt,
    observedAt,
    metricName: "queue.depth",
    value,
    unit: "jobs",
    queueName: "orders:process",
  };
}

function queueFixture(updatedAt: string): NonNullable<DashboardRecoveryResponse["queue"]> {
  return {
    name: "orders:process",
    connectivity: "reachable",
    depth: 0,
    counts: { waiting: 0, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
    oldestWaitingAgeSeconds: null,
    retryPressure: {
      inspectedJobCount: 0,
      inspectionLimit: 100,
      retryingJobCount: 0,
      retryAttemptCount: 0,
      inspectionTruncated: false,
    },
    failedJobs: {
      totalCount: 0,
      recent: [],
      inspectionLimit: 20,
      inspectionTruncated: false,
    },
    updatedAt,
  };
}

function eventTime(offsetMs: number): string {
  return new Date(Date.parse("2026-06-20T00:01:00.000Z") + offsetMs).toISOString();
}

function uuidFor(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function runEventFixture(
  run: NonNullable<DashboardRecoveryResponse["currentRun"]>,
): DashboardEvent {
  return {
    type: "load.run.updated",
    runId: run.runId,
    correlationId: "corr-run-live",
    occurredAt: "2026-06-20T00:01:01.000Z",
    run,
  };
}

function runFixture(
  runId: string,
  startedAt: string,
): NonNullable<DashboardRecoveryResponse["currentRun"]> {
  return {
    runId,
    presetId: "33333333-3333-4333-8333-333333333333",
    presetName: "Hook run",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId: "44444444-4444-4444-8444-444444444444",
    startedAt,
    trafficStartedAt: startedAt,
    configSnapshot: {
      trafficConfig: {
        mode: "buyer-spike",
        buyerCount: 100,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 2,
        quantityPerAttempt: 1,
      },
      inventoryConfig: {
        startingStock: 25,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 15,
      },
      erpConfig: {
        latencyMs: 80,
        maxTps: 250,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 2_000,
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 5,
        retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
        drainTimeoutSeconds: 300,
        pendingPersistenceRetryAfterSeconds: 30,
        circuitBreakerFailureThreshold: 5,
        circuitBreakerResetTimeoutMs: 10_000,
      },
    },
  };
}

function recoveryFixture(recoveredAt = "2026-06-20T00:00:10.000Z"): DashboardRecoveryResponse {
  return {
    correlationId: "corr-web-recovery",
    scope: null,
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAccounting: null,
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
    { status, ...(retryAfter ? { headers: { "retry-after": retryAfter } } : {}) },
  );
}
