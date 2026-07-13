import { RunHistoryAdminControls } from "../components/run-history-admin-controls";
import { RunHistoryList } from "../components/run-history-list";
import { StatusPill } from "../components/status-pill";
import { getRunHistoryPage } from "../lib/api";

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
  const summaryCount =
    history.status === "available" ? `${history.data.totalCount} summaries` : "unavailable";

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Run history</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Completed runs, terminal inventory, traffic summaries, and business outcomes.
          </p>
        </div>
        <StatusPill label={summaryCount} tone={history.status === "available" ? "ok" : "blocked"} />
      </header>
      {history.status === "available" ? (
        <>
          <RunHistoryList history={history.data} />
          <RunHistoryAdminControls summaries={history.data.summaries} />
        </>
      ) : (
        <section className="rounded-lg border border-border bg-surface p-4">
          <p className="m-0 text-xs font-bold uppercase text-muted">Completed runs</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            History unavailable
          </h2>
          <p className="m-0 mt-3 max-w-[66ch] text-sm font-semibold leading-6 text-danger">
            {history.reason}
          </p>
        </section>
      )}
    </>
  );
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
