import {
  adminRunHistoryDetailHttpQuerySchema,
  runHistoryDetailParamsSchema,
} from "@checkout-surge/contracts";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { neutralLinkButtonClassName } from "../../components/control-styles";
import { ErrorNotice } from "../../components/error-notice";
import { PageView } from "../../components/page-view";
import { RunHistoryAdminControls } from "../../components/run-history-admin-controls";
import { AdminRunHistoryDetail, PublicRunHistoryDetail } from "../../components/run-history-detail";
import { RunHistoryRowControls } from "../../components/run-history-row-controls";
import { StatusPill } from "../../components/status-pill";
import { getAdminRunHistoryDetail, getRunHistoryDetail } from "../../lib/api";
import { formatDurationMs, formatInstantUtc } from "../../lib/presentation/format";
import {
  runResultOutcomeLabel,
  runResultOutcomeTone,
} from "../../lib/presentation/public-vocabulary";
import { hasValidAdminPageSession } from "../../lib/server/admin-page-session";
import { readPageViewMode } from "../../lib/server/page-view-mode";

export const metadata: Metadata = { title: "Run report" };
export const dynamic = "force-dynamic";

interface RunHistoryDetailPageProps {
  params?: Promise<{
    runId?: string;
  }>;
  searchParams?: Promise<{
    filterKind?: string;
    filterValue?: string;
    limit?: string;
    cursor?: string;
  }>;
}

export default async function RunHistoryDetailPage({
  params,
  searchParams,
}: RunHistoryDetailPageProps) {
  const resolvedParams = await params;
  const runId = resolvedParams?.runId ?? "";
  const parsedParams = runHistoryDetailParamsSchema.safeParse({ runId });
  if (!parsedParams.success) notFound();

  const isAdmin = await hasValidAdminPageSession();
  const viewMode = isAdmin ? "basic" : await readPageViewMode("report");
  const parsedAdminQuery = isAdmin
    ? adminRunHistoryDetailHttpQuerySchema.safeParse((await searchParams) ?? {})
    : null;
  const invalidAdminQuery = parsedAdminQuery?.success === false;
  const adminQuery = parsedAdminQuery?.success ? parsedAdminQuery.data : { limit: 20 };
  const adminDetail =
    isAdmin && adminQuery
      ? await getAdminRunHistoryDetail(parsedParams.data.runId, adminQuery)
      : null;
  const publicDetail = !isAdmin ? await getRunHistoryDetail(parsedParams.data.runId) : null;
  const selectedDetail = adminDetail ?? publicDetail;
  if (
    selectedDetail?.status === "unavailable" &&
    selectedDetail.httpStatus === 404 &&
    selectedDetail.errorCode === "resource_not_found"
  ) {
    notFound();
  }

  if (publicDetail?.status === "available") {
    const { summary, result, overallDurationMs } = publicDetail.data;
    return (
      <PageView initialMode={viewMode} page="report">
        <header className="mb-4">
          <Link className={neutralLinkButtonClassName} href="/run-history">
            Back to run history
          </Link>
          <h1 className="m-0 mt-4 text-4xl font-bold leading-tight text-ink">
            {summary.presetName}
          </h1>
          <p className="m-0 mt-2 max-w-[66ch] leading-6 text-muted">
            Saved run report for a checkout simulation.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <p className="m-0 text-sm text-muted">
              <time dateTime={summary.startedAt ?? summary.endedAt}>
                {formatInstantUtc(summary.startedAt ?? summary.endedAt)}
              </time>
              {" · "}
              {summary.failureCategory === "operator"
                ? "Acceptance-to-stop duration: "
                : "Overall duration: "}
              {formatDurationMs(overallDurationMs) ?? "duration not recorded"}
            </p>
            <StatusPill
              status={{
                label: runResultOutcomeLabel(result.outcome),
                tone: runResultOutcomeTone(result.outcome),
              }}
            />
          </div>
        </header>
        <PublicRunHistoryDetail detail={publicDetail.data} />
      </PageView>
    );
  }

  if (adminDetail?.status === "available") {
    return (
      <RunHistoryAdminControls
        showBulkControls={false}
        showSelectionToolbar={false}
        visibleRunIds={[adminDetail.data.summary.runId]}
      >
        {invalidAdminQuery ? (
          <p
            className="m-0 rounded-lg border border-warning bg-surface p-4 text-sm font-semibold text-warning"
            role="status"
          >
            Invalid search parameters. Showing the unfiltered run detail.
          </p>
        ) : null}
        <AdminRunHistoryDetail
          actions={
            <RunHistoryRowControls
              presetName={adminDetail.data.summary.presetName}
              runId={adminDetail.data.summary.runId}
              showSelection={false}
            />
          }
          detail={adminDetail.data}
          navigation={
            <Link className={`${neutralLinkButtonClassName} mb-4`} href="/run-history">
              Back to run history
            </Link>
          }
        />
      </RunHistoryAdminControls>
    );
  }

  const detail = adminDetail ??
    publicDetail ?? {
      status: "unavailable" as const,
      httpStatus: 404,
      errorCode: "resource_not_found" as const,
      reason: "No finished result exists for this run.",
    };

  const body = isAdmin ? (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <Link className={neutralLinkButtonClassName} href="/run-history">
            Back to run history
          </Link>
          <h1 className="m-0 mt-4 text-4xl font-bold leading-tight text-ink">Run history detail</h1>
          <p className="mt-3 max-w-[66ch] [overflow-wrap:anywhere] leading-6 text-muted">{runId}</p>
        </div>
        <StatusPill
          status={{
            label: "unavailable",
            tone: "danger",
          }}
        />
      </header>
      <section className="rounded-lg border border-border bg-surface p-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Run history detail</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">Detail unavailable</h2>
        <ErrorNotice
          context={{ surface: "history-detail", protected: isAdmin }}
          protectedDetails={isAdmin}
          read={detail}
        />
      </section>
    </>
  ) : (
    <>
      <header className="mb-4">
        <h1 className="m-0 text-4xl font-bold leading-tight text-ink">
          This report is not available
        </h1>
        <p className="mt-3 max-w-[66ch] leading-6 text-muted">
          We could not load a saved report from this link.
        </p>
      </header>
      <section className="rounded-lg border border-border bg-surface p-4">
        <ErrorNotice
          context={{ surface: "history-detail", protected: false }}
          protectedDetails={false}
          read={detail}
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <Link className={neutralLinkButtonClassName} href="/run-history">
            Back to run history
          </Link>
          <Link className={neutralLinkButtonClassName} href="/">
            Choose a simulation
          </Link>
        </div>
      </section>
    </>
  );

  if (isAdmin) {
    return body;
  }

  return (
    <PageView initialMode={viewMode} page="report">
      {body}
    </PageView>
  );
}
