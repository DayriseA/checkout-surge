import { AdminConsole } from "../components/admin-console";
import { StatusPill } from "../components/status-pill";

export default function AdminPage() {
  return (
    <>
      <header className="mb-4 grid grid-cols-[1fr_auto] items-end gap-4 max-[900px]:grid-cols-1 max-[900px]:items-start">
        <div>
          <h1 className="m-0 text-4xl font-bold leading-tight text-ink">Admin console</h1>
          <p className="mt-3 max-w-[66ch] leading-6 text-muted">
            Protected operator controls and service state for supervised demo runs.
          </p>
        </div>
        <StatusPill label="access required" tone="pending" />
      </header>
      <AdminConsole />
    </>
  );
}
