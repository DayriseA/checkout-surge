import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ReadinessCheck } from "@checkout-surge/contracts";
import type { LoadOrchestratorConfig } from "./config.js";

export interface LoadOrchestratorReadiness {
  checks(): Promise<ReadinessCheck[]>;
}

export function createLoadOrchestratorReadiness(
  config: LoadOrchestratorConfig,
): LoadOrchestratorReadiness {
  return {
    async checks() {
      return [
        {
          name: "api_base_url_configured",
          status: config.apiBaseUrl ? "ok" : "unavailable",
        },
        {
          name: "preset_traffic_start_enabled",
          status: "ok",
        },
        await k6BinaryCheck(config.k6Binary),
      ];
    },
  };
}

async function k6BinaryCheck(k6Binary: string): Promise<ReadinessCheck> {
  if (k6Binary.includes("/")) {
    try {
      await access(k6Binary, constants.X_OK);
      return { name: "k6_binary_executable", status: "ok" };
    } catch (error) {
      return {
        name: "k6_binary_executable",
        status: "unavailable",
        message: error instanceof Error ? error.message : "Configured k6 binary is not executable.",
      };
    }
  }

  return {
    name: "k6_binary_executable",
    status: "degraded",
    message: "Readiness cannot verify PATH binaries until execution starts.",
  };
}
