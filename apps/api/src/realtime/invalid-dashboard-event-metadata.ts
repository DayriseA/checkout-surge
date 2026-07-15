const maximumInvalidDashboardMetadataLength = 128;

export interface InvalidDashboardEventMetadata {
  stage: "redis_subscriber_parse";
  messageLength: number;
  errorName?: string;
  eventType?: string;
  metricName?: string;
  businessEventName?: string;
  runId?: string;
  correlationId?: string;
}

export function invalidDashboardEventMetadata(
  message: string,
  error?: unknown,
): InvalidDashboardEventMetadata {
  const metadata: InvalidDashboardEventMetadata = {
    stage: "redis_subscriber_parse",
    messageLength: message.length,
    ...errorName(error),
  };
  let candidate: unknown;
  try {
    candidate = JSON.parse(message);
  } catch {
    return metadata;
  }
  if (!isRecord(candidate)) return metadata;

  return {
    ...metadata,
    ...boundedStringField(candidate, "type", "eventType"),
    ...boundedStringField(candidate, "metricName", "metricName"),
    ...boundedStringField(candidate, "eventName", "businessEventName"),
    ...boundedStringField(candidate, "runId", "runId"),
    ...boundedStringField(candidate, "correlationId", "correlationId"),
  };
}

function errorName(error: unknown): Pick<InvalidDashboardEventMetadata, "errorName"> | object {
  if (!(error instanceof Error) || error.name.length === 0) return {};
  return { errorName: error.name.slice(0, maximumInvalidDashboardMetadataLength) };
}

function boundedStringField<OutputKey extends keyof InvalidDashboardEventMetadata>(
  candidate: Record<string, unknown>,
  inputKey: string,
  outputKey: OutputKey,
): Partial<Pick<InvalidDashboardEventMetadata, OutputKey>> {
  const value = candidate[inputKey];
  if (typeof value !== "string" || value.length === 0) return {};
  return { [outputKey]: value.slice(0, maximumInvalidDashboardMetadataLength) } as Partial<
    Pick<InvalidDashboardEventMetadata, OutputKey>
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
