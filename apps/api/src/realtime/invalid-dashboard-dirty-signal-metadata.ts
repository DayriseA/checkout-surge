const maximumInvalidDashboardMetadataLength = 128;

export interface InvalidDashboardDirtySignalMetadata {
  stage: "redis_subscriber_parse";
  messageLength: number;
  errorName?: string;
  signalType?: string;
  correlationId?: string;
}

export function invalidDashboardDirtySignalMetadata(
  message: string,
  error?: unknown,
): InvalidDashboardDirtySignalMetadata {
  const metadata: InvalidDashboardDirtySignalMetadata = {
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
    ...boundedStringField(candidate, "type", "signalType"),
    ...boundedStringField(candidate, "correlationId", "correlationId"),
  };
}

function errorName(
  error: unknown,
): Pick<InvalidDashboardDirtySignalMetadata, "errorName"> | object {
  if (!(error instanceof Error) || error.name.length === 0) return {};
  return { errorName: error.name.slice(0, maximumInvalidDashboardMetadataLength) };
}

function boundedStringField<OutputKey extends keyof InvalidDashboardDirtySignalMetadata>(
  candidate: Record<string, unknown>,
  inputKey: string,
  outputKey: OutputKey,
): Partial<Pick<InvalidDashboardDirtySignalMetadata, OutputKey>> {
  const value = candidate[inputKey];
  if (typeof value !== "string" || value.length === 0) return {};
  return { [outputKey]: value.slice(0, maximumInvalidDashboardMetadataLength) } as Partial<
    Pick<InvalidDashboardDirtySignalMetadata, OutputKey>
  >;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
