"use client";

import {
  type AcceptedRunConfigSnapshot,
  type AdminPresetListItem,
  type AdminPublicRuntimePolicyResponse,
  type DeploymentHardCaps,
  type ErpChaosStatus,
  nonnegativeNumberMinimum,
  orderProcessConcurrencyHardCap,
  positiveIntegerMinimum,
} from "@checkout-surge/contracts";
import { type ReactNode, useEffect, useId, useRef } from "react";
import type {
  DraftFieldError,
  DraftFormError,
  PresetDraft,
  RunConfigDraft,
  RuntimePolicyDraft,
} from "../../lib/admin-drafts";
import type { BackendRead } from "../../lib/api";
import type { AdminNotice } from "../../lib/presentation/admin-notice";
import {
  adminDraftFieldHints,
  adminFieldHints,
  fieldHints,
} from "../../lib/presentation/field-hints";
import { formatCount } from "../../lib/presentation/format";
import { ratioToPercent } from "../../lib/presentation/percent";
import { trafficModeLabel } from "../../lib/presentation/public-vocabulary";
import { ConfigGroup, FieldRow } from "../config-presentation";
import {
  buttonClassName,
  fieldHelpClassName,
  fieldLabelClassName,
  inputClassName,
  panelClassName,
  primaryButtonClassName,
  settingsFieldsetClassName,
  settingsLegendClassName,
} from "../control-styles";
import { ErrorNotice } from "../error-notice";
import { FieldHint } from "../field-hint";
import { StatusPill } from "../status-pill";
import { AdminNoticeView } from "./admin-notice";

export { buttonClassName, panelClassName, primaryButtonClassName };

export const eyebrowClassName = "m-0 text-xs font-medium text-muted";
export const panelTitleClassName =
  "type-title m-0 mt-0.5 flex items-center gap-2 text-lg leading-tight text-ink";
const fieldGridClassName =
  "grid grid-cols-[repeat(auto-fill,minmax(min(100%,12.5rem),1fr))] items-start gap-3";
const presetListButtonClassName =
  "flex min-h-10 w-full items-center rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-colors enabled:cursor-pointer disabled:cursor-not-allowed disabled:opacity-55";
const reasonClassName = "m-0 mt-1 max-w-64 text-xs leading-4 text-muted";
const subheadingClassName = "m-0 flex items-center gap-2 text-sm font-semibold text-ink";

export function AdminRuntimePolicyView({
  draft,
  fieldErrors = {},
  formErrors = [],
  isPending,
  latestRuntimePolicyRead,
  notice,
  onBlurField = () => undefined,
  onRefresh,
  onSave,
  onUpdateDraft,
  runtimePolicy,
  showValidationSummary = false,
  validationSummaryRevision = 0,
}: {
  draft: RuntimePolicyDraft | null;
  fieldErrors?: Record<string, DraftFieldError>;
  formErrors?: DraftFormError[];
  isPending: boolean;
  latestRuntimePolicyRead?: BackendRead<AdminPublicRuntimePolicyResponse>;
  notice: AdminNotice | null;
  onBlurField?: (field: string) => void;
  onRefresh: () => void;
  onSave: () => void;
  onUpdateDraft: (next: Partial<RuntimePolicyDraft>) => void;
  runtimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
  showValidationSummary?: boolean;
  validationSummaryRevision?: number;
}) {
  const policy = runtimePolicy.status === "available" ? runtimePolicy.data.policy : null;
  const latestRead = latestRuntimePolicyRead ?? runtimePolicy;
  return (
    <section className={`${panelClassName} lg:col-span-2`} id="public-runtime-policy">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className={eyebrowClassName}>Public policy</p>
          <h2 className={panelTitleClassName}>
            Public runtime policy{" "}
            <FieldHint label="Public runtime policy" text={adminFieldHints.publicPolicy} />
          </h2>
          <p className="m-0 mt-1 text-sm text-muted">
            Shared policy for future public starts. Already accepted runs keep their snapshots.
          </p>
        </div>
        <StatusPill
          status={{
            label:
              policy && draft
                ? draft.isPublicRunBudgetEnforced
                  ? "budgeted"
                  : "open"
                : "not yet available",
            tone: policy && draft ? "ok" : "idle",
          }}
        />
      </div>
      <details className="rounded-xl border border-border px-4 py-3">
        <summary className="disclosure text-sm font-semibold text-ink">
          Runtime budgets, custom limits, and deployment hard caps
        </summary>
        <div className="mt-4">
          {policy && draft ? (
            <div className="grid gap-4">
              {showValidationSummary ? (
                <ValidationSummary
                  errors={fieldErrors}
                  formErrors={formErrors}
                  key={validationSummaryRevision}
                  prefix="runtime-policy"
                />
              ) : null}
              <div className="grid gap-3">
                <p className={subheadingClassName}>Public budget</p>
                <div className={fieldGridClassName}>
                  <Checkbox
                    label="Enforce public budget"
                    hint={adminFieldHints.publicBudget}
                    checked={draft.isPublicRunBudgetEnforced}
                    onChange={(value) => onUpdateDraft({ isPublicRunBudgetEnforced: value })}
                  />
                  <DraftInput
                    label="Budget window seconds"
                    draft={draft}
                    field="budgetWindowSeconds"
                    onUpdate={onUpdateDraft}
                    onBlur={onBlurField}
                    error={fieldErrors.budgetWindowSeconds}
                    prefix="runtime-policy"
                  />
                  <DraftInput
                    label="Per-visitor starts"
                    draft={draft}
                    field="perVisitorMaxStarts"
                    onUpdate={onUpdateDraft}
                    onBlur={onBlurField}
                    error={fieldErrors.perVisitorMaxStarts}
                    prefix="runtime-policy"
                  />
                  <DraftInput
                    label="Global starts"
                    draft={draft}
                    field="globalMaxStarts"
                    onUpdate={onUpdateDraft}
                    onBlur={onBlurField}
                    error={fieldErrors.globalMaxStarts}
                    prefix="runtime-policy"
                  />
                </div>
              </div>
              <div className="grid gap-3">
                <p className={subheadingClassName}>
                  Public custom defaults{" "}
                  <FieldHint label="Public custom defaults" text={adminFieldHints.publicDefaults} />
                </p>
                <div className="border-y border-border">
                  <ConfigFieldset legend="Traffic">
                    <TrafficEditor
                      disabled={isPending}
                      draft={draft}
                      errors={fieldErrors}
                      hardCaps={policy.deploymentHardCaps}
                      onBlur={onBlurField}
                      onUpdateDraft={onUpdateDraft}
                      prefix="runtime-policy"
                    />
                  </ConfigFieldset>
                  <RunConfigFields
                    disabled={isPending}
                    erpErrorRateMax={Number(draft.maxErpErrorRate)}
                    draft={draft}
                    errors={fieldErrors}
                    includeForcedOutage={false}
                    onBlur={onBlurField}
                    onUpdateDraft={onUpdateDraft}
                    prefix="runtime-policy"
                  />
                </div>
              </div>
              <div className="grid gap-3">
                <p className={subheadingClassName}>
                  Public custom limits{" "}
                  <FieldHint label="Public custom limits" text={adminFieldHints.publicLimits} />
                </p>
                <div className={fieldGridClassName}>
                  {policyLimitFields.map(([field, label, step]) => (
                    <DraftInput
                      key={field}
                      label={label}
                      draft={draft}
                      field={field}
                      onUpdate={onUpdateDraft}
                      onBlur={onBlurField}
                      error={fieldErrors[field as string]}
                      prefix="runtime-policy"
                      step={step}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-8">
                  <Checkbox
                    alignWithInputs={false}
                    label="Allow buyer spike"
                    hint={adminFieldHints.allowTrafficModes}
                    id="runtime-policy-allowBuyerSpike"
                    checked={draft.allowBuyerSpike}
                    error={fieldErrors.allowBuyerSpike}
                    onChange={(value) => onUpdateDraft({ allowBuyerSpike: value })}
                  />
                  <Checkbox
                    alignWithInputs={false}
                    label="Allow constant arrival"
                    hint={adminFieldHints.allowTrafficModes}
                    id="runtime-policy-allowConstantArrivalRate"
                    checked={draft.allowConstantArrivalRate}
                    error={fieldErrors.allowConstantArrivalRate}
                    onChange={(value) => onUpdateDraft({ allowConstantArrivalRate: value })}
                  />
                </div>
              </div>
              <dl className="m-0 grid grid-cols-4 gap-3 rounded-xl bg-surface-muted p-4 max-[900px]:grid-cols-2">
                <div className="col-span-full flex items-center gap-2 text-sm font-semibold text-ink">
                  Deployment hard caps{" "}
                  <FieldHint
                    label="Deployment hard caps"
                    text={adminFieldHints.deploymentHardCaps}
                  />
                </div>
                <Fact
                  label="Hard max buyers"
                  value={formatCap(policy.deploymentHardCaps.maxBuyers)}
                />
                <Fact
                  label="Hard max requests"
                  value={formatCap(policy.deploymentHardCaps.maxTotalRequests)}
                />
                <Fact
                  label="Hard max requests/second"
                  value={formatCap(policy.deploymentHardCaps.maxRequestsPerSecond)}
                />
                <Fact
                  label="Hard max duration (seconds)"
                  value={formatCap(policy.deploymentHardCaps.maxTrafficDurationSeconds)}
                />
                <Fact
                  label="Hard max start delay (seconds)"
                  value={formatCap(policy.deploymentHardCaps.maxTrafficStartDelaySeconds)}
                />
                <Fact
                  label="Hard max preallocated virtual users"
                  value={formatCap(policy.deploymentHardCaps.maxPreAllocatedVus)}
                />
                <Fact
                  label="Hard max virtual users"
                  value={formatCap(policy.deploymentHardCaps.maxVus)}
                />
              </dl>
              <div className="flex flex-wrap gap-2">
                <button
                  className={primaryButtonClassName}
                  disabled={isPending}
                  onClick={onSave}
                  type="button"
                >
                  Save public policy
                </button>
                <button
                  className={buttonClassName}
                  disabled={isPending}
                  onClick={onRefresh}
                  type="button"
                >
                  Refresh policy
                </button>
              </div>
              {latestRead.status === "unavailable" ? <Unavailable read={latestRead} /> : null}
            </div>
          ) : (
            <div>
              <Unavailable read={runtimePolicy} />
              <button
                className={`${buttonClassName} mt-4`}
                disabled={isPending}
                onClick={onRefresh}
                type="button"
              >
                Refresh policy
              </button>
            </div>
          )}
          <AdminNoticeView notice={notice} />
        </div>
      </details>
    </section>
  );
}

/**
 * A cap is read against the editable field that sets it — the duration cap sits beside the
 * `Max duration seconds` input — so it renders as a grouped count in that field's unit rather
 * than as a tiered duration. Being operator-typed is not the reason: configured guards that sit
 * among observed intervals in the run-history detail are operator-typed too and are tiered there.
 * Grouping still follows the one locale policy, so 100000 reads 100,000.
 */
function formatCap(value: number): string {
  return formatCount(value) ?? "not configured";
}

const policyLimitFields: ReadonlyArray<[keyof RuntimePolicyDraft, string, string?]> = [
  ["maxTotalRequests", "Max total requests"],
  ["maxBuyers", "Max buyers"],
  ["maxRequestsPerSecond", "Max requests/sec"],
  ["maxTrafficDurationSeconds", "Max duration seconds"],
  ["maxTrafficStartDelaySeconds", "Max start delay seconds"],
  ["maxPreAllocatedVus", "Max preallocated VUs"],
  ["maxPublicVus", "Max VUs"],
  ["maxStartingStock", "Max starting stock"],
  ["maxErpLatencyMs", "Max ERP latency ms"],
  ["minErpMaxTps", "Min ERP max TPS"],
  ["maxErpMaxTps", "Max ERP max TPS"],
  ["maxErpErrorRate", "Max ERP error rate", "0.01"],
];

export function AdminPresetView({
  draft,
  effectiveConfig,
  fieldErrors,
  formErrors,
  hardCaps,
  duplicateTargetSlug,
  isPending,
  isDirty,
  notice,
  onBlurField,
  syncNotice,
  onArchive,
  onCopyToCustom,
  onDuplicate,
  onDuplicateTargetSlugChange,
  onSave,
  onSelect,
  onStart,
  onUpdateDraft,
  presets,
  presetsRead,
  selectedPreset,
  startBlocked,
  startBlockedReason,
  admissionNotice,
  acceptedRunId,
  showValidationSummary,
  validationSummaryRevision,
}: {
  draft: PresetDraft | null;
  effectiveConfig?: AcceptedRunConfigSnapshot | undefined;
  fieldErrors: Record<string, DraftFieldError>;
  formErrors: DraftFormError[];
  hardCaps?: DeploymentHardCaps | undefined;
  duplicateTargetSlug: string;
  isPending: boolean;
  isDirty: boolean;
  notice: AdminNotice | null;
  onBlurField: (field: string) => void;
  syncNotice: AdminNotice | null;
  onArchive: () => void;
  onCopyToCustom: () => void;
  onDuplicate: (targetSlug: string) => void;
  onDuplicateTargetSlugChange: (value: string) => void;
  onSave: () => void;
  onSelect: (slug: string) => void;
  onStart: () => void;
  onUpdateDraft: (next: Partial<PresetDraft>) => void;
  presets: AdminPresetListItem[];
  presetsRead: BackendRead<unknown>;
  selectedPreset: AdminPresetListItem | null;
  admissionNotice?: React.ReactNode;
  acceptedRunId?: string | undefined;
  startBlocked: boolean;
  startBlockedReason?: string | undefined;
  showValidationSummary: boolean;
  validationSummaryRevision: number;
}) {
  const presetListPendingReasonId = useId();
  const startPendingReasonId = useId();
  const startBlockedReasonId = useId();
  const saveReasonId = useId();
  const copyPendingReasonId = useId();
  const archiveReasonId = useId();
  const duplicateReasonId = useId();
  const actionPendingReason = isPending ? "A preset action is in progress." : null;
  const saveReason = selectedPreset
    ? (actionPendingReason ?? saveUnavailableReason(selectedPreset))
    : null;
  const archiveReason = selectedPreset
    ? (actionPendingReason ?? archiveUnavailableReason(selectedPreset))
    : null;
  const duplicateReason = selectedPreset
    ? (actionPendingReason ??
      (selectedPreset.slug === "public-custom"
        ? "The public Custom scenario cannot be duplicated."
        : null))
    : null;
  return (
    <section className={`${panelClassName} lg:col-span-2`} id="presets">
      <PanelHeading
        eyebrow="Presets"
        title="Inspection and starts"
        hint={adminFieldHints.presets}
        status={
          <StatusPill
            status={
              presetsRead.status === "unavailable"
                ? { label: "unavailable", tone: "warning" }
                : { label: `${presets.length} loaded`, tone: "ok" }
            }
          />
        }
      />
      <div className="grid grid-cols-[minmax(11rem,14rem)_minmax(0,1fr)] gap-6 max-[800px]:grid-cols-1">
        {/* biome-ignore lint/a11y/useSemanticElements: C04 intentionally groups pressed buttons rather than native radios because preset changes may require confirmation. */}
        <div
          aria-label="Preset selection"
          className="grid content-start gap-1 min-[801px]:sticky min-[801px]:top-20"
          role="group"
        >
          {presets.map((preset) => (
            <button
              aria-describedby={actionPendingReason ? presetListPendingReasonId : undefined}
              aria-pressed={preset.slug === selectedPreset?.slug}
              className={`${presetListButtonClassName} ${preset.slug === selectedPreset?.slug ? "border-accent bg-accent text-white" : "border-transparent text-muted-strong enabled:hover:bg-surface-muted enabled:hover:text-ink"} [overflow-wrap:anywhere]`}
              disabled={isPending}
              key={preset.slug}
              onClick={() => onSelect(preset.slug)}
              type="button"
            >
              {preset.display.name}
            </button>
          ))}
          {actionPendingReason ? (
            <p className="m-0 text-xs text-muted" id={presetListPendingReasonId}>
              {actionPendingReason}
            </p>
          ) : null}
          {presetsRead.status === "unavailable" ? <Unavailable read={presetsRead} /> : null}
        </div>
        {selectedPreset && draft ? (
          <div className="grid min-w-0 gap-4 border-l border-border pl-6 max-[800px]:border-l-0 max-[800px]:pl-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="type-title m-0 text-xl text-ink">{selectedPreset.display.name}</h3>
              <span aria-live="polite" role="status">
                <StatusPill
                  status={{
                    label: isDirty ? "Unsaved" : "Saved",
                    tone: isDirty ? "warning" : "ok",
                  }}
                />
              </span>
            </div>
            {!selectedPreset.isEditable ? (
              <p className="m-0 rounded-lg border border-warning-line bg-warning-soft px-3 py-2 text-sm font-semibold text-warning">
                You're editing values for a one-off run — {selectedPreset.display.name} itself can't
                be changed
              </p>
            ) : null}
            {showValidationSummary ? (
              <ValidationSummary
                errors={fieldErrors}
                formErrors={formErrors}
                key={validationSummaryRevision}
                prefix="preset"
              />
            ) : null}
            <ConfigGroup title="Preset identity">
              <FieldRow label="Slug" value={selectedPreset.slug} hint={adminFieldHints.slug} />
              <FieldRow
                label="Visibility"
                value={selectedPreset.visibility}
                hint={adminFieldHints.visibility}
              />
              <FieldRow
                label="Custom"
                value={selectedPreset.isCustom ? "yes" : "no"}
                hint={adminFieldHints.custom}
              />
            </ConfigGroup>
            <p className="m-0 [overflow-wrap:anywhere] text-sm text-muted">{draft.description}</p>
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_8rem] gap-3 max-[1100px]:grid-cols-2 max-[560px]:grid-cols-1">
              <DraftInput
                label="Name"
                hint={adminFieldHints.presetName}
                draft={draft}
                field="displayName"
                error={fieldErrors.displayName}
                onUpdate={onUpdateDraft}
                onBlur={onBlurField}
                type="text"
                prefix="preset"
                disabled={isPending || !selectedPreset.isEditable}
              />
              <DraftInput
                label="Description"
                hint={adminFieldHints.presetDescription}
                draft={draft}
                field="description"
                onUpdate={onUpdateDraft}
                onBlur={onBlurField}
                type="text"
                prefix="preset"
                disabled={isPending || !selectedPreset.isEditable}
              />
              <DraftInput
                label="Sort order"
                hint={adminFieldHints.sortOrder}
                draft={draft}
                field="sortOrder"
                onUpdate={onUpdateDraft}
                onBlur={onBlurField}
                error={fieldErrors.sortOrder}
                prefix="preset"
                disabled={isPending || !selectedPreset.isEditable}
              />
            </div>
            <div className="border-y border-border">
              <ConfigFieldset disabled={isPending} legend="Traffic">
                <TrafficEditor
                  disabled={isPending}
                  draft={draft}
                  errors={fieldErrors}
                  hardCaps={hardCaps}
                  onBlur={onBlurField}
                  onUpdateDraft={onUpdateDraft}
                  prefix="preset"
                />
              </ConfigFieldset>
              <ConfigFieldset disabled={isPending} legend="Inventory">
                <RunConfigInputs
                  draft={draft}
                  errors={fieldErrors}
                  fields={inventoryFields}
                  disabled={isPending}
                  onBlur={onBlurField}
                  onUpdateDraft={onUpdateDraft}
                  prefix="preset"
                />
              </ConfigFieldset>
              <ConfigFieldset
                disabled={isPending}
                hint={adminFieldHints.perRunErp}
                legend="Per-run ERP"
              >
                <RunConfigInputs
                  draft={draft}
                  errors={fieldErrors}
                  fields={erpFields}
                  disabled={isPending}
                  onBlur={onBlurField}
                  onUpdateDraft={onUpdateDraft}
                  prefix="preset"
                />
                <Checkbox
                  label="ERP forced outage"
                  hint={adminDraftFieldHints.erpForcedOutage}
                  disabled={isPending}
                  id="preset-erpForcedOutage"
                  checked={draft.erpForcedOutage}
                  error={fieldErrors.erpForcedOutage}
                  onChange={(value) => onUpdateDraft({ erpForcedOutage: value })}
                />
              </ConfigFieldset>
              <ConfigFieldset
                disabled={isPending}
                hint={adminFieldHints.workerBackpressure}
                legend="Worker and backpressure"
              >
                <RunConfigInputs
                  draft={draft}
                  errors={fieldErrors}
                  fields={workerFields}
                  disabled={isPending}
                  onBlur={onBlurField}
                  onUpdateDraft={onUpdateDraft}
                  prefix="preset"
                />
              </ConfigFieldset>
            </div>
            {effectiveConfig ? <EffectiveRunPreview config={effectiveConfig} /> : null}
            <div className="flex flex-wrap items-start gap-2">
              <div>
                <button
                  aria-describedby={
                    [
                      actionPendingReason ? startPendingReasonId : null,
                      startBlockedReason ? startBlockedReasonId : null,
                    ]
                      .filter(Boolean)
                      .join(" ") || undefined
                  }
                  className={primaryButtonClassName}
                  disabled={isPending || startBlocked}
                  onClick={onStart}
                  type="button"
                >
                  Run once with these values
                </button>
                {actionPendingReason ? (
                  <p className={reasonClassName} id={startPendingReasonId}>
                    {actionPendingReason}
                  </p>
                ) : null}
                {admissionNotice}
                {startBlockedReason ? (
                  <p className={reasonClassName} id={startBlockedReasonId}>
                    {startBlockedReason}
                  </p>
                ) : null}
              </div>
              <div>
                <button
                  aria-describedby={saveReason ? saveReasonId : undefined}
                  className={buttonClassName}
                  disabled={
                    isPending ||
                    !(selectedPreset.visibility === "admin" && selectedPreset.isEditable)
                  }
                  onClick={onSave}
                  type="button"
                >
                  Save preset
                </button>
                {saveReason ? (
                  <p className={reasonClassName} id={saveReasonId}>
                    {saveReason}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="grid gap-4 border-t border-border pt-4">
              <div className="flex flex-wrap items-start gap-2">
                <div>
                  <button
                    aria-describedby={actionPendingReason ? copyPendingReasonId : undefined}
                    className={buttonClassName}
                    disabled={isPending}
                    onClick={onCopyToCustom}
                    type="button"
                  >
                    Copy saved values to custom scenario
                  </button>{" "}
                  <FieldHint
                    label="Copy saved values to custom scenario"
                    text={adminFieldHints.copyToCustom}
                  />
                  {actionPendingReason ? (
                    <p className={reasonClassName} id={copyPendingReasonId}>
                      {actionPendingReason}
                    </p>
                  ) : null}
                </div>
                <div>
                  <button
                    aria-describedby={archiveReason ? archiveReasonId : undefined}
                    className={buttonClassName}
                    disabled={isPending || !selectedPreset.canArchive}
                    onClick={onArchive}
                    type="button"
                  >
                    Archive preset
                  </button>
                  {archiveReason ? (
                    <p className={reasonClassName} id={archiveReasonId}>
                      {archiveReason}
                    </p>
                  ) : null}
                </div>
              </div>
              <form
                className="grid grid-cols-[minmax(10rem,22rem)_max-content] items-start gap-2 max-[560px]:grid-cols-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  const targetSlug = String(
                    new FormData(event.currentTarget).get("duplicate-target-slug") ?? "",
                  );
                  onDuplicate(targetSlug);
                }}
              >
                <LabeledTextInput
                  disabled={isPending}
                  help="Letters are lowercased and separators become hyphens, e.g. recruiter-demo."
                  hint={adminFieldHints.duplicateSlug}
                  label="Duplicate slug"
                  name="duplicate-target-slug"
                  onChange={onDuplicateTargetSlugChange}
                  value={duplicateTargetSlug}
                />
                <button
                  aria-describedby={duplicateReason ? duplicateReasonId : undefined}
                  className={`${buttonClassName} min-[561px]:mt-7`}
                  disabled={isPending || selectedPreset.slug === "public-custom"}
                  type="submit"
                >
                  Duplicate saved preset
                </button>
                {duplicateReason ? (
                  <p className="col-span-full m-0 text-xs text-muted" id={duplicateReasonId}>
                    {duplicateReason}
                  </p>
                ) : null}
              </form>
            </div>
          </div>
        ) : presetsRead.status === "available" ? (
          <p className="m-0 text-muted">No admin presets are available.</p>
        ) : null}
      </div>
      <AdminNoticeView notice={notice} />
      {notice === "Admin run accepted." ? (
        <a
          className={`${buttonClassName} mt-4 inline-flex items-center`}
          href={acceptedRunId ? `/watch?${new URLSearchParams({ acceptedRunId })}` : "/watch"}
        >
          Watch live
        </a>
      ) : null}
      <AdminNoticeView notice={syncNotice} />
    </section>
  );
}

function saveUnavailableReason(preset: AdminPresetListItem): string | null {
  if (preset.visibility !== "admin") return "Public presets cannot be saved from the admin editor.";
  if (!preset.isEditable) return "This read-only preset cannot be saved.";
  return null;
}

function archiveUnavailableReason(preset: AdminPresetListItem): string | null {
  if (preset.canArchive) return null;
  if (preset.isCustom) return "The Custom scratch scenario cannot be archived.";
  if (preset.visibility !== "admin") return "Public presets cannot be archived.";
  if (!preset.isEditable) return "Read-only and system presets cannot be archived.";
  return "The server reports this preset can't be archived right now.";
}

export function EffectiveRunPreview({
  config,
  defaultOpen = false,
}: {
  config: AcceptedRunConfigSnapshot;
  defaultOpen?: boolean;
}) {
  const traffic = config.trafficConfig;
  return (
    <details className="rounded-xl border border-border px-4 py-3" open={defaultOpen}>
      <summary className="disclosure text-sm font-semibold text-ink">
        Effective run preview{" "}
        <FieldHint label="Effective run preview" text={adminFieldHints.effectiveRunPreview} />
      </summary>
      <div className="mt-3 grid grid-cols-2 items-start gap-x-6 gap-y-3 max-[700px]:grid-cols-1">
        <div className="grid min-w-0 gap-3">
          <ConfigGroup title="Traffic">
            <FieldRow label="Mode" value={trafficModeLabel(traffic.mode)} />
            {traffic.mode === "buyer-spike" ? (
              <>
                <FieldRow label="Buyer count" value={traffic.buyerCount} />
                <FieldRow
                  label="Duplicate attempts"
                  value={traffic.duplicateEachBuyerAttempt ? "yes" : "no"}
                />
                <FieldRow label="Max duration seconds" value={traffic.maxDurationSeconds} />
              </>
            ) : (
              <>
                <FieldRow label="Requests per second" value={traffic.ratePerSecond} />
                <FieldRow label="Duration seconds" value={traffic.durationSeconds} />
                <FieldRow label="Preallocated VUs" value={traffic.k6Vus?.preAllocatedVus ?? "—"} />
                <FieldRow label="Max VUs" value={traffic.k6Vus?.maxVus ?? "—"} />
              </>
            )}
            <FieldRow label="Start delay seconds" value={traffic.startDelaySeconds} />
            <FieldRow label="Quantity per attempt" value={traffic.quantityPerAttempt} />
          </ConfigGroup>
          <ConfigGroup title="Inventory">
            <FieldRow label="Starting stock" value={config.inventoryConfig.startingStock} />
          </ConfigGroup>
        </div>
        <div className="grid min-w-0 gap-3">
          <ConfigGroup title="Per-run ERP">
            <FieldRow label="Latency ms" value={config.erpConfig.latencyMs} />
            <FieldRow label="Max TPS" value={config.erpConfig.maxTps} />
            <FieldRow label="Error rate" value={`${ratioToPercent(config.erpConfig.errorRate)}%`} />
            <FieldRow label="Forced outage" value={config.erpConfig.forcedOutage ? "yes" : "no"} />
          </ConfigGroup>
          <ConfigGroup title="Worker and backpressure">
            <FieldRow
              label="Physical queue name"
              value={config.backpressureConfig.physicalQueueName}
            />
            <FieldRow
              label="Order process concurrency"
              value={config.backpressureConfig.orderProcessConcurrency}
            />
            <FieldRow label="Queue name" value={config.backpressureConfig.queueName} />
          </ConfigGroup>
        </div>
      </div>
    </details>
  );
}

function TrafficEditor({
  disabled,
  draft,
  errors,
  hardCaps,
  onBlur,
  onUpdateDraft,
  prefix,
}: {
  draft: RunConfigDraft;
  disabled?: boolean | undefined;
  errors: Record<string, DraftFieldError>;
  hardCaps?: DeploymentHardCaps | undefined;
  onBlur: (field: string) => void;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
  prefix: string;
}) {
  return (
    <div className="col-span-full grid gap-3">
      <fieldset
        aria-describedby={errors.mode ? `${prefix}-mode-error` : undefined}
        aria-invalid={errors.mode ? true : undefined}
        className="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
        id={`${prefix}-mode`}
        tabIndex={-1}
      >
        <legend className="float-left mr-1 flex min-h-10 items-center text-sm font-semibold text-ink">
          Traffic pattern
        </legend>
        <FieldHint
          label="Traffic pattern"
          text={`${fieldHints.trafficPattern} Technically, k6 per-vu-iterations (one virtual user per buyer) versus constant-arrival-rate.`}
        />
        {(["buyer-spike", "constant-arrival-rate"] as const).map((mode) => (
          <label
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-muted-strong has-checked:border-accent has-checked:bg-accent-soft has-checked:text-ink has-disabled:cursor-not-allowed has-disabled:opacity-55"
            key={mode}
          >
            <input
              checked={draft.mode === mode}
              disabled={disabled}
              name={`${prefix}-traffic-mode`}
              onChange={() => onUpdateDraft({ mode })}
              type="radio"
              value={mode}
            />
            {trafficModeLabel(mode)}
          </label>
        ))}
      </fieldset>
      {errors.mode ? (
        <span className="text-xs font-semibold text-danger" id={`${prefix}-mode-error`}>
          {errors.mode.message}
        </span>
      ) : null}
      <div className={fieldGridClassName}>
        {draft.mode === "buyer-spike" ? (
          <>
            <DraftInput
              disabled={disabled}
              label="Buyer count"
              draft={draft}
              field="buyerCount"
              onUpdate={onUpdateDraft}
              onBlur={onBlur}
              error={errors.buyerCount}
              max={hardCaps?.maxBuyers}
              prefix={prefix}
            />
            <DraftInput
              disabled={disabled}
              label="Max duration seconds"
              draft={draft}
              field="maxDurationSeconds"
              onUpdate={onUpdateDraft}
              onBlur={onBlur}
              error={errors.maxDurationSeconds}
              max={hardCaps?.maxTrafficDurationSeconds}
              prefix={prefix}
            />
            <Checkbox
              label="Duplicate attempts"
              hint={adminDraftFieldHints.duplicateEachBuyerAttempt}
              disabled={disabled}
              id={`${prefix}-duplicateEachBuyerAttempt`}
              checked={draft.duplicateEachBuyerAttempt}
              error={errors.duplicateEachBuyerAttempt}
              onChange={(value) => onUpdateDraft({ duplicateEachBuyerAttempt: value })}
            />
          </>
        ) : (
          <>
            <DraftInput
              disabled={disabled}
              label="Requests per second"
              draft={draft}
              field="ratePerSecond"
              onUpdate={onUpdateDraft}
              onBlur={onBlur}
              error={errors.ratePerSecond}
              max={hardCaps?.maxRequestsPerSecond}
              prefix={prefix}
            />
            <DraftInput
              disabled={disabled}
              label="Duration seconds"
              draft={draft}
              field="durationSeconds"
              onUpdate={onUpdateDraft}
              onBlur={onBlur}
              error={errors.durationSeconds}
              max={hardCaps?.maxTrafficDurationSeconds}
              prefix={prefix}
            />
            <DraftInput
              disabled={disabled}
              label="Preallocated VUs"
              draft={draft}
              field="preAllocatedVus"
              onUpdate={onUpdateDraft}
              onBlur={onBlur}
              error={errors.preAllocatedVus}
              max={hardCaps?.maxPreAllocatedVus}
              prefix={prefix}
            />
            <DraftInput
              disabled={disabled}
              label="Max VUs"
              draft={draft}
              error={errors.maxVus}
              max={hardCaps?.maxVus}
              field="maxVus"
              onUpdate={onUpdateDraft}
              onBlur={onBlur}
              prefix={prefix}
            />
          </>
        )}
        <DraftInput
          disabled={disabled}
          label="Start delay seconds"
          draft={draft}
          field="startDelaySeconds"
          onUpdate={onUpdateDraft}
          onBlur={onBlur}
          error={errors.startDelaySeconds}
          max={hardCaps?.maxTrafficStartDelaySeconds}
          prefix={prefix}
        />
      </div>
    </div>
  );
}

function RunConfigFields({
  draft,
  disabled,
  erpErrorRateMax,
  errors,
  includeForcedOutage = true,
  onBlur,
  onUpdateDraft,
  prefix,
}: {
  draft: RunConfigDraft;
  disabled?: boolean | undefined;
  erpErrorRateMax?: number | undefined;
  errors: Record<string, DraftFieldError>;
  includeForcedOutage?: boolean;
  onBlur: (field: string) => void;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
  prefix: string;
}) {
  return (
    <>
      <ConfigFieldset legend="Inventory">
        <RunConfigInputs
          disabled={disabled}
          draft={draft}
          errors={errors}
          fields={inventoryFields}
          onBlur={onBlur}
          onUpdateDraft={onUpdateDraft}
          prefix={prefix}
        />
      </ConfigFieldset>
      <ConfigFieldset hint={adminFieldHints.perRunErp} legend="Per-run ERP">
        <RunConfigInputs
          disabled={disabled}
          erpErrorRateMax={erpErrorRateMax}
          draft={draft}
          errors={errors}
          fields={erpFields}
          onBlur={onBlur}
          onUpdateDraft={onUpdateDraft}
          prefix={prefix}
        />
        {includeForcedOutage ? (
          <Checkbox
            label="ERP forced outage"
            disabled={disabled}
            id={`${prefix}-erpForcedOutage`}
            checked={draft.erpForcedOutage}
            error={errors.erpForcedOutage}
            onChange={(value) => onUpdateDraft({ erpForcedOutage: value })}
          />
        ) : null}
      </ConfigFieldset>
      <ConfigFieldset hint={adminFieldHints.workerBackpressure} legend="Worker and backpressure">
        <RunConfigInputs
          disabled={disabled}
          draft={draft}
          errors={errors}
          fields={workerFields}
          onBlur={onBlur}
          onUpdateDraft={onUpdateDraft}
          prefix={prefix}
        />
      </ConfigFieldset>
    </>
  );
}

function ConfigFieldset({
  children,
  disabled,
  hint,
  legend,
}: {
  children: ReactNode;
  disabled?: boolean | undefined;
  hint?: string | undefined;
  legend: string;
}) {
  return (
    <fieldset aria-disabled={disabled || undefined} className={settingsFieldsetClassName}>
      <legend className={settingsLegendClassName}>
        {legend} {hint ? <FieldHint label={legend} text={hint} /> : null}
      </legend>
      <div className={fieldGridClassName}>{children}</div>
    </fieldset>
  );
}

function RunConfigInputs({
  draft,
  disabled,
  erpErrorRateMax,
  errors,
  fields,
  onBlur,
  onUpdateDraft,
  prefix,
}: {
  draft: RunConfigDraft;
  disabled?: boolean | undefined;
  erpErrorRateMax?: number | undefined;
  errors: Record<string, DraftFieldError>;
  fields: ReadonlyArray<[keyof RunConfigDraft, string, string?]>;
  onBlur: (field: string) => void;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
  prefix: string;
}) {
  return fields.map(([field, label, step]) => (
    <DraftInput
      disabled={disabled}
      max={field === "erpErrorRate" ? erpErrorRateMax : undefined}
      key={field}
      label={label}
      draft={draft}
      field={field}
      onUpdate={onUpdateDraft}
      onBlur={onBlur}
      error={errors[field as string]}
      prefix={prefix}
      step={step}
    />
  ));
}

const inventoryFields: ReadonlyArray<[keyof RunConfigDraft, string, string?]> = [
  ["startingStock", "Starting stock"],
];
const workerFields: ReadonlyArray<[keyof RunConfigDraft, string, string?]> = [
  ["orderProcessConcurrency", "Worker concurrency"],
];
const erpFields: ReadonlyArray<[keyof RunConfigDraft, string, string?]> = [
  ["erpLatencyMs", "ERP latency ms"],
  ["erpMaxTps", "ERP max TPS"],
  ["erpErrorRate", "ERP error rate", "0.01"],
];

export function AdminErpDiagnosticsView({
  controlsDisabledReason,
  errorRate,
  erpChaos,
  fieldErrors,
  formErrors,
  forcedOutage,
  isPending,
  latencyMs,
  latestErpChaosRead,
  maxTps,
  notice,
  onBlurField,
  onApply,
  onErrorRateChange,
  onForcedOutageChange,
  onLatencyMsChange,
  onMaxTpsChange,
  onReset,
  runErpConfig,
  showValidationSummary,
  validationSummaryRevision,
}: {
  controlsDisabledReason?: string | undefined;
  errorRate: string;
  erpChaos: BackendRead<ErpChaosStatus>;
  fieldErrors: Record<string, DraftFieldError>;
  formErrors: DraftFormError[];
  forcedOutage: boolean;
  isPending: boolean;
  latencyMs: string;
  latestErpChaosRead?: BackendRead<ErpChaosStatus>;
  maxTps: string;
  notice: AdminNotice | null;
  onBlurField: (field: string) => void;
  onApply: () => void;
  onErrorRateChange: (value: string) => void;
  onForcedOutageChange: (value: boolean) => void;
  onLatencyMsChange: (value: string) => void;
  onMaxTpsChange: (value: string) => void;
  onReset: () => void;
  runErpConfig?: AcceptedRunConfigSnapshot["erpConfig"] | undefined;
  showValidationSummary: boolean;
  validationSummaryRevision: number;
}) {
  const controlsDisabledReasonId = useId();
  const current = erpChaos.status === "available" ? erpChaos.data : null;
  const caps = current?.effectiveSafetyCaps;
  const latestRead = latestErpChaosRead ?? erpChaos;
  return (
    <section className={`${panelClassName} lg:col-span-2`} id="erp-fault-injection">
      <PanelHeading
        eyebrow="Global fallback scope"
        title="ERP fault injection (global fallback)"
        hint={adminFieldHints.erpFallback}
        status={
          <StatusPill
            status={{
              label: current
                ? `forced outage ${current.forcedOutage ? "on" : "off"}`
                : "forced outage unavailable",
              tone: "idle",
            }}
          />
        }
      />
      <p className="m-0 mb-4 max-w-[72ch] text-sm leading-6 text-muted">
        Runs use the ERP settings frozen when they start. These controls change fallback behaviour
        for calls that carry no run settings; they do not change an accepted run.
      </p>
      <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3 max-[560px]:grid-cols-1">
        <ConfigGroup
          title="Accepted run snapshot (per-run)"
          hint="The ERP settings frozen into the active run. These are what the running run's orders actually use."
        >
          {runErpConfig ? (
            <>
              <FieldRow label="Latency ms" value={runErpConfig.latencyMs} />
              <FieldRow label="Max TPS" value={runErpConfig.maxTps} />
              <FieldRow label="Error rate" value={`${ratioToPercent(runErpConfig.errorRate)}%`} />
              <FieldRow label="Forced outage" value={runErpConfig.forcedOutage ? "on" : "off"} />
            </>
          ) : (
            <FieldRow label="Current run" value="none" />
          )}
        </ConfigGroup>
        <ConfigGroup
          title="Configured global fallback"
          hint="The ERP service's own values, used for calls without run settings. Reset to deployment defaults when the Mock ERP restarts."
        >
          <FieldRow label="Latency ms" value={current?.latencyMs ?? "unavailable"} />
          <FieldRow label="Max TPS" value={current?.maxTps ?? "unavailable"} />
          <FieldRow
            label="Error rate"
            value={current ? `${ratioToPercent(current.errorRate)}%` : "unavailable"}
          />
          <FieldRow
            label="Forced outage"
            value={current ? (current.forcedOutage ? "on" : "off") : "unavailable"}
          />
        </ConfigGroup>
      </div>
      {showValidationSummary ? (
        <ValidationSummary
          errors={fieldErrors}
          formErrors={formErrors}
          key={validationSummaryRevision}
          prefix="erp-chaos"
        />
      ) : null}
      <div className={fieldGridClassName}>
        <LabeledTextInput
          error={fieldErrors.latencyMs}
          help={
            caps
              ? `Unit: milliseconds. Minimum: ${nonnegativeNumberMinimum}. Maximum: ${caps.maxLatencyMs}.`
              : undefined
          }
          hint={adminFieldHints.fallbackLatency}
          id="erp-chaos-latencyMs"
          inputMode="numeric"
          label="Latency ms"
          name="latencyMs"
          onChange={onLatencyMsChange}
          onBlur={() => onBlurField("latencyMs")}
          type="text"
          value={latencyMs}
        />
        <LabeledTextInput
          error={fieldErrors.maxTps}
          help={caps ? `Unit: calls/second. Minimum: ${caps.minMaxTps}.` : undefined}
          hint={adminFieldHints.fallbackCapacity}
          id="erp-chaos-maxTps"
          inputMode="numeric"
          label="Max TPS"
          name="maxTps"
          onChange={onMaxTpsChange}
          onBlur={() => onBlurField("maxTps")}
          type="text"
          value={maxTps}
        />
        <LabeledTextInput
          error={fieldErrors.errorRate}
          help={
            caps
              ? `Unit: percent. Minimum: 0. Maximum: ${ratioToPercent(caps.maxErrorRate)}. Enter 25 for 25%.`
              : undefined
          }
          hint={adminFieldHints.fallbackErrorRate}
          id="erp-chaos-errorRate"
          inputMode="decimal"
          label="Error rate"
          name="errorRate"
          onChange={onErrorRateChange}
          onBlur={() => onBlurField("errorRate")}
          type="text"
          value={errorRate}
        />
        <Checkbox
          label="Forced outage"
          hint="Makes the simulated ERP refuse every call that uses the fallback settings."
          id="erp-chaos-forcedOutage"
          checked={forcedOutage}
          error={fieldErrors.forcedOutage}
          onChange={onForcedOutageChange}
        />
      </div>
      <div className="mt-4">
        <p className="m-0 mb-2 text-xs leading-5 text-muted">
          Reset ERP controls restores the process's initial fallback configuration, not a clean
          healthy preset.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            aria-describedby={controlsDisabledReason ? controlsDisabledReasonId : undefined}
            className={buttonClassName}
            disabled={isPending || erpChaos.status !== "available"}
            onClick={onApply}
            type="button"
          >
            Apply ERP controls
          </button>
          <button
            aria-describedby={controlsDisabledReason ? controlsDisabledReasonId : undefined}
            className={buttonClassName}
            disabled={isPending || erpChaos.status !== "available"}
            onClick={onReset}
            type="button"
          >
            Reset ERP controls
          </button>
        </div>
        {controlsDisabledReason ? (
          <p className={reasonClassName} id={controlsDisabledReasonId}>
            {controlsDisabledReason}
          </p>
        ) : null}
      </div>
      {erpChaos.status === "unavailable" ? <Unavailable read={erpChaos} /> : null}
      {erpChaos.status === "available" && latestRead.status === "unavailable" ? (
        <Unavailable read={latestRead} />
      ) : null}
      <AdminNoticeView notice={notice} />
    </section>
  );
}

export function EffectiveChangeList({
  changes,
}: {
  changes: ReadonlyArray<{ label: string; oldValue: ReactNode; proposedValue: ReactNode }>;
}) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0">
      {changes.map((change) => (
        <li
          className="grid grid-cols-[minmax(8rem,1fr)_minmax(4rem,1fr)_auto_minmax(4rem,1fr)] gap-2"
          key={change.label}
        >
          <span className="font-semibold text-ink">{change.label}</span>
          <span>
            <span className="sr-only">Old value: </span>
            {change.oldValue}
          </span>
          <span aria-hidden="true">→</span>
          <span>
            <span className="sr-only">Proposed value: </span>
            {change.proposedValue}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DraftInput<T extends object>({
  draft,
  disabled,
  error,
  field,
  hint,
  label,
  max,
  onBlur,
  onUpdate,
  prefix,
  step,
  type = "number",
}: {
  draft: T;
  disabled?: boolean | undefined;
  error?: DraftFieldError | undefined;
  field: keyof T;
  hint?: string | undefined;
  label: string;
  max?: number | undefined;
  onBlur?: ((field: string) => void) | undefined;
  onUpdate: (next: Partial<T>) => void;
  prefix?: string | undefined;
  step?: string | undefined;
  type?: "number" | "text";
}) {
  const bounds = type === "number" ? intrinsicInputBounds(String(field)) : {};
  return (
    <LabeledTextInput
      disabled={disabled}
      error={error}
      help={
        field === "erpErrorRate" || String(field) === "maxErpErrorRate"
          ? `Unit: percent. Minimum: 0. Maximum: ${max ?? 100}. Enter 25 for 25%.`
          : max === undefined
            ? bounds.help
            : `${bounds.help ?? ""} Maximum: ${max}.`.trim()
      }
      hint={hint ?? adminDraftFieldHints[String(field)]}
      id={prefix ? `${prefix}-${String(field)}` : undefined}
      inputMode={type === "number" ? (step ? "decimal" : "numeric") : undefined}
      label={label}
      name={String(field)}
      onChange={(value) => onUpdate({ [field]: value } as Partial<T>)}
      onBlur={() => onBlur?.(String(field))}
      type="text"
      value={String(draft[field])}
    />
  );
}

function intrinsicInputBounds(field: string): {
  help?: string;
} {
  if (field === "sortOrder") return { help: "Whole number." };
  if (field.includes("ErrorRate") || field === "erpErrorRate")
    return { help: "Unit: percent. Minimum: 0." };
  const unit =
    field === "maxRequestsPerSecond" || field === "ratePerSecond"
      ? "requests/second"
      : field.includes("Starts")
        ? "starts"
        : field.includes("Seconds") || field.includes("seconds") || field === "budgetWindowSeconds"
          ? "seconds"
          : field.includes("Latency") || field === "erpLatencyMs"
            ? "milliseconds"
            : field.includes("Tps") || field.includes("TPS")
              ? "calls/second"
              : field.includes("Vus") || field.includes("VUs")
                ? "virtual users"
                : field.includes("Stock") || field === "startingStock"
                  ? "units"
                  : field.includes("Buyer") || field === "buyerCount"
                    ? "buyers"
                    : field === "maxTotalRequests"
                      ? "requests"
                      : field.includes("Concurrency")
                        ? "orders"
                        : "items";
  const minimum = [
    "startingStock",
    "startDelaySeconds",
    "maxTrafficStartDelaySeconds",
    "erpLatencyMs",
    "maxErpLatencyMs",
  ].includes(field)
    ? 0
    : positiveIntegerMinimum;
  if (
    field === "startingStock" ||
    field === "startDelaySeconds" ||
    field === "maxTrafficStartDelaySeconds" ||
    field === "erpLatencyMs" ||
    field === "maxErpLatencyMs"
  ) {
    return { help: `Unit: ${unit}. Minimum: ${nonnegativeNumberMinimum}.` };
  }
  if (field === "orderProcessConcurrency") {
    return {
      help: `Unit: ${unit}. Minimum: ${formatCount(positiveIntegerMinimum)}. Maximum: ${formatCount(orderProcessConcurrencyHardCap)}.`,
    };
  }
  return {
    help: `Unit: ${unit}. Minimum: ${minimum}.`,
  };
}

function Checkbox({
  alignWithInputs = true,
  checked,
  disabled,
  error,
  id,
  label,
  hint,
  onChange,
}: {
  alignWithInputs?: boolean;
  checked: boolean;
  disabled?: boolean | undefined;
  error?: DraftFieldError | undefined;
  id?: string;
  label: string;
  hint?: string | undefined;
  onChange: (value: boolean) => void;
}) {
  // Beside inputs, skip the label row so the box centres on the neighbouring input.
  return (
    <div className={`grid content-start gap-1 ${alignWithInputs ? "min-[561px]:pt-7" : ""}`}>
      <div className="flex min-h-11 items-center gap-2 text-sm font-semibold text-ink">
        <label className="flex items-center gap-2">
          <input
            aria-describedby={error && id ? `${id}-error` : undefined}
            aria-invalid={error ? true : undefined}
            checked={checked}
            disabled={disabled}
            id={id}
            onChange={(event) => onChange(event.target.checked)}
            type="checkbox"
          />
          {label}
        </label>
        {hint ? <FieldHint label={label} text={hint} /> : null}
      </div>
      {error && id ? (
        <span className="text-xs font-semibold text-danger" id={`${id}-error`}>
          {error.message}
        </span>
      ) : null}
    </div>
  );
}

function PanelHeading({
  eyebrow,
  hint,
  status,
  title,
}: {
  eyebrow: string;
  hint?: string;
  status?: React.ReactNode;
  title: string;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <p className={eyebrowClassName}>{eyebrow}</p>
        <h2 className={panelTitleClassName}>
          {title}
          {hint ? <FieldHint label={title} text={hint} /> : null}
        </h2>
      </div>
      <div className="shrink-0 whitespace-nowrap">{status}</div>
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 [overflow-wrap:anywhere] text-sm font-semibold text-ink">
        {value}
      </dd>
    </div>
  );
}

export function Unavailable({ read }: { read: BackendRead<unknown> }) {
  return <ErrorNotice className="mt-3" context="admin-read" protectedDetails read={read} />;
}

function LabeledTextInput({
  disabled,
  error,
  help,
  hint,
  id,
  inputMode,
  label,
  name,
  onChange,
  onBlur,
  type = "text",
  value,
}: {
  label: string;
  disabled?: boolean | undefined;
  error?: DraftFieldError | undefined;
  help?: string | undefined;
  hint?: string | undefined;
  id?: string | undefined;
  inputMode?: "decimal" | "numeric" | undefined;
  name?: string | undefined;
  onChange: (next: string) => void;
  onBlur?: (() => void) | undefined;
  type?: "number" | "password" | "text";
  value: string;
}) {
  const controlId = id ?? name;
  return (
    <div className="grid min-w-0 content-start gap-1">
      <div className="flex min-h-6 items-center gap-1.5">
        <label className={fieldLabelClassName} htmlFor={controlId}>
          {label}
        </label>
        {hint ? <FieldHint label={label} text={hint} /> : null}
      </div>
      <input
        aria-describedby={
          [
            help && controlId ? `${controlId}-help` : "",
            error && controlId ? `${controlId}-error` : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={error ? true : undefined}
        className={inputClassName}
        disabled={disabled}
        id={controlId}
        inputMode={inputMode}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        type={type}
        value={value}
      />
      {help && controlId ? (
        <span className={fieldHelpClassName} id={`${controlId}-help`}>
          {help}
        </span>
      ) : null}
      {error && controlId ? (
        <span className="text-xs font-semibold text-danger" id={`${controlId}-error`}>
          {error.message}
        </span>
      ) : null}
    </div>
  );
}

function ValidationSummary({
  errors,
  formErrors,
  prefix,
}: {
  errors: Record<string, DraftFieldError>;
  formErrors: DraftFormError[];
  prefix: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const entries = Object.entries(errors);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  if (entries.length === 0 && formErrors.length === 0) return null;
  return (
    <div
      className="rounded-lg border border-danger-line bg-danger-soft p-3 text-sm text-danger"
      ref={ref}
      tabIndex={-1}
    >
      <p className="m-0 font-bold">Correct the highlighted fields.</p>
      <ul className="mb-0 mt-2 pl-5 [&_a]:font-semibold [&_a]:underline">
        {entries.map(([field, error]) => (
          <li key={field}>
            <a href={`#${prefix}-${field}`}>{error.message}</a>
          </li>
        ))}
        {formErrors.map((error) => (
          <li key={`${error.message}-${error.fields.join("-")}`}>
            {error.message}{" "}
            {error.fields.map((field, index) => (
              <span key={field}>
                {index ? ", " : ""}
                <a href={`#${prefix}-${field}`}>{fieldLabel(field)}</a>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

const fieldLabels: Record<string, string> = {
  allowBuyerSpike: "Allow buyer spike",
  allowConstantArrivalRate: "Allow constant arrival",
  allowForcedOutage: "Allow forced outage",
  buyerCount: "Buyer count",
  duplicateEachBuyerAttempt: "Duplicate attempts",
  durationSeconds: "Duration",
  erpErrorRate: "ERP error rate",
  erpForcedOutage: "ERP forced outage",
  erpLatencyMs: "ERP latency",
  erpMaxTps: "ERP maximum TPS",
  maxBuyers: "Maximum buyers",
  maxDurationSeconds: "Maximum duration",
  maxErpErrorRate: "Maximum ERP error rate",
  maxErpLatencyMs: "Maximum ERP latency",
  maxErpMaxTps: "Maximum ERP TPS",
  maxPreAllocatedVus: "Maximum preallocated VUs",
  maxPublicVus: "Maximum public VUs",
  maxRequestsPerSecond: "Maximum requests per second",
  maxStartingStock: "Maximum starting stock",
  maxTotalRequests: "Maximum total requests",
  maxTrafficDurationSeconds: "Maximum traffic duration",
  maxTrafficStartDelaySeconds: "Maximum start delay",
  maxVus: "Maximum VUs",
  minErpMaxTps: "Minimum ERP TPS",
  mode: "Traffic mode",
  preAllocatedVus: "Preallocated VUs",
  ratePerSecond: "Requests per second",
  startDelaySeconds: "Start delay",
  startingStock: "Starting stock",
};

function fieldLabel(field: string): string {
  return fieldLabels[field] ?? field;
}

export function currentRunStatus(
  recovery: BackendRead<{ currentRun: { status: string } | null }>,
): string {
  return recovery.status === "available"
    ? (recovery.data.currentRun?.status ?? "idle")
    : "unavailable";
}
