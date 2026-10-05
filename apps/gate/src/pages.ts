import type { GatePageState } from "./core-status.js";

/** The gate's own path for the start button. Every other path belongs to the core. */
export const wakePath = "/__gate/start";

interface PageContent {
  title: string;
  text: string;
  /** Seconds before the page reloads itself. */
  refreshSeconds?: number;
  action?: "start" | "retry_start" | "reload";
}

const pages: Record<GatePageState, PageContent> = {
  stopped: {
    title: "The demo is asleep",
    text: "Its servers sleep when nobody uses them, to keep hosting costs near zero. Waking them takes about 15 seconds.",
    action: "start",
  },
  booting: {
    title: "Starting the infrastructure",
    text: "The demo's servers are starting. This page reloads on its own and opens the demo as soon as it is ready.",
    refreshSeconds: 3,
  },
  updating: {
    title: "Update in progress",
    text: "A new version of the demo is being deployed. Please retry shortly.",
    action: "retry_start",
  },
  setup_failed: {
    title: "The demo could not start",
    text: "Its database setup failed while the servers were starting. This needs a fix from the project owner; please come back later.",
  },
  unavailable: {
    title: "The demo is unavailable",
    text: "The hosting provider did not answer as expected. Please try again in a moment.",
    action: "reload",
  },
};

/** The page shown for any URL while the core is not ready. `returnPath` is that URL. */
export function renderGatePage(state: GatePageState, returnPath: string): string {
  const page = pages[state];
  const refresh =
    page.refreshSeconds === undefined
      ? ""
      : `<meta http-equiv="refresh" content="${page.refreshSeconds}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>Checkout Surge - ${page.title}</title>
<style>
body { margin: 0; font-family: system-ui, sans-serif; background: #f6f7f9; color: #1d2330; }
main { max-width: 34rem; margin: 18vh auto 0; padding: 0 1rem; }
h1 { font-size: 1.6rem; }
p { line-height: 1.5; }
button, a.button { display: inline-block; padding: 0.7rem 1.2rem; border: 0; border-radius: 0.4rem;
  background: #1d4ed8; color: #fff; font: inherit; text-decoration: none; cursor: pointer; }
</style>
</head>
<body>
<main>
<p>Checkout Surge</p>
<h1>${page.title}</h1>
<p>${page.text}</p>
${renderAction(page.action, returnPath)}
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
<button type="submit">${action === "start" ? "Start the demo" : "Retry"}</button>
</form>`;
    case "reload":
      return `<a class="button" href="${escapeHtml(returnPath)}">Try again</a>`;
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
 * query and fragment are kept.
 */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  const url = URL.parse(value, returnBase);
  return url?.origin === returnBase ? `${url.pathname}${url.search}${url.hash}` : "/";
}
