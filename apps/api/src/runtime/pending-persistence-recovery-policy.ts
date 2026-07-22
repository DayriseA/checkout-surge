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
