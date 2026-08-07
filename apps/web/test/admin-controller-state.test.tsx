// @vitest-environment jsdom

import {
  type AdminPresetListItem,
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
  type ErpChaosStatus,
  type ErrorPayloadCode,
  errorPayloadSchema,
  nonnegativeNumberMinimum,
  orderProcessConcurrencyHardCap,
  percentageMinimum,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAuthenticatedSurface,
  AdminCurrentRunPanel,
  AdminErpDiagnosticsController,
  AdminPresetController,
  AdminRuntimePolicyController,
  serverFieldErrors,
} from "../src/app/components/admin/admin-authenticated-surface.js";
import type { BackendRead } from "../src/app/lib/api.js";
import {
  adminDemoResetProxyPath,
  adminDemoRunStartProxyPath,
  adminErpChaosProxyPath,
  adminErpChaosResetProxyPath,
  adminMaintenanceCleanupRunsProxyPath,
  adminPresetDuplicateProxyPath,
  adminPresetListProxyPath,
  adminPresetSaveProxyPath,
  adminPublicRuntimePolicyProxyPath,
  dashboardRecoveryProxyPath,
} from "../src/app/lib/control-paths.js";
import { dashboardStaleAfterMs } from "../src/app/lib/presentation/freshness.js";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

class InjectedEventSource {
  static instances: InjectedEventSource[] = [];
  listeners = new Map<string, Set<EventListener>>();

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

  close() {}

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

beforeEach(() => {
  vi.stubGlobal("EventSource", InjectedEventSource);
});

afterEach(() => {
  cleanup();
  InjectedEventSource.instances = [];
  navigation.refresh.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("admin feature controllers", () => {
  it("confirms generated-run cleanup before sending its exact request", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === adminMaintenanceCleanupRunsProxyPath
        ? jsonResponse({
            deletedRunCount: 2,
            deletedSaleOfferCount: 2,
            preservedLatestCount: 15,
            preservedActiveRunCount: 0,
            cutoffBefore: "2026-06-13T00:00:00.000Z",
            cleanedAt: "2026-06-20T00:00:00.000Z",
            correlationId: "corr-cleanup",
          })
        : jsonResponse({ ...recoveryFixture(null), revision: 2 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await user.click(screen.getByRole("button", { name: "Cleanup runs" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cleanup runs" }));
    await user.click(screen.getByRole("button", { name: "Cleanup generated runs" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminMaintenanceCleanupRunsProxyPath);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      keepLatest: 15,
      olderThanDays: 7,
    });
  });

  it("confirms shared ERP reset before sending the reset request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(erpFixture()),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);

    await user.click(screen.getByRole("button", { name: "Reset ERP controls" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(confirmationButton("Reset ERP controls"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminErpChaosResetProxyPath);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("renders protected readiness probes in a collapsed operator block", () => {
    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(null)}
        initialReadiness={{
          status: "available",
          httpStatus: 503,
          data: {
            service: "api",
            status: "unavailable",
            timestamp: "2026-06-20T00:00:00.000Z",
            uptimeSeconds: 1,
            checks: [
              {
                name: "database_reachable",
                status: "unavailable",
                message: "PostgreSQL readiness check failed.",
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByText("Readiness probe details")).toBeTruthy();
    expect(screen.getByText("database_reachable")).toBeTruthy();
    expect(screen.getByText(/PostgreSQL readiness check failed/)).toBeTruthy();
  });

  it("renders the eight admin sections in operational DOM order", () => {
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    const sectionIds = [
      "current-run",
      "readiness",
      "routine-actions",
      "presets",
      "erp-fault-injection",
      "maintenance",
      "public-runtime-policy",
      "diagnostics-links",
    ];
    const sections = sectionIds.map((id) => document.getElementById(id));

    expect(sections.every(Boolean)).toBe(true);
    for (let index = 1; index < sections.length; index += 1) {
      expect(sections[index - 1]?.compareDocumentPosition(sections[index] as Node)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }
    expect(screen.getByRole("navigation", { name: "Admin console sections" })).toBeTruthy();
    expect(screen.getByText(/Runtime budgets, custom limits/).closest("details")?.open).toBe(false);
  });

  it("groups preset configuration into five named fieldsets", () => {
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    for (const name of [
      "Traffic",
      "Inventory",
      "Per-run ERP",
      "Worker and backpressure",
      "Circuit protection",
    ]) {
      expect(screen.getByRole("group", { name })).toBeTruthy();
    }
  });

  it("wraps a long preset description without changing its single-line editor", () => {
    const props = surfaceProps(null);
    if (props.initialPresets.status !== "available") throw new Error("Expected presets.");
    const description =
      "One-second public preview with a deliberately long operator-facing description that must remain readable.";
    const preset = props.initialPresets.data.presets[0];
    if (!preset) throw new Error("Expected a preset.");
    props.initialPresets.data.presets[0] = {
      ...preset,
      display: { ...preset.display, description },
    };

    render(<AdminAuthenticatedSurface {...props} />);

    const displayedDescription = screen.getByText(description);
    expect(displayedDescription.tagName).toBe("P");
    expect(displayedDescription.className).toContain("[overflow-wrap:anywhere]");
    expect(displayedDescription.className).not.toContain("truncate");
    expect(screen.getByLabelText("Description").tagName).toBe("INPUT");
  });

  it("keeps routine refresh disabled during the Retry-After wait", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(null)}
        initialRecovery={{
          status: "unavailable",
          reason: "Recovery is rate limited.",
          retryAfterMs: 120_000,
        }}
      />,
    );

    const refresh = screen.getByRole("button", { name: "Refresh current run" });
    expect((refresh as HTMLButtonElement).disabled).toBe(true);
    refresh.click();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies external lifecycle projections to current-run state and start gating in order", () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
    const source = InjectedEventSource.instances[0];
    const start = screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement;
    const currentRunSection = screen
      .getByRole("heading", { name: "Current run" })
      .closest("section");
    if (!currentRunSection) throw new Error("Expected current-run panel.");
    const currentRunPanel = within(currentRunSection);

    expect(start.disabled).toBe(false);
    const activeRun = runFixture();
    if (activeRun?.status !== "active") throw new Error("Expected active run fixture.");
    const externallyStartedRun = {
      ...activeRun,
      configSnapshot: previewRunConfigSnapshotFixture(),
      startedAt: "2026-06-20T00:00:20.000Z",
      trafficStartedAt: "2026-06-20T00:00:20.000Z",
    } as DashboardProjection["currentRun"];
    act(() =>
      source?.emit(
        "message",
        projectionMessage({
          ...recoveryFixture(externallyStartedRun),
          recoveredAt: "2026-06-20T00:00:21.000Z",
        }),
      ),
    );
    expect(currentRunPanel.getByText("active")).toBeTruthy();
    expect(currentRunPanel.getByRole("status").textContent).toBe("Traffic: active");
    expect(start.disabled).toBe(true);

    act(() =>
      source?.emit(
        "message",
        projectionMessage({
          ...recoveryFixture(completedRunFixture(externallyStartedRun)),
          revision: 2,
          recoveredAt: "2026-06-20T00:00:22.000Z",
        }),
      ),
    );
    expect(currentRunPanel.getAllByText("completed")).toHaveLength(2);
    expect(start.disabled).toBe(false);

    act(() =>
      source?.emit(
        "message",
        projectionMessage({
          ...recoveryFixture(externallyStartedRun),
          recoveredAt: "2026-06-20T00:00:21.000Z",
        }),
      ),
    );
    expect(currentRunPanel.getAllByText("completed")).toHaveLength(2);

    act(() =>
      source?.emit(
        "message",
        projectionMessage({
          ...recoveryFixture(null),
          revision: 3,
          recoveredAt: "2026-06-20T00:00:23.000Z",
        }),
      ),
    );
    expect(currentRunPanel.getByText("idle")).toBeTruthy();
    expect(start.disabled).toBe(false);
  });

  it("reserves recovery copy for failed reads", () => {
    const projection = recoveryFixture(runFixture());
    const recovery = available(projection);
    const commonProps = {
      freshness: {
        state: "retained-fresh" as const,
        observedAt: projection.recoveredAt,
        final: false,
      },
      isRetryScheduled: false,
      onRefresh: async () => undefined,
      recovery,
      retriesExhausted: false,
      retryAttempt: 0,
      retryDelayMs: null,
    };
    const { rerender } = render(
      <AdminCurrentRunPanel
        {...commonProps}
        hasSyncIssue={false}
        isPending={false}
        syncIssue={null}
      />,
    );

    expect(screen.getByText("2026-06-20 00:00:10 UTC")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
    expect(screen.queryByText(/Recovery/)).toBeNull();

    rerender(
      <AdminCurrentRunPanel {...commonProps} hasSyncIssue={false} isPending syncIssue={null} />,
    );
    expect(screen.getByRole("button", { name: "Refreshing status" })).toBeTruthy();

    const syncIssue = { status: "unavailable" as const, reason: "Read failed" };
    rerender(
      <AdminCurrentRunPanel
        {...commonProps}
        hasSyncIssue
        isPending={false}
        syncIssue={syncIssue}
      />,
    );
    expect(screen.getByRole("button", { name: "Retry recovery" })).toBeTruthy();
  });

  it("derives stale admin state after the shared freshness threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-20T00:00:10.000Z"));
    vi.stubGlobal("EventSource", InjectedEventSource);
    const projection = projectionWithExpectedWork(recoveryFixture(runFixture()));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(runFixture())}
        initialRecovery={available(projection)}
      />,
    );
    const source = InjectedEventSource.instances[0];

    act(() => source?.emit("open", new Event("open")));
    expect(screen.queryByText(/ · stale$/)).toBeNull();

    await act(async () => vi.advanceTimersByTimeAsync(dashboardStaleAfterMs));
    expect(screen.getByText("2026-06-20 00:00:10 UTC · stale")).toBeTruthy();
    expect(screen.getByText("Status is stale — refresh before starting")).toBeTruthy();
  });

  it("keeps last-known-good state disconnected until a reconnect refresh succeeds", async () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ...recoveryFixture(null), revision: 2 }))
      .mockResolvedValueOnce(jsonResponse({ ...recoveryFixture(null), revision: 3 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
    const source = InjectedEventSource.instances[0];
    const start = screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement;

    act(() => source?.emit("error", new Event("error")));
    expect(screen.getByText("2026-06-20 00:00:10 UTC · disconnected")).toBeTruthy();
    expect(screen.getByText("Status is stale — refresh before starting")).toBeTruthy();
    expect(start.disabled).toBe(true);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    act(() => source?.emit("open", new Event("open")));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Status is stale — refresh before starting")).toBeNull();
    expect(start.disabled).toBe(false);
  });

  it("keeps a retained terminal run disconnected and blocks start", async () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    const terminalRun = completedRunFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...recoveryFixture(terminalRun), revision: 2 })),
    );
    render(<AdminAuthenticatedSurface {...surfaceProps(terminalRun)} />);
    const source = InjectedEventSource.instances[0];

    act(() => source?.emit("error", new Event("error")));

    expect(screen.getByText("2026-06-20 00:00:10 UTC · disconnected")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("labels unsupported live updates and blocks start", async () => {
    vi.stubGlobal("EventSource", undefined);
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(screen.getByText("2026-06-20 00:00:10 UTC · live updates unsupported")).toBeTruthy();
    expect(screen.getByText("live updates unsupported")).toBeTruthy();
  });

  it("refreshes current-run recovery after a successful start", async () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    const preset = presetFixture();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === adminDemoRunStartProxyPath) {
        return jsonResponse(
          {
            run: {
              ...runFixture(),
              configSnapshot: {
                trafficConfig: preset.trafficConfig,
                inventoryConfig: preset.inventoryConfig,
                erpConfig: preset.erpConfig,
                backpressureConfig: preset.backpressureConfig,
              },
            },
            recovery: { establishedAt: "2026-06-20T00:00:11.000Z" },
            correlationId: "admin-start-accepted",
            timestamp: "2026-06-20T00:00:11.000Z",
          },
          202,
        );
      }
      if (String(input) === dashboardRecoveryProxyPath) {
        return jsonResponse({ ...recoveryFixture(runFixture()), revision: 2 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await user.click(screen.getByRole("button", { name: "Start admin run" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      adminDemoRunStartProxyPath,
      dashboardRecoveryProxyPath,
    ]);
  });

  it("keeps unrelated controls enabled while an ERP mutation is pending", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input) === adminErpChaosProxyPath) return pending.promise;
        throw new Error(`Unexpected fetch: ${String(input)}`);
      }),
    );
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    expect(
      (screen.getByRole("button", { name: "Apply ERP controls" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Reset demo" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    pending.resolve(jsonResponse(erpFixture()));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Apply ERP controls" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("renders the canonical worker concurrency cap", () => {
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    expect(screen.getByLabelText("Worker concurrency").getAttribute("max")).toBeNull();
    expect(screen.getByLabelText("Worker concurrency").getAttribute("min")).toBeNull();
    expect(screen.getByLabelText("Worker concurrency").getAttribute("step")).toBeNull();
    expect(screen.getByText(`Allowed range: 1–${orderProcessConcurrencyHardCap}.`)).toBeTruthy();
  });

  it("describes canonical ERP bounds without inert numeric attributes", () => {
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
    expect(screen.getByLabelText("Latency ms").getAttribute("min")).toBeNull();
    expect(screen.getByLabelText("Error rate").getAttribute("min")).toBeNull();
    expect(screen.getByLabelText("Error rate").getAttribute("step")).toBeNull();
    expect(
      screen.getByText(`Allowed range: ${nonnegativeNumberMinimum}–5000 milliseconds.`),
    ).toBeTruthy();
    expect(screen.getByText(`Allowed range: ${percentageMinimum}–1.`)).toBeTruthy();
  });

  it("keeps a dirty ERP draft across props and submits its exact values", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />,
    );
    const latency = screen.getByLabelText("Latency ms");
    await user.clear(latency);
    await user.type(latency, "250");
    rerender(
      <AdminErpDiagnosticsController
        initialErpChaos={available({ ...erpFixture(), latencyMs: 75 })}
      />,
    );
    expect((screen.getByLabelText("Latency ms") as HTMLInputElement).value).toBe("250");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ...erpFixture(), latencyMs: 250 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      latencyMs: 250,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
    });
  });

  it("retains ERP controls while reporting a newer unavailable read", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />,
    );
    await user.clear(screen.getByLabelText("Latency ms"));
    await user.type(screen.getByLabelText("Latency ms"), "250");

    rerender(
      <AdminErpDiagnosticsController
        initialErpChaos={{ status: "unavailable", reason: "Latest ERP read failed" }}
      />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Latest ERP read failed")).toBeTruthy();
    expect((screen.getByLabelText("Latency ms") as HTMLInputElement).value).toBe("250");
    expect(
      (screen.getByRole("button", { name: "Apply ERP controls" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("disables ERP Apply when no authoritative caps are available", () => {
    render(
      <AdminErpDiagnosticsController
        initialErpChaos={{ status: "unavailable", reason: "ERP not loaded" }}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Apply ERP controls" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Reset ERP controls" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("keeps an empty operation status mounted until a success message arrives", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(erpFixture())),
    );
    const user = userEvent.setup();
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    await user.type(screen.getByLabelText("Latency ms"), "0");
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    await waitFor(() => expect(status.textContent).toBe("ERP diagnostics updated."));
    expect(screen.getByRole("status")).toBe(status);
  });

  it("classifies authoritative field rejections separately from parse failures", () => {
    expect(
      serverFieldErrors(
        { issues: [{ path: ["policy", "publicCustomLimits", "maxBuyers"] }] },
        "policy",
      ).maxBuyers?.code,
    ).toBe("server_rejected");
  });

  it("keeps a blank ERP draft, validates it on blur, and sends no fallback request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);

    const latency = screen.getByLabelText("Latency ms");
    await user.clear(latency);
    await user.tab();
    expect((latency as HTMLInputElement).value).toBe("");
    expect(latency.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Latency is required.")).toBeTruthy();
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Correct the highlighted fields.").parentElement).toBe(
      document.activeElement,
    );
    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    expect(screen.getByText("Correct the highlighted fields.").parentElement).toBe(
      document.activeElement,
    );
  });

  it("preserves malformed ERP text through blur and submit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);

    const latency = screen.getByLabelText("Latency ms");
    expect(latency.getAttribute("type")).toBe("text");
    expect(latency.getAttribute("inputmode")).toBe("numeric");
    await user.clear(latency);
    await user.type(latency, "Infinity");
    await user.tab();
    expect((latency as HTMLInputElement).value).toBe("Infinity");
    expect(
      screen.getByText("Latency must be a finite number.", {
        selector: "#erp-chaos-latencyMs-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((latency as HTMLInputElement).value).toBe("Infinity");
  });

  it("keeps ERP controls usable after a structured server rejection and retries exactly", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () =>
      attempts++ === 0
        ? canonicalErrorResponse("Rejected", 400, "invalid_chaos_configuration", {
            forcedOutage: { allowed: false, actual: true },
          })
        : jsonResponse({ ...erpFixture(), forcedOutage: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
    await user.click(screen.getByLabelText("Forced outage"));

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    const forcedOutage = screen.getByLabelText("Forced outage");
    expect(
      await screen.findByText(
        "The service rejected this value. Review its permitted range and try again.",
        { selector: "#erp-chaos-forcedOutage-error" },
      ),
    ).toBeTruthy();
    expect(forcedOutage.getAttribute("aria-invalid")).toBe("true");
    expect(forcedOutage.getAttribute("aria-describedby")).toBe("erp-chaos-forcedOutage-error");
    expect(document.querySelector("#erp-chaos-forcedOutage-error")).toBeTruthy();
    expect((forcedOutage as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("ERP diagnostics are unavailable.")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("ERP diagnostics updated.")).toBeTruthy();
    expect(screen.getByLabelText("Forced outage").getAttribute("aria-invalid")).toBeNull();
  });

  it("clears stale ERP validation after a successful authoritative reset", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(erpFixture())),
    );
    const user = userEvent.setup();
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
    await user.clear(screen.getByLabelText("Latency ms"));
    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    expect(
      screen.getByText("Latency is required.", {
        selector: "#erp-chaos-latencyMs-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reset ERP controls" }));
    await user.click(confirmationButton("Reset ERP controls"));
    await waitFor(() => expect(screen.queryByText("Latency is required.")).toBeNull());
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();
    expect((screen.getByLabelText("Latency ms") as HTMLInputElement).value).toBe("50");
  });

  it("reconciles reset recovery into current-run and preset start gating", async () => {
    const knownRecoveryPath = `${dashboardRecoveryProxyPath}?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=33333333-3333-4333-8333-333333333333`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === adminDemoResetProxyPath) {
        return jsonResponse({
          failedRunCount: 1,
          closedSaleOfferCount: 1,
          cleanedQueueCount: 1,
          cleanedJobCount: 2,
          correlationId: "corr-reset",
          resetAt: "2026-06-20T00:00:12.000Z",
        });
      }
      if (String(input) === knownRecoveryPath) {
        return jsonResponse({
          ...recoveryFixture(null),
          revision: 2,
          recoveredAt: "2026-06-20T00:00:12.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(runFixture())} />);
    expect(
      (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await user.click(confirmationButton("Reset demo"));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      adminDemoResetProxyPath,
      knownRecoveryPath,
    ]);
  });

  it("reconciles recovery even when the reset response is unavailable", async () => {
    const knownRecoveryPath = `${dashboardRecoveryProxyPath}?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=33333333-3333-4333-8333-333333333333`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === adminDemoResetProxyPath) {
        return canonicalErrorResponse("Reset outcome is uncertain.", 503);
      }
      if (String(input) === knownRecoveryPath) {
        return jsonResponse({
          ...recoveryFixture(null),
          revision: 2,
          recoveredAt: "2026-06-20T00:00:12.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(runFixture())} />);

    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await user.click(confirmationButton("Reset demo"));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(await screen.findByText("Something didn't work on our side")).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      adminDemoResetProxyPath,
      knownRecoveryPath,
    ]);
  });

  it("keeps preset mutation failures separate from dashboard recovery retry", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === adminPresetSaveProxyPath) {
        return canonicalErrorResponse("Preset save failed", 503, "backend_unavailable");
      }
      if (String(input) === dashboardRecoveryProxyPath) {
        return jsonResponse({ ...recoveryFixture(null), revision: 2 });
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await user.click(screen.getByRole("button", { name: "Save preset" }));
    expect(
      await screen.findByText("The latest information is temporarily unavailable"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Refresh current run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      adminPresetSaveProxyPath,
      dashboardRecoveryProxyPath,
    ]);
  });

  it("adopts changed same-slug preset props while the draft is clean", async () => {
    const recovery = available(recoveryFixture(null));
    const initialPresets = presetListFixture("Custom");
    const { rerender } = render(
      <AdminPresetController initialPresets={initialPresets} recovery={recovery} />,
    );
    rerender(
      <AdminPresetController
        initialPresets={presetListFixture("Server updated")}
        recovery={recovery}
      />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Server updated"),
    );
  });

  it("suppresses invalid preset save/start requests and clears selected-mode errors", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    const buyers = screen.getByLabelText("Buyer count");
    await user.clear(buyers);
    await user.click(screen.getByRole("button", { name: "Save preset" }));
    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("Buyer count is required.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "constant-arrival-rate" }));
    expect(screen.queryByText("Buyer count is required.")).toBeNull();
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "buyer-spike" }));
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Buyer count").getAttribute("aria-invalid")).toBeNull();
  });

  it("preserves incomplete, malformed, and fractional preset numbers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    const buyers = screen.getByLabelText("Buyer count");
    expect(buyers.getAttribute("type")).toBe("text");
    expect(buyers.getAttribute("inputmode")).toBe("numeric");

    await user.clear(buyers);
    await user.type(buyers, "-");
    await user.tab();
    expect((buyers as HTMLInputElement).value).toBe("-");
    expect(
      screen.getByText("Buyer count must be a finite number.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.clear(buyers);
    await user.type(buyers, "oops");
    await user.tab();
    expect((buyers as HTMLInputElement).value).toBe("oops");
    expect(
      screen.getByText("Buyer count must be a finite number.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.clear(buyers);
    await user.type(buyers, "2.5");
    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    expect((buyers as HTMLInputElement).value).toBe("2.5");
    expect(
      screen.getByText("Buyer count must be a whole number.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      mode: "buyer spike",
      prepare: async (user: ReturnType<typeof userEvent.setup>) => {
        const buyers = screen.getByLabelText("Buyer count");
        await user.clear(buyers);
        await user.type(buyers, "50000");
        await user.click(screen.getByLabelText("Duplicate attempts"));
      },
      links: ["Buyer count", "Duplicate attempts"],
      values: [["Buyer count", "50000"]] as const,
      checkedLabel: "Duplicate attempts",
      message:
        "This configuration creates 100000 requests; the permitted maximum is 90000 requests.",
    },
    {
      mode: "constant arrival",
      prepare: async (user: ReturnType<typeof userEvent.setup>) => {
        await user.click(screen.getByRole("button", { name: "constant-arrival-rate" }));
        const rate = screen.getByLabelText("Requests per second");
        const duration = screen.getByLabelText("Duration seconds");
        await user.clear(rate);
        await user.type(rate, "1000");
        await user.clear(duration);
        await user.type(duration, "91");
      },
      links: ["Requests per second", "Duration"],
      values: [
        ["Requests per second", "1000"],
        ["Duration seconds", "91"],
      ] as const,
      checkedLabel: undefined,
      message:
        "This configuration creates 91000 requests; the permitted maximum is 90000 requests.",
    },
  ])("blocks derived deployment totals for $mode save and start", async ({
    prepare,
    links,
    values,
    checkedLabel,
    message,
  }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const runtimePolicy = runtimePolicyFixture(100_000, 300);
    runtimePolicy.policy.deploymentHardCaps.maxTotalRequests = 90_000;
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
        runtimePolicy={available(runtimePolicy)}
      />,
    );
    await prepare(user);

    await user.click(screen.getByRole("button", { name: "Save preset" }));
    expect(fetchMock).not.toHaveBeenCalled();
    for (const label of links) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(document.body.textContent).toContain(message);

    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    expect(fetchMock).not.toHaveBeenCalled();
    for (const label of links) {
      expect(screen.getByRole("link", { name: label })).toBeTruthy();
    }
    expect(document.body.textContent).toContain(message);
    for (const [label, value] of values) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(value);
    }
    if (checkedLabel) {
      expect((screen.getByLabelText(checkedLabel) as HTMLInputElement).checked).toBe(true);
    }
  });

  it("sends a valid run start unchanged and keeps authoritative rejection guidance usable", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      canonicalErrorResponse("Rejected", 400, "invalid_run_configuration", {
        violationCode: "public_traffic_mode_not_allowed",
        path: ["trafficConfig", "mode"],
        value: "buyer-spike",
        internal: "private-detail",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const preset = presetFixture();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminDemoRunStartProxyPath);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      presetSlug: preset.slug,
      configOverride: {
        trafficConfig: preset.trafficConfig,
        inventoryConfig: preset.inventoryConfig,
        erpConfig: preset.erpConfig,
        backpressureConfig: preset.backpressureConfig,
      },
    });
    expect(await screen.findByText("Check the values and try again")).toBeTruthy();
    expect(
      screen
        .getByRole("link", {
          name: "The service rejected this value. Review its permitted range and try again.",
        })
        .getAttribute("href"),
    ).toBe("#preset-mode");
    const mode = document.querySelector("#preset-mode");
    expect(mode).toBeTruthy();
    expect(mode?.getAttribute("aria-invalid")).toBe("true");
    expect(mode?.getAttribute("aria-describedby")).toBe("preset-mode-error");
    expect(document.querySelector("#preset-mode-error")?.textContent).toBe(
      "The service rejected this value. Review its permitted range and try again.",
    );
    expect(document.querySelector('a[href="#preset-internal"]')).toBeNull();
    expect(document.body.textContent).not.toContain("private-detail");
    expect(
      (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(fetchMock.mock.calls[0]?.[1]?.body);
  });

  it("renders a server run conflict after fresh-looking idle state without claiming success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        canonicalErrorResponse("Another run started first.", 409, "run_conflict", {
          conflictReason: "active_run_exists",
        }),
      ),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Start admin run" }));

    expect(await screen.findByText("A demo run is already in progress")).toBeTruthy();
    expect(screen.queryByText("Admin run accepted.")).toBeNull();
  });

  it("announces an accepted admin start before offering user-activated Watch navigation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const preset = presetFixture();
        return jsonResponse(
          {
            run: {
              ...runFixture(),
              configSnapshot: {
                trafficConfig: preset.trafficConfig,
                inventoryConfig: preset.inventoryConfig,
                erpConfig: preset.erpConfig,
                backpressureConfig: preset.backpressureConfig,
              },
            },
            recovery: { establishedAt: "2026-06-20T00:00:01.000Z" },
            correlationId: "admin-start-accepted",
            timestamp: "2026-06-20T00:00:01.000Z",
          },
          202,
        );
      }),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    const status = screen.getAllByRole("status")[0];
    if (!status) throw new Error("Expected the admin operation status region.");
    expect(status.textContent).toBe("");
    const assign = vi.fn();
    const navigationWindow = Object.create(window) as Window;
    Object.defineProperty(navigationWindow, "location", { value: { assign } });
    vi.stubGlobal("window", navigationWindow);

    await user.click(screen.getByRole("button", { name: "Start admin run" }));

    await waitFor(() => expect(status.textContent).toBe("Admin run accepted."));
    expect(screen.getAllByRole("status")[0]).toBe(status);
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe("/watch");
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows actionable guidance when residual preset text validation rejects save", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.clear(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Save preset" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "Check the values and try again. Use the available fields and limits for this operation.",
      ),
    ).toBeTruthy();
  });

  it("rejects a duplicate when the visible slug is cleared ahead of React's state commit", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("Unexpected duplicate fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    const duplicateSlugInput = screen.getByLabelText("Duplicate slug") as HTMLInputElement;
    expect(duplicateSlugInput.value).toBe("custom-copy");
    duplicateSlugInput.value = "";

    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "Check the values and try again. Use the available fields and limits for this operation.",
      ),
    ).toBeTruthy();
  });

  it("submits the current duplicate slug exactly through the shared contract", async () => {
    const clone = presetWithSlug("preview-clone", "Custom Copy");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === adminPresetDuplicateProxyPath && init?.method === "POST") {
        return jsonResponse({
          preset: clone,
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      if (path === adminPresetListProxyPath) {
        return jsonResponse({
          presets: [presetFixture(), clone],
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    const duplicateSlugInput = screen.getByLabelText("Duplicate slug");
    await user.clear(duplicateSlugInput);
    await user.type(duplicateSlugInput, "preview-clone");
    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminPresetDuplicateProxyPath);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sourceSlug: "custom",
      targetSlug: "preview-clone",
      displayName: "Custom Copy",
    });
  });

  it("turns a duplicate slug conflict into edit guidance without recovery retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        canonicalErrorResponse("A preset already uses that slug.", 409, "preset_conflict", {
          conflictReason: "slug_in_use",
          slug: "private-duplicate-slug",
          internal: "private-detail",
        }),
      ),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.clear(screen.getByLabelText("Duplicate slug"));
    await user.type(screen.getByLabelText("Duplicate slug"), "taken-slug");
    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    expect(await screen.findByText("That preset slug is already in use")).toBeTruthy();
    expect(screen.getByText("Choose another slug")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(document.body.textContent).not.toContain("private-duplicate-slug");
    expect(document.body.textContent).not.toContain("private-detail");
  });

  it("preserves an in-progress preset draft while refreshed props update start gating", async () => {
    const user = userEvent.setup();
    const props = surfaceProps(null);
    const { rerender } = render(<AdminAuthenticatedSurface {...props} />);
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Edited locally");
    await user.click(screen.getByRole("button", { name: "Custom" }));

    rerender(
      <AdminAuthenticatedSurface
        {...props}
        initialPresets={presetListFixture("Server updated")}
        initialRecovery={available(recoveryFixture(runFixture()))}
      />,
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited locally");
    expect(
      (screen.getByRole("button", { name: "Start admin run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("shares a recovered runtime policy with dirty preset validation", async () => {
    const recovered = runtimePolicyFixture(1000, 300);
    recovered.policy.deploymentHardCaps.maxBuyers = 1000;
    const fetchMock = vi.fn(async () => jsonResponse(recovered));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Edited locally");
    const presetBuyerCount = () => document.querySelector<HTMLInputElement>("#preset-buyerCount");
    expect(document.querySelector("#preset-buyerCount-help")?.textContent).not.toContain(
      "Maximum: 1000.",
    );

    await user.click(screen.getByRole("button", { name: "Refresh policy" }));
    await waitFor(() =>
      expect(document.querySelector("#preset-buyerCount-help")?.textContent).toContain(
        "Maximum: 1000.",
      ),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited locally");

    if (!presetBuyerCount()) throw new Error("Expected preset buyer-count control.");
    await user.clear(presetBuyerCount() as HTMLInputElement);
    await user.type(presetBuyerCount() as HTMLInputElement, "1001");
    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      screen.getByText("Buyer count must be at most 1000.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();
  });

  it("clears stale preset validation when an authoritative policy changes", async () => {
    const initial = runtimePolicyFixture(1000, 300);
    initial.policy.deploymentHardCaps.maxBuyers = 1000;
    const refreshed = runtimePolicyFixture(2000, 300);
    refreshed.policy.deploymentHardCaps.maxBuyers = 2000;
    const fetchMock = vi.fn(async () => jsonResponse(refreshed));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(null)}
        initialRuntimePolicy={available(initial)}
      />,
    );
    const presetBuyerCount = () => document.querySelector<HTMLInputElement>("#preset-buyerCount");
    if (!presetBuyerCount()) throw new Error("Expected preset buyer-count control.");

    await user.clear(presetBuyerCount() as HTMLInputElement);
    await user.type(presetBuyerCount() as HTMLInputElement, "1001");
    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    expect(
      screen.getByText("Buyer count must be at most 1000.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh policy" }));
    await waitFor(() =>
      expect(document.querySelector("#preset-buyerCount-help")?.textContent).toContain(
        "Maximum: 2000.",
      ),
    );
    expect(presetBuyerCount()?.value).toBe("1001");
    expect(presetBuyerCount()?.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("Buyer count must be at most 1000.")).toBeNull();

    await user.clear(presetBuyerCount() as HTMLInputElement);
    await user.type(presetBuyerCount() as HTMLInputElement, "2001");
    await user.click(screen.getByRole("button", { name: "Start admin run" }));
    expect(
      screen.getByText("Buyer count must be at most 2000.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a dirty policy draft across props and adopts an explicit save response", async () => {
    const initialResponse = runtimePolicyFixture(10_000, 300);
    initialResponse.policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    initialResponse.policy.publicCustomLimits.allowForcedOutage = true;
    const initial = available(initialResponse);
    const user = userEvent.setup();
    const { rerender } = render(<AdminRuntimePolicyController initialRuntimePolicy={initial} />);
    expect(screen.queryByLabelText("ERP forced outage")).toBeNull();
    expect(screen.queryByLabelText("Allow forced outage")).toBeNull();
    const maxBuyers = screen.getByLabelText("Max buyers");
    await user.clear(maxBuyers);
    await user.type(maxBuyers, "4321");

    rerender(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(9999, 400))}
      />,
    );
    expect((screen.getByLabelText("Max buyers") as HTMLInputElement).value).toBe("4321");

    const saved = runtimePolicyFixture(4321, 777);
    saved.policy.publicCustomDefaults.erpConfig.forcedOutage = true;
    saved.policy.publicCustomLimits.allowForcedOutage = true;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(saved),
    );
    vi.stubGlobal("fetch", fetchMock);
    await user.click(screen.getByRole("button", { name: "Save public policy" }));

    await waitFor(() =>
      expect((screen.getByLabelText("Budget window seconds") as HTMLInputElement).value).toBe(
        "777",
      ),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminPublicRuntimePolicyProxyPath);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      policy: {
        publicCustomDefaults: { erpConfig: { forcedOutage: true } },
        publicCustomLimits: { allowForcedOutage: true, maxBuyers: 4321 },
      },
    });
    expect((screen.getByLabelText("Max buyers") as HTMLInputElement).value).toBe("4321");
  });

  it("surfaces a newer policy failure while retaining dirty drafts and preset caps", async () => {
    const user = userEvent.setup();
    const initialPolicy = runtimePolicyFixture(10_000, 300);
    initialPolicy.policy.deploymentHardCaps.maxBuyers = 1000;
    const props = {
      ...surfaceProps(null),
      initialRuntimePolicy: available(initialPolicy),
    };
    const { rerender } = render(<AdminAuthenticatedSurface {...props} />);
    await user.clear(screen.getByLabelText("Max buyers"));
    await user.type(screen.getByLabelText("Max buyers"), "4321");
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Edited locally");

    rerender(
      <AdminAuthenticatedSurface
        {...props}
        initialRuntimePolicy={{ status: "unavailable", reason: "Latest policy read failed" }}
      />,
    );

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByText("Latest policy read failed")).toBeTruthy();
    expect((screen.getByLabelText("Max buyers") as HTMLInputElement).value).toBe("4321");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited locally");
    expect(document.querySelector("#preset-buyerCount-help")?.textContent).toContain(
      "Maximum: 1000.",
    );
  });

  it("blocks invalid policy saves and links every corrective control with readable labels", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );
    await user.clear(screen.getByLabelText("Max buyers"));
    await user.type(screen.getByLabelText("Max buyers"), "500");
    await user.click(screen.getByRole("button", { name: "Save public policy" }));

    expect(fetchMock).not.toHaveBeenCalled();
    const buyerLink = screen.getByRole("link", { name: "Buyer count" });
    const limitLink = screen.getByRole("link", { name: "Maximum buyers" });
    expect(buyerLink.getAttribute("href")).toBe("#runtime-policy-buyerCount");
    expect(limitLink.getAttribute("href")).toBe("#runtime-policy-maxBuyers");
    expect(document.querySelector(buyerLink.getAttribute("href") ?? "")).toBeTruthy();
    expect(document.querySelector(limitLink.getAttribute("href") ?? "")).toBeTruthy();
    expect(document.body.textContent).not.toContain("maxBuyers");
  });

  it("clears hidden policy validation when the selected traffic mode changes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );
    await user.clear(screen.getByLabelText("Buyer count"));
    await user.click(screen.getByRole("button", { name: "Save public policy" }));
    expect(
      screen.getByText("Buyer count is required.", {
        selector: "#runtime-policy-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "constant-arrival-rate" }));
    expect(screen.queryByText("Buyer count is required.")).toBeNull();
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();
    await user.click(screen.getByRole("button", { name: "buyer-spike" }));
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("");
    expect(screen.getByLabelText("Buyer count").getAttribute("aria-invalid")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves an authoritative policy after save failure and allows retry", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () =>
      attempts++ === 0
        ? canonicalErrorResponse("Save failed", 503, "backend_unavailable")
        : jsonResponse(runtimePolicyFixture(10_000, 400)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Save public policy" }));
    expect(
      await screen.findByText("The latest information is temporarily unavailable"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Max buyers")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save public policy" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText("Budget window seconds") as HTMLInputElement).value).toBe("400");
  });

  it("clears stale policy validation after a successful authoritative refresh", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(runtimePolicyFixture(10_000, 400))),
    );
    const user = userEvent.setup();
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );
    await user.clear(screen.getByLabelText("Max buyers"));
    await user.type(screen.getByLabelText("Max buyers"), "500");
    await user.click(screen.getByRole("button", { name: "Save public policy" }));
    expect(screen.getByText("Correct the highlighted fields.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh policy" }));
    await waitFor(() => expect(screen.queryByText("Correct the highlighted fields.")).toBeNull());
    expect((screen.getByLabelText("Budget window seconds") as HTMLInputElement).value).toBe("400");
  });

  it("refreshes the runtime policy only for the canonical session-expired error", async () => {
    const fetchMock = vi.fn(async () =>
      canonicalErrorResponse("Session expired", 401, "admin_session_required"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Refresh policy" }));
    await waitFor(() => expect(navigation.refresh).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("disables the archive control for protected presets", () => {
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    expect(
      (screen.getByRole("button", { name: "Archive preset" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("performs no fetch when archive confirmation is cancelled", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => {
      throw new Error("Unexpected archive fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Preset archived.")).toBeNull();
  });

  it("closes an archive confirmation and refreshes server auth state on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => canonicalErrorResponse("Session expired", 401, "admin_session_required")),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("keeps non-session 401 diagnostics instead of refreshing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        canonicalErrorResponse("Control token missing", 401, "control_token_required"),
      ),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));

    expect(await screen.findByText("Operator connection needs attention")).toBeTruthy();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  it("disables stale archive capability after a not-archivable conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        canonicalErrorResponse(
          "Only operator-created admin presets can be archived.",
          409,
          "preset_conflict",
          {
            conflictReason: "not_archivable",
            slug: "private-archive-slug",
            internal: "private-detail",
          },
        ),
      ),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));

    expect(await screen.findByText("This preset can no longer be archived")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Archive preset" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("link", { name: "Refresh presets" }).getAttribute("href")).toBe(
      "/admin",
    );
    expect(document.body.textContent).not.toContain("private-archive-slug");
    expect(document.body.textContent).not.toContain("private-detail");
  });

  it("keeps archive failures visible and allows retry in the same dialog", async () => {
    let deleteAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "DELETE" && deleteAttempts++ === 0) {
          return canonicalErrorResponse("Archive temporarily unavailable", 503);
        }
        if (init?.method === "DELETE") {
          return jsonResponse({
            slug: "operator-dup",
            archivedAt: "2026-06-20T00:00:12.000Z",
            timestamp: "2026-06-20T00:00:12.000Z",
          });
        }
        return jsonResponse({ presets: [], timestamp: "2026-06-20T00:00:12.000Z" });
      }),
    );
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The latest information is temporarily unavailable",
    );
    expect(screen.getByText("Technical details")).toBeTruthy();
    await user.click(confirmationButton("Archive preset"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleteAttempts).toBe(2);
  });

  it("archives the selected preset after confirmation, refreshes the list, and selects a remaining preset", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === adminPresetListProxyPath && init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({ slug: "operator-dup" });
        return jsonResponse({
          slug: "operator-dup",
          archivedAt: "2026-06-20T00:00:12.000Z",
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      if (path === adminPresetListProxyPath) {
        return jsonResponse({
          presets: [presetFixture()],
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup"), presetFixture()],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));

    await waitFor(() => expect(screen.getByText("Preset archived.")).toBeTruthy());
    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method])).toEqual([
      [adminPresetListProxyPath, "DELETE"],
      [adminPresetListProxyPath, undefined],
    ]);
    expect(screen.queryByRole("button", { name: "Operator Dup" })).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Custom");
    expect((screen.getByLabelText("Duplicate slug") as HTMLInputElement).value).toBe("custom-copy");
  });

  it("keeps an archive success after the follow-up list refresh fails", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        return jsonResponse({
          slug: "operator-dup",
          archivedAt: "2026-06-20T00:00:12.000Z",
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      return canonicalErrorResponse("List refresh failed", 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup"), presetFixture()],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));

    await waitFor(() => expect(screen.getByText("Preset archived.")).toBeTruthy());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Operator Dup" })).toBeNull();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps a duplicate success when the follow-up list refresh fails", async () => {
    const clone = presetWithSlug("preview-clone", "Custom Copy");
    const { canArchive: _canArchive, ...cloneContract } = clone;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === adminPresetDuplicateProxyPath && init?.method === "POST") {
        return jsonResponse({ preset: cloneContract, timestamp: "2026-06-20T00:00:12.000Z" });
      }
      return canonicalErrorResponse("List refresh failed", 503);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.clear(screen.getByLabelText("Duplicate slug"));
    await user.type(screen.getByLabelText("Duplicate slug"), "preview-clone");
    await user.click(screen.getByRole("button", { name: "Duplicate" }));

    await waitFor(() => expect(screen.getByText("Preset duplicated.")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Custom Copy" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Archive preset" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the preset editor after archiving the last remaining preset", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === adminPresetListProxyPath && init?.method === "DELETE") {
        return jsonResponse({
          slug: "operator-dup",
          archivedAt: "2026-06-20T00:00:12.000Z",
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      if (path === adminPresetListProxyPath) {
        return jsonResponse({
          presets: [],
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    expect((screen.getByLabelText("Duplicate slug") as HTMLInputElement).value).toBe(
      "operator-dup-copy",
    );
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));

    await waitFor(() => expect(screen.getByText("Preset archived.")).toBeTruthy());
    expect(screen.getByText("No admin presets are available.")).toBeTruthy();
    expect(screen.queryByLabelText("Duplicate slug")).toBeNull();
  });

  it("keeps the archive control disabled while an archive is pending", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === adminPresetListProxyPath && init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({ slug: "operator-dup" });
        return pending.promise;
      }
      if (path === adminPresetListProxyPath) {
        return jsonResponse({
          presets: [presetFixture()],
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      throw new Error(`Unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available<AdminPresetListResponse>({
          presets: [archivablePresetFixture("operator-dup", "Operator Dup")],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(confirmationButton("Archive preset"));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect(fetchMock).toHaveBeenCalledOnce();

    pending.resolve(
      jsonResponse({
        slug: "operator-dup",
        archivedAt: "2026-06-20T00:00:12.000Z",
        timestamp: "2026-06-20T00:00:12.000Z",
      }),
    );
  });
});

function surfaceProps(currentRun: DashboardProjection["currentRun"]) {
  return {
    initialErpChaos: available(erpFixture()),
    initialPresets: available<AdminPresetListResponse>({
      presets: [presetFixture()],
      timestamp: "2026-06-20T00:00:10.000Z",
    }),
    initialRecovery: available(recoveryFixture(currentRun)),
    initialReadiness: available({
      service: "api" as const,
      status: "ok" as const,
      timestamp: "2026-06-20T00:00:10.000Z",
      uptimeSeconds: 10,
      checks: [],
    }),
    initialRuntimePolicy: { status: "unavailable" as const, reason: "Not loaded" },
  };
}

function presetListFixture(name: string): BackendRead<AdminPresetListResponse> {
  return available({
    presets: [{ ...presetFixture(), display: { ...presetFixture().display, name } }],
    timestamp: "2026-06-20T00:00:11.000Z",
  });
}

function available<T>(data: T): BackendRead<T> {
  return { status: "available", data, httpStatus: 200 };
}

function canonicalErrorResponse(
  message: string,
  status: number,
  code: ErrorPayloadCode = "backend_unavailable",
  details?: Record<string, unknown>,
): Response {
  return jsonResponse(
    errorPayloadSchema.parse({
      code,
      message,
      ...(details ? { details } : {}),
      correlationId: "admin-controller-error",
      timestamp: "2026-06-20T00:00:00.000Z",
    }),
    status,
  );
}

function erpFixture(): ErpChaosStatus {
  return {
    latencyMs: 50,
    maxTps: 100,
    errorRate: 0,
    forcedOutage: false,
    updatedAt: "2026-06-20T00:00:10.000Z",
    effectiveSafetyCaps: {
      maxLatencyMs: 5000,
      minMaxTps: 1,
      maxErrorRate: 1,
      allowForcedOutage: true,
    },
  };
}

function recoveryFixture(currentRun: DashboardProjection["currentRun"]): DashboardProjection {
  const scope = recoveryScope(currentRun);
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    scopeId: dashboardProjectionScopeId(scope),
    revision: 1,
    correlationId: "corr-web-recovery",
    scope,
    currentRun,
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

function projectionWithExpectedWork(projection: DashboardProjection): DashboardProjection {
  return {
    ...projection,
    businessOutcome: {
      acceptedReservations: 1,
      reservedUnits: 1,
      soldOutRejections: 0,
      queuedOrders: 1,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 0,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    },
  };
}

function recoveryScope(currentRun: DashboardProjection["currentRun"]) {
  if (!currentRun) return null;
  if (!currentRun.saleOfferId) {
    throw new Error(`Run ${currentRun.runId} fixture requires a sale offer.`);
  }
  return { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId };
}

function runFixture(): DashboardProjection["currentRun"] {
  return {
    runId: "11111111-1111-4111-8111-111111111111",
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Custom",
    operatorMode: "admin",
    status: "active",
    trafficStatus: "active",
    configSnapshot: presetFixture(),
    saleOfferId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-06-20T00:00:00.000Z",
    trafficStartedAt: "2026-06-20T00:00:00.000Z",
  };
}

function completedRunFixture(
  currentRun: DashboardProjection["currentRun"] = runFixture(),
): Extract<NonNullable<DashboardProjection["currentRun"]>, { status: "completed" }> {
  const run = currentRun;
  if (run?.status !== "active") throw new Error("Expected active run fixture.");
  return {
    ...run,
    status: "completed",
    trafficStatus: "succeeded",
    trafficEndedAt: "2026-06-20T00:00:21.000Z",
    finalizedAt: "2026-06-20T00:00:22.000Z",
  };
}

function projectionMessage(projection: DashboardProjection): MessageEvent {
  return new MessageEvent("message", { data: JSON.stringify(projection) });
}

function confirmationButton(name: string): HTMLElement {
  return within(screen.getByRole("alertdialog")).getByRole("button", { name });
}

function presetFixture(): AdminPresetListItem {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "custom",
    visibility: "admin",
    isEditable: true,
    isCustom: true,
    canArchive: false,
    display: { name: "Custom", description: "Fixture", sortOrder: 100, outcomeFocus: [] },
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 1000,
      duplicateEachBuyerAttempt: false,
      startDelaySeconds: 0,
      maxDurationSeconds: 2,
      quantityPerAttempt: 1,
    },
    inventoryConfig: { startingStock: 250, quantityPerCheckout: 1, reservationHoldMinutes: 15 },
    erpConfig: {
      latencyMs: 80,
      maxTps: 100,
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
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  };
}

function presetWithSlug(slug: string, name: string): AdminPresetListItem {
  const base = presetFixture();
  return {
    ...base,
    slug,
    display: { ...base.display, name },
  };
}

function archivablePresetFixture(slug: string, name: string): AdminPresetListItem {
  const base = presetFixture();
  return {
    ...base,
    slug,
    visibility: "admin",
    isEditable: true,
    isCustom: false,
    canArchive: true,
    display: { ...base.display, name },
  };
}

function runtimePolicyFixture(
  maxBuyers: number,
  windowSeconds: number,
): AdminPublicRuntimePolicyResponse {
  const config = presetFixture();
  const publicCustomDefaults = {
    trafficConfig: config.trafficConfig,
    inventoryConfig: config.inventoryConfig,
    erpConfig: config.erpConfig,
    backpressureConfig: config.backpressureConfig,
  };
  return {
    id: "active",
    policy: {
      isPublicRunBudgetEnforced: true,
      publicRunBudget: { windowSeconds, perVisitorMaxStarts: 2, globalMaxStarts: 6 },
      publicCustomDefaults,
      publicCustomLimits: {
        maxTotalRequests: 10_000,
        maxBuyers,
        maxRequestsPerSecond: 1000,
        maxTrafficDurationSeconds: 120,
        maxTrafficStartDelaySeconds: 10,
        maxPreAllocatedVus: 1000,
        maxVus: 1000,
        maxStartingStock: 1000,
        maxErpLatencyMs: 2000,
        minErpMaxTps: 1,
        maxErpMaxTps: 100,
        maxErpErrorRate: 0.25,
        allowForcedOutage: false,
        allowedTrafficModes: ["buyer-spike", "constant-arrival-rate"],
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
    },
    updatedAt: "2026-06-20T00:00:10.000Z",
    correlationId: "corr-policy",
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
