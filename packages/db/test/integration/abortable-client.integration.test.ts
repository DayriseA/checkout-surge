import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAbortableDatabaseConnection, createSqlClient } from "../../src/index.js";
import { createTestDatabaseIfMissing } from "../../src/testing.js";

describe("abortable postgres.js client", () => {
  it("cancels active and pool-queued statements without blocking a later pool", async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");
    await createTestDatabaseIfMissing(databaseUrl);
    const observer = createSqlClient(databaseUrl, { max: 1 });
    const controller = new AbortController();
    const connection = createAbortableDatabaseConnection(databaseUrl, controller.signal, {
      max: 1,
    });
    const marker = `dashboard_recovery_abort_${Date.now()}`;

    try {
      const active = connection.db.execute(drizzleSql.raw(`select pg_sleep(30) /* ${marker} */`));
      const queued = connection.db.execute(drizzleSql`select 2 as value`);
      void active.catch(() => undefined);
      void queued.catch(() => undefined);
      await expect
        .poll(async () => {
          const [row] = await observer.unsafe<{ count: number }[]>(
            "select count(*)::int as count from pg_stat_activity where query like $1",
            [`%${marker}%`],
          );
          return row?.count ?? 0;
        })
        .toBe(1);

      controller.abort(new Error("recovery deadline"));

      const results = await within(Promise.allSettled([active, queued]), "queries did not cancel");
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      await within(connection.close(), "aborted pool did not terminate");
      await expect
        .poll(async () => {
          const [row] = await observer.unsafe<{ count: number }[]>(
            "select count(*)::int as count from pg_stat_activity where query like $1",
            [`%${marker}%`],
          );
          return row?.count ?? 0;
        })
        .toBe(0);
      const laterConnection = createSqlClient(databaseUrl, { max: 1 });
      try {
        await expect(laterConnection`select 1 as value`).resolves.toMatchObject([{ value: 1 }]);
      } finally {
        await laterConnection.end({ timeout: 5 });
      }
    } finally {
      await Promise.all([connection.close(), observer.end({ timeout: 5 })]);
    }
  });
});

async function within<T>(operation: PromiseLike<T>, message: string): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), 3_000);
        deadline.unref();
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
