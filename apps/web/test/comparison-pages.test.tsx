import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ComparisonPage from "../src/app/comparisons/[comparisonId]/page.js";
import WatchPage from "../src/app/watch/page.js";
import { comparisonFixture, comparisonId } from "./comparison-fixtures.js";

const reads = vi.hoisted(() => ({
  getComparisonDetail: vi.fn(),
  getRunHistoryDetail: vi.fn(),
  getRunHistoryPage: vi.fn(),
  pendingDashboardRecovery: vi.fn(() => ({ status: "loading" })),
}));
vi.mock("../src/app/lib/api.js", () => reads);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  reads.getComparisonDetail.mockResolvedValue({
    status: "available",
    data: comparisonFixture("completed", 3),
  });
});

describe("comparison pages", () => {
  it.each([
    "watch",
    "saved",
  ] as const)("presents canonical absence on the %s entry without temporary-outage or retry copy", async (entry) => {
    reads.getComparisonDetail.mockResolvedValue({
      status: "unavailable",
      httpStatus: 404,
      errorCode: "resource_not_found",
    });
    const page =
      entry === "watch"
        ? await WatchPage({ searchParams: Promise.resolve({ comparisonId }) })
        : await ComparisonPage({ params: Promise.resolve({ comparisonId }) });
    const markup = renderToStaticMarkup(page);
    expect(markup).toContain("This comparison could not be found");
    expect(markup).toContain('href="/run-history"');
    expect(markup).toContain('href="/demo"');
    expect(markup).not.toContain("temporarily unavailable");
    expect(markup).not.toContain("Check again");
  });
  it.each([
    { comparisonId: "bad" },
    { comparisonId: [comparisonId] },
    { comparisonId, acceptedRunId: "11111111-1111-4111-8111-111111111111" },
    { comparisonId, acceptedRunId: [] },
    { acceptedRunId: ["11111111-1111-4111-8111-111111111111"] },
    { acceptedRunId: "bad" },
  ])("rejects ambiguous or invalid watch context before any reads: %j", async (query) => {
    expect(
      renderToStaticMarkup(await WatchPage({ searchParams: Promise.resolve(query) })),
    ).toContain("This Watch link is invalid");
    expect(reads.getComparisonDetail).not.toHaveBeenCalled();
    expect(reads.getRunHistoryDetail).not.toHaveBeenCalled();
    expect(reads.getRunHistoryPage).not.toHaveBeenCalled();
  });

  it("uses the same parent-owned report on watch and saved links", async () => {
    const watch = renderToStaticMarkup(
      await WatchPage({ searchParams: Promise.resolve({ comparisonId }) }),
    );
    const saved = renderToStaticMarkup(
      await ComparisonPage({ params: Promise.resolve({ comparisonId }) }),
    );
    expect(watch).toBe(saved);
    expect(watch).toContain("Stock checks");
    expect(watch).toContain("Order processing");
    expect(reads.getComparisonDetail).toHaveBeenCalledTimes(2);
    expect(reads.getRunHistoryPage).not.toHaveBeenCalled();
  });

  it("rejects an invalid saved identity before reads", async () => {
    await expect(
      ComparisonPage({ params: Promise.resolve({ comparisonId: "bad" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(reads.getComparisonDetail).not.toHaveBeenCalled();
  });
});
