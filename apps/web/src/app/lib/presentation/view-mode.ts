export type ViewMode = "basic" | "advanced";
export const viewModeCookieName = "checkout-surge.view";

export function parseViewMode(raw: string | undefined | null): ViewMode {
  return raw === "advanced" ? "advanced" : "basic";
}
