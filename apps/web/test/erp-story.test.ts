import type {
  ErpCircuitBreakerSnapshot,
  ErpCircuitState,
  RunErpOutcomeSummary,
  SharedErpProtectionStatus,
} from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";
import { deriveRunErpStory, deriveSharedErpStory } from "../src/app/lib/presentation/erp-story.js";

const pendingProtectionSentence =
  "Simulated-ERP protection state has not been reported for these calls";

/**
 * The exact retry-pressure object `SharedErpProtectionService.getStatus` substitutes when the queue
 * read throws (`apps/api/src/services/erp-status-service.ts`). It is the only shape that can
 * accompany `retry_pressure_unavailable`: every count is a fixed fallback rather than an
 * observation, so a fixture must not pretend the inspection fields hold real queue data.
 */
const queueReadFailureRetryPressure = {
  retryingJobCount: 0,
  retryAttemptCount: 0,
  inspectedJobCount: 0,
  inspectionLimit: 1,
  inspectionTruncated: false,
} as const;

describe("simulated-ERP story", () => {
  it.each([
    { name: "no failures or timeouts", failures: 0, timeouts: 0, expected: "Keeping up" },
    { name: "a failure", failures: 1, timeouts: 0, expected: "Constrained but keeping up" },
    { name: "a timeout", failures: 0, timeouts: 1, expected: "Constrained but keeping up" },
  ])("reads a normal run circuit with $name as $expected", ({ failures, timeouts, expected }) => {
    const story = deriveRunErpStory(
      runErp({
        circuit: circuit("closed"),
        recentAttemptCount: 5,
        recentFailureCount: failures,
        recentTimeoutCount: timeouts,
      }),
    );

    expect(story.sentence).toBe(expected);
    // Normal operation has no scheduled action, and filler would be the only alternative.
    expect(story.nextAction).toBeNull();
  });

  // The breaker schedules nothing: `nextAttemptAt` is the earliest moment an arriving call would be
  // let through, so the copy states eligibility and never books an event.
  it("leads with protection and when calls become eligible again while calls are paused", () => {
    const story = deriveRunErpStory(
      runErp({ circuit: circuit("open", { nextAttemptAt: "2026-06-20T00:00:19.000Z" }) }),
    );

    expect(story.sentence).toBe("Calls paused to protect the simulated ERP");
    expect(story.nextAction).toBe("Calls can be retried from 2026-06-20 00:00:19 UTC");
    expect(story.nextAction).not.toContain("Recovery test at");
    expect(story.nextAction).not.toContain("scheduled");
  });

  /**
   * A contract-level case, not one today's worker emits: `erpCircuitBreakerSnapshotSchema` declares
   * `nextAttemptAt` nullable, while the current breaker always derives one for an open circuit. The
   * branch exists because the panel must never fill the gap with a different clock if that ever
   * changes, so the fixture is deliberately a schema-valid shape rather than a produced one.
   */
  it("reports the retry time as unavailable rather than substituting another clock", () => {
    const startedAt = "2026-06-20T00:00:00.000Z";
    const story = deriveRunErpStory(
      runErp({
        circuit: circuit("open", {
          nextAttemptAt: null,
          openedAt: startedAt,
          lastChangedAt: startedAt,
        }),
      }),
    );

    expect(story.sentence).toBe("Calls paused to protect the simulated ERP");
    expect(story.nextAction).toBe("Retry time unavailable");
    expect(story.nextAction).not.toContain("UTC");
    expect(story.nextAction).not.toContain("scheduled");
  });

  // `halfOpenProbeInFlight` is true only while a probe call is executing, so half-open has two
  // genuinely different readings.
  it.each([
    {
      name: "a probe is executing",
      halfOpenProbeInFlight: true,
      expected: "Watching the test call now running",
    },
    {
      name: "the breaker awaits the next call",
      halfOpenProbeInFlight: false,
      expected: "The next call will test recovery",
    },
  ])("distinguishes half-open sub-states when $name", ({ halfOpenProbeInFlight, expected }) => {
    const story = deriveRunErpStory(
      runErp({ circuit: circuit("half_open", { halfOpenProbeInFlight }) }),
    );

    expect(story.sentence).toBe("Testing recovery");
    expect(story.nextAction).toBe(expected);
  });

  it.each([
    { name: "a missing run summary", erp: null },
    {
      name: "a run with no retained protection state and no calls",
      erp: runErp({ circuit: null, recentAttemptCount: 0 }),
    },
  ])("reports $name as field-specific absence without an error tone", ({ erp }) => {
    const story = deriveRunErpStory(erp);

    expect(story.sentence).toBe("No recent simulated-ERP activity");
    expect(story.nextAction).toBeNull();
  });

  // Snapshot publication is best-effort in the worker's circuit breaker and run-scoped snapshots
  // expire, so a missing snapshot never proves protection stayed closed.
  it.each([
    { name: "an active run", runStatus: "active" as const, expected: pendingProtectionSentence },
    {
      name: "a draining run",
      runStatus: "draining" as const,
      expected: pendingProtectionSentence,
    },
    { name: "an unknown lifecycle", runStatus: null, expected: pendingProtectionSentence },
    {
      name: "a completed run",
      runStatus: "completed" as const,
      expected: "No simulated-ERP protection state was retained for this run",
    },
    {
      name: "a failed run",
      runStatus: "failed" as const,
      expected: "No simulated-ERP protection state was retained for this run",
    },
  ])("neither claims health nor denies calls when $name has no retained snapshot", ({
    runStatus,
    expected,
  }) => {
    const story = deriveRunErpStory(
      runErp({ circuit: null, recentAttemptCount: 4, recentFailureCount: 2 }),
      runStatus,
    );

    expect(story.sentence).toBe(expected);
    expect(story.sentence).not.toContain("Keeping up");
    expect(story.nextAction).toBeNull();
  });

  it("separates an unreadable protection state from an absence of activity", () => {
    const story = deriveRunErpStory(
      runErp({ circuit: null, circuitReadStatus: "unavailable", recentAttemptCount: 3 }),
    );

    expect(story.sentence).toBe("Simulated-ERP protection state is unavailable");
    expect(story.nextAction).toBeNull();
  });

  // Each case below is a status/reason pair `deriveSharedProtectionState` in the API's ERP status
  // service actually emits. The shared sentence translates that authoritative interpretation
  // instead of re-deriving health from the raw fields behind it.
  it.each([
    {
      name: "a healthy shared runtime",
      protection: sharedProtection({ status: "healthy", reason: null }),
      expected: "Keeping up",
    },
    {
      name: "pending ERP retries",
      protection: sharedProtection({
        status: "degraded",
        reason: "erp_retries_pending",
        retryingJobCount: 2,
      }),
      expected: "Constrained but keeping up",
    },
    {
      name: "an unreadable circuit state",
      protection: sharedProtection({
        status: "unavailable",
        reason: "circuit_state_unavailable",
        circuit: null,
      }),
      expected: "Simulated-ERP protection state is unavailable",
    },
    {
      name: "a missing circuit snapshot",
      protection: sharedProtection({
        status: "degraded",
        reason: "circuit_state_missing",
        circuit: null,
      }),
      expected: "Simulated-ERP protection state is not being reported",
    },
    {
      name: "an unreadable retry count",
      protection: sharedProtection({
        status: "degraded",
        reason: "retry_pressure_unavailable",
        retryPressure: queueReadFailureRetryPressure,
      }),
      expected: "Simulated-ERP retry status is unavailable",
    },
    {
      // Deliberately not a reason the service emits: this pins the defensive default branch, since
      // `reason` is a plain nullable string in the contract rather than a closed enum.
      name: "an unrecognised degraded reason",
      protection: sharedProtection({ status: "degraded", reason: "something_new" }),
      expected: "Simulated-ERP protection needs attention",
    },
    {
      name: "a missing shared status",
      protection: null,
      expected: "No recent simulated-ERP activity",
    },
  ])("reads $name as $expected", ({ protection, expected }) => {
    const story = deriveSharedErpStory(protection);

    expect(story.sentence).toBe(expected);
    expect(story.nextAction).toBeNull();
  });

  it("never reads a zeroed retry count as calm when the queue read failed", () => {
    const story = deriveSharedErpStory(
      sharedProtection({
        status: "degraded",
        reason: "retry_pressure_unavailable",
        circuit: circuit("closed"),
        retryPressure: queueReadFailureRetryPressure,
      }),
    );

    expect(story.sentence).not.toBe("Keeping up");
    expect(story.sentence).toBe("Simulated-ERP retry status is unavailable");
  });

  it("uses the same paused sentence and retry eligibility copy for the shared runtime", () => {
    const story = deriveSharedErpStory(
      sharedProtection({
        status: "unavailable",
        reason: "circuit_open",
        circuit: circuit("open", { nextAttemptAt: "2026-06-20T00:00:19.000Z" }),
      }),
    );

    expect(story.sentence).toBe("Calls paused to protect the simulated ERP");
    expect(story.nextAction).toBe("Calls can be retried from 2026-06-20 00:00:19 UTC");
    expect(story.nextAction).not.toContain("scheduled");
  });

  /** The same schema-valid, not-currently-produced shape as the run-scoped case above. */
  it("reports the shared retry time as unavailable when the snapshot carries no such time", () => {
    const story = deriveSharedErpStory(
      sharedProtection({
        status: "unavailable",
        reason: "circuit_open",
        circuit: circuit("open", { nextAttemptAt: null }),
      }),
    );

    expect(story.nextAction).toBe("Retry time unavailable");
    expect(story.nextAction).not.toContain("UTC");
  });

  it.each([
    {
      name: "a probe is executing",
      halfOpenProbeInFlight: true,
      expected: "Watching the test call now running",
    },
    {
      name: "the breaker awaits the next call",
      halfOpenProbeInFlight: false,
      expected: "The next call will test recovery",
    },
  ])("distinguishes shared half-open sub-states when $name", ({
    halfOpenProbeInFlight,
    expected,
  }) => {
    const story = deriveSharedErpStory(
      sharedProtection({
        status: "degraded",
        reason: "circuit_half_open",
        circuit: circuit("half_open", { halfOpenProbeInFlight }),
      }),
    );

    expect(story.sentence).toBe("Testing recovery");
    expect(story.nextAction).toBe(expected);
  });

  it("omits the recovery action when the probe state is not readable", () => {
    const story = deriveSharedErpStory(
      sharedProtection({ status: "degraded", reason: "circuit_half_open", circuit: null }),
    );

    expect(story.sentence).toBe("Testing recovery");
    // Neither sub-state may be assumed without a snapshot, so no line beats a silent default.
    expect(story.nextAction).toBeNull();
  });
});

function circuit(
  state: ErpCircuitState,
  overrides: Partial<ErpCircuitBreakerSnapshot> = {},
): ErpCircuitBreakerSnapshot {
  return {
    state,
    consecutiveFailureCount: state === "closed" ? 0 : 5,
    failureThreshold: 5,
    resetTimeoutMs: 10_000,
    openedAt: state === "closed" ? null : "2026-06-20T00:00:09.000Z",
    nextAttemptAt: state === "open" ? "2026-06-20T00:00:19.000Z" : null,
    halfOpenProbeInFlight: state === "half_open",
    lastChangedAt: "2026-06-20T00:00:10.000Z",
    ...overrides,
  };
}

function runErp(overrides: Partial<RunErpOutcomeSummary> = {}): RunErpOutcomeSummary {
  const runId = "11111111-1111-4111-8111-111111111111";
  const recentAttemptCount = overrides.recentAttemptCount ?? 5;

  return {
    runId,
    circuit: circuit("closed"),
    circuitReadStatus: "available",
    // The latest attempt and the windowed counts are read from the same attempt table, so a run
    // with attempts inside the window always has a latest one.
    latestAttempt:
      recentAttemptCount > 0
        ? { runId, status: "succeeded", finishedAt: "2026-06-20T00:00:10.500Z" }
        : null,
    recentAttemptWindowSeconds: 60,
    recentAttemptCount,
    recentFailureCount: 0,
    recentTimeoutCount: 0,
    observedAt: "2026-06-20T00:00:11.000Z",
    ...overrides,
  };
}

/**
 * `retryingJobCount` is a shorthand for a successful queue read; pass `retryPressure` directly for
 * shapes that a successful read cannot produce.
 */
function sharedProtection(
  overrides: Partial<SharedErpProtectionStatus> & { retryingJobCount?: number } = {},
): SharedErpProtectionStatus {
  const { retryingJobCount = 0, ...rest } = overrides;
  return {
    status: "healthy",
    reason: null,
    circuit: circuit("closed"),
    retryPressure: {
      retryingJobCount,
      retryAttemptCount: retryingJobCount,
      inspectedJobCount: 10,
      inspectionLimit: 100,
      inspectionTruncated: false,
    },
    observedAt: "2026-06-20T00:00:11.000Z",
    ...rest,
  };
}
