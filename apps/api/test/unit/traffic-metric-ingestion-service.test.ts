import { describe, expect, it, vi } from "vitest";
import type { DashboardTrafficMetricStore } from "../../src/services/dashboard-traffic-metric-store.js";
import {
  maximumPendingTrafficMetricBatches,
  TrafficMetricIngestionService,
} from "../../src/services/traffic-metric-ingestion-service.js";

const metricRequest = {
  batchId: "77777777-7777-4777-8777-777777777777",
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
      metricName: "traffic.request_arrival_rate" as const,
      value: 100,
      unit: "requests_per_second",
      timestamp: "2026-07-14T00:00:02.000Z",
    },
  ],
  observedAt: "2026-07-14T00:00:02.000Z",
};

describe("TrafficMetricIngestionService", () => {
  it("retains before publishing one aggregate projection dirty signal", async () => {
    const order: string[] = [];
    const publishDirtyIfLive = vi.fn(async (_runId: string, signal: unknown) => {
      order.push("publish");
      expect(signal).toEqual({
        type: "dashboard.projection.dirty",
        correlationId: metricRequest.correlationId,
      });
      return { outcome: "published" as const };
    });
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => {
        order.push("append");
        return "appended" as const;
      },
      publishDirtyIfLive,
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();

    expect(order).toEqual(["append", "publish"]);
    expect(publishDirtyIfLive).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("contains dirty-signal transport failure without rejecting retention", async () => {
    const publicationError = new Error("dirty signal publish failed");
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => "appended",
      publishDirtyIfLive: async () => ({
        outcome: "failed",
        error: publicationError,
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
      },
      "Could not publish traffic metric projection dirty signal.",
    );
  });

  it("contains a thrown dirty-signal publication failure after retention", async () => {
    const publicationError = new Error("pubsub unavailable");
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => "appended",
      publishDirtyIfLive: async () => {
        throw publicationError;
      },
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      {
        err: publicationError,
        runId: metricRequest.runId,
        correlationId: metricRequest.correlationId,
      },
      "Could not publish traffic metric projection dirty signal.",
    );
  });

  it("does not let a throwing warning logger redefine accepted retention", async () => {
    const warn = vi.fn(() => {
      throw new Error("logger unavailable");
    });
    const service = createService({
      appendIfLive: async () => "appended",
      publishDirtyIfLive: async () => ({
        outcome: "failed",
        error: new Error("dirty publish failed"),
      }),
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("accepts retained work when reset fences advisory publication between phases", async () => {
    const warn = vi.fn();
    const service = createService({
      appendIfLive: async () => "appended",
      publishDirtyIfLive: async () => ({ outcome: "fenced" }),
      warn,
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("propagates retention failure without publishing", async () => {
    const retentionError = new Error("retention unavailable");
    const publishDirtyIfLive = vi.fn();
    const service = createService({
      appendIfLive: async () => {
        throw retentionError;
      },
      publishDirtyIfLive,
      warn: vi.fn(),
    });

    await expect(service.ingest(metricRequest)).rejects.toBe(retentionError);
    expect(publishDirtyIfLive).not.toHaveBeenCalled();
  });

  it("accepts duplicate work without publishing another dirty signal", async () => {
    const publishDirtyIfLive = vi.fn();
    const service = createService({
      appendIfLive: async () => "duplicate",
      publishDirtyIfLive,
      warn: vi.fn(),
    });

    await expect(service.ingest(metricRequest)).resolves.toBeUndefined();
    expect(publishDirtyIfLive).not.toHaveBeenCalled();
  });

  it("rejects missing, wrong-lifecycle, and reset-fenced runs before publication", async () => {
    const appendIfLive = vi.fn(async () => "appended" as const);
    const publishDirtyIfLive = vi.fn(async () => ({ outcome: "published" as const }));
    const missing = createService({ appendIfLive, publishDirtyIfLive, warn: vi.fn(), run: null });
    const draining = createService({
      appendIfLive,
      publishDirtyIfLive,
      warn: vi.fn(),
      run: { status: "draining", trafficStatus: "succeeded" },
    });
    const fenced = createService({
      appendIfLive: async () => "fenced",
      publishDirtyIfLive,
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
    expect(publishDirtyIfLive).not.toHaveBeenCalled();
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
      return "appended" as const;
    });
    const publishDirtyIfLive = vi.fn(async () => {
      expect(transactionOpen).toBe(true);
      return { outcome: "published" as const };
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
      store: { appendIfLive, publishDirtyIfLive, countUnacceptedBatches: vi.fn() },
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
    expect(publishDirtyIfLive).toHaveBeenCalledTimes(maximumPendingTrafficMetricBatches);
    expect(maximumActiveStoreOperations).toBe(1);
  });

  it("counts each batch dropped at capacity once, unless another attempt of it was accepted", async () => {
    let releaseAppend: (() => void) | undefined;
    const appendGate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const countUnacceptedBatches = vi.fn(
      async (_runId: string, batchIds: string[]) =>
        batchIds.filter((batchId) => batchId !== metricRequest.batchId).length,
    );
    const service = createService({
      appendIfLive: async () => {
        await appendGate;
        return "appended";
      },
      publishDirtyIfLive: async () => ({ outcome: "published" }),
      countUnacceptedBatches,
      warn: vi.fn(),
    });
    const runStartedAt = new Date();
    await expect(service.droppedBatchCount(metricRequest.runId, runStartedAt)).resolves.toBe(0);

    const admitted = Array.from({ length: maximumPendingTrafficMetricBatches }, () =>
      service.ingest(metricRequest),
    );
    const lostBatchId = "77777777-7777-4777-8777-777777777778";
    await service.ingest({ ...metricRequest, batchId: lostBatchId });
    await service.ingest({ ...metricRequest, batchId: lostBatchId });
    await service.ingest(metricRequest);
    releaseAppend?.();
    await Promise.all(admitted);

    await expect(service.droppedBatchCount(metricRequest.runId, runStartedAt)).resolves.toBe(1);
    expect(countUnacceptedBatches).toHaveBeenCalledWith(metricRequest.runId, [
      lostBatchId,
      metricRequest.batchId,
    ]);
  });

  it("reads the count as unknown for a run that started before the process", async () => {
    const service = createService({
      appendIfLive: async () => "appended",
      publishDirtyIfLive: async () => ({ outcome: "published" }),
      warn: vi.fn(),
    });

    await expect(service.droppedBatchCount(metricRequest.runId, new Date(0))).resolves.toBeNull();
  });
});

function createService(options: {
  appendIfLive: Pick<DashboardTrafficMetricStore, "appendIfLive">["appendIfLive"];
  publishDirtyIfLive: Pick<DashboardTrafficMetricStore, "publishDirtyIfLive">["publishDirtyIfLive"];
  countUnacceptedBatches?: DashboardTrafficMetricStore["countUnacceptedBatches"];
  warn: ReturnType<typeof vi.fn>;
  run?: { status: string; trafficStatus: string } | null;
}): TrafficMetricIngestionService {
  const selectedRun =
    options.run === undefined ? { status: "active", trafficStatus: "active" } : options.run;
  return new TrafficMetricIngestionService({
    db: databaseForRun(selectedRun) as never,
    store: {
      appendIfLive: options.appendIfLive,
      publishDirtyIfLive: options.publishDirtyIfLive,
      countUnacceptedBatches: options.countUnacceptedBatches ?? (async () => 0),
    },
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
