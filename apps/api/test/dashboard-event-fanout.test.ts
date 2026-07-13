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
  throwOnWrite = false;
  throwOnWriteHead = false;

  writeHead(statusCode: number, headers: Record<string, unknown>): this {
    if (this.throwOnWriteHead) throw new Error("writeHead failed");
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("write failed");
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
      sourceKey: "ip4:127.0.0.1",
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
      sourceKey: "ip4:127.0.0.1",
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
      sourceKey: "ip4:127.0.0.1",
    });
    fanout.close();

    expect(fanout.clientCount()).toBe(0);
    expect(response.writableEnded).toBe(true);
  });

  it("atomically distinguishes per-source and total capacity and frees slots once", () => {
    let id = 0;
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      maxClients: 2,
      maxClientsPerSource: 1,
      generateConnectionId: () => `connection-${++id}`,
    });
    const firstRequest = new FakeRequest();
    const firstResponse = new FakeResponse();
    expect(
      fanout.connect({
        request: firstRequest as IncomingMessage,
        response: firstResponse as unknown as ServerResponse,
        correlationId: "first",
        sourceKey: "ip4:192.0.2.1",
      }),
    ).toBe("connected");
    expect(
      fanout.connect({
        request: new FakeRequest() as IncomingMessage,
        response: new FakeResponse() as unknown as ServerResponse,
        correlationId: "same-source",
        sourceKey: "ip4:192.0.2.1",
      }),
    ).toBe("source_capacity");
    expect(
      fanout.connect({
        request: new FakeRequest() as IncomingMessage,
        response: new FakeResponse() as unknown as ServerResponse,
        correlationId: "other-source",
        sourceKey: "ip4:192.0.2.2",
      }),
    ).toBe("connected");
    expect(
      fanout.connect({
        request: new FakeRequest() as IncomingMessage,
        response: new FakeResponse() as unknown as ServerResponse,
        correlationId: "total",
        sourceKey: "ip4:192.0.2.3",
      }),
    ).toBe("total_capacity");
    firstRequest.emit("close");
    firstResponse.emit("close");
    expect(
      fanout.connect({
        request: new FakeRequest() as IncomingMessage,
        response: new FakeResponse() as unknown as ServerResponse,
        correlationId: "reconnect",
        sourceKey: "ip4:192.0.2.1",
      }),
    ).toBe("connected");
  });

  it("reserves before a re-entrant accepted callback and cleans callback failure", () => {
    let id = 0;
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      maxClients: 1,
      maxClientsPerSource: 1,
      generateConnectionId: () => `connection-${++id}`,
    });
    let nestedOutcome: string | undefined;
    const input = connectionInput("first", "ip4:192.0.2.1");
    expect(
      fanout.connect({
        ...input,
        onAccepted: () => {
          nestedOutcome = fanout.connect(connectionInput("nested", "ip4:192.0.2.2"));
        },
      }),
    ).toBe("connected");
    expect(nestedOutcome).toBe("total_capacity");
    fanout.close();

    expect(() =>
      fanout.connect({
        ...connectionInput("throw", "ip4:192.0.2.1"),
        onAccepted: () => {
          throw new Error("hijack failed");
        },
      }),
    ).toThrow("hijack failed");
    expect(fanout.clientCount()).toBe(0);
    expect(fanout.connect(connectionInput("later", "ip4:192.0.2.1"))).toBe("connected");
    fanout.close();
  });

  it.each([
    "backpressure",
    "throw",
    "headers",
  ] as const)("frees opening capacity after initial %s and permits reconnect", (failure) => {
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      maxClients: 1,
      maxClientsPerSource: 1,
    });
    const input = connectionInput("failed", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    if (failure === "backpressure") response.writeResult = false;
    if (failure === "throw") response.throwOnWrite = true;
    if (failure === "headers") response.throwOnWriteHead = true;
    expect(fanout.connect(input)).toBe("connected");
    expect(fanout.clientCount()).toBe(0);
    expect(fanout.connect(connectionInput("later", "ip4:192.0.2.1"))).toBe("connected");
    fanout.close();
  });

  it.each([
    "request",
    "response",
    "event-backpressure",
    "event-throw",
    "shutdown",
  ] as const)("idempotently frees capacity after %s teardown and stops the timer at zero", (teardown) => {
    vi.useFakeTimers();
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      heartbeatMs: 10,
      maxClients: 1,
      maxClientsPerSource: 1,
    });
    const input = connectionInput("first", "ip4:192.0.2.1");
    const request = input.request as unknown as FakeRequest;
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    if (teardown === "request") request.emit("close");
    if (teardown === "response") response.emit("close");
    if (teardown === "event-backpressure") {
      response.writeResult = false;
      fanout.publish(dashboardEvent);
    }
    if (teardown === "event-throw") {
      response.throwOnWrite = true;
      fanout.publish(dashboardEvent);
    }
    if (teardown === "shutdown") fanout.close();
    request.emit("close");
    response.emit("close");
    expect(fanout.clientCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fanout.connect(connectionInput("later", "ip4:192.0.2.1"))).toBe("connected");
    fanout.close();
  });

  it.each([
    "backpressure",
    "throw",
  ] as const)("closes on heartbeat %s and allows reconnect", (failure) => {
    vi.useFakeTimers();
    const fanout = new DashboardEventFanout({
      logger: createSilentLogger("api"),
      heartbeatMs: 10,
      maxClients: 1,
      maxClientsPerSource: 1,
    });
    const input = connectionInput("first", "ip4:192.0.2.1");
    (input.response as unknown as FakeResponse).writeResult = true;
    fanout.connect(input);
    if (failure === "backpressure") (input.response as unknown as FakeResponse).writeResult = false;
    else (input.response as unknown as FakeResponse).throwOnWrite = true;
    vi.advanceTimersByTime(10);
    expect(fanout.clientCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(fanout.connect(connectionInput("later", "ip4:192.0.2.1"))).toBe("connected");
    fanout.close();
  });
});

function connectionInput(correlationId: string, sourceKey: string) {
  return {
    request: new FakeRequest() as IncomingMessage,
    response: new FakeResponse() as unknown as ServerResponse,
    correlationId,
    sourceKey,
  };
}
