import { FlyMachinesClient } from "@checkout-surge/fly-machines";
import { createServiceLogger } from "@checkout-surge/logger";
import { loadGateConfig } from "./config.js";
import { CoreRecovery, readDeployedCoreConfig } from "./core-recovery.js";
import { CoreStatusCache, probeCore, readCoreStatus } from "./core-status.js";
import { CoreWake } from "./core-wake.js";
import { buildGateServer } from "./server.js";

// The listing normally answers in well under 200 ms (measured from the gate), so 3 s only cuts off
// a failing API, while bounding how long a visitor waits on a status read.
const statusReadTimeoutMs = 3_000;

export async function startGate(): Promise<void> {
  const config = loadGateConfig(process.env);
  const logger = createServiceLogger({ service: "gate" });
  const machines = new FlyMachinesClient({
    appName: config.coreAppName,
    token: config.coreFlyApiToken,
  });
  // Visitors wait on status reads, so a slow Machines API is cut short; the wake keeps the
  // client's default timeout, since a start can legitimately take a few seconds.
  const statusMachines = new FlyMachinesClient({
    appName: config.coreAppName,
    token: config.coreFlyApiToken,
    requestTimeoutMs: statusReadTimeoutMs,
  });
  const status = new CoreStatusCache({
    read: (previous) => readCoreStatus({ machines: statusMachines, probe: probeCore, previous }),
    logger,
  });
  const recovery = new CoreRecovery({ machines, probe: probeCore, logger });
  const readCoreConfig = () => readDeployedCoreConfig(config.coreMachineConfigFile);
  if (await readCoreConfig()) {
    logger.info({ path: config.coreMachineConfigFile }, "Deployed core config found.");
  } else {
    logger.error(
      { path: config.coreMachineConfigFile },
      "No deployed core config; the core cannot be recreated until the core is deployed.",
    );
  }
  const wake = new CoreWake({
    machines,
    recovery,
    readCoreConfig,
    onStarted: () => status.invalidate(),
    logger,
  });
  const server = await buildGateServer({ status, wake, logger });

  const handleShutdown = () => {
    void server
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error({ err: error }, "Gate shutdown failed.");
        process.exit(1);
      });
  };
  process.once("SIGTERM", handleShutdown);
  process.once("SIGINT", handleShutdown);

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (error) {
    process.exitCode = 1;
    logger.error({ err: error }, "Gate failed to start.");
  }
}

if (process.env.NODE_ENV !== "test" && import.meta.url === `file://${process.argv[1]}`) {
  void startGate();
}
