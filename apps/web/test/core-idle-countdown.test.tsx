// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreIdleCountdown } from "../src/app/components/core-idle-countdown";
import { coreActivityProxyPath, coreIdleStatusProxyPath } from "../src/app/lib/control-paths";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function widget() {
  return document.querySelector("[data-core-idle]");
}

describe("core idle countdown", () => {
  it("counts down, alerts in the last 2 minutes, and resets on stay awake", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (path: string) =>
      path === coreActivityProxyPath
        ? json({ state: "awake", sleepsInSeconds: 600 })
        : json({ state: "awake", sleepsInSeconds: 125 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreIdleCountdown />);
    await advance(0);
    expect(widget()?.textContent).toContain("will sleep after 2:05 without activity");
    expect(widget()?.getAttribute("data-core-idle")).toBe("normal");

    await advance(5_000);
    expect(widget()?.textContent).toContain("2:00");
    expect(widget()?.getAttribute("data-core-idle")).toBe("alert");

    fireEvent.click(screen.getByRole("button", { name: "Stay awake" }));
    await advance(0);
    expect(fetchMock).toHaveBeenCalledWith(
      coreActivityProxyPath,
      expect.objectContaining({ method: "POST" }),
    );
    expect(widget()?.textContent).toContain("10:00");
    expect(widget()?.getAttribute("data-core-idle")).toBe("normal");
  });

  it("shows the run in progress instead of the countdown", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ state: "run_in_progress" })),
    );
    render(<CoreIdleCountdown />);
    await advance(0);
    expect(widget()?.textContent).toBe("Run in progress, the system stays awake.");
  });

  it("stays hidden and stops polling where the core never sleeps", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json({ state: "disabled" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreIdleCountdown />);
    await advance(0);
    await advance(120_000);
    expect(widget()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(coreIdleStatusProxyPath, expect.anything());
  });

  it("shows Demo paused with a link back to the gate once the awake core stops answering", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ state: "awake", sleepsInSeconds: 20 }))
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    render(<CoreIdleCountdown />);
    await advance(0);
    await advance(30_000);
    expect(widget()?.textContent).toContain("Demo paused.");
    expect(screen.getByRole("link", { name: "Back to the start page" }).getAttribute("href")).toBe(
      "/",
    );
  });
});
