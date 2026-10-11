import type { InventoryStatus } from "@checkout-surge/contracts";
import type { RunInventoryScope } from "./inventory-status-service.js";

export interface RunInventoryLifecycle {
  initialize(scope: RunInventoryScope, allocatedStock: number, initializedAt: Date): Promise<void>;
  close(scope: RunInventoryScope): Promise<boolean>;
  read(scope: RunInventoryScope, observedAt: Date): Promise<InventoryStatus>;
  retire(scope: RunInventoryScope): Promise<"deleted" | "pending_persistence">;
  settleProcessing(runIds: string[], deadline: number): Promise<void>;
}
