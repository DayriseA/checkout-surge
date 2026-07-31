import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DashboardProjection, demoRunSnapshotSchema } from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DashboardProjectionFanout,
  formatDashboardProjectionFrame,
} from "../src/realtime/dashboard-projection-fanout.js";
import { acceptedRunConfigSnapshotFixture } from "./demo-administration-test-fixtures.js";

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

describe("dashboard projection fan-out", () => {
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

    fanout.publish(projection(1));
    vi.advanceTimersByTime(10);
    fanout.publish(projection(2));
    expect(response.chunks).toEqual([
      "retry: 3000\n: connected\n\n",
      formatDashboardProjectionFrame(projection(1)),
    ]);

    response.writeResult = true;
    response.emit("drain");
    expect(response.chunks).toEqual([
      "retry: 3000\n: connected\n\n",
      formatDashboardProjectionFrame(projection(1)),
      ": heartbeat 2026-07-16T12:00:00.010Z\n\n",
      formatDashboardProjectionFrame(projection(2)),
    ]);
    response.emit("drain");
    expect(response.chunks).toHaveLength(4);
    fanout.close();
  });

  it("flushes the newest same-scope projection once after repeated backpressure", () => {
    const fanout = createFanout();
    const input = connectionInput("first", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    response.writeResult = false;
    fanout.publish(projection(1));
    fanout.publish(projection(2));
    fanout.publish(projection(3));

    response.writeResults = [false];
    response.writeResult = true;
    response.emit("drain");
    expect(projectionRevisions(response.chunks)).toEqual([1, 3]);
    response.emit("drain");
    expect(projectionRevisions(response.chunks)).toEqual([1, 3]);
    response.emit("drain");
    expect(projectionRevisions(response.chunks)).toEqual([1, 3]);
    fanout.close();
  });

  it("allows exact frame and UTF-8 byte boundaries and closes on the next frame", () => {
    const firstScoped = scopedProjection(
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
    );
    const secondScoped = scopedProjection(
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    );
    const thirdScoped = scopedProjection(
      "99999999-9999-4999-8999-999999999999",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const exactBufferedBytes =
      Buffer.byteLength(formatDashboardProjectionFrame(firstScoped)) +
      Buffer.byteLength(formatDashboardProjectionFrame(secondScoped));
    for (const limits of [
      { maxBufferedFrames: 2, maxBufferedBytes: exactBufferedBytes * 10 },
      { maxBufferedFrames: 10, maxBufferedBytes: exactBufferedBytes },
    ]) {
      const fanout = createFanout(limits);
      const input = connectionInput("first", "ip4:192.0.2.1");
      const response = input.response as unknown as FakeResponse;
      fanout.connect(input);
      response.writeResult = false;
      fanout.publish(projection(1));
      fanout.publish(firstScoped);
      fanout.publish(secondScoped);
      expect(fanout.clientCount()).toBe(1);
      fanout.publish(thirdScoped);
      expect(fanout.clientCount()).toBe(0);
      expect(response.writableEnded).toBe(true);
    }
  });

  it("bounds an overflowing slow client and lets its reconnect start from current delivery", () => {
    let nextId = 0;
    const fanout = createFanout({
      maxBufferedFrames: 10,
      maxBufferedProjectionScopes: 2,
      generateConnectionId: () => `connection-${++nextId}`,
    });
    const slow = connectionInput("slow", "ip4:192.0.2.1");
    const healthy = connectionInput("healthy", "ip4:192.0.2.2");
    fanout.connect(slow);
    fanout.connect(healthy);
    (slow.response as unknown as FakeResponse).writeResult = false;

    fanout.publish(projection(1));
    fanout.publish(projection(2));
    fanout.publish(
      scopedProjection(
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
      ),
    );

    expect(fanout.clientCount()).toBe(2);
    expect((slow.response as unknown as FakeResponse).writableEnded).toBe(false);
    fanout.publish(
      scopedProjection(
        "77777777-7777-4777-8777-777777777777",
        "88888888-8888-4888-8888-888888888888",
      ),
    );
    expect(fanout.clientCount()).toBe(1);
    expect((slow.response as unknown as FakeResponse).writableEnded).toBe(true);
    expect(projectionRevisions((healthy.response as unknown as FakeResponse).chunks)).toEqual([
      1, 2, 1, 1,
    ]);

    const reconnected = connectionInput("slow-reconnected", "ip4:192.0.2.1");
    expect(fanout.connect(reconnected)).toBe("connected");
    fanout.publish(projection(4));
    expect(projectionRevisions((reconnected.response as unknown as FakeResponse).chunks)).toEqual([
      4,
    ]);
    fanout.close();
  });

  it("keeps only the newest pending replaceable projection for a slow client scope", () => {
    const fanout = createFanout({
      maxBufferedFrames: 1,
      maxBufferedProjectionScopes: 1,
    });
    const input = connectionInput("slow", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    response.writeResult = false;

    fanout.publish(projection(1));
    fanout.publish(projection(2));
    fanout.publish(projection(3));

    expect(fanout.clientCount()).toBe(1);
    expect(projectionRevisions(response.chunks)).toEqual([1]);
    response.writeResult = true;
    response.emit("drain");
    expect(projectionRevisions(response.chunks)).toEqual([1, 3]);
    fanout.close();
  });

  it("disconnects only the slow client when pending projection scopes exceed capacity", () => {
    const fanout = createFanout({
      maxBufferedFrames: 10,
      maxBufferedProjectionScopes: 1,
    });
    const input = connectionInput("slow", "ip4:192.0.2.1");
    const response = input.response as unknown as FakeResponse;
    fanout.connect(input);
    response.writeResult = false;

    fanout.publish(projection(1));
    fanout.publish(projection(2));
    fanout.publish(
      scopedProjection(
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
      ),
    );

    expect(fanout.clientCount()).toBe(0);
    expect(response.writableEnded).toBe(true);
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
      fanout.publish(projection(1));
    }
    if (teardown === "overflow") {
      response.writeResult = false;
      fanout.publish(projection(1));
      fanout.publish(projection(2));
      fanout.publish(
        scopedProjection(
          "55555555-5555-4555-8555-555555555555",
          "66666666-6666-4666-8666-666666666666",
        ),
      );
    }
    if (teardown === "shutdown") fanout.close();
    const chunksAfterClose = response.chunks.length;

    request.emit("close");
    response.emit("close");
    response.emit("drain");
    fanout.publish(projection(2));

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
    fanout.publish(projection(2));
    expect(fanout.clientCount()).toBe(1);
    expect(response.chunks).toEqual(["retry: 3000\n: connected\n\n"]);
    response.writeResult = true;
    response.emit("drain");
    expect(response.chunks).toEqual([
      "retry: 3000\n: connected\n\n",
      formatDashboardProjectionFrame(projection(2)),
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
    expect(() => createFanout({ maxBufferedProjectionScopes: value })).toThrow(
      /maxBufferedProjectionScopes/,
    );
  });

  it("formats projection frames through the exact public schema", () => {
    const frame = formatDashboardProjectionFrame(projection(7));
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(frame.slice("data: ".length))).toEqual(projection(7));
  });
});

function createFanout(
  options: Omit<Partial<ConstructorParameters<typeof DashboardProjectionFanout>[0]>, "logger"> = {},
) {
  let nextId = 0;
  return new DashboardProjectionFanout({
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

function projectionRevisions(chunks: string[]): number[] {
  return chunks.flatMap((chunk) => {
    if (!chunk.startsWith("data: ")) return [];
    const payload = JSON.parse(chunk.slice("data: ".length)) as {
      schema?: string;
      revision?: number;
    };
    return payload.schema === "checkout-surge.dashboard-projection" &&
      payload.revision !== undefined
      ? [payload.revision]
      : [];
  });
}

function projection(revision: number): DashboardProjection {
  return {
    schema: "checkout-surge.dashboard-projection",
    version: 1,
    correlationId: `projection-${revision}`,
    scopeId: "idle",
    revision,
    scope: null,
    recoveredAt: "2026-07-23T12:00:00.000Z",
    currentRun: null,
    inventory: null,
    recentMetrics: [],
    queue: null,
    erp: null,
    businessOutcome: null,
    consistencyLag: null,
    recentCompletionOutcomes: [],
    transportAttemptCounts: null,
    httpSummary: null,
    requestArrivalSummary: null,
    runSignalTimelineSummary: null,
  };
}

function scopedProjection(runId: string, saleOfferId: string): DashboardProjection {
  const currentRun = demoRunSnapshotSchema.parse({
    runId,
    presetId: "77777777-7777-4777-8777-777777777777",
    presetName: "Preview 1k",
    operatorMode: "public",
    status: "active",
    trafficStatus: "active",
    saleOfferId,
    configSnapshot: acceptedRunConfigSnapshotFixture(),
    startedAt: "2026-07-23T11:59:00.000Z",
    trafficStartedAt: "2026-07-23T11:59:01.000Z",
  });
  return {
    ...projection(1),
    scopeId: `run/${runId}/sale-offer/${saleOfferId}`,
    scope: { runId, saleOfferId },
    currentRun,
  };
}
