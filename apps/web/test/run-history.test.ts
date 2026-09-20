// @vitest-environment jsdom

import {
  type AdminRunHistoryDetailResponse,
  deriveRunResult,
  emptyHttpTimingBreakdownSummary,
  emptyRequestArrivalSummary,
  emptyServerReservationTimingSummary,
  type PublicRunHistoryDetailResponse,
  type RunHistoryListResponse,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunHistoryAdminControls } from "../src/app/components/run-history-admin-controls.js";
import {
  AdminRunHistoryDetail,
  PublicRunHistoryDetail,
} from "../src/app/components/run-history-detail.js";
import { RunHistoryList } from "../src/app/components/run-history-list.js";
import { buildRunHistoryTrace } from "../src/app/lib/presentation/run-history-trace.js";
import RunHistoryDetailPage from "../src/app/run-history/[runId]/page.js";
import RunHistoryPage from "../src/app/run-history/page.js";

const getRunHistoryPage = vi.hoisted(() => vi.fn());
const getRunHistoryDetail = vi.hoisted(() => vi.fn());
const getAdminRunHistoryDetail = vi.hoisted(() => vi.fn());
const hasValidAdminPageSession = vi.hoisted(() => vi.fn());
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);

vi.mock("next/navigation", () => ({ notFound, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../src/app/lib/api.js", () => ({
  getRunHistoryPage,
  getRunHistoryDetail,
  getAdminRunHistoryDetail,
}));
vi.mock("../src/app/lib/server/admin-page-session.js", () => ({ hasValidAdminPageSession }));
function publicReport(detail: PublicRunHistoryDetailResponse) {
  return createElement(PublicRunHistoryDetail, { detail });
}

describe("run history", () => {
  it("presents reset history as cancelled with discarded data", () => {
    const history = listFixture();
    const summary = history.summaries[0];
    if (!summary) throw new Error("Expected a run summary fixture.");
    summary.dataDiscarded = true;
    const list = renderToStaticMarkup(createElement(RunHistoryList, { history }));
    expect(list).toContain("Cancelled");

    const publicDetail = detailFixture("failed");
    publicDetail.summary.dataDiscarded = true;
    const publicMarkup = renderToStaticMarkup(
      createElement(PublicRunHistoryDetail, { detail: publicDetail }),
    );
    expect(publicMarkup).toContain("cancelled by an admin reset");
    expect(publicMarkup).toContain("experiment data was discarded");
    expect(publicMarkup).not.toContain("Final stock and orders");
    expect(publicMarkup).toContain("Back to run history");

    const adminDetail = adminDetailFixture();
    adminDetail.summary.dataDiscarded = true;
    const adminMarkup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, {
        detail: adminDetail,
        actions: createElement("button", { type: "button" }, "Delete run"),
        navigation: createElement("a", { href: "/admin/run-history" }, "Back to admin history"),
      }),
    );
    expect(adminMarkup).toContain("experiment data was discarded");
    expect(adminMarkup).toContain("Delete run");
    expect(adminMarkup).toContain("Back to admin history");
    expect(adminMarkup).not.toContain("Evidence and reconciliation proof");
  });

  it("labels operator-stop and work-cleanup boundaries without fabricating legacy completion", () => {
    const detail = detailFixture("failed");
    detail.summary.failureCategory = "operator";
    detail.summary.businessOutcomeSummary.notificationsRecorded = 0;
    detail.run.finalizedAt = "2026-06-20T00:00:10.000Z";
    detail.run.adminResetCompletedAt = "2026-06-20T00:00:20.000Z";
    const output = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));
    expect(output).toContain("Operator stop decision");
    expect(output).toContain("Work cleanup and history completed");
    expect(output).toContain("Acceptance-to-stop duration");
    expect(output).toContain("Acceptance-to-work-cleanup completion duration");
    expect(output).toContain("20 s");
    expect(renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }))).toBe(output);
    delete detail.run.adminResetCompletedAt;
    const legacy = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));
    expect(legacy).toContain("Unknown");
    expect(legacy).not.toContain("2026-06-20 00:00:20 UTC");
    const admin = adminDetailFixture();
    admin.summary.failureCategory = "operator";
    admin.run.adminResetCompletedAt = "2026-06-20T00:00:20.000Z";
    const adminOutput = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: admin }),
    );
    expect(adminOutput).toContain("Operator stop decision");
    expect(adminOutput).toContain("Acceptance-to-work-cleanup completion duration");
  });

  afterEach(cleanup);

  beforeEach(() => {
    getRunHistoryPage.mockReset();
    getRunHistoryDetail.mockReset();
    getAdminRunHistoryDetail.mockReset();
    hasValidAdminPageSession.mockResolvedValue(false);
    notFound.mockClear();
  });

  it.each([
    [0, "0 runs"],
    [1, "1 run"],
    [11, "11 runs"],
  ] as const)("renders the run count for totalCount %i", async (totalCount, expected) => {
    const history = {
      ...listFixture(),
      summaries: totalCount === 0 ? [] : listFixture().summaries,
      totalCount,
    };
    getRunHistoryPage.mockResolvedValue({ status: "available", data: history });

    const pageMarkup = renderToStaticMarkup(await RunHistoryPage({}));
    expect(pageMarkup).toContain(expected);

    if (totalCount === 1) {
      const listMarkup = renderToStaticMarkup(
        createElement(RunHistoryList, {
          history: { ...history, summaries: [], page: 2 },
        }),
      );
      expect(listMarkup).toContain("1 run exists");
      expect(listMarkup).not.toContain("1 runs");
    } else if (totalCount > history.pageSize) {
      expect(renderToStaticMarkup(createElement(RunHistoryList, { history }))).toContain(expected);
    }
  });

  it("renders the complete list", async () => {
    const history = listFixture();
    const first = history.summaries[0];
    if (!first) throw new Error("Expected a run summary fixture.");
    history.summaries.push(
      {
        ...first,
        runId: "66666666-6666-4666-8666-666666666666",
        presetName: "Order failure warning scenario",
        resultOutcome: "completed-with-order-failures",
        plannedAttempts: 1_200,
        startingStock: 100,
        uniqueReservations: 100,
        soldOutRejections: 1_100,
        confirmedOrders: 98,
        failedOrders: 2,
        overallDurationMs: 12_000,
        convergenceDurationSeconds: 4,
      },
      {
        ...first,
        runId: "77777777-7777-4777-8777-777777777777",
        presetName: "Result awaiting enough evidence to be verified",
        resultOutcome: "outcome-indeterminate",
      },
    );
    getRunHistoryPage.mockResolvedValue({ status: "available", data: history });
    const page = await RunHistoryPage({});
    const { container } = render(page);

    const completedRow = screen.getByRole("heading", { name: "Preview 1k" }).closest("article");
    const warningRow = screen
      .getByRole("heading", { name: "Order failure warning scenario" })
      .closest("article");
    if (!completedRow || !warningRow) throw new Error("Expected complete history rows.");
    const expectVisibleFact = (row: HTMLElement, label: string, value: string) => {
      const labelElement = within(row).getByText(label, { selector: "p" });
      expect(labelElement.closest("[hidden]")).toBeNull();
      expect(labelElement.nextElementSibling?.textContent).toBe(value);
    };

    expect(within(completedRow).getByText("20 attempts · 10 units")).toBeTruthy();
    expect(within(completedRow).getByText("Completed")).toBeTruthy();
    expectVisibleFact(completedRow, "Confirmed orders", "10");
    expectVisibleFact(completedRow, "Failed orders", "0");
    expectVisibleFact(completedRow, "Overall duration", "10 s");

    expect(within(warningRow).getByText("1,200 attempts · 100 units")).toBeTruthy();
    expect(within(warningRow).getByText("Completed with order failures").classList).toContain(
      "text-warning",
    );
    expectVisibleFact(warningRow, "Confirmed orders", "98");
    expectVisibleFact(warningRow, "Failed orders", "2");
    expectVisibleFact(warningRow, "Overall duration", "12 s");

    expect(screen.getByText("Result not fully verified").classList).toContain("text-muted-strong");
    const occurredAt = completedRow.querySelector("time");
    expect(occurredAt?.dateTime).toBe("2026-06-20T00:00:00.000Z");
    expect(occurredAt?.textContent).toContain("2026-06-20 00:00:00 UTC");
    const reportLink = within(completedRow).getByRole("link", {
      name: "View report for Preview 1k run from 2026-06-20 00:00:00 UTC",
    });
    expect(reportLink.getAttribute("href")).toBe(
      "/run-history/55555555-5555-4555-8555-555555555555",
    );
    for (const row of container.querySelectorAll("article")) {
      expect(within(row as HTMLElement).getAllByRole("link")).toHaveLength(1);
    }
    expect(screen.getAllByText("Unique reservations secured", { selector: "p" })).toHaveLength(3);
    expect(screen.getAllByText("Sold-out rejections")).toHaveLength(3);
    expect(screen.getAllByText("Convergence duration")).toHaveLength(3);
    expect(screen.getByText(/Convergence measures from the end of traffic dispatch/)).toBeTruthy();

    expectVisibleFact(completedRow, "Unique reservations secured", "10");
    expectVisibleFact(completedRow, "Sold-out rejections", "10");
    expectVisibleFact(completedRow, "Convergence duration", "2 s");
    expectVisibleFact(warningRow, "Unique reservations secured", "100");
    expectVisibleFact(warningRow, "Sold-out rejections", "1,100");
    expectVisibleFact(warningRow, "Convergence duration", "4 s");
    expect(container.textContent).not.toContain("Traffic delivery");
    expect(container.textContent).not.toContain("Final inventory");
    expect(container.textContent).not.toContain("55555555-5555-4555-8555-555555555555");
  });

  it("names detail links and keeps destructive controls outside named pagination", () => {
    const history = listFixture();
    const firstSummary = history.summaries[0];
    if (!firstSummary) throw new Error("Expected a run summary fixture.");
    history.summaries.push({
      ...firstSummary,
      runId: "66666666-6666-4666-8666-666666666666",
      presetName: "Surge 5k",
      occurredAt: "2026-06-20T00:01:00.000Z",
    });
    history.totalCount = 11;
    const { rerender } = render(
      createElement(
        RunHistoryAdminControls,
        { visibleRunIds: history.summaries.map(({ runId }) => runId) },
        createElement(RunHistoryList, { history }),
      ),
    );

    expect(screen.queryByRole("group", { name: "View" })).toBeNull();
    expect(screen.getAllByText("Unique reservations secured", { selector: "p" })).toHaveLength(2);
    expect(screen.getAllByText("Convergence duration")).toHaveLength(2);

    expect(
      screen.getByRole("link", {
        name: "View report for Preview 1k run from 2026-06-20 00:00:00 UTC",
      }).classList,
    ).toContain("min-h-11");
    expect(
      screen.getByRole("link", {
        name: "View report for Surge 5k run from 2026-06-20 00:01:00 UTC",
      }),
    ).toBeTruthy();
    const pagination = screen.getByRole("navigation", { name: "Run history pages" });
    expect(within(pagination).getByRole("link", { name: "Next" }).classList).toContain("min-h-11");
    expect(
      within(pagination).queryByRole("button", { name: "Delete all run summaries" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Delete all run summaries" })).toBeTruthy();

    rerender(
      createElement(
        RunHistoryAdminControls,
        { visibleRunIds: history.summaries.map(({ runId }) => runId) },
        createElement(RunHistoryList, { history: { ...history, totalCount: 2 } }),
      ),
    );
    expect(screen.queryByRole("navigation", { name: "Run history pages" })).toBeNull();
  });

  it("handles empty, multiple-page, and out-of-range run states", () => {
    const empty = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: { ...listFixture(), summaries: [], totalCount: 0 },
      }),
    );
    expect(empty).toContain("No runs yet");
    expect(empty).toMatch(/href="\/demo"[^>]*>Start a simulation<\/a>/);

    expect(
      renderToStaticMarkup(
        createElement(RunHistoryList, {
          history: { ...listFixture(), totalCount: 11 },
        }),
      ),
    ).toContain("11 runs");

    const outOfRange = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: { ...listFixture(), summaries: [], page: 3, totalCount: 11 },
      }),
    );
    expect(outOfRange).toContain("Page 3 does not exist");
    expect(outOfRange).toContain("View page 1");
    expect(outOfRange).toContain("min-h-11");
    expect(outOfRange).not.toContain("summaries");
  });

  it("links only to pagination pages within the available bounds", () => {
    const firstPage = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: { ...listFixture(), totalCount: 25 },
      }),
    );
    expect(firstPage).toMatch(/href="\/run-history\?page=2"[^>]*>Next<\/a>/);
    expect(firstPage).not.toContain(">Previous</");

    const secondPage = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: { ...listFixture(), page: 2, totalCount: 25 },
      }),
    );
    expect(secondPage).toMatch(/href="\/run-history\?page=1"[^>]*>Previous<\/a>/);
    expect(secondPage).toMatch(/href="\/run-history\?page=3"[^>]*>Next<\/a>/);

    const lastPage = renderToStaticMarkup(
      createElement(RunHistoryList, {
        history: { ...listFixture(), page: 3, totalCount: 25 },
      }),
    );
    expect(lastPage).toMatch(/href="\/run-history\?page=2"[^>]*>Previous<\/a>/);
    expect(lastPage).not.toContain(">Next</");
  });

  it("renders the complete public report and hides clean zero-noise", () => {
    const markup = renderToStaticMarkup(
      createElement(PublicRunHistoryDetail, { detail: detailFixture() }),
    );

    expect(markup).toContain("Scenario settings");
    expect(markup).toContain("Traffic");
    expect(markup).toContain("Inventory");
    expect(markup).toContain("Simulated ERP");
    expect(markup).toContain("Backpressure");
    expect(markup).toContain("Evidence and reconciliation proof");
    expect(markup).toContain("Signals");
    expect(markup).toContain("Delivery and measurements");
    expect(markup).toContain("Checkout response p95 (client-observed)");
    expect(markup).toContain("Reservation processing p95 bound");
    expect(markup).toContain("Simulated ERP call p95");
    expect(markup).toContain("Reservation-to-confirmation p95");
    expect(markup).toContain("Checkout dispatch duration (observed)");
    expect(markup).toContain("Configured maximum dispatch time");
    expect(markup).toMatch(/Configured start delay<\/dt><dd[^>]*>0 ms<\/dd>/);
    expect(markup).toMatch(/Request timeout \(configured safety limit\)<\/dt><dd[^>]*>2 s<\/dd>/);
    expect(markup).toMatch(/Retry attempts \(configured limit\)<\/dt><dd[^>]*>4<\/dd>/);
    expect(markup).toMatch(/Initial retry backoff<\/dt><dd[^>]*>500 ms<\/dd>/);
    expect(markup).toMatch(/Circuit-breaker failure threshold<\/dt><dd[^>]*>5<\/dd>/);
    expect(markup).toMatch(/Circuit-breaker reset timeout<\/dt><dd[^>]*>10 s<\/dd>/);
    expect(markup).toContain("Logical queue");
    expect(markup).toContain("orders:process");
    expect(markup).toContain("Physical queue");
    expect(markup).toContain("orders-process");
    expect(markup).toContain("Traffic delivery: All planned attempts dispatched");
    const document = new DOMParser().parseFromString(markup, "text/html");
    const deliveryPill = [...document.querySelectorAll("span")].find((element) =>
      element.textContent?.includes("Traffic delivery: All planned attempts dispatched"),
    );
    expect(deliveryPill).toBeDefined();
    expect([...(deliveryPill?.classList ?? [])]).not.toContain("whitespace-nowrap");
    expect(markup).toContain("Lifecycle and reference");
    expect(markup).toContain("Run ended");
    expect(markup).toContain('id="report-advanced-scenario"');
    expect(markup).toContain('id="report-advanced-signals"');
    expect(markup).toContain('id="report-advanced-consistency"');
    expect(markup).toContain('id="report-advanced-measurements"');
    expect(markup).toContain('id="report-advanced-lifecycle"');
    expect(markup.match(/55555555-5555-4555-8555-555555555555/g)).toHaveLength(1);
    expect(markup).not.toContain("Failed attempts");
    expect(markup).not.toContain("Timed-out attempts");
    expect(markup).not.toContain("Generator received no reply");
    expect(markup).not.toContain("Replies not recorded");
    expect(markup).not.toContain("Never dispatched");
    expect(markup).not.toContain(">Unexpected<");
    expect(markup).not.toContain("Events");
    expect(markup).not.toContain("source");
    expect(markup).not.toContain("saleOffer");
    expect(markup).not.toMatch(/finalization|finalized/i);

    const sectionOrder = [
      "report-advanced-signals",
      "report-advanced-consistency",
      "report-advanced-scenario",
      "report-advanced-measurements",
      "report-advanced-lifecycle",
    ].map((id) => markup.indexOf(`id="${id}"`));
    expect(sectionOrder).toEqual([...sectionOrder].sort((left, right) => left - right));
    expect(markup.indexOf('aria-label="Report actions"')).toBeGreaterThan(sectionOrder.at(-1) ?? 0);
    expect(markup).toContain('href="#main-content"');
  });

  it("promotes sanitized failure guidance and nonzero ERP failures", () => {
    const detail = detailFixture("failed");
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toContain("What happened");
    expect(markup).toContain("load generator could not deliver");
    expect(markup).toContain("Start a new run");
    expect(markup).toContain("Failed attempts");
    expect(markup).toContain("Traffic delivery: Delivery failed");
    expect(markup).not.toContain("load_orchestrator_unavailable");

    detail.summary.failureCategory = "reconciliation";
    detail.result = deriveRunResult({
      ...resultEvidence(detail),
      generator: {
        transportAttemptCounts: detail.summary.transportAttemptCounts,
        httpSummary: detail.summary.httpSummary,
      },
    });
    const reconciliationMarkup = renderToStaticMarkup(
      createElement(PublicRunHistoryDetail, { detail }),
    );
    expect(reconciliationMarkup).toContain(
      "The final counts did not agree, so the result could not be verified",
    );
    expect(reconciliationMarkup).not.toMatch(/finalization|finalized/i);
  });

  it("renders nonzero delivery exceptions while keeping routine zero rows hidden", () => {
    const detail = detailFixture("failed");
    detail.summary.transportAttemptCounts = {
      plannedRequests: 21,
      startedRequests: 20,
      completedRequests: 19,
      interruptedRequests: 1,
      unstartedRequests: 1,
    };
    detail.summary.httpSummary = {
      ...detail.summary.httpSummary,
      failedRequests: 3,
      transportFailures: 2,
      unexpectedResponses: 1,
    };
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toContain("Generator received no reply");
    expect(markup).toContain("Replies not recorded");
    expect(markup).toContain("Never dispatched");
    expect(markup).toContain(">Unexpected<");
  });

  it("renders every explicit constant-arrival configuration value", () => {
    const detail = detailFixture();
    detail.run.configSnapshot.trafficConfig = {
      mode: "constant-arrival-rate",
      ratePerSecond: 25,
      startDelaySeconds: 3,
      durationSeconds: 8,
      quantityPerAttempt: 2,
      k6Vus: { preAllocatedVus: 30, maxVus: 60 },
    };
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toContain("Configured arrival rate (per second)");
    expect(markup).toContain("Configured traffic duration");
    expect(markup).toContain("Pre-allocated k6 VUs");
    expect(markup).toContain(">30<");
    expect(markup).toContain("Maximum k6 VUs");
    expect(markup).toContain(">60<");
  });

  it("renders all four delivery summary values and preserves missing measurements", () => {
    const detail = detailFixture();
    detail.summary.serverReservationTimingSummary = {
      ...detail.summary.serverReservationTimingSummary,
      redisAtomicReservation: {
        ...detail.summary.serverReservationTimingSummary.redisAtomicReservation,
        p95Ms: 5,
      },
    };
    const { container, unmount } = render(createElement(PublicRunHistoryDetail, { detail }));
    const summaryRows = container.querySelector("[data-delivery-summary]");

    expect([...(summaryRows?.children ?? [])].map((row) => row.textContent)).toEqual([
      "100%Delivery coverageof dispatched attempts",
      "≤ 5msObserved reservation p95bounded p95 estimate",
      "42 msCheckout response p95 (client-observed)",
      "n/aReservation-to-confirmation p95",
    ]);

    unmount();
    const missingDetail = detailFixture();
    delete missingDetail.summary.httpSummary.p95LatencyMs;
    const missing = render(createElement(PublicRunHistoryDetail, { detail: missingDetail }));
    expect(
      [...(missing.container.querySelector("[data-delivery-summary]")?.children ?? [])].map(
        (row) => row.textContent,
      ),
    ).toEqual([
      "100%Delivery coverageof dispatched attempts",
      "n/aObserved reservation p95bounded p95 estimate",
      "n/aCheckout response p95 (client-observed)",
      "n/aReservation-to-confirmation p95",
    ]);
  });

  it("keeps accepted-config demand distinct from mismatched generator evidence", () => {
    const detail = detailFixture();
    detail.plannedAttempts = 10;
    detail.summary.transportAttemptCounts = {
      plannedRequests: 99,
      startedRequests: 20,
      completedRequests: 20,
      interruptedRequests: 0,
      unstartedRequests: 79,
    };
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toMatch(/Planned demand<\/dt><dd[^>]*>10<\/dd>/);
    expect(markup).toMatch(/Planned attempts<\/dt><dd[^>]*>99<\/dd>/);
  });

  it("keeps the complete report visible", () => {
    const detail = detailFixture();
    const { container } = render(publicReport(detail));

    expect(screen.getByText("Completed").closest("[hidden]")).toBeNull();
    expect(screen.getByText("Orders confirmed").closest("[hidden]")).toBeNull();
    expect(
      screen.getByText(/10 units reserved \/ 10 unique reservations/).closest("[hidden]"),
    ).toBeNull();
    expect(screen.getByText("Scenario settings").closest("[hidden]")).toBeNull();
    expect(screen.getByText("Run UUID").closest("details")?.open).toBe(false);
    expect(
      screen.getByText("reserved units = starting stock − remaining stock").closest("[hidden]"),
    ).toBeNull();
    expect(container.querySelector("#report-advanced-signals")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector("#report-advanced-measurements")?.textContent).toContain(
      "Observed reservation p95",
    );
    expect(
      container.querySelector<HTMLDetailsElement>("#report-advanced-measurements details")?.open,
    ).toBe(false);
    expect(
      screen.getByText(/Final timeline evidence was not recorded/).closest("[hidden]"),
    ).toBeNull();
    expect(screen.getByText("Final stock and orders").closest("[hidden]")).toBeNull();
  });

  it("reveals measurements for incomplete replies", () => {
    const detail = detailFixture();
    detail.summary.transportAttemptCounts = {
      plannedRequests: 20,
      startedRequests: 20,
      completedRequests: 20,
      interruptedRequests: 0,
      unstartedRequests: 0,
    };
    detail.summary.httpSummary = {
      ...detail.summary.httpSummary,
      failedRequests: 3,
      transportFailures: 3,
    };
    const { container } = render(publicReport(detail));
    const target = container.querySelector<HTMLElement>("#report-advanced-measurements");
    const disclosure = target?.querySelector<HTMLDetailsElement>("details");
    const caveat = target?.querySelector("[data-measurement-caveat]");

    expect(screen.getByText(/Reply observation incomplete/).closest("[hidden]")).toBeNull();
    expect(caveat?.textContent).toContain(
      "Checkout response p95 (client-observed) covers only the 17 of 20 planned attempts",
    );
    expect(caveat?.textContent).toContain(
      "Server-observed reservation timing and durable reservation-to-confirmation timing use separate evidence.",
    );
    expect(caveat?.textContent).not.toContain("The p95 describes replies received only");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByRole("link", { name: "View technical measurements" }));

    expect(disclosure?.open).toBe(true);
    expect(document.activeElement).toBe(target);

    fireEvent.click(screen.getByRole("link", { name: "View technical measurements" }));
    expect(disclosure?.open).toBe(true);
  });

  it("keeps operator-stop guidance and unknown cleanup qualification beside the result", () => {
    const detail = detailFixture("failed");
    detail.summary.failureCategory = "operator";
    detail.result = deriveRunResult({
      ...resultEvidence(detail),
      generator: {
        transportAttemptCounts: detail.summary.transportAttemptCounts,
        httpSummary: detail.summary.httpSummary,
      },
    });
    delete detail.run.adminResetCompletedAt;
    delete detail.run.trafficStartedAt;
    delete detail.run.trafficEndedAt;
    detail.run.configSnapshot.trafficConfig = {
      mode: "constant-arrival-rate",
      ratePerSecond: 25,
      startDelaySeconds: 0,
      durationSeconds: 1,
      quantityPerAttempt: 1,
    };
    const { container } = render(publicReport(detail));
    const recap = screen.getByRole("heading", { name: "What happened" }).closest("section");

    expect(screen.getByText(/stopped by an operator/).closest("[hidden]")).toBeNull();
    expect(
      screen.getByText(/reporting or cleanup may be incomplete/).closest("[hidden]"),
    ).toBeNull();
    expect(recap?.textContent).toContain("Checkout attempts start and end were not recorded.");
    expect(recap?.textContent).not.toContain("arrived");
    expect(recap?.textContent).not.toContain("Buyer traffic");
    expect(recap?.textContent).toContain(
      "10 units reserved / 10 unique reservations; 10 attempts turned away because stock ran out.",
    );
    expect(recap?.textContent).toContain("Operator stop decision: 00:00:10 UTC.");
    expect(
      container.querySelector<HTMLDetailsElement>("#report-advanced-lifecycle details")?.open,
    ).toBe(false);
  });

  it("keeps durable comparison facts visible when final inventory was not recorded", () => {
    const detail = detailFixture();
    const { terminalInventorySnapshot: _terminalInventorySnapshot, ...summary } = detail.summary;
    detail.summary = summary;
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toContain("starting stock</dt><dd");
    expect(markup).toContain(">not recorded</dd>");
    expect(markup).toContain("Unique reservations secured");
    expect(markup).toContain("sold-out rejections recorded by Checkout-Surge");
    expect(markup).toContain("Confirmed orders");
    expect(markup).toContain("Failed orders");
    expect(markup).toContain(">0</dd>");
  });

  it("marks partial generator evidence visibly outside the reconciliation disclosure", () => {
    const detail = detailFixture();
    detail.summary.transportAttemptCounts = {
      plannedRequests: 20,
      startedRequests: 19,
      completedRequests: 19,
      interruptedRequests: 0,
      unstartedRequests: 1,
    };
    detail.result = deriveRunResult({
      ...resultEvidence(detail),
      generator: {
        transportAttemptCounts: detail.summary.transportAttemptCounts,
        httpSummary: detail.summary.httpSummary,
      },
    });
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toMatch(
      /role="status"[^>]*>Evidence incomplete: planned checkout attempts and checkout responses completed by the load generator require reconciliation\./,
    );
    expect(markup).toContain("border-warning bg-warning-soft");
    expect(markup).toContain("Only attempts that reached a response are included");
  });

  it("shows a sanitized visible warning for unexplained population disagreement", () => {
    const detail = detailFixture();
    detail.summary.httpSummary = {
      ...detail.summary.httpSummary,
      acceptedResponses: 9,
      soldOutResponses: 10,
    };
    detail.result = deriveRunResult({
      ...resultEvidence(detail),
      generator: {
        transportAttemptCounts: detail.summary.transportAttemptCounts,
        httpSummary: detail.summary.httpSummary,
      },
    });
    const markup = renderToStaticMarkup(createElement(PublicRunHistoryDetail, { detail }));

    expect(markup).toMatch(/role="status"[^>]*>Reconciliation warning:/);
    expect(markup).toContain("border-warning bg-warning-soft");
    expect(markup).toContain("accepted responses observed by the load generator");
    expect(markup).toContain("Unique reservations secured");
    expect(markup).not.toContain("private");
  });

  it("uses the scenario headline and authoritative result on the public route", async () => {
    getRunHistoryDetail.mockResolvedValue({ status: "available", data: detailFixture() });

    const page = await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("<h1");
    expect(markup).toContain("Preview 1k</h1>");
    expect(markup).toContain("Everyone at once · 1,000 buyers · 250 starting units");
    expect(markup).toContain("This is a simulation of buyers competing for limited stock");
    expect(markup).not.toContain("Saved run report for a checkout simulation.");
    expect(markup).toContain("All 10 available units were reserved without overselling.");
    expect(markup).toContain("Completed");
    expect(markup).toContain("2026-06-20 00:00:00 UTC");
    expect(markup).not.toContain("Run history detail");
    expect(markup).not.toContain(">available<");
    expect(getRunHistoryDetail).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555");
    expect(getAdminRunHistoryDetail).not.toHaveBeenCalled();
  });

  it("renders the exact order-failure outcome badge and conclusion on the public route", async () => {
    const detail = detailFixture();
    detail.summary.businessOutcomeSummary = {
      ...detail.summary.businessOutcomeSummary,
      confirmedOrders: 8,
      failedOrders: 2,
      notificationsRecorded: 8,
    };
    detail.result = deriveRunResult({
      ...resultEvidence(detail),
      generator: {
        transportAttemptCounts: detail.summary.transportAttemptCounts,
        httpSummary: detail.summary.httpSummary,
      },
    });
    getRunHistoryDetail.mockResolvedValue({ status: "available", data: detail });

    const markup = renderToStaticMarkup(
      await RunHistoryDetailPage({
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      }),
    );

    expect(markup).toContain('aria-hidden="true">!</span>Completed with order failures</span>');
    expect(markup).toContain("8 orders were confirmed, 2 failed, and 0 remain pending.");
  });

  it("renders the exact indeterminate outcome badge and conclusion on the public route", async () => {
    const detail = detailFixture();
    const { terminalInventorySnapshot: _terminalInventorySnapshot, ...summary } = detail.summary;
    detail.summary = summary;
    detail.result = deriveRunResult({
      ...resultEvidence(detail),
      generator: {
        transportAttemptCounts: detail.summary.transportAttemptCounts,
        httpSummary: detail.summary.httpSummary,
      },
    });
    getRunHistoryDetail.mockResolvedValue({ status: "available", data: detail });

    const markup = renderToStaticMarkup(
      await RunHistoryDetailPage({
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      }),
    );

    expect(markup).toContain('aria-hidden="true">•</span>Result not fully verified</span>');
    expect(markup).toContain(
      "The run outcome is indeterminate because authoritative evidence is incomplete.",
    );
  });

  it("maps malformed and confirmed-absent public runs to Next notFound", async () => {
    await expect(
      RunHistoryDetailPage({ params: Promise.resolve({ runId: "bad" }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getRunHistoryDetail).not.toHaveBeenCalled();

    getRunHistoryDetail.mockResolvedValue({
      status: "unavailable",
      httpStatus: 404,
      errorCode: "resource_not_found",
    });
    await expect(
      RunHistoryDetailPage({
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("maps a confirmed-absent admin run to Next notFound without a public read", async () => {
    hasValidAdminPageSession.mockResolvedValue(true);
    getAdminRunHistoryDetail.mockResolvedValue({
      status: "unavailable",
      httpStatus: 404,
      errorCode: "resource_not_found",
    });

    await expect(
      RunHistoryDetailPage({
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(getAdminRunHistoryDetail).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", {
      limit: 20,
    });
    expect(getRunHistoryDetail).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", { status: "unavailable", reason: "request timed out" }],
    [
      "503",
      {
        status: "unavailable",
        httpStatus: 503,
        errorCode: "dependency_unavailable",
        correlationId: "public-history-correlation",
        reason: "private public-reader diagnostic",
      },
    ],
    [
      "malformed response",
      {
        status: "unavailable",
        httpStatus: 404,
        reason: "invalid backend error response",
      },
    ],
  ])("keeps %s reads on the unavailable branch", async (_case, read) => {
    getRunHistoryDetail.mockResolvedValue(read);
    const page = await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("This report is not available");
    expect(markup).toContain("We could not load a saved report from this link");
    expect(markup).toContain('href="/run-history"');
    expect(markup).toContain('href="/demo"');
    expect(markup).not.toContain("55555555-5555-4555-8555-555555555555");
    expect(markup).not.toContain("public-history-correlation");
    expect(markup).not.toContain("private public-reader diagnostic");
    expect(markup).not.toContain("Technical details");
    expect(notFound).not.toHaveBeenCalled();
    expect(getAdminRunHistoryDetail).not.toHaveBeenCalled();
  });

  it("uses only the admin reader for a validated session and preserves protected diagnostics", async () => {
    hasValidAdminPageSession.mockResolvedValue(true);
    getAdminRunHistoryDetail.mockResolvedValue({
      status: "unavailable",
      httpStatus: 503,
      errorCode: "dependency_unavailable",
      correlationId: "admin-history-correlation",
      reason: "protected admin-reader diagnostic",
    });

    const page = await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(getAdminRunHistoryDetail).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", {
      limit: 20,
    });
    expect(getRunHistoryDetail).not.toHaveBeenCalled();
    expect(markup).toContain("Technical details");
    expect(markup).toContain("admin-history-correlation");
    expect(markup).toContain("protected admin-reader diagnostic");
  });

  it("renders bounded row-level diagnostics for an available admin detail", async () => {
    hasValidAdminPageSession.mockResolvedValue(true);
    getAdminRunHistoryDetail.mockResolvedValue({
      status: "available",
      data: adminDetailFixture(),
    });

    const page = await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(markup).toContain("Order outcomes");
    expect(markup).toContain("ord_history_1");
    expect(markup).toContain("corr-history-detail");
    expect(markup).toContain("ERP attempts");
    expect(markup).toContain("Event timeline");
    expect(markup).toContain("worker");
    expect(markup).toContain("1 total");
    expect(markup).toContain("Exception summary");
    expect(markup).toContain("<table");
    expect(markup).toContain("Technical detail");
    expect(markup).toContain('<caption class="sr-only">Order outcomes</caption>');
    expect(markup).toContain('<caption class="sr-only">ERP attempts</caption>');
    expect(markup).toContain('<caption class="sr-only">simulated emails recorded</caption>');
    expect(markup).toContain('<caption class="sr-only">Event timeline</caption>');
    expect(markup).toContain('scope="row"');
    const document = new DOMParser().parseFromString(markup, "text/html");

    for (const accessibleName of [
      "Order outcomes",
      "ERP attempts",
      "simulated emails recorded",
      "Event timeline",
    ]) {
      const region = document.querySelector(`[role="region"][aria-label="${accessibleName}"]`);

      expect(region).not.toBeNull();
      expect([...(region?.classList ?? [])]).toEqual(
        expect.arrayContaining(["w-full", "min-w-0", "max-w-full", "overflow-x-auto"]),
      );
      expect([...(region?.parentElement?.classList ?? [])]).toEqual(
        expect.arrayContaining(["min-w-0", "max-w-full"]),
      );
      expect([...(region?.closest("section.rounded-lg")?.classList ?? [])]).toEqual(
        expect.arrayContaining(["min-w-0", "max-w-full"]),
      );
    }
    expect(markup).toContain("Scrolls sideways.");
    expect(markup).toContain('scope="col"');
    expect(markup).toContain('aria-label="Technical detail for order ord_history_1"');
    expect(markup).toContain(
      'aria-label="Technical detail for ERP attempt 99999999-9999-4999-8999-999999999992"',
    );
    expect(markup).toContain(
      'aria-label="Technical detail for notification 99999999-9999-4999-8999-999999999993"',
    );
    expect(markup).toContain(
      'aria-label="Technical detail for event 99999999-9999-4999-8999-999999999994"',
    );
    expect(markup).toContain("Terminal inventory");
    expect(markup).toContain("sold-out rejections recorded by Checkout-Surge");
    expect(markup).toContain("Pending persistence");
    expect(markup).toContain("Simulated ERP call average");
    expect(markup).toContain("<code>orders:process</code>");
    expect(markup).toContain("<code>orders-process</code>");
    expect(markup).toContain("<code>accepted_responses_vs_unique_reservations</code>");
    expect(markup).not.toContain("expected population difference");
    expect(markup).not.toContain("Failure none");
    expect(markup).not.toContain("Error none");
    expect(markup).toContain("0 warnings · complete");
    expect(markup).toMatch(/<h1[^>]*>Preview 1k<\/h1>/);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    // Static markup verifies the responsive stacking contract, not browser geometry.
    expect(markup).toContain("min-[900px]:sticky min-[900px]:top-16 min-[900px]:z-[5]");
    expect(markup).not.toContain('aria-label="Select run 55555555-5555-4555-8555-555555555555"');
    expect(markup).toContain(
      'aria-label="Delete run Preview 1k (55555555-5555-4555-8555-555555555555)"',
    );
  });

  it("sends the run-scoped search through the protected API reader", async () => {
    hasValidAdminPageSession.mockResolvedValue(true);
    getAdminRunHistoryDetail.mockResolvedValue({
      status: "available",
      data: adminDetailFixture(),
    });

    await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      searchParams: Promise.resolve({
        filterKind: "publicOrderId",
        filterValue: "ord_history_1",
        limit: "10",
      }),
    });

    expect(getAdminRunHistoryDetail).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", {
      filter: { kind: "publicOrderId", value: "ord_history_1" },
      limit: 10,
    });
    expect(getRunHistoryDetail).not.toHaveBeenCalled();
  });

  it("falls back to unfiltered detail and discloses invalid search parameters", async () => {
    hasValidAdminPageSession.mockResolvedValue(true);
    getAdminRunHistoryDetail.mockResolvedValue({
      status: "available",
      data: adminDetailFixture(),
    });

    const page = await RunHistoryDetailPage({
      params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      searchParams: Promise.resolve({ cursor: "bad" }),
    });
    const markup = renderToStaticMarkup(page);

    expect(getAdminRunHistoryDetail).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", {
      limit: 20,
    });
    expect(markup).toContain("Invalid search parameters. Showing the unfiltered run detail.");
  });

  it("renders exception classification and delivery tones without understating severity", () => {
    const clean = adminDetailFixture();
    clean.exceptionSummary.generatorWarnings = 0;
    const cleanMarkup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: clean }),
    );
    expect(cleanMarkup).toContain("Clean run · no exceptions require attention.");
    expect(cleanMarkup).toContain("text-accent");

    const incomplete = adminDetailFixture();
    incomplete.exceptionSummary.generatorWarnings = 0;
    incomplete.exceptionSummary.maximumClassification = "evidence_incomplete";
    const incompleteMarkup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: incomplete }),
    );
    expect(incompleteMarkup).toContain("Evidence incomplete");
    expect(incompleteMarkup).toContain("text-warning");
    expect(incompleteMarkup).not.toContain("Clean run");

    const failed = adminDetailFixture();
    failed.exceptionSummary.maximumClassification = "correctness_failure";
    failed.exceptionSummary.brokenInvariants = 1;
    const failedMarkup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: failed }),
    );
    expect(failedMarkup).toContain("Correctness failure");
    expect(failedMarkup).toContain("border-danger bg-danger-soft");
    expect(failedMarkup).toContain("text-danger");

    const failedLifecycle = adminDetailFixture();
    failedLifecycle.summary.status = "failed";
    failedLifecycle.run.status = "failed";
    failedLifecycle.exceptionSummary.maximumClassification = "expected_population_difference";
    failedLifecycle.exceptionSummary.generatorWarnings = 0;
    const failedLifecycleMarkup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: failedLifecycle }),
    );
    expect(failedLifecycleMarkup).toContain("Run failed");
    expect(failedLifecycleMarkup).toContain("border-danger bg-danger-soft");
    expect(failedLifecycleMarkup).toContain("text-danger");
    expect(failedLifecycleMarkup).not.toContain("Clean run");

    for (const status of ["warning", "degraded"] as const) {
      const detail = adminDetailFixture();
      detail.summary.trafficDeliverySummary.trafficDeliveryStatus = status;
      detail.exceptionSummary.partialDelivery = 1;
      const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));
      expect(markup).toContain(`Delivery ${status}`);
      expect(markup).toContain("bg-warning-soft text-warning");
      expect(markup).not.toContain(`✓ Delivery ${status}`);
    }
  });

  it("presents instrumentation and collection limits without escalating the exception panel", () => {
    const detail = adminDetailFixture();
    detail.orders.totalCount = 240;
    detail.orders.matchedCount = 240;
    detail.orders.truncated = true;
    detail.exceptionSummary.truncatedCollections = 1;

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));
    const document = new DOMParser().parseFromString(markup, "text/html");
    const exceptionSummary = document.querySelector('[aria-label="Exception summary"]');

    expect(exceptionSummary?.classList).toContain("border-border");
    expect(exceptionSummary?.classList).toContain("bg-surface");
    expect(exceptionSummary?.classList).not.toContain("border-warning");
    expect(exceptionSummary?.textContent).toContain("Clean run · no exceptions require attention.");
    expect(exceptionSummary?.textContent).toContain("Instrumentation limitations: 1");
    expect(exceptionSummary?.textContent).toContain("Display-limited collections: 1");
    expect(markup).toContain("240 total · 0 warnings · showing newest 1 of 240");
  });

  it("labels a failed attempt with retries remaining without failure or evidence-loss styling", () => {
    const detail = adminDetailFixture();
    const successfulAttempt = detail.erpAttempts.records[0];
    if (!successfulAttempt) throw new Error("Expected an ERP attempt fixture.");
    detail.exceptionSummary.generatorWarnings = 0;
    detail.erpAttempts.totalCount = 2;
    detail.erpAttempts.matchedCount = 2;
    detail.erpAttempts.records = [
      {
        ...successfulAttempt,
        attemptId: "99999999-9999-4999-8999-999999999990",
        attemptNumber: 1,
        status: "failed",
        terminal: false,
        httpStatus: 503,
        errorCode: "erp_unavailable",
      },
      { ...successfulAttempt, attemptNumber: 2 },
    ];

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));
    const document = new DOMParser().parseFromString(markup, "text/html");
    const retryStatus = [...document.querySelectorAll("span")].find((element) =>
      element.textContent?.includes("failed · retry scheduled"),
    );

    expect(retryStatus).toBeDefined();
    expect(retryStatus?.classList).not.toContain("text-danger");
    expect(markup).not.toContain("missing terminal evidence");
    expect(markup).not.toContain("Missing terminal evidence");
    expect(markup).toContain("2 total · 0 warnings · complete view");
  });

  it("surfaces failed and pending order evidence alongside neutral display limits", () => {
    const detail = adminDetailFixture();
    detail.orders = {
      totalCount: 25,
      matchedCount: 25,
      warningCount: 1,
      limit: 20,
      truncated: true,
      records: [
        {
          orderId: "99999999-9999-4999-8999-999999999995",
          publicOrderId: "ord_failed",
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlationId: "corr-failed",
          quantity: 1,
          status: "failed",
          queuedAt: "2026-06-20T00:00:02.000Z",
          failedAt: "2026-06-20T00:00:06.000Z",
          failureCode: "erp_rejected",
        },
        {
          orderId: "99999999-9999-4999-8999-999999999996",
          publicOrderId: "ord_pending",
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlationId: "corr-pending",
          quantity: 1,
          status: "queued",
          queuedAt: "2026-06-20T00:00:09.000Z",
        },
      ],
    };
    detail.exceptionSummary.failedOrders = 1;
    detail.exceptionSummary.pendingWork = 1;
    detail.exceptionSummary.truncatedCollections = 1;
    const terminalAttempt = detail.erpAttempts.records[0];
    if (!terminalAttempt) throw new Error("Expected an ERP attempt fixture.");
    terminalAttempt.status = "failed";
    terminalAttempt.terminal = true;
    terminalAttempt.errorCode = "erp_rejected";
    detail.erpAttempts.warningCount = 1;

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));
    const document = new DOMParser().parseFromString(markup, "text/html");
    const terminalFailure = [...document.querySelectorAll("span")].find((element) =>
      element.textContent?.includes("failed · erp_rejected"),
    );

    expect(markup).toContain("ord_failed");
    expect(markup).toContain("<code>erp_rejected</code>");
    expect(markup).toContain("2026-06-20 00:00:06 UTC");
    expect(markup).toContain("ord_pending");
    expect(markup).toContain("Missing terminal evidence");
    expect(terminalFailure?.classList).toContain("text-danger");
    expect(markup).toContain("25 total · 1 warnings · showing newest 2 of 25");
  });

  it("renders API-filtered results as a deterministic chronological trace", () => {
    const detail = adminDetailFixture();
    detail.query = {
      filter: { kind: "correlationId", value: "corr-history-detail" },
      limit: 20,
    };
    const timestamp = "2026-06-20T00:00:07.000Z";
    const order = detail.orders.records[0];
    const attempt = detail.erpAttempts.records[0];
    const notification = detail.notifications.records[0];
    const event = detail.eventTimeline.records[0];
    if (!order || !attempt || !notification || !event) throw new Error("Expected trace fixtures.");
    order.confirmedAt = timestamp;
    attempt.finishedAt = timestamp;
    notification.recordedAt = timestamp;
    event.occurredAt = timestamp;
    detail.eventTimeline.records.push({
      ...event,
      eventId: "99999999-9999-4999-8999-999999999990",
    });
    detail.eventTimeline.matchedCount = 2;
    const earlierTimestamp = "2026-06-20T00:00:06.000Z";
    notification.recordedAt = earlierTimestamp;

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));
    const trace = buildRunHistoryTrace(detail);

    expect(markup).toContain(
      "5 record matches across all collections for correlationId “corr-history-detail”.",
    );
    expect(markup).toContain("Chronological trace");
    expect(trace.map((entry) => entry.id)).toEqual([
      notification.notificationId,
      order.orderId,
      attempt.attemptId,
      "99999999-9999-4999-8999-999999999990",
      event.eventId,
    ]);
    expect(markup).toContain("<code>2026-06-20T00:00:07.000Z</code>");
    expect(markup).toContain("<code>2026-06-20T00:00:06.000Z</code>");
  });

  it("renders an explicit no-match state for an API filter", () => {
    const detail = adminDetailFixture();
    detail.query = {
      filter: { kind: "publicOrderId", value: "ord_missing" },
      limit: 20,
    };
    detail.orders.matchedCount = 0;
    detail.orders.records = [];
    detail.erpAttempts.matchedCount = 0;
    detail.erpAttempts.records = [];
    detail.notifications.matchedCount = 0;
    detail.notifications.records = [];
    detail.eventTimeline.matchedCount = 0;
    detail.eventTimeline.records = [];

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));

    expect(markup).toContain("No records matched publicOrderId “ord_missing” in this run.");
    expect(markup).toContain("No records matched this search in order outcomes.");
    expect(markup).toContain("No records matched this search in ERP attempts.");
    expect(markup).toContain("No records matched this search in simulated notifications.");
    expect(markup).toContain("No records matched this search in the event timeline.");
    expect(markup).not.toContain("Chronological trace");
  });

  it("discloses truncation for filtered results", () => {
    const detail = adminDetailFixture();
    detail.query = {
      filter: { kind: "orderId", value: "99999999-9999-4999-8999-999999999991" },
      limit: 1,
    };
    detail.orders.totalCount = 2;
    detail.orders.matchedCount = 2;
    detail.orders.limit = 1;
    detail.orders.truncated = true;
    detail.orders.nextCursor = "c1";

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));

    expect(markup).toContain("Some matching collections are display-limited on this page.");
    expect(markup).toContain("2 matches of 2 total");
    expect(markup).toContain("showing newest 1 of 2");
  });

  it("labels an empty cursor page as display-limited filtered evidence", () => {
    const detail = adminDetailFixture();
    detail.query = {
      filter: { kind: "publicOrderId", value: "ord_history_1" },
      limit: 1,
      cursor: "c100",
    };
    for (const collection of [
      detail.orders,
      detail.erpAttempts,
      detail.notifications,
      detail.eventTimeline,
    ]) {
      collection.records = [];
      collection.limit = 1;
      collection.truncated = true;
    }

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));

    expect(markup).toContain("Some matching collections are display-limited on this page.");
    expect(markup).toContain("1 matches of 1 total");
    expect(markup).toContain("showing 0 of 1 on this page");
    expect(markup).toContain("No matching records are included on this page in order outcomes.");
  });

  it("labels an unfiltered cursor page without claiming newest or search results", () => {
    const detail = adminDetailFixture();
    detail.query = { limit: 20, cursor: "c100" };
    for (const collection of [
      detail.orders,
      detail.erpAttempts,
      detail.notifications,
      detail.eventTimeline,
    ]) {
      collection.records = [];
      collection.truncated = true;
    }

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));

    expect(markup).toContain("Showing up to 20 records per collection for this page.");
    expect(markup).toContain(
      "No records are included on this page in order outcomes; the page may be beyond the recorded set.",
    );
    expect(markup).toContain("showing 0 of 1 on this page");
    expect(markup).not.toContain("Showing the newest");
    expect(markup).not.toContain("No records matched this search");
  });

  it("includes the public failure explanation and recovery action for admins", () => {
    const publicDetail = detailFixture("failed");
    const detail = adminDetailFixture();
    detail.summary = {
      ...detail.summary,
      status: "failed",
      failureCategory: publicDetail.summary.failureCategory,
    };
    detail.run.status = "failed";
    detail.run.trafficStatus = "failed";
    detail.internalFailureReason = "traffic_failed";

    const markup = renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail }));

    expect(markup).toContain("What happened");
    expect(markup).toContain(
      "The load generator could not deliver the planned traffic, so this run&#x27;s evidence is incomplete.",
    );
    expect(markup).toContain("Start a new run to try again.");
  });
});

describe("run-history cross-route time and duration presentation", () => {
  beforeEach(() => {
    getRunHistoryDetail.mockReset();
    getAdminRunHistoryDetail.mockReset();
    hasValidAdminPageSession.mockResolvedValue(false);
    notFound.mockClear();
  });

  it("keeps the same absolute UTC instant and human duration across current shapes", async () => {
    const detail = detailFixture();
    getRunHistoryDetail.mockResolvedValue({ status: "available", data: detail });
    const markups = [
      renderToStaticMarkup(createElement(RunHistoryList, { history: listFixture() })),
      renderToStaticMarkup(
        await RunHistoryDetailPage({
          params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
        }),
      ),
      renderToStaticMarkup(createElement(AdminRunHistoryDetail, { detail: adminDetailFixture() })),
    ];

    for (const markup of markups) {
      expect(markup).toContain("2026-06-20 00:00:00 UTC");
      expect(markup).toContain('dateTime="2026-06-20T00:00:00.000Z"');
      expect(markup).not.toContain("Jun 20, 2026");
      expect(markup).not.toContain("AM UTC");
      expect(markup).not.toContain("PM UTC");
      const container = document.createElement("div");
      container.innerHTML = markup;
      expect(container.textContent).not.toMatch(/\b\d{2}:\d{2}:\d{2}(?! UTC)/);
    }
    expect(markups[0]).toMatch(/Overall duration<\/p><p[^>]*>10 s<\/p>/);
    expect(markups[1]).toMatch(
      /dateTime="2026-06-20T00:00:00.000Z">2026-06-20 00:00:00 UTC<\/time> · Overall duration: 10 s<\/p>/,
    );
    expect(markups[2]).toMatch(/Overall run duration<\/dt><dd[^>]*>10 s<\/dd>/);
  });

  it("renders explicit unavailable duration copy when summary start evidence is missing", async () => {
    const history = listFixture();
    const item = history.summaries[0];
    if (!item) throw new Error("Expected run history list fixture.");
    item.overallDurationMs = null;

    const publicDetail = detailFixture();
    const { startedAt: _startedAt, ...publicSummary } = publicDetail.summary;
    publicDetail.summary = publicSummary;
    publicDetail.overallDurationMs = null;
    getRunHistoryDetail.mockResolvedValue({ status: "available", data: publicDetail });

    const adminDetail = adminDetailFixture();
    const { startedAt: _adminStartedAt, ...adminSummary } = adminDetail.summary;
    adminDetail.summary = adminSummary;
    adminDetail.overallDurationMs = null;

    const listMarkup = renderToStaticMarkup(createElement(RunHistoryList, { history }));
    const publicMarkup = renderToStaticMarkup(
      await RunHistoryDetailPage({
        params: Promise.resolve({ runId: "55555555-5555-4555-8555-555555555555" }),
      }),
    );
    const adminMarkup = renderToStaticMarkup(
      createElement(AdminRunHistoryDetail, { detail: adminDetail }),
    );

    expect(listMarkup).toMatch(/Overall duration<\/p><p[^>]*>not recorded<\/p>/);
    expect(publicMarkup).toContain("duration not recorded");
    expect(adminMarkup).toMatch(/Overall run duration<\/dt><dd[^>]*>— no recorded start<\/dd>/);
    expect(adminMarkup).not.toMatch(/Overall run duration<\/dt><dd[^>]*>0 ms<\/dd>/);
  });
});

function listFixture(): RunHistoryListResponse {
  return {
    summaries: [
      {
        runId: "55555555-5555-4555-8555-555555555555",
        presetName: "Preview 1k",
        occurredAt: "2026-06-20T00:00:00.000Z",
        overallDurationMs: 10_000,
        resultOutcome: "completed-successfully",
        plannedAttempts: 20,
        startingStock: 10,
        uniqueReservations: 10,
        soldOutRejections: 10,
        confirmedOrders: 10,
        failedOrders: 0,
        convergenceDurationSeconds: 2,
      },
    ],
    page: 1,
    pageSize: 10,
    totalCount: 1,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function detailFixture(
  status: "completed" | "failed" = "completed",
): PublicRunHistoryDetailResponse {
  const transportAttemptCounts = {
    plannedRequests: 20,
    startedRequests: 20,
    completedRequests: 20,
    interruptedRequests: 0,
    unstartedRequests: 0,
  };
  const httpSummary = {
    failedRequests: 0,
    acceptedResponses: 10,
    soldOutResponses: 10,
    transportFailures: 0,
    unexpectedResponses: 0,
    p95LatencyMs: 42,
    failureRate: 0,
  };
  const businessOutcomeSummary = {
    acceptedReservations: 10,
    reservedUnits: 10,
    soldOutRejections: 10,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 10,
    failedOrders: 0,
    pendingPersistenceCount: 0,
    notificationsRecorded: 10,
  };
  const terminalInventorySnapshot = {
    startingStock: 10,
    remainingStock: 0,
    reservedStock: 10,
    acceptedReservations: 10,
    soldOutRejections: 10,
    pendingPersistenceCount: 0,
    capturedAt: "2026-06-20T00:00:10.000Z",
  };
  const failureCategory = status === "failed" ? ("traffic" as const) : undefined;
  const result = deriveRunResult({
    runStatus: status,
    failureCategory: failureCategory ?? null,
    startingStock: 10,
    remainingStock: 0,
    durable: {
      reservedUnits: 10,
      uniqueReservations: 10,
      soldOutDecisions: 10,
      confirmedOrders: 10,
      failedOrders: 0,
      queuedOrders: 0,
      processingOrders: 0,
      durablePendingPersistenceRecords: 0,
      notificationsRecorded: 10,
    },
    heldReservationsAwaitingPersistence: 0,
    replayPossible: false,
    generator: { transportAttemptCounts, httpSummary },
  });
  const serverTiming = emptyServerReservationTimingSummary;
  return {
    summary: {
      runId: "55555555-5555-4555-8555-555555555555",
      presetName: "Preview 1k",
      status,
      replayPossible: false,
      ...(failureCategory ? { failureCategory } : {}),
      startedAt: "2026-06-20T00:00:00.000Z",
      endedAt: "2026-06-20T00:00:10.000Z",
      transportAttemptCounts,
      httpSummary,
      trafficDeliverySummary: {
        trafficMode: "buyer-spike",
        plannedBuyers: 20,
        scheduledRatePerSecond: null,
        configuredDurationSeconds: null,
        preAllocatedVUs: null,
        maxVUs: null,
        droppedIterations: 0,
        completedIterations: 20,
        requestArrivalSummary: {
          ...emptyRequestArrivalSummary,
          firstAttemptStartedAt: "2026-06-20T00:00:01.000Z",
          peakArrivalRatePerSecond: 20,
          dispatchDurationSeconds: 1,
          arrivalWindowCountObserved: 1,
          arrivalWindowCountRetained: 1,
          arrivalRateSeries: [{ windowStartedAt: "2026-06-20T00:00:01.000Z", ratePerSecond: 20 }],
        },
        trafficDeliveryStatus: status === "failed" ? "failed" : "complete",
      },
      serverReservationTimingSummary: serverTiming,
      businessOutcomeSummary,
      terminalInventorySnapshot,
      runSignalTimelineSummary: null,
      capturedAt: "2026-06-20T00:00:10.000Z",
    },
    run: {
      runId: "55555555-5555-4555-8555-555555555555",
      presetName: "Preview 1k",
      operatorMode: "public",
      status,
      trafficStatus: status === "failed" ? "failed" : "succeeded",
      configSnapshot: previewRunConfigSnapshotFixture(),
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
      trafficEndedAt: "2026-06-20T00:00:09.000Z",
      finalizedAt: "2026-06-20T00:00:10.000Z",
    },
    result,
    overallDurationMs: 10_000,
    plannedAttempts: 20,
    httpTimingBreakdownSummary: emptyHttpTimingBreakdownSummary,
    erpAttempts: {
      totalCount: status === "failed" ? 2 : 1,
      byStatus: {
        succeeded: 1,
        failed: status === "failed" ? 1 : 0,
        timedOut: 0,
      },
      averageLatencyMs: 20,
      p95LatencyMs: 25,
    },
    runSignalTimelineSummary: null,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function adminDetailFixture(): AdminRunHistoryDetailResponse {
  const detail = detailFixture();
  const inventory = detail.summary.terminalInventorySnapshot;
  if (!inventory) throw new Error("Expected terminal inventory fixture.");

  return {
    query: { limit: 20 },
    overallDurationMs: 10_000,
    summary: {
      ...detail.summary,
      id: "66666666-6666-4666-8666-666666666666",
      trafficDeliverySummary: {
        ...detail.summary.trafficDeliverySummary,
        notes: [],
      },
      terminalInventorySnapshot: {
        ...inventory,
        saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        source: "redis",
      },
    },
    exceptionSummary: {
      maximumClassification: detail.result.maximumClassification,
      brokenInvariants: 0,
      failedOrders: 0,
      pendingWork: 0,
      partialDelivery: 0,
      generatorWarnings: 1,
      truncatedCollections: 0,
    },
    run: {
      runId: detail.run.runId,
      presetId: "33333333-3333-4333-8333-333333333333",
      presetName: detail.run.presetName,
      operatorMode: "public",
      status: "completed",
      trafficStatus: "succeeded",
      saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      configSnapshot: detail.run.configSnapshot,
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
      trafficEndedAt: "2026-06-20T00:00:09.000Z",
      finalizedAt: "2026-06-20T00:00:10.000Z",
    },
    httpTimingBreakdownSummary: detail.httpTimingBreakdownSummary,
    loadRunDiagnosticsSummary: null,
    orders: {
      totalCount: 1,
      matchedCount: 1,
      warningCount: 0,
      limit: 20,
      truncated: false,
      records: [
        {
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlationId: "corr-history-detail",
          quantity: 1,
          status: "confirmed",
          queuedAt: "2026-06-20T00:00:02.000Z",
          processingAt: "2026-06-20T00:00:03.000Z",
          confirmedAt: "2026-06-20T00:00:07.000Z",
        },
      ],
    },
    erpAttempts: {
      totalCount: 1,
      matchedCount: 1,
      warningCount: 0,
      limit: 20,
      truncated: false,
      records: [
        {
          attemptId: "99999999-9999-4999-8999-999999999992",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          correlationId: "corr-history-detail",
          attemptNumber: 1,
          status: "succeeded",
          terminal: true,
          httpStatus: 200,
          latencyMs: 42,
          startedAt: "2026-06-20T00:00:04.000Z",
          finishedAt: "2026-06-20T00:00:05.000Z",
        },
      ],
    },
    erpAttemptSummary: detail.erpAttempts,
    notifications: {
      totalCount: 1,
      matchedCount: 1,
      warningCount: 0,
      limit: 20,
      truncated: false,
      records: [
        {
          notificationId: "99999999-9999-4999-8999-999999999993",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          correlationId: "corr-history-detail",
          recordedAt: "2026-06-20T00:00:08.000Z",
        },
      ],
    },
    eventTimeline: {
      totalCount: 1,
      matchedCount: 1,
      warningCount: 0,
      limit: 20,
      truncated: false,
      records: [
        {
          eventId: "99999999-9999-4999-8999-999999999994",
          eventName: "order.confirmed",
          source: "worker",
          saleOfferId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          correlationId: "corr-history-detail",
          orderId: "99999999-9999-4999-8999-999999999991",
          publicOrderId: "ord_history_1",
          occurredAt: "2026-06-20T00:00:07.000Z",
        },
      ],
    },
    runSignalTimelineSummary: null,
    timestamp: "2026-06-20T00:00:10.000Z",
  };
}

function resultEvidence(detail: PublicRunHistoryDetailResponse) {
  const business = detail.summary.businessOutcomeSummary;
  const inventory = detail.summary.terminalInventorySnapshot;
  return {
    runStatus: detail.summary.status,
    failureCategory: detail.summary.failureCategory ?? null,
    startingStock: inventory?.startingStock ?? null,
    remainingStock: inventory?.remainingStock ?? null,
    durable: {
      reservedUnits: business.reservedUnits,
      uniqueReservations: business.acceptedReservations,
      soldOutDecisions: business.soldOutRejections,
      confirmedOrders: business.confirmedOrders,
      failedOrders: business.failedOrders,
      queuedOrders: business.queuedOrders,
      processingOrders: business.processingOrders,
      durablePendingPersistenceRecords: business.pendingPersistenceCount,
      notificationsRecorded: business.notificationsRecorded,
    },
    heldReservationsAwaitingPersistence: inventory?.pendingPersistenceCount ?? null,
    replayPossible: detail.summary.replayPossible,
  };
}
