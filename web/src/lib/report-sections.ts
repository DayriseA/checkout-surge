/**
 * Locates a coded section inside its source report markdown.
 *
 * Self-audit reports use F{n}/N{n}; implementation-comparison reports use
 * C{n}. In both formats the heading starts with "### {code} —", so the
 * matcher is derived from the code alone.
 */
export function findingHeadingPattern(code: string): RegExp {
  return new RegExp(`^###\\s+${escapeRegExp(code)}\\s+—`);
}

export function extractSection(markdown: string, code: string): string | null {
  const pattern = findingHeadingPattern(code);

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
