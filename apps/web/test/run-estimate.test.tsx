// @vitest-environment jsdom

import {
  type AdminPresetListItem,
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionScopeId,
  type PublicRuntimePolicy,
  type StartDemoRunRequest,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminPresetController } from "../src/app/components/admin/admin-authenticated-surface";
import { PublicDemoEntry } from "../src/app/components/public-demo-entry";
import { useDashboardRecovery } from "../src/app/components/realtime/use-dashboard-recovery";
import { RunEstimateNotice } from "../src/app/components/run-estimate-notice";
import { useRunEstimate } from "../src/app/components/use-run-estimate";
import type { BackendRead, PublicDemoSurface } from "../src/app/lib/api";
import {
  adminDemoRunEstimateProxyPath,
  adminDemoRunStartProxyPath,
  dashboardRecoveryProxyPath,
  demoRunEstimateProxyPath,
  demoRunStartProxyPath,
} from "../src/app/lib/control-paths";
import { estimateRejectionCopy } from "../src/app/lib/presentation/estimate-presentation";
import { estimateFixture, estimateRejectionFixture } from "./estimate-fixtures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function debounce() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function available<T>(data: T): BackendRead<T> {
  return { status: "available", data };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("debounces rapid edits, aborts superseded requests and ignores out-of-order responses even when inputs return to an earlier value", async () => {
  vi.useFakeTimers();
  const old = deferred<Response>();
  const fetchMock = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(json({ result: estimateFixture("over_ceiling") }))
    .mockResolvedValueOnce(json({ result: estimateFixture() }));
  vi.stubGlobal("fetch", fetchMock);
  const request = (count: number): StartDemoRunRequest => ({
    presetSlug: "custom",
    configOverride: {
      inventoryConfig: {
        ...previewRunConfigSnapshotFixture().inventoryConfig,
        startingStock: count,
      },
    },
  });
  const { result, rerender, unmount } = renderHook(
    ({ count, enabled }) => useRunEstimate(request(count), "admin", enabled),
    { initialProps: { count: 1, enabled: true } },
  );
  expect(result.current.blocksStart).toBe(true);
  rerender({ count: 2, enabled: true });
  rerender({ count: 3, enabled: true });
  expect(fetchMock).not.toHaveBeenCalled();
  await debounce();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const signal = fetchMock.mock.calls[0]?.[1].signal as AbortSignal;
  rerender({ count: 4, enabled: true });
  expect(signal.aborted).toBe(true);
  expect(result.current.state.status).toBe("pending");
  await debounce();
  expect(result.current.state.status).toBe("rejected");
  rerender({ count: 3, enabled: true });
  expect(result.current.state.status).toBe("pending");
  await debounce();
  await act(async () => old.resolve(json({ result: estimateFixture("unestimable") })));
  expect(result.current.state.status).toBe("allowed");
  expect(result.current.blocksStart).toBe(false);
  rerender({ count: 10, enabled: false });
  expect(result.current.state.status).toBe("inactive");
  await debounce();
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect((fetchMock.mock.calls[2]?.[1].signal as AbortSignal).aborted).toBe(true);
  unmount();
});

it("keeps public outage and policy guidance private", () => {
  const outage = estimateFixture("unestimable");
  expect(estimateRejectionCopy(outage, "admin").join(" ")).toContain(
    "Disable the declared permanent ERP outage",
  );
  const publicCopy = estimateRejectionCopy(outage, "public").join(" ");
  expect(publicCopy).toContain("ERP availability");
  expect(publicCopy).not.toMatch(/outage|Disable|duration|30%/i);
  expect(
    estimateRejectionCopy(
      {
        ...outage,
        unestimableReason: "error_rate_above_policy_maximum",
        reasons: ["Lower to 30%."],
      },
      "public",
    ).join(" "),
  ).not.toContain("30%");
});

it("uses the API decision despite display rounding and stays silent when allowed", () => {
  const { rerender } = render(
    <RunEstimateNotice state={{ status: "allowed", result: estimateFixture() }} mode="public" />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  rerender(
    <RunEstimateNotice
      state={{ status: "rejected", result: estimateFixture("over_ceiling") }}
      mode="public"
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Configuration not allowed.");
  expect(screen.getByText("Conservative duration: 600 seconds.")).toBeTruthy();
  expect(screen.getByText("Demo limit: 600 seconds.")).toBeTruthy();
  expect(screen.getByText(/Increase declared ERP capacity/)).toBeTruthy();
});

describe.each(["public", "admin"] as const)("%s admission surface", (mode) => {
  function mount() {
    return mode === "public"
      ? render(<PublicDemoEntry surface={publicSurface()} />)
      : render(
          <AdminPresetController
            initialPresets={available({ presets: [preset()], timestamp })}
            recovery={available(recovery())}
          />,
        );
  }
  function startButton() {
    return screen.getByRole("button", {
      name: mode === "public" ? "Start Preview 1k" : "Run once with these values",
    }) as HTMLButtonElement;
  }
  async function start() {
    await act(async () => fireEvent.click(startButton()));
    if (mode === "admin")
      await act(async () =>
        fireEvent.click(
          within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start run" }),
        ),
      );
  }
  const previewPath = mode === "public" ? demoRunEstimateProxyPath : adminDemoRunEstimateProxyPath;
  const startPath = mode === "public" ? demoRunStartProxyPath : adminDemoRunStartProxyPath;

  it.each([
    "over_ceiling",
    "unestimable",
  ] as const)("shows authoritative %s start rejection", async (kind) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === previewPath
        ? json({ result: estimateFixture() })
        : json(
            {
              code: "estimated_duration_rejected",
              message: "Rejected",
              details: estimateRejectionFixture(kind),
              correlationId: "start-rejected",
              timestamp,
            },
            400,
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mount();
    await debounce();
    expect(startButton().disabled).toBe(false);
    await start();
    expect(screen.getAllByText("Configuration not allowed.").length).toBeGreaterThan(0);
    expect(startButton().disabled).toBe(true);
    if (mode === "admin")
      expect(
        (
          within(screen.getByRole("alertdialog")).getByRole("button", {
            name: "Start run",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === startPath)).toHaveLength(1);
    if (mode === "public") {
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === previewPath)).toHaveLength(
        0,
      );
      if (kind === "unestimable") expect(document.body.textContent).not.toMatch(/outage/i);
    }
  });

  it("makes no preview requests or admission display while a run is active", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const active = accepted(mode).run;
    if (mode === "public")
      render(
        <PublicDemoEntry surface={{ ...publicSurface(), recovery: available(recovery(active)) }} />,
      );
    else
      render(
        <AdminPresetController
          initialPresets={available({ presets: [preset()], timestamp })}
          recovery={available(recovery(active))}
        />,
      );
    await debounce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Conservative duration/)).toBeNull();
  });
});

describe("admin admission surface", () => {
  const previewPath = adminDemoRunEstimateProxyPath;
  const startPath = adminDemoRunStartProxyPath;
  function mountAdmin() {
    render(
      <AdminPresetController
        initialPresets={available({ presets: [preset()], timestamp })}
        recovery={available(recovery())}
      />,
    );
  }
  function adminStartButton() {
    return screen.getByRole("button", { name: "Run once with these values" }) as HTMLButtonElement;
  }
  it.each([
    "over_ceiling",
    "unestimable",
  ] as const)("blocks pending and %s previews with actionable copy", async (kind) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ result: estimateFixture(kind) }));
    vi.stubGlobal("fetch", fetchMock);
    mountAdmin();
    expect(adminStartButton().disabled).toBe(true);
    await debounce();
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(adminStartButton().disabled).toBe(true);
    expect(screen.getByText("Configuration not allowed.")).toBeTruthy();
    if (kind === "over_ceiling") expect(screen.getByText(/Conservative duration:/)).toBeTruthy();
    else expect(screen.queryByText(/Conservative duration:/)).toBeNull();
    fireEvent.click(adminStartButton());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows an authoritative start after a preview failure and hides admission after acceptance", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === previewPath) throw new Error("offline");
      if (String(input) === startPath) return json(accepted("admin"), 202);
      throw new Error(`Unexpected request ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    mountAdmin();
    await debounce();
    expect(screen.getByText(/Preview unavailable. You can try starting/)).toBeTruthy();
    expect(adminStartButton().disabled).toBe(false);
    await act(async () => fireEvent.click(adminStartButton()));
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start run" }),
      ),
    );
    expect(screen.queryByText(/Preview unavailable/)).toBeNull();
    expect(adminStartButton().disabled).toBe(true);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === startPath)).toHaveLength(1);
    await debounce();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === previewPath)).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toContain(
      accepted("admin").run.runId,
    );
  });
});

it.each([
  "public",
  "admin",
] as const)("previews only the latest %s custom inputs and submits the same strict intent", async (mode) => {
  vi.useFakeTimers();
  const previewPath = mode === "public" ? demoRunEstimateProxyPath : adminDemoRunEstimateProxyPath;
  const startPath = mode === "public" ? demoRunStartProxyPath : adminDemoRunStartProxyPath;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input) === previewPath ? json({ result: estimateFixture() }) : json(accepted(mode), 202),
  );
  vi.stubGlobal("fetch", fetchMock);
  if (mode === "public") {
    const surface = publicSurface();
    surface.presets = available({
      presets: [{ ...preset(), slug: "public-custom", isCustom: true }],
      timestamp,
    });
    surface.runtimePolicy = available({
      id: "active",
      policy: publicRuntimePolicyFixture(),
      updatedAt: timestamp,
    });
    render(<PublicDemoEntry surface={surface} />);
    await debounce();
    expect(fetchMock).not.toHaveBeenCalled();
    const details = screen.getByText("Customize a scenario").closest("details");
    if (!details) throw new Error("Expected custom builder");
    details.open = true;
    fireEvent(details, new Event("toggle"));
  } else {
    render(
      <AdminPresetController
        initialPresets={available({
          presets: [
            { ...preset(), slug: "custom", visibility: "admin", isEditable: true, isCustom: true },
          ],
          timestamp,
        })}
        recovery={available(recovery())}
      />,
    );
  }
  await debounce();
  const initialSignal = fetchMock.mock.calls[0]?.[1]?.signal;
  const buyers = screen.getByLabelText(/^Buyer count/);
  fireEvent.change(buyers, { target: { value: "11" } });
  fireEvent.change(buyers, { target: { value: "12" } });
  const start = screen.getByRole("button", {
    name: mode === "public" ? "Start custom run" : "Run once with these values",
  }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  expect(initialSignal?.aborted).toBe(true);
  await debounce();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const previewBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
  expect(previewBody.configOverride.trafficConfig.buyerCount).toBe(12);
  expect(start.disabled).toBe(false);
  await act(async () => fireEvent.click(start));
  if (mode === "admin")
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start run" }),
      ),
    );
  const submission = fetchMock.mock.calls.find(([input]) => String(input) === startPath);
  expect(JSON.parse(String(submission?.[1]?.body))).toEqual(previewBody);
  await debounce();
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("retains the accepted admin handoff after failed recovery until a newer authoritative inactive read", async () => {
  vi.useFakeTimers();
  const initialRecovery = available({ ...recovery(), recoveredAt: "2026-06-20T00:00:11.000Z" });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === adminDemoRunEstimateProxyPath) return json({ result: estimateFixture() });
    if (String(input) === adminDemoRunStartProxyPath) return json(accepted("admin"), 202);
    throw new Error("Recovery failed");
  });
  vi.stubGlobal("fetch", fetchMock);
  function RecoveringAdmin() {
    const controller = useDashboardRecovery(initialRecovery, {
      preserveAvailableRecoveryOnFailure: true,
    });
    return (
      <>
        <button type="button" onClick={() => void controller.retryNow()}>
          Retry recovery
        </button>
        {controller.hasSyncIssue ? <p>Recovery failed; previous projection retained.</p> : null}
        <AdminPresetController
          initialPresets={available({ presets: [preset()], timestamp })}
          recovery={controller.recovery}
          onStartComplete={controller.retryNow}
        />
      </>
    );
  }
  render(<RecoveringAdmin />);
  await debounce();
  const start = screen.getByRole("button", {
    name: "Run once with these values",
  }) as HTMLButtonElement;
  await act(async () => fireEvent.click(start));
  await act(async () =>
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Start run" }),
    ),
  );
  expect(
    fetchMock.mock.calls.filter(([input]) => String(input) === dashboardRecoveryProxyPath),
  ).toHaveLength(0);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry recovery" })));
  expect(screen.getByText("Recovery failed; previous projection retained.")).toBeTruthy();
  expect(
    fetchMock.mock.calls.filter(([input]) => String(input) === dashboardRecoveryProxyPath),
  ).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Watch live" }).getAttribute("href")).toBe(
    `/watch?acceptedRunId=${accepted("admin").run.runId}`,
  );
  expect(start.disabled).toBe(true);
  await debounce();
  expect(
    fetchMock.mock.calls.filter(([input]) => String(input) === adminDemoRunEstimateProxyPath),
  ).toHaveLength(1);

  fetchMock.mockResolvedValueOnce(
    json({ ...recovery(), revision: 2, recoveredAt: "2026-06-20T00:00:12.000Z" }),
  );
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry recovery" })));
  expect(screen.queryByText("Recovery failed; previous projection retained.")).toBeNull();
  expect(start.disabled).toBe(true);
  await debounce();
  expect(
    fetchMock.mock.calls.filter(([input]) => String(input) === adminDemoRunEstimateProxyPath),
  ).toHaveLength(2);
  expect(start.disabled).toBe(false);
});

const timestamp = "2026-06-20T00:00:10.000Z";
function preset(): AdminPresetListItem {
  return {
    ...previewRunConfigSnapshotFixture(),
    id: "33333333-3333-4333-8333-333333333331",
    slug: "preview-1k",
    visibility: "public",
    isEditable: false,
    isCustom: false,
    canArchive: false,
    display: { name: "Preview 1k", description: "Test scenario", sortOrder: 1, outcomeFocus: [] },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function accepted(mode: "public" | "admin") {
  const run: DemoRunSnapshot = {
    runId: "55555555-5555-4555-8555-555555555555",
    presetId: preset().id,
    presetName: "Accepted server scenario",
    operatorMode: mode,
    status: "active",
    trafficStatus: "active",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt: timestamp,
    autoResetAt: timestamp,
    trafficStartedAt: timestamp,
  };
  return { run, recovery: { establishedAt: timestamp }, correlationId: "accepted-run", timestamp };
}
function recovery(currentRun: DashboardProjection["currentRun"] = null): DashboardProjection {
  const scope = currentRun
    ? { runId: currentRun.runId, saleOfferId: currentRun.saleOfferId as string }
    : null;
  return {
    schema: dashboardProjectionSchemaName,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    correlationId: "recovery",
    scopeId: dashboardProjectionScopeId(scope),
    revision: 1,
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
    recoveredAt: timestamp,
    runtimeProgress: null,
  };
}
function publicSurface(): PublicDemoSurface {
  return {
    presets: available({ presets: [preset()], timestamp }),
    readiness: available({ service: "api", status: "ok", timestamp, uptimeSeconds: 1, checks: [] }),
    recovery: available(recovery()),
    runtimePolicy: { status: "loading" },
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
    publicCustomDefaults: previewRunConfigSnapshotFixture(),
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
