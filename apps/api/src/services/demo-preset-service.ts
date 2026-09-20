import { randomUUID } from "node:crypto";
import {
  type AdminPresetListItem,
  type AdminPresetListResponse,
  type AdminPresetMutationResponse,
  type ArchiveAdminPresetRequest,
  type ArchiveAdminPresetResponse,
  acceptedErpRunConfigSchema,
  adminPresetListItemSchema,
  adminPresetListResponseSchema,
  adminPresetMutationResponseSchema,
  archiveAdminPresetResponseSchema,
  type CopyDemoPresetToCustomRequest,
  type DemoPresetContract,
  type DuplicateDemoPresetRequest,
  demoPresetContractSchema,
  type PublicPresetListResponse,
  publicPresetListResponseSchema,
  type SaveDemoPresetRequest,
} from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoPresets } from "@checkout-surge/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DemoRunValidationError } from "./demo-run-validation-error.js";

export interface DemoPresetController {
  listPublicPresets(): Promise<PublicPresetListResponse>;
  listAdminPresets(): Promise<AdminPresetListResponse>;
  saveAdminPreset(request: SaveDemoPresetRequest): Promise<AdminPresetMutationResponse>;
  duplicatePreset(request: DuplicateDemoPresetRequest): Promise<AdminPresetMutationResponse>;
  copyPresetToCustom(request: CopyDemoPresetToCustomRequest): Promise<AdminPresetMutationResponse>;
  archiveAdminPreset(request: ArchiveAdminPresetRequest): Promise<ArchiveAdminPresetResponse>;
}

export interface ActiveDemoPresetReader {
  readActivePreset(slug: string): Promise<DemoPresetContract>;
}

export class DemoPresetService implements DemoPresetController, ActiveDemoPresetReader {
  constructor(
    private readonly options: {
      db: CheckoutSurgeDatabase;
      now?: () => Date;
      generateId?: () => string;
    },
  ) {}

  async listPublicPresets(): Promise<PublicPresetListResponse> {
    const rows = await this.options.db
      .select()
      .from(demoPresets)
      .where(and(eq(demoPresets.visibility, "public"), isNull(demoPresets.archivedAt)))
      .orderBy(sql`(${demoPresets.display}->>'sortOrder')::int`);

    return publicPresetListResponseSchema.parse({
      presets: rows.map(toDemoPresetContract),
      timestamp: this.now().toISOString(),
    });
  }

  async listAdminPresets(): Promise<AdminPresetListResponse> {
    const rows = await this.options.db
      .select()
      .from(demoPresets)
      .where(isNull(demoPresets.archivedAt))
      .orderBy(sql`(${demoPresets.display}->>'sortOrder')::int`, demoPresets.slug);

    return adminPresetListResponseSchema.parse({
      presets: rows.map(toAdminPresetListItem),
      timestamp: this.now().toISOString(),
    });
  }

  async saveAdminPreset(request: SaveDemoPresetRequest): Promise<AdminPresetMutationResponse> {
    acceptedErpRunConfigSchema.parse(request.erpConfig);
    const now = this.now();
    const preset = await this.readActivePreset(request.slug);
    ensureEditableAdminPreset(preset);

    const [updated] = await this.options.db
      .update(demoPresets)
      .set({
        display: request.display,
        trafficConfig: request.trafficConfig,
        inventoryConfig: request.inventoryConfig,
        erpConfig: request.erpConfig,
        backpressureConfig: request.backpressureConfig,
        updatedAt: now,
      })
      .where(eq(demoPresets.slug, request.slug))
      .returning();

    return adminPresetMutationResponseSchema.parse({
      preset: toDemoPresetContract(requirePresetRow(updated, request.slug)),
      timestamp: now.toISOString(),
    });
  }

  async duplicatePreset(request: DuplicateDemoPresetRequest): Promise<AdminPresetMutationResponse> {
    const now = this.now();
    const source = await this.readActivePreset(request.sourceSlug);
    acceptedErpRunConfigSchema.parse(source.erpConfig);
    const targetSlug = normalizeSlug(request.targetSlug);
    const [existingTarget] = await this.options.db
      .select({ id: demoPresets.id })
      .from(demoPresets)
      .where(eq(demoPresets.slug, targetSlug))
      .limit(1);

    if (existingTarget) {
      throw new DemoRunValidationError("preset_conflict", "A preset already uses that slug.", {
        conflictReason: "slug_in_use",
        slug: targetSlug,
      });
    }

    if (source.slug === "public-custom") {
      throw new DemoRunValidationError(
        "preset_operation_not_allowed",
        "The public custom base preset cannot be duplicated.",
      );
    }

    const [inserted] = await this.options.db
      .insert(demoPresets)
      .values({
        id: this.generateId(),
        slug: targetSlug,
        visibility: "admin",
        isEditable: true,
        isCustom: false,
        isSystem: false,
        display: {
          ...source.display,
          name: request.displayName ?? `${source.display.name} Copy`,
        },
        trafficConfig: source.trafficConfig,
        inventoryConfig: source.inventoryConfig,
        erpConfig: source.erpConfig,
        backpressureConfig: source.backpressureConfig,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    return adminPresetMutationResponseSchema.parse({
      preset: toDemoPresetContract(requirePresetRow(inserted, targetSlug)),
      timestamp: now.toISOString(),
    });
  }

  async copyPresetToCustom(
    request: CopyDemoPresetToCustomRequest,
  ): Promise<AdminPresetMutationResponse> {
    const now = this.now();
    const source = await this.readActivePreset(request.sourceSlug);
    acceptedErpRunConfigSchema.parse(source.erpConfig);
    const custom = await this.readActivePreset("custom");
    ensureEditableAdminPreset(custom);

    const [updated] = await this.options.db
      .update(demoPresets)
      .set({
        display: {
          ...custom.display,
          description: `Scratch copy of ${source.display.name}.`,
        },
        trafficConfig: source.trafficConfig,
        inventoryConfig: source.inventoryConfig,
        erpConfig: source.erpConfig,
        backpressureConfig: source.backpressureConfig,
        updatedAt: now,
      })
      .where(eq(demoPresets.slug, "custom"))
      .returning();

    return adminPresetMutationResponseSchema.parse({
      preset: toDemoPresetContract(requirePresetRow(updated, "custom")),
      timestamp: now.toISOString(),
    });
  }

  async archiveAdminPreset(
    request: ArchiveAdminPresetRequest,
  ): Promise<ArchiveAdminPresetResponse> {
    const now = this.now();
    const slug = request.slug;
    const [row] = await this.options.db
      .select()
      .from(demoPresets)
      .where(eq(demoPresets.slug, slug))
      .limit(1);

    if (!row || row.archivedAt !== null) {
      throw new DemoRunValidationError("resource_not_found", "Demo preset was not found.", {
        slug,
      });
    }

    if (!isPresetRowArchivable(row)) {
      throw new DemoRunValidationError(
        "preset_conflict",
        "Only operator-created admin presets can be archived.",
        { conflictReason: "not_archivable", slug },
      );
    }

    const [updated] = await this.options.db
      .update(demoPresets)
      .set({ archivedAt: now, updatedAt: now })
      .where(archivablePresetRowCondition(row.id))
      .returning();

    if (!updated?.archivedAt) {
      const [current] = await this.options.db
        .select()
        .from(demoPresets)
        .where(eq(demoPresets.id, row.id))
        .limit(1);

      if (!current || current.archivedAt !== null) {
        throw new DemoRunValidationError("resource_not_found", "Demo preset was not found.", {
          slug,
        });
      }

      throw new DemoRunValidationError(
        "preset_conflict",
        "Only operator-created admin presets can be archived.",
        { conflictReason: "not_archivable", slug },
      );
    }

    return archiveAdminPresetResponseSchema.parse({
      slug: updated.slug,
      archivedAt: updated.archivedAt.toISOString(),
      timestamp: now.toISOString(),
    });
  }

  async readActivePreset(slug: string): Promise<DemoPresetContract> {
    const [preset] = await this.options.db
      .select()
      .from(demoPresets)
      .where(and(eq(demoPresets.slug, slug), isNull(demoPresets.archivedAt)))
      .limit(1);

    if (!preset) {
      throw new DemoRunValidationError("resource_not_found", "Demo preset was not found.", {
        slug,
      });
    }

    return toDemoPresetContract(preset);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private generateId(): string {
    return this.options.generateId?.() ?? randomUUID();
  }
}

function toDemoPresetContract(preset: typeof demoPresets.$inferSelect): DemoPresetContract {
  return demoPresetContractSchema.parse({
    id: preset.id,
    slug: preset.slug,
    visibility: preset.visibility,
    isEditable: preset.isEditable,
    isCustom: preset.isCustom,
    display: preset.display,
    trafficConfig: preset.trafficConfig,
    inventoryConfig: preset.inventoryConfig,
    erpConfig: preset.erpConfig,
    backpressureConfig: preset.backpressureConfig,
    createdAt: preset.createdAt.toISOString(),
    updatedAt: preset.updatedAt.toISOString(),
  });
}

const archivablePresetProperties = {
  visibility: "admin",
  isEditable: true,
  isCustom: false,
  isSystem: false,
} as const;

function isPresetRowArchivable(row: typeof demoPresets.$inferSelect): boolean {
  return (
    row.visibility === archivablePresetProperties.visibility &&
    row.isEditable === archivablePresetProperties.isEditable &&
    row.isCustom === archivablePresetProperties.isCustom &&
    row.isSystem === archivablePresetProperties.isSystem &&
    row.archivedAt === null
  );
}

function archivablePresetRowCondition(presetId: string) {
  return and(
    eq(demoPresets.id, presetId),
    eq(demoPresets.visibility, archivablePresetProperties.visibility),
    eq(demoPresets.isEditable, archivablePresetProperties.isEditable),
    eq(demoPresets.isCustom, archivablePresetProperties.isCustom),
    eq(demoPresets.isSystem, archivablePresetProperties.isSystem),
    isNull(demoPresets.archivedAt),
  );
}

function toAdminPresetListItem(row: typeof demoPresets.$inferSelect): AdminPresetListItem {
  return adminPresetListItemSchema.parse({
    ...toDemoPresetContract(row),
    canArchive: isPresetRowArchivable(row),
  });
}

function ensureEditableAdminPreset(preset: DemoPresetContract): void {
  if (preset.visibility !== "admin" || !preset.isEditable) {
    throw new DemoRunValidationError(
      "preset_operation_not_allowed",
      "Only editable admin presets can be changed.",
      { slug: preset.slug },
    );
  }
}

function normalizeSlug(slug: string): string {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  if (!normalized) {
    throw new DemoRunValidationError(
      "invalid_request",
      "Preset slug must contain a letter or number.",
    );
  }

  return normalized;
}

function requirePresetRow(
  preset: typeof demoPresets.$inferSelect | undefined,
  slug: string,
): typeof demoPresets.$inferSelect {
  if (!preset) {
    throw new DemoRunValidationError("resource_not_found", "Demo preset was not found.", { slug });
  }

  return preset;
}
