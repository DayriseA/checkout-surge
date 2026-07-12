import {
  type InventoryStatus,
  inventoryStatusSchema,
  inventoryUpdatedEventPayloadSchema,
  uuidSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";

const inventoryEventHistoryLimit = 100;
const inventoryNamespaceScanBatchSize = 100;
export const reservationThroughputWindowSeconds = 60;
export const pendingPersistenceIndexKey = "inventory:pending-persistence-index";

export interface InventoryKeys {
  prefix: string;
  state: string;
  reservations: string;
  reservationExpirations: string;
  pendingPersistence: string;
  pendingPersistenceRecords: string;
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

export interface RunInventoryConfig {
  runId: string;
  status: RunSaleEligibility["status"];
}

export function runSaleEligibilityKey(runId: string): string {
  return `demo-run:${runId}:sale-eligibility`;
}

export async function setRunSaleEligibility(
  redis: CheckoutSurgeRedis,
  eligibility: RunSaleEligibility,
): Promise<void> {
  const runId = uuidSchema.parse(eligibility.runId);
  const saleOfferId = uuidSchema.parse(eligibility.saleOfferId);
  const keys = inventoryKeys(saleOfferId);
  const result = await redis.eval(
    setRunSaleEligibilityScript,
    2,
    keys.state,
    runSaleEligibilityKey(runId),
    runId,
    saleOfferId,
    eligibility.status,
    JSON.stringify({ ...eligibility, runId, saleOfferId }),
  );

  if (result === "inventory_not_initialized") {
    throw new InventoryNotInitializedError(saleOfferId);
  }
  if (result !== "updated") {
    throw new Error(`Could not update run sale eligibility: ${String(result)}.`);
  }
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
  run?: RunInventoryConfig;
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
    pendingPersistenceRecords: `${prefix}:pending-persistence-records`,
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

  const run = input.run
    ? {
        runId: uuidSchema.parse(input.run.runId),
        status: assertRunSaleStatus(input.run.status),
      }
    : undefined;

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

  const previousRunId = await redis.hget(keys.state, "runId");
  await deleteInventoryNamespace(redis, keys.prefix);
  if (previousRunId) {
    await redis.unlink(runSaleEligibilityKey(previousRunId));
  }

  const initialization = redis
    .multi()
    .hset(keys.state, {
      saleOfferId: input.saleOfferId,
      inventoryScope: run ? "generated_run" : "catalog",
      allocatedStock: input.allocatedStock.toString(),
      remainingStock: input.allocatedStock.toString(),
      reservedStock: "0",
      lastUpdatedAt: timestamp,
      ...(run ? { runId: run.runId, runSaleStatus: run.status } : {}),
    })
    .hset(keys.reservationOutcomes, "api_sold_out_decision", "0");

  if (run) {
    initialization.set(
      runSaleEligibilityKey(run.runId),
      JSON.stringify({ runId: run.runId, saleOfferId: input.saleOfferId, status: run.status }),
    );
  }

  await initialization
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

  const allocatedStock = parseStateInteger(state, "allocatedStock");
  const remainingStock = parseStateInteger(state, "remainingStock");
  const reservedStock = parseStateInteger(state, "reservedStock");

  if (remainingStock + reservedStock !== allocatedStock) {
    throw new Error("Inventory stock counters must sum to allocatedStock.");
  }

  return inventoryStatusSchema.parse({
    saleOfferId: stateSaleOfferId,
    allocatedStock,
    remainingStock,
    reservedStock,
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

const setRunSaleEligibilityScript = `
local stateType = redis.call("TYPE", KEYS[1]).ok
if stateType == "none" then
  return "inventory_not_initialized"
end
if stateType ~= "hash" then
  return redis.error_reply("Inventory state key must be a hash")
end
if redis.call("HGET", KEYS[1], "saleOfferId") ~= ARGV[2] then
  return redis.error_reply("Inventory state sale offer ID must match run eligibility")
end
if redis.call("HGET", KEYS[1], "inventoryScope") ~= "generated_run" then
  return redis.error_reply("Run eligibility can only be updated for generated-run inventory")
end
if redis.call("HGET", KEYS[1], "runId") ~= ARGV[1] then
  return redis.error_reply("Inventory run ID must match run eligibility")
end
if ARGV[3] ~= "accepting" and ARGV[3] ~= "closed" then
  return redis.error_reply("Run sale status must be accepting or closed")
end

redis.call("HSET", KEYS[1], "runSaleStatus", ARGV[3])
redis.call("SET", KEYS[2], ARGV[4])
return "updated"
`;

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

function assertRunSaleStatus(status: string): RunSaleEligibility["status"] {
  if (status !== "accepting" && status !== "closed") {
    throw new Error("Run inventory status must be accepting or closed.");
  }

  return status;
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
