import {
  correlationIdSchema,
  type DashboardProjectionScope,
  uuidSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

export const dashboardProjectionDirtyRedisChannel = "dashboard-projection-dirty" as const;

export interface DashboardProjectionDirtySignal {
  type: "dashboard.projection.dirty";
  correlationId?: string;
  scope?: DashboardProjectionScope;
}

export interface DashboardProjectionDirtySubscriberHandlers {
  onDirty(signal: DashboardProjectionDirtySignal): void | Promise<void>;
  onHandlerError?(error: unknown): void;
  onInvalidMessage?(error: unknown, message: string): void;
}

export interface RedisDashboardProjectionDirtySubscriber {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function serializeDashboardProjectionDirtySignal(
  signal: DashboardProjectionDirtySignal,
): string {
  return JSON.stringify(parseDashboardProjectionDirtyValue(signal));
}

export function parseDashboardProjectionDirtyMessage(
  message: string,
): DashboardProjectionDirtySignal {
  return parseDashboardProjectionDirtyValue(JSON.parse(message));
}

export async function publishDashboardProjectionDirtySignal(
  redis: CheckoutSurgeRedis,
  signal: DashboardProjectionDirtySignal,
): Promise<number> {
  return redis.publish(
    dashboardProjectionDirtyRedisChannel,
    serializeDashboardProjectionDirtySignal(signal),
  );
}

function parseDashboardProjectionDirtyValue(value: unknown): DashboardProjectionDirtySignal {
  if (!isRecordWithOnlyKeys(value, ["type", "correlationId", "scope"])) {
    throw new Error("Dashboard projection dirty signal must be a strict object.");
  }
  if (value.type !== "dashboard.projection.dirty") {
    throw new Error("Dashboard projection dirty signal type is invalid.");
  }
  const correlationId =
    value.correlationId === undefined ? undefined : correlationIdSchema.parse(value.correlationId);
  let scope: DashboardProjectionScope | undefined;
  if (value.scope !== undefined) {
    if (!isRecordWithOnlyKeys(value.scope, ["runId", "saleOfferId"])) {
      throw new Error("Dashboard projection dirty scope must be a strict object.");
    }
    scope = {
      runId: uuidSchema.parse(value.scope.runId),
      saleOfferId: uuidSchema.parse(value.scope.saleOfferId),
    };
  }
  return {
    type: "dashboard.projection.dirty",
    ...(correlationId ? { correlationId } : {}),
    ...(scope ? { scope } : {}),
  };
}

function isRecordWithOnlyKeys(
  value: unknown,
  allowedKeys: readonly string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

export function createRedisDashboardProjectionDirtySubscriber(
  redis: CheckoutSurgeRedis,
  handlers: DashboardProjectionDirtySubscriberHandlers,
): RedisDashboardProjectionDirtySubscriber {
  let isStarted = false;

  const handleMessage = (channel: string, message: string) => {
    if (channel !== dashboardProjectionDirtyRedisChannel) {
      return;
    }

    let signal: DashboardProjectionDirtySignal;
    try {
      signal = parseDashboardProjectionDirtyMessage(message);
    } catch (error) {
      handlers.onInvalidMessage?.(error, message);
      return;
    }

    void Promise.resolve(handlers.onDirty(signal)).catch((error: unknown) => {
      handlers.onHandlerError?.(error);
    });
  };

  return {
    async start() {
      if (isStarted) {
        return;
      }

      redis.on("message", handleMessage);

      try {
        await redis.subscribe(dashboardProjectionDirtyRedisChannel);
        isStarted = true;
      } catch (error) {
        redis.off("message", handleMessage);
        throw error;
      }
    },

    async close() {
      redis.off("message", handleMessage);

      if (!isStarted) {
        return;
      }

      isStarted = false;
      await redis.unsubscribe(dashboardProjectionDirtyRedisChannel);
    },
  };
}
