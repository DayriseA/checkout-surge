"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminSessionProxyPath } from "../lib/control-paths";

export function AdminSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      className="inline-flex min-h-11 items-center rounded-lg px-2.5 py-2 text-sm font-semibold text-muted-strong hover:bg-surface-muted hover:text-ink disabled:opacity-60"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch(adminSessionProxyPath, { method: "DELETE", cache: "no-store" });
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
      type="button"
    >
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
