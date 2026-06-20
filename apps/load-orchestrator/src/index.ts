import { contractsPackageName } from "@checkout-surge/contracts";
import { loggerPackageName } from "@checkout-surge/logger";

export const loadOrchestratorAppName = "load-orchestrator" as const;
export const loadOrchestratorAppDependencies = [contractsPackageName, loggerPackageName] as const;
