import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  [key: string]: unknown;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function snapshotManagedState(snapshot: Snapshot): Omit<Snapshot, "id" | "prevId"> {
  const { id: _id, prevId: _prevId, ...managedState } = snapshot;
  return managedState;
}

describe("Drizzle migration metadata", () => {
  it("has one ordered, linked PostgreSQL v7 snapshot per journal entry", async () => {
    const journal = await readJson<Journal>(path.join(metadataFolder, "_journal.json"));
    const snapshotFiles = (await readdir(metadataFolder))
      .filter((fileName) => fileName.endsWith("_snapshot.json"))
      .sort();
    const sqlFiles = (await readdir(drizzleFolder))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();

    expect(journal).toMatchObject({ version: "7", dialect: "postgresql" });
    expect(snapshotFiles).toEqual(
      journal.entries.map((entry) => `${entry.idx.toString().padStart(4, "0")}_snapshot.json`),
    );
    expect(sqlFiles).toEqual(journal.entries.map((entry) => `${entry.tag}.sql`));

    let expectedPrevId = "00000000-0000-0000-0000-000000000000";
    const snapshotIds = new Set<string>();
    for (const [position, entry] of journal.entries.entries()) {
      expect(entry).toMatchObject({ idx: position, version: "7" });
      expect(entry.tag.startsWith(`${position.toString().padStart(4, "0")}_`)).toBe(true);

      const snapshotFile = snapshotFiles[position];
      expect(snapshotFile).toBeDefined();
      const snapshot = await readJson<Snapshot>(path.join(metadataFolder, snapshotFile ?? ""));
      expect(snapshot).toMatchObject({
        version: "7",
        dialect: "postgresql",
        prevId: expectedPrevId,
      });
      expect(snapshot.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(snapshotIds.has(snapshot.id)).toBe(false);
      snapshotIds.add(snapshot.id);
      expectedPrevId = snapshot.id;
    }
    expect(snapshotIds.size).toBe(journal.entries.length);
  });

  it("records custom SQL entries as explicit snapshot-invisible state", async () => {
    for (const index of [1, 3, 4, 5, 13, 14]) {
      const previous = await readJson<Snapshot>(
        path.join(metadataFolder, `${(index - 1).toString().padStart(4, "0")}_snapshot.json`),
      );
      const current = await readJson<Snapshot>(
        path.join(metadataFolder, `${index.toString().padStart(4, "0")}_snapshot.json`),
      );

      expect(snapshotManagedState(current)).toEqual(snapshotManagedState(previous));
    }
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
      const result = await execFileAsync(
        drizzleKit,
        ["generate", "--config", temporaryConfig],
        { cwd: temporaryRoot },
      );

      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "No schema changes, nothing to migrate",
      );
      expect((await readdir(temporaryDrizzle)).sort()).toEqual(before);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
