import { contractsPackageName } from "@checkout-surge/contracts";
import { createDatabaseConnection, dbPackageName } from "@checkout-surge/db";
import { createServiceLogger, loggerPackageName } from "@checkout-surge/logger";
import {
  ChaosConfirmationDecisionProvider,
  ErpChaosConfigStore,
} from "./application/chaos-control-service.js";
import { ConfirmationService } from "./application/confirmation-service.js";
import { PostgresConfirmationLedger } from "./application/postgres-confirmation-ledger.js";
import { SlidingWindowTpsLimiter } from "./application/tps-limiter.js";
import { loadMockErpConfig } from "./runtime/config.js";
import { buildMockErpServer } from "./server.js";

export const mockErpAppName = "mock-erp" as const;
export const mockErpAppDependencies = [
  contractsPackageName,
  dbPackageName,
  loggerPackageName,
] as const;

export {
  ChaosConfirmationDecisionProvider,
  ErpChaosConfigSafetyError,
  ErpChaosConfigStore,
  type ErpChaosSafetyCaps,
} from "./application/chaos-control-service.js";
export {
  type ConfirmationDecision,
  type ConfirmationDecisionProvider,
  ConfirmationIdempotencyConflictError,
  type ConfirmationLedger,
  ConfirmationService,
  InMemoryConfirmationLedger,
} from "./application/confirmation-service.js";
export { PostgresConfirmationLedger } from "./application/postgres-confirmation-ledger.js";
export {
  SlidingWindowTpsLimiter,
  type SlidingWindowTpsLimiterOptions,
  type TpsLimiter,
} from "./application/tps-limiter.js";
export { loadMockErpConfig, type MockErpConfig } from "./runtime/config.js";
export { buildMockErpServer } from "./server.js";

export async function startMockErp(): Promise<void> {
  const config = loadMockErpConfig(process.env);
  const logger = createServiceLogger({ service: "mock-erp" });
  const database = createDatabaseConnection(requireDatabaseUrl(process.env));
  const chaosConfigStore = new ErpChaosConfigStore(
    config.defaultChaosConfig,
    config.chaosSafetyCaps,
  );
  const server = buildMockErpServer({
    confirmationService: new ConfirmationService({
      ledger: new PostgresConfirmationLedger(database.db),
      decisionProvider: new ChaosConfirmationDecisionProvider({
        configStore: chaosConfigStore,
        tpsLimiter: new SlidingWindowTpsLimiter(),
      }),
    }),
    chaosConfigStore,
    controlServiceToken: config.controlServiceToken,
    logger,
    startedAt: new Date(),
  });

  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= server.close().finally(() => database.close());
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

function requireDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_URL is required.");
  return value;
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startMockErp();
}
