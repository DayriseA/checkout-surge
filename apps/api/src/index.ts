import { contractsPackageName } from "@checkout-surge/contracts";
import { dbPackageName } from "@checkout-surge/db";
import { loggerPackageName } from "@checkout-surge/logger";

export const apiAppName = "api" as const;
export const apiAppDependencies = [contractsPackageName, dbPackageName, loggerPackageName] as const;
