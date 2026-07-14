import { contractsPackageName } from "@checkout-surge/contracts";

export const dbPackageName = "@checkout-surge/db" as const;
export const dbPackageDependencies = [contractsPackageName] as const;

export * from "./business-outcome-dashboard.js";
export * from "./business-outcome-publication-scheduler.js";
export * from "./client.js";
export * from "./demo-run-maintenance.js";
export * from "./json.js";
export * from "./migrations.js";
export * from "./redis.js";
export * from "./redis-dashboard-events.js";
export * from "./redis-erp-resilience.js";
export * from "./redis-inventory.js";
export * from "./redis-stock-reservation.js";
export * from "./schema.js";
