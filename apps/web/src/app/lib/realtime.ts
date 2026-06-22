import { dashboardEventsPath } from "@checkout-surge/contracts";

const DEFAULT_BROWSER_API_BASE_URL = "http://localhost:4000";

export function dashboardEventsUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_BROWSER_API_BASE_URL;

  return `${baseUrl.replace(/\/+$/, "")}${dashboardEventsPath}`;
}
