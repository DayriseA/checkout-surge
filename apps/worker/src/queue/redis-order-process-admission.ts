import { randomUUID } from "node:crypto";
import type { OrderProcessJob } from "@checkout-surge/contracts";
import type { Redis } from "ioredis";
import type {
  OrderProcessAdmission,
  OrderProcessAdmissionLease,
} from "../application/order-process-admission.js";
import type { RunConfigReader } from "../application/run-config.js";

const acquireScript = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return 1`;
const renewScript = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
  return 1
end
return 0`;
const releaseScript = `
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return removed`;

export class RedisOrderProcessAdmission implements OrderProcessAdmission {
  private readonly leases = new Set<RedisLease>();
  private closing = false;

  constructor(
    private readonly options: {
      redis: Redis;
      runConfigReader: RunConfigReader;
      fallbackConcurrency: number;
      leaseMs?: number;
      keyPrefix?: string;
      onError?: (operation: "renew" | "release", error: unknown) => void;
    },
  ) {}

  async tryAcquire(job: OrderProcessJob): Promise<OrderProcessAdmissionLease | null> {
    if (this.closing) return null;
    const limit = await this.resolveLimit(job);
    const namespace = job.runId ? `run:${job.runId}` : "non-run";
    const key = `${this.options.keyPrefix ?? "checkout-surge:order-admission"}:${namespace}`;
    const owner = randomUUID();
    const leaseMs = this.options.leaseMs ?? 30_000;
    const acquired = await this.options.redis.eval(
      acquireScript,
      1,
      key,
      limit,
      leaseMs,
      owner,
      leaseMs * 2,
    );
    if (Number(acquired) !== 1) return null;
    const lease = new RedisLease(
      this.options.redis,
      key,
      owner,
      leaseMs,
      (operation, error) => this.options.onError?.(operation, error),
      () => this.leases.delete(lease),
    );
    this.leases.add(lease);
    return lease;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.leases].map((lease) => lease.release()));
  }

  private async resolveLimit(job: OrderProcessJob): Promise<number> {
    if (!job.runId) return this.options.fallbackConcurrency;
    const snapshot = await this.options.runConfigReader.read(job.runId);
    if (!snapshot)
      throw new Error(`Accepted run snapshot was not found for order job run ${job.runId}.`);
    return snapshot.backpressureConfig.orderProcessConcurrency;
  }
}

class RedisLease implements OrderProcessAdmissionLease {
  private released = false;
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly owner: string,
    private readonly leaseMs: number,
    private readonly onError: (operation: "renew" | "release", error: unknown) => void,
    private readonly onRelease: () => void,
  ) {
    this.timer = setInterval(() => void this.renew(), Math.max(100, Math.floor(leaseMs / 3)));
    this.timer.unref();
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    try {
      await this.redis.eval(releaseScript, 1, this.key, this.owner);
    } catch (error) {
      this.onError("release", error);
      throw error;
    } finally {
      this.onRelease();
    }
  }

  private async renew(): Promise<void> {
    if (this.released) return;
    try {
      await this.redis.eval(renewScript, 1, this.key, this.owner, this.leaseMs, this.leaseMs * 2);
    } catch (error) {
      this.onError("renew", error);
    }
  }
}
