"use client";

import {
  type AcceptedRunConfigSnapshot,
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
  type DemoRunSnapshot,
  duplicateDemoPresetRequestSchema,
  type ErpChaosConfig,
  type ErpChaosStatus,
  erpChaosConfigSchema,
  erpChaosStatusSchema,
  estimateAdmissionRejectionDetailsSchema,
  type HealthResponse,
  type PublicRuntimePolicy,
  type PublicRuntimePolicyMutable,
  type StartDemoRunRequest,
  saveDemoPresetRequestSchema,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  buildEffectiveRunConfig,
  buildErpChaosFromDraft,
  buildPolicyFromDraft,
  buildSortOrder,
  type DraftFieldError,
  type DraftFormError,
  draftFromPreset,
  draftFromRuntimePolicy,
  isPresetDraftDirty,
  type PresetDraft,
  presetContractDraftErrors,
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
import { adminFieldHints } from "../../lib/presentation/field-hints";
import { formatCount, formatInstantUtc } from "../../lib/presentation/format";
import {
  dashboardUpdateExpected,
  deriveFreshness,
  type Freshness,
  type RealtimeConnectionStatus,
} from "../../lib/presentation/freshness";
import { ratioToPercent } from "../../lib/presentation/percent";
import { deriveFreshnessPresentationState } from "../../lib/presentation/run-presentation-state";
import { ConfirmationDialog } from "../confirmation-dialog";
import { buttonClassName } from "../control-styles";
import { RealtimeRecoveryNotice } from "../dashboard-panels";
import { ErrorNotice } from "../error-notice";
import { FieldHint } from "../field-hint";
import { useDashboardProjections } from "../realtime/use-dashboard-projections";
import { useDashboardRecovery } from "../realtime/use-dashboard-recovery";
import { RunEstimateNotice } from "../run-estimate-notice";
import { StatusPill } from "../status-pill";
import { useRunEstimate } from "../use-run-estimate";
import {
  AdminErpDiagnosticsView,
  AdminPresetView,
  AdminRuntimePolicyView,
  currentRunStatus,
  EffectiveChangeList,
  EffectiveRunPreview,
  eyebrowClassName,
  Fact,
  panelClassName,
  panelTitleClassName,
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
  const recoveryController = useDashboardRecovery(props.initialRecovery, {
    preserveAvailableRecoveryOnFailure: true,
  });
  const recovery = recoveryController.recovery;
  const firstOpenRef = useRef(true);
  const handleOpen = useCallback(() => {
    recoveryController.notifyRealtimeReopened();
    if (firstOpenRef.current) {
      firstOpenRef.current = false;
      if (props.initialRecovery.status === "loading") return;
    }
    void recoveryController.refresh();
  }, [
    props.initialRecovery.status,
    recoveryController.refresh,
    recoveryController.notifyRealtimeReopened,
  ]);
  const { status: realtimeStatus, reconnectExhausted } = useDashboardProjections({
    onProjection: recoveryController.applyProjection,
    onOpen: handleOpen,
    onDisconnect: () => void recoveryController.notifyRealtimeDisconnected(),
  });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 2_000);
    return () => clearInterval(interval);
  }, []);
  const freshness = deriveAdminFreshness(recovery, realtimeStatus, now);
  const hasReadFailure = recovery.status === "unavailable" || recoveryController.hasSyncIssue;
  const startBlocked = isRunStartBlocked(recovery, freshness, hasReadFailure);
  const startBlockedReason = runStartBlockedReason(recovery, freshness, hasReadFailure);
  const hasPreservedAvailableRetryScheduled =
    recovery.status === "available" &&
    recoveryController.hasSyncIssue &&
    recoveryController.isRetryScheduled;
  const isRefreshDisabled =
    recoveryController.isRefreshing ||
    hasPreservedAvailableRetryScheduled ||
    (recovery.status === "unavailable" && (recovery.retryAfterMs ?? 0) > 0);
  const refreshDisabledReason = hasPreservedAvailableRetryScheduled
    ? "Wait for the automatic retry countdown before refreshing."
    : undefined;
  const [runtimePolicy, setRuntimePolicy] = useState(props.initialRuntimePolicy);

  useEffect(() => {
    setRuntimePolicy((current) =>
      props.initialRuntimePolicy.status === "available" || current.status !== "available"
        ? props.initialRuntimePolicy
        : current,
    );
  }, [props.initialRuntimePolicy]);

  return (
    <div className="grid grid-cols-[11rem_minmax(0,1fr)] items-start gap-6 max-[1100px]:grid-cols-1">
      <nav
        aria-label="Admin console sections"
        className="sticky top-20 grid gap-0.5 text-sm max-[1100px]:static max-[1100px]:flex max-[1100px]:gap-1 max-[1100px]:overflow-x-auto max-[1100px]:pb-1"
      >
        {adminSections.map(([id, label]) => (
          <a
            className="rounded-md border-l-2 border-border py-1.5 pl-3 text-muted-strong [overflow-wrap:anywhere] hover:border-accent hover:text-ink max-[1100px]:shrink-0 max-[1100px]:rounded-full max-[1100px]:border max-[1100px]:bg-surface max-[1100px]:px-3 max-[1100px]:[overflow-wrap:normal]"
            href={`#${id}`}
            key={id}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
        <RealtimeRecoveryNotice
          className="lg:col-span-2"
          realtimeStatus={realtimeStatus}
          reconnectExhausted={reconnectExhausted}
        />
        <AdminCurrentRunPanel
          isPending={recoveryController.isRefreshing}
          isRefreshDisabled={isRefreshDisabled}
          isRetryScheduled={recoveryController.isRetryScheduled}
          onRefresh={recoveryController.retryNow}
          recovery={recovery}
          refreshDisabledReason={refreshDisabledReason}
          freshness={freshness}
          hasSyncIssue={recoveryController.hasSyncIssue}
          retriesExhausted={recoveryController.retriesExhausted}
          retryAttempt={recoveryController.retryAttempt}
          retryDelayMs={recoveryController.retryDelayMs}
          syncIssue={recoveryController.syncIssue}
        />
        <AdminReadinessPanel read={props.initialReadiness} />
        <AdminRoutineActions
          isRefreshDisabled={isRefreshDisabled}
          isRefreshing={recoveryController.isRefreshing}
          onRefresh={recoveryController.retryNow}
          refreshDisabledReason={refreshDisabledReason}
        />
        <AdminPresetController
          initialPresets={props.initialPresets}
          onStartComplete={recoveryController.retryNow}
          recovery={recovery}
          runtimePolicy={runtimePolicy}
          startBlocked={startBlocked}
          startBlockedReason={startBlockedReason}
        />
        <AdminErpDiagnosticsController
          runState={
            recovery.status !== "available"
              ? "unavailable"
              : isRunInProgress(recovery.data.currentRun?.status)
                ? "active"
                : "inactive"
          }
          initialErpChaos={props.initialErpChaos}
          runErpConfig={
            recovery.status === "available"
              ? recovery.data.currentRun?.configSnapshot.erpConfig
              : undefined
          }
        />
        <AdminMaintenancePanel
          onResetComplete={recoveryController.retryNow}
          incomplete={
            recovery.status === "available" && recovery.data.resetRecovery === "incomplete"
          }
        />
        <AdminRuntimePolicyController
          initialRuntimePolicy={runtimePolicy}
          latestRuntimePolicyRead={props.initialRuntimePolicy}
          onRuntimePolicyAvailable={setRuntimePolicy}
        />
        <AdminDiagnosticsLinks />
      </div>
    </div>
  );
}

const adminSections = [
  ["current-run", "Current run"],
  ["readiness", "Readiness"],
  ["routine-actions", "Routine actions"],
  ["presets", "Presets"],
  ["erp-fault-injection", "ERP fault injection"],
  ["maintenance", "Maintenance"],
  ["public-runtime-policy", "Public runtime policy"],
  ["diagnostics-links", "Diagnostics"],
] as const;

function AdminRoutineActions({
  isRefreshDisabled,
  isRefreshing,
  onRefresh,
  refreshDisabledReason,
}: {
  isRefreshDisabled: boolean;
  isRefreshing: boolean;
  onRefresh: () => Promise<void>;
  refreshDisabledReason?: string | undefined;
}) {
  const refreshDisabledReasonId = useId();

  return (
    <section
      className={`${panelClassName} flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 lg:col-span-2`}
      id="routine-actions"
    >
      <div>
        <h2 className="type-title m-0 text-base leading-tight text-ink">Routine actions</h2>
        <p className="m-0 mt-0.5 text-sm text-muted">
          Review shared state before using the controls in each section.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <div>
          <button
            aria-describedby={refreshDisabledReason ? refreshDisabledReasonId : undefined}
            className={buttonClassName}
            disabled={isRefreshDisabled}
            onClick={() => void onRefresh()}
            type="button"
          >
            {isRefreshing ? "Refreshing current run" : "Refresh current run"}
          </button>
          {refreshDisabledReason ? (
            <p
              className="m-0 mt-1 max-w-64 text-xs leading-4 text-muted"
              id={refreshDisabledReasonId}
            >
              {refreshDisabledReason}
            </p>
          ) : null}
        </div>
        <a className={buttonClassName} href="#presets">
          Start from a preset
        </a>
        <a className={buttonClassName} href="#maintenance">
          Reset or clean up
        </a>
      </div>
    </section>
  );
}

function AdminDiagnosticsLinks() {
  return (
    <section
      className={`${panelClassName} flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4 lg:col-span-2`}
      id="diagnostics-links"
    >
      <h2 className="type-title m-0 text-base leading-tight text-ink">Diagnostics links</h2>
      <div className="flex flex-wrap gap-2">
        <a className={buttonClassName} href="/watch">
          Live dashboard
        </a>
        <a className={buttonClassName} href="/run-history">
          Run history
        </a>
      </div>
    </section>
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
    <section className={panelClassName} id="readiness">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className={eyebrowClassName}>Readiness</p>
          <h2 className={panelTitleClassName}>
            Shared dependencies{" "}
            <FieldHint label="Shared dependencies" text={adminFieldHints.sharedDependencies} />
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
        <details className="mt-3 rounded-xl border border-border px-4 py-3 text-sm text-muted-strong">
          <summary className="disclosure font-semibold text-ink">Readiness probe details</summary>
          <dl className="mb-0 mt-2 grid gap-1">
            {checks.map((check) => (
              <div
                className="grid grid-cols-[minmax(8rem,auto)_minmax(0,1fr)] gap-3"
                key={check.name}
              >
                <dt className="font-medium text-ink">{check.name}</dt>
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
  isRefreshDisabled,
  isRetryScheduled,
  onRefresh,
  recovery,
  refreshDisabledReason,
  freshness,
  hasSyncIssue,
  retriesExhausted,
  retryAttempt,
  retryDelayMs,
  syncIssue,
}: {
  isPending: boolean;
  isRefreshDisabled: boolean;
  isRetryScheduled: boolean;
  onRefresh: () => Promise<void>;
  recovery: BackendRead<DashboardProjection>;
  refreshDisabledReason?: string | undefined;
  freshness: Freshness;
  hasSyncIssue: boolean;
  retriesExhausted: boolean;
  retryAttempt: number;
  retryDelayMs: number | null;
  syncIssue: BackendRead<DashboardProjection> | null;
}) {
  const refreshDisabledReasonId = useId();
  const startBlocked = isRunStartBlocked(recovery, freshness, hasSyncIssue);
  const readFailed = recovery.status === "unavailable" || hasSyncIssue;
  const presentedFreshness =
    readFailed && freshness.state !== "disconnected" && freshness.state !== "unsupported"
      ? { ...freshness, state: "stale" as const }
      : freshness;
  const freshnessPresentation = deriveFreshnessPresentationState(presentedFreshness);

  return (
    <section className={panelClassName} id="current-run">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className={eyebrowClassName}>Live status</p>
          <h2 className={panelTitleClassName}>
            Current run <FieldHint label="Current run" text={adminFieldHints.currentRun} />
          </h2>
        </div>
        <StatusPill
          status={
            presentedFreshness.state === "live" ||
            presentedFreshness.state === "retained-fresh" ||
            presentedFreshness.state === "not-applicable"
              ? {
                  label: currentRunStatus(recovery),
                  tone: startBlocked ? "progress" : "idle",
                }
              : freshnessPresentation
          }
        />
      </div>
      {recovery.status === "available" ? (
        <>
          <p className="m-0 mb-3 text-sm font-medium text-muted-strong" role="status">
            Traffic: {recovery.data.currentRun?.trafficStatus ?? "not active"}
          </p>
          <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
            <Fact label="Run" value={recovery.data.currentRun?.presetName ?? "No active run"} />
            <Fact label="Status" value={recovery.data.currentRun?.status ?? "idle"} />
            <Fact
              label="Last updated"
              value={`${formatInstantUtc(recovery.data.recoveredAt) ?? "not yet available"}${freshnessSuffix(presentedFreshness)}`}
            />
          </dl>
        </>
      ) : (
        <Unavailable read={recovery} />
      )}
      {syncIssue ? <Unavailable read={syncIssue} /> : null}
      <button
        aria-describedby={refreshDisabledReason ? refreshDisabledReasonId : undefined}
        className={`${buttonClassName} mt-4`}
        disabled={isRefreshDisabled}
        onClick={() => void onRefresh()}
        type="button"
      >
        {isPending
          ? readFailed
            ? "Retrying recovery"
            : "Refreshing status"
          : readFailed
            ? "Retry recovery"
            : "Refresh status"}
      </button>
      {refreshDisabledReason ? (
        <p className="m-0 mt-1 max-w-64 text-xs leading-4 text-muted" id={refreshDisabledReasonId}>
          {refreshDisabledReason}
        </p>
      ) : null}
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
  const [proposedPolicy, setProposedPolicy] = useState<PublicRuntimePolicyMutable | null>(null);
  const [saveError, setSaveError] = useState<AdminNotice | null>(null);
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

  function save() {
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
    setSaveError(null);
    setProposedPolicy(parsed.data.policy);
  }

  async function confirmSave() {
    if (!proposedPolicy) return;
    setIsPending(true);
    setNotice(null);
    try {
      const result = await readProxyJson(
        adminPublicRuntimePolicyProxyPath,
        adminPublicRuntimePolicyResponseSchema,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ policy: proposedPolicy }),
        },
      );
      if (isAdminSessionRequired(result)) {
        setProposedPolicy(null);
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
        setProposedPolicy(null);
        setSaveError(null);
      }
      setNotice(result.status === "available" ? "Public runtime policy saved." : null);
      if (result.status === "unavailable") {
        setSaveError(adminFailureNotice(result));
        setFieldErrors(serverFieldErrors(result.details, "policy"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
      }
    } finally {
      setIsPending(false);
    }
  }

  return (
    <>
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
        onSave={save}
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
      <ConfirmationDialog
        confirmLabel="Save public policy"
        tone="default"
        description="This shared public policy governs future public starts; already accepted runs are unaffected."
        error={saveError ? <AdminNoticeView notice={saveError} /> : null}
        onCancel={() => {
          setProposedPolicy(null);
          setSaveError(null);
        }}
        onConfirm={() => void confirmSave()}
        open={proposedPolicy !== null}
        pending={isPending}
        title="Save the public runtime policy?"
      >
        {runtimePolicy.status === "available" && proposedPolicy ? (
          <EffectiveChangeList
            changes={policyChangeSummary(runtimePolicy.data.policy, proposedPolicy)}
          />
        ) : null}
      </ConfirmationDialog>
    </>
  );

  function clearValidationState() {
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }
}

export function AdminPresetController({
  initialPresets,
  onStartComplete,
  recovery,
  runtimePolicy,
  startBlocked,
  startBlockedReason,
}: {
  initialPresets: BackendRead<AdminPresetListResponse>;
  onStartComplete?: () => Promise<void>;
  recovery: BackendRead<DashboardProjection>;
  runtimePolicy?: BackendRead<AdminPublicRuntimePolicyResponse>;
  startBlocked?: boolean;
  startBlockedReason?: string | undefined;
}) {
  const router = useRouter();
  const [acceptedRun, setAcceptedRun] = useState<DemoRunSnapshot | null>(null);
  const acceptedRecoveryRef = useRef(recovery);
  const initialPreset =
    initialPresets.status === "available" ? initialPresets.data.presets[0] : null;
  const [presetsRead, setPresetsRead] = useState(initialPresets);
  const [effectiveRuntimePolicy, setEffectiveRuntimePolicy] = useState(runtimePolicy);
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
  const [startConfirmation, setStartConfirmation] = useState<{
    request: StartDemoRunRequest;
    config: AcceptedRunConfigSnapshot;
  } | null>(null);
  const [startError, setStartError] = useState<AdminNotice | null>(null);
  const latestInitialPresetsRef = useRef(initialPresets);
  const latestRuntimePolicyRef = useRef(runtimePolicy);
  const [pendingTransition, setPendingTransition] = useState<
    | { kind: "select"; slug: string }
    | { kind: "copy" }
    | { kind: "duplicate"; targetSlug: string }
    | {
        kind: "refresh";
        presetsRead?: BackendRead<AdminPresetListResponse>;
        runtimePolicy?: BackendRead<AdminPublicRuntimePolicyResponse>;
      }
    | null
  >(null);
  const presets = presetsRead.status === "available" ? presetsRead.data.presets : [];
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.slug === selectedSlug) ?? presets[0] ?? null,
    [presets, selectedSlug],
  );
  const isDirty = Boolean(draft && selectedPreset && isPresetDraftDirty(draft, selectedPreset));
  const effectiveConfig = useMemo(
    () =>
      selectedPreset && draft
        ? buildEffectiveRunConfig(
            draft,
            selectedPreset,
            effectiveRuntimePolicy?.status === "available"
              ? effectiveRuntimePolicy.data.policy
              : undefined,
          )
        : null,
    [draft, effectiveRuntimePolicy, selectedPreset],
  );

  const controlsBlocked = startBlocked ?? isRunStartBlocked(recovery);
  const estimate = useRunEstimate(
    startConfirmation?.request ??
      (selectedPreset && effectiveConfig?.values
        ? { presetSlug: selectedPreset.slug, configOverride: effectiveConfig.values }
        : null),
    "admin",
    !controlsBlocked && !acceptedRun,
    JSON.stringify([selectedPreset, effectiveRuntimePolicy]),
  );
  useEffect(() => {
    // Failed reads can rewrap the previous projection; only producer time proves a newer read.
    if (
      acceptedRun &&
      recovery.status === "available" &&
      Date.parse(recovery.data.recoveredAt) > Date.parse(acceptedRun.startedAt) &&
      (acceptedRecoveryRef.current.status !== "available" ||
        Date.parse(recovery.data.recoveredAt) >
          Date.parse(acceptedRecoveryRef.current.data.recoveredAt)) &&
      !isRunStartBlocked(recovery)
    ) {
      setAcceptedRun(null);
    }
  }, [acceptedRun, recovery]);

  useEffect(() => {
    if (initialPresets === latestInitialPresetsRef.current) return;
    latestInitialPresetsRef.current = initialPresets;
    if (isDirty) {
      setPendingTransition((current) => ({
        ...(current?.kind === "refresh" ? current : {}),
        kind: "refresh",
        presetsRead: initialPresets,
      }));
      return;
    }
    setPresetsRead(initialPresets);
    const nextPresets = initialPresets.status === "available" ? initialPresets.data.presets : [];
    const nextPreset =
      nextPresets.find((preset) => preset.slug === selectedSlug) ?? nextPresets[0] ?? null;
    setSelectedSlug(nextPreset?.slug ?? null);
    setDraft(nextPreset ? draftFromPreset(nextPreset) : null);
    setDuplicateTargetSlug(nextPreset ? `${nextPreset.slug}-copy` : "");
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }, [initialPresets, isDirty, selectedSlug]);

  useEffect(() => {
    if (runtimePolicy === latestRuntimePolicyRef.current) return;
    latestRuntimePolicyRef.current = runtimePolicy;
    if (isDirty && runtimePolicy) {
      setPendingTransition((current) => ({
        ...(current?.kind === "refresh" ? current : {}),
        kind: "refresh",
        runtimePolicy,
      }));
      return;
    }
    setEffectiveRuntimePolicy(runtimePolicy);
  }, [isDirty, runtimePolicy]);

  useEffect(() => {
    if (effectiveRuntimePolicy?.status !== "available") return;
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }, [effectiveRuntimePolicy]);

  function start() {
    if (controlsBlocked || acceptedRun || estimate.blocksStart) return;
    if (!selectedPreset || !draft || !effectiveConfig) return;
    const built = effectiveConfig;
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
    setStartError(null);
    setStartConfirmation({ request: parsed.data, config: built.values });
  }

  async function confirmStart() {
    if (!startConfirmation || controlsBlocked || acceptedRun || estimate.blocksStart) return;
    await withPending(async () => {
      const result = await readProxyJson(adminDemoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(startConfirmation.request),
      });
      if (isAdminSessionRequired(result)) {
        setStartConfirmation(null);
        router.refresh();
        return;
      }
      setNotice(result.status === "available" ? "Admin run accepted." : null);
      if (result.status === "available") {
        acceptedRecoveryRef.current = recovery;
        setAcceptedRun(result.data.run);
        setStartConfirmation(null);
        setStartError(null);
        router.push(`/watch?${new URLSearchParams({ acceptedRunId: result.data.run.runId })}`);
        return;
      }
      if (result.status === "unavailable") {
        if (result.errorCode === "estimated_duration_rejected") {
          const rejection = estimateAdmissionRejectionDetailsSchema.safeParse(result.details);
          if (rejection.success) {
            estimate.reject(rejection.data);
            return;
          }
        }
        setStartError(adminFailureNotice(result));
        setFieldErrors(serverFieldErrors(result.details, "preset"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
      }
      await onStartComplete?.();
    });
  }

  async function save() {
    if (!selectedPreset || !draft || !effectiveConfig) return;
    const built = effectiveConfig;
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
      setNotice(null);
      const errors = presetContractDraftErrors(parsed.error.issues);
      setFieldErrors(errors.fieldErrors);
      setFormErrors(errors.formErrors);
      setShowValidationSummary(true);
      setValidationSummaryRevision((revision) => revision + 1);
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
      const refreshedRemaining = reconcileAcceptedPresetMutation(
        refreshed.data.presets,
        archived.data.slug,
        null,
      );
      setPresetsRead({
        ...refreshed,
        data: { ...refreshed.data, presets: refreshedRemaining },
      });
      const nextRefreshed =
        refreshedRemaining.find((preset) => preset.slug === nextAfterArchive?.slug) ??
        refreshedRemaining[0] ??
        null;
      setSelectedSlug(nextRefreshed?.slug ?? null);
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
      const refreshedPresets = reconcileAcceptedPresetMutation(
        refreshed.data.presets,
        localPreset.slug,
        localPreset,
      );
      setPresetsRead({
        ...refreshed,
        data: { ...refreshed.data, presets: refreshedPresets },
      });
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
        effectiveConfig={effectiveConfig?.values}
        fieldErrors={fieldErrors}
        formErrors={formErrors}
        hardCaps={
          effectiveRuntimePolicy?.status === "available"
            ? effectiveRuntimePolicy.data.policy.deploymentHardCaps
            : undefined
        }
        duplicateTargetSlug={duplicateTargetSlug}
        isPending={isPending}
        isDirty={isDirty}
        notice={notice}
        onBlurField={(field) => {
          if (!selectedPreset || !draft) return;
          const built = buildEffectiveRunConfig(
            draft,
            selectedPreset,
            effectiveRuntimePolicy?.status === "available"
              ? effectiveRuntimePolicy.data.policy
              : undefined,
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
        onCopyToCustom={() =>
          isDirty ? setPendingTransition({ kind: "copy" }) : void copyToCustom()
        }
        onDuplicate={(targetSlug) =>
          isDirty
            ? setPendingTransition({ kind: "duplicate", targetSlug })
            : void duplicate(targetSlug)
        }
        onDuplicateTargetSlugChange={setDuplicateTargetSlug}
        onSave={() => void save()}
        onSelect={(slug) => {
          if (slug === selectedSlug) return;
          if (isDirty) setPendingTransition({ kind: "select", slug });
          else selectPreset(slug);
        }}
        onStart={start}
        onUpdateDraft={(next) => {
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
        acceptedRunId={acceptedRun?.runId}
        admissionNotice={<RunEstimateNotice state={estimate.state} mode="admin" />}
        startBlocked={controlsBlocked || Boolean(acceptedRun) || estimate.blocksStart}
        startBlockedReason={startBlockedReason}
      />
      <ConfirmationDialog
        confirmDisabled={controlsBlocked || Boolean(acceptedRun) || estimate.blocksStart}
        confirmLabel="Start run"
        tone="default"
        wide
        description="Start with this effective configuration and claim the one shared demo runtime. The accepted values become a frozen per-run snapshot."
        error={
          <>
            {startConfirmation ? <RunEstimateNotice state={estimate.state} mode="admin" /> : null}
            {startError ? <AdminNoticeView notice={startError} /> : null}
          </>
        }
        onCancel={() => {
          setStartConfirmation(null);
          setStartError(null);
        }}
        onConfirm={() => void confirmStart()}
        open={startConfirmation !== null}
        pending={isPending}
        title="Start this run?"
      >
        {startConfirmation?.config ? (
          <EffectiveRunPreview config={startConfirmation.config} defaultOpen />
        ) : null}
      </ConfirmationDialog>
      <ConfirmationDialog
        confirmLabel="Archive preset"
        tone="default"
        description={`Archive the "${selectedPreset?.display.name ?? "selected"}" preset. It will leave the active list while historical runs are retained.${isDirty ? " Your unsaved edits will be discarded." : ""}`}
        error={archiveError ? <AdminNoticeView notice={archiveError} /> : null}
        onCancel={() => setArchiveOpen(false)}
        onConfirm={() => void archive()}
        open={archiveOpen}
        pending={isPending}
        title="Archive this preset?"
      />
      <ConfirmationDialog
        confirmLabel="Discard unsaved edits"
        description={`${discardDescription(pendingTransition)}${
          pendingTransition?.kind === "copy"
            ? " Your unsaved edits will not be copied."
            : pendingTransition?.kind === "duplicate"
              ? " Your unsaved edits will not be duplicated."
              : ""
        }`}
        onCancel={() => setPendingTransition(null)}
        onConfirm={confirmPendingTransition}
        open={pendingTransition !== null}
        title="Discard unsaved edits?"
      />
    </>
  );

  function selectPreset(slug: string) {
    const nextPreset = presets.find((preset) => preset.slug === slug);
    if (!nextPreset) return;
    setSelectedSlug(slug);
    setDraft(draftFromPreset(nextPreset));
    setDuplicateTargetSlug(`${slug}-copy`);
    clearValidationState();
  }

  function adoptPresets(nextRead: BackendRead<AdminPresetListResponse>) {
    setPresetsRead(nextRead);
    const nextPresets = nextRead.status === "available" ? nextRead.data.presets : [];
    const nextPreset =
      nextPresets.find((preset) => preset.slug === selectedSlug) ?? nextPresets[0] ?? null;
    setSelectedSlug(nextPreset?.slug ?? null);
    setDraft(nextPreset ? draftFromPreset(nextPreset) : null);
    setDuplicateTargetSlug(nextPreset ? `${nextPreset.slug}-copy` : "");
    clearValidationState();
  }

  function confirmPendingTransition() {
    const transition = pendingTransition;
    setPendingTransition(null);
    if (!transition) return;
    if (transition.kind === "select") selectPreset(transition.slug);
    if (transition.kind === "copy") void copyToCustom();
    if (transition.kind === "duplicate") void duplicate(transition.targetSlug);
    if (transition.kind === "refresh") {
      if (transition.presetsRead) adoptPresets(transition.presetsRead);
      else if (selectedPreset) setDraft(draftFromPreset(selectedPreset));
      if (transition.runtimePolicy) setEffectiveRuntimePolicy(transition.runtimePolicy);
    }
  }

  function clearValidationState() {
    setFieldErrors({});
    setFormErrors([]);
    setShowValidationSummary(false);
  }
}

function discardDescription(
  transition: { kind: "select" | "copy" | "duplicate" | "refresh" } | null,
): string {
  switch (transition?.kind) {
    case "select":
      return "Switching presets will discard your unsaved edits.";
    case "copy":
      return "Copying the saved preset will replace this draft.";
    case "duplicate":
      return "Duplicating the saved preset will replace this draft.";
    case "refresh":
      return "Refreshing preset or policy data will discard your unsaved edits.";
    default:
      return "";
  }
}

export function AdminMaintenancePanel({
  onResetComplete,
  incomplete = false,
}: {
  incomplete?: boolean;
  onResetComplete: () => Promise<void>;
}) {
  const router = useRouter();
  const [isPending, setIsPending] = useState(false);
  const [notice, setNotice] = useState<AdminNotice | null>(null);
  const [intent, setIntent] = useState<"reset" | "cleanup" | null>(null);
  const [error, setError] = useState<AdminNotice | null>(null);

  function openIntent(next: "reset" | "cleanup") {
    setNotice(null);
    setError(null);
    setIntent(next);
  }

  async function run() {
    if (!intent) return;
    setIsPending(true);
    setNotice(null);
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
          `Reset complete: ${formatMaintenanceCount(result.data.failedRunCount)} runs failed, ${formatMaintenanceCount(result.data.closedSaleOfferCount)} sale offers closed, ${formatMaintenanceCount(result.data.cleanedQueueCount)} queues cleaned, ${formatMaintenanceCount(result.data.cleanedJobCount)} jobs cleaned. Global ERP fault injection is not changed by this reset.`,
        );
      } else if ("deletedRunCount" in result.data) {
        setNotice(
          `Cleanup complete: ${formatMaintenanceCount(result.data.deletedRunCount)} generated runs removed.`,
        );
      }
      await onResetComplete();
      setIntent(null);
    } finally {
      setIsPending(false);
    }
  }

  return (
    <section className={panelClassName} id="maintenance">
      <div className="mb-4">
        <p className={eyebrowClassName}>Maintenance</p>
        <h2 className={panelTitleClassName}>
          Recovery and cleanup{" "}
          <FieldHint label="Recovery and cleanup" text={adminFieldHints.recovery} />
        </h2>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className={buttonClassName}
          disabled={isPending}
          onClick={() => openIntent("reset")}
          type="button"
        >
          {incomplete ? "Retry Reset" : "Reset demo"}
        </button>
        <button
          className={buttonClassName}
          disabled={isPending}
          onClick={() => openIntent("cleanup")}
          type="button"
        >
          Cleanup runs
        </button>
      </div>
      {incomplete ? (
        <p
          className="mb-0 mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning"
          role="status"
        >
          Operator stop decision recorded. Work cleanup and history are incomplete; worker work may
          still settle. Starts are blocked. Retry Reset to complete recovery.
        </p>
      ) : null}
      <AdminNoticeView notice={notice} />
      <ConfirmationDialog
        confirmLabel={intent === "reset" ? "Reset demo" : "Cleanup generated runs"}
        description={
          intent === "reset"
            ? "Resetting stops all demo work immediately, discards the current run's data, and frees the demo for the next run. One basic history line marked as cancelled remains. Global ERP fault injection is not changed by this reset."
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
  runErpConfig,
  runState = "unavailable",
}: {
  initialErpChaos: BackendRead<ErpChaosStatus>;
  runErpConfig?: AcceptedRunConfigSnapshot["erpConfig"] | undefined;
  runState?: "active" | "inactive" | "unavailable";
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
  const [confirmation, setConfirmation] = useState<{
    kind: "apply" | "reset";
    proposed: ErpChaosConfig;
  } | null>(null);
  const [confirmationError, setConfirmationError] = useState<AdminNotice | null>(null);
  const isDraftDirtyRef = useRef(false);
  const controlsDisabledReason = isPending
    ? "A change is being applied — wait before applying or resetting ERP controls."
    : erpChaos.status === "unavailable"
      ? "Diagnostics status is unavailable — refresh before applying or resetting ERP controls."
      : undefined;

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

  async function submit() {
    if (!confirmation) return;
    const path =
      confirmation.kind === "reset" ? adminErpChaosResetProxyPath : adminErpChaosProxyPath;
    const init: RequestInit =
      confirmation.kind === "reset"
        ? { method: "POST" }
        : {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(confirmation.proposed),
          };
    setIsPending(true);
    setNotice(null);
    try {
      const result = await readProxyJson(path, erpChaosStatusSchema, init);
      if (isAdminSessionRequired(result)) {
        setConfirmation(null);
        router.refresh();
        return;
      }
      if (result.status === "unavailable") {
        setConfirmationError(adminFailureNotice(result));
        setFieldErrors(serverFieldErrors(result.details, "erp"));
        setShowValidationSummary(true);
        setValidationSummaryRevision((revision) => revision + 1);
        return;
      }
      setErpChaos(result);
      setLatestErpChaosRead(result);
      setDraft(erpDraftFromRead(result));
      isDraftDirtyRef.current = false;
      clearValidationState();
      setNotice(
        path === adminErpChaosResetProxyPath
          ? "Global ERP fault injection reset."
          : "Global ERP fault injection updated.",
      );
      setConfirmation(null);
      setConfirmationError(null);
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
    setConfirmationError(null);
    setConfirmation({ kind: "apply", proposed: parsed.data });
  }

  return (
    <>
      <AdminErpDiagnosticsView
        controlsDisabledReason={controlsDisabledReason}
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
          if (erpChaos.status !== "available") return;
          setConfirmationError(null);
          setConfirmation({ kind: "reset", proposed: erpChaos.data.defaultConfig });
        }}
        runErpConfig={runErpConfig}
        showValidationSummary={showValidationSummary}
        validationSummaryRevision={validationSummaryRevision}
      />
      <ConfirmationDialog
        confirmLabel={confirmation?.kind === "reset" ? "Reset ERP controls" : "Apply ERP controls"}
        tone="default"
        description={`${runState === "active" ? "This does not change the active run — frozen in the accepted run snapshot; affects fallback and future non-snapshot calls. " : runState === "inactive" ? "There is no active run; these values govern fallback and future non-snapshot calls. " : "Current run state is unavailable — a currently active run keeps its frozen snapshot; these values govern fallback and future non-snapshot calls. "}They have global/fallback scope and reset when Mock ERP restarts.`}
        error={confirmationError ? <AdminNoticeView notice={confirmationError} /> : null}
        onCancel={() => {
          setConfirmation(null);
          setConfirmationError(null);
        }}
        onConfirm={() => void submit()}
        open={confirmation !== null}
        pending={isPending}
        title={
          confirmation?.kind === "reset"
            ? "Reset global ERP fault injection?"
            : "Apply global ERP fault injection?"
        }
      >
        {confirmation && erpChaos.status === "available" ? (
          <EffectiveChangeList changes={erpChangeSummary(erpChaos.data, confirmation.proposed)} />
        ) : null}
      </ConfirmationDialog>
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

function erpChangeSummary(current: ErpChaosConfig, proposed: ErpChaosConfig) {
  return [
    { label: "Latency ms", oldValue: current.latencyMs, proposedValue: proposed.latencyMs },
    { label: "Max TPS", oldValue: current.maxTps, proposedValue: proposed.maxTps },
    {
      label: "Error rate",
      oldValue: `${ratioToPercent(current.errorRate)}%`,
      proposedValue: `${ratioToPercent(proposed.errorRate)}%`,
    },
    {
      label: "Forced outage",
      oldValue: current.forcedOutage ? "on" : "off",
      proposedValue: proposed.forcedOutage ? "on" : "off",
    },
  ];
}

const policyFieldKeys = {
  budget: ["windowSeconds", "perVisitorMaxStarts", "globalMaxStarts"],
  traffic: [
    "mode",
    "buyerCount",
    "duplicateEachBuyerAttempt",
    "ratePerSecond",
    "startDelaySeconds",
    "maxDurationSeconds",
    "durationSeconds",
    "quantityPerAttempt",
    "k6Vus.preAllocatedVus",
    "k6Vus.maxVus",
  ],
  inventory: ["startingStock"],
  erp: ["latencyMs", "maxTps", "errorRate"],
  backpressure: ["queueName", "physicalQueueName", "orderProcessConcurrency"],
  limits: [
    "maxTotalRequests",
    "maxBuyers",
    "maxRequestsPerSecond",
    "maxTrafficDurationSeconds",
    "maxTrafficStartDelaySeconds",
    "maxPreAllocatedVus",
    "maxVus",
    "maxStartingStock",
    "maxErpLatencyMs",
    "minErpMaxTps",
    "maxErpMaxTps",
    "maxErpErrorRate",
  ],
} as const;

function policyChangeRow(label: string, oldValue: string | number, proposedValue: string | number) {
  return { label, oldValue, proposedValue };
}

function policyChangeRows<const Key extends string, Value extends Record<Key, string | number>>(
  prefix: string,
  keys: readonly Key[],
  oldValues: Value,
  proposedValues: Value,
) {
  return keys.map((key) => {
    const percentage = key === "errorRate" || key === "maxErpErrorRate";
    const format = (value: string | number) =>
      percentage && typeof value === "number" ? `${ratioToPercent(value)}%` : value;
    return policyChangeRow(`${prefix}.${key}`, format(oldValues[key]), format(proposedValues[key]));
  });
}

function publicTrafficPolicyFields(traffic: AcceptedRunConfigSnapshot["trafficConfig"]) {
  const buyer = traffic.mode === "buyer-spike" ? traffic : undefined;
  const arrival = traffic.mode === "constant-arrival-rate" ? traffic : undefined;
  return {
    mode: traffic.mode,
    buyerCount: buyer?.buyerCount ?? "—",
    duplicateEachBuyerAttempt: buyer ? String(buyer.duplicateEachBuyerAttempt) : "—",
    ratePerSecond: arrival?.ratePerSecond ?? "—",
    startDelaySeconds: traffic.startDelaySeconds,
    maxDurationSeconds: buyer?.maxDurationSeconds ?? "—",
    durationSeconds: arrival?.durationSeconds ?? "—",
    quantityPerAttempt: traffic.quantityPerAttempt,
    "k6Vus.preAllocatedVus": arrival?.k6Vus?.preAllocatedVus ?? "—",
    "k6Vus.maxVus": arrival?.k6Vus?.maxVus ?? "—",
  };
}

export function policyChangeSummary(
  current: PublicRuntimePolicy,
  proposed: PublicRuntimePolicyMutable,
) {
  const oldDefaults = current.publicCustomDefaults;
  const newDefaults = proposed.publicCustomDefaults;

  return [
    policyChangeRow(
      "Budget enforcement",
      current.isPublicRunBudgetEnforced ? "on" : "off",
      proposed.isPublicRunBudgetEnforced ? "on" : "off",
    ),
    ...policyChangeRows(
      "publicRunBudget",
      policyFieldKeys.budget,
      current.publicRunBudget,
      proposed.publicRunBudget,
    ),
    ...policyChangeRows(
      "publicCustomDefaults.trafficConfig",
      policyFieldKeys.traffic,
      publicTrafficPolicyFields(oldDefaults.trafficConfig),
      publicTrafficPolicyFields(newDefaults.trafficConfig),
    ),
    ...policyChangeRows(
      "publicCustomDefaults.inventoryConfig",
      policyFieldKeys.inventory,
      oldDefaults.inventoryConfig,
      newDefaults.inventoryConfig,
    ),
    ...policyChangeRows(
      "publicCustomDefaults.erpConfig",
      policyFieldKeys.erp,
      oldDefaults.erpConfig,
      newDefaults.erpConfig,
    ),
    policyChangeRow(
      "publicCustomDefaults.erpConfig.forcedOutage",
      String(oldDefaults.erpConfig.forcedOutage),
      String(newDefaults.erpConfig.forcedOutage),
    ),
    ...policyChangeRows(
      "publicCustomDefaults.backpressureConfig",
      policyFieldKeys.backpressure,
      oldDefaults.backpressureConfig,
      newDefaults.backpressureConfig,
    ),
    ...policyChangeRows(
      "publicCustomLimits",
      policyFieldKeys.limits,
      current.publicCustomLimits,
      proposed.publicCustomLimits,
    ),
    policyChangeRow(
      "publicCustomLimits.allowForcedOutage",
      String(current.publicCustomLimits.allowForcedOutage),
      String(proposed.publicCustomLimits.allowForcedOutage),
    ),
    policyChangeRow(
      "publicCustomLimits.allowedTrafficModes",
      JSON.stringify(current.publicCustomLimits.allowedTrafficModes),
      JSON.stringify(proposed.publicCustomLimits.allowedTrafficModes),
    ),
  ].filter((change) => change.oldValue !== change.proposedValue);
}

function erpDraftFromRead(read: BackendRead<ErpChaosStatus>): ErpDraft {
  return read.status === "available"
    ? {
        latencyMs: String(read.data.latencyMs),
        maxTps: String(read.data.maxTps),
        errorRate: String(ratioToPercent(read.data.errorRate)),
        forcedOutage: read.data.forcedOutage,
      }
    : { latencyMs: "0", maxTps: "100", errorRate: "0", forcedOutage: false };
}

function deriveAdminFreshness(
  recovery: BackendRead<DashboardProjection>,
  transportStatus: RealtimeConnectionStatus,
  now: Date,
): Freshness {
  const projection = recovery.status === "available" ? recovery.data : null;
  const freshness = deriveFreshness({
    transportStatus,
    recoveredAt: projection?.recoveredAt ?? now.toISOString(),
    now,
    lifecycle: projection?.currentRun?.status ?? (projection ? "starting" : null),
    updateExpected: projection ? dashboardUpdateExpected(projection) : false,
  });
  return transportStatus === "disconnected" || transportStatus === "unsupported"
    ? { ...freshness, state: transportStatus }
    : freshness;
}

function isFreshnessBlockingStart(freshness: Freshness, hasReadFailure: boolean): boolean {
  return (
    hasReadFailure ||
    freshness.state === "stale" ||
    freshness.state === "disconnected" ||
    freshness.state === "unsupported"
  );
}

function isRunStartBlocked(
  recovery: BackendRead<DashboardProjection>,
  freshness?: Freshness,
  hasReadFailure = false,
): boolean {
  if (recovery.status !== "available") return true;
  if (freshness && isFreshnessBlockingStart(freshness, hasReadFailure)) return true;
  return (
    recovery.data.resetRecovery === "incomplete" ||
    isRunInProgress(recovery.data.currentRun?.status)
  );
}

function runStartBlockedReason(
  recovery: BackendRead<DashboardProjection>,
  freshness: Freshness,
  hasReadFailure: boolean,
): string | undefined {
  if (recovery.status === "loading") return "Status is loading — wait before starting";
  if (recovery.status === "unavailable") return "Status is unavailable — refresh before starting";
  if (isFreshnessBlockingStart(freshness, hasReadFailure)) {
    return "Status is stale — refresh before starting";
  }
  if (recovery.data.resetRecovery === "incomplete")
    return "Work cleanup and history are incomplete — retry Reset before starting";
  const status = recovery.data.currentRun?.status;
  return isRunInProgress(status) ? `Run is ${status} — wait before starting another` : undefined;
}

function isRunInProgress(
  status: NonNullable<DashboardProjection["currentRun"]>["status"] | undefined,
): boolean {
  return status === "starting" || status === "active" || status === "draining";
}

function freshnessSuffix(freshness: Freshness): string {
  if (freshness.state === "stale") return " · stale";
  if (freshness.state === "disconnected") return " · disconnected";
  if (freshness.state === "unsupported") return " · live updates unsupported";
  return "";
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

// The accepted mutation wins payload fields for this immediate reconciliation;
// the refreshed list still owns server-computed capabilities. Later reads replace it normally.
function reconcileAcceptedPresetMutation(
  refreshedPresets: AdminPresetListItem[],
  affectedSlug: string,
  acceptedPreset: AdminPresetListItem | null,
): AdminPresetListItem[] {
  if (!acceptedPreset) {
    return refreshedPresets.filter((preset) => preset.slug !== affectedSlug);
  }
  const refreshedPreset = refreshedPresets.find((preset) => preset.slug === affectedSlug);
  return refreshedPreset
    ? refreshedPresets.map((preset) =>
        preset.slug === affectedSlug
          ? { ...acceptedPreset, canArchive: refreshedPreset.canArchive }
          : preset,
      )
    : [...refreshedPresets, acceptedPreset];
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
const inventoryServerFields = new Set(["startingStock"]);
const erpConfigServerFields = new Set([
  "erpErrorRate",
  "erpForcedOutage",
  "erpLatencyMs",
  "erpMaxTps",
]);
const backpressureServerFields = new Set(["orderProcessConcurrency"]);
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
