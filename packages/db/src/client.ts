import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type CheckoutSurgeSchema = typeof schema;
export type CheckoutSurgeDatabase = PostgresJsDatabase<CheckoutSurgeSchema>;
export type SqlClient = ReturnType<typeof postgres>;
export type SqlClientOptions = NonNullable<Parameters<typeof postgres>[1]>;

export interface DatabaseConnection {
  db: CheckoutSurgeDatabase;
  sql: SqlClient;
  close: () => Promise<void>;
}

export interface AbortableDatabaseConnection extends DatabaseConnection {
  abort: () => Promise<void>;
}

type CancellablePendingQuery = PromiseLike<unknown> & { cancel(): void };

export function createSqlClient(databaseUrl: string, options: SqlClientOptions = {}): SqlClient {
  return postgres(databaseUrl, options);
}

export function createDatabase(sqlClient: SqlClient): CheckoutSurgeDatabase {
  return drizzle(sqlClient, { schema });
}

/** Bind direct postgres.js queries to an operation signal. */
export function createAbortableSqlClient(sqlClient: SqlClient, signal: AbortSignal): SqlClient {
  return new Proxy(sqlClient, {
    apply(target, _thisArgument, argumentsList) {
      return bindQueryToAbortSignal(Reflect.apply(target, target, argumentsList), signal);
    },
    get(target, property, receiver) {
      if (property === "unsafe") {
        return (...argumentsList: unknown[]) =>
          bindQueryToAbortSignal(Reflect.apply(target.unsafe, target, argumentsList), signal);
      }

      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function bindQueryToAbortSignal<T extends CancellablePendingQuery>(
  query: T,
  signal: AbortSignal,
): T {
  const cancel = () => query.cancel();

  if (signal.aborted) {
    cancel();
    return query;
  }

  signal.addEventListener("abort", cancel, { once: true });
  void Promise.resolve(query)
    .finally(() => signal.removeEventListener("abort", cancel))
    .catch(() => undefined);
  return query;
}

export function createDatabaseConnection(
  databaseUrl: string,
  options: SqlClientOptions = {},
): DatabaseConnection {
  const sqlClient = createSqlClient(databaseUrl, options);

  return {
    db: createDatabase(sqlClient),
    sql: sqlClient,
    close: async () => {
      await sqlClient.end({ timeout: 5 });
    },
  };
}

/**
 * Owns a short-lived database pool for one cancellable control-plane operation.
 * Aborting cancels each Drizzle statement and force-terminates the owned pool,
 * including any statement still waiting for a checkout.
 */
export function createAbortableDatabaseConnection(
  databaseUrl: string,
  signal: AbortSignal,
  options: SqlClientOptions = {},
): AbortableDatabaseConnection {
  const sqlClient = createSqlClient(databaseUrl, options);
  let abortPromise: Promise<void> | undefined;
  const abort = () => {
    abortPromise ??= sqlClient.end({ timeout: 0 });
    void abortPromise.catch(() => undefined);
    return abortPromise;
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) void abort();

  return {
    db: createDatabase(createAbortableSqlClient(sqlClient, signal)),
    sql: createAbortableSqlClient(sqlClient, signal),
    abort,
    close: async () => {
      signal.removeEventListener("abort", abort);
      await abort();
    },
  };
}
