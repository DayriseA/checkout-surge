import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseK6SummaryMetrics } from "../src/application/k6-output-parser.js";
import { generateK6Script } from "../src/application/k6-script.js";

const k6Binary = process.env.K6_BINARY?.trim() || "/usr/local/bin/k6";
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-compat-"));
  const version = await runK6(["version"]);
  if (!/k6 v2\.0\.0\b/.test(`${version.stdout}\n${version.stderr}`)) {
    throw new Error(
      `The required compatibility lane must use load-orchestrator-runtime k6 v2.0.0; received: ${version.stdout || version.stderr}`,
    );
  }
});

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe("pinned production k6 compatibility", () => {
  it.each([
    ["buyer-spike", createRequest()],
    [
      "steady-arrival-rate",
      createRequest({
        mode: "steady-arrival-rate",
        ratePerSecond: 1,
        startDelaySeconds: 0,
        durationSeconds: 1,
        quantityPerAttempt: 1,
        k6Vus: { preAllocatedVus: 1, maxVus: 2 },
      }),
    ],
  ])("inspects the generated %s script", async (name, request) => {
    const scriptPath = path.join(workDir, `${name}.js`);
    await writeFile(scriptPath, generateK6Script(request).contents, "utf8");
    await expect(runK6(["inspect", scriptPath])).resolves.toMatchObject({ exitCode: 0 });
  });

  it("parses a real summary export produced by the production binary", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a loopback TCP port.");

    const scriptPath = path.join(workDir, "summary-smoke.js");
    const summaryPath = path.join(workDir, "summary-smoke.json");
    await writeFile(
      scriptPath,
      `import http from "k6/http";
export const options = { vus: 1, iterations: 1 };
export default function () { http.get("http://127.0.0.1:${address.port}/"); }
`,
      "utf8",
    );
    try {
      await runK6([
        "run",
        "--quiet",
        "--summary-export",
        summaryPath,
        "--out",
        "json=-",
        scriptPath,
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    const parsed = parseK6SummaryMetrics(await readFile(summaryPath, "utf8"));
    expect(parsed).toMatchObject({
      httpRequests: 1,
      completedIterations: 1,
      httpFailureRate: 0,
      requestDuration: {
        averageMs: expect.any(Number),
        p95Ms: expect.any(Number),
      },
    });
  });
});

async function runK6(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(k6Binary, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${String(chunk)}`.slice(-64 * 1024);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-64 * 1024);
    });
    child.once("error", (error) => {
      reject(
        new Error(
          `Required k6 binary ${k6Binary} is unavailable. Run this lane through the load-orchestrator-runtime image.`,
          { cause: error },
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (exitCode === 0) resolve({ exitCode, stdout, stderr });
      else
        reject(
          new Error(
            `k6 ${args[0] ?? "command"} failed with ${signal ?? exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
    });
  });
}

function createRequest(
  trafficConfig: TrafficExecutionStartRequest["configSnapshot"]["trafficConfig"] = {
    mode: "buyer-spike",
    buyerCount: 1,
    duplicateEachBuyerAttempt: false,
    startDelaySeconds: 0,
    maxDurationSeconds: 1,
    quantityPerAttempt: 1,
  },
): TrafficExecutionStartRequest {
  return {
    runId: "55555555-5555-4555-8555-555555555555",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    apiBaseUrl: "http://127.0.0.1:4000",
    buyEndpointPath: "/buy",
    correlationId: "corr-k6-compat",
    configSnapshot: {
      trafficConfig,
      inventoryConfig: {
        startingStock: 1,
        quantityPerCheckout: 1,
        reservationHoldMinutes: 1,
      },
      erpConfig: {
        latencyMs: 0,
        maxTps: 1,
        errorRate: 0,
        forcedOutage: false,
        requestTimeoutMs: 1000,
      },
      backpressureConfig: {
        queueName: "orders:process",
        physicalQueueName: "orders-process",
        orderProcessConcurrency: 1,
        retryPolicy: { maxAttempts: 1, initialBackoffMs: 0 },
        drainTimeoutSeconds: 1,
        pendingPersistenceRetryAfterSeconds: 1,
        circuitBreakerFailureThreshold: 1,
        circuitBreakerResetTimeoutMs: 1000,
      },
    },
  };
}
