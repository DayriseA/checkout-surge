"use client";

import {
  type AdminPresetListItem,
  type AdminPresetListResponse,
  type AdminPublicRuntimePolicyResponse,
  adminDemoResetResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  adminPresetListResponseSchema,
  adminPresetMutationResponseSchema,
  adminPublicRuntimePolicyResponseSchema,
  adminPublicRuntimePolicyUpdateRequestSchema,
  archiveAdminPresetRequestSchema,
  archiveAdminPresetResponseSchema,
  copyDemoPresetToCustomRequestSchema,
  type DashboardProjection,
  duplicateDemoPresetRequestSchema,
  type ErpChaosStatus,
  erpChaosConfigSchema,
  erpChaosStatusSchema,
  type HealthResponse,
  saveDemoPresetRequestSchema,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildConfigFromDraft,
  buildErpChaosFromDraft,
  buildPolicyFromDraft,
  buildSortOrder,
  type DraftFieldError,
  type DraftFormError,
  draftFromPreset,
  draftFromRuntimePolicy,
  type PresetDraft,
  type RuntimePolicyDraft,
} from "../../lib/admin-drafts";
import type { BackendRead } from "../../lib/api";
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
} from "../../lib/control-paths";
import type { AdminNotice } from "../../lib/presentation/admin-notice";
import { adminFailureNotice } from "../../lib/presentation/admin-notice";
import { mapErrorPresentation } from "../../lib/presentation/error-presentation";
import { formatCount, formatInstantUtc } from "../../lib/presentation/format";
import { ConfirmationDialog } from "../confirmation-dialog";
import { ErrorNotice } from "../error-notice";
import { useDashboardRecovery } from "../realtime/use-dashboard-recovery";
import { StatusPill } from "../status-pill";
import {
  AdminErpDiagnosticsView,
  AdminPresetView,
  AdminRuntimePolicyView,
  buttonClassName,
  currentRunStatus,
  Fact,
  panelClassName,
  Unavailable,
} from "./admin-feature-views";
import { AdminNoticeView } from "./admin-notice";

export interface AdminAuthenticatedSurfaceProps {
  initialErpChaos: BackendRead<ErpChaosStatus>;
  initialPresets: BackendRead<AdminPresetListResponse>;
  initialRecovery: BackendRead<DashboardProjection>;
  initialReadiness: BackendRead<HealthResponse>;
  initialRuntimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
}

export function AdminAuthenticatedSurface(props: AdminAuthenticatedSurfaceProps) {
  const recoveryController = useDashboardRecovery(props.initialRecovery);
  const recovery = recoveryController.recovery;
  const [runtimePolicy, setRuntimePolicy] = useState(props.initialRuntimePolicy);

  useEffect(() => {
    setRuntimePolicy((current) =>
      props.initialRuntimePolicy.status === "available" || current.status !== "available"
        ? props.initialRuntimePolicy
        : current,
    );
  }, [props.initialRuntimePolicy]);

  return (
    <div className="grid grid-cols-12 gap-4">
      <AdminCurrentRunPanel
        isPending={recoveryController.isRefreshing}
        isRetryScheduled={recoveryController.isRetryScheduled}
        onRefresh={recoveryController.retryNow}
        recovery={recovery}
        retriesExhausted={recoveryController.retriesExhausted}
        retryAttempt={recoveryController.retryAttempt}
        retryDelayMs={recoveryController.retryDelayMs}
      />
      <AdminReadinessPanel read={props.initialReadiness} />
      <AdminRuntimePolicyController
        initialRuntimePolicy={runtimePolicy}
        latestRuntimePolicyRead={props.initialRuntimePolicy}
        onRuntimePolicyAvailable={setRuntimePolicy}
      />
      <AdminPresetController
        initialPresets={props.initialPresets}
        recovery={recovery}
        runtimePolicy={runtimePolicy}
      />
      <AdminMaintenancePanel onResetComplete={recoveryController.retryNow} />
      <AdminErpDiagnosticsController initialErpChaos={props.initialErpChaos} />
    </div>
  );
}

function AdminReadinessPanel({ read }: { read: BackendRead<HealthResponse> }) {
  const readiness =
    read.status === "available" && read.data.status !== "ok"
      ? read.data.status
      : read.status === "unavailable"
        ? "unavailable"
        : undefined;
  const checks = read.status === "available" ? read.data.checks.slice(0, 8) : [];

  return (
    <section className={`${panelClassName} col-span-4`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Readiness</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Shared dependencies
          </h2>
        </div>
        <StatusPill
          status={{
            label: read.status === "loading" ? "checking" : (readiness ?? "ready"),
            tone: read.status === "loading" ? "idle" : readiness ? "warning" : "ok",
          }}
        />
      </div>
      {readiness ? (
        <ErrorNotice context={{ surface: "admin-read", readiness }} protectedDetails read={read} />
      ) : read.status === "loading" ? (
        <ErrorNotice context="admin-read" read={read} />
      ) : null}
      {checks.length > 0 ? (
        <details className="mt-3 rounded border border-border px-3 py-2 text-sm text-muted-strong">
          <summary className="cursor-pointer font-semibold">Readiness probe details</summary>
          <dl className="mt-2 grid gap-1">
            {checks.map((check) => (
              <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2" key={check.name}>
                <dt>{check.name}</dt>
                <dd className="m-0 [overflow-wrap:anywhere]">
                  {check.status}
                  {check.message ? ` — ${check.message}` : ""}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}

export function AdminCurrentRunPanel({
  isPending,
  isRetryScheduled,
  onRefresh,
  recovery,
  retriesExhausted,
  retryAttempt,
  retryDelayMs,
}: {
  isPending: boolean;
  isRetryScheduled: boolean;
  onRefresh: () => Promise<void>;
  recovery: BackendRead<DashboardProjection>;
  retriesExhausted: boolean;
  retryAttempt: number;
  retryDelayMs: number | null;
}) {
  const startBlocked = isRunStartBlocked(recovery);
  const retryWaitActive = recovery.status === "unavailable" && (recovery.retryAfterMs ?? 0) > 0;

  return (
    <section className={`${panelClassName} col-span-4`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Recovery</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Current run</h2>
        </div>
        <StatusPill
          status={{
            label: currentRunStatus(recovery),
            tone: startBlocked ? "progress" : "idle",
          }}
        />
      </div>
      {recovery.status === "available" ? (
        <dl className="m-0 grid gap-3">
          <Fact label="Run" value={recovery.data.currentRun?.presetName ?? "No active run"} />
          <Fact label="Status" value={recovery.data.currentRun?.status ?? "idle"} />
          <Fact label="Traffic" value={recovery.data.currentRun?.trafficStatus ?? "Not active"} />
          <Fact
            label="Recovered"
            value={formatInstantUtc(recovery.data.recoveredAt) ?? "not yet available"}
          />
        </dl>
      ) : (
        <Unavailable read={recovery} />
      )}
      <button
        className={`${buttonClassName} mt-4`}
        disabled={isPending || retryWaitActive}
        onClick={() => void onRefresh()}
        type="button"
      >
        {isPending ? "Checking Recovery" : "Retry Recovery"}
      </button>
      {isRetryScheduled && retryDelayMs !== null ? (
        <p className="m-0 mt-2 text-sm text-muted">
          Automatic retry {retryAttempt} in {Math.ceil(retryDelayMs / 1_000)} seconds.
        </p>
      ) : retriesExhausted ? (
        <p className="m-0 mt-2 text-sm text-muted">
          Automatic retries paused. Manual retry remains available.
        </p>
      ) : null}
    </section>
  );
}

export function AdminRuntimePolicyController({
  initialRuntimePolicy,
  latestRuntimePolicyRead = initialRuntimePolicy,
  onRuntimePolicyAvailable,
}: {
  initialRuntimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>;
  latestRuntimePolicyRead?: BackendRead<AdminPublicRuntimePolicyResponse>;
  onRuntimePolicyAvailable?: (runtimePolicy: BackendRead<AdminPublicRuntimePolicyResponse>) => void;
}) {
  const router = useRouter();
  const [runtimePolicy, setRuntimePolicy] = useState(initialRuntimePolicy);
  const [latestRead, setLatestRead] = useState(latestRuntimePolicyRead);
  const [draft, setDraft] = useState<RuntimePolicyDraft | null>(
    initialRuntimePolicy.status === "available"
      ? draftFromRuntimePolicy(initialRuntimePolicy.data.policy)
      : null,
  );
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<AdminNotice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, DraftFieldError>>({});
  const [formErrors, setFormErrors] = useState<DraftFormError[]>([]);
  const [showValidationSummary, setShowValidationSummary] = useState(false);
  const [validationSummaryRevision, setValidationSummaryRevision] = useState(0);
  const isDraftDirtyRef = useRef(false);

  useEffect(() => {
    setRuntimePolicy((current) =>
      initialRuntimePolicy.status === "available" || current.status !== "available"
        ? initialRuntimePolicy
        : current,
    );
    if (initialRuntimePolicy.status === "available") {
      setFieldErrors({});
      setFormErrors([]);
      setShowValidationSummary(false);
    }
    if (!isDraftDirtyRef.current && initialRuntimePolicy.status === "available") {
      setDraft(draftFromRuntimePolicy(initialRuntimePolicy.data.policy));
    }
  }, [initialRuntimePolicy]);

  useEffect(() => setLatestRead(latestRuntimePolicyRead), [latestRuntimePolicyRead]);

  async function refresh() {
    setIsPending(true);
    setNotice(null);
    try {
      const result = await readProxyJson(
        adminPublicRuntimePolicyProxyPath,
        adminPublicRuntimePolicyResponseSchema,
      );
      if (isAdminSessionRequired(result)) {
        router.refresh();
        return;
      }
      if (result.status === "available") {
        setRuntimePolicy(result);
        setLatestRead(result);
        onRuntimePolicyAvailable?.(result);
        setDraft(draftFromRuntimePolicy(result.data.policy));
        isDraftDirtyRef.current = false;
        clearValidationState();
      }
      setNotice(
        result.status === "available"
          ? "Public runtime policy refreshed."
          : adminFailureNotice(result),
      );
    } finally {
      setIsPending(false);
    }
  }

  async function save() {
    if (runtimePolicy.status !== "available" || !draft) return;
    const built = buildPolicyFromDraft(draft, runtimePolicy.data.policy);
    if (!built.values) {
      setFieldErrors(built.fieldErrors);
      setFormErrors(built.formErrors);
      setShowValidationSummary(true);
      setValidationSummaryRevision((revision) => revision + 1);
      return;
    }
    const parsed = adminPublicRuntimePolicyUpdateRequestSchema.safeParse({ policy: built.values });
    if (!parsed.success) {
      setNotice(adminValidationMessage());
      return;
    }
    setFieldErrors({});
    setFormErrors([]);
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
      if (isAdminSessionRequired(result)) {
        router.refresh();
        return;
      }
      if (result.status === "available") {
        setRuntimePolicy(result);
        setLatestRead(result);
        onRuntimePolicyAvailable?.(result);
        setDraft(draftFromRuntimePolicy(result.data.policy));
        isDraftDirtyRef.current = false;
        clearValidationState();
      }
      setNotice(
        result.status === "available" ? "Public runtime policy saved." : adminFailureNotice(result),
      );
      if (result.status === "unavailable") {
        setFieldErrors(serverFieldErrors(result.details, "policy"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
      }
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AdminRuntimePolicyView
      draft={draft}
      fieldErrors={fieldErrors}
      formErrors={formErrors}
      isPending={isPending}
      latestRuntimePolicyRead={latestRead}
      notice={notice}
      onBlurField={(field) => {
        if (runtimePolicy.status !== "available" || !draft) return;
        setFieldErrors((current) =>
          replaceFieldError(
            current,
            field,
            buildPolicyFromDraft(draft, runtimePolicy.data.policy).fieldErrors[field],
          ),
        );
      }}
      onRefresh={() => void refresh()}
      onSave={() => void save()}
      onUpdateDraft={(next) => {
        isDraftDirtyRef.current = true;
        if (next.mode !== undefined) clearValidationState();
        else {
          setFieldErrors((current) => clearChangedErrors(current, next));
          setFormErrors([]);
        }
        setDraft((current) => (current ? { ...current, ...next } : null));
      }}
      runtimePolicy={runtimePolicy}
      showValidationSummary={showValidationSummary}
      validationSummaryRevision={validationSummaryRevision}
    />
  );

  function clearValidationState() {
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }
}

export function AdminPresetController({
  initialPresets,
  recovery,
  runtimePolicy,
}: {
  initialPresets: BackendRead<AdminPresetListResponse>;
  recovery: BackendRead<DashboardProjection>;
  runtimePolicy?: BackendRead<AdminPublicRuntimePolicyResponse>;
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
  const [notice, setNotice] = useState<AdminNotice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, DraftFieldError>>({});
  const [formErrors, setFormErrors] = useState<DraftFormError[]>([]);
  const [showValidationSummary, setShowValidationSummary] = useState(false);
  const [validationSummaryRevision, setValidationSummaryRevision] = useState(0);
  const [syncNotice, setSyncNotice] = useState<AdminNotice | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<AdminNotice | null>(null);
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
      setFieldErrors({});
      setFormErrors([]);
      setShowValidationSummary(false);
      return;
    }
    const switchedPreset = draftSlugRef.current !== selectedPreset.slug;
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
    if (!switchedPreset && isDraftDirtyRef.current) return;
    setDraft(draftFromPreset(selectedPreset));
    draftSlugRef.current = selectedPreset.slug;
    isDraftDirtyRef.current = false;
    if (switchedPreset) setDuplicateTargetSlug(`${selectedPreset.slug}-copy`);
  }, [selectedPreset]);

  useEffect(() => {
    if (runtimePolicy?.status !== "available") return;
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }, [runtimePolicy]);

  async function start() {
    if (!selectedPreset || !draft) return;
    const built = buildConfigFromDraft(
      draft,
      selectedPreset,
      runtimePolicy?.status === "available" ? runtimePolicy.data.policy : undefined,
    );
    if (!built.values) {
      setFieldErrors(built.fieldErrors);
      setFormErrors(built.formErrors);
      setShowValidationSummary(true);
      setValidationSummaryRevision((revision) => revision + 1);
      return;
    }
    const parsed = startDemoRunRequestSchema.safeParse({
      presetSlug: selectedPreset.slug,
      configOverride: built.values,
    });
    if (!parsed.success) {
      setNotice(adminValidationMessage());
      return;
    }
    setFieldErrors({});
    setFormErrors([]);
    await withPending(async () => {
      const result = await readProxyJson(adminDemoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (isAdminSessionRequired(result)) {
        router.refresh();
        return;
      }
      setNotice(result.status === "available" ? "Admin run accepted." : adminFailureNotice(result));
      if (result.status === "unavailable") {
        setFieldErrors(serverFieldErrors(result.details, "preset"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
      }
    });
  }

  async function save() {
    if (!selectedPreset || !draft) return;
    const built = buildConfigFromDraft(
      draft,
      selectedPreset,
      runtimePolicy?.status === "available" ? runtimePolicy.data.policy : undefined,
    );
    const sortOrder = buildSortOrder(draft.sortOrder);
    if (!built.values || sortOrder.values === undefined) {
      setFieldErrors({ ...built.fieldErrors, ...sortOrder.fieldErrors });
      setFormErrors([...built.formErrors, ...sortOrder.formErrors]);
      setShowValidationSummary(true);
      setValidationSummaryRevision((revision) => revision + 1);
      return;
    }
    const parsed = saveDemoPresetRequestSchema.safeParse({
      slug: selectedPreset.slug,
      display: {
        ...selectedPreset.display,
        name: draft.displayName,
        description: draft.description,
        sortOrder: sortOrder.values,
      },
      ...built.values,
    });
    if (!parsed.success) {
      setNotice(adminValidationMessage());
      return;
    }
    setFieldErrors({});
    setFormErrors([]);
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
      setNotice(adminValidationMessage());
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
      setNotice(adminValidationMessage());
      return;
    }
    await mutate(adminPresetCopyToCustomProxyPath, parsed.data, "Custom updated.");
  }

  async function archive() {
    if (!selectedPreset?.canArchive) return;
    const parsed = archiveAdminPresetRequestSchema.safeParse({ slug: selectedPreset.slug });
    if (!parsed.success) {
      setNotice(adminValidationMessage());
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
        if (isAdminSessionRequired(archived)) {
          setArchiveOpen(false);
          router.refresh();
          return;
        }
        if (
          archived.errorCode === "preset_conflict" &&
          archived.details?.conflictReason === "not_archivable"
        ) {
          setPresetsRead((current) =>
            current.status === "available"
              ? {
                  ...current,
                  data: {
                    ...current.data,
                    presets: current.data.presets.map((preset) =>
                      preset.slug === selectedPreset.slug
                        ? { ...preset, canArchive: false }
                        : preset,
                    ),
                  },
                }
              : current,
          );
          setNotice(adminFailureNotice(archived));
          setArchiveOpen(false);
          setArchiveError(null);
          return;
        }
        setArchiveError(adminFailureNotice(archived));
        return;
      }

      const remainingAfterArchive = presets.filter((preset) => preset.slug !== archived.data.slug);
      const nextAfterArchive = remainingAfterArchive[0] ?? null;
      setPresetsRead(localPresetListRead(remainingAfterArchive, archived.data.timestamp));
      setSelectedSlug(nextAfterArchive?.slug ?? null);
      draftSlugRef.current = nextAfterArchive?.slug ?? null;
      isDraftDirtyRef.current = false;
      setDraft(nextAfterArchive ? draftFromPreset(nextAfterArchive) : null);
      setDuplicateTargetSlug(nextAfterArchive ? `${nextAfterArchive.slug}-copy` : "");
      setNotice("Preset archived.");
      setSyncNotice(null);
      setArchiveOpen(false);
      setArchiveError(null);

      const refreshed = await readProxyJson(
        adminPresetListProxyPath,
        adminPresetListResponseSchema,
      );
      if (refreshed.status !== "available") {
        if (isAdminSessionRequired(refreshed)) {
          router.refresh();
          return;
        }
        setSyncNotice(adminFailureNotice(refreshed));
        return;
      }
      setPresetsRead(refreshed);
      const refreshedRemaining = refreshed.data.presets;
      const nextRefreshed = refreshedRemaining[0] ?? null;
      setSelectedSlug(nextRefreshed?.slug ?? null);
      draftSlugRef.current = nextRefreshed?.slug ?? null;
      isDraftDirtyRef.current = false;
      setDraft(nextRefreshed ? draftFromPreset(nextRefreshed) : null);
      setDuplicateTargetSlug(nextRefreshed ? `${nextRefreshed.slug}-copy` : "");
    });
  }

  async function mutate(path: string, body: unknown, successNotice: string) {
    await withPending(async () => {
      const mutation = await readProxyJson(path, adminPresetMutationResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (isAdminSessionRequired(mutation)) {
        router.refresh();
        return;
      }
      if (mutation.status !== "available") {
        setFieldErrors(serverFieldErrors(mutation.details, "preset"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
        setNotice(adminFailureNotice(mutation));
        return;
      }
      const currentCapability = presets.find(
        (preset) => preset.slug === mutation.data.preset.slug,
      )?.canArchive;
      const localPreset = {
        ...mutation.data.preset,
        canArchive: currentCapability ?? false,
      };
      const localPresets = presets.some((preset) => preset.slug === localPreset.slug)
        ? presets.map((preset) => (preset.slug === localPreset.slug ? localPreset : preset))
        : [...presets, localPreset];
      setPresetsRead(localPresetListRead(localPresets, mutation.data.timestamp));
      setSelectedSlug(localPreset.slug);
      setDraft(draftFromPreset(localPreset));
      draftSlugRef.current = localPreset.slug;
      isDraftDirtyRef.current = false;
      clearValidationState();
      setNotice(successNotice);
      setSyncNotice(null);
      const refreshed = await readProxyJson(
        adminPresetListProxyPath,
        adminPresetListResponseSchema,
      );
      if (refreshed.status !== "available") {
        if (isAdminSessionRequired(refreshed)) {
          router.refresh();
          return;
        }
        setSyncNotice(adminFailureNotice(refreshed));
        return;
      }
      setPresetsRead(refreshed);
    });
  }

  async function withPending(operation: () => Promise<void>) {
    setIsPending(true);
    setNotice(null);
    setSyncNotice(null);
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
        fieldErrors={fieldErrors}
        formErrors={formErrors}
        hardCaps={
          runtimePolicy?.status === "available"
            ? runtimePolicy.data.policy.deploymentHardCaps
            : undefined
        }
        duplicateTargetSlug={duplicateTargetSlug}
        isPending={isPending}
        notice={notice}
        onBlurField={(field) => {
          if (!selectedPreset || !draft) return;
          const built = buildConfigFromDraft(
            draft,
            selectedPreset,
            runtimePolicy?.status === "available" ? runtimePolicy.data.policy : undefined,
          );
          const error =
            field === "sortOrder"
              ? buildSortOrder(draft.sortOrder).fieldErrors.sortOrder
              : built.fieldErrors[field];
          setFieldErrors((current) => replaceFieldError(current, field, error));
        }}
        syncNotice={syncNotice}
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
          if (next.mode !== undefined) clearValidationState();
          else {
            setFieldErrors((current) => clearChangedErrors(current, next));
            setFormErrors([]);
          }
          setDraft((current) => (current ? { ...current, ...next } : null));
        }}
        presets={presets}
        presetsRead={presetsRead}
        selectedPreset={selectedPreset}
        showValidationSummary={showValidationSummary}
        validationSummaryRevision={validationSummaryRevision}
        startBlocked={isRunStartBlocked(recovery)}
      />
      <ConfirmationDialog
        confirmLabel="Archive preset"
        description={`Archive the "${selectedPreset?.display.name ?? "selected"}" preset. It will leave the active list while historical runs are retained.`}
        error={archiveError ? <AdminNoticeView notice={archiveError} /> : null}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => void archive()}
        open={archiveOpen}
        pending={isPending}
        title="Archive this preset?"
      />
    </>
  );

  function clearValidationState() {
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }
}

export function AdminMaintenancePanel({
  onResetComplete,
}: {
  onResetComplete: () => Promise<void>;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<AdminNotice | null>(null);
  const [intent, setIntent] = useState<"reset" | "cleanup" | null>(null);
  const [error, setError] = useState<AdminNotice | null>(null);

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
        if (isAdminSessionRequired(result)) {
          setIntent(null);
          router.refresh();
        } else {
          setError(adminFailureNotice(result));
          if (intent === "reset") await onResetComplete();
        }
        return;
      }
      if (intent === "reset" && "failedRunCount" in result.data) {
        setNotice(
          `Reset complete: ${formatMaintenanceCount(result.data.failedRunCount)} runs failed, ${formatMaintenanceCount(result.data.cleanedJobCount)} jobs cleaned.`,
        );
        await onResetComplete();
      } else if ("deletedRunCount" in result.data) {
        setNotice(
          `Cleanup complete: ${formatMaintenanceCount(result.data.deletedRunCount)} generated runs removed.`,
        );
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
      <AdminNoticeView notice={notice} />
      <ConfirmationDialog
        confirmLabel={intent === "reset" ? "Reset demo" : "Cleanup generated runs"}
        description={
          intent === "reset"
            ? "Fail active demo work, clear queued jobs, and reset shared demo state. This disrupts current visitors."
            : "Permanently remove generated runs older than 7 days while keeping the latest 15."
        }
        error={error ? <AdminNoticeView notice={error} /> : null}
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
  const [latestErpChaosRead, setLatestErpChaosRead] = useState(initialErpChaos);
  const [draft, setDraft] = useState(() => erpDraftFromRead(initialErpChaos));
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<AdminNotice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, DraftFieldError>>({});
  const [formErrors, setFormErrors] = useState<DraftFormError[]>([]);
  const [showValidationSummary, setShowValidationSummary] = useState(false);
  const [validationSummaryRevision, setValidationSummaryRevision] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetError, setResetError] = useState<AdminNotice | null>(null);
  const isDraftDirtyRef = useRef(false);

  useEffect(() => {
    setLatestErpChaosRead(initialErpChaos);
    setErpChaos((current) =>
      initialErpChaos.status === "available" || current.status !== "available"
        ? initialErpChaos
        : current,
    );
    if (initialErpChaos.status === "available") {
      setFieldErrors({});
      setFormErrors([]);
      setShowValidationSummary(false);
    }
    if (!isDraftDirtyRef.current && initialErpChaos.status === "available") {
      setDraft(erpDraftFromRead(initialErpChaos));
    }
  }, [initialErpChaos]);

  async function submit(path: string, init: RequestInit) {
    setIsPending(true);
    setNotice(null);
    try {
      const result = await readProxyJson(path, erpChaosStatusSchema, init);
      if (isAdminSessionRequired(result)) {
        setResetOpen(false);
        router.refresh();
        return;
      }
      if (path === adminErpChaosResetProxyPath && result.status === "unavailable") {
        setResetError(adminFailureNotice(result));
        return;
      }
      if (result.status === "available") {
        setErpChaos(result);
        setLatestErpChaosRead(result);
        setDraft(erpDraftFromRead(result));
        isDraftDirtyRef.current = false;
        clearValidationState();
      }
      setNotice(
        result.status === "available"
          ? path === adminErpChaosResetProxyPath
            ? "ERP diagnostics reset."
            : "ERP diagnostics updated."
          : adminFailureNotice(result),
      );
      if (result.status === "unavailable") {
        setFieldErrors(serverFieldErrors(result.details, "erp"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
      }
      if (path === adminErpChaosResetProxyPath) setResetOpen(false);
    } finally {
      setIsPending(false);
    }
  }

  function apply() {
    if (erpChaos.status !== "available") return;
    const built = buildErpChaosFromDraft(draft, erpChaos.data.effectiveSafetyCaps);
    if (!built.values) {
      setFieldErrors(built.fieldErrors);
      setFormErrors(built.formErrors);
      setShowValidationSummary(true);
      setValidationSummaryRevision((revision) => revision + 1);
      return;
    }
    const parsed = erpChaosConfigSchema.safeParse(built.values);
    if (!parsed.success) {
      setNotice(adminValidationMessage());
      return;
    }
    setFieldErrors({});
    setFormErrors([]);
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
        fieldErrors={fieldErrors}
        formErrors={formErrors}
        forcedOutage={draft.forcedOutage}
        isPending={isPending}
        latencyMs={draft.latencyMs}
        latestErpChaosRead={latestErpChaosRead}
        maxTps={draft.maxTps}
        notice={notice}
        onBlurField={(field) => {
          if (erpChaos.status !== "available") return;
          setFieldErrors((current) =>
            replaceFieldError(
              current,
              field,
              buildErpChaosFromDraft(draft, erpChaos.data.effectiveSafetyCaps).fieldErrors[field],
            ),
          );
        }}
        onApply={apply}
        onErrorRateChange={(errorRate) => updateErpDraft({ errorRate })}
        onForcedOutageChange={(forcedOutage) => updateErpDraft({ forcedOutage })}
        onLatencyMsChange={(latencyMs) => updateErpDraft({ latencyMs })}
        onMaxTpsChange={(maxTps) => updateErpDraft({ maxTps })}
        onReset={() => {
          setResetError(null);
          setResetOpen(true);
        }}
        showValidationSummary={showValidationSummary}
        validationSummaryRevision={validationSummaryRevision}
      />
      <ConfirmationDialog
        confirmLabel="Reset ERP controls"
        description="Reset the shared ERP latency, throughput, error-rate, and outage controls to their defaults."
        error={resetError ? <AdminNoticeView notice={resetError} /> : null}
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
    setFieldErrors((current) => clearChangedErrors(current, next));
    setFormErrors([]);
    setDraft((current) => ({ ...current, ...next }));
  }

  function clearValidationState() {
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
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

function isRunStartBlocked(recovery: BackendRead<DashboardProjection>): boolean {
  if (recovery.status !== "available") return true;
  const status = recovery.data.currentRun?.status;
  return status === "starting" || status === "active" || status === "draining";
}

function adminValidationMessage(): string {
  const presentation = mapErrorPresentation(
    { status: "unavailable", errorCode: "invalid_request" },
    "admin-operation",
  );
  return [presentation.headline, presentation.explanation].filter(Boolean).join(". ");
}

function isAdminSessionRequired(read: BackendRead<unknown>): boolean {
  return read.status === "unavailable" && read.errorCode === "admin_session_required";
}

function localPresetListRead(
  presets: AdminPresetListItem[],
  timestamp: string,
): BackendRead<AdminPresetListResponse> {
  return {
    status: "available",
    data: { presets, timestamp },
    httpStatus: 200,
  };
}

/** Maintenance receipts report counts, so they group like every other count on the product. */
function formatMaintenanceCount(value: number): string {
  return formatCount(value) ?? "an unreported number of";
}

function clearChangedErrors(
  current: Record<string, DraftFieldError>,
  changed: object,
): Record<string, DraftFieldError> {
  const next = { ...current };
  for (const field of Object.keys(changed)) delete next[field];
  return next;
}

function replaceFieldError(
  current: Record<string, DraftFieldError>,
  field: string,
  error: DraftFieldError | undefined,
): Record<string, DraftFieldError> {
  const next = { ...current };
  if (error) next[field] = error;
  else delete next[field];
  return next;
}

type ServerFieldContext = "policy" | "preset" | "erp";

const trafficServerFields = new Set([
  "buyerCount",
  "duplicateEachBuyerAttempt",
  "durationSeconds",
  "maxDurationSeconds",
  "maxVus",
  "mode",
  "preAllocatedVus",
  "ratePerSecond",
  "startDelaySeconds",
]);
const inventoryServerFields = new Set([
  "quantityPerCheckout",
  "reservationHoldMinutes",
  "startingStock",
]);
const erpConfigServerFields = new Set([
  "erpErrorRate",
  "erpForcedOutage",
  "erpLatencyMs",
  "erpMaxTps",
  "erpRequestTimeoutMs",
]);
const backpressureServerFields = new Set([
  "circuitBreakerFailureThreshold",
  "circuitBreakerResetTimeoutMs",
  "drainTimeoutSeconds",
  "orderProcessConcurrency",
  "pendingPersistenceRetryAfterSeconds",
]);
const policyLimitServerFields = new Set([
  "allowBuyerSpike",
  "allowConstantArrivalRate",
  "allowForcedOutage",
  "maxBuyers",
  "maxErpErrorRate",
  "maxErpLatencyMs",
  "maxErpMaxTps",
  "maxPreAllocatedVus",
  "maxPublicVus",
  "maxRequestsPerSecond",
  "maxStartingStock",
  "maxTotalRequests",
  "maxTrafficDurationSeconds",
  "maxTrafficStartDelaySeconds",
  "minErpMaxTps",
]);
const erpServerFields = new Set(["errorRate", "forcedOutage", "latencyMs", "maxTps"]);

export function serverFieldErrors(
  details: Record<string, unknown> | undefined,
  context: ServerFieldContext,
): Record<string, DraftFieldError> {
  const errors: Record<string, DraftFieldError> = {};
  for (const path of serverFieldPaths(details, context)) {
    const field = serverDraftField(path, context);
    if (!field) continue;
    errors[field] = {
      code: "server_rejected",
      message: "The service rejected this value. Review its permitted range and try again.",
    };
  }
  return errors;
}

function serverFieldPaths(
  details: Record<string, unknown> | undefined,
  context: ServerFieldContext,
): string[][] {
  if (!details) return [];
  const paths: string[][] = [];
  if (Array.isArray(details.issues)) {
    for (const issue of details.issues) {
      const path =
        issue && typeof issue === "object" ? (issue as { path?: unknown }).path : undefined;
      if (isStringPath(path)) paths.push(path);
    }
  }
  if (isStringPath(details.path)) paths.push(details.path);
  if (context === "erp") {
    for (const field of erpServerFields) {
      const violation = details[field];
      if (violation && typeof violation === "object" && !Array.isArray(violation)) {
        paths.push([field]);
      }
    }
  }
  return paths;
}

function isStringPath(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string");
}

function serverDraftField(path: string[], context: ServerFieldContext): string | undefined {
  const rawField = path.at(-1);
  if (!rawField) return undefined;
  if (context === "erp") {
    return path.length === 1 && erpServerFields.has(rawField) ? rawField : undefined;
  }
  let field = rawField;
  if (context === "preset" && path.includes("display") && rawField === "name") {
    field = "displayName";
  } else if (path.includes("erpConfig")) {
    field =
      rawField === "latencyMs"
        ? "erpLatencyMs"
        : rawField === "maxTps"
          ? "erpMaxTps"
          : rawField === "errorRate"
            ? "erpErrorRate"
            : rawField === "forcedOutage"
              ? "erpForcedOutage"
              : rawField === "requestTimeoutMs"
                ? "erpRequestTimeoutMs"
                : rawField;
  } else if (context === "policy" && path.includes("publicRunBudget")) {
    field =
      rawField === "windowSeconds"
        ? "budgetWindowSeconds"
        : rawField === "perVisitorMaxStarts"
          ? "perVisitorMaxStarts"
          : rawField === "globalMaxStarts"
            ? "globalMaxStarts"
            : rawField;
  } else if (context === "policy" && path.includes("publicCustomLimits")) {
    field =
      rawField === "maxVus"
        ? "maxPublicVus"
        : rawField === "allowForcedOutage"
          ? "allowForcedOutage"
          : rawField;
  }
  if (context === "preset" && path.includes("display")) {
    return ["description", "displayName", "sortOrder"].includes(field) ? field : undefined;
  }
  if (context === "policy" && path.includes("publicRunBudget")) {
    return ["budgetWindowSeconds", "globalMaxStarts", "perVisitorMaxStarts"].includes(field)
      ? field
      : undefined;
  }
  if (context === "policy" && path.includes("publicCustomLimits")) {
    return policyLimitServerFields.has(field) ? field : undefined;
  }
  if (context === "policy" && !path.includes("publicCustomDefaults")) return undefined;
  if (path.includes("trafficConfig")) {
    return trafficServerFields.has(field) ? field : undefined;
  }
  if (path.includes("inventoryConfig")) {
    return inventoryServerFields.has(field) ? field : undefined;
  }
  if (path.includes("erpConfig")) {
    return erpConfigServerFields.has(field) ? field : undefined;
  }
  if (path.includes("backpressureConfig")) {
    return backpressureServerFields.has(field) ? field : undefined;
  }
  return undefined;
}
