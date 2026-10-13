import { describe, expect, it } from "vitest";
import { buildSeedPresets } from "../../src/seed-presets.js";

describe("seeded presets", () => {
  it("say the ERP is slow only when they slow it below the standard ERP", () => {
    const presets = buildSeedPresets();
    const standard = presets.find((preset) => preset.slug === "preview-1k")?.erpConfig;
    if (!standard) throw new Error("Expected the standard ERP's preset.");
    for (const { slug, display, erpConfig } of presets) {
      if (display.outcomeFocus.includes("downstream_capacity"))
        expect(erpConfig.maxTps, slug).toBeLessThan(standard.maxTps);
      if (display.outcomeFocus.includes("downstream_latency"))
        expect(erpConfig.latencyMs, slug).toBeGreaterThan(standard.latencyMs);
    }
  });
});
