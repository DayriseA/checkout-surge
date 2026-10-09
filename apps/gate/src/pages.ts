import type { GatePageState } from "./core-status.js";

/** The gate's own path for the start button. Every other path belongs to the core. */
export const wakePath = "/__gate/start";

/** The status tones of the demo's `StatusPill`, with the same colors and markers. */
type Tone = "idle" | "progress" | "warning" | "danger";

interface PageContent {
  /** A short status shown above the title, in the page's tone. */
  status: string;
  tone: Tone;
  title: string;
  text: string;
  /** Seconds before the page reloads itself. */
  refreshSeconds?: number;
  action?: "start" | "retry_start" | "reload";
}

const pages: Record<GatePageState, PageContent> = {
  stopped: {
    status: "Asleep",
    tone: "idle",
    title: "The demo is asleep",
    text: "Its servers sleep while nobody uses them, to keep hosting costs near zero. Waking them usually takes about 15 seconds, then the demo opens.",
    action: "start",
  },
  booting: {
    status: "Starting",
    tone: "progress",
    title: "Starting the demo",
    text: "Its servers are starting, which usually takes less than a minute. This page reloads on its own and opens the demo once it is ready.",
    refreshSeconds: 3,
  },
  // Also shown while something other than a deploy holds the core's lease (HD-29,
  // docs/decisions/hosted_deployment.md), so the wording does not promise a deploy.
  updating: {
    status: "Maintenance",
    tone: "progress",
    title: "Maintenance in progress",
    text: "The demo's servers are busy with maintenance, most often an update, and cannot start right now. This usually takes a few minutes; please try again then.",
    action: "retry_start",
  },
  relocating: {
    status: "Moving",
    tone: "progress",
    title: "Moving the demo to new servers",
    text: "The hosting provider has no room for the demo on its current servers, or they failed, so the demo is moving to new ones and starts there as a fresh install, with an empty run history. This usually takes about a minute; this page reloads on its own and opens the demo once it is ready.",
    refreshSeconds: 5,
  },
  refreshing: {
    status: "Reinstalling",
    tone: "progress",
    title: "Installing a fresh demo",
    text: "The demo is being reinstalled on new servers and starts with an empty run history. This usually takes about a minute; this page reloads on its own and opens the demo once it is ready.",
    refreshSeconds: 5,
  },
  no_capacity: {
    status: "Provider full",
    tone: "warning",
    title: "No room at the hosting provider",
    text: 'Fly.io, the demo\'s hosting provider, has no room for its servers in Europe right now. Nothing is broken in the demo, and this is usually temporary: please come back later, or check the <a href="https://status.flyio.net/">Fly.io status page</a>.',
    action: "retry_start",
  },
  setup_failed: {
    status: "Start failed",
    tone: "danger",
    title: "The demo could not start",
    text: "Preparing its database failed while its servers were starting. This needs a fix from the project's owner, so please come back later.",
  },
  unavailable: {
    status: "Unavailable",
    tone: "warning",
    title: "The demo is unavailable",
    text: "It could not be reached or started just now, most often because its hosting provider did not answer. This is usually brief; please try again in a moment.",
    action: "reload",
  },
};

/**
 * The demo's light theme, copied from its `@theme` tokens in `apps/web/src/app/globals.css`: the
 * gate image does not contain the web app. Keep the values in step with that file.
 */
const colors = {
  page: "#eceef1",
  surface: "#ffffff",
  surfaceMuted: "#f3f4f6",
  border: "#d9dde3",
  ink: "#0d1b2a",
  mutedStrong: "#344052",
  accent: "#17325a",
  signal: "#ffb81c",
  info: "#1f4fd1",
  infoSoft: "#e6edff",
  warning: "#8a5300",
  warningSoft: "#fff1cf",
  danger: "#b42318",
  dangerSoft: "#fde7e3",
} as const;

/** The demo's fallback font stack (`--font-sans` without its bundled font): no font file to load. */
const fontStack =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const styles = `
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; min-height: 100vh; background: ${colors.page}; color: ${colors.ink};
  font: 0.9375rem/1.5rem ${fontStack}; -webkit-font-smoothing: antialiased; }
.band { background: ${colors.ink}; color: #fff; }
.band div { display: flex; align-items: center; gap: 0.625rem; max-width: 1280px; min-height: 3.5rem;
  margin: 0 auto; padding: 0 1.5rem; }
.band svg { flex: none; width: 1.5rem; height: 1.5rem; }
.band strong { font-size: 1.0625rem; line-height: 1; font-weight: 800; font-stretch: 125%; }
main { max-width: 38rem; margin: 0 auto; padding: 12vh 1.5rem 4rem; }
.card { padding: 2rem; border: 1px solid ${colors.border}; border-radius: 1rem; background: ${colors.surface};
  overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: 0.375rem; min-height: 1.5rem; margin: 0;
  padding: 0.125rem 0.625rem; border-radius: 999px; font-size: 0.75rem; line-height: 1rem; font-weight: 600; }
.idle { background: ${colors.surfaceMuted}; color: ${colors.mutedStrong}; box-shadow: inset 0 0 0 1px ${colors.border}; }
.progress { background: ${colors.infoSoft}; color: ${colors.info}; }
.warning { background: ${colors.warningSoft}; color: ${colors.warning}; }
.danger { background: ${colors.dangerSoft}; color: ${colors.danger}; }
.pulse { display: block; width: 0.5rem; height: 0.5rem; border-radius: 50%; background: currentColor;
  animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
.loader { height: 3px; margin: 0 0 1.25rem; overflow: hidden; border-radius: 999px; background: ${colors.infoSoft}; }
.loader::after { content: ""; display: block; width: 40%; height: 100%; border-radius: inherit;
  background: ${colors.info}; animation: slide 1s ease-in-out infinite; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.enter .card { animation: enter 240ms ease-out both; }
@keyframes enter { from { opacity: 0; transform: translateY(6px); } }
h1 { margin: 1rem 0 0; color: ${colors.ink}; font-size: 1.5rem; line-height: 1.25; font-weight: 700;
  font-stretch: 112%; letter-spacing: -0.005em; }
.text { margin: 0.75rem 0 0; color: ${colors.mutedStrong}; font-size: 1rem; line-height: 1.75rem; }
.text a { color: ${colors.accent}; font-weight: 600; text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, ${colors.accent} 35%, transparent); }
.text a:hover { text-decoration-color: ${colors.accent}; }
form, .action { margin: 1.5rem 0 0; }
.button { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem;
  padding: 0.5rem 1.25rem; border: 1px solid ${colors.accent}; border-radius: 0.5rem; background: ${colors.accent};
  color: #fff; font: inherit; font-size: 1rem; font-weight: 600; text-decoration: none; cursor: pointer;
  transition: background-color 150ms ease, transform 150ms ease, box-shadow 150ms ease; }
.button:hover, .button:focus-visible { background: ${colors.ink}; transform: translateY(-1px);
  box-shadow: 0 4px 12px color-mix(in srgb, ${colors.ink} 20%, transparent); }
.button:active { transform: none; box-shadow: none; }
:focus-visible { outline: 2px solid ${colors.ink}; outline-offset: 2px; }
@media (max-width: 560px) {
  .band div { padding: 0 1rem; }
  main { padding: 1.5rem 1rem 3rem; }
  .card { padding: 1.25rem; }
  .button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .pulse, .loader::after, .enter .card { animation: none; }
  .loader { display: none; }
  .button, .button:hover, .button:focus-visible { transition: none; transform: none; }
}
`;

/** The demo's brand mark: a surge of arrivals meeting one gate and leaving as a single line. */
const brandMark = `<svg aria-hidden="true" viewBox="0 0 24 24">
<g fill="currentColor" opacity="0.55"><circle cx="3" cy="6" r="1.6"/><circle cx="7" cy="9" r="1.6"/><circle cx="3" cy="12" r="1.6"/><circle cx="7" cy="15" r="1.6"/><circle cx="3" cy="18" r="1.6"/></g>
<rect fill="${colors.signal}" height="18" rx="1.5" width="3" x="11" y="3"/>
<g fill="currentColor"><circle cx="18" cy="12" r="1.6"/><circle cx="22.4" cy="12" r="1.6"/></g>
</svg>`;

const toneMarkers: Record<Tone, string> = {
  idle: "•",
  progress: '<span class="pulse"></span>',
  warning: "!",
  danger: "×",
};

/** The page shown for any URL while the core is not ready. `returnPath` is that URL. */
export function renderGatePage(state: GatePageState, returnPath: string): string {
  const page = pages[state];
  const reloads = page.refreshSeconds !== undefined;
  const refresh = reloads ? `<meta http-equiv="refresh" content="${page.refreshSeconds}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
${refresh}
<title>${page.title} · Checkout-Surge</title>
<style>${styles}</style>
</head>
<body${reloads ? "" : ' class="enter"'}>
<header class="band"><div>${brandMark}<strong>Checkout-Surge</strong></div></header>
<main>
<div class="card">
${reloads ? '<div class="loader" aria-hidden="true"></div>' : ""}
<p class="status ${page.tone}"><span aria-hidden="true">${toneMarkers[page.tone]}</span>${page.status}</p>
<h1>${page.title}</h1>
<p class="text">${page.text}</p>
${renderAction(page.action, returnPath)}
</div>
</main>
</body>
</html>
`;
}

function renderAction(action: PageContent["action"], returnPath: string): string {
  switch (action) {
    case "start":
    case "retry_start":
      return `<form method="post" action="${wakePath}?return=${encodeURIComponent(returnPath)}">
<button class="button" type="submit">${action === "start" ? "Start the demo" : "Try again"}</button>
</form>`;
    case "reload":
      return `<p class="action"><a class="button" href="${escapeHtml(returnPath)}">Try again</a></p>`;
    default:
      return "";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const returnBase = "http://gate.invalid";

/**
 * A same-site path to return to, never another site. The value is parsed the way a browser would
 * (dropping tabs and newlines, reading a backslash as a slash), and only its normalized path,
 * query and fragment are kept. A normalized path starting with `//` (from dot segments such as
 * `/.//host`) would itself read as another site, so it returns to `/` too.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const url = URL.parse(value, returnBase);
  if (url?.origin !== returnBase || url.pathname.startsWith("//")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
