import { contractsPackageName } from "@checkout-surge/contracts";
import { dbPackageName } from "@checkout-surge/db";
import { loggerPackageName } from "@checkout-surge/logger";

export const workerAppName = "worker" as const;
export const workerAppDependencies = [
  contractsPackageName,
  dbPackageName,
  loggerPackageName,
] as const;
