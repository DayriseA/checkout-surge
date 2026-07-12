import type {
  BusinessOutcomeSummary,
  TerminalInventorySnapshot,
  TrafficDeliverySummary,
  TrafficHttpSummary,
} from "@checkout-surge/contracts";
import type { DemoRunStatus, DemoRunTrafficStatus, demoRuns } from "@checkout-surge/db";

export type TerminalDemoRunStatus = "completed" | "failed";

export interface TerminalDemoRunTransitionInput {
  runId: string;
  terminalStatus: TerminalDemoRunStatus;
  failureReason: string | null;
  finalizedAt: Date;
  allowedCurrentStatuses: DemoRunStatus[];
  terminalTrafficStatus?: DemoRunTrafficStatus;
}

export interface TerminalDemoRunSummaryInput {
  run: typeof demoRuns.$inferSelect;
  terminalStatus: TerminalDemoRunStatus;
  failureReason: string | null;
  finalizedAt: Date;
  capturedAt?: Date;
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
  httpTimingBreakdownSummary: Record<string, unknown>;
  loadRunDiagnosticsSummary: Record<string, unknown>;
  apiRequestLifecycleSummary: Record<string, unknown>;
  businessOutcome: BusinessOutcomeSummary;
  terminalInventorySnapshot: TerminalInventorySnapshot | null;
  allowedCurrentStatuses: DemoRunStatus[];
  terminalTrafficStatus?: DemoRunTrafficStatus;
}

export interface TerminalDemoRunWriter {
  claimTerminalRun(input: TerminalDemoRunTransitionInput): Promise<boolean>;
  write(input: TerminalDemoRunSummaryInput): Promise<boolean>;
  writeAfterTerminalClaim(input: TerminalDemoRunSummaryInput): Promise<boolean>;
  writeAfterTerminalClaims(inputs: TerminalDemoRunSummaryInput[]): Promise<number>;
}
