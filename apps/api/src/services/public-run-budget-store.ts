import { randomUUID } from "node:crypto";
import type { PublicRuntimePolicy } from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "@checkout-surge/db";

const reserveScript = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 'collision' end
local globalCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local visitorCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if visitorCount >= tonumber(ARGV[2]) then return 'visitor' end
if globalCount >= tonumber(ARGV[1]) then return 'global' end
redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[3], 'NX')
redis.call('INCR', KEYS[2]); redis.call('EXPIRE', KEYS[2], ARGV[3], 'NX')
redis.call('SET', KEYS[3], '1', 'EX', ARGV[3], 'NX')
return 'allowed'
`;

const releaseScript = `
if redis.call('DEL', KEYS[3]) == 0 then return 0 end
for index = 1, 2 do
  local count = tonumber(redis.call('GET', KEYS[index]) or '0')
  if count <= 1 then redis.call('DEL', KEYS[index]) else redis.call('DECR', KEYS[index]) end
end
return 1
`;

export interface PublicRunBudgetReservation {
  reservationId: string;
  globalKey: string;
  visitorKey: string;
  reservationKey: string;
}

export interface PublicRunBudgetStore {
  reserve(input: {
    policy: PublicRuntimePolicy;
    publicVisitorId: string;
    now: Date;
  }): Promise<PublicRunBudgetDecision>;
  release(reservation: PublicRunBudgetReservation): Promise<void>;
}

export type PublicRunBudgetDecision =
  | { outcome: "allowed"; reservation: PublicRunBudgetReservation }
  | { outcome: "denied"; reason: "visitor" | "global" };

export class RedisPublicRunBudgetStore implements PublicRunBudgetStore {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  async reserve(input: {
    policy: PublicRuntimePolicy;
    publicVisitorId: string;
    now: Date;
  }): Promise<PublicRunBudgetDecision> {
    const window = Math.floor(
      input.now.getTime() / (input.policy.publicRunBudget.windowSeconds * 1000),
    );
    const hashTag = `{${window}}`;
    const globalKey = `demo-run:public-budget:${hashTag}:global`;
    const visitorKey = `demo-run:public-budget:${hashTag}:visitor:${input.publicVisitorId}`;
    const ttlSeconds = input.policy.publicRunBudget.windowSeconds * 2;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reservationId = randomUUID();
      const reservationKey = `demo-run:public-budget:${hashTag}:reservation:${reservationId}`;
      const result = await this.redis.eval(
        reserveScript,
        3,
        globalKey,
        visitorKey,
        reservationKey,
        input.policy.publicRunBudget.globalMaxStarts,
        input.policy.publicRunBudget.perVisitorMaxStarts,
        ttlSeconds,
      );
      if (result === "allowed")
        return {
          outcome: "allowed",
          reservation: { reservationId, globalKey, visitorKey, reservationKey },
        };
      if (result === "visitor" || result === "global") return { outcome: "denied", reason: result };
      if (result !== "collision") throw new Error("Redis public run budget reservation failed.");
    }
    throw new Error("Could not allocate a unique public run budget reservation ID.");
  }

  async release(reservation: PublicRunBudgetReservation): Promise<void> {
    await this.redis.eval(
      releaseScript,
      3,
      reservation.globalKey,
      reservation.visitorKey,
      reservation.reservationKey,
    );
  }
}
