import { contractsPackageName } from "@checkout-surge/contracts";

export const dbPackageName = "@checkout-surge/db" as const;
export const dbPackageDependencies = [contractsPackageName] as const;
