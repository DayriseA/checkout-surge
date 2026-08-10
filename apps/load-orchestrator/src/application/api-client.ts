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
import { ZodError } from "zod";

const maxMetricBatchSendAttempts = 3;
const metricBatchRetryDelayMs = 25;

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
    const requestTimeoutMs = this.options.requestTimeoutMs ?? 5_000;
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("API requestTimeoutMs must be finite and greater than zero.");
    }
    let rejectTimeout: (reason: Error) => void = () => undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      rejectTimeout = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error(`API load ingestion request timed out after ${requestTimeoutMs}ms.`));
    }, requestTimeoutMs);
    try {
      return await Promise.race([
        this.fetchJson(path, body, correlationId, controller.signal),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof LoadApiHttpError) throw error;
      throw new Error("API load ingestion request failed.", { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJson(
    path: string,
    body: unknown,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await (this.options.fetch ?? fetch)(`${this.options.apiBaseUrl}${path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        [correlationIdHeaderName]: correlationId,
        [controlServiceTokenHeaderName]: this.options.controlServiceToken,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new LoadApiHttpError(
        `API load ingestion failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    return response.json();
  }
}

export class LoadApiHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isRetryableLoadApiError(error: unknown): boolean {
  return !(error instanceof LoadApiHttpError || error instanceof ZodError);
}

export function isRetryableCompletionLoadApiError(error: unknown): boolean {
  return !(
    error instanceof LoadApiHttpError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export interface MetricBatchLossTotals {
  sampleCount: number;
  batchCount: number;
}

export class MetricBatcher {
  private readonly samples: MetricSample[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<void> | null = null;
  private forceFlushRequested = false;
  private closed = false;
  private discarded = false;
  private lostSampleCount = 0;
  private lostBatchCount = 0;

  constructor(
    private readonly options: {
      runId: string;
      correlationId: string;
      client: Pick<LoadApiClient, "sendMetrics">;
      maxBatchSize?: number;
      maxBufferedSamples?: number;
      flushIntervalMs?: number;
      now?: () => Date;
      onFlushError?: (error: unknown) => void;
      onOverflow?: (sample: MetricSample) => void;
    },
  ) {
    if (!Number.isInteger(this.maxBatchSize) || this.maxBatchSize <= 0) {
      throw new Error("MetricBatcher maxBatchSize must be a positive integer.");
    }
    if (!Number.isInteger(this.maxBufferedSamples) || this.maxBufferedSamples < this.maxBatchSize) {
      throw new Error("MetricBatcher maxBufferedSamples must be at least maxBatchSize.");
    }
  }

  /** Adds in order. On overflow, the newest sample is dropped and reported. */
  async add(sample: MetricSample): Promise<void> {
    if (this.closed) throw new Error("Cannot add a metric sample after MetricBatcher.close().");
    if (this.samples.length >= this.maxBufferedSamples) {
      this.recordLoss(1);
      this.options.onOverflow?.(sample);
      return;
    }
    this.samples.push(sample);

    if (this.samples.length >= this.maxBatchSize) {
      await this.requestFlush(false);
      return;
    }

    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      void this.requestFlush(true);
    }, this.options.flushIntervalMs ?? 1000);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    await this.requestFlush(true);
  }

  /** Stops future delivery and drops buffered samples when cancellation takes ownership. */
  async discard(): Promise<void> {
    this.closed = true;
    this.discarded = true;
    this.samples.length = 0;
    this.forceFlushRequested = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    await this.activeFlush;
  }

  lossTotals(): MetricBatchLossTotals {
    return {
      sampleCount: this.lostSampleCount,
      batchCount: this.lostBatchCount,
    };
  }

  private get maxBatchSize(): number {
    return this.options.maxBatchSize ?? 100;
  }

  private get maxBufferedSamples(): number {
    return this.options.maxBufferedSamples ?? this.maxBatchSize * 10;
  }

  private requestFlush(force: boolean): Promise<void> {
    this.forceFlushRequested ||= force;
    this.activeFlush ??= this.drain().finally(() => {
      this.activeFlush = null;
    });
    return this.activeFlush;
  }

  private async drain(): Promise<void> {
    while (
      this.samples.length >= this.maxBatchSize ||
      (this.forceFlushRequested && this.samples.length > 0)
    ) {
      const force = this.forceFlushRequested;
      const sampleCount = force
        ? Math.min(this.samples.length, this.maxBatchSize)
        : this.maxBatchSize;
      const samples = this.samples.splice(0, sampleCount);

      await this.sendWithRetries(samples);
      if (force && this.samples.length === 0) this.forceFlushRequested = false;
    }
  }

  private async sendWithRetries(samples: MetricSample[]): Promise<void> {
    for (let attempt = 1; attempt <= maxMetricBatchSendAttempts; attempt += 1) {
      if (this.discarded) return;
      try {
        await this.options.client.sendMetrics({
          runId: this.options.runId,
          correlationId: this.options.correlationId,
          samples,
          observedAt: (this.options.now?.() ?? new Date()).toISOString(),
        });
        return;
      } catch (error) {
        this.options.onFlushError?.(error);
        if (
          this.discarded ||
          !isRetryableLoadApiError(error) ||
          attempt === maxMetricBatchSendAttempts
        ) {
          if (!this.discarded) this.recordLoss(samples.length);
          return;
        }
        this.samples.unshift(...samples);
        await new Promise((resolve) => setTimeout(resolve, metricBatchRetryDelayMs));
        if (this.discarded) return;
        this.samples.splice(0, samples.length);
      }
    }
  }

  private recordLoss(sampleCount: number): void {
    this.lostSampleCount += sampleCount;
    this.lostBatchCount += 1;
  }
}
