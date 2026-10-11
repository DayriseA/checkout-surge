import { describe, expect, it } from "vitest";
import {
  comparisonDetailParamsSchema,
  comparisonDetailResponseSchema,
  comparisonStageRoles,
  demoRunSnapshotSchema,
  startComparisonRequestSchema,
} from "../src/index.js";
import { previewRunConfigSnapshotFixture } from "../src/testing.js";

const id = "11111111-1111-4111-8111-111111111111";
const runIds = [
  "22222222-2222-4222-8222-222222222221",
  "22222222-2222-4222-8222-222222222222",
  "22222222-2222-4222-8222-222222222223",
  "22222222-2222-4222-8222-222222222224",
];
const modes = ["demo", "without_redis", "demo", "without_order_queue"];
function detail() {
  return {
    comparisonId: id,
    acceptedAt: "2026-10-11T00:00:00.000Z",
    autoResetAt: "2026-10-11T00:15:00.000Z",
    state: "running",
    currentStage: 0,
    currentRunId: runIds[0],
    terminalReason: null,
    currentFailureReason: null,
    terminalAt: null,
    timestamp: "2026-10-11T00:00:00.000Z",
    stages: comparisonStageRoles.map((role, index) => ({
      role,
      runId: runIds[index],
      executionMode: modes[index],
      availability: index === 0 ? "unavailable" : "not_run",
    })),
  };
}

describe("fixed comparison contracts", () => {
  it("accepts correlation only and rejects malformed parent IDs", () => {
    expect(startComparisonRequestSchema.parse({})).toEqual({});
    expect(startComparisonRequestSchema.parse({ correlationId: "comparison" })).toEqual({
      correlationId: "comparison",
    });
    for (const payload of [
      { presetSlug: "architecture-comparison" },
      { executionMode: "demo" },
      { configOverride: {} },
      { children: [] },
    ])
      expect(startComparisonRequestSchema.safeParse(payload).success).toBe(false);
    expect(comparisonDetailParamsSchema.safeParse({ comparisonId: "invalid" }).success).toBe(false);
  });
  it("retains four fixed child identities and rejects reordered stages or a mismatched current child", () => {
    const value = detail();
    expect(comparisonDetailResponseSchema.parse(value).stages).toHaveLength(4);
    expect(
      comparisonDetailResponseSchema.safeParse({ ...value, currentRunId: runIds[1] }).success,
    ).toBe(false);
    expect(
      comparisonDetailResponseSchema.safeParse({ ...value, stages: [...value.stages].reverse() })
        .success,
    ).toBe(false);
  });
  it("retains optional membership on ordinary snapshots without changing ordinary producers", () => {
    const run = {
      runId: runIds[0],
      presetId: "33333333-3333-4333-8333-333333333338",
      presetName: "Comparison",
      operatorMode: "public",
      status: "starting",
      trafficStatus: "starting",
      configSnapshot: previewRunConfigSnapshotFixture(),
      startedAt: "2026-10-11T00:00:00.000Z",
      autoResetAt: "2026-10-11T00:15:00.000Z",
    };
    expect(demoRunSnapshotSchema.parse({ ...run, comparisonId: id }).comparisonId).toBe(id);
    expect(demoRunSnapshotSchema.parse(run).comparisonId).toBeUndefined();
  });
});
