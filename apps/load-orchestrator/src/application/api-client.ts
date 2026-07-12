import {
  controlServiceTokenHeaderName,
  internalLoadMetricIngestPath,
  internalTrafficCompletionPath,
  type LoadMetricIngestRequest,
  loadMetricIngestRequestSchema,
  type MetricSample,
  type TrafficCompletionReport,
  trafficCompletionAcknowledgementSchema,
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
      requestTimeoutMs?: number;
      fetch?: typeof fetch;
    },
  ) {}

  async sendMetrics(request: LoadMetricIngestRequest): Promise<void> {
    const payload = loadMetricIngestRequestSchema.parse(request);
    await this.postJson(internalLoadMetricIngestPath, payload, payload.correlationId);
  }

  async sendCompletion(report: TrafficCompletionReport): Promise<void> {
    const payload = trafficCompletionReportSchema.parse(report);
    const acknowledgement = trafficCompletionAcknowledgementSchema.parse(
      await this.postJson(internalTrafficCompletionPath, payload, payload.correlationId),
    );
    if (
      acknowledgement.runId !== payload.runId ||
      acknowledgement.correlationId !== payload.correlationId
    ) {
      throw new Error("API completion acknowledgement did not match the delivered report.");
    }
  }

  private async postJson(path: string, body: unknown, correlationId: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.apiBaseUrl}${path}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          [correlationIdHeaderName]: correlationId,
          [controlServiceTokenHeaderName]: this.options.controlServiceToken,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error("API load ingestion request failed.", { cause: error });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`API load ingestion failed with HTTP ${response.status}.`);
    }
    return response.json();
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
