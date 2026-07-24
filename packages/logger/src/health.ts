import {
  type HealthResponse,
  type HealthStatus,
  healthResponseSchema,
  livenessResponseSchema,
  type ReadinessCheck,
  readinessCheckSchema,
  type ServiceName,
  serviceNameSchema,
} from "@checkout-surge/contracts";

export interface HealthResponseOptions {
  service: ServiceName;
  startedAt?: Date;
  now?: Date;
}

export function createReadinessResponse(
  options: HealthResponseOptions & { checks: ReadinessCheck[] },
): HealthResponse {
  const now = options.now ?? new Date();
  const checks = options.checks.map((check) => readinessCheckSchema.parse(check));

  return healthResponseSchema.parse({
    service: serviceNameSchema.parse(options.service),
    status: aggregateHealthStatus(checks),
    timestamp: now.toISOString(),
    uptimeSeconds: uptimeSeconds(options.startedAt, now),
    checks,
  });
}

export function createReadinessCheck(check: ReadinessCheck): ReadinessCheck {
  return readinessCheckSchema.parse(check);
}

export function aggregateHealthStatus(checks: ReadinessCheck[]): HealthStatus {
  if (checks.some((check) => check.status === "unavailable")) {
    return "unavailable";
  }

  if (checks.some((check) => check.status === "degraded")) {
    return "degraded";
  }

  return "ok";
}

export function createLivenessPayload(options: HealthResponseOptions) {
  const now = options.now ?? new Date();

  return livenessResponseSchema.parse({
    service: serviceNameSchema.parse(options.service),
    status: "ok",
    timestamp: now.toISOString(),
    uptimeSeconds: uptimeSeconds(options.startedAt, now),
  });
}

function uptimeSeconds(startedAt: Date | undefined, now: Date): number {
  if (!startedAt) {
    return Math.floor(process.uptime());
  }

  return Math.max(0, (now.getTime() - startedAt.getTime()) / 1000);
}
