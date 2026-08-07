import {
  type DashboardProjection,
  type DemoRunSnapshot,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { describe, expect, it } from "vitest";
import {
  deriveWatchAnnouncements,
  type WatchAnnouncementSnapshot,
  type WatchAnnouncementTracking,
} from "../src/app/lib/presentation/watch-announcements.js";
import { deriveWatchComposition } from "../src/app/lib/presentation/watch-composition.js";

describe("watch announcements", () => {
  it("seeds a mid-run baseline and duplicate render without announcing existing facts", () => {
    const snapshot = watchSnapshot(projection(run("active")), "connected", false);
    const seeded = deriveWatchAnnouncements(null, snapshot);

    expect(seeded.announcements).toEqual({});
    expect(deriveWatchAnnouncements(seeded.tracking, { ...snapshot }).announcements).toEqual({});
  });

  it("silently seeds the first run after checking, then announces a genuinely newer run", () => {
    let result = deriveWatchAnnouncements(null, checkingSnapshot());
    const firstRun = projection(run("active"), {
      businessOutcome: businessOutcome(1),
      inventory: inventory(10, 0),
    });

    result = deriveWatchAnnouncements(result.tracking, watchSnapshot(firstRun, "connected", false));
    expect(result.announcements).toEqual({});
    expect(next(result.tracking, firstRun).announcements).toEqual({});

    const secondRun = projection(run("starting", "66666666-6666-4666-8666-666666666666"));
    expect(next(result.tracking, secondRun).announcements.lifecycle).toBe(
      "Preparing checkout traffic.",
    );
  });

  it("announces a run that starts after checking resolves to idle", () => {
    let result = deriveWatchAnnouncements(null, checkingSnapshot());
    result = deriveWatchAnnouncements(
      result.tracking,
      watchSnapshot(projection(null), "connected", false),
    );
    expect(result.announcements).toEqual({});

    expect(next(result.tracking, projection(run("starting"))).announcements.lifecycle).toBe(
      "Preparing checkout traffic.",
    );
  });

  it("announces lifecycle phases forward once and ignores duplicate or regressive frames", () => {
    let tracking = seed(projection(run("starting")));

    ({ tracking } = expectAnnouncement(
      tracking,
      projection(run("active")),
      "Checkout attempts are being accepted.",
    ));
    ({ tracking } = expectAnnouncement(
      tracking,
      projection(run("draining")),
      "Checkout attempts have finished; accepted reservations are still moving to final confirmation.",
    ));

    expect(next(tracking, projection(run("draining"))).announcements).toEqual({});
    expect(next(tracking, projection(run("active"))).announcements).toEqual({});
  });

  it("announces sellout and the first durable order failure once per run", () => {
    let tracking = seed(projection(run("active")));
    const soldOut = projection(run("active"), {
      inventory: inventory(10, 0),
    });
    let result = next(tracking, soldOut);
    tracking = result.tracking;
    expect(result.announcements.milestone).toBe(
      "All 10 units are now reserved — the sale is sold out.",
    );
    expect(next(tracking, soldOut).announcements).toEqual({});

    const failedOrder = projection(run("active"), { businessOutcome: businessOutcome(1) });
    result = next(tracking, failedOrder);
    tracking = result.tracking;
    expect(result.announcements.milestone).toBe(
      "The first durable order failure has been recorded.",
    );
    expect(next(tracking, failedOrder).announcements).toEqual({});
  });

  it("announces only a known disconnect edge and its reconnect", () => {
    const active = projection(run("active"));
    let tracking = seed(active, "connecting");

    let result = next(tracking, active, "connected");
    tracking = result.tracking;
    expect(result.announcements).toEqual({});

    result = next(tracking, active, "disconnected");
    tracking = result.tracking;
    expect(result.announcements.connection).toContain("Live updates are interrupted.");
    expect(next(tracking, active, "disconnected").announcements).toEqual({});

    result = next(tracking, active, "connected");
    tracking = result.tracking;
    expect(result.announcements.connection).toBe("Live updates restored.");
    expect(next(tracking, active, "connected").announcements).toEqual({});
  });

  it("retains terminal identity across idle and retained-recap handoffs", () => {
    const active = projection(run("active"));
    const completed = projection(run("completed"));
    let tracking = seed(active);

    const terminal = next(tracking, completed);
    tracking = terminal.tracking;
    expect(terminal.announcements.terminal).toContain("Run completed.");
    expect(next(tracking, projection(null)).announcements).toEqual({});
    expect(next(tracking, completed).announcements).toEqual({});
  });

  it("resets milestones for a newer run without reannouncing the previous terminal recap", () => {
    const firstRun = run("active");
    let tracking = seed(projection(firstRun, { inventory: inventory(10, 0) }));
    const completed = projection(run("completed"));
    tracking = next(tracking, completed).tracking;

    const secondRun = run("starting", "66666666-6666-4666-8666-666666666666");
    const started = next(tracking, projection(secondRun));
    tracking = started.tracking;
    expect(started.announcements.lifecycle).toBe("Preparing checkout traffic.");

    expect(
      next(tracking, projection(run("active", secondRun.runId), { inventory: inventory(10, 0) }))
        .announcements.milestone,
    ).toContain("sold out");
    expect(next(tracking, completed).announcements.terminal).toBeUndefined();
  });
});

const runId = "11111111-1111-4111-8111-111111111111";
const saleOfferId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-07-30T12:00:04.000Z");

function seed(
  currentProjection: DashboardProjection,
  transportStatus: WatchAnnouncementSnapshot["transportStatus"] = "connected",
): WatchAnnouncementTracking {
  return deriveWatchAnnouncements(null, watchSnapshot(currentProjection, transportStatus, false))
    .tracking;
}

function next(
  tracking: WatchAnnouncementTracking,
  currentProjection: DashboardProjection,
  transportStatus: WatchAnnouncementSnapshot["transportStatus"] = "connected",
) {
  return deriveWatchAnnouncements(
    tracking,
    watchSnapshot(currentProjection, transportStatus, false),
  );
}

function expectAnnouncement(
  tracking: WatchAnnouncementTracking,
  currentProjection: DashboardProjection,
  message: string,
) {
  const result = next(tracking, currentProjection);
  expect(result.announcements.lifecycle).toBe(message);
  return result;
}

function watchSnapshot(
  currentProjection: DashboardProjection,
  transportStatus: WatchAnnouncementSnapshot["transportStatus"],
  retriesExhausted: boolean,
): WatchAnnouncementSnapshot {
  return {
    composition: deriveWatchComposition({
      recovery: { status: "available", data: currentProjection, httpStatus: 200 },
      retainedTerminalRun: null,
      latestCompletedRun: { status: "available", data: null },
      signalSamples: [],
      transportStatus,
      now,
    }),
    retriesExhausted,
    transportStatus,
  };
}

function checkingSnapshot(): WatchAnnouncementSnapshot {
  return {
    composition: deriveWatchComposition({
      recovery: { status: "loading" },
      retainedTerminalRun: null,
      latestCompletedRun: { status: "available", data: null },
      signalSamples: [],
      transportStatus: "connecting",
      now,
    }),
    retriesExhausted: false,
    transportStatus: "connecting",
  };
}

function run(status: DemoRunSnapshot["status"], id = runId): DemoRunSnapshot {
  const base = {
    runId: id,
    presetId: "22222222-2222-4222-8222-222222222222",
    presetName: "Preview 1k",
    operatorMode: "public" as const,
    saleOfferId,
    configSnapshot: previewRunConfigSnapshotFixture(),
    startedAt: "2026-07-30T12:00:00.000Z",
  };
  if (status === "starting") return { ...base, status, trafficStatus: "starting" };
  if (status === "active") {
    return { ...base, status, trafficStatus: "active", trafficStartedAt: base.startedAt };
  }
  if (status === "draining") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: base.startedAt,
      trafficEndedAt: "2026-07-30T12:00:01.000Z",
    };
  }
  if (status === "completed") {
    return {
      ...base,
      status,
      trafficStatus: "succeeded",
      trafficStartedAt: base.startedAt,
      trafficEndedAt: "2026-07-30T12:00:01.000Z",
      finalizedAt: "2026-07-30T12:00:02.000Z",
    };
  }
  return {
    ...base,
    status,
    trafficStatus: "failed",
    trafficStartedAt: base.startedAt,
    trafficEndedAt: "2026-07-30T12:00:01.000Z",
    finalizedAt: "2026-07-30T12:00:02.000Z",
    failureCategory: "traffic",
  };
}

function projection(
  currentRun: DemoRunSnapshot | null,
  overrides: Partial<DashboardProjection> = {},
): DashboardProjection {
  const scope = currentRun ? { runId: currentRun.runId, saleOfferId } : null;
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    correlationId: "corr-watch-announcements",
    scopeId: dashboardProjectionScopeId(scope),
    scope,
    revision: 1,
    recoveredAt: "2026-07-30T12:00:03.000Z",
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
    ...overrides,
  };
}

function inventory(allocatedStock: number, remainingStock: number) {
  return {
    saleOfferId,
    allocatedStock,
    remainingStock,
    reservedStock: allocatedStock - remainingStock,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    reservationThroughput: {
      windowSeconds: 10,
      successfulReservationCount: allocatedStock - remainingStock,
      peakRatePerSecond: 1,
      peakWindowSeconds: 1 as const,
      unit: "reservations_per_second" as const,
      measuredAt: "2026-07-30T12:00:03.000Z",
    },
    soldOutPressure: { rejectionCount: 0, latestObservedAt: null },
    observedAt: "2026-07-30T12:00:03.000Z",
    lastUpdatedAt: "2026-07-30T12:00:03.000Z",
  };
}

function businessOutcome(failedOrders: number) {
  return {
    acceptedReservations: 1,
    reservedUnits: 1,
    soldOutRejections: 0,
    queuedOrders: 0,
    processingOrders: 0,
    retryingOrders: 0,
    confirmedOrders: 0,
    failedOrders,
    pendingPersistenceCount: 0,
    notificationsRecorded: 0,
  };
}
