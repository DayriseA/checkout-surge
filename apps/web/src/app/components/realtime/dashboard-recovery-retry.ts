export interface DashboardRecoveryRetryPolicy {
  initialDelayMs: number;
  maximumDelayMs: number;
  multiplier: number;
}

export const dashboardRecoveryRetryPolicy: DashboardRecoveryRetryPolicy = {
  initialDelayMs: 1_000,
  maximumDelayMs: 30_000,
  multiplier: 2,
};

export interface DashboardRecoveryRetryState {
  attempt: number;
  delayMs: number | null;
  scheduled: boolean;
}

interface DashboardRecoveryRetrySchedulerOptions {
  onRetry: () => void;
  onStateChange?: (state: DashboardRecoveryRetryState) => void;
  policy?: DashboardRecoveryRetryPolicy;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DashboardRecoveryRetryScheduler {
  cancel(): void;
  reset(): void;
  schedule(): DashboardRecoveryRetryState;
  state(): DashboardRecoveryRetryState;
}

export function createDashboardRecoveryRetryScheduler({
  onRetry,
  onStateChange,
  policy = dashboardRecoveryRetryPolicy,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}: DashboardRecoveryRetrySchedulerOptions): DashboardRecoveryRetryScheduler {
  let attempt = 0;
  let delayMs: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const currentState = (): DashboardRecoveryRetryState => ({
    attempt,
    delayMs,
    scheduled: timer !== null,
  });
  const publish = () => onStateChange?.(currentState());

  const cancel = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
    publish();
  };

  return {
    cancel,
    reset() {
      cancel();
      attempt = 0;
      delayMs = null;
      publish();
    },
    schedule() {
      if (timer !== null) return currentState();
      attempt += 1;
      delayMs = Math.min(
        policy.maximumDelayMs,
        policy.initialDelayMs * policy.multiplier ** (attempt - 1),
      );
      timer = setTimer(() => {
        timer = null;
        publish();
        onRetry();
      }, delayMs);
      publish();
      return currentState();
    },
    state: currentState,
  };
}
