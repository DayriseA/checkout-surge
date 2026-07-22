import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardEvent } from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardEventFanout,
  formatDashboardEventFrame,
} from "../src/realtime/dashboard-event-fanout.js";

const dashboardEvent: DashboardEvent = {
  type: "dashboard.metric.observed",
  runId: "55555555-5555-4555-8555-555555555555",
  metricName: "traffic.latency",
  value: 42,
  unit: "ms",
  occurredAt: "2026-06-20T12:00:00.000Z",
  observedAt: "2026-06-20T12:00:00.000Z",
};

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  readonly chunks: string[] = [];
  headers: Record<string, unknown> = {};
  statusCode: number | null = null;
  destroyed = false;
  writableEnded = false;
  writeResult = true;
  writeResults: boolean[] = [];
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
    return this.writeResults.shift() ?? this.writeResult;
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

  it("opens with exact SSE headers and reconnect wire bytes", () => {
    const fanout = createFanout({ retryMs: 1234 });
    const input = connectionInput("first", "ip4:127.0.0.1");
    const response = input.response as unknown as FakeResponse;

    fanout.connect(input);

    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      [correlationIdHeaderName]: "first",
    });
    expect(response.chunks).toEqual(["retry: 1234\n: connected\n\n"]);
    fanout.close();
  });

  it("uses one lazy heartbeat timer for all clients and stops it at zero or shutdown", () => {
    vi.useFakeTimers();
    const fanout = createFanout({ heartbeatMs: 50 });
    const first = connectionInput("first", "ip4:192.0.2.1");
    const second = connectionInput("second", "ip4:192.0.2.2");

    expect(vi.getTimerCount()).toBe(0);
    fanout.connect(first);
    fanout.connect(second);
    expect(vi.getTimerCount()).toBe(1);
    (first.request as unknown as FakeRequest).emit("close");
    expect(vi.getTimerCount()).toBe(1);
    (second.response as unknown as FakeResponse).emit("close");
    expect(vi.getTimerCount()).toBe(0);

    fanout.connect(connectionInput("third", "ip4:192.0.2.3"));
    expect(vi.getTimerCount()).toBe(1);
    fanout.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("orders events and heartbeats through one FIFO without duplicating the accepted false write", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:00.000Z"));
    const fanout = createFanout({ heartbeatMs: 10 });
    const input = connectionInput("first", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    response.writeResult = false;

    fanout.publish(dashboardEvent);
    vi.advanceTimersByTime(10);
    fanout.publish({ ...dashboardEvent, value: 43 });
    expect(response.chunks).toEqual([
      "retry: 3000\n: connected\n\n",
      formatDashboardEventFrame(dashboardEvent),
    ]);

    response.writeResult = true;
    response.emit("drain");
    expect(response.chunks).toEqual([
      "retry: 3000\n: connected\n\n",
      formatDashboardEventFrame(dashboardEvent),
      ": heartbeat 2026-07-16T12:00:00.010Z\n\n",
      formatDashboardEventFrame({ ...dashboardEvent, value: 43 }),
    ]);
    response.emit("drain");
    expect(response.chunks).toHaveLength(4);
    fanout.close();
  });

  it("flushes FIFO exactly once and stops when a drained write reports backpressure again", () => {
    const fanout = createFanout();
    const input = connectionInput("first", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    response.writeResult = false;
    fanout.publish(dashboardEvent);
    fanout.publish({ ...dashboardEvent, value: 43 });
    fanout.publish({ ...dashboardEvent, value: 44 });

    response.writeResults = [false];
    response.writeResult = true;
    response.emit("drain");
    expect(eventValues(response.chunks)).toEqual([42, 43]);
    response.emit("drain");
    expect(eventValues(response.chunks)).toEqual([42, 43, 44]);
    response.emit("drain");
    expect(eventValues(response.chunks)).toEqual([42, 43, 44]);
    fanout.close();
  });

  it("allows exact frame and UTF-8 byte boundaries and closes on the next frame", () => {
    const frame = formatDashboardEventFrame(dashboardEvent);
    for (const limits of [
      { maxBufferedFrames: 2, maxBufferedBytes: Buffer.byteLength(frame) * 10 },
      { maxBufferedFrames: 10, maxBufferedBytes: Buffer.byteLength(frame) * 2 },
    ]) {
      const fanout = createFanout(limits);
      const input = connectionInput("first", "ip4:192.0.2.1");
      const response = input.response as unknown as FakeResponse;
      fanout.connect(input);
      response.writeResult = false;
      fanout.publish(dashboardEvent);
      fanout.publish(dashboardEvent);
      fanout.publish(dashboardEvent);
      expect(fanout.clientCount()).toBe(1);
      fanout.publish(dashboardEvent);
      expect(fanout.clientCount()).toBe(0);
      expect(response.writableEnded).toBe(true);
    }
  });

  it("drops only an overflowing slow client while healthy clients continue", () => {
    let nextId = 0;
    const fanout = createFanout({
      maxBufferedFrames: 1,
      generateConnectionId: () => `connection-${++nextId}`,
    });
    const slow = connectionInput("slow", "ip4:192.0.2.1");
    const healthy = connectionInput("healthy", "ip4:192.0.2.2");
    fanout.connect(slow);
    fanout.connect(healthy);
    (slow.response as unknown as FakeResponse).writeResult = false;

    fanout.publish(dashboardEvent);
    fanout.publish({ ...dashboardEvent, value: 43 });
    fanout.publish({ ...dashboardEvent, value: 44 });

    expect(fanout.clientCount()).toBe(1);
    expect((slow.response as unknown as FakeResponse).writableEnded).toBe(true);
    expect(eventValues((healthy.response as unknown as FakeResponse).chunks)).toEqual([42, 43, 44]);
    fanout.close();
  });

  it.each([
    "request",
    "response",
    "write-throw",
    "overflow",
    "shutdown",
  ] as const)("cleans every listener idempotently after %s teardown and ignores late drain", (teardown) => {
    const fanout = createFanout({ maxBufferedFrames: 1 });
    const input = connectionInput("first", "ip4:192.0.2.1");
    const request = input.request as unknown as FakeRequest;
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    if (teardown === "request") request.emit("close");
    if (teardown === "response") response.emit("close");
    if (teardown === "write-throw") {
      response.throwOnWrite = true;
      fanout.publish(dashboardEvent);
    }
    if (teardown === "overflow") {
      response.writeResult = false;
      fanout.publish(dashboardEvent);
      fanout.publish(dashboardEvent);
      fanout.publish(dashboardEvent);
    }
    if (teardown === "shutdown") fanout.close();
    const chunksAfterClose = response.chunks.length;

    request.emit("close");
    response.emit("close");
    response.emit("drain");
    fanout.publish(dashboardEvent);

    expect(fanout.clientCount()).toBe(0);
    expect(request.listenerCount("close")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.chunks).toHaveLength(chunksAfterClose);
  });

  it("atomically distinguishes per-source and total capacity and frees slots once", () => {
    let id = 0;
    const fanout = createFanout({
      maxClients: 2,
      maxClientsPerSource: 1,
      generateConnectionId: () => `connection-${++id}`,
    });
    const first = connectionInput("first", "ip4:192.0.2.1");
    expect(fanout.connect(first)).toBe("connected");
    expect(fanout.connect(connectionInput("same", "ip4:192.0.2.1"))).toBe("source_capacity");
    expect(fanout.connect(connectionInput("other", "ip4:192.0.2.2"))).toBe("connected");
    expect(fanout.connect(connectionInput("total", "ip4:192.0.2.3"))).toBe("total_capacity");
    (first.request as unknown as FakeRequest).emit("close");
    (first.response as unknown as FakeResponse).emit("close");
    expect(fanout.connect(connectionInput("again", "ip4:192.0.2.1"))).toBe("connected");
    fanout.close();
  });

  it("reserves before a re-entrant accepted callback and cleans callback failure", () => {
    let id = 0;
    const fanout = createFanout({
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
  });

  it.each([
    "throw",
    "headers",
  ] as const)("frees opening capacity after initial %s and permits reconnect", (failure) => {
    const fanout = createFanout({ maxClients: 1, maxClientsPerSource: 1 });
    const input = connectionInput("failed", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    if (failure === "throw") response.throwOnWrite = true;
    else response.throwOnWriteHead = true;
    expect(fanout.connect(input)).toBe("connected");
    expect(fanout.clientCount()).toBe(0);
    expect(fanout.connect(connectionInput("later", "ip4:192.0.2.1"))).toBe("connected");
    fanout.close();
  });

  it("keeps an opening frame that reports backpressure and queues later frames", () => {
    const fanout = createFanout();
    const input = connectionInput("first", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    response.writeResult = false;
    fanout.connect(input);
    fanout.publish(dashboardEvent);
    expect(fanout.clientCount()).toBe(1);
    expect(response.chunks).toEqual(["retry: 3000\n: connected\n\n"]);
    response.writeResult = true;
    response.emit("drain");
    expect(response.chunks).toEqual([
      "retry: 3000\n: connected\n\n",
      formatDashboardEventFrame(dashboardEvent),
    ]);
    fanout.close();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid or zero queue bounds (%s)", (value) => {
    expect(() => createFanout({ maxBufferedFrames: value })).toThrow(/maxBufferedFrames/);
    expect(() => createFanout({ maxBufferedBytes: value })).toThrow(/maxBufferedBytes/);
  });
});

function createFanout(
  options: Omit<Partial<ConstructorParameters<typeof DashboardEventFanout>[0]>, "logger"> = {},
) {
  let nextId = 0;
  return new DashboardEventFanout({
    logger: createSilentLogger("api"),
    ...options,
    generateConnectionId: options.generateConnectionId ?? (() => `connection-${++nextId}`),
  });
}

function connectionInput(correlationId: string, sourceKey: string) {
  return {
    request: new FakeRequest() as IncomingMessage,
    response: new FakeResponse() as unknown as ServerResponse,
    correlationId,
    sourceKey,
  };
}

function eventValue(chunk: string): number | undefined {
  if (!chunk.startsWith("data: ")) return undefined;
  return (JSON.parse(chunk.slice("data: ".length)) as { value: number }).value;
}

function eventValues(chunks: string[]): number[] {
  return chunks.map(eventValue).filter((value): value is number => value !== undefined);
}
