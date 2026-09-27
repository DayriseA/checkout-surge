import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DashboardProjection, dashboardProjectionSchema } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { correlationIdHeaderName } from "@checkout-surge/logger";

export const defaultDashboardSseHeartbeatMs = 15_000;
export const defaultDashboardSseRetryMs = 3_000;
export const defaultDashboardSseMaxBufferedFrames = 32;
export const defaultDashboardSseMaxBufferedBytes = 256 * 1024;
export const defaultDashboardSseMaxBufferedProjectionScopes = 8;

export interface DashboardProjectionFanoutOptions {
  logger: CheckoutSurgeLogger;
  heartbeatMs?: number;
  retryMs?: number;
  generateConnectionId?: () => string;
  maxClients?: number;
  maxClientsPerSource?: number;
  maxBufferedFrames?: number;
  maxBufferedBytes?: number;
  maxBufferedProjectionScopes?: number;
}

export interface DashboardSseConnectionInput {
  request: IncomingMessage;
  response: ServerResponse;
  correlationId: string;
  sourceKey: string;
  onAccepted?: () => void;
}

export type DashboardSseAdmission = "connected" | "total_capacity" | "source_capacity";

interface DashboardSseClient {
  id: string;
  request: IncomingMessage;
  response: ServerResponse;
  close: () => void;
  drain: () => void;
  sourceKey: string;
  backpressured: boolean;
  bufferedFrames: BufferedDashboardFrame[];
  bufferedBytes: number;
}

type BufferedDashboardFrame =
  | { frame: string; bytes: number; kind: "fifo" }
  | { frame: string; bytes: number; kind: "projection"; scopeId: string };

export class DashboardProjectionFanout {
  private readonly clients = new Map<string, DashboardSseClient>();
  private readonly logger: CheckoutSurgeLogger;
  private readonly heartbeatMs: number;
  private readonly retryMs: number;
  private readonly generateConnectionId: () => string;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly sourceCounts = new Map<string, number>();
  private readonly maxClients: number;
  private readonly maxClientsPerSource: number;
  private readonly maxBufferedFrames: number;
  private readonly maxBufferedBytes: number;
  private readonly maxBufferedProjectionScopes: number;

  constructor(options: DashboardProjectionFanoutOptions) {
    this.logger = options.logger;
    this.heartbeatMs = options.heartbeatMs ?? defaultDashboardSseHeartbeatMs;
    this.retryMs = options.retryMs ?? defaultDashboardSseRetryMs;
    this.generateConnectionId = options.generateConnectionId ?? randomUUID;
    this.maxClients = options.maxClients ?? 80;
    this.maxClientsPerSource = options.maxClientsPerSource ?? 6;
    this.maxBufferedFrames = options.maxBufferedFrames ?? defaultDashboardSseMaxBufferedFrames;
    this.maxBufferedBytes = options.maxBufferedBytes ?? defaultDashboardSseMaxBufferedBytes;
    this.maxBufferedProjectionScopes =
      options.maxBufferedProjectionScopes ?? defaultDashboardSseMaxBufferedProjectionScopes;
  }

  connect(input: DashboardSseConnectionInput): DashboardSseAdmission {
    if (this.clients.size >= this.maxClients) {
      this.logger.warn(
        { outcome: "total_capacity", activeDashboardConnections: this.clients.size },
        "Dashboard SSE rejected.",
      );
      return "total_capacity";
    }
    const sourceCount = this.sourceCounts.get(input.sourceKey) ?? 0;
    if (sourceCount >= this.maxClientsPerSource) {
      this.logger.warn(
        { outcome: "source_capacity", activeDashboardConnections: this.clients.size },
        "Dashboard SSE rejected.",
      );
      return "source_capacity";
    }
    let client!: DashboardSseClient;
    const close = () => this.closeClient(client, "client_closed");
    const drain = () => this.flushClient(client);
    client = {
      id: this.generateConnectionId(),
      request: input.request,
      response: input.response,
      close,
      drain,
      sourceKey: input.sourceKey,
      backpressured: false,
      bufferedFrames: [],
      bufferedBytes: 0,
    };

    this.clients.set(client.id, client);
    this.sourceCounts.set(input.sourceKey, sourceCount + 1);

    input.onAccepted?.();

    try {
      input.response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        [correlationIdHeaderName]: input.correlationId,
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Dashboard SSE opening headers failed.");
      this.closeClient(client, "opening_headers_failed");
      return "connected";
    }
    input.request.once("close", client.close);
    input.response.once("close", client.close);
    input.response.on("drain", client.drain);
    this.ensureHeartbeat();

    this.sendFrame(client, `retry: ${this.retryMs}\n: connected\n\n`, "initial_write_failed");
    this.logger.debug(
      { outcome: "accepted", activeDashboardConnections: this.clients.size },
      "Dashboard SSE admitted.",
    );
    return "connected";
  }

  publish(projection: DashboardProjection): void {
    const parsed = dashboardProjectionSchema.parse(projection);
    const payload = formatDashboardProjectionFrame(parsed);

    for (const client of [...this.clients.values()]) {
      this.sendFrame(client, payload, "projection_write_failed", parsed.scopeId);
    }
  }

  close(): void {
    for (const client of [...this.clients.values()]) {
      this.closeClient(client, "server_shutdown");
    }
    this.stopHeartbeat();
  }

  clientCount(): number {
    return this.clients.size;
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.clients.size === 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      const frame = `: heartbeat ${new Date().toISOString()}\n\n`;

      for (const client of [...this.clients.values()]) {
        this.sendFrame(client, frame, "heartbeat_write_failed");
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendFrame(
    client: DashboardSseClient,
    frame: string,
    failureReason: string,
    projectionScopeId?: string,
  ): void {
    if (this.clients.get(client.id) !== client) {
      return;
    }

    if (client.backpressured) {
      this.enqueueFrame(client, frame, projectionScopeId);
      return;
    }

    try {
      if (!client.response.write(frame)) {
        // Node accepted this frame before reporting that its writable buffer is full.
        client.backpressured = true;
      }
    } catch (error) {
      this.logger.warn(
        { err: error, dashboardConnectionId: client.id },
        "Dashboard SSE write failed.",
      );
      this.closeClient(client, failureReason);
    }
  }

  private enqueueFrame(
    client: DashboardSseClient,
    frame: string,
    projectionScopeId?: string,
  ): void {
    const frameBytes = Buffer.byteLength(frame, "utf8");
    if (projectionScopeId !== undefined) {
      const replaceableIndex = client.bufferedFrames.findIndex(
        (pending) => pending.kind === "projection" && pending.scopeId === projectionScopeId,
      );
      if (replaceableIndex >= 0) {
        const replaced = client.bufferedFrames[replaceableIndex];
        if (!replaced) return;
        const nextBufferedBytes = client.bufferedBytes - replaced.bytes + frameBytes;
        if (nextBufferedBytes > this.maxBufferedBytes) {
          this.closeClient(client, "buffer_overflow");
          return;
        }
        client.bufferedFrames[replaceableIndex] = {
          kind: "projection",
          scopeId: projectionScopeId,
          frame,
          bytes: frameBytes,
        };
        client.bufferedBytes = nextBufferedBytes;
        return;
      }
    }

    const pendingProjectionScopeCount = client.bufferedFrames.reduce(
      (count, pending) => count + (pending.kind === "projection" ? 1 : 0),
      0,
    );
    if (
      client.bufferedFrames.length >= this.maxBufferedFrames ||
      (projectionScopeId !== undefined &&
        pendingProjectionScopeCount >= this.maxBufferedProjectionScopes) ||
      frameBytes > this.maxBufferedBytes - client.bufferedBytes
    ) {
      this.closeClient(client, "buffer_overflow");
      return;
    }

    client.bufferedFrames.push(
      projectionScopeId === undefined
        ? { kind: "fifo", frame, bytes: frameBytes }
        : {
            kind: "projection",
            scopeId: projectionScopeId,
            frame,
            bytes: frameBytes,
          },
    );
    client.bufferedBytes += frameBytes;
  }

  private flushClient(client: DashboardSseClient): void {
    if (this.clients.get(client.id) !== client || !client.backpressured) {
      return;
    }

    client.backpressured = false;
    while (client.bufferedFrames.length > 0) {
      const pending = client.bufferedFrames.shift();
      if (pending === undefined) {
        return;
      }
      client.bufferedBytes -= pending.bytes;
      this.sendFrame(
        client,
        pending.frame,
        "drain_write_failed",
        pending.kind === "projection" ? pending.scopeId : undefined,
      );
      if (client.backpressured || this.clients.get(client.id) !== client) {
        return;
      }
    }
  }

  private closeClient(client: DashboardSseClient, reason: string): void {
    if (!this.clients.delete(client.id)) {
      return;
    }
    const sourceCount = this.sourceCounts.get(client.sourceKey) ?? 0;
    if (sourceCount <= 1) this.sourceCounts.delete(client.sourceKey);
    else this.sourceCounts.set(client.sourceKey, sourceCount - 1);

    client.request.off("close", client.close);
    client.response.off("close", client.close);
    client.response.off("drain", client.drain);
    client.bufferedFrames.length = 0;
    client.bufferedBytes = 0;
    client.backpressured = false;

    if (!client.response.destroyed && !client.response.writableEnded) {
      client.response.end();
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }

    this.logger.debug({ dashboardConnectionId: client.id, reason }, "Dashboard SSE closed.");
  }
}

export function formatDashboardProjectionFrame(projection: DashboardProjection): string {
  return `data: ${JSON.stringify(dashboardProjectionSchema.parse(projection))}\n\n`;
}
