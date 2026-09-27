import { createDatabaseConnection, demoPresets, demoRuns } from "@checkout-surge/db";
import { requireTestDatabaseUrl, resetTestDatabase } from "@checkout-surge/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DemoPresetService } from "../src/services/demo-preset-service.js";
import { acceptedRunConfigSnapshotFixture } from "./demo-administration-test-fixtures.js";

const now = new Date("2026-06-20T00:00:10.000Z");

describe("demo preset service", () => {
  let connection: ReturnType<typeof createDatabaseConnection> | null = null;

  beforeEach(async () => {
    await connection?.close();
    await resetTestDatabase();
    connection = createDatabaseConnection(requireTestDatabaseUrl(), { max: 1 });
    await seedPresetFixtures(requireConnection(connection));
  });

  afterAll(async () => {
    await connection?.close();
  });

  it("exposes public presets separately and reports archive eligibility to admins", async () => {
    const service = createService(requireConnection(connection));
    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "Operator Copy",
    });

    const publicList = await service.listPublicPresets();
    const adminList = await service.listAdminPresets();

    expect(publicList.presets.map((preset) => preset.slug)).toEqual([
      "preview-1k",
      "public-custom",
    ]);
    expect(adminList.presets.map((preset) => [preset.slug, preset.visibility])).toEqual([
      ["operator-copy", "admin"],
      ["preview-1k", "public"],
      ["public-custom", "public"],
      ["system-admin", "admin"],
      ["custom", "admin"],
    ]);
    expect(adminList.presets.find((preset) => preset.slug === created.preset.slug)).toMatchObject({
      visibility: "admin",
      canArchive: true,
    });
    expect(adminList.presets.find((preset) => preset.slug === "custom")?.canArchive).toBe(false);
  });

  it("keeps system presets immutable while saving and copying through Custom", async () => {
    const service = createService(requireConnection(connection));
    const snapshot = acceptedRunConfigSnapshotFixture();
    const saved = await service.saveAdminPreset({
      slug: "custom",
      display: {
        name: "Custom Saved",
        description: "Saved scratch configuration.",
        sortOrder: 120,
        outcomeFocus: [],
      },
      ...snapshot,
    });

    await expect(
      service.saveAdminPreset({
        slug: "preview-1k",
        display: saved.preset.display,
        ...snapshot,
      }),
    ).rejects.toMatchObject({ code: "preset_operation_not_allowed" });

    const copied = await service.copyPresetToCustom({ sourceSlug: "preview-1k" });
    expect(saved.preset.display.name).toBe("Custom Saved");
    expect(copied.preset).toMatchObject({
      slug: "custom",
      display: { name: "Custom Saved", description: "Scratch copy of Preview 1k." },
    });
  });

  it("normalizes duplicate slugs, creates editable admin copies, and reserves archived slugs", async () => {
    const service = createService(requireConnection(connection));
    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: " Preview Copy ",
    });
    expect(created.preset).toMatchObject({
      slug: "preview-copy",
      visibility: "admin",
      isEditable: true,
      isCustom: false,
    });

    await service.archiveAdminPreset({ slug: "preview-copy" });
    await expect(
      service.duplicatePreset({ sourceSlug: "preview-1k", targetSlug: "preview-copy" }),
    ).rejects.toMatchObject({
      code: "preset_conflict",
      details: { conflictReason: "slug_in_use", slug: "preview-copy" },
    });
    await expect(
      service.duplicatePreset({ sourceSlug: "public-custom", targetSlug: "custom-copy" }),
    ).rejects.toMatchObject({ code: "preset_operation_not_allowed" });
  });

  it("soft-archives operator copies without breaking historical run references", async () => {
    const activeConnection = requireConnection(connection);
    const service = createService(activeConnection);
    const created = await service.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "linked-copy",
    });
    await activeConnection.db.insert(demoRuns).values({
      correlationId: "corr-test-run",
      enginePolicyName: "declared-capacity-erp-dispatch",
      enginePolicyVersion: 2,
      id: "55555555-5555-4555-8555-555555555570",
      presetId: created.preset.id,
      presetName: created.preset.display.name,
      operatorMode: "admin",
      status: "completed",
      trafficStatus: "succeeded",
      configSnapshot: acceptedRunConfigSnapshotFixture(),
      startedAt: now,
      trafficStartedAt: now,
      trafficEndedAt: now,
      finalizedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const archived = await service.archiveAdminPreset({ slug: "linked-copy" });
    const [presetRow] = await activeConnection.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.id, created.preset.id));
    const runs = await activeConnection.db
      .select()
      .from(demoRuns)
      .where(eq(demoRuns.presetId, created.preset.id));

    expect(archived.archivedAt).toBe(now.toISOString());
    expect(presetRow?.archivedAt).toEqual(now);
    expect(runs).toHaveLength(1);
    expect((await service.listAdminPresets()).presets.map((preset) => preset.slug)).not.toContain(
      "linked-copy",
    );
    await expect(service.readActivePreset("linked-copy")).rejects.toMatchObject({
      code: "resource_not_found",
    });
    await expect(service.archiveAdminPreset({ slug: "linked-copy" })).rejects.toMatchObject({
      code: "resource_not_found",
    });
  });

  it.each([
    "preview-1k",
    "public-custom",
    "custom",
    "system-admin",
  ])("refuses to archive protected preset %s", async (slug) => {
    const service = createService(requireConnection(connection));
    await expect(service.archiveAdminPreset({ slug })).rejects.toMatchObject({
      code: "preset_conflict",
      details: { conflictReason: "not_archivable", slug },
    });
  });

  it("rechecks archive eligibility in the guarded update", async () => {
    const activeConnection = requireConnection(connection);
    const setup = createService(activeConnection);
    const created = await setup.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "concurrently-protected",
    });
    const service = createService(
      activeConnection,
      interceptFirstSelect(activeConnection.db, async () => {
        await activeConnection.db
          .update(demoPresets)
          .set({ isSystem: true })
          .where(eq(demoPresets.id, created.preset.id));
      }),
    );

    await expect(
      service.archiveAdminPreset({ slug: "concurrently-protected" }),
    ).rejects.toMatchObject({ code: "preset_conflict" });
    const [row] = await activeConnection.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.id, created.preset.id));
    expect(row).toMatchObject({ isSystem: true, archivedAt: null });
  });

  it("reports not found when another archive wins the guarded update", async () => {
    const activeConnection = requireConnection(connection);
    const setup = createService(activeConnection);
    const created = await setup.duplicatePreset({
      sourceSlug: "preview-1k",
      targetSlug: "concurrently-archived",
    });
    const concurrentlyArchivedAt = new Date("2026-06-20T00:00:09.000Z");
    const service = createService(
      activeConnection,
      interceptFirstSelect(activeConnection.db, async () => {
        await activeConnection.db
          .update(demoPresets)
          .set({ archivedAt: concurrentlyArchivedAt })
          .where(eq(demoPresets.id, created.preset.id));
      }),
    );

    await expect(
      service.archiveAdminPreset({ slug: "concurrently-archived" }),
    ).rejects.toMatchObject({ code: "resource_not_found" });
    const [row] = await activeConnection.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.id, created.preset.id));
    expect(row?.archivedAt).toEqual(concurrentlyArchivedAt);
  });
});

function createService(
  connection: ReturnType<typeof createDatabaseConnection>,
  db = connection.db,
): DemoPresetService {
  return new DemoPresetService({
    db,
    now: () => now,
    generateId: () => "66666666-6666-4666-8666-666666666666",
  });
}

function interceptFirstSelect(
  database: ReturnType<typeof createDatabaseConnection>["db"],
  afterSelect: () => Promise<void>,
): ReturnType<typeof createDatabaseConnection>["db"] {
  let shouldIntercept = true;
  function wrap<T extends object>(builder: T): T {
    return new Proxy(builder, {
      get(target, property) {
        if (property === "then") {
          return (
            onFulfilled?: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve(target)
              .then(async (result) => {
                if (shouldIntercept) {
                  shouldIntercept = false;
                  await afterSelect();
                }
                return result;
              })
              .then(onFulfilled, onRejected);
        }
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args) as unknown;
          return typeof result === "object" && result !== null ? wrap(result) : result;
        };
      },
    });
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "select") {
        return (...args: unknown[]) =>
          wrap(Reflect.apply(target.select, target, args) as ReturnType<typeof target.select>);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function seedPresetFixtures(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  const snapshot = acceptedRunConfigSnapshotFixture();
  await connection.db
    .insert(demoPresets)
    .values([
      presetRow(
        "33333333-3333-4333-8333-333333333331",
        "preview-1k",
        "public",
        false,
        false,
        false,
        10,
        snapshot,
      ),
      presetRow(
        "33333333-3333-4333-8333-333333333335",
        "public-custom",
        "public",
        false,
        true,
        true,
        20,
        snapshot,
      ),
      presetRow(
        "44444444-4444-4444-8444-444444444443",
        "custom",
        "admin",
        true,
        true,
        true,
        120,
        snapshot,
      ),
      presetRow(
        "44444444-4444-4444-8444-444444444450",
        "system-admin",
        "admin",
        true,
        false,
        true,
        90,
        snapshot,
      ),
    ]);
}

function presetRow(
  id: string,
  slug: string,
  visibility: "public" | "admin",
  isEditable: boolean,
  isCustom: boolean,
  isSystem: boolean,
  sortOrder: number,
  snapshot: ReturnType<typeof acceptedRunConfigSnapshotFixture>,
) {
  const names: Record<string, string> = {
    "preview-1k": "Preview 1k",
    "public-custom": "Public Custom",
    custom: "Custom",
    "system-admin": "System Admin",
  };
  return {
    id,
    slug,
    visibility,
    isEditable,
    isCustom,
    isSystem,
    display: {
      name: names[slug] ?? slug,
      description: "Fixture preset.",
      sortOrder,
      outcomeFocus: [],
    },
    ...snapshot,
    createdAt: now,
    updatedAt: now,
  };
}

function requireConnection(connection: ReturnType<typeof createDatabaseConnection> | null) {
  if (!connection) throw new Error("Test database connection was not initialized.");
  return connection;
}
