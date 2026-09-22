// @vitest-environment jsdom

import {
  type DashboardProjection,
  type DemoPresetContract,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  demoRunSnapshotSchema,
  deriveRunResult,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  errorPayloadSchema,
  type HealthResponse,
  type PublicPresetListResponse,
  type PublicRunHistoryDetailResponse,
  type PublicRuntimePolicy,
  type PublicRuntimePolicyResponse,
  publicRunHistorySummarySchema,
  type RunHistoryListItem,
  type RunHistoryListResponse,
  type RunHistorySummary,
  runSignalBucketCount,
  type ServerReservationTimingSummary,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture as configSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminPage from "../src/app/admin/page.js";
import { OperatorDashboard } from "../src/app/components/operator-dashboard.js";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry.js";
import { useAcceptedRunResult } from "../src/app/components/realtime/use-accepted-run-result.js";
import { RunHistoryAdminControls } from "../src/app/components/run-history-admin-controls.js";
import { RunHistoryList } from "../src/app/components/run-history-list.js";
import DemoDashboardPage from "../src/app/demo/page.js";
import type { BackendRead, PublicDemoSurface } from "../src/app/lib/api";
import {
  getPublicDemoSurface,
  getRunHistoryDetail,
  getRunHistoryPage,
  pendingDashboardRecovery,
} from "../src/app/lib/api.js";
import {
  dashboardRecoveryProxyPath,
  demoRunStartProxyPath,
  healthReadyProxyPath,
  publicRunHistoryDetailProxyPath,
} from "../src/app/lib/control-paths.js";
import { acceptedRunResultFromRead } from "../src/app/lib/presentation/accepted-run-result.js";
import OverviewPage from "../src/app/page.js";
import RunHistoryDetailPage from "../src/app/run-history/[runId]/page.js";
import RunHistoryPage from "../src/app/run-history/page.js";
import WatchPage from "../src/app/watch/page.js";

// Admission timing is exercised with the real transport in run-estimate.test.tsx.
// These existing workflows isolate their recovery, validation and mutation boundaries.
vi.mock("../src/app/components/use-run-estimate", () => ({
  useRunEstimate: () => ({ state: { status: "inactive" }, blocksStart: false, reject: vi.fn() }),
}));

vi.mock("../src/app/lib/api.js", () => ({
  getAdminRunHistoryDetail: vi.fn(),
  getPublicDemoSurface: vi.fn(),
  getRunHistoryDetail: vi.fn(),
  getRunHistoryPage: vi.fn(),
  pendingDashboardRecovery: vi.fn(() => ({
    status: "loading",
  })),
}));
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: vi.fn(async () => false),
}));
vi.mock("../src/app/lib/server/admin-reads.js", () => ({
  readAdminErpChaos: vi.fn(),
  readAdminPresets: vi.fn(),
  readAdminRuntimePolicy: vi.fn(),
  readAdminReadiness: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

type FetchCall = [input: string | URL | Request, init: RequestInit | undefined];
type FetchMock = {
  mock: {
    calls: unknown[][];
  };
};

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];

  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly close = vi.fn();
  readonly listeners = new Map<string, Set<EventListener>>();
  readyState = FakeEventSource.CONNECTING;
  readonly url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
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
  FakeEventSource.instances = [];
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("public browser starts", () => {
  it.each([
    ["curated", "lost"],
    ["curated", "malformed"],
    ["custom", "lost"],
    ["custom", "malformed"],
  ] as const)("releases %s pending state after a %s start response without claiming acceptance", async (entry, failure) => {
    const recovery = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) {
        return Promise.resolve(jsonResponse(readinessFixture()));
      }
      if (String(input) === demoRunStartProxyPath) {
        if (failure === "lost") return Promise.reject(new Error("QA response lost"));
        return Promise.resolve(new Response("not-json", { status: 202 }));
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) return recovery.promise;
      return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    if (entry === "custom") await user.click(screen.getByText("Customize a scenario"));
    const start = screen.getByRole("button", {
      name: entry === "custom" ? "Start custom run" : "Start Preview 1k",
    }) as HTMLButtonElement;
    await user.click(start);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(dashboardRecoveryProxyPath),
        expect.anything(),
      ),
    );
    expect(start.disabled).toBe(true);
    expect(screen.queryByText("ready")).toBeNull();
    await waitFor(() => expect(screen.getByText("Checking run status")).toBeTruthy());
    expect(screen.queryByText("Run accepted.")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(1);
    if (entry === "custom") {
      const summary = await screen.findByRole("alert", { name: "Operation failure" });
      expect(document.activeElement).toBe(summary);
    } else {
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.queryByRole("alert", { name: "Operation failure" })).toBeNull();
    }

    recovery.resolve(
      jsonResponse(
        dashboardRecoveryFixture({
          currentRun: demoRunFixture({ status: "active" }),
          recoveredAt: "2026-06-20T00:00:11.000Z",
          revision: 2,
        }),
      ),
    );
    expect(await screen.findByText("A demo run is already in progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(start.disabled).toBe(true);
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();
    if (entry === "curated") {
      expect(screen.queryByText("We couldn't confirm whether your run started")).toBeNull();
    }
    expect(screen.queryByText("Run accepted.")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(1);
  });

  it("keeps checking run status past start retry expiry until recovery completes", async () => {
    vi.useFakeTimers();
    const recovery = deferred<Response>();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) {
        return new Response(
          JSON.stringify(
            errorPayloadSchema.parse({
              code: "backend_unavailable",
              message: "Start response unavailable.",
              correlationId: "uncertain-start",
              timestamp: "2026-06-20T00:00:00.000Z",
            }),
          ),
          { status: 503, headers: { "content-type": "application/json", "retry-after": "1" } },
        );
      }
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input).startsWith(dashboardRecoveryProxyPath)) return recovery.promise;
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(start);
    });
    expect(recoveryFetchCount(fetchMock)).toBe(1);
    expect(readinessFetchCount(fetchMock)).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_100));
    expect(screen.getByText("Checking run status")).toBeTruthy();
    expect(screen.queryByText("ready")).toBeNull();
    expect(start.disabled).toBe(true);

    await act(async () => {
      recovery.resolve(jsonResponse(dashboardRecoveryFixture({ revision: 2 })));
    });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByText("Checking run status")).toBeNull();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(start.disabled).toBe(false);
  });

  it("re-enables starts with the uncertain notice when reconciliation finds no current run", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) {
        return Promise.resolve(jsonResponse(readinessFixture()));
      }
      if (String(input) === demoRunStartProxyPath) {
        return Promise.reject(new Error("QA response lost"));
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        return Promise.resolve(jsonResponse(dashboardRecoveryFixture()));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;
    await user.click(start);

    expect(await screen.findByText("We couldn't confirm whether your run started")).toBeTruthy();
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(recoveryFetchCount(fetchMock)).toBe(1);
    expect(readinessFetchCount(fetchMock)).toBe(1);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(recoveryFetchCount(fetchMock)).toBe(2));
    await waitFor(() => expect(readinessFetchCount(fetchMock)).toBe(2));
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(1);
    expect(start.disabled).toBe(false);
  });

  it("waits for a fresh recovery read when one was already in flight at click time", async () => {
    vi.useFakeTimers();
    const reads = [deferred<Response>(), deferred<Response>()];
    let readIndex = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) {
        return Promise.resolve(jsonResponse(readinessFixture()));
      }
      if (String(input) === demoRunStartProxyPath) {
        return Promise.reject(new Error("QA response lost"));
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        const read = reads[readIndex];
        readIndex += 1;
        if (!read) return Promise.resolve(jsonResponse(dashboardRecoveryFixture()));
        return read.promise;
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(recoveryFetchCount(fetchMock)).toBe(1);

    await act(async () => {
      fireEvent.click(start);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(start.disabled).toBe(true);
    expect(recoveryFetchCount(fetchMock)).toBe(1);

    reads[0]?.resolve(jsonResponse(dashboardRecoveryFixture()));
    await act(async () => {
      await reads[0]?.promise;
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(recoveryFetchCount(fetchMock)).toBe(2);
    expect(start.disabled).toBe(true);
    expect(screen.queryByText("ready")).toBeNull();
    expect(screen.getByText("Checking run status")).toBeTruthy();

    reads[1]?.resolve(
      jsonResponse(
        dashboardRecoveryFixture({
          currentRun: demoRunFixture({ status: "active" }),
          recoveredAt: "2026-06-20T00:00:11.000Z",
          revision: 2,
        }),
      ),
    );
    await act(async () => {
      await reads[1]?.promise;
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    });
    expect(screen.getByText("A demo run is already in progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(start.disabled).toBe(true);
  });

  it("holds the checking gate until readiness completes after an uncertain start", async () => {
    const readiness = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) return readiness.promise;
      if (String(input) === demoRunStartProxyPath) {
        return Promise.reject(new Error("QA response lost"));
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        return Promise.resolve(jsonResponse(dashboardRecoveryFixture()));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;
    await user.click(start);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(dashboardRecoveryProxyPath),
        expect.anything(),
      ),
    );
    await waitFor(() => expect(screen.getByText("Checking run status")).toBeTruthy());
    expect(screen.queryByText("ready")).toBeNull();
    expect(start.disabled).toBe(true);

    readiness.resolve(jsonResponse(readinessFixture()));
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("We couldn't confirm whether your run started")).toBeTruthy();
  });

  it("keeps starts disabled when post-start recovery fails while readiness is healthy", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) {
        return Promise.resolve(jsonResponse(readinessFixture()));
      }
      if (String(input) === demoRunStartProxyPath) {
        return Promise.reject(new Error("QA response lost"));
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        return Promise.resolve(
          jsonResponse(
            errorPayloadSchema.parse({
              code: "backend_unavailable",
              message: "Private recovery failure.",
              correlationId: "post-start-recovery-failure",
              timestamp: "2026-06-20T00:00:00.000Z",
            }),
            503,
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;
    await user.click(start);

    await waitFor(() => expect(recoveryFetchCount(fetchMock)).toBe(1));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Starting Preview 1k" })).toBeNull(),
    );
    expect(start.disabled).toBe(true);
    expect(screen.queryByText("ready")).toBeNull();
    expect(
      screen.getAllByText("We couldn't confirm whether your run started").length,
    ).toBeGreaterThan(0);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(1);
    expect(assign).not.toHaveBeenCalled();
  });

  it("blocks repeated starts while an active-run conflict converges to Watch", async () => {
    const recovery = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) {
        return Promise.resolve(runConflictResponse("active_run_exists"));
      }
      if (String(input) === healthReadyProxyPath) {
        return Promise.resolve(jsonResponse(readinessFixture()));
      }
      if (String(input) === dashboardRecoveryProxyPath) return recovery.promise;
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;
    await user.click(start);

    expect(await screen.findByText("A demo run is already in progress")).toBeTruthy();
    expect(start.disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(1);

    recovery.resolve(
      jsonResponse(
        dashboardRecoveryFixture({
          currentRun: demoRunFixture({
            status: "active",
            startedAt: "2026-06-20T00:00:11.000Z",
            trafficStartedAt: "2026-06-20T00:00:11.000Z",
          }),
          recoveredAt: "2026-06-20T00:00:11.000Z",
        }),
      ),
    );
    await waitFor(() => expect(screen.getByText("accepting checkout attempts")).toBeTruthy());
    expect(screen.getByText("A demo run is already in progress")).toBeTruthy();
    expect(start.disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
  });

  it("replaces a stale failed-start notice when recovery discovers an active run", async () => {
    vi.useFakeTimers();
    let recoveryRevision = 1;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) {
        return new Response(
          JSON.stringify(
            errorPayloadSchema.parse({
              code: "backend_unavailable",
              message: "Private backend failure must not become public copy.",
              correlationId: "stale-start-failure",
              timestamp: "2026-06-20T00:00:00.000Z",
            }),
          ),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        recoveryRevision += 1;
        const currentRun =
          recoveryRevision === 3
            ? demoRunFixture({ status: "active" })
            : recoveryRevision === 4
              ? demoRunFixture({ status: "completed", trafficStatus: "succeeded" })
              : null;
        return jsonResponse(
          dashboardRecoveryFixture({
            currentRun,
            recoveredAt: `2026-06-20T00:00:${String(recoveryRevision).padStart(2, "0")}.000Z`,
            revision: recoveryRevision,
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start Preview 1k" }));
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(screen.getByText("We couldn't confirm whether your run started")).toBeTruthy();
    expect(recoveryFetchCount(fetchMock)).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(screen.getByText("accepting checkout attempts")).toBeTruthy();
    expect(screen.getByText("A demo run is already in progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(screen.queryByText("We couldn't confirm whether your run started")).toBeNull();
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(screen.queryByText("A demo run is already in progress")).toBeNull();
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it.each([
    "degraded",
    "unavailable",
  ] as const)("prioritizes the active-run outcome over %s readiness", (readinessStatus) => {
    const surface = publicDemoSurfaceFixture();
    surface.recovery = available(
      dashboardRecoveryFixture({ currentRun: demoRunFixture({ status: "active" }) }),
    );
    surface.readiness =
      readinessStatus === "degraded"
        ? available({ ...readinessFixture(), status: "degraded" })
        : { status: "unavailable", reason: "Private readiness failure." };

    render(createElement(PublicDemoEntry, { surface }));

    expect(screen.getByText("A demo run is already in progress")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("navigates an accepted public start to the live view", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input) === demoRunStartProxyPath) {
        return jsonResponse(startDemoRunResponseFixture(), 202);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    const assign = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);

    await user.click(screen.getByRole("button", { name: "Start Preview 1k" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/watch?acceptedRunId=55555555-5555-4555-8555-555555555555",
      ),
    );
  });

  it.each([
    ["preview-1k", "Preview 1k", "33333333-3333-4333-8333-333333333331"],
    ["surge-5k", "Surge 5k", "33333333-3333-4333-8333-333333333332"],
    ["surge-10k", "Surge 10k", "33333333-3333-4333-8333-333333333333"],
    ["idempotency-check-200", "Duplicate-click storm", "33333333-3333-4333-8333-333333333334"],
  ] as const)("starts the %s public preset through the accepted-run path", async (slug, name, id) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) {
        return jsonResponse(startDemoRunResponseFixture(), 202);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);
    const surface = publicDemoSurfaceFixture();
    if (surface.presets.status !== "available") throw new Error("Expected presets.");
    const preview = demoPresetFixture("preview-1k");
    surface.presets.data.presets = [
      demoPresetFixture("public-custom"),
      {
        ...preview,
        id,
        slug,
        display: { ...preview.display, name },
      },
    ];

    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface }));
    await user.click(screen.getByRole("button", { name: `Start ${name}` }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/watch?acceptedRunId=55555555-5555-4555-8555-555555555555",
      ),
    );
    const [, init] = findFetchCall(fetchMock, demoRunStartProxyPath, "POST");
    expect(jsonRequestBody(init)).toEqual({ presetSlug: slug });
  });

  it("navigates an accepted custom start with the response run ID", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input) === demoRunStartProxyPath) {
        return jsonResponse(startDemoRunResponseFixture(), 202);
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    await user.click(screen.getByText("Customize a scenario"));
    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "/watch?acceptedRunId=55555555-5555-4555-8555-555555555555",
      ),
    );
  });

  it.each([
    "presets",
    "runtimePolicy",
  ] as const)("offers a same-page reload for unavailable initial %s", async (readName) => {
    const surface = publicDemoSurfaceFixture();
    const unavailableRead = { status: "unavailable" as const, reason: `${readName} offline` };
    if (readName === "presets") surface.presets = unavailableRead;
    else surface.runtimePolicy = unavailableRead;

    const reload = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { reload } });
    render(createElement(PublicDemoEntry, { surface }));
    vi.stubGlobal("window", navigationWindow);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("blocks public starts on fresh global recovery and lets visitors check again", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === healthReadyProxyPath
        ? jsonResponse(readinessFixture())
        : jsonResponse(dashboardRecoveryFixture({ revision: 2 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const surface = publicDemoSurfaceFixture();
    surface.recovery = {
      status: "available",
      data: dashboardRecoveryFixture({
        resetRecoveryRunId: "11111111-1111-4111-8111-111111111111",
        resetRecovery: "incomplete",
      }),
    };
    render(createElement(PublicDemoEntry, { surface }));
    expect(
      (screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("The previous run is still recovering")).toBeTruthy();
    expect(screen.getByText(/Worker work may still settle/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reset/ })).toBeNull();
    expect(screen.getByText("Recovery incomplete")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(findFetchCall(fetchMock, dashboardRecoveryProxyPath)[0]).toBe(
      dashboardRecoveryProxyPath,
    );
    expect(findFetchCall(fetchMock, healthReadyProxyPath)[0]).toBe(healthReadyProxyPath);
  });

  it("reloads to recheck a reset-incomplete conflict while keeping starts blocked", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) {
        return runConflictResponse("reset_incomplete");
      }
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input) === dashboardRecoveryProxyPath) {
        return jsonResponse(dashboardRecoveryFixture({ revision: 2 }));
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { reload } });
    vi.stubGlobal("window", navigationWindow);
    const user = userEvent.setup();

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;
    await user.click(start);

    expect(await screen.findByText("The previous run is still recovering")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(start.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(reload).toHaveBeenCalledOnce();
    expect(start.disabled).toBe(true);
  });

  it("removes an expired start rate-limit wait before enabling starts", async () => {
    vi.useFakeTimers();
    const assign = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) {
        return new Response(
          JSON.stringify(
            errorPayloadSchema.parse({
              code: "public_run_budget_exceeded",
              message: "Public start limit reached.",
              correlationId: "public-start-limited",
              details: { budget: "global" },
              timestamp: "2026-06-20T00:00:00.000Z",
            }),
          ),
          {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "10" },
          },
        );
      }
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input) === dashboardRecoveryProxyPath) {
        return jsonResponse(dashboardRecoveryFixture({ revision: 2 }));
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const start = screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(start);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(start.disabled).toBe(true);
    expect(screen.getByText("The shared demo has reached its start limit")).toBeTruthy();
    expect(screen.getAllByText("Wait 10 seconds before trying again.").length).toBeGreaterThan(0);
    expect(screen.getByText("Wait before retrying")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(10_000));

    expect(start.disabled).toBe(false);
    expect(screen.queryByText("The shared demo has reached its start limit")).toBeNull();
    expect(screen.queryByText("Wait 10 seconds before trying again.")).toBeNull();
    expect(screen.queryByText("Wait before retrying")).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });

  it("submits curated start requests from the public surface", async () => {
    const user = userEvent.setup();
    const startRequest = deferred<Response>();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        return jsonResponse(dashboardRecoveryFixture());
      }
      return startRequest.promise;
    });
    vi.stubGlobal("fetch", fetchMock);
    const surface = publicDemoSurfaceFixture();
    if (surface.presets.status !== "available") throw new Error("Expected presets.");
    const preview = demoPresetFixture("preview-1k");
    surface.presets.data.presets.push({
      ...preview,
      id: "33333333-3333-4333-8333-333333333332",
      slug: "surge-5k",
      display: { ...preview.display, name: "Surge 5k", sortOrder: 130 },
    });

    render(createElement(PublicDemoEntry, { surface }));

    expect(screen.getByRole("button", { name: "Start Preview 1k" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Surge 5k" })).toBeTruthy();
    const previewArticle = screen.getByText("Preview 1k").closest("article");
    if (!previewArticle) {
      throw new Error("Expected Preview 1k card.");
    }

    const customDisclosure = screen.getByText("Customize a scenario");
    await user.click(customDisclosure);
    await replaceInputValue("Buyer count (buyers)", "321", user);
    await user.click(customDisclosure);
    expect(screen.getByText("Edited settings retained")).toBeTruthy();

    await user.click(within(previewArticle).getByRole("button", { name: "Start Preview 1k" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Starting Preview 1k" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Surge 5k" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Starting" })).toBeNull();
    const [, init] = findFetchCall(fetchMock, demoRunStartProxyPath, "POST");
    expect(init?.method).toBe("POST");
    expect(jsonRequestBody(init)).toEqual({ presetSlug: "preview-1k" });
    startRequest.resolve(jsonResponse({ message: "start blocked" }, 409));
    expect(await screen.findByText("We couldn't confirm whether your run started")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(findFetchCall(fetchMock, healthReadyProxyPath)[0]).toBe(healthReadyProxyPath);
  });

  it("keeps the semantic custom form hidden until the visitor expands it", async () => {
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    expect(screen.getByRole("button", { name: "Start Preview 1k" })).toBeTruthy();
    const expander = screen.getByText("Customize a scenario");
    const details = expander.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await user.click(expander);
    expect(details.open).toBe(true);
    expect(screen.getByRole("form", { name: "Custom run builder" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Buyers" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Stock" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Slow ERP" })).toBeTruthy();
  });

  it("keeps concise preset facts visible and opens preset details independently", async () => {
    const surface = publicDemoSurfaceFixture();
    if (surface.presets.status !== "available") throw new Error("Expected presets.");
    const duplicatePreset = demoPresetFixture("preview-1k");
    if (duplicatePreset.trafficConfig.mode !== "buyer-spike") {
      throw new Error("Expected spike preset.");
    }
    surface.presets.data.presets = [
      demoPresetFixture("public-custom"),
      demoPresetFixture("preview-1k"),
      {
        ...duplicatePreset,
        id: "33333333-3333-4333-8333-333333333334",
        slug: "idempotency-check-200",
        display: {
          ...duplicatePreset.display,
          name: "Duplicate-click storm",
          outcomeFocus: ["idempotency", "happy_path"],
        },
        trafficConfig: {
          ...duplicatePreset.trafficConfig,
          duplicateEachBuyerAttempt: true,
        },
      },
    ];
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface }));

    const duplicateArticle = screen.getByText("Duplicate-click storm").closest("article");
    const previewArticle = screen.getByText("Preview 1k").closest("article");
    if (!duplicateArticle || !previewArticle) throw new Error("Expected both preset cards.");
    expect(within(duplicateArticle).getByText("Each buyer tries twice")).toBeTruthy();
    expect(
      within(duplicateArticle).getByRole("button", { name: "Start Duplicate-click storm" }),
    ).toBeTruthy();

    const duplicateDetails = duplicateArticle.querySelector("details");
    const previewDetails = previewArticle.querySelector("details");
    const duplicateSummary = duplicateDetails?.querySelector("summary");
    const previewSummary = previewDetails?.querySelector("summary");
    if (!duplicateDetails || !previewDetails || !duplicateSummary || !previewSummary) {
      throw new Error("Expected preset technical disclosures.");
    }
    expect(duplicateDetails.open).toBe(false);
    expect(previewDetails.open).toBe(false);
    expect(duplicateSummary.textContent).toContain("Technical details for Duplicate-click storm");
    expect(previewSummary.textContent).toContain("Technical details for Preview 1k");

    await user.click(duplicateSummary);
    expect(duplicateDetails.open).toBe(true);
    expect(previewDetails.open).toBe(false);
    expect(within(duplicateArticle).getByText("Detailed assumptions")).toBeTruthy();

    await user.click(previewSummary);
    expect(duplicateDetails.open).toBe(true);
    expect(previewDetails.open).toBe(true);
  });

  it("retains the custom draft, disclosure state, and field errors across collapse", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    const builderSummary = screen.getByText("Customize a scenario");
    const builder = builderSummary.closest("details") as HTMLDetailsElement;
    await user.click(builderSummary);
    await user.click(screen.getByLabelText("Steady stream"));
    const protectionSummary = document.querySelector("#custom-protection-settings > summary");
    if (!(protectionSummary instanceof HTMLElement))
      throw new Error("Expected protection summary.");
    const protection = protectionSummary.closest("details") as HTMLDetailsElement;
    await user.click(protectionSummary);
    const form = screen.getByRole("form", { name: "Custom run builder" });
    const stock = screen.getByLabelText("Starting stock (units)") as HTMLInputElement;
    await user.clear(stock);
    fireEvent.invalid(stock);
    const nativeError = stock.validationMessage;
    expect(stock.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(nativeError)).toBeTruthy();

    await user.click(builderSummary);
    expect(builder.open).toBe(false);
    expect(screen.getByText("Edited settings retained")).toBeTruthy();
    expect(form.isConnected).toBe(true);
    expect(stock.isConnected).toBe(true);
    expect(protection.isConnected).toBe(true);
    expect(document.querySelector('form[aria-label="Custom run builder"]')).toBe(form);
    expect(document.getElementById("custom-stock")).toBe(stock);
    expect(document.getElementById("custom-protection-settings")).toBe(protection);

    await user.click(builderSummary);
    expect(builder.open).toBe(true);
    expect(protection.open).toBe(true);
    expect(screen.getByText(nativeError)).toBeTruthy();
    expect(form.isConnected).toBe(true);
    expect(stock.isConnected).toBe(true);
    expect(protection.isConnected).toBe(true);
    expect(document.querySelector('form[aria-label="Custom run builder"]')).toBe(form);
    expect(document.getElementById("custom-stock")).toBe(stock);
    expect(document.getElementById("custom-protection-settings")).toBe(protection);
    expect(protection.open).toBe(true);
    expect(
      (document.getElementById("custom-traffic-mode-constant-arrival-rate") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect((document.getElementById("custom-stock") as HTMLInputElement).value).toBe("");
    expect(document.getElementById("custom-stock")?.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText(nativeError)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("associates native field errors and blocks invalid custom submission", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    const buyerCount = screen.getByLabelText("Buyer count (buyers)") as HTMLInputElement;

    await user.clear(buyerCount);
    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    const summary = screen.getByRole("alert", { name: "Fix these settings" });
    expect(document.activeElement).toBe(buyerCount);
    expect(buyerCount.getAttribute("aria-invalid")).toBe("true");
    expect(buyerCount.getAttribute("aria-describedby")).toContain("custom-buyers-error");
    expect(screen.getByText(buyerCount.validationMessage)).toBeTruthy();
    await user.click(within(summary).getByRole("link", { name: /Buyer count/ }));
    expect(document.activeElement).toBe(buyerCount);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the same invalid custom submit path for Enter and reports every invalid field", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    const buyerCount = screen.getByLabelText("Buyer count (buyers)") as HTMLInputElement;
    const startingStock = screen.getByLabelText("Starting stock (units)") as HTMLInputElement;

    await user.clear(buyerCount);
    await user.clear(startingStock);
    await user.keyboard("{Enter}");

    const summary = screen.getByRole("alert", { name: "Fix these settings" });
    expect(document.activeElement).toBe(buyerCount);
    expect(within(summary).getAllByRole("link")).toHaveLength(2);
    expect(within(summary).getByRole("link", { name: /Buyer count/ })).toBeTruthy();
    expect(within(summary).getByRole("link", { name: /Starting stock/ })).toBeTruthy();
    expect(buyerCount.getAttribute("aria-invalid")).toBe("true");
    expect(startingStock.getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();

    await replaceInputValue("Buyer count (buyers)", "1000", user);
    expect(screen.queryByRole("alert", { name: "Fix these settings" })).toBeNull();
    expect(buyerCount.getAttribute("aria-invalid")).toBeNull();
  });

  it("clears a mode-specific native error when the traffic control changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    const buyerCount = screen.getByLabelText("Buyer count (buyers)") as HTMLInputElement;

    await user.clear(buyerCount);
    await user.click(screen.getByRole("button", { name: "Start custom run" }));
    expect(buyerCount.getAttribute("aria-invalid")).toBe("true");

    await user.click(screen.getByLabelText("Steady stream"));
    const arrivalRate = screen.getByLabelText("Arrival rate (requests/second)") as HTMLInputElement;
    expect(arrivalRate.getAttribute("aria-invalid")).toBeNull();
    expect(arrivalRate.getAttribute("aria-describedby")).toBe("custom-rate-description");
    expect(document.getElementById("custom-rate-description")?.textContent).toContain(
      "Requests dispatched during each second.",
    );
    expect(screen.queryByText(buyerCount.validationMessage)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the traffic pattern as one native radio group", async () => {
    const user = userEvent.setup();
    const surface = publicDemoSurfaceFixture();
    render(createElement(PublicDemoEntry, { surface }));
    await user.click(screen.getByText("Customize a scenario"));

    const group = screen.getByRole("group", { name: "Traffic pattern" });
    const spike = within(group).getByRole("radio", { name: "Everyone at once" });
    const steady = within(group).getByRole("radio", { name: "Steady stream" });
    expect((spike as HTMLInputElement).checked).toBe(true);
    expect((steady as HTMLInputElement).checked).toBe(false);

    await user.click(steady);
    expect((spike as HTMLInputElement).checked).toBe(false);
    expect((steady as HTMLInputElement).checked).toBe(true);

    cleanup();
    if (surface.runtimePolicy.status !== "available") throw new Error("Expected runtime policy.");
    surface.runtimePolicy.data.policy.publicCustomLimits.allowedTrafficModes = ["buyer-spike"];
    render(createElement(PublicDemoEntry, { surface }));
    await user.click(screen.getByText("Customize a scenario"));
    expect(
      (
        within(screen.getByRole("group", { name: "Traffic pattern" })).getByRole("radio", {
          name: "Steady stream",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it("drops hidden traffic errors and submits only the corrected visible mode", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === healthReadyProxyPath
        ? jsonResponse(readinessFixture())
        : jsonResponse({ message: "start blocked" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    const buyerCount = screen.getByLabelText("Buyer count (buyers)");

    await user.clear(buyerCount);
    await user.click(screen.getByRole("button", { name: "Start custom run" }));
    expect(screen.getByRole("alert", { name: "Fix these settings" })).toBeTruthy();

    await user.click(screen.getByLabelText("Steady stream"));
    expect(screen.queryByRole("alert", { name: "Fix these settings" })).toBeNull();
    expect(document.getElementById("custom-buyers")).toBeNull();
    await replaceInputValue("Arrival rate (requests/second)", "125", user);
    await replaceInputValue("Traffic duration (seconds)", "20", user);
    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
      ).toHaveLength(1),
    );
    const [, init] = findFetchCall(fetchMock, demoRunStartProxyPath, "POST");
    expect(jsonRequestBody(init)).toMatchObject({
      configOverride: {
        trafficConfig: {
          durationSeconds: 20,
          mode: "constant-arrival-rate",
          ratePerSecond: 125,
        },
      },
    });
    expect(JSON.stringify(jsonRequestBody(init))).not.toContain('"buyerCount"');
  });

  it.each([
    [0, "0"],
    [0.005, "0.5"],
    [0.07, "7"],
    [0.25, "25"],
    [1, "100"],
  ] as const)("displays ERP failure ratio %s as percentage %s and serializes it once", async (ratio, percent) => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input) === healthReadyProxyPath
        ? jsonResponse(readinessFixture())
        : jsonResponse({ message: "start blocked" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);

    const surface = publicDemoSurfaceFixture();
    if (surface.runtimePolicy.status !== "available") throw new Error("Expected runtime policy.");
    surface.runtimePolicy.data.policy.publicCustomDefaults.erpConfig.errorRate = ratio;
    surface.runtimePolicy.data.policy.publicCustomLimits.maxErpErrorRate = Math.max(0.25, ratio);
    render(createElement(PublicDemoEntry, { surface }));
    await user.click(screen.getByText("Customize a scenario"));

    const errorRate = screen.getByLabelText("Failure rate (percent)") as HTMLInputElement;
    expect(errorRate.value).toBe(percent);
    expect(errorRate.max).toBe(String(Math.max(25, Number(percent))));

    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = findFetchCall(fetchMock, demoRunStartProxyPath, "POST");
    expect(jsonRequestBody(init)).toMatchObject({
      configOverride: { erpConfig: { errorRate: ratio } },
    });
  });

  it("updates planned attempts and blocks only totals above the policy boundary", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));

    expect(screen.getByText("Planned total attempts: 1,000")).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Duplicate each buyer attempt/ }));
    expect(screen.getByText("Planned total attempts: 2,000")).toBeTruthy();

    await replaceInputValue("Buyer count (buyers)", "5001", user);
    expect(screen.getByText("Planned total attempts: 10,002")).toBeTruthy();
    expect(
      screen.getByText(/Reduce the buyer count.*10,000 planned attempts or fewer/),
    ).toBeTruthy();
    const start = screen.getByRole("button", {
      name: "Start custom run",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await user.click(start);
    const summary = screen.getByRole("alert", { name: "Fix these settings" });
    expect(document.activeElement).toBe(document.getElementById("custom-traffic-error"));
    await user.click(within(summary).getByRole("link", { name: /Reduce the buyer count/ }));
    expect(document.activeElement).toBe(document.getElementById("custom-traffic-error"));
    expect(fetchMock).not.toHaveBeenCalled();

    await replaceInputValue("Buyer count (buyers)", "5000", user);
    expect(screen.getByText("Planned total attempts: 10,000")).toBeTruthy();
    expect(screen.queryByText(/Reduce the buyer count/)).toBeNull();
    expect(start.disabled).toBe(false);
  });

  it("calculates constant-arrival attempts as rate times duration", async () => {
    const user = userEvent.setup();
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    await user.click(screen.getByLabelText("Steady stream"));
    await replaceInputValue("Arrival rate (requests/second)", "125", user);
    await replaceInputValue("Traffic duration (seconds)", "20", user);

    expect(screen.getByText("Planned total attempts: 2,500")).toBeTruthy();
  });

  it("builds bounded custom start payloads from edited public controls", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) =>
      String(input) === healthReadyProxyPath
        ? jsonResponse(readinessFixture())
        : jsonResponse({ message: "start blocked" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);

    const surface = publicDemoSurfaceFixture();
    if (surface.runtimePolicy.status !== "available") throw new Error("Expected runtime policy.");
    surface.runtimePolicy.data.policy.publicCustomLimits.allowForcedOutage = true;
    surface.runtimePolicy.data.policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    render(createElement(PublicDemoEntry, { surface }));
    expect(screen.queryByLabelText("Forced outage")).toBeNull();
    await user.click(screen.getByText("Customize a scenario"));
    for (const protectedControl of [
      "Worker concurrency (workers)",
      "Persistence retry delay (seconds)",
      "Reservation hold (minutes)",
      "ERP request timeout (milliseconds)",
    ]) {
      expect(screen.queryByLabelText(protectedControl)).toBeNull();
    }

    await replaceInputValue("Buyer count (buyers)", "321", user);
    await replaceInputValue("Starting stock (units)", "44", user);
    await replaceInputValue("Delay per order (milliseconds)", "125", user);
    await replaceInputValue("Capacity (orders/second)", "33", user);
    await replaceInputValue("Failure rate (percent)", "0.2", user);
    await user.keyboard("{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = findFetchCall(fetchMock, demoRunStartProxyPath, "POST");
    const requestBody = jsonRequestBody(init);
    expect(requestBody).toEqual({
      presetSlug: "public-custom",
      configOverride: {
        trafficConfig: {
          mode: "buyer-spike",
          buyerCount: 321,
          duplicateEachBuyerAttempt: false,
          startDelaySeconds: 0,
          maxDurationSeconds: 2,
          quantityPerAttempt: 1,
        },
        inventoryConfig: {
          startingStock: 44,
          quantityPerCheckout: 1,
          reservationHoldMinutes: 15,
        },
        erpConfig: {
          latencyMs: 125,
          maxTps: 33,
          errorRate: 0.002,
          forcedOutage: false,
        },
      },
    });
    expect(requestBody).not.toHaveProperty("configOverride.backpressureConfig");
    expect(findFetchCall(fetchMock, healthReadyProxyPath)[0]).toBe(healthReadyProxyPath);
  });

  it("presents authoritative backend custom rejection without leaking its message", async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      return new Response(
        JSON.stringify(
          errorPayloadSchema.parse({
            code: "invalid_run_configuration",
            message: "Private contract violation detail.",
            correlationId: "private-custom-rejection",
            details: { path: ["trafficConfig", "buyerCount"] },
            timestamp: "2026-06-20T00:00:00.000Z",
          }),
        ),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    const summary = await screen.findByRole("alert", { name: "Fix these settings" });
    const buyerCount = screen.getByLabelText("Buyer count (buyers)");
    expect(document.activeElement).toBe(buyerCount);
    expect(within(summary).getByRole("link", { name: /Buyer count/ })).toBeTruthy();
    expect(buyerCount.getAttribute("aria-invalid")).toBe("true");
    expect(buyerCount.getAttribute("aria-describedby")).toContain("custom-buyers-error");
    expect(screen.getByText("Use an available value for Buyer count.")).toBeTruthy();
    expect(screen.queryByText("Check the values and try again")).toBeNull();
    expect(screen.queryByText("Private contract violation detail.")).toBeNull();
    expect(document.body.textContent).not.toContain("private-custom-rejection");
    expect(assign).not.toHaveBeenCalled();

    await replaceInputValue("Buyer count (buyers)", "999", user);
    expect(screen.queryByRole("alert", { name: "Fix these settings" })).toBeNull();
    expect(buyerCount.getAttribute("aria-invalid")).toBeNull();
  });

  it("reopens collapsed custom and protection disclosures for a late field error", async () => {
    const user = userEvent.setup();
    const startRequest = deferred<Response>();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      if (String(input) === demoRunStartProxyPath) return startRequest.promise;
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    const builderSummary = screen.getByText("Customize a scenario");
    const builder = builderSummary.closest("details") as HTMLDetailsElement;
    await user.click(builderSummary);
    const protectionSummary = document.querySelector("#custom-protection-settings > summary");
    if (!(protectionSummary instanceof HTMLElement))
      throw new Error("Expected protection summary.");
    const protection = protectionSummary.closest("details") as HTMLDetailsElement;
    await user.click(screen.getByRole("button", { name: "Start custom run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await user.click(builderSummary);
    expect(builder.open).toBe(false);

    startRequest.resolve(
      new Response(
        JSON.stringify(
          errorPayloadSchema.parse({
            code: "invalid_run_configuration",
            message: "Private contract violation detail.",
            correlationId: "late-custom-rejection",
            details: { path: ["trafficConfig", "maxDurationSeconds"] },
            timestamp: "2026-06-20T00:00:00.000Z",
          }),
        ),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    expect(await screen.findByRole("alert", { name: "Fix these settings" })).toBeTruthy();
    await waitFor(() => expect(builder.open).toBe(true));
    expect(protection.open).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("custom-safety-cutoff"));
    expect((document.getElementById("custom-safety-cutoff") as HTMLInputElement).value).toBe("2");
  });

  it("drops a late validation error for a traffic field that became inactive", async () => {
    const user = userEvent.setup();
    const startRequest = deferred<Response>();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === demoRunStartProxyPath) return startRequest.promise;
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    const builderSummary = screen.getByText("Customize a scenario");
    const builder = builderSummary.closest("details") as HTMLDetailsElement;
    await user.click(builderSummary);
    await user.click(screen.getByRole("button", { name: "Start custom run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await user.click(screen.getByLabelText("Steady stream"));
    await user.click(builderSummary);

    startRequest.resolve(
      new Response(
        JSON.stringify(
          errorPayloadSchema.parse({
            code: "invalid_run_configuration",
            message: "Private stale field detail.",
            correlationId: "stale-custom-rejection",
            details: { path: ["trafficConfig", "buyerCount"] },
            timestamp: "2026-06-20T00:00:00.000Z",
          }),
        ),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start custom run" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(builder.open).toBe(false);
    expect(screen.queryByRole("alert", { name: "Fix these settings" })).toBeNull();
    expect(screen.queryByText(/Buyer count: Use an available value/)).toBeNull();
    expect(document.getElementById("custom-buyers")).toBeNull();
  });

  it("uses a safe custom-form fallback for an unknown backend validation path", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) return jsonResponse(readinessFixture());
      return new Response(
        JSON.stringify(
          errorPayloadSchema.parse({
            code: "invalid_run_configuration",
            message: "Private unknown-field detail.",
            correlationId: "private-unknown-path",
            details: { path: ["internalOnlyField"] },
            timestamp: "2026-06-20T00:00:00.000Z",
          }),
        ),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    await user.click(screen.getByText("Customize a scenario"));
    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    const form = screen.getByRole("form", { name: "Custom run builder" });
    const summary = await screen.findByRole("alert", { name: "Fix these settings" });
    expect(document.activeElement).toBe(summary);
    expect(within(form).getAllByText("Review the custom run settings and try again.")).toHaveLength(
      2,
    );
    expect(form.getAttribute("aria-invalid")).toBe("true");
    expect(form.getAttribute("aria-describedby")).toBe("custom-form-error");
    expect(screen.queryByText("Private unknown-field detail.")).toBeNull();
  });

  it("mirrors and focuses an operation-level failure only for a custom start", async () => {
    const user = userEvent.setup();
    let startRequestCount = 0;
    const unavailableResponse = () =>
      jsonResponse(
        errorPayloadSchema.parse({
          code: "backend_unavailable",
          message: "Private refresh failure.",
          correlationId: "private-refresh-failure",
          timestamp: "2026-06-20T00:00:00.000Z",
        }),
        503,
      );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) {
        return startRequestCount === 1 ? jsonResponse(readinessFixture()) : unavailableResponse();
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        return jsonResponse(dashboardRecoveryFixture());
      }
      startRequestCount += 1;
      return startRequestCount === 1
        ? new Response(
            JSON.stringify(
              errorPayloadSchema.parse({
                code: "public_run_budget_exceeded",
                message: "Private budget detail.",
                correlationId: "private-budget-rejection",
                timestamp: "2026-06-20T00:00:00.000Z",
              }),
            ),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          )
        : runConflictResponse("reset_incomplete");
    });
    vi.stubGlobal("fetch", fetchMock);
    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    await user.click(screen.getByRole("button", { name: "Start Preview 1k" }));
    const curatedNotice = await screen.findByRole("alert");
    expect(
      within(curatedNotice).getByText("Public start limit reached for now — try again later"),
    ).toBeTruthy();
    expect(screen.queryByRole("alert", { name: "Operation failure" })).toBeNull();

    await user.click(screen.getByText("Customize a scenario"));
    await user.click(screen.getByRole("button", { name: "Start custom run" }));

    const summary = await screen.findByRole("alert", { name: "Operation failure" });
    expect(document.activeElement).toBe(summary);
    expect(within(summary).getByText("The previous run is still recovering")).toBeTruthy();
    expect(within(summary).getByText(/Worker work may still settle/)).toBeTruthy();
    expect(within(summary).queryByRole("link")).toBeNull();
    expect(summary.textContent).not.toContain(
      "Backend conflict detail must not become public copy.",
    );
    await waitFor(() =>
      expect(screen.getAllByText("The previous run is still recovering")).toHaveLength(2),
    );
    expect(
      screen.queryByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeNull();
  });
});

describe("public recovery convergence", () => {
  it("converges from bootstrap backoff and then arms steady polling", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            errorPayloadSchema.parse({
              code: "dashboard_recovery_rate_limited",
              message: "Recovery is temporarily limited.",
              correlationId: "public-recovery-limited",
              timestamp: "2026-06-20T00:00:00.000Z",
            }),
          ),
          { status: 429, headers: { "retry-after": "10" } },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(dashboardRecoveryFixture()))
      .mockResolvedValueOnce(
        jsonResponse(
          dashboardRecoveryFixture({
            recoveredAt: "2026-06-20T00:00:11.000Z",
            revision: 2,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const surface = publicDemoSurfaceFixture();
    surface.recovery = {
      status: "loading",
    };

    render(createElement(PublicDemoEntry, { surface }));
    const curatedStart = screen.getByRole("button", {
      name: "Start Preview 1k",
    }) as HTMLButtonElement;
    const customStart = screen.getByRole("button", {
      name: "Start custom run",
      hidden: true,
    }) as HTMLButtonElement;
    expect(curatedStart.disabled).toBe(true);
    expect(customStart.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(curatedStart.disabled).toBe(true);
    expect(
      screen.getByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(curatedStart.disabled).toBe(false);
    expect(customStart.disabled).toBe(false);
    expect(screen.getByText("ready")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("ready")).toBeTruthy();
  });

  it("re-homes manual recovery and readiness refresh into the gate", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === healthReadyProxyPath
        ? jsonResponse(readinessFixture())
        : jsonResponse(dashboardRecoveryFixture()),
    );
    vi.stubGlobal("fetch", fetchMock);
    const surface = publicDemoSurfaceFixture();
    surface.recovery = {
      status: "unavailable",
      reason: "Recovery unavailable.",
    };

    render(createElement(PublicDemoEntry, { surface }));
    await user.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(findFetchCall(fetchMock, dashboardRecoveryProxyPath)[0]).toBe(
      dashboardRecoveryProxyPath,
    );
    expect(findFetchCall(fetchMock, healthReadyProxyPath)[0]).toBe(healthReadyProxyPath);
  });

  it("polls recovery and blocks starts when another visitor starts a run", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== dashboardRecoveryProxyPath) {
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }
      return jsonResponse(
        dashboardRecoveryFixture({
          currentRun: demoRunFixture({ status: "active" }),
          recoveredAt: "2026-06-20T00:00:11.000Z",
          revision: 2,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const curatedStart = screen.getByRole("button", {
      name: "Start Preview 1k",
    }) as HTMLButtonElement;
    expect(curatedStart.disabled).toBe(false);

    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(curatedStart.disabled).toBe(true);
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
  });

  it("leaves unavailable recovery to backoff and stops after retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) =>
      String(input) === healthReadyProxyPath
        ? jsonResponse(readinessFixture())
        : new Response(
            JSON.stringify(
              errorPayloadSchema.parse({
                code: "backend_unavailable",
                message: "Recovery temporarily unavailable.",
                correlationId: "public-recovery-failed",
                timestamp: "2026-06-20T00:00:00.000Z",
              }),
            ),
            {
              status: 503,
              headers: { "content-type": "application/json", "retry-after": "1" },
            },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(recoveryFetchCount(fetchMock)).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(61_000));
    expect(recoveryFetchCount(fetchMock)).toBe(7);
    expect(
      screen.getByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeTruthy();
    expect(
      screen.getByText("Automatic retries paused. Manual retry remains available."),
    ).toBeTruthy();
    const manualRetry = screen.getByRole("button", { name: "Check again" });

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(recoveryFetchCount(fetchMock)).toBe(7);
    await act(async () => {
      fireEvent.click(manualRetry);
      await Promise.resolve();
    });
    expect(recoveryFetchCount(fetchMock)).toBe(8);
  });

  it("guards every readiness request until the current Retry-After expires", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === dashboardRecoveryProxyPath) {
        return jsonResponse(dashboardRecoveryFixture());
      }
      if (String(input) === healthReadyProxyPath) {
        const readinessRequests = fetchMock.mock.calls.filter(
          ([requestInput]) => String(requestInput) === healthReadyProxyPath,
        ).length;
        return readinessRequests === 1
          ? new Response(
              JSON.stringify(
                errorPayloadSchema.parse({
                  code: "backend_unavailable",
                  message: "Readiness temporarily unavailable.",
                  correlationId: "public-readiness-limited",
                  timestamp: "2026-06-20T00:00:00.000Z",
                }),
              ),
              {
                status: 503,
                headers: { "content-type": "application/json", "retry-after": "120" },
              },
            )
          : jsonResponse(readinessFixture());
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const surface = publicDemoSurfaceFixture();
    surface.readiness = {
      status: "unavailable",
      errorCode: "dashboard_recovery_rate_limited",
      retryAfterMs: 120_000,
    };

    render(createElement(PublicDemoEntry, { surface }));
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(119_999));
    expect(readinessFetchCount(fetchMock)).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(readinessFetchCount(fetchMock)).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(119_999));
    expect(readinessFetchCount(fetchMock)).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(readinessFetchCount(fetchMock)).toBe(2);
    expect(
      (screen.getByRole("button", { name: "Start Preview 1k" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("polls readiness slowly and blocks starts on an unavailable check", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === healthReadyProxyPath) {
        return jsonResponse(
          {
            ...readinessFixture(),
            status: "unavailable",
            checks: [
              {
                name: "redis_reachable",
                status: "unavailable",
                message: "Redis readiness check failed.",
              },
            ],
          },
          503,
        );
      }
      if (String(input) === dashboardRecoveryProxyPath) {
        return jsonResponse(dashboardRecoveryFixture());
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));
    const curatedStart = screen.getByRole("button", {
      name: "Start Preview 1k",
    }) as HTMLButtonElement;

    await act(async () => vi.advanceTimersByTimeAsync(60_000));

    expect(curatedStart.disabled).toBe(true);
    expect(
      screen.getByText("The demo backend isn't ready yet — try again in a moment"),
    ).toBeTruthy();
    expect(screen.queryByText("Redis readiness check failed.")).toBeNull();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === healthReadyProxyPath),
    ).toHaveLength(1);
  });
});

describe("watch browser recovery", () => {
  it("converges to a terminal projection after realtime disconnects during recovery", async () => {
    vi.useFakeTimers();
    const initialRecovery = deferred<Response>();
    const activeProjection = dashboardRecoveryFixture({
      currentRun: demoRunFixture({ status: "active" }),
    });
    const terminalProjection = dashboardRecoveryFixture({
      currentRun: demoRunFixture({ status: "completed", trafficStatus: "succeeded" }),
      recoveredAt: "2026-06-20T00:00:12.000Z",
      revision: 2,
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => initialRecovery.promise)
      .mockResolvedValueOnce(jsonResponse(terminalProjection));
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(OperatorDashboard, { initialRecovery: { status: "loading" } }));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledOnce();
    act(() => FakeEventSource.instances[0]?.emit("error", new Event("error")));
    initialRecovery.resolve(jsonResponse(activeProjection));
    await act(async () => {
      await initialRecovery.promise;
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
    });

    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      `${dashboardRecoveryProxyPath}?knownRunId=55555555-5555-4555-8555-555555555555&knownSaleOfferId=22222222-2222-4222-8222-222222222222`,
    );
    expect(screen.getByRole("region", { name: "Run conclusion" })).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps initial read availability separate from an available idle lifecycle", () => {
    const loadingMarkup = renderToStaticMarkup(
      createElement(OperatorDashboard, { initialRecovery: { status: "loading" } }),
    );
    const unavailableMarkup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: {
          status: "unavailable",
          reason: "Current run data could not be loaded.",
          httpStatus: 503,
        },
      }),
    );
    const idleMarkup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(dashboardRecoveryFixture()),
      }),
    );

    expect(loadingMarkup).toContain("Run: checking availability");
    expect(loadingMarkup).toContain("Checking availability.");
    expect(loadingMarkup).not.toContain("No run has started");
    expect(loadingMarkup).not.toContain("data-watch-signals");

    expect(unavailableMarkup).toContain("Run: updates unavailable");
    expect(unavailableMarkup).toContain("Something didn");
    expect(unavailableMarkup).not.toContain("No run has started");
    expect(unavailableMarkup.toLowerCase()).not.toContain("not yet");
    expect(unavailableMarkup).not.toContain("data-watch-signals");

    expect(idleMarkup).toContain("No run has started");
    expect(idleMarkup).toContain("Choose a simulation");
    expect(idleMarkup).toContain("See run history");
    expect(idleMarkup).toContain("Run availability and updates");
    expect(idleMarkup.toLowerCase()).not.toContain("not yet");
    expect(idleMarkup).not.toContain("Live panels");
    expect(idleMarkup).not.toContain("in progress");
  });

  it("uses pending wording only for an available active run with missing evidence", () => {
    const markup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(
          dashboardRecoveryFixture({ currentRun: demoRunFixture({ status: "active" }) }),
        ),
      }),
    );

    expect(markup).toContain("Run: accepting checkout attempts");
    expect(markup).toContain("Not yet available");
    // Live mode renders missing evidence as em-dash placeholders on the board instead of the
    // report-mode "no evidence yet" panels.
    expect(markup).toContain("of — left");
    expect(markup).not.toContain("No run has started");
  });

  it.each([
    "completed",
    "failed",
  ] as const)("renders retained partial %s evidence as final and incomplete", (status) => {
    const currentRun =
      status === "completed"
        ? demoRunFixture({ status, trafficStatus: "succeeded" })
        : demoRunFixture({ status, trafficStatus: "failed" });
    const markup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(
          dashboardRecoveryFixture({
            currentRun,
            recentMetrics: [
              {
                metricName: "traffic.request_arrival_rate",
                value: 8,
                unit: "requests_per_second",
                timestamp: "2026-06-20T00:00:11.000Z",
              },
            ],
            recoveredAt: "2026-06-20T00:00:12.000Z",
          }),
        ),
      }),
    );
    const normalized = markup.toLowerCase();

    expect(markup).toContain("Sale evidence");
    expect(markup).toContain("Not recorded for this run");
    expect(markup).not.toContain("Retained peak 8 attempts/s");
    expect(markup).toContain("Final request totals were not recorded for this run.");
    expect(markup).toContain("Shared demo-runtime status is unavailable.");
    expect(markup).not.toContain("No run has started");
    expect(markup).not.toContain("Live panels");
    expect(normalized).not.toContain("not yet");
    expect(normalized).not.toContain("in progress");
  });

  it("keeps run backlog and retries separate from shared queue pressure", () => {
    const currentRun = demoRunFixture();
    const markup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(
          dashboardRecoveryFixture({
            currentRun,
            businessOutcome: {
              acceptedReservations: 12,
              reservedUnits: 12,
              soldOutRejections: 0,
              queuedOrders: 7,
              processingOrders: 1,
              retryingOrders: 3,
              confirmedOrders: 1,
              failedOrders: 0,
              pendingPersistenceCount: 0,
              notificationsRecorded: 1,
            },
            systemStatus: {
              queue: {
                name: "orders:process",
                connectivity: "reachable",
                depth: 41,
                counts: {
                  waiting: 30,
                  prioritized: 0,
                  paused: 0,
                  delayed: 10,
                  active: 1,
                  failed: 0,
                },
                oldestWaitingAgeSeconds: 4,
                retryPressure: {
                  inspectedJobCount: 41,
                  inspectionLimit: 100,
                  retryingJobCount: 29,
                  retryAttemptCount: 37,
                  inspectionTruncated: false,
                },
                failedJobs: {
                  totalCount: 0,
                  recent: [],
                  inspectionLimit: 20,
                  inspectionTruncated: false,
                },
                observedAt: "2026-06-20T00:00:10.000Z",
              },
              erpProtection: {
                status: "degraded",
                reason: "erp_retries_pending",
                retryPressure: {
                  retryingJobCount: 29,
                  retryAttemptCount: 37,
                  inspectedJobCount: 41,
                  inspectionLimit: 100,
                  inspectionTruncated: false,
                },
                observedAt: "2026-06-20T00:00:10.000Z",
              },
            },
          }),
        ),
      }),
    );

    expect(markup).not.toContain('aria-label="Run conclusion"');
    expect(markup).toContain("7 waiting · peak 7");
    // Run-owned outcome totals stay reachable on the live board: the run's own retrying count (3)
    // is separate from the shared queue's retry pressure (29) in the run context's system status.
    expect(markup).toMatch(/Retrying<\/dt><dd[^>]*>3<\/dd>/);
    expect(markup).toContain("Physical order queue");
    expect(markup).toMatch(/Depth \(all runs\)<\/dt><dd[^>]*>41<\/dd>/);
    expect(markup.match(/Retrying jobs<\/dt><dd[^>]*>29<\/dd>/g)).toHaveLength(1);
    expect(markup).not.toContain("41 waiting · peak 41");
    expect(markup).not.toContain("Run-owned retrying orders are shown separately (29)");
  });

  it("keeps the terminal chart anchored at the first attempt after a long preparation gap", () => {
    const firstAttemptStartedAt = "2026-06-20T00:01:10.000Z";
    const elapsed = Array.from({ length: runSignalBucketCount }, (_, index) => (index + 1) * 0.005);
    const currentRun = demoRunFixture({
      status: "completed",
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:10.000Z",
      trafficEndedAt: "2026-06-20T00:01:10.100Z",
      finalizedAt: "2026-06-20T00:01:10.600Z",
      configSnapshot: {
        ...configSnapshotFixture(),
        trafficConfig: {
          ...configSnapshotFixture().trafficConfig,
          startDelaySeconds: 15,
        },
      },
    });
    const markup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(
          dashboardRecoveryFixture({
            currentRun,
            businessOutcome: {
              acceptedReservations: 1,
              reservedUnits: 1,
              soldOutRejections: 0,
              queuedOrders: 0,
              processingOrders: 0,
              retryingOrders: 0,
              confirmedOrders: 1,
              failedOrders: 0,
              pendingPersistenceCount: 0,
              notificationsRecorded: 0,
            },
            requestArrivalSummary: {
              firstAttemptStartedAt,
              peakArrivalRatePerSecond: 1,
              peakArrivalWindowSeconds: 0.6,
              dispatchDurationSeconds: 0,
              arrivalRateSeries: [{ windowStartedAt: firstAttemptStartedAt, ratePerSecond: 1 }],
              arrivalWindowCountObserved: 1,
              arrivalWindowCountRetained: 1,
              arrivalSeriesLimit: 120,
            },
            runSignalTimelineSummary: {
              window: {
                anchoredAt: firstAttemptStartedAt,
                endedAt: "2026-06-20T00:01:10.600Z",
                bucketCount: runSignalBucketCount,
                bucketWidthSeconds: 0.005,
              },
              inventoryDrain: {
                startingStock: 1,
                remainingStock: 0,
                depletedAt: "2026-06-20T00:01:10.200Z",
                timeToDepletionSeconds: 0.2,
                remainingStockSeries: elapsed.map((elapsedSeconds) => ({
                  elapsedSeconds,
                  remainingStock: elapsedSeconds < 0.2 ? 1 : 0,
                })),
              },
              queueBacklog: {
                peakBacklog: 0,
                peakAtElapsedSeconds: null,
                backlogDrainedAt: null,
                drainDurationSeconds: null,
                drainDurationBoundary: "first_order_queued_to_final_backlog_zero",
                definition: "accepted_awaiting_first_processing_start",
                backlogSeries: elapsed.map((elapsedSeconds) => ({
                  elapsedSeconds,
                  backlog: 0,
                })),
              },
              confirmationConvergence: {
                confirmedOrderCount: 1,
                failedOrderCount: 0,
                pendingAtCaptureCount: 0,
                averageLagMs: 200,
                p95LagMs: 200,
                maxLagMs: 200,
                boundary: "reservation_secured_to_order_confirmed",
                convergenceSeries: elapsed.map((elapsedSeconds) => ({
                  elapsedSeconds,
                  cumulativeConfirmedOrderCount: elapsedSeconds < 0.2 ? 0 : 1,
                  cumulativeSettledOrderCount: elapsedSeconds < 0.2 ? 0 : 1,
                })),
              },
              convergenceDurationSeconds: 0.2,
            },
            recoveredAt: "2026-06-20T00:01:10.600Z",
          }),
        ),
      }),
    );

    expect(markup).toMatch(/Configured start delay<\/dt><dd[^>]*>15 s<\/dd>/);
    expect(markup).toMatch(/Startup overhead beyond configured delay<\/dt><dd[^>]*>45 s<\/dd>/);
    expect(markup).toMatch(/Time until checkout attempts begin<\/dt><dd[^>]*>60 s<\/dd>/);
    expect(markup).toContain("depleted in 200 ms");
    expect(markup).toContain(
      "Shared axis: 0s first checkout attempt · 0.6s final timeline boundary",
    );
    expect(markup).toContain("<li>0s: 1</li>");
    expect(markup).not.toContain("60.6s final timeline boundary");
  });

  it("keeps the last Watch snapshot and renders one sync warning after refresh failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          dashboardRecoveryFixture({ currentRun: demoRunFixture({ status: "active" }) }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify(
            errorPayloadSchema.parse({
              code: "backend_unavailable",
              message: "Recovery temporarily unavailable.",
              correlationId: "watch-refresh-failed",
              timestamp: "2026-06-20T00:00:11.000Z",
            }),
          ),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      createElement(OperatorDashboard, {
        initialRecovery: pendingDashboardRecovery(),
      }),
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]?.emit("open", new Event("open")));
    await screen.findByText("Preview 1k");
    act(() => FakeEventSource.instances[0]?.emit("error", new Event("error")));

    await screen.findByText("The latest information is temporarily unavailable");
    expect(screen.getAllByText("Last-known-good data")).toHaveLength(1);
    expect(
      screen
        .getAllByRole("button", { name: "Refresh", hidden: true })
        .filter((element) => !element.closest("details:not([open])")),
    ).toHaveLength(1);

    fireEvent.click(screen.getByText("Technical details", { selector: "summary" }));

    expect(screen.getAllByText("Last-known-good data")).toHaveLength(1);
    expect(
      screen
        .getAllByRole("button", { name: "Refresh", hidden: true })
        .filter((element) => !element.closest("details:not([open])")),
    ).toHaveLength(1);
    expect(screen.getByText("Preview 1k")).toBeTruthy();
    expect(screen.queryAllByText("Unavailable")).toHaveLength(0);
    const connection = container.querySelector<HTMLElement>("#watch-advanced-connection");
    if (!connection) throw new Error("Expected the technical connection group.");
    expect(within(connection).getByRole("alert")).toBeTruthy();
  });
});

describe("run history browser cleanup", () => {
  it("deletes a single run straight from its per-row trash control", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        deletedSummaryCount: 1,
        deletedAt: "2026-06-20T00:00:10.000Z",
        correlationId: "corr-delete-history",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const history = runHistoryListFixture();
    const target = history.summaries[0];
    render(
      createElement(
        RunHistoryAdminControls,
        { visibleRunIds: history.summaries.map((summary) => summary.runId) },
        createElement(RunHistoryList, { history }),
      ),
    );

    await user.click(
      screen.getByRole("button", {
        name: `Delete run ${target?.presetName} (${target?.runId})`,
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete run summary" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(jsonRequestBody(requireFetchCall(fetchMock, 0)[1])).toEqual({
      runIds: [target?.runId],
      visibleFilter: { runIds: history.summaries.map((summary) => summary.runId) },
    });
  });
});

describe("accepted Watch result handoff", () => {
  const acceptedRunId = "55555555-5555-4555-8555-555555555555";
  const newerRunId = "66666666-6666-4666-8666-666666666666";

  it.each([
    "operator",
    "automatic_reset",
  ] as const)("retains saved %s cancellation on reload and beside a successor", (failureCategory) => {
    const detail = runHistoryDetailFixtureFor(acceptedRunId);
    detail.summary = publicRunHistorySummarySchema.parse({
      ...detail.summary,
      status: "failed",
      failureCategory,
      dataDiscarded: true,
    });
    detail.result = { ...detail.result, outcome: "failed", failureCategory };
    detail.run = {
      ...detail.run,
      status: "failed",
      trafficStatus: "succeeded",
      finalizedAt: detail.summary.endedAt,
    };
    const acceptedResult = acceptedRunResultFromRead(acceptedRunId, {
      status: "available",
      data: detail,
    });
    expect(acceptedResult).toMatchObject({
      status: "available",
      cancellation: { automatic: failureCategory === "automatic_reset" },
    });
    expect(acceptedResult).not.toHaveProperty("reportEvidence");
    for (const currentRun of [null, demoRunFixture({ runId: newerRunId, status: "active" })]) {
      const html = renderToStaticMarkup(
        createElement(OperatorDashboard, {
          acceptedResult,
          initialRecovery: available(dashboardRecoveryFixture({ currentRun })),
        }),
      );
      expect(html).toContain("Cancelled");
      expect(html).toContain(`/run-history/${acceptedRunId}`);
      expect(html).not.toContain("The run failed");
      expect(html).not.toContain("Reconciliation warning");
      if (currentRun) expect(html).toContain("The surge is under way");
    }
  });

  it.each([
    "accepted",
    "operator-reset",
    "operator-reset-with-old-recap",
  ])("never substitutes prior history and resolves the exact %s result without lifecycle frames", async (origin) => {
    vi.useFakeTimers();
    const latestRun = runHistoryListFixture().summaries[0];
    if (!latestRun) throw new Error("Expected prior history.");
    const previousRun = {
      ...latestRun,
      runId: "11111111-1111-4111-8111-111111111111",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resourceNotFoundResponse(acceptedRunId))
      .mockResolvedValueOnce(jsonResponse(runHistoryDetailFixtureFor(acceptedRunId)));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);

    render(
      createElement(OperatorDashboard, {
        ...(origin === "accepted"
          ? { acceptedResult: { status: "awaiting" as const, runId: acceptedRunId } }
          : {}),
        initialRecovery: available(
          dashboardRecoveryFixture(
            origin !== "accepted"
              ? {
                  resetRecovery: "incomplete",
                  resetRecoveryRunId: acceptedRunId,
                  ...(origin === "operator-reset-with-old-recap"
                    ? {
                        currentRun: demoRunFixture({
                          runId: previousRun.runId,
                          status: "completed",
                          trafficStatus: "succeeded",
                          trafficEndedAt: "2026-06-20T00:00:11.000Z",
                          finalizedAt: "2026-06-20T00:00:12.000Z",
                        }),
                      }
                    : {}),
                }
              : {},
          ),
        ),
        latestCompletedRun: available(previousRun),
      }),
    );

    expect(
      screen.getByText("The saved result for this run is being checked", { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByText("No completed runs yet")).toBeNull();
    expect(document.querySelector(`a[href="/run-history/${previousRun.runId}"]`)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledWith(
      publicRunHistoryDetailProxyPath(acceptedRunId),
      expect.any(Object),
    );
    expect(document.querySelector(`a[href="/run-history/${previousRun.runId}"]`)).toBeNull();
    if (origin !== "accepted") {
      expect(screen.getByText("Your result")).toBeTruthy();
      act(() =>
        FakeEventSource.instances[0]?.emit(
          "message",
          new MessageEvent("message", {
            data: JSON.stringify(
              dashboardRecoveryFixture({ revision: 2, recoveredAt: "2026-06-20T00:00:15.000Z" }),
            ),
          }),
        ),
      );
    }
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(document.querySelector(`a[href="/run-history/${acceptedRunId}"]`)).toBeTruthy();
    expect(document.querySelector(`a[href="/run-history/${previousRun.runId}"]`)).toBeNull();
    expect(screen.queryByText("No completed runs yet")).toBeNull();
  });

  it("retries a transient exact-result failure and then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errorResponse("Temporarily unavailable", 503))
      .mockResolvedValueOnce(jsonResponse(runHistoryDetailFixtureFor(acceptedRunId)));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useAcceptedRunResult({ status: "unavailable", runId: acceptedRunId }),
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.result?.status).toBe("unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(result.current.result).toMatchObject({ status: "available", runId: acceptedRunId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors initial server retry guidance before the first client read", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(runHistoryDetailFixtureFor(acceptedRunId)));
    vi.stubGlobal("fetch", fetchMock);
    const initialResult = acceptedRunResultFromRead(acceptedRunId, {
      status: "unavailable",
      httpStatus: 503,
      retryAfterMs: 10_000,
    });
    const { result } = renderHook(() => useAcceptedRunResult(initialResult));

    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.current.result).toMatchObject({ status: "available", runId: acceptedRunId });
  });

  it("exhausts missing-result retries and offers a manual retry", async () => {
    vi.useFakeTimers();
    const finalRequest = deferred<Response>();
    const fetchMock = vi.fn(() =>
      fetchMock.mock.calls.length === 6
        ? finalRequest.promise
        : Promise.resolve(resourceNotFoundResponse(acceptedRunId)),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    render(
      createElement(OperatorDashboard, {
        acceptedResult: { status: "awaiting", runId: acceptedRunId },
        initialRecovery: available(dashboardRecoveryFixture()),
      }),
    );

    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(screen.queryByRole("button", { name: "Check accepted result again" })).toBeNull();

    finalRequest.resolve(resourceNotFoundResponse(acceptedRunId));
    await act(async () => finalRequest.promise);
    const retry = screen.getByRole("button", { name: "Check accepted result again" });
    fireEvent.click(retry);
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("ignores a late result after the accepted context changes", async () => {
    vi.useFakeTimers();
    const oldRequest = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) =>
      String(input) === publicRunHistoryDetailProxyPath(acceptedRunId)
        ? oldRequest.promise
        : Promise.resolve(jsonResponse(runHistoryDetailFixtureFor(newerRunId))),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ runId }) => useAcceptedRunResult({ status: "awaiting", runId }),
      { initialProps: { runId: acceptedRunId } },
    );

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    rerender({ runId: newerRunId });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.result).toMatchObject({ status: "available", runId: newerRunId });

    oldRequest.resolve(jsonResponse(runHistoryDetailFixtureFor(acceptedRunId)));
    await act(async () => oldRequest.promise);
    expect(result.current.result).toMatchObject({ status: "available", runId: newerRunId });
  });

  it("keeps a newer shared live run separate from the accepted result", () => {
    const currentRun = demoRunFixture({ status: "active", runId: newerRunId });
    const output = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        acceptedResult: {
          status: "available",
          runId: acceptedRunId,
          presetName: "Accepted B",
          endedAt: "2026-06-20T00:00:10.000Z",
        },
        initialRecovery: available(dashboardRecoveryFixture({ currentRun })),
      }),
    );

    // The accepted run keeps its own section and its exact report link.
    expect(output).toContain("Your result");
    expect(output).toContain(`href="/run-history/${acceptedRunId}"`);
    // The shared run is labeled as the shared demo without exposing its identity here.
    expect(output).toContain("Now running in the shared demo");
    expect(output).toContain("The surge is under way");
    expect(output).not.toContain(`Live panels are following shared run`);
  });
});

describe("watch composition", () => {
  const acceptedRunId = "55555555-5555-4555-8555-555555555555";
  const sharedRunId = "77777777-7777-4777-8777-777777777777";

  function innermostByText(container: HTMLElement, needle: string): HTMLElement | null {
    const match = [...container.querySelectorAll("*")].find(
      (element) =>
        element.textContent?.includes(needle) &&
        ![...element.children].some((child) => child.textContent?.includes(needle)),
    );
    return (match as HTMLElement) ?? null;
  }

  function expectVisible(container: HTMLElement, needle: string): void {
    const element = innermostByText(container, needle);
    expect(element).not.toBeNull();
    expect(element?.closest("details:not([open])")).toBeNull();
  }

  const watchSurface = (ui: ReactElement) => ui;

  function activeProjectionFixture(): DashboardProjection {
    return dashboardRecoveryFixture({
      currentRun: demoRunFixture({ status: "active", runId: sharedRunId }),
      recentMetrics: [
        {
          metricName: "traffic.request_arrival_rate",
          value: 8,
          unit: "requests_per_second",
          timestamp: "2026-06-20T00:00:11.000Z",
        },
      ],
    });
  }

  function runInventoryFixture(): NonNullable<DashboardProjection["inventory"]> {
    return {
      saleOfferId: "22222222-2222-4222-8222-222222222222",
      allocatedStock: 100,
      remainingStock: 12,
      reservedStock: 88,
      pendingPersistenceCount: 0,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 0,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 88,
        peakRatePerSecond: 88,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-06-20T00:00:11.000Z",
      },
      soldOutPressure: {
        rejectionCount: 500,
        latestObservedAt: "2026-06-20T00:00:11.000Z",
      },
      observedAt: "2026-06-20T00:00:11.000Z",
      lastUpdatedAt: "2026-06-20T00:00:11.000Z",
    };
  }

  function terminalProjectionFixture(runId: string): DashboardProjection {
    return dashboardRecoveryFixture({
      currentRun: demoRunFixture({ runId, status: "completed", trafficStatus: "succeeded" }),
      inventory: {
        saleOfferId: "22222222-2222-4222-8222-222222222222",
        allocatedStock: 250,
        remainingStock: 0,
        reservedStock: 250,
        pendingPersistenceCount: 0,
        expiredReservationCount: 0,
        oldestPendingPersistenceAgeSeconds: 0,
        reservationThroughput: {
          windowSeconds: 60,
          successfulReservationCount: 250,
          peakRatePerSecond: 250,
          peakWindowSeconds: 1,
          unit: "reservations_per_second",
          measuredAt: "2026-06-20T00:00:11.000Z",
        },
        soldOutPressure: {
          rejectionCount: 750,
          latestObservedAt: "2026-06-20T00:00:11.000Z",
        },
        observedAt: "2026-06-20T00:00:11.000Z",
        lastUpdatedAt: "2026-06-20T00:00:11.000Z",
      },
      businessOutcome: {
        acceptedReservations: 250,
        reservedUnits: 250,
        soldOutRejections: 750,
        queuedOrders: 0,
        processingOrders: 0,
        retryingOrders: 0,
        confirmedOrders: 250,
        failedOrders: 0,
        pendingPersistenceCount: 0,
        notificationsRecorded: 250,
      },
      recoveredAt: "2026-06-20T00:00:12.000Z",
      revision: 2,
    });
  }

  function qualifiedDetailFor(runId: string): PublicRunHistoryDetailResponse {
    const detail = runHistoryDetailFixtureFor(runId);
    return {
      ...detail,
      summary: {
        ...detail.summary,
        trafficDeliverySummary: {
          ...detail.summary.trafficDeliverySummary,
          trafficDeliveryStatus: "degraded",
        },
      },
    };
  }

  it("keeps one verdict while the same-run saved report is preparing, then links and qualifies", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resourceNotFoundResponse(sharedRunId))
      .mockResolvedValueOnce(jsonResponse(qualifiedDetailFor(sharedRunId)));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          acceptedResult: { status: "awaiting", runId: sharedRunId },
          initialRecovery: available(terminalProjectionFixture(sharedRunId)),
        }),
      ),
    );

    // The known terminal result stays visible while only the saved report is pending.
    expect(screen.getAllByText("Final result")).toHaveLength(1);
    expectVisible(container, "All 250 available units were reserved without overselling.");
    expectVisible(container, "Preparing saved report");
    expect(document.querySelector(`a[href="/run-history/${sharedRunId}"]`)).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(document.querySelector(`a[href="/run-history/${sharedRunId}"]`)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    // Availability confirms the link, and the visitor's own exact-run evidence qualifies it.
    expect(document.querySelector(`a[href="/run-history/${sharedRunId}"]`)).toBeTruthy();
    expectVisible(container, "Partial delivery: not all planned checkout attempts were delivered.");
    expect(screen.getAllByText("Final result")).toHaveLength(1);
  });

  it("keeps the manual Check again retry for an exhausted same-run lookup", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(resourceNotFoundResponse(sharedRunId));
    vi.stubGlobal("fetch", fetchMock);
    render(
      createElement(OperatorDashboard, {
        acceptedResult: { status: "unavailable", runId: sharedRunId },
        initialRecovery: available(terminalProjectionFixture(sharedRunId)),
      }),
    );

    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    expect(fetchMock).toHaveBeenCalledTimes(6);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(screen.getAllByText("Final result")).toHaveLength(1);
  });

  it("separates an ID-only accepted run from the shared demo run with UUIDs in technical details", () => {
    const idOnlyAcceptedRunId = "88888888-8888-4888-8888-888888888888";
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          acceptedResult: { status: "awaiting", runId: idOnlyAcceptedRunId },
          initialRecovery: available(
            dashboardRecoveryFixture({
              currentRun: demoRunFixture({ status: "active", runId: sharedRunId }),
            }),
          ),
        }),
      ),
    );

    expectVisible(container, "Your result");
    expectVisible(container, "The saved result for this run is being checked");
    expect(innermostByText(container, idOnlyAcceptedRunId)?.closest("details")).not.toBeNull();
    // A's card carries neither fabricated metadata nor B's counts.
    const acceptedCard = container.querySelector('[data-accepted-result=""]');
    expect(acceptedCard?.textContent).not.toContain("Preview 1k");
    expect(acceptedCard?.textContent).not.toContain("Units left");
    expectVisible(container, "Now running in the shared demo");
    expectVisible(container, "The surge is under way");
  });

  it("opens technical details focused on a signal's full chart from its sparkline", async () => {
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          initialRecovery: available(activeProjectionFixture()),
        }),
      ),
    );

    const arrivalsTile = screen.getByText("Arrivals").closest("button");
    if (!arrivalsTile) throw new Error("Expected the arrivals sparkline link.");
    fireEvent.click(arrivalsTile);

    expect(
      screen.getByText("Technical details", { selector: "summary" }).closest("details")?.open,
    ).toBe(true);
    await waitFor(() => expect(document.activeElement?.id).toBe("watch-signal-arrival"));
    expect(container.querySelector("#watch-signal-arrival")?.hasAttribute("hidden")).toBe(false);
  });

  it("keeps the stream, samples, and report retries intact across repeated details toggles", async () => {
    vi.useFakeTimers();
    const activeFixture = activeProjectionFixture();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === publicRunHistoryDetailProxyPath(acceptedRunId)) {
        return Promise.resolve(resourceNotFoundResponse(acceptedRunId));
      }
      if (String(input).startsWith(dashboardRecoveryProxyPath)) {
        return Promise.resolve(jsonResponse(activeFixture));
      }
      return Promise.reject(new Error(`Unexpected fetch: ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource);
    render(
      watchSurface(
        createElement(OperatorDashboard, {
          acceptedResult: { status: "awaiting", runId: acceptedRunId },
          initialRecovery: available(activeFixture),
        }),
      ),
    );
    await act(async () => FakeEventSource.instances[0]?.emit("open", new Event("open")));
    const arrivalLineBefore =
      document.querySelector("[data-watch-signals] svg polyline")?.getAttribute("points") ?? "";
    expect(arrivalLineBefore).not.toBe("");

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === publicRunHistoryDetailProxyPath(acceptedRunId),
      ),
    ).toHaveLength(1);

    const detailsSummary = screen.getByText("Technical details", { selector: "summary" });
    for (let index = 0; index < 4; index += 1) fireEvent.click(detailsSummary);

    // One stream, one start-free page, preserved samples, and the live scope still on screen.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input) === demoRunStartProxyPath),
    ).toHaveLength(0);
    const arrivalLineAfter =
      document.querySelector("[data-watch-signals] svg polyline")?.getAttribute("points") ?? "";
    expect(arrivalLineAfter).toBe(arrivalLineBefore);
    expect(screen.getByText("The surge is under way")).toBeTruthy();

    // The scheduled report retry continues on its original backoff instead of restarting.
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === publicRunHistoryDetailProxyPath(acceptedRunId),
      ),
    ).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === publicRunHistoryDetailProxyPath(acceptedRunId),
      ),
    ).toHaveLength(2);
  });

  it("warns about a failed authoritative read while last-known counts stay visible", async () => {
    const activeFixture = dashboardRecoveryFixture({
      currentRun: demoRunFixture({ status: "active", runId: sharedRunId }),
      inventory: runInventoryFixture(),
      businessOutcome: {
        acceptedReservations: 60,
        reservedUnits: 88,
        soldOutRejections: 500,
        queuedOrders: 40,
        processingOrders: 20,
        retryingOrders: 0,
        confirmedOrders: 0,
        failedOrders: 0,
        pendingPersistenceCount: 0,
        notificationsRecorded: 0,
      },
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    const failedRead = () =>
      new Response(
        JSON.stringify(
          errorPayloadSchema.parse({
            code: "backend_unavailable",
            message: "Recovery temporarily unavailable.",
            correlationId: "watch-basic-sync-failure",
            timestamp: "2026-06-20T00:00:11.000Z",
          }),
        ),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    const pendingRefresh = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(failedRead()).mockReturnValueOnce(pendingRefresh.promise),
    );
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          initialRecovery: available(activeFixture),
        }),
      ),
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // The stream stays connected; only the authoritative read fails.
    act(() => FakeEventSource.instances[0]?.emit("open", new Event("open")));
    const detailsRefresh = container.querySelector<HTMLButtonElement>(
      "#watch-advanced-connection button",
    );
    if (!detailsRefresh) throw new Error("Expected the technical-details refresh control.");
    fireEvent.click(detailsRefresh);

    await screen.findAllByText("Last-known-good data");
    expectVisible(container, "Last-known-good data");
    expectVisible(container, "Retry scheduled in 1 s (attempt 1).");
    expectVisible(container, "Updated");
    // The last-known counts stay visible beside the warning.
    expectVisible(container, "Units left");
    expectVisible(container, "Awaiting confirmation");
    // The connected stream means no reconnect announcement is duplicated here.
    expect(screen.queryByText("Live updates interrupted")).toBeNull();
    fireEvent.click(screen.getByText("Technical details", { selector: "summary" }));
    expect(screen.getAllByText("Last-known-good data")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Refresh", hidden: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    const refreshing = screen.getByRole("button", { name: "Refreshing" }) as HTMLButtonElement;
    expect(refreshing.disabled).toBe(true);
    expectVisible(container, "Refreshing the latest run data now.");
    pendingRefresh.resolve(failedRead());
    await act(async () => pendingRefresh.promise);
    expectVisible(container, "Retry scheduled in 1 s (attempt 1).");
  });

  it("shows a failed authoritative read after an idle snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify(
            errorPayloadSchema.parse({
              code: "backend_unavailable",
              message: "Recovery temporarily unavailable.",
              correlationId: "watch-idle-sync-failure",
              timestamp: "2026-06-20T00:00:11.000Z",
            }),
          ),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          initialRecovery: available(dashboardRecoveryFixture()),
        }),
      ),
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]?.emit("open", new Event("open")));
    const detailsRefresh = container.querySelector<HTMLButtonElement>(
      "#watch-advanced-connection button",
    );
    if (!detailsRefresh) throw new Error("Expected the technical-details refresh control.");
    fireEvent.click(detailsRefresh);

    await screen.findAllByText("Last-known-good data");
    expectVisible(container, "Last-known-good data");
    expectVisible(container, "Choose a simulation");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(container.querySelector('[data-sync-warning=""] time')).toBeNull();
  });

  it("keeps the reading age visible when a connected run's readings go stale", async () => {
    const staleFixture = dashboardRecoveryFixture({
      currentRun: demoRunFixture({ status: "active", runId: sharedRunId }),
      inventory: runInventoryFixture(),
      businessOutcome: {
        acceptedReservations: 60,
        reservedUnits: 88,
        soldOutRejections: 500,
        queuedOrders: 40,
        processingOrders: 20,
        retryingOrders: 0,
        confirmedOrders: 0,
        failedOrders: 0,
        pendingPersistenceCount: 0,
        notificationsRecorded: 0,
      },
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(staleFixture)));
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          initialRecovery: available(staleFixture),
        }),
      ),
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0]?.emit("open", new Event("open")));

    await screen.findAllByText("stale, showing last known values", { exact: false });
    expect(container.querySelectorAll('[data-sync-warning=""]')).toHaveLength(1);
    expectVisible(container, "stale, showing last known values");
    expectVisible(container, "Units left");
    // Stale readings alone are not a sync failure: no last-known-good block appears.
    expect(screen.queryByText("Last-known-good data")).toBeNull();
  });

  it("targets the Signals group from a sparkline when no chart evidence exists yet", async () => {
    const { container } = render(
      watchSurface(
        createElement(OperatorDashboard, {
          initialRecovery: available(
            dashboardRecoveryFixture({
              currentRun: demoRunFixture({ status: "starting", runId: sharedRunId }),
            }),
          ),
        }),
      ),
    );

    const arrivalsTile = screen.getByText("Arrivals").closest("button");
    if (!arrivalsTile) throw new Error("Expected the arrivals sparkline link.");
    fireEvent.click(arrivalsTile);

    expect(
      screen.getByText("Technical details", { selector: "summary" }).closest("details")?.open,
    ).toBe(true);
    await waitFor(() => expect(document.activeElement?.id).toBe("watch-advanced-signals"));
    expect(container.querySelector("#watch-advanced-signals")?.hasAttribute("hidden")).toBe(false);
  });
});

describe("web page smoke coverage", () => {
  it("keeps Demo compact with independent technical details", async () => {
    vi.mocked(getPublicDemoSurface).mockResolvedValue(publicDemoSurfaceFixture());
    const demo = await DemoDashboardPage();

    render(demo);

    expect(
      screen.getByText(/Starting a bounded run uses the one shared demo runtime/),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How the surge stays safe" })).toBeTruthy();
    const detailsSummary = screen.getByText("Technical details", { selector: "summary" });
    const details = detailsSummary.closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    await userEvent.setup().click(detailsSummary);
    expect(details.open).toBe(true);
  });

  it("opens Watch technical details by default and allows collapsing them", async () => {
    vi.mocked(getRunHistoryPage).mockResolvedValue(available(runHistoryListFixture()));
    const watch = await WatchPage();

    render(watch);

    const details = screen
      .getByText("Technical details", { selector: "summary" })
      .closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(true);
    await userEvent.setup().click(details.querySelector("summary") as HTMLElement);
    expect(details.open).toBe(false);
  });

  it("renders the routed page surfaces with stubbed data reads", async () => {
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "session required" }, 401)),
    );
    vi.mocked(getPublicDemoSurface).mockResolvedValue(publicDemoSurfaceFixture());
    vi.mocked(getRunHistoryPage).mockResolvedValue(available(runHistoryListFixture()));
    vi.mocked(getRunHistoryDetail).mockResolvedValue(available(runHistoryDetailFixture()));

    render(await DemoDashboardPage());
    expect(screen.getByRole("heading", { name: "Checkout-Surge demo" })).toBeTruthy();
    cleanup();

    render(await WatchPage());
    expect(screen.getByRole("heading", { name: "Live watch" })).toBeTruthy();
    cleanup();

    render(await AdminPage());
    expect(screen.getByRole("heading", { name: "Protected operator surface" })).toBeTruthy();
    cleanup();

    render(
      await RunHistoryPage({
        searchParams: Promise.resolve({ page: "1" }),
      }),
    );
    expect(screen.getByRole("heading", { name: "Run history" })).toBeTruthy();
    cleanup();

    const detailRunId = runHistoryListFixture().summaries[0]?.runId;
    if (!detailRunId) {
      throw new Error("Expected run history summary fixture.");
    }

    render(await RunHistoryDetailPage({ params: Promise.resolve({ runId: detailRunId }) }));
    expect(screen.getByRole("heading", { name: "Preview 1k" })).toBeTruthy();
    cleanup();

    const overviewMarkup = renderToStaticMarkup(await OverviewPage());
    expect(overviewMarkup.match(/k6/g)).toHaveLength(1);
    render(await OverviewPage());
    expect(screen.getByRole("heading", { name: "Checkout-Surge" })).toBeTruthy();
  });

  it("rejects a malformed accepted run query at the Watch page boundary", async () => {
    const output = renderToStaticMarkup(
      await WatchPage({ searchParams: Promise.resolve({ acceptedRunId: "not-a-uuid" }) }),
    );

    expect(output).toContain("This Watch link is invalid");
    expect(output).toContain("This link does not identify a saved run");
    expect(output).toContain("No result has been selected");
    // Concise history and demo navigation, without exposing identifiers.
    expect(output).toContain('href="/run-history"');
    expect(output).toContain("Open run history");
    expect(output).toContain("Choose a simulation");
    expect(getRunHistoryDetail).not.toHaveBeenCalled();
    expect(getRunHistoryPage).not.toHaveBeenCalled();
  });
});

async function replaceInputValue(
  label: string | RegExp,
  value: string,
  user: ReturnType<typeof userEvent.setup>,
) {
  const input = screen.getByLabelText(label);
  await user.clear(input);
  await user.type(input, value);
}

function requireFetchCall(fetchMock: FetchMock, index: number): FetchCall {
  const call = fetchMock.mock.calls[index];
  if (!call || call.length === 0) {
    throw new Error(`Expected fetch call ${index}.`);
  }

  return [call[0] as string | URL | Request, call[1] as RequestInit | undefined];
}

function findFetchCall(fetchMock: FetchMock, path: string, method?: string): FetchCall {
  const call = fetchMock.mock.calls.find(
    ([input, init]) =>
      String(input) === path && (!method || (init as RequestInit | undefined)?.method === method),
  );

  if (!call) {
    throw new Error(`Expected fetch call for ${method ?? "GET"} ${path}.`);
  }

  return [call[0] as string | URL | Request, call[1] as RequestInit | undefined];
}

function recoveryFetchCount(fetchMock: FetchMock): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === dashboardRecoveryProxyPath)
    .length;
}

function readinessFetchCount(fetchMock: FetchMock): number {
  return fetchMock.mock.calls.filter(([input]) => String(input) === healthReadyProxyPath).length;
}

function jsonRequestBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") {
    throw new Error("Expected a string JSON request body.");
  }

  return JSON.parse(init.body);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse(
    errorPayloadSchema.parse({
      code: "backend_unavailable",
      message,
      correlationId: "accepted-result-error",
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    status,
  );
}

function resourceNotFoundResponse(runId: string): Response {
  return jsonResponse(
    errorPayloadSchema.parse({
      code: "resource_not_found",
      message: "Run history detail was not found.",
      details: { runId },
      correlationId: "accepted-result-missing",
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    404,
  );
}

function runConflictResponse(conflictReason: "active_run_exists" | "reset_incomplete"): Response {
  return jsonResponse(
    errorPayloadSchema.parse({
      code: "run_conflict",
      message: "Backend conflict detail must not become public copy.",
      details: { conflictReason },
      correlationId: "public-start-conflict",
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    409,
  );
}

function startDemoRunResponseFixture() {
  return {
    run: demoRunFixture({ status: "active" }),
    recovery: { establishedAt: "2026-06-20T00:00:10.000Z" },
    correlationId: "public-start-success",
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

function available<T>(data: T): Extract<BackendRead<T>, { status: "available" }> {
  return {
    status: "available",
    data,
    httpStatus: 200,
  };
}

function publicDemoSurfaceFixture(): PublicDemoSurface {
  return {
    presets: available(publicPresetListFixture()),
    readiness: available(readinessFixture()),
    runtimePolicy: available(publicRuntimePolicyResponseFixture()),
    recovery: available(dashboardRecoveryFixture()),
  };
}

function readinessFixture(): HealthResponse {
  return {
    service: "api",
    status: "ok",
    timestamp: "2026-06-20T00:00:10.000Z",
    uptimeSeconds: 10,
    checks: [{ name: "database_reachable", status: "ok" }],
  };
}

function dashboardRecoveryFixture(
  overrides: Partial<DashboardProjection> = {},
): DashboardProjection {
  const currentRun = overrides.currentRun ?? null;
  const scope = recoveryScope(currentRun);
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    scopeId: dashboardProjectionScopeId(scope),
    revision: 1,
    correlationId: "corr-web-recovery",
    scope,
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

function recoveryScope(currentRun: DashboardProjection["currentRun"]) {
  if (!currentRun) return null;
  if (!currentRun.saleOfferId) {
    throw new Error(`Run ${currentRun.runId} fixture requires a sale offer.`);
  }
  return { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId };
}

function publicPresetListFixture(): PublicPresetListResponse {
  return {
    presets: [demoPresetFixture("preview-1k"), demoPresetFixture("public-custom")],
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function demoPresetFixture(slug: "custom" | "preview-1k" | "public-custom"): DemoPresetContract {
  const isPublicCustom = slug === "public-custom";
  const isAdminCustom = slug === "custom";

  return {
    id: isAdminCustom
      ? "44444444-4444-4444-8444-444444444443"
      : isPublicCustom
        ? "44444444-4444-4444-8444-444444444444"
        : "33333333-3333-4333-8333-333333333331",
    slug,
    visibility: isAdminCustom ? "admin" : "public",
    isEditable: isAdminCustom,
    isCustom: isAdminCustom || isPublicCustom,
    display: {
      name: isPublicCustom ? "Public Custom" : isAdminCustom ? "Custom" : "Preview 1k",
      description: "Preset fixture.",
      sortOrder: isPublicCustom ? 140 : 120,
      outcomeFocus: [],
    },
    ...configSnapshotFixture(),
    createdAt: "2026-06-20T00:00:10.000Z",
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function publicRuntimePolicyResponseFixture(): PublicRuntimePolicyResponse {
  return {
    id: "active",
    policy: publicRuntimePolicyFixture(),
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function publicRuntimePolicyFixture(): PublicRuntimePolicy {
  return {
    estimatedDemoOccupancyCeilingSeconds: 600,
    isPublicRunBudgetEnforced: true,
    publicRunBudget: {
      windowSeconds: 300,
      perVisitorMaxStarts: 2,
      globalMaxStarts: 6,
    },
    publicCustomDefaults: configSnapshotFixture(),
    publicCustomLimits: {
      maxTotalRequests: 10_000,
      maxBuyers: 10_000,
      maxRequestsPerSecond: 1000,
      maxTrafficDurationSeconds: 120,
      maxTrafficStartDelaySeconds: 10,
      maxPreAllocatedVus: 1000,
      maxVus: 1000,
      maxStartingStock: 1000,
      maxErpLatencyMs: 2000,
      minErpMaxTps: 1,
      maxErpMaxTps: 300,
      maxErpErrorRate: 0.25,
      allowForcedOutage: false,
      allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
    },
    deploymentHardCaps: {
      estimatedDemoOccupancyCeilingSeconds: 600,
      maxBuyers: 100_000,
      maxTotalRequests: 100_000,
      maxRequestsPerSecond: 10_000,
      maxTrafficDurationSeconds: 300,
      maxTrafficStartDelaySeconds: 30,
      maxPreAllocatedVus: 10_000,
      maxVus: 10_000,
    },
  };
}

function demoRunFixture(overrides: Partial<DemoRunSnapshot> = {}): DemoRunSnapshot {
  const status = overrides.status ?? "active";
  return demoRunSnapshotSchema.parse({
    runId: "55555555-5555-4555-8555-555555555555",
    presetId: "33333333-3333-4333-8333-333333333331",
    presetName: "Preview 1k",
    operatorMode: "public",
    status,
    trafficStatus:
      status === "starting" ? "starting" : status === "active" ? "active" : "succeeded",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    configSnapshot: configSnapshotFixture(),
    startedAt: "2026-06-20T00:00:10.000Z",
    ...(status === "starting" ? {} : { trafficStartedAt: "2026-06-20T00:00:10.000Z" }),
    ...(status === "draining" ? { trafficEndedAt: "2026-06-20T00:00:11.000Z" } : {}),
    ...(status === "completed" || status === "failed"
      ? {
          trafficEndedAt: "2026-06-20T00:00:11.000Z",
          finalizedAt: "2026-06-20T00:00:12.000Z",
        }
      : {}),
    ...(status === "failed" ? { failureCategory: "traffic" as const } : {}),
    ...overrides,
  });
}

function runHistoryListFixture(): RunHistoryListResponse {
  return {
    summaries: [
      runHistoryListItemFixture(),
      runHistoryListItemFixture("66666666-6666-4666-8666-666666666666"),
    ],
    page: 1,
    pageSize: 10,
    totalCount: 2,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryListItemFixture(
  runId = "55555555-5555-4555-8555-555555555555",
): RunHistoryListItem {
  return {
    runId,
    presetName: "Preview 1k",
    occurredAt: "2026-06-20T00:00:00.000Z",
    overallDurationMs: 10_000,
    resultOutcome: "completed-with-order-failures",
    plannedAttempts: 10,
    startingStock: 10,
    uniqueReservations: 6,
    soldOutRejections: 4,
    confirmedOrders: 5,
    failedOrders: 1,
    convergenceDurationSeconds: null,
  };
}

function runHistorySummaryFixture(
  runId = "55555555-5555-4555-8555-555555555555",
): RunHistorySummary {
  const serverReservationTimingSummary: ServerReservationTimingSummary = {
    redisAtomicReservation: { sampleCount: 10, averageMs: 0.7, p95Ms: 1 },
    reserveOrderService: { sampleCount: 10, averageMs: 12, p95Ms: 25 },
  };
  return {
    id:
      runId === "55555555-5555-4555-8555-555555555555"
        ? "77777777-7777-4777-8777-777777777777"
        : "77777777-7777-4777-8777-777777777778",
    runId,
    presetName: "Preview 1k",
    status: "completed",
    replayPossible: false,
    startedAt: "2026-06-20T00:00:00.000Z",
    endedAt: "2026-06-20T00:00:10.000Z",
    transportAttemptCounts: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
    },
    httpSummary: {
      failedRequests: 0,
      acceptedResponses: 6,
      soldOutResponses: 4,
      transportFailures: 0,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      requestArrivalSummary: emptyRequestArrivalSummary,
      trafficDeliveryStatus: "complete",
      notes: [],
    },
    serverReservationTimingSummary,
    businessOutcomeSummary: {
      acceptedReservations: 6,
      reservedUnits: 6,
      soldOutRejections: 4,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 5,
      failedOrders: 1,
      pendingPersistenceCount: 0,
      notificationsRecorded: 5,
    },
    terminalInventorySnapshot: {
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      startingStock: 10,
      remainingStock: 0,
      reservedStock: 10,
      acceptedReservations: 6,
      soldOutRejections: 4,
      pendingPersistenceCount: 0,
      capturedAt: "2026-06-20T00:00:10.000Z",
      source: "redis",
    },
    runSignalTimelineSummary: null,
    capturedAt: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryDetailFixture(): PublicRunHistoryDetailResponse {
  const summary = runHistorySummaryFixture();
  const { id: _id, terminalInventorySnapshot, ...publicSummary } = summary;
  const sanitizedInventory = terminalInventorySnapshot
    ? (({ saleOfferId: _saleOfferId, source: _inventorySource, ...inventory }) => inventory)(
        terminalInventorySnapshot,
      )
    : undefined;
  const { notes: _deliveryNotes, ...publicDeliverySummary } = publicSummary.trafficDeliverySummary;

  return {
    summary: {
      ...publicSummary,
      trafficDeliverySummary: publicDeliverySummary,
      ...(sanitizedInventory ? { terminalInventorySnapshot: sanitizedInventory } : {}),
    },
    run: {
      runId: summary.runId,
      presetName: summary.presetName,
      operatorMode: "public",
      status: "completed",
      trafficStatus: "succeeded",
      configSnapshot: configSnapshotFixture(),
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:01.000Z",
      trafficEndedAt: "2026-06-20T00:00:09.000Z",
      finalizedAt: "2026-06-20T00:00:10.000Z",
    },
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    result: deriveRunResult({
      runStatus: "completed",
      failureCategory: null,
      startingStock: 10,
      remainingStock: 0,
      durable: {
        reservedUnits: 6,
        uniqueReservations: 6,
        soldOutDecisions: 4,
        confirmedOrders: 5,
        failedOrders: 1,
        queuedOrders: 0,
        processingOrders: 0,
        durablePendingPersistenceRecords: 0,
        notificationsRecorded: 5,
      },
      heldReservationsAwaitingPersistence: 0,
      replayPossible: false,
      generator: {
        transportAttemptCounts: summary.transportAttemptCounts,
        httpSummary: summary.httpSummary,
      },
    }),
    overallDurationMs: 10_000,
    plannedAttempts: 10,
    erpAttempts: {
      totalCount: 1,
      byStatus: { succeeded: 1, failed: 0, timedOut: 0 },
      averageLatencyMs: 42,
      p95LatencyMs: 42,
    },
    runSignalTimelineSummary: null,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryDetailFixtureFor(runId: string): PublicRunHistoryDetailResponse {
  const detail = runHistoryDetailFixture();
  return {
    ...detail,
    summary: { ...detail.summary, runId },
    run: { ...detail.run, runId },
  };
}
