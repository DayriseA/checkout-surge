"use client";

import { createContext, useContext } from "react";

export interface RunHistoryRowAdminValue {
  isSelected: (runId: string) => boolean;
  toggleSelection: (runId: string) => void;
  requestRunDeletion: (runId: string, presetName: string) => void;
  requestDeleteAll: () => void;
}

const RunHistoryAdminContext = createContext<RunHistoryRowAdminValue | null>(null);

export const RunHistoryAdminProvider = RunHistoryAdminContext.Provider;

/** Returns null for unauthenticated visitors, whose tree has no admin provider. */
export function useRunHistoryRowAdmin(): RunHistoryRowAdminValue | null {
  return useContext(RunHistoryAdminContext);
}
