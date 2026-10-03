import { describe, expect, it, vi } from "vitest";
import { FlyMachinesApiError, FlyMachinesClient } from "../src/index.js";

function createClient(responses: Array<{ status: number; body?: unknown }>) {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error("Unexpected request.");
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), {
      status: next.status,
    });
  });
  const client = new FlyMachinesClient({
    appName: "runner-app",
    token: "test-token",
    baseUrl: "https://machines.test",
    fetch,
  });
  return { client, fetch };
}

function requestAt(fetch: ReturnType<typeof createClient>["fetch"], index: number) {
  const [url, init] = fetch.mock.calls[index] ?? [];
  return {
    url: String(url),
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
  };
}

describe("FlyMachinesClient", () => {
  it("acquires a lease, then sends its nonce with lease-guarded calls", async () => {
    const { client, fetch } = createClient([
      { status: 201, body: { status: "success", data: { nonce: "nonce-1" } } },
      { status: 200, body: { id: "m1", instance_id: "v2" } },
      { status: 200 },
    ]);

    const nonce = await client.acquireLease("m1", 120, "runner start");
    await client.updateMachine(
      "m1",
      { guest: { cpu_kind: "performance", cpus: 4, memory_mb: 8192 } },
      nonce,
    );
    await client.releaseLease("m1", nonce);

    expect(requestAt(fetch, 0)).toMatchObject({
      url: "https://machines.test/v1/apps/runner-app/machines/m1/lease",
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: { ttl: 120, description: "runner start" },
    });
    expect(requestAt(fetch, 1)).toMatchObject({
      url: "https://machines.test/v1/apps/runner-app/machines/m1",
      method: "POST",
      headers: { "fly-machine-lease-nonce": "nonce-1" },
      body: { skip_launch: true, config: { guest: { cpus: 4 } } },
    });
    expect(requestAt(fetch, 2)).toMatchObject({
      method: "DELETE",
      headers: { "fly-machine-lease-nonce": "nonce-1" },
    });
  });

  it("raises a non-2xx answer with its status and body", async () => {
    const { client } = createClient([{ status: 409, body: { error: "lease currently held" } }]);

    const failure = client.startMachine("m1", "stale-nonce");

    await expect(failure).rejects.toBeInstanceOf(FlyMachinesApiError);
    await expect(failure).rejects.toMatchObject({
      status: 409,
      body: JSON.stringify({ error: "lease currently held" }),
    });
  });

  it("reports a wait that reached the state, and one that timed out", async () => {
    const { client, fetch } = createClient([
      { status: 200, body: { ok: true } },
      { status: 408, body: { error: "deadline_exceeded" } },
    ]);

    await expect(
      client.waitForState("m1", "stopped", { timeoutSeconds: 30, instanceId: "v2" }),
    ).resolves.toBe(true);
    await expect(client.waitForState("m1", "started", { timeoutSeconds: 5 })).resolves.toBe(false);

    expect(requestAt(fetch, 0).url).toBe(
      "https://machines.test/v1/apps/runner-app/machines/m1/wait?state=stopped&timeout=30&instance_id=v2",
    );
  });
});
