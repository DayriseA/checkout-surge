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

export function createSqlClient(databaseUrl: string, options: SqlClientOptions = {}): SqlClient {
  return postgres(databaseUrl, options);
}

export function createDatabase(sqlClient: SqlClient): CheckoutSurgeDatabase {
  return drizzle(sqlClient, { schema });
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
