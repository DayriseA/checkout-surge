// @vitest-environment jsdom

import { type DashboardProjection, demoRunSnapshotSchema } from "@checkout-surge/contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComparisonReport, ComparisonWatch } from "../src/app/components/comparison-watch.js";
import { PublicComparisonEntry } from "../src/app/components/public-comparison-entry.js";
import {
  comparisonProgress,
  comparisonStageEvidence,
} from "../src/app/lib/presentation/comparison.js";
import {
  comparisonFixture,
  comparisonId,
  completedStage,
  missingComparisonResponse,
  projectionFixture,
  timestamp,
} from "./comparison-fixtures.js";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Set<EventListener>>();
  close = vi.fn();
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener);
  }
  emit(projection: DashboardProjection) {
    for (const listener of this.listeners.get("message") ?? [])
      listener(new MessageEvent("message", { data: JSON.stringify(projection) }));
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeEventSource.instances = [];
});

describe("public comparison", () => {
  it("closes the live stream and offers recovery links when a later poll confirms a missing comparison", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(missingComparisonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ComparisonWatch
        comparisonId={comparisonId}
        initialRead={{ status: "available", data: comparisonFixture() }}
      />,
    );
    const source = FakeEventSource.instances[0];
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(
      screen.getByRole("heading", { name: "This comparison could not be found" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.queryByText(/temporarily unavailable/)).toBeNull();
    expect(source?.close).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Run history" }).getAttribute("href")).toBe(
      "/run-history",
    );
    expect(screen.getByRole("link", { name: "Back to the demo" }).getAttribute("href")).toBe(
      "/demo",
    );
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("offers one fixed action, posts once, and navigates using only the accepted parent", async () => {
    const assign = vi.fn();
    const navigationWindow = Object.create(window);
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);
    const detail = comparisonFixture();
    const stage = detail.stages[0];
    if (stage.availability !== "pending") throw new Error("Expected pending fixture");
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetchMock = vi.fn().mockReturnValue(pending);
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<PublicComparisonEntry />);
    expect(container.querySelectorAll("input, select, textarea")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Start comparison" }));
    fireEvent.click(screen.getByRole("button", { name: "Starting your comparison…" }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/demo/comparisons/start");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: "{}" });
    await act(async () => {
      resolve(
        Response.json({
          comparisonId,
          run: stage.run,
          recovery: { establishedAt: timestamp },
          correlationId: "comparison-start",
          timestamp,
        }),
      );
      await pending;
    });
    expect(assign).toHaveBeenCalledWith(`/watch?comparisonId=${comparisonId}`);
  });

  it("does not retry a rejected start automatically and observes its Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PublicComparisonEntry />);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Start comparison" })),
    );
    expect(
      (screen.getByRole("button", { name: "Start comparison" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      (screen.getByRole("button", { name: "Start comparison" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("uses the matched wall-time cohorts and unique counts without inventing a winner", () => {
    const detail = comparisonFixture("completed", 3);
    detail.stages = detail.stages.map((stage) => completedStage(stage)) as typeof detail.stages;
    render(<ComparisonReport detail={detail} />);
    const stock = within(screen.getByRole("region", { name: "Stock checks" }));
    const queue = within(screen.getByRole("region", { name: "Order processing" }));
    expect(stock.getAllByText("28 ms")).toHaveLength(2);
    expect(queue.getAllByText("1.8 s")).toHaveLength(2);
    expect(queue.getAllByText("250")).toHaveLength(4);
    expect(queue.getAllByText("500")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "View this simulation’s report" })).toHaveLength(4);
    expect(screen.getByText(/Within each pair/)).toBeTruthy();
    expect(screen.getByText(/Accepted replies can include repeat/)).toBeTruthy();
    expect(screen.queryByText(/winner|faster by|expected failure/i)).toBeNull();
  });

  it("keeps unknown measurements distinct from recorded zero and explains stopped cleanup", () => {
    const detail = comparisonFixture("cleanup_pending");
    detail.stages[0] = completedStage(detail.stages[0]);
    if (detail.stages[0].availability !== "available")
      throw new Error("Expected available fixture");
    detail.stages[0].detail.summary.httpSummary.buyerWallLatencySummary = {
      accepted: null,
      soldOut: null,
    };
    render(<ComparisonReport detail={detail} />);
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0")).toHaveLength(2);
    expect(screen.getAllByText("Not run")).toHaveLength(3);
    expect(comparisonProgress(detail)).toBe("Finishing cleanup before the next visitor can start.");
    expect(comparisonProgress(detail)).not.toContain("next simulation");
    expect(comparisonStageEvidence(detail.stages[0])?.timing).toBeNull();
    detail.stages[0].detail.summary.dataDiscarded = true;
    expect(comparisonStageEvidence(detail.stages[0])).toBeNull();
  });

  it("ignores unrelated and old live frames and closes transports on child switch and parent termination", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const next = comparisonFixture("running", 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json(next))
      .mockResolvedValueOnce(Response.json(comparisonFixture("failed", 1)));
    vi.stubGlobal("fetch", fetchMock);
    const initial = comparisonFixture();
    render(
      <ComparisonWatch
        comparisonId={comparisonId}
        initialRead={{ status: "available", data: initial }}
      />,
    );
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("Expected source");
    act(() => source.emit(projectionFixture(next, 10)));
    expect(screen.queryByText("17")).toBeNull();
    act(() => source.emit(projectionFixture(initial, 2)));
    expect(screen.getByText("17")).toBeTruthy();
    const old = projectionFixture(initial, 1);
    if (old.businessOutcome) old.businessOutcome.acceptedReservations = 999;
    act(() => source.emit(old));
    expect(screen.queryByText("999")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(source.close).toHaveBeenCalledOnce();
    expect(screen.queryByText("17")).toBeNull();
    const second = FakeEventSource.instances[1];
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(second?.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a terminal child's stream without completing the parent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const detail = comparisonFixture();
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(detail)));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <ComparisonWatch
        comparisonId={comparisonId}
        initialRead={{ status: "available", data: detail }}
      />,
    );
    const terminal = projectionFixture(detail, 2);
    terminal.currentRun = demoRunSnapshotSchema.parse({
      ...terminal.currentRun,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: timestamp,
      finalizedAt: timestamp,
    });
    act(() => FakeEventSource.instances[0]?.emit(terminal));
    expect(FakeEventSource.instances[0]?.close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "Comparison results" })).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(FakeEventSource.instances).toHaveLength(1);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
