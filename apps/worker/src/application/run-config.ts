import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";

export interface RunConfigReader {
  read(runId: string): Promise<AcceptedRunConfigSnapshot | null>;
}

export class MissingAcceptedRunSnapshotError extends Error {
  override readonly name = "MissingAcceptedRunSnapshotError";
  constructor(readonly runId: string) {
    super(`Accepted run snapshot was not found for order job run ${runId}.`);
  }
}

export function acceptedRunSnapshotInterventionReason(error: unknown): string | null {
  if (error instanceof MissingAcceptedRunSnapshotError) return "accepted_run_snapshot_missing";
  if (error instanceof Error && error.name === "PersistedRunConfigCorruptionError") {
    return "accepted_run_snapshot_invalid";
  }
  return null;
}

export function toErpRequestConfig(snapshot: AcceptedRunConfigSnapshot) {
  return {
    latencyMs: snapshot.erpConfig.latencyMs,
    maxTps: snapshot.erpConfig.maxTps,
    errorRate: snapshot.erpConfig.errorRate,
    forcedOutage: snapshot.erpConfig.forcedOutage,
  };
}
