import { createHash } from "node:crypto";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { abortReason, settleWithAbort } from "../runtime/operation-lifecycle.js";

const admissionScript = `
local global = tonumber(redis.call('GET', KEYS[1]) or '0')
local source = tonumber(redis.call('GET', KEYS[2]) or '0')
if source >= tonumber(ARGV[2]) then return 'source' end
if global >= tonumber(ARGV[1]) then return 'global' end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[3], 'NX')
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], ARGV[3], 'NX')
return 'allowed'
`;

export interface DashboardRecoveryBudgetStore {
  admit(input: {
    sourceKey: string;
    globalMax: number;
    perSourceMax: number;
    windowSeconds: number;
    now: Date;
    signal?: AbortSignal;
  }): Promise<"allowed" | "global" | "source">;
}
export type DashboardRecoveryAdmission =
  | { outcome: "admitted"; release(): void }
  | { outcome: "rate_limited" | "at_capacity" | "unavailable" };
export interface DashboardRecoveryAdmissionController {
  admit(sourceKey: string, signal?: AbortSignal): Promise<DashboardRecoveryAdmission>;
}

export class RedisDashboardRecoveryBudgetStore implements DashboardRecoveryBudgetStore {
  constructor(
    private readonly createClient: () => {
      eval(...args: unknown[]): Promise<unknown>;
      disconnect(): void;
    },
  ) {}
  async admit(input: {
    sourceKey: string;
    globalMax: number;
    perSourceMax: number;
    windowSeconds: number;
    now: Date;
    signal?: AbortSignal;
  }) {
    const redis = this.createClient();
    const window = Math.floor(input.now.getTime() / (input.windowSeconds * 1000));
    const tag = `{${window}}`;
    const sourceHash = createHash("sha256").update(input.sourceKey).digest("hex");
    const disconnect = () => redis.disconnect();
    input.signal?.addEventListener("abort", disconnect, { once: true });
    try {
      const operation = redis.eval(
        admissionScript,
        2,
        `dashboard:recovery:${tag}:global`,
        `dashboard:recovery:${tag}:source:${sourceHash}`,
        input.globalMax,
        input.perSourceMax,
        input.windowSeconds * 2,
      );
      const result = input.signal
        ? await settleWithAbort(operation, input.signal)
        : await operation;
      if (result === "allowed" || result === "global" || result === "source") return result;
      throw new Error("Unexpected dashboard recovery limiter response.");
    } finally {
      input.signal?.removeEventListener("abort", disconnect);
      disconnect();
    }
  }
}

export class DashboardRecoveryAdmissionService implements DashboardRecoveryAdmissionController {
  private inFlight = 0;
  constructor(
    private readonly options: {
      store: DashboardRecoveryBudgetStore;
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
    this.inFlight += 1;
    this.options.logger.debug(
      { outcome: "admission_pending", recoveryInFlight: this.inFlight },
      "Dashboard recovery admission started.",
    );
    try {
      const budgetOperation = this.options.store.admit({
        sourceKey,
        globalMax: this.options.globalMax,
        perSourceMax: this.options.perSourceMax,
        windowSeconds: this.options.windowSeconds,
        now: this.options.now?.() ?? new Date(),
        ...(signal ? { signal } : {}),
      });
      const budget = signal
        ? await settleWithAbort(budgetOperation, signal)
        : await budgetOperation;
      if (budget !== "allowed") {
        this.options.logger.warn(
          { reason: `${budget}_rate`, recoveryInFlight: this.inFlight },
          "Dashboard recovery rejected.",
        );
        this.inFlight -= 1;
        return { outcome: "rate_limited" };
      }
    } catch (error) {
      this.inFlight -= 1;
      if (signal?.aborted) throw abortReason(signal);
      this.options.logger.error(
        { err: error, reason: "limiter_unavailable" },
        "Dashboard recovery rejected.",
      );
      return { outcome: "unavailable" };
    }
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
}
