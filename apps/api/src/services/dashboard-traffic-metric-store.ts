import {
  type DashboardProjectionDirtySignal,
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
} from "@checkout-surge/contracts";
import {
  type CheckoutSurgeRedis,
  dashboardProjectionDirtyRedisChannel,
  serializeDashboardProjectionDirtySignal,
} from "@checkout-surge/db";

const recentMetricRetentionLimit = 50;
const recoveredMetricLimit = 20;
const metricTtlSeconds = 24 * 60 * 60;
const pinnedMetricNames = ["traffic.request_arrival_rate", "traffic.attempts_dispatched"] as const;

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
        for index, payload in ipairs(ARGV) do
          local metricName = cjson.decode(payload).metricName
          if metricName == "${pinnedMetricNames[0]}" or metricName == "${pinnedMetricNames[1]}" then
            redis.call("HSET", KEYS[3], metricName, payload)
          end
        end
        redis.call("EXPIRE", KEYS[3], ${metricTtlSeconds})
        return 1
      `,
      3,
      trafficMetricKey(input.runId),
      trafficMetricFenceKey(input.runId),
      pinnedTrafficMetricKey(input.runId),
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
      .del(pinnedTrafficMetricKey(runId))
      .exec();
  }

  async hasRunState(runId: string): Promise<boolean> {
    return (await this.redis.exists(trafficMetricKey(runId), pinnedTrafficMetricKey(runId))) > 0;
  }

  async readRecent(runId: string | null): Promise<MetricSample[]> {
    if (!runId) return [];

    const [rawSamples, pinnedSamplesByName] = parseTrafficMetricSnapshot(
      await this.redis.eval(
        `
          return {
            redis.call("LRANGE", KEYS[1], -${recoveredMetricLimit}, -1),
            redis.call("HMGET", KEYS[2], unpack(ARGV))
          }
        `,
        2,
        trafficMetricKey(runId),
        pinnedTrafficMetricKey(runId),
        ...pinnedMetricNames,
      ),
    );
    const sampleSchema = loadMetricIngestRequestSchema.shape.samples.element;
    const recentSamples = rawSamples.map((raw) => sampleSchema.parse(JSON.parse(raw)));
    const pinnedSamples = pinnedSamplesByName
      .filter((raw): raw is string => raw !== null)
      .map((raw) => sampleSchema.parse(JSON.parse(raw)));
    const recentEvidence = new Set(recentSamples.map((sample) => JSON.stringify(sample)));
    return [
      ...recentSamples,
      ...pinnedSamples.filter((sample) => !recentEvidence.has(JSON.stringify(sample))),
    ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }
}

function trafficMetricKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics`;
}

function trafficMetricFenceKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics-reset-fence`;
}

function pinnedTrafficMetricKey(runId: string): string {
  return `demo-run:${runId}:traffic-metrics-pinned`;
}

function parseTrafficMetricSnapshot(value: unknown): [string[], Array<string | null>] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Array.isArray(value[0]) ||
    !value[0].every((sample) => typeof sample === "string") ||
    !Array.isArray(value[1]) ||
    !value[1].every((sample) => sample === null || typeof sample === "string")
  ) {
    throw new Error("Redis returned an invalid traffic metric snapshot.");
  }
  return [value[0], value[1]];
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
