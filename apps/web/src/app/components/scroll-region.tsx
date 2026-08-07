// biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/noRedundantRoles: C03 explicitly requires role=region and keyboard focus on protected horizontal scroll regions.
import type { ReactNode } from "react";

export function ScrollRegion({
  accessibleName,
  children,
}: {
  accessibleName: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-3 min-w-0 max-w-full">
      <p className="m-0 mb-1 text-xs text-muted">Scrolls sideways.</p>
      <section
        aria-label={accessibleName}
        className="w-full min-w-0 max-w-full overflow-x-auto"
        role="region"
        tabIndex={0}
      >
        {children}
      </section>
    </div>
  );
}
