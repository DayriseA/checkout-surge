// @vitest-environment jsdom

import {
  type AdminPresetListItem,
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  type DashboardProjection,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  type ErpChaosStatus,
  type ErrorPayloadCode,
  errorPayloadSchema,
  nonnegativeNumberMinimum,
  orderProcessConcurrencyHardCap,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminAuthenticatedSurface,
  AdminCurrentRunPanel,
  AdminErpDiagnosticsController,
  AdminMaintenancePanel,
  AdminPresetController,
  AdminRuntimePolicyController,
  policyChangeSummary,
  serverFieldErrors,
} from "../src/app/components/admin/admin-authenticated-surface.js";
import { buildEffectiveRunConfig, draftFromPreset } from "../src/app/lib/admin-drafts.js";
import type { BackendRead } from "../src/app/lib/api.js";
import {
  adminDemoResetProxyPath,
  adminDemoRunStartProxyPath,
  adminErpChaosProxyPath,
  adminErpChaosResetProxyPath,
  adminMaintenanceCleanupRunsProxyPath,
  adminPresetCopyToCustomProxyPath,
  adminPresetDuplicateProxyPath,
  adminPresetListProxyPath,
  adminPresetSaveProxyPath,
  adminPublicRuntimePolicyProxyPath,
  dashboardRecoveryProxyPath,
} from "../src/app/lib/control-paths.js";
import { dashboardStaleAfterMs } from "../src/app/lib/presentation/freshness.js";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
// Admission timing is exercised with the real transport in run-estimate.test.tsx.
// These existing workflows isolate their recovery, validation and mutation boundaries.
vi.mock("../src/app/components/use-run-estimate", () => ({
  useRunEstimate: () => ({ state: { status: "inactive" }, blocksStart: false, reject: vi.fn() }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

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

beforeEach(() => {
  vi.stubGlobal("EventSource", InjectedEventSource);
});

afterEach(() => {
  cleanup();
  InjectedEventSource.instances = [];
  navigation.refresh.mockReset();
  navigation.push.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("admin feature controllers", () => {
  describe.each([
    ["preset save", "Save preset", null, adminPresetSaveProxyPath, "Buyer count", "1234"],
    [
      "policy save",
      "Save public policy",
      "Save public policy",
      adminPublicRuntimePolicyProxyPath,
      "Budget window seconds",
      "301",
    ],
    [
      "ERP apply",
      "Apply ERP controls",
      "Apply ERP controls",
      adminErpChaosProxyPath,
      "Latency ms",
      "123",
    ],
    ["preset archive", "Archive preset", "Archive preset", adminPresetListProxyPath, null, null],
    [
      "admin start",
      "Run once with these values",
      "Start run",
      adminDemoRunStartProxyPath,
      null,
      null,
    ],
    [
      "cleanup",
      "Cleanup runs",
      "Cleanup generated runs",
      adminMaintenanceCleanupRunsProxyPath,
      null,
      null,
    ],
  ] as const)("QA transport: %s", (kind, action, confirmation, path, field, value) => {
    it("releases pending after an unavailable response without claiming success or retrying", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === path) {
          throw new Error("QA response lost");
        }
        if (String(input) === dashboardRecoveryProxyPath) {
          return jsonResponse({ ...recoveryFixture(null), revision: 2 });
        }
        throw new Error(`Unexpected QA request: ${String(input)}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      if (kind === "policy save") {
        render(
          <AdminRuntimePolicyController
            initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
          />,
        );
      } else if (kind === "ERP apply") {
        render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
      } else if (kind === "cleanup") {
        render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
      } else {
        render(
          <AdminPresetController
            initialPresets={
              kind === "preset archive"
                ? available<AdminPresetListResponse>({
                    presets: [archivablePresetFixture("qa-transport", "QA Transport")],
                    timestamp: "2026-06-20T00:00:10.000Z",
                  })
                : presetListFixture("Custom")
            }
            recovery={available(recoveryFixture(null))}
          />,
        );
      }
      if (field && value) {
        await user.clear(screen.getByLabelText(field));
        await user.type(screen.getByLabelText(field), value);
      }
      await user.click(screen.getByRole("button", { name: action }));
      if (confirmation) await user.click(confirmationButton(confirmation));
      expect((await screen.findAllByRole("alert")).length).toBeGreaterThan(0);
      await waitFor(() => {
        const retry = confirmation
          ? confirmationButton(confirmation)
          : screen.getByRole("button", { name: action });
        expect((retry as HTMLButtonElement).disabled).toBe(false);
      });
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === path)).toHaveLength(1);
      expect(
        screen.queryByText(
          /Preset saved\.|Admin run accepted\.|Global ERP fault injection updated\.|Cleanup complete:/,
        ),
      ).toBeNull();
      if (field) expect((screen.getByLabelText(field) as HTMLInputElement).value).toBe(value);
      if (kind === "preset save") expect(screen.getByText("Unsaved")).toBeTruthy();
      if (kind === "preset archive") expect(screen.getByRole("alertdialog")).toBeTruthy();
    });
  });

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

  it("summarizes global ERP scope and sends no apply when confirmation is cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminErpDiagnosticsController
        initialErpChaos={available(erpFixture())}
        runErpConfig={presetFixture().erpConfig}
        runState="active"
      />,
    );
    await user.clear(screen.getByLabelText("Latency ms"));
    await user.type(screen.getByLabelText("Latency ms"), "250");
    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Latency ms")).toBeTruthy();
    expect(within(dialog).getByText("250")).toBeTruthy();
    expect(dialog.textContent).toContain(
      "This does not change the active run — frozen in the accepted run snapshot; affects fallback and future non-snapshot calls.",
    );
    expect(dialog.textContent).toContain("reset when Mock ERP restarts.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Latency ms") as HTMLInputElement).value).toBe("250");
  });

  it("shows run-snapshot and global ERP configuration without claiming health", () => {
    render(<AdminAuthenticatedSurface {...surfaceProps(runFixture())} />);
    const panel = document.querySelector("#erp-fault-injection");
    if (!panel) throw new Error("Expected ERP fault-injection panel.");
    expect(
      within(panel as HTMLElement).getByRole("heading", {
        name: "Accepted run snapshot (per-run)",
      }),
    ).toBeTruthy();
    expect(
      within(panel as HTMLElement).getByRole("heading", { name: "Configured global fallback" }),
    ).toBeTruthy();
    expect(panel.textContent).toContain("forced outage off");
    expect(panel.textContent).not.toContain("ready");
  });

  it("keeps ERP fault hints reachable while the error-rate constraint stays concise", async () => {
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
    const panel = document.querySelector("#erp-fault-injection") as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "About Error rate" }));
    expect(within(panel).getByRole("tooltip").textContent).toContain("confirmation calls");
    expect(panel.querySelector("#erp-chaos-errorRate-help")?.textContent).toContain(
      "Enter 25 for 25%.",
    );
    expect(panel.querySelector("#erp-chaos-errorRate-help")?.textContent).not.toContain(
      "confirmation calls",
    );
  });

  it("does not invent forced-outage configuration when ERP status is unavailable", () => {
    render(
      <AdminErpDiagnosticsController
        initialErpChaos={{ status: "unavailable", reason: "ERP not loaded" }}
      />,
    );

    expect(screen.getByText("forced outage unavailable")).toBeTruthy();
    expect(screen.queryByText("forced outage off")).toBeNull();
  });

  it("describes global ERP scope without implying a terminal run is active", async () => {
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(completedRunFixture())} />);

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "There is no active run; these values govern fallback and future non-snapshot calls.",
    );
    expect(dialog.textContent).not.toContain("does not change the active run");
  });

  it("does not claim there is no active run when current-run state is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(null)}
        initialRecovery={{ status: "unavailable", reason: "Recovery unavailable" }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Current run state is unavailable — a currently active run keeps its frozen snapshot",
    );
    expect(dialog.textContent).not.toContain("There is no active run");
  });

  it("renders protected readiness probes in an expanded operator block", () => {
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
    expect(screen.getByText("Readiness probe details").closest("details")?.open).toBe(true);
    expect(screen.getByRole("img", { name: "unavailable" })).toBeTruthy();
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

  it("groups preset configuration by inventory, ERP and worker ownership", () => {
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    for (const name of ["Traffic", "Inventory", "Per-run ERP", "Worker and backpressure"]) {
      expect(screen.getByRole("group", { name })).toBeTruthy();
    }
  });

  it("places each preset ERP and worker input once under its owning group", () => {
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
    const erp = screen.getByRole("group", { name: "Per-run ERP" });
    for (const label of ["ERP latency ms", "ERP max TPS", "ERP error rate", "ERP forced outage"]) {
      expect(within(erp).getAllByLabelText(label)).toHaveLength(1);
    }
    const worker = screen.getByRole("group", { name: "Worker and backpressure" });
    expect(within(worker).getAllByLabelText("Worker concurrency")).toHaveLength(1);
    expect(within(worker).queryByLabelText(/Persistence retry seconds/)).toBeNull();
    expect(screen.getByRole("button", { name: "About ERP error rate" })).toBeTruthy();
    expect(within(erp).getByText(/Unit: percent\. Minimum: 0\. Maximum: 100\./)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Circuit protection" })).toBeNull();
  });

  it("keeps the runtime-policy and preset traffic radio groups independent", () => {
    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(null)}
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );

    const trafficGroups = screen.getAllByRole("group", {
      name: "Traffic pattern",
      hidden: true,
    });
    expect(trafficGroups).toHaveLength(2);

    const radioNames = Object.fromEntries(
      trafficGroups.map((group) => {
        const radios = within(group).getAllByRole("radio", { hidden: true });
        expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
        return [group.id, new Set(radios.map((radio) => (radio as HTMLInputElement).name))];
      }),
    );
    expect(radioNames).toEqual({
      "preset-mode": new Set(["preset-traffic-mode"]),
      "runtime-policy-mode": new Set(["runtime-policy-traffic-mode"]),
    });
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

  it("keeps both refresh controls enabled during ordinary unavailable retries", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());

    render(
      <AdminAuthenticatedSurface
        {...surfaceProps(null)}
        initialRecovery={{ status: "unavailable", reason: "Recovery unavailable." }}
      />,
    );

    expect(screen.getByText("Automatic retry 1 in 1 seconds.")).toBeTruthy();
    for (const refresh of [
      screen.getByRole("button", { name: "Retry recovery" }),
      screen.getByRole("button", { name: "Refresh current run" }),
    ]) {
      expect((refresh as HTMLButtonElement).disabled).toBe(false);
      expect(refresh.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("disables both refresh controls during preserved-available backoff", async () => {
    vi.useFakeTimers();
    const rateLimited = canonicalErrorResponse("Recovery is rate limited.", 429);
    rateLimited.headers.set("retry-after", "1");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(
        jsonResponse({
          ...recoveryFixture(null),
          revision: 2,
          recoveredAt: "2026-06-20T00:00:11.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
    screen.getByRole("button", { name: "Refresh status" }).click();
    await act(async () => Promise.resolve());

    const panelRefresh = screen.getByRole("button", { name: "Retry recovery" });
    const routineRefresh = screen.getByRole("button", { name: "Refresh current run" });
    for (const refresh of [panelRefresh, routineRefresh]) {
      expect((refresh as HTMLButtonElement).disabled).toBe(true);
      expectControlDescription(
        refresh,
        "Wait for the automatic retry countdown before refreshing.",
      );
    }
    expect(screen.getByText("Automatic retry 1 in 1 seconds.")).toBeTruthy();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await act(async () => Promise.resolve());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      (screen.getByRole("button", { name: "Refresh status" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect((routineRefresh as HTMLButtonElement).disabled).toBe(false);
  });

  it("applies external lifecycle projections to current-run state and start gating in order", () => {
    vi.stubGlobal("EventSource", InjectedEventSource);
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
    const source = InjectedEventSource.instances[0];
    const start = screen.getByRole("button", {
      name: "Run once with these values",
    }) as HTMLButtonElement;
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
    expectControlDescription(start, "Run is active — wait before starting another");

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
    expect(start.getAttribute("aria-describedby")).toBeNull();

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
      isRefreshDisabled: false,
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
    expect(screen.getByText("2026-06-20 00:00:10 UTC · stale")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Read failed");
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
    expect(
      (
        screen.getByRole("button", {
          name: "Run once with these values",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expectControlDescription(
      screen.getByRole("button", { name: "Run once with these values" }),
      "Status is stale — refresh before starting",
    );
  });

  it.each([
    ["starting", "starting", undefined],
    ["draining", "succeeded", "2026-06-20T00:00:11.000Z"],
  ] as const)("explains why a %s run blocks another start", (status, trafficStatus, trafficEndedAt) => {
    const activeRun = runFixture();
    if (activeRun?.status !== "active") throw new Error("Expected active run fixture.");
    const currentRun = {
      ...activeRun,
      status,
      trafficStatus,
      ...(trafficEndedAt ? { trafficEndedAt } : {}),
      ...(status === "starting" ? { trafficStartedAt: undefined } : {}),
    } as DashboardProjection["currentRun"];

    render(<AdminAuthenticatedSurface {...surfaceProps(currentRun)} />);

    const start = screen.getByRole("button", {
      name: "Run once with these values",
    }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expectControlDescription(start, `Run is ${status} — wait before starting another`);
  });

  it("explains unavailable recovery and omits a reason when start is enabled", () => {
    const props = surfaceProps(null);
    const { unmount } = render(
      <AdminAuthenticatedSurface
        {...props}
        initialRecovery={{ status: "unavailable", reason: "Recovery unavailable." }}
      />,
    );
    const start = screen.getByRole("button", {
      name: "Run once with these values",
    }) as HTMLButtonElement;

    expect(start.disabled).toBe(true);
    expectControlDescription(start, "Status is unavailable — refresh before starting");

    unmount();
    render(<AdminAuthenticatedSurface {...props} />);
    const enabledStart = screen.getByRole("button", { name: "Run once with these values" });
    expect((enabledStart as HTMLButtonElement).disabled).toBe(false);
    expect(enabledStart.getAttribute("aria-describedby")).toBeNull();
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
    const start = screen.getByRole("button", {
      name: "Run once with these values",
    }) as HTMLButtonElement;

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
      (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("labels unsupported live updates and blocks start", async () => {
    vi.stubGlobal("EventSource", undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => canonicalErrorResponse("Dashboard recovery failed", 503)),
    );
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);
    await user.click(screen.getByRole("button", { name: "Refresh status" }));

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true),
    );
    expect(screen.getByText("2026-06-20 00:00:10 UTC · live updates unsupported")).toBeTruthy();
    expect(screen.getByText("live updates unsupported")).toBeTruthy();
    expect(screen.getByText("The latest information is temporarily unavailable")).toBeTruthy();
  });

  it("navigates without refreshing current-run recovery after a successful start", async () => {
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

    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    await user.click(confirmationButton("Start run"));

    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledExactlyOnceWith(
        `/watch?acceptedRunId=${runFixture()?.runId}`,
      ),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      adminDemoRunStartProxyPath,
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
    await user.click(confirmationButton("Apply ERP controls"));
    const erpPanel = document.querySelector("#erp-fault-injection");
    if (!erpPanel) throw new Error("Expected ERP fault-injection panel.");
    for (const control of [
      within(erpPanel as HTMLElement).getByRole("button", { name: "Apply ERP controls" }),
      within(erpPanel as HTMLElement).getByRole("button", { name: "Reset ERP controls" }),
    ]) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
      expectControlDescription(
        control,
        "A change is being applied — wait before applying or resetting ERP controls.",
      );
    }
    expect((screen.getByRole("button", { name: "Reset demo" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    pending.resolve(jsonResponse(erpFixture()));
    await waitFor(() =>
      expect(
        (document.querySelector("#erp-fault-injection button") as HTMLButtonElement).disabled,
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
    expect(
      screen.getByText(
        `Unit: orders. Minimum: 1. Maximum: ${orderProcessConcurrencyHardCap.toLocaleString("en-US")}.`,
      ),
    ).toBeTruthy();
  });

  it("describes canonical ERP bounds", () => {
    render(<AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />);
    expect(
      screen.getByText(`Unit: milliseconds. Minimum: ${nonnegativeNumberMinimum}. Maximum: 5000.`),
    ).toBeTruthy();
    expect(
      screen.getByText("Unit: percent. Minimum: 0. Maximum: 100. Enter 25 for 25%."),
    ).toBeTruthy();
    for (const control of [
      screen.getByRole("button", { name: "Apply ERP controls" }),
      screen.getByRole("button", { name: "Reset ERP controls" }),
    ]) {
      expect((control as HTMLButtonElement).disabled).toBe(false);
      expect(control.getAttribute("aria-describedby")).toBeNull();
    }
  });

  it("keeps a dirty ERP draft across props and submits its exact values", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <AdminErpDiagnosticsController initialErpChaos={available(erpFixture())} />,
    );
    const latency = screen.getByLabelText("Latency ms");
    await user.clear(latency);
    await user.type(latency, "250");
    const maxTps = screen.getByLabelText("Max TPS");
    await user.clear(maxTps);
    await user.type(maxTps, "20");
    const errorRate = screen.getByLabelText("Error rate");
    await user.clear(errorRate);
    await user.type(errorRate, "25");
    await user.click(screen.getByLabelText("Forced outage"));
    rerender(
      <AdminErpDiagnosticsController
        initialErpChaos={available({ ...erpFixture(), latencyMs: 75 })}
      />,
    );
    expect((screen.getByLabelText("Latency ms") as HTMLInputElement).value).toBe("250");
    expect((screen.getByLabelText("Max TPS") as HTMLInputElement).value).toBe("20");
    expect((screen.getByLabelText("Error rate") as HTMLInputElement).value).toBe("25");
    expect((screen.getByLabelText("Forced outage") as HTMLInputElement).checked).toBe(true);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        ...erpFixture(),
        latencyMs: 250,
        maxTps: 20,
        errorRate: 0.25,
        forcedOutage: true,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await user.click(screen.getByRole("button", { name: "Apply ERP controls" }));
    await user.click(confirmationButton("Apply ERP controls"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      latencyMs: 250,
      maxTps: 20,
      errorRate: 0.25,
      forcedOutage: true,
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

  it("explains disabled ERP controls when no authoritative caps are available", () => {
    render(
      <AdminErpDiagnosticsController
        initialErpChaos={{ status: "unavailable", reason: "ERP not loaded" }}
      />,
    );

    for (const control of [
      screen.getByRole("button", { name: "Apply ERP controls" }),
      screen.getByRole("button", { name: "Reset ERP controls" }),
    ]) {
      expect((control as HTMLButtonElement).disabled).toBe(true);
      expectControlDescription(
        control,
        "Diagnostics status is unavailable — refresh before applying or resetting ERP controls.",
      );
    }
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
    await user.click(confirmationButton("Apply ERP controls"));
    await waitFor(() => expect(status.textContent).toBe("Global ERP fault injection updated."));
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
    await user.click(confirmationButton("Apply ERP controls"));
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

    await user.click(confirmationButton("Apply ERP controls"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Global ERP fault injection updated.")).toBeTruthy();
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
    const props = surfaceProps(runFixture());
    if (props.initialErpChaos.status !== "available") throw new Error("Expected ERP status.");
    props.initialErpChaos = available({ ...props.initialErpChaos.data, latencyMs: 250 });
    render(<AdminAuthenticatedSurface {...props} />);
    expect(
      (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await user.click(confirmationButton("Reset demo"));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      adminDemoResetProxyPath,
      knownRecoveryPath,
    ]);
    expect((screen.getByLabelText("Latency ms") as HTMLInputElement).value).toBe("250");
    const maintenance = screen
      .getByRole("heading", { name: "Recovery and cleanup" })
      .closest("section");
    expect(maintenance?.textContent).toContain(
      "1 runs failed, 1 sale offers closed, 1 queues cleaned, 2 jobs cleaned. Global ERP fault injection is not changed by this reset.",
    );
  });

  it("explains the destructive reset before the action and cancels without side effects", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminMaintenancePanel onResetComplete={vi.fn().mockResolvedValue(undefined)} />);

    await user.click(screen.getByRole("button", { name: "Reset demo" }));

    const dialog = screen.getByRole("alertdialog");
    // The pre-action explanation states every consequence before anything runs.
    expect(dialog.textContent).toContain("stops all demo work immediately");
    expect(dialog.textContent).toContain("discards the current run's data");
    expect(dialog.textContent).toContain("One basic history line marked as cancelled");
    expect(dialog.textContent).toContain("frees the demo for the next run");

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a previous maintenance success notice when the next reset fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          failedRunCount: 0,
          closedSaleOfferCount: 0,
          cleanedQueueCount: 0,
          cleanedJobCount: 0,
          correlationId: "corr-reset-success",
          resetAt: "2026-06-20T00:00:12.000Z",
        }),
      )
      .mockResolvedValueOnce(canonicalErrorResponse("Reset failed.", 503));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminMaintenancePanel onResetComplete={vi.fn().mockResolvedValue(undefined)} />);

    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await user.click(confirmationButton("Reset demo"));
    expect(await screen.findByText(/Reset complete:/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    expect(screen.queryByText(/Reset complete:/)).toBeNull();
    await user.click(confirmationButton("Reset demo"));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/Reset complete:/)).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Cleanup runs" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Reset failed.")).toBeNull();
  });

  it.each([
    "unavailable",
    "lost",
  ] as const)("reconciles recovery even when the reset response is %s", async (failure) => {
    const knownRecoveryPath = `${dashboardRecoveryProxyPath}?knownRunId=11111111-1111-4111-8111-111111111111&knownSaleOfferId=33333333-3333-4333-8333-333333333333`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === adminDemoResetProxyPath) {
        if (failure === "lost") throw new Error("QA reset response lost");
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
        (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      (await screen.findAllByText("Something didn't work on our side")).length,
    ).toBeGreaterThan(0);
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

  it("shows a blank preset Name error without saving and saves after correction", async () => {
    const accepted = presetFixture();
    accepted.display.name = "Valid preset";
    const { canArchive: _canArchive, ...acceptedContract } = accepted;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === adminPresetSaveProxyPath
        ? jsonResponse({
            preset: acceptedContract,
            timestamp: "2026-06-20T00:00:12.000Z",
          })
        : jsonResponse({
            presets: [accepted],
            timestamp: "2026-06-20T00:00:12.000Z",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "   ");
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    expect(name.value).toBe("   ");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("link", { name: "Name is required." }).getAttribute("href")).toBe(
      "#preset-displayName",
    );
    expect(fetchMock).not.toHaveBeenCalled();

    await user.clear(name);
    await user.type(name, "Valid preset");
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    await waitFor(() => expect(screen.getByText("Preset saved.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await user.clear(name);
    await user.type(name, "   ");
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    expect(screen.queryByText("Preset saved.")).toBeNull();
    expect(screen.getByRole("link", { name: "Name is required." })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("presents a failed preset read as unavailable and recovers via props", () => {
    const recovery = available(recoveryFixture(null));
    const { rerender } = render(
      <AdminPresetController
        initialPresets={{ status: "unavailable", reason: "Preset read failed" }}
        recovery={recovery}
      />,
    );
    const presetsSection = within(document.querySelector("#presets") as HTMLElement);

    expect(presetsSection.getByText("unavailable")).toBeTruthy();
    expect(presetsSection.queryByText("0 loaded")).toBeNull();
    expect(presetsSection.queryByText("No admin presets are available.")).toBeNull();
    expect(presetsSection.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Preset read failed")).toBeTruthy();

    rerender(
      <AdminPresetController initialPresets={presetListFixture("Custom")} recovery={recovery} />,
    );

    expect(screen.getByRole("button", { name: "Custom" })).toBeTruthy();
    expect(presetsSection.getByText("1 loaded")).toBeTruthy();
    expect(presetsSection.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["public", readOnlyPresetFixture("public", "Public preset")],
    ["system", readOnlyPresetFixture("admin", "System preset")],
  ])("frames a read-only %s preset as a one-off override workspace", (_kind, preset) => {
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [preset],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    expect(
      screen.getByText(
        `You're editing values for a one-off run — ${preset.display.name} itself can't be changed`,
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Description") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Sort order") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).disabled).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Save preset" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Archive preset" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(document.body.textContent).not.toContain("Editable: no");
    expect(document.body.textContent).toContain(
      preset.visibility === "public"
        ? "Public presets cannot be saved from the admin editor."
        : "This read-only preset cannot be saved.",
    );
    expectControlDescription(
      screen.getByRole("button", { name: "Save preset" }),
      preset.visibility === "public"
        ? "Public presets cannot be saved from the admin editor."
        : "This read-only preset cannot be saved.",
    );
    expectControlDescription(
      screen.getByRole("button", { name: "Archive preset" }),
      preset.visibility === "public"
        ? "Public presets cannot be archived."
        : "Read-only and system presets cannot be archived.",
    );
  });

  it("allows public Custom to be copied while explaining why it cannot be duplicated", () => {
    const publicCustom = {
      ...readOnlyPresetFixture("public", "Public Custom"),
      slug: "public-custom",
      isCustom: true,
    };
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [publicCustom],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Copy saved values to custom scenario",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Duplicate saved preset" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(document.body.textContent).not.toContain("cannot be copied to itself");
    expect(document.body.textContent).toContain("The public Custom scenario cannot be duplicated.");
    expectControlDescription(
      screen.getByRole("button", { name: "Duplicate saved preset" }),
      "The public Custom scenario cannot be duplicated.",
    );
  });

  it("keeps selection and draft when dirty switching is cancelled, then discards on confirm", async () => {
    const first = presetFixture();
    const second = presetWithSlug("second", "Second preset");
    second.trafficConfig = {
      mode: "constant-arrival-rate",
      ratePerSecond: 100,
      startDelaySeconds: 0,
      durationSeconds: 10,
      quantityPerAttempt: 1,
      k6Vus: { preAllocatedVus: 10, maxVus: 20 },
    };
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [first, second],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    const presetGroup = screen.getByRole("group", { name: "Preset selection" });
    expect(
      within(presetGroup)
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1);
    expect(
      within(presetGroup).getByRole("button", { name: "Custom" }).getAttribute("aria-pressed"),
    ).toBe("true");
    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    expect(screen.getByText("Unsaved")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Second preset" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect(
      within(presetGroup).getByRole("button", { name: "Custom" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(presetGroup)
        .getByRole("button", { name: "Second preset" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    await user.click(screen.getByRole("button", { name: "Second preset" }));
    await user.click(confirmationButton("Discard unsaved edits"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Second preset");
    expect((screen.getByLabelText("Requests per second") as HTMLInputElement).value).toBe("100");
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(
      within(presetGroup)
        .getByRole("button", { name: "Second preset" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect((screen.getByRole("radio", { name: "Steady stream" }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("keeps Unsaved after save failure and adopts the accepted response as Saved", async () => {
    const accepted = presetFixture();
    if (accepted.trafficConfig.mode !== "buyer-spike") {
      throw new Error("Expected buyer-spike fixture.");
    }
    accepted.trafficConfig.buyerCount = 1234;
    const staleListPreset = presetFixture();
    const { canArchive: _canArchive, ...acceptedContract } = accepted;
    let saveAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === adminPresetSaveProxyPath && saveAttempts++ === 0) {
        return canonicalErrorResponse("Save failed", 503);
      }
      if (String(input) === adminPresetSaveProxyPath) {
        return jsonResponse({
          preset: acceptedContract,
          timestamp: "2026-06-20T00:00:12.000Z",
        });
      }
      return jsonResponse({
        presets: [staleListPreset],
        timestamp: "2026-06-20T00:00:12.000Z",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    expect(screen.getByText("Unsaved").closest('[role="status"]')).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save preset" }));
    expect(
      await screen.findByText("The latest information is temporarily unavailable"),
    ).toBeTruthy();
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect(screen.getByText("Unsaved")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save preset" }));
    await waitFor(() => expect(screen.getByText("Preset saved.")).toBeTruthy());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByText("Saved").closest('[role="status"]')).toBeTruthy());
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
  });

  it("keeps an accepted duplicate selected when the same-pass list omits it", async () => {
    const source = archivablePresetFixture("operator-source", "Operator source");
    const clone = archivablePresetFixture("operator-source-copy", "Operator source Copy");
    const { canArchive: _canArchive, ...cloneContract } = clone;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === adminPresetDuplicateProxyPath
        ? jsonResponse({
            preset: cloneContract,
            timestamp: "2026-06-20T00:00:12.000Z",
          })
        : jsonResponse({
            presets: [source],
            timestamp: "2026-06-20T00:00:12.000Z",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [source],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));
    await waitFor(() => expect(screen.getByText("Preset duplicated.")).toBeTruthy());

    expect(
      (
        screen.getByRole("button", { name: "Operator source Copy" }) as HTMLButtonElement
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Operator source Copy");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("keeps accepted duplicate values while adopting refreshed archive capability", async () => {
    const source = archivablePresetFixture("operator-source", "Operator source");
    const clone = archivablePresetFixture("operator-source-copy", "Accepted clone");
    const staleClone = {
      ...clone,
      display: { ...clone.display, name: "Stale clone" },
      trafficConfig: { ...clone.trafficConfig, buyerCount: 999 },
      canArchive: true,
    };
    const { canArchive: _canArchive, ...cloneContract } = clone;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === adminPresetDuplicateProxyPath
        ? jsonResponse({
            preset: cloneContract,
            timestamp: "2026-06-20T00:00:12.000Z",
          })
        : jsonResponse({
            presets: [source, staleClone],
            timestamp: "2026-06-20T00:00:12.000Z",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [source],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Archive preset" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    expect(screen.getByRole("button", { name: "Accepted clone" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stale clone" })).toBeNull();
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1000");
  });

  it("prevents editor changes and preset switching while a save mutation is pending", async () => {
    const pendingSave = deferred<Response>();
    const accepted = presetFixture();
    if (accepted.trafficConfig.mode !== "buyer-spike") {
      throw new Error("Expected buyer-spike fixture.");
    }
    accepted.trafficConfig.buyerCount = 1234;
    const { canArchive: _canArchive, ...acceptedContract } = accepted;
    const second = presetWithSlug("second", "Second preset");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === adminPresetSaveProxyPath
        ? pendingSave.promise
        : jsonResponse({
            presets: [presetFixture(), second],
            timestamp: "2026-06-20T00:00:12.000Z",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [presetFixture(), second],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    await user.click(screen.getByRole("button", { name: "Save preset" }));
    const secondButton = screen.getByRole("button", { name: "Second preset" });
    const buyerCount = screen.getByLabelText("Buyer count") as HTMLInputElement;
    const duplicateSlug = screen.getByLabelText("Duplicate slug") as HTMLInputElement;
    await waitFor(() => expect((secondButton as HTMLButtonElement).disabled).toBe(true));
    expect(buyerCount.matches(":disabled")).toBe(true);
    expect(duplicateSlug.disabled).toBe(true);
    expect(secondButton.parentElement?.textContent).toContain("A preset action is in progress.");
    expect(
      screen.getByRole("button", { name: "Copy saved values to custom scenario" }).parentElement
        ?.textContent,
    ).toContain("A preset action is in progress.");
    expect(
      screen.getByRole("button", { name: "Duplicate saved preset" }).closest("form")?.textContent,
    ).toContain("A preset action is in progress.");
    expect(
      screen.getByRole("button", { name: "Run once with these values" }).parentElement?.textContent,
    ).toContain("A preset action is in progress.");
    for (const name of [
      "Second preset",
      "Run once with these values",
      "Save preset",
      "Copy saved values to custom scenario",
      "Archive preset",
      "Duplicate saved preset",
    ]) {
      expectControlDescription(
        screen.getByRole("button", { name }),
        "A preset action is in progress.",
      );
    }

    await user.click(buyerCount);
    await user.keyboard("{Control>}a{/Control}9999");
    await user.click(duplicateSlug);
    await user.keyboard("{Control>}a{/Control}changed");
    await user.click(secondButton);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Custom");
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect((screen.getByLabelText("Duplicate slug") as HTMLInputElement).value).toBe("custom-copy");

    pendingSave.resolve(
      jsonResponse({
        preset: acceptedContract,
        timestamp: "2026-06-20T00:00:12.000Z",
      }),
    );
    await waitFor(() => expect(screen.getByText("Preset saved.")).toBeTruthy());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Custom");
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("previews and submits the same unsaved run-once configuration without saving", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      canonicalErrorResponse("Another run started first.", 409, "run_conflict", {
        conflictReason: "active_run_exists",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.clear(screen.getByLabelText("Starting stock"));
    await user.type(screen.getByLabelText("Starting stock"), "333");
    await user.click(screen.getByRole("radio", { name: "Steady stream" }));
    expect((screen.getByRole("radio", { name: "Steady stream" }) as HTMLInputElement).checked).toBe(
      true,
    );
    await user.click(screen.getByRole("radio", { name: "Everyone at once" }));
    const preset = presetFixture();
    const expectedDraft = draftFromPreset(preset);
    expectedDraft.startingStock = "333";
    const expectedConfigOverride = buildEffectiveRunConfig(expectedDraft, preset).values;
    if (!expectedConfigOverride) throw new Error("Expected valid run configuration.");
    await user.click(screen.getByText("Effective run preview"));
    const preview = screen.getByText("Effective run preview").closest("details");
    if (!preview) throw new Error("Expected effective run preview.");
    expect(within(preview).getByText("333")).toBeTruthy();
    for (const label of ["Quantity per attempt", "Queue name", "Physical queue name"]) {
      expect(within(preview).getByText(label)).toBeTruthy();
    }
    expect(within(preview).queryByText("Pending retry after seconds")).toBeNull();
    const previewGroupByPayloadKey = {
      trafficConfig: "Traffic",
      inventoryConfig: "Inventory",
      erpConfig: "Per-run ERP",
      backpressureConfig: "Worker and backpressure",
    } as const;
    for (const key of Object.keys(expectedConfigOverride) as Array<
      keyof typeof previewGroupByPayloadKey
    >) {
      expect(
        within(preview).getByRole("heading", { name: previewGroupByPayloadKey[key] }),
      ).toBeTruthy();
    }

    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    await user.click(confirmationButton("Start run"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminDemoRunStartProxyPath);
    expect(request.configOverride).toEqual(expectedConfigOverride);
    expect(request.configOverride.trafficConfig.mode).toBe("buyer-spike");
    expect(fetchMock.mock.calls.some(([input]) => String(input) === adminPresetSaveProxyPath)).toBe(
      false,
    );
    expect(screen.getByText("Unsaved")).toBeTruthy();
  });

  it("cancels a run start after showing B14's effective snapshot", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={presetListFixture("Custom")}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("claim the one shared demo runtime");
    expect(within(dialog).getByText("Effective run preview").closest("details")?.open).toBe(true);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("confirms that copy uses saved values and keeps its slug-only request", async () => {
    const source = archivablePresetFixture("operator-copy", "Operator copy");
    const custom = presetFixture();
    const { canArchive: _canArchive, ...customContract } = custom;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === adminPresetCopyToCustomProxyPath
        ? jsonResponse({
            preset: customContract,
            timestamp: "2026-06-20T00:00:12.000Z",
          })
        : jsonResponse({
            presets: [source, custom],
            timestamp: "2026-06-20T00:00:12.000Z",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [source],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    await user.click(screen.getByRole("button", { name: "Copy saved values to custom scenario" }));
    expect(screen.getByText(/Your unsaved edits will not be copied\./)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Operator copy");
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect(
      (
        screen.getByRole("button", {
          name: "Operator copy",
        }) as HTMLButtonElement
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Copy saved values to custom scenario" }));
    await user.click(confirmationButton("Discard unsaved edits"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminPresetCopyToCustomProxyPath);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sourceSlug: "operator-copy",
    });
  });

  it("cancels and confirms duplicate from a dirty draft without changing its saved-source payload", async () => {
    const source = archivablePresetFixture("operator-duplicate", "Operator duplicate");
    const clone = presetWithSlug("operator-duplicate-copy", "Operator duplicate Copy");
    const { canArchive: _canArchive, ...cloneContract } = clone;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input) === adminPresetDuplicateProxyPath
        ? jsonResponse({
            preset: cloneContract,
            timestamp: "2026-06-20T00:00:12.000Z",
          })
        : jsonResponse({
            presets: [source, clone],
            timestamp: "2026-06-20T00:00:12.000Z",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [source],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );
    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));
    expect(screen.getByText(/Your unsaved edits will not be duplicated\./)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Operator duplicate");
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect(
      (
        screen.getByRole("button", { name: "Operator duplicate" }) as HTMLButtonElement
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));
    await user.click(confirmationButton("Discard unsaved edits"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminPresetDuplicateProxyPath);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sourceSlug: "operator-duplicate",
      targetSlug: "operator-duplicate-copy",
      displayName: "Operator duplicate Copy",
    });
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
    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByText("Buyer count is required.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: "Steady stream" }));
    expect(screen.queryByText("Buyer count is required.")).toBeNull();
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Everyone at once" }));
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
    await user.type(buyers, "2.5");
    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    expect((buyers as HTMLInputElement).value).toBe("2.5");
    expect(
      screen.getByText("Buyer count must be a whole number.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks derived deployment totals for preset save and start", async () => {
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
    const buyers = screen.getByLabelText("Buyer count");
    await user.clear(buyers);
    await user.type(buyers, "50000");
    await user.click(screen.getByLabelText("Duplicate attempts"));

    for (const action of ["Save preset", "Run once with these values"]) {
      await user.click(screen.getByRole("button", { name: action }));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByRole("link", { name: "Buyer count" })).toBeTruthy();
      expect(screen.getByRole("link", { name: "Duplicate attempts" })).toBeTruthy();
      expect(document.body.textContent).toContain(
        "This configuration creates 100,000 requests; the permitted maximum is 90,000 requests.",
      );
    }
    expect((buyers as HTMLInputElement).value).toBe("50000");
    expect((screen.getByLabelText("Duplicate attempts") as HTMLInputElement).checked).toBe(true);
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

    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    await user.click(confirmationButton("Start run"));
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
    expect((await screen.findAllByText("Check the values and try again")).length).toBeGreaterThan(
      0,
    );
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
      (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    await user.click(confirmationButton("Start run"));
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

    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    await user.click(confirmationButton("Start run"));

    expect(
      (await screen.findAllByText("A demo run is already in progress")).length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Admin run accepted.")).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("navigates to Watch with the accepted admin run", async () => {
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
    const status = document.querySelector<HTMLParagraphElement>("#presets p[role='status']");
    if (!status) throw new Error("Expected the admin operation status region.");
    expect(status.textContent).toBe("");

    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    await user.click(confirmationButton("Start run"));

    await waitFor(() => expect(status.textContent).toBe("Admin run accepted."));
    expect(document.querySelector("#presets p[role='status']")).toBe(status);
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe(
      `/watch?acceptedRunId=${runFixture()?.runId}`,
    );
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(
      `/watch?acceptedRunId=${runFixture()?.runId}`,
    );
  });

  it("rejects a duplicate when the slug is cleared", async () => {
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
    await user.clear(duplicateSlugInput);

    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));

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
    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));

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
    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));

    expect(await screen.findByText("That preset slug is already in use")).toBeTruthy();
    expect(screen.getByText("Choose another slug")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(document.body.textContent).not.toContain("private-duplicate-slug");
    expect(document.body.textContent).not.toContain("private-detail");
  });

  it("preserves an in-progress preset draft while refreshed props update start gating", async () => {
    const user = userEvent.setup();
    const props = {
      ...surfaceProps(null),
      initialPresets: twoPresetListFixture("Custom"),
    };
    const { rerender } = render(<AdminAuthenticatedSurface {...props} />);
    const name = screen.getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Edited locally");
    await user.click(screen.getByRole("button", { name: "Custom" }));

    rerender(
      <AdminAuthenticatedSurface
        {...props}
        initialPresets={twoPresetListFixture("Server updated")}
        initialRecovery={available(recoveryFixture(runFixture()))}
      />,
    );
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited locally");
    expect(
      (screen.getByRole("button", { name: "Custom" }) as HTMLButtonElement).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(
      (screen.getByRole("button", { name: "Second preset" }) as HTMLButtonElement).getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(
      (screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    rerender(
      <AdminAuthenticatedSurface
        {...props}
        initialPresets={twoPresetListFixture("Server updated again")}
        initialRecovery={available(recoveryFixture(runFixture()))}
      />,
    );
    await user.click(confirmationButton("Discard unsaved edits"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Server updated again");
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
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited locally");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Edited locally");
    expect(document.querySelector<HTMLInputElement>("#preset-buyerCount")?.value).toBe("1000");

    await user.click(screen.getByRole("button", { name: "Refresh policy" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await user.click(confirmationButton("Discard unsaved edits"));
    await waitFor(() =>
      expect(document.querySelector("#preset-buyerCount-help")?.textContent).toContain(
        "Maximum: 1000.",
      ),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Custom");

    if (!presetBuyerCount()) throw new Error("Expected preset buyer-count control.");
    await user.clear(presetBuyerCount() as HTMLInputElement);
    await user.type(presetBuyerCount() as HTMLInputElement, "1001");
    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    expect(
      screen.getByText("Buyer count must be at most 1000.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Refresh policy" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    await user.click(confirmationButton("Discard unsaved edits"));
    await waitFor(() =>
      expect(document.querySelector("#preset-buyerCount-help")?.textContent).toContain(
        "Maximum: 2000.",
      ),
    );
    expect(presetBuyerCount()?.value).toBe("1000");
    expect(presetBuyerCount()?.getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByText("Buyer count must be at most 1000.")).toBeNull();

    await user.clear(presetBuyerCount() as HTMLInputElement);
    await user.type(presetBuyerCount() as HTMLInputElement, "2001");
    await user.click(screen.getByRole("button", { name: "Run once with these values" }));
    expect(
      screen.getByText("Buyer count must be at most 2000.", {
        selector: "#preset-buyerCount-error",
      }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows policy hints and the edited error-rate maximum", async () => {
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText("Runtime budgets, custom limits, and deployment hard caps"));
    await user.click(screen.getByRole("button", { name: "About Budget window seconds" }));
    expect(screen.getByRole("tooltip").textContent).toContain("fixed, not rolling");
    const budgetHelp = document.querySelector("#runtime-policy-budgetWindowSeconds-help");
    expect(budgetHelp?.textContent).toContain("Unit: seconds.");
    expect(budgetHelp?.textContent).not.toContain("fixed, not rolling");

    const limit = screen.getByLabelText("Max ERP error rate");
    await user.clear(limit);
    await user.type(limit, "50");
    expect(document.querySelector("#runtime-policy-erpErrorRate-help")?.textContent).toContain(
      "Maximum: 50. Enter 25 for 25%.",
    );
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
    await user.click(confirmationButton("Save public policy"));

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

  it("summarizes and cancels a future-public-policy change", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(
      <AdminRuntimePolicyController
        initialRuntimePolicy={available(runtimePolicyFixture(10_000, 300))}
      />,
    );
    await user.clear(screen.getByLabelText("Budget window seconds"));
    await user.type(screen.getByLabelText("Budget window seconds"), "400");
    await user.click(screen.getByRole("button", { name: "Save public policy" }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "governs future public starts; already accepted runs are unaffected",
    );
    expect(within(dialog).getByText("publicRunBudget.windowSeconds")).toBeTruthy();
    expect(dialog.textContent).toContain("300");
    expect(dialog.textContent).toContain("400");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("summarizes policy changes at field level", () => {
    const current = runtimePolicyFixture(10_000, 300).policy;
    const { deploymentHardCaps: _deploymentHardCaps, ...proposed } = structuredClone(current);
    proposed.isPublicRunBudgetEnforced = false;
    proposed.publicRunBudget.windowSeconds = 400;
    proposed.publicRunBudget.globalMaxStarts = 8;

    expect(policyChangeSummary(current, proposed)).toEqual([
      { label: "Budget enforcement", oldValue: "on", proposedValue: "off" },
      { label: "publicRunBudget.windowSeconds", oldValue: 300, proposedValue: 400 },
      { label: "publicRunBudget.globalMaxStarts", oldValue: 6, proposedValue: 8 },
    ]);
  });

  it("summarizes same-mode traffic changes at field level", () => {
    const current = runtimePolicyFixture(10_000, 300).policy;
    const { deploymentHardCaps: _deploymentHardCaps, ...proposed } = structuredClone(current);
    const traffic = proposed.publicCustomDefaults.trafficConfig;
    if (traffic.mode !== "buyer-spike") throw new Error("Expected buyer-spike fixture.");
    traffic.buyerCount = 1200;
    traffic.duplicateEachBuyerAttempt = true;

    expect(policyChangeSummary(current, proposed)).toEqual([
      {
        label: "publicCustomDefaults.trafficConfig.buyerCount",
        oldValue: 1000,
        proposedValue: 1200,
      },
      {
        label: "publicCustomDefaults.trafficConfig.duplicateEachBuyerAttempt",
        oldValue: "false",
        proposedValue: "true",
      },
    ]);
  });

  it("summarizes traffic mode transitions with unavailable field placeholders", () => {
    const current = runtimePolicyFixture(10_000, 300).policy;
    const { deploymentHardCaps: _deploymentHardCaps, ...proposed } = structuredClone(current);
    proposed.publicCustomDefaults.trafficConfig = {
      mode: "constant-arrival-rate",
      ratePerSecond: 25,
      startDelaySeconds: 0,
      durationSeconds: 2,
      quantityPerAttempt: 1,
      k6Vus: { preAllocatedVus: 10, maxVus: 20 },
    };

    expect(policyChangeSummary(current, proposed)).toEqual([
      {
        label: "publicCustomDefaults.trafficConfig.mode",
        oldValue: "buyer-spike",
        proposedValue: "constant-arrival-rate",
      },
      {
        label: "publicCustomDefaults.trafficConfig.buyerCount",
        oldValue: 1000,
        proposedValue: "—",
      },
      {
        label: "publicCustomDefaults.trafficConfig.duplicateEachBuyerAttempt",
        oldValue: "false",
        proposedValue: "—",
      },
      {
        label: "publicCustomDefaults.trafficConfig.ratePerSecond",
        oldValue: "—",
        proposedValue: 25,
      },
      {
        label: "publicCustomDefaults.trafficConfig.maxDurationSeconds",
        oldValue: 2,
        proposedValue: "—",
      },
      {
        label: "publicCustomDefaults.trafficConfig.durationSeconds",
        oldValue: "—",
        proposedValue: 2,
      },
      {
        label: "publicCustomDefaults.trafficConfig.k6Vus.preAllocatedVus",
        oldValue: "—",
        proposedValue: 10,
      },
      {
        label: "publicCustomDefaults.trafficConfig.k6Vus.maxVus",
        oldValue: "—",
        proposedValue: 20,
      },
    ]);
  });

  it("summarizes public custom limit changes at field level", () => {
    const current = runtimePolicyFixture(10_000, 300).policy;
    const { deploymentHardCaps: _deploymentHardCaps, ...proposed } = structuredClone(current);
    proposed.publicCustomLimits.maxBuyers = 12_000;
    proposed.publicCustomLimits.allowForcedOutage = true;
    proposed.publicCustomLimits.allowedTrafficModes = ["buyer-spike"];

    expect(policyChangeSummary(current, proposed)).toEqual([
      { label: "publicCustomLimits.maxBuyers", oldValue: 10_000, proposedValue: 12_000 },
      {
        label: "publicCustomLimits.allowForcedOutage",
        oldValue: "false",
        proposedValue: "true",
      },
      {
        label: "publicCustomLimits.allowedTrafficModes",
        oldValue: '["buyer-spike","constant-arrival-rate"]',
        proposedValue: '["buyer-spike"]',
      },
    ]);
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

    await user.click(screen.getByRole("radio", { name: "Steady stream" }));
    expect(screen.queryByText("Buyer count is required.")).toBeNull();
    expect(screen.queryByText("Correct the highlighted fields.")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Everyone at once" }));
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
    await user.click(confirmationButton("Save public policy"));
    expect(
      (await screen.findAllByText("The latest information is temporarily unavailable")).length,
    ).toBeTruthy();
    expect(screen.getByLabelText("Max buyers")).toBeTruthy();
    await user.click(confirmationButton("Save public policy"));
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

    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Preset archived.")).toBeNull();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Operator Dup");
    expect((screen.getByLabelText("Buyer count") as HTMLInputElement).value).toBe("1234");
    expect(
      (screen.getByRole("button", { name: "Operator Dup" }) as HTMLButtonElement).getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
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
    expect(document.body.textContent).toContain(
      "The server reports this preset can't be archived right now.",
    );
    expectControlDescription(
      screen.getByRole("button", { name: "Archive preset" }),
      "The server reports this preset can't be archived right now.",
    );
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

  it("keeps an accepted archive removed when the same-pass list resurrects it", async () => {
    const archivedPreset = archivablePresetFixture("operator-dup", "Operator Dup");
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
          presets: [archivedPreset, presetFixture()],
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
          presets: [archivedPreset, presetFixture()],
          timestamp: "2026-06-20T00:00:10.000Z",
        })}
        recovery={available(recoveryFixture(null))}
      />,
    );

    await user.clear(screen.getByLabelText("Buyer count"));
    await user.type(screen.getByLabelText("Buyer count"), "1234");
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    expect(screen.getByText(/Your unsaved edits will be discarded\./)).toBeTruthy();
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
    await user.click(screen.getByRole("button", { name: "Duplicate saved preset" }));

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

describe("admin realtime stream recovery", () => {
  const replacementDelaysMs = [1_000, 2_000, 4_000, 8_000, 16_000];
  const exhaustedNotice =
    "Unable to restore live updates. Reload the page. If the problem persists, try again later.";

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

  it("offers a full-page reload after exhaustion and keeps HTTP refresh from restarting attempts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => jsonResponse({ ...recoveryFixture(null), revision: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    exhaustStream();
    await act(async () => Promise.resolve());
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(screen.getByText(exhaustedNotice)).toBeTruthy();
    const recoveryReadsBeforeRefresh = fetchMock.mock.calls.length;
    screen.getByRole("button", { name: "Refresh status" }).click();
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(recoveryReadsBeforeRefresh + 1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(InjectedEventSource.instances).toHaveLength(6);
    expect(screen.getByText(exhaustedNotice)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeTruthy();
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

function twoPresetListFixture(name: string): BackendRead<AdminPresetListResponse> {
  return available({
    presets: [
      { ...presetFixture(), display: { ...presetFixture().display, name } },
      presetWithSlug("second", "Second preset"),
    ],
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
    defaultConfig: { latencyMs: 50, maxTps: 100, errorRate: 0, forcedOutage: false },
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
    resetRecoveryRunId: null,
    resetRecovery: "ready",
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
    runtimeProgress: null,
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
    inventoryConfig: { startingStock: 250 },
    erpConfig: {
      latencyMs: 80,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
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

function readOnlyPresetFixture(
  visibility: AdminPresetListItem["visibility"],
  name: string,
): AdminPresetListItem {
  const base = presetFixture();
  return {
    ...base,
    slug: visibility === "public" ? "public-preset" : "system-preset",
    visibility,
    isEditable: false,
    isCustom: false,
    canArchive: false,
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
      estimatedDemoOccupancyCeilingSeconds: 600,
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
        estimatedDemoOccupancyCeilingSeconds: 600,
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

function expectControlDescription(control: HTMLElement, text: string): void {
  const descriptionIds = control.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
  expect(descriptionIds.map((id) => document.getElementById(id)?.textContent)).toContain(text);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
