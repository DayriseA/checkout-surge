import type { RunErpOutcomeSummary } from "@checkout-surge/contracts";
import { getTranslation, type Locale } from "../i18n/translate";

/**
 * The one public sentence the run-scoped simulated-ERP surface leads with.
 *
 * This lives beside `run-presentation-state.ts` rather than inside it because that module derives
 * `PresentationState` for status pills (state name, tone, label, description). The ERP story is a
 * different output: reader-facing panel copy with no tone. `RunErpOutcomeSummary` publishes
 * attempt counts and no interpretation, so the sentence is derived here.
 *
 * Evidence-only wording: attempt counts alone say nothing about throughput or recovery, so the
 * sentence reports what the window contains and never claims the ERP is keeping up.
 */
const erpStorySentence = {
  withFailures: "Recent simulated-ERP calls include failures or timeouts",
  allSucceeded: "Recent simulated-ERP calls succeeded",
  /** Field-specific absence: no error tone, and no claim about health. */
  noActivity: "No recent simulated-ERP activity",
} as const;

export function deriveRunErpStory(erp: RunErpOutcomeSummary | null, locale: Locale = "en"): string {
  const t = getTranslation(locale);
  if (!erp || erp.recentAttemptCount === 0) return t(erpStorySentence.noActivity);
  return erp.recentFailureCount + erp.recentTimeoutCount > 0
    ? t(erpStorySentence.withFailures)
    : t(erpStorySentence.allSucceeded);
}
