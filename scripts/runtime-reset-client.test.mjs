import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { RuntimeResetAggregateError, resetRuntime } from "./runtime-reset-client.mjs";

const correlationId = "reset-correlation";

test("resets API then Mock ERP with exact bodyless routes and shared headers", async () => {
  const calls = [];
  const result = await resetRuntime({
    apiBaseUrl: "http://api.test///",
    mockErpBaseUrl: "http://erp.test/",
    controlServiceToken: "secret",
    correlationId,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true }, { headers: { "x-correlation-id": correlationId } });
    },
  });
  assert.deepEqual(
    calls.map(({ url }) => url),
    ["http://api.test/admin/demo/reset", "http://erp.test/chaos/reset"],
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
    ["succeeded", "succeeded"],
  );
});

test("attempts ERP after API failure and reports truthful aggregate outcomes", async () => {
  const calls = [];
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      fetch: async (url) => {
        calls.push(url);
        return calls.length === 1
          ? new Response("api unavailable", { status: 503 })
          : Response.json({ reset: true, correlationId: "erp-response-correlation" });
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(
        error.result.services.map(({ outcome }) => outcome),
        ["failed", "succeeded"],
      );
      assert.equal(error.result.services[1].responseCorrelationId, "erp-response-correlation");
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("preserves API success when Mock ERP reset fails", async () => {
  let call = 0;
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      fetch: async () => {
        call += 1;
        return call === 1
          ? Response.json(
              { reset: true },
              { headers: { "x-correlation-id": "api-reset-correlation" } },
            )
          : new Response(JSON.stringify({ code: "erp_reset_failed" }), {
              status: 503,
              headers: {
                "content-type": "application/json",
                "x-correlation-id": "erp-reset-correlation",
              },
            });
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(error.result.services, [
        {
          service: "api",
          outcome: "succeeded",
          status: 200,
          responseCorrelationId: "api-reset-correlation",
        },
        {
          service: "mock-erp",
          outcome: "failed",
          status: 503,
          responseCorrelationId: "erp-reset-correlation",
          message: JSON.stringify({ code: "erp_reset_failed" }),
        },
      ]);
      return true;
    },
  );
});

test("collects both failures, rejects malformed success, and caps diagnostics", async () => {
  let call = 0;
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      fetch: async () => {
        call += 1;
        return call === 1
          ? new Response("not-json", { status: 200 })
          : new Response(`token=secret ${"x".repeat(2_000)}`, { status: 500 });
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.equal(error.result.services[0].message, "invalid_json_response");
      assert.equal(error.result.services[1].message.includes("secret"), false);
      assert.ok(error.result.services[1].message.length <= 1_000);
      return true;
    },
  );
});

test("times out each request independently and still attempts both services", async () => {
  let calls = 0;
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      requestTimeoutMs: 2,
      fetch: async (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("secret internal URL")));
        });
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.deepEqual(
        error.result.services.map(({ message }) => message),
        ["request_timeout", "request_timeout"],
      );
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("bounds a hung API response body and still attempts Mock ERP", async () => {
  const calls = [];
  await assert.rejects(
    resetRuntime({
      controlServiceToken: "secret",
      correlationId,
      requestTimeoutMs: 5,
      fetch: async (url) => {
        calls.push(url);
        if (calls.length === 1) {
          return new Response(
            new ReadableStream({
              start() {
                // Headers resolve, but the body intentionally never closes.
              },
            }),
            { status: 200 },
          );
        }
        return Response.json({ reset: true });
      },
    }),
    (error) => {
      assert.ok(error instanceof RuntimeResetAggregateError);
      assert.equal(error.result.services[0].message, "request_timeout");
      assert.equal(error.result.services[1].outcome, "succeeded");
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("removes exact token echoes, JSON credentials, and malicious response correlations", async () => {
  const token = "actual-control-token";
  let call = 0;
  await assert.rejects(
    resetRuntime({
      controlServiceToken: token,
      correlationId,
      fetch: async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              token,
              other: `raw-${token}-echo`,
              authorization: "different-sensitive-value",
            }),
            { status: 500, headers: { "x-correlation-id": `malicious-${token}` } },
          );
        }
        return Response.json(
          { reset: true },
          { headers: { "x-correlation-id": `erp-${token}-correlation` } },
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
    ["http://localhost:4000/admin/demo/reset", "http://localhost:4100/chaos/reset"],
  );
  assert.match(result.correlationId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    calls.map(({ correlationId: id }) => id),
    [result.correlationId, result.correlationId],
  );
});

test("CLI reports partial outcomes and exits nonzero", async () => {
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
    assert.match(result.stdout, /mock-erp: succeeded \(HTTP 200\)/);
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
