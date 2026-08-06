// @vitest-environment jsdom

import type { RunHistorySummary } from "@checkout-surge/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunHistoryAdminControls } from "../src/app/components/run-history-admin-controls.js";
import { RunHistoryDeleteAllButton } from "../src/app/components/run-history-delete-all-button.js";
import { RunHistoryRowControls } from "../src/app/components/run-history-row-controls.js";
import { adminRunHistoryProxyPath } from "../src/app/lib/control-paths.js";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

describe("RunHistoryAdminControls", () => {
  it("does not render an empty dialog error wrapper", () => {
    const { container } = renderSurface();

    expect(container.querySelector("dialog > div.mt-4")).toBeNull();
  });

  it("sends no request on trigger/cancel and requires the exact delete-all token", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderSurface();

    await user.click(screen.getByRole("button", { name: "Delete all run summaries" }));
    const confirm = screen.getByRole("button", { name: "Delete all summaries" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByRole("textbox"), "delete");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "DELETE");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the sticky selection bar only while summaries are selected", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    renderSurface();

    expect(screen.queryByRole("button", { name: /Delete selected/ })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[1]?.runId}` }));
    expect(screen.getByRole("button", { name: "Delete selected (2)" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByRole("button", { name: /Delete selected/ })).toBeNull();
  });

  it("selects and clears every visible run from the select-all control", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    renderSurface();
    const selectAll = screen.getByRole("checkbox", { name: "Select all visible runs" });

    await user.click(selectAll);
    expect(screen.getByRole("button", { name: "Delete selected (2)" })).toBeTruthy();
    for (const summary of summaries) {
      const row = screen.getByRole("checkbox", { name: `Select run ${summary.runId}` });
      expect((row as HTMLInputElement).checked).toBe(true);
    }

    await user.click(selectAll);
    expect(screen.queryByRole("button", { name: /Delete selected/ })).toBeNull();
  });

  it("reflects a partial row selection as an indeterminate select-all control", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    renderSurface();
    const selectAll = screen.getByRole("checkbox", {
      name: "Select all visible runs",
    }) as HTMLInputElement;
    expect(selectAll.indeterminate).toBe(false);

    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    expect(selectAll.indeterminate).toBe(true);
    expect(selectAll.checked).toBe(false);

    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[1]?.runId}` }));
    expect(selectAll.indeterminate).toBe(false);
    expect(selectAll.checked).toBe(true);
  });

  it("deletes a single run from its row control without touching the selection", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      successResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderSurface();

    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(
      screen.getByRole("button", {
        name: `Delete run ${summaries[1]?.presetName} (${summaries[1]?.runId})`,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Delete run summary" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      runIds: [summaries[1]?.runId],
      visibleFilter: { runIds: summaries.map((summary) => summary.runId) },
    });
    expect(screen.getByRole("button", { name: "Delete selected (1)" })).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("submits one exact selected payload, locks pending dismissal/duplicates, then refreshes", async () => {
    const user = userEvent.setup();
    const pending = deferred<Response>();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    renderSurface();
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: /Delete selected/ }));
    await user.click(screen.getByRole("button", { name: "Delete run summary" }));
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
    renderSurface();
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: /Delete selected/ }));

    await user.click(screen.getByRole("button", { name: "Delete run summary" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Something didn't work on our side",
    );
    expect(screen.getByText("Technical details")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete run summary" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Something didn't work on our side",
    );
    expect(screen.getByText("Technical details")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Delete run summary" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("clears selection, typed token, errors, and the privileged dialog on 401", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "admin_session_required",
            message: "Session expired",
            correlationId: "delete-session-expired",
            timestamp: "2026-06-20T00:00:00.000Z",
          },
          { status: 401 },
        ),
      ),
    );
    renderSurface();
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: "Delete all run summaries" }));
    await user.type(screen.getByRole("textbox"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete all summaries" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /Delete selected/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Delete all run summaries" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Delete all summaries" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("does not refresh on a malformed 401 and retains protected diagnostics", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Session expired" }, { status: 401 })),
    );
    renderSurface();
    await user.click(screen.getByRole("checkbox", { name: `Select run ${summaries[0]?.runId}` }));
    await user.click(screen.getByRole("button", { name: /Delete selected/ }));
    await user.click(screen.getByRole("button", { name: "Delete run summary" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Something didn't work on our side");
  });
});

/** Rows stand in for the summary list, which browser-workflows covers end to end. */
function renderSurface() {
  return render(
    <RunHistoryAdminControls visibleRunIds={summaries.map((summary) => summary.runId)}>
      {summaries.map((summary) => (
        <RunHistoryRowControls
          key={summary.runId}
          presetName={summary.presetName}
          runId={summary.runId}
        />
      ))}
      <RunHistoryDeleteAllButton />
    </RunHistoryAdminControls>,
  );
}

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
