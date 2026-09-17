import "server-only";

import { cookies } from "next/headers";
import { parseViewMode, type ViewMode, viewModeCookieName } from "../presentation/view-mode";

export async function readViewMode(): Promise<ViewMode> {
  try {
    const value = (await cookies()).get(viewModeCookieName)?.value;
    return parseViewMode(value);
  } catch {
    return "basic";
  }
}
