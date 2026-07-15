// @vitest-environment jsdom

import type { RunHistorySummary } from "@checkout-surge/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHistoryAdminControls } from "../src/app/components/run-history-admin-controls.js";
import { adminRunHistoryProxyPath } from "../src/app/lib/control-paths.js";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("RunHistoryAdminControls", () => {
  it("sends no request on trigger/cancel and requires the exact delete-all token", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<RunHistoryAdminControls summaries={summaries} />);

    await user.click(screen.getByRole("button", { name: "Delete All Run Summaries" }));
    const confirm = screen.getByRole("button", { name: "Delete all summaries" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox"), "DELETE_ALL_RUN_SUMMARIE");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox"), "S");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits one exact selected payload, locks pending dismissal/duplicates, then refreshes", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    render(<RunHistoryAdminControls summaries={summaries} />);
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: /Delete Selected/ }));
    await user.click(screen.getByRole("button", { name: "Delete selected summaries" }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(adminRunHistoryProxyPath);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      runIds: [summaries[0]?.runId],
      visibleFilter: { runIds: summaries.map((summary) => summary.runId) },
    });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Working…" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    pending.resolve(successResponse());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps network and HTTP failures open and retryable", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network disconnected"))
      .mockResolvedValueOnce(Response.json({ message: "Deletion refused" }, { status: 503 }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<RunHistoryAdminControls summaries={summaries} />);
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: /Delete Selected/ }));

    await user.click(screen.getByRole("button", { name: "Delete selected summaries" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Network disconnected");
    await user.click(screen.getByRole("button", { name: "Delete selected summaries" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Deletion refused");
    await user.click(screen.getByRole("button", { name: "Delete selected summaries" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("clears selection, typed token, errors, and the privileged dialog on 401", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Session expired" }, { status: 401 })),
    );
    render(<RunHistoryAdminControls summaries={summaries} />);
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: "Delete All Run Summaries" }));
    await user.type(screen.getByRole("textbox"), "DELETE_ALL_RUN_SUMMARIES");
    await user.click(screen.getByRole("button", { name: "Delete all summaries" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(refresh).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: /Delete Selected/ }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Delete All Run Summaries" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect((screen.getByRole("button", { name: "Delete all summaries" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const summaries = [
  { runId: "55555555-5555-4555-8555-555555555555", presetName: "Preview 1k" },
  { runId: "66666666-6666-4666-8666-666666666666", presetName: "Surge 5k" },
] as RunHistorySummary[];

function successResponse(): Response {
  return Response.json({
    deletedSummaryCount: 1,
    deletedAt: "2026-06-20T00:00:10.000Z",
    correlationId: "corr-delete-history",
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
