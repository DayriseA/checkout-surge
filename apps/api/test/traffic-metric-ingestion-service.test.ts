import { describe, expect, it, vi } from "vitest";
import type { DashboardTrafficMetricStore } from "../src/services/dashboard-traffic-metric-store.js";
import {
  maximumPendingTrafficMetricBatches,
  TrafficMetricIngestionService,
} from "../src/services/traffic-metric-ingestion-service.js";

const metricRequest = {
  runId: "55555555-5555-4555-8555-555555555551",
  correlationId: "metric-correlation",
  samples: [
    {
      metricName: "traffic.latency" as const,
      value: 42,
      unit: "ms",
      timestamp: "2026-07-14T00:00:00.000Z",
    },
    {
      metricName: "traffic.failure_rate" as const,
      value: 0.1,
      unit: "ratio",
      timestamp: "2026-07-14T00:00:01.000Z",
    },
    {
      metricName: "traffic.scheduled_request_rate" as const,
      value: 100,
      unit: "requests_per_second",
      timestamp: "2026-07-14T00:00:02.000Z",
    },
  ],
  observedAt: "2026-07-14T00:00:02.000Z",
};

describe("TrafficMetricIngestionService", () => {
  it("retains before canonical advisory publication", async () => {
    const order: string[] = [];
    const publishIfLive = vi.fn(async (_runId: string, payloads: string[]) => {
      order.push("publish");
      expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
        expect.objectContaining({
          type: "dashboard.metric.observed",
          runId: metricRequest.runId,
          correlationId: metricRequest.correlationId,
          metricName: "traffic.latency",
          value: 42,
          unit: "ms",
          occurredAt: "2026-07-14T00:00:00.000Z",
          observedAt: "2026-07-14T00:00:00.000Z",
        }),
        expect.objectContaining({ metricName: "traffic.failure_rate" }),
        expect.objectContaining({ metricName: "traffic.scheduled_request_rate" }),
      ]);
      return { outcome: "attempted" as const, failures: [] };
    });
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => {
        order.push("append");
        return true;
      },
      publishIfLive,
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();

    expect(order).toEqual(["append", "publish"]);
    expect(publishIfLive).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("contains mixed event validation and transport failures without rejecting retention", async () => {
    const transportError = new Error("pubsub unavailable");
    const publishIfLive = vi.fn(async (_runId: string, payloads: string[]) => {
      expect(payloads.map((payload) => JSON.parse(payload).metricName)).toEqual([
        "traffic.latency",
        "traffic.scheduled_request_rate",
      ]);
      throw transportError;
    });
    const warn = vi.fn();
    const service = createService({ appendIfLive: async () => true, publishIfLive, warn });

    await expect(
      service.ingest({
        ...metricRequest,
        samples: metricRequest.samples.map((sample) =>
          sample.metricName === "traffic.failure_rate" ? { ...sample, value: 2 } : sample,
        ),
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: transportError,
        runId: metricRequest.runId,
        correlationId: metricRequest.correlationId,
        metricName: "traffic.scheduled_request_rate",
      }),
      "Could not publish traffic metric dashboard event.",
    );
  });

  it("warns only for the indexed failed publication", async () => {
    const publicationError = new Error("sample publish failed");
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => true,
      publishIfLive: async () => ({
        outcome: "attempted",
        failures: [{ index: 1, error: publicationError }],
      }),
      warn,
    });

    await service.ingest(metricRequest);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      {
        err: publicationError,
        runId: metricRequest.runId,
        correlationId: metricRequest.correlationId,
        metricName: "traffic.failure_rate",
      },
      "Could not publish traffic metric dashboard event.",
    );
  });

  it("does not let a throwing warning logger redefine accepted retention", async () => {
    const warn = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const service = createService({
      appendIfLive: async () => true,
      publishIfLive: async () => ({
        outcome: "attempted",
        failures: [{ index: 0, error: new Error("sample publish failed") }],
      }),
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("accepts retained work when reset fences advisory publication between phases", async () => {
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => true,
      publishIfLive: async () => ({ outcome: "fenced" }),
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("propagates retention failure without publishing", async () => {
    const retentionError = new Error("retention unavailable");
    const publishIfLive = vi.fn();
    const service = createService({
      appendIfLive: async () => {
        throw retentionError;
      },
      publishIfLive,
      warn: vi.fn(),
    });

    await expect(service.ingest(metricRequest)).rejects.toBe(retentionError);
    expect(publishIfLive).not.toHaveBeenCalled();
  });

  it("rejects missing, wrong-lifecycle, and reset-fenced runs before publication", async () => {
    const appendIfLive = vi.fn(async () => true);
    const publishIfLive = vi.fn(async () => ({ outcome: "attempted" as const, failures: [] }));
    const missing = createService({ appendIfLive, publishIfLive, warn: vi.fn(), run: null });
    const draining = createService({
      appendIfLive,
      publishIfLive,
      warn: vi.fn(),
      run: { status: "draining", trafficStatus: "succeeded" },
    });
    const fenced = createService({
      appendIfLive: async () => false,
      publishIfLive,
      warn: vi.fn(),
    });

    await expect(missing.ingest(metricRequest)).rejects.toMatchObject({
      code: "resource_not_found",
      details: { runId: metricRequest.runId },
    });
    await expect(draining.ingest(metricRequest)).rejects.toMatchObject({
      code: "traffic_report_rejected",
      details: { status: "draining", trafficStatus: "succeeded" },
    });
    await expect(fenced.ingest(metricRequest)).rejects.toMatchObject({
      code: "traffic_report_rejected",
      details: { runId: metricRequest.runId },
    });
    expect(appendIfLive).not.toHaveBeenCalled();
    expect(publishIfLive).not.toHaveBeenCalled();
  });

  it("reserves bounded capacity before DB admission and runs admitted work single-flight", async () => {
    let releaseFirstAppend: (() => void) | undefined;
    let markFirstAppendEntered: (() => void) | undefined;
    const firstAppendGate = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    const firstAppendEntered = new Promise<void>((resolve) => {
      markFirstAppendEntered = resolve;
    });
    let transactionCount = 0;
    let transactionOpen = false;
    let activeStoreOperations = 0;
    let maximumActiveStoreOperations = 0;
    const appendIfLive = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
      activeStoreOperations += 1;
      maximumActiveStoreOperations = Math.max(maximumActiveStoreOperations, activeStoreOperations);
      if (appendIfLive.mock.calls.length === 1) {
        markFirstAppendEntered?.();
        await firstAppendGate;
      }
      activeStoreOperations -= 1;
      return true;
    });
    const publishIfLive = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
      return { outcome: "attempted" as const, failures: [] };
    });
    const database = databaseForRun({ status: "active", trafficStatus: "active" }, () => {
      transactionCount += 1;
      transactionOpen = true;
      return () => {
        transactionOpen = false;
      };
    });
    const service = new TrafficMetricIngestionService({
      db: database as never,
      store: { appendIfLive, publishIfLive },
      logger: { warn: vi.fn() },
    });

    const admitted = Array.from({ length: maximumPendingTrafficMetricBatches }, (_, index) =>
      service.ingest({ ...metricRequest, correlationId: `metric-admitted-${index}` }),
    );
    await firstAppendEntered;
    await expect(
      service.ingest({ ...metricRequest, correlationId: "metric-overflow" }),
    ).resolves.toBeUndefined();

    expect(transactionCount).toBe(1);
    releaseFirstAppend?.();
    await Promise.all(admitted);
    expect(transactionCount).toBe(maximumPendingTrafficMetricBatches);
    expect(appendIfLive).toHaveBeenCalledTimes(maximumPendingTrafficMetricBatches);
    expect(publishIfLive).toHaveBeenCalledTimes(maximumPendingTrafficMetricBatches);
    expect(maximumActiveStoreOperations).toBe(1);
  });
});

function createService(options: {
  appendIfLive: Pick<DashboardTrafficMetricStore, "appendIfLive">["appendIfLive"];
  publishIfLive: Pick<DashboardTrafficMetricStore, "publishIfLive">["publishIfLive"];
  warn: ReturnType<typeof vi.fn>;
  run?: { status: string; trafficStatus: string } | null;
}): TrafficMetricIngestionService {
  const selectedRun =
    options.run === undefined ? { status: "active", trafficStatus: "active" } : options.run;
  return new TrafficMetricIngestionService({
    db: databaseForRun(selectedRun) as never,
    store: { appendIfLive: options.appendIfLive, publishIfLive: options.publishIfLive },
    logger: { warn: options.warn as never },
  });
}

function databaseForRun(
  run: { status: string; trafficStatus: string } | null,
  onTransactionStart?: () => () => void,
): Record<string, unknown> {
  const database: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: async () => (run ? [run] : []),
          }),
        }),
      }),
    }),
  };
  database.transaction = async (operation: (tx: typeof database) => Promise<unknown>) => {
    const finish = onTransactionStart?.();
    try {
      return await operation(database);
    } finally {
      finish?.();
    }
  };
  return database;
}
