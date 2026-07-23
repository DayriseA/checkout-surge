import {
  dashboardProjectionSchema,
  dashboardProjectionSchemaName,
  dashboardProjectionSchemaVersion,
  errorPayloadSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { fastify } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { DashboardSseAdmission } from "../src/realtime/dashboard-projection-fanout.js";
import { registerDashboardRoutes } from "../src/routes/dashboard-routes.js";
import type { ApiFastifyInstance } from "../src/runtime/fastify.js";
import type { DashboardRecoveryAdmissionController } from "../src/services/dashboard-recovery-admission.js";
import type { DashboardProjectionService } from "../src/services/dashboard-recovery-service.js";
import type { DashboardRecoveryWorkflowResult } from "../src/services/dashboard-recovery-workflow.js";
import { DashboardRecoveryWorkflow } from "../src/services/dashboard-recovery-workflow.js";

const correlationHeader = { [correlationIdHeaderName]: "route-correlation" };

describe("dashboard route admission", () => {
  it.each([
    ["total_capacity", 503, "dashboard_sse_at_capacity"],
    ["source_capacity", 429, "dashboard_sse_source_limit_exceeded"],
  ] as const)("maps SSE %s without partial stream headers", async (outcome, status, code) => {
    const server = buildServer({ sseOutcome: outcome });
    const response = await server.inject({
      method: "GET",
      url: "/dashboard/events",
      headers: correlationHeader,
    });
    const payload = errorPayloadSchema.parse(response.json());
    expect(response.statusCode).toBe(status);
    expect(payload.code).toBe(code);
    expect(payload.correlationId).toBe("route-correlation");
    expect(new Date(payload.timestamp).toISOString()).toBe(payload.timestamp);
    expect(response.headers["retry-after"]).toBe("7");
    expect(response.headers["content-type"]).not.toContain("text/event-stream");
    expect(response.body).not.toContain("retry:");
    await server.close();
  });

  it.each([
    ["rate_limited", 429, "dashboard_recovery_rate_limited", undefined],
    ["at_capacity", 503, "dashboard_recovery_unavailable", "at_capacity"],
  ] as const)("rejects recovery %s before service work", async (outcome, status, code, reason) => {
    const getRecovery = vi.fn();
    const server = buildServer({ recoveryOutcome: outcome, getRecovery });
    const response = await server.inject({
      method: "GET",
      url: "/dashboard/recovery",
      headers: correlationHeader,
    });
    expect(response.statusCode).toBe(status);
    expect(errorPayloadSchema.parse(response.json())).toMatchObject({
      code,
      correlationId: "route-correlation",
      ...(reason ? { details: { reason } } : {}),
    });
    expect(response.headers[correlationIdHeaderName]).toBe("route-correlation");
    expect(response.headers["retry-after"]).toBe("11");
    expect(getRecovery).not.toHaveBeenCalled();
    await server.close();
  });

  it("preserves the successful recovery contract and releases after success and throw", async () => {
    const release = vi.fn();
    const getRecovery = vi
      .fn()
      .mockResolvedValueOnce(recoveryFixture())
      .mockRejectedValueOnce(new Error("projection failed"));
    const server = buildServer({ getRecovery, release });
    const success = await server.inject({
      method: "GET",
      url: "/dashboard/recovery",
      headers: correlationHeader,
    });
    expect(success.statusCode).toBe(200);
    expect(dashboardProjectionSchema.parse(success.json()).correlationId).toBe("route-correlation");
    expect(success.headers[correlationIdHeaderName]).toBe("route-correlation");
    expect(getRecovery).toHaveBeenCalledWith({
      correlationId: "route-correlation",
      signal: expect.any(AbortSignal),
    });
    expect(release).toHaveBeenCalledTimes(1);
    const failure = await server.inject({
      method: "GET",
      url: "/dashboard/recovery",
      headers: correlationHeader,
    });
    expect(failure.statusCode).toBe(500);
    expect(release).toHaveBeenCalledTimes(2);
    await server.close();
  });

  it("passes a complete known scope through one recovery workflow call", async () => {
    const getRecovery = vi.fn().mockResolvedValue(recoveryFixture());
    const server = buildServer({ getRecovery });
    const knownRunId = "11111111-1111-4111-8111-111111111111";
    const knownSaleOfferId = "22222222-2222-4222-8222-222222222222";

    const response = await server.inject({
      method: "GET",
      url: `/dashboard/recovery?knownRunId=${knownRunId}&knownSaleOfferId=${knownSaleOfferId}`,
      headers: correlationHeader,
    });

    expect(response.statusCode).toBe(200);
    expect(getRecovery).toHaveBeenCalledWith({
      correlationId: "route-correlation",
      signal: expect.any(AbortSignal),
      knownScope: { runId: knownRunId, saleOfferId: knownSaleOfferId },
    });
    await server.close();
  });

  it("rejects an incomplete known recovery scope before workflow admission", async () => {
    const getRecovery = vi.fn();
    const server = buildServer({ getRecovery });

    const response = await server.inject({
      method: "GET",
      url: "/dashboard/recovery?knownRunId=11111111-1111-4111-8111-111111111111",
      headers: correlationHeader,
    });

    expect(response.statusCode).toBe(400);
    expect(getRecovery).not.toHaveBeenCalled();
    await server.close();
  });

  it("returns the stable contract-valid timeout error", async () => {
    const server = buildServer({ workflowOutcome: { outcome: "timed_out" } });

    const response = await server.inject({
      method: "GET",
      url: "/dashboard/recovery",
      headers: correlationHeader,
    });

    expect(response.statusCode).toBe(503);
    expect(errorPayloadSchema.parse(response.json())).toMatchObject({
      code: "dashboard_recovery_unavailable",
      correlationId: "route-correlation",
      details: { reason: "timed_out" },
    });
    expect(response.headers[correlationIdHeaderName]).toBe("route-correlation");
    expect(response.headers["retry-after"]).toBe("11");
    await server.close();
  });
});

function buildServer(options: {
  sseOutcome?: DashboardSseAdmission;
  recoveryOutcome?: "rate_limited" | "at_capacity";
  getRecovery?: DashboardProjectionService["getRecovery"];
  release?: () => void;
  workflowOutcome?: DashboardRecoveryWorkflowResult;
}) {
  const app = fastify({ loggerInstance: createSilentLogger("api") }) as ApiFastifyInstance;
  installFastifyCorrelation(app);
  app.setErrorHandler((error, request, reply) =>
    reply.status(error instanceof ZodError ? 400 : 500).send(
      errorPayloadSchema.parse({
        code: error instanceof ZodError ? "invalid_request" : "internal_error",
        message: "Dashboard route test failure.",
        correlationId: request.correlationId,
        timestamp: new Date().toISOString(),
      }),
    ),
  );
  const admission: DashboardRecoveryAdmissionController = {
    admit: async () =>
      options.recoveryOutcome
        ? { outcome: options.recoveryOutcome }
        : { outcome: "admitted", release: options.release ?? (() => undefined) },
  };
  registerDashboardRoutes(app, {
    dashboardProjectionFanout: {
      connect: () => options.sseOutcome ?? "connected",
    },
    dashboardRecoveryWorkflow: options.workflowOutcome
      ? { recover: async () => options.workflowOutcome as DashboardRecoveryWorkflowResult }
      : new DashboardRecoveryWorkflow({
          recovery: {
            getRecovery: options.getRecovery ?? vi.fn().mockResolvedValue(recoveryFixture()),
          } as unknown as DashboardProjectionService,
          admission,
        }),
    sourceResolver: {
      resolveSse: (ip) => ip,
      resolveRecovery: ({ ip }) => ip,
    },
    sseRetryAfterSeconds: 7,
    recoveryRetryAfterSeconds: 11,
    recoveryTimeoutMs: 5_000,
  });
  return app;
}

function recoveryFixture() {
  return {
    schema: dashboardProjectionSchemaName,
    version: dashboardProjectionSchemaVersion,
    correlationId: "route-correlation",
    scopeId: "idle",
    revision: 1,
    scope: null,
    recoveredAt: "2026-07-13T00:00:00.000Z",
    currentRun: null,
    inventory: null,
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recentMetrics: [],
    recentCompletionOutcomes: [],
  };
}
