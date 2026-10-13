import type { StoreLoad } from "@checkout-surge/contracts";
import { sql } from "drizzle-orm";
import type { CheckoutSurgeDatabase } from "./client.js";
import type { CheckoutSurgeRedis } from "./redis.js";

/** Cumulative counters of PostgreSQL (this database) and Redis (its process) at one instant. */
export interface StoreLoadCounters {
  postgresTransactions: number;
  postgresBusyMs: number;
  /** Absent from windows recorded before it was read. */
  postgresCpuMs?: number | null;
  redisCpuMs: number;
  capturedAt: string;
}

/** The counters around a measured run: before its traffic, and once its statistics settled. */
export interface StoreLoadWindow {
  start: StoreLoadCounters;
  end?: StoreLoadCounters;
}

/**
 * Reads PostgreSQL's own statistics for this database (`pg_stat_database`: transactions and the
 * time its connections spent executing statements), the CPU time of PostgreSQL's container, and
 * the Redis process's CPU time.
 */
export async function readStoreLoadCounters(
  db: CheckoutSurgeDatabase,
  redis: CheckoutSurgeRedis,
  now: Date = new Date(),
): Promise<StoreLoadCounters> {
  const [rows, postgresCpuMs, cpu] = await Promise.all([
    db.execute<{ transactions: string; busy_ms: number }>(
      sql`select (xact_commit + xact_rollback)::text as transactions, active_time as busy_ms
        from pg_stat_database where datname = current_database()`,
    ),
    readPostgresCpuMs(db),
    redis.info("cpu"),
  ]);
  const [database] = rows;
  if (!database) throw new Error("pg_stat_database has no row for the current database.");
  return {
    postgresTransactions: Number(database.transactions),
    postgresBusyMs: Number(database.busy_ms),
    postgresCpuMs,
    redisCpuMs:
      (redisInfoSeconds(cpu, "used_cpu_sys") + redisInfoSeconds(cpu, "used_cpu_user")) * 1000,
    capturedAt: now.toISOString(),
  };
}

/**
 * What the stores did during the window; null until it has an end, and null when a counter went
 * backwards (a statistics reset or a restart inside the window), which leaves the work unknown.
 */
export function storeLoadOf(window: StoreLoadWindow | null): StoreLoad | null {
  if (!window?.end) return null;
  const { start, end } = window;
  const load = {
    postgresTransactions: end.postgresTransactions - start.postgresTransactions,
    postgresBusyMs: end.postgresBusyMs - start.postgresBusyMs,
    postgresCpuMs:
      start.postgresCpuMs == null || end.postgresCpuMs == null
        ? null
        : end.postgresCpuMs - start.postgresCpuMs,
    redisCpuMs: end.redisCpuMs - start.redisCpuMs,
  };
  return Object.values(load).some((delta) => delta !== null && delta < 0) ? null : load;
}

/**
 * The CPU time of PostgreSQL's container, which PostgreSQL reads from its own cgroup. Null where
 * it cannot: no cgroup v2 file, or a role without the right to read server files.
 */
async function readPostgresCpuMs(db: CheckoutSurgeDatabase): Promise<number | null> {
  try {
    const [row] = await db.execute<{ stat: string }>(
      sql`select pg_read_file('/sys/fs/cgroup/cpu.stat') as stat`,
    );
    const usageUs = Number(/^usage_usec (\d+)$/m.exec(row?.stat ?? "")?.[1]);
    return Number.isFinite(usageUs) ? usageUs / 1000 : null;
  } catch {
    return null;
  }
}

function redisInfoSeconds(info: string, field: string): number {
  const value = Number(new RegExp(`^${field}:([0-9.]+)\\r?$`, "m").exec(info)?.[1]);
  if (!Number.isFinite(value)) throw new Error(`Redis INFO has no ${field}.`);
  return value;
}
