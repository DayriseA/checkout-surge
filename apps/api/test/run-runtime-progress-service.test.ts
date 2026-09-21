import type { RunRuntimeProgress } from "@checkout-surge/contracts";
import type { RunRuntimeProgressReadModel } from "@checkout-surge/db";
import { describe, expect, it, vi } from "vitest";
import { RunRuntimeProgressService } from "../src/services/run-runtime-progress-service.js";

const now = new Date("2026-09-21T12:00:30.000Z");
const runId = "11111111-1111-4111-8111-111111111111";

describe("RunRuntimeProgressService", () => {
  it("derives the confirmation rate over the stated window and the nominal status", async () => {
    const service = buildService({
      model: {
        outstandingOrders: 3,
        oldestOutstandingAgeSeconds: 12.5,
        confirmedOrdersInWindow: 5,
        processingStartedAt: new Date(now.getTime() - 30_000),
      },
      status: "nominal",
    });

    await expect(service.getProgress(runId)).resolves.toEqual(
      progressFixture({
        confirmationRatePerSecond: 0.5,
        confirmationRateWindowSeconds: 10,
      }),
    );
  });

  it("bounds the rate window by the elapsed processing time", async () => {
    const service = buildService({
      model: {
        outstandingOrders: 2,
        oldestOutstandingAgeSeconds: 4,
        confirmedOrdersInWindow: 2,
        processingStartedAt: new Date(now.getTime() - 4_000),
      },
      status: "erp_limiting",
    });

    await expect(service.getProgress(runId)).resolves.toEqual(
      progressFixture({
        outstandingOrders: 2,
        oldestOutstandingAgeSeconds: 4,
        confirmationRatePerSecond: 0.5,
        confirmationRateWindowSeconds: 4,
        downstreamErpStatus: "erp_limiting",
      }),
    );
  });

  it("keeps a genuine zero rate inside the window instead of reporting unavailability", async () => {
    const service = buildService({
      model: progressModel({
        confirmedOrdersInWindow: 0,
      }),
      status: "nominal",
    });

    await expect(service.getProgress(runId)).resolves.toEqual(
      progressFixture({ confirmationRatePerSecond: 0 }),
    );
  });

  it("reports no measurable rate before any order has entered processing", async () => {
    const service = buildService({
      model: progressModel({ processingStartedAt: null, confirmedOrdersInWindow: 0 }),
      status: "nominal",
    });

    await expect(service.getProgress(runId)).resolves.toEqual(
      progressFixture({
        confirmationRatePerSecond: null,
        confirmationRateWindowSeconds: 0,
      }),
    );
  });

  it("reports a failed downstream status read as explicitly unavailable", async () => {
    const loggerError = vi.fn();
    const service = buildService({
      model: progressModel(),
      statusError: new Error("resilience state unavailable"),
      loggerError,
    });

    await expect(service.getProgress(runId)).resolves.toEqual(
      progressFixture({
        downstreamErpStatus: null,
        downstreamErpStatusReadStatus: "unavailable",
      }),
    );
    expect(loggerError).toHaveBeenCalledOnce();
  });

  it("propagates a failed progress read so the projection can degrade the section", async () => {
    const service = buildService({
      modelError: new Error("orders unavailable"),
      status: "nominal",
    });

    await expect(service.getProgress(runId)).rejects.toThrow("orders unavailable");
  });
});

function progressModel(
  overrides: Partial<RunRuntimeProgressReadModel> = {},
): RunRuntimeProgressReadModel {
  return {
    outstandingOrders: 3,
    oldestOutstandingAgeSeconds: 12.5,
    confirmedOrdersInWindow: 5,
    processingStartedAt: new Date(now.getTime() - 30_000),
    ...overrides,
  };
}

function progressFixture(overrides: Partial<RunRuntimeProgress> = {}): RunRuntimeProgress {
  return {
    runId,
    outstandingOrders: 3,
    oldestOutstandingAgeSeconds: 12.5,
    confirmationRatePerSecond: 0.5,
    confirmationRateWindowSeconds: 10,
    downstreamErpStatus: "nominal",
    downstreamErpStatusReadStatus: "available",
    observedAt: now.toISOString(),
    ...overrides,
  };
}

function buildService(options: {
  model?: RunRuntimeProgressReadModel;
  modelError?: Error;
  status?: RunRuntimeProgress["downstreamErpStatus"];
  statusError?: Error;
  loggerError?: (error: unknown) => void;
}) {
  return new RunRuntimeProgressService({
    progressReader: {
      read: async () => {
        if (options.modelError) throw options.modelError;
        return options.model ?? progressModel();
      },
    },
    downstreamStatusReader: {
      read: async () => {
        if (options.statusError) throw options.statusError;
        return options.status ?? "nominal";
      },
    },
    logger: { error: options.loggerError ?? vi.fn() } as never,
    now: () => now,
  });
}
