import { startDemoRunPath } from "@checkout-surge/contracts";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it } from "vitest";
import { loadApiConfig } from "../../src/runtime/config.js";
import { buildBuyServer } from "../../src/server.js";

const buy = {
  runId: "44444444-4444-4444-8444-444444444444",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  idempotencyKey: "pool-idem-1",
  quantity: 1,
};

describe("buy-only API process", () => {
  let server: Awaited<ReturnType<typeof buildBuyServer>> | undefined;

  afterEach(async () => {
    await server?.close();
  });

  it("answers buyers and leaves every run operation to the control process", async () => {
    const soldOut = async (input: { correlationId: string }) => ({
      outcome: "sold_out" as const,
      correlationId: input.correlationId,
      timestamp: "2026-06-20T00:00:00.000Z",
      reservation: null,
      order: null,
    });
    server = await buildBuyServer({
      config: loadApiConfig({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://postgres:postgres@localhost/test",
        REDIS_URL: "redis://localhost:6380",
        CONTROL_SERVICE_TOKEN: "test-control-token",
        PUBLIC_CLIENT_COOKIE_SECRET: "test-public-cookie-secret",
      }),
      logger: createSilentLogger("api"),
      readiness: { checks: async () => [], close: async () => undefined },
      reserveOrderService: { reserve: soldOut },
      synchronousConfirmationBuyService: { buy: soldOut },
      postgresStockBuyService: { buy: soldOut },
    } as unknown as Parameters<typeof buildBuyServer>[0]);

    const answers = await Promise.all(
      ["/buy", "/stock-in-postgres/buy"].map((url) =>
        server?.inject({ method: "POST", url, payload: buy }),
      ),
    );
    const start = await server.inject({ method: "POST", url: startDemoRunPath, payload: {} });

    expect(answers.map((answer) => answer?.statusCode)).toEqual([409, 409]);
    expect(start.statusCode).toBe(404);
  });
});
