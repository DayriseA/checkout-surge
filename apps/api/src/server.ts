import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { normalizeCorrelationId } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import cors from "@fastify/cors";
import { type FastifyReply, fastify } from "fastify";
import { ZodError } from "zod";
import type { DashboardProjectionFanout } from "./realtime/dashboard-projection-fanout.js";
import { registerAdminMaintenanceRoutes } from "./routes/admin-maintenance-routes.js";
import { registerBuyRoutes } from "./routes/buy-routes.js";
import { registerDashboardRoutes } from "./routes/dashboard-routes.js";
import { registerDemoRunRoutes } from "./routes/demo-run-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerInventoryRoutes } from "./routes/inventory-routes.js";
import { registerOrderStatusRoutes } from "./routes/order-status-routes.js";
import { registerQueueRoutes } from "./routes/queue-routes.js";
import { registerRunHistoryRoutes } from "./routes/run-history-routes.js";
import type { ApiConfig } from "./runtime/config.js";
import { createDashboardSourceResolver } from "./runtime/dashboard-source-identity.js";
import { ApiHttpError, createErrorPayload } from "./runtime/errors.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import type { ApiReadiness } from "./runtime/readiness.js";
import type { AdminDemoResetWorkflow } from "./services/admin-demo-reset-service.js";
import type { DashboardRecoveryAdmissionController } from "./services/dashboard-recovery-admission.js";
import type { DashboardProjectionService } from "./services/dashboard-recovery-service.js";
import { DashboardRecoveryWorkflow } from "./services/dashboard-recovery-workflow.js";
import type { DemoPresetController } from "./services/demo-preset-service.js";
import type { DemoRunLifecycleController } from "./services/demo-run-service.js";
import { DemoRunValidationError } from "./services/demo-run-validation-error.js";
import type { GeneratedRunRetentionWorkflow } from "./services/generated-run-retention-service.js";
import type { GeneratedRunTeardownWorkflow } from "./services/generated-run-teardown-service.js";
import type { InventoryStatusService } from "./services/inventory-status-service.js";
import type { OrderStatusController } from "./services/order-status-service.js";
import type { PublicRuntimePolicyController } from "./services/public-runtime-policy-service.js";
import type { QueueStatusService } from "./services/queue-status-service.js";
import type { ReserveOrderService } from "./services/reserve-order-service.js";
import type { RunHistoryController } from "./services/run-history-service.js";
import type { RunnerOperations } from "./services/runner-operations.js";
import type { TrafficCompletionController } from "./services/traffic-completion-service.js";
import type { TrafficMetricIngestionController } from "./services/traffic-metric-ingestion-service.js";

export interface BuildApiServerOptions {
  config: ApiConfig;
  logger: CheckoutSurgeLogger;
  readiness: ApiReadiness;
  dashboardProjectionFanout: DashboardProjectionFanout;
  dashboardRecoveryService: DashboardProjectionService;
  dashboardRecoveryAdmission: DashboardRecoveryAdmissionController;
  inventoryStatusService: InventoryStatusService;
  orderStatusService: OrderStatusController;
  queueStatusService: QueueStatusService;
  reserveOrderService: ReserveOrderService;
  presetService: DemoPresetController;
  runtimePolicyService: PublicRuntimePolicyController;
  demoRunLifecycleService: DemoRunLifecycleController;
  trafficCompletionService: TrafficCompletionController;
  trafficMetricIngestion: TrafficMetricIngestionController;
  adminDemoReset: AdminDemoResetWorkflow;
  generatedRunRetention: GeneratedRunRetentionWorkflow;
  generatedRunTeardown: GeneratedRunTeardownWorkflow;
  runnerRecreation: Pick<RunnerOperations, "recreate">;
  runHistoryService: RunHistoryController;
  startedAt?: Date;
}

export async function buildApiServer(options: BuildApiServerOptions): Promise<ApiFastifyInstance> {
  const app = fastify({
    loggerInstance: options.logger,
    trustProxy: options.config.trustedProxyCidrs,
  }) as ApiFastifyInstance;

  installFastifyCorrelation(app);

  await app.register(cors, {
    origin: options.config.webOrigins.length > 0 ? options.config.webOrigins : true,
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = request.correlationId ?? normalizeCorrelationId(undefined);

    if (error instanceof ApiHttpError) {
      return sendError(reply, error.statusCode, {
        code: error.code,
        message: error.message,
        correlationId,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error instanceof DemoRunValidationError) {
      const retryAfterSeconds = publicRunBudgetRetryAfterSeconds(error);
      return sendError(
        reply,
        demoRunValidationStatus(error.code),
        {
          code: error.code,
          message: error.message,
          correlationId,
          ...(error.details ? { details: error.details } : {}),
        },
        retryAfterSeconds === undefined ? undefined : { "retry-after": String(retryAfterSeconds) },
      );
    }

    if (error instanceof ZodError) {
      return sendError(reply, 400, {
        code: "invalid_request",
        message: "Request validation failed.",
        correlationId,
        details: { issues: error.issues },
      });
    }

    if (isBadRequestError(error)) {
      return sendError(reply, 400, {
        code: "invalid_request",
        message: error.message || "Request validation failed.",
        correlationId,
      });
    }

    request.log.error({ err: error }, "Unhandled API error.");

    return sendError(reply, 500, {
      code: "internal_error",
      message: "The API could not complete the request.",
      correlationId,
    });
  });

  registerHealthRoutes(app, {
    readiness: options.readiness,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
  registerBuyRoutes(app, { reserveOrderService: options.reserveOrderService });
  registerInventoryRoutes(app, { inventoryStatusService: options.inventoryStatusService });
  registerOrderStatusRoutes(app, { orderStatusService: options.orderStatusService });
  registerQueueRoutes(app, { queueStatusService: options.queueStatusService });
  registerDemoRunRoutes(app, {
    presetService: options.presetService,
    runtimePolicyService: options.runtimePolicyService,
    demoRunLifecycleService: options.demoRunLifecycleService,
    trafficCompletionService: options.trafficCompletionService,
    trafficMetricIngestion: options.trafficMetricIngestion,
    controlServiceToken: options.config.controlServiceToken,
  });
  registerAdminMaintenanceRoutes(app, {
    adminDemoReset: options.adminDemoReset,
    generatedRunRetention: options.generatedRunRetention,
    generatedRunTeardown: options.generatedRunTeardown,
    runnerRecreation: options.runnerRecreation,
    controlServiceToken: options.config.controlServiceToken,
  });
  registerRunHistoryRoutes(app, {
    runHistoryService: options.runHistoryService,
    controlServiceToken: options.config.controlServiceToken,
  });
  registerDashboardRoutes(app, {
    dashboardProjectionFanout: options.dashboardProjectionFanout,
    dashboardRecoveryWorkflow: new DashboardRecoveryWorkflow({
      recovery: options.dashboardRecoveryService,
      admission: options.dashboardRecoveryAdmission,
    }),
    sourceResolver: createDashboardSourceResolver(options.config.publicClientCookieSecret),
    sseRetryAfterSeconds: options.config.dashboardSseRetryAfterSeconds,
    recoveryRetryAfterSeconds: options.config.dashboardRecoveryRetryAfterSeconds,
    recoveryTimeoutMs: options.config.dashboardRecoveryTimeoutMs,
  });

  return app;
}

function demoRunValidationStatus(code: DemoRunValidationError["code"]): number {
  if (code === "public_visitor_forbidden") return 403;
  if (code === "public_run_budget_exceeded") return 429;
  if (code === "resource_not_found") return 404;
  if (["run_conflict", "preset_conflict", "traffic_report_rejected"].includes(code)) return 409;
  return 400;
}

function isBadRequestError(error: unknown): error is Error & { statusCode: 400 } {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    (error as { statusCode?: unknown }).statusCode === 400
  );
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  options: Parameters<typeof createErrorPayload>[0],
  headers?: Record<string, string>,
) {
  if (headers) {
    for (const [name, value] of Object.entries(headers)) reply.header(name, value);
  }
  const payload = createErrorPayload(options);
  return reply.status(statusCode).send(payload);
}

function publicRunBudgetRetryAfterSeconds(error: DemoRunValidationError): number | undefined {
  if (error.code !== "public_run_budget_exceeded") return undefined;
  return error.retryAfterSeconds;
}
