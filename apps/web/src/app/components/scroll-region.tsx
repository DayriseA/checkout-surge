// biome-ignore-all lint/a11y/noNoninteractiveTabindex lint/a11y/noRedundantRoles: Protected horizontal scroll regions need role=region and keyboard focus.
"use client";

import type { ReactNode } from "react";
import { useTranslation } from "../lib/i18n/locale-context";

export function ScrollRegion({
  accessibleName,
  children,
}: {
  accessibleName: string;
  children: ReactNode;
}) {
  const t = useTranslation();
  return (
    <div className="mt-3 min-w-0 max-w-full">
      <p className="m-0 mb-1 text-xs text-muted">{t("Scrolls sideways.")}</p>
      <section
        aria-label={t(accessibleName)}
        className="w-full min-w-0 max-w-full overflow-x-auto"
        role="region"
        tabIndex={0}
      >
        {children}
      </section>
    </div>
  );
}
