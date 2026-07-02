import {
  controlServiceTokenHeaderName,
  internalLoadMetricIngestPath,
  internalTrafficCompletionPath,
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
  type TrafficCompletionReport,
  trafficCompletionReportSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName } from "@checkout-surge/logger";

export interface LoadApiClient {
  sendMetrics(request: LoadMetricIngestRequest): Promise<void>;
  sendCompletion(report: TrafficCompletionReport): Promise<void>;
}

export class HttpLoadApiClient implements LoadApiClient {
  constructor(
    private readonly options: {
      apiBaseUrl: string;
      controlServiceToken: string;
    },
  ) {}

  async sendMetrics(request: LoadMetricIngestRequest): Promise<void> {
    const payload = loadMetricIngestRequestSchema.parse(request);
    await this.postJson(internalLoadMetricIngestPath, payload, payload.correlationId);
  }

  async sendCompletion(report: TrafficCompletionReport): Promise<void> {
    const payload = trafficCompletionReportSchema.parse(report);
    await this.postJson(internalTrafficCompletionPath, payload, payload.correlationId);
  }

  private async postJson(path: string, body: unknown, correlationId: string): Promise<void> {
    const response = await fetch(`${this.options.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [correlationIdHeaderName]: correlationId,
        [controlServiceTokenHeaderName]: this.options.controlServiceToken,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`API load ingestion failed with HTTP ${response.status}.`);
    }
  }
}

export class MetricBatcher {
  private readonly samples: MetricSample[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: {
      runId: string;
      correlationId: string;
      client: LoadApiClient;
      maxBatchSize?: number;
      flushIntervalMs?: number;
      now?: () => Date;
      onFlushError?: (error: unknown) => void;
    },
  ) {}

  add(sample: MetricSample): void {
    this.samples.push(sample);

    if (this.samples.length >= (this.options.maxBatchSize ?? 100)) {
      void this.flush();
      return;
    }

    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.options.flushIntervalMs ?? 1000);
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.flush();
  }

  private async flush(): Promise<void> {
    const samples = this.samples.splice(0, this.samples.length);
    if (samples.length === 0) {
      return;
    }

    try {
      await this.options.client.sendMetrics({
        runId: this.options.runId,
        correlationId: this.options.correlationId,
        samples,
        observedAt: (this.options.now?.() ?? new Date()).toISOString(),
      });
    } catch (error) {
      this.options.onFlushError?.(error);
    }
  }
}
