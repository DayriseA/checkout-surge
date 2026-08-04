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
  errorPayloadSchema,
} from "@checkout-surge/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminAuthenticatedSurface,
  AdminErpDiagnosticsController,
  AdminPresetController,
  AdminRuntimePolicyController,
} from "../src/app/components/admin/admin-authenticated-surface.js";
import type { BackendRead } from "../src/app/lib/api.js";
import {
  adminDemoResetProxyPath,
  adminErpChaosProxyPath,
  adminErpChaosResetProxyPath,
  adminMaintenanceCleanupRunsProxyPath,
  adminPresetDuplicateProxyPath,
  adminPresetListProxyPath,
  adminPresetSaveProxyPath,
  adminPublicRuntimePolicyProxyPath,
  dashboardRecoveryProxyPath,
} from "../src/app/lib/control-paths.js";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

afterEach(() => {
  cleanup();
  navigation.refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("admin feature controllers", () => {
  it("confirms generated-run cleanup before sending its exact request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        deletedRunCount: 2,
        deletedSaleOfferCount: 2,
        preservedLatestCount: 15,
        preservedActiveRunCount: 0,
        cutoffBefore: "2026-06-13T00:00:00.000Z",
        cleanedAt: "2026-06-20T00:00:00.000Z",
        correlationId: "corr-cleanup",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AdminAuthenticatedSurface {...surfaceProps(null)} />);

    await user.click(screen.getByRole("button", { name: "Cleanup Runs" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cleanup Runs" }));
    await user.click(screen.getByRole("button", { name: "Cleanup generated runs" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
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

    await user.click(screen.getByRole("button", { name: "Reset ERP Controls" }));
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reset ERP controls" }));
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

    await user.click(screen.getByRole("button", { name: "Apply ERP Controls" }));
    expect(
      (screen.getByRole("button", { name: "Apply ERP Controls" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Reset Demo" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      (screen.getByRole("button", { name: "Start Admin Run" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    pending.resolve(jsonResponse(erpFixture()));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Apply ERP Controls" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
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
    await user.click(screen.getByRole("button", { name: "Apply ERP Controls" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      latencyMs: 250,
      maxTps: 100,
      errorRate: 0,
      forcedOutage: false,
    });
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
      (screen.getByRole("button", { name: "Start Admin Run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Reset Demo" }));
    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start Admin Run" }) as HTMLButtonElement).disabled,
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

    await user.click(screen.getByRole("button", { name: "Reset Demo" }));
    await user.click(screen.getByRole("button", { name: "Reset demo" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start Admin Run" }) as HTMLButtonElement).disabled,
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

    await user.click(screen.getByRole("button", { name: "Save Preset" }));
    expect(
      await screen.findByText("The latest information is temporarily unavailable"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Retry Recovery" }));
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
      (screen.getByRole("button", { name: "Start Admin Run" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("preserves a dirty policy draft across props and adopts an explicit save response", async () => {
    const initial = available(runtimePolicyFixture(10_000, 300));
    const user = userEvent.setup();
    const { rerender } = render(<AdminRuntimePolicyController initialRuntimePolicy={initial} />);
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
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(saved),
    );
    vi.stubGlobal("fetch", fetchMock);
    await user.click(screen.getByRole("button", { name: "Save Public Policy" }));

    await waitFor(() =>
      expect((screen.getByLabelText("Budget window seconds") as HTMLInputElement).value).toBe(
        "777",
      ),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(adminPublicRuntimePolicyProxyPath);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect((screen.getByLabelText("Max buyers") as HTMLInputElement).value).toBe("4321");
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

    await user.click(screen.getByRole("button", { name: "Refresh Policy" }));
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
      (screen.getByRole("button", { name: "Archive Preset" }) as HTMLButtonElement).disabled,
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

    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
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
    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
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
    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));

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

    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));

    expect(await screen.findByText("This preset can no longer be archived")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Archive Preset" }) as HTMLButtonElement).disabled,
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
    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The latest information is temporarily unavailable",
    );
    expect(screen.getByText("Technical details")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
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

    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));

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

    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));

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
      (screen.getByRole("button", { name: "Archive Preset" }) as HTMLButtonElement).disabled,
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
    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));

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

    await user.click(screen.getByRole("button", { name: "Archive Preset" }));
    await user.click(screen.getByRole("button", { name: "Archive preset" }));
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
  code:
    | "backend_unavailable"
    | "admin_session_required"
    | "control_token_required"
    | "preset_conflict" = "backend_unavailable",
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
