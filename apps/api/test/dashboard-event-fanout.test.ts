import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardEvent } from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardEventFanout } from "../src/realtime/dashboard-event-fanout.js";

const dashboardEvent: DashboardEvent = {
  type: "traffic.metric",
  eventId: "77777777-7777-4777-8777-777777777777",
  runId: "55555555-5555-4555-8555-555555555555",
  metricName: "traffic.latency",
  value: 42,
  unit: "ms",
  occurredAt: "2026-06-20T12:00:00.000Z",
};

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  headers: Record<string, unknown> = {};
  statusCode: number | null = null;
  destroyed = false;
  writableEnded = false;
  writeResult = true;

  writeHead(statusCode: number, headers: Record<string, unknown>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return this.writeResult;
  }

  end(): this {
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

describe("dashboard event fan-out", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens SSE clients with reconnect guidance, heartbeat comments, and contract event frames", () => {
    vi.useFakeTimers();
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      heartbeatMs: 50,
      retryMs: 1234,
      generateConnectionId: () => "connection-1",
    });
    const request = new FakeRequest();
    const response = new FakeResponse();

    fanout.connect({
      request: request as IncomingMessage,
      response: response as unknown as ServerResponse,
      correlationId: "corr-dashboard-test",
    });
    vi.advanceTimersByTime(50);
    fanout.publish(dashboardEvent);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      [correlationIdHeaderName]: "corr-dashboard-test",
    });
    expect(response.chunks[0]).toBe("retry: 1234\n: connected\n\n");
    expect(response.chunks.some((chunk) => chunk.startsWith(": heartbeat "))).toBe(true);
    expect(response.chunks.join("")).toContain('"type":"traffic.metric"');
    expect(response.chunks.join("")).toContain('"eventId":"77777777-7777-4777-8777-777777777777"');
    expect(fanout.clientCount()).toBe(1);

    request.emit("close");

    expect(fanout.clientCount()).toBe(0);
    expect(response.writableEnded).toBe(true);
  });

  it("closes a client immediately instead of buffering when a write applies backpressure", () => {
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      generateConnectionId: () => "connection-1",
    });
    const request = new FakeRequest();
    const response = new FakeResponse();

    fanout.connect({
      request: request as IncomingMessage,
      response: response as unknown as ServerResponse,
      correlationId: "corr-dashboard-test",
    });
    response.writeResult = false;

    fanout.publish(dashboardEvent);

    expect(fanout.clientCount()).toBe(0);
    expect(response.writableEnded).toBe(true);
  });

  it("closes every active client during server shutdown", () => {
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      generateConnectionId: () => "connection-1",
    });
    const request = new FakeRequest();
    const response = new FakeResponse();

    fanout.connect({
      request: request as IncomingMessage,
      response: response as unknown as ServerResponse,
      correlationId: "corr-dashboard-test",
    });
    fanout.close();

    expect(fanout.clientCount()).toBe(0);
    expect(response.writableEnded).toBe(true);
  });
});
