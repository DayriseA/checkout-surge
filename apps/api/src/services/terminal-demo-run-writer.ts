import type {
  BusinessOutcomeSummary,
  DemoRunStatus,
  ServerReservationTimingSummary,
  TerminalInventorySnapshot,
  TrafficDeliverySummary,
  TrafficExecutionStatus,
  TrafficHttpSummary,
  TransportAttemptCounts,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeDatabase, demoRuns } from "@checkout-surge/db";

export type TerminalDemoRunStatus = "completed" | "failed";

export interface TerminalDemoRunTransitionInput {
  runId: string;
  terminalStatus: TerminalDemoRunStatus;
  failureReason: string | null;
  finalizedAt: Date;
  allowedCurrentStatuses: DemoRunStatus[];
  terminalTrafficStatus?: TrafficExecutionStatus;
}

export interface TerminalDemoRunSummaryInput {
  run: typeof demoRuns.$inferSelect;
  terminalStatus: TerminalDemoRunStatus;
  failureReason: string | null;
  finalizedAt: Date;
  capturedAt?: Date;
  transportAttemptCounts: TransportAttemptCounts;
  httpSummary: TrafficHttpSummary;
  trafficDeliverySummary: TrafficDeliverySummary;
  httpTimingBreakdownSummary: Record<string, unknown>;
  serverReservationTimingSummary: ServerReservationTimingSummary;
  loadRunDiagnosticsSummary: Record<string, unknown>;
  businessOutcome: BusinessOutcomeSummary;
  terminalInventorySnapshot: TerminalInventorySnapshot | null;
  allowedCurrentStatuses: DemoRunStatus[];
  terminalTrafficStatus?: TrafficExecutionStatus;
}

export interface TerminalDemoRunWriter {
  claimTerminalRun(input: TerminalDemoRunTransitionInput): Promise<boolean>;
  write(input: TerminalDemoRunSummaryInput): Promise<boolean>;
  writePrepared(
    runId: string,
    prepare: (db: CheckoutSurgeDatabase) => Promise<TerminalDemoRunSummaryInput | null>,
  ): Promise<boolean>;
  writeAfterTerminalClaim(input: TerminalDemoRunSummaryInput): Promise<boolean>;
  writeAfterTerminalClaims(inputs: TerminalDemoRunSummaryInput[]): Promise<number>;
}
