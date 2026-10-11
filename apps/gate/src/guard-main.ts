import { FlyMachinesClient } from "@checkout-surge/fly-machines";
import { createServiceLogger } from "@checkout-surge/logger";
import { loadGuardConfig } from "./config.js";
import { probeCore } from "./core-status.js";
import { Guard } from "./guard.js";
import { StoresLifecycle } from "./stores-lifecycle.js";

// The guard's one-shot entrypoint: Fly starts its Machine on schedule, and it exits after one pass.
const logger = createServiceLogger({ service: "gate", base: { component: "guard" } });
try {
  const config = loadGuardConfig(process.env);
  const core = new FlyMachinesClient({
    appName: config.coreAppName,
    token: config.coreFlyApiToken,
    ...(config.stores ? { expectedOrganization: config.stores.organization } : {}),
  });
  const guard = new Guard({
    core,
    ...(config.stores
      ? {
          stores: new StoresLifecycle({
            core,
            stores: new FlyMachinesClient({
              appName: config.stores.appName,
              token: config.stores.token,
              expectedOrganization: config.stores.organization,
            }),
          }),
        }
      : {}),
    runner: new FlyMachinesClient({
      appName: config.runnerAppName,
      token: config.runnerFlyApiToken,
      ...(config.stores ? { expectedOrganization: config.stores.organization } : {}),
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
