import { describe, expect, it } from "vitest";
import { loadGateConfig, loadGuardConfig } from "../src/config.js";

const production = {
  FLY_APP_NAME: "checkout-surge-gate",
  CORE_FLY_APP: "checkout-surge-core",
  RUNNER_FLY_APP: "checkout-surge-runner",
  STORES_FLY_APP: "checkout-surge-stores",
  EXPECTED_FLY_ORGANIZATION: "personal",
  CORE_FLY_API_TOKEN: "core-token",
  RUNNER_FLY_API_TOKEN: "runner-token",
  STORES_FLY_API_TOKEN: "stores-token",
  GATE_LIFECYCLE_TOKEN: "lifecycle-token",
  CORE_MACHINE_CONFIG_FILE: "/fly/core-machine.json",
};

describe("remote-store configuration", () => {
  for (const load of [loadGateConfig, loadGuardConfig]) {
    it(`${load.name} permits only the exact production app tuple in personal`, () => {
      expect(load(production).stores).toMatchObject({
        appName: "checkout-surge-stores",
        organization: "personal",
      });
      for (const key of [
        "FLY_APP_NAME",
        "CORE_FLY_APP",
        "RUNNER_FLY_APP",
        "STORES_FLY_APP",
        "EXPECTED_FLY_ORGANIZATION",
      ]) {
        expect(() => load({ ...production, [key]: "other-app" })).toThrow(/production app tuple/);
      }
    });

    it(`${load.name} retains proof isolation`, () => {
      const proof = {
        ...production,
        FLY_APP_NAME: "cs-proof-gate",
        CORE_FLY_APP: "cs-proof-core",
        RUNNER_FLY_APP: "cs-proof-runner",
        STORES_FLY_APP: "cs-proof-stores",
        EXPECTED_FLY_ORGANIZATION: "playground-416",
      };
      expect(load(proof).stores?.organization).toBe("playground-416");
      for (const key of ["CORE_FLY_APP", "RUNNER_FLY_APP", "STORES_FLY_APP"] as const) {
        expect(() => load({ ...proof, [key]: production[key] })).toThrow(/Production apps/);
      }
      expect(() => load({ ...proof, EXPECTED_FLY_ORGANIZATION: "personal" })).toThrow(
        /production app tuple/,
      );
    });
  }
});
