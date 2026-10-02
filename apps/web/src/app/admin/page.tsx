import type { Metadata } from "next";
import { AdminAuthenticatedSurface } from "../components/admin/admin-authenticated-surface";
import { AdminSignIn } from "../components/admin/admin-sign-in";
import { pendingDashboardRecovery } from "../lib/api";
import { hasValidAdminPageSession } from "../lib/server/admin-page-session";
import {
  readAdminPresets,
  readAdminReadiness,
  readAdminRuntimePolicy,
} from "../lib/server/admin-reads";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const authenticated = await hasValidAdminPageSession();
  const reads = authenticated
    ? await Promise.all([readAdminPresets(), readAdminRuntimePolicy(), readAdminReadiness()])
    : null;
  return (
    <>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-2">
        <h1 className="type-display m-0 text-[clamp(2rem,4vw,2.75rem)] leading-none text-ink">
          Admin console
        </h1>
        <p className="m-0 max-w-[52ch] leading-6 text-muted">
          Protected operator controls and service state for supervised demo runs.
        </p>
      </header>
      {reads ? (
        <AdminAuthenticatedSurface
          initialPresets={reads[0]}
          initialRecovery={pendingDashboardRecovery()}
          initialReadiness={reads[2]}
          initialRuntimePolicy={reads[1]}
        />
      ) : (
        <AdminSignIn />
      )}
    </>
  );
}
