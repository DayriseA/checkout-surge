import {
  type DashboardEvent,
  dashboardEventSchema,
  dashboardEventsRedisChannel,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

export interface DashboardEventSubscriberHandlers {
  onEvent(event: DashboardEvent): void | Promise<void>;
  onHandlerError?(error: unknown): void;
  onInvalidMessage?(error: unknown, message: string): void;
}

export interface RedisDashboardEventSubscriber {
  start(): Promise<void>;
  close(): Promise<void>;
}

export function serializeDashboardEvent(event: DashboardEvent): string {
  return JSON.stringify(dashboardEventSchema.parse(event));
}

export function parseDashboardEventMessage(message: string): DashboardEvent {
  return dashboardEventSchema.parse(JSON.parse(message));
}

export async function publishDashboardEvent(
  redis: CheckoutSurgeRedis,
  event: DashboardEvent,
): Promise<number> {
  return redis.publish(dashboardEventsRedisChannel, serializeDashboardEvent(event));
}

export function createRedisDashboardEventSubscriber(
  redis: CheckoutSurgeRedis,
  handlers: DashboardEventSubscriberHandlers,
): RedisDashboardEventSubscriber {
  let isStarted = false;

  const handleMessage = (channel: string, message: string) => {
    if (channel !== dashboardEventsRedisChannel) {
      return;
    }

    let event: DashboardEvent;
    try {
      event = parseDashboardEventMessage(message);
    } catch (error) {
      handlers.onInvalidMessage?.(error, message);
      return;
    }

    void Promise.resolve(handlers.onEvent(event)).catch((error: unknown) => {
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
        await redis.subscribe(dashboardEventsRedisChannel);
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
      await redis.unsubscribe(dashboardEventsRedisChannel);
    },
  };
}
