// @vitest-environment jsdom

import type { ComparisonDetailResponse } from "@checkout-surge/contracts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComparison } from "../src/app/components/realtime/use-comparison.js";
import type { BackendRead } from "../src/app/lib/api.js";
import {
  comparisonFixture,
  comparisonId,
  missingComparisonResponse,
  timestamp,
} from "./comparison-fixtures.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const available = (data: ComparisonDetailResponse) => ({ status: "available" as const, data });

describe("comparison parent reads", () => {
  it("does not schedule or manually retry a canonical missing initial report", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useComparison(comparisonId, {
        status: "unavailable",
        httpStatus: 404,
        errorCode: "resource_not_found",
      }),
    );
    expect(result.current.notFound).toBe(true);
    expect(result.current.unavailable).toBe(false);
    act(() => result.current.refresh());
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reads and clears last-known data when a later poll confirms removal", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(missingComparisonResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() =>
      useComparison(comparisonId, available(comparisonFixture())),
    );
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(result.current.notFound).toBe(true);
    expect(result.current.detail).toBeNull();
    act(() => result.current.refresh());
    await act(async () => vi.advanceTimersByTimeAsync(300000));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps retrying an unverified HTML 404 rather than declaring a missing comparison", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response("<h1>Not found</h1>", { status: 404 })),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useComparison(comparisonId, { status: "loading" }));
    await act(async () => Promise.resolve());
    expect(result.current.notFound).toBe(false);
    expect(result.current.unavailable).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("deduplicates reads and keeps cleanup pending until the parent is terminal", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(Response.json(comparisonFixture("failed")));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useComparison(comparisonId, { status: "loading" }));
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      resolve(Response.json(comparisonFixture("cleanup_pending")));
      await pending;
    });
    expect(result.current.detail?.state).toBe("cleanup_pending");
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(result.current.detail?.state).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
    act(() => result.current.refresh());
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains last-known results, honors Retry-After for manual reads, and stops bounded failure retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        Response.json(
          {
            code: "comparison_read_unavailable",
            message: "Comparison reads are temporarily limited.",
            correlationId: "comparison-unavailable",
            timestamp,
          },
          { status: 503, headers: { "retry-after": "60" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const initial = comparisonFixture();
    const { result } = renderHook(() => useComparison(comparisonId, available(initial)));
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(result.current.detail).toEqual(initial);
    expect(result.current.unavailable).toBe(true);
    act(() => result.current.refresh());
    await act(async () => vi.advanceTimersByTimeAsync(59999));
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Six bounded retries follow the initial failed periodic read.
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60000));
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.current.retriesExhausted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock).toHaveBeenCalledTimes(7);
    act(() => result.current.refresh());
    await act(async () => Promise.resolve());
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("aborts old identities and ignores late responses after identity change and unmount", async () => {
    vi.useFakeTimers();
    const requests: {
      resolve: (response: Response) => void;
      signal: AbortSignal | null | undefined;
    }[] = [];
    const fetchMock = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((resolve) => requests.push({ resolve, signal: init?.signal })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const initialRead: BackendRead<ComparisonDetailResponse> = { status: "loading" };
    const { result, rerender, unmount } = renderHook(({ id }) => useComparison(id, initialRead), {
      initialProps: { id: comparisonId },
    });
    rerender({ id: otherId });
    expect(requests[0]?.signal?.aborted).toBe(true);
    await act(async () => requests[0]?.resolve(Response.json(comparisonFixture("completed"))));
    expect(result.current.detail).toBeNull();
    await act(async () =>
      requests[1]?.resolve(Response.json(comparisonFixture("running", 0, otherId))),
    );
    expect(result.current.detail?.comparisonId).toBe(otherId);
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    unmount();
    expect(requests[2]?.signal?.aborted).toBe(true);
    await act(async () =>
      requests[2]?.resolve(Response.json(comparisonFixture("running", 0, otherId))),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a successful response for a different parent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(comparisonFixture("completed", 0, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")),
        ),
    );
    const { result } = renderHook(() => useComparison(comparisonId, { status: "loading" }));
    await act(async () => Promise.resolve());
    expect(result.current.detail).toBeNull();
    expect(result.current.unavailable).toBe(true);
  });
});
