import {
  idempotencyKeySchema,
  positiveIntegerSchema,
  type SecuredReservationHold,
  type StockReservationDecision,
  securedReservationHoldSchema,
  stockReservationDecisionSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";
import { inventoryKeys, reservationThroughputWindowSeconds } from "./redis-inventory.js";

const inventoryEventHistoryLimit = 100;

const markPendingPersistenceScript = `
local pendingType = redis.call("TYPE", KEYS[3]).ok
if pendingType ~= "none" and pendingType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence key must be a sorted set")
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
return "marked"
`;

const promoteAcceptedScript = `
local pendingType = redis.call("TYPE", KEYS[2]).ok
if pendingType ~= "none" and pendingType ~= "zset" then
  return redis.error_reply("Inventory pending-persistence key must be a sorted set")
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
  return "already_accepted"
end
if record.status ~= "pending_persistence" then
  return "invalid_status"
end
record.status = "accepted"
redis.call("SET", KEYS[1], cjson.encode(record), "KEEPTTL")
redis.call("ZREM", KEYS[2], ARGV[1])
return "promoted"
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

local existingIdempotencyJson = redis.call("GET", KEYS[8])
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

local stateType = redis.call("TYPE", KEYS[1]).ok
if stateType == "none" then
  return cjson.encode({ outcome = "inventory_not_initialized", reservation = cjson.null })
end
if stateType ~= "hash" then
  return redis.error_reply("Inventory state key must be a hash")
end

assertOptionalKeyType(KEYS[2], "hash", "Inventory reservations")
assertOptionalKeyType(KEYS[3], "zset", "Inventory reservation-expirations")
assertOptionalKeyType(KEYS[4], "list", "Inventory events")
assertOptionalKeyType(KEYS[5], "hash", "Inventory reservation-outcomes")
assertOptionalKeyType(KEYS[6], "hash", "Inventory reservation-throughput")
assertOptionalKeyType(KEYS[7], "zset", "Inventory pending-persistence")

local reservation = cjson.decode(ARGV[2])
if redis.call("HGET", KEYS[1], "saleOfferId") ~= reservation.saleOfferId then
  return redis.error_reply("Inventory state sale offer ID must match the reservation")
end
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
redis.call("SET", KEYS[8], cjson.encode(preDurableIdempotencyRecord), "EX", ARGV[6])

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
    8,
    keys.state,
    keys.reservations,
    keys.reservationExpirations,
    keys.events,
    keys.reservationOutcomes,
    keys.reservationThroughput,
    keys.pendingPersistence,
    keys.idempotency(idempotencyKey),
    reservation.quantity.toString(),
    JSON.stringify(reservation),
    new Date(reservation.expiresAt).getTime().toString(),
    reservation.securedAt,
    "reservation",
    idempotencyTtlSeconds.toString(),
    inventoryEventHistoryLimit.toString(),
    new Date(reservation.securedAt).getTime().toString(),
    reservationThroughputWindowSeconds.toString(),
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
    3,
    keys.idempotency(idempotencyKey),
    keys.reservations,
    keys.pendingPersistence,
    reservation.id,
    reservation.quantity.toString(),
    reservation.saleOfferId,
    reservation.reservationToken,
    reservation.correlationId,
    reservation.runId ?? "",
    reservation.securedAt,
    reservation.expiresAt,
    new Date(reservation.securedAt).getTime().toString(),
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
    2,
    keys.idempotency(idempotencyKey),
    keys.pendingPersistence,
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

function assertValidHoldWindow(reservation: SecuredReservationHold): void {
  if (new Date(reservation.expiresAt).getTime() <= new Date(reservation.securedAt).getTime()) {
    throw new Error("Reservation expiresAt must be later than securedAt.");
  }
}
