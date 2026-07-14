import { type ServiceName, serviceNameSchema } from "@checkout-surge/contracts";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { normalizeCorrelationId } from "./correlation.js";

export type CheckoutSurgeLogger = Logger;

export interface CreateServiceLoggerOptions {
  service: ServiceName;
  level?: string;
  correlationId?: string;
  base?: Record<string, unknown>;
  pinoOptions?: Omit<LoggerOptions, "base" | "level">;
  /**
   * Optional writable destination for log output. Tests pass an in-memory
   * stream so real Pino serialization can be asserted without a transport.
   */
  destination?: DestinationStream;
}

export function createServiceLogger(options: CreateServiceLoggerOptions): CheckoutSurgeLogger {
  const service = serviceNameSchema.parse(options.service);
  const correlationId = options.correlationId
    ? normalizeCorrelationId(options.correlationId)
    : undefined;

  const pinoOptions = {
    ...options.pinoOptions,
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: {
      service,
      ...options.base,
      ...(correlationId ? { correlationId } : {}),
    },
  };

  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}

export function createSilentLogger(service: ServiceName): CheckoutSurgeLogger {
  return createServiceLogger({
    service,
    level: "silent",
  });
}

export function childLoggerWithContext(
  logger: CheckoutSurgeLogger,
  fields: Record<string, unknown>,
): CheckoutSurgeLogger {
  return logger.child(fields);
}

export function childLoggerWithCorrelationId(
  logger: CheckoutSurgeLogger,
  correlationId: string,
): CheckoutSurgeLogger {
  return childLoggerWithContext(logger, {
    correlationId: normalizeCorrelationId(correlationId),
  });
}
