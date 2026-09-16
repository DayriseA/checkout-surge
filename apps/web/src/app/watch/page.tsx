import { type RunHistoryListItem, runHistoryDetailParamsSchema } from "@checkout-surge/contracts";
import type { Metadata } from "next";
import { OperatorDashboard } from "../components/operator-dashboard";
import { PageView } from "../components/page-view";
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
import { readPageViewMode } from "../lib/server/page-view-mode";

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

  const viewMode = await readPageViewMode("watch");

  return (
    <PageView initialMode={viewMode} page="watch">
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Live watch</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Follow a flash sale while it runs: what is happening now, how it finished, and what to
            do next. Technical evidence stays available in the Advanced view.
          </p>
        </div>
      </header>
      <OperatorDashboard
        {...(acceptedResult ? { acceptedResult } : {})}
        initialRecovery={pendingDashboardRecovery()}
        invalidAcceptedRunContext={invalidAcceptedRunContext}
        latestCompletedRun={latestCompletedRun}
      />
    </PageView>
  );
}
