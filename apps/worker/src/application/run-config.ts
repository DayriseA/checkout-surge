import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";

export interface RunConfigReader {
  read(runId: string): Promise<AcceptedRunConfigSnapshot | null>;
}

export function toErpRequestConfig(snapshot: AcceptedRunConfigSnapshot) {
  return {
    latencyMs: snapshot.erpConfig.latencyMs,
    maxTps: snapshot.erpConfig.maxTps,
    errorRate: snapshot.erpConfig.errorRate,
    forcedOutage: snapshot.erpConfig.forcedOutage,
  };
}
