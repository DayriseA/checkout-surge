"use client";

import {
  type AcceptedRunConfigSnapshot,
  calculatePlannedRequests,
  type DashboardProjection,
  type DemoPresetContract,
  type DemoRunConfigOverride,
  type HealthResponse,
  healthResponseSchema,
  type PublicRuntimePolicy,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackendRead, PublicDemoSurface } from "../lib/api";
import { readProxyJson } from "../lib/client/proxy-json";
import { demoRunStartProxyPath, healthReadyProxyPath } from "../lib/control-paths";
import {
  type ErrorPresentation,
  mapErrorPresentation,
} from "../lib/presentation/error-presentation";
import { formatCount, formatDurationMs } from "../lib/presentation/format";
import {
  outcomeFocusLabel,
  publicVocabulary,
  trafficModeLabel,
} from "../lib/presentation/public-vocabulary";
import {
  deriveRunPresentationState,
  type PresentationState,
} from "../lib/presentation/run-presentation-state";
import { ErrorNotice } from "./error-notice";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";
import { StatusPill } from "./status-pill";
import { ConditionalCaveat } from "./transport-observation";

const recoveryPollIntervalMs = 15_000;
const readinessPollIntervalMs = 60_000;
const panelClassName = "min-w-0 rounded-lg border border-border bg-surface p-4";
const primaryButtonClassName =
  "min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";
const inputClassName = "min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink";
const recommendedPresetSlug = "preview-1k";

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

type CustomErrorGroup = "traffic" | "stock" | "erp" | "advanced" | "form";

interface CustomFormError {
  group: CustomErrorGroup;
  message: string;
}

export function PublicDemoEntry({ surface }: { surface: PublicDemoSurface }) {
  const [startingSlug, setStartingSlug] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [startPresentation, setStartPresentation] = useState<ErrorPresentation | null>(null);
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
  const [customFormError, setCustomFormError] = useState<CustomFormError | null>(null);
  const advancedSettingsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (customFormError?.group === "advanced" && advancedSettingsRef.current) {
      advancedSettingsRef.current.open = true;
    }
  }, [customFormError]);

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

  useEffect(() => {
    if (recovery.status !== "available") return;
    const interval = setInterval(() => void refresh(), recoveryPollIntervalMs);
    return () => clearInterval(interval);
  }, [recovery.status, refresh]);

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
    if (startRetryUntil === null) return;
    const remainingMs = Math.max(0, startRetryUntil - Date.now());
    const timer = setTimeout(() => {
      setStartRetryUntil(null);
      setStartPresentation(
        startConflictBlock === null
          ? null
          : mapErrorPresentation(
              {
                status: "unavailable",
                errorCode: "run_conflict",
                details: { conflictReason: startConflictBlock },
              },
              "public-start",
            ),
      );
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [startConflictBlock, startRetryUntil]);

  useEffect(() => {
    if (
      startConflictBlock !== "active_run_exists" ||
      !activeConflictRefreshComplete ||
      recovery.status !== "available"
    ) {
      return;
    }
    if (isRunStartBlocked(recovery)) {
      setStartPresentation(null);
      return;
    }
    setStartConflictBlock(null);
    setStartPresentation(null);
  }, [activeConflictRefreshComplete, recovery, startConflictBlock]);

  useEffect(() => {
    if (recovery.status !== "available" || !isRunStartBlocked(recovery)) return;
    if (startRetryUntil === null) {
      if (startPresentation !== null) setStartPresentation(null);
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
      ? `Reduce the buyer count, rate, duration, or duplicate attempts to ${formatCount(runtimePolicy.publicCustomLimits.maxTotalRequests)} planned attempts or fewer.`
      : null;
  const startDisabled =
    isBlocked ||
    isReadinessBlocked ||
    startingSlug !== null ||
    startConflictBlock !== null ||
    startRetryUntil !== null ||
    surface.presets.status !== "available" ||
    recovery.status !== "available";
  const customStartDisabled = startDisabled || totalRequestsError !== null;

  function updateCustomDraft(update: (draft: CustomDraft) => CustomDraft) {
    setCustomDraft(update);
    setCustomFormError(null);
  }

  async function startRun(
    presetSlug: string,
    configOverride?: DemoRunConfigOverride,
    isCustom = false,
  ) {
    const parsed = startDemoRunRequestSchema.safeParse({
      presetSlug,
      ...(configOverride ? { configOverride } : {}),
    });

    if (!parsed.success) {
      setStatusMessage(null);
      if (isCustom) {
        setCustomFormError(customValidationError(parsed.error.issues.map((issue) => issue.path)));
        return;
      }
      setStartPresentation(
        mapErrorPresentation(
          { status: "unavailable", errorCode: "invalid_request", reason: "invalid request" },
          "public-start",
        ),
      );
      return;
    }

    setStartingSlug(presetSlug);
    setStatusMessage(null);
    setStartPresentation(null);
    setCustomFormError(null);
    setStartRetryUntil(null);

    try {
      const result = await readProxyJson(demoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });

      if (result.status === "available") {
        setStatusMessage("Run accepted.");
        navigateToWatch();
        return;
      }

      if (
        isCustom &&
        (result.errorCode === "invalid_request" || result.errorCode === "invalid_run_configuration")
      ) {
        setCustomFormError(customValidationError([customValidationPath(result.details?.path)]));
        return;
      }

      const presentation = mapErrorPresentation(result, "public-start");
      setStartPresentation(presentation);
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
      if (conflictReason) {
        await Promise.all([refresh(), refreshReadiness()]);
        if (conflictReason === "active_run_exists") setActiveConflictRefreshComplete(true);
      } else {
        await refreshReadiness();
      }
    } finally {
      setStartingSlug(null);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className={`${panelClassName} col-span-12`}>
        <div className="mb-4 flex items-start justify-between gap-3 max-[700px]:flex-col">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Public demo</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
              Curated surge presets
            </h2>
          </div>
          <StartGate
            isRetryScheduled={isRetryScheduled}
            onRetry={
              startConflictBlock === "reset_incomplete"
                ? reloadPage
                : () => {
                    void Promise.all([retryNow(), refreshReadiness()]);
                  }
            }
            readiness={readiness}
            recovery={recovery}
            retriesExhausted={retriesExhausted}
            retryAttempt={retryAttempt}
            retryDelayMs={retryDelayMs}
            presentation={startPresentation}
            statusMessage={statusMessage}
            startRetryAfterMs={
              startRetryUntil === null ? null : Math.max(0, startRetryUntil - Date.now())
            }
          />
        </div>
        <SharedRuntimeDisclosure />
        {surface.presets.status === "available" && curatedPresets.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
            {curatedPresets.map((preset) => {
              const facts = derivePresetCardFacts(preset);
              const isRecommended = preset.slug === recommendedPresetSlug;
              const headingId = `${preset.slug}-title`;
              return (
                <article
                  aria-labelledby={headingId}
                  className={`min-w-0 rounded-lg border p-3 ${
                    isRecommended ? "border-accent bg-accent-soft" : "border-border"
                  }`}
                  key={preset.slug}
                >
                  <div className="mb-3 grid gap-1">
                    {isRecommended ? (
                      <span className="w-fit rounded-full bg-accent px-2 py-1 text-xs font-bold text-white">
                        Recommended: start here
                      </span>
                    ) : null}
                    <h3 className="m-0 text-base font-bold text-ink" id={headingId}>
                      {preset.display.name}
                    </h3>
                    <span className="text-sm leading-5 text-muted">
                      {preset.display.description}
                    </span>
                  </div>
                  <dl className="m-0 mb-3 grid grid-cols-2 gap-3 text-sm">
                    <Fact
                      label="Scenario"
                      value={trafficModeLabel(preset.trafficConfig.mode as TrafficMode)}
                    />
                    <Fact label={facts.surgeLabel} value={facts.surgeValue} />
                    <Fact
                      label={publicVocabulary.startingStock}
                      value={formatCount(preset.inventoryConfig.startingStock) ?? "not configured"}
                    />
                    <Fact
                      label="Simulated ERP capacity"
                      value={`${formatCount(preset.erpConfig.maxTps) ?? "not configured"} orders/s`}
                    />
                    <Fact
                      label="Simulated ERP delay per order"
                      value={formatDurationMs(preset.erpConfig.latencyMs) ?? "not configured"}
                    />
                    <Fact label="Duplicate attempts" value={facts.duplicateAttempts} />
                    <Fact
                      label="Expected sold-out rejections"
                      value={formatCount(facts.expectedSoldOutCount) ?? "not configured"}
                    />
                    <Fact label="Approximate settling" value={facts.settlingCopy} />
                    <Fact label="What to watch for" value={facts.outcomeFocus} />
                  </dl>
                  <ConditionalCaveat show={facts.hasDuplicateAttempts}>
                    The API safely replays the same accepted reservation, so accepted responses can
                    exceed unique reservations in the completed result.
                  </ConditionalCaveat>
                  <button
                    className={`${primaryButtonClassName} mt-3`}
                    disabled={startDisabled}
                    onClick={() => {
                      void startRun(preset.slug);
                    }}
                    type="button"
                  >
                    {startingSlug === preset.slug
                      ? `Starting ${preset.display.name}`
                      : `Start ${preset.display.name}`}
                  </button>
                </article>
              );
            })}
          </div>
        ) : surface.presets.status === "unavailable" ? (
          <Unavailable onRetry={reloadPage} read={surface.presets} />
        ) : (
          <p className="m-0 text-muted">No curated public presets are currently available.</p>
        )}
      </section>

      <details className={`${panelClassName} col-span-12`}>
        <summary className="cursor-pointer text-base font-bold text-ink">
          Build your own run
        </summary>
        {runtimePolicy && customPreset && customConfig ? (
          <form
            aria-describedby={customFormError?.group === "form" ? "custom-form-error" : undefined}
            aria-invalid={customFormError?.group === "form" ? true : undefined}
            aria-label="Custom run builder"
            className="mt-4 grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!customStartDisabled) void startRun(customPreset.slug, customConfig, true);
            }}
          >
            <fieldset
              aria-describedby={`custom-traffic-total${totalRequestsError ? " custom-traffic-error" : ""}${customFormError?.group === "traffic" ? " custom-traffic-validation-error" : ""}`}
              aria-invalid={
                totalRequestsError || customFormError?.group === "traffic" ? true : undefined
              }
              className="grid gap-3 rounded-lg border border-border p-3"
            >
              <legend className="px-1 font-bold text-ink">Buyers</legend>
              <TrafficModeSelector
                allowedModes={runtimePolicy.publicCustomLimits.allowedTrafficModes}
                mode={customDraft.mode}
                onChange={(mode) => updateCustomDraft((draft) => ({ ...draft, mode }))}
              />
              <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                {customDraft.mode === "buyer-spike" ? (
                  <>
                    <LabeledInput
                      helper="How many distinct buyers arrive in the spike."
                      id="custom-buyers"
                      key="buyer-count"
                      label="Buyer count"
                      max={runtimePolicy.publicCustomLimits.maxBuyers}
                      min={1}
                      onChange={(buyerCount) =>
                        updateCustomDraft((draft) => ({ ...draft, buyerCount }))
                      }
                      unit="buyers"
                      value={customDraft.buyerCount}
                    />
                    <div className="grid content-start gap-1 text-sm font-semibold text-muted-strong">
                      <span className="flex min-h-10 items-center gap-2">
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
                        <label htmlFor="custom-duplicate">Duplicate each buyer attempt</label>
                      </span>
                      <span
                        className="font-normal leading-5 text-muted"
                        id="custom-duplicate-description"
                      >
                        Sends the same request twice per buyer and doubles planned attempts.
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <LabeledInput
                      helper="Requests dispatched during each second."
                      id="custom-rate"
                      key="arrival-rate"
                      label="Arrival rate"
                      max={runtimePolicy.publicCustomLimits.maxRequestsPerSecond}
                      min={1}
                      onChange={(ratePerSecond) =>
                        updateCustomDraft((draft) => ({ ...draft, ratePerSecond }))
                      }
                      unit="requests/second"
                      value={customDraft.ratePerSecond}
                    />
                    <LabeledInput
                      helper="Arrival rate × duration determines planned attempts."
                      id="custom-duration"
                      label="Traffic duration"
                      max={runtimePolicy.publicCustomLimits.maxTrafficDurationSeconds}
                      min={1}
                      onChange={(durationSeconds) =>
                        updateCustomDraft((draft) => ({ ...draft, durationSeconds }))
                      }
                      unit="seconds"
                      value={customDraft.durationSeconds}
                    />
                  </>
                )}
              </div>
              <p className="m-0 text-sm font-semibold text-ink" id="custom-traffic-total">
                Planned total attempts: {formatCount(plannedRequests) ?? "—"}
              </p>
              {totalRequestsError ? (
                <p className="m-0 text-sm font-semibold text-danger" id="custom-traffic-error">
                  {totalRequestsError}
                </p>
              ) : null}
              {customFormError?.group === "traffic" ? (
                <CustomValidationError
                  error={customFormError}
                  id="custom-traffic-validation-error"
                />
              ) : null}
            </fieldset>

            <fieldset
              aria-describedby={
                customFormError?.group === "stock" ? "custom-stock-validation-error" : undefined
              }
              aria-invalid={customFormError?.group === "stock" ? true : undefined}
              className="grid gap-3 rounded-lg border border-border p-3"
            >
              <legend className="px-1 font-bold text-ink">Stock</legend>
              <LabeledInput
                helper="Units available before the run begins."
                id="custom-stock"
                label="Starting stock"
                max={runtimePolicy.publicCustomLimits.maxStartingStock}
                min={0}
                onChange={(startingStock) =>
                  updateCustomDraft((draft) => ({ ...draft, startingStock }))
                }
                unit="units"
                value={customDraft.startingStock}
              />
              {customFormError?.group === "stock" ? (
                <CustomValidationError error={customFormError} id="custom-stock-validation-error" />
              ) : null}
            </fieldset>

            <fieldset
              aria-describedby={
                customFormError?.group === "erp" ? "custom-erp-validation-error" : undefined
              }
              aria-invalid={customFormError?.group === "erp" ? true : undefined}
              className="grid gap-3 rounded-lg border border-border p-3"
            >
              <legend className="px-1 font-bold text-ink">Slow ERP</legend>
              <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                <LabeledInput
                  helper="Added delay for each simulated ERP call."
                  id="custom-erp-delay"
                  label="Delay per order"
                  max={runtimePolicy.publicCustomLimits.maxErpLatencyMs}
                  min={0}
                  onChange={(erpLatencyMs) =>
                    updateCustomDraft((draft) => ({ ...draft, erpLatencyMs }))
                  }
                  unit="milliseconds"
                  value={customDraft.erpLatencyMs}
                />
                <LabeledInput
                  helper="Maximum simulated ERP throughput."
                  id="custom-erp-capacity"
                  label="Capacity"
                  max={runtimePolicy.publicCustomLimits.maxErpMaxTps}
                  min={runtimePolicy.publicCustomLimits.minErpMaxTps}
                  onChange={(erpMaxTps) => updateCustomDraft((draft) => ({ ...draft, erpMaxTps }))}
                  unit="orders/second"
                  value={customDraft.erpMaxTps}
                />
                <LabeledInput
                  helper="Enter 25 for a 25% simulated failure rate."
                  id="custom-erp-error-rate"
                  label="Failure rate"
                  max={ratioToPercent(runtimePolicy.publicCustomLimits.maxErpErrorRate)}
                  min={0}
                  onChange={(erpErrorRate) =>
                    updateCustomDraft((draft) => ({ ...draft, erpErrorRate }))
                  }
                  step="0.01"
                  unit="percent"
                  value={customDraft.erpErrorRate}
                />
              </div>
              {customFormError?.group === "erp" ? (
                <CustomValidationError error={customFormError} id="custom-erp-validation-error" />
              ) : null}
            </fieldset>

            <details className="rounded-lg border border-border p-3" ref={advancedSettingsRef}>
              <summary className="cursor-pointer font-bold text-ink">
                Advanced protection settings
              </summary>
              <fieldset
                aria-describedby={
                  customFormError?.group === "advanced"
                    ? "custom-advanced-validation-error"
                    : undefined
                }
                aria-invalid={customFormError?.group === "advanced" ? true : undefined}
                className="mt-3 grid gap-3"
              >
                <legend className="sr-only">Advanced protection settings</legend>
                <div className="grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
                  {customDraft.mode === "buyer-spike" ? (
                    <LabeledInput
                      helper="Stops dispatch if the spike overruns — not the expected run duration."
                      id="custom-safety-cutoff"
                      label="Safety cutoff"
                      max={runtimePolicy.publicCustomLimits.maxTrafficDurationSeconds}
                      min={1}
                      onChange={(maxDurationSeconds) =>
                        updateCustomDraft((draft) => ({ ...draft, maxDurationSeconds }))
                      }
                      unit="seconds"
                      value={customDraft.maxDurationSeconds}
                    />
                  ) : null}
                  <LabeledInput
                    helper="Wait before the load generator starts dispatching."
                    id="custom-start-delay"
                    label="Start delay"
                    max={runtimePolicy.publicCustomLimits.maxTrafficStartDelaySeconds}
                    min={0}
                    onChange={(startDelaySeconds) =>
                      updateCustomDraft((draft) => ({ ...draft, startDelaySeconds }))
                    }
                    unit="seconds"
                    value={customDraft.startDelaySeconds}
                  />
                </div>
                {customFormError?.group === "advanced" ? (
                  <CustomValidationError
                    error={customFormError}
                    id="custom-advanced-validation-error"
                  />
                ) : null}
              </fieldset>
            </details>

            {customFormError?.group === "form" ? (
              <CustomValidationError error={customFormError} id="custom-form-error" />
            ) : null}
            <p className="m-0 text-sm leading-6 text-muted-strong">
              {publicRunBudgetCopy(runtimePolicy)}
            </p>
            <SharedRuntimeDisclosure />
            <button className={primaryButtonClassName} disabled={customStartDisabled} type="submit">
              {startingSlug === customPreset.slug ? "Starting custom run" : "Start custom run"}
            </button>
          </form>
        ) : surface.runtimePolicy.status === "unavailable" ? (
          <Unavailable onRetry={reloadPage} read={surface.runtimePolicy} />
        ) : (
          <p className="m-0 text-muted">Public custom is unavailable.</p>
        )}
      </details>
    </div>
  );
}

export function isRunStartBlocked(recovery: BackendRead<DashboardProjection>): boolean {
  if (recovery.status !== "available") {
    return true;
  }

  const status = recovery.data.currentRun?.status;
  return status === "starting" || status === "active" || status === "draining";
}

export function readinessBlocksRunStart(readiness: BackendRead<HealthResponse>): boolean {
  return readiness.status !== "available" || readiness.data.status !== "ok";
}

export function derivePresetCardFacts(preset: DemoPresetContract) {
  const traffic = preset.trafficConfig;
  const uniqueAttempts =
    traffic.mode === "buyer-spike"
      ? traffic.buyerCount
      : traffic.ratePerSecond * traffic.durationSeconds;
  const expectedConfirmedOrders = Math.min(uniqueAttempts, preset.inventoryConfig.startingStock);
  const workerThroughput =
    preset.erpConfig.latencyMs === 0
      ? Number.POSITIVE_INFINITY
      : (preset.backpressureConfig.orderProcessConcurrency * 1_000) / preset.erpConfig.latencyMs;
  const settlingSeconds = Math.max(
    1,
    Math.ceil(expectedConfirmedOrders / Math.min(preset.erpConfig.maxTps, workerThroughput)),
  );
  const hasDuplicateAttempts = traffic.mode === "buyer-spike" && traffic.duplicateEachBuyerAttempt;

  return {
    surgeLabel: traffic.mode === "buyer-spike" ? "Buyers" : "Planned unique attempts",
    surgeValue: formatCount(uniqueAttempts) ?? "not configured",
    hasDuplicateAttempts,
    duplicateAttempts: hasDuplicateAttempts
      ? "Yes — every buyer sends the same request twice"
      : traffic.mode === "buyer-spike"
        ? "No — one request per buyer"
        : "No",
    expectedSoldOutCount: Math.max(0, uniqueAttempts - preset.inventoryConfig.startingStock),
    settlingCopy: `Usually about ${formatDurationMs(settlingSeconds * 1_000) ?? `${settlingSeconds}s`} on the demo host; actual time depends on the environment`,
    outcomeFocus: preset.display.outcomeFocus.map(outcomeFocusLabel).join(" · "),
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
      quantityPerCheckout: defaults.inventoryConfig.quantityPerCheckout,
      reservationHoldMinutes: defaults.inventoryConfig.reservationHoldMinutes,
    },
    erpConfig: {
      latencyMs: parseInteger(draft.erpLatencyMs, 0),
      maxTps: parseInteger(draft.erpMaxTps, 1),
      errorRate: percentToRatio(draft.erpErrorRate),
      forcedOutage: false,
      requestTimeoutMs: defaults.erpConfig.requestTimeoutMs,
    },
  };
}

function draftFromSnapshot(snapshot: AcceptedRunConfigSnapshot): CustomDraft {
  const traffic = snapshot.trafficConfig;

  return {
    mode: traffic.mode,
    buyerCount: traffic.mode === "buyer-spike" ? String(traffic.buyerCount) : "500",
    duplicateEachBuyerAttempt:
      traffic.mode === "buyer-spike" ? traffic.duplicateEachBuyerAttempt : false,
    maxDurationSeconds: traffic.mode === "buyer-spike" ? String(traffic.maxDurationSeconds) : "10",
    ratePerSecond: traffic.mode === "constant-arrival-rate" ? String(traffic.ratePerSecond) : "50",
    durationSeconds:
      traffic.mode === "constant-arrival-rate" ? String(traffic.durationSeconds) : "10",
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
    buyerCount: "500",
    duplicateEachBuyerAttempt: false,
    maxDurationSeconds: "10",
    ratePerSecond: "50",
    durationSeconds: "10",
    startDelaySeconds: "0",
    startingStock: "100",
    erpLatencyMs: "100",
    erpMaxTps: "100",
    erpErrorRate: "0",
  };
}

function publicRunBudgetCopy({
  isPublicRunBudgetEnforced,
  publicRunBudget,
}: Pick<PublicRuntimePolicy, "isPublicRunBudgetEnforced" | "publicRunBudget">): string {
  if (!isPublicRunBudgetEnforced) {
    return "Public start budgets are not enforced right now.";
  }
  return `Up to ${formatCount(publicRunBudget.perVisitorMaxStarts)} starts per visitor and ${formatCount(publicRunBudget.globalMaxStarts)} starts total every ${formatPolicyWindow(publicRunBudget.windowSeconds)}.`;
}

function formatPolicyWindow(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function navigateToWatch() {
  if (typeof window !== "undefined") {
    window.location.assign("/watch");
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

function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratioToPercent(ratio: number): number {
  return Number((ratio * 100).toFixed(10));
}

function percentToRatio(percent: string): number {
  return parseNumber(percent, 0) / 100;
}

function customValidationPath(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((part) => typeof part === "string") ? value : [];
}

function customValidationError(paths: ReadonlyArray<readonly unknown[]>): CustomFormError {
  const group = paths.map(customErrorGroup).find((candidate) => candidate !== "form") ?? "form";
  const messages: Record<CustomErrorGroup, string> = {
    traffic: "Review the Buyers settings and keep the traffic within the available limits.",
    stock: "Review the Stock settings and keep values within the available limits.",
    erp: "Review the Slow ERP settings and keep values within the available limits.",
    advanced: "Review the Advanced protection settings and keep values within supported limits.",
    form: "Review the custom run settings and try again.",
  };
  return { group, message: messages[group] };
}

function customErrorGroup(path: readonly unknown[]): CustomErrorGroup {
  const field = path.at(-1);
  if (path.includes("backpressureConfig")) return "advanced";
  if (path.includes("trafficConfig")) {
    return field === "maxDurationSeconds" || field === "startDelaySeconds" ? "advanced" : "traffic";
  }
  if (path.includes("inventoryConfig")) {
    return field === "reservationHoldMinutes" ? "advanced" : "stock";
  }
  if (path.includes("erpConfig")) {
    return field === "requestTimeoutMs" || field === "forcedOutage" ? "advanced" : "erp";
  }
  return "form";
}

function CustomValidationError({ error, id }: { error: CustomFormError; id: string }) {
  return (
    <p className="m-0 text-sm font-semibold text-danger" id={id} role="alert">
      {error.message}
    </p>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

function SharedRuntimeDisclosure() {
  return (
    <p className="m-0 mb-4 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm leading-6 text-muted-strong">
      Starting a bounded run uses the one shared demo runtime — other visitors can&apos;t start
      until it finishes. A successful start opens the live view.
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
  isRetryScheduled,
  onRetry,
  readiness,
  recovery,
  retriesExhausted,
  retryAttempt,
  retryDelayMs,
  presentation,
  statusMessage,
  startRetryAfterMs,
}: {
  isRetryScheduled: boolean;
  onRetry: () => void;
  readiness: BackendRead<HealthResponse>;
  recovery: BackendRead<DashboardProjection>;
  retriesExhausted: boolean;
  retryAttempt: number;
  retryDelayMs: number | null;
  presentation: ErrorPresentation | null;
  statusMessage: string | null;
  startRetryAfterMs: number | null;
}) {
  const runInProgress = recovery.status === "available" && isRunStartBlocked(recovery);
  const activeRunPresentation = runInProgress
    ? mapErrorPresentation(
        {
          status: "unavailable",
          errorCode: "run_conflict",
          details: { conflictReason: "active_run_exists" },
        },
        "public-start",
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
          <StatusPill status={deriveRunPresentationState(recovery)} />
        ) : runInProgress ? (
          <StatusPill status={deriveRunPresentationState(recovery)} />
        ) : readinessBlocked ? (
          <StatusPill status={readinessPresentation(readiness)} />
        ) : (
          <StatusPill status={{ label: "ready", tone: "idle" }} />
        )}
      </div>
      {activeRunPresentation ? (
        <ErrorNotice
          className="w-full"
          context="public-start"
          presentation={activeRunPresentation}
        />
      ) : null}
      {!activeRunPresentation && readinessBlocked ? (
        <ReadinessNotice
          {...(readiness.status === "unavailable" && readiness.retryAfterMs ? {} : { onRetry })}
          read={readiness}
        />
      ) : null}
      {!activeRunPresentation && recoveryUnavailable ? (
        <Unavailable onRetry={onRetry} read={recovery} />
      ) : null}
      {!activeRunPresentation &&
      (recoveryUnavailable || readinessBlocked || startRetryAfterMs !== null) ? (
        shouldShowRetryWait && retryAfterMs !== undefined ? (
          <p className="m-0 text-sm text-muted">
            Wait {Math.ceil(retryAfterMs / 1_000)} seconds before trying again.
          </p>
        ) : null
      ) : null}
      {!activeRunPresentation && isRetryScheduled && retryDelayMs !== null ? (
        <p className="m-0 text-sm text-muted">
          Automatic retry {retryAttempt} in {Math.ceil(retryDelayMs / 1_000)} seconds.
        </p>
      ) : !activeRunPresentation && retriesExhausted ? (
        <p className="m-0 text-sm text-muted">
          Automatic retries paused. Manual retry remains available.
        </p>
      ) : null}
      {!activeRunPresentation && presentation ? (
        <ErrorNotice context="public-start" onRetry={onRetry} presentation={presentation} />
      ) : !activeRunPresentation && statusMessage ? (
        <p className="m-0 text-sm font-semibold text-muted-strong">{statusMessage}</p>
      ) : null}
    </div>
  );
}

export function readinessPresentation(readiness: BackendRead<HealthResponse>): PresentationState {
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
    state:
      readiness.status === "loading"
        ? "infrastructure-checking"
        : `infrastructure-${readinessStatus}`,
    label: readiness.status === "loading" ? "checking infrastructure" : "backend not ready",
    tone: presentation.tone,
    description: presentation.explanation ?? presentation.headline,
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
  return (
    <div aria-label="Traffic pattern" className="flex flex-wrap gap-3" role="radiogroup">
      {(["buyer-spike", "constant-arrival-rate"] as const).map((trafficMode) => (
        <label
          className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong"
          key={trafficMode}
        >
          <input
            checked={trafficMode === mode}
            disabled={!allowedModes.includes(trafficMode)}
            name="custom-traffic-mode"
            onChange={() => onChange(trafficMode)}
            type="radio"
            value={trafficMode}
          />
          {trafficModeLabel(trafficMode)}
        </label>
      ))}
    </div>
  );
}

function LabeledInput({
  helper,
  id,
  label,
  max,
  min,
  onChange,
  step,
  unit,
  value,
}: {
  helper: string;
  id: string;
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  step?: string;
  unit: string;
  value: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;

  return (
    <div className="grid content-start gap-1 text-sm text-muted-strong">
      <label className="font-semibold" htmlFor={id}>
        {label} ({unit})
      </label>
      <input
        aria-describedby={`${descriptionId}${error ? ` ${errorId}` : ""}`}
        aria-invalid={error ? true : undefined}
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
      <span className="font-normal leading-5 text-muted" id={descriptionId}>
        Unit: {unit}. Minimum: {formatCount(min)}. Maximum: {formatCount(max)}. {helper}
      </span>
      {error ? (
        <span className="font-semibold text-danger" id={errorId}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
