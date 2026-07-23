import {
  dashboardEventsRedisChannel,
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeRedis } from "@checkout-surge/db";

const recentMetricRetentionLimit = 50;
const recoveredMetricLimit = 20;
const metricTtlSeconds = 24 * 60 * 60;

export type TrafficMetricPublishResult =
  | { outcome: "fenced" }
  | {
      outcome: "attempted";
      failures: Array<{ index: number; error: Error }>;
    };

export interface DashboardTrafficMetricReader {
  readRecent(runId: string | null): Promise<MetricSample[]>;
}

export interface DashboardTrafficMetricStore extends DashboardTrafficMetricReader {
  appendIfLive(input: LoadMetricIngestRequest): Promise<boolean>;
  publishIfLive(runId: string, eventPayloads: string[]): Promise<TrafficMetricPublishResult>;
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

  async publishIfLive(runId: string, eventPayloads: string[]): Promise<TrafficMetricPublishResult> {
    if (eventPayloads.length === 0) return { outcome: "attempted", failures: [] };
    const result = await this.redis.eval(
      `
        if redis.call("EXISTS", KEYS[1]) == 1 then return { "fenced" } end
        local outcomes = { "attempted" }
        for i = 1, #ARGV do
          local publishResult = redis.pcall("PUBLISH", KEYS[2], ARGV[i])
          if type(publishResult) == "table" and publishResult.err then
            table.insert(outcomes, publishResult.err)
          else
            table.insert(outcomes, "")
          end
        end
        return outcomes
      `,
      2,
      trafficMetricFenceKey(runId),
      dashboardEventsRedisChannel,
      ...eventPayloads,
    );
    return parseTrafficMetricPublishResult(result, eventPayloads.length);
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

function parseTrafficMetricPublishResult(
  value: unknown,
  expectedOutcomeCount: number,
): TrafficMetricPublishResult {
  if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== "string") {
    throw new Error("Redis returned an invalid traffic metric publication result.");
  }
  if (value[0] === "fenced" && value.length === 1) return { outcome: "fenced" };
  if (value[0] !== "attempted" || value.length !== expectedOutcomeCount + 1) {
    throw new Error("Redis returned an invalid traffic metric publication result.");
  }

  const failures: Array<{ index: number; error: Error }> = [];
  for (let index = 0; index < expectedOutcomeCount; index += 1) {
    const outcome = value[index + 1];
    if (typeof outcome !== "string") {
      throw new Error("Redis returned an invalid traffic metric publication result.");
    }
    if (outcome.length > 0) failures.push({ index, error: new Error(outcome) });
  }
  return { outcome: "attempted", failures };
}
