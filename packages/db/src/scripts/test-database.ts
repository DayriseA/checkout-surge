import postgres from "postgres";

export async function createTestDatabaseIfMissing(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, ""));

  if (!databaseName) {
    throw new Error("TEST_DATABASE_URL must include a database name.");
  }

  const adminUrl = new URL(target);
  adminUrl.pathname = "/postgres";

  const admin = postgres(adminUrl.toString(), { max: 1 });

  try {
    const rows = await admin<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_database
        WHERE datname = ${databaseName}
      ) AS "exists"
    `;

    if (rows[0]?.exists) {
      return;
    }

    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    console.log(`Created isolated test database ${databaseName}.`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
