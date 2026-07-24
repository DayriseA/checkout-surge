import { describe, expect, it } from "vitest";
import {
  aggregateHealthStatus,
  childLoggerWithCorrelationId,
  createLivenessPayload,
  createReadinessResponse,
  createServiceLogger,
  normalizeCorrelationId,
} from "../src/index.js";

describe("correlation ID helpers", () => {
  it("accept valid correlation IDs and generates replacements for invalid input", () => {
    expect(normalizeCorrelationId("request-123")).toBe("request-123");
    expect(normalizeCorrelationId(" ", { generate: () => "generated-1" })).toBe("generated-1");
  });
});

describe("service logger wrapper", () => {
  it("stamps service metadata onto root and child loggers", () => {
    const logger = createServiceLogger({ service: "api", level: "silent" });
    const child = childLoggerWithCorrelationId(logger, "request-2");

    expect(logger.bindings()).toMatchObject({ service: "api" });
    expect(child.bindings()).toMatchObject({ correlationId: "request-2" });
  });
});

describe("health helpers", () => {
  it("aggregates readiness status by most severe check", () => {
    expect(
      aggregateHealthStatus([
        { name: "database_reachable", status: "ok" },
        { name: "redis_url_configured", status: "degraded" },
      ]),
    ).toBe("degraded");

    expect(
      aggregateHealthStatus([
        { name: "database_reachable", status: "ok" },
        { name: "worker_running", status: "unavailable" },
      ]),
    ).toBe("unavailable");
  });

  it("creates contract-valid readiness and liveness payloads", () => {
    const startedAt = new Date("2026-06-20T12:00:00.000Z");
    const now = new Date("2026-06-20T12:00:12.000Z");

    const readiness = createReadinessResponse({
      service: "worker",
      startedAt,
      now,
      checks: [{ name: "order_process_worker_running", status: "ok" }],
    });
    const liveness = createLivenessPayload({ service: "worker", startedAt, now });

    expect(readiness.status).toBe("ok");
    expect(readiness.uptimeSeconds).toBe(12);
    expect(liveness).toMatchObject({ service: "worker", status: "ok" });
  });
});
