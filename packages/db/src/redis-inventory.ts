import {
  type InventoryStatus,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

const inventoryEventHistoryLimit = 100;
const inventoryNamespaceScanBatchSize = 100;

export interface InventoryKeys {
  prefix: string;
  state: string;
  reservations: string;
  reservationExpirations: string;
  pendingPersistence: string;
  events: string;
  reservationOutcomes: string;
  idempotency: (idempotencyKey: string) => string;
}

export interface InitializeInventoryInput {
  saleOfferId: string;
  allocatedStock: number;
  source?: string;
  initializedAt?: Date;
}

export class InventoryNotInitializedError extends Error {
  readonly saleOfferId: string;

  constructor(saleOfferId: string) {
    super(`Inventory is not initialized for sale offer ${saleOfferId}.`);
    this.name = "InventoryNotInitializedError";
    this.saleOfferId = saleOfferId;
  }
}

export function inventoryKeys(saleOfferId: string): InventoryKeys {
  const prefix = `inventory:${saleOfferId}`;

  return {
    prefix,
    state: `${prefix}:state`,
    reservations: `${prefix}:reservations`,
    reservationExpirations: `${prefix}:reservation-expirations`,
    pendingPersistence: `${prefix}:pending-persistence`,
    events: `${prefix}:events`,
    reservationOutcomes: `${prefix}:reservation-outcomes`,
    idempotency: (idempotencyKey) => `${prefix}:idempotency:${idempotencyKey}`,
  };
}

export async function initializeInventory(
  redis: CheckoutSurgeRedis,
  input: InitializeInventoryInput,
): Promise<InventoryStatus> {
  assertNonnegativeInteger(input.allocatedStock, "allocatedStock");

  const keys = inventoryKeys(input.saleOfferId);
  const initializedAt = input.initializedAt ?? new Date();
  const timestamp = initializedAt.toISOString();
  const event = inventoryUpdatedEventPayloadSchema.parse({
    eventName: "inventory.updated",
    saleOfferId: input.saleOfferId,
    allocatedStock: input.allocatedStock,
    remainingStock: input.allocatedStock,
    reservedStock: 0,
    source: input.source ?? "initialization",
    occurredAt: timestamp,
  });

  await deleteInventoryNamespace(redis, keys.prefix);
  await redis
    .multi()
    .hset(keys.state, {
      saleOfferId: input.saleOfferId,
      allocatedStock: input.allocatedStock.toString(),
      remainingStock: input.allocatedStock.toString(),
      reservedStock: "0",
      lastUpdatedAt: timestamp,
    })
    .hset(keys.reservationOutcomes, "api_sold_out_decision", "0")
    .rpush(keys.events, JSON.stringify(event))
    .ltrim(keys.events, -inventoryEventHistoryLimit, -1)
    .exec();

  return inventoryStatusSchema.parse({
    saleOfferId: input.saleOfferId,
    allocatedStock: input.allocatedStock,
    remainingStock: input.allocatedStock,
    reservedStock: 0,
    pendingPersistenceCount: 0,
    expiredReservationCount: 0,
    oldestPendingPersistenceAgeSeconds: 0,
    lastUpdatedAt: timestamp,
  });
}

export async function getInventoryStatus(
  redis: CheckoutSurgeRedis,
  saleOfferId: string,
  now: Date = new Date(),
): Promise<InventoryStatus> {
  const keys = inventoryKeys(saleOfferId);
  const state = await redis.hgetall(keys.state);

  if (Object.keys(state).length === 0) {
    throw new InventoryNotInitializedError(saleOfferId);
  }

  const [pendingPersistenceCount, oldestPending, expiredReservationCount] = await Promise.all([
    redis.zcard(keys.pendingPersistence),
    redis.zrange(keys.pendingPersistence, 0, 0, "WITHSCORES"),
    redis.zcount(keys.reservationExpirations, "-inf", now.getTime()),
  ]);
  const stateSaleOfferId = requireStateValue(state, "saleOfferId");

  if (stateSaleOfferId !== saleOfferId) {
    throw new Error("Inventory state sale offer ID does not match its Redis namespace.");
  }

  return inventoryStatusSchema.parse({
    saleOfferId: stateSaleOfferId,
    allocatedStock: parseStateInteger(state, "allocatedStock"),
    remainingStock: parseStateInteger(state, "remainingStock"),
    reservedStock: parseStateInteger(state, "reservedStock"),
    pendingPersistenceCount,
    expiredReservationCount,
    oldestPendingPersistenceAgeSeconds: calculateOldestPendingAgeSeconds(oldestPending, now),
    lastUpdatedAt: requireStateValue(state, "lastUpdatedAt"),
  });
}

async function deleteInventoryNamespace(
  redis: CheckoutSurgeRedis,
  inventoryPrefix: string,
): Promise<void> {
  let cursor = "0";

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${inventoryPrefix}:*`,
      "COUNT",
      inventoryNamespaceScanBatchSize,
    );

    if (keys.length > 0) {
      await redis.unlink(...keys);
    }

    cursor = nextCursor;
  } while (cursor !== "0");
}

function calculateOldestPendingAgeSeconds(oldestPending: string[], now: Date): number {
  const oldestPendingTimestamp = oldestPending[1];

  if (oldestPendingTimestamp === undefined) {
    return 0;
  }

  const timestampMilliseconds = Number(oldestPendingTimestamp);
  if (!Number.isFinite(timestampMilliseconds)) {
    throw new Error("Inventory pending-persistence score must be a timestamp in milliseconds.");
  }

  return Math.max(0, (now.getTime() - timestampMilliseconds) / 1000);
}

function parseStateInteger(state: Record<string, string>, field: string): number {
  const value = Number(requireStateValue(state, field));
  assertNonnegativeInteger(value, field);
  return value;
}

function requireStateValue(state: Record<string, string>, field: string): string {
  const value = state[field];

  if (value === undefined) {
    throw new Error(`Inventory state is missing required field ${field}.`);
  }

  return value;
}

function assertNonnegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative safe integer.`);
  }
}
