import {
  idempotencyKeySchema,
  positiveIntegerSchema,
  type SecuredReservationHold,
  type StockReservationDecision,
  securedReservationHoldSchema,
  stockReservationDecisionSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";
import {
  inventoryKeys,
  pendingPersistenceIndexKey,
  reservationThroughputWindowSeconds,
} from "./redis-inventory.js";

const inventoryEventHistoryLimit = 100;

const markPendingPersistenceScript = `
local pendingType = redis.call("TYPE", KEYS[3]).ok
if pendingType ~= "none" and pendingType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence key must be a sorted set")
end
local recordsType = redis.call("TYPE", KEYS[4]).ok
if recordsType ~= "none" and recordsType ~= "hash" then
  return redis.error_reply("Inventory pending-persistence records key must be a hash")
end
local indexType = redis.call("TYPE", KEYS[5]).ok
if indexType ~= "none" and indexType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence index key must be a sorted set")
end
local idempotencyJson = redis.call("GET", KEYS[1])
if not idempotencyJson then
  return "missing"
end
if redis.call("PTTL", KEYS[1]) <= 0 then
  return redis.error_reply("Inventory idempotency record must have a positive TTL")
end
local record = cjson.decode(idempotencyJson)
if record.status ~= "pending_persistence" then
  return "invalid_status"
end
if record.quantity ~= tonumber(ARGV[2])
  or record.reservation.id ~= ARGV[1]
  or record.reservation.saleOfferId ~= ARGV[3]
  or record.reservation.reservationToken ~= ARGV[4]
  or record.reservation.correlationId ~= ARGV[5]
  or (record.reservation.runId or "") ~= ARGV[6]
  or record.reservation.securedAt ~= ARGV[7]
  or record.reservation.expiresAt ~= ARGV[8] then
  return "mismatch"
end
if not redis.call("HGET", KEYS[2], ARGV[1]) then
  return "missing_hold"
end
redis.call("ZADD", KEYS[3], ARGV[9], ARGV[1])
local pendingRecord = {
  id = ARGV[1],
  saleOfferId = ARGV[3],
  correlationId = ARGV[5],
  runId = (ARGV[6] ~= "" and ARGV[6] or cjson.null),
  idempotencyKey = ARGV[10],
  quantity = tonumber(ARGV[2]),
  reservationToken = ARGV[4],
  securedAt = ARGV[7],
  expiresAt = ARGV[8]
}
redis.call("HSET", KEYS[4], ARGV[1], cjson.encode(pendingRecord))
redis.call("ZADD", KEYS[5], ARGV[9], ARGV[3] .. ":" .. ARGV[1])
return "marked"
`;

const promoteAcceptedScript = `
local pendingType = redis.call("TYPE", KEYS[2]).ok
if pendingType ~= "none" and pendingType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence key must be a sorted set")
end
local recordsType = redis.call("TYPE", KEYS[3]).ok
if recordsType ~= "none" and recordsType ~= "hash" then
  return redis.error_reply("Inventory pending-persistence records key must be a hash")
end
local indexType = redis.call("TYPE", KEYS[4]).ok
if indexType ~= "none" and indexType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence index key must be a sorted set")
end
local idempotencyJson = redis.call("GET", KEYS[1])
if not idempotencyJson then
  return "missing"
end
if redis.call("PTTL", KEYS[1]) <= 0 then
  return redis.error_reply("Inventory idempotency record must have a positive TTL")
end
local record = cjson.decode(idempotencyJson)
if record.quantity ~= tonumber(ARGV[2])
  or record.reservation.id ~= ARGV[1]
  or record.reservation.saleOfferId ~= ARGV[3]
  or record.reservation.reservationToken ~= ARGV[4]
  or record.reservation.correlationId ~= ARGV[5]
  or (record.reservation.runId or "") ~= ARGV[6]
  or record.reservation.securedAt ~= ARGV[7]
  or record.reservation.expiresAt ~= ARGV[8] then
  return "mismatch"
end
if record.status == "accepted" then
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("HDEL", KEYS[3], ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[3] .. ":" .. ARGV[1])
  return "already_accepted"
end
if record.status ~= "pending_persistence" then
  return "invalid_status"
end
record.status = "accepted"
redis.call("SET", KEYS[1], cjson.encode(record), "KEEPTTL")
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[3] .. ":" .. ARGV[1])
return "promoted"
`;

const reverseReservationScript = `
local maximumSafeInteger = 9007199254740991
local function assertOptionalKeyType(key, expectedType, label)
  local actualType = redis.call("TYPE", key).ok
  if actualType ~= "none" and actualType ~= expectedType then
    error(label .. " key must be a " .. expectedType)
  end
end
assertOptionalKeyType(KEYS[1], "hash", "Inventory state")
assertOptionalKeyType(KEYS[2], "hash", "Inventory reservations")
assertOptionalKeyType(KEYS[3], "zset", "Inventory reservation-expirations")
assertOptionalKeyType(KEYS[4], "list", "Inventory events")
assertOptionalKeyType(KEYS[5], "zset", "Inventory pending-persistence")
assertOptionalKeyType(KEYS[6], "hash", "Inventory pending-persistence records")
assertOptionalKeyType(KEYS[7], "string", "Inventory idempotency")
assertOptionalKeyType(KEYS[8], "zset", "Inventory pending-persistence index")

local rawHold = redis.call("HGET", KEYS[2], ARGV[1])
local rawIdempotency = redis.call("GET", KEYS[7])
if rawIdempotency and redis.call("PTTL", KEYS[7]) <= 0 then
  return redis.error_reply("Inventory idempotency record must have a positive TTL")
end
local rawPendingRecord = redis.call("HGET", KEYS[6], ARGV[1])
if rawHold and not rawPendingRecord then
  return "mismatch"
end
if rawPendingRecord then
  local pendingRecord = cjson.decode(rawPendingRecord)
  local pendingRunId = pendingRecord.runId
  if pendingRunId == cjson.null then
    pendingRunId = ""
  end
  if pendingRecord.id ~= ARGV[1] or pendingRecord.saleOfferId ~= ARGV[3]
    or pendingRecord.correlationId ~= ARGV[5] or pendingRunId ~= ARGV[6]
    or pendingRecord.idempotencyKey ~= ARGV[11]
    or pendingRecord.quantity ~= tonumber(ARGV[2])
    or pendingRecord.reservationToken ~= ARGV[4]
    or pendingRecord.securedAt ~= ARGV[7] or pendingRecord.expiresAt ~= ARGV[8] then
    return "mismatch"
  end
end
if rawIdempotency then
  local idempotency = cjson.decode(rawIdempotency)
  if idempotency.status ~= "pending_persistence"
    or idempotency.quantity ~= tonumber(ARGV[2])
    or not idempotency.reservation
    or idempotency.reservation.id ~= ARGV[1]
    or idempotency.reservation.saleOfferId ~= ARGV[3]
    or idempotency.reservation.correlationId ~= ARGV[5]
    or (idempotency.reservation.runId or "") ~= ARGV[6]
    or idempotency.reservation.reservationToken ~= ARGV[4]
    or idempotency.reservation.securedAt ~= ARGV[7]
    or idempotency.reservation.expiresAt ~= ARGV[8] then
    return "mismatch"
  end
end
if not rawHold then
  redis.call("ZREM", KEYS[5], ARGV[1])
  redis.call("HDEL", KEYS[6], ARGV[1])
  redis.call("ZREM", KEYS[8], ARGV[3] .. ":" .. ARGV[1])
  if rawIdempotency then
    local idempotency = cjson.decode(rawIdempotency)
    if idempotency.reservation and idempotency.reservation.id == ARGV[1] then
      redis.call("DEL", KEYS[7])
    end
  end
  return "not_held"
end
local hold = cjson.decode(rawHold)
if hold.id ~= ARGV[1] or hold.saleOfferId ~= ARGV[3]
  or hold.reservationToken ~= ARGV[4] or hold.quantity ~= tonumber(ARGV[2])
  or hold.correlationId ~= ARGV[5] or (hold.runId or "") ~= ARGV[6]
  or hold.securedAt ~= ARGV[7] or hold.expiresAt ~= ARGV[8] then
  return "mismatch"
end
local rawState = redis.call("HGETALL", KEYS[1])
if #rawState == 0 then
  return "inventory_not_initialized"
end
local allocatedStock = tonumber(redis.call("HGET", KEYS[1], "allocatedStock"))
local remainingStock = tonumber(redis.call("HGET", KEYS[1], "remainingStock"))
local reservedStock = tonumber(redis.call("HGET", KEYS[1], "reservedStock"))
local quantity = tonumber(ARGV[2])
if not allocatedStock or not remainingStock or not reservedStock
  or allocatedStock < 0 or allocatedStock > maximumSafeInteger
  or remainingStock < 0 or reservedStock < quantity
  or remainingStock + reservedStock ~= allocatedStock then
  return redis.error_reply("Inventory stock counters are invalid")
end
redis.call("HINCRBY", KEYS[1], "remainingStock", quantity)
redis.call("HINCRBY", KEYS[1], "reservedStock", -quantity)
redis.call("HSET", KEYS[1], "lastUpdatedAt", ARGV[9])
redis.call("HDEL", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[5], ARGV[1])
redis.call("HDEL", KEYS[6], ARGV[1])
redis.call("ZREM", KEYS[8], ARGV[3] .. ":" .. ARGV[1])
if rawIdempotency then
  local idempotency = cjson.decode(rawIdempotency)
  if idempotency.reservation and idempotency.reservation.id == ARGV[1] then
    redis.call("DEL", KEYS[7])
  end
end
local event = {
  eventName = "inventory.updated",
  saleOfferId = ARGV[3],
  allocatedStock = allocatedStock,
  remainingStock = remainingStock + quantity,
  reservedStock = reservedStock - quantity,
  source = "reservation-reversal",
  occurredAt = ARGV[9]
}
redis.call("RPUSH", KEYS[4], cjson.encode(event))
redis.call("LTRIM", KEYS[4], -tonumber(ARGV[10]), -1)
return "reversed"
`;

const reserveInventoryScript = `
local maximumSafeInteger = 9007199254740991

local function assertOptionalKeyType(key, expectedType, label)
  local actualType = redis.call("TYPE", key).ok
  if actualType ~= "none" and actualType ~= expectedType then
    error(label .. " key must be a " .. expectedType)
  end
end

local function parseNonnegativeInteger(value, label)
  if type(value) ~= "string" or not string.match(value, "^%d+$") then
    error(label .. " must be a nonnegative safe integer")
  end
  local parsed = tonumber(value)
  if not parsed or parsed < 0 or parsed ~= math.floor(parsed) or parsed > maximumSafeInteger then
    error(label .. " must be a nonnegative safe integer")
  end
  return parsed
end

local quantity = tonumber(ARGV[1])
if not quantity or quantity <= 0 or quantity ~= math.floor(quantity) or quantity > maximumSafeInteger then
  return cjson.encode({ outcome = "quantity_invalid", reservation = cjson.null })
end

local stateType = redis.call("TYPE", KEYS[1]).ok
if stateType == "none" then
  return cjson.encode({ outcome = "inventory_not_initialized", reservation = cjson.null })
end
if stateType ~= "hash" then
  return redis.error_reply("Inventory state key must be a hash")
end

local reservation = cjson.decode(ARGV[2])
if redis.call("HGET", KEYS[1], "saleOfferId") ~= reservation.saleOfferId then
  return redis.error_reply("Inventory state sale offer ID must match the reservation")
end
local inventoryScope = redis.call("HGET", KEYS[1], "inventoryScope") or "catalog"
if inventoryScope == "catalog" then
  if reservation.runId then
    return cjson.encode({ outcome = "run_not_accepting_traffic", reservation = cjson.null })
  end
elseif inventoryScope == "generated_run" then
  local inventoryRunId = redis.call("HGET", KEYS[1], "runId")
  local runSaleStatus = redis.call("HGET", KEYS[1], "runSaleStatus")
  if not reservation.runId
    or reservation.runId ~= inventoryRunId
    or runSaleStatus ~= "accepting" then
    return cjson.encode({ outcome = "run_not_accepting_traffic", reservation = cjson.null })
  end
else
  return redis.error_reply("Inventory scope must be catalog or generated_run")
end

-- Eligibility precedes idempotency replay so closure always fails closed, including retries.
local existingIdempotencyJson = redis.call("GET", KEYS[9])
if existingIdempotencyJson then
  local existingIdempotency = cjson.decode(existingIdempotencyJson)
  if existingIdempotency.quantity ~= quantity then
    return cjson.encode({ outcome = "idempotency_conflict", reservation = cjson.null })
  end

  local replayOutcome
  if existingIdempotency.status == "pending_persistence" then
    replayOutcome = "reservation_pending_persistence"
  elseif existingIdempotency.status == "accepted" then
    replayOutcome = "idempotent_replay"
  else
    return redis.error_reply("Inventory idempotency record has an unsupported status")
  end

  return cjson.encode({ outcome = replayOutcome, reservation = existingIdempotency.reservation })
end

assertOptionalKeyType(KEYS[2], "hash", "Inventory reservations")
assertOptionalKeyType(KEYS[3], "zset", "Inventory reservation-expirations")
assertOptionalKeyType(KEYS[4], "list", "Inventory events")
assertOptionalKeyType(KEYS[5], "hash", "Inventory reservation-outcomes")
assertOptionalKeyType(KEYS[6], "hash", "Inventory reservation-throughput")
assertOptionalKeyType(KEYS[7], "zset", "Inventory pending-persistence")
assertOptionalKeyType(KEYS[8], "hash", "Inventory pending-persistence records")
assertOptionalKeyType(KEYS[9], "string", "Inventory idempotency")
assertOptionalKeyType(KEYS[10], "zset", "Inventory pending-persistence index")

if redis.call("HGET", KEYS[2], reservation.id)
  or redis.call("ZSCORE", KEYS[3], reservation.id)
  or redis.call("ZSCORE", KEYS[7], reservation.id) then
  return redis.error_reply("Inventory reservation ID must not already exist")
end

local allocatedStock = parseNonnegativeInteger(
  redis.call("HGET", KEYS[1], "allocatedStock"),
  "Inventory allocatedStock"
)
local remainingStock = parseNonnegativeInteger(
  redis.call("HGET", KEYS[1], "remainingStock"),
  "Inventory remainingStock"
)
local reservedStock = parseNonnegativeInteger(
  redis.call("HGET", KEYS[1], "reservedStock"),
  "Inventory reservedStock"
)
if remainingStock + reservedStock ~= allocatedStock then
  return redis.error_reply("Inventory stock counters must sum to allocatedStock")
end

local soldOutCount = parseNonnegativeInteger(
  redis.call("HGET", KEYS[5], "api_sold_out_decision"),
  "Inventory api_sold_out_decision"
)

local expirationScore = tonumber(ARGV[3])
local throughputMilliseconds = tonumber(ARGV[8])
local eventHistoryLimit = tonumber(ARGV[7])
local throughputWindowSeconds = tonumber(ARGV[9])
if not expirationScore or not throughputMilliseconds then
  return redis.error_reply("Inventory reservation timestamps must be numeric")
end
if not eventHistoryLimit or eventHistoryLimit <= 0 or eventHistoryLimit ~= math.floor(eventHistoryLimit) then
  return redis.error_reply("Inventory event history limit must be a positive integer")
end
if not throughputWindowSeconds or throughputWindowSeconds <= 0
  or throughputWindowSeconds ~= math.floor(throughputWindowSeconds) then
  return redis.error_reply("Inventory throughput window must be a positive integer")
end

local throughputSecond = math.floor(throughputMilliseconds / 1000)
local throughputSlot = tostring(throughputSecond % throughputWindowSeconds)
local throughputSecondField = throughputSlot .. ":second"
local throughputCountField = throughputSlot .. ":count"
local existingThroughputSecondValue = redis.call("HGET", KEYS[6], throughputSecondField)
local existingThroughputCountValue = redis.call("HGET", KEYS[6], throughputCountField)
if (existingThroughputSecondValue and not existingThroughputCountValue)
  or (not existingThroughputSecondValue and existingThroughputCountValue) then
  return redis.error_reply("Inventory throughput slot must contain both second and count")
end
local existingThroughputSecond = nil
local existingThroughputCount = nil
if existingThroughputSecondValue then
  existingThroughputSecond = parseNonnegativeInteger(
    existingThroughputSecondValue,
    "Inventory throughput second"
  )
  existingThroughputCount = parseNonnegativeInteger(
    existingThroughputCountValue,
    "Inventory throughput count"
  )
end
if existingThroughputSecond == throughputSecond
  and existingThroughputCount >= maximumSafeInteger then
  return redis.error_reply("Inventory throughput count cannot exceed the safe integer limit")
end

if quantity > remainingStock then
  if soldOutCount >= maximumSafeInteger then
    return redis.error_reply("Inventory api_sold_out_decision cannot exceed the safe integer limit")
  end
  redis.call("HINCRBY", KEYS[5], "api_sold_out_decision", 1)
  redis.call("HSET", KEYS[5], "api_sold_out_decision_latest_observed_at", ARGV[4])
  return cjson.encode({ outcome = "sold_out", reservation = cjson.null })
end

local newRemainingStock = redis.call("HINCRBY", KEYS[1], "remainingStock", -quantity)
local newReservedStock = redis.call("HINCRBY", KEYS[1], "reservedStock", quantity)
redis.call("HSET", KEYS[1], "lastUpdatedAt", ARGV[4])
redis.call("HSET", KEYS[2], reservation.id, ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[3], reservation.id)
redis.call("ZADD", KEYS[7], ARGV[8], reservation.id)
local pendingRecord = {
  id = reservation.id,
  saleOfferId = reservation.saleOfferId,
  correlationId = reservation.correlationId,
  runId = (reservation.runId or cjson.null),
  idempotencyKey = ARGV[10],
  quantity = quantity,
  reservationToken = reservation.reservationToken,
  securedAt = reservation.securedAt,
  expiresAt = reservation.expiresAt
}
redis.call("HSET", KEYS[8], reservation.id, cjson.encode(pendingRecord))
redis.call("ZADD", KEYS[10], ARGV[8], reservation.saleOfferId .. ":" .. reservation.id)

if existingThroughputSecond == throughputSecond then
  redis.call("HINCRBY", KEYS[6], throughputCountField, 1)
else
  redis.call("HSET", KEYS[6], throughputSecondField, throughputSecond, throughputCountField, 1)
end

local inventoryEvent = {
  eventName = "inventory.updated",
  saleOfferId = reservation.saleOfferId,
  allocatedStock = allocatedStock,
  remainingStock = newRemainingStock,
  reservedStock = newReservedStock,
  reservationCount = 1,
  reservedQuantity = quantity,
  source = ARGV[5],
  occurredAt = ARGV[4]
}
redis.call("RPUSH", KEYS[4], cjson.encode(inventoryEvent))
redis.call("LTRIM", KEYS[4], -tonumber(ARGV[7]), -1)

-- Securing the Redis hold precedes durable PostgreSQL persistence. Task 3.3 promotes this
-- record to "accepted" only after the reservation and order have been persisted.
local preDurableIdempotencyRecord = {
  status = "pending_persistence",
  quantity = quantity,
  reservation = reservation
}
redis.call("SET", KEYS[9], cjson.encode(preDurableIdempotencyRecord), "EX", ARGV[6])

return cjson.encode({ outcome = "reservation_secured", reservation = reservation })
`;

export interface ReserveInventoryStockInput {
  idempotencyKey: string;
  idempotencyTtlSeconds: number;
  reservation: SecuredReservationHold;
}

export async function reserveInventoryStock(
  redis: CheckoutSurgeRedis,
  input: ReserveInventoryStockInput,
): Promise<StockReservationDecision> {
  if (!positiveIntegerSchema.safeParse(input.reservation.quantity).success) {
    return stockReservationDecisionSchema.parse({
      outcome: "quantity_invalid",
      reservation: null,
    });
  }

  const reservation = securedReservationHoldSchema.parse(input.reservation);
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const idempotencyTtlSeconds = positiveIntegerSchema.parse(input.idempotencyTtlSeconds);
  assertValidHoldWindow(reservation);

  const keys = inventoryKeys(reservation.saleOfferId);
  const rawDecision = await redis.eval(
    reserveInventoryScript,
    10,
    keys.state,
    keys.reservations,
    keys.reservationExpirations,
    keys.events,
    keys.reservationOutcomes,
    keys.reservationThroughput,
    keys.pendingPersistence,
    keys.pendingPersistenceRecords,
    keys.idempotency(idempotencyKey),
    pendingPersistenceIndexKey,
    reservation.quantity.toString(),
    JSON.stringify(reservation),
    new Date(reservation.expiresAt).getTime().toString(),
    reservation.securedAt,
    "reservation",
    idempotencyTtlSeconds.toString(),
    inventoryEventHistoryLimit.toString(),
    new Date(reservation.securedAt).getTime().toString(),
    reservationThroughputWindowSeconds.toString(),
    idempotencyKey,
  );

  if (typeof rawDecision !== "string") {
    throw new Error("Redis returned an invalid stock reservation decision.");
  }

  return stockReservationDecisionSchema.parse(JSON.parse(rawDecision));
}

export type AcceptedPromotionResult = "promoted" | "already_accepted";

export async function markReservationPendingPersistence(
  redis: CheckoutSurgeRedis,
  input: { idempotencyKey: string; reservation: SecuredReservationHold },
): Promise<void> {
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const reservation = securedReservationHoldSchema.parse(input.reservation);
  const keys = inventoryKeys(reservation.saleOfferId);
  const result = await redis.eval(
    markPendingPersistenceScript,
    5,
    keys.idempotency(idempotencyKey),
    keys.reservations,
    keys.pendingPersistence,
    keys.pendingPersistenceRecords,
    pendingPersistenceIndexKey,
    reservation.id,
    reservation.quantity.toString(),
    reservation.saleOfferId,
    reservation.reservationToken,
    reservation.correlationId,
    reservation.runId ?? "",
    reservation.securedAt,
    reservation.expiresAt,
    new Date(reservation.securedAt).getTime().toString(),
    idempotencyKey,
  );

  if (result !== "marked") {
    throw new Error(`Could not mark reservation pending persistence: ${String(result)}.`);
  }
}

export async function promoteReservationIdempotencyToAccepted(
  redis: CheckoutSurgeRedis,
  input: { idempotencyKey: string; reservation: SecuredReservationHold },
): Promise<AcceptedPromotionResult> {
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const reservation = securedReservationHoldSchema.parse(input.reservation);
  const keys = inventoryKeys(reservation.saleOfferId);
  const result = await redis.eval(
    promoteAcceptedScript,
    4,
    keys.idempotency(idempotencyKey),
    keys.pendingPersistence,
    keys.pendingPersistenceRecords,
    pendingPersistenceIndexKey,
    reservation.id,
    reservation.quantity.toString(),
    reservation.saleOfferId,
    reservation.reservationToken,
    reservation.correlationId,
    reservation.runId ?? "",
    reservation.securedAt,
    reservation.expiresAt,
  );

  if (result !== "promoted" && result !== "already_accepted") {
    throw new Error(`Could not promote reservation idempotency: ${String(result)}.`);
  }

  return result;
}

export interface PendingPersistenceRecord {
  id: string;
  saleOfferId: string;
  correlationId: string;
  runId?: string;
  idempotencyKey: string;
  quantity: number;
  reservationToken: string;
  securedAt: string;
  expiresAt: string;
}

export async function readPendingPersistenceRecords(
  redis: CheckoutSurgeRedis,
  input: { saleOfferId: string; limit?: number },
): Promise<PendingPersistenceRecord[]> {
  const keys = inventoryKeys(input.saleOfferId);
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const ids = await redis.zrange(keys.pendingPersistence, 0, limit - 1);
  if (ids.length === 0) {
    return [];
  }

  const [records, holds] = await Promise.all([
    Promise.all(ids.map((id) => redis.hget(keys.pendingPersistenceRecords, id))),
    Promise.all(ids.map((id) => redis.hget(keys.reservations, id))),
  ]);
  const result: PendingPersistenceRecord[] = [];
  for (let index = 0; index < ids.length; index += 1) {
    const raw = records[index];
    const rawHold = holds[index];
    if (!raw || !rawHold) {
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PendingPersistenceRecord>;
      const hold = securedReservationHoldSchema.parse(JSON.parse(rawHold));
      if (
        typeof parsed.id !== "string" ||
        typeof parsed.saleOfferId !== "string" ||
        typeof parsed.correlationId !== "string" ||
        typeof parsed.idempotencyKey !== "string" ||
        typeof parsed.quantity !== "number" ||
        typeof parsed.reservationToken !== "string" ||
        typeof parsed.securedAt !== "string" ||
        typeof parsed.expiresAt !== "string"
      ) {
        continue;
      }
      if (
        hold.id !== parsed.id ||
        hold.saleOfferId !== parsed.saleOfferId ||
        hold.quantity !== parsed.quantity ||
        hold.reservationToken !== parsed.reservationToken ||
        hold.correlationId !== parsed.correlationId ||
        (hold.runId ?? "") !== (parsed.runId ?? "") ||
        hold.securedAt !== parsed.securedAt ||
        hold.expiresAt !== parsed.expiresAt
      ) {
        continue;
      }
      result.push({
        id: parsed.id,
        saleOfferId: parsed.saleOfferId,
        correlationId: parsed.correlationId,
        ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
        idempotencyKey: parsed.idempotencyKey,
        quantity: parsed.quantity,
        reservationToken: parsed.reservationToken,
        securedAt: parsed.securedAt,
        expiresAt: parsed.expiresAt,
      });
    } catch {
      // A malformed companion record must not hide all other pending holds.
    }
  }

  return result;
}

export type ReservationReversalResult = "reversed" | "not_held";

const deferPendingPersistenceIndexMemberScript = `
local indexType = redis.call("TYPE", KEYS[1]).ok
if indexType ~= "none" and indexType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence index key must be a sorted set")
end
local pendingType = redis.call("TYPE", KEYS[2]).ok
if pendingType ~= "none" and pendingType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence key must be a sorted set")
end
if redis.call("ZSCORE", KEYS[2], ARGV[1]) then
  redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
  return "deferred"
end
redis.call("ZREM", KEYS[1], ARGV[3])
return "removed"
`;

export async function deferPendingPersistenceIndexMember(
  redis: CheckoutSurgeRedis,
  input: { saleOfferId: string; reservationId: string; now?: Date },
): Promise<"deferred" | "removed"> {
  const keys = inventoryKeys(input.saleOfferId);
  const result = await redis.eval(
    deferPendingPersistenceIndexMemberScript,
    2,
    pendingPersistenceIndexKey,
    keys.pendingPersistence,
    input.reservationId,
    (input.now ?? new Date()).getTime().toString(),
    `${input.saleOfferId}:${input.reservationId}`,
  );
  if (result !== "deferred" && result !== "removed") {
    throw new Error(`Could not defer pending persistence index member: ${String(result)}.`);
  }
  return result;
}

export async function reverseReservation(
  redis: CheckoutSurgeRedis,
  input: { idempotencyKey: string; reservation: SecuredReservationHold; occurredAt?: Date },
): Promise<ReservationReversalResult> {
  const idempotencyKey = idempotencyKeySchema.parse(input.idempotencyKey);
  const reservation = securedReservationHoldSchema.parse(input.reservation);
  const keys = inventoryKeys(reservation.saleOfferId);
  const result = await redis.eval(
    reverseReservationScript,
    8,
    keys.state,
    keys.reservations,
    keys.reservationExpirations,
    keys.events,
    keys.pendingPersistence,
    keys.pendingPersistenceRecords,
    keys.idempotency(idempotencyKey),
    pendingPersistenceIndexKey,
    reservation.id,
    reservation.quantity.toString(),
    reservation.saleOfferId,
    reservation.reservationToken,
    reservation.correlationId,
    reservation.runId ?? "",
    reservation.securedAt,
    reservation.expiresAt,
    (input.occurredAt ?? new Date()).toISOString(),
    inventoryEventHistoryLimit.toString(),
    idempotencyKey,
  );

  if (result === "reversed" || result === "not_held") {
    return result;
  }
  if (result === "mismatch") {
    throw new Error("Could not reverse reservation: reservation hold mismatch.");
  }
  throw new Error(`Could not reverse reservation: ${String(result)}.`);
}

function assertValidHoldWindow(reservation: SecuredReservationHold): void {
  if (new Date(reservation.expiresAt).getTime() <= new Date(reservation.securedAt).getTime()) {
    throw new Error("Reservation expiresAt must be later than securedAt.");
  }
}
