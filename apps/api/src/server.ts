import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { DashboardProjectionFanout } from "./realtime/dashboard-projection-fanout.js";
import { registerAdminMaintenanceRoutes } from "./routes/admin-maintenance-routes.js";
import { registerPendingRecoveryRoute } from "./routes/api-peer-routes.js";
import { registerBuyRoutes } from "./routes/buy-routes.js";
import {
  type RegisterComparisonRoutesOptions,
  registerComparisonRoutes,
} from "./routes/comparison-routes.js";
import { registerCoreIdleRoutes } from "./routes/core-idle-routes.js";
import { registerDashboardRoutes } from "./routes/dashboard-routes.js";
import { registerDemoRunRoutes } from "./routes/demo-run-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerInventoryRoutes } from "./routes/inventory-routes.js";
import { registerOrderStatusRoutes } from "./routes/order-status-routes.js";
import { registerQueueRoutes } from "./routes/queue-routes.js";
import { registerRunHistoryRoutes } from "./routes/run-history-routes.js";
import { buildApiHttpServer } from "./runtime/api-http-server.js";
import type { ApiConfig } from "./runtime/config.js";
import { createDashboardSourceResolver } from "./runtime/dashboard-source-identity.js";
import type { ApiFastifyInstance } from "./runtime/fastify.js";
import type { ApiReadiness } from "./runtime/readiness.js";
import type { AdminDemoResetWorkflow } from "./services/admin-demo-reset-service.js";
import type { CoreIdleShutdown } from "./services/core-idle-stop.js";
import type { DashboardRecoveryAdmissionController } from "./services/dashboard-recovery-admission.js";
import type { DashboardProjectionService } from "./services/dashboard-recovery-service.js";
import { DashboardRecoveryWorkflow } from "./services/dashboard-recovery-workflow.js";
import type { DemoPresetController } from "./services/demo-preset-service.js";
import type { DemoRunLifecycleController } from "./services/demo-run-service.js";
import type { GeneratedRunRetentionWorkflow } from "./services/generated-run-retention-service.js";
import type { GeneratedRunTeardownWorkflow } from "./services/generated-run-teardown-service.js";
import type { InventoryStatusService } from "./services/inventory-status-service.js";
import type { OrderStatusController } from "./services/order-status-service.js";
import type { PublicRuntimePolicyController } from "./services/public-runtime-policy-service.js";
import type { QueueStatusService } from "./services/queue-status-service.js";
import type {
  PendingPersistenceRecovery,
  ReserveOrderService,
} from "./services/reserve-order-service.js";
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
  reserveOrderService: Pick<ReserveOrderService, "reserve">;
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
  coreIdleShutdown: CoreIdleShutdown;
  comparison: Pick<RegisterComparisonRoutesOptions, "comparisonService" | "comparisonReader">;
  pendingPersistenceRecovery?: PendingPersistenceRecovery;
  startedAt?: Date;
}

export async function buildApiServer(options: BuildApiServerOptions): Promise<ApiFastifyInstance> {
  const app = await buildApiHttpServer(options);

  registerHealthRoutes(app, {
    readiness: options.readiness,
    ...(options.startedAt ? { startedAt: options.startedAt } : {}),
  });
  registerCoreIdleRoutes(app, { coreIdleShutdown: options.coreIdleShutdown });
  if (options.config.role !== "control") {
    registerBuyRoutes(app, { reserveOrderService: options.reserveOrderService });
  }
  if (options.config.role === "control" && options.pendingPersistenceRecovery) {
    registerPendingRecoveryRoute(app, {
      controlServiceToken: options.config.controlServiceToken,
      recovery: options.pendingPersistenceRecovery,
    });
  }
  registerInventoryRoutes(app, { inventoryStatusService: options.inventoryStatusService });
  registerOrderStatusRoutes(app, { orderStatusService: options.orderStatusService });
  registerQueueRoutes(app, { queueStatusService: options.queueStatusService });
  registerComparisonRoutes(app, {
    ...options.comparison,
    admission: options.dashboardRecoveryAdmission,
    sourceResolver: createDashboardSourceResolver(options.config.publicClientCookieSecret),
    controlServiceToken: options.config.controlServiceToken,
    timeoutMs: options.config.dashboardRecoveryTimeoutMs,
    retryAfterSeconds: options.config.dashboardRecoveryRetryAfterSeconds,
  });
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
