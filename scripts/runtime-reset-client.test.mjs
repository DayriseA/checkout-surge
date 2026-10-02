import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { RuntimeResetAggregateError, resetRuntime } from "./runtime-reset-client.mjs";

const correlationId = "reset-correlation";

test("resets the run through the exact API route and shared headers", async () => {
  const calls = [];
  const result = await resetRuntime({
    apiBaseUrl: "http://api.test///",
    controlServiceToken: "secret",
    correlationId,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true }, { headers: { "x-correlation-id": correlationId } });
    },
  });
  assert.deepEqual(
    calls.map(({ url }) => url),
    ["http://api.test/admin/demo/reset"],
  );
  for (const { init } of calls) {
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    assert.equal(init.headers["content-type"], undefined);
    assert.equal(init.headers.accept, "application/json");
    assert.equal(init.headers["x-control-service-token"], "secret");
    assert.equal(init.headers["x-correlation-id"], correlationId);
  }
  assert.deepEqual(
    result.services.map(({ outcome }) => outcome),
    ["succeeded"],
  );
});

test("reports API failure truthfully", async () => {
  const calls = [];
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      fetch: async (url) => {
        calls.push(url);
        return new Response("api unavailable", { status: 503 });
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(
        error.result.services.map(({ outcome }) => outcome),
        ["failed"],
      );
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("reports invalid JSON success distinctly", async () => {
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      fetch: async () => new Response("not-json"),
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(error.result.services, [
        { service: "api", outcome: "failed", status: 200, message: "invalid_json_response" },
      ]);
      return true;
    },
  );
});

test("times out a fetch that never resolves and aborts its API request", async () => {
  let requestSignal;
  let calls = 0;
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      requestTimeoutMs: 5,
      fetch: async (_url, init) => {
        calls += 1;
        requestSignal = init.signal;
        return new Promise(() => {});
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(error.result.services, [
        { service: "api", outcome: "failed", message: "request_timeout" },
      ]);
      return true;
    },
  );
  assert.equal(calls, 1);
  assert.equal(requestSignal.aborted, true);
});

test("reports request timeout when API headers resolve but the body hangs", async () => {
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      requestTimeoutMs: 5,
      fetch: async () => new Response(new ReadableStream({ start() {} })),
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(error.result.services, [
        { service: "api", outcome: "failed", message: "request_timeout" },
      ]);
      return true;
    },
  );
});

test("sanitizes and truncates failed API response diagnostics to 1,000 characters", async () => {
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      fetch: async () => new Response(`detail secret; ${"x".repeat(2_000)}`, { status: 500 }),
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.equal(error.result.services.length, 1);
      const outcome = error.result.services[0];
      assert.equal(outcome.service, "api");
      assert.equal(outcome.outcome, "failed");
      assert.equal(outcome.status, 500);
      assert.equal(outcome.message.includes("secret"), false);
      assert.equal(outcome.message.length, 1_000);
      assert.equal(outcome.message, `detail ; ${"x".repeat(2_000)}`.slice(0, 1_000));
      return true;
    },
  );
});

test("removes exact token echoes, JSON credentials, and malicious response correlations", async () => {
  const token = "actual-control-token";
  await assert.rejects(
    resetRuntime({
      controlServiceToken: token,
      correlationId,
      fetch: async () => {
        return new Response(
          JSON.stringify({
            token,
            other: `raw-${token}-echo`,
            authorization: "different-sensitive-value",
          }),
          { status: 500, headers: { "x-correlation-id": `malicious-${token}` } },
        );
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      const serialized = JSON.stringify(error.result);
      assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes("different-sensitive-value"), false);
      return true;
    },
  );
});

test("requires a control token", async () => {
  await assert.rejects(resetRuntime({ env: {} }), /CONTROL_SERVICE_TOKEN is required/);
});

test("uses local defaults and one generated correlation ID", async () => {
  const calls = [];
  const result = await resetRuntime({
    env: { CONTROL_SERVICE_TOKEN: "secret" },
    fetch: async (url, init) => {
      calls.push({ url, correlationId: init.headers["x-correlation-id"] });
      return Response.json({ reset: true });
    },
  });
  assert.deepEqual(
    calls.map(({ url }) => url),
    ["http://localhost:4000/admin/demo/reset"],
  );
  assert.match(result.correlationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    calls.map(({ correlationId: id }) => id),
    [result.correlationId],
  );
});

test("CLI reports API failure and exits nonzero", async () => {
  const api = await listenWithResponse(503, { code: "api_failed" });
  const erp = await listenWithResponse(200, { reset: true });
  try {
    const result = await runCli({
      CONTROL_SERVICE_TOKEN: "secret",
      API_BASE_URL: api.baseUrl,
      MOCK_ERP_BASE_URL: erp.baseUrl,
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Runtime reset correlation:/);
    assert.match(result.stdout, /api: failed \(HTTP 503\)/);
    assert.doesNotMatch(result.stdout, /mock-erp:/);
  } finally {
    await Promise.all([api.close(), erp.close()]);
  }
});

async function listenWithResponse(status, payload) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function runCli(environment) {
  const child = spawn(process.execPath, ["scripts/runtime-reset.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}
