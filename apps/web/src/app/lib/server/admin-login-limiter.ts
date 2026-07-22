import { createHash } from "node:crypto";

export interface LoginRatePolicy {
  clientCapacity: number;
  globalCapacity: number;
  refillWindowMs: number;
}

export type LoginAdmission =
  | { outcome: "admitted" }
  | { outcome: "limited"; retryAfterSeconds: number };

export interface AdminLoginLimiter {
  admit(clientIdentity: string, nowMs: number): LoginAdmission | Promise<LoginAdmission>;
}

export class AdminLoginAttemptLimiter implements AdminLoginLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly policy: LoginRatePolicy,
    private readonly now: () => number = Date.now,
    private readonly maxClientBuckets = 1_024,
  ) {
    if (!Number.isSafeInteger(maxClientBuckets) || maxClientBuckets <= 0) {
      throw new Error("maxClientBuckets must be a positive integer");
    }
  }

  get clientBucketCount(): number {
    return [...this.buckets.keys()].filter((key) => key.startsWith("client:")).length;
  }

  admit(clientIdentity: string, nowMs = this.now()): LoginAdmission {
    const clientDigest = hashIdentity(clientIdentity);
    const clientKey = `client:${clientDigest}`;
    this.pruneClientBuckets(clientKey, nowMs, this.policy.refillWindowMs * 2);
    const client = this.refill(
      clientKey,
      nowMs,
      this.policy.clientCapacity,
      this.policy.refillWindowMs,
    );
    const global = this.refill(
      "global",
      nowMs,
      this.policy.globalCapacity,
      this.policy.refillWindowMs,
    );
    const clientWait = retryAfter(client, this.policy.clientCapacity, this.policy.refillWindowMs);
    const globalWait = retryAfter(global, this.policy.globalCapacity, this.policy.refillWindowMs);
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

interface Bucket {
  tokens: number;
  updatedAt: number;
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function retryAfter(bucket: Bucket, capacity: number, windowMs: number): number {
  return bucket.tokens >= 1
    ? 0
    : Math.max(1, Math.ceil(((1 - bucket.tokens) * windowMs) / capacity / 1000));
}
