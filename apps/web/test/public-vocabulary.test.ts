import { describe, expect, it } from "vitest";
import {
  circuitStateLabel,
  isRunEvidenceSettled,
  publicLimitsLabel,
  publicStatusLabel,
  publicVocabulary,
  rateWindowLabel,
  runEvidenceAbsence,
  trafficDeliveryStatusLabel,
  trafficModeLabel,
} from "../src/app/lib/presentation/public-vocabulary.js";

describe("public vocabulary", () => {
  it("keeps buyer populations and sold-out evidence distinct", () => {
    expect(publicVocabulary.acceptedResponses).toBe("accepted responses");
    expect(publicVocabulary.uniqueReservationsSecured).toBe("Unique reservations secured");
    expect(publicVocabulary.soldOutRejectionsRecorded).toBe(
      "sold-out rejections recorded by Checkout-Surge",
    );
    expect(publicVocabulary.soldOutRejectionsSeen).toBe(
      "sold-out rejections seen by the load generator",
    );
  });

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

  it("translates modes, limits, circuit states, and measurement windows", () => {
    expect(trafficModeLabel("buyer-spike")).toBe("Everyone at once");
    expect(trafficModeLabel("constant-arrival-rate")).toBe("Steady stream");
    expect(publicLimitsLabel(true)).toBe("Public limits apply");
    expect(publicLimitsLabel(false)).toBe("Public limits not applied");
    expect(publicLimitsLabel(undefined)).toBe("Public limits unavailable");
    expect(circuitStateLabel("closed")).toBe("Protection normal");
    expect(circuitStateLabel("open")).toBe("Calls paused to protect the ERP");
    expect(circuitStateLabel("half_open")).toBe("Testing recovery");
    expect(rateWindowLabel(1)).toBe("1-second window");
  });
});
