import path from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabaseConnection } from "./client.js";

export interface RunMigrationsOptions {
  databaseUrl: string;
  migrationsFolder?: string;
}

export async function runDatabaseMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationsFolder = options.migrationsFolder ?? path.resolve(process.cwd(), "drizzle");
  const connection = createDatabaseConnection(options.databaseUrl, { max: 1 });

  try {
    await migrate(connection.db, { migrationsFolder });
  } finally {
    await connection.close();
  }
}
