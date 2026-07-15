"use client";

import {
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  archiveAdminPresetResponseSchema,
  adminDemoResetResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  adminPresetListResponseSchema,
  adminPresetMutationResponseSchema,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
  archiveAdminPresetRequestSchema,
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
import { useRouter } from "next/navigation";
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
import { ConfirmationDialog } from "../confirmation-dialog";

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
  const router = useRouter();
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
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
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

  async function archive() {
    if (!selectedPreset?.canArchive) return;
    const parsed = archiveAdminPresetRequestSchema.safeParse({ slug: selectedPreset.slug });
    if (!parsed.success) {
      setNotice("Archive request is outside the shared contract.");
      return;
    }

    await withPending(async () => {
      // The archive response is intentionally not an active preset; keep this
      // workflow explicit rather than reusing the generic mutate helper.
      const archived = await readProxyJson(
        adminPresetListProxyPath,
        archiveAdminPresetResponseSchema,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );
      if (archived.status !== "available") {
        if (archived.httpStatus === 401) {
          setArchiveOpen(false);
          router.refresh();
          return;
        }
        setArchiveError(archived.reason);
        return;
      }

      const refreshed = await readProxyJson(
        adminPresetListProxyPath,
        adminPresetListResponseSchema,
      );
      setPresetsRead(refreshed);
      const remaining = refreshed.status === "available" ? refreshed.data.presets : [];
      const next = remaining[0] ?? null;
      setSelectedSlug(next?.slug ?? null);
      draftSlugRef.current = next?.slug ?? null;
      isDraftDirtyRef.current = false;
      setDraft(next ? draftFromPreset(next) : null);
      setDuplicateTargetSlug(next ? `${next.slug}-copy` : "");
      setNotice("Preset archived.");
      setArchiveOpen(false);
      setArchiveError(null);
    });
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
    <>
    <AdminPresetView
      draft={draft}
      duplicateTargetSlug={duplicateTargetSlug}
      isPending={isPending}
      notice={notice}
      onArchive={() => {
        setArchiveError(null);
        setArchiveOpen(true);
      }}
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
    <ConfirmationDialog
      confirmLabel="Archive preset"
      description={`Archive the "${selectedPreset?.display.name ?? "selected"}" preset. It will leave the active list while historical runs are retained.`}
      error={archiveError}
      onCancel={() => setArchiveOpen(false)}
      onConfirm={() => void archive()}
      open={archiveOpen}
      pending={isPending}
      title="Archive this preset?"
    />
    </>
  );
}

export function AdminMaintenancePanel({
  onResetComplete,
}: {
  onResetComplete: () => Promise<void>;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [intent, setIntent] = useState<"reset" | "cleanup" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!intent) return;
    setIsPending(true);
    setError(null);
    try {
      const result =
        intent === "reset"
          ? await readProxyJson(adminDemoResetProxyPath, adminDemoResetResponseSchema, {
              method: "POST",
            })
          : await readProxyJson(
              adminMaintenanceCleanupRunsProxyPath,
              adminMaintenanceCleanupRunsResponseSchema,
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ keepLatest: 15, olderThanDays: 7 }),
              },
            );
      if (result.status === "unavailable") {
        if (result.httpStatus === 401) {
          setIntent(null);
          router.refresh();
        } else {
          setError(result.reason);
          if (intent === "reset") await onResetComplete();
        }
        return;
      }
      if (intent === "reset" && "failedRunCount" in result.data) {
        setNotice(
          `Reset complete: ${result.data.failedRunCount} runs failed, ${result.data.cleanedJobCount} jobs cleaned.`,
        );
        await onResetComplete();
      } else if ("deletedRunCount" in result.data) {
        setNotice(`Cleanup complete: ${result.data.deletedRunCount} generated runs removed.`);
      }
      setIntent(null);
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
          onClick={() => setIntent("reset")}
          type="button"
        >
          Reset Demo
        </button>
        <button
          className={buttonClassName}
          disabled={isPending}
          onClick={() => setIntent("cleanup")}
          type="button"
        >
          Cleanup Runs
        </button>
      </div>
      {notice ? <p className="m-0 mt-4 text-sm font-semibold text-muted-strong">{notice}</p> : null}
      <ConfirmationDialog
        confirmLabel={intent === "reset" ? "Reset demo" : "Cleanup generated runs"}
        description={
          intent === "reset"
            ? "Fail active demo work, clear queued jobs, and reset shared demo state. This disrupts current visitors."
            : "Permanently remove generated runs older than 7 days while keeping the latest 15."
        }
        error={error}
        onCancel={() => setIntent(null)}
        onConfirm={() => void run()}
        open={intent !== null}
        pending={isPending}
        title={intent === "reset" ? "Reset the shared demo?" : "Cleanup generated runs?"}
      />
    </section>
  );
}

export function AdminErpDiagnosticsController({
  initialErpChaos,
}: {
  initialErpChaos: BackendRead<ErpChaosStatus>;
}) {
  const router = useRouter();
  const [erpChaos, setErpChaos] = useState(initialErpChaos);
  const [draft, setDraft] = useState(() => erpDraftFromRead(initialErpChaos));
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
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
      if (result.status === "unavailable" && result.httpStatus === 401) {
        setResetOpen(false);
        router.refresh();
        return;
      }
      if (path === adminErpChaosResetProxyPath && result.status === "unavailable") {
        setResetError(result.reason);
        return;
      }
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
      if (path === adminErpChaosResetProxyPath) setResetOpen(false);
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
    <>
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
      onReset={() => {
        setResetError(null);
        setResetOpen(true);
      }}
    />
    <ConfirmationDialog
      confirmLabel="Reset ERP controls"
      description="Reset the shared ERP latency, throughput, error-rate, and outage controls to their defaults."
      error={resetError}
      onCancel={() => setResetOpen(false)}
      onConfirm={() => void submit(adminErpChaosResetProxyPath, { method: "POST" })}
      open={resetOpen}
      pending={isPending}
      title="Reset ERP controls?"
    />
    </>
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
