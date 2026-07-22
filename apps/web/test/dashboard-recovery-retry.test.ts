import { describe, expect, it, vi } from "vitest";
import { createDashboardRecoveryRetryScheduler } from "../src/app/components/realtime/dashboard-recovery-retry.js";

describe("dashboard recovery retry scheduler", () => {
  it("coalesces timers, clears identity before retry, bounds backoff, and resets", () => {
    vi.useFakeTimers();
    const observed: Array<{ attempt: number; delayMs: number | null; scheduled: boolean }> = [];
    let scheduler!: ReturnType<typeof createDashboardRecoveryRetryScheduler>;
    const onRetry = vi.fn(() => scheduler.schedule());
    scheduler = createDashboardRecoveryRetryScheduler({
      onRetry,
      onStateChange: (state) => observed.push(state),
      policy: { initialDelayMs: 100, maximumAttempts: 4, maximumDelayMs: 250, multiplier: 2 },
    });

    expect(scheduler.schedule()).toEqual({
      attempt: 1,
      delayMs: 100,
      exhausted: false,
      scheduled: true,
    });
    expect(scheduler.schedule()).toEqual({
      attempt: 1,
      delayMs: 100,
      exhausted: false,
      scheduled: true,
    });
    vi.advanceTimersByTime(100);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(scheduler.state()).toEqual({
      attempt: 2,
      delayMs: 200,
      exhausted: false,
      scheduled: true,
    });
    vi.advanceTimersByTime(200);
    expect(scheduler.state()).toEqual({
      attempt: 3,
      delayMs: 250,
      exhausted: false,
      scheduled: true,
    });
    vi.advanceTimersByTime(250);
    expect(scheduler.state()).toEqual({
      attempt: 4,
      delayMs: 250,
      exhausted: false,
      scheduled: true,
    });
    expect(observed).toContainEqual({
      attempt: 1,
      delayMs: 100,
      exhausted: false,
      scheduled: false,
    });

    vi.advanceTimersByTime(250);
    expect(scheduler.state()).toEqual({
      attempt: 4,
      delayMs: 250,
      exhausted: true,
      scheduled: false,
    });

    scheduler.reset();
    expect(scheduler.state()).toEqual({
      attempt: 0,
      delayMs: null,
      exhausted: false,
      scheduled: false,
    });
    vi.runAllTimers();
    expect(onRetry).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("respects a valid minimum Retry-After delay", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const scheduler = createDashboardRecoveryRetryScheduler({ onRetry });
    expect(scheduler.schedule(10_000)).toMatchObject({ delayMs: 10_000, scheduled: true });
    vi.advanceTimersByTime(9_999);
    expect(onRetry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onRetry).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("cancels a pending retry", () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const scheduler = createDashboardRecoveryRetryScheduler({ onRetry });
    scheduler.schedule();
    scheduler.cancel();
    vi.runAllTimers();
    expect(onRetry).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
