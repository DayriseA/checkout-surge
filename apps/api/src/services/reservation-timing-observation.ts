import {
  type ServerReservationTimingSummary,
  serverReservationTimingSummarySchema,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "@checkout-surge/db";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";

const timingTtlSeconds = 24 * 60 * 60;
const timingBucketUpperBoundsMs = [
  0.25, 0.5, 0.75, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
] as const;

export interface ReservationTimingObservation {
  runId: string;
  redisAtomicReservationMs?: number;
  reserveOrderServiceMs: number;
}

export interface ReservationTimingObservationPort {
  observe(input: ReservationTimingObservation): void;
}

interface TimingAggregate {
  count: number;
  sumMs: number;
  maxMs: number;
  buckets: number[];
}

export interface ReservationTimingAggregate {
  redisAtomicReservation: TimingAggregate;
  reserveOrderService: TimingAggregate;
}

export interface ReservationTimingStore {
  mergeIfLive(runId: string, aggregate: ReservationTimingAggregate): Promise<boolean>;
  readAndFence(runId: string): Promise<ServerReservationTimingSummary>;
  clearRun(runId: string): Promise<void>;
}

export interface TerminalReservationTimingReader {
  readAndFence(runId: string): Promise<ServerReservationTimingSummary>;
}

export interface ReservationTimingLifecycle extends TerminalReservationTimingReader {
  clearRun(runId: string): Promise<void>;
}

export class ReservationTimingObservationScheduler implements ReservationTimingObservationPort {
  private readonly pending = new Map<string, ReservationTimingAggregate>();
  private scheduledDrain: NodeJS.Immediate | null = null;
  private drainInFlight: Promise<void> | null = null;

  constructor(
    private readonly store: ReservationTimingStore,
    private readonly logger: CheckoutSurgeLogger,
  ) {}

  observe(input: ReservationTimingObservation): void {
    if (
      !validDuration(input.reserveOrderServiceMs) ||
      (input.redisAtomicReservationMs !== undefined &&
        !validDuration(input.redisAtomicReservationMs))
    ) {
      this.logger.warn({ runId: input.runId }, "Ignored an invalid reservation timing sample.");
      return;
    }

    const aggregate = this.pending.get(input.runId) ?? emptyAggregate();
    recordTiming(aggregate.reserveOrderService, input.reserveOrderServiceMs);
    if (input.redisAtomicReservationMs !== undefined) {
      recordTiming(aggregate.redisAtomicReservation, input.redisAtomicReservationMs);
    }
    this.pending.set(input.runId, aggregate);
    this.scheduleDrain();
  }

  async readAndFence(runId: string): Promise<ServerReservationTimingSummary> {
    await this.flush();
    return this.store.readAndFence(runId);
  }

  async clearRun(runId: string): Promise<void> {
    this.pending.delete(runId);
    await this.flush();
    await this.store.clearRun(runId);
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleDrain(): void {
    if (this.scheduledDrain || this.drainInFlight) return;
    this.scheduledDrain = setImmediate(() => {
      this.scheduledDrain = null;
      this.startDrain();
    });
    this.scheduledDrain.unref();
  }

  private startDrain(): void {
    if (this.drainInFlight || this.pending.size === 0) return;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    this.drainInFlight = this.mergeBatch(batch).finally(() => {
      this.drainInFlight = null;
      if (this.pending.size > 0) this.scheduleDrain();
    });
  }

  private async mergeBatch(batch: Array<[string, ReservationTimingAggregate]>): Promise<void> {
    await Promise.all(
      batch.map(async ([runId, aggregate]) => {
        try {
          const merged = await this.store.mergeIfLive(runId, aggregate);
          if (!merged) {
            this.logger.debug(
              { droppedSampleCount: aggregate.reserveOrderService.count, runId },
              "Dropped reservation timing observations after the terminal fence.",
            );
          }
        } catch (error) {
          this.logger.warn(
            { err: error, runId },
            "Could not persist advisory reservation timing observations.",
          );
        }
      }),
    );
  }

  private async flush(): Promise<void> {
    if (this.scheduledDrain) {
      clearImmediate(this.scheduledDrain);
      this.scheduledDrain = null;
    }
    while (this.pending.size > 0 || this.drainInFlight) {
      if (!this.drainInFlight) this.startDrain();
      await this.drainInFlight;
    }
  }
}

export class RedisReservationTimingStore implements ReservationTimingStore {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  async mergeIfLive(runId: string, aggregate: ReservationTimingAggregate): Promise<boolean> {
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
        local aggregate = cjson.decode(ARGV[1])
        local function merge(prefix, timing)
          redis.call("HINCRBY", KEYS[1], prefix .. ":count", timing.count)
          redis.call("HINCRBYFLOAT", KEYS[1], prefix .. ":sum_ms", timing.sumMs)
          local currentMax = tonumber(redis.call("HGET", KEYS[1], prefix .. ":max_ms")) or 0
          if timing.maxMs > currentMax then
            redis.call("HSET", KEYS[1], prefix .. ":max_ms", timing.maxMs)
          end
          for index, count in ipairs(timing.buckets) do
            if count > 0 then
              redis.call("HINCRBY", KEYS[1], prefix .. ":bucket:" .. index, count)
            end
          end
        end
        merge("redis", aggregate.redisAtomicReservation)
        merge("service", aggregate.reserveOrderService)
        redis.call("EXPIRE", KEYS[1], ${timingTtlSeconds})
        return 1
      `,
      2,
      timingKey(runId),
      timingFenceKey(runId),
      JSON.stringify(aggregate),
    );
    return result === 1;
  }

  async readAndFence(runId: string): Promise<ServerReservationTimingSummary> {
    const raw = await this.redis.eval(
      `
        redis.call("SET", KEYS[2], "terminal", "EX", ${timingTtlSeconds})
        redis.call("EXPIRE", KEYS[1], ${timingTtlSeconds})
        return redis.call("HGETALL", KEYS[1])
      `,
      2,
      timingKey(runId),
      timingFenceKey(runId),
    );
    return toTimingSummary(parseHash(raw));
  }

  async clearRun(runId: string): Promise<void> {
    await this.redis.del(timingKey(runId), timingFenceKey(runId));
  }
}

function emptyAggregate(): ReservationTimingAggregate {
  return {
    redisAtomicReservation: emptyTimingAggregate(),
    reserveOrderService: emptyTimingAggregate(),
  };
}

function emptyTimingAggregate(): TimingAggregate {
  return {
    count: 0,
    sumMs: 0,
    maxMs: 0,
    buckets: Array.from({ length: timingBucketUpperBoundsMs.length + 1 }, () => 0),
  };
}

function recordTiming(aggregate: TimingAggregate, durationMs: number): void {
  aggregate.count += 1;
  aggregate.sumMs += durationMs;
  aggregate.maxMs = Math.max(aggregate.maxMs, durationMs);
  const bucketIndex = timingBucketUpperBoundsMs.findIndex((bound) => durationMs <= bound);
  const targetIndex = bucketIndex === -1 ? timingBucketUpperBoundsMs.length : bucketIndex;
  aggregate.buckets[targetIndex] = (aggregate.buckets[targetIndex] ?? 0) + 1;
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function parseHash(value: unknown): Map<string, number> {
  if (
    !Array.isArray(value) ||
    value.length % 2 !== 0 ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Redis returned an invalid reservation timing snapshot.");
  }
  const parsed = new Map<string, number>();
  for (let index = 0; index < value.length; index += 2) {
    const field = value[index] as string;
    const number = Number(value[index + 1]);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error("Redis returned an invalid reservation timing value.");
    }
    parsed.set(field, number);
  }
  return parsed;
}

function toTimingSummary(values: Map<string, number>): ServerReservationTimingSummary {
  return serverReservationTimingSummarySchema.parse({
    redisAtomicReservation: toTimingMeasurement(values, "redis"),
    reserveOrderService: toTimingMeasurement(values, "service"),
  });
}

function toTimingMeasurement(values: Map<string, number>, prefix: string) {
  const count = values.get(`${prefix}:count`) ?? 0;
  if (count === 0) {
    return { sampleCount: 0, averageMs: null, p95Ms: null };
  }
  if (!Number.isSafeInteger(count)) {
    throw new Error("Redis returned a non-integer reservation timing count.");
  }

  const percentileRank = Math.ceil(count * 0.95);
  let cumulativeCount = 0;
  let p95Ms = values.get(`${prefix}:max_ms`) ?? 0;
  for (let index = 0; index <= timingBucketUpperBoundsMs.length; index += 1) {
    cumulativeCount += values.get(`${prefix}:bucket:${index + 1}`) ?? 0;
    if (cumulativeCount >= percentileRank) {
      p95Ms = timingBucketUpperBoundsMs[index] ?? p95Ms;
      break;
    }
  }

  return {
    sampleCount: count,
    averageMs: (values.get(`${prefix}:sum_ms`) ?? 0) / count,
    p95Ms,
  };
}

function timingKey(runId: string): string {
  return `demo-run:${runId}:reservation-timing`;
}

function timingFenceKey(runId: string): string {
  return `demo-run:${runId}:reservation-timing-fence`;
}
