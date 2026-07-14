import type { SqlClient } from "@checkout-surge/db";
import { demoRunStartLockKey } from "./demo-run-service.js";

export interface DemoResetWorkflowFence {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

/** Holds the same advisory lock used by run creation for the full reset workflow. */
export class PostgresDemoResetWorkflowFence implements DemoResetWorkflowFence {
  constructor(private readonly sql: SqlClient) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const reservedClient = await this.sql.reserve();
    let locked = false;
    try {
      await reservedClient`select pg_advisory_lock(hashtext(${demoRunStartLockKey}))`;
      locked = true;
      return await operation();
    } finally {
      try {
        if (locked) {
          await reservedClient`select pg_advisory_unlock(hashtext(${demoRunStartLockKey}))`;
        }
      } finally {
        reservedClient.release();
      }
    }
  }
}
