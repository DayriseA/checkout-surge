import type { Comparison } from "@checkout-surge/contracts";
import { publicNarrative } from "./presentation/public-vocabulary";

/** Every route of the site that a page links to. */
export const sitePages = {
  home: "/",
  demo: "/demo",
  watch: "/watch",
  runHistory: "/run-history",
  admin: "/admin",
  howItWorks: "/how-it-works",
  limits: "/limits",
  underTheHood: "/under-the-hood",
} as const;

/** The anchors other pages link to, by page. Each page renders its anchors from here. */
export const siteAnchors = {
  howItWorks: {
    threeNumbers: "three-numbers",
    waitingRoom: "waiting-room",
    stockInMemory: "stock-in-memory",
    yesNow: "yes-now-confirm-later",
    safeRetries: "safe-retries",
    atItsScale: "at-its-scale",
    queueComparison: "queue-comparison",
    redisComparison: "redis-comparison",
  },
  limits: {
    realAndSimulated: "real-and-simulated",
    scale: "scale",
    runLimits: "run-limits",
    comparisonLimits: "comparison-limits",
    production: "production",
    knownDefects: "known-defects",
  },
  underTheHood: {
    architecture: "architecture",
    buyPath: "buy-path",
    safetyNets: "safety-nets",
    runs: "runs",
    signals: "signals",
    measurement: "measurement",
    hosting: "hosting",
    glossary: "glossary",
  },
} as const;

type AnchoredPage = keyof typeof siteAnchors;

export function siteLink<P extends AnchoredPage>(
  page: P,
  anchor: keyof (typeof siteAnchors)[P],
): string {
  return `${sitePages[page]}#${siteAnchors[page][anchor] as string}`;
}

/** The section of How it works that explains each comparison. */
export const comparisonExplanationLinks: Record<Comparison, string> = {
  order_queue: siteLink("howItWorks", "queueComparison"),
  redis: siteLink("howItWorks", "redisComparison"),
};

export const comparisonLimitsLink = siteLink("limits", "comparisonLimits");

/** The heading ID of a preset's card on the demo page, so other pages can link to the card. */
export function presetCardId(slug: string): string {
  return `${slug}-title`;
}

export function presetCardLink(slug: string): string {
  return `${sitePages.demo}#${presetCardId(slug)}`;
}

/** A file of the repository on GitHub, optionally at a heading's anchor. */
export function repositoryFileLink(path: string, anchor?: string): string {
  return `${publicNarrative.repositoryUrl}/blob/main/${path}${anchor ? `#${anchor}` : ""}`;
}
