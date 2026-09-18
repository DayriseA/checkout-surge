import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSoakCoversTwoWindows,
  readRecoverySoakConfig,
  runRecoverySoak,
} from "./runtime-recovery-soak.mjs";

test("requires a soak strictly longer than two recovery budget windows", () => {
  assert.throws(
    () => assertSoakCoversTwoWindows({ budgetWindowSeconds: 60, soakSeconds: 120 }),
    /must be greater than two.*\(120\)/,
  );
  assert.throws(
    () =>
      readRecoverySoakConfig({
        DASHBOARD_RECOVERY_WINDOW_SECONDS: "60",
        RUNTIME_RECOVERY_SOAK_SECONDS: "119",
      }),
    /must be greater than two/,
  );
  assert.equal(
    readRecoverySoakConfig({
      DASHBOARD_RECOVERY_WINDOW_SECONDS: "60",
      RUNTIME_RECOVERY_SOAK_SECONDS: "121",
    }).soakSeconds,
    121,
  );
});

test("soaks both health paths, checks root, and recovers idle with distinct visitor cookies", async () => {
  const calls = [];
  let recoveryCount = 0;
  let clock = 0;
  const writes = [];
  const result = await runRecoverySoak({
    config: configFixture(),
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    write: (message) => writes.push(message),
    fetch: async (url) => {
      calls.push(url);
      if (url.endsWith("/health")) return Response.json({ service: "web", status: "ok" });
      if (url === "http://proxy.test/demo") {
        return new Response("<h1>Checkout-Surge demo</h1>");
      }
      recoveryCount += 1;
      return Response.json(
        { currentRun: null, scope: null },
        { headers: { "set-cookie": `visitor=visitor-${recoveryCount}; HttpOnly` } },
      );
    },
  });

  assert.deepEqual(result, { probeRounds: 5 });
  assert.equal(calls.filter((url) => url === "http://web.test/health").length, 5);
  assert.equal(calls.filter((url) => url === "http://proxy.test/health").length, 5);
  assert.equal(calls.filter((url) => url === "http://proxy.test/demo").length, 1);
  assert.equal(calls.filter((url) => url.endsWith("/api/dashboard/recovery")).length, 2);
  assert.match(writes.at(-1), /component test/);
});

test("fails clearly when fresh recovery is non-idle", async () => {
  await assert.rejects(
    runOneRound(async (url) => {
      if (url.endsWith("/health")) return Response.json({ service: "web", status: "ok" });
      if (url === "http://proxy.test/demo") return new Response("Checkout-Surge demo");
      return Response.json(
        { currentRun: { status: "active" }, scope: { runId: "run-1" } },
        { headers: { "set-cookie": "visitor=one; HttpOnly" } },
      );
    }),
    /requires an idle runtime/,
  );
});

test("fails clearly when the recovery BFF omits its visitor cookie", async () => {
  await assert.rejects(
    runOneRound(async (url) => {
      if (url.endsWith("/health")) return Response.json({ service: "web", status: "ok" });
      if (url === "http://proxy.test/demo") return new Response("Checkout-Surge demo");
      return Response.json({ currentRun: null, scope: null });
    }),
    /did not issue a signed visitor cookie/,
  );
});

function configFixture() {
  return {
    directWebBaseUrl: "http://web.test",
    dashboardBaseUrl: "http://proxy.test",
    budgetWindowSeconds: 10,
    soakSeconds: 21,
    probeIntervalMs: 5_000,
  };
}

function runOneRound(fetch) {
  let clock = 0;
  return runRecoverySoak({
    config: {
      ...configFixture(),
      budgetWindowSeconds: 1,
      soakSeconds: 3,
      probeIntervalMs: 3_000,
    },
    fetch,
    now: () => clock,
    wait: async (milliseconds) => {
      clock += milliseconds;
    },
    write: () => undefined,
  });
}
