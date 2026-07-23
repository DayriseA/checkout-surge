import { contractsPackageName } from "@checkout-surge/contracts";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { HttpLoadApiClient } from "./application/api-client.js";
import { FileExecutionStore } from "./application/execution-store.js";
import { SpawnK6Runner } from "./application/k6-runner.js";
import { TrafficExecutionService } from "./application/traffic-execution-service.js";
import { loadLoadOrchestratorConfig } from "./runtime/config.js";
import { createLoadOrchestratorReadiness } from "./runtime/readiness.js";
import { buildLoadOrchestratorServer } from "./server.js";

export const loadOrchestratorAppName = "load-orchestrator" as const;
export const loadOrchestratorAppDependencies = [contractsPackageName, loggerPackageName] as const;

export { HttpLoadApiClient, MetricBatcher } from "./application/api-client.js";
export {
  ExecutionConflictError,
  type ExecutionStore,
  FileExecutionStore,
} from "./application/execution-store.js";
export {
  defaultK6CancellationTimeoutMs,
  K6ChildProcessSupervisor,
  type K6ExecutionLifecycle,
  maxK6CancellationTimeoutMs,
} from "./application/k6-child-process-supervisor.js";
export {
  K6RunAccumulator,
  type K6SummaryMetrics,
  type K6TrendSummary,
  parseK6JsonLine,
  parseK6SummaryMetrics,
} from "./application/k6-output-parser.js";
export { type K6Runner, SpawnK6Runner } from "./application/k6-runner.js";
export { generateK6Script } from "./application/k6-script.js";
export { TrafficExecutionService } from "./application/traffic-execution-service.js";
export { type LoadOrchestratorConfig, loadLoadOrchestratorConfig } from "./runtime/config.js";
export {
  createLoadOrchestratorReadiness,
  type LoadOrchestratorReadiness,
} from "./runtime/readiness.js";
export { buildLoadOrchestratorServer } from "./server.js";

export async function startLoadOrchestrator(): Promise<void> {
  const config = loadLoadOrchestratorConfig(process.env);
  const logger = createServiceLogger({ service: "load-orchestrator" });
  const apiClient = new HttpLoadApiClient({
    apiBaseUrl: config.apiBaseUrl,
    controlServiceToken: config.controlServiceToken,
  });
  const trafficExecutionService = new TrafficExecutionService(
    new SpawnK6Runner({
      k6Binary: config.k6Binary,
      apiClient,
      logger,
      executionStore: new FileExecutionStore(config.stateDirectory),
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
