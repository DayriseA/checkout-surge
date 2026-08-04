import { AdminAuthenticatedSurface } from "../components/admin/admin-authenticated-surface";
import { AdminSignIn } from "../components/admin/admin-sign-in";
import { pendingDashboardRecovery } from "../lib/api";
import { hasValidAdminPageSession } from "../lib/server/admin-page-session";
import {
  readAdminErpChaos,
  readAdminReadiness,
  readAdminPresets,
  readAdminRuntimePolicy,
} from "../lib/server/admin-reads";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const authenticated = await hasValidAdminPageSession();
  if (!authenticated) return <AdminSignIn />;
  const reads = await Promise.all([
    readAdminErpChaos(),
    readAdminPresets(),
    readAdminRuntimePolicy(),
    readAdminReadiness(),
  ]);
  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Admin console</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Protected operator controls and service state for supervised demo runs.
          </p>
        </div>
      </header>
      <AdminAuthenticatedSurface
        initialErpChaos={reads[0]}
        initialPresets={reads[1]}
        initialRecovery={pendingDashboardRecovery()}
        initialReadiness={reads[3]}
        initialRuntimePolicy={reads[2]}
      />
    </>
  );
}
