import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";

test("sends numeric camelCase cleanup options and allows omitted options", async () => {
  const bodies = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await runCleanupScript(port, ["--keep-latest=4", "--older-than-days", "7"]);
    await runCleanupScript(port, []);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  assert.deepEqual(bodies, [{ keepLatest: 4, olderThanDays: 7 }, {}]);
});

test("strictly rejects unknown options and missing values", () => {
  for (const args of [["--unknown", "1"], ["--keep-latest"]]) {
    const result = spawnSync(process.execPath, ["scripts/maintenance-cleanup-runs.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CONTROL_SERVICE_TOKEN: "test-token" },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_PARSE_ARGS/);
  }
});

function runCleanupScript(port, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/maintenance-cleanup-runs.mjs", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_BASE_URL: `http://127.0.0.1:${port}`,
        CONTROL_SERVICE_TOKEN: "test-token",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Cleanup script exited ${code}: ${stderr}`));
      }
    });
  });
}
