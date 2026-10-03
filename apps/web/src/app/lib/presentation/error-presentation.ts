import type { ErrorPayloadCode, PublicRunFailureCategory } from "@checkout-surge/contracts";
import type { BackendRead } from "../backend-read";

export type ErrorPresentationContextName =
  | "public-start"
  | "public-read"
  | "watch-read"
  | "history-read"
  | "history-detail"
  | "admin-read"
  | "admin-operation";

export type ErrorPresentationTone = "idle" | "progress" | "ok" | "warning" | "danger";
export type ErrorPresentationActionKind =
  | "none"
  | "check"
  | "retry"
  | "wait"
  | "watch"
  | "edit"
  | "sign-in"
  | "contact-operator";

export interface ErrorPresentationAction {
  kind: ErrorPresentationActionKind;
  label: string;
  href?: string;
  retryAfterMs?: number;
}

export interface ErrorTechnicalDetails {
  code?: ErrorPayloadCode;
  httpStatus?: number;
  correlationId?: string;
  reason?: string;
}

export interface ErrorPresentation {
  headline: string;
  explanation?: string;
  action: ErrorPresentationAction;
  tone: ErrorPresentationTone;
  technicalDetails?: ErrorTechnicalDetails | undefined;
  fieldErrors?: ReadonlyArray<{ field: string; message: string }>;
}

export interface ErrorPresentationContext {
  surface: ErrorPresentationContextName;
  /** Set only by a server-authorized protected surface that may disclose diagnostics. */
  protected?: boolean;
  /** Set only when presenting the outcome of a submitted public start request. */
  startRequestOutcome?: true;
  cause?:
    | "active_run_exists"
    | "reset_incomplete"
    | "projection_cleanup_incomplete"
    | "slug_in_use"
    | "not_archivable";
  budget?: "visitor" | "global";
  fieldErrors?: ReadonlyArray<{ field: string; message: string }>;
  readiness?: "degraded" | "unavailable";
  failedRunCategory?: PublicRunFailureCategory;
}

const genericPresentation = {
  headline: "Something didn't work on our side",
  explanation:
    "Try again shortly. If the problem continues, the demo may be temporarily unavailable.",
  action: { kind: "retry", label: "Check again" } as const,
  tone: "danger" as const,
};

const infrastructureRunLimitCodes = new Set([
  "deployment_buyers_exceeded",
  "deployment_duration_exceeded",
  "deployment_max_vus_exceeded",
  "deployment_preallocated_vus_exceeded",
  "deployment_request_rate_exceeded",
  "deployment_start_delay_exceeded",
  "deployment_total_requests_exceeded",
  "public_buyers_exceeded",
  "public_duration_exceeded",
  "public_max_vus_exceeded",
  "public_preallocated_vus_exceeded",
  "public_request_rate_exceeded",
  "public_total_requests_exceeded",
  "public_start_delay_exceeded",
]);

export function isInfrastructureRunLimitRejection(read: BackendRead<unknown>): boolean {
  return (
    read.status === "unavailable" &&
    read.errorCode === "invalid_run_configuration" &&
    typeof read.details?.violationCode === "string" &&
    infrastructureRunLimitCodes.has(read.details.violationCode)
  );
}

const publicStartActionCodes = new Set<ErrorPayloadCode>([
  "run_conflict",
  "public_run_budget_exceeded",
  "invalid_request",
  "invalid_run_configuration",
]);

// When returned from the start path, these mean the BFF never saw a valid API verdict,
// so a start may already have been accepted; they are uncertain outcomes, not verdicts.
const publicStartUncertainCodes = new Set<ErrorPayloadCode>([
  "backend_unavailable",
  "invalid_backend_response",
]);

/**
 * The one web boundary between canonical transport errors and user-facing copy.
 * Backend messages remain diagnostics; only this client-owned table becomes public text.
 */
export function mapErrorPresentation(
  read: BackendRead<unknown>,
  context: ErrorPresentationContextName | ErrorPresentationContext,
): ErrorPresentation {
  const resolved = withBoundedCause(
    typeof context === "string" ? { surface: context } : context,
    read,
  );
  const technicalDetails =
    (isProtectedSurface(resolved.surface) || resolved.protected === true) &&
    read.status === "unavailable"
      ? toTechnicalDetails(read)
      : undefined;

  if (read.status === "loading") {
    return {
      headline: "Checking availability",
      explanation: "Checking the latest information now.",
      action: { kind: "none", label: "" },
      tone: "idle",
    };
  }

  if (resolved.readiness) {
    return readinessPresentation(resolved.readiness, technicalDetails);
  }

  if (resolved.failedRunCategory) {
    return failedRunPresentation(resolved.failedRunCategory);
  }

  if (resolved.fieldErrors && resolved.fieldErrors.length > 0) {
    return {
      headline: "Check the highlighted fields",
      explanation: "Correct the values below and try again.",
      action: { kind: "edit", label: "Edit fields" },
      tone: "warning",
      fieldErrors: resolved.fieldErrors,
      technicalDetails,
    };
  }

  if (read.status === "available") {
    return {
      headline: "Ready",
      explanation: "The latest information is available.",
      action: { kind: "none", label: "" },
      tone: "ok",
    };
  }

  if (isInfrastructureRunLimitRejection(read)) {
    return {
      headline: "This run exceeds an infrastructure limit",
      explanation:
        "This limit was deliberately chosen for the infrastructure running this demo. For larger runs, run the project locally or deploy it on larger infrastructure.",
      action: { kind: "edit", label: "Edit values" },
      tone: "warning",
      technicalDetails,
    };
  }

  const retryAfterMs =
    read.retryAfterMs !== undefined && read.retryAfterMs > 0 ? read.retryAfterMs : undefined;
  const isStartRequestOutcome =
    resolved.surface === "public-start" && resolved.startRequestOutcome === true;
  const mapped = read.errorCode
    ? resolved.surface !== "public-start" || publicStartActionCodes.has(read.errorCode)
      ? codePresentation(read.errorCode, retryAfterMs, resolved)
      : isStartRequestOutcome && publicStartUncertainCodes.has(read.errorCode)
        ? publicStartUncertainRetryPresentation(retryAfterMs)
        : publicBackendRetryPresentation(retryAfterMs)
    : resolved.surface === "public-start" && !isStartRequestOutcome
      ? publicBackendRetryPresentation(retryAfterMs)
      : null;
  if (mapped) return { ...mapped, technicalDetails };

  // An absent code includes network failures and malformed envelopes. Fail closed: the
  // transport reason is retained only for authenticated technical details. For a submitted
  // public start request the browser never saw the API verdict, so the outcome is uncertain.
  if (resolved.surface === "public-start") {
    return {
      ...(isStartRequestOutcome
        ? publicStartUncertainPresentation()
        : publicBackendUnavailablePresentation()),
      technicalDetails,
    };
  }
  return { ...genericPresentation, technicalDetails };
}

function readinessPresentation(
  status: "degraded" | "unavailable",
  technicalDetails: ErrorTechnicalDetails | undefined,
): ErrorPresentation {
  return {
    ...publicBackendUnavailablePresentation(status),
    technicalDetails,
  };
}

function publicBackendUnavailablePresentation(
  status: "degraded" | "unavailable" = "unavailable",
): Omit<ErrorPresentation, "technicalDetails"> {
  return {
    headline: "The demo backend isn't ready yet — try again in a moment",
    explanation: "Check again before starting a run.",
    action: { kind: "check", label: "Check again" },
    tone: status === "degraded" ? "warning" : "danger",
  };
}

function publicStartUncertainPresentation(): Omit<ErrorPresentation, "technicalDetails"> {
  return {
    headline: "We couldn't confirm whether your run started",
    explanation: "Check whether a run is already in progress before starting another one.",
    action: { kind: "check", label: "Check again" },
    tone: "warning",
  };
}

function failedRunPresentation(
  category: NonNullable<ErrorPresentationContext["failedRunCategory"]>,
): ErrorPresentation {
  const explanation =
    category === "inventory"
      ? "The scenario could not prepare its inventory."
      : category === "traffic"
        ? "The scenario could not complete its traffic window."
        : category === "automatic_reset"
          ? "The scenario was cancelled by an automatic reset."
          : "The scenario was stopped by an operator.";
  return {
    headline: "This run did not finish",
    explanation,
    action: { kind: "none", label: "" },
    tone: "danger",
  };
}

function codePresentation(
  code: ErrorPayloadCode,
  retryAfterMs: number | undefined,
  context: ErrorPresentationContext,
): Omit<ErrorPresentation, "technicalDetails"> | null {
  switch (code) {
    case "run_conflict":
      return conflictPresentation(context, retryAfterMs);
    case "preset_conflict":
      return presetConflictPresentation(context);
    case "traffic_execution_conflict":
      return context.surface === "public-start"
        ? publicBackendRetryPresentation(retryAfterMs)
        : genericPresentation;
    case "public_run_budget_exceeded":
      return waitPresentation(
        context.surface === "public-start" && context.budget === "visitor"
          ? "You’ve reached your visitor start allowance"
          : context.surface === "public-start" && context.budget === "global"
            ? "The shared demo has reached its start limit"
            : context.surface === "public-start"
              ? "Public start limit reached for now — try again later"
              : "The public run limit has been reached",
        retryAfterMs,
      );
    case "admin_login_rate_limited":
    case "dashboard_recovery_rate_limited":
      return waitPresentation("Please wait before trying again", retryAfterMs);
    case "resource_not_found":
      return resourceNotFoundPresentation(context);
    case "admin_session_required":
      return {
        headline: "Sign in to continue",
        explanation: "This operator action is protected.",
        action: { kind: "sign-in", label: "Sign in", href: "/admin" },
        tone: "warning",
      };
    case "control_token_required":
      return {
        headline: "Operator connection needs attention",
        explanation: "The protected control connection is not configured.",
        action: { kind: "contact-operator", label: "Review deployment" },
        tone: "danger",
      };
    case "dashboard_recovery_unavailable":
    case "queue_status_unavailable":
    case "load_orchestrator_unavailable":
      return context.surface === "public-start"
        ? publicBackendRetryPresentation(retryAfterMs)
        : retryPresentation("The latest information is temporarily unavailable", retryAfterMs);
    case "backend_unavailable":
      if (context.surface !== "public-start")
        return retryPresentation("The latest information is temporarily unavailable", retryAfterMs);
      return context.startRequestOutcome === true
        ? publicStartUncertainRetryPresentation(retryAfterMs)
        : publicBackendRetryPresentation(retryAfterMs);
    case "invalid_backend_response":
      if (context.surface !== "public-start") return genericPresentation;
      return context.startRequestOutcome === true
        ? publicStartUncertainRetryPresentation(retryAfterMs)
        : publicBackendRetryPresentation(retryAfterMs);
    case "internal_error":
      return context.surface === "public-start"
        ? publicBackendRetryPresentation(retryAfterMs)
        : genericPresentation;
    case "invalid_request":
    case "invalid_run_configuration":
    case "invalid_runtime_policy":
    case "public_override_not_allowed":
    case "preset_operation_not_allowed":
      return {
        headline: "Check the values and try again",
        explanation: "Use the available fields and limits for this operation.",
        action: { kind: "edit", label: "Edit values" },
        tone: "warning",
      };
    case "run_cleanup_conflict":
      if (context.cause === "projection_cleanup_incomplete")
        return {
          headline: "Work cleanup and history completed",
          explanation:
            "Remaining dashboard or shared-state cleanup failed. Retry Reset to finish it; the completed reset does not block new runs.",
          action: { kind: "contact-operator", label: "Retry Reset" },
          tone: "warning",
        };
      return {
        headline: "Work cleanup needs operator review",
        explanation: "Review the cleanup conflict before retrying Reset.",
        action: { kind: "contact-operator", label: "Review operation" },
        tone: "danger",
      };

    case "traffic_termination_unconfirmed":
    case "load_orchestrator_abort_unconfirmed":
    case "load_orchestrator_run_mismatch":
    case "load_orchestrator_start_ambiguous":
    case "operator_mode_required":
      return {
        headline: "The operator action could not be completed",
        explanation: "Review the operation and try again, or contact an operator.",
        action: { kind: "contact-operator", label: "Review operation" },
        tone: "danger",
      };
    default:
      return null;
  }
}

function conflictPresentation(
  context: ErrorPresentationContext,
  retryAfterMs: number | undefined,
): Omit<ErrorPresentation, "technicalDetails"> {
  if (context.cause === "active_run_exists") {
    return {
      headline: "A demo run is already in progress",
      explanation: "Watch the current run, then try again when it finishes.",
      action: { kind: "watch", label: "Watch live", href: "/watch" },
      tone: "warning",
    };
  }
  if (context.cause === "reset_incomplete") {
    return isProtectedSurface(context.surface)
      ? {
          headline: "Recovery needs attention",
          explanation: "Repair the prior reset before starting another run.",
          action: {
            kind: "retry",
            label: "Retry recovery",
            ...(retryAfterMs ? { retryAfterMs } : {}),
          },
          tone: "warning",
        }
      : {
          headline: "The previous run is still recovering",
          explanation:
            "Worker work may still settle. New runs remain unavailable until recovery completes.",
          action: {
            kind: "check",
            label: "Check again",
            ...(retryAfterMs ? { retryAfterMs } : {}),
          },
          tone: "warning",
        };
  }
  return context.surface === "public-start"
    ? publicBackendUnavailablePresentation()
    : genericPresentation;
}

function presetConflictPresentation(
  context: ErrorPresentationContext,
): Omit<ErrorPresentation, "technicalDetails"> {
  if (context.cause === "slug_in_use") {
    return {
      headline: "That preset slug is already in use",
      explanation: "Choose another slug before duplicating the preset.",
      action: { kind: "edit", label: "Choose another slug" },
      tone: "warning",
    };
  }
  if (context.cause === "not_archivable") {
    return {
      headline: "This preset can no longer be archived",
      explanation: "Refresh the preset list and review the available actions.",
      action: { kind: "check", label: "Refresh presets", href: "/admin" },
      tone: "warning",
    };
  }
  return context.surface === "public-start"
    ? publicBackendUnavailablePresentation()
    : genericPresentation;
}

function resourceNotFoundPresentation(
  context: ErrorPresentationContext,
): Omit<ErrorPresentation, "technicalDetails"> {
  if (context.surface === "history-detail") {
    return {
      headline: "That saved report could not be found",
      explanation: "Choose an available report from run history.",
      action: { kind: "retry", label: "View run history", href: "/run-history" },
      tone: "warning",
    };
  }
  if (context.surface === "public-start") {
    return publicBackendUnavailablePresentation();
  }
  if (context.surface === "admin-operation") {
    return {
      headline: "The requested item is no longer available",
      explanation: "Review the operation and choose an available item.",
      action: { kind: "contact-operator", label: "Review operation" },
      tone: "warning",
    };
  }
  return {
    headline: "That result is no longer available",
    explanation: "Try another result.",
    action: { kind: "retry", label: "Try again" },
    tone: "warning",
  };
}

function isProtectedSurface(surface: ErrorPresentationContextName): boolean {
  return surface === "admin-read" || surface === "admin-operation";
}

function withBoundedCause(
  context: ErrorPresentationContext,
  read: BackendRead<unknown>,
): ErrorPresentationContext {
  if (read.status !== "unavailable" || !read.details) return context;
  const budget = read.details.budget;
  const cause = read.details.conflictReason;
  const boundedCause =
    cause === "active_run_exists" ||
    cause === "reset_incomplete" ||
    cause === "projection_cleanup_incomplete" ||
    cause === "slug_in_use" ||
    cause === "not_archivable"
      ? cause
      : undefined;
  return {
    ...context,
    ...(context.cause || boundedCause === undefined ? {} : { cause: boundedCause }),
    ...(budget === "visitor" || budget === "global" ? { budget } : {}),
  };
}

function retryPresentation(
  headline: string,
  retryAfterMs: number | undefined,
): Omit<ErrorPresentation, "technicalDetails"> {
  return retryAfterMs === undefined
    ? {
        headline,
        explanation: "Try again shortly.",
        action: { kind: "retry", label: "Check again" },
        tone: "danger",
      }
    : waitPresentation(headline, retryAfterMs);
}

function publicStartUncertainRetryPresentation(
  retryAfterMs: number | undefined,
): Omit<ErrorPresentation, "technicalDetails"> {
  return retryAfterMs === undefined
    ? publicStartUncertainPresentation()
    : waitPresentation(publicStartUncertainPresentation().headline, retryAfterMs);
}

function publicBackendRetryPresentation(
  retryAfterMs: number | undefined,
): Omit<ErrorPresentation, "technicalDetails"> {
  return retryAfterMs === undefined
    ? publicBackendUnavailablePresentation()
    : waitPresentation(publicBackendUnavailablePresentation().headline, retryAfterMs);
}

function waitPresentation(
  headline: string,
  retryAfterMs: number | undefined,
): Omit<ErrorPresentation, "technicalDetails"> {
  const explanation =
    retryAfterMs === undefined
      ? "Try again later."
      : `Wait ${formatRetryDelay(retryAfterMs)} before trying again.`;
  return {
    headline,
    explanation,
    action: {
      kind: "wait",
      label: retryAfterMs === undefined ? "Try again later" : "Wait before retrying",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
    tone: "warning",
  };
}

function formatRetryDelay(milliseconds: number): string {
  const seconds = Math.max(1, Math.ceil(milliseconds / 1_000));
  return seconds < 60
    ? `${seconds} second${seconds === 1 ? "" : "s"}`
    : `${Math.ceil(seconds / 60)} minutes`;
}

function toTechnicalDetails(
  read: Extract<BackendRead<unknown>, { status: "unavailable" }>,
): ErrorTechnicalDetails {
  return {
    ...(read.errorCode === undefined ? {} : { code: read.errorCode }),
    ...(read.httpStatus === undefined ? {} : { httpStatus: read.httpStatus }),
    ...(read.correlationId === undefined ? {} : { correlationId: read.correlationId }),
    ...(read.reason ? { reason: read.reason } : {}),
  };
}
