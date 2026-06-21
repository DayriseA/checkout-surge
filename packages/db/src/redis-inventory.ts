import {
  type InventoryStatus,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

const inventoryEventHistoryLimit = 100;
const inventoryNamespaceScanBatchSize = 100;
export const reservationThroughputWindowSeconds = 60;

export interface InventoryKeys {
  prefix: string;
  state: string;
  reservations: string;
  reservationExpirations: string;
  pendingPersistence: string;
  events: string;
  reservationOutcomes: string;
  reservationThroughput: string;
  idempotency: (idempotencyKey: string) => string;
}

export interface RunSaleEligibility {
  runId: string;
  saleOfferId: string;
  status: "accepting" | "closed";
}

export function runSaleEligibilityKey(runId: string): string {
  return `demo-run:${runId}:sale-eligibility`;
}

export async function setRunSaleEligibility(
  redis: CheckoutSurgeRedis,
  eligibility: RunSaleEligibility,
): Promise<void> {
  await redis.set(runSaleEligibilityKey(eligibility.runId), JSON.stringify(eligibility));
}

export async function isRunSaleEligible(
  redis: CheckoutSurgeRedis,
  input: { runId: string; saleOfferId: string },
): Promise<boolean> {
  const rawEligibility = await redis.get(runSaleEligibilityKey(input.runId));

  if (!rawEligibility) {
    return false;
  }

  const eligibility = parseRunSaleEligibility(rawEligibility);
  return (
    eligibility.runId === input.runId &&
    eligibility.saleOfferId === input.saleOfferId &&
    eligibility.status === "accepting"
  );
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
    reservationThroughput: `${prefix}:reservation-throughput`,
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
    reservationThroughput: buildReservationThroughput([], initializedAt),
    soldOutPressure: {
      rejectionCount: 0,
      latestObservedAt: null,
    },
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

  const throughputFields = buildThroughputFields();
  const [
    pendingPersistenceCount,
    oldestPending,
    expiredReservationCount,
    reservationOutcomeValues,
    throughputValues,
  ] = await Promise.all([
    redis.zcard(keys.pendingPersistence),
    redis.zrange(keys.pendingPersistence, 0, 0, "WITHSCORES"),
    redis.zcount(keys.reservationExpirations, "-inf", now.getTime()),
    redis.hmget(
      keys.reservationOutcomes,
      "api_sold_out_decision",
      "api_sold_out_decision_latest_observed_at",
    ),
    redis.hmget(keys.reservationThroughput, ...throughputFields),
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
    reservationThroughput: buildReservationThroughput(throughputValues, now),
    soldOutPressure: {
      rejectionCount: parseOptionalNonnegativeInteger(
        reservationOutcomeValues[0] ?? null,
        "api_sold_out_decision",
      ),
      latestObservedAt: reservationOutcomeValues[1] ?? null,
    },
    lastUpdatedAt: requireStateValue(state, "lastUpdatedAt"),
  });
}

function buildThroughputFields(): string[] {
  return Array.from({ length: reservationThroughputWindowSeconds }, (_, slot) => [
    `${slot}:second`,
    `${slot}:count`,
  ]).flat();
}

function buildReservationThroughput(values: Array<string | null>, measuredAt: Date) {
  const currentSecond = Math.floor(measuredAt.getTime() / 1000);
  const firstIncludedSecond = currentSecond - reservationThroughputWindowSeconds + 1;
  let successfulReservationCount = 0;

  for (let index = 0; index < values.length; index += 2) {
    const slot = index / 2;
    const parsedSlot = parseReservationThroughputSlot(
      values[index] ?? null,
      values[index + 1] ?? null,
      slot,
    );

    if (parsedSlot === null) {
      continue;
    }

    const { observedSecond, count } = parsedSlot;

    if (observedSecond >= firstIncludedSecond && observedSecond <= currentSecond) {
      successfulReservationCount += count;
      assertNonnegativeInteger(successfulReservationCount, "successfulReservationCount");
    }
  }

  return {
    windowSeconds: reservationThroughputWindowSeconds,
    successfulReservationCount,
    rate: successfulReservationCount / reservationThroughputWindowSeconds,
    unit: "reservations_per_second" as const,
    measuredAt: measuredAt.toISOString(),
  };
}

function parseReservationThroughputSlot(
  secondValue: string | null,
  countValue: string | null,
  slot: number,
): { observedSecond: number; count: number } | null {
  if (secondValue === null && countValue === null) {
    return null;
  }

  if (secondValue === null || countValue === null) {
    throw new Error(
      `Malformed reservation throughput state at slot ${slot}: second and count must both be present.`,
    );
  }

  const observedSecond = parseThroughputInteger(secondValue, slot, "second");
  const count = parseThroughputInteger(countValue, slot, "count");

  return { observedSecond, count };
}

function parseThroughputInteger(value: string, slot: number, field: "second" | "count"): number {
  const parsed = Number(value);

  if (value.trim().length === 0 || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      `Malformed reservation throughput state at slot ${slot}: ${field} must be a nonnegative safe integer.`,
    );
  }

  return parsed;
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

function parseOptionalNonnegativeInteger(value: string | null, field: string): number {
  if (value === null) {
    return 0;
  }

  const parsed = Number(value);
  assertNonnegativeInteger(parsed, field);
  return parsed;
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

function parseRunSaleEligibility(rawEligibility: string): RunSaleEligibility {
  const eligibility: unknown = JSON.parse(rawEligibility);

  if (
    typeof eligibility !== "object" ||
    eligibility === null ||
    !("runId" in eligibility) ||
    typeof eligibility.runId !== "string" ||
    !("saleOfferId" in eligibility) ||
    typeof eligibility.saleOfferId !== "string" ||
    !("status" in eligibility) ||
    (eligibility.status !== "accepting" && eligibility.status !== "closed")
  ) {
    throw new Error("Redis run sale eligibility record is invalid.");
  }

  return eligibility as RunSaleEligibility;
}
