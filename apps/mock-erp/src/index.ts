import { contractsPackageName } from "@checkout-surge/contracts";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import { ConfirmationService } from "./application/confirmation-service.js";
import { loadMockErpConfig } from "./runtime/config.js";
import { buildMockErpServer } from "./server.js";

export const mockErpAppName = "mock-erp" as const;
export const mockErpAppDependencies = [contractsPackageName, loggerPackageName] as const;

export {
  type ConfirmationDecision,
  type ConfirmationDecisionProvider,
  ConfirmationService,
} from "./application/confirmation-service.js";
export { loadMockErpConfig, type MockErpConfig } from "./runtime/config.js";
export { buildMockErpServer } from "./server.js";

export async function startMockErp(): Promise<void> {
  const config = loadMockErpConfig(process.env);
  const logger = createServiceLogger({ service: "mock-erp" });
  const server = buildMockErpServer({
    confirmationService: new ConfirmationService(),
    logger,
    startedAt: new Date(),
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (!closePromise) {
      closePromise = server.close();
    }
    return closePromise;
  };

  process.once("SIGTERM", () => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Mock ERP shutdown failed.");
        process.exit(1);
      });
  });
  process.once("SIGINT", () => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Mock ERP shutdown failed.");
        process.exit(1);
      });
  });

  try {
    await server.listen({
      host: config.host,
      port: config.port,
      listenTextResolver: (address) => `Mock ERP listening at ${address}`,
    });
  } catch (error) {
    process.exitCode = 1;
    logger.error({ err: error }, "Mock ERP failed to start.");
    try {
      await close();
    } catch (cleanupError) {
      logger.error({ err: cleanupError }, "Mock ERP startup cleanup failed.");
    }
  }
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startMockErp();
}
