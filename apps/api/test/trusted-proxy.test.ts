import { fastify } from "fastify";
import { describe, expect, it } from "vitest";

describe("trusted dashboard proxy boundary", () => {
  it("ignores X-Forwarded-For from an untrusted direct caller", async () => {
    const app = fastify({ trustProxy: ["172.30.0.2/32"] });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const response = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "198.51.100.8",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    expect(response.json()).toEqual({ ip: "198.51.100.8" });
    await app.close();
  });

  it("derives distinct visitor sources only through the exact trusted proxy", async () => {
    const app = fastify({ trustProxy: ["172.30.0.2/32"] });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    const first = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "172.30.0.2",
      headers: { "x-forwarded-for": "203.0.113.7" },
    });
    const second = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress: "172.30.0.2",
      headers: { "x-forwarded-for": "203.0.113.8" },
    });
    expect(first.json()).toEqual({ ip: "203.0.113.7" });
    expect(second.json()).toEqual({ ip: "203.0.113.8" });
    await app.close();
  });
});
