import { readFile } from "node:fs/promises";
import { dashboardEventsPath } from "@checkout-surge/contracts";
import { describe, expect, it } from "vitest";

const configurations = [
  ["compose", new URL("../../../infra/caddy/Caddyfile", import.meta.url), "api-dashboard-edge:4000"],
  [
    "host-native",
    new URL("../../../infra/caddy/Caddyfile.host-native", import.meta.url),
    "localhost:4000",
  ],
] as const;

describe.each(configurations)("%s Caddy dashboard events routing", (_name, file, apiTarget) => {
  it("isolates the exact lifecycle-safe SSE path from fallback compression", async () => {
    const configuration = await readFile(file, "utf8");
    const matcherPaths = configuration
      .match(/^\s*@dashboard_events path (?<paths>.+)$/m)
      ?.groups?.paths?.trim()
      .split(/\s+/);
    const sseHandlerStart = configuration.indexOf("\thandle @dashboard_events {");
    const fallbackHandlerStart = configuration.indexOf("\n\thandle {", sseHandlerStart);
    const sseHandler = configuration.slice(sseHandlerStart, fallbackHandlerStart);
    const fallbackHandler = configuration.slice(fallbackHandlerStart);

    expect(matcherPaths).toEqual([dashboardEventsPath]);
    expect(matcherPaths).not.toContain(`${dashboardEventsPath}-extra`);
    expect(sseHandlerStart).toBeGreaterThan(-1);
    expect(fallbackHandlerStart).toBeGreaterThan(sseHandlerStart);
    expect(sseHandler).toContain(`reverse_proxy ${apiTarget}`);
    expect(sseHandler).toContain("auto-flushes text/event-stream");
    expect(sseHandler).not.toContain("flush_interval");
    expect(sseHandler).not.toContain("encode gzip");
    expect(fallbackHandler).toContain("encode gzip");
    expect(fallbackHandler).not.toContain(apiTarget);
  });
});
