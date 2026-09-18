// @vitest-environment jsdom

import {
  type BusinessOutcomeSummary,
  type ConsistencyLagSummary,
  type DashboardProjection,
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ConsistencyLagPanel,
  InventoryDrainPanel,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunErpOutcomesPanel,
  RunOutcomesPanel,
  SystemStatusPanel,
} from "../src/app/components/dashboard-panels.js";
import { OperatorDashboard } from "../src/app/components/operator-dashboard.js";
import type { Freshness } from "../src/app/lib/presentation/freshness.js";
import {
  deriveInventoryOutcomeState,
  deriveLagPresentationState,
  deriveOutcomePresentationState,
  deriveRunErpOutcomeState,
  deriveRunPresentationState,
  deriveSharedErpProtectionState,
  deriveSharedRuntimeState,
  type PresentationState,
} from "../src/app/lib/presentation/run-presentation-state.js";

describe("Phase 6 projection dashboard", () => {
  it("renders neutral initial hydration without recovery controls", () => {
    const recovery = { status: "loading" as const };
    const markup = renderToStaticMarkup(
      createElement(RecoveryStatusPanel, {
        recovery,
        realtimeStatus: "connecting",
        presentation: deriveRunPresentationState(recovery),
        onRefresh: () => undefined,
      }),
    );

    expect(markup).toContain("Checking availability.");
    expect(markup).not.toContain("Unavailable");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("Refresh");
    expect(markup).not.toContain("Retry");
  });

  it("renders aggregate lag and durable completion outcomes without a recent-order panel", () => {
    const recovery = available(projectionFixture());
    const lagMarkup = renderToStaticMarkup(
      createElement(ConsistencyLagPanel, {
        recovery,
        presentation: activePresentation,
        freshness: liveFreshness,
      }),
    );
    const outcomeMarkup = renderToStaticMarkup(
      createElement(RunOutcomesPanel, {
        recovery,
        presentation: activePresentation,
        freshness: liveFreshness,
      }),
    );
    expect(lagMarkup).toContain("Fast reservation vs final confirmation");
    expect(lagMarkup).toContain("350 ms");
    expect(lagMarkup).not.toContain("Latest individual order");
    expect(outcomeMarkup).toContain("Reservation and confirmation summary");
    expect(outcomeMarkup).toContain("Durable checkout records");
    expect(outcomeMarkup).toContain("Reservation and order outcomes recorded by Checkout-Surge");
    expect(outcomeMarkup).toContain("Unique reservations secured");
    expect(outcomeMarkup).toContain("sold-out rejections recorded by Checkout-Surge");
    expect(outcomeMarkup).toContain("Confirmed");
    expect(outcomeMarkup).toContain("Failed");
  });

  it.each([
    ["connecting", "connecting to live updates", "connecting", "bg-surface-muted"],
    ["unsupported", "live updates unsupported", "live updates unsupported", "bg-surface-muted"],
  ] as const)("renders %s freshness without a disconnect claim", (state, expectedCopy, expectedLabel, expectedToneClass) => {
    const recovery = available(projectionFixture());
    const markup = renderToStaticMarkup(
      createElement(RequestSurgePanel, {
        recovery,
        freshness: { ...liveFreshness, state },
      }),
    );

    expect(markup).toContain(
      `Updated <time dateTime="2026-06-20T00:00:12.000Z">2026-06-20 00:00:12 UTC</time> · ${expectedCopy}`,
    );
    expect(markup).toMatch(
      new RegExp(`${expectedToneClass}[^>]*><span[^>]*>[^<]*</span>${expectedLabel}</span>`),
    );
    expect(markup).not.toContain("disconnected");
    expect(markup).not.toContain("last known values");
  });

  it("renders the request panel's configured delay and time until checkout attempts begin", () => {
    const projection = drainingProjectionFixture();
    if (projection.currentRun?.status !== "draining" || !projection.requestArrivalSummary) {
      throw new Error("Expected a run with terminal arrival evidence.");
    }
    const currentRun = projection.currentRun;
    projection.currentRun = {
      ...currentRun,
      configSnapshot: {
        ...currentRun.configSnapshot,
        trafficConfig: {
          ...currentRun.configSnapshot.trafficConfig,
          startDelaySeconds: 3,
        },
      },
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
    };
    // The first attempt moves, so the one observed arrival window moves with it: a window opening
    // ten seconds before the first attempt started would describe traffic nobody dispatched.
    projection.requestArrivalSummary = {
      ...projection.requestArrivalSummary,
      firstAttemptStartedAt: "2026-06-20T00:00:10.000Z",
      arrivalRateSeries: [{ windowStartedAt: "2026-06-20T00:00:10.000Z", ratePerSecond: 1_000 }],
    };

    const markup = renderToStaticMarkup(
      createElement(RequestSurgePanel, {
        recovery: available(projection),
        freshness: liveFreshness,
      }),
    );

    expect(markup).toMatch(/Configured start delay<\/dt><dd[^>]*>3 s<\/dd>/);
    expect(markup).toMatch(/Startup overhead beyond configured delay<\/dt><dd[^>]*>7 s<\/dd>/);
    expect(markup).toMatch(/Time until checkout attempts begin<\/dt><dd[^>]*>10 s<\/dd>/);
    expect(markup).toContain("sold-out rejections recorded by Checkout-Surge");
  });

  it("keeps every request-surge fact and absence state in one compact grid", () => {
    const projection = projectionFixture();
    const markup = renderToStaticMarkup(
      createElement(RequestSurgePanel, {
        recovery: available(projection),
        freshness: liveFreshness,
      }),
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const panel = panelSection(document, "Traffic arrival and responses");
    const grids = panel.querySelectorAll("dl");
    const expectedLabels = [
      "request arrival rate",
      "Attempts dispatched",
      "Dispatch duration",
      "Response completion rate",
      "Configured start delay",
      "Startup overhead beyond configured delay",
      "Time until checkout attempts begin",
      "Response latency",
      "HTTP failure rate",
      "Peak reservation rate",
      "Reservations in",
      "sold-out rejections recorded by Checkout-Surge",
    ];

    expect(grids).toHaveLength(1);
    const renderedLabels = [...(grids[0]?.querySelectorAll("dt") ?? [])].map(
      (term) => term.textContent?.toLowerCase() ?? "",
    );
    const labelPositions = expectedLabels.map((label) =>
      renderedLabels.findIndex((renderedLabel) => renderedLabel.startsWith(label.toLowerCase())),
    );
    expect(labelPositions.every((position) => position >= 0)).toBe(true);
    expect(labelPositions).toEqual([...labelPositions].sort((left, right) => left - right));

    projection.inventory = null;
    const absentMarkup = renderToStaticMarkup(
      createElement(RequestSurgePanel, {
        recovery: available(projection),
        freshness: liveFreshness,
      }),
    );
    const absentDocument = new DOMParser().parseFromString(absentMarkup, "text/html");
    const absentGrid = panelSection(absentDocument, "Traffic arrival and responses").querySelector(
      "dl.m-0.grid.grid-cols-3",
    );
    expect(absentGrid?.textContent).toContain("Waiting for inventory evidence");
  });

  it("separates run ERP outcomes from shared runtime state and labels both clocks", () => {
    const projection = projectionFixture();
    const runMarkup = renderToStaticMarkup(
      createElement(RunErpOutcomesPanel, {
        recovery: available(projection),
        presentation: deriveRunErpOutcomeState(projection.erp),
        freshness: liveFreshness,
      }),
    );
    const systemMarkup = renderToStaticMarkup(
      createElement(SystemStatusPanel, {
        recovery: available(projectionFixture()),
        presentation: deriveSharedRuntimeState(projection.systemStatus),
        erpPresentation: deriveSharedErpProtectionState(
          projection.systemStatus?.erpProtection ?? null,
        ),
      }),
    );

    expect(runMarkup).toContain("This run");
    expect(runMarkup).toMatch(/Run protection<\/dt><dd[^>]*>Calls paused to protect the ERP<\/dd>/);
    expect(runMarkup).toContain("Protection state changed (reported by circuit breaker)");
    expect(runMarkup).not.toContain("Shared demo runtime");
    expect(systemMarkup).toContain("Shared demo runtime");
    expect(systemMarkup).toContain("across all runs and visitors");
    expect(systemMarkup).toContain("Protection state changed (reported by circuit breaker)");
    // The backlog column keeps its own poll clock; the ERP column's is demoted and named.
    expect(systemMarkup).toContain("Last updated");
    expect(systemMarkup).toContain("Projected by API at");
    expect(systemMarkup).not.toContain("no scheduled update cadence");
    expect(systemMarkup).not.toContain("Recent attempts");
  });

  it("keeps run attempt evidence visible when circuit state is unavailable", () => {
    const projection = projectionFixture();
    if (!projection.erp) throw new Error("Expected run ERP outcome fixture.");
    projection.erp = {
      ...projection.erp,
      circuit: null,
      circuitReadStatus: "unavailable",
    };

    const markup = renderToStaticMarkup(
      createElement(RunErpOutcomesPanel, {
        recovery: available(projection),
        presentation: deriveRunErpOutcomeState(projection.erp),
        freshness: liveFreshness,
      }),
    );

    expect(markup).toMatch(/Run protection<\/dt><dd[^>]*>Protection status unavailable<\/dd>/);
    expect(markup).toMatch(/Recent attempts<\/dt><dd[^>]*>3<\/dd>/);
    expect(markup).toContain("protection unavailable");
    expect(markup).not.toContain("No ERP outcome data for this run.");
  });

  it("renders a completed exact sellout without warning presentation", () => {
    const projection = projectionFixture();
    if (
      projection.currentRun?.status !== "active" ||
      !projection.inventory ||
      !projection.businessOutcome ||
      !projection.consistencyLag
    ) {
      throw new Error("Expected a complete active projection fixture.");
    }
    const currentRun = projection.currentRun;
    const inventory = projection.inventory;
    const businessOutcome = projection.businessOutcome;
    const consistencyLag = projection.consistencyLag;
    projection.currentRun = {
      ...currentRun,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:12.000Z",
      finalizedAt: "2026-06-20T00:00:13.000Z",
    };
    projection.inventory = {
      ...inventory,
      remainingStock: 0,
      reservedStock: 100,
    };
    projection.businessOutcome = {
      ...businessOutcome,
      acceptedReservations: 100,
      // Reserved units sum the quantity of those same reservations, and quantity is a positive
      // integer, so this count moves with `acceptedReservations` and can never fall below it.
      reservedUnits: 100,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 100,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      // A run cannot finalize while notifications trail confirmed orders.
      notificationsRecorded: 100,
    };
    projection.consistencyLag = {
      ...consistencyLag,
      confirmedOrderCount: 100,
      pendingConfirmationCount: 0,
      oldestPendingAgeSeconds: null,
    };
    expectFinalizableCompletedOutcome(projection.businessOutcome);
    expectCoherentConfirmationCounts(projection.businessOutcome, projection.consistencyLag);
    const recovery = available(projection);
    const runState = deriveRunPresentationState(recovery);
    const freshness = { ...liveFreshness, state: "not-applicable" as const, final: true };
    const markup = [
      renderToStaticMarkup(
        createElement(InventoryDrainPanel, {
          recovery,
          presentation: deriveInventoryOutcomeState(
            projection.inventory,
            projection.currentRun,
            projection.businessOutcome.reservedUnits,
          ),
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(ConsistencyLagPanel, {
          recovery,
          presentation: deriveLagPresentationState(
            projection.consistencyLag.pendingConfirmationCount,
            projection.consistencyLag.confirmedOrderCount,
            projection.currentRun,
          ),
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(RunOutcomesPanel, {
          recovery,
          presentation: deriveOutcomePresentationState(
            projection.businessOutcome,
            projection.currentRun,
            runState,
          ),
          freshness,
        }),
      ),
    ].join("");

    expect(markup).toContain("exact sellout");
    expect(markup).toContain("completed successfully");
    expect(markup).not.toContain("bg-warning-soft");
  });

  it.each([
    "completed",
    "failed",
  ] as const)("does not imply missing evidence will arrive after a %s run", (status) => {
    const projection = projectionFixture();
    const currentRun = projection.currentRun;
    if (currentRun?.status !== "active") {
      throw new Error("Expected an active run fixture.");
    }
    projection.currentRun =
      status === "completed"
        ? {
            ...currentRun,
            status,
            trafficStatus: "succeeded",
            trafficEndedAt: "2026-06-20T00:00:12.000Z",
            finalizedAt: "2026-06-20T00:00:13.000Z",
          }
        : {
            ...currentRun,
            status,
            trafficStatus: "failed",
            failureCategory: "traffic",
            trafficEndedAt: "2026-06-20T00:00:12.000Z",
            finalizedAt: "2026-06-20T00:00:13.000Z",
          };
    projection.inventory = null;
    projection.erp = null;
    projection.businessOutcome = null;
    projection.consistencyLag = null;
    projection.recentMetrics = [];
    projection.transportAttemptCounts = null;
    projection.httpSummary = null;
    projection.requestArrivalSummary = null;
    const recovery = available(projection);
    const freshness = { ...liveFreshness, state: "not-applicable" as const, final: true };
    const markup = [
      renderToStaticMarkup(createElement(RequestSurgePanel, { recovery, freshness })),
      renderToStaticMarkup(
        createElement(InventoryDrainPanel, {
          recovery,
          presentation: activePresentation,
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(RunErpOutcomesPanel, {
          recovery,
          presentation: activePresentation,
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(ConsistencyLagPanel, {
          recovery,
          presentation: activePresentation,
          freshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(RunOutcomesPanel, {
          recovery,
          presentation: activePresentation,
          freshness,
        }),
      ),
    ].join("");

    expect(markup).toContain("Not recorded for this run");
    expect(markup).toContain("Inventory evidence is unavailable for this run.");
    expect(markup).toContain("Simulated ERP evidence is unavailable for this run.");
    expect(markup).toContain("Confirmation evidence is unavailable for this run.");
    expect(markup).toContain("Checkout outcome evidence is unavailable for this run.");
    expect(markup).toContain("Final request totals were not recorded for this run.");
    expect(markup).not.toContain("Waiting for");
    expect(markup).not.toContain("not yet available");
    expect(markup).not.toContain("evidence yet");
    expect(markup).not.toContain("appear here once");
  });

  it("settles load-generator absence while a draining run still awaits durable evidence", () => {
    const projection = projectionFixture();
    const currentRun = projection.currentRun;
    if (currentRun?.status !== "active") {
      throw new Error("Expected an active run fixture.");
    }
    projection.currentRun = {
      ...currentRun,
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:12.000Z",
    };
    projection.inventory = null;
    projection.erp = null;
    projection.businessOutcome = null;
    projection.consistencyLag = null;
    projection.recentMetrics = [];
    projection.transportAttemptCounts = null;
    projection.httpSummary = null;
    projection.requestArrivalSummary = null;
    const recovery = available(projection);
    const surgeMarkup = renderToStaticMarkup(
      createElement(RequestSurgePanel, { recovery, freshness: liveFreshness }),
    );
    const durableMarkup = [
      renderToStaticMarkup(
        createElement(InventoryDrainPanel, {
          recovery,
          presentation: activePresentation,
          freshness: liveFreshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(RunErpOutcomesPanel, {
          recovery,
          presentation: activePresentation,
          freshness: liveFreshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(ConsistencyLagPanel, {
          recovery,
          presentation: activePresentation,
          freshness: liveFreshness,
        }),
      ),
      renderToStaticMarkup(
        createElement(RunOutcomesPanel, {
          recovery,
          presentation: activePresentation,
          freshness: liveFreshness,
        }),
      ),
    ].join("");

    // Traffic has ended, so nothing the load generator owns can still arrive.
    expect(surgeMarkup).toContain("Not recorded for this run");
    expect(surgeMarkup).toContain("Final request totals were not recorded for this run.");
    expect(surgeMarkup).not.toContain("Waiting for the load generator");
    expect(surgeMarkup).not.toContain("not yet available");
    expect(surgeMarkup).not.toContain("appear here once");
    // Durable processing continues, so its absence stays provisional in the same panel.
    expect(surgeMarkup).toContain("Waiting for inventory evidence");
    expect(durableMarkup).toContain("No inventory evidence yet.");
    expect(durableMarkup).toContain("No simulated ERP evidence yet.");
    expect(durableMarkup).toContain("No confirmation evidence yet.");
    expect(durableMarkup).toContain("No checkout outcome evidence yet.");
  });

  it("leads both simulated-ERP surfaces with one sentence and demotes protection configuration", () => {
    const projection = projectionFixture();
    const runMarkup = renderToStaticMarkup(
      createElement(RunErpOutcomesPanel, {
        recovery: available(projection),
        presentation: deriveRunErpOutcomeState(projection.erp),
        freshness: liveFreshness,
      }),
    );
    const sharedMarkup = renderToStaticMarkup(
      createElement(SystemStatusPanel, {
        recovery: available(projection),
        presentation: deriveSharedRuntimeState(projection.systemStatus),
        erpPresentation: deriveSharedErpProtectionState(
          projection.systemStatus?.erpProtection ?? null,
        ),
      }),
    );

    expect(runMarkup).toContain("Calls paused to protect the simulated ERP");
    expect(runMarkup).toContain("Calls can be retried from 2026-06-20 00:00:19 UTC");
    expect(runMarkup.indexOf("Calls paused to protect the simulated ERP")).toBeLessThan(
      runMarkup.indexOf("Recent attempts"),
    );
    // The window is stated once for the counts below it, never inline on each number.
    expect(runMarkup).toContain("Attempts, failures, and timeouts over the last 60s.");
    expect(runMarkup).not.toContain("Attempt window");

    // Demotion means containment inside the collapsed element, not merely appearing after it.
    const runDetails = collapsedDetails(runMarkup, "Protection details");
    const runMainView = runMarkup.replace(runDetails, "");
    for (const demoted of [
      "Run protection",
      "Failures before protection pauses calls",
      "Current failure streak",
      "Recovery check delay",
      // Both provenance clocks name their producer and update meaning distinctly.
      "Protection pause began (reported by circuit breaker)",
      "Calls can be retried from (per circuit breaker)",
      "Protection state changed (reported by circuit breaker)",
      "Projected by API at",
    ]) {
      expect(runDetails).toContain(demoted);
      expect(runMainView).not.toContain(demoted);
    }
    // A generic poll clock must not sit among the leading public facts.
    expect(runMainView).not.toContain("Last updated");

    // The shared column tells the same story from shared evidence, under its own framing.
    expect(sharedMarkup).toContain("Constrained but keeping up");
    expect(sharedMarkup).toContain("Shared demo runtime");
    expect(sharedMarkup).not.toContain("This run");
    const sharedDetails = collapsedDetails(sharedMarkup, "Protection details");
    const sharedProtectionColumn = visibleErpProtectionColumn(sharedMarkup);
    for (const demoted of [
      "Protection note",
      "Failures before protection pauses calls",
      "Protection pause began (reported by circuit breaker)",
      "Protection state changed (reported by circuit breaker)",
      "Projected by API at",
    ]) {
      expect(sharedDetails).toContain(demoted);
      expect(sharedProtectionColumn).not.toContain(demoted);
    }
    expect(sharedProtectionColumn).not.toContain("Last updated");
  });

  it("keeps shared retry pressure in the main view only while it is nonzero", () => {
    const withPressure = projectionFixture();
    const withoutPressure = projectionFixture();
    const systemStatus = withoutPressure.systemStatus;
    if (!systemStatus) throw new Error("Expected a shared runtime status fixture.");
    // The status service reports no retry pressure as healthy, so the fixture moves as a pair.
    withoutPressure.systemStatus = {
      ...systemStatus,
      erpProtection: {
        ...systemStatus.erpProtection,
        status: "healthy",
        reason: null,
        retryPressure: {
          ...systemStatus.erpProtection.retryPressure,
          retryingJobCount: 0,
          retryAttemptCount: 0,
        },
      },
    };
    const render = (projection: DashboardProjection) =>
      renderToStaticMarkup(
        createElement(SystemStatusPanel, {
          recovery: available(projection),
          presentation: deriveSharedRuntimeState(projection.systemStatus),
          erpPresentation: deriveSharedErpProtectionState(
            projection.systemStatus?.erpProtection ?? null,
          ),
        }),
      );

    // Scoped to the ERP column's visible surface: a document-wide count would also be satisfied by
    // the fact merely moving into the collapsed details, which is not what "main view" means.
    expect(visibleErpProtectionColumn(render(withPressure))).toMatch(
      /Retrying jobs<\/dt><dd[^>]*>1<\/dd>/,
    );
    expect(visibleErpProtectionColumn(render(withoutPressure))).not.toContain("Retrying jobs");
    expect(visibleErpProtectionColumn(render(withoutPressure))).toContain("Keeping up");
  });

  it("states the lag measurement boundary and keeps draining work visible", () => {
    const projection = projectionFixture();
    const currentRun = projection.currentRun;
    if (currentRun?.status !== "active" || !projection.consistencyLag) {
      throw new Error("Expected an active run with a consistency lag fixture.");
    }
    // Traffic has stopped while accepted reservations are still reaching durable outcomes: the
    // lifecycle state this panel exists to explain.
    projection.currentRun = {
      ...currentRun,
      status: "draining",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:12.000Z",
    };
    const markup = renderToStaticMarkup(
      createElement(ConsistencyLagPanel, {
        recovery: available(projection),
        presentation: deriveLagPresentationState(
          projection.consistencyLag.pendingConfirmationCount,
          projection.consistencyLag.confirmedOrderCount,
          projection.currentRun,
        ),
        freshness: liveFreshness,
      }),
    );

    expect(markup).toContain("Fast reservation vs final confirmation");
    expect(markup).toContain(
      "Measured from the moment a reservation is secured to final simulated-ERP confirmation",
    );
    expect(markup).toMatch(/95% confirmed within<\/dt><dd[^>]*>350 ms<\/dd>/);
    expect(markup).toMatch(/Average<\/dt><dd[^>]*>225 ms<\/dd>/);
    expect(markup).toMatch(/Longest<\/dt><dd[^>]*>375 ms<\/dd>/);
    expect(markup).not.toContain("Avg confirmed");
    expect(markup).not.toContain("Max confirmed");
    expect(markup).not.toContain("Reservation: Secured");
    // Draining work is in-flight evidence, not degradation.
    expect(markup).toMatch(/Awaiting confirmation<\/dt><dd[^>]*>2<\/dd>/);
    expect(markup).toMatch(/Oldest pending<\/dt><dd[^>]*>8\.5 s<\/dd>/);
    expect(markup).toContain("processing unique reservations");
    expect(markup).not.toContain("bg-warning-soft");
    expect(markup).not.toContain("bg-danger-soft");
  });

  // "Yet" may only promise evidence that can still arrive, so the zero-confirmation copy follows
  // A04's pending-versus-settled rule in both directions.
  it.each([
    { name: "an active run", terminal: false, expected: "No confirmations yet" },
    {
      name: "a completed run",
      terminal: true,
      expected: "No confirmations were recorded for this run",
    },
  ])("reports a zero-confirmation distribution on $name as $expected", ({ terminal, expected }) => {
    const projection = projectionFixture();
    const currentRun = projection.currentRun;
    const businessOutcome = projection.businessOutcome;
    if (currentRun?.status !== "active" || !businessOutcome) {
      throw new Error("Expected an active run with an outcome fixture.");
    }
    // Every reservation failed. Both branches need it, terminal or not: a lag summary reading zero
    // confirmed and zero pending says no order confirmed and none is queued or processing, so the
    // only accounting left for six accepted reservations is six failed ones. The base fixture's
    // open circuit makes that ordinary rather than contrived. Overriding the lag alone would leave
    // the outcome's own confirmed and in-flight counts behind, describing nothing real.
    projection.businessOutcome = {
      ...businessOutcome,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 0,
      failedOrders: 6,
      pendingPersistenceCount: 0,
      notificationsRecorded: 0,
    };
    if (terminal) {
      projection.currentRun = {
        ...currentRun,
        status: "completed",
        trafficStatus: "succeeded",
        trafficEndedAt: "2026-06-20T00:00:12.000Z",
        finalizedAt: "2026-06-20T00:00:13.000Z",
      };
      // Nothing is left in flight and no notification is owed, so the drain blockers are satisfied.
      expectFinalizableCompletedOutcome(projection.businessOutcome);
    }
    projection.consistencyLag = {
      confirmedOrderCount: 0,
      pendingConfirmationCount: 0,
      averageLagMs: null,
      p95LagMs: null,
      maxLagMs: null,
      oldestPendingAgeSeconds: null,
      measuredAt: "2026-06-20T00:00:10.000Z",
    };
    expectCoherentConfirmationCounts(projection.businessOutcome, projection.consistencyLag);
    const markup = renderToStaticMarkup(
      createElement(ConsistencyLagPanel, {
        recovery: available(projection),
        presentation: deriveLagPresentationState(0, 0, projection.currentRun),
        freshness: liveFreshness,
      }),
    );

    expect(markup.match(new RegExp(expected, "g"))).toHaveLength(3);
    // A pre-run zero is never called settled, and a terminal zero never promises a later arrival.
    expect(markup).not.toContain("settled");
    if (terminal) expect(markup).not.toContain("No confirmations yet");
    expect(markup).not.toContain("Not recorded for this run");
    expect(markup).toContain(
      "Measured from the moment a reservation is secured to final simulated-ERP confirmation",
    );
  });

  it("keeps the completed lag distribution readable after every confirmation lands", () => {
    const projection = projectionFixture();
    const currentRun = projection.currentRun;
    const businessOutcome = projection.businessOutcome;
    if (currentRun?.status !== "active" || !projection.consistencyLag || !businessOutcome) {
      throw new Error("Expected an active run with lag and outcome fixtures.");
    }
    projection.currentRun = {
      ...currentRun,
      status: "completed",
      trafficStatus: "succeeded",
      trafficEndedAt: "2026-06-20T00:00:12.000Z",
      finalizedAt: "2026-06-20T00:00:13.000Z",
    };
    // The confirmation counts move together: the lag summary counts a subset of the confirmed
    // orders, which are themselves a subset of the accepted reservations. Every one of this run's
    // six reservations confirmed, so all three counts land on six — and a completed run has both a
    // notification per confirmation and nothing left in flight.
    projection.businessOutcome = {
      ...businessOutcome,
      queuedOrders: 0,
      processingOrders: 0,
      retryingOrders: 0,
      confirmedOrders: 6,
      failedOrders: 0,
      pendingPersistenceCount: 0,
      notificationsRecorded: 6,
    };
    expectFinalizableCompletedOutcome(projection.businessOutcome);
    projection.consistencyLag = {
      ...projection.consistencyLag,
      confirmedOrderCount: 6,
      pendingConfirmationCount: 0,
      oldestPendingAgeSeconds: null,
    };
    expectCoherentConfirmationCounts(projection.businessOutcome, projection.consistencyLag);
    const markup = renderToStaticMarkup(
      createElement(ConsistencyLagPanel, {
        recovery: available(projection),
        presentation: deriveLagPresentationState(0, 6, projection.currentRun),
        freshness: { ...liveFreshness, state: "not-applicable", final: true },
      }),
    );

    expect(markup).toMatch(/95% confirmed within<\/dt><dd[^>]*>350 ms<\/dd>/);
    expect(markup).toMatch(/Confirmed<\/dt><dd[^>]*>6<\/dd>/);
    expect(markup).toMatch(/Awaiting confirmation<\/dt><dd[^>]*>0<\/dd>/);
    expect(markup).not.toContain("No confirmations yet");
  });

  /**
   * The layout contract is adjacency, not two independent spans: B07 exists because the
   * consistency card left an empty region beside it, and two half-width panels reproduce exactly
   * that unless they are siblings inside the 12-column grid. A `col-span-6` on a panel nested in
   * some wrapper does not participate in that grid at all, so this asserts element identity and
   * parent/child structure in a real DOM rather than arithmetic on serialized markup. It carries
   * the whole desktop-row contract, spans included: a separate per-panel span test would only
   * restate what the panels found here already prove.
   */
  it("places the run ERP and consistency panels side by side in the Processing group", () => {
    const markup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(projectionFixture()),
      }),
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const processing = document.querySelector("#watch-advanced-processing");
    if (!processing) throw new Error("Expected the Processing technical group.");
    const grid = processing.querySelector(".grid-cols-12");
    if (!grid) throw new Error("Expected a 12-column Processing grid.");
    const erpPanel = panelSection(document, "Simulated ERP outcomes");
    const lagPanel = panelSection(document, "Fast reservation vs final confirmation");
    // Positions among the grid's own children, by element identity. Comparing indices rather than
    // the elements themselves keeps a failure readable: vitest serializing two DOM nodes for a diff
    // reports a jsdom environment error instead of the mismatch.
    const gridChildren = [...grid.children];
    const erpIndex = gridChildren.indexOf(erpPanel);
    const lagIndex = gridChildren.indexOf(lagPanel);

    // Direct children of the grid: a wrapper around the pair takes their spans out of it entirely.
    expect(erpIndex).toBeGreaterThan(-1);
    // Immediate siblings: any panel between them splits the row into two half-width gaps.
    expect(lagIndex).toBe(erpIndex + 1);
    for (const panel of [erpPanel, lagPanel]) {
      // Class tokens, not substrings: `toContain("col-span-6")` and `/\bcol-span-6\b/` both match
      // inside a responsive variant such as `max-[900px]:col-span-6`, a different contract.
      expect(panel.classList.contains("col-span-6")).toBe(true);
      // Breadth is what is wanted here, so a substring is right: no `col-span-4` survives on either
      // panel, responsive variant or not.
      expect(panel.className).not.toContain("col-span-4");
    }
  });

  it.each([
    "idle",
    "active",
    "completed",
  ] as const)("keeps every grouped technical section's desktop rows filled for %s evidence", (status) => {
    const projection = projectionFixture();
    if (status === "idle") {
      projection.currentRun = null;
    } else if (status === "completed") {
      const currentRun = projection.currentRun;
      if (currentRun?.status !== "active") throw new Error("Expected an active run fixture.");
      projection.currentRun = {
        ...currentRun,
        status,
        trafficStatus: "succeeded",
        trafficEndedAt: "2026-06-20T00:00:11.000Z",
        finalizedAt: "2026-06-20T00:00:12.000Z",
      };
    }
    const markup = renderToStaticMarkup(
      createElement(OperatorDashboard, {
        initialRecovery: available(projection),
      }),
    );
    const document = new DOMParser().parseFromString(markup, "text/html");
    const groups = [...document.querySelectorAll("[id^='watch-advanced-']")];
    expect(groups.map((group) => group.id)).toEqual(
      status === "idle"
        ? ["watch-advanced-connection"]
        : [
            "watch-advanced-scenario",
            "watch-advanced-signals",
            "watch-advanced-processing",
            "watch-advanced-consistency",
            "watch-advanced-connection",
          ],
    );
    for (const group of groups) {
      const grid = group.querySelector(".grid-cols-12");
      if (!grid) throw new Error(`Expected a 12-column grid in #${group.id}.`);
      const spans = [...grid.children].map((panel) => {
        const span = [...panel.classList]
          .map((className) => /^col-span-(\d+|full)$/.exec(className)?.[1])
          .find(Boolean);
        if (!span) throw new Error(`Expected a desktop span on ${panel.textContent}.`);
        // `col-span-full` is the panels' existing full-width form of 12 columns.
        return span === "full" ? 12 : Number(span);
      });

      let rowWidth = 0;
      for (const span of spans) {
        rowWidth += span;
        expect(rowWidth).toBeLessThanOrEqual(12);
        if (rowWidth === 12) rowWidth = 0;
      }
      expect(rowWidth).toBe(0);
      expect(spans).toEqual(groupSpans(group.id));
    }
    const processing = document.querySelector("#watch-advanced-processing");
    if (status === "completed") {
      const grid = processing?.querySelector(".grid-cols-12");
      if (!grid) throw new Error("Expected the Processing 12-column grid.");
      const children = [...grid.children];
      const outcomesIndex = children.findIndex((panel) =>
        panel.textContent?.includes("Reservation and confirmation summary"),
      );
      expect(outcomesIndex).toBe(0);
      expect(document.querySelector("#watch-advanced-consistency")?.textContent).toContain(
        "Evidence and reconciliation proof",
      );
    }

    function groupSpans(groupId: string): number[] {
      switch (groupId) {
        case "watch-advanced-scenario":
          return [12, 12];
        case "watch-advanced-signals":
          return [12];
        case "watch-advanced-consistency":
          return status === "completed" ? [12, 12] : [12];
        case "watch-advanced-processing":
          return [12, 6, 6];
        case "watch-advanced-connection":
          return status === "idle" ? [12] : [4, 8, 12];
        default:
          throw new Error(`Unexpected group ${groupId}.`);
      }
    }
  });

  it.each([
    ["an active run before its traffic completes", projectionFixture],
    ["a draining run carrying its terminal traffic evidence", drainingProjectionFixture],
  ])("provides a contract-valid, recognizable fixture for %s", (_label, buildProjection) => {
    const projection = buildProjection();
    const {
      currentRun,
      erp,
      transportAttemptCounts,
      httpSummary,
      businessOutcome,
      consistencyLag,
    } = projection;
    if (!currentRun || !erp || !businessOutcome || !consistencyLag) {
      throw new Error("Expected a fully populated projection fixture.");
    }

    expect(() => dashboardProjectionSchema.parse(projection)).not.toThrow();

    // These relationships keep the fixture recognizable without imposing strict invariants on
    // potentially torn live reads.
    expectCoherentConfirmationCounts(businessOutcome, consistencyLag);
    if (erp.recentAttemptCount > 0) expect(erp.latestAttempt).not.toBeNull();

    if (transportAttemptCounts || httpSummary) {
      expect(["draining", "completed", "failed"]).toContain(currentRun.status);
    }
  });

  it("renders retained inventory values and their update time after disconnect", () => {
    const projection = projectionFixture();
    const markup = renderToStaticMarkup(
      createElement(InventoryDrainPanel, {
        recovery: available(projection),
        presentation: deriveInventoryOutcomeState(
          projection.inventory,
          projection.currentRun,
          projection.businessOutcome?.reservedUnits ?? null,
        ),
        freshness: {
          state: "disconnected",
          observedAt: projection.recoveredAt,
          final: false,
        },
      }),
    );

    expect(markup).toContain(
      'Updated <time dateTime="2026-06-20T00:00:11.000Z">2026-06-20 00:00:11 UTC</time> · disconnected, showing last known values',
    );
    expect(markup).toContain("Starting stock");
    expect(markup).toContain(">100<");
    expect(markup).toContain("Remaining");
    expect(markup).toContain(">12<");
    expect(markup).toContain("Reserved");
    expect(markup).toContain(">88<");
  });
});

const activePresentation: PresentationState = {
  state: "accepting-checkout-attempts",
  tone: "progress",
  label: "accepting checkout attempts",
  description: "Checkout attempts are being accepted.",
};

const liveFreshness: Freshness = {
  state: "live",
  observedAt: "2026-06-20T00:00:12.000Z",
  final: false,
};

/**
 * A hard rule, from an explicit named decision rather than an inferred relationship:
 * `businessDrainBlockers` in `apps/api/src/services/demo-run-finalization-service.ts` refuses to
 * finalize a run while notifications trail confirmed orders, or while queued, processing, or
 * retrying orders exceed the counts a timeout escalation has excused. A run presenting as
 * `completed` therefore cannot carry any of them. The escalated counts are zero unless a run was
 * escalated, which none of these fixtures depicts.
 */
function expectFinalizableCompletedOutcome(outcome: BusinessOutcomeSummary): void {
  expect(outcome.notificationsRecorded).toBeGreaterThanOrEqual(outcome.confirmedOrders);
  expect(outcome.queuedOrders).toBe(0);
  expect(outcome.processingOrders).toBe(0);
  expect(outcome.retryingOrders).toBe(0);
}

/**
 * Keeps inline fixture overrides recognizable by checking that confirmation and lag counts still
 * describe one coherent snapshot. These are fixture-realism checks, not strict live-read
 * invariants.
 */
function expectCoherentConfirmationCounts(
  outcome: BusinessOutcomeSummary,
  lag: ConsistencyLagSummary,
): void {
  expect(lag.confirmedOrderCount).toBe(outcome.confirmedOrders);
  expect(lag.pendingConfirmationCount).toBe(outcome.queuedOrders + outcome.processingOrders);
  expect(outcome.confirmedOrders).toBeLessThanOrEqual(outcome.acceptedReservations);
  expect(
    outcome.queuedOrders +
      outcome.processingOrders +
      outcome.confirmedOrders +
      outcome.failedOrders,
  ).toBe(outcome.acceptedReservations);
  expect(outcome.retryingOrders).toBeLessThanOrEqual(outcome.processingOrders);
  expect(outcome.reservedUnits).toBeGreaterThanOrEqual(outcome.acceptedReservations);
}

/** The panel `<section>` owning a given title, found through the heading rather than by position. */
function panelSection(document: Document, title: string): Element {
  const heading = [...document.querySelectorAll("h2")].find(
    (candidate) => candidate.textContent === title,
  );
  const section = heading?.closest("section");
  if (!section) throw new Error(`No panel section titled "${title}".`);

  return section;
}

/** The shared ERP protection column with its collapsed details removed: what a reader sees first. */
function visibleErpProtectionColumn(markup: string): string {
  const column = markup.slice(markup.indexOf("Shared simulated ERP protection"));
  return column.replace(collapsedDetails(column, "Protection details"), "");
}

/**
 * The markup of the one `<details>` element carrying `summaryText`, so a demotion test can assert
 * containment rather than mere document order.
 */
function collapsedDetails(markup: string, summaryText: string): string {
  for (const match of markup.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)) {
    if (match[0].includes(summaryText)) return match[0];
  }

  throw new Error(`No collapsed <details> element with summary "${summaryText}".`);
}

function available(data: DashboardProjection) {
  return { status: "available" as const, data, httpStatus: 200 };
}

/**
 * A contract-valid, recognizable projection of an active run. Tests that override related fixture
 * fields keep their scenario coherent with `expectCoherentConfirmationCounts` and, for completed
 * runs, `expectFinalizableCompletedOutcome`.
 */
function projectionFixture(): DashboardProjection {
  const runId = "11111111-1111-4111-8111-111111111111";
  const saleOfferId = "33333333-3333-4333-8333-333333333333";
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    resetRecoveryRunId: null,
    resetRecovery: "ready",
    scopeId: dashboardProjectionScopeId({ runId, saleOfferId }),
    revision: 4,
    correlationId: "corr-web-recovery",
    scope: { runId, saleOfferId },
    currentRun: {
      runId,
      presetId: "22222222-2222-4222-8222-222222222222",
      presetName: "Preview 1k",
      operatorMode: "public",
      status: "active",
      trafficStatus: "active",
      saleOfferId,
      configSnapshot: {
        inventoryConfig: {
          startingStock: 100,
          quantityPerCheckout: 1,
          reservationHoldMinutes: 15,
        },
        trafficConfig: {
          mode: "buyer-spike",
          buyerCount: 1_000,
          duplicateEachBuyerAttempt: false,
          startDelaySeconds: 0,
          maxDurationSeconds: 10,
          quantityPerAttempt: 1,
        },
        erpConfig: {
          latencyMs: 100,
          maxTps: 2,
          errorRate: 0,
          forcedOutage: false,
          requestTimeoutMs: 1_000,
        },
        backpressureConfig: {
          queueName: "orders:process",
          physicalQueueName: "orders-process",
          orderProcessConcurrency: 4,
          retryPolicy: { maxAttempts: 3, initialBackoffMs: 100 },
          drainTimeoutSeconds: 300,
          pendingPersistenceRetryAfterSeconds: 30,
          circuitBreakerFailureThreshold: 5,
          circuitBreakerResetTimeoutMs: 10_000,
        },
      },
      startedAt: "2026-06-20T00:00:00.000Z",
      trafficStartedAt: "2026-06-20T00:00:00.000Z",
    },
    inventory: {
      saleOfferId,
      allocatedStock: 100,
      remainingStock: 12,
      reservedStock: 88,
      pendingPersistenceCount: 0,
      expiredReservationCount: 0,
      oldestPendingPersistenceAgeSeconds: 0,
      reservationThroughput: {
        windowSeconds: 60,
        successfulReservationCount: 88,
        peakRatePerSecond: 88,
        peakWindowSeconds: 1,
        unit: "reservations_per_second",
        measuredAt: "2026-06-20T00:00:11.000Z",
      },
      soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
      observedAt: "2026-06-20T00:00:12.000Z",
      lastUpdatedAt: "2026-06-20T00:00:11.000Z",
    },
    recentMetrics: [
      {
        metricName: "traffic.request_arrival_rate",
        value: 12.5,
        unit: "requests_per_second",
        timestamp: "2026-06-20T00:00:11.000Z",
      },
      {
        metricName: "traffic.latency",
        value: 42,
        unit: "ms",
        timestamp: "2026-06-20T00:00:11.000Z",
      },
      {
        // Every k6 point feeds both the live aggregator and the run summary, so a positive live
        // window cannot coexist with an all-run rate of zero in `httpSummary` below.
        metricName: "traffic.failure_rate",
        value: 0,
        unit: "ratio",
        timestamp: "2026-06-20T00:00:11.000Z",
      },
    ],
    erp: {
      runId,
      circuit: {
        state: "open",
        consecutiveFailureCount: 5,
        failureThreshold: 5,
        resetTimeoutMs: 10_000,
        openedAt: "2026-06-20T00:00:09.000Z",
        nextAttemptAt: "2026-06-20T00:00:19.000Z",
        halfOpenProbeInFlight: false,
        lastChangedAt: "2026-06-20T00:00:10.000Z",
      },
      circuitReadStatus: "available",
      // Read from the same attempt table as the windowed counts below, so attempts inside the
      // window always come with a latest attempt. The breaker opened on this one.
      latestAttempt: { runId, status: "failed", finishedAt: "2026-06-20T00:00:09.000Z" },
      recentAttemptWindowSeconds: 60,
      recentAttemptCount: 3,
      recentFailureCount: 2,
      recentTimeoutCount: 1,
      observedAt: "2026-06-20T00:00:11.000Z",
    },
    systemStatus: {
      queue: {
        name: "orders:process",
        connectivity: "reachable",
        depth: 2,
        counts: { waiting: 2, prioritized: 0, paused: 0, delayed: 0, active: 0, failed: 0 },
        oldestWaitingAgeSeconds: null,
        retryPressure: {
          inspectedJobCount: 2,
          inspectionLimit: 100,
          retryingJobCount: 1,
          retryAttemptCount: 2,
          inspectionTruncated: false,
        },
        failedJobs: {
          totalCount: 0,
          recent: [],
          inspectionLimit: 20,
          inspectionTruncated: false,
        },
        observedAt: "2026-06-20T00:00:11.000Z",
      },
      erpProtection: {
        status: "degraded",
        reason: "erp_retries_pending",
        circuit: {
          state: "closed",
          consecutiveFailureCount: 0,
          failureThreshold: 5,
          resetTimeoutMs: 10_000,
          openedAt: null,
          nextAttemptAt: null,
          halfOpenProbeInFlight: false,
          lastChangedAt: "2026-06-19T16:00:10.000Z",
        },
        retryPressure: {
          retryingJobCount: 1,
          retryAttemptCount: 2,
          inspectedJobCount: 2,
          inspectionLimit: 100,
          inspectionTruncated: false,
        },
        observedAt: "2026-06-20T00:00:11.000Z",
      },
    },
    businessOutcome: {
      acceptedReservations: 6,
      reservedUnits: 6,
      soldOutRejections: 2,
      queuedOrders: 1,
      processingOrders: 1,
      retryingOrders: 1,
      confirmedOrders: 2,
      // One order per reservation, so the four statuses account for all six: 1 queued, 1
      // processing (the retrying one), 2 confirmed, 2 failed.
      failedOrders: 2,
      pendingPersistenceCount: 0,
      notificationsRecorded: 2,
    },
    consistencyLag: {
      confirmedOrderCount: 2,
      // The one queued and the one processing order; the retrying order is that processing one.
      pendingConfirmationCount: 2,
      averageLagMs: 225,
      p95LagMs: 350,
      maxLagMs: 375,
      oldestPendingAgeSeconds: 8.5,
      measuredAt: "2026-06-20T00:00:10.000Z",
    },
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
    recoveredAt: "2026-06-20T00:00:11.000Z",
  };
}

/** The same run one moment later, with terminal transport evidence recognizable as draining. */
function drainingProjectionFixture(): DashboardProjection {
  const projection = projectionFixture();
  const currentRun = projection.currentRun;
  if (currentRun?.status !== "active") {
    throw new Error("Expected an active run fixture.");
  }
  projection.currentRun = {
    ...currentRun,
    status: "draining",
    trafficStatus: "succeeded",
    trafficEndedAt: "2026-06-20T00:00:11.000Z",
  };
  projection.transportAttemptCounts = {
    plannedRequests: 1_000,
    startedRequests: 900,
    completedRequests: 850,
    interruptedRequests: 50,
    unstartedRequests: 100,
  };
  // Generator-observed replies and durable records are separate populations, and this run's
  // coverage is partial (100 attempts never started, 50 never completed), so
  // `accepted_responses_vs_unique_reservations` in `packages/contracts/src/run-result.ts:287`
  // classifies the difference as evidence_incomplete rather than a contradiction.
  projection.httpSummary = {
    failedRequests: 0,
    acceptedResponses: 0,
    soldOutResponses: 0,
    transportFailures: 0,
    unexpectedResponses: 0,
    failureRate: 0,
  };
  projection.requestArrivalSummary = {
    firstAttemptStartedAt: "2026-06-20T00:00:00.000Z",
    peakArrivalRatePerSecond: 1_000,
    peakArrivalWindowSeconds: 1,
    dispatchDurationSeconds: 0.8,
    arrivalRateSeries: [
      {
        windowStartedAt: "2026-06-20T00:00:00.000Z",
        ratePerSecond: 1_000,
      },
    ],
    arrivalWindowCountObserved: 1,
    arrivalWindowCountRetained: 1,
    arrivalSeriesLimit: 120,
  };

  return projection;
}
