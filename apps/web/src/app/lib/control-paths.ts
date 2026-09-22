export const dashboardRecoveryProxyPath = "/api/dashboard/recovery" as const;
export const healthReadyProxyPath = "/api/health/ready" as const;
export const demoRunEstimateProxyPath = "/api/demo/runs/estimate" as const;
export const adminDemoRunEstimateProxyPath = "/api/admin/demo/runs/estimate" as const;
export const demoRunStartProxyPath = "/api/demo/runs/start" as const;
export function publicRunHistoryDetailProxyPath(runId: string): string {
  return `/api/demo/runs/history/${encodeURIComponent(runId)}`;
}
export const adminDemoRunStartProxyPath = "/api/admin/demo/runs/start" as const;
export const adminPresetListProxyPath = "/api/admin/demo/presets" as const;
export const adminPresetSaveProxyPath = "/api/admin/demo/presets/save" as const;
export const adminPresetDuplicateProxyPath = "/api/admin/demo/presets/duplicate" as const;
export const adminPresetCopyToCustomProxyPath = "/api/admin/demo/presets/copy-to-custom" as const;
export const adminErpChaosProxyPath = "/api/admin/erp-chaos" as const;
export const adminErpChaosResetProxyPath = "/api/admin/erp-chaos/reset" as const;
export const adminDemoResetProxyPath = "/api/admin/demo/reset" as const;
export const adminMaintenanceCleanupRunsProxyPath = "/api/admin/demo/runs/cleanup" as const;
export const adminRunHistoryProxyPath = "/api/admin/demo/runs/history" as const;
export const adminPublicRuntimePolicyProxyPath = "/api/admin/demo/runtime-policy" as const;
export const adminSessionProxyPath = "/api/admin/session" as const;
