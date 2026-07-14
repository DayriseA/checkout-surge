"use client";

import {
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
  dashboardRecoveryResponseSchema,
  duplicateDemoPresetRequestSchema,
  type ErpChaosConfig,
  type ErpChaosStatus,
  erpChaosConfigSchema,
  erpChaosStatusSchema,
  saveDemoPresetRequestSchema,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BackendRead } from "../../lib/api";
import {
  configFromDraft,
  draftFromPreset,
  draftFromRuntimePolicy,
  parseInteger,
  parseNumber,
  policyFromDraft,
  type PresetDraft,
  type RuntimePolicyDraft,
} from "../../lib/admin-drafts";
import { readProxyJson } from "../../lib/client/proxy-json";
import {
  adminDemoResetProxyPath,
  adminDemoRunStartProxyPath,
  adminErpChaosProxyPath,
  adminErpChaosResetProxyPath,
  adminMaintenanceCleanupRunsProxyPath,
  adminPresetCopyToCustomProxyPath,
  adminPresetDuplicateProxyPath,
  adminPresetListProxyPath,
  adminPresetSaveProxyPath,
  adminPublicRuntimePolicyProxyPath,
  dashboardRecoveryProxyPath,
} from "../../lib/control-paths";
import { formatDashboardTime } from "../../lib/dashboard-time";
import {
  AdminErpDiagnosticsView,
  AdminPresetView,
  AdminRuntimePolicyView,
  Fact,
  Unavailable,
  buttonClassName,
  currentRunStatus,
  navigateToWatch,
  panelClassName,
} from "./admin-feature-views";
import { StatusPill } from "../status-pill";

export interface AdminAuthenticatedSurfaceProps {
  initialErpChaos: BackendRead<ErpChaosStatus>;
  initialPresets: BackendRead<AdminPresetListResponse>;
  initialRecovery: BackendRead<DashboardRecoveryResponse>;
  initialRuntimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
}

export function AdminAuthenticatedSurface(props: AdminAuthenticatedSurfaceProps) {
  const [recovery, setRecovery] = useState(props.initialRecovery);
  useEffect(() => {
    setRecovery(props.initialRecovery);
  }, [props.initialRecovery]);

  async function refreshRecovery() {
    const next = await readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema);
    setRecovery(next);
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <AdminCurrentRunPanel recovery={recovery} onRecoveryChange={setRecovery} />
      <AdminRuntimePolicyController initialRuntimePolicy={props.initialRuntimePolicy} />
      <AdminPresetController initialPresets={props.initialPresets} recovery={recovery} />
      <AdminMaintenancePanel onResetComplete={refreshRecovery} />
      <AdminErpDiagnosticsController initialErpChaos={props.initialErpChaos} />
    </div>
  );
}

export function AdminCurrentRunPanel({
  onRecoveryChange,
  recovery,
}: {
  onRecoveryChange: (recovery: BackendRead<DashboardRecoveryResponse>) => void;
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const [isPending, setIsPending] = useState(false);
  const startBlocked = isRunStartBlocked(recovery);

  async function refresh() {
    setIsPending(true);
    try {
      onRecoveryChange(
        await readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema),
      );
    } finally {
      setIsPending(false);
    }
  }

  return (
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
          <Fact label="Recovered" value={formatDashboardTime(recovery.data.recoveredAt)} />
        </dl>
      ) : (
        <Unavailable read={recovery} />
      )}
      <button
        className={`${buttonClassName} mt-4`}
        disabled={isPending}
        onClick={() => void refresh()}
        type="button"
      >
        Refresh Recovery
      </button>
    </section>
  );
}

export function AdminRuntimePolicyController({
  initialRuntimePolicy,
}: {
  initialRuntimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
}) {
  const [runtimePolicy, setRuntimePolicy] = useState(initialRuntimePolicy);
  const [draft, setDraft] = useState<RuntimePolicyDraft | null>(
    initialRuntimePolicy.status === "available"
      ? draftFromRuntimePolicy(initialRuntimePolicy.data.policy)
      : null,
  );
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isDraftDirtyRef = useRef(false);

  useEffect(() => {
    setRuntimePolicy(initialRuntimePolicy);
    if (!isDraftDirtyRef.current && initialRuntimePolicy.status === "available") {
      setDraft(draftFromRuntimePolicy(initialRuntimePolicy.data.policy));
    }
  }, [initialRuntimePolicy]);

  async function refresh() {
    setIsPending(true);
    setNotice(null);
    try {
      const result = await readProxyJson(
        adminPublicRuntimePolicyProxyPath,
        adminPublicRuntimePolicyResponseSchema,
      );
      setRuntimePolicy(result);
      if (result.status === "available") {
        setDraft(draftFromRuntimePolicy(result.data.policy));
        isDraftDirtyRef.current = false;
      }
      setNotice(result.status === "available" ? "Public runtime policy refreshed." : result.reason);
    } finally {
      setIsPending(false);
    }
  }

  async function save() {
    if (runtimePolicy.status !== "available" || !draft) return;
    const parsed = adminPublicRuntimePolicyUpdateRequestSchema.safeParse({
      policy: policyFromDraft(draft, runtimePolicy.data.policy),
    });
    if (!parsed.success) {
      setNotice("Public runtime policy values are outside the shared contract.");
      return;
    }
    setIsPending(true);
    setNotice(null);
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
      if (result.status === "available") setDraft(draftFromRuntimePolicy(result.data.policy));
      if (result.status === "available") isDraftDirtyRef.current = false;
      setNotice(result.status === "available" ? "Public runtime policy saved." : result.reason);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AdminRuntimePolicyView
      draft={draft}
      isPending={isPending}
      notice={notice}
      onRefresh={() => void refresh()}
      onSave={() => void save()}
      onUpdateDraft={(next) => {
        isDraftDirtyRef.current = true;
        setDraft((current) => (current ? { ...current, ...next } : null));
      }}
      runtimePolicy={runtimePolicy}
    />
  );
}

export function AdminPresetController({
  initialPresets,
  recovery,
}: {
  initialPresets: BackendRead<AdminPresetListResponse>;
  recovery: BackendRead<DashboardRecoveryResponse>;
}) {
  const initialPreset =
    initialPresets.status === "available" ? initialPresets.data.presets[0] : null;
  const [presetsRead, setPresetsRead] = useState(initialPresets);
  const [selectedSlug, setSelectedSlug] = useState(initialPreset?.slug ?? null);
  const [draft, setDraft] = useState<PresetDraft | null>(
    initialPreset ? draftFromPreset(initialPreset) : null,
  );
  const [duplicateTargetSlug, setDuplicateTargetSlug] = useState(
    initialPreset ? `${initialPreset.slug}-copy` : "",
  );
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const draftSlugRef = useRef(initialPreset?.slug ?? null);
  const isDraftDirtyRef = useRef(false);
  const presets = presetsRead.status === "available" ? presetsRead.data.presets : [];
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.slug === selectedSlug) ?? presets[0] ?? null,
    [presets, selectedSlug],
  );

  useEffect(() => {
    setPresetsRead(initialPresets);
  }, [initialPresets]);

  useEffect(() => {
    if (!selectedPreset) {
      setDraft(null);
      draftSlugRef.current = null;
      isDraftDirtyRef.current = false;
      return;
    }
    const switchedPreset = draftSlugRef.current !== selectedPreset.slug;
    if (!switchedPreset && isDraftDirtyRef.current) return;
    setDraft(draftFromPreset(selectedPreset));
    draftSlugRef.current = selectedPreset.slug;
    isDraftDirtyRef.current = false;
    if (switchedPreset) setDuplicateTargetSlug(`${selectedPreset.slug}-copy`);
  }, [selectedPreset]);

  async function start() {
    if (!selectedPreset || !draft) return;
    const parsed = startDemoRunRequestSchema.safeParse({
      presetSlug: selectedPreset.slug,
      configOverride: configFromDraft(draft, selectedPreset),
    });
    if (!parsed.success) {
      setNotice("Run configuration is outside the shared start contract.");
      return;
    }
    await withPending(async () => {
      const result = await readProxyJson(adminDemoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      setNotice(result.status === "available" ? "Admin run accepted." : result.reason);
      if (result.status === "available") navigateToWatch();
    });
  }

  async function save() {
    if (!selectedPreset || !draft) return;
    const parsed = saveDemoPresetRequestSchema.safeParse({
      slug: selectedPreset.slug,
      display: {
        ...selectedPreset.display,
        name: draft.displayName,
        description: draft.description,
        sortOrder: parseInteger(draft.sortOrder, selectedPreset.display.sortOrder),
      },
      ...configFromDraft(draft, selectedPreset),
    });
    if (!parsed.success) {
      setNotice("Preset changes are outside the shared save contract.");
      return;
    }
    await mutate(adminPresetSaveProxyPath, parsed.data, "Preset saved.");
  }

  async function duplicate(targetSlug: string) {
    if (!selectedPreset) return;
    const parsed = duplicateDemoPresetRequestSchema.safeParse({
      sourceSlug: selectedPreset.slug,
      targetSlug,
      displayName: `${selectedPreset.display.name} Copy`,
    });
    if (!parsed.success) {
      setNotice("Duplicate target slug is outside the shared contract.");
      return;
    }
    await mutate(adminPresetDuplicateProxyPath, parsed.data, "Preset duplicated.");
  }

  async function copyToCustom() {
    if (!selectedPreset) return;
    const parsed = copyDemoPresetToCustomRequestSchema.safeParse({
      sourceSlug: selectedPreset.slug,
    });
    if (!parsed.success) {
      setNotice("Copy request is outside the shared contract.");
      return;
    }
    await mutate(adminPresetCopyToCustomProxyPath, parsed.data, "Custom updated.");
  }

  async function mutate(path: string, body: unknown, successNotice: string) {
    await withPending(async () => {
      const mutation = await readProxyJson(path, adminPresetMutationResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (mutation.status !== "available") {
        setNotice(mutation.reason);
        return;
      }
      const refreshed = await readProxyJson(
        adminPresetListProxyPath,
        adminPresetListResponseSchema,
      );
      setPresetsRead(refreshed);
      setSelectedSlug(mutation.data.preset.slug);
      setDraft(draftFromPreset(mutation.data.preset));
      draftSlugRef.current = mutation.data.preset.slug;
      isDraftDirtyRef.current = false;
      setNotice(successNotice);
    });
  }

  async function withPending(operation: () => Promise<void>) {
    setIsPending(true);
    setNotice(null);
    try {
      await operation();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AdminPresetView
      draft={draft}
      duplicateTargetSlug={duplicateTargetSlug}
      isPending={isPending}
      notice={notice}
      onCopyToCustom={() => void copyToCustom()}
      onDuplicate={(targetSlug) => void duplicate(targetSlug)}
      onDuplicateTargetSlugChange={setDuplicateTargetSlug}
      onSave={() => void save()}
      onSelect={(slug) => {
        if (slug !== selectedSlug) isDraftDirtyRef.current = false;
        setSelectedSlug(slug);
      }}
      onStart={() => void start()}
      onUpdateDraft={(next) => {
        isDraftDirtyRef.current = true;
        setDraft((current) => (current ? { ...current, ...next } : null));
      }}
      presets={presets}
      presetsRead={presetsRead}
      selectedPreset={selectedPreset}
      startBlocked={isRunStartBlocked(recovery)}
    />
  );
}

export function AdminMaintenancePanel({
  onResetComplete,
}: {
  onResetComplete: () => Promise<void>;
}) {
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(operation: () => Promise<string>) {
    setIsPending(true);
    setNotice(null);
    try {
      setNotice(await operation());
    } finally {
      setIsPending(false);
    }
  }

  return (
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
          disabled={isPending}
          onClick={() =>
            void run(async () => {
              const result = await readProxyJson(
                adminDemoResetProxyPath,
                adminDemoResetResponseSchema,
                { method: "POST" },
              );
              const resultNotice =
                result.status === "available"
                  ? `Reset complete: ${result.data.failedRunCount} runs failed, ${result.data.cleanedJobCount} jobs cleaned.`
                  : result.reason;
              await onResetComplete();
              return resultNotice;
            })
          }
          type="button"
        >
          Reset Demo
        </button>
        <button
          className={buttonClassName}
          disabled={isPending}
          onClick={() =>
            void run(async () => {
              const result = await readProxyJson(
                adminMaintenanceCleanupRunsProxyPath,
                adminMaintenanceCleanupRunsResponseSchema,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ keepLatest: 15, olderThanDays: 7 }),
                },
              );
              return result.status === "available"
                ? `Cleanup complete: ${result.data.deletedRunCount} generated runs removed.`
                : result.reason;
            })
          }
          type="button"
        >
          Cleanup Runs
        </button>
      </div>
      {notice ? <p className="m-0 mt-4 text-sm font-semibold text-muted-strong">{notice}</p> : null}
    </section>
  );
}

export function AdminErpDiagnosticsController({
  initialErpChaos,
}: {
  initialErpChaos: BackendRead<ErpChaosStatus>;
}) {
  const [erpChaos, setErpChaos] = useState(initialErpChaos);
  const [draft, setDraft] = useState(() => erpDraftFromRead(initialErpChaos));
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isDraftDirtyRef = useRef(false);

  useEffect(() => {
    setErpChaos(initialErpChaos);
    if (!isDraftDirtyRef.current) setDraft(erpDraftFromRead(initialErpChaos));
  }, [initialErpChaos]);

  async function submit(path: string, init: RequestInit) {
    setIsPending(true);
    setNotice(null);
    try {
      const result = await readProxyJson(path, erpChaosStatusSchema, init);
      setErpChaos(result);
      if (result.status === "available") {
        setDraft(erpDraftFromRead(result));
        isDraftDirtyRef.current = false;
      }
      setNotice(
        result.status === "available"
          ? path === adminErpChaosResetProxyPath
            ? "ERP diagnostics reset."
            : "ERP diagnostics updated."
          : result.reason,
      );
    } finally {
      setIsPending(false);
    }
  }

  function apply() {
    const next: ErpChaosConfig = {
      latencyMs: parseInteger(draft.latencyMs, 0),
      maxTps: parseInteger(draft.maxTps, 1),
      errorRate: parseNumber(draft.errorRate, 0),
      forcedOutage: draft.forcedOutage,
    };
    const parsed = erpChaosConfigSchema.safeParse(next);
    if (!parsed.success) {
      setNotice("ERP chaos values are outside the shared contract.");
      return;
    }
    void submit(adminErpChaosProxyPath, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
  }

  return (
    <AdminErpDiagnosticsView
      errorRate={draft.errorRate}
      erpChaos={erpChaos}
      forcedOutage={draft.forcedOutage}
      isPending={isPending}
      latencyMs={draft.latencyMs}
      maxTps={draft.maxTps}
      notice={notice}
      onApply={apply}
      onErrorRateChange={(errorRate) => updateErpDraft({ errorRate })}
      onForcedOutageChange={(forcedOutage) => updateErpDraft({ forcedOutage })}
      onLatencyMsChange={(latencyMs) => updateErpDraft({ latencyMs })}
      onMaxTpsChange={(maxTps) => updateErpDraft({ maxTps })}
      onReset={() => void submit(adminErpChaosResetProxyPath, { method: "POST" })}
    />
  );

  function updateErpDraft(next: Partial<ErpDraft>) {
    isDraftDirtyRef.current = true;
    setDraft((current) => ({ ...current, ...next }));
  }
}

interface ErpDraft {
  latencyMs: string;
  maxTps: string;
  errorRate: string;
  forcedOutage: boolean;
}

function erpDraftFromRead(read: BackendRead<ErpChaosStatus>): ErpDraft {
  return read.status === "available"
    ? {
        latencyMs: String(read.data.latencyMs),
        maxTps: String(read.data.maxTps),
        errorRate: String(read.data.errorRate),
        forcedOutage: read.data.forcedOutage,
      }
    : { latencyMs: "0", maxTps: "100", errorRate: "0", forcedOutage: false };
}

function isRunStartBlocked(recovery: BackendRead<DashboardRecoveryResponse>): boolean {
  if (recovery.status !== "available") return true;
  const status = recovery.data.currentRun?.status;
  return status === "starting" || status === "active" || status === "draining";
}
