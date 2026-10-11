import {
  comparisonDetailParamsSchema,
  type RunHistoryListItem,
  runHistoryDetailParamsSchema,
} from "@checkout-surge/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { ComparisonWatch } from "../components/comparison-watch";
import { OperatorDashboard } from "../components/operator-dashboard";
import {
  type BackendRead,
  getComparisonDetail,
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
  searchParams?: Promise<{ acceptedRunId?: string | string[]; comparisonId?: string | string[] }>;
} = {}) {
  const query = await searchParams;
  const acceptedRunId = query?.acceptedRunId;
  const comparisonId = query?.comparisonId;
  if (comparisonId !== undefined) {
    const parsed = comparisonDetailParamsSchema.safeParse({ comparisonId });
    if (!parsed.success || acceptedRunId !== undefined) return <InvalidWatchLink />;
    return (
      <ComparisonWatch
        comparisonId={parsed.data.comparisonId}
        initialRead={await getComparisonDetail(parsed.data.comparisonId)}
      />
    );
  }
  const hasAcceptedContext = acceptedRunId !== undefined;
  const parsedAcceptedRun = runHistoryDetailParamsSchema.safeParse({ runId: acceptedRunId });
  const invalidAcceptedRunContext = hasAcceptedContext && !parsedAcceptedRun.success;
  if (invalidAcceptedRunContext) return <InvalidWatchLink />;
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
      <header className="mb-4 flex items-baseline gap-5 max-[900px]:block">
        <h1 className="type-display m-0 shrink-0 text-[1.75rem] leading-none text-ink">
          Live watch
        </h1>
        <p className="m-0 text-sm leading-5 text-muted max-[900px]:mt-1">
          Follow the run from live activity to the final result; technical details are available
          below.
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

function InvalidWatchLink() {
  return (
    <section className="rounded-2xl border border-warning-line bg-warning-soft p-5">
      <h1 className="type-title m-0 text-xl">This Watch link is invalid</h1>
      <p>This link does not identify a saved run or comparison. No result has been selected.</p>
      <div className="flex gap-4">
        <Link href="/run-history">Open run history</Link>
        <Link href="/demo">Choose a simulation</Link>
      </div>
    </section>
  );
}
