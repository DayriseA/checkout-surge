import { z } from "zod";
import { correlationIdSchema, isoTimestampSchema, jsonObjectSchema } from "./primitives.js";

/**
 * Bounded direct deployment / public snapshot violation codes. These are the
 * only codes that `collectAcceptedRunConfigSnapshotViolations` can emit for a
 * public custom run, and therefore the only codes that
 * `collectDefaultSnapshotViolations` prefixes with `public_custom_default_`.
 * Kept as a stable readonly tuple so the prefixed vocabulary below cannot drift
 * from the base violation vocabulary.
 */
export const directSnapshotViolationCodes = [
  "deployment_buyers_exceeded",
  "deployment_duration_exceeded",
  "deployment_max_vus_exceeded",
  "deployment_preallocated_vus_exceeded",
  "deployment_request_rate_exceeded",
  "deployment_start_delay_exceeded",
  "deployment_total_requests_exceeded",
  "public_buyers_exceeded",
  "public_duration_exceeded",
  "public_erp_error_rate_exceeded",
  "public_erp_latency_exceeded",
  "public_erp_tps_exceeded",
  "public_forced_outage_not_allowed",
  "public_max_vus_exceeded",
  "public_preallocated_vus_exceeded",
  "public_request_rate_exceeded",
  "public_start_delay_exceeded",
  "public_starting_stock_exceeded",
  "public_total_requests_exceeded",
  "public_traffic_mode_not_allowed",
] as const;

/**
 * Stable, duplicate-free canonical machine error-code vocabulary. Every public
 * `ErrorPayload` emitted by the API, Mock ERP, load-orchestrator, and web BFF
 * must use one of these codes. Add new public codes here and only here.
 */
export const errorPayloadCodes = [
  // Web/BFF local origins
  "admin_login_limiter_unavailable",
  "admin_login_rate_limited",
  "admin_origin_required",
  "admin_passphrase_not_configured",
  "admin_passphrase_required",
  "admin_session_config_invalid",
  "admin_session_required",
  "admin_session_secret_not_configured",
  "backend_unavailable",
  "control_token_not_configured",
  "invalid_backend_response",
  "invalid_json",
  "public_client_cookie_secret_not_configured",

  // Shared / API basics
  "control_token_required",
  "internal_error",
  "invalid_request",
  "operator_mode_required",
  "order_not_found",
  "run_attribution_mismatch",
  "run_history_detail_not_found",
  "inventory_not_initialized",
  "inventory_unavailable",
  "queue_status_unavailable",

  // Dashboard admission limits
  "dashboard_recovery_at_capacity",
  "dashboard_recovery_limiter_unavailable",
  "dashboard_recovery_rate_limited",
  "dashboard_sse_at_capacity",
  "dashboard_sse_source_limit_exceeded",

  // Demo / preset / public access
  "active_product_not_found",
  "demo_reset_incomplete",
  "demo_run_already_active",
  "invalid_preset_slug",
  "preset_not_archivable",
  "preset_not_duplicable",
  "preset_not_editable",
  "preset_not_found",
  "preset_not_public",
  "preset_slug_conflict",
  "public_override_not_allowed",
  "public_run_budget_exceeded",
  "public_runtime_policy_not_found",
  "public_visitor_forbidden",
  "public_visitor_run_budget_exceeded",
  "run_not_found",
  "run_sale_offer_missing",
  "traffic_completion_report_mismatch",
  "traffic_completion_run_not_eligible",
  "traffic_metric_run_not_eligible",

  // Direct deployment / public snapshot policy violations
  ...directSnapshotViolationCodes,

  // Public runtime policy definition violations
  "public_erp_tps_limit_invalid",
  "public_limit_buyers_exceeds_deployment_cap",
  "public_limit_duration_exceeds_deployment_cap",
  "public_limit_max_vus_exceeds_deployment_cap",
  "public_limit_preallocated_vus_exceeds_deployment_cap",
  "public_limit_request_rate_exceeds_deployment_cap",
  "public_limit_start_delay_exceeds_deployment_cap",
  "public_limit_total_requests_exceeds_deployment_cap",
  "public_vus_limit_invalid",

  // Public custom default violations (prefixed direct/public snapshot codes)
  "public_custom_default_deployment_buyers_exceeded",
  "public_custom_default_deployment_duration_exceeded",
  "public_custom_default_deployment_max_vus_exceeded",
  "public_custom_default_deployment_preallocated_vus_exceeded",
  "public_custom_default_deployment_request_rate_exceeded",
  "public_custom_default_deployment_start_delay_exceeded",
  "public_custom_default_deployment_total_requests_exceeded",
  "public_custom_default_public_buyers_exceeded",
  "public_custom_default_public_duration_exceeded",
  "public_custom_default_public_erp_error_rate_exceeded",
  "public_custom_default_public_erp_latency_exceeded",
  "public_custom_default_public_erp_tps_exceeded",
  "public_custom_default_public_forced_outage_not_allowed",
  "public_custom_default_public_max_vus_exceeded",
  "public_custom_default_public_preallocated_vus_exceeded",
  "public_custom_default_public_request_rate_exceeded",
  "public_custom_default_public_start_delay_exceeded",
  "public_custom_default_public_starting_stock_exceeded",
  "public_custom_default_public_total_requests_exceeded",
  "public_custom_default_public_traffic_mode_not_allowed",

  // Generated-run queue maintenance
  "run_not_terminal",
  "run_ownership_mismatch",
  "run_queue_job_active",
  "run_queue_job_malformed",
  "run_queue_maintenance_owned_by_other_run",
  "run_queue_not_quiescent",

  // API to load-orchestrator failures
  "load_orchestrator_abort_invalid_response",
  "load_orchestrator_abort_unconfirmed",
  "load_orchestrator_run_mismatch",
  "load_orchestrator_start_ambiguous",
  "load_orchestrator_start_failed",

  // Mock ERP / load-orchestrator public failures
  "chaos_config_exceeds_caps",
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
