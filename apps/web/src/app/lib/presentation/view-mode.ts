export type ViewMode = "basic" | "advanced";
export type ViewPage = "demo" | "watch" | "about" | "history" | "report";

export function viewModeCookieName(page: ViewPage): string {
  return `checkout-surge.view.${page}`;
}

export function parseViewMode(raw: string | undefined | null): ViewMode {
  return raw === "advanced" ? "advanced" : "basic";
}
