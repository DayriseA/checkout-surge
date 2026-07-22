import { z } from "zod";
import { correlationIdSchema, isoTimestampSchema, jsonObjectSchema } from "./primitives.js";

/**
 * Public HTTP error categories. Exact validation causes and internal worker,
 * persistence, PostgreSQL, and Zod diagnostics belong in their owning
 * vocabulary and may be carried in `details` without becoming wire codes.
 */
export const errorPayloadCodes = [
  "service_misconfigured",
  "admin_login_rate_limited",
  "admin_origin_required",
  "admin_passphrase_required",
  "admin_session_required",
  "backend_unavailable",
  "service_unavailable",
  "invalid_backend_response",
  "invalid_request",
  "control_token_required",
  "internal_error",
  "operator_mode_required",
  "resource_not_found",
  "inventory_not_initialized",
  "inventory_unavailable",
  "queue_status_unavailable",
  "dashboard_recovery_unavailable",
  "dashboard_recovery_rate_limited",
  "dashboard_sse_at_capacity",
  "dashboard_sse_source_limit_exceeded",
  "run_conflict",
  "preset_operation_not_allowed",
  "preset_conflict",
  "public_override_not_allowed",
  "public_run_budget_exceeded",
  "public_visitor_forbidden",
  "traffic_report_rejected",
  "invalid_run_configuration",
  "invalid_runtime_policy",
  "run_cleanup_conflict",
  "load_orchestrator_unavailable",
  "load_orchestrator_abort_unconfirmed",
  "load_orchestrator_run_mismatch",
  "load_orchestrator_start_ambiguous",
  "invalid_chaos_configuration",
  "idempotency_conflict",
  "traffic_execution_conflict",
  "traffic_termination_unconfirmed",
] as const;

export type ErrorPayloadCode = (typeof errorPayloadCodes)[number];

export const errorPayloadCodeSchema = z.enum(errorPayloadCodes);

export const errorPayloadSchema = z
  .object({
    code: errorPayloadCodeSchema,
    message: z.string().trim().min(1),
    details: jsonObjectSchema.optional(),
    correlationId: correlationIdSchema,
    timestamp: isoTimestampSchema,
  })
  .strict();

export type ErrorPayload = z.infer<typeof errorPayloadSchema>;
