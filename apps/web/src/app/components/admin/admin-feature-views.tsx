"use client";

import {
  type AdminPresetListItem,
  type AdminPublicRuntimePolicyResponse,
  type DeploymentHardCaps,
  type ErpChaosStatus,
  nonnegativeNumberMinimum,
  orderProcessConcurrencyHardCap,
  percentageMaximum,
  percentageMinimum,
  positiveIntegerMinimum,
} from "@checkout-surge/contracts";
import { useEffect, useRef } from "react";
import type {
  DraftFieldError,
  DraftFormError,
  PresetDraft,
  RunConfigDraft,
  RuntimePolicyDraft,
} from "../../lib/admin-drafts";
import type { BackendRead } from "../../lib/api";
import type { AdminNotice } from "../../lib/presentation/admin-notice";
import { formatCount } from "../../lib/presentation/format";
import { ErrorNotice } from "../error-notice";
import { StatusPill } from "../status-pill";
import { AdminNoticeView } from "./admin-notice";

export const panelClassName =
  "min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full";
export const buttonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";
export const primaryButtonClassName =
  "min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";
const inputClassName = "min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink";

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
    <section className={`${panelClassName} col-span-8`}>
      <PanelHeading
        eyebrow="Public policy"
        title="Runtime budgets and custom limits"
        status={
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
        }
      />
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
          <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
            <Checkbox
              label="Enforce public budget"
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
          <div className="grid gap-3">
            <p className="m-0 text-xs font-bold uppercase text-muted">Public custom defaults</p>
            <TrafficEditor
              draft={draft}
              errors={fieldErrors}
              hardCaps={policy.deploymentHardCaps}
              onBlur={onBlurField}
              onUpdateDraft={onUpdateDraft}
              prefix="runtime-policy"
            />
            <RunConfigFields
              draft={draft}
              errors={fieldErrors}
              includeForcedOutage={false}
              onBlur={onBlurField}
              onUpdateDraft={onUpdateDraft}
              prefix="runtime-policy"
            />
          </div>
          <div className="grid gap-3">
            <p className="m-0 text-xs font-bold uppercase text-muted">Public custom limits</p>
            <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
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
              <Checkbox
                label="Buyer spike"
                id="runtime-policy-allowBuyerSpike"
                checked={draft.allowBuyerSpike}
                error={fieldErrors.allowBuyerSpike}
                onChange={(value) => onUpdateDraft({ allowBuyerSpike: value })}
              />
              <Checkbox
                label="Constant arrival"
                id="runtime-policy-allowConstantArrivalRate"
                checked={draft.allowConstantArrivalRate}
                error={fieldErrors.allowConstantArrivalRate}
                onChange={(value) => onUpdateDraft({ allowConstantArrivalRate: value })}
              />
            </div>
          </div>
          <dl className="m-0 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
            <Fact label="Hard max buyers" value={formatCap(policy.deploymentHardCaps.maxBuyers)} />
            <Fact
              label="Hard max requests"
              value={formatCap(policy.deploymentHardCaps.maxTotalRequests)}
            />
            <Fact
              label="Hard max RPS"
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
              label="Hard max preallocated VUs"
              value={formatCap(policy.deploymentHardCaps.maxPreAllocatedVus)}
            />
            <Fact label="Hard max VUs" value={formatCap(policy.deploymentHardCaps.maxVus)} />
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
  fieldErrors,
  formErrors,
  hardCaps,
  duplicateTargetSlug,
  isPending,
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
  showValidationSummary,
  validationSummaryRevision,
}: {
  draft: PresetDraft | null;
  fieldErrors: Record<string, DraftFieldError>;
  formErrors: DraftFormError[];
  hardCaps?: DeploymentHardCaps | undefined;
  duplicateTargetSlug: string;
  isPending: boolean;
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
  startBlocked: boolean;
  startBlockedReason?: string | undefined;
  showValidationSummary: boolean;
  validationSummaryRevision: number;
}) {
  return (
    <section className={`${panelClassName} col-span-8`}>
      <PanelHeading
        eyebrow="Presets"
        title="Inspection and starts"
        status={<StatusPill status={{ label: `${presets.length} loaded`, tone: "ok" }} />}
      />
      <div className="grid grid-cols-[minmax(180px,260px)_1fr] gap-4 max-[800px]:grid-cols-1">
        <div className="grid content-start gap-2">
          {presets.map((preset) => (
            <button
              className={
                preset.slug === selectedPreset?.slug ? primaryButtonClassName : buttonClassName
              }
              key={preset.slug}
              onClick={() => onSelect(preset.slug)}
              type="button"
            >
              {preset.display.name}
            </button>
          ))}
          {presetsRead.status === "unavailable" ? <Unavailable read={presetsRead} /> : null}
        </div>
        {selectedPreset && draft ? (
          <div className="grid gap-4">
            {showValidationSummary ? (
              <ValidationSummary
                errors={fieldErrors}
                formErrors={formErrors}
                key={validationSummaryRevision}
                prefix="preset"
              />
            ) : null}
            <dl className="m-0 grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
              <Fact label="Slug" value={selectedPreset.slug} />
              <Fact label="Visibility" value={selectedPreset.visibility} />
              <Fact label="Editable" value={selectedPreset.isEditable ? "yes" : "no"} />
              <Fact label="Custom" value={selectedPreset.isCustom ? "yes" : "no"} />
            </dl>
            <div className="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
              <DraftInput
                label="Name"
                draft={draft}
                field="displayName"
                onUpdate={onUpdateDraft}
                onBlur={onBlurField}
                type="text"
                prefix="preset"
              />
              <DraftInput
                label="Description"
                draft={draft}
                field="description"
                onUpdate={onUpdateDraft}
                onBlur={onBlurField}
                type="text"
                prefix="preset"
              />
              <DraftInput
                label="Sort order"
                draft={draft}
                field="sortOrder"
                onUpdate={onUpdateDraft}
                onBlur={onBlurField}
                error={fieldErrors.sortOrder}
                prefix="preset"
              />
            </div>
            <TrafficEditor
              draft={draft}
              errors={fieldErrors}
              hardCaps={hardCaps}
              onBlur={onBlurField}
              onUpdateDraft={onUpdateDraft}
              prefix="preset"
            />
            <RunConfigFields
              draft={draft}
              errors={fieldErrors}
              onBlur={onBlurField}
              onUpdateDraft={onUpdateDraft}
              prefix="preset"
            />
            <div className="flex flex-wrap gap-2">
              <button
                className={primaryButtonClassName}
                disabled={isPending || startBlocked}
                onClick={onStart}
                type="button"
              >
                Start admin run
              </button>
              <button
                className={buttonClassName}
                disabled={
                  isPending || !(selectedPreset.visibility === "admin" && selectedPreset.isEditable)
                }
                onClick={onSave}
                type="button"
              >
                Save preset
              </button>
              <button
                className={buttonClassName}
                disabled={isPending || selectedPreset.slug === "public-custom"}
                onClick={onCopyToCustom}
                type="button"
              >
                Copy to custom
              </button>
              <button
                className={buttonClassName}
                disabled={isPending || !selectedPreset.canArchive}
                onClick={onArchive}
                type="button"
              >
                Archive preset
              </button>
            </div>
            {startBlockedReason ? (
              <p className="m-0 text-sm text-muted">{startBlockedReason}</p>
            ) : null}
            <form
              className="grid grid-cols-[minmax(160px,1fr)_auto] gap-2 max-[560px]:grid-cols-1"
              onSubmit={(event) => {
                event.preventDefault();
                const targetSlug = String(
                  new FormData(event.currentTarget).get("duplicate-target-slug") ?? "",
                );
                onDuplicate(targetSlug);
              }}
            >
              <LabeledTextInput
                label="Duplicate slug"
                name="duplicate-target-slug"
                onChange={onDuplicateTargetSlugChange}
                value={duplicateTargetSlug}
              />
              <button
                className={`${buttonClassName} self-end`}
                disabled={isPending || selectedPreset.slug === "public-custom"}
                type="submit"
              >
                Duplicate
              </button>
            </form>
          </div>
        ) : (
          <p className="m-0 text-muted">No admin presets are available.</p>
        )}
      </div>
      <AdminNoticeView notice={notice} />
      {notice === "Admin run accepted." ? (
        <a className={`${buttonClassName} mt-4 inline-flex items-center`} href="/watch">
          Watch live
        </a>
      ) : null}
      <AdminNoticeView notice={syncNotice} />
    </section>
  );
}

function TrafficEditor({
  draft,
  errors,
  hardCaps,
  onBlur,
  onUpdateDraft,
  prefix,
}: {
  draft: RunConfigDraft;
  errors: Record<string, DraftFieldError>;
  hardCaps?: DeploymentHardCaps | undefined;
  onBlur: (field: string) => void;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
  prefix: string;
}) {
  return (
    <div className="grid gap-3">
      <fieldset
        aria-describedby={errors.mode ? `${prefix}-mode-error` : undefined}
        aria-invalid={errors.mode ? true : undefined}
        className="m-0 flex flex-wrap gap-2 border-0 p-0"
        id={`${prefix}-mode`}
        tabIndex={-1}
      >
        <legend className="sr-only">Traffic mode</legend>
        {(["buyer-spike", "constant-arrival-rate"] as const).map((mode) => (
          <button
            className={draft.mode === mode ? primaryButtonClassName : buttonClassName}
            key={mode}
            onClick={() => onUpdateDraft({ mode })}
            type="button"
          >
            {mode}
          </button>
        ))}
      </fieldset>
      {errors.mode ? (
        <span className="text-xs font-semibold text-danger" id={`${prefix}-mode-error`}>
          {errors.mode.message}
        </span>
      ) : null}
      <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
        {draft.mode === "buyer-spike" ? (
          <>
            <DraftInput
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
              id={`${prefix}-duplicateEachBuyerAttempt`}
              checked={draft.duplicateEachBuyerAttempt}
              error={errors.duplicateEachBuyerAttempt}
              onChange={(value) => onUpdateDraft({ duplicateEachBuyerAttempt: value })}
            />
          </>
        ) : (
          <>
            <DraftInput
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
  errors,
  includeForcedOutage = true,
  onBlur,
  onUpdateDraft,
  prefix,
}: {
  draft: RunConfigDraft;
  errors: Record<string, DraftFieldError>;
  includeForcedOutage?: boolean;
  onBlur: (field: string) => void;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
  prefix: string;
}) {
  return (
    <>
      <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
        {runConfigFields.slice(0, 8).map(([field, label]) => (
          <DraftInput
            key={field}
            label={label}
            draft={draft}
            field={field}
            onUpdate={onUpdateDraft}
            onBlur={onBlur}
            error={errors[field as string]}
            prefix={prefix}
          />
        ))}
      </div>
      <div className="grid grid-cols-5 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
        {runConfigFields.slice(8).map(([field, label, step]) => (
          <DraftInput
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
        ))}
        {includeForcedOutage ? (
          <Checkbox
            label="ERP forced outage"
            id={`${prefix}-erpForcedOutage`}
            checked={draft.erpForcedOutage}
            error={errors.erpForcedOutage}
            onChange={(value) => onUpdateDraft({ erpForcedOutage: value })}
          />
        ) : null}
      </div>
    </>
  );
}

const runConfigFields: ReadonlyArray<[keyof RunConfigDraft, string, string?]> = [
  ["startingStock", "Starting stock"],
  ["quantityPerCheckout", "Quantity per checkout"],
  ["reservationHoldMinutes", "Hold minutes"],
  ["orderProcessConcurrency", "Worker concurrency"],
  ["drainTimeoutSeconds", "Drain timeout seconds"],
  ["pendingPersistenceRetryAfterSeconds", "Persistence retry seconds"],
  ["circuitBreakerFailureThreshold", "Circuit failure threshold"],
  ["circuitBreakerResetTimeoutMs", "Circuit reset timeout ms"],
  ["erpLatencyMs", "ERP latency ms"],
  ["erpMaxTps", "ERP max TPS"],
  ["erpErrorRate", "ERP error rate", "0.01"],
  ["erpRequestTimeoutMs", "ERP timeout ms"],
];

export function AdminErpDiagnosticsView({
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
  showValidationSummary,
  validationSummaryRevision,
}: {
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
  showValidationSummary: boolean;
  validationSummaryRevision: number;
}) {
  const current = erpChaos.status === "available" ? erpChaos.data : null;
  const caps = current?.effectiveSafetyCaps;
  const latestRead = latestErpChaosRead ?? erpChaos;
  return (
    <section className={`${panelClassName} col-span-6`}>
      <PanelHeading
        eyebrow="ERP diagnostics"
        title="Global chaos controls"
        status={
          <StatusPill
            status={{ label: current?.forcedOutage ? "outage" : "ready", tone: "idle" }}
          />
        }
      />
      {showValidationSummary ? (
        <ValidationSummary
          errors={fieldErrors}
          formErrors={formErrors}
          key={validationSummaryRevision}
          prefix="erp-chaos"
        />
      ) : null}
      <div className="grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
        <LabeledTextInput
          error={fieldErrors.latencyMs}
          help={
            caps
              ? `Allowed range: ${nonnegativeNumberMinimum}–${caps.maxLatencyMs} milliseconds.`
              : undefined
          }
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
          help={caps ? `Minimum: ${caps.minMaxTps} transactions per second.` : undefined}
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
          help={caps ? `Allowed range: ${percentageMinimum}–${caps.maxErrorRate}.` : undefined}
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
          id="erp-chaos-forcedOutage"
          checked={forcedOutage}
          error={fieldErrors.forcedOutage}
          onChange={onForcedOutageChange}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className={buttonClassName}
          disabled={isPending || erpChaos.status !== "available"}
          onClick={onApply}
          type="button"
        >
          Apply ERP controls
        </button>
        <button className={buttonClassName} disabled={isPending} onClick={onReset} type="button">
          Reset ERP controls
        </button>
      </div>
      {erpChaos.status === "unavailable" ? <Unavailable read={erpChaos} /> : null}
      {erpChaos.status === "available" && latestRead.status === "unavailable" ? (
        <Unavailable read={latestRead} />
      ) : null}
      <AdminNoticeView notice={notice} />
    </section>
  );
}

function DraftInput<T extends object>({
  draft,
  error,
  field,
  label,
  max,
  onBlur,
  onUpdate,
  prefix,
  step,
  type = "number",
}: {
  draft: T;
  error?: DraftFieldError | undefined;
  field: keyof T;
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
      error={error}
      help={max === undefined ? bounds.help : `${bounds.help ?? ""} Maximum: ${max}.`.trim()}
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
  if (field.includes("ErrorRate") || field === "erpErrorRate") {
    return {
      help: `Allowed range: ${percentageMinimum}–${percentageMaximum}.`,
    };
  }
  if (
    field === "startingStock" ||
    field === "startDelaySeconds" ||
    field === "maxTrafficStartDelaySeconds" ||
    field === "erpLatencyMs" ||
    field === "maxErpLatencyMs"
  ) {
    return {
      help: `Minimum: ${nonnegativeNumberMinimum}.`,
    };
  }
  if (field === "orderProcessConcurrency") {
    return {
      help: `Allowed range: ${positiveIntegerMinimum}–${orderProcessConcurrencyHardCap}.`,
    };
  }
  return {
    help: `Minimum: ${positiveIntegerMinimum}.`,
  };
}

function Checkbox({
  checked,
  error,
  id,
  label,
  onChange,
}: {
  checked: boolean;
  error?: DraftFieldError | undefined;
  id?: string;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="grid gap-1">
      <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
        <input
          aria-describedby={error && id ? `${id}-error` : undefined}
          aria-invalid={error ? true : undefined}
          checked={checked}
          id={id}
          onChange={(event) => onChange(event.target.checked)}
          type="checkbox"
        />
        {label}
      </label>
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
  status,
  title,
}: {
  eyebrow: string;
  status?: React.ReactNode;
  title: string;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <p className="m-0 text-xs font-bold uppercase text-muted">{eyebrow}</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">{title}</h2>
      </div>
      {status}
    </div>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

export function Unavailable({ read }: { read: BackendRead<unknown> }) {
  return <ErrorNotice className="mt-3" context="admin-read" protectedDetails read={read} />;
}

function LabeledTextInput({
  error,
  help,
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
  error?: DraftFieldError | undefined;
  help?: string | undefined;
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
    <div className="grid gap-1 text-sm font-semibold text-muted-strong">
      <label htmlFor={controlId}>{label}</label>
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
        id={controlId}
        inputMode={inputMode}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        type={type}
        value={value}
      />
      {help && controlId ? (
        <span className="text-xs font-normal text-muted" id={`${controlId}-help`}>
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
    <div className="rounded border border-danger p-3 text-sm" ref={ref} tabIndex={-1}>
      <p className="m-0 font-bold">Correct the highlighted fields.</p>
      <ul className="mb-0 mt-2">
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
