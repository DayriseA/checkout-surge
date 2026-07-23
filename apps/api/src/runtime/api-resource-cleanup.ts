export interface ApiResourceCleanupOperations {
  closePendingPersistenceRecovery(): Promise<void>;
  closeReadiness(): Promise<void>;
  closeServer(): Promise<void>;
  closeDashboardPublicationScheduler(): Promise<void>;
  closeBusinessOutcomePublicationScheduler(): Promise<void>;
  closeDashboardProjectionDirtySubscriber(): Promise<void>;
  closeOrderProcessJobPublisher(): Promise<void>;
  closeOrderProcessQueueInspector(): Promise<void>;
  closeDemoQueueMaintenance(): Promise<void>;
  disconnectRedis(): void;
  closeDatabase(): Promise<void>;
}

export type ResourceCleanup = () => void | Promise<void>;

export function createOperationResourceCleanup(input: {
  signal: AbortSignal;
  operations: readonly ResourceCleanup[];
  failureMessage: string;
}): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (!closePromise) {
      input.signal.removeEventListener("abort", closeOnAbort);
      closePromise = closeResources(input.operations, input.failureMessage);
    }
    return closePromise;
  };
  const closeOnAbort = () => {
    void close().catch(() => undefined);
  };

  input.signal.addEventListener("abort", closeOnAbort, { once: true });
  if (input.signal.aborted) closeOnAbort();
  return close;
}

export async function closeResources(
  operations: readonly ResourceCleanup[],
  failureMessage: string,
): Promise<void> {
  const results = await Promise.allSettled(operations.map(runCleanup));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, failureMessage);
  }
}

export async function failAfterResourceConstruction(
  constructionError: unknown,
  operations: readonly ResourceCleanup[],
  failureMessage: string,
): Promise<never> {
  try {
    await closeResources(operations, failureMessage);
  } catch (cleanupError) {
    const errors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
    throw new AggregateError([constructionError, ...errors], failureMessage);
  }
  throw constructionError;
}

export async function runWithResourceCleanup<T>(
  operation: () => Promise<T>,
  cleanup: ResourceCleanup,
  failureMessage: string,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
    operationFailed = true;
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    if (operationFailed) {
      const cleanupErrors =
        cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError([operationError, ...cleanupErrors], failureMessage);
    }
    throw cleanupError;
  }

  if (operationFailed) throw operationError;
  return result as T;
}

export async function closeApiResources(operations: ApiResourceCleanupOperations): Promise<void> {
  const errors: unknown[] = [];

  try {
    await runCleanup(operations.closePendingPersistenceRecovery);
  } catch (error) {
    errors.push(error);
  }

  try {
    await runCleanup(operations.closeReadiness);
  } catch (error) {
    errors.push(error);
  }

  try {
    await runCleanup(operations.closeServer);
  } catch (error) {
    errors.push(error);
  }

  try {
    await runCleanup(operations.closeDashboardPublicationScheduler);
  } catch (error) {
    errors.push(error);
  }

  try {
    await runCleanup(operations.closeBusinessOutcomePublicationScheduler);
  } catch (error) {
    errors.push(error);
  }

  const dependencyResults = await Promise.allSettled([
    runCleanup(operations.closeDashboardProjectionDirtySubscriber),
    runCleanup(operations.closeOrderProcessJobPublisher),
    runCleanup(operations.closeOrderProcessQueueInspector),
    runCleanup(operations.closeDemoQueueMaintenance),
    runCleanup(operations.disconnectRedis),
    runCleanup(operations.closeDatabase),
  ]);
  errors.push(
    ...dependencyResults.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );

  if (errors.length > 0) {
    throw new AggregateError(errors, "One or more API resources failed to close.");
  }
}

async function runCleanup(operation: () => void | Promise<void>): Promise<void> {
  await operation();
}
