export interface ApiResourceCleanupOperations {
  closeServer(): Promise<void>;
  closeDashboardPublicationScheduler(): Promise<void>;
  closeBusinessOutcomePublicationScheduler(): Promise<void>;
  closeDashboardEventSubscriber(): Promise<void>;
  closeOrderProcessJobPublisher(): Promise<void>;
  closeOrderProcessQueueInspector(): Promise<void>;
  closeDemoQueueMaintenance(): Promise<void>;
  disconnectRedis(): void;
  closeDatabase(): Promise<void>;
}

export async function closeApiResources(operations: ApiResourceCleanupOperations): Promise<void> {
  const errors: unknown[] = [];

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
    runCleanup(operations.closeDashboardEventSubscriber),
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
