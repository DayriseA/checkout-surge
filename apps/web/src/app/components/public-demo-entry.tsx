"use client";

import {
  type AcceptedRunConfigSnapshot,
  calculatePlannedRequests,
  capacityAssessmentSchema,
  type DashboardProjection,
  type DemoPresetContract,
  type DemoRunConfigOverride,
  type EstimateAdmissionRejectionDetails,
  estimateAdmissionRejectionDetailsSchema,
  type HealthResponse,
  healthResponseSchema,
  type PublicRuntimePolicy,
  type StartDemoRunRequest,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import Link from "next/link";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackendRead, PublicDemoSurface } from "../lib/api";
import { readProxyJson } from "../lib/client/proxy-json";
import { demoRunStartProxyPath, healthReadyProxyPath } from "../lib/control-paths";
import { useLocale, useTranslation } from "../lib/i18n/locale-context";
import { getTranslation, type Locale } from "../lib/i18n/translate";
import {
  type CustomErrorGroup,
  type CustomRunSummaryEntry,
  type InvalidCustomRunControl,
  presentCustomRunIssues,
  presentInvalidCustomRunControls,
} from "../lib/presentation/custom-run-issue-presentation";
import {
  type ErrorPresentation,
  isInfrastructureRunLimitRejection,
  largerRunsGuidance,
  mapErrorPresentation,
} from "../lib/presentation/error-presentation";
import { fieldHints } from "../lib/presentation/field-hints";
import { formatCount, formatDurationMs, pluralize } from "../lib/presentation/format";
import { percentToRatio, ratioToPercent } from "../lib/presentation/percent";
import { publicVocabulary, trafficModeLabel } from "../lib/presentation/public-vocabulary";
import {
  deriveRunConfigFacts,
  presetDistinguishingBehavior,
  presetOutcomeFocus,
} from "../lib/presentation/run-config-presentation";
import {
  deriveRunPresentationState,
  type PresentationState,
} from "../lib/presentation/run-presentation-state";
import { comparisonExplanationLinks, presetCardId } from "../lib/site-links";
import {
  fieldHelpClassName,
  fieldLabelClassName,
  inputClassName,
  primaryButtonClassName,
  settingsFieldsetClassName,
  settingsLegendClassName,
  textLinkClassName,
} from "./control-styles";
import { ErrorNotice } from "./error-notice";
import { FieldHint } from "./field-hint";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";
import { RunEstimateNotice } from "./run-estimate-notice";
import { RunStartWaitingPanel } from "./run-start-waiting-panel";
import { RunnerRelocationNotice } from "./runner-relocation-notice";
import { StatusPill } from "./status-pill";
import { ConditionalCaveat } from "./transport-observation";
import { useRunEstimate } from "./use-run-estimate";

const recoveryPollIntervalMs = 15_000;
// While the visitor's own start is pending, so a runner relocation shows during the wait. It stays
// within the per-visitor budget of dashboard recovery reads.
const startingRecoveryPollIntervalMs = 6_000;
const readinessPollIntervalMs = 60_000;
const boardClassName = "min-w-0 rounded-2xl border border-border bg-surface";
const recommendedPresetSlug = "surge-5k";
const customFieldsetClassName = `${settingsFieldsetClassName} px-5 max-[560px]:px-4`;

type TrafficMode = AcceptedRunConfigSnapshot["trafficConfig"]["mode"];

interface CustomDraft {
  mode: TrafficMode;
  buyerCount: string;
  duplicateEachBuyerAttempt: boolean;
  maxDurationSeconds: string;
  ratePerSecond: string;
  durationSeconds: string;
  startDelaySeconds: string;
  startingStock: string;
  erpLatencyMs: string;
  erpMaxTps: string;
  erpErrorRate: string;
}

type CustomSubmissionFailure =
  | { kind: "validation"; entries: CustomRunSummaryEntry[]; notice?: ErrorPresentation }
  | { kind: "operation"; presentation: ErrorPresentation };

type StartFailureSource = { read: BackendRead<unknown>; startRequestOutcome?: true };
type CustomFailureSource =
  | { kind: "operation"; read: BackendRead<unknown> }
  | {
      kind: "validation";
      validation:
        | { kind: "controls"; controls: InvalidCustomRunControl[] }
        | { kind: "issues"; paths: ReadonlyArray<readonly unknown[]>; mode: TrafficMode }
        | { kind: "traffic-limit"; limit: number };
      notice?: BackendRead<unknown>;
    };

function totalAttemptsLimitMessage(limit: number, locale: Locale): string {
  return getTranslation(locale)(
    "Reduce the buyer count, rate, duration, or duplicate attempts to {count} planned attempts or fewer.",
    { count: formatCount(limit, locale) ?? "—" },
  );
}

function presentCustomFailure(
  source: CustomFailureSource | null,
  locale: Locale,
): CustomSubmissionFailure | null {
  if (!source) return null;
  const context = { surface: "public-start", startRequestOutcome: true } as const;
  if (source.kind === "operation") {
    return { kind: "operation", presentation: mapErrorPresentation(source.read, context, locale) };
  }
  const validation = source.validation;
  const entries =
    validation.kind === "controls"
      ? presentInvalidCustomRunControls(validation.controls, locale)
      : validation.kind === "issues"
        ? presentCustomRunIssues(validation.paths, locale).filter((entry) =>
            customEntryAppliesToMode(entry, validation.mode),
          )
        : [
            {
              group: "traffic" as const,
              key: "custom-traffic-error",
              message: totalAttemptsLimitMessage(validation.limit, locale),
              targetId: "custom-traffic-error",
            },
          ];
  return {
    kind: "validation",
    entries,
    ...(source.notice ? { notice: mapErrorPresentation(source.notice, context, locale) } : {}),
  };
}

export function PublicDemoEntry({ surface }: { surface: PublicDemoSurface }) {
  const t = useTranslation();
  const locale = useLocale();
  const [accepted, setAccepted] = useState(false);
  const [startingSlug, setStartingSlug] = useState<string | null>(null);
  // Only while the start request itself waits for its answer; the starting slug is held longer.
  const [startRequestInFlight, setStartRequestInFlight] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [startFailureSource, setStartFailureSource] = useState<StartFailureSource | null>(null);
  const startPresentation = useMemo(
    () =>
      startFailureSource
        ? mapErrorPresentation(
            startFailureSource.read,
            startFailureSource.startRequestOutcome
              ? { surface: "public-start", startRequestOutcome: true }
              : "public-start",
            locale,
          )
        : null,
    [startFailureSource, locale],
  );
  const [startConflictBlock, setStartConflictBlock] = useState<
    "active_run_exists" | "reset_incomplete" | null
  >(null);
  const [activeConflictRefreshComplete, setActiveConflictRefreshComplete] = useState(false);
  const [startRetryUntil, setStartRetryUntil] = useState<number | null>(null);
  const [readiness, setReadiness] = useState(surface.readiness);
  const [, setIsReadinessRefreshing] = useState(false);
  const readinessRequestRef = useRef<Promise<BackendRead<HealthResponse>> | null>(null);
  const readinessRetryUntilRef = useRef<number | null>(
    surface.readiness.status === "unavailable" &&
      surface.readiness.retryAfterMs !== undefined &&
      surface.readiness.retryAfterMs > 0
      ? Date.now() + surface.readiness.retryAfterMs
      : null,
  );
  const readinessMountedRef = useRef(true);
  const [customDraft, setCustomDraft] = useState<CustomDraft>(() =>
    surface.runtimePolicy.status === "available"
      ? draftFromSnapshot(surface.runtimePolicy.data.policy.publicCustomDefaults)
      : fallbackDraft(),
  );
  const customModeRef = useRef(customDraft.mode);
  customModeRef.current = customDraft.mode;
  const [customFailureSource, setCustomFailureSource] = useState<CustomFailureSource | null>(null);
  const customSubmissionFailure = useMemo(
    () => presentCustomFailure(customFailureSource, locale),
    [customFailureSource, locale],
  );
  const customValidationEntries =
    customSubmissionFailure?.kind === "validation" ? customSubmissionFailure.entries : [];
  const customSummaryRef = useRef<HTMLDivElement>(null);
  const customBuilderRef = useRef<HTMLDetailsElement>(null);
  const advancedSettingsRef = useRef<HTMLDetailsElement>(null);
  const [customBuilderOpen, setCustomBuilderOpen] = useState(false);
  const [customDraftEdited, setCustomDraftEdited] = useState(false);

  useEffect(() => {
    if (!customSubmissionFailure) return;
    if (customBuilderRef.current) customBuilderRef.current.open = true;
    setCustomBuilderOpen(true);
    if (
      customSubmissionFailure.kind === "validation" &&
      customSubmissionFailure.entries.some((entry) => entry.group === "advanced")
    ) {
      if (advancedSettingsRef.current) advancedSettingsRef.current.open = true;
    }
    if (customSubmissionFailure.kind === "validation") {
      const target = customSubmissionFailure.entries
        .filter((entry) => entry.group !== "form")
        .map((entry) => document.getElementById(entry.targetId))
        .find((element) => element !== null);
      (target ?? customSummaryRef.current)?.focus();
    } else {
      customSummaryRef.current?.focus();
    }
  }, [customSubmissionFailure]);

  const {
    recovery,
    isRetryScheduled,
    retriesExhausted,
    retryAttempt,
    retryDelayMs,
    refresh,
    retryNow,
  } = useDashboardRecovery(surface.recovery);
  const refreshReadiness = useCallback(async (): Promise<void> => {
    if (readinessRetryUntilRef.current !== null && readinessRetryUntilRef.current > Date.now()) {
      return;
    }
    readinessRetryUntilRef.current = null;

    if (readinessRequestRef.current) {
      await readinessRequestRef.current;
      return;
    }

    setIsReadinessRefreshing(true);
    const request = readProxyJson(healthReadyProxyPath, healthResponseSchema, undefined, [503]);
    readinessRequestRef.current = request;

    try {
      const nextReadiness = await request;
      if (readinessMountedRef.current) {
        readinessRetryUntilRef.current =
          nextReadiness.status === "unavailable" &&
          nextReadiness.retryAfterMs !== undefined &&
          nextReadiness.retryAfterMs > 0
            ? Date.now() + nextReadiness.retryAfterMs
            : null;
        setReadiness(nextReadiness);
      }
    } finally {
      if (readinessRequestRef.current === request) readinessRequestRef.current = null;
      if (readinessMountedRef.current) setIsReadinessRefreshing(false);
    }
  }, []);

  useEffect(() => {
    readinessMountedRef.current = true;
    return () => {
      readinessMountedRef.current = false;
    };
  }, []);

  const startPending = startingSlug !== null;
  useEffect(() => {
    if (recovery.status !== "available") return;
    const interval = setInterval(
      () => void refresh(),
      startPending ? startingRecoveryPollIntervalMs : recoveryPollIntervalMs,
    );
    return () => clearInterval(interval);
  }, [recovery.status, refresh, startPending]);

  useEffect(() => {
    const interval = setInterval(() => void refreshReadiness(), readinessPollIntervalMs);
    return () => clearInterval(interval);
  }, [refreshReadiness]);

  useEffect(() => {
    const retryUntil = readinessRetryUntilRef.current;
    if (readiness.status !== "unavailable" || retryUntil === null) return;
    const timer = setTimeout(
      () => {
        if (readinessRetryUntilRef.current !== retryUntil) return;
        readinessRetryUntilRef.current = null;
        setReadiness((current) => {
          if (current.status !== "unavailable") return current;
          const { retryAfterMs: _expiredRetryAfterMs, ...withoutRetryAfter } = current;
          return withoutRetryAfter;
        });
      },
      Math.max(0, retryUntil - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [readiness]);

  useEffect(() => {
    if (startRetryUntil === null || startingSlug !== null) return;
    const remainingMs = Math.max(0, startRetryUntil - Date.now());
    const timer = setTimeout(() => {
      setStartRetryUntil(null);
      setStartFailureSource(
        startConflictBlock === null
          ? null
          : {
              read: {
                status: "unavailable",
                errorCode: "run_conflict",
                details: { conflictReason: startConflictBlock },
              },
            },
      );
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [startConflictBlock, startRetryUntil, startingSlug]);

  useEffect(() => {
    if (
      startConflictBlock !== "active_run_exists" ||
      !activeConflictRefreshComplete ||
      recovery.status !== "available"
    ) {
      return;
    }
    if (isRunStartBlocked(recovery)) {
      setStartFailureSource(null);
      return;
    }
    setStartConflictBlock(null);
    setStartFailureSource(null);
  }, [activeConflictRefreshComplete, recovery, startConflictBlock]);

  useEffect(() => {
    if (recovery.status !== "available" || !isRunStartBlocked(recovery)) return;
    if (startRetryUntil === null) {
      if (startPresentation !== null) setStartFailureSource(null);
    }
  }, [recovery, startPresentation, startRetryUntil]);

  const isBlocked = isRunStartBlocked(recovery);
  const isReadinessBlocked = readinessBlocksRunStart(readiness);
  const presets =
    surface.presets.status === "available"
      ? surface.presets.data.presets.filter((preset) => preset.visibility === "public")
      : [];
  const curatedPresets = presets
    .filter((preset) => preset.slug !== "public-custom")
    .sort(
      (left, right) =>
        Number(right.slug === recommendedPresetSlug) - Number(left.slug === recommendedPresetSlug),
    );
  const customPreset = presets.find((preset) => preset.slug === "public-custom") ?? null;
  const runtimePolicy =
    surface.runtimePolicy.status === "available" ? surface.runtimePolicy.data.policy : null;
  const customConfig = useMemo(
    () =>
      runtimePolicy
        ? buildCustomConfigOverride(customDraft, runtimePolicy.publicCustomDefaults)
        : null,
    [customDraft, runtimePolicy],
  );
  const plannedRequests = customConfig?.trafficConfig
    ? calculatePlannedRequests(customConfig.trafficConfig)
    : null;
  const totalRequestsError =
    runtimePolicy &&
    plannedRequests !== null &&
    plannedRequests > runtimePolicy.publicCustomLimits.maxTotalRequests
      ? totalAttemptsLimitMessage(runtimePolicy.publicCustomLimits.maxTotalRequests, locale)
      : null;
  const startDisabled =
    accepted ||
    isBlocked ||
    isReadinessBlocked ||
    startingSlug !== null ||
    startConflictBlock !== null ||
    startRetryUntil !== null ||
    surface.presets.status !== "available" ||
    recovery.status !== "available";
  const customEstimate = useRunEstimate(
    customPreset && customConfig
      ? { presetSlug: customPreset.slug, configOverride: customConfig }
      : null,
    "public",
    !isBlocked && !isReadinessBlocked && !accepted && customBuilderOpen,
    JSON.stringify(runtimePolicy),
  );
  const customStartDisabled = startDisabled || customEstimate.blocksStart;
  const startOptionsAvailable =
    curatedPresets.length > 0 || Boolean(runtimePolicy && customPreset && customConfig);
  // Derived post-start reconciliation window: a start is pending its post-failure
  // reconciliation while the failed-start presentation is up and the starting slug has
  // not been released (it is only released once both required reads complete).
  const postStartReconciliationPending = startingSlug !== null && startPresentation !== null;
  // The waiting panel sits beside the start the visitor clicked, so it stays in view.
  const customStartPending = customPreset !== null && startingSlug === customPreset.slug;

  function updateCustomDraft(update: (draft: CustomDraft) => CustomDraft) {
    setCustomDraft(update);
    setCustomDraftEdited(true);
    setCustomFailureSource(null);
  }

  function groupError(group: CustomErrorGroup) {
    return customValidationEntries.find((entry) => !entry.fieldId && entry.group === group);
  }

  function fieldError(fieldId: string) {
    return customValidationEntries.find((entry) => entry.fieldId === fieldId)?.fieldError;
  }

  async function startRun(presetSlug: string) {
    const parsed = startDemoRunRequestSchema.safeParse({ presetSlug });

    if (!parsed.success) {
      setStatusMessage(null);
      setStartFailureSource({
        read: { status: "unavailable", errorCode: "invalid_request", reason: "invalid request" },
      });
      return;
    }
    return await sendStartRequest(parsed.data, false);
  }

  async function sendStartRequest(request: StartDemoRunRequest, isCustom: boolean) {
    const presetSlug = request.presetSlug;
    setStartingSlug(presetSlug);
    setStatusMessage(null);
    setStartFailureSource(null);
    setCustomFailureSource(null);
    setStartRetryUntil(null);

    try {
      setStartRequestInFlight(true);
      const result = await readProxyJson(demoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }).finally(() => setStartRequestInFlight(false));

      if (result.status === "available") {
        setAccepted(true);
        setStatusMessage("Run accepted.");
        navigateToWatch(result.data.run.runId);
        return;
      }

      if (result.errorCode === "estimated_duration_rejected") {
        const rejection = estimateAdmissionRejectionDetailsSchema.safeParse(result.details);
        if (rejection.success) {
          if (isCustom) customEstimate.reject(rejection.data);
          return rejection.data;
        }
      }

      if (isCustom && result.errorCode === "estimated_capacity_rejected") {
        const capacity = capacityAssessmentSchema.safeParse(result.details);
        if (capacity.success) {
          customEstimate.rejectCapacity(capacity.data);
          return;
        }
      }

      if (
        isCustom &&
        (result.errorCode === "invalid_request" || result.errorCode === "invalid_run_configuration")
      ) {
        const paths = [customValidationPath(result.details?.path)];
        const entries = presentCustomRunIssues(paths).filter((entry) =>
          customEntryAppliesToMode(entry, customModeRef.current),
        );
        const infrastructureLimit = isInfrastructureRunLimitRejection(result);
        // An infrastructure limit with no form field to flag falls through to the operation notice.
        if (entries.length > 0 || !infrastructureLimit) {
          setCustomFailureSource(
            entries.length > 0
              ? {
                  kind: "validation",
                  validation: { kind: "issues", paths, mode: customModeRef.current },
                  ...(infrastructureLimit ? { notice: result } : {}),
                }
              : null,
          );
          return;
        }
      }

      setStartFailureSource({ read: result, startRequestOutcome: true });
      if (isCustom) {
        setCustomFailureSource({ kind: "operation", read: result });
      }
      const conflictReason =
        result.status === "unavailable" &&
        (result.details?.conflictReason === "active_run_exists" ||
          result.details?.conflictReason === "reset_incomplete")
          ? result.details.conflictReason
          : null;
      setStartConflictBlock(conflictReason);
      setActiveConflictRefreshComplete(false);
      if (result.status === "unavailable" && result.retryAfterMs && result.retryAfterMs > 0) {
        setStartRetryUntil(Date.now() + result.retryAfterMs);
      }
      // Every operational failure reaching this branch is an uncertain start outcome
      // until reconciled: refresh the current-run recovery (started after the failed
      // response, guaranteed by the recovery hook contract) and readiness together.
      await Promise.all([refresh(), refreshReadiness()]);
      if (conflictReason === "active_run_exists") setActiveConflictRefreshComplete(true);
    } finally {
      setStartingSlug(null);
    }
  }

  return (
    <div className="grid gap-5">
      <section
        aria-labelledby="curated-presets-heading"
        className={boardClassName}
        id="public-start-controls"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4 max-[700px]:flex-col max-[560px]:px-4">
          <div className="min-w-0">
            <h2
              className="type-title m-0 text-lg leading-tight text-ink"
              id="curated-presets-heading"
            >
              {t("Curated surge presets")}
            </h2>
            <SharedRuntimeDisclosure />
          </div>
          <StartGate
            isStarting={startingSlug !== null}
            isRetryScheduled={isRetryScheduled}
            onRetry={
              startConflictBlock === "reset_incomplete"
                ? reloadPage
                : () => {
                    void Promise.all([retryNow(), refreshReadiness()]);
                  }
            }
            postStartReconciliationPending={postStartReconciliationPending}
            showWaitingPanel={startRequestInFlight && !customStartPending}
            startRequestInFlight={startRequestInFlight}
            readiness={readiness}
            readyLabel={curatedPresets.length > 0 ? "ready" : "Custom scenario ready"}
            recovery={recovery}
            retriesExhausted={retriesExhausted}
            retryAttempt={retryAttempt}
            retryDelayMs={retryDelayMs}
            presentation={startPresentation}
            statusMessage={statusMessage}
            startRetryAfterMs={
              startRetryUntil === null ? null : Math.max(0, startRetryUntil - Date.now())
            }
            startOptionsAvailable={startOptionsAvailable}
          />
        </div>
        {surface.presets.status === "available" && curatedPresets.length > 0 ? (
          <div className="divide-y divide-border">
            {curatedPresets.map((preset) => {
              const facts = derivePresetCardFacts(preset, locale);
              const isRecommended = preset.slug === recommendedPresetSlug;
              const headingId = presetCardId(preset.slug);
              return (
                <article
                  aria-labelledby={headingId}
                  className={`relative grid min-w-0 grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)_minmax(0,0.85fr)_11.5rem] items-start gap-x-6 gap-y-2 px-5 py-3.5 max-[1100px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_11.5rem] max-[760px]:grid-cols-1 max-[560px]:px-4 ${
                    isRecommended
                      ? "bg-signal-soft/45 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-signal"
                      : ""
                  }`}
                  key={preset.slug}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="type-title m-0 text-base leading-snug text-ink" id={headingId}>
                        {t(preset.display.name)}
                      </h3>
                      {isRecommended ? (
                        <span className="rounded-full bg-signal px-2 py-0.5 text-xs font-semibold text-ink">
                          {t("Recommended: start here")}
                        </span>
                      ) : null}
                    </div>
                    <p className="m-0 mt-1 text-sm leading-5 text-muted">
                      {t(preset.display.description)}
                    </p>
                    {preset.comparison ? (
                      <Link
                        className={`${textLinkClassName} mt-1 inline-block text-sm`}
                        href={comparisonExplanationLinks[preset.comparison]}
                      >
                        {t("What this shows ")}
                        <span className="sr-only">
                          {t("for ")}
                          {t(preset.display.name)}
                        </span>
                      </Link>
                    ) : null}
                  </div>
                  <DemandGauge
                    demandLabel={facts.demandLabel}
                    demandNoun={preset.trafficConfig.mode === "buyer-spike" ? "buyers" : "attempts"}
                    demandValue={facts.demandValue}
                    stock={preset.inventoryConfig.startingStock}
                    uniqueAttempts={facts.uniqueAttempts}
                  />
                  <dl className="m-0 max-[1100px]:col-start-1 max-[1100px]:row-start-2 max-[760px]:row-start-auto">
                    <Fact label={t("What happens")} value={facts.distinguishingBehavior} />
                  </dl>
                  <PublicPresetStart
                    preset={preset}
                    disabled={startDisabled}
                    starting={startingSlug === preset.slug}
                    onStart={() => startRun(preset.slug)}
                  />
                  <details className="col-span-full -mt-1">
                    <summary className="disclosure rounded text-sm font-semibold text-accent">
                      {t("Technical details")}
                      <span className="sr-only">
                        {t(" for ")}
                        {t(preset.display.name)}
                      </span>
                    </summary>
                    <div className="mt-3 grid gap-3 rounded-lg border border-border bg-surface p-4">
                      <dl className="m-0 grid grid-cols-4 gap-x-5 gap-y-3 text-sm max-[1100px]:grid-cols-3 max-[760px]:grid-cols-2 max-[420px]:grid-cols-1">
                        <Fact
                          label={t("Scenario")}
                          value={trafficModeLabel(preset.trafficConfig.mode as TrafficMode, locale)}
                        />
                        <Fact
                          label={t("Simulated ERP capacity")}
                          value={`${formatCount(preset.erpConfig.maxTps, locale) ?? t("not configured")} ${t("orders/s")}`}
                        />
                        <Fact
                          label={t("Simulated ERP delay per order")}
                          value={
                            formatDurationMs(preset.erpConfig.latencyMs, locale) ?? "not configured"
                          }
                        />
                        <Fact
                          label={t("Worker concurrency / backpressure")}
                          value={deriveRunConfigFacts(preset, locale).workerBackpressure}
                        />
                        <Fact label={t("Duplicate attempts")} value={facts.duplicateAttempts} />
                        <Fact
                          label={t("Expected sold-out rejections")}
                          value={
                            formatCount(facts.expectedSoldOutCount, locale) ?? "not configured"
                          }
                        />
                        <Fact label={t("Detailed assumptions")} value={facts.outcomeFocus} />
                      </dl>
                      <ConditionalCaveat show={facts.hasDuplicateAttempts}>
                        {t(
                          "The API safely replays the same accepted reservation, so accepted responses can exceed unique reservations in the completed result.",
                        )}
                      </ConditionalCaveat>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        ) : surface.presets.status === "unavailable" ? (
          <div className="p-5">
            <Unavailable onRetry={reloadPage} read={surface.presets} />
          </div>
        ) : (
          <p className="m-0 p-5 text-muted">
            {t("No curated public presets are currently available.")}
          </p>
        )}
      </section>

      <details
        className={`${boardClassName} group`}
        onToggle={(event) => setCustomBuilderOpen(event.currentTarget.open)}
        ref={customBuilderRef}
      >
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-2xl px-5 py-4 max-[560px]:px-4 [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full border border-control-border text-sm font-bold text-ink transition-transform group-open:rotate-45"
          >
            +
          </span>
          <span className="type-title text-lg leading-tight text-ink">
            {t("Customize a scenario")}
          </span>
          {!customBuilderOpen && customDraftEdited ? (
            <span className="text-sm font-normal text-muted">{t("Edited settings retained")}</span>
          ) : (
            <span className="text-sm font-normal text-muted max-[700px]:hidden">
              {t("Set your own buyers, stock, and ERP speed within the public limits.")}
            </span>
          )}
        </summary>
        {runtimePolicy && customPreset && customConfig ? (
          <form
            aria-describedby={groupError("form") ? "custom-form-error" : undefined}
            aria-invalid={groupError("form") ? true : undefined}
            aria-label={t("Custom run builder")}
            className="grid border-t border-border"
            onSubmit={(event) => {
              event.preventDefault();
              if (customStartDisabled) return;

              const form = event.currentTarget;
              if (!form.checkValidity()) {
                const controls = Array.from(form.elements).flatMap((element) =>
                  element instanceof HTMLInputElement && !element.validity.valid
                    ? [{ controlId: element.id, message: element.validationMessage }]
                    : [],
                );
                setCustomFailureSource({
                  kind: "validation",
                  validation: { kind: "controls", controls },
                });
                return;
              }

              if (totalRequestsError) {
                setCustomFailureSource({
                  kind: "validation",
                  validation: {
                    kind: "traffic-limit",
                    limit: runtimePolicy.publicCustomLimits.maxTotalRequests,
                  },
                });
                return;
              }

              const parsed = startDemoRunRequestSchema.safeParse({
                presetSlug: customPreset.slug,
                configOverride: customConfig,
              });
              if (!parsed.success) {
                setCustomFailureSource({
                  kind: "validation",
                  validation: {
                    kind: "issues",
                    paths: parsed.error.issues.map((issue) => issue.path),
                    mode: customModeRef.current,
                  },
                });
                return;
              }

              void sendStartRequest(parsed.data, true);
            }}
            noValidate
          >
            <p className="m-0 border-b border-border px-5 py-3 text-sm leading-5 text-muted max-[560px]:px-4">
              {t("These limits were chosen for the infrastructure running this demo.")}{" "}
              {t(largerRunsGuidance)}
            </p>
            <fieldset
              aria-describedby={`custom-traffic-total${totalRequestsError ? " custom-traffic-error" : ""}${groupError("traffic") ? " custom-traffic-validation-error" : ""}`}
              aria-invalid={totalRequestsError || groupError("traffic") ? true : undefined}
              className={customFieldsetClassName}
            >
              <legend className={settingsLegendClassName}>{t("Buyers")}</legend>
              <TrafficModeSelector
                allowedModes={runtimePolicy.publicCustomLimits.allowedTrafficModes}
                mode={customDraft.mode}
                onChange={(mode) => updateCustomDraft((draft) => ({ ...draft, mode }))}
              />
              <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                {customDraft.mode === "buyer-spike" ? (
                  <>
                    <LabeledInput
                      hint={fieldHints.buyerCount}
                      id="custom-buyers"
                      key="buyer-count"
                      label={t("Buyer count")}
                      max={runtimePolicy.publicCustomLimits.maxBuyers}
                      min={1}
                      onChange={(buyerCount) =>
                        updateCustomDraft((draft) => ({ ...draft, buyerCount }))
                      }
                      submittedError={fieldError("custom-buyers")}
                      unit="buyers"
                      value={customDraft.buyerCount}
                    />
                    <div className="grid content-start gap-1 text-sm font-semibold text-ink min-[561px]:pt-7">
                      <div className="flex min-h-11 items-center gap-2">
                        <input
                          aria-describedby="custom-duplicate-description"
                          checked={customDraft.duplicateEachBuyerAttempt}
                          id="custom-duplicate"
                          onChange={(event) =>
                            updateCustomDraft((draft) => ({
                              ...draft,
                              duplicateEachBuyerAttempt: event.target.checked,
                            }))
                          }
                          type="checkbox"
                        />
                        <label htmlFor="custom-duplicate">
                          {t("Duplicate each buyer attempt")}
                        </label>
                        <FieldHint
                          label={t("Duplicate each buyer attempt")}
                          text={fieldHints.duplicateBuyerAttempt}
                        />
                      </div>
                      <span className={fieldHelpClassName} id="custom-duplicate-description">
                        {t("Doubles the planned attempts.")}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <LabeledInput
                      hint={fieldHints.arrivalRate}
                      id="custom-rate"
                      key="arrival-rate"
                      label={t("Arrival rate")}
                      max={runtimePolicy.publicCustomLimits.maxRequestsPerSecond}
                      min={1}
                      onChange={(ratePerSecond) =>
                        updateCustomDraft((draft) => ({ ...draft, ratePerSecond }))
                      }
                      submittedError={fieldError("custom-rate")}
                      unit="requests/second"
                      value={customDraft.ratePerSecond}
                    />
                    <LabeledInput
                      hint={fieldHints.trafficDuration}
                      id="custom-duration"
                      label={t("Traffic duration")}
                      max={runtimePolicy.publicCustomLimits.maxTrafficDurationSeconds}
                      min={1}
                      onChange={(durationSeconds) =>
                        updateCustomDraft((draft) => ({ ...draft, durationSeconds }))
                      }
                      submittedError={fieldError("custom-duration")}
                      unit="seconds"
                      value={customDraft.durationSeconds}
                    />
                  </>
                )}
              </div>
              <p
                className="m-0 flex items-center gap-2 text-sm font-semibold text-ink"
                id="custom-traffic-total"
              >
                {t("Planned total attempts: ")}
                {formatCount(plannedRequests, locale) ?? "—"}
                <FieldHint label={t("Planned total attempts")} text={fieldHints.plannedAttempts} />
              </p>
              {customDraft.mode === "constant-arrival-rate" ? (
                <p className="m-0 text-sm text-muted">
                  {t("Planned attempts = arrival rate × duration.")}
                </p>
              ) : null}
              {totalRequestsError ? (
                <p
                  className="m-0 text-sm font-semibold text-danger"
                  id="custom-traffic-error"
                  tabIndex={-1}
                >
                  {totalRequestsError}
                </p>
              ) : null}
              {groupError("traffic") ? (
                <CustomValidationError
                  error={groupError("traffic")}
                  id="custom-traffic-validation-error"
                />
              ) : null}
            </fieldset>

            <fieldset
              aria-describedby={groupError("stock") ? "custom-stock-validation-error" : undefined}
              aria-invalid={groupError("stock") ? true : undefined}
              className={customFieldsetClassName}
            >
              <legend className={settingsLegendClassName}>{t("Stock")}</legend>
              <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                <LabeledInput
                  hint={fieldHints.startingStock}
                  id="custom-stock"
                  label={t("Starting stock")}
                  max={runtimePolicy.publicCustomLimits.maxStartingStock}
                  min={0}
                  onChange={(startingStock) =>
                    updateCustomDraft((draft) => ({ ...draft, startingStock }))
                  }
                  submittedError={fieldError("custom-stock")}
                  unit="units"
                  value={customDraft.startingStock}
                />
              </div>
              {groupError("stock") ? (
                <CustomValidationError
                  error={groupError("stock")}
                  id="custom-stock-validation-error"
                />
              ) : null}
            </fieldset>

            <fieldset
              aria-describedby={groupError("erp") ? "custom-erp-validation-error" : undefined}
              aria-invalid={groupError("erp") ? true : undefined}
              className={customFieldsetClassName}
            >
              <legend className={settingsLegendClassName}>{t("Slow ERP")}</legend>
              <p className="m-0 text-sm text-muted">
                {t(
                  "The ERP is the simulated back-office system that confirms each order after its stock is reserved. Here it is deliberately slow and unreliable.",
                )}
              </p>
              <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                <LabeledInput
                  hint={fieldHints.erpDelay}
                  id="custom-erp-delay"
                  label={t("Delay per order")}
                  max={runtimePolicy.publicCustomLimits.maxErpLatencyMs}
                  min={0}
                  onChange={(erpLatencyMs) =>
                    updateCustomDraft((draft) => ({ ...draft, erpLatencyMs }))
                  }
                  submittedError={fieldError("custom-erp-delay")}
                  unit="milliseconds"
                  value={customDraft.erpLatencyMs}
                />
                <LabeledInput
                  hint={fieldHints.erpCapacity}
                  id="custom-erp-capacity"
                  label={t("Capacity")}
                  max={runtimePolicy.publicCustomLimits.maxErpMaxTps}
                  min={runtimePolicy.publicCustomLimits.minErpMaxTps}
                  onChange={(erpMaxTps) => updateCustomDraft((draft) => ({ ...draft, erpMaxTps }))}
                  submittedError={fieldError("custom-erp-capacity")}
                  unit="calls/second"
                  value={customDraft.erpMaxTps}
                />
                <LabeledInput
                  hint={fieldHints.erpFailureRate}
                  instruction="Enter 25 for 25%."
                  id="custom-erp-error-rate"
                  label={t("Failure rate")}
                  max={ratioToPercent(runtimePolicy.publicCustomLimits.maxErpErrorRate)}
                  min={0}
                  onChange={(erpErrorRate) =>
                    updateCustomDraft((draft) => ({ ...draft, erpErrorRate }))
                  }
                  step="0.01"
                  submittedError={fieldError("custom-erp-error-rate")}
                  unit="percent"
                  value={customDraft.erpErrorRate}
                />
              </div>
              {groupError("erp") ? (
                <CustomValidationError error={groupError("erp")} id="custom-erp-validation-error" />
              ) : null}
            </fieldset>

            <details
              className="border-b border-border px-5 py-4 max-[560px]:px-4"
              id="custom-protection-settings"
              ref={advancedSettingsRef}
            >
              <summary className="disclosure text-sm font-semibold text-ink">
                {t("Advanced protection settings")}{" "}
                <FieldHint
                  label={t("Advanced protection settings")}
                  text={fieldHints.advancedProtection}
                />
              </summary>
              <fieldset
                aria-describedby={
                  groupError("advanced") ? "custom-advanced-validation-error" : undefined
                }
                aria-invalid={groupError("advanced") ? true : undefined}
                className="m-0 mt-3 grid min-w-0 gap-3 border-0 p-0 min-[900px]:ml-44"
              >
                <legend className="sr-only">{t("Advanced protection settings")}</legend>
                <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                  {customDraft.mode === "buyer-spike" ? (
                    <LabeledInput
                      hint={fieldHints.safetyCutoff}
                      id="custom-safety-cutoff"
                      label={t("Safety cutoff")}
                      max={runtimePolicy.publicCustomLimits.maxTrafficDurationSeconds}
                      min={1}
                      onChange={(maxDurationSeconds) =>
                        updateCustomDraft((draft) => ({ ...draft, maxDurationSeconds }))
                      }
                      submittedError={fieldError("custom-safety-cutoff")}
                      unit="seconds"
                      value={customDraft.maxDurationSeconds}
                    />
                  ) : null}
                  <LabeledInput
                    hint={fieldHints.startDelay}
                    id="custom-start-delay"
                    label={t("Start delay")}
                    max={runtimePolicy.publicCustomLimits.maxTrafficStartDelaySeconds}
                    min={0}
                    onChange={(startDelaySeconds) =>
                      updateCustomDraft((draft) => ({ ...draft, startDelaySeconds }))
                    }
                    submittedError={fieldError("custom-start-delay")}
                    unit="seconds"
                    value={customDraft.startDelaySeconds}
                  />
                </div>
                {groupError("advanced") ? (
                  <CustomValidationError
                    error={groupError("advanced")}
                    id="custom-advanced-validation-error"
                  />
                ) : null}
              </fieldset>
            </details>

            <div className="grid gap-3 rounded-b-2xl bg-surface-muted px-5 py-4 max-[560px]:px-4">
              {groupError("form") ? (
                <CustomValidationError error={groupError("form")} id="custom-form-error" />
              ) : null}
              {customSubmissionFailure ? (
                <CustomErrorSummary
                  failure={customSubmissionFailure}
                  summaryRef={customSummaryRef}
                />
              ) : null}
              <RunEstimateNotice state={customEstimate.state} mode="public" />
              {startRequestInFlight && customStartPending ? (
                <RunStartWaitingPanel recovery={recovery} />
              ) : null}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="m-0 text-sm leading-5 text-muted-strong">
                  {publicRunBudgetCopy(runtimePolicy, locale)}
                </p>
                <button
                  className={`${primaryButtonClassName} min-w-44`}
                  disabled={customStartDisabled}
                  type="submit"
                >
                  {startingSlug === customPreset.slug
                    ? t("Starting custom run")
                    : t("Start custom run")}
                </button>
              </div>
            </div>
          </form>
        ) : surface.runtimePolicy.status === "unavailable" ? (
          <div className="border-t border-border p-5">
            <Unavailable onRetry={reloadPage} read={surface.runtimePolicy} />
          </div>
        ) : (
          <p className="m-0 border-t border-border p-5 text-muted">
            {t("Public custom is unavailable.")}
          </p>
        )}
      </details>
    </div>
  );
}

export function isRunStartBlocked(recovery: BackendRead<DashboardProjection>): boolean {
  if (recovery.status !== "available") {
    return true;
  }

  if (recovery.data.resetRecovery === "incomplete") return true;
  const status = recovery.data.currentRun?.status;
  return status === "starting" || status === "active" || status === "draining";
}

export function readinessBlocksRunStart(readiness: BackendRead<HealthResponse>): boolean {
  return readiness.status !== "available" || readiness.data.status !== "ok";
}

function PublicPresetStart({
  preset,
  disabled,
  starting,
  onStart,
}: {
  preset: DemoPresetContract;
  disabled: boolean;
  starting: boolean;
  onStart: () => Promise<EstimateAdmissionRejectionDetails | undefined>;
}) {
  const t = useTranslation();
  const [rejection, setRejection] = useState<EstimateAdmissionRejectionDetails>();
  const blocked = disabled || rejection !== undefined;
  return (
    <div className="grid min-w-0 gap-1 max-[760px]:max-w-72">
      {rejection ? (
        <RunEstimateNotice state={{ status: "rejected", result: rejection }} mode="public" />
      ) : null}
      <button
        className={`${primaryButtonClassName} w-full`}
        disabled={blocked}
        onClick={async () => {
          if (blocked) return;
          setRejection(await onStart());
        }}
        type="button"
      >
        {t(starting ? "Starting {name}" : "Start {name}", { name: t(preset.display.name) })}
      </button>
    </div>
  );
}

export function derivePresetCardFacts(preset: DemoPresetContract, locale: Locale = "en") {
  const configFacts = deriveRunConfigFacts(preset, locale);
  const uniqueAttempts = configFacts.uniqueAttempts;

  return {
    uniqueAttempts,
    surgeLabel: configFacts.surgeLabel,
    surgeValue: configFacts.surgeValue,
    hasDuplicateAttempts: configFacts.hasDuplicateAttempts,
    duplicateAttempts: configFacts.duplicateAttempts,
    demandLabel: configFacts.demandLabel,
    demandValue: configFacts.demandValue,
    distinguishingBehavior: presetDistinguishingBehavior(preset, locale),
    expectedSoldOutCount: Math.max(0, uniqueAttempts - preset.inventoryConfig.startingStock),
    outcomeFocus: presetOutcomeFocus(preset, locale),
  };
}

function buildCustomConfigOverride(
  draft: CustomDraft,
  defaults: AcceptedRunConfigSnapshot,
): DemoRunConfigOverride {
  return {
    trafficConfig:
      draft.mode === "buyer-spike"
        ? {
            mode: "buyer-spike",
            buyerCount: parseInteger(draft.buyerCount, 1),
            duplicateEachBuyerAttempt: draft.duplicateEachBuyerAttempt,
            startDelaySeconds: parseInteger(draft.startDelaySeconds, 0),
            maxDurationSeconds: parseInteger(draft.maxDurationSeconds, 1),
            quantityPerAttempt: defaults.trafficConfig.quantityPerAttempt,
          }
        : {
            mode: "constant-arrival-rate",
            ratePerSecond: parseInteger(draft.ratePerSecond, 1),
            startDelaySeconds: parseInteger(draft.startDelaySeconds, 0),
            durationSeconds: parseInteger(draft.durationSeconds, 1),
            quantityPerAttempt: defaults.trafficConfig.quantityPerAttempt,
          },
    inventoryConfig: {
      startingStock: parseInteger(draft.startingStock, 0),
    },
    erpConfig: {
      latencyMs: parseInteger(draft.erpLatencyMs, 0),
      maxTps: parseInteger(draft.erpMaxTps, 1),
      errorRate: percentToRatio(draft.erpErrorRate),
      forcedOutage: false,
    },
  };
}

function draftFromSnapshot(snapshot: AcceptedRunConfigSnapshot): CustomDraft {
  const traffic = snapshot.trafficConfig;

  return {
    mode: traffic.mode,
    buyerCount: traffic.mode === "buyer-spike" ? String(traffic.buyerCount) : "5000",
    duplicateEachBuyerAttempt:
      traffic.mode === "buyer-spike" ? traffic.duplicateEachBuyerAttempt : false,
    maxDurationSeconds: traffic.mode === "buyer-spike" ? String(traffic.maxDurationSeconds) : "80",
    ratePerSecond: traffic.mode === "constant-arrival-rate" ? String(traffic.ratePerSecond) : "20",
    durationSeconds:
      traffic.mode === "constant-arrival-rate" ? String(traffic.durationSeconds) : "30",
    startDelaySeconds: String(traffic.startDelaySeconds),
    startingStock: String(snapshot.inventoryConfig.startingStock),
    erpLatencyMs: String(snapshot.erpConfig.latencyMs),
    erpMaxTps: String(snapshot.erpConfig.maxTps),
    erpErrorRate: String(ratioToPercent(snapshot.erpConfig.errorRate)),
  };
}

function fallbackDraft(): CustomDraft {
  return {
    mode: "buyer-spike",
    buyerCount: "5000",
    duplicateEachBuyerAttempt: false,
    maxDurationSeconds: "80",
    ratePerSecond: "20",
    durationSeconds: "30",
    startDelaySeconds: "0",
    startingStock: "500",
    erpLatencyMs: "100",
    erpMaxTps: "20",
    erpErrorRate: "0",
  };
}

function publicRunBudgetCopy(
  {
    isPublicRunBudgetEnforced,
    publicRunBudget,
  }: Pick<PublicRuntimePolicy, "isPublicRunBudgetEnforced" | "publicRunBudget">,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  if (!isPublicRunBudgetEnforced) {
    return t("Public start budgets are not enforced right now.");
  }
  return t(
    "Up to {visitorCount} {visitorStarts} per visitor and {globalCount} {globalStarts} total every {window}.",
    {
      visitorCount: formatCount(publicRunBudget.perVisitorMaxStarts, locale) ?? "—",
      visitorStarts: t(pluralize(publicRunBudget.perVisitorMaxStarts, "start")),
      globalCount: formatCount(publicRunBudget.globalMaxStarts, locale) ?? "—",
      globalStarts: t(pluralize(publicRunBudget.globalMaxStarts, "start")),
      window: formatPolicyWindow(publicRunBudget.windowSeconds, locale),
    },
  );
}

function formatPolicyWindow(seconds: number, locale: Locale = "en"): string {
  if (seconds % 60 !== 0) return formatSeconds(seconds, locale);
  const minutes = seconds / 60;
  return `${formatCount(minutes, locale)} ${getTranslation(locale)(pluralize(minutes, "minute"))}`;
}

function formatSeconds(seconds: number, locale: Locale = "en"): string {
  return `${formatCount(seconds, locale)} ${getTranslation(locale)(pluralize(seconds, "second"))}`;
}

function navigateToWatch(acceptedRunId: string) {
  if (typeof window !== "undefined") {
    window.location.assign(`/watch?${new URLSearchParams({ acceptedRunId })}`);
  }
}

function reloadPage() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}

function parseInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function customValidationPath(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : [];
}

function CustomValidationError({
  error,
  id,
}: {
  error: { message: string } | undefined;
  id: string;
}) {
  const t = useTranslation();
  if (!error) return null;
  return (
    <p className="m-0 text-sm font-semibold text-danger" id={id} tabIndex={-1}>
      {t(error.message)}
    </p>
  );
}

function CustomErrorSummary({
  failure,
  summaryRef,
}: {
  failure: CustomSubmissionFailure;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslation();
  if (failure.kind === "operation") {
    return (
      <div
        aria-label={t("Operation failure")}
        className="grid gap-1 rounded-lg border border-danger-line bg-danger-soft p-3 text-danger"
        ref={summaryRef}
        role="alert"
        tabIndex={-1}
      >
        <h3 className="m-0 text-base font-bold">{t("Operation failure")}</h3>
        <strong>{failure.presentation.headline}</strong>
        {failure.presentation.explanation ? <span>{failure.presentation.explanation}</span> : null}
      </div>
    );
  }

  return (
    <div
      aria-labelledby="custom-error-summary-title"
      className="grid gap-2 rounded-lg border border-danger-line bg-danger-soft p-3 text-danger"
      ref={summaryRef}
      role="alert"
      tabIndex={-1}
    >
      <h3 className="m-0 text-base font-bold" id="custom-error-summary-title">
        {t("Fix these settings")}
      </h3>
      {failure.notice ? (
        <div className="grid gap-1">
          <strong>{failure.notice.headline}</strong>
          {failure.notice.explanation ? <span>{failure.notice.explanation}</span> : null}
        </div>
      ) : null}
      <ul className="m-0 list-disc pl-5">
        {failure.entries.map((entry) => (
          <li key={entry.key}>
            <a
              className="font-semibold underline"
              href={`#${entry.targetId}`}
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(entry.targetId)?.focus();
              }}
            >
              {t(entry.message)}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  const t = useTranslation();
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted">{t(label)}</dt>
      <dd className="m-0 mt-0.5 [overflow-wrap:anywhere] text-sm font-semibold leading-5 text-ink">
        {t(value)}
      </dd>
    </div>
  );
}

/**
 * Demand against supply at a glance: the ink segment is the stock that can sell, the signal
 * segment the demand that will meet a sold-out answer.
 */
function DemandGauge({
  demandLabel,
  demandNoun,
  demandValue,
  stock,
  uniqueAttempts,
}: {
  demandLabel: string;
  demandNoun: string;
  demandValue: string;
  stock: number;
  uniqueAttempts: number;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const sellableShare = uniqueAttempts > 0 ? Math.min(1, stock / uniqueAttempts) : 1;
  return (
    <div className="grid min-w-0 gap-1.5">
      <dl className="m-0 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Fact label={demandLabel} value={demandValue} />
        <div className="min-w-0 text-right max-[760px]:text-left">
          <dt className="text-xs font-medium text-muted">{t(publicVocabulary.startingStock)}</dt>
          <dd className="m-0 mt-0.5 text-sm font-semibold leading-5 text-ink">
            {formatCount(stock, locale) ?? t("not configured")}
          </dd>
        </div>
      </dl>
      <div aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-signal">
        <span className="block h-full bg-ink" style={{ width: `${sellableShare * 100}%` }} />
      </div>
      <p className="m-0 text-xs text-muted">
        {demandPressureCopy(uniqueAttempts, stock, demandNoun, locale)}
      </p>
    </div>
  );
}

function demandPressureCopy(
  uniqueAttempts: number,
  stock: number,
  noun: string,
  locale: Locale = "en",
): string {
  const t = getTranslation(locale);
  if (stock === 0) return t("No stock to sell");
  if (uniqueAttempts <= stock) return t("Enough stock for all {noun}", { noun: t(noun) });
  const ratio = uniqueAttempts / stock;
  const rounded = ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio);
  return t("{ratio}× more {noun} than units", {
    ratio: formatCount(rounded, locale) ?? "—",
    noun: t(noun),
  });
}

function SharedRuntimeDisclosure() {
  const t = useTranslation();
  return (
    <p className="m-0 mt-1 max-w-[72ch] text-sm leading-5 text-muted">
      {t(
        "Starting a bounded run uses the one shared demo runtime — other visitors can't start until it finishes. A successful start opens the live view.",
      )}
    </p>
  );
}

function Unavailable({ read, onRetry }: { read: BackendRead<unknown>; onRetry?: () => void }) {
  return (
    <ErrorNotice
      className="w-full"
      context="public-start"
      {...(onRetry ? { onRetry } : {})}
      read={read}
    />
  );
}

function StartGate({
  isStarting,
  isRetryScheduled,
  onRetry,
  postStartReconciliationPending,
  showWaitingPanel,
  startRequestInFlight,
  readiness,
  readyLabel,
  recovery,
  retriesExhausted,
  retryAttempt,
  retryDelayMs,
  presentation,
  statusMessage,
  startRetryAfterMs,
  startOptionsAvailable,
}: {
  isStarting: boolean;
  isRetryScheduled: boolean;
  onRetry: () => void;
  postStartReconciliationPending: boolean;
  showWaitingPanel: boolean;
  startRequestInFlight: boolean;
  readiness: BackendRead<HealthResponse>;
  readyLabel: string;
  recovery: BackendRead<DashboardProjection>;
  retriesExhausted: boolean;
  retryAttempt: number;
  retryDelayMs: number | null;
  presentation: ErrorPresentation | null;
  statusMessage: string | null;
  startRetryAfterMs: number | null;
  startOptionsAvailable: boolean;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const resetIncomplete =
    recovery.status === "available" && recovery.data.resetRecovery === "incomplete";
  const runInProgress = recovery.status === "available" && isRunStartBlocked(recovery);
  const runPresentation = deriveRunPresentationState(recovery, undefined, undefined, locale);
  const relocatingRunner = runPresentation.state === "relocating-load-generator";
  // The visitor's own pending start is not "another run in progress".
  const activeRunPresentation =
    runInProgress && !relocatingRunner && !isStarting
      ? mapErrorPresentation(
          {
            status: "unavailable",
            errorCode: "run_conflict",
            details: { conflictReason: resetIncomplete ? "reset_incomplete" : "active_run_exists" },
          },
          "public-start",
          locale,
        )
      : null;
  const recoveryUnavailable = recovery.status === "unavailable";
  const readinessBlocked = readinessBlocksRunStart(readiness);
  const retryAfterMs = [
    recovery.status === "unavailable" ? recovery.retryAfterMs : undefined,
    readiness.status === "unavailable" ? readiness.retryAfterMs : undefined,
    startRetryAfterMs ?? undefined,
  ].find((value) => value !== undefined);
  const retryWaitActive = retryAfterMs !== undefined && retryAfterMs > 0;
  const shouldShowRetryWait =
    retryWaitActive && (recoveryUnavailable || readinessBlocked || startRetryAfterMs !== null);

  return (
    <div className="grid max-w-[32rem] justify-items-end gap-2 text-right max-[700px]:w-full max-[700px]:max-w-none max-[700px]:justify-items-start max-[700px]:text-left">
      <div className="flex flex-wrap justify-end gap-2 max-[700px]:justify-start">
        {recovery.status !== "available" ? (
          <StatusPill status={deriveRunPresentationState(recovery, undefined, undefined, locale)} />
        ) : resetIncomplete ? (
          <StatusPill status={{ label: "Recovery incomplete", tone: "warning" }} />
        ) : runInProgress ? (
          <StatusPill status={runPresentation} />
        ) : postStartReconciliationPending ? (
          <StatusPill status={{ label: "Checking run status", tone: "idle" }} />
        ) : isStarting ? (
          <StatusPill status={{ label: "Starting", tone: "progress" }} />
        ) : startRetryAfterMs !== null ? (
          <StatusPill status={{ label: "Cooldown", tone: "warning" }} />
        ) : readinessBlocked ? (
          <StatusPill status={readinessPresentation(readiness, locale)} />
        ) : !startOptionsAvailable ? (
          <StatusPill status={{ label: "Scenarios unavailable", tone: "warning" }} />
        ) : (
          <StatusPill status={{ label: readyLabel, tone: "idle" }} />
        )}
      </div>
      {showWaitingPanel ? <RunStartWaitingPanel className="w-full" recovery={recovery} /> : null}
      {startRequestInFlight ? null : <RunnerRelocationNotice recovery={recovery} />}
      {activeRunPresentation ? (
        <ErrorNotice
          className="w-full"
          context="public-start"
          {...(resetIncomplete ? { onRetry } : {})}
          presentation={activeRunPresentation}
        />
      ) : null}
      {!activeRunPresentation && !presentation && readinessBlocked ? (
        <ReadinessNotice
          {...(readiness.status === "unavailable" && readiness.retryAfterMs ? {} : { onRetry })}
          read={readiness}
        />
      ) : null}
      {!activeRunPresentation && !presentation && recoveryUnavailable ? (
        <Unavailable onRetry={onRetry} read={recovery} />
      ) : null}
      {!activeRunPresentation &&
      (recoveryUnavailable || readinessBlocked || startRetryAfterMs !== null) ? (
        shouldShowRetryWait && retryAfterMs !== undefined ? (
          <p className="m-0 text-sm text-muted">
            {t("Wait ")}
            {formatSeconds(Math.ceil(retryAfterMs / 1_000), locale)}
            {t(" before trying again.")}
          </p>
        ) : null
      ) : null}
      {!activeRunPresentation && isRetryScheduled && retryDelayMs !== null ? (
        <p className="m-0 text-sm text-muted">
          {t("Automatic retry ")}
          {retryAttempt}
          {t(" in ")}
          {formatSeconds(Math.ceil(retryDelayMs / 1_000), locale)}.
        </p>
      ) : !activeRunPresentation && retriesExhausted ? (
        <p className="m-0 text-sm text-muted">
          {t("Automatic retries paused. Manual retry remains available.")}
        </p>
      ) : null}
      {!activeRunPresentation && presentation ? (
        <ErrorNotice context="public-start" onRetry={onRetry} presentation={presentation} />
      ) : !activeRunPresentation && statusMessage ? (
        <p className="m-0 text-sm font-semibold text-muted-strong">{t(statusMessage)}</p>
      ) : null}
    </div>
  );
}

function customEntryAppliesToMode(entry: CustomRunSummaryEntry, mode: TrafficMode): boolean {
  if (mode === "buyer-spike") {
    return entry.fieldId !== "custom-rate" && entry.fieldId !== "custom-duration";
  }
  return entry.fieldId !== "custom-buyers" && entry.fieldId !== "custom-safety-cutoff";
}

function readinessPresentation(
  readiness: BackendRead<HealthResponse>,
  locale: Locale = "en",
): Pick<PresentationState, "label" | "tone"> {
  const readinessStatus =
    readiness.status === "unavailable" ||
    (readiness.status === "available" && readiness.data.status === "unavailable")
      ? "unavailable"
      : "degraded";
  const presentation =
    readiness.status === "loading"
      ? mapErrorPresentation(readiness, "public-start")
      : mapErrorPresentation(readiness, {
          surface: "public-start",
          readiness: readinessStatus,
        });
  return {
    label: getTranslation(locale)(
      readiness.status === "loading" ? "checking infrastructure" : "backend not ready",
    ),
    tone: presentation.tone,
  };
}

function ReadinessNotice({
  onRetry,
  read,
}: {
  onRetry?: () => void;
  read: BackendRead<HealthResponse>;
}) {
  if (read.status === "available" && read.data.status === "ok") return null;
  if (read.status === "loading")
    return <ErrorNotice context="public-start" {...(onRetry ? { onRetry } : {})} read={read} />;
  return (
    <ErrorNotice
      context={{
        surface: "public-start",
        readiness:
          read.status === "unavailable" || read.data.status === "unavailable"
            ? "unavailable"
            : "degraded",
      }}
      {...(onRetry ? { onRetry } : {})}
      read={read}
    />
  );
}

function TrafficModeSelector({
  allowedModes,
  mode,
  onChange,
}: {
  allowedModes: TrafficMode[];
  mode: TrafficMode;
  onChange: (mode: TrafficMode) => void;
}) {
  const t = useTranslation();
  const locale = useLocale();
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-0 p-0">
      <legend className="float-left mr-1 flex min-h-11 items-center text-sm font-semibold text-ink">
        {t("Traffic pattern")}
      </legend>
      <FieldHint label={t("Traffic pattern")} text={fieldHints.trafficPattern} />
      {(["buyer-spike", "constant-arrival-rate"] as const).map((trafficMode) => {
        const id = `custom-traffic-mode-${trafficMode}`;
        return (
          <label
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm font-semibold text-muted-strong has-checked:border-accent has-checked:bg-accent-soft has-checked:text-ink has-disabled:cursor-not-allowed has-disabled:opacity-55"
            htmlFor={id}
            key={trafficMode}
          >
            <input
              checked={trafficMode === mode}
              disabled={!allowedModes.includes(trafficMode)}
              id={id}
              name="custom-traffic-mode"
              onChange={() => onChange(trafficMode)}
              type="radio"
              value={trafficMode}
            />
            {trafficModeLabel(trafficMode, locale)}
          </label>
        );
      })}
    </fieldset>
  );
}

function LabeledInput({
  hint,
  instruction,
  id,
  label,
  max,
  min,
  onChange,
  step,
  submittedError,
  unit,
  value,
}: {
  hint: string;
  instruction?: string;
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  step?: string;
  submittedError?: string | undefined;
  unit: string;
  value: string;
}) {
  const t = useTranslation();
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const visibleError = error ?? submittedError;

  return (
    <div className="grid min-w-0 content-start gap-1 text-sm text-muted-strong">
      <div className="flex min-h-6 items-center gap-1.5">
        <label className={fieldLabelClassName} htmlFor={id}>
          {t(label)} ({t(unit)})
        </label>
        <FieldHint label={label} text={hint} />
      </div>
      <input
        aria-describedby={`${descriptionId}${visibleError ? ` ${errorId}` : ""}`}
        aria-invalid={visibleError ? true : undefined}
        className={inputClassName}
        id={id}
        max={max}
        min={min}
        onChange={(event) => {
          setError(null);
          onChange(event.target.value);
        }}
        onInvalid={(event) => setError(event.currentTarget.validationMessage)}
        required
        step={step}
        type="number"
        value={value}
      />
      <span className={fieldHelpClassName} id={descriptionId}>
        {t("Unit: ")}
        {t(unit)}
        {t(". Minimum: ")}
        {formatCount(min, locale)}
        {t(". Maximum: ")}
        {formatCount(max, locale)}.{instruction ? ` ${t(instruction)}` : ""}
      </span>
      {visibleError ? (
        <span className="text-xs font-semibold text-danger" id={errorId}>
          {t(visibleError)}
        </span>
      ) : null}
    </div>
  );
}
