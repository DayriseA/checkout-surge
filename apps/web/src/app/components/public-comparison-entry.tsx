"use client";

import { startComparisonResponseSchema } from "@checkout-surge/contracts";
import { useEffect, useRef, useState } from "react";
import type { CompletedBackendRead } from "../lib/api";
import { readProxyJson } from "../lib/client/proxy-json";
import { comparisonStartProxyPath } from "../lib/control-paths";
import { primaryButtonClassName } from "./control-styles";
import { ErrorNotice } from "./error-notice";

export function PublicComparisonEntry() {
  const [starting, setStarting] = useState(false);
  const [failure, setFailure] = useState<CompletedBackendRead<never> | null>(null);
  const [waiting, setWaiting] = useState(false);
  const inFlightRef = useRef(false);
  const retryUntilRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(
      () => setWaiting(false),
      Math.max(0, retryUntilRef.current - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [waiting]);

  async function start() {
    if (inFlightRef.current || Date.now() < retryUntilRef.current) return;
    inFlightRef.current = true;
    setStarting(true);
    setFailure(null);
    const result = await readProxyJson(comparisonStartProxyPath, startComparisonResponseSchema, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!mountedRef.current) return;
    if (result.status === "available") {
      window.location.assign(
        `/watch?${new URLSearchParams({ comparisonId: result.data.comparisonId })}`,
      );
      return;
    }
    inFlightRef.current = false;
    setStarting(false);
    setFailure(result);
    retryUntilRef.current = Date.now() + (result.retryAfterMs ?? 0);
    setWaiting((result.retryAfterMs ?? 0) > 0);
  }

  return (
    <section
      aria-labelledby="comparison-title"
      className="mb-5 rounded-2xl border border-border bg-surface p-5"
    >
      <h2 id="comparison-title" className="type-title m-0 text-xl text-ink">
        See what Redis and an order queue change
      </h2>
      <p className="mt-2 max-w-[70ch] leading-6 text-muted-strong">
        See how Redis changes stock checks, then how an order queue changes buyers’ wait.
      </p>
      <button
        className={primaryButtonClassName}
        disabled={starting || waiting}
        onClick={() => void start()}
        type="button"
      >
        {starting ? "Starting your comparison…" : "Start comparison"}
      </button>
      <p className="mb-0 mt-2 text-sm text-muted">
        Simulated buyers and orders. Results are measured live.
      </p>
      {failure ? <ErrorNotice className="mt-3" context="public-start" read={failure} /> : null}
    </section>
  );
}
