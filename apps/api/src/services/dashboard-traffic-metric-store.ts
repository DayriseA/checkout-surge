import {
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  type DashboardProjectionDirtySignal,
  dashboardProjectionDirtyRedisChannel,
  serializeDashboardProjectionDirtySignal,
} from "@checkout-surge/db";

const recentMetricRetentionLimit = 50;
const recoveredMetricLimit = 20;
const metricTtlSeconds = 24 * 60 * 60;

export type TrafficMetricPublishResult =
  | { outcome: "fenced" }
  | { outcome: "published" }
  | { outcome: "failed"; error: Error };

export interface DashboardTrafficMetricReader {
  readRecent(runId: string | null): Promise<MetricSample[]>;
}

export interface DashboardTrafficMetricStore extends DashboardTrafficMetricReader {
  appendIfLive(input: LoadMetricIngestRequest): Promise<boolean>;
  publishDirtyIfLive(
    runId: string,
    signal: DashboardProjectionDirtySignal,
  ): Promise<TrafficMetricPublishResult>;
  fenceRun(runId: string): Promise<void>;
  clearRun(runId: string): Promise<void>;
  hasRunState(runId: string): Promise<boolean>;
}

export class RedisDashboardTrafficMetricStore implements DashboardTrafficMetricStore {
  constructor(private readonly redis: CheckoutSurgeRedis) {}

  async appendIfLive(input: LoadMetricIngestRequest): Promise<boolean> {
    const samplePayloads = input.samples.map((sample) => JSON.stringify(sample));
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
        redis.call("RPUSH", KEYS[1], unpack(ARGV))
        redis.call("LTRIM", KEYS[1], -${recentMetricRetentionLimit}, -1)
        redis.call("EXPIRE", KEYS[1], ${metricTtlSeconds})
        return 1
      `,
      2,
      trafficMetricKey(input.runId),
      trafficMetricFenceKey(input.runId),
      ...samplePayloads,
    );
    return result === 1;
  }

  async publishDirtyIfLive(
    runId: string,
    signal: DashboardProjectionDirtySignal,
  ): Promise<TrafficMetricPublishResult> {
    const payload = serializeDashboardProjectionDirtySignal(signal);
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[1]) == 1 then return { "fenced" } end
        local publishResult = redis.pcall("PUBLISH", KEYS[2], ARGV[1])
        if type(publishResult) == "table" and publishResult.err then
          return { "failed", publishResult.err }
        end
        return { "published" }
      `,
      2,
      trafficMetricFenceKey(runId),
      dashboardProjectionDirtyRedisChannel,
      payload,
    );
    return parseTrafficMetricPublishResult(result);
  }

  async fenceRun(runId: string): Promise<void> {
    await this.redis.set(trafficMetricFenceKey(runId), "reset", "EX", metricTtlSeconds);
  }

  async clearRun(runId: string): Promise<void> {
    await this.redis
      .multi()
      .set(trafficMetricFenceKey(runId), "reset", "EX", metricTtlSeconds)
      .del(trafficMetricKey(runId))
      .exec();
  }

  async hasRunState(runId: string): Promise<boolean> {
    return (await this.redis.exists(trafficMetricKey(runId))) === 1;
  }

  async readRecent(runId: string | null): Promise<MetricSample[]> {
    if (!runId) return [];

    const rawSamples = await this.redis.lrange(trafficMetricKey(runId), -recoveredMetricLimit, -1);
    return rawSamples.map((raw) =>
      loadMetricIngestRequestSchema.shape.samples.element.parse(JSON.parse(raw)),
    );
  }
}

function trafficMetricKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics`;
}

function trafficMetricFenceKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics-reset-fence`;
}

function parseTrafficMetricPublishResult(value: unknown): TrafficMetricPublishResult {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== "string") {
    throw new Error("Redis returned an invalid traffic metric publication result.");
  }
  if (value[0] === "fenced" && value.length === 1) return { outcome: "fenced" };
  if (value[0] === "published" && value.length === 1) return { outcome: "published" };
  if (value[0] === "failed" && value.length === 2 && typeof value[1] === "string") {
    return { outcome: "failed", error: new Error(value[1]) };
  }
  throw new Error("Redis returned an invalid traffic metric publication result.");
}
