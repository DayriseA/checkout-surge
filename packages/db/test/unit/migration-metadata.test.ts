import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const drizzleFolder = path.join(packageRoot, "drizzle");
const metadataFolder = path.join(drizzleFolder, "meta");

interface Journal {
  dialect: string;
  entries: Array<{ idx: number; tag: string; version: string }>;
  version: string;
}

interface Snapshot {
  dialect: string;
  id: string;
  prevId: string;
  version: string;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("Drizzle migration metadata", () => {
  it("has linked PostgreSQL v7 migration snapshots and SQL files", async () => {
    const journal = await readJson<Journal>(path.join(metadataFolder, "_journal.json"));
    const snapshotFiles = (await readdir(metadataFolder))
      .filter((fileName) => fileName.endsWith("_snapshot.json"))
      .sort();
    const sqlFiles = (await readdir(drizzleFolder))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    expect(journal).toMatchObject({ version: "7", dialect: "postgresql" });
    expect(journal.entries).toHaveLength(13);
    expect(journal.entries[0]).toMatchObject({
      idx: 0,
      version: "7",
      tag: "0000_baseline",
    });
    expect(snapshotFiles).toEqual(
      journal.entries.map((entry) => `${entry.idx.toString().padStart(4, "0")}_snapshot.json`),
    );
    expect(sqlFiles).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`));

    const snapshot = await readJson<Snapshot>(path.join(metadataFolder, "0000_snapshot.json"));
    expect(snapshot).toMatchObject({
      version: "7",
      dialect: "postgresql",
      prevId: "00000000-0000-0000-0000-000000000000",
    });
    expect(snapshot.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("keeps only the required snapshot-invisible core without upgrade scaffolding", async () => {
    const baseline = await readFile(path.join(drizzleFolder, "0000_baseline.sql"), "utf8");

    for (const requiredSql of [
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto"',
      'CREATE UNIQUE INDEX "demo_runs_single_non_terminal_idx"',
      'CREATE UNIQUE INDEX "simulated_notifications_order_id_unique"',
      'CONSTRAINT "orders_backing_reservation_fk"',
      'CONSTRAINT "orders_run_sale_context_fk"',
      'CONSTRAINT "order_events_run_sale_context_fk"',
      'CONSTRAINT "simulated_notifications_order_attribution_fk"',
    ]) {
      expect(baseline).toContain(requiredSql);
    }

    expect(baseline).not.toMatch(/CREATE (?:OR REPLACE )?FUNCTION|CREATE TRIGGER/i);
    expect(baseline).not.toMatch(
      /LOCK TABLE|contradictory historical|backfill|hydrate|UPDATE "public_runtime_policies"/i,
    );
  });

  it("generates no accidental schema migration from the current schema", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "checkout-surge-drizzle-drift-"));
    const temporaryDrizzle = path.join(temporaryRoot, "drizzle");

    try {
      await cp(drizzleFolder, temporaryDrizzle, { recursive: true });
      const before = (await readdir(temporaryDrizzle)).sort();
      const drizzleKit = path.join(packageRoot, "node_modules", ".bin", "drizzle-kit");
      const temporaryConfig = path.join(temporaryRoot, "drizzle.config.ts");
      await writeFile(
        temporaryConfig,
        `export default ${JSON.stringify({
          schema: path.join(packageRoot, "src", "schema.ts"),
          out: "./drizzle",
          dialect: "postgresql",
        })};\n`,
      );
      await execFileAsync(drizzleKit, ["generate", "--config", temporaryConfig], {
        cwd: temporaryRoot,
      });

      expect((await readdir(temporaryDrizzle)).sort()).toEqual(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
