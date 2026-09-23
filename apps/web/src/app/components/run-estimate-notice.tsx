import { estimateRejectionCopy } from "../lib/presentation/estimate-presentation";
import type { RunEstimateState } from "./use-run-estimate";

export function RunEstimateNotice({
  state,
  mode,
}: {
  state: RunEstimateState;
  mode: "public" | "admin";
}) {
  if (state.status !== "unavailable" && state.status !== "rejected") return null;
  const lines =
    state.status === "unavailable"
      ? ["Preview unavailable. You can try starting; the server will check admission again."]
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
