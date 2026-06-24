"use client";

import {
  adminDemoResetResponseSchema,
  adminMaintenanceCleanupRunsResponseSchema,
  type DashboardEvent,
  type DashboardRecoveryResponse,
  dashboardEventSchema,
  dashboardRecoveryResponseSchema,
  type ErpChaosStatus,
  erpChaosConfigSchema,
  erpChaosStatusSchema,
  type StartDemoRunResponse,
  startDemoRunResponseSchema,
} from "@checkout-surge/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BackendRead, DashboardBackendSnapshot } from "../lib/api";
import {
  adminDemoResetProxyPath,
  adminErpChaosProxyPath,
  adminErpChaosResetProxyPath,
  adminMaintenanceCleanupRunsProxyPath,
  adminPassphraseHeaderName,
  adminSessionProxyPath,
  dashboardRecoveryProxyPath,
  demoRunStartProxyPath,
} from "../lib/control-paths";
import { dashboardEventsUrl } from "../lib/realtime";
import {
  ApiStatusPanel,
  CompletionOutcomesPanel,
  ConsistencyLagPanel,
  ErpHealthPanel,
  InventoryDrainPanel,
  LoadRunControlsPanel,
  QueuePressurePanel,
  type RealtimeConnectionStatus,
  RecoveryStatusPanel,
  RequestSurgePanel,
  RunOutcomesPanel,
} from "./dashboard-panels";

interface OperatorDashboardProps {
  snapshot: DashboardBackendSnapshot;
  showControls?: boolean;
  showAdminActions?: boolean;
  showHistoryPlaceholder?: boolean;
}

export function OperatorDashboard({
  snapshot,
  showControls = false,
  showAdminActions = false,
  showHistoryPlaceholder = false,
}: OperatorDashboardProps) {
  const [recovery, setRecovery] = useState(snapshot.recovery);
  const [erpChaos, setErpChaos] = useState(snapshot.erpChaos);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeConnectionStatus>("connecting");
  const [liveEventCount, setLiveEventCount] = useState(0);
  const [isRefreshingRecovery, setIsRefreshingRecovery] = useState(false);
  const [startingPresetSlug, setStartingPresetSlug] = useState<string | null>(null);
  const [startStatusMessage, setStartStatusMessage] = useState<string | null>(null);
  const recoveryPromiseRef = useRef<Promise<void> | null>(null);
  const recoveryFollowUpRequestedRef = useRef(false);
  const discardedLiveEventDuringRecoveryRef = useRef(false);

  const refreshRecovery = useCallback(async () => {
    if (recoveryPromiseRef.current) {
      recoveryFollowUpRequestedRef.current = true;
      await recoveryPromiseRef.current;
      return;
    }

    setIsRefreshingRecovery(true);

    const recoveryPromise = (async () => {
      setRecovery(await readProxyJson(dashboardRecoveryProxyPath, dashboardRecoveryResponseSchema));
    })();

    recoveryPromiseRef.current = recoveryPromise;

    try {
      await recoveryPromise;
    } finally {
      recoveryPromiseRef.current = null;
      setIsRefreshingRecovery(false);

      if (discardedLiveEventDuringRecoveryRef.current || recoveryFollowUpRequestedRef.current) {
        discardedLiveEventDuringRecoveryRef.current = false;
        recoveryFollowUpRequestedRef.current = false;
        await refreshRecovery();
      }
    }
  }, []);

  useEffect(() => {
    setRecovery(snapshot.recovery);
  }, [snapshot.recovery]);

  useEffect(() => {
    setErpChaos(snapshot.erpChaos);
  }, [snapshot.erpChaos]);

  useEffect(() => {
    if (typeof EventSource === "undefined") {
      setRealtimeStatus("unsupported");
      return;
    }

    const source = new EventSource(dashboardEventsUrl());

    source.onopen = () => {
      setRealtimeStatus("connected");
      void refreshRecovery();
    };
    source.onerror = () => {
      setRealtimeStatus("disconnected");
    };
    source.onmessage = (message) => {
      const payload = parseJson(message.data);

      if (!payload.ok) {
        return;
      }

      const parsed = dashboardEventSchema.safeParse(payload.value);

      if (!parsed.success) {
        return;
      }

      setLiveEventCount((count) => count + 1);
      if (recoveryPromiseRef.current) {
        discardedLiveEventDuringRecoveryRef.current = true;
        return;
      }

      setRecovery((current) => applyDashboardEvent(current, parsed.data));
      if (shouldRequestAuthoritativeRecoveryAfterEvent(parsed.data)) {
        void refreshRecovery();
      }
    };

    return () => {
      source.close();
    };
  }, [refreshRecovery]);

  const liveSnapshot = useMemo(
    () => ({
      ...snapshot,
      recovery,
      erpChaos,
    }),
    [snapshot, recovery, erpChaos],
  );

  async function startPublicRun(presetSlug: string): Promise<BackendRead<StartDemoRunResponse>> {
    setStartingPresetSlug(presetSlug);
    setStartStatusMessage(null);

    try {
      const response = await readProxyJson(demoRunStartProxyPath, startDemoRunResponseSchema, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presetSlug,
        }),
      });

      if (response.status === "available") {
        setStartStatusMessage("Run accepted.");
        await refreshRecovery();
      } else {
        setStartStatusMessage(response.reason);
      }

      return response;
    } finally {
      setStartingPresetSlug(null);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-4">
      <ApiStatusPanel snapshot={liveSnapshot} />
      <RecoveryStatusPanel
        recovery={recovery}
        isRefreshing={isRefreshingRecovery}
        realtimeStatus={realtimeStatus}
        liveEventCount={liveEventCount}
        onRefresh={() => {
          void refreshRecovery();
        }}
      />
      {showControls ? (
        <LoadRunControlsPanel
          recovery={recovery}
          onStartPreset={startPublicRun}
          startingPresetSlug={startingPresetSlug}
          statusMessage={startStatusMessage}
        />
      ) : null}
      <RequestSurgePanel recovery={recovery} liveEventCount={liveEventCount} />
      <InventoryDrainPanel recovery={recovery} />
      <QueuePressurePanel recovery={recovery} />
      <ErpHealthPanel recovery={recovery} />
      <ConsistencyLagPanel recovery={recovery} />
      <RunOutcomesPanel recovery={recovery} />
      <CompletionOutcomesPanel recovery={recovery} />
      {showAdminActions ? (
        <AdminActionsPanel erpChaos={erpChaos} onErpChaosChange={setErpChaos} />
      ) : null}
      {showHistoryPlaceholder ? <RunHistoryPlaceholder /> : null}
    </div>
  );
}

interface ContractSchema<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { message: string } };
}

async function readProxyJson<T>(
  path: string,
  schema: ContractSchema<T>,
  init?: RequestInit,
): Promise<BackendRead<T>> {
  let response: Response;
  const { headers, ...requestInit } = init ?? {};

  try {
    response = await fetch(path, {
      ...requestInit,
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...headers,
      },
    });
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Dashboard control request failed.",
    };
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch (error) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: error instanceof Error ? error.message : "Dashboard control returned non-JSON data.",
    };
  }

  if (!response.ok) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: errorMessageFromPayload(payload),
    };
  }

  const parsed = schema.safeParse(payload);

  if (!parsed.success) {
    return {
      status: "unavailable",
      httpStatus: response.status,
      reason: `Dashboard control response did not match the shared contract: ${parsed.error.message}`,
    };
  }

  return {
    status: "available",
    data: parsed.data,
    httpStatus: response.status,
  };
}

function errorMessageFromPayload(payload: unknown): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
  ) {
    return payload.message;
  }

  return "Dashboard control request failed.";
}

function parseJson(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch {
    return { ok: false };
  }
}

export function applyDashboardEvent(
  recovery: BackendRead<DashboardRecoveryResponse>,
  event: DashboardEvent,
): BackendRead<DashboardRecoveryResponse> {
  if (recovery.status !== "available") {
    return recovery;
  }

  const current = recovery.data;

  switch (event.type) {
    case "run.started":
    case "run.updated":
    case "run.completed":
    case "run.failed":
      return {
        ...recovery,
        data: {
          ...current,
          currentRun: event.run,
          recoveredAt: event.occurredAt,
        },
      };
    case "inventory.updated":
      return {
        ...recovery,
        data: {
          ...current,
          inventory: event.inventory,
        },
      };
    case "queue.updated":
      return {
        ...recovery,
        data: {
          ...current,
          queue: event.queue,
        },
      };
    case "traffic.metric":
      return {
        ...recovery,
        data: {
          ...current,
          recentMetrics: [
            ...current.recentMetrics.slice(-19),
            {
              metricName: event.metricName,
              value: event.value,
              unit: event.unit,
              timestamp: event.occurredAt,
            },
          ],
        },
      };
    case "business.outcome.updated":
      return {
        ...recovery,
        data: {
          ...current,
          businessOutcome: event.outcome,
          consistencyLag: event.consistencyLag,
        },
      };
  }
}

export function shouldRequestAuthoritativeRecoveryAfterEvent(event: DashboardEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed";
}

function AdminActionsPanel({
  erpChaos,
  onErpChaosChange,
}: {
  erpChaos: BackendRead<ErpChaosStatus>;
  onErpChaosChange: (next: BackendRead<ErpChaosStatus>) => void;
}) {
  const current = erpChaos.status === "available" ? erpChaos.data : null;
  const [adminPassphrase, setAdminPassphrase] = useState("");
  const [latencyMs, setLatencyMs] = useState("0");
  const [maxTps, setMaxTps] = useState("100");
  const [errorRate, setErrorRate] = useState("0");
  const [forcedOutage, setForcedOutage] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!current) {
      return;
    }

    setLatencyMs(String(current.latencyMs));
    setMaxTps(String(current.maxTps));
    setErrorRate(String(current.errorRate));
    setForcedOutage(current.forcedOutage);
  }, [current]);

  async function signInAdmin() {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const response = await fetch(adminSessionProxyPath, {
        method: "POST",
        cache: "no-store",
        headers: {
          [adminPassphraseHeaderName]: adminPassphrase,
        },
      });
      const payload = await response.json().catch(() => null);

      setStatusMessage(
        response.ok
          ? "Admin session established."
          : payload && typeof payload === "object" && "message" in payload
            ? String(payload.message)
            : "Admin session failed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function updateChaos() {
    const parsedConfig = erpChaosConfigSchema.safeParse({
      latencyMs: Number(latencyMs),
      maxTps: Number(maxTps),
      errorRate: Number(errorRate),
      forcedOutage,
    });

    if (!parsedConfig.success) {
      setStatusMessage("ERP chaos values are outside the accepted contract.");
      return;
    }

    await submitChaosRequest(adminErpChaosProxyPath, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [adminPassphraseHeaderName]: adminPassphrase,
      },
      body: JSON.stringify(parsedConfig.data),
    });
  }

  async function resetChaos() {
    await submitChaosRequest(adminErpChaosResetProxyPath, {
      method: "POST",
      headers: {
        [adminPassphraseHeaderName]: adminPassphrase,
      },
    });
  }

  async function resetDemo() {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const result = await readProxyJson(adminDemoResetProxyPath, adminDemoResetResponseSchema, {
        method: "POST",
        headers: {
          [adminPassphraseHeaderName]: adminPassphrase,
        },
      });

      setStatusMessage(
        result.status === "available"
          ? `Reset complete: ${result.data.failedRunCount} runs failed, ${result.data.cleanedJobCount} jobs cleaned.`
          : result.reason,
      );
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
          headers: {
            "content-type": "application/json",
            [adminPassphraseHeaderName]: adminPassphrase,
          },
          body: JSON.stringify({ keepLatest: 15, olderThanDays: 7 }),
        },
      );

      setStatusMessage(
        result.status === "available"
          ? `Cleanup complete: ${result.data.deletedRunCount} runs removed.`
          : result.reason,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitChaosRequest(path: string, init: RequestInit) {
    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const next = await readProxyJson(path, erpChaosStatusSchema, init);
      onErpChaosChange(next);
      setStatusMessage(next.status === "available" ? "ERP chaos controls updated." : next.reason);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="col-span-8 min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Admin actions</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            Protected controls
          </h2>
        </div>
      </div>
      <div className="grid gap-4">
        <div className="grid gap-3 border-t border-border pt-3">
          <div className="grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
            <LabeledInput
              label="Admin passphrase"
              onChange={setAdminPassphrase}
              type="password"
              value={adminPassphrase}
            />
            <LabeledInput label="Latency ms" onChange={setLatencyMs} value={latencyMs} />
            <LabeledInput label="Max TPS" onChange={setMaxTps} value={maxTps} />
            <LabeledInput
              label="Error rate"
              onChange={setErrorRate}
              step="0.01"
              value={errorRate}
            />
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold text-muted-strong">
            <input
              checked={forcedOutage}
              onChange={(event) => setForcedOutage(event.target.checked)}
              type="checkbox"
            />
            Forced outage
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => {
                void signInAdmin();
              }}
              type="button"
            >
              Sign In
            </button>
            <button
              className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => {
                void updateChaos();
              }}
              type="button"
            >
              Apply ERP Controls
            </button>
            <button
              className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => {
                void resetChaos();
              }}
              type="button"
            >
              Reset ERP Controls
            </button>
          </div>
          <dl className="m-0 grid grid-cols-4 gap-3 max-[700px]:grid-cols-2">
            <FactLike label="Latency" value={current ? `${current.latencyMs}ms` : "n/a"} />
            <FactLike label="Max TPS" value={current ? String(current.maxTps) : "n/a"} />
            <FactLike label="Error rate" value={current ? String(current.errorRate) : "n/a"} />
            <FactLike label="Outage" value={current?.forcedOutage ? "enabled" : "disabled"} />
          </dl>
          {erpChaos.status === "unavailable" ? (
            <p className="m-0 text-sm font-semibold text-danger">{erpChaos.reason}</p>
          ) : null}
          {statusMessage ? (
            <p className="m-0 text-sm font-semibold text-muted-strong">{statusMessage}</p>
          ) : null}
        </div>
        <ul className="m-0 grid list-none gap-3 p-0">
          <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
            <span>Demo reset and recovery</span>
            <button
              className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => {
                void resetDemo();
              }}
              type="button"
            >
              Reset Demo
            </button>
          </li>
          <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
            <span>Local maintenance cleanup</span>
            <button
              className="min-h-10 rounded-lg border border-border bg-surface px-3.5 py-2.5 font-semibold text-muted-strong disabled:cursor-not-allowed disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => {
                void cleanupRuns();
              }}
              type="button"
            >
              Cleanup Runs
            </button>
          </li>
        </ul>
      </div>
    </section>
  );
}

function LabeledInput({
  label,
  onChange,
  step,
  type = "number",
  value,
}: {
  label: string;
  onChange: (next: string) => void;
  step?: string;
  type?: "number" | "password";
  value: string;
}) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-muted-strong">
      <span>{label}</span>
      <input
        className="min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
        onChange={(event) => onChange(event.target.value)}
        step={step}
        type={type}
        value={value}
      />
    </label>
  );
}

function FactLike({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs font-bold text-muted">{label}</dt>
      <dd className="m-0 [overflow-wrap:anywhere] text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

function RunHistoryPlaceholder() {
  return (
    <section className="col-span-8 min-w-0 rounded-lg border border-border bg-surface p-4 max-[900px]:col-span-full">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-bold uppercase text-muted">Completed runs</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Summary table</h2>
        </div>
      </div>
      <ul className="m-0 grid list-none gap-3 p-0">
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>Run ID</span>
          <span className="font-semibold text-muted">n/a</span>
        </li>
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>HTTP summary</span>
          <span className="font-semibold text-muted">n/a</span>
        </li>
        <li className="flex items-center justify-between gap-3 border-t border-border pt-3 text-muted-strong">
          <span>Business outcome</span>
          <span className="font-semibold text-muted">n/a</span>
        </li>
      </ul>
    </section>
  );
}
