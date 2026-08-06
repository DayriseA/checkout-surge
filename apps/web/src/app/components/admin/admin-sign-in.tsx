"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { adminPassphraseHeaderName, adminSessionProxyPath } from "../../lib/control-paths";

const maximumTimeoutMs = 2_147_483_647;

export function AdminSignIn() {
  const router = useRouter();
  const [passphrase, setPassphrase] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryUntil, setRetryUntil] = useState<number | null>(null);

  useEffect(() => {
    if (retryUntil === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleExpiry = () => {
      const remainingMs = retryUntil - Date.now();
      if (remainingMs <= 0) {
        setRetryUntil(null);
        return;
      }
      timer = setTimeout(scheduleExpiry, Math.min(remainingMs, maximumTimeoutMs));
    };
    scheduleExpiry();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [retryUntil]);

  async function signIn() {
    if (retryUntil !== null) return;
    setIsPending(true);
    setError(null);
    try {
      const response = await fetch(adminSessionProxyPath, {
        method: "POST",
        cache: "no-store",
        headers: { [adminPassphraseHeaderName]: passphrase },
      });
      await response.json().catch(() => null);
      if (!response.ok) {
        setError(response.status === 429 ? "Too many sign-in attempts." : "Admin sign-in failed.");
        if (response.status === 429) {
          const retryAfterMs = parseLoginRetryAfterMs(response.headers.get("retry-after"));
          if (retryAfterMs !== undefined && retryAfterMs > 0) {
            setRetryUntil(Date.now() + retryAfterMs);
          }
        }
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
      retryAfterMs={retryUntil === null ? null : Math.max(0, retryUntil - Date.now())}
      onPassphraseChange={setPassphrase}
      onSignIn={() => void signIn()}
      passphrase={passphrase}
    />
  );
}

/** Login admission is same-origin and authoritative; unlike dashboard retries, it is not capped. */
export function parseLoginRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const seconds = Number(value.trim());
  const milliseconds = seconds * 1_000;
  return Number.isSafeInteger(seconds) && Number.isSafeInteger(milliseconds)
    ? milliseconds
    : undefined;
}

export function AdminSignInView({
  error,
  isPending,
  retryAfterMs,
  onPassphraseChange,
  onSignIn,
  passphrase,
}: {
  error: string | null;
  isPending: boolean;
  retryAfterMs: number | null;
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
      <form
        aria-busy={isPending}
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSignIn();
        }}
      >
        <label className="grid gap-1 text-sm font-semibold text-muted-strong">
          <span>Admin passphrase</span>
          <input
            autoComplete="current-password"
            className="min-h-10 min-w-0 rounded-lg border border-border bg-bg px-3 py-2 text-ink"
            disabled={isPending || retryAfterMs !== null}
            name="passphrase"
            onChange={(event) => onPassphraseChange(event.target.value)}
            type="password"
            value={passphrase}
          />
        </label>
        <button
          className="min-h-10 rounded-lg border border-accent bg-accent px-3.5 py-2.5 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isPending || retryAfterMs !== null}
          type="submit"
        >
          {isPending ? "Signing in…" : "Sign in"}
        </button>
        {error ? (
          <p className="m-0 text-sm font-semibold text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {retryAfterMs !== null && retryAfterMs > 0 ? (
          <p aria-live="polite" className="m-0 text-sm text-muted" role="status">
            Wait {Math.ceil(retryAfterMs / 1_000)} seconds before trying again.
          </p>
        ) : null}
      </form>
    </section>
  );
}
