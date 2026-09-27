import * as contracts from "@checkout-surge/contracts";
import { isPgEnum } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/schema.js";

type ExportedPgEnumMetadata = {
  readonly enumName: string;
  readonly enumValues: readonly string[];
};

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
  erpOutcomeDispositionEnum: [
    schema.erpOutcomeDispositionEnum,
    "erp_outcome_disposition",
    contracts.erpOutcomeDispositionValues,
  ],
  orderEventNameEnum: [
    schema.orderEventNameEnum,
    "order_event_name",
    contracts.orderEventNameValues,
  ],
  orderStatusEnum: [schema.orderStatusEnum, "order_status", contracts.orderStatusValues],
  orderWaitingReasonEnum: [
    schema.orderWaitingReasonEnum,
    "order_waiting_reason",
    contracts.orderWaitingReasonValues,
  ],
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
  saleOfferPurposeEnum: [
    schema.saleOfferPurposeEnum,
    "sale_offer_purpose",
    contracts.saleOfferPurposeValues,
  ],
  trafficCompletionEnrichmentStatusEnum: [
    schema.trafficCompletionEnrichmentStatusEnum,
    "traffic_completion_enrichment_status",
    contracts.trafficCompletionEnrichmentStatusValues,
  ],
} as const satisfies Record<string, readonly [ExportedPgEnumMetadata, string, readonly string[]]>;

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
