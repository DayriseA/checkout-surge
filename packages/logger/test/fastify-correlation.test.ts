import { errorPayloadSchema } from "@checkout-surge/contracts";
import { fastify } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { installFastifyCorrelation, replaceFastifyCorrelation } from "../src/fastify.js";
import { correlationIdHeaderName, createServiceLogger } from "../src/index.js";

interface CapturedLog {
  msg: string;
  correlationId?: string;
  reqId?: string;
  marker?: string;
}

function createCapturingLogger(service: "api") {
  const lines: string[] = [];
  const destination = { write: (chunk: string) => void lines.push(chunk) };
  const logger = createServiceLogger({ service, level: "info", destination });
  return { logger, lines, records: () => lines.map((line) => JSON.parse(line) as CapturedLog) };
}

describe("Fastify correlation installer", () => {
  let server: ReturnType<typeof fastify> | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("binds a known inbound id into the response header, error body, and routine request logs", async () => {
    const { logger, records } = createCapturingLogger("api");
    server = fastify({ loggerInstance: logger });
    installFastifyCorrelation(server);

    server.route({
      method: "GET",
      url: "/echo",
      handler: async (request) => {
        request.log.info({ marker: "echo-marker" }, "echo");
        return { correlationId: request.correlationId };
      },
    });
    server.setErrorHandler((_error, request, reply) =>
      reply.status(500).send(
        errorPayloadSchema.parse({
          code: "internal_error",
          message: "failed",
          correlationId: request.correlationId,
          timestamp: new Date().toISOString(),
        }),
      ),
    );
    server.route({
      method: "GET",
      url: "/boom",
      handler: async () => {
        throw new Error("boom");
      },
    });

    const echo = await server.inject({
      method: "GET",
      url: "/echo",
      headers: { [correlationIdHeaderName]: "known-inbound-1" },
    });
    const boom = await server.inject({
      method: "GET",
      url: "/boom",
      headers: { [correlationIdHeaderName]: "known-inbound-1" },
    });

    expect(echo.headers[correlationIdHeaderName]).toBe("known-inbound-1");
    expect(echo.json().correlationId).toBe("known-inbound-1");
    expect(boom.headers[correlationIdHeaderName]).toBe("known-inbound-1");
    expect(errorPayloadSchema.parse(boom.json()).correlationId).toBe("known-inbound-1");

    const echoRecords = records().filter((record) => record.msg === "echo");
    expect(echoRecords).toHaveLength(1);
    expect(echoRecords[0]?.correlationId).toBe("known-inbound-1");
    expect(echoRecords[0]?.marker).toBe("echo-marker");
  });

  it("isolates correlation bindings across requests with different ids", async () => {
    const { logger, records } = createCapturingLogger("api");
    server = fastify({ loggerInstance: logger });
    installFastifyCorrelation(server);

    server.route({
      method: "GET",
      url: "/echo",
      handler: async (request) => {
        request.log.info({ marker: "echo-marker" }, "echo");
        return { correlationId: request.correlationId };
      },
    });

    const first = await server.inject({
      method: "GET",
      url: "/echo",
      headers: { [correlationIdHeaderName]: "isolated-a" },
    });
    const second = await server.inject({
      method: "GET",
      url: "/echo",
      headers: { [correlationIdHeaderName]: "isolated-b" },
    });

    expect(first.headers[correlationIdHeaderName]).toBe("isolated-a");
    expect(second.headers[correlationIdHeaderName]).toBe("isolated-b");

    const echoRecords = records().filter((record) => record.msg === "echo");
    expect(echoRecords).toHaveLength(2);
    expect(echoRecords[0]?.correlationId).toBe("isolated-a");
    expect(echoRecords[1]?.correlationId).toBe("isolated-b");
  });

  it("replaces the request correlation from a body id without emitting duplicate keys", async () => {
    const { logger, lines, records } = createCapturingLogger("api");
    server = fastify({ loggerInstance: logger });
    installFastifyCorrelation(server);

    server.route({
      method: "POST",
      url: "/promote",
      handler: async (request, reply) => {
        const promoted = replaceFastifyCorrelation(request, reply, "body-promoted-id");
        request.log.info({ marker: "promoted-marker" }, "promoted");
        return { correlationId: promoted };
      },
    });

    const response = await server.inject({
      method: "POST",
      url: "/promote",
      headers: { [correlationIdHeaderName]: "inbound-header-id" },
    });

    expect(response.headers[correlationIdHeaderName]).toBe("body-promoted-id");
    expect(response.json().correlationId).toBe("body-promoted-id");

    const rawLine = lines.find((line) => line.includes('"promoted"'));
    expect(rawLine).toBeDefined();
    expect((rawLine?.match(/"reqId"/g) ?? []).length).toBe(1);
    expect((rawLine?.match(/"correlationId"/g) ?? []).length).toBe(1);
    expect((rawLine?.match(/"body-promoted-id"/g) ?? []).length).toBe(2);
    expect(rawLine).not.toContain('"inbound-header-id"');

    const promotedRecord = records().find((record) => record.msg === "promoted");
    expect(promotedRecord?.reqId).toBe("body-promoted-id");
    expect(promotedRecord?.correlationId).toBe("body-promoted-id");

    const rootBindings = logger.bindings();
    expect(rootBindings).not.toHaveProperty("correlationId");
    expect(rootBindings).not.toHaveProperty("reqId");
  });

  it("generates a valid id once when the inbound header is absent or invalid", async () => {
    const { logger } = createCapturingLogger("api");
    server = fastify({ loggerInstance: logger });
    installFastifyCorrelation(server);

    server.route({
      method: "GET",
      url: "/echo",
      handler: async (request) => ({ correlationId: request.correlationId }),
    });

    const missing = await server.inject({ method: "GET", url: "/echo" });
    const blank = await server.inject({
      method: "GET",
      url: "/echo",
      headers: { [correlationIdHeaderName]: "   " },
    });
    const oversized = await server.inject({
      method: "GET",
      url: "/echo",
      headers: { [correlationIdHeaderName]: "x".repeat(200) },
    });

    for (const response of [missing, blank, oversized]) {
      const id = response.headers[correlationIdHeaderName];
      expect(typeof id).toBe("string");
      expect(id).toHaveLength(36);
      expect(response.json().correlationId).toBe(id);
    }
  });
});
