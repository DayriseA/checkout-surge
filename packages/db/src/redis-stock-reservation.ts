import {
  idempotencyKeySchema,
  positiveIntegerSchema,
  type SecuredReservationHold,
  type StockReservationDecision,
  securedReservationHoldSchema,
  stockReservationDecisionSchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "./redis.js";
import { inventoryKeys } from "./redis-inventory.js";

const inventoryEventHistoryLimit = 100;

const reserveInventoryScript = `
local quantity = tonumber(ARGV[1])
if not quantity or quantity <= 0 or quantity ~= math.floor(quantity) or quantity > 9007199254740991 then
  return cjson.encode({ outcome = "quantity_invalid", reservation = cjson.null })
end

local existingIdempotencyJson = redis.call("GET", KEYS[6])
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

if redis.call("EXISTS", KEYS[1]) == 0 then
  return cjson.encode({ outcome = "inventory_not_initialized", reservation = cjson.null })
end

local remainingStock = tonumber(redis.call("HGET", KEYS[1], "remainingStock"))
if not remainingStock or remainingStock < 0 or remainingStock ~= math.floor(remainingStock) then
  return redis.error_reply("Inventory remainingStock must be a nonnegative integer")
end

if quantity > remainingStock then
  redis.call("HINCRBY", KEYS[5], "api_sold_out_decision", 1)
  redis.call("HSET", KEYS[5], "api_sold_out_decision_latest_observed_at", ARGV[4])
  return cjson.encode({ outcome = "sold_out", reservation = cjson.null })
end

local reservation = cjson.decode(ARGV[2])
local newRemainingStock = redis.call("HINCRBY", KEYS[1], "remainingStock", -quantity)
local newReservedStock = redis.call("HINCRBY", KEYS[1], "reservedStock", quantity)
redis.call("HSET", KEYS[1], "lastUpdatedAt", ARGV[4])
redis.call("HSET", KEYS[2], reservation.id, ARGV[2])
redis.call("ZADD", KEYS[3], ARGV[3], reservation.id)

local allocatedStock = tonumber(redis.call("HGET", KEYS[1], "allocatedStock"))
local inventoryEvent = {
  eventName = "inventory.updated",
  saleOfferId = reservation.saleOfferId,
  allocatedStock = allocatedStock,
  remainingStock = newRemainingStock,
  reservedStock = newReservedStock,
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
redis.call("SET", KEYS[6], cjson.encode(preDurableIdempotencyRecord), "EX", ARGV[6])

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
    6,
    keys.state,
    keys.reservations,
    keys.reservationExpirations,
    keys.events,
    keys.reservationOutcomes,
    keys.idempotency(idempotencyKey),
    reservation.quantity.toString(),
    JSON.stringify(reservation),
    new Date(reservation.expiresAt).getTime().toString(),
    reservation.securedAt,
    "reservation",
    idempotencyTtlSeconds.toString(),
    inventoryEventHistoryLimit.toString(),
  );

  if (typeof rawDecision !== "string") {
    throw new Error("Redis returned an invalid stock reservation decision.");
  }

  return stockReservationDecisionSchema.parse(JSON.parse(rawDecision));
}

function assertValidHoldWindow(reservation: SecuredReservationHold): void {
  if (new Date(reservation.expiresAt).getTime() <= new Date(reservation.securedAt).getTime()) {
    throw new Error("Reservation expiresAt must be later than securedAt.");
  }
}
