import type {
  DemoRunStatus,
  RunErpOutcomeSummary,
  SharedErpProtectionStatus,
} from "@checkout-surge/contracts";
import { formatInstantUtc } from "./format";
import { isRunEvidenceSettled } from "./public-vocabulary";

/**
 * The one public sentence each simulated-ERP surface leads with, plus the next meaningful action.
 *
 * This lives beside `run-presentation-state.ts` rather than inside it because that module derives
 * `PresentationState` for status pills (state name, tone, label, description). The ERP story is a
 * different output: reader-facing panel copy with no tone and an optional second line. Two
 * components consume it — the run-scoped panel and the shared-runtime protection column — so the
 * state-to-copy rules belong in one shared helper rather than in either component.
 *
 * The two sources carry different evidence and deliberately do not share one derivation path; they
 * share the copy, which is the reason this helper exists. `RunErpOutcomeSummary` publishes a raw
 * breaker snapshot plus attempt counts and no interpretation, so the run sentence is derived here.
 * `SharedErpProtectionStatus` is published by a service that has already interpreted the same raw
 * fields into `status`/`reason`; that interpretation is authoritative, so the shared sentence
 * translates it instead of re-deriving health from the fields behind it.
 */
export interface ErpStory {
  /** The leading sentence. Always present; absence is expressed as a sentence, not as `null`. */
  sentence: string;
  /**
   * The next meaningful action, or `null` when there is none to state. A normal circuit has no
   * scheduled action, and inventing one ("nothing to do", a run-start timestamp) would be filler.
   */
  nextAction: string | null;
}

const erpStorySentence = {
  paused: "Calls paused to protect the simulated ERP",
  testingRecovery: "Testing recovery",
  constrained: "Constrained but keeping up",
  keepingUp: "Keeping up",
  /** Field-specific absence: no error tone, and no claim about health. */
  noActivity: "No recent simulated-ERP activity",
  /** A read failure is a different fact from an absence of activity, so it gets its own sentence. */
  protectionUnreadable: "Simulated-ERP protection state is unavailable",
  /**
   * Calls happened, but no protection snapshot backs them. Snapshot publication is best-effort in
   * the worker's circuit breaker and run-scoped snapshots expire, so a missing snapshot is not
   * evidence that protection stayed closed. These sentences therefore neither claim health nor
   * deny the activity the attempt counts already prove.
   */
  protectionUnreportedPending:
    "Simulated-ERP protection state has not been reported for these calls",
  protectionUnreportedSettled: "No simulated-ERP protection state was retained for this run",
  protectionUnreportedShared: "Simulated-ERP protection state is not being reported",
  /** Retry counts fall back to zero when the queue read fails, so zero cannot be read as calm. */
  retryStatusUnavailable: "Simulated-ERP retry status is unavailable",
  /** Mirrors the shared protection vocabulary for a degraded state this helper does not recognise. */
  needsAttention: "Simulated-ERP protection needs attention",
} as const;

/**
 * Nothing schedules a recovery probe. `ErpCircuitBreaker.snapshot()` derives `nextAttemptAt` as
 * `openedAt + resetTimeoutMs`, and the move out of `open` happens only inside
 * `enterHalfOpenIfReady()`, which runs when `confirm()` is called. The timestamp is therefore the
 * earliest moment a call would be let through *if one arrives*: with an empty queue no test ever
 * happens. This copy states that eligibility and must not be "corrected" back into a booked event.
 */
const retryEligibleFrom = (readableTime: string) => `Calls can be retried from ${readableTime}`;
const retryTimeUnavailable = "Retry time unavailable";

/**
 * Half-open has two sub-states. `halfOpenProbeInFlight` is true only while a probe call is actually
 * executing (set before the call, cleared in `finally`, with concurrent calls rejected meanwhile);
 * otherwise the breaker is simply waiting for the next call to serve as the test.
 */
const watchingProbeInFlight = "Watching the test call now running";
const awaitingRecoveryProbe = "The next call will test recovery";

export function deriveRunErpStory(
  erp: RunErpOutcomeSummary | null,
  runStatus: DemoRunStatus | null = null,
): ErpStory {
  if (!erp) return sentenceOnly(erpStorySentence.noActivity);

  if (erp.circuit) {
    switch (erp.circuit.state) {
      case "open":
        return {
          sentence: erpStorySentence.paused,
          nextAction: retryEligibilityAction(erp.circuit.nextAttemptAt),
        };
      case "half_open":
        return {
          sentence: erpStorySentence.testingRecovery,
          nextAction: recoveryTestingAction(erp.circuit.halfOpenProbeInFlight),
        };
      case "closed":
        // The only threshold this helper owns: any failure or timeout inside the run's own attempt
        // window is strain. A tunable health score would be over-engineering for this panel.
        return normalOperationStory(erp.recentFailureCount + erp.recentTimeoutCount > 0);
    }
  }
  if (erp.circuitReadStatus === "unavailable") {
    return sentenceOnly(erpStorySentence.protectionUnreadable);
  }
  if (erp.recentAttemptCount > 0) {
    // A04's lifecycle rule decides whether the missing snapshot may still arrive: durable
    // processing keeps producing evidence until the run is terminal, so only a settled run may say
    // the state was never retained.
    return sentenceOnly(
      runStatus !== null && isRunEvidenceSettled(runStatus, "durable-processing")
        ? erpStorySentence.protectionUnreportedSettled
        : erpStorySentence.protectionUnreportedPending,
    );
  }

  return sentenceOnly(erpStorySentence.noActivity);
}

/**
 * Whether the run's ERP story expresses waiting or uncertainty rather than settled fact: paused
 * calls, a recovery test in progress, an unreadable protection read, protection state still
 * unreported while the run keeps producing evidence, or an unavailable retry read. False for
 * keeping up, constrained-but-coping, and a genuine no-activity absence — none of those explains
 * a delay a reader might be waiting on.
 */
export function erpStoryExplainsWaiting(
  erp: RunErpOutcomeSummary | null,
  runStatus: DemoRunStatus | null = null,
): boolean {
  const story = deriveRunErpStory(erp, runStatus);
  return (
    story.nextAction !== null ||
    story.sentence === erpStorySentence.protectionUnreadable ||
    story.sentence === erpStorySentence.protectionUnreportedPending ||
    story.sentence === erpStorySentence.retryStatusUnavailable
  );
}

/**
 * Translates the shared protection state the API service publishes. Every `reason` below is a case
 * that service emits; switching on it is what keeps a partial read ("retry pressure could not be
 * counted") from being presented as a calm reading of zero.
 */
export function deriveSharedErpStory(protection: SharedErpProtectionStatus | null): ErpStory {
  if (!protection) return sentenceOnly(erpStorySentence.noActivity);

  switch (protection.reason) {
    case null:
      return sentenceOnly(
        protection.status === "healthy"
          ? erpStorySentence.keepingUp
          : erpStorySentence.needsAttention,
      );
    case "circuit_open":
      return {
        sentence: erpStorySentence.paused,
        nextAction: retryEligibilityAction(protection.circuit?.nextAttemptAt ?? null),
      };
    case "circuit_half_open":
      return {
        sentence: erpStorySentence.testingRecovery,
        // Without a snapshot the probe state is unknown, and neither sub-state may be assumed:
        // omit the action rather than defaulting to one.
        nextAction: protection.circuit
          ? recoveryTestingAction(protection.circuit.halfOpenProbeInFlight)
          : null,
      };
    case "circuit_state_unavailable":
      return sentenceOnly(erpStorySentence.protectionUnreadable);
    case "circuit_state_missing":
      return sentenceOnly(erpStorySentence.protectionUnreportedShared);
    case "retry_pressure_unavailable":
      return sentenceOnly(erpStorySentence.retryStatusUnavailable);
    case "erp_retries_pending":
      // The service has already decided that pending ERP retries are the degradation, so the copy
      // states coping under strain rather than failure.
      return sentenceOnly(erpStorySentence.constrained);
    default:
      return sentenceOnly(erpStorySentence.needsAttention);
  }
}

function normalOperationStory(isStrained: boolean): ErpStory {
  return sentenceOnly(isStrained ? erpStorySentence.constrained : erpStorySentence.keepingUp);
}

function retryEligibilityAction(nextAttemptAt: string | null): string {
  const eligibleFrom = formatInstantUtc(nextAttemptAt);
  return eligibleFrom === null ? retryTimeUnavailable : retryEligibleFrom(eligibleFrom);
}

function recoveryTestingAction(halfOpenProbeInFlight: boolean): string {
  return halfOpenProbeInFlight ? watchingProbeInFlight : awaitingRecoveryProbe;
}

function sentenceOnly(sentence: string): ErpStory {
  return { sentence, nextAction: null };
}
