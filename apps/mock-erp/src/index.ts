import { createDatabaseConnection } from "@checkout-surge/db";
import { createServiceLogger } from "@checkout-surge/logger";
import {
  ChaosConfirmationDecisionProvider,
  ErpChaosConfigStore,
} from "./application/chaos-control-service.js";
import { ConfirmationService } from "./application/confirmation-service.js";
import { SlidingWindowTpsLimiter } from "./application/tps-limiter.js";
import { PostgresConfirmationLedger } from "./persistence/postgres-confirmation-ledger.js";
import { loadMockErpConfig } from "./runtime/config.js";
import { buildMockErpServer } from "./server.js";

export async function startMockErp(): Promise<void> {
  const config = loadMockErpConfig(process.env);
  const logger = createServiceLogger({ service: "mock-erp" });
  const database = createDatabaseConnection(config.databaseUrl, { max: config.postgresPoolMax });
  const chaosConfigStore = new ErpChaosConfigStore(
    config.defaultChaosConfig,
    config.chaosSafetyCaps,
  );
  const server = buildMockErpServer({
    confirmationService: new ConfirmationService({
      decisionProvider: new ChaosConfirmationDecisionProvider({
        configStore: chaosConfigStore,
        tpsLimiter: new SlidingWindowTpsLimiter(),
      }),
      ledger: new PostgresConfirmationLedger(database.sql),
    }),
    chaosConfigStore,
    controlServiceToken: config.controlServiceToken,
    logger,
    startedAt: new Date(),
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        await server.close();
      } finally {
        await database.close();
      }
    })();
    return closePromise;
  };

  const handleShutdown = () => {
    void close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Mock ERP shutdown failed.");
        process.exit(1);
      });
  };
  process.once("SIGTERM", handleShutdown);
  process.once("SIGINT", handleShutdown);

  try {
    await server.listen({
      host: config.host,
      port: config.port,
      listenTextResolver: (address: string) => `Mock ERP listening at ${address}`,
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
