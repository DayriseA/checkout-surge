import { FlyMachinesClient } from "@checkout-surge/fly-machines";
import { createServiceLogger } from "@checkout-surge/logger";
import { loadGuardConfig } from "./config.js";
import { probeCore } from "./core-status.js";
import { Guard } from "./guard.js";

// The guard's one-shot entrypoint: Fly starts its Machine on schedule, and it exits after one pass.
const logger = createServiceLogger({ service: "gate", base: { component: "guard" } });
try {
  const config = loadGuardConfig(process.env);
  const guard = new Guard({
    core: new FlyMachinesClient({ appName: config.coreAppName, token: config.coreFlyApiToken }),
    runner: new FlyMachinesClient({
      appName: config.runnerAppName,
      token: config.runnerFlyApiToken,
    }),
    probe: probeCore,
    thresholds: config.thresholds,
    dryRun: config.dryRun,
    logger,
  });
  logger.info({ thresholds: config.thresholds, dryRun: config.dryRun }, "The guard started.");
  if (!(await guard.run())) process.exitCode = 1;
} catch (error) {
  logger.error({ err: error }, "The guard failed.");
  process.exitCode = 1;
}
