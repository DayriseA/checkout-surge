import { healthReadyPath } from "@checkout-surge/contracts";
import { createServiceLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "../../src/runtime/config.js";
import { type BuildApiServerOptions, buildApiServer } from "../../src/server.js";

const ids = {
  run: "44444444-4444-4444-8444-444444444444",
  saleOffer: "22222222-2222-4222-8222-222222222222",
};

describe("API request logging", () => {
  let server: Awaited<ReturnType<typeof buildApiServer>> | undefined;

  afterEach(async () => {
    await server?.close();
  });

  async function buildServer() {
    const lines: Record<string, unknown>[] = [];
    const logger = createServiceLogger({
      service: "api",
      level: "info",
      destination: { write: (line: string) => lines.push(JSON.parse(line)) },
    });
    server = await buildApiServer({
      config: loadApiConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://postgres:postgres@localhost/test",
        REDIS_URL: "redis://localhost:6380",
        CONTROL_SERVICE_TOKEN: "test-control-token",
        PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
      }),
      logger,
      readiness: {
        checks: async () => [{ name: "database_reachable", status: "unavailable" }],
        close: async () => undefined,
      },
      reserveOrderService: {
        reserve: async (input: { correlationId: string }) => ({
          outcome: "sold_out",
          correlationId: input.correlationId,
          timestamp: "2026-06-20T00:00:00.000Z",
          reservation: null,
          order: null,
        }),
      },
    } as unknown as BuildApiServerOptions);
    return { server, lines };
  }

  it("logs nothing per request for a success or a sold-out answer", async () => {
    const { server, lines } = await buildServer();

    const live = await server.inject({ method: "GET", url: "/health/live" });
    const soldOut = await server.inject({
      method: "POST",
      url: "/buy",
      payload: {
        runId: ids.run,
        saleOfferId: ids.saleOffer,
        idempotencyKey: "sold-out-idem-1",
        quantity: 1,
      },
    });

    expect([live.statusCode, soldOut.statusCode]).toEqual([200, 409]);
    expect(lines).toEqual([]);
  });

  it("logs one line for a failed request", async () => {
    const { server, lines } = await buildServer();

    const ready = await server.inject({ method: "GET", url: healthReadyPath });

    expect(ready.statusCode).toBe(503);
    expect(lines).toEqual([
      expect.objectContaining({
        msg: "Request failed.",
        level: 50,
        method: "GET",
        url: healthReadyPath,
        statusCode: 503,
      }),
    ]);
  });
});
