import { describe, expect, it } from "vitest";
import {
  presentCustomRunIssues,
  presentInvalidCustomRunControls,
} from "../src/app/lib/presentation/custom-run-issue-presentation.js";

describe("custom run issue presentation", () => {
  it("maps issue paths to distinct fields and groups", () => {
    expect(
      presentCustomRunIssues([
        ["configOverride", "trafficConfig", "buyerCount"],
        ["erpConfig", "errorRate"],
        ["trafficConfig", "buyerCount"],
      ]),
    ).toEqual([
      {
        fieldId: "custom-buyers",
        fieldError: "Use an available value for Buyer count.",
        group: "traffic",
        key: "custom-buyers",
        message: "Buyer count: Use an available value for Buyer count.",
        targetId: "custom-buyers",
      },
      {
        fieldId: "custom-erp-error-rate",
        fieldError: "Use an available value for Failure rate.",
        group: "erp",
        key: "custom-erp-error-rate",
        message: "Failure rate: Use an available value for Failure rate.",
        targetId: "custom-erp-error-rate",
      },
    ]);
  });

  it("keeps group and unknown-path fallbacks safe", () => {
    expect(
      presentCustomRunIssues([["erpConfig", "requestTimeoutMs"], ["internalOnlyField"]]),
    ).toEqual([
      {
        group: "advanced",
        key: "custom-advanced-validation-error",
        message: "Review the Advanced protection settings and keep values within supported limits.",
        targetId: "custom-advanced-validation-error",
      },
      {
        group: "form",
        key: "custom-form-error",
        message: "Review the custom run settings and try again.",
        targetId: "custom-form-error",
      },
    ]);
  });

  it("maps invalid controls without defining their validation rules", () => {
    expect(
      presentInvalidCustomRunControls([
        { controlId: "custom-buyers", message: "Value must be greater than or equal to 1." },
        { controlId: "unknown-control", message: "Ignored." },
      ]),
    ).toEqual([
      {
        fieldId: "custom-buyers",
        fieldError: "Value must be greater than or equal to 1.",
        group: "traffic",
        key: "custom-buyers",
        message: "Buyer count: Value must be greater than or equal to 1.",
        targetId: "custom-buyers",
      },
    ]);
  });
});
