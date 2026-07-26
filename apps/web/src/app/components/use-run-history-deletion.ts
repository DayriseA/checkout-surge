"use client";

import { adminDeleteRunHistoryResponseSchema } from "@checkout-surge/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { adminRunHistoryProxyPath } from "../lib/control-paths";

export type DeleteIntent =
  | { kind: "runs"; runIds: string[]; description: string }
  | { kind: "all" };

export interface RunHistoryDeletion {
  selectedRunIds: ReadonlySet<string>;
  toggleSelection: (runId: string) => void;
  toggleAllVisible: () => void;
  clearSelection: () => void;
  intent: DeleteIntent | null;
  openIntent: (next: DeleteIntent) => void;
  closeIntent: () => void;
  confirmDelete: () => Promise<void>;
  deleteAllConfirmation: string;
  setDeleteAllConfirmation: (value: string) => void;
  error: string | null;
  statusMessage: string | null;
  isSubmitting: boolean;
}

export function useRunHistoryDeletion(visibleRunIds: string[]): RunHistoryDeletion {
  const router = useRouter();
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [intent, setIntent] = useState<DeleteIntent | null>(null);
  const [deleteAllConfirmation, setDeleteAllConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggleSelection = useCallback((runId: string) => {
    setSelectedRunIds((current) => {
      const next = new Set(current);
      next.has(runId) ? next.delete(runId) : next.add(runId);
      return next;
    });
  }, []);

  /** Selecting every visible run twice clears it, matching table select-all conventions. */
  const toggleAllVisible = useCallback(() => {
    setSelectedRunIds((current) =>
      visibleRunIds.every((runId) => current.has(runId)) ? new Set() : new Set(visibleRunIds),
    );
  }, [visibleRunIds]);

  const clearSelection = useCallback(() => setSelectedRunIds(new Set()), []);

  const openIntent = useCallback((next: DeleteIntent) => {
    setError(null);
    setStatusMessage(null);
    setIntent(next);
  }, []);

  const closeIntent = useCallback(() => {
    if (isSubmitting) return;
    setIntent(null);
    setDeleteAllConfirmation("");
    setError(null);
  }, [isSubmitting]);

  const confirmDelete = useCallback(async () => {
    if (!intent || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      let response: Response;
      try {
        response = await fetch(adminRunHistoryProxyPath, {
          method: "DELETE",
          cache: "no-store",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(deletionRequestBody(intent, visibleRunIds, deleteAllConfirmation)),
        });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Run History deletion failed.");
        return;
      }

      const payload = await response.json().catch(() => null);
      if (response.status === 401) {
        setIntent(null);
        setSelectedRunIds(new Set());
        setDeleteAllConfirmation("");
        setError(null);
        setStatusMessage(null);
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError(errorMessageFromPayload(payload, "Run History deletion failed."));
        return;
      }

      const parsed = adminDeleteRunHistoryResponseSchema.safeParse(payload);
      if (!parsed.success) {
        setError("Deletion response did not match the shared contract.");
        return;
      }

      setStatusMessage(`Deleted ${parsed.data.deletedSummaryCount} run summaries.`);
      setSelectedRunIds((current) => remainingSelection(current, intent));
      setIntent(null);
      setDeleteAllConfirmation("");
      router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }, [deleteAllConfirmation, intent, isSubmitting, router, visibleRunIds]);

  return {
    selectedRunIds,
    toggleSelection,
    toggleAllVisible,
    clearSelection,
    intent,
    openIntent,
    closeIntent,
    confirmDelete,
    deleteAllConfirmation,
    setDeleteAllConfirmation,
    error,
    statusMessage,
    isSubmitting,
  };
}

function deletionRequestBody(
  intent: DeleteIntent,
  visibleRunIds: string[],
  deleteAllConfirmation: string,
): Record<string, unknown> {
  return intent.kind === "all"
    ? { deleteAllConfirmation }
    : { runIds: intent.runIds, visibleFilter: { runIds: visibleRunIds } };
}

function remainingSelection(current: Set<string>, intent: DeleteIntent): Set<string> {
  if (intent.kind === "all") return new Set();
  const next = new Set(current);
  for (const runId of intent.runIds) next.delete(runId);
  return next;
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  return typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "string"
    ? payload.message
    : fallback;
}
