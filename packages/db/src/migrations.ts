import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabaseConnection } from "./client.js";

export interface RunMigrationsOptions {
  databaseUrl: string;
  expectedDatabaseName?: string;
  migrationsFolder?: string;
}

export interface ExpectedDatabaseMigration {
  createdAt: number;
  hash: string;
}

const packageMigrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

export function resolveMigrationsFolder(migrationsFolder?: string): string {
  return migrationsFolder ?? packageMigrationsFolder;
}

export function readExpectedDatabaseMigrations(
  migrationsFolder: string,
): ExpectedDatabaseMigration[] {
  return readMigrationFiles({ migrationsFolder }).map((migration) => ({
    createdAt: migration.folderMillis,
    hash: migration.hash,
  }));
}

export async function runDatabaseMigrations(options: RunMigrationsOptions): Promise<void> {
  const migrationsFolder = resolveMigrationsFolder(options.migrationsFolder);
  const connection = createDatabaseConnection(options.databaseUrl, { max: 1 });

  try {
    if (options.expectedDatabaseName) {
      const [identity] = await connection.sql<{ database_name: string }[]>`
        SELECT current_database() AS database_name
      `;
      if (identity?.database_name !== options.expectedDatabaseName) {
        throw new Error(
          `Refusing database migrations: connected database identity did not match the validated target.`,
        );
      }
    }
    await migrate(connection.db, { migrationsFolder });
  } finally {
    await connection.close();
  }
}
