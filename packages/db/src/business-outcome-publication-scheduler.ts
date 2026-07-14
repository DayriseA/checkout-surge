export const businessOutcomePublicationWindowMs = 500;

export interface BusinessOutcomePublicationScope {
  saleOfferId: string;
  runId?: string;
  correlationId?: string;
  occurredAt?: Date;
}

export class BusinessOutcomePublicationScheduler {
  private readonly pending = new Map<string, BusinessOutcomePublicationScope>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private accepting = true;
  private abandoned = false;

  constructor(
    private readonly options: {
      publish(scope: BusinessOutcomePublicationScope): Promise<unknown>;
      onError(error: unknown, scope: BusinessOutcomePublicationScope): void;
      onDrop?(scope: BusinessOutcomePublicationScope): void;
      windowMs?: number;
      maxPendingScopes?: number;
      closeTimeoutMs?: number;
    },
  ) {}

  markDirty(scope: BusinessOutcomePublicationScope): void {
    if (!this.accepting) return;
    const key = scopeKey(scope);
    const maximum = this.options.maxPendingScopes ?? 64;
    if (!this.pending.has(key) && this.pending.size >= maximum) {
      const oldest = this.pending.keys().next().value as string | undefined;
      if (oldest) {
        const dropped = this.pending.get(oldest);
        this.pending.delete(oldest);
        if (dropped) {
          try {
            this.options.onDrop?.(dropped);
          } catch {
            // Drop reporting is advisory and markDirty must remain synchronous and safe.
          }
        }
      }
    }
    this.pending.set(key, scope);
    this.schedule();
  }

  clearRun(runId: string): void {
    for (const [key, scope] of this.pending) {
      if (scope.runId === runId) this.pending.delete(key);
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.pending.size > 0 || this.inFlight) {
      if (!this.inFlight) this.startFlush();
      await this.inFlight;
    }
  }

  async close(): Promise<void> {
    this.accepting = false;
    const timeoutMs = this.options.closeTimeoutMs ?? 5_000;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.abandoned = true;
          this.pending.clear();
          resolve();
        }, timeoutMs);
        timeout.unref();
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
    this.pending.clear();
  }

  private schedule(): void {
    if (this.timer || this.inFlight || !this.accepting) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startFlush();
    }, this.options.windowMs ?? businessOutcomePublicationWindowMs);
    this.timer.unref();
  }

  private startFlush(): void {
    if (this.inFlight || this.pending.size === 0) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.inFlight = this.publishBatch(batch).finally(() => {
      this.inFlight = null;
      if (this.pending.size > 0) this.schedule();
    });
  }

  private async publishBatch(batch: readonly BusinessOutcomePublicationScope[]): Promise<void> {
    for (const scope of batch) {
      if (this.abandoned) break;
      try {
        await this.options.publish(scope);
      } catch (error) {
        try {
          this.options.onError(error, scope);
        } catch {
          // Advisory error reporting cannot make durable domain work fail.
        }
      }
    }
  }
}

function scopeKey(scope: BusinessOutcomePublicationScope): string {
  return JSON.stringify([scope.runId ?? null, scope.saleOfferId]);
}
