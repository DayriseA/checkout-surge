import * as contracts from "@checkout-surge/contracts";
import { isPgEnum, type PgEnum } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/schema.js";

type ExportedPgEnum = PgEnum<[string, ...string[]]>;

const enumInventory = {
  demoPresetVisibilityEnum: [
    schema.demoPresetVisibilityEnum,
    "demo_preset_visibility",
    contracts.demoPresetVisibilityValues,
  ],
  demoRunOperatorModeEnum: [
    schema.demoRunOperatorModeEnum,
    "demo_run_operator_mode",
    contracts.operatorModeValues,
  ],
  demoRunReservationOutcomeEnum: [
    schema.demoRunReservationOutcomeEnum,
    "demo_run_reservation_outcome",
    contracts.demoRunReservationOutcomeValues,
  ],
  demoRunReservationOutcomeSourceEnum: [
    schema.demoRunReservationOutcomeSourceEnum,
    "demo_run_reservation_outcome_source",
    contracts.demoRunReservationOutcomeSourceValues,
  ],
  demoRunStatusEnum: [schema.demoRunStatusEnum, "demo_run_status", contracts.demoRunStatusValues],
  demoRunTrafficStatusEnum: [
    schema.demoRunTrafficStatusEnum,
    "demo_run_traffic_status",
    contracts.trafficExecutionStatusValues,
  ],
  erpAttemptStatusEnum: [
    schema.erpAttemptStatusEnum,
    "erp_attempt_status",
    contracts.erpAttemptStatusValues,
  ],
  orderEventNameEnum: [
    schema.orderEventNameEnum,
    "order_event_name",
    contracts.orderEventNameValues,
  ],
  orderStatusEnum: [schema.orderStatusEnum, "order_status", contracts.orderStatusValues],
  recoveryJobStatusEnum: [
    schema.recoveryJobStatusEnum,
    "recovery_job_status",
    contracts.recoveryJobStatusValues,
  ],
  reservationPendingPersistenceStatusEnum: [
    schema.reservationPendingPersistenceStatusEnum,
    "reservation_pending_persistence_status",
    contracts.reservationPendingPersistenceStatusValues,
  ],
  reservationStatusEnum: [
    schema.reservationStatusEnum,
    "reservation_status",
    contracts.reservationStatusValues,
  ],
  saleOfferPurposeEnum: [
    schema.saleOfferPurposeEnum,
    "sale_offer_purpose",
    contracts.saleOfferPurposeValues,
  ],
  simulatedNotificationChannelEnum: [
    schema.simulatedNotificationChannelEnum,
    "simulated_notification_channel",
    contracts.simulatedNotificationChannelValues,
  ],
  simulatedNotificationStatusEnum: [
    schema.simulatedNotificationStatusEnum,
    "simulated_notification_status",
    contracts.simulatedNotificationStatusValues,
  ],
  trafficCompletionEnrichmentStatusEnum: [
    schema.trafficCompletionEnrichmentStatusEnum,
    "traffic_completion_enrichment_status",
    contracts.trafficCompletionEnrichmentStatusValues,
  ],
} as const satisfies Record<string, readonly [ExportedPgEnum, string, readonly string[]]>;

describe("PostgreSQL enum vocabulary parity", () => {
  it("explicitly inventories every exported pgEnum declaration", () => {
    const exportedEnumNames = Object.entries(schema)
      .filter(([, value]) => isPgEnum(value))
      .map(([name]) => name)
      .sort();

    expect(exportedEnumNames).toEqual(Object.keys(enumInventory).sort());
  });

  it.each(
    Object.entries(enumInventory),
  )("%s matches its contract tuple and SQL enum name", (_exportName, [
    databaseEnum,
    sqlName,
    contractValues,
  ]) => {
    expect(isPgEnum(databaseEnum)).toBe(true);
    if (!isPgEnum(databaseEnum)) return;

    expect(databaseEnum.enumName).toBe(sqlName);
    expect(databaseEnum.enumValues).toEqual(contractValues);
    expect(databaseEnum.enumValues.length).toBeGreaterThan(0);
    expect(new Set(databaseEnum.enumValues).size).toBe(databaseEnum.enumValues.length);
  });
});
