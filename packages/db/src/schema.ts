import type {
  AcceptedRunConfigSnapshot,
  AdministrativeStopEvidence,
  BackpressureConfig,
  BusinessOutcomeSummary,
  DemoPresetDisplay,
  ErpConfirmationResponse,
  ErpOutcomeDisposition,
  ErpRunConfig,
  HttpTimingBreakdownSummary,
  InventoryConfig,
  PublicRuntimePolicyMutable as PublicRuntimePolicyMutableContract,
  RealLoadRunDiagnosticsSummary,
  RunSignalTimelineSummary,
  ServerReservationTimingSummary,
  TerminalInventorySnapshot,
  TrafficConfig,
  TrafficDeliverySummary,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import {
  demoPresetVisibilityValues,
  demoRunStatusValues,
  emptyServerReservationTimingSummary,
  erpAttemptStatusValues,
  erpOutcomeDispositionValues,
  operatorModeValues,
  orderEventNameValues,
  orderFailureCategoryValues,
  orderStatusValues,
  orderWaitingReasonValues,
  recoveryJobStatusValues,
  reservationPendingPersistenceStatusValues,
  saleOfferPurposeValues,
  trafficCompletionEnrichmentStatusValues,
  trafficExecutionStatusValues,
} from "@checkout-surge/contracts";
import { sql } from "drizzle-orm";

// Drizzle snapshots cannot represent the pgcrypto extension or the expression
// index appended to the reviewed baseline. Preserve that small custom SQL
// section when amending the pre-release baseline.
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

export const saleOfferPurposeEnum = pgEnum("sale_offer_purpose", saleOfferPurposeValues);

export const orderStatusEnum = pgEnum("order_status", orderStatusValues);

export const orderWaitingReasonEnum = pgEnum("order_waiting_reason", orderWaitingReasonValues);

export const orderFailureCategoryEnum = pgEnum(
  "order_failure_category",
  orderFailureCategoryValues,
);

export const erpAttemptStatusEnum = pgEnum("erp_attempt_status", erpAttemptStatusValues);

export const erpOutcomeDispositionEnum = pgEnum(
  "erp_outcome_disposition",
  erpOutcomeDispositionValues,
);

export const recoveryJobStatusEnum = pgEnum("recovery_job_status", recoveryJobStatusValues);

export const orderEventNameEnum = pgEnum("order_event_name", orderEventNameValues);

export const demoPresetVisibilityEnum = pgEnum(
  "demo_preset_visibility",
  demoPresetVisibilityValues,
);

export const demoRunOperatorModeEnum = pgEnum("demo_run_operator_mode", operatorModeValues);

export const demoRunStatusEnum = pgEnum("demo_run_status", demoRunStatusValues);

export const demoRunTrafficStatusEnum = pgEnum(
  "demo_run_traffic_status",
  trafficExecutionStatusValues,
);

export const trafficCompletionEnrichmentStatusEnum = pgEnum(
  "traffic_completion_enrichment_status",
  trafficCompletionEnrichmentStatusValues,
);

export const reservationPendingPersistenceStatusEnum = pgEnum(
  "reservation_pending_persistence_status",
  reservationPendingPersistenceStatusValues,
);

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
const jsonObject = <T>(name: string) => jsonb(name).$type<T>().notNull();

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
    display: jsonObject<DemoPresetDisplay>("display"),
    trafficConfig: jsonObject<TrafficConfig>("traffic_config"),
    inventoryConfig: jsonObject<InventoryConfig>("inventory_config"),
    erpConfig: jsonObject<ErpRunConfig>("erp_config"),
    backpressureConfig: jsonObject<BackpressureConfig>("backpressure_config"),
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
    configSnapshot: jsonObject<AcceptedRunConfigSnapshot>("config_snapshot"),
    correlationId: text("correlation_id"),
    saleOfferId: uuid("sale_offer_id").references(() => saleOffers.id, { onDelete: "restrict" }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    trafficStartedAt: timestamp("traffic_started_at", { withTimezone: true }),
    trafficEndedAt: timestamp("traffic_ended_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    adminResetCompletedAt: timestamp("admin_reset_completed_at", { withTimezone: true }),
    administrativeStop: jsonb("administrative_stop").$type<AdministrativeStopEvidence>(),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The baseline hand-authors the constant-expression partial unique index
    // admitting only one non-terminal run. Keep it out of this declaration
    // because Drizzle does not reliably round-trip expression indexes.
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
    runId: uuid("run_id"),
    quantity: integer("quantity").default(1).notNull(),
    reservationToken: text("reservation_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    securedAt: timestamp("secured_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("reservations_reservation_token_unique").on(table.reservationToken),
    uniqueIndex("reservations_backing_order_identity_unique").on(
      table.id,
      table.saleOfferId,
      table.correlationId,
      table.quantity,
    ),
    check("reservations_quantity_positive", sql`${table.quantity} > 0`),
    foreignKey({
      name: "reservations_run_sale_context_fk",
      columns: [table.runId, table.saleOfferId],
      foreignColumns: [demoRunSaleContexts.runId, demoRunSaleContexts.saleOfferId],
    }).onDelete("restrict"),
    index("reservations_sale_offer_id_idx").on(table.saleOfferId),
    index("reservations_run_id_idx").on(table.runId),
    index("reservations_correlation_id_idx").on(table.correlationId),
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
    reservationId: uuid("reservation_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id"),
    quantity: integer("quantity").default(1).notNull(),
    status: orderStatusEnum("status").default("queued").notNull(),
    failureCategory: orderFailureCategoryEnum("failure_category"),
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
    uniqueIndex("orders_erp_attribution_identity_unique").on(table.id, table.correlationId),
    uniqueIndex("orders_notification_attribution_identity_unique").on(
      table.id,
      table.saleOfferId,
      table.correlationId,
    ),
    check("orders_quantity_positive", sql`${table.quantity} > 0`),
    check(
      "orders_confirmed_requires_confirmed_at",
      sql`${table.status} <> 'confirmed' OR ${table.confirmedAt} IS NOT NULL`,
    ),
    check(
      "orders_failed_requires_failed_at",
      sql`${table.status} <> 'failed' OR ${table.failedAt} IS NOT NULL`,
    ),
    check(
      "orders_in_progress_requires_processing_at",
      sql`${table.status} NOT IN ('processing', 'confirmed', 'failed') OR ${table.processingAt} IS NOT NULL`,
    ),
    check(
      "orders_terminal_timestamps_after_queued_at",
      sql`(${table.confirmedAt} IS NULL OR ${table.confirmedAt} >= ${table.queuedAt}) AND (${table.failedAt} IS NULL OR ${table.failedAt} >= ${table.queuedAt})`,
    ),
    foreignKey({
      name: "orders_backing_reservation_fk",
      columns: [table.reservationId, table.saleOfferId, table.correlationId, table.quantity],
      foreignColumns: [
        reservations.id,
        reservations.saleOfferId,
        reservations.correlationId,
        reservations.quantity,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "orders_run_sale_context_fk",
      columns: [table.runId, table.saleOfferId],
      foreignColumns: [demoRunSaleContexts.runId, demoRunSaleContexts.saleOfferId],
    }).onDelete("restrict"),
    index("orders_sale_offer_id_idx").on(table.saleOfferId),
    index("orders_run_id_idx").on(table.runId),
    index("orders_run_id_queued_at_created_at_idx").on(
      table.runId,
      table.queuedAt.desc(),
      table.createdAt.desc(),
    ),
    index("orders_run_id_correlation_id_idx").on(table.runId, table.correlationId),
    index("orders_correlation_id_idx").on(table.correlationId),
    index("orders_status_idx").on(table.status),
  ],
);

/**
 * Durable identity of one actual confirmation POST (D04/D05). The row is
 * written before the HTTP request is sent and keeps the immutable
 * order/reservation/sale/run/quantity/idempotency identity plus correlation
 * lineage, independently of queue delivery identity or BullMQ attempt budgets.
 */
export const erpDispatchCalls = pgTable(
  "erp_dispatch_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull(),
    processingGeneration: integer("processing_generation").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    publicOrderId: text("public_order_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    saleOfferId: uuid("sale_offer_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    correlationId: text("correlation_id").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check("erp_dispatch_calls_quantity_positive", sql`${table.quantity} > 0`),
    check("erp_dispatch_calls_generation_nonnegative", sql`${table.processingGeneration} >= 0`),
    foreignKey({
      name: "erp_dispatch_calls_order_correlation_fk",
      columns: [table.orderId, table.correlationId],
      foreignColumns: [orders.id, orders.correlationId],
    }).onDelete("cascade"),
    index("erp_dispatch_calls_order_id_idx").on(table.orderId),
    index("erp_dispatch_calls_run_id_idx").on(table.runId),
    index("erp_dispatch_calls_idempotency_key_idx").on(table.idempotencyKey),
  ],
);

/** Mock ERP-owned terminal confirmation evidence (D05). */
export const erpConfirmationLedger = pgTable(
  "erp_confirmation_ledger",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    orderId: uuid("order_id").notNull(),
    publicOrderId: text("public_order_id").notNull(),
    reservationId: uuid("reservation_id").notNull(),
    saleOfferId: uuid("sale_offer_id").notNull(),
    runId: uuid("run_id"),
    quantity: integer("quantity").notNull(),
    terminalResult: jsonb("terminal_result").$type<ErpConfirmationResponse>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("erp_confirmation_ledger_quantity_positive", sql`${table.quantity} > 0`),
    index("erp_confirmation_ledger_run_id_idx").on(table.runId),
  ],
);

export const erpAttempts = pgTable(
  "erp_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull(),
    deliveryId: text("delivery_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id").references(() => demoRuns.id, { onDelete: "restrict" }),
    erpCallId: uuid("erp_call_id").references(() => erpDispatchCalls.id, {
      onDelete: "restrict",
    }),
    attemptNumber: integer("attempt_number").notNull(),
    status: erpAttemptStatusEnum("status").notNull(),
    disposition: erpOutcomeDispositionEnum("disposition"),
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
    uniqueIndex("erp_attempts_order_delivery_attempt_unique")
      .on(table.orderId, table.deliveryId, table.attemptNumber)
      .where(sql`${table.erpCallId} is null`),
    uniqueIndex("erp_attempts_erp_call_id_unique").on(table.erpCallId),
    uniqueIndex("erp_attempts_success_idempotency_key_unique").on(table.idempotencyKey),
    check("erp_attempts_attempt_number_positive", sql`${table.attemptNumber} > 0`),
    check("erp_attempts_latency_nonnegative", sql`${table.latencyMs} >= 0`),
    check(
      "erp_attempts_http_status_valid",
      sql`${table.httpStatus} IS NULL OR (${table.httpStatus} >= 100 AND ${table.httpStatus} <= 599)`,
    ),
    check("erp_attempts_finished_after_started", sql`${table.finishedAt} >= ${table.startedAt}`),
    foreignKey({
      name: "erp_attempts_order_correlation_fk",
      columns: [table.orderId, table.correlationId],
      foreignColumns: [orders.id, orders.correlationId],
    }).onDelete("cascade"),
    index("erp_attempts_order_id_idx").on(table.orderId),
    index("erp_attempts_run_id_idx").on(table.runId),
    index("erp_attempts_run_id_finished_at_created_at_idx").on(
      table.runId,
      table.finishedAt.desc(),
      table.createdAt.desc(),
    ),
    index("erp_attempts_run_id_correlation_id_idx").on(table.runId, table.correlationId),
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
    // Durable per-order processing-control fields (D01/D04/D07).
    processingGeneration: integer("processing_generation").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    waitingReason: orderWaitingReasonEnum("waiting_reason"),
    publicationOwner: text("publication_owner"),
    unresolvedErpCallId: uuid("unresolved_erp_call_id"),
    attemptCounts: jsonb("attempt_counts")
      .$type<Partial<Record<ErpOutcomeDisposition, number>>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("order_recovery_jobs_recovery_key_unique").on(table.recoveryKey),
    index("order_recovery_jobs_status_next_attempt_idx").on(table.status, table.nextAttemptAt),
    index("order_recovery_jobs_order_id_idx").on(table.orderId),
    check("order_recovery_jobs_generation_nonnegative", sql`${table.processingGeneration} >= 0`),
    foreignKey({
      name: "order_recovery_jobs_unresolved_erp_call_fk",
      columns: [table.unresolvedErpCallId],
      foreignColumns: [erpDispatchCalls.id],
    }).onDelete("set null"),
  ],
);

/**
 * Restart-safety state per downstream capacity scope (`catalog` or `run:<id>`)
 * (D07). Learned rates and latency samples stay unpersisted; only the durable
 * cooldown and circuit-open expiries survive a restart.
 */
export const erpScopeResilienceState = pgTable("erp_scope_resilience_state", {
  scope: text("scope").primaryKey(),
  cooldownExpiresAt: timestamp("cooldown_expires_at", { withTimezone: true }),
  availabilityRetryAt: timestamp("availability_retry_at", { withTimezone: true }),
  availabilityCircuitOpen: boolean("availability_circuit_open").default(false).notNull(),
  circuitOpenExpiresAt: timestamp("circuit_open_expires_at", { withTimezone: true }),
  nextProbeAt: timestamp("next_probe_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

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
    runId: uuid("run_id"),
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
    index("order_events_run_id_occurred_at_created_at_idx").on(
      table.runId,
      table.occurredAt.desc(),
      table.createdAt.desc(),
    ),
    index("order_events_run_id_correlation_id_idx").on(table.runId, table.correlationId),
    index("order_events_event_name_idx").on(table.eventName),
    index("order_events_occurred_at_idx").on(table.occurredAt),
    foreignKey({
      name: "order_events_run_sale_context_fk",
      columns: [table.runId, table.saleOfferId],
      foreignColumns: [demoRunSaleContexts.runId, demoRunSaleContexts.saleOfferId],
    }).onDelete("restrict"),
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
    runId: uuid("run_id"),
    status: reservationPendingPersistenceStatusEnum("status")
      .default("pending_reconciliation")
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastError: text("last_error"),
    exhaustedAt: timestamp("exhausted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("reservation_pending_persistence_reservation_id_unique").on(table.reservationId),
    check(
      "reservation_pending_persistence_attempt_count_nonnegative",
      sql`${table.attemptCount} >= 0`,
    ),
    foreignKey({
      name: "reservation_pending_persistence_run_sale_context_fk",
      columns: [table.runId, table.saleOfferId],
      foreignColumns: [demoRunSaleContexts.runId, demoRunSaleContexts.saleOfferId],
    }).onDelete("restrict"),
    index("reservation_pending_persistence_run_id_idx").on(table.runId),
  ],
);

export const simulatedNotifications = pgTable(
  "simulated_notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orderId: uuid("order_id").notNull(),
    saleOfferId: uuid("sale_offer_id")
      .notNull()
      .references(() => saleOffers.id, { onDelete: "restrict" }),
    correlationId: text("correlation_id").notNull(),
    runId: uuid("run_id"),
    recipientPlaceholder: text("recipient_placeholder").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("simulated_notifications_order_id_unique").on(table.orderId),
    foreignKey({
      name: "simulated_notifications_order_attribution_fk",
      columns: [table.orderId, table.saleOfferId, table.correlationId],
      foreignColumns: [orders.id, orders.saleOfferId, orders.correlationId],
    }).onDelete("cascade"),
    foreignKey({
      name: "simulated_notifications_run_sale_context_fk",
      columns: [table.runId, table.saleOfferId],
      foreignColumns: [demoRunSaleContexts.runId, demoRunSaleContexts.saleOfferId],
    }).onDelete("restrict"),
    index("simulated_notifications_order_id_idx").on(table.orderId),
    index("simulated_notifications_sale_offer_id_idx").on(table.saleOfferId),
    index("simulated_notifications_run_id_idx").on(table.runId),
    index("simulated_notifications_run_id_recorded_at_created_at_idx").on(
      table.runId,
      table.recordedAt.desc(),
      table.createdAt.desc(),
    ),
    index("simulated_notifications_run_id_correlation_id_idx").on(table.runId, table.correlationId),
  ],
);

export const demoRunSoldOutCounts = pgTable(
  "demo_run_sold_out_counts",
  {
    runId: uuid("run_id")
      .primaryKey()
      .notNull()
      .references(() => demoRuns.id, { onDelete: "cascade" }),
    count: integer("count").default(0).notNull(),
    latestObservedAt: timestamp("latest_observed_at", { withTimezone: true }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [check("demo_run_sold_out_counts_count_nonnegative", sql`${table.count} >= 0`)],
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
    transportAttemptCounts: jsonObject<TransportAttemptCounts>("transport_attempt_counts"),
    httpSummary: jsonObject<TrafficHttpSummary>("http_summary"),
    trafficOutcomeSummary: jsonObject<JsonRecord>("traffic_outcome_summary"),
    trafficDeliverySummary: jsonObject<TrafficDeliverySummary>("traffic_delivery_summary"),
    httpTimingBreakdownSummary: jsonObject<HttpTimingBreakdownSummary>(
      "http_timing_breakdown_summary",
    ),
    loadRunDiagnosticsSummary: jsonObject<RealLoadRunDiagnosticsSummary>(
      "load_run_diagnostics_summary",
    ),
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
    replayPossible: boolean("replay_possible").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
    transportAttemptCounts: jsonObject<TransportAttemptCounts>("transport_attempt_counts"),
    httpSummary: jsonObject<TrafficHttpSummary>("http_summary"),
    trafficDeliverySummary: jsonObject<TrafficDeliverySummary>("traffic_delivery_summary"),
    httpTimingBreakdownSummary: jsonObject<JsonRecord>("http_timing_breakdown_summary"),
    serverReservationTimingSummary: jsonObject<ServerReservationTimingSummary>(
      "server_reservation_timing_summary",
    ).default(emptyServerReservationTimingSummary),
    loadRunDiagnosticsSummary: jsonObject<JsonRecord>("load_run_diagnostics_summary"),
    businessOutcomeSummary: jsonObject<BusinessOutcomeSummary>("business_outcome_summary"),
    terminalInventorySnapshot: jsonb(
      "terminal_inventory_snapshot",
    ).$type<TerminalInventorySnapshot>(),
    runSignalTimelineSummary: jsonb(
      "run_signal_timeline_summary",
    ).$type<RunSignalTimelineSummary>(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("demo_run_summaries_run_id_unique").on(table.runId),
    check("demo_run_summaries_terminal_status", sql`${table.status} IN ('completed', 'failed')`),
    index("demo_run_summaries_captured_at_idx").on(table.capturedAt),
  ],
);

export const publicRuntimePolicies = pgTable(
  "public_runtime_policies",
  {
    id: text("id").default("active").primaryKey(),
    policy: jsonObject<PublicRuntimePolicyMutableContract>("policy"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check("public_runtime_policies_active_singleton", sql`${table.id} = 'active'`)],
);
