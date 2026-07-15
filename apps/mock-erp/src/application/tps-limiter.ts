import { performance } from "node:perf_hooks";

const TPS_WINDOW_MS = 1_000;

export interface TpsLimiter {
  acquire(scopeKey: string, maxTps: number): boolean;
}

interface ScopeArrivals {
  acceptedAtMs: number[];
  headIndex: number;
}

export interface SlidingWindowTpsLimiterOptions {
  nowMs?: () => number;
}

/**
 * An in-process, synchronous limiter. Its production clock is monotonic, and
 * callers can inject a millisecond clock for deterministic tests.
 */
export class SlidingWindowTpsLimiter implements TpsLimiter {
  private readonly nowMs: () => number;
  private readonly scopes = new Map<string, ScopeArrivals>();

  constructor(options: SlidingWindowTpsLimiterOptions = {}) {
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  acquire(scopeKey: string, maxTps: number): boolean {
    const nowMs = this.nowMs();
    this.pruneStaleScopes(nowMs);

    const arrivals = this.scopes.get(scopeKey) ?? {
      acceptedAtMs: [],
      headIndex: 0,
    };
    this.expireArrivals(arrivals, nowMs);

    if (arrivals.acceptedAtMs.length - arrivals.headIndex >= maxTps) {
      return false;
    }

    arrivals.acceptedAtMs.push(nowMs);
    this.scopes.set(scopeKey, arrivals);
    return true;
  }

  /** Narrow, read-only state diagnostic intended for focused verification. */
  get activeScopeCount(): number {
    return this.scopes.size;
  }

  private pruneStaleScopes(nowMs: number): void {
    for (const [scopeKey, arrivals] of this.scopes) {
      const newestArrival = arrivals.acceptedAtMs.at(-1);
      if (newestArrival === undefined || nowMs - newestArrival >= TPS_WINDOW_MS) {
        this.scopes.delete(scopeKey);
      }
    }
  }

  private expireArrivals(arrivals: ScopeArrivals, nowMs: number): void {
    let oldestArrival = arrivals.acceptedAtMs[arrivals.headIndex];
    while (oldestArrival !== undefined && nowMs - oldestArrival >= TPS_WINDOW_MS) {
      arrivals.headIndex += 1;
      oldestArrival = arrivals.acceptedAtMs[arrivals.headIndex];
    }

    if (
      arrivals.headIndex > 0 &&
      (arrivals.headIndex >= 1_024 || arrivals.headIndex * 2 >= arrivals.acceptedAtMs.length)
    ) {
      arrivals.acceptedAtMs = arrivals.acceptedAtMs.slice(arrivals.headIndex);
      arrivals.headIndex = 0;
    }
  }
}
