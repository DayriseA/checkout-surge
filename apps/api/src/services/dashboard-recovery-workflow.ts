import type { DashboardProjection } from "@checkout-surge/contracts";
import { OperationDeadlineExceededError, settleWithAbort } from "../runtime/operation-lifecycle.js";
import type { DashboardRecoveryAdmissionController } from "./dashboard-recovery-admission.js";
import type { DashboardProjectionService } from "./dashboard-recovery-service.js";

export type DashboardRecoveryWorkflowResult =
  | { outcome: "recovered"; response: DashboardProjection }
  | { outcome: "rate_limited" | "at_capacity" | "timed_out" }
  | { outcome: "client_disconnected" };

export interface DashboardRecoveryWorkflowController {
  recover(input: {
    sourceKey: string;
    correlationId: string;
    signal: AbortSignal;
  }): Promise<DashboardRecoveryWorkflowResult>;
}

export class DashboardRecoveryWorkflow implements DashboardRecoveryWorkflowController {
  constructor(
    private readonly options: {
      admission: DashboardRecoveryAdmissionController;
      recovery: DashboardProjectionService;
    },
  ) {}

  async recover(input: {
    sourceKey: string;
    correlationId: string;
    signal: AbortSignal;
  }): Promise<DashboardRecoveryWorkflowResult> {
    try {
      const admission = await this.options.admission.admit(input.sourceKey, input.signal);
      if (admission.outcome !== "admitted") {
        return { outcome: admission.outcome };
      }

      try {
        const response = await settleWithAbort(
          this.options.recovery.getRecovery({
            correlationId: input.correlationId,
            signal: input.signal,
          }),
          input.signal,
        );
        return { outcome: "recovered", response };
      } finally {
        admission.release();
      }
    } catch (error) {
      if (!input.signal.aborted) throw error;
      return {
        outcome:
          input.signal.reason instanceof OperationDeadlineExceededError
            ? "timed_out"
            : "client_disconnected",
      };
    }
  }
}
