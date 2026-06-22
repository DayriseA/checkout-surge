import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type DashboardEvent, dashboardEventSchema } from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { correlationIdHeaderName } from "@checkout-surge/logger";

export const defaultDashboardSseHeartbeatMs = 15_000;
export const defaultDashboardSseRetryMs = 3_000;

export interface DashboardEventFanoutOptions {
  logger: CheckoutSurgeLogger;
  heartbeatMs?: number;
  retryMs?: number;
  generateConnectionId?: () => string;
}

export interface DashboardSseConnectionInput {
  request: IncomingMessage;
  response: ServerResponse;
  correlationId: string;
}

interface DashboardSseClient {
  id: string;
  request: IncomingMessage;
  response: ServerResponse;
  close: () => void;
}

export class DashboardEventFanout {
  private readonly clients = new Map<string, DashboardSseClient>();
  private readonly logger: CheckoutSurgeLogger;
  private readonly heartbeatMs: number;
  private readonly retryMs: number;
  private readonly generateConnectionId: () => string;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: DashboardEventFanoutOptions) {
    this.logger = options.logger;
    this.heartbeatMs = options.heartbeatMs ?? defaultDashboardSseHeartbeatMs;
    this.retryMs = options.retryMs ?? defaultDashboardSseRetryMs;
    this.generateConnectionId = options.generateConnectionId ?? randomUUID;
  }

  connect(input: DashboardSseConnectionInput): void {
    let client!: DashboardSseClient;
    const close = () => this.closeClient(client, "client_closed");
    client = {
      id: this.generateConnectionId(),
      request: input.request,
      response: input.response,
      close,
    };

    input.response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      [correlationIdHeaderName]: input.correlationId,
    });
    input.request.once("close", client.close);
    input.response.once("close", client.close);
    this.clients.set(client.id, client);
    this.ensureHeartbeat();

    if (!this.writeFrame(client, `retry: ${this.retryMs}\n: connected\n\n`)) {
      this.closeClient(client, "initial_backpressure");
    }
  }

  publish(event: DashboardEvent): void {
    const payload = formatDashboardEventFrame(event);

    for (const client of [...this.clients.values()]) {
      if (!this.writeFrame(client, payload)) {
        this.closeClient(client, "event_backpressure");
      }
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
        if (!this.writeFrame(client, frame)) {
          this.closeClient(client, "heartbeat_backpressure");
        }
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

  private writeFrame(client: DashboardSseClient, frame: string): boolean {
    try {
      return client.response.write(frame);
    } catch (error) {
      this.logger.warn(
        { err: error, dashboardConnectionId: client.id },
        "Dashboard SSE write failed.",
      );
      return false;
    }
  }

  private closeClient(client: DashboardSseClient, reason: string): void {
    if (!this.clients.delete(client.id)) {
      return;
    }

    client.request.off("close", client.close);
    client.response.off("close", client.close);

    if (!client.response.destroyed && !client.response.writableEnded) {
      client.response.end();
    }

    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }

    this.logger.debug({ dashboardConnectionId: client.id, reason }, "Dashboard SSE closed.");
  }
}

export function formatDashboardEventFrame(event: DashboardEvent): string {
  return `data: ${JSON.stringify(dashboardEventSchema.parse(event))}\n\n`;
}
