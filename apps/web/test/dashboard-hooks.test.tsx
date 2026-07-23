// @vitest-environment jsdom

import {
  type DashboardProjection,
  dashboardEventsPath,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  errorPayloadSchema,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboardProjections } from "../src/app/components/realtime/use-dashboard-projections.js";
import { useDashboardRecovery } from "../src/app/components/realtime/use-dashboard-recovery.js";
import type { BackendRead } from "../src/app/lib/api.js";

type ActiveRun = Extract<NonNullable<DashboardProjection["currentRun"]>, { status: "active" }>;
type DrainingRun = Extract<NonNullable<DashboardProjection["currentRun"]>, { status: "draining" }>;
type CompletedRun = Extract<
  NonNullable<DashboardProjection["currentRun"]>,
  { status: "completed" }
>;

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

describe("useDashboardProjections", () => {
  it("accepts complete projection frames and ignores malformed data", () => {
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    const onOpen = vi.fn();
    const onDisconnect = vi.fn();
    const { result, rerender, unmount } = renderHook(
      ({ onProjection }) =>
        useDashboardProjections({
          eventSourceConstructor: InjectedEventSource,
          onProjection,
          onOpen,
          onDisconnect,
        }),
      { initialProps: { onProjection: firstCallback } },
    );
    const source = InjectedEventSource.instances[0];
    expect(source?.url).toBe(dashboardEventsPath);
    expect(result.current).toBe("connecting");

    act(() => source?.emit("message", new MessageEvent("message", { data: "{" })));
    expect(firstCallback).not.toHaveBeenCalled();

    rerender({ onProjection: secondCallback });
    expect(InjectedEventSource.instances).toHaveLength(1);
    act(() => source?.emit("open", new Event("open")));
    expect(result.current).toBe("connected");
    expect(onOpen).toHaveBeenCalledOnce();

    const projection = projectionFixture();
    act(() =>
      source?.emit("message", new MessageEvent("message", { data: JSON.stringify(projection) })),
    );
    expect(firstCallback).not.toHaveBeenCalled();
    expect(secondCallback).toHaveBeenCalledWith(projection);

    act(() => source?.emit("error", new Event("error")));
    expect(result.current).toBe("disconnected");
    expect(onDisconnect).toHaveBeenCalledOnce();

    unmount();
    expect(source?.close).toHaveBeenCalledOnce();
    expect([...(source?.listeners.values() ?? [])].every((listeners) => listeners.size === 0)).toBe(
      true,
    );
  });
});

describe("useDashboardRecovery", () => {
  it("keeps initial loading fail-closed and retries once after Strict Mode effect replay", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(projectionFixture()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(
      () =>
        useDashboardRecovery({
          status: "unavailable",
          reason: "Authoritative run state is loading.",
        }),
      {
        wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
      },
    );

    expect(result.current.recovery.status).toBe("unavailable");
    expect(result.current.hasSyncIssue).toBe(false);
    expect(result.current.syncIssue).toBeNull();
    expect(result.current.isRetryScheduled).toBe(true);
    expect(result.current.retryDelayMs).toBe(1_000);
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
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
      useDashboardRecovery({ status: "unavailable", reason: "Authoritative state loading" }),
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
    const request = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => request.promise);
    vi.stubGlobal("fetch", fetchMock);
    const initial = runProjection();
    const next = runProjection({ revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" });
    const { result } = renderHook(() => useDashboardRecovery(available(initial)));

    let first!: Promise<void>;
    act(() => {
      first = result.current.refresh();
      void result.current.refresh();
      void result.current.refresh();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/dashboard/recovery?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=44444444-4444-4444-8444-444444444444",
    );

    request.resolve(jsonResponse(next));
    await act(async () => first);
    expect(result.current.recovery).toEqual(available(next));
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
    expect(result.current.liveProjectionCount).toBe(1);

    request.resolve(jsonResponse(staleRead));
    await act(async () => request.promise);
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.recovery).toEqual(available(liveTerminal));
    expect(fetchMock).toHaveBeenCalledOnce();
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
    version: dashboardProjectionSchemaVersion,
    scopeId: "idle",
    revision: 1,
    correlationId: "corr-web-recovery",
    scope: null,
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAttemptCounts: null,
    recentCompletionOutcomes: [],
    recoveredAt: "2026-06-20T00:00:10.000Z",
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

function activeRun(): ActiveRun {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
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

function drainingRun(): DrainingRun {
  return {
    ...activeRun(),
    status: "draining",
    trafficStatus: "succeeded",
    trafficEndedAt: "2026-06-20T00:00:11.000Z",
  };
}

function terminalRun(): CompletedRun {
  return {
    ...drainingRun(),
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
