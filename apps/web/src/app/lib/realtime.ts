import { dashboardEventsPath } from "@checkout-surge/contracts";

export function dashboardEventsUrl(): string {
  return process.env.NEXT_PUBLIC_DASHBOARD_EVENTS_URL?.trim() || dashboardEventsPath;
}
