"use client";

import {
  type AcceptedRunConfigSnapshot,
  type DashboardProjection,
  type DemoRunConfigOverride,
  type HealthResponse,
  healthResponseSchema,
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
import { formatCount } from "../lib/presentation/format";
import {
  publicLimitsLabel,
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

const recoveryPollIntervalMs = 15_000;
const readinessPollIntervalMs = 60_000;
const panelClassName = "min-w-0 rounded-lg border border-border bg-surface p-4";
const buttonClassName =
  "min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60";
const primaryButtonClassName =
  "min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60";
const inputClassName = "min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink";

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
  forcedOutage: boolean;
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
  const curatedPresets = presets.filter((preset) => preset.slug !== "public-custom");
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
  const startDisabled =
    isBlocked ||
    isReadinessBlocked ||
    startingSlug !== null ||
    startConflictBlock !== null ||
    startRetryUntil !== null ||
    surface.presets.status !== "available" ||
    recovery.status !== "available";

  async function startRun(presetSlug: string, configOverride?: DemoRunConfigOverride) {
    const parsed = startDemoRunRequestSchema.safeParse({
      presetSlug,
      ...(configOverride ? { configOverride } : {}),
    });

    if (!parsed.success) {
      setStatusMessage(null);
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
            {curatedPresets.map((preset) => (
              <article className="min-w-0 rounded-lg border border-border p-3" key={preset.slug}>
                <div className="mb-3 grid gap-1">
                  <strong className="text-ink">{preset.display.name}</strong>
                  <span className="text-sm leading-5 text-muted">{preset.display.description}</span>
                </div>
                <dl className="m-0 mb-3 grid grid-cols-3 gap-2 text-sm">
                  <Fact
                    label="Scenario"
                    value={trafficModeLabel(preset.trafficConfig.mode as TrafficMode)}
                  />
                  <Fact
                    label={publicVocabulary.startingStock}
                    value={formatCount(preset.inventoryConfig.startingStock) ?? "not configured"}
                  />
                  <Fact
                    label="Simulated ERP capacity (orders/s)"
                    value={formatCount(preset.erpConfig.maxTps) ?? "not configured"}
                  />
                </dl>
                <button
                  className={primaryButtonClassName}
                  disabled={startDisabled}
                  onClick={() => {
                    void startRun(preset.slug);
                  }}
                  type="button"
                >
                  {startingSlug === preset.slug ? "Starting" : "Start"}
                </button>
              </article>
            ))}
          </div>
        ) : surface.presets.status === "unavailable" ? (
          <Unavailable onRetry={reloadPage} read={surface.presets} />
        ) : (
          <p className="m-0 text-muted">No curated public presets are currently available.</p>
        )}
      </section>

      <section className={`${panelClassName} col-span-12`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Public custom</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
              Build a safe custom scenario
            </h2>
          </div>
          <StatusPill
            status={{
              label: publicLimitsLabel(runtimePolicy?.isPublicRunBudgetEnforced),
              tone: "idle",
            }}
          />
        </div>
        {runtimePolicy && customPreset && customConfig ? (
          <div className="grid gap-4">
            <TrafficModeSelector
              allowedModes={runtimePolicy.publicCustomLimits.allowedTrafficModes}
              mode={customDraft.mode}
              onChange={(mode) => setCustomDraft((draft) => ({ ...draft, mode }))}
            />
            <div className="grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[560px]:grid-cols-1">
              {customDraft.mode === "buyer-spike" ? (
                <>
                  <LabeledInput
                    label="Buyers"
                    max={runtimePolicy.publicCustomLimits.maxBuyers}
                    min={1}
                    onChange={(buyerCount) => setCustomDraft((draft) => ({ ...draft, buyerCount }))}
                    value={customDraft.buyerCount}
                  />
                  <LabeledInput
                    label="Maximum run time (seconds)"
                    max={runtimePolicy.publicCustomLimits.maxTrafficDurationSeconds}
                    min={1}
                    onChange={(maxDurationSeconds) =>
                      setCustomDraft((draft) => ({ ...draft, maxDurationSeconds }))
                    }
                    value={customDraft.maxDurationSeconds}
                  />
                  <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-muted-strong">
                    <input
                      checked={customDraft.duplicateEachBuyerAttempt}
                      onChange={(event) =>
                        setCustomDraft((draft) => ({
                          ...draft,
                          duplicateEachBuyerAttempt: event.target.checked,
                        }))
                      }
                      type="checkbox"
                    />
                    Duplicate attempts
                  </label>
                </>
              ) : (
                <>
                  <LabeledInput
                    label="Requests per second"
                    max={runtimePolicy.publicCustomLimits.maxRequestsPerSecond}
                    min={1}
                    onChange={(ratePerSecond) =>
                      setCustomDraft((draft) => ({ ...draft, ratePerSecond }))
                    }
                    value={customDraft.ratePerSecond}
                  />
                  <LabeledInput
                    label="Duration seconds"
                    max={runtimePolicy.publicCustomLimits.maxTrafficDurationSeconds}
                    min={1}
                    onChange={(durationSeconds) =>
                      setCustomDraft((draft) => ({ ...draft, durationSeconds }))
                    }
                    value={customDraft.durationSeconds}
                  />
                </>
              )}
              <LabeledInput
                label="Start delay seconds"
                max={runtimePolicy.publicCustomLimits.maxTrafficStartDelaySeconds}
                min={0}
                onChange={(startDelaySeconds) =>
                  setCustomDraft((draft) => ({ ...draft, startDelaySeconds }))
                }
                value={customDraft.startDelaySeconds}
              />
              <LabeledInput
                label="Starting stock"
                max={runtimePolicy.publicCustomLimits.maxStartingStock}
                min={0}
                onChange={(startingStock) =>
                  setCustomDraft((draft) => ({ ...draft, startingStock }))
                }
                value={customDraft.startingStock}
              />
              <LabeledInput
                label="Simulated ERP delay per order (ms)"
                max={runtimePolicy.publicCustomLimits.maxErpLatencyMs}
                min={0}
                onChange={(erpLatencyMs) => setCustomDraft((draft) => ({ ...draft, erpLatencyMs }))}
                value={customDraft.erpLatencyMs}
              />
              <LabeledInput
                label="Simulated ERP capacity (orders/s)"
                max={runtimePolicy.publicCustomLimits.maxErpMaxTps}
                min={runtimePolicy.publicCustomLimits.minErpMaxTps}
                onChange={(erpMaxTps) => setCustomDraft((draft) => ({ ...draft, erpMaxTps }))}
                value={customDraft.erpMaxTps}
              />
              <LabeledInput
                label="Simulated ERP failure rate (%)"
                max={ratioToPercent(runtimePolicy.publicCustomLimits.maxErpErrorRate)}
                min={0}
                onChange={(erpErrorRate) => setCustomDraft((draft) => ({ ...draft, erpErrorRate }))}
                step="0.01"
                value={customDraft.erpErrorRate}
              />
            </div>
            <SharedRuntimeDisclosure />
            <button
              className={primaryButtonClassName}
              disabled={startDisabled}
              onClick={() => {
                void startRun(customPreset.slug, customConfig);
              }}
              type="button"
            >
              {startingSlug === customPreset.slug ? "Starting" : "Start Public Custom"}
            </button>
          </div>
        ) : surface.runtimePolicy.status === "unavailable" ? (
          <Unavailable onRetry={reloadPage} read={surface.runtimePolicy} />
        ) : (
          <p className="m-0 text-muted">Public custom is unavailable.</p>
        )}
      </section>
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
      ...defaults.inventoryConfig,
      startingStock: parseInteger(draft.startingStock, 0),
    },
    erpConfig: {
      ...defaults.erpConfig,
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
    forcedOutage: false,
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
    forcedOutage: false,
  };
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
  return ratio * 100;
}

function percentToRatio(percent: string): number {
  return parseNumber(percent, 0) / 100;
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
    <div className="flex flex-wrap gap-2">
      {(["buyer-spike", "constant-arrival-rate"] as const).map((trafficMode) => (
        <button
          className={trafficMode === mode ? primaryButtonClassName : buttonClassName}
          disabled={!allowedModes.includes(trafficMode)}
          key={trafficMode}
          onClick={() => onChange(trafficMode)}
          type="button"
        >
          {trafficModeLabel(trafficMode)}
        </button>
      ))}
    </div>
  );
}

function LabeledInput({
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  step?: string;
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-muted-strong">
      <span>{label}</span>
      <input
        className={inputClassName}
        max={max}
        min={min}
        onChange={(event) => onChange(event.target.value)}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}
