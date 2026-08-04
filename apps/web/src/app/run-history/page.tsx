import type { RunHistoryListResponse } from "@checkout-surge/contracts";
import { ErrorNotice } from "../components/error-notice";
import { RunHistoryAdminControls } from "../components/run-history-admin-controls";
import { RunHistoryList } from "../components/run-history-list";
import { StatusPill } from "../components/status-pill";
import { getRunHistoryPage } from "../lib/api";
import { formatCount } from "../lib/presentation/format";
import { hasValidAdminPageSession } from "../lib/server/admin-page-session";

export const dynamic = "force-dynamic";

interface RunHistoryPageProps {
  searchParams?: Promise<{
    page?: string;
  }>;
}

const pageSize = 10;

export default async function RunHistoryPage({ searchParams }: RunHistoryPageProps) {
  const resolvedSearchParams = await searchParams;
  const page = parsePositiveInteger(resolvedSearchParams?.page, 1);
  const history = await getRunHistoryPage(page, pageSize);
  const authenticated = await hasValidAdminPageSession();
  const summaryCount =
    history.status === "available"
      ? `${formatCount(history.data.totalCount) ?? "an unknown number of"} summaries`
      : "unavailable";

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Run history</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Finished flash-sale scenarios, inventory evidence, buyer observations, and durable
            checkout outcomes.
          </p>
        </div>
        <StatusPill
          status={{
            label: summaryCount,
            tone: history.status === "available" ? "ok" : "danger",
          }}
        />
      </header>
      {history.status === "available" ? (
        <HistorySurface authenticated={authenticated} history={history.data} />
      ) : (
        <section className="rounded-lg border border-border bg-surface p-4">
          <p className="m-0 text-xs font-bold uppercase text-muted">Finished runs</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            History unavailable
          </h2>
          <ErrorNotice
            context={{ surface: "history-read", protected: authenticated }}
            protectedDetails={authenticated}
            read={history}
          />
        </section>
      )}
    </>
  );
}

/** Admin sessions get the deletion provider wrapped around the same public list. */
function HistorySurface({
  authenticated,
  history,
}: {
  authenticated: boolean;
  history: RunHistoryListResponse;
}) {
  const list = <RunHistoryList history={history} />;

  if (!authenticated) {
    return list;
  }

  return (
    <RunHistoryAdminControls visibleRunIds={history.summaries.map((summary) => summary.runId)}>
      {list}
    </RunHistoryAdminControls>
  );
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
