"use client";

import type {
  AdminPresetListItem,
  AdminPublicRuntimePolicyResponse,
  ErpChaosStatus,
} from "@checkout-surge/contracts";
import type { PresetDraft, RunConfigDraft, RuntimePolicyDraft } from "../../lib/admin-drafts";
import type { BackendRead } from "../../lib/api";
import { StatusPill } from "../status-pill";

export const panelClassName =
  "min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full";
export const buttonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";
export const primaryButtonClassName =
  "min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";
const inputClassName = "min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink";

export function AdminRuntimePolicyView({
  draft,
  isPending,
  notice,
  onRefresh,
  onSave,
  onUpdateDraft,
  runtimePolicy,
}: {
  draft: RuntimePolicyDraft | null;
  isPending: boolean;
  notice: string | null;
  onRefresh: () => void;
  onSave: () => void;
  onUpdateDraft: (next: Partial<RuntimePolicyDraft>) => void;
  runtimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
}) {
  const policy = runtimePolicy.status === "available" ? runtimePolicy.data.policy : null;
  return (
    <section className={`${panelClassName} col-span-8`}>
      <PanelHeading
        eyebrow="Public policy"
        title="Runtime budgets and custom limits"
        status={
          <StatusPill
            label={draft?.isPublicRunBudgetEnforced ? "budgeted" : "open"}
            tone={policy ? "ok" : "pending"}
          />
        }
      />
      {policy && draft ? (
        <div className="grid gap-4">
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
            />
            <DraftInput
              label="Per-visitor starts"
              draft={draft}
              field="perVisitorMaxStarts"
              onUpdate={onUpdateDraft}
            />
            <DraftInput
              label="Global starts"
              draft={draft}
              field="globalMaxStarts"
              onUpdate={onUpdateDraft}
            />
          </div>
          <div className="grid gap-3">
            <p className="m-0 text-xs font-bold uppercase text-muted">Public custom defaults</p>
            <TrafficEditor draft={draft} onUpdateDraft={onUpdateDraft} />
            <RunConfigFields draft={draft} onUpdateDraft={onUpdateDraft} />
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
                  step={step}
                />
              ))}
              <Checkbox
                label="Buyer spike"
                checked={draft.allowBuyerSpike}
                onChange={(value) => onUpdateDraft({ allowBuyerSpike: value })}
              />
              <Checkbox
                label="Constant arrival"
                checked={draft.allowConstantArrivalRate}
                onChange={(value) => onUpdateDraft({ allowConstantArrivalRate: value })}
              />
              <Checkbox
                label="Allow forced outage"
                checked={draft.allowForcedOutage}
                onChange={(value) => onUpdateDraft({ allowForcedOutage: value })}
              />
            </div>
          </div>
          <dl className="m-0 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2">
            <Fact label="Hard max buyers" value={String(policy.deploymentHardCaps.maxBuyers)} />
            <Fact
              label="Hard max requests"
              value={String(policy.deploymentHardCaps.maxTotalRequests)}
            />
            <Fact
              label="Hard max RPS"
              value={String(policy.deploymentHardCaps.maxRequestsPerSecond)}
            />
            <Fact
              label="Hard max duration"
              value={`${policy.deploymentHardCaps.maxTrafficDurationSeconds}s`}
            />
          </dl>
          <div className="flex flex-wrap gap-2">
            <button
              className={primaryButtonClassName}
              disabled={isPending}
              onClick={onSave}
              type="button"
            >
              Save Public Policy
            </button>
            <button
              className={buttonClassName}
              disabled={isPending}
              onClick={onRefresh}
              type="button"
            >
              Refresh Policy
            </button>
          </div>
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
            Refresh Policy
          </button>
        </div>
      )}
      {notice ? <Notice>{notice}</Notice> : null}
    </section>
  );
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
  duplicateTargetSlug,
  isPending,
  notice,
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
}: {
  draft: PresetDraft | null;
  duplicateTargetSlug: string;
  isPending: boolean;
  notice: string | null;
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
}) {
  return (
    <section className={`${panelClassName} col-span-8`}>
      <PanelHeading
        eyebrow="Presets"
        title="Inspection and starts"
        status={<StatusPill label={`${presets.length} loaded`} tone="ok" />}
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
                type="text"
              />
              <DraftInput
                label="Description"
                draft={draft}
                field="description"
                onUpdate={onUpdateDraft}
                type="text"
              />
              <DraftInput
                label="Sort order"
                draft={draft}
                field="sortOrder"
                onUpdate={onUpdateDraft}
              />
            </div>
            <TrafficEditor draft={draft} onUpdateDraft={onUpdateDraft} />
            <RunConfigFields draft={draft} onUpdateDraft={onUpdateDraft} />
            <div className="flex flex-wrap gap-2">
              <button
                className={primaryButtonClassName}
                disabled={isPending || startBlocked}
                onClick={onStart}
                type="button"
              >
                Start Admin Run
              </button>
              <button
                className={buttonClassName}
                disabled={
                  isPending || !(selectedPreset.visibility === "admin" && selectedPreset.isEditable)
                }
                onClick={onSave}
                type="button"
              >
                Save Preset
              </button>
              <button
                className={buttonClassName}
                disabled={isPending || selectedPreset.slug === "public-custom"}
                onClick={onCopyToCustom}
                type="button"
              >
                Copy to Custom
              </button>
              <button
                className={buttonClassName}
                disabled={isPending || !selectedPreset.canArchive}
                onClick={onArchive}
                type="button"
              >
                Archive Preset
              </button>
            </div>
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
      {notice ? <Notice>{notice}</Notice> : null}
    </section>
  );
}

function TrafficEditor({
  draft,
  onUpdateDraft,
}: {
  draft: RunConfigDraft;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
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
      </div>
      <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
        {draft.mode === "buyer-spike" ? (
          <>
            <DraftInput
              label="Buyer count"
              draft={draft}
              field="buyerCount"
              onUpdate={onUpdateDraft}
            />
            <DraftInput
              label="Max duration seconds"
              draft={draft}
              field="maxDurationSeconds"
              onUpdate={onUpdateDraft}
            />
            <Checkbox
              label="Duplicate attempts"
              checked={draft.duplicateEachBuyerAttempt}
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
            />
            <DraftInput
              label="Duration seconds"
              draft={draft}
              field="durationSeconds"
              onUpdate={onUpdateDraft}
            />
            <DraftInput
              label="Preallocated VUs"
              draft={draft}
              field="preAllocatedVus"
              onUpdate={onUpdateDraft}
            />
            <DraftInput label="Max VUs" draft={draft} field="maxVus" onUpdate={onUpdateDraft} />
          </>
        )}
        <DraftInput
          label="Start delay seconds"
          draft={draft}
          field="startDelaySeconds"
          onUpdate={onUpdateDraft}
        />
      </div>
    </div>
  );
}

function RunConfigFields({
  draft,
  onUpdateDraft,
}: {
  draft: RunConfigDraft;
  onUpdateDraft: (next: Partial<RunConfigDraft>) => void;
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
            step={step}
          />
        ))}
        <Checkbox
          label="ERP forced outage"
          checked={draft.erpForcedOutage}
          onChange={(value) => onUpdateDraft({ erpForcedOutage: value })}
        />
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
  forcedOutage,
  isPending,
  latencyMs,
  maxTps,
  notice,
  onApply,
  onErrorRateChange,
  onForcedOutageChange,
  onLatencyMsChange,
  onMaxTpsChange,
  onReset,
}: {
  errorRate: string;
  erpChaos: BackendRead<ErpChaosStatus>;
  forcedOutage: boolean;
  isPending: boolean;
  latencyMs: string;
  maxTps: string;
  notice: string | null;
  onApply: () => void;
  onErrorRateChange: (value: string) => void;
  onForcedOutageChange: (value: boolean) => void;
  onLatencyMsChange: (value: string) => void;
  onMaxTpsChange: (value: string) => void;
  onReset: () => void;
}) {
  const current = erpChaos.status === "available" ? erpChaos.data : null;
  return (
    <section className={`${panelClassName} col-span-6`}>
      <PanelHeading
        eyebrow="ERP diagnostics"
        title="Global chaos controls"
        status={<StatusPill label={current?.forcedOutage ? "outage" : "ready"} tone="idle" />}
      />
      <div className="grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
        <LabeledTextInput
          label="Latency ms"
          onChange={onLatencyMsChange}
          type="number"
          value={latencyMs}
        />
        <LabeledTextInput label="Max TPS" onChange={onMaxTpsChange} type="number" value={maxTps} />
        <LabeledTextInput
          label="Error rate"
          onChange={onErrorRateChange}
          step="0.01"
          type="number"
          value={errorRate}
        />
        <Checkbox label="Forced outage" checked={forcedOutage} onChange={onForcedOutageChange} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button className={buttonClassName} disabled={isPending} onClick={onApply} type="button">
          Apply ERP Controls
        </button>
        <button className={buttonClassName} disabled={isPending} onClick={onReset} type="button">
          Reset ERP Controls
        </button>
      </div>
      {erpChaos.status === "unavailable" ? <Unavailable read={erpChaos} /> : null}
      {notice ? <Notice>{notice}</Notice> : null}
    </section>
  );
}

function DraftInput<T extends object>({
  draft,
  field,
  label,
  onUpdate,
  step,
  type = "number",
}: {
  draft: T;
  field: keyof T;
  label: string;
  onUpdate: (next: Partial<T>) => void;
  step?: string | undefined;
  type?: "number" | "text";
}) {
  return (
    <LabeledTextInput
      label={label}
      onChange={(value) => onUpdate({ [field]: value } as Partial<T>)}
      step={step}
      type={type}
      value={String(draft[field])}
    />
  );
}

function Checkbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
      <input
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      {label}
    </label>
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
  return read.status === "available" ? null : (
    <div className="mt-3 grid gap-1 rounded-lg border border-[#f7b4ad] bg-danger-soft p-3 leading-6 text-danger">
      <strong>Unavailable</strong>
      <span>{read.reason}</span>
      {read.httpStatus ? <span>HTTP {read.httpStatus}</span> : null}
      {read.correlationId ? <span>Correlation {read.correlationId}</span> : null}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="m-0 mt-4 text-sm font-semibold text-muted-strong">{children}</p>;
}

function LabeledTextInput({
  label,
  name,
  onChange,
  step,
  type = "text",
  value,
}: {
  label: string;
  name?: string | undefined;
  onChange: (next: string) => void;
  step?: string | undefined;
  type?: "number" | "password" | "text";
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-muted-strong">
      <span>{label}</span>
      <input
        className={inputClassName}
        name={name}
        onChange={(event) => onChange(event.target.value)}
        step={step}
        type={type}
        value={value}
      />
    </label>
  );
}

export function currentRunStatus(
  recovery: BackendRead<{ currentRun: { status: string } | null }>,
): string {
  return recovery.status === "available"
    ? (recovery.data.currentRun?.status ?? "idle")
    : "unavailable";
}

export function navigateToWatch() {
  if (typeof window !== "undefined") window.location.assign("/watch");
}
