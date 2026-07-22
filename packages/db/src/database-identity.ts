import type { SqlClient } from "./client.js";

export async function assertConnectedDatabaseIdentity(
  sql: SqlClient,
  expectedDatabaseName: string,
): Promise<void> {
  const [identity] = await sql<{ database_name: string }[]>`
    SELECT current_database() AS database_name
  `;
  if (identity?.database_name !== expectedDatabaseName) {
    throw new Error(
      "Refusing database operation: connected database identity did not match the validated target.",
    );
  }
}
