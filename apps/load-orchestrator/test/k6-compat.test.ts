import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type TrafficExecutionStartRequest,
  trafficCompletionReportSchema,
} from "@checkout-surge/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  K6RunAccumulator,
  parseK6JsonLine,
  parseK6SummaryMetrics,
} from "../src/application/k6-output-parser.js";
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
      "constant-arrival-rate",
      createRequest({
        mode: "constant-arrival-rate",
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
        "--no-usage-report",
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

  it("reports an attempt still waiting at k6 termination as started and interrupted", {
    timeout: 60_000,
  }, async () => {
    // The server accepts the request but deliberately never completes the
    // response, so k6 must terminate the attempt at the scenario boundary.
    const heldSockets = new Set<Socket>();
    const server = createServer(() => {
      // Never write a response; the socket is tracked and destroyed during cleanup.
    });
    server.on("connection", (socket) => {
      heldSockets.add(socket);
      socket.on("close", () => heldSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP port.");
    }

    const request = createRequest(
      {
        mode: "buyer-spike",
        buyerCount: 1,
        duplicateEachBuyerAttempt: false,
        startDelaySeconds: 0,
        maxDurationSeconds: 1,
        quantityPerAttempt: 1,
      },
      `http://127.0.0.1:${address.port}`,
    );
    const generated = generateK6Script(request);
    const scriptPath = path.join(workDir, "hung-endpoint.js");
    const summaryPath = path.join(workDir, "hung-endpoint.json");
    await writeFile(scriptPath, generated.contents, "utf8");

    try {
      const execution = await runK6(
        [
          "run",
          "--quiet",
          "--no-usage-report",
          "--summary-export",
          summaryPath,
          "--out",
          "json=-",
          scriptPath,
        ],
        { expectSuccessfulExit: false },
      );

      const accumulator = new K6RunAccumulator({
        runId: request.runId,
        correlationId: request.correlationId,
        plannedRequests: generated.plannedRequests,
        startedAt: new Date(),
        executionPlan: generated.executionPlan,
      });
      for (const line of execution.stdout.split("\n")) {
        const point = parseK6JsonLine(line);
        if (point) accumulator.observe(point);
      }
      const summaryMetrics = parseK6SummaryMetrics(await readFile(summaryPath, "utf8"));
      expect(summaryMetrics?.attemptsStarted).toBe(1);

      const report = accumulator.completionReport({
        status: execution.exitCode === 0 ? "succeeded" : "failed",
        exitCode: execution.exitCode,
        completedAt: new Date(),
        ...(summaryMetrics ? { summaryMetrics } : {}),
      });

      expect(report.transportAttemptCounts).toEqual({
        plannedRequests: 1,
        startedRequests: 1,
        completedRequests: 0,
        interruptedRequests: 1,
        unstartedRequests: 0,
      });
      expect(() => trafficCompletionReportSchema.parse(report)).not.toThrow();
    } finally {
      for (const socket of heldSockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("separates a real connection failure from unexpected application responses", async () => {
    const request = createRequest(undefined, "http://127.0.0.1:1");
    const generated = generateK6Script(request);
    const scriptPath = path.join(workDir, "unreachable-endpoint.js");
    const summaryPath = path.join(workDir, "unreachable-endpoint.json");
    await writeFile(scriptPath, generated.contents, "utf8");

    const execution = await runK6([
      "run",
      "--quiet",
      "--no-usage-report",
      "--summary-export",
      summaryPath,
      "--out",
      "json=-",
      scriptPath,
    ]);
    const accumulator = new K6RunAccumulator({
      runId: request.runId,
      correlationId: request.correlationId,
      plannedRequests: generated.plannedRequests,
      startedAt: new Date(),
      executionPlan: generated.executionPlan,
    });
    for (const line of execution.stdout.split("\n")) {
      const point = parseK6JsonLine(line);
      if (point) accumulator.observe(point);
    }
    const summaryMetrics = parseK6SummaryMetrics(await readFile(summaryPath, "utf8"));
    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: execution.exitCode,
      completedAt: new Date(),
      ...(summaryMetrics ? { summaryMetrics } : {}),
    });

    expect(report.transportAttemptCounts).toEqual({
      plannedRequests: 1,
      startedRequests: 1,
      completedRequests: 1,
      interruptedRequests: 0,
      unstartedRequests: 0,
    });
    expect(report.httpSummary).toMatchObject({
      failedRequests: 1,
      transportFailures: 1,
      unexpectedResponses: 0,
    });
    expect(() => trafficCompletionReportSchema.parse(report)).not.toThrow();
  });
});

async function runK6(
  args: string[],
  options: { expectSuccessfulExit?: boolean } = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const expectSuccessfulExit = options.expectSuccessfulExit ?? true;
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
      if (exitCode !== null && (exitCode === 0 || !expectSuccessfulExit)) {
        resolve({ exitCode, stdout, stderr });
      } else {
        reject(
          new Error(
            `k6 ${args[0] ?? "command"} failed with ${signal ?? exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
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
  apiBaseUrl = "http://127.0.0.1:4000",
): TrafficExecutionStartRequest {
  return {
    runId: "55555555-5555-4555-8555-555555555555",
    saleOfferId: "22222222-2222-4222-8222-222222222222",
    apiBaseUrl,
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
