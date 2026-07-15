import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type JsonRecord = Record<string, unknown>;
export type JsonValue = JsonRecord | JsonValue[] | string | number | boolean | null;

export const saleOfferPurposeValues = ["catalog", "generated_run"] as const;
export type SaleOfferPurpose = (typeof saleOfferPurposeValues)[number];
export const saleOfferPurposeEnum = pgEnum("sale_offer_purpose", saleOfferPurposeValues);

export const reservationStatusValues = ["secured", "rejected", "released", "expired"] as const;
export type ReservationStatus = (typeof reservationStatusValues)[number];
export const reservationStatusEnum = pgEnum("reservation_status", reservationStatusValues);

export const orderStatusValues = ["queued", "processing", "confirmed", "failed"] as const;
export type OrderStatus = (typeof orderStatusValues)[number];
export const orderStatusEnum = pgEnum("order_status", orderStatusValues);

export const erpAttemptStatusValues = ["succeeded", "failed", "timed_out"] as const;
export type ErpAttemptStatus = (typeof erpAttemptStatusValues)[number];
export const erpAttemptStatusEnum = pgEnum("erp_attempt_status", erpAttemptStatusValues);

export const recoveryJobStatusValues = ["pending", "enqueued", "escalated", "resolved"] as const;
export type RecoveryJobStatus = (typeof recoveryJobStatusValues)[number];
export const recoveryJobStatusEnum = pgEnum("recovery_job_status", recoveryJobStatusValues);

export const orderEventNameValues = [
  "reservation.secured",
  "reservation.rejected",
  "reservation.released",
  "reservation.expired",
  "order.queued",
  "order.processing",
  "order.confirmed",
  "order.failed",
  "notification.recorded",
  "inventory.updated",
  "erp.attempt.failed",
  "erp.attempt.succeeded",
] as const;
export type OrderEventName = (typeof orderEventNameValues)[number];
export const orderEventNameEnum = pgEnum("order_event_name", orderEventNameValues);

export const demoPresetVisibilityValues = ["public", "admin"] as const;
export type DemoPresetVisibility = (typeof demoPresetVisibilityValues)[number];
export const demoPresetVisibilityEnum = pgEnum(
  "demo_preset_visibility",
  demoPresetVisibilityValues,
);

export const demoRunOperatorModeValues = ["public", "admin"] as const;
export type DemoRunOperatorMode = (typeof demoRunOperatorModeValues)[number];
export const demoRunOperatorModeEnum = pgEnum("demo_run_operator_mode", demoRunOperatorModeValues);

export const demoRunStatusValues = [
  "starting",
  "active",
  "draining",
  "completed",
  "failed",
] as const;
export type DemoRunStatus = (typeof demoRunStatusValues)[number];
export const demoRunStatusEnum = pgEnum("demo_run_status", demoRunStatusValues);

export const demoRunTrafficStatusValues = [
  "not_started",
  "starting",
  "active",
  "succeeded",
  "failed",
] as const;
export type DemoRunTrafficStatus = (typeof demoRunTrafficStatusValues)[number];
export const demoRunTrafficStatusEnum = pgEnum(
  "demo_run_traffic_status",
  demoRunTrafficStatusValues,
);

export const trafficCompletionEnrichmentStatusValues = ["pending", "completed"] as const;
export type TrafficCompletionEnrichmentStatus =
  (typeof trafficCompletionEnrichmentStatusValues)[number];
export const trafficCompletionEnrichmentStatusEnum = pgEnum(
  "traffic_completion_enrichment_status",
  trafficCompletionEnrichmentStatusValues,
);

export const reservationPendingPersistenceStatusValues = [
  "pending_reconciliation",
  "reconciled",
] as const;
export type ReservationPendingPersistenceStatus =
  (typeof reservationPendingPersistenceStatusValues)[number];
export const reservationPendingPersistenceStatusEnum = pgEnum(
  "reservation_pending_persistence_status",
  reservationPendingPersistenceStatusValues,
);

export const simulatedNotificationChannelValues = ["email", "sms"] as const;
export type SimulatedNotificationChannel = (typeof simulatedNotificationChannelValues)[number];
export const simulatedNotificationChannelEnum = pgEnum(
  "simulated_notification_channel",
  simulatedNotificationChannelValues,
);

export const simulatedNotificationStatusValues = ["recorded"] as const;
export type SimulatedNotificationStatus = (typeof simulatedNotificationStatusValues)[number];
export const simulatedNotificationStatusEnum = pgEnum(
  "simulated_notification_status",
  simulatedNotificationStatusValues,
);

export const demoRunReservationOutcomeValues = ["api_sold_out_decision"] as const;
export type DemoRunReservationOutcomeName = (typeof demoRunReservationOutcomeValues)[number];
export const demoRunReservationOutcomeEnum = pgEnum(
  "demo_run_reservation_outcome",
  demoRunReservationOutcomeValues,
);

export const demoRunReservationOutcomeSourceValues = ["redis", "postgres", "api"] as const;
export type DemoRunReservationOutcomeSource =
  (typeof demoRunReservationOutcomeSourceValues)[number];
export const demoRunReservationOutcomeSourceEnum = pgEnum(
  "demo_run_reservation_outcome_source",
  demoRunReservationOutcomeSourceValues,
);

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const jsonObject = (name: string) => jsonb(name).$type<JsonRecord>().notNull();

export const products = pgTable(
  "products",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sku: text("sku").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("products_sku_unique").on(table.sku),
    uniqueIndex("products_slug_unique").on(table.slug),
    index("products_is_active_idx").on(table.isActive),
  ],
);

export const saleOffers = pgTable(
  "sale_offers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    allocatedStock: integer("allocated_stock").notNull(),
    saleStartsAt: timestamp("sale_starts_at", { withTimezone: true }).notNull(),
    saleEndsAt: timestamp("sale_ends_at", { withTimezone: true }).notNull(),
    isActive: boolean("is_active").default(true).notNull(),
    purpose: saleOfferPurposeEnum("purpose").default("catalog").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("sale_offers_allocated_stock_nonnegative", sql`${table.allocatedStock} >= 0`),
    check("sale_offers_valid_window", sql`${table.saleEndsAt} > ${table.saleStartsAt}`),
    index("sale_offers_product_id_idx").on(table.productId),
    index("sale_offers_purpose_idx").on(table.purpose),
    index("sale_offers_active_window_idx").on(table.isActive, table.saleStartsAt, table.saleEndsAt),
  ],
);

export const demoPresets = pgTable(
  "demo_presets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    visibility: demoPresetVisibilityEnum("visibility").notNull(),
    isEditable: boolean("is_editable").default(false).notNull(),
    isCustom: boolean("is_custom").default(false).notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    display: jsonObject("display"),
    trafficConfig: jsonObject("traffic_config"),
    inventoryConfig: jsonObject("inventory_config"),
    erpConfig: jsonObject("erp_config"),
    backpressureConfig: jsonObject("backpressure_config"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("demo_presets_slug_unique").on(table.slug),
    check(
      "demo_presets_public_read_only",
      sql`${table.visibility} <> 'public' OR ${table.isEditable} = false`,
    ),
    index("demo_presets_visibility_idx").on(table.visibility),
    index("demo_presets_archived_at_idx").on(table.archivedAt),
  ],
);

export const demoRuns = pgTable(
  "demo_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    presetId: uuid("preset_id")
      .notNull()
      .references(() => demoPresets.id, { onDelete: "restrict" }),
    presetName: text("preset_name").notNull(),
    operatorMode: demoRunOperatorModeEnum("operator_mode").notNull(),
    status: demoRunStatusEnum("status").default("starting").notNull(),
    trafficStatus: demoRunTrafficStatusEnum("traffic_status").default("not_started").notNull(),
    configSnapshot: jsonObject("config_snapshot"),
    saleOfferId: uuid("sale_offer_id").references(() => saleOffers.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    trafficStartedAt: timestamp("traffic_started_at", { withTimezone: true }),
    trafficEndedAt: timestamp("traffic_ended_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The constant-expression partial unique index that admits only one
    // non-terminal run is hand-authored in 0003_demo_runs_single_non_terminal.sql.
    // Keep it out of this declaration because Drizzle does not reliably
    // round-trip expression indexes; do not generate a duplicate schema index.
    uniqueIndex("demo_runs_sale_offer_id_unique").on(table.saleOfferId),
    uniqueIndex("demo_runs_id_sale_offer_id_unique").on(table.id, table.saleOfferId),
    index("demo_runs_preset_id_idx").on(table.presetId),
    index("demo_runs_status_idx").on(table.status),
  ],
);

export const demoRunSaleContexts = pgTable(
  "demo_run_sale_contexts",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(() => demoRuns.id, { onDelete: "cascade" }),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("demo_run_sale_contexts_sale_offer_id_unique").on(table.saleOfferId),
    uniqueIndex("demo_run_sale_contexts_run_sale_offer_unique").on(table.runId, table.saleOfferId),
    foreignKey({
      name: "demo_run_sale_contexts_run_sale_offer_demo_runs_fk",
      columns: [table.runId, table.saleOfferId],
      foreignColumns: [demoRuns.id, demoRuns.saleOfferId],
    }).onDelete("cascade"),
  ],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    quantity: integer("quantity").default(1).notNull(),
    status: reservationStatusEnum("status").notNull(),
    reservationToken: text("reservation_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    securedAt: timestamp("secured_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("reservations_reservation_token_unique").on(table.reservationToken),
    check("reservations_quantity_positive", sql`${table.quantity} > 0`),
    index("reservations_sale_offer_id_idx").on(table.saleOfferId),
    index("reservations_run_id_idx").on(table.runId),
    index("reservations_correlation_id_idx").on(table.correlationId),
    index("reservations_status_idx").on(table.status),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    publicOrderId: text("public_order_id").notNull(),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    reservationId: uuid("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    quantity: integer("quantity").default(1).notNull(),
    status: orderStatusEnum("status").default("queued").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull(),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("orders_public_order_id_unique").on(table.publicOrderId),
    uniqueIndex("orders_reservation_id_unique").on(table.reservationId),
    check("orders_quantity_positive", sql`${table.quantity} > 0`),
    index("orders_sale_offer_id_idx").on(table.saleOfferId),
    index("orders_run_id_idx").on(table.runId),
    index("orders_correlation_id_idx").on(table.correlationId),
    index("orders_status_idx").on(table.status),
  ],
);

export const erpAttempts = pgTable(
  "erp_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    deliveryId: text("delivery_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    status: erpAttemptStatusEnum("status").notNull(),
    terminal: boolean("terminal").default(false).notNull(),
    httpStatus: integer("http_status"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    latencyMs: integer("latency_ms").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    confirmationId: text("confirmation_id"),
    idempotencyKey: text("idempotency_key"),
    response: jsonb("response").$type<JsonRecord>(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("erp_attempts_order_delivery_attempt_unique").on(
      table.orderId,
      table.deliveryId,
      table.attemptNumber,
    ),
    uniqueIndex("erp_attempts_success_idempotency_key_unique").on(table.idempotencyKey),
    check("erp_attempts_attempt_number_positive", sql`${table.attemptNumber} > 0`),
    check("erp_attempts_latency_nonnegative", sql`${table.latencyMs} >= 0`),
    check(
      "erp_attempts_http_status_valid",
      sql`${table.httpStatus} IS NULL OR (${table.httpStatus} >= 100 AND ${table.httpStatus} <= 599)`,
    ),
    index("erp_attempts_order_id_idx").on(table.orderId),
    index("erp_attempts_run_id_idx").on(table.runId),
  ],
);

/** Durable first-write-wins ERP result ledger. */
export const erpConfirmationResults = pgTable(
  "erp_confirmation_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    orderId: text("order_id").notNull(),
    requestFingerprint: jsonb("request_fingerprint").$type<JsonRecord>().notNull(),
    response: jsonb("response").$type<JsonRecord>().notNull(),
    confirmationId: text("confirmation_id").notNull(),
    httpStatus: integer("http_status").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("erp_confirmation_results_idempotency_key_unique").on(table.idempotencyKey),
    index("erp_confirmation_results_created_at_idx").on(table.createdAt),
  ],
);

export const orderRecoveryJobs = pgTable(
  "order_recovery_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recoveryKey: text("recovery_key").notNull(),
    jobId: text("job_id").notNull(),
    sourceJobId: text("source_job_id"),
    sourceDisposition: text("source_disposition"),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<JsonRecord>().notNull(),
    result: jsonb("result").$type<JsonRecord>(),
    reason: text("reason").notNull(),
    status: recoveryJobStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("order_recovery_jobs_recovery_key_unique").on(table.recoveryKey),
    index("order_recovery_jobs_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    index("order_recovery_jobs_order_id_idx").on(table.orderId),
  ],
);

export const orderDeadLetters = pgTable(
  "order_dead_letters",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    jobId: text("job_id").notNull(),
    jobName: text("job_name").notNull(),
    claimedOrderId: text("claimed_order_id"),
    queueName: text("queue_name").default("orders:process").notNull(),
    payload: jsonb("payload").$type<JsonValue>(),
    reason: text("reason").notNull(),
    mismatchedFields: jsonb("mismatched_fields").$type<string[]>(),
    attemptsMade: integer("attempts_made").default(0).notNull(),
    correlationId: text("correlation_id"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("order_dead_letters_queue_job_name_unique").on(
      table.queueName,
      table.jobId,
      table.jobName,
    ),
    index("order_dead_letters_observed_at_idx").on(table.observedAt),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    reservationId: uuid("reservation_id").references(() => reservations.id, {
      onDelete: "set null",
    }),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    eventName: orderEventNameEnum("event_name").notNull(),
    payload: jsonb("payload").$type<JsonRecord>().default(sql`'{}'::jsonb`).notNull(),
    source: text("source").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index("order_events_order_id_idx").on(table.orderId),
    index("order_events_reservation_id_idx").on(table.reservationId),
    index("order_events_sale_offer_id_idx").on(table.saleOfferId),
    index("order_events_run_id_idx").on(table.runId),
    index("order_events_event_name_idx").on(table.eventName),
    index("order_events_occurred_at_idx").on(table.occurredAt),
  ],
);

export const reservationPendingPersistence = pgTable(
  "reservation_pending_persistence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reservationId: uuid("reservation_id").notNull(),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    quantity: integer("quantity").default(1).notNull(),
    reservationToken: text("reservation_token").notNull(),
    status: reservationPendingPersistenceStatusEnum("status")
      .default("pending_reconciliation")
      .notNull(),
    securedAt: timestamp("secured_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("reservation_pending_persistence_reservation_id_unique").on(table.reservationId),
    uniqueIndex("reservation_pending_persistence_offer_idempotency_unique").on(
      table.saleOfferId,
      table.idempotencyKey,
    ),
    check("reservation_pending_persistence_quantity_positive", sql`${table.quantity} > 0`),
    index("reservation_pending_persistence_sale_offer_id_idx").on(table.saleOfferId),
    index("reservation_pending_persistence_run_id_idx").on(table.runId),
    index("reservation_pending_persistence_status_idx").on(table.status),
  ],
);

export const simulatedNotifications = pgTable(
  "simulated_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    channel: simulatedNotificationChannelEnum("channel").notNull(),
    recipientPlaceholder: text("recipient_placeholder").notNull(),
    status: simulatedNotificationStatusEnum("status").default("recorded").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("simulated_notifications_order_channel_unique").on(table.orderId, table.channel),
    index("simulated_notifications_order_id_idx").on(table.orderId),
    index("simulated_notifications_sale_offer_id_idx").on(table.saleOfferId),
    index("simulated_notifications_run_id_idx").on(table.runId),
  ],
);

export const demoRunReservationOutcomes = pgTable(
  "demo_run_reservation_outcomes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => demoRuns.id, { onDelete: "cascade" }),
    outcome: demoRunReservationOutcomeEnum("outcome").notNull(),
    count: integer("count").default(0).notNull(),
    latestObservedAt: timestamp("latest_observed_at", { withTimezone: true }),
    source: demoRunReservationOutcomeSourceEnum("source").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("demo_run_reservation_outcomes_run_outcome_unique").on(table.runId, table.outcome),
    check("demo_run_reservation_outcomes_count_nonnegative", sql`${table.count} >= 0`),
    index("demo_run_reservation_outcomes_run_id_idx").on(table.runId),
  ],
);

export const demoRunFinalizations = pgTable(
  "demo_run_finalizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => demoRuns.id, { onDelete: "cascade" }),
    exitCode: integer("exit_code"),
    errorMessage: text("error_message"),
    httpSummary: jsonObject("http_summary"),
    trafficOutcomeSummary: jsonObject("traffic_outcome_summary"),
    trafficDeliverySummary: jsonObject("traffic_delivery_summary"),
    httpTimingBreakdownSummary: jsonObject("http_timing_breakdown_summary"),
    loadRunDiagnosticsSummary: jsonObject("load_run_diagnostics_summary"),
    apiRequestLifecycleSummary: jsonObject("api_request_lifecycle_summary"),
    completionEnrichmentStatus: trafficCompletionEnrichmentStatusEnum(
      "completion_enrichment_status",
    )
      .default("completed")
      .notNull(),
    trafficSummaryReceivedAt: timestamp("traffic_summary_received_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("demo_run_finalizations_run_id_unique").on(table.runId),
    index("demo_run_finalizations_run_id_idx").on(table.runId),
  ],
);

export const demoRunSummaries = pgTable(
  "demo_run_summaries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => demoRuns.id, { onDelete: "cascade" }),
    presetName: text("preset_name").notNull(),
    status: demoRunStatusEnum("status").notNull(),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    httpSummary: jsonObject("http_summary"),
    trafficDeliverySummary: jsonObject("traffic_delivery_summary"),
    httpTimingBreakdownSummary: jsonObject("http_timing_breakdown_summary"),
    loadRunDiagnosticsSummary: jsonObject("load_run_diagnostics_summary"),
    apiRequestLifecycleSummary: jsonObject("api_request_lifecycle_summary"),
    businessOutcomeSummary: jsonObject("business_outcome_summary"),
    terminalInventorySnapshot: jsonb("terminal_inventory_snapshot").$type<JsonRecord>(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("demo_run_summaries_run_id_unique").on(table.runId),
    check("demo_run_summaries_terminal_status", sql`${table.status} IN ('completed', 'failed')`),
    index("demo_run_summaries_captured_at_idx").on(table.capturedAt),
  ],
);

/** Durable retry coordinates retained only while external teardown is incomplete. */
export const demoRunTeardownReceipts = pgTable(
  "demo_run_teardown_receipts",
  {
    runId: uuid("run_id").primaryKey(),
    saleOfferId: uuid("sale_offer_id").notNull(),
    presetName: text("preset_name").notNull(),
    durableDeletedAt: timestamp("durable_deleted_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index("demo_run_teardown_receipts_sale_offer_id_idx").on(table.saleOfferId)],
);

export const publicRuntimePolicies = pgTable(
  "public_runtime_policies",
  {
    id: text("id").default("active").primaryKey(),
    policy: jsonObject("policy"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check("public_runtime_policies_active_singleton", sql`${table.id} = 'active'`)],
);

export const productsRelations = relations(products, ({ many }) => ({
  saleOffers: many(saleOffers),
}));

export const saleOffersRelations = relations(saleOffers, ({ one, many }) => ({
  product: one(products, {
    fields: [saleOffers.productId],
    references: [products.id],
  }),
  demoRunSaleContext: one(demoRunSaleContexts),
  reservations: many(reservations),
  orders: many(orders),
  orderEvents: many(orderEvents),
}));

export const demoPresetsRelations = relations(demoPresets, ({ many }) => ({
  demoRuns: many(demoRuns),
}));

export const demoRunsRelations = relations(demoRuns, ({ one, many }) => ({
  preset: one(demoPresets, {
    fields: [demoRuns.presetId],
    references: [demoPresets.id],
  }),
  saleOffer: one(saleOffers, {
    fields: [demoRuns.saleOfferId],
    references: [saleOffers.id],
  }),
  saleContext: one(demoRunSaleContexts),
  reservations: many(reservations),
  orders: many(orders),
  erpAttempts: many(erpAttempts),
  recoveryJobs: many(orderRecoveryJobs),
  orderEvents: many(orderEvents),
  pendingPersistence: many(reservationPendingPersistence),
  simulatedNotifications: many(simulatedNotifications),
  reservationOutcomes: many(demoRunReservationOutcomes),
  finalization: one(demoRunFinalizations),
  summary: one(demoRunSummaries),
}));

export const demoRunSaleContextsRelations = relations(demoRunSaleContexts, ({ one }) => ({
  run: one(demoRuns, {
    fields: [demoRunSaleContexts.runId],
    references: [demoRuns.id],
  }),
  saleOffer: one(saleOffers, {
    fields: [demoRunSaleContexts.saleOfferId],
    references: [saleOffers.id],
  }),
}));

export const reservationsRelations = relations(reservations, ({ one, many }) => ({
  saleOffer: one(saleOffers, {
    fields: [reservations.saleOfferId],
    references: [saleOffers.id],
  }),
  run: one(demoRuns, {
    fields: [reservations.runId],
    references: [demoRuns.id],
  }),
  order: one(orders),
  events: many(orderEvents),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  saleOffer: one(saleOffers, {
    fields: [orders.saleOfferId],
    references: [saleOffers.id],
  }),
  reservation: one(reservations, {
    fields: [orders.reservationId],
    references: [reservations.id],
  }),
  run: one(demoRuns, {
    fields: [orders.runId],
    references: [demoRuns.id],
  }),
  erpAttempts: many(erpAttempts),
  events: many(orderEvents),
  simulatedNotifications: many(simulatedNotifications),
}));

export const erpAttemptsRelations = relations(erpAttempts, ({ one }) => ({
  order: one(orders, {
    fields: [erpAttempts.orderId],
    references: [orders.id],
  }),
  run: one(demoRuns, {
    fields: [erpAttempts.runId],
    references: [demoRuns.id],
  }),
}));

export const orderRecoveryJobsRelations = relations(orderRecoveryJobs, ({ one }) => ({
  order: one(orders, {
    fields: [orderRecoveryJobs.orderId],
    references: [orders.id],
  }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, {
    fields: [orderEvents.orderId],
    references: [orders.id],
  }),
  reservation: one(reservations, {
    fields: [orderEvents.reservationId],
    references: [reservations.id],
  }),
  saleOffer: one(saleOffers, {
    fields: [orderEvents.saleOfferId],
    references: [saleOffers.id],
  }),
  run: one(demoRuns, {
    fields: [orderEvents.runId],
    references: [demoRuns.id],
  }),
}));

export const reservationPendingPersistenceRelations = relations(
  reservationPendingPersistence,
  ({ one }) => ({
    saleOffer: one(saleOffers, {
      fields: [reservationPendingPersistence.saleOfferId],
      references: [saleOffers.id],
    }),
    run: one(demoRuns, {
      fields: [reservationPendingPersistence.runId],
      references: [demoRuns.id],
    }),
  }),
);

export const simulatedNotificationsRelations = relations(simulatedNotifications, ({ one }) => ({
  order: one(orders, {
    fields: [simulatedNotifications.orderId],
    references: [orders.id],
  }),
  saleOffer: one(saleOffers, {
    fields: [simulatedNotifications.saleOfferId],
    references: [saleOffers.id],
  }),
  run: one(demoRuns, {
    fields: [simulatedNotifications.runId],
    references: [demoRuns.id],
  }),
}));

export const demoRunReservationOutcomesRelations = relations(
  demoRunReservationOutcomes,
  ({ one }) => ({
    run: one(demoRuns, {
      fields: [demoRunReservationOutcomes.runId],
      references: [demoRuns.id],
    }),
  }),
);

export const demoRunFinalizationsRelations = relations(demoRunFinalizations, ({ one }) => ({
  run: one(demoRuns, {
    fields: [demoRunFinalizations.runId],
    references: [demoRuns.id],
  }),
}));

export const demoRunSummariesRelations = relations(demoRunSummaries, ({ one }) => ({
  run: one(demoRuns, {
    fields: [demoRunSummaries.runId],
    references: [demoRuns.id],
  }),
}));

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type SaleOffer = typeof saleOffers.$inferSelect;
export type NewSaleOffer = typeof saleOffers.$inferInsert;
export type DemoPreset = typeof demoPresets.$inferSelect;
export type NewDemoPreset = typeof demoPresets.$inferInsert;
export type DemoRun = typeof demoRuns.$inferSelect;
export type NewDemoRun = typeof demoRuns.$inferInsert;
export type DemoRunSaleContext = typeof demoRunSaleContexts.$inferSelect;
export type NewDemoRunSaleContext = typeof demoRunSaleContexts.$inferInsert;
export type Reservation = typeof reservations.$inferSelect;
export type NewReservation = typeof reservations.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type ErpAttempt = typeof erpAttempts.$inferSelect;
export type NewErpAttempt = typeof erpAttempts.$inferInsert;
export type ErpConfirmationResult = typeof erpConfirmationResults.$inferSelect;
export type NewErpConfirmationResult = typeof erpConfirmationResults.$inferInsert;
export type OrderRecoveryJob = typeof orderRecoveryJobs.$inferSelect;
export type NewOrderRecoveryJob = typeof orderRecoveryJobs.$inferInsert;
export type OrderDeadLetter = typeof orderDeadLetters.$inferSelect;
export type NewOrderDeadLetter = typeof orderDeadLetters.$inferInsert;
export type OrderEvent = typeof orderEvents.$inferSelect;
export type NewOrderEvent = typeof orderEvents.$inferInsert;
export type ReservationPendingPersistence = typeof reservationPendingPersistence.$inferSelect;
export type NewReservationPendingPersistence = typeof reservationPendingPersistence.$inferInsert;
export type SimulatedNotification = typeof simulatedNotifications.$inferSelect;
export type NewSimulatedNotification = typeof simulatedNotifications.$inferInsert;
export type DemoRunReservationOutcome = typeof demoRunReservationOutcomes.$inferSelect;
export type NewDemoRunReservationOutcome = typeof demoRunReservationOutcomes.$inferInsert;
export type DemoRunFinalization = typeof demoRunFinalizations.$inferSelect;
export type NewDemoRunFinalization = typeof demoRunFinalizations.$inferInsert;
export type DemoRunSummary = typeof demoRunSummaries.$inferSelect;
export type NewDemoRunSummary = typeof demoRunSummaries.$inferInsert;
export type DemoRunTeardownReceipt = typeof demoRunTeardownReceipts.$inferSelect;
export type PublicRuntimePolicy = typeof publicRuntimePolicies.$inferSelect;
export type NewPublicRuntimePolicy = typeof publicRuntimePolicies.$inferInsert;
