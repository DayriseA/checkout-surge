import { formatCount } from "./format";

export function formatRunCount(value: number, fallback = "not recorded"): string {
  return `${formatCount(value) ?? fallback} ${value === 1 ? "run" : "runs"}`;
}
