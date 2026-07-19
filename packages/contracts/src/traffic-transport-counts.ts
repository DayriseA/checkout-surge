import { z } from "zod";
import { nonnegativeIntegerSchema } from "./primitives.js";

/**
 * Canonical transport-attempt accounting for generated load traffic.
 *
 * These five counts describe client-side attempts truthfully:
 * - `plannedRequests`: configured number of client attempts.
 * - `startedRequests`: attempts for which the generated script incremented a
 *   counter immediately before calling `http.post()`.
 * - `completedRequests`: attempts for which `http.post()` returned to script
 *   code and the script incremented a completion counter.
 * - `interruptedRequests`: started attempts that did not reach the
 *   response-completed counter before shutdown.
 * - `unstartedRequests`: planned attempts that never reached the
 *   attempt-started counter.
 *
 * A started attempt is client-side evidence only; it must never be relabeled
 * as "API received". The reconciliation equations are:
 *
 *   plannedRequests = startedRequests + unstartedRequests
 *   startedRequests = completedRequests + interruptedRequests
 */
export const transportAttemptCountsShape = {
  plannedRequests: nonnegativeIntegerSchema,
  startedRequests: nonnegativeIntegerSchema,
  completedRequests: nonnegativeIntegerSchema,
  interruptedRequests: nonnegativeIntegerSchema,
  unstartedRequests: nonnegativeIntegerSchema,
} as const;

export interface TransportAttemptCounts {
  plannedRequests: number;
  startedRequests: number;
  completedRequests: number;
  interruptedRequests: number;
  unstartedRequests: number;
}

/** Reusable cross-field validation for the two transport reconciliation equations. */
export function refineTransportAttemptCounts(
  value: TransportAttemptCounts,
  context: z.RefinementCtx,
): void {
  if (value.plannedRequests !== value.startedRequests + value.unstartedRequests) {
    context.addIssue({
      code: "custom",
      path: ["unstartedRequests"],
      message: "plannedRequests must equal startedRequests + unstartedRequests",
    });
  }
  if (value.startedRequests !== value.completedRequests + value.interruptedRequests) {
    context.addIssue({
      code: "custom",
      path: ["interruptedRequests"],
      message: "startedRequests must equal completedRequests + interruptedRequests",
    });
  }
}

export const transportAttemptCountsSchema = z
  .object(transportAttemptCountsShape)
  .strict()
  .superRefine(refineTransportAttemptCounts);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Legacy read-boundary compatibility for old HTTP summaries. The retired
 * producer recorded `emittedRequests` with completed-response semantics. The
 * best available legacy mapping is started = old `emittedRequests`,
 * completed = old `completedRequests`, with derived interrupted/unstarted
 * counts. Inconsistent historical evidence remains inconsistent and is
 * rejected by the canonical schema rather than silently rewritten. This
 * mapping must only run at explicit compatibility/migration read boundaries;
 * new producers emit the canonical names directly.
 */
export function normalizeLegacyTrafficHttpSummaryJson(value: unknown): unknown {
  if (!isPlainRecord(value) || !("emittedRequests" in value)) return value;
  if (
    !isNonnegativeFiniteNumber(value.plannedRequests) ||
    !isNonnegativeFiniteNumber(value.emittedRequests)
  ) {
    return value;
  }
  const { emittedRequests, completedRequests: legacyCompleted, ...rest } = value;
  const startedRequests = emittedRequests;
  const completedRequests = isNonnegativeFiniteNumber(legacyCompleted)
    ? legacyCompleted
    : startedRequests;
  return {
    ...rest,
    startedRequests,
    completedRequests,
    interruptedRequests: startedRequests - completedRequests,
    unstartedRequests: Math.max(0, value.plannedRequests - startedRequests),
  };
}

/**
 * Legacy read-boundary compatibility for old delivery summaries. Old rows
 * carry `emittedRequests` plus the retired `unstartedIterations` and
 * `requestShortfall` diagnostics but no distinct response-completion count, so
 * the only defensible mapping is started = old emitted, completed = old
 * emitted, interrupted = 0, unstarted = planned - started. Historical
 * interrupted traffic cannot be reconstructed when the old producer never
 * recorded it.
 */
export function normalizeLegacyTrafficDeliverySummaryJson(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const hasLegacyNames =
    "emittedRequests" in value || "unstartedIterations" in value || "requestShortfall" in value;
  if (!hasLegacyNames) return value;
  const {
    emittedRequests: legacyEmitted,
    unstartedIterations: _legacyUnstartedIterations,
    requestShortfall: _legacyRequestShortfall,
    ...rest
  } = value;
  if ("startedRequests" in rest) return rest;
  if (
    !isNonnegativeFiniteNumber(value.plannedRequests) ||
    !isNonnegativeFiniteNumber(legacyEmitted)
  ) {
    return value;
  }
  const startedRequests = legacyEmitted;
  return {
    ...rest,
    startedRequests,
    completedRequests: startedRequests,
    interruptedRequests: 0,
    unstartedRequests: Math.max(0, value.plannedRequests - startedRequests),
  };
}

/**
 * Legacy read-boundary compatibility for old request-lifecycle summaries,
 * which recorded the old completed-only equivalence as `{ completedRequests }`.
 * Rewrite them to the canonical five-count lifecycle view using the known
 * planned total, without inventing server-side receipt evidence.
 */
export function normalizeLegacyApiRequestLifecycleSummaryJson(
  value: Record<string, unknown>,
  plannedRequests: number,
): Record<string, unknown>;
export function normalizeLegacyApiRequestLifecycleSummaryJson(
  value: unknown,
  plannedRequests: number,
): unknown;
export function normalizeLegacyApiRequestLifecycleSummaryJson(
  value: unknown,
  plannedRequests: number,
): unknown {
  if (!isPlainRecord(value)) return value;
  if ("startedRequests" in value || !("completedRequests" in value)) return value;
  if (!isNonnegativeFiniteNumber(value.completedRequests)) return value;
  const completedRequests = value.completedRequests;
  return {
    ...value,
    plannedRequests,
    startedRequests: completedRequests,
    completedRequests,
    interruptedRequests: 0,
    unstartedRequests: Math.max(0, plannedRequests - completedRequests),
  };
}

/**
 * Renames the retired terminal started-evidence key inside persisted load-run
 * diagnostics. This is intentionally a read-boundary transform; canonical
 * diagnostics remain unchanged and new writers never emit the legacy key.
 */
export function normalizeLegacyLoadRunDiagnosticsSummaryJson(
  value: Record<string, unknown>,
): Record<string, unknown>;
export function normalizeLegacyLoadRunDiagnosticsSummaryJson(value: unknown): unknown;
export function normalizeLegacyLoadRunDiagnosticsSummaryJson(value: unknown): unknown {
  if (!isPlainRecord(value) || !isPlainRecord(value.terminalMetricSources)) return value;
  const sources = value.terminalMetricSources;
  if (!("emittedRequests" in sources)) return value;
  const { emittedRequests: legacyStartedSource, ...canonicalSources } = sources;
  return {
    ...value,
    terminalMetricSources: {
      ...canonicalSources,
      ...("startedRequests" in canonicalSources ? {} : { startedRequests: legacyStartedSource }),
    },
  };
}
