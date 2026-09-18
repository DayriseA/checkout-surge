import { type RunHistoryListItem, runHistoryDetailParamsSchema } from "@checkout-surge/contracts";
import type { Metadata } from "next";
import { OperatorDashboard } from "../components/operator-dashboard";
import {
  type BackendRead,
  getRunHistoryDetail,
  getRunHistoryPage,
  pendingDashboardRecovery,
} from "../lib/api";
import {
  type AcceptedRunResult,
  acceptedRunResultFromRead,
} from "../lib/presentation/accepted-run-result";

export const metadata: Metadata = { title: "Live watch" };
export const dynamic = "force-dynamic";

export default async function WatchPage({
  searchParams,
}: {
  searchParams?: Promise<{ acceptedRunId?: string | string[] }>;
} = {}) {
  const acceptedRunId = (await searchParams)?.acceptedRunId;
  const hasAcceptedContext = acceptedRunId !== undefined;
  const parsedAcceptedRun = runHistoryDetailParamsSchema.safeParse({ runId: acceptedRunId });
  const invalidAcceptedRunContext = hasAcceptedContext && !parsedAcceptedRun.success;
  let acceptedResult: AcceptedRunResult | undefined;
  let latestCompletedRun: BackendRead<RunHistoryListItem | null> = {
    status: "available",
    data: null,
  };

  if (parsedAcceptedRun.success) {
    acceptedResult = acceptedRunResultFromRead(
      parsedAcceptedRun.data.runId,
      await getRunHistoryDetail(parsedAcceptedRun.data.runId),
    );
  } else if (!hasAcceptedContext) {
    const history = await getRunHistoryPage(1, 1);
    latestCompletedRun =
      history.status === "available"
        ? { status: "available" as const, data: history.data.summaries[0] ?? null }
        : history;
  }

  return (
    <>
      <header className="mb-2 flex items-baseline gap-4 max-[900px]:block">
        <h1 className="m-0 shrink-0 text-2xl font-bold leading-tight text-ink">Live watch</h1>
        <p className="m-0 text-sm leading-5 text-muted max-[900px]:mt-1">
          Follow the flash sale from live activity to the final result; technical details are
          available below.
        </p>
      </header>
      <OperatorDashboard
        {...(acceptedResult ? { acceptedResult } : {})}
        initialRecovery={pendingDashboardRecovery()}
        invalidAcceptedRunContext={invalidAcceptedRunContext}
        latestCompletedRun={latestCompletedRun}
      />
    </>
  );
}
