/**
 * Locates a finding's own section inside its source report markdown.
 *
 * The three reports use different heading conventions, so the matcher is
 * derived from the finding code rather than storing exact heading strings
 * (which would be fragile against dash variants):
 *   opus-4.8 / glm-5.2  →  "### Finding <n> — <title>"
 *   gpt-5.5             →  "### P1-01 - <title>"
 * Opus's lower-confidence notes (N*) have no headings of their own.
 */
export function findingHeadingPattern(model: string, code: string): RegExp | null {
  if (code.startsWith("N")) return null;
  if (model === "gpt-5.5") {
    return new RegExp(`^###\\s+${escapeRegExp(code)}\\s`);
  }
  const number = code.replace(/^F/, "");
  return new RegExp(`^###\\s+Finding\\s+${escapeRegExp(number)}\\s`);
}

export function extractSection(markdown: string, model: string, code: string): string | null {
  const pattern = findingHeadingPattern(model, code);
  if (!pattern) return null;

  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => pattern.test(line));
  if (start === -1) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  return lines
    .slice(start, end)
    .join("\n")
    .replace(/\n-{3,}\s*$/g, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
