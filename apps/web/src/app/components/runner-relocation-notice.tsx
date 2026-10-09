import type { DashboardProjection } from "@checkout-surge/contracts";
import type { BackendRead } from "../lib/api";
import { deriveRunPresentationState } from "../lib/presentation/run-presentation-state";

/** Says, in plain words, that the starting run waits for its load generator to move host. */
export function RunnerRelocationNotice({
  recovery,
  className = "",
  announce = true,
}: {
  recovery: BackendRead<DashboardProjection>;
  className?: string;
  /** False inside a container that is already a live region, so it is announced once. */
  announce?: boolean;
}) {
  const presentation = deriveRunPresentationState(recovery);
  if (presentation.state !== "relocating-load-generator") return null;
  return (
    <p
      className={`m-0 rounded-lg border border-warning-line bg-warning-soft p-3 text-sm text-warning ${className}`}
      role={announce ? "status" : undefined}
    >
      {presentation.description}
    </p>
  );
}
