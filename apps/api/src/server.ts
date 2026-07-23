import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { normalizeCorrelationId } from "@checkout-surge/logger";
import { installFastifyCorrelation } from "@checkout-surge/logger/fastify";
import cors from "@fastify/cors";
import { type FastifyReply, fastify } from "fastify";
import { ZodError } from "zod";
import type { DashboardEventFanout } from "./realtime/dashboard-event-fanout.js";
import { registerAdminMaintenanceRoutes } from "./routes/admin-maintenance-routes.js";
import { registerBuyRoutes } from "./routes/buy-routes.js";
import { registerDashboardRoutes } from "./routes/dashboard-routes.js";
import { registerDemoRunRoutes } from "./routes/demo-run-routes.js";
import { registerErpRoutes } from "./routes/erp-routes.js";
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
import type { DashboardRecoveryAdmissionController } from "./services/dashboard-recovery-admission.js";
import type { DashboardRecoveryService } from "./services/dashboard-recovery-service.js";
import { DashboardRecoveryWorkflow } from "./services/dashboard-recovery-workflow.js";
import type { DemoMaintenanceService } from "./services/demo-maintenance-service.js";
import type { DemoPresetController } from "./services/demo-preset-service.js";
import type { DemoRunLifecycleController } from "./services/demo-run-service.js";
import type { ErpStatusService } from "./services/erp-status-service.js";
import type { InventoryStatusService } from "./services/inventory-status-service.js";
import type { OrderStatusController } from "./services/order-status-service.js";
import type { PublicRuntimePolicyController } from "./services/public-runtime-policy-service.js";
import type { QueueStatusService } from "./services/queue-status-service.js";
import type { ReserveOrderService } from "./services/reserve-order-service.js";
import type { RunHistoryController } from "./services/run-history-service.js";
import type { TrafficCompletionController } from "./services/traffic-completion-service.js";
import type { TrafficMetricIngestionController } from "./services/traffic-metric-ingestion-service.js";

export interface BuildApiServerOptions {
  config: ApiConfig;
  logger: CheckoutSurgeLogger;
  readiness: ApiReadiness;
  dashboardEventFanout: DashboardEventFanout;
  dashboardRecoveryService: DashboardRecoveryService;
  dashboardRecoveryAdmission: DashboardRecoveryAdmissionController;
  erpStatusService: ErpStatusService;
  inventoryStatusService: InventoryStatusService;
  orderStatusService: OrderStatusController;
  queueStatusService: QueueStatusService;
  reserveOrderService: ReserveOrderService;
  presetService: DemoPresetController;
  runtimePolicyService: PublicRuntimePolicyController;
  demoRunLifecycleService: DemoRunLifecycleController;
  trafficCompletionService: TrafficCompletionController;
  trafficMetricIngestion: TrafficMetricIngestionController;
  demoMaintenanceService: DemoMaintenanceService;
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
  registerErpRoutes(app, { erpStatusService: options.erpStatusService });
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
    demoMaintenanceService: options.demoMaintenanceService,
    controlServiceToken: options.config.controlServiceToken,
  });
  registerRunHistoryRoutes(app, {
    runHistoryService: options.runHistoryService,
    controlServiceToken: options.config.controlServiceToken,
  });
  registerDashboardRoutes(app, {
    dashboardEventFanout: options.dashboardEventFanout,
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
) {
  const payload = createErrorPayload(options);
  return reply.status(statusCode).send(payload);
}
