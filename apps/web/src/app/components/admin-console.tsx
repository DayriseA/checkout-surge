"use client";

import {
  type AcceptedRunConfigSnapshot,
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  adminDemoResetResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  adminPresetListResponseSchema,
  adminPresetMutationResponseSchema,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
  copyDemoPresetToCustomRequestSchema,
  type DashboardRecoveryResponse,
  type DemoPresetContract,
  dashboardRecoveryResponseSchema,
  duplicateDemoPresetRequestSchema,
  type ErpChaosConfig,
  type ErpChaosStatus,
  erpChaosConfigSchema,
  erpChaosStatusSchema,
  type PublicRuntimePolicy,
  type PublicRuntimePolicyMutable,
  saveDemoPresetRequestSchema,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { BackendRead } from "../lib/api";
import { readProxyJson } from "../lib/client/proxy-json";
import {
  adminDemoResetProxyPath,
  adminDemoRunStartProxyPath,
  adminErpChaosProxyPath,
  adminErpChaosResetProxyPath,
  adminMaintenanceCleanupRunsProxyPath,
  adminPassphraseHeaderName,
  adminPresetCopyToCustomProxyPath,
  adminPresetDuplicateProxyPath,
  adminPresetListProxyPath,
  adminPresetSaveProxyPath,
  adminPublicRuntimePolicyProxyPath,
  adminSessionProxyPath,
  dashboardRecoveryProxyPath,
} from "../lib/control-paths";
import { StatusPill } from "./status-pill";

const panelClassName =
  "min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full";
const buttonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClassName =
  "min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";
const inputClassName = "min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink";

type TrafficMode = DemoPresetContract["trafficConfig"]["mode"];
type RunConfigBase = Pick<
  AcceptedRunConfigSnapshot,
  "trafficConfig" | "inventoryConfig" | "erpConfig" | "backpressureConfig"
>;
type RunConfigDraft = Pick<
  PresetDraft,
  | "mode"
  | "buyerCount"
  | "duplicateEachBuyerAttempt"
  | "maxDurationSeconds"
  | "ratePerSecond"
  | "durationSeconds"
  | "startDelaySeconds"
  | "preAllocatedVus"
  | "maxVus"
  | "startingStock"
  | "quantityPerCheckout"
  | "reservationHoldMinutes"
  | "erpLatencyMs"
  | "erpMaxTps"
  | "erpErrorRate"
  | "erpForcedOutage"
  | "erpRequestTimeoutMs"
  | "orderProcessConcurrency"
  | "drainTimeoutSeconds"
  | "pendingPersistenceRetryAfterSeconds"
>;

interface PresetDraft {
  displayName: string;
  description: string;
  sortOrder: string;
  mode: TrafficMode;
  buyerCount: string;
  duplicateEachBuyerAttempt: boolean;
  maxDurationSeconds: string;
  ratePerSecond: string;
  durationSeconds: string;
  startDelaySeconds: string;
  preAllocatedVus: string;
  maxVus: string;
  startingStock: string;
  quantityPerCheckout: string;
  reservationHoldMinutes: string;
  erpLatencyMs: string;
  erpMaxTps: string;
  erpErrorRate: string;
  erpForcedOutage: boolean;
  erpRequestTimeoutMs: string;
  orderProcessConcurrency: string;
  drainTimeoutSeconds: string;
  pendingPersistenceRetryAfterSeconds: string;
}

interface RuntimePolicyDraft extends RunConfigDraft {
  isPublicRunBudgetEnforced: boolean;
  budgetWindowSeconds: string;
  perVisitorMaxStarts: string;
  globalMaxStarts: string;
  maxTotalRequests: string;
  maxBuyers: string;
  maxRequestsPerSecond: string;
  maxTrafficDurationSeconds: string;
  maxTrafficStartDelaySeconds: string;
  maxPreAllocatedVus: string;
  maxPublicVus: string;
  maxStartingStock: string;
  maxErpLatencyMs: string;
  minErpMaxTps: string;
  maxErpMaxTps: string;
  maxErpErrorRate: string;
  allowForcedOutage: boolean;
  allowBuyerSpike: boolean;
  allowSteadyArrivalRate: boolean;
}

export interface AdminConsoleProps {
  autoCheckSession?: boolean;
  initialAuthenticated?: boolean;
  initialErpChaos?: BackendRead<ErpChaosStatus>;
  initialPresets?: BackendRead<AdminPresetListResponse>;
  initialRecovery?: BackendRead<DashboardRecoveryResponse>;
  initialRuntimePolicy?: BackendRead<AdminPublicRuntimePolicyResponse>;
}

export function AdminConsole({
  autoCheckSession = true,
  initialAuthenticated = false,
  initialErpChaos,
  initialPresets,
  initialRecovery,
  initialRuntimePolicy,
}: AdminConsoleProps = {}) {
  const initialSelectedPreset =
    initialPresets?.status === "available" ? initialPresets.data.presets[0] : null;
  const [authenticated, setAuthenticated] = useState(initialAuthenticated);
  const [passphrase, setPassphrase] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [presetsRead, setPresetsRead] = useState<BackendRead<AdminPresetListResponse>>(
    initialPresets ?? {
      status: "unavailable",
      reason: "Admin sign-in required.",
    },
  );
  const [recovery, setRecovery] = useState<BackendRead<DashboardRecoveryResponse>>(
    initialRecovery ?? {
      status: "unavailable",
      reason: "Admin sign-in required.",
    },
  );
  const [erpChaos, setErpChaos] = useState<BackendRead<ErpChaosStatus>>(
    initialErpChaos ?? {
      status: "unavailable",
      reason: "Admin sign-in required.",
    },
  );
  const [runtimePolicy, setRuntimePolicy] = useState<BackendRead<AdminPublicRuntimePolicyResponse>>(
    initialRuntimePolicy ?? {
      status: "unavailable",
      reason: "Admin sign-in required.",
    },
  );
  const [selectedSlug, setSelectedSlug] = useState<string | null>(
    initialSelectedPreset?.slug ?? null,
  );
  const [draft, setDraft] = useState<PresetDraft | null>(
    initialSelectedPreset ? draftFromPreset(initialSelectedPreset) : null,
  );
  const [policyDraft, setPolicyDraft] = useState<RuntimePolicyDraft | null>(
    initialRuntimePolicy?.status === "available"
      ? draftFromRuntimePolicy(initialRuntimePolicy.data.policy)
      : null,
  );
  const [duplicateTargetSlug, setDuplicateTargetSlug] = useState(
    initialSelectedPreset ? `${initialSelectedPreset.slug}-copy` : "",
  );

  const presets = presetsRead.status === "available" ? presetsRead.data.presets : [];
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.slug === selectedSlug) ?? presets[0] ?? null,
    [presets, selectedSlug],
  );
  const startBlocked = isRunStartBlocked(recovery);

  const refreshProtectedSurface = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setStatusMessage(null);
    }

    const nextPresets = await readProxyJson(
      adminPresetListProxyPath,
      adminPresetListResponseSchema,
    );
    if (nextPresets.status !== "available") {
      setPresetsRead(nextPresets);
      setAuthenticated(false);
      if (!options?.silent) {
        setStatusMessage(nextPresets.reason);
      }
      return;
    }

    const [nextRecovery, nextErpChaos, nextRuntimePolicy] = await Promise.all([
      readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema),
      readProxyJson(adminErpChaosProxyPath, erpChaosStatusSchema),
      readProxyJson(adminPublicRuntimePolicyProxyPath, adminPublicRuntimePolicyResponseSchema),
    ]);

    setAuthenticated(true);
    setPresetsRead(nextPresets);
    setRecovery(nextRecovery);
    setErpChaos(nextErpChaos);
    setRuntimePolicy(nextRuntimePolicy);
    setSelectedSlug((current) => current ?? nextPresets.data.presets[0]?.slug ?? null);
  }, []);

  useEffect(() => {
    if (autoCheckSession) {
      void refreshProtectedSurface({ silent: true });
    }
  }, [autoCheckSession, refreshProtectedSurface]);

  useEffect(() => {
    if (!selectedPreset) {
      setDraft(null);
      return;
    }

    setDraft(draftFromPreset(selectedPreset));
    setDuplicateTargetSlug(`${selectedPreset.slug}-copy`);
  }, [selectedPreset]);

  useEffect(() => {
    if (runtimePolicy.status !== "available") {
      setPolicyDraft(null);
      return;
    }

    setPolicyDraft(draftFromRuntimePolicy(runtimePolicy.data.policy));
  }, [runtimePolicy]);

  async function signIn() {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const response = await fetch(adminSessionProxyPath, {
        method: "POST",
        cache: "no-store",
        headers: {
          [adminPassphraseHeaderName]: passphrase,
        },
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok) {
        setStatusMessage(errorMessageFromPayload(payload, "Admin sign-in failed."));
        return;
      }

      setPassphrase("");
      setAuthenticated(true);
      setStatusMessage("Admin session established.");
      await refreshProtectedSurface();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function refreshRecovery() {
    setRecovery(await readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema));
  }

  async function refreshRuntimePolicy() {
    const result = await readProxyJson(
      adminPublicRuntimePolicyProxyPath,
      adminPublicRuntimePolicyResponseSchema,
    );
    setRuntimePolicy(result);
    setStatusMessage(
      result.status === "available" ? "Public runtime policy refreshed." : result.reason,
    );
  }

  async function saveRuntimePolicy() {
    if (runtimePolicy.status !== "available" || !policyDraft) {
      return;
    }

    const parsed = adminPublicRuntimePolicyUpdateRequestSchema.safeParse({
      policy: policyFromDraft(policyDraft, runtimePolicy.data.policy),
    });

    if (!parsed.success) {
      setStatusMessage("Public runtime policy values are outside the shared contract.");
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(
        adminPublicRuntimePolicyProxyPath,
        adminPublicRuntimePolicyResponseSchema,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );

      setRuntimePolicy(result);
      setStatusMessage(
        result.status === "available" ? "Public runtime policy saved." : result.reason,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function startSelectedPreset() {
    if (!selectedPreset || !draft) {
      return;
    }

    const configOverride = configFromDraft(draft, selectedPreset);
    const parsed = startDemoRunRequestSchema.safeParse({
      presetSlug: selectedPreset.slug,
      configOverride,
    });

    if (!parsed.success) {
      setStatusMessage("Run configuration is outside the shared start contract.");
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(adminDemoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (result.status === "available") {
        setStatusMessage("Admin run accepted.");
        navigateToWatch();
        return;
      }

      setStatusMessage(result.reason);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function saveSelectedPreset() {
    if (!selectedPreset || !draft || !canSavePreset(selectedPreset)) {
      return;
    }

    const config = configFromDraft(draft, selectedPreset);
    const parsed = saveDemoPresetRequestSchema.safeParse({
      slug: selectedPreset.slug,
      display: {
        ...selectedPreset.display,
        name: draft.displayName,
        description: draft.description,
        sortOrder: parseInteger(draft.sortOrder, selectedPreset.display.sortOrder),
      },
      ...config,
    });

    if (!parsed.success) {
      setStatusMessage("Preset changes are outside the shared save contract.");
      return;
    }

    await submitPresetMutation(adminPresetSaveProxyPath, parsed.data, "Preset saved.");
  }

  async function duplicateSelectedPreset() {
    if (!selectedPreset) {
      return;
    }

    const parsed = duplicateDemoPresetRequestSchema.safeParse({
      sourceSlug: selectedPreset.slug,
      targetSlug: duplicateTargetSlug,
      displayName: `${selectedPreset.display.name} Copy`,
    });

    if (!parsed.success) {
      setStatusMessage("Duplicate target slug is outside the shared contract.");
      return;
    }

    await submitPresetMutation(adminPresetDuplicateProxyPath, parsed.data, "Preset duplicated.");
  }

  async function copySelectedToCustom() {
    if (!selectedPreset) {
      return;
    }

    const parsed = copyDemoPresetToCustomRequestSchema.safeParse({
      sourceSlug: selectedPreset.slug,
    });

    if (!parsed.success) {
      setStatusMessage("Copy request is outside the shared contract.");
      return;
    }

    await submitPresetMutation(adminPresetCopyToCustomProxyPath, parsed.data, "Custom updated.");
  }

  async function submitPresetMutation(path: string, body: unknown, successMessage: string) {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(path, adminPresetMutationResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (result.status !== "available") {
        setStatusMessage(result.reason);
        return;
      }

      setStatusMessage(successMessage);
      setSelectedSlug(result.data.preset.slug);
      await refreshProtectedSurface({ silent: true });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resetDemo() {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(adminDemoResetProxyPath, adminDemoResetResponseSchema, {
        method: "POST",
      });

      setStatusMessage(
        result.status === "available"
          ? `Reset complete: ${result.data.failedRunCount} runs failed, ${result.data.cleanedJobCount} jobs cleaned.`
          : result.reason,
      );
      await refreshRecovery();
    } finally {
      setIsSubmitting(false);
    }
  }

  async function cleanupRuns() {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(
        adminMaintenanceCleanupRunsProxyPath,
        adminMaintenanceCleanupRunsResponseSchema,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keepLatest: 15, olderThanDays: 7 }),
        },
      );

      setStatusMessage(
        result.status === "available"
          ? `Cleanup complete: ${result.data.deletedRunCount} generated runs removed.`
          : result.reason,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function updateErpChaos(next: ErpChaosConfig) {
    const parsed = erpChaosConfigSchema.safeParse(next);
    if (!parsed.success) {
      setStatusMessage("ERP chaos values are outside the shared contract.");
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(adminErpChaosProxyPath, erpChaosStatusSchema, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      setErpChaos(result);
      setStatusMessage(result.status === "available" ? "ERP diagnostics updated." : result.reason);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function resetErpChaos() {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(adminErpChaosResetProxyPath, erpChaosStatusSchema, {
        method: "POST",
      });

      setErpChaos(result);
      setStatusMessage(result.status === "available" ? "ERP diagnostics reset." : result.reason);
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!authenticated) {
    return (
      <section className="max-w-[520px] rounded-lg border border-border bg-surface p-4">
        <div className="mb-4">
          <p className="m-0 text-xs font-bold uppercase text-muted">Admin sign-in</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Protected operator surface
          </h2>
        </div>
        <div className="grid gap-3">
          <LabeledTextInput
            label="Admin passphrase"
            onChange={setPassphrase}
            type="password"
            value={passphrase}
          />
          <button
            className={primaryButtonClassName}
            disabled={isSubmitting}
            onClick={() => {
              void signIn();
            }}
            type="button"
          >
            Sign In
          </button>
          {statusMessage ? (
            <p className="m-0 text-sm font-semibold text-muted-strong">{statusMessage}</p>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className={`${panelClassName} col-span-4`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Recovery</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Current run</h2>
          </div>
          <StatusPill label={currentRunStatus(recovery)} tone={startBlocked ? "pending" : "idle"} />
        </div>
        {recovery.status === "available" ? (
          <dl className="m-0 grid gap-3">
            <Fact label="Run" value={recovery.data.currentRun?.presetName ?? "No active run"} />
            <Fact label="Status" value={recovery.data.currentRun?.status ?? "idle"} />
            <Fact label="Traffic" value={recovery.data.currentRun?.trafficStatus ?? "Not active"} />
            <Fact label="Recovered" value={formatTime(recovery.data.recoveredAt)} />
          </dl>
        ) : (
          <Unavailable read={recovery} />
        )}
        <button
          className={`${buttonClassName} mt-4`}
          disabled={isSubmitting}
          onClick={() => {
            void refreshRecovery();
          }}
          type="button"
        >
          Refresh Recovery
        </button>
      </section>

      <PublicRuntimePolicyPanel
        draft={policyDraft}
        isSubmitting={isSubmitting}
        onRefresh={() => {
          void refreshRuntimePolicy();
        }}
        onSave={() => {
          void saveRuntimePolicy();
        }}
        onUpdateDraft={(next) =>
          setPolicyDraft((current) => (current ? { ...current, ...next } : current))
        }
        runtimePolicy={runtimePolicy}
      />

      <section className={`${panelClassName} col-span-8`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Presets</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
              Inspection and starts
            </h2>
          </div>
          <StatusPill label={`${presets.length} loaded`} tone="ok" />
        </div>
        <div className="grid grid-cols-[minmax(180px,260px)_1fr] gap-4 max-[800px]:grid-cols-1">
          <div className="grid content-start gap-2">
            {presets.map((preset) => (
              <button
                className={
                  preset.slug === selectedPreset?.slug ? primaryButtonClassName : buttonClassName
                }
                key={preset.slug}
                onClick={() => setSelectedSlug(preset.slug)}
                type="button"
              >
                {preset.display.name}
              </button>
            ))}
            {presetsRead.status === "unavailable" ? <Unavailable read={presetsRead} /> : null}
          </div>
          {selectedPreset && draft ? (
            <PresetEditor
              draft={draft}
              duplicateTargetSlug={duplicateTargetSlug}
              isSubmitting={isSubmitting}
              onCopyToCustom={() => {
                void copySelectedToCustom();
              }}
              onDuplicate={() => {
                void duplicateSelectedPreset();
              }}
              onDuplicateTargetSlugChange={setDuplicateTargetSlug}
              onSave={() => {
                void saveSelectedPreset();
              }}
              onStart={() => {
                void startSelectedPreset();
              }}
              onUpdateDraft={(next) =>
                setDraft((current) => ({ ...(current as PresetDraft), ...next }))
              }
              preset={selectedPreset}
              startBlocked={startBlocked}
            />
          ) : (
            <p className="m-0 text-muted">No admin presets are available.</p>
          )}
        </div>
      </section>

      <section className={`${panelClassName} col-span-6`}>
        <div className="mb-4">
          <p className="m-0 text-xs font-bold uppercase text-muted">Maintenance</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Recovery and cleanup
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={buttonClassName}
            disabled={isSubmitting}
            onClick={() => {
              void resetDemo();
            }}
            type="button"
          >
            Reset Demo
          </button>
          <button
            className={buttonClassName}
            disabled={isSubmitting}
            onClick={() => {
              void cleanupRuns();
            }}
            type="button"
          >
            Cleanup Runs
          </button>
        </div>
        {statusMessage ? (
          <p className="m-0 mt-4 text-sm font-semibold text-muted-strong">{statusMessage}</p>
        ) : null}
      </section>

      <ErpDiagnosticsPanel
        erpChaos={erpChaos}
        isSubmitting={isSubmitting}
        onReset={() => {
          void resetErpChaos();
        }}
        onUpdate={(next) => {
          void updateErpChaos(next);
        }}
      />
    </div>
  );
}

function PublicRuntimePolicyPanel({
  draft,
  isSubmitting,
  onRefresh,
  onSave,
  onUpdateDraft,
  runtimePolicy,
}: {
  draft: RuntimePolicyDraft | null;
  isSubmitting: boolean;
  onRefresh: () => void;
  onSave: () => void;
  onUpdateDraft: (next: Partial<RuntimePolicyDraft>) => void;
  runtimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
}) {
  const policy = runtimePolicy.status === "available" ? runtimePolicy.data.policy : null;

  return (
    <section className={`${panelClassName} col-span-8`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Public policy</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Runtime budgets and custom limits
          </h2>
        </div>
        <StatusPill
          label={draft?.isPublicRunBudgetEnforced ? "budgeted" : "open"}
          tone={runtimePolicy.status === "available" ? "ok" : "pending"}
        />
      </div>
      {runtimePolicy.status === "available" && policy && draft ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
            <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
              <input
                checked={draft.isPublicRunBudgetEnforced}
                onChange={(event) =>
                  onUpdateDraft({ isPublicRunBudgetEnforced: event.target.checked })
                }
                type="checkbox"
              />
              Enforce public budget
            </label>
            <LabeledTextInput
              label="Budget window seconds"
              onChange={(budgetWindowSeconds) => onUpdateDraft({ budgetWindowSeconds })}
              type="number"
              value={draft.budgetWindowSeconds}
            />
            <LabeledTextInput
              label="Per-visitor starts"
              onChange={(perVisitorMaxStarts) => onUpdateDraft({ perVisitorMaxStarts })}
              type="number"
              value={draft.perVisitorMaxStarts}
            />
            <LabeledTextInput
              label="Global starts"
              onChange={(globalMaxStarts) => onUpdateDraft({ globalMaxStarts })}
              type="number"
              value={draft.globalMaxStarts}
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
              <LabeledTextInput
                label="Max total requests"
                onChange={(maxTotalRequests) => onUpdateDraft({ maxTotalRequests })}
                type="number"
                value={draft.maxTotalRequests}
              />
              <LabeledTextInput
                label="Max buyers"
                onChange={(maxBuyers) => onUpdateDraft({ maxBuyers })}
                type="number"
                value={draft.maxBuyers}
              />
              <LabeledTextInput
                label="Max requests/sec"
                onChange={(maxRequestsPerSecond) => onUpdateDraft({ maxRequestsPerSecond })}
                type="number"
                value={draft.maxRequestsPerSecond}
              />
              <LabeledTextInput
                label="Max duration seconds"
                onChange={(maxTrafficDurationSeconds) =>
                  onUpdateDraft({ maxTrafficDurationSeconds })
                }
                type="number"
                value={draft.maxTrafficDurationSeconds}
              />
              <LabeledTextInput
                label="Max start delay seconds"
                onChange={(maxTrafficStartDelaySeconds) =>
                  onUpdateDraft({ maxTrafficStartDelaySeconds })
                }
                type="number"
                value={draft.maxTrafficStartDelaySeconds}
              />
              <LabeledTextInput
                label="Max preallocated VUs"
                onChange={(maxPreAllocatedVus) => onUpdateDraft({ maxPreAllocatedVus })}
                type="number"
                value={draft.maxPreAllocatedVus}
              />
              <LabeledTextInput
                label="Max VUs"
                onChange={(maxPublicVus) => onUpdateDraft({ maxPublicVus })}
                type="number"
                value={draft.maxPublicVus}
              />
              <LabeledTextInput
                label="Max starting stock"
                onChange={(maxStartingStock) => onUpdateDraft({ maxStartingStock })}
                type="number"
                value={draft.maxStartingStock}
              />
              <LabeledTextInput
                label="Max ERP latency ms"
                onChange={(maxErpLatencyMs) => onUpdateDraft({ maxErpLatencyMs })}
                type="number"
                value={draft.maxErpLatencyMs}
              />
              <LabeledTextInput
                label="Min ERP max TPS"
                onChange={(minErpMaxTps) => onUpdateDraft({ minErpMaxTps })}
                type="number"
                value={draft.minErpMaxTps}
              />
              <LabeledTextInput
                label="Max ERP max TPS"
                onChange={(maxErpMaxTps) => onUpdateDraft({ maxErpMaxTps })}
                type="number"
                value={draft.maxErpMaxTps}
              />
              <LabeledTextInput
                label="Max ERP error rate"
                onChange={(maxErpErrorRate) => onUpdateDraft({ maxErpErrorRate })}
                step="0.01"
                type="number"
                value={draft.maxErpErrorRate}
              />
              <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
                <input
                  checked={draft.allowBuyerSpike}
                  onChange={(event) => onUpdateDraft({ allowBuyerSpike: event.target.checked })}
                  type="checkbox"
                />
                Buyer spike
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
                <input
                  checked={draft.allowSteadyArrivalRate}
                  onChange={(event) =>
                    onUpdateDraft({ allowSteadyArrivalRate: event.target.checked })
                  }
                  type="checkbox"
                />
                Steady arrival
              </label>
              <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
                <input
                  checked={draft.allowForcedOutage}
                  onChange={(event) => onUpdateDraft({ allowForcedOutage: event.target.checked })}
                  type="checkbox"
                />
                Allow forced outage
              </label>
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
              disabled={isSubmitting}
              onClick={onSave}
              type="button"
            >
              Save Public Policy
            </button>
            <button
              className={buttonClassName}
              disabled={isSubmitting}
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
            disabled={isSubmitting}
            onClick={onRefresh}
            type="button"
          >
            Refresh Policy
          </button>
        </div>
      )}
    </section>
  );
}

function PresetEditor({
  draft,
  duplicateTargetSlug,
  isSubmitting,
  onCopyToCustom,
  onDuplicate,
  onDuplicateTargetSlugChange,
  onSave,
  onStart,
  onUpdateDraft,
  preset,
  startBlocked,
}: {
  draft: PresetDraft;
  duplicateTargetSlug: string;
  isSubmitting: boolean;
  onCopyToCustom: () => void;
  onDuplicate: () => void;
  onDuplicateTargetSlugChange: (value: string) => void;
  onSave: () => void;
  onStart: () => void;
  onUpdateDraft: (next: Partial<PresetDraft>) => void;
  preset: DemoPresetContract;
  startBlocked: boolean;
}) {
  return (
    <div className="grid gap-4">
      <dl className="m-0 grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
        <Fact label="Slug" value={preset.slug} />
        <Fact label="Visibility" value={preset.visibility} />
        <Fact label="Editable" value={preset.isEditable ? "yes" : "no"} />
        <Fact label="Custom" value={preset.isCustom ? "yes" : "no"} />
      </dl>
      <div className="grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
        <LabeledTextInput
          label="Name"
          onChange={(displayName) => onUpdateDraft({ displayName })}
          value={draft.displayName}
        />
        <LabeledTextInput
          label="Description"
          onChange={(description) => onUpdateDraft({ description })}
          value={draft.description}
        />
        <LabeledTextInput
          label="Sort order"
          onChange={(sortOrder) => onUpdateDraft({ sortOrder })}
          type="number"
          value={draft.sortOrder}
        />
      </div>
      <TrafficEditor draft={draft} onUpdateDraft={onUpdateDraft} />
      <RunConfigFields draft={draft} onUpdateDraft={onUpdateDraft} />
      <div className="flex flex-wrap gap-2">
        <button
          className={primaryButtonClassName}
          disabled={isSubmitting || startBlocked}
          onClick={onStart}
          type="button"
        >
          Start Admin Run
        </button>
        <button
          className={buttonClassName}
          disabled={isSubmitting || !canSavePreset(preset)}
          onClick={onSave}
          type="button"
        >
          Save Preset
        </button>
        <button
          className={buttonClassName}
          disabled={isSubmitting || preset.slug === "public-custom"}
          onClick={onCopyToCustom}
          type="button"
        >
          Copy to Custom
        </button>
      </div>
      <div className="grid grid-cols-[minmax(160px,1fr)_auto] gap-2 max-[560px]:grid-cols-1">
        <LabeledTextInput
          label="Duplicate slug"
          onChange={onDuplicateTargetSlugChange}
          value={duplicateTargetSlug}
        />
        <button
          className={`${buttonClassName} self-end`}
          disabled={isSubmitting || preset.slug === "public-custom"}
          onClick={onDuplicate}
          type="button"
        >
          Duplicate
        </button>
      </div>
    </div>
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
        {(["buyer-spike", "steady-arrival-rate"] as const).map((mode) => (
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
            <LabeledTextInput
              label="Buyer count"
              onChange={(buyerCount) => onUpdateDraft({ buyerCount })}
              type="number"
              value={draft.buyerCount}
            />
            <LabeledTextInput
              label="Max duration seconds"
              onChange={(maxDurationSeconds) => onUpdateDraft({ maxDurationSeconds })}
              type="number"
              value={draft.maxDurationSeconds}
            />
            <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
              <input
                checked={draft.duplicateEachBuyerAttempt}
                onChange={(event) =>
                  onUpdateDraft({ duplicateEachBuyerAttempt: event.target.checked })
                }
                type="checkbox"
              />
              Duplicate attempts
            </label>
          </>
        ) : (
          <>
            <LabeledTextInput
              label="Requests per second"
              onChange={(ratePerSecond) => onUpdateDraft({ ratePerSecond })}
              type="number"
              value={draft.ratePerSecond}
            />
            <LabeledTextInput
              label="Duration seconds"
              onChange={(durationSeconds) => onUpdateDraft({ durationSeconds })}
              type="number"
              value={draft.durationSeconds}
            />
            <LabeledTextInput
              label="Preallocated VUs"
              onChange={(preAllocatedVus) => onUpdateDraft({ preAllocatedVus })}
              type="number"
              value={draft.preAllocatedVus}
            />
            <LabeledTextInput
              label="Max VUs"
              onChange={(maxVus) => onUpdateDraft({ maxVus })}
              type="number"
              value={draft.maxVus}
            />
          </>
        )}
        <LabeledTextInput
          label="Start delay seconds"
          onChange={(startDelaySeconds) => onUpdateDraft({ startDelaySeconds })}
          type="number"
          value={draft.startDelaySeconds}
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
        <LabeledTextInput
          label="Starting stock"
          onChange={(startingStock) => onUpdateDraft({ startingStock })}
          type="number"
          value={draft.startingStock}
        />
        <LabeledTextInput
          label="Quantity per checkout"
          onChange={(quantityPerCheckout) => onUpdateDraft({ quantityPerCheckout })}
          type="number"
          value={draft.quantityPerCheckout}
        />
        <LabeledTextInput
          label="Hold minutes"
          onChange={(reservationHoldMinutes) => onUpdateDraft({ reservationHoldMinutes })}
          type="number"
          value={draft.reservationHoldMinutes}
        />
        <LabeledTextInput
          label="Worker concurrency"
          onChange={(orderProcessConcurrency) => onUpdateDraft({ orderProcessConcurrency })}
          type="number"
          value={draft.orderProcessConcurrency}
        />
        <LabeledTextInput
          label="Drain timeout seconds"
          onChange={(drainTimeoutSeconds) => onUpdateDraft({ drainTimeoutSeconds })}
          type="number"
          value={draft.drainTimeoutSeconds}
        />
        <LabeledTextInput
          label="Persistence retry seconds"
          onChange={(pendingPersistenceRetryAfterSeconds) =>
            onUpdateDraft({ pendingPersistenceRetryAfterSeconds })
          }
          type="number"
          value={draft.pendingPersistenceRetryAfterSeconds}
        />
      </div>
      <div className="grid grid-cols-5 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
        <LabeledTextInput
          label="ERP latency ms"
          onChange={(erpLatencyMs) => onUpdateDraft({ erpLatencyMs })}
          type="number"
          value={draft.erpLatencyMs}
        />
        <LabeledTextInput
          label="ERP max TPS"
          onChange={(erpMaxTps) => onUpdateDraft({ erpMaxTps })}
          type="number"
          value={draft.erpMaxTps}
        />
        <LabeledTextInput
          label="ERP error rate"
          onChange={(erpErrorRate) => onUpdateDraft({ erpErrorRate })}
          step="0.01"
          type="number"
          value={draft.erpErrorRate}
        />
        <LabeledTextInput
          label="ERP timeout ms"
          onChange={(erpRequestTimeoutMs) => onUpdateDraft({ erpRequestTimeoutMs })}
          type="number"
          value={draft.erpRequestTimeoutMs}
        />
        <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
          <input
            checked={draft.erpForcedOutage}
            onChange={(event) => onUpdateDraft({ erpForcedOutage: event.target.checked })}
            type="checkbox"
          />
          ERP forced outage
        </label>
      </div>
    </>
  );
}

function ErpDiagnosticsPanel({
  erpChaos,
  isSubmitting,
  onReset,
  onUpdate,
}: {
  erpChaos: BackendRead<ErpChaosStatus>;
  isSubmitting: boolean;
  onReset: () => void;
  onUpdate: (next: ErpChaosConfig) => void;
}) {
  const current = erpChaos.status === "available" ? erpChaos.data : null;
  const [latencyMs, setLatencyMs] = useState("0");
  const [maxTps, setMaxTps] = useState("100");
  const [errorRate, setErrorRate] = useState("0");
  const [forcedOutage, setForcedOutage] = useState(false);

  useEffect(() => {
    if (!current) {
      return;
    }

    setLatencyMs(String(current.latencyMs));
    setMaxTps(String(current.maxTps));
    setErrorRate(String(current.errorRate));
    setForcedOutage(current.forcedOutage);
  }, [current]);

  return (
    <section className={`${panelClassName} col-span-6`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">ERP diagnostics</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Global chaos controls
          </h2>
        </div>
        <StatusPill label={current?.forcedOutage ? "outage" : "ready"} tone="idle" />
      </div>
      <div className="grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
        <LabeledTextInput
          label="Latency ms"
          onChange={setLatencyMs}
          type="number"
          value={latencyMs}
        />
        <LabeledTextInput label="Max TPS" onChange={setMaxTps} type="number" value={maxTps} />
        <LabeledTextInput
          label="Error rate"
          onChange={setErrorRate}
          step="0.01"
          type="number"
          value={errorRate}
        />
        <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
          <input
            checked={forcedOutage}
            onChange={(event) => setForcedOutage(event.target.checked)}
            type="checkbox"
          />
          Forced outage
        </label>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className={buttonClassName}
          disabled={isSubmitting}
          onClick={() =>
            onUpdate({
              latencyMs: parseInteger(latencyMs, 0),
              maxTps: parseInteger(maxTps, 1),
              errorRate: parseNumber(errorRate, 0),
              forcedOutage,
            })
          }
          type="button"
        >
          Apply ERP Controls
        </button>
        <button className={buttonClassName} disabled={isSubmitting} onClick={onReset} type="button">
          Reset ERP Controls
        </button>
      </div>
      {erpChaos.status === "unavailable" ? <Unavailable read={erpChaos} /> : null}
    </section>
  );
}

function draftFromPreset(preset: DemoPresetContract): PresetDraft {
  return {
    displayName: preset.display.name,
    description: preset.display.description,
    sortOrder: String(preset.display.sortOrder),
    ...draftFromConfigSnapshot(preset),
  };
}

function draftFromRuntimePolicy(policy: PublicRuntimePolicy): RuntimePolicyDraft {
  return {
    isPublicRunBudgetEnforced: policy.isPublicRunBudgetEnforced,
    budgetWindowSeconds: String(policy.publicRunBudget.windowSeconds),
    perVisitorMaxStarts: String(policy.publicRunBudget.perVisitorMaxStarts),
    globalMaxStarts: String(policy.publicRunBudget.globalMaxStarts),
    ...draftFromConfigSnapshot(policy.publicCustomDefaults),
    maxTotalRequests: String(policy.publicCustomLimits.maxTotalRequests),
    maxBuyers: String(policy.publicCustomLimits.maxBuyers),
    maxRequestsPerSecond: String(policy.publicCustomLimits.maxRequestsPerSecond),
    maxTrafficDurationSeconds: String(policy.publicCustomLimits.maxTrafficDurationSeconds),
    maxTrafficStartDelaySeconds: String(policy.publicCustomLimits.maxTrafficStartDelaySeconds),
    maxPreAllocatedVus: String(policy.publicCustomLimits.maxPreAllocatedVus),
    maxPublicVus: String(policy.publicCustomLimits.maxVus),
    maxStartingStock: String(policy.publicCustomLimits.maxStartingStock),
    maxErpLatencyMs: String(policy.publicCustomLimits.maxErpLatencyMs),
    minErpMaxTps: String(policy.publicCustomLimits.minErpMaxTps),
    maxErpMaxTps: String(policy.publicCustomLimits.maxErpMaxTps),
    maxErpErrorRate: String(policy.publicCustomLimits.maxErpErrorRate),
    allowForcedOutage: policy.publicCustomLimits.allowForcedOutage,
    allowBuyerSpike: policy.publicCustomLimits.allowedTrafficModes.includes("buyer-spike"),
    allowSteadyArrivalRate:
      policy.publicCustomLimits.allowedTrafficModes.includes("steady-arrival-rate"),
  };
}

function draftFromConfigSnapshot(config: RunConfigBase): RunConfigDraft {
  const traffic = config.trafficConfig;
  const steadyVus = traffic.mode === "steady-arrival-rate" ? traffic.k6Vus : undefined;

  return {
    mode: traffic.mode,
    buyerCount: traffic.mode === "buyer-spike" ? String(traffic.buyerCount) : "1000",
    duplicateEachBuyerAttempt:
      traffic.mode === "buyer-spike" ? traffic.duplicateEachBuyerAttempt : false,
    maxDurationSeconds: traffic.mode === "buyer-spike" ? String(traffic.maxDurationSeconds) : "10",
    ratePerSecond: traffic.mode === "steady-arrival-rate" ? String(traffic.ratePerSecond) : "50",
    durationSeconds:
      traffic.mode === "steady-arrival-rate" ? String(traffic.durationSeconds) : "10",
    startDelaySeconds: String(traffic.startDelaySeconds),
    preAllocatedVus: String(steadyVus?.preAllocatedVus ?? 10),
    maxVus: String(steadyVus?.maxVus ?? 50),
    startingStock: String(config.inventoryConfig.startingStock),
    quantityPerCheckout: String(config.inventoryConfig.quantityPerCheckout),
    reservationHoldMinutes: String(config.inventoryConfig.reservationHoldMinutes),
    erpLatencyMs: String(config.erpConfig.latencyMs),
    erpMaxTps: String(config.erpConfig.maxTps),
    erpErrorRate: String(config.erpConfig.errorRate),
    erpForcedOutage: config.erpConfig.forcedOutage,
    erpRequestTimeoutMs: String(config.erpConfig.requestTimeoutMs),
    orderProcessConcurrency: String(config.backpressureConfig.orderProcessConcurrency),
    drainTimeoutSeconds: String(config.backpressureConfig.drainTimeoutSeconds),
    pendingPersistenceRetryAfterSeconds: String(
      config.backpressureConfig.pendingPersistenceRetryAfterSeconds,
    ),
  };
}

function policyFromDraft(
  draft: RuntimePolicyDraft,
  currentPolicy: PublicRuntimePolicy,
): PublicRuntimePolicyMutable {
  const allowedTrafficModes = [
    ...(draft.allowBuyerSpike ? (["buyer-spike"] as const) : []),
    ...(draft.allowSteadyArrivalRate ? (["steady-arrival-rate"] as const) : []),
  ];

  return {
    isPublicRunBudgetEnforced: draft.isPublicRunBudgetEnforced,
    publicRunBudget: {
      windowSeconds: parseInteger(draft.budgetWindowSeconds, 1),
      perVisitorMaxStarts: parseInteger(draft.perVisitorMaxStarts, 1),
      globalMaxStarts: parseInteger(draft.globalMaxStarts, 1),
    },
    publicCustomDefaults: configFromDraft(draft, currentPolicy.publicCustomDefaults),
    publicCustomLimits: {
      maxTotalRequests: parseInteger(draft.maxTotalRequests, 1),
      maxBuyers: parseInteger(draft.maxBuyers, 1),
      maxRequestsPerSecond: parseInteger(draft.maxRequestsPerSecond, 1),
      maxTrafficDurationSeconds: parseInteger(draft.maxTrafficDurationSeconds, 1),
      maxTrafficStartDelaySeconds: parseInteger(draft.maxTrafficStartDelaySeconds, 0),
      maxPreAllocatedVus: parseInteger(draft.maxPreAllocatedVus, 1),
      maxVus: parseInteger(draft.maxPublicVus, 1),
      maxStartingStock: parseInteger(draft.maxStartingStock, 1),
      maxErpLatencyMs: parseInteger(draft.maxErpLatencyMs, 0),
      minErpMaxTps: parseInteger(draft.minErpMaxTps, 1),
      maxErpMaxTps: parseInteger(draft.maxErpMaxTps, 1),
      maxErpErrorRate: parseNumber(draft.maxErpErrorRate, 0),
      allowForcedOutage: draft.allowForcedOutage,
      allowedTrafficModes,
    },
  };
}

function configFromDraft(draft: RunConfigDraft, base: RunConfigBase): AcceptedRunConfigSnapshot {
  return {
    trafficConfig:
      draft.mode === "buyer-spike"
        ? {
            mode: "buyer-spike" as const,
            buyerCount: parseInteger(draft.buyerCount, 1),
            duplicateEachBuyerAttempt: draft.duplicateEachBuyerAttempt,
            startDelaySeconds: parseInteger(draft.startDelaySeconds, 0),
            maxDurationSeconds: parseInteger(draft.maxDurationSeconds, 1),
            quantityPerAttempt: base.trafficConfig.quantityPerAttempt,
          }
        : {
            mode: "steady-arrival-rate" as const,
            ratePerSecond: parseInteger(draft.ratePerSecond, 1),
            startDelaySeconds: parseInteger(draft.startDelaySeconds, 0),
            durationSeconds: parseInteger(draft.durationSeconds, 1),
            quantityPerAttempt: base.trafficConfig.quantityPerAttempt,
            k6Vus: {
              preAllocatedVus: parseInteger(draft.preAllocatedVus, 1),
              maxVus: parseInteger(draft.maxVus, 1),
            },
          },
    inventoryConfig: {
      startingStock: parseInteger(draft.startingStock, 0),
      quantityPerCheckout: parseInteger(draft.quantityPerCheckout, 1),
      reservationHoldMinutes: parseInteger(draft.reservationHoldMinutes, 1),
    },
    erpConfig: {
      latencyMs: parseInteger(draft.erpLatencyMs, 0),
      maxTps: parseInteger(draft.erpMaxTps, 1),
      errorRate: parseNumber(draft.erpErrorRate, 0),
      forcedOutage: draft.erpForcedOutage,
      requestTimeoutMs: parseInteger(draft.erpRequestTimeoutMs, 1),
    },
    backpressureConfig: {
      ...base.backpressureConfig,
      orderProcessConcurrency: parseInteger(draft.orderProcessConcurrency, 1),
      drainTimeoutSeconds: parseInteger(draft.drainTimeoutSeconds, 1),
      pendingPersistenceRetryAfterSeconds: parseInteger(
        draft.pendingPersistenceRetryAfterSeconds,
        1,
      ),
    },
  };
}

function canSavePreset(preset: DemoPresetContract): boolean {
  return preset.visibility === "admin" && preset.isEditable;
}

function isRunStartBlocked(recovery: BackendRead<DashboardRecoveryResponse>): boolean {
  if (recovery.status !== "available") {
    return true;
  }

  const status = recovery.data.currentRun?.status;
  return status === "starting" || status === "active" || status === "draining";
}

function currentRunStatus(recovery: BackendRead<DashboardRecoveryResponse>): string {
  return recovery.status === "available"
    ? (recovery.data.currentRun?.status ?? "idle")
    : "unavailable";
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function navigateToWatch() {
  if (typeof window !== "undefined") {
    window.location.assign("/watch");
  }
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return fallback;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

function Unavailable({ read }: { read: BackendRead<unknown> }) {
  return read.status === "available" ? null : (
    <div className="mt-3 grid gap-1 rounded-lg border border-[#f7b4ad] bg-danger-soft p-3 leading-6 text-danger">
      <strong>Unavailable</strong>
      <span>{read.reason}</span>
      {read.httpStatus ? <span>HTTP {read.httpStatus}</span> : null}
    </div>
  );
}

function LabeledTextInput({
  label,
  onChange,
  step,
  type = "text",
  value,
}: {
  label: string;
  onChange: (next: string) => void;
  step?: string;
  type?: "number" | "password" | "text";
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-muted-strong">
      <span>{label}</span>
      <input
        className={inputClassName}
        onChange={(event) => onChange(event.target.value)}
        step={step}
        type={type}
        value={value}
      />
    </label>
  );
}
