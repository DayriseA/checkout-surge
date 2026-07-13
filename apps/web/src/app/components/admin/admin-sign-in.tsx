"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminPassphraseHeaderName, adminSessionProxyPath } from "../../lib/control-paths";

export function AdminSignIn() {
  const router = useRouter();
  const [passphrase, setPassphrase] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(adminSessionProxyPath, {
        method: "POST",
        cache: "no-store",
        headers: { [adminPassphraseHeaderName]: passphrase },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setError(readMessage(payload, passphrase));
        return;
      }
      setPassphrase("");
      router.refresh();
    } finally {
      setIsPending(false);
    }
  }

  return (
    <AdminSignInView
      error={error}
      isPending={isPending}
      onPassphraseChange={setPassphrase}
      onSignIn={() => void signIn()}
      passphrase={passphrase}
    />
  );
}

export function AdminSignInView({
  error,
  isPending,
  onPassphraseChange,
  onSignIn,
  passphrase,
}: {
  error: string | null;
  isPending: boolean;
  onPassphraseChange: (value: string) => void;
  onSignIn: () => void;
  passphrase: string;
}) {
  return (
    <section className="max-w-[520px] rounded-lg border border-border bg-surface p-4">
      <div className="mb-4">
        <p className="m-0 text-xs font-bold uppercase text-muted">Admin sign-in</p>
        <h2 className="m-0 mt-1 text-base font-bold leading-tight text-ink">
          Protected operator surface
        </h2>
      </div>
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm font-semibold text-muted-strong">
          <span>Admin passphrase</span>
          <input
            className="min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
            onChange={(event) => onPassphraseChange(event.target.value)}
            type="password"
            value={passphrase}
          />
        </label>
        <button
          className="min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isPending}
          onClick={onSignIn}
          type="button"
        >
          Sign In
        </button>
        {error ? <p className="m-0 text-sm font-semibold text-danger">{error}</p> : null}
      </div>
    </section>
  );
}

function readMessage(payload: unknown, passphrase: string): string {
  const message =
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
      ? payload.message
      : null;
  return message && (!passphrase || !message.includes(passphrase))
    ? message
    : "Admin sign-in failed.";
}
