import { describe, expect, it } from "vitest";
import {
  isRunEvidenceSettled,
  outcomeFocusLabel,
  publicStatusLabel,
  runEvidenceAbsence,
  trafficDeliveryStatusLabel,
} from "../src/app/lib/presentation/public-vocabulary.js";

describe("public vocabulary", () => {
  it("settles load-generator absence when traffic ends and durable absence only at a terminal status", () => {
    const traffic = {
      source: "load-generator",
      pending: "Waiting",
      settled: "Unavailable",
    } as const;
    const durable = {
      source: "durable-processing",
      pending: "Waiting",
      settled: "Unavailable",
    } as const;

    expect(runEvidenceAbsence(null, traffic)).toBe("No run has started");
    expect(runEvidenceAbsence(null, durable)).toBe("No run has started");
    for (const status of ["starting", "active"] as const) {
      expect(runEvidenceAbsence(status, traffic)).toBe("Waiting");
      expect(runEvidenceAbsence(status, durable)).toBe("Waiting");
    }
    // Traffic has ended by `draining`, so only durable processing evidence can still arrive.
    expect(runEvidenceAbsence("draining", traffic)).toBe("Unavailable");
    expect(runEvidenceAbsence("draining", durable)).toBe("Waiting");
    for (const status of ["completed", "failed"] as const) {
      expect(runEvidenceAbsence(status, traffic)).toBe("Unavailable");
      expect(runEvidenceAbsence(status, durable)).toBe("Unavailable");
    }
    expect(isRunEvidenceSettled("draining", "load-generator")).toBe(true);
    expect(isRunEvidenceSettled("draining", "durable-processing")).toBe(false);
  });

  it("qualifies all three status families and collapses partial delivery", () => {
    expect(publicStatusLabel({ family: "load-generator", status: "succeeded" })).toBe(
      "Load generator: Finished",
    );
    expect(publicStatusLabel({ family: "traffic-delivery", status: "warning" })).toBe(
      "Traffic delivery: Partial delivery",
    );
    expect(trafficDeliveryStatusLabel("degraded")).toBe("Partial delivery");
    expect(publicStatusLabel({ family: "run", status: "draining" })).toBe("Run: Finishing");
  });

  it("explains the two downstream constraints on public preset cards", () => {
    expect(outcomeFocusLabel("downstream_capacity")).toBe(
      "A slow ERP sets the pace; orders wait in the queue",
    );
    expect(outcomeFocusLabel("downstream_latency")).toBe(
      "Slow ERP responses limit orders in flight",
    );
  });
});
