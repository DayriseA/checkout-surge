import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreStatus } from "../src/core-status.js";
import type { RecoveryPage, WakeOutcome } from "../src/core-wake.js";
import { buildGateServer } from "../src/server.js";

const closers: (() => Promise<unknown>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A stand-in for the core's Caddy that records what reaches it. */
async function startCore() {
  const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push({ url: request.url ?? "", headers: request.headers, body });
      if (request.url === "/busy") {
        response.writeHead(503, { "retry-after": "1" }).end("busy");
      } else if (request.url === "/dashboard/events") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write("data: first\n\n");
      } else {
        response.writeHead(200, { "content-type": "text/plain" }).end("from the core");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { received, target: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function setup(
  initial: CoreStatus,
  wakeOutcome: WakeOutcome = "starting",
  recoveryPage?: RecoveryPage,
) {
  let current = initial;
  const status = {
    current: vi.fn(async () => current),
    invalidate: vi.fn(),
  };
  const wake = { wake: vi.fn(async () => wakeOutcome), recoveryState: () => recoveryPage };
  const gate = await buildGateServer({ status, wake, logger: createSilentLogger("gate") });
  closers.push(() => gate.close());
  return { gate, status, wake, setStatus: (next: CoreStatus) => (current = next) };
}

describe("gate server", () => {
  it("answers any URL with its own page while the core sleeps, and a GET never wakes it", async () => {
    const { gate, wake } = await setup({ state: "stopped" });

    const response = await gate.inject({ method: "GET", url: "/demo/watch?run=1" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("The demo is asleep");
    expect(response.body).toContain('action="/__gate/start?return=%2Fdemo%2Fwatch%3Frun%3D1"');
    expect(response.body).not.toContain('http-equiv="refresh"');
    expect(wake.wake).not.toHaveBeenCalled();
  });

  it("answers robots.txt itself, asleep or awake, without waking or relaying", async () => {
    const core = await startCore();
    const asleep = await setup({ state: "stopped" });
    const awake = await setup({ state: "ready", target: core.target });

    for (const { gate, status, wake } of [asleep, awake]) {
      const get = await gate.inject({ method: "GET", url: "/robots.txt" });
      const head = await gate.inject({ method: "HEAD", url: "/robots.txt" });

      expect(get.statusCode).toBe(200);
      expect(get.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(get.headers["cache-control"]).toBe("public, max-age=86400");
      expect(get.body).toBe("User-agent: *\nDisallow: /\n");
      expect(head.statusCode).toBe(200);
      expect(head.headers["content-type"]).toBe("text/plain; charset=utf-8");
      expect(head.body).toBe("");
      expect(status.current).not.toHaveBeenCalled();
      expect(wake.wake).not.toHaveBeenCalled();
    }
    expect(core.received).toHaveLength(0);
  });

  it("reloads the starting page every 3 seconds until the core is ready", async () => {
    const { gate } = await setup({ state: "booting" });

    const response = await gate.inject({ method: "GET", url: "/demo" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Starting the demo");
    expect(response.body).toContain('<meta http-equiv="refresh" content="3">');
    expect(response.body).not.toContain("<form");
  });

  it("offers neither a reload nor a start when the core's setup failed", async () => {
    const { gate } = await setup({ state: "setup_failed" });

    const response = await gate.inject({ method: "GET", url: "/demo" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("The demo could not start");
    expect(response.body).not.toContain('http-equiv="refresh"');
    expect(response.body).not.toContain("<form");
    expect(response.body).not.toContain('class="button"');
  });

  it("starts the core from the button, then returns to the visitor's page", async () => {
    const { gate, wake } = await setup({ state: "stopped" });

    const response = await gate.inject({ method: "POST", url: "/__gate/start?return=%2Fdemo" });

    expect(wake.wake).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/demo");
  });

  it("never returns the visitor to another site", async () => {
    const { gate } = await setup({ state: "stopped" });

    for (const returnPath of [
      "//evil.example/",
      "/\t/evil.example/",
      "/\t\\evil.example",
      "/.//evil.example/",
      "/%2e//evil.example/",
    ]) {
      const response = await gate.inject({
        method: "POST",
        url: `/__gate/start?return=${encodeURIComponent(returnPath)}`,
      });

      expect(response.headers.location).toBe("/");
    }
  });

  it("never links the visitor to another site from its own page", async () => {
    const { gate } = await setup({ state: "unavailable" });

    const response = await gate.inject({ method: "GET", url: "//evil.example/" });

    expect(response.body).toContain('<a class="button" href="/">Try again</a>');
  });

  it("returns the visitor to their page while the core is recreated", async () => {
    const { gate } = await setup({ state: "stopped" }, "relocating");

    const response = await gate.inject({ method: "POST", url: "/__gate/start?return=%2Fdemo" });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/demo");
  });

  it("answers any URL with the recovery page while one runs or found no capacity", async () => {
    const relocating = await setup(
      { state: "ready", target: "http://127.0.0.1:9" },
      "starting",
      "relocating",
    );
    const refreshing = await setup({ state: "stopped" }, "starting", "refreshing");
    const noCapacity = await setup({ state: "stopped" }, "starting", "no_capacity");

    const moving = await relocating.gate.inject({ method: "GET", url: "/demo" });
    const fresh = await refreshing.gate.inject({ method: "GET", url: "/demo" });
    const full = await noCapacity.gate.inject({ method: "GET", url: "/demo" });

    expect(moving.statusCode).toBe(503);
    expect(moving.headers["cache-control"]).toBe("no-store");
    expect(moving.body).toContain("Moving the demo to new servers");
    expect(moving.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(relocating.status.current).not.toHaveBeenCalled();
    expect(fresh.statusCode).toBe(503);
    expect(fresh.body).toContain("Installing a fresh demo");
    expect(fresh.body).toContain('<meta http-equiv="refresh" content="5">');
    expect(fresh.body).not.toContain("hosting provider");
    expect(full.body).toContain('href="https://status.flyio.net/"');
    expect(full.body).toContain('action="/__gate/start?return=%2Fdemo"');
    expect(full.body).not.toContain('http-equiv="refresh"');
  });

  it("shows the maintenance page when a deploy holds the core", async () => {
    const { gate } = await setup({ state: "stopped" }, "updating");

    const response = await gate.inject({ method: "POST", url: "/__gate/start?return=%2F" });

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("Maintenance in progress");
    expect(response.body).toContain('action="/__gate/start?return=%2F"');
  });

  it("relays to the ready core with the visitor's Fly address as the only forwarded source", async () => {
    const core = await startCore();
    const { gate } = await setup({ state: "ready", target: core.target });

    const response = await gate.inject({
      method: "POST",
      url: "/api/demo/runs/start?preset=surge",
      headers: {
        host: "gate.example",
        "content-type": "application/json",
        "fly-client-ip": "203.0.113.9",
        "x-forwarded-for": "198.51.100.1, 203.0.113.9",
        forwarded: "for=198.51.100.1",
        "x-real-ip": "198.51.100.1",
        "x-forwarded-proto": "http",
      },
      payload: '{"presetSlug":"surge-10k"}',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("from the core");
    const [relayed] = core.received;
    expect(relayed?.url).toBe("/api/demo/runs/start?preset=surge");
    expect(relayed?.body).toBe('{"presetSlug":"surge-10k"}');
    expect(relayed?.headers).toMatchObject({
      host: "gate.example",
      "x-forwarded-for": "203.0.113.9",
      "x-forwarded-proto": "https",
    });
    expect(relayed?.headers).not.toHaveProperty("forwarded");
    expect(relayed?.headers).not.toHaveProperty("x-real-ip");
    expect(relayed?.headers).not.toHaveProperty("fly-client-ip");
  });

  it("passes the core's own errors through without replaying the request", async () => {
    const core = await startCore();
    const { gate } = await setup({ state: "ready", target: core.target });

    const response = await gate.inject({ method: "GET", url: "/busy" });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("busy");
    expect(core.received).toHaveLength(1);
  });

  it("streams server-sent events as the core writes them", async () => {
    const core = await startCore();
    const { gate } = await setup({ state: "ready", target: core.target });
    const address = await gate.listen({ host: "127.0.0.1", port: 0 });
    const abort = new AbortController();

    const response = await fetch(`${address}/dashboard/events`, { signal: abort.signal });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    abort.abort();

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(new TextDecoder().decode(first?.value)).toBe("data: first\n\n");
  });

  it("shows the gate page, from a fresh status, when the core goes away", async () => {
    const { gate, status, setStatus } = await setup({
      state: "ready",
      target: "http://127.0.0.1:9",
    });
    status.invalidate.mockImplementationOnce(() => setStatus({ state: "stopped" }));

    const response = await gate.inject({ method: "GET", url: "/api/core/idle-status" });

    expect(status.invalidate).toHaveBeenCalledOnce();
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("The demo is asleep");
  });
});
