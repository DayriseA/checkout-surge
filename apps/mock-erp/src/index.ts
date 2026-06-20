import { contractsPackageName } from "@checkout-surge/contracts";
import { loggerPackageName } from "@checkout-surge/logger";

export const mockErpAppName = "mock-erp" as const;
export const mockErpAppDependencies = [contractsPackageName, loggerPackageName] as const;
