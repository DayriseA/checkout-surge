import {
  type DashboardProjection,
  type DashboardProjectionScope,
  dashboardProjectionScopeId,
} from "@checkout-surge/contracts";
import type { DashboardProjectionDirtySignal } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { normalizeCorrelationId } from "@checkout-surge/logger";
import {
  abortReason,
  OperationDeadlineExceededError,
  settleWithAbort,
} from "../runtime/operation-lifecycle.js";
import type { DashboardProjectionService } from "./dashboard-recovery-service.js";

export const dashboardProjectionMaxLatencyMs = 1_000;
export const defaultDashboardProjectionMaxPendingScopes = 8;

interface DirtyProjection {
  correlationId: string;
  dueAt: number;
  generation: number;
  urgent: boolean;
  scope?: DashboardProjectionScope;
}

export interface DashboardProjectionPublicationSchedulerOptions {
  projectionService: Pick<DashboardProjectionService, "build">;
  publish(projection: DashboardProjection): void | Promise<void>;
  logger: CheckoutSurgeLogger;
  buildTimeoutMs: number;
  maxLatencyMs?: number;
  maxPendingScopes?: number;
}

/**
 * Builds at most one complete projection at a time and retains one coalesced
 * trailing build per dirty scope. There is deliberately no signal-count
 * threshold: producer aggregation already provides the useful work boundary.
 */
export class DashboardProjectionPublicationScheduler {
  private readonly pending = new Map<string, DirtyProjection>();
  private readonly maxLatencyMs: number;
  private readonly maxPendingScopes: number;
  private readonly buildTimeoutMs: number;
  private timer: NodeJS.Timeout | null = null;
  private buildInFlight: Promise<void> | null = null;
  private buildAbortController: AbortController | null = null;
  private generation = 0;
  private accepting = true;

  constructor(private readonly options: DashboardProjectionPublicationSchedulerOptions) {
    this.buildTimeoutMs = requirePositiveSafeInteger(options.buildTimeoutMs, "buildTimeoutMs");
    this.maxLatencyMs = requirePositiveSafeInteger(
      options.maxLatencyMs ?? dashboardProjectionMaxLatencyMs,
      "maxLatencyMs",
    );
    this.maxPendingScopes = requirePositiveSafeInteger(
      options.maxPendingScopes ?? defaultDashboardProjectionMaxPendingScopes,
      "maxPendingScopes",
    );
  }

  markDirty(signal: DashboardProjectionDirtySignal): void {
    if (!this.accepting) return;

    const scope = signal.scope;
    const urgent = scope !== undefined;
    const key = scope ? dashboardProjectionScopeId(scope) : "current";

    if (!this.pending.has(key) && this.pending.size >= this.maxPendingScopes) {
      const oldestKey = this.pending.keys().next().value as string | undefined;
      if (oldestKey) this.pending.delete(oldestKey);
      this.options.logger.warn(
        { maxPendingScopes: this.maxPendingScopes, droppedScope: oldestKey },
        "Dashboard projection publication scope limit reached; dropped the oldest dirty scope.",
      );
    }

    const existing = this.pending.get(key);
    this.pending.set(key, {
      ...(scope ? { scope } : {}),
      correlationId: normalizeCorrelationId(signal.correlationId),
      dueAt: urgent ? Date.now() : (existing?.dueAt ?? Date.now() + this.maxLatencyMs),
      generation: ++this.generation,
      urgent: urgent || (existing?.urgent ?? false),
    });
    this.scheduleNext();
  }

  async flush(): Promise<void> {
    this.clearTimer();
    while (this.pending.size > 0 || this.buildInFlight) {
      const before = this.pendingSignature();
      if (!this.buildInFlight) this.startNextBuild();
      await this.buildInFlight;
      if (this.accepting && this.pendingSignature() === before) return;
    }
  }

  async close(): Promise<void> {
    if (!this.accepting) {
      await this.buildInFlight;
      return;
    }
    this.accepting = false;
    this.clearTimer();
    this.pending.clear();
    this.buildAbortController?.abort(new Error("Dashboard projection publication is closing."));
    await this.buildInFlight;
  }

  private scheduleNext(): void {
    if (this.buildInFlight || this.timer || this.pending.size === 0) return;
    const delayMs = Math.max(
      0,
      Math.min(
        ...[...this.pending.values()].map((dirty) => (dirty.urgent ? 0 : dirty.dueAt - Date.now())),
      ),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startNextBuild();
    }, delayMs);
    this.timer.unref?.();
  }

  private startNextBuild(): void {
    if (this.buildInFlight || this.pending.size === 0) return;
    this.clearTimer();
    const entry =
      [...this.pending.entries()].find(([, dirty]) => dirty.urgent) ??
      this.pending.entries().next().value;
    if (!entry) return;
    const [key, dirty] = entry;
    this.pending.delete(key);
    const lifecycle = createBuildLifecycle(this.buildTimeoutMs);
    this.buildAbortController = lifecycle.controller;

    this.buildInFlight = settleWithAbort(
      this.buildAndPublish(dirty, lifecycle.controller.signal),
      lifecycle.controller.signal,
    )
      .catch((error: unknown) => {
        if (!this.accepting) return;
        const retained = this.pending.get(key);
        if (!retained) {
          this.pending.set(key, {
            ...dirty,
            urgent: false,
            dueAt: Date.now() + this.maxLatencyMs,
          });
        }
        this.options.logger.error(
          {
            err: error,
            scopeId: key,
            correlationId: dirty.correlationId,
          },
          "Dashboard projection build or publication failed; retained the dirty scope.",
        );
      })
      .finally(() => {
        lifecycle.dispose();
        if (this.buildAbortController === lifecycle.controller) {
          this.buildAbortController = null;
        }
        this.buildInFlight = null;
        this.scheduleNext();
      });
  }

  private async buildAndPublish(dirty: DirtyProjection, signal: AbortSignal): Promise<void> {
    const projection = await this.options.projectionService.build({
      correlationId: dirty.correlationId,
      signal,
      ...(dirty.scope ? { scope: dirty.scope } : {}),
    });
    if (signal.aborted) throw abortReason(signal);
    await this.options.publish(projection);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private pendingSignature(): string {
    return [...this.pending.entries()]
      .map(([key, dirty]) => `${key}:${dirty.generation}`)
      .join("|");
  }
}

function createBuildLifecycle(timeoutMs: number): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new OperationDeadlineExceededError(timeoutMs));
    }
  }, timeoutMs);
  deadline.unref?.();
  return {
    controller,
    dispose: () => clearTimeout(deadline),
  };
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}
