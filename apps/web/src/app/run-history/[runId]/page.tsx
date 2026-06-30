import Link from "next/link";
import { RunHistoryDetail } from "../../components/run-history-detail";
import { StatusPill } from "../../components/status-pill";
import { getRunHistoryDetail } from "../../lib/api";

interface RunHistoryDetailPageProps {
  params?: Promise<{
    runId?: string;
  }>;
}

export default async function RunHistoryDetailPage({ params }: RunHistoryDetailPageProps) {
  const resolvedParams = await params;
  const runId = resolvedParams?.runId ?? "";
  const detail = await getRunHistoryDetail(runId);

  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <Link
            className="inline-flex min-h-10 items-center rounded-lg border border-border px-3.5 py-2.5 text-sm font-semibold text-muted-strong"
            href="/run-history"
          >
            Back to run history
          </Link>
          <h1 className="m-0 mt-4 text-4xl font-bold leading-tight text-ink">Run history detail</h1>
          <p className="mt-3 max-w-[66ch] [overflow-wrap:anywhere] leading-6 text-muted">{runId}</p>
        </div>
        <StatusPill
          label={detail.status === "available" ? "available" : statusLabel(detail.httpStatus)}
          tone={detail.status === "available" ? "ok" : "blocked"}
        />
      </header>
      {detail.status === "available" ? (
        <RunHistoryDetail detail={detail.data} />
      ) : (
        <section className="rounded-lg border border-border bg-surface p-4">
          <p className="m-0 text-xs font-bold uppercase text-muted">Run history detail</p>
          <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
            {detail.httpStatus === 404 ? "Run not found" : "Detail unavailable"}
          </h2>
          <p className="m-0 mt-3 max-w-[66ch] text-sm font-semibold leading-6 text-danger">
            {detail.httpStatus === 404 ? "No terminal summary exists for this run." : detail.reason}
          </p>
        </section>
      )}
    </>
  );
}

function statusLabel(httpStatus: number | undefined): string {
  return httpStatus === 404 ? "not found" : "unavailable";
}
