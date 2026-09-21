import { estimateRejectionCopy } from "../lib/presentation/estimate-presentation";
import type { RunEstimateState } from "./use-run-estimate";

export function RunEstimateNotice({
  state,
  mode,
}: {
  state: RunEstimateState;
  mode: "public" | "admin";
}) {
  if (state.status === "inactive") return null;
  const lines =
    state.status === "pending"
      ? ["Checking whether this configuration is allowed…"]
      : state.status === "unavailable"
        ? ["Preview unavailable. You can try starting; the server will check admission again."]
        : state.status === "allowed"
          ? ["Configuration allowed. Admission is checked again when you start."]
          : estimateRejectionCopy(state.result, mode);
  return (
    <div role="status" aria-live="polite" className="my-2 text-sm text-muted-strong">
      {[...new Set(lines)].map((line) => (
        <p className="m-0" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}
