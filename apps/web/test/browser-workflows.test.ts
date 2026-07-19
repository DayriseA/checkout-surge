// @vitest-environment jsdom

import {
  type AcceptedRunConfigSnapshot,
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  type DashboardEvent,
  type DashboardRecoveryResponse,
  type DemoPresetContract,
  type DemoRunSnapshot,
  demoRunSnapshotSchema,
  type ErpChaosStatus,
  errorPayloadSchema,
  type HealthResponse,
  type LivenessResponse,
  type PublicPresetListResponse,
  type PublicRuntimePolicy,
  type PublicRuntimePolicyResponse,
  type RunHistoryDetailResponse,
  type RunHistoryListResponse,
  type RunHistorySummary,
} from "@checkout-surge/contracts";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AboutPage from "../src/app/about/page.js";
import AdminPage from "../src/app/admin/page.js";
import { AdminAuthenticatedSurface } from "../src/app/components/admin/admin-authenticated-surface.js";
import { OperatorDashboard } from "../src/app/components/operator-dashboard.js";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry.js";
import { RunHistoryAdminControls } from "../src/app/components/run-history-admin-controls.js";
import type { BackendRead, DashboardBackendSnapshot, PublicDemoSurface } from "../src/app/lib/api";
import {
  getDashboardBackendSnapshot,
  getPublicDemoSurface,
  getRunHistoryDetail,
  getRunHistoryPage,
} from "../src/app/lib/api.js";
import {
  adminErpChaosProxyPath,
  adminPresetListProxyPath,
  adminPublicRuntimePolicyProxyPath,
  adminRunHistoryProxyPath,
  dashboardRecoveryProxyPath,
  demoRunStartProxyPath,
} from "../src/app/lib/control-paths.js";
import DemoDashboardPage from "../src/app/page.js";
import RunHistoryDetailPage from "../src/app/run-history/[runId]/page.js";
import RunHistoryPage from "../src/app/run-history/page.js";
import WatchPage from "../src/app/watch/page.js";

vi.mock("../src/app/lib/api.js", () => ({
  getDashboardBackendSnapshot: vi.fn(),
  getAdminRunHistoryDetail: vi.fn(),
  getPublicDemoSurface: vi.fn(),
  getRunHistoryDetail: vi.fn(),
  getRunHistoryPage: vi.fn(),
}));
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({
  hasValidAdminPageSession: vi.fn(async () => false),
}));
vi.mock("../src/app/lib/server/admin-reads.js", () => ({
  readAdminErpChaos: vi.fn(),
  readAdminPresets: vi.fn(),
  readAdminRecovery: vi.fn(),
  readAdminRuntimePolicy: vi.fn(),
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
  static instances: FakeEventSource[] = [];

  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly close = vi.fn();
  readonly listeners = new Map<string, Set<EventListener>>();
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
  it("submits curated start requests from the public surface", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ message: "start blocked" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(PublicDemoEntry, { surface: publicDemoSurfaceFixture() }));

    const previewArticle = screen.getByText("Preview 1k").closest("article");
    if (!previewArticle) {
      throw new Error("Expected Preview 1k card.");
    }

    await user.click(within(previewArticle).getByRole("button", { name: "Start" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = requireFetchCall(fetchMock, 0);
    expect(String(requireFetchCall(fetchMock, 0)[0])).toBe(demoRunStartProxyPath);
    expect(init?.method).toBe("POST");
    expect(jsonRequestBody(init)).toEqual({ presetSlug: "preview-1k" });
  });

  it("builds bounded custom start payloads from edited public controls", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ message: "start blocked" }, 409),
    );
    vi.stubGlobal("fetch", fetchMock);

    const surface = publicDemoSurfaceFixture();
    if (surface.runtimePolicy.status !== "available") throw new Error("Expected runtime policy.");
    surface.runtimePolicy.data.policy.publicCustomLimits.allowForcedOutage = true;
    surface.runtimePolicy.data.policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    render(createElement(PublicDemoEntry, { surface }));
    expect(screen.queryByLabelText("Forced outage")).toBeNull();

    await replaceInputValue("Buyers", "321", user);
    await replaceInputValue("Starting stock", "44", user);
    await replaceInputValue("ERP latency ms", "125", user);
    await replaceInputValue("ERP max TPS", "33", user);
    await replaceInputValue("ERP error rate", "0.2", user);
    await user.click(screen.getByRole("button", { name: "Start Public Custom" }));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = requireFetchCall(fetchMock, 0);
    expect(String(requireFetchCall(fetchMock, 0)[0])).toBe(demoRunStartProxyPath);
    expect(jsonRequestBody(init)).toEqual({
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
          errorRate: 0.2,
          forcedOutage: false,
          requestTimeoutMs: 2000,
        },
      },
    });
  });
});

describe("public recovery convergence", () => {
  it("enables Start controls after a 429 then idle recovery without remounting or extra requests", async () => {
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
      .mockResolvedValueOnce(jsonResponse(dashboardRecoveryFixture()));
    vi.stubGlobal("fetch", fetchMock);
    const surface = publicDemoSurfaceFixture();
    surface.recovery = {
      status: "unavailable",
      reason: "Authoritative run state is loading.",
    };

    render(createElement(PublicDemoEntry, { surface }));
    const curatedStart = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    const customStart = screen.getByRole("button", {
      name: "Start Public Custom",
    }) as HTMLButtonElement;
    expect(curatedStart.disabled).toBe(true);
    expect(customStart.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(curatedStart.disabled).toBe(true);
    expect(screen.getByText("Recovery is temporarily limited.")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(curatedStart.disabled).toBe(false);
    expect(customStart.disabled).toBe(false);
    expect(screen.getByText("ready")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("admin browser workflows", () => {
  it("submits exact ERP chaos values from the authenticated controls", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);

      if (path === adminPresetListProxyPath) {
        return jsonResponse(adminPresetListFixture());
      }

      if (path === dashboardRecoveryProxyPath) {
        return jsonResponse(dashboardRecoveryFixture());
      }

      if (path === adminPublicRuntimePolicyProxyPath) {
        return jsonResponse(adminRuntimePolicyResponseFixture());
      }

      if (path === adminErpChaosProxyPath && init?.method === "PUT") {
        return jsonResponse({
          latencyMs: 250,
          maxTps: 20,
          errorRate: 0.25,
          forcedOutage: true,
          updatedAt: "2026-06-20T00:00:10.000Z",
        });
      }

      if (path === adminErpChaosProxyPath) {
        return jsonResponse(erpChaosStatusFixture());
      }

      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(AdminAuthenticatedSurface, {
        initialErpChaos: available(erpChaosStatusFixture()),
        initialPresets: available(adminPresetListFixture()),
        initialRecovery: available(dashboardRecoveryFixture()),
        initialRuntimePolicy: available(adminRuntimePolicyResponseFixture()),
      }),
    );
    await screen.findByRole("button", { name: "Apply ERP Controls" });
    await replaceInputValue("Latency ms", "250", user);
    await replaceInputValue("Max TPS", "20", user);
    await replaceInputValue("Error rate", "0.25", user);
    await user.click(screen.getByLabelText("Forced outage"));
    await user.click(screen.getByRole("button", { name: "Apply ERP Controls" }));

    const [, init] = findFetchCall(fetchMock, adminErpChaosProxyPath, "PUT");
    expect(jsonRequestBody(init)).toEqual({
      latencyMs: 250,
      maxTps: 20,
      errorRate: 0.25,
      forcedOutage: true,
    });
  });
});

describe("watch browser recovery", () => {
  it("requests follow-up recovery when SSE events arrive during a refresh", async () => {
    const firstRecovery = deferred<Response>();
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return firstRecovery.promise;
      }

      return jsonResponse(
        dashboardRecoveryFixture({
          currentRun: demoRunFixture({ status: "completed", trafficStatus: "succeeded" }),
          recoveredAt: "2026-06-20T00:00:12.000Z",
        }),
      );
    });
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", fetchMock);

    render(createElement(OperatorDashboard, { snapshot: dashboardSnapshotFixture() }));

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => {
      FakeEventSource.instances[0]?.emit("open", new Event("open"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    act(() => {
      FakeEventSource.instances[0]?.emit(
        "message",
        new MessageEvent("message", {
          data: JSON.stringify(runCompletedEventFixture()),
        }),
      );
    });
    await act(async () => {
      firstRecovery.resolve(
        jsonResponse(
          dashboardRecoveryFixture({
            currentRun: demoRunFixture({ status: "completed", trafficStatus: "succeeded" }),
            recoveredAt: "2026-06-20T00:00:11.000Z",
          }),
        ),
      );
      await firstRecovery.promise;
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      dashboardRecoveryProxyPath,
      dashboardRecoveryProxyPath,
    ]);
  });
});

describe("run history browser cleanup", () => {
  it("submits selected and delete-all destructive requests from visible controls", async () => {
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
    render(createElement(RunHistoryAdminControls, { summaries: history.summaries }));

    await user.click(screen.getByLabelText(new RegExp(history.summaries[0]?.runId ?? "")));
    await user.click(screen.getByRole("button", { name: /Delete Selected/ }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete selected summaries" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(requireFetchCall(fetchMock, 0)[0])).toBe(adminRunHistoryProxyPath);
    expect(requireFetchCall(fetchMock, 0)[1]?.method).toBe("DELETE");
    expect(jsonRequestBody(requireFetchCall(fetchMock, 0)[1])).toEqual({
      runIds: [history.summaries[0]?.runId],
      visibleFilter: {
        runIds: history.summaries.map((summary) => summary.runId),
      },
    });

    await user.click(screen.getByRole("button", { name: "Delete All Run Summaries" }));
    await replaceInputValue(/Type DELETE_ALL_RUN_SUMMARIES/, "DELETE_ALL_RUN_SUMMARIES", user);
    await user.click(screen.getByRole("button", { name: "Delete all summaries" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(jsonRequestBody(requireFetchCall(fetchMock, 1)[1])).toEqual({
      deleteAllConfirmation: "DELETE_ALL_RUN_SUMMARIES",
    });
  });
});

describe("web page smoke coverage", () => {
  it("renders the routed page surfaces with stubbed data reads", async () => {
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "session required" }, 401)),
    );
    vi.mocked(getPublicDemoSurface).mockResolvedValue(publicDemoSurfaceFixture());
    vi.mocked(getDashboardBackendSnapshot).mockResolvedValue(dashboardSnapshotFixture());
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
    expect(screen.getByRole("heading", { name: "Run history detail" })).toBeTruthy();
    cleanup();

    render(createElement(AboutPage));
    expect(screen.getByRole("heading", { name: "About" })).toBeTruthy();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, reject, resolve };
}

function available<T>(data: T): BackendRead<T> {
  return {
    status: "available",
    data,
    httpStatus: 200,
  };
}

function dashboardSnapshotFixture(): DashboardBackendSnapshot {
  return {
    liveness: available(livenessFixture()),
    readiness: available(readinessFixture()),
    recovery: available(dashboardRecoveryFixture()),
    erpChaos: available(erpChaosStatusFixture()),
  };
}

function publicDemoSurfaceFixture(): PublicDemoSurface {
  return {
    presets: available(publicPresetListFixture()),
    runtimePolicy: available(publicRuntimePolicyResponseFixture()),
    recovery: available(dashboardRecoveryFixture()),
  };
}

function livenessFixture(): LivenessResponse {
  return {
    service: "api",
    status: "ok",
    timestamp: "2026-06-20T00:00:10.000Z",
    uptimeSeconds: 10,
  };
}

function readinessFixture(): HealthResponse {
  return {
    ...livenessFixture(),
    checks: [{ name: "database_reachable", status: "ok" }],
  };
}

function dashboardRecoveryFixture(
  overrides: Partial<DashboardRecoveryResponse> = {},
): DashboardRecoveryResponse {
  const currentRun = overrides.currentRun ?? null;
  return {
    correlationId: "corr-web-recovery",
    scope: currentRun
      ? { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId ?? null }
      : null,
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    transportAccounting: null,
    recentCompletionOutcomes: [],
    recoveredAt: "2026-06-20T00:00:10.000Z",
    ...overrides,
  };
}

function erpChaosStatusFixture(): ErpChaosStatus {
  return {
    latencyMs: 80,
    maxTps: 250,
    errorRate: 0,
    forcedOutage: false,
    updatedAt: "2026-06-20T00:00:10.000Z",
  };
}

function publicPresetListFixture(): PublicPresetListResponse {
  return {
    presets: [demoPresetFixture("preview-1k"), demoPresetFixture("public-custom")],
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function adminPresetListFixture(): AdminPresetListResponse {
  return {
    presets: [{ ...demoPresetFixture("custom"), canArchive: false }],
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

function adminRuntimePolicyResponseFixture(): AdminPublicRuntimePolicyResponse {
  return {
    ...publicRuntimePolicyResponseFixture(),
    correlationId: "corr-policy-read",
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function publicRuntimePolicyFixture(): PublicRuntimePolicy {
  return {
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
      allowedTrafficModes: ["buyer-spike", "steady-arrival-rate"],
    },
    deploymentHardCaps: {
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

function configSnapshotFixture(): AcceptedRunConfigSnapshot {
  return {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 250,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 80,
      maxTps: 250,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
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
    ...(status === "failed" ? { failureReason: "traffic_failed" } : {}),
    ...overrides,
  });
}

function runCompletedEventFixture(): DashboardEvent {
  return {
    type: "load.run.updated",
    runId: "55555555-5555-4555-8555-555555555555",
    correlationId: "corr-run-completed",
    occurredAt: "2026-06-20T00:00:11.000Z",
    run: demoRunFixture({ status: "completed", trafficStatus: "succeeded" }),
  };
}

function runHistoryListFixture(): RunHistoryListResponse {
  return {
    summaries: [
      runHistorySummaryFixture(),
      runHistorySummaryFixture("66666666-6666-4666-8666-666666666666"),
    ],
    page: 1,
    pageSize: 10,
    totalCount: 2,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function runHistorySummaryFixture(
  runId = "55555555-5555-4555-8555-555555555555",
): RunHistorySummary {
  return {
    id:
      runId === "55555555-5555-4555-8555-555555555555"
        ? "77777777-7777-4777-8777-777777777777"
        : "77777777-7777-4777-8777-777777777778",
    runId,
    presetName: "Preview 1k",
    status: "completed",
    startedAt: "2026-06-20T00:00:00.000Z",
    endedAt: "2026-06-20T00:00:10.000Z",
    httpSummary: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
      failedRequests: 0,
      acceptedResponses: 6,
      soldOutResponses: 4,
      unexpectedResponses: 0,
      p95LatencyMs: 42,
      failureRate: 0,
    },
    trafficDeliverySummary: {
      plannedRequests: 10,
      startedRequests: 10,
      completedRequests: 10,
      interruptedRequests: 0,
      unstartedRequests: 0,
      trafficMode: null,
      plannedBuyers: null,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      droppedIterations: 0,
      completedIterations: null,
      trafficDeliveryStatus: "complete",
      notes: [],
    },
    businessOutcomeSummary: {
      acceptedReservations: 6,
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
    capturedAt: "2026-06-20T00:00:10.000Z",
  };
}

function runHistoryDetailFixture(): RunHistoryDetailResponse {
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
    orders: {
      totalCount: 1,
      byStatus: { queued: 0, processing: 0, confirmed: 1, failed: 0 },
    },
    erpAttempts: {
      totalCount: 1,
      byStatus: { succeeded: 1, failed: 0, timedOut: 0 },
      averageLatencyMs: 42,
      p95LatencyMs: 42,
    },
    notifications: { totalCount: 1 },
    events: { totalCount: 1 },
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}
