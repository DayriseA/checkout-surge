import { Redis, type RedisOptions } from "ioredis";

export type CheckoutSurgeRedis = Redis;

export function createRedisClient(
  redisUrl: string,
  options: RedisOptions = {},
): CheckoutSurgeRedis {
  return new Redis(redisUrl, options);
}
