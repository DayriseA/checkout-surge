/**
 * Watch announcements use a five-second minimum polite cadence so projection bursts coalesce into
 * one utterance. Terminal and actionable announcements bypass that cadence, so their maximum
 * throttle delay is zero milliseconds (bounded only by the React commit).
 */

import type { RealtimeConnectionStatus } from "./freshness";
import { publicFailureExplanation, runResultOutcomeLabel } from "./public-vocabulary";
import type { WatchComposition } from "./watch-composition";

/** Minimum time between non-terminal polite announcements. */
export const politeAnnouncementMinimumIntervalMs = 5_000;

/** Maximum throttle delay for terminal announcements, which always bypass the polite queue. */
export const terminalAnnouncementMaximumDelayMs = 0;

type AnnouncementCategory = "lifecycle" | "milestone" | "connection";

export interface WatchAnnouncements {
  assertive?: string;
  connection?: string;
  lifecycle?: string;
  milestone?: string;
  terminal?: string;
}

export interface WatchAnnouncementTracking {
  exhaustedEpisode: boolean;
  hasResolvedBaseline: boolean;
  highestPhaseRank: number;
  orderFailureAnnounced: boolean;
  runId: string | null;
  selloutAnnounced: boolean;
  terminalRunId: string | null;
  transportStatus: RealtimeConnectionStatus;
  wasDisconnected: boolean;
}

export interface WatchAnnouncementSnapshot {
  composition: WatchComposition;
  retriesExhausted: boolean;
  transportStatus: RealtimeConnectionStatus;
}

const phaseRanks = {
  starting: 1,
  active: 2,
  draining: 3,
  completed: 4,
  failed: 4,
} as const;

export function deriveWatchAnnouncements(
  previousTracking: WatchAnnouncementTracking | null,
  snapshot: WatchAnnouncementSnapshot,
): { tracking: WatchAnnouncementTracking; announcements: WatchAnnouncements } {
  if (previousTracking === null) {
    return { tracking: seedTracking(snapshot), announcements: {} };
  }

  const announcements: WatchAnnouncements = {};
  const runComposition = compositionWithRun(snapshot.composition);
  if (!previousTracking.hasResolvedBaseline && runComposition) {
    const projection = runComposition.projection;
    const inventory = projection.inventory;
    return {
      tracking: {
        ...previousTracking,
        exhaustedEpisode: snapshot.retriesExhausted,
        hasResolvedBaseline: true,
        highestPhaseRank: phaseRanks[runComposition.phase],
        orderFailureAnnounced: (projection.businessOutcome?.failedOrders ?? 0) > 0,
        runId: runComposition.run.runId,
        selloutAnnounced:
          inventory !== null && inventory.allocatedStock > 0 && inventory.remainingStock === 0,
        terminalRunId:
          runComposition.phase === "completed" || runComposition.phase === "failed"
            ? runComposition.run.runId
            : previousTracking.terminalRunId,
        transportStatus: snapshot.transportStatus,
      },
      announcements: {},
    };
  }
  const isNewRun = runComposition !== null && runComposition.run.runId !== previousTracking.runId;
  const tracking: WatchAnnouncementTracking = {
    ...previousTracking,
    exhaustedEpisode: snapshot.retriesExhausted,
    hasResolvedBaseline:
      isResolvedComposition(snapshot.composition) || previousTracking.hasResolvedBaseline,
    highestPhaseRank: isNewRun ? 0 : previousTracking.highestPhaseRank,
    orderFailureAnnounced: isNewRun ? false : previousTracking.orderFailureAnnounced,
    runId: runComposition?.run.runId ?? previousTracking.runId,
    selloutAnnounced: isNewRun ? false : previousTracking.selloutAnnounced,
    transportStatus: snapshot.transportStatus,
  };

  if (runComposition) {
    const phaseRank = phaseRanks[runComposition.phase];
    if (phaseRank > tracking.highestPhaseRank) {
      tracking.highestPhaseRank = phaseRank;
      if (
        (runComposition.phase === "completed" || runComposition.phase === "failed") &&
        tracking.terminalRunId !== runComposition.run.runId
      ) {
        tracking.terminalRunId = runComposition.run.runId;
        announcements.terminal = terminalMessage(runComposition);
      } else if (runComposition.phase !== "completed" && runComposition.phase !== "failed") {
        announcements.lifecycle = lifecycleMessage(runComposition);
      }
    }

    const projection = runComposition.projection;
    if (
      !tracking.selloutAnnounced &&
      projection.inventory !== null &&
      projection.inventory.allocatedStock > 0 &&
      projection.inventory.remainingStock === 0
    ) {
      tracking.selloutAnnounced = true;
      announcements.milestone = `All ${projection.inventory.allocatedStock} units are now reserved — the sale is sold out.`;
    }
    if (
      !tracking.orderFailureAnnounced &&
      projection.businessOutcome !== null &&
      projection.businessOutcome.failedOrders > 0
    ) {
      tracking.orderFailureAnnounced = true;
      announcements.milestone = "The first durable order failure has been recorded.";
    }
  }

  if (
    previousTracking.transportStatus === "connected" &&
    snapshot.transportStatus === "disconnected"
  ) {
    tracking.wasDisconnected = true;
    announcements.connection =
      "Live updates are interrupted. The latest data stays visible while the connection recovers automatically.";
  } else if (
    previousTracking.wasDisconnected &&
    snapshot.transportStatus === "connected" &&
    previousTracking.transportStatus !== "connected"
  ) {
    tracking.wasDisconnected = false;
    announcements.connection = "Live updates restored.";
  }

  const retainedDataVisible =
    snapshot.composition.phase !== "checking" && snapshot.composition.phase !== "unavailable";
  if (snapshot.retriesExhausted && !previousTracking.exhaustedEpisode && retainedDataVisible) {
    return {
      tracking,
      announcements: {
        assertive:
          "Live updates could not be restored automatically. Use the retry control or reload the page.",
      },
    };
  }
  if (announcements.terminal) {
    return { tracking, announcements: { terminal: announcements.terminal } };
  }
  return { tracking, announcements };
}

export function composePoliteWatchAnnouncement(
  announcements: Partial<Record<AnnouncementCategory, string>>,
): string {
  return [announcements.lifecycle, announcements.milestone, announcements.connection]
    .filter((message): message is string => message !== undefined)
    .join(" ");
}

function seedTracking(snapshot: WatchAnnouncementSnapshot): WatchAnnouncementTracking {
  const runComposition = compositionWithRun(snapshot.composition);
  const projection = runComposition?.projection;
  const inventory = projection?.inventory;
  return {
    exhaustedEpisode: snapshot.retriesExhausted,
    hasResolvedBaseline: isResolvedComposition(snapshot.composition),
    highestPhaseRank: runComposition ? phaseRanks[runComposition.phase] : 0,
    orderFailureAnnounced: (projection?.businessOutcome?.failedOrders ?? 0) > 0,
    runId: runComposition?.run.runId ?? null,
    selloutAnnounced: inventory
      ? inventory.allocatedStock > 0 && inventory.remainingStock === 0
      : false,
    terminalRunId:
      runComposition?.phase === "completed" || runComposition?.phase === "failed"
        ? runComposition.run.runId
        : null,
    transportStatus: snapshot.transportStatus,
    wasDisconnected: false,
  };
}

function compositionWithRun(
  composition: WatchComposition,
): Exclude<WatchComposition, { phase: "checking" | "unavailable" | "idle" }> | null {
  return "run" in composition ? composition : null;
}

function isResolvedComposition(composition: WatchComposition): boolean {
  return composition.phase !== "checking" && composition.phase !== "unavailable";
}

function lifecycleMessage(
  composition: Exclude<
    WatchComposition,
    { phase: "checking" | "unavailable" | "idle" | "completed" | "failed" }
  >,
): string {
  switch (composition.phase) {
    case "starting":
    case "active":
      return composition.presentation.description;
    case "draining":
      return "Checkout attempts have finished; accepted reservations are still moving to final confirmation.";
  }
}

function terminalMessage(
  composition: Extract<WatchComposition, { phase: "completed" | "failed" }>,
): string {
  if (composition.phase === "failed" && composition.run.status === "failed") {
    return `Run failed. ${publicFailureExplanation(composition.run.failureCategory).explanation}`;
  }
  return `Run completed. ${runResultOutcomeLabel(composition.result.outcome)}.`;
}
