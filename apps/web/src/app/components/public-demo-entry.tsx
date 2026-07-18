"use client";

import {
  type AcceptedRunConfigSnapshot,
  type DashboardRecoveryResponse,
  type DemoRunConfigOverride,
  startDemoRunRequestSchema,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useMemo, useState } from "react";
import type { BackendRead, PublicDemoSurface } from "../lib/api";
import { readProxyJson } from "../lib/client/proxy-json";
import { demoRunStartProxyPath } from "../lib/control-paths";
import { formatDashboardTime } from "../lib/dashboard-time";
import { useDashboardRecovery } from "./realtime/use-dashboard-recovery";
import { StatusPill } from "./status-pill";

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
  const [customDraft, setCustomDraft] = useState<CustomDraft>(() =>
    surface.runtimePolicy.status === "available"
      ? draftFromSnapshot(surface.runtimePolicy.data.policy.publicCustomDefaults)
      : fallbackDraft(),
  );

  const {
    recovery,
    isRefreshing,
    isRetryScheduled,
    retriesExhausted,
    retryAttempt,
    retryDelayMs,
    retryNow,
  } = useDashboardRecovery(surface.recovery);
  const isBlocked = isRunStartBlocked(recovery);
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
    startingSlug !== null ||
    surface.presets.status !== "available" ||
    recovery.status !== "available";

  async function startRun(presetSlug: string, configOverride?: DemoRunConfigOverride) {
    const parsed = startDemoRunRequestSchema.safeParse({
      presetSlug,
      ...(configOverride ? { configOverride } : {}),
    });

    if (!parsed.success) {
      setStatusMessage("Run configuration is outside the shared start contract.");
      return;
    }

    setStartingSlug(presetSlug);
    setStatusMessage(null);

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

      setStatusMessage(result.reason);
    } finally {
      setStartingSlug(null);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <section className={`${panelClassName} col-span-8 max-[900px]:col-span-full`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Public demo</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
              Curated surge presets
            </h2>
          </div>
          <StatusPill
            label={publicAvailabilityStatus(recovery)}
            tone={
              recovery.status === "unavailable" ? "unavailable" : isBlocked ? "pending" : "ok"
            }
          />
        </div>
        {surface.presets.status === "available" && curatedPresets.length > 0 ? (
          <div className="grid grid-cols-2 gap-3 max-[700px]:grid-cols-1">
            {curatedPresets.map((preset) => (
              <article className="min-w-0 rounded-lg border border-border p-3" key={preset.slug}>
                <div className="mb-3 grid gap-1">
                  <strong className="text-ink">{preset.display.name}</strong>
                  <span className="text-sm leading-5 text-muted">{preset.display.description}</span>
                </div>
                <dl className="m-0 mb-3 grid grid-cols-3 gap-2 text-sm">
                  <Fact label="Mode" value={preset.trafficConfig.mode} />
                  <Fact label="Stock" value={String(preset.inventoryConfig.startingStock)} />
                  <Fact label="ERP TPS" value={String(preset.erpConfig.maxTps)} />
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
          <Unavailable read={surface.presets} />
        ) : (
          <p className="m-0 text-muted">No curated public presets are currently available.</p>
        )}
      </section>

      <section className={`${panelClassName} col-span-4 max-[900px]:col-span-full`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Current run</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Start gating</h2>
          </div>
          <StatusPill label={currentRunStatus(recovery)} tone={isBlocked ? "pending" : "idle"} />
        </div>
        {recovery.status === "available" ? (
          <dl className="m-0 grid gap-3">
            <Fact label="Run" value={recovery.data.currentRun?.presetName ?? "No active run"} />
            <Fact
              label="Traffic"
              value={recovery.data.currentRun?.trafficStatus ?? "Not active"}
            />
            <Fact label="Recovered" value={formatDashboardTime(recovery.data.recoveredAt)} />
          </dl>
        ) : (
          <Unavailable read={recovery} />
        )}
        <button
          className={`${buttonClassName} mt-4`}
          disabled={isRefreshing}
          onClick={() => void retryNow()}
          type="button"
        >
          {isRefreshing ? "Checking recovery" : "Retry recovery"}
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
        {statusMessage ? (
          <p className="m-0 mt-4 text-sm font-semibold text-muted-strong">{statusMessage}</p>
        ) : null}
      </section>

      <section className={`${panelClassName} col-span-12`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <p className="m-0 text-xs font-bold uppercase text-muted">Public custom</p>
            <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
              Bounded run-scoped start
            </h2>
          </div>
          <StatusPill
            label={runtimePolicy?.isPublicRunBudgetEnforced ? "budgeted" : "open"}
            tone="idle"
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
                    label="Max duration seconds"
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
                label="ERP latency ms"
                max={runtimePolicy.publicCustomLimits.maxErpLatencyMs}
                min={0}
                onChange={(erpLatencyMs) => setCustomDraft((draft) => ({ ...draft, erpLatencyMs }))}
                value={customDraft.erpLatencyMs}
              />
              <LabeledInput
                label="ERP max TPS"
                max={runtimePolicy.publicCustomLimits.maxErpMaxTps}
                min={runtimePolicy.publicCustomLimits.minErpMaxTps}
                onChange={(erpMaxTps) => setCustomDraft((draft) => ({ ...draft, erpMaxTps }))}
                value={customDraft.erpMaxTps}
              />
              <LabeledInput
                label="ERP error rate"
                max={runtimePolicy.publicCustomLimits.maxErpErrorRate}
                min={0}
                onChange={(erpErrorRate) => setCustomDraft((draft) => ({ ...draft, erpErrorRate }))}
                step="0.01"
                value={customDraft.erpErrorRate}
              />
            </div>
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
          <Unavailable read={surface.runtimePolicy} />
        ) : (
          <p className="m-0 text-muted">Public custom is unavailable.</p>
        )}
      </section>
    </div>
  );
}

export function isRunStartBlocked(recovery: BackendRead<DashboardRecoveryResponse>): boolean {
  if (recovery.status !== "available") {
    return true;
  }

  const status = recovery.data.currentRun?.status;
  return status === "starting" || status === "active" || status === "draining";
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
            mode: "steady-arrival-rate",
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
      errorRate: parseNumber(draft.erpErrorRate, 0),
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
    ratePerSecond: traffic.mode === "steady-arrival-rate" ? String(traffic.ratePerSecond) : "50",
    durationSeconds:
      traffic.mode === "steady-arrival-rate" ? String(traffic.durationSeconds) : "10",
    startDelaySeconds: String(traffic.startDelaySeconds),
    startingStock: String(snapshot.inventoryConfig.startingStock),
    erpLatencyMs: String(snapshot.erpConfig.latencyMs),
    erpMaxTps: String(snapshot.erpConfig.maxTps),
    erpErrorRate: String(snapshot.erpConfig.errorRate),
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

function currentRunStatus(recovery: BackendRead<DashboardRecoveryResponse>): string {
  return recovery.status === "available"
    ? (recovery.data.currentRun?.status ?? "idle")
    : "unavailable";
}

function publicAvailabilityStatus(recovery: BackendRead<DashboardRecoveryResponse>): string {
  if (recovery.status === "unavailable") return "availability unavailable";
  return isRunStartBlocked(recovery) ? "run in progress" : "ready";
}

function navigateToWatch() {
  if (typeof window !== "undefined") {
    window.location.assign("/watch");
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
    <div className="grid gap-1 rounded-lg border border-[#f7b4ad] bg-danger-soft p-3 leading-6 text-danger">
      <strong>Unavailable</strong>
      <span>{read.reason}</span>
      {read.httpStatus ? <span>HTTP {read.httpStatus}</span> : null}
      {read.correlationId ? <span>Correlation {read.correlationId}</span> : null}
    </div>
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
      {(["buyer-spike", "steady-arrival-rate"] as const).map((trafficMode) => (
        <button
          className={trafficMode === mode ? primaryButtonClassName : buttonClassName}
          disabled={!allowedModes.includes(trafficMode)}
          key={trafficMode}
          onClick={() => onChange(trafficMode)}
          type="button"
        >
          {trafficMode}
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
