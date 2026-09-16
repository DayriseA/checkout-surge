import "server-only";

import { cookies } from "next/headers";
import {
  parseViewMode,
  type ViewMode,
  type ViewPage,
  viewModeCookieName,
} from "../presentation/view-mode";

export async function readPageViewMode(page: ViewPage): Promise<ViewMode> {
  try {
    const value = (await cookies()).get(viewModeCookieName(page))?.value;
    return parseViewMode(value);
  } catch {
    return "basic";
  }
}
