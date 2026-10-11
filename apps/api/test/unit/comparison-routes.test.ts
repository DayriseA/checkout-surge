import {
  type ComparisonDetailResponse,
  comparisonStageRoles,
  controlServiceTokenHeaderName,
  demoRunOperatorModeHeaderName,
  publicVisitorIdHeaderName,
} from "@checkout-surge/contracts";
import { previewRunConfigSnapshotFixture } from "@checkout-surge/contracts/testing";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComparisonRoutes } from "../../src/routes/comparison-routes.js";
import { buildApiHttpServer } from "../../src/runtime/api-http-server.js";
import { loadApiConfig } from "../../src/runtime/config.js";

const id = "11111111-1111-4111-8111-111111111111";
const run = {
  comparisonId: id,
  runId: "22222222-2222-4222-8222-222222222220",
  presetId: "33333333-3333-4333-8333-333333333338",
  presetName: "Redis",
  operatorMode: "public" as const,
  executionMode: "demo" as const,
  status: "starting" as const,
  trafficStatus: "starting" as const,
  configSnapshot: previewRunConfigSnapshotFixture(),
  startedAt: "2026-10-11T00:00:00.000Z",
  autoResetAt: "2026-10-11T00:15:00.000Z",
};
const headers = {
  [controlServiceTokenHeaderName]: "control-token",
  [demoRunOperatorModeHeaderName]: "public",
  [publicVisitorIdHeaderName]: "signed-credential",
};
const servers: Awaited<ReturnType<typeof buildApiHttpServer>>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function build(outcome: "admitted" | "rate_limited" | "at_capacity" = "admitted") {
  const server = await buildApiHttpServer({
    config: loadApiConfig({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://postgres:postgres@localhost/test",
      REDIS_URL: "redis://localhost:6380",
      CONTROL_SERVICE_TOKEN: "control-token",
      PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
    }),
    logger: createSilentLogger("api"),
  });
  servers.push(server);
  const startComparison = vi.fn(async () => ({ comparisonId: id, run }));
  const detail = vi.fn(
    async (_comparisonId: string, _signal: AbortSignal): Promise<ComparisonDetailResponse | null> =>
      null,
  );
  const release = vi.fn();
  registerComparisonRoutes(server, {
    comparisonService: { startComparison },
    comparisonReader: { detail },
    admission: { admit: async () => (outcome === "admitted" ? { outcome, release } : { outcome }) },
    sourceResolver: { resolveRecovery: () => "visitor", resolveSse: () => "visitor" },
    controlServiceToken: "control-token",
    timeoutMs: 1000,
    retryAfterSeconds: 5,
  });
  return { server, startComparison, detail, release };
}

describe("fixed public comparison routes", () => {
  it("returns the parent and current child without stripping membership", async () => {
    const { server, detail, release } = await build();
    const modes = ["demo", "without_redis", "demo", "without_order_queue"] as const;
    const fixture = {
      comparisonId: id,
      acceptedAt: run.startedAt,
      autoResetAt: run.autoResetAt,
      state: "running",
      currentStage: 0,
      currentRunId: run.runId,
      terminalReason: null,
      currentFailureReason: null,
      terminalAt: null,
      timestamp: run.startedAt,
      stages: comparisonStageRoles.map((role, index) =>
        index === 0
          ? { role, runId: run.runId, executionMode: modes[index], availability: "pending", run }
          : {
              role,
              runId: `22222222-2222-4222-8222-22222222222${index}`,
              executionMode: modes[index],
              availability: "not_run",
            },
      ),
    };
    detail.mockResolvedValue(fixture as ComparisonDetailResponse);
    const response = await server.inject({ method: "GET", url: `/demo/comparisons/${id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fixture);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(release).toHaveBeenCalledOnce();
  });
  it("reuses public credential and correlation transport, accepting no configuration", async () => {
    const { server, startComparison } = await build();
    const response = await server.inject({
      method: "POST",
      url: "/demo/comparisons/start",
      headers,
      payload: { correlationId: "comparison-start" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      comparisonId: id,
      correlationId: "comparison-start",
      run: { comparisonId: id },
    });
    expect(startComparison).toHaveBeenCalledWith("signed-credential", "comparison-start");
    const invalid = await server.inject({
      method: "POST",
      url: "/demo/comparisons/start",
      headers,
      payload: { executionMode: "without_redis" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(startComparison).toHaveBeenCalledOnce();
  });
  it("refuses missing control authority or admin mode before starting", async () => {
    const { server, startComparison } = await build();
    expect(
      (await server.inject({ method: "POST", url: "/demo/comparisons/start", payload: {} }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/demo/comparisons/start",
          headers: { ...headers, [demoRunOperatorModeHeaderName]: "admin" },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    expect(startComparison).not.toHaveBeenCalled();
  });
  it.each([
    ["rate_limited", 429],
    ["at_capacity", 503],
  ] as const)("bounds %s reads before DB work", async (outcome, status) => {
    const { server, detail } = await build(outcome);
    const response = await server.inject({ method: "GET", url: `/demo/comparisons/${id}` });
    expect(response.statusCode).toBe(status);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(detail).not.toHaveBeenCalled();
  });
  it("rejects invalid IDs and returns bounded missing-parent reads, releasing the permit", async () => {
    const { server, detail, release } = await build();
    expect((await server.inject({ method: "GET", url: "/demo/comparisons/nope" })).statusCode).toBe(
      400,
    );
    expect(detail).not.toHaveBeenCalled();
    const response = await server.inject({ method: "GET", url: `/demo/comparisons/${id}` });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(release).toHaveBeenCalledOnce();
  });
  it("returns retry guidance after an aborted database read and releases its permit", async () => {
    const { server, detail, release } = await build();
    detail.mockImplementation(
      async (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const response = await server.inject({ method: "GET", url: `/demo/comparisons/${id}` });
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(response.json().code).toBe("comparison_read_unavailable");
    expect(release).toHaveBeenCalledOnce();
  });
});
