import { dashboardRecoveryResponseSchema, errorPayloadSchema } from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { fastify } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type {
  DashboardEventFanout,
  DashboardSseAdmission,
} from "../src/realtime/dashboard-event-fanout.js";
import { registerDashboardRoutes } from "../src/routes/dashboard-routes.js";
import type { ApiFastifyInstance } from "../src/runtime/fastify.js";
import type { DashboardRecoveryAdmissionController } from "../src/services/dashboard-recovery-admission.js";
import type { DashboardRecoveryService } from "../src/services/dashboard-recovery-service.js";

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
    ["rate_limited", 429, "dashboard_recovery_rate_limited"],
    ["at_capacity", 503, "dashboard_recovery_at_capacity"],
    ["unavailable", 503, "dashboard_recovery_limiter_unavailable"],
  ] as const)("rejects recovery %s before service work", async (outcome, status, code) => {
    const getRecovery = vi.fn();
    const server = buildServer({ recoveryOutcome: outcome, getRecovery });
    const response = await server.inject({
      method: "GET",
      url: "/dashboard/recovery",
      headers: correlationHeader,
    });
    expect(response.statusCode).toBe(status);
    expect(errorPayloadSchema.parse(response.json()).code).toBe(code);
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
    dashboardRecoveryResponseSchema.parse(success.json());
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
});

function buildServer(options: {
  sseOutcome?: DashboardSseAdmission;
  recoveryOutcome?: "rate_limited" | "at_capacity" | "unavailable";
  getRecovery?: ReturnType<typeof vi.fn>;
  release?: ReturnType<typeof vi.fn>;
}) {
  const app = fastify({ loggerInstance: createSilentLogger("api") }) as ApiFastifyInstance;
  installFastifyCorrelation(app);
  app.setErrorHandler((_error, request, reply) =>
    reply.status(500).send(
      errorPayloadSchema.parse({
        code: "internal_error",
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
    dashboardEventFanout: {
      connect: () => options.sseOutcome ?? "connected",
    } as DashboardEventFanout,
    dashboardRecoveryService: {
      getRecovery: options.getRecovery ?? vi.fn().mockResolvedValue(recoveryFixture()),
    } as unknown as DashboardRecoveryService,
    dashboardRecoveryAdmission: admission,
    sourceResolver: {
      resolveSse: (ip) => ip,
      resolveRecovery: ({ ip }) => ip,
    },
    sseRetryAfterSeconds: 7,
    recoveryRetryAfterSeconds: 11,
  });
  return app;
}

function recoveryFixture() {
  return {
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
