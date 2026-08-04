import type { ErrorPayloadCode } from "@checkout-surge/contracts";
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
  cause?: "active_run_exists" | "reset_incomplete" | "slug_in_use" | "not_archivable";
  fieldErrors?: ReadonlyArray<{ field: string; message: string }>;
  readiness?: "degraded" | "unavailable";
  failedRunCategory?: "reconciliation" | "business" | "traffic" | "inventory" | "operator";
}

const genericPresentation = {
  headline: "Something didn't work on our side",
  explanation:
    "Try again shortly. If the problem continues, the demo may be temporarily unavailable.",
  action: { kind: "retry", label: "Check again" } as const,
  tone: "danger" as const,
};

const publicStartActionCodes = new Set<ErrorPayloadCode>([
  "run_conflict",
  "public_run_budget_exceeded",
  "invalid_request",
  "invalid_run_configuration",
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

  const retryAfterMs =
    read.retryAfterMs !== undefined && read.retryAfterMs > 0 ? read.retryAfterMs : undefined;
  const mapped =
    read.errorCode &&
    (resolved.surface !== "public-start" || publicStartActionCodes.has(read.errorCode))
      ? codePresentation(read.errorCode, retryAfterMs, resolved)
      : resolved.surface === "public-start"
        ? publicBackendRetryPresentation(retryAfterMs)
        : null;
  if (mapped) return { ...mapped, technicalDetails };

  // An absent code includes network failures and malformed envelopes. Fail closed: the
  // transport reason is retained only for authenticated technical details.
  if (resolved.surface === "public-start") {
    return {
      ...publicBackendUnavailablePresentation(),
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

function failedRunPresentation(
  category: NonNullable<ErrorPresentationContext["failedRunCategory"]>,
): ErrorPresentation {
  const explanation =
    category === "inventory"
      ? "The scenario could not prepare its inventory."
      : category === "traffic"
        ? "The scenario could not complete its traffic window."
        : category === "business"
          ? "The scenario could not finish processing its checkout work."
          : category === "reconciliation"
            ? "The final evidence did not settle consistently."
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
        context.surface === "public-start"
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
    case "service_unavailable":
    case "backend_unavailable":
    case "dashboard_recovery_unavailable":
    case "inventory_unavailable":
    case "queue_status_unavailable":
    case "load_orchestrator_unavailable":
      return context.surface === "public-start"
        ? publicBackendRetryPresentation(retryAfterMs)
        : retryPresentation("The latest information is temporarily unavailable", retryAfterMs);
    case "invalid_backend_response":
    case "internal_error":
    case "service_misconfigured":
      return context.surface === "public-start"
        ? publicBackendRetryPresentation(retryAfterMs)
        : genericPresentation;
    case "invalid_request":
    case "invalid_run_configuration":
    case "invalid_runtime_policy":
    case "invalid_chaos_configuration":
    case "public_override_not_allowed":
    case "preset_operation_not_allowed":
      return {
        headline: "Check the values and try again",
        explanation: "Use the available fields and limits for this operation.",
        action: { kind: "edit", label: "Edit values" },
        tone: "warning",
      };
    case "run_cleanup_conflict":
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
      : publicBackendRetryPresentation(retryAfterMs);
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
      headline: "That result is no longer available",
      explanation: "Return to run history to choose another finished run.",
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
  if (context.cause || read.status !== "unavailable" || !read.details) return context;
  const cause = read.details.conflictReason;
  return cause === "active_run_exists" ||
    cause === "reset_incomplete" ||
    cause === "slug_in_use" ||
    cause === "not_archivable"
    ? { ...context, cause }
    : context;
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
