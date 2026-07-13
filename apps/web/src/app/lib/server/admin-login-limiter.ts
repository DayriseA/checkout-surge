import { createHash, timingSafeEqual } from "node:crypto";
import type Redis from "ioredis";

export interface LoginRatePolicy {
  clientCapacity: number;
  globalCapacity: number;
  refillWindowMs: number;
}

export type LoginAdmission =
  | { outcome: "admitted" }
  | { outcome: "limited"; retryAfterSeconds: number }
  | { outcome: "unavailable" };

export interface AdminLoginAttemptStore {
  admit(clientDigest: string, nowMs: number, policy: LoginRatePolicy): Promise<LoginAdmission>;
}

export class AdminLoginAttemptLimiter {
  constructor(
    private readonly store: AdminLoginAttemptStore,
    private readonly policy: LoginRatePolicy,
    private readonly now: () => number = Date.now,
  ) {}

  async admit(clientIdentity: string, nowMs = this.now()): Promise<LoginAdmission> {
    try {
      return await this.store.admit(hashIdentity(clientIdentity), nowMs, this.policy);
    } catch {
      return { outcome: "unavailable" };
    }
  }
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class MemoryAdminLoginAttemptStore implements AdminLoginAttemptStore {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxClientBuckets = 1_024) {
    if (!Number.isSafeInteger(maxClientBuckets) || maxClientBuckets <= 0) {
      throw new Error("maxClientBuckets must be a positive integer");
    }
  }

  get clientBucketCount(): number {
    return [...this.buckets.keys()].filter((key) => key.startsWith("client:")).length;
  }

  async admit(
    clientDigest: string,
    nowMs: number,
    policy: LoginRatePolicy,
  ): Promise<LoginAdmission> {
    const clientKey = `client:${clientDigest}`;
    this.pruneClientBuckets(clientKey, nowMs, policy.refillWindowMs * 2);
    const client = this.refill(clientKey, nowMs, policy.clientCapacity, policy.refillWindowMs);
    const global = this.refill("global", nowMs, policy.globalCapacity, policy.refillWindowMs);
    const clientWait = retryAfter(client, policy.clientCapacity, policy.refillWindowMs);
    const globalWait = retryAfter(global, policy.globalCapacity, policy.refillWindowMs);
    if (client.tokens < 1 || global.tokens < 1) {
      return { outcome: "limited", retryAfterSeconds: Math.max(clientWait, globalWait) };
    }
    client.tokens -= 1;
    global.tokens -= 1;
    return { outcome: "admitted" };
  }

  private refill(key: string, nowMs: number, capacity: number, windowMs: number): Bucket {
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: nowMs };
    const refillRate = capacity / windowMs;
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + Math.max(0, nowMs - bucket.updatedAt) * refillRate,
    );
    bucket.updatedAt = nowMs;
    this.buckets.set(key, bucket);
    return bucket;
  }

  private pruneClientBuckets(currentKey: string, nowMs: number, staleAfterMs: number): void {
    for (const [key, bucket] of this.buckets) {
      if (key.startsWith("client:") && nowMs - bucket.updatedAt >= staleAfterMs) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.has(currentKey) || this.clientBucketCount < this.maxClientBuckets) return;

    const oldest = [...this.buckets.entries()]
      .filter(([key]) => key.startsWith("client:"))
      .sort(([leftKey, left], [rightKey, right]) =>
        left.updatedAt === right.updatedAt
          ? leftKey.localeCompare(rightKey)
          : left.updatedAt - right.updatedAt,
      )[0];
    if (oldest) this.buckets.delete(oldest[0]);
  }
}

const redisAdmissionScript = `
local function take(key, capacity, window, now)
  local value = redis.call('HMGET', key, 'tokens', 'updated')
  local tokens = tonumber(value[1]) or capacity
  local updated = tonumber(value[2]) or now
  tokens = math.min(capacity, tokens + math.max(0, now-updated) * capacity/window)
  local wait = 0
  if tokens < 1 then wait = math.ceil((1-tokens) * window/capacity) end
  return {tokens, wait}
end
local client = take(KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[3]), tonumber(ARGV[4]))
local global = take(KEYS[2], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]))
local ttl = tonumber(ARGV[3]) * 2
local admitted = 0
if client[1] >= 1 and global[1] >= 1 then
  admitted = 1
  client[1] = client[1] - 1
  global[1] = global[1] - 1
end
redis.call('HSET', KEYS[1], 'tokens', client[1], 'updated', ARGV[4])
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('HSET', KEYS[2], 'tokens', global[1], 'updated', ARGV[4])
redis.call('PEXPIRE', KEYS[2], ttl)
return {admitted, math.max(client[2], global[2])}`;

export class RedisAdminLoginAttemptStore implements AdminLoginAttemptStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "web:admin-login:",
  ) {}

  async admit(
    clientDigest: string,
    nowMs: number,
    policy: LoginRatePolicy,
  ): Promise<LoginAdmission> {
    if (!/^[0-9a-f]{64}$/.test(clientDigest)) throw new Error("Invalid client digest");
    const keyPrefix = `${this.prefix}{admin-login}:`;
    const result = await this.redis.eval(
      redisAdmissionScript,
      2,
      `${keyPrefix}client:${clientDigest}`,
      `${keyPrefix}global`,
      policy.clientCapacity,
      policy.globalCapacity,
      policy.refillWindowMs,
      nowMs,
    );
    if (!Array.isArray(result) || result.length !== 2)
      throw new Error("Invalid Redis limiter result");
    const admitted = result[0];
    const retryMs = result[1];
    if (
      typeof admitted !== "number" ||
      (admitted !== 0 && admitted !== 1) ||
      typeof retryMs !== "number" ||
      !Number.isFinite(retryMs) ||
      retryMs < 0
    ) {
      throw new Error("Invalid Redis limiter result");
    }
    return admitted === 1
      ? { outcome: "admitted" }
      : { outcome: "limited", retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
}

export function resolveTrustedAdminClient(request: Request, attestationSecret?: string): string {
  const identity = request.headers.get("x-checkout-surge-client-id");
  const attestation = request.headers.get("x-checkout-surge-client-attestation");
  if (!identity || !attestation || !attestationSecret) return "unknown";
  const boundedIdentity = identity.trim();
  if (!boundedIdentity || boundedIdentity.length > 256) return "unknown";
  return constantEqual(attestation, attestationSecret) ? boundedIdentity : "unknown";
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function constantEqual(left: string, right: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
}
function retryAfter(bucket: Bucket, capacity: number, windowMs: number): number {
  return bucket.tokens >= 1
    ? 0
    : Math.max(1, Math.ceil(((1 - bucket.tokens) * windowMs) / capacity / 1000));
}
