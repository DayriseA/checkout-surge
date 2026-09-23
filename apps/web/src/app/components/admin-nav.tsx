"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminSessionProxyPath } from "../lib/control-paths";

export function AdminSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        className="inline-flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white disabled:opacity-60 max-[900px]:text-muted-strong max-[900px]:hover:bg-surface-muted max-[900px]:hover:text-ink"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setFailed(false);
          try {
            const response = await fetch(adminSessionProxyPath, {
              method: "DELETE",
              cache: "no-store",
            });
            if (!response.ok) {
              setFailed(true);
              return;
            }
            router.refresh();
          } catch {
            setFailed(true);
          } finally {
            setPending(false);
          }
        }}
        type="button"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {failed ? (
        <p className="m-0 text-sm font-semibold text-signal max-[900px]:text-danger" role="alert">
          Admin sign-out failed.
        </p>
      ) : null}
    </div>
  );
}
