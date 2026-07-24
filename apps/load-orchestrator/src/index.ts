import { createServiceLogger } from "@checkout-surge/logger";
import { HttpLoadApiClient } from "./application/api-client.js";
import { CompletionDeliveryCoordinator } from "./application/completion-delivery-coordinator.js";
import { FileExecutionStore } from "./application/execution-store.js";
import { SpawnK6Runner } from "./application/k6-runner.js";
import { TrafficExecutionService } from "./application/traffic-execution-service.js";
import { loadLoadOrchestratorConfig } from "./runtime/config.js";
import { createLoadOrchestratorReadiness } from "./runtime/readiness.js";
import { buildLoadOrchestratorServer } from "./server.js";

export async function startLoadOrchestrator(): Promise<void> {
  const config = loadLoadOrchestratorConfig(process.env);
  const logger = createServiceLogger({ service: "load-orchestrator" });
  const apiClient = new HttpLoadApiClient({
    apiBaseUrl: config.apiBaseUrl,
    controlServiceToken: config.controlServiceToken,
  });
  const executionStore = new FileExecutionStore(config.stateDirectory);
  const completionDelivery = new CompletionDeliveryCoordinator({
    executionStore,
    apiClient,
    logger,
    retryIntervalMs: config.completionDeliveryRetryIntervalMs,
  });
  const trafficExecutionService = new TrafficExecutionService(
    new SpawnK6Runner({
      k6Binary: config.k6Binary,
      apiClient,
      completionDelivery,
      logger,
      executionStore,
      cancellationTimeoutMs: config.k6CancellationTimeoutMs,
    }),
  );
  await trafficExecutionService.initialize();
  const server = buildLoadOrchestratorServer({
    config,
    logger,
    readiness: createLoadOrchestratorReadiness(config),
    trafficExecutionService,
    startedAt: new Date(),
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = server.close().then(() => trafficExecutionService.close());
    }
    return closePromise;
  };

  process.once("SIGTERM", () => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Load orchestrator shutdown failed.");
        process.exit(1);
      });
  });
  process.once("SIGINT", () => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Load orchestrator shutdown failed.");
        process.exit(1);
      });
  });

  try {
    await server.listen({
      host: config.host,
      port: config.port,
      listenTextResolver: (address: string) => `Load orchestrator listening at ${address}`,
    });
  } catch (error) {
    process.exitCode = 1;
    logger.error({ err: error }, "Load orchestrator failed to start.");
    try {
      await close();
    } catch (cleanupError) {
      logger.error({ err: cleanupError }, "Load orchestrator startup cleanup failed.");
    }
  }
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startLoadOrchestrator();
}
