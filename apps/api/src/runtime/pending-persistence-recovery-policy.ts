export const pendingPersistenceRecoveryDefaults = {
  recoveryWindowSeconds: 300,
  maxAttempts: 6,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  pollIntervalMs: 1_000,
  discoveryTimeoutMs: 2_000,
  maxConcurrentDirectAttempts: 3,
  batchSize: 100,
} as const;

/**
 * How long the scheduler leaves a newly secured hold to its buy request's own save. It covers
 * that save under spike load, stays below the 30-second maximum backoff and `Retry-After`,
 * and uses a small part of the 300-second recovery window.
 */
export const pendingPersistenceFreshHoldGraceMs = 10_000;
