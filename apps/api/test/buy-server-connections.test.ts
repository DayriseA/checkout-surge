import { randomUUID } from "node:crypto";
import { createDatabaseConnection, createRedisClient } from "@checkout-surge/db";
import { requireTestDatabaseUrl } from "@checkout-surge/db/testing";
import { describe, expect, it } from "vitest";
import { openConnections } from "../src/buy-server.js";

describe("buy-only process start", () => {
  it("opens every pooled connection before serving", async () => {
    const applicationName = `buy-pool-${randomUUID()}`;
    const pool = createDatabaseConnection(requireTestDatabaseUrl(), {
      max: 3,
      connection: { application_name: applicationName },
    });
    const observer = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    const redis = createRedisClient(requireTestRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    try {
      await openConnections({ sql: pool.sql, redis, poolSize: 3 });

      const [row] = await observer.sql<{ count: number }[]>`
        select count(*)::int as count from pg_stat_activity where application_name = ${applicationName}`;
      expect(row?.count).toBe(3);
      expect(redis.status).toBe("ready");
    } finally {
      redis.disconnect();
      await Promise.all([pool.close(), observer.close()]);
    }
  });
});

function requireTestRedisUrl(): string {
  const url = process.env.TEST_REDIS_URL;
  if (!url) throw new Error("TEST_REDIS_URL is required.");
  return url;
}
