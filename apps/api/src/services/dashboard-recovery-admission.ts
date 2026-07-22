import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { abortReason } from "../runtime/operation-lifecycle.js";

export type DashboardRecoveryAdmission =
  | { outcome: "admitted"; release(): void }
  | { outcome: "rate_limited" | "at_capacity" };
export interface DashboardRecoveryAdmissionController {
  admit(sourceKey: string, signal?: AbortSignal): Promise<DashboardRecoveryAdmission>;
}

export class DashboardRecoveryAdmissionService implements DashboardRecoveryAdmissionController {
  private inFlight = 0;
  private budgetWindow = -1;
  private globalRequestCount = 0;
  private readonly sourceRequestCounts = new Map<string, number>();

  constructor(
    private readonly options: {
      maxConcurrent: number;
      globalMax: number;
      perSourceMax: number;
      windowSeconds: number;
      logger: CheckoutSurgeLogger;
      now?: () => Date;
    },
  ) {}
  async admit(sourceKey: string, signal?: AbortSignal): Promise<DashboardRecoveryAdmission> {
    if (signal?.aborted) throw abortReason(signal);

    if (this.inFlight >= this.options.maxConcurrent) {
      this.options.logger.warn(
        { reason: "local_capacity", recoveryInFlight: this.inFlight },
        "Dashboard recovery rejected.",
      );
      return { outcome: "at_capacity" };
    }

    this.rollBudgetWindow(this.options.now?.() ?? new Date());
    const sourceRequestCount = this.sourceRequestCounts.get(sourceKey) ?? 0;
    const budgetReason =
      sourceRequestCount >= this.options.perSourceMax
        ? "source_rate"
        : this.globalRequestCount >= this.options.globalMax
          ? "global_rate"
          : null;
    if (budgetReason) {
      this.options.logger.warn(
        { reason: budgetReason, recoveryInFlight: this.inFlight },
        "Dashboard recovery rejected.",
      );
      return { outcome: "rate_limited" };
    }

    this.globalRequestCount += 1;
    this.sourceRequestCounts.set(sourceKey, sourceRequestCount + 1);
    this.inFlight += 1;
    this.options.logger.debug(
      { outcome: "admitted", recoveryInFlight: this.inFlight },
      "Dashboard recovery admitted.",
    );

    let released = false;
    return {
      outcome: "admitted",
      release: () => {
        if (!released) {
          released = true;
          this.inFlight -= 1;
          this.options.logger.debug(
            { outcome: "released", recoveryInFlight: this.inFlight },
            "Dashboard recovery permit released.",
          );
        }
      },
    };
  }

  private rollBudgetWindow(now: Date): void {
    const window = Math.floor(now.getTime() / (this.options.windowSeconds * 1_000));
    if (window <= this.budgetWindow) return;

    this.budgetWindow = window;
    this.globalRequestCount = 0;
    this.sourceRequestCounts.clear();
  }
}
