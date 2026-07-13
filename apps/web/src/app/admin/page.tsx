import { AdminAuthenticatedSurface } from "../components/admin/admin-authenticated-surface";
import { AdminSignIn } from "../components/admin/admin-sign-in";
import { StatusPill } from "../components/status-pill";
import { hasValidAdminPageSession } from "../lib/server/admin-page-session";
import {
  readAdminErpChaos,
  readAdminPresets,
  readAdminRecovery,
  readAdminRuntimePolicy,
} from "../lib/server/admin-reads";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const authenticated = await hasValidAdminPageSession();
  const reads = authenticated
    ? await Promise.all([
        readAdminErpChaos(),
        readAdminPresets(),
        readAdminRecovery(),
        readAdminRuntimePolicy(),
      ])
    : null;
  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Admin console</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Protected operator controls and service state for supervised demo runs.
          </p>
        </div>
        <StatusPill
          label={authenticated ? "authenticated" : "access required"}
          tone={authenticated ? "ok" : "pending"}
        />
      </header>
      {reads ? (
        <AdminAuthenticatedSurface
          initialErpChaos={reads[0]}
          initialPresets={reads[1]}
          initialRecovery={reads[2]}
          initialRuntimePolicy={reads[3]}
        />
      ) : (
        <AdminSignIn />
      )}
    </>
  );
}
