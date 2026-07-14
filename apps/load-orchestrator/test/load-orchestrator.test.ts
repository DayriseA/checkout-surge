import { type spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  buyOutcomeHeaderName,
  buyRejectionReasonHeaderName,
  controlServiceTokenHeaderName,
  type HealthStatus,
  healthResponseSchema,
  type LoadMetricIngestRequest,
  loadRunIdHeaderName,
  type ReadinessCheck,
  type TrafficCompletionReport,
  type TrafficExecutionStartRequest,
  trafficExecutionAbortPath,
  trafficExecutionAbortResponseSchema,
  trafficExecutionStartPath,
  trafficExecutionStartResponseSchema,
} from "@checkout-surge/contracts";
import { correlationIdHeaderName, createSilentLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  HttpLoadApiClient,
  type LoadApiClient,
  MetricBatcher,
} from "../src/application/api-client.js";
import {
  ExecutionConflictError,
  FileExecutionStore,
  withCompletion,
} from "../src/application/execution-store.js";
import { K6LiveMetricAggregator } from "../src/application/k6-live-metric-aggregator.js";
import {
  BoundedStderrCollector,
  K6RunAccumulator,
  parseK6JsonLine,
} from "../src/application/k6-output-parser.js";
import {
  ExecutionSlotConflictError,
  type K6Runner,
  SpawnK6Runner,
  TrafficTerminationUnconfirmedError,
} from "../src/application/k6-runner.js";
import { generateK6Script } from "../src/application/k6-script.js";
import {
  collectLoadRunDiagnostics,
  runBoundedDiagnosticCommand,
} from "../src/application/load-run-diagnostics.js";
import { TrafficExecutionService } from "../src/application/traffic-execution-service.js";
import { type LoadOrchestratorConfig, loadLoadOrchestratorConfig } from "../src/runtime/config.js";
import { checkK6Executable, createLoadOrchestratorReadiness } from "../src/runtime/readiness.js";
import { buildLoadOrchestratorServer } from "../src/server.js";

const timestamp = "2026-06-20T12:00:00.000Z";
const completionTimestamp = "2026-06-20T12:00:05.000Z";
const startRequest: TrafficExecutionStartRequest = {
  runId: "55555555-5555-4555-8555-555555555555",
  saleOfferId: "22222222-2222-4222-8222-222222222222",
  apiBaseUrl: "http://localhost:4000",
  buyEndpointPath: "/buy",
  correlationId: "corr-load-test",
  configSnapshot: {
    trafficConfig: {
      mode: "buyer-spike",
      buyerCount: 200,
      duplicateEachBuyerAttempt: true,
      startDelaySeconds: 1,
      maxDurationSeconds: 5,
      quantityPerAttempt: 1,
    },
    inventoryConfig: {
      startingStock: 200,
      quantityPerCheckout: 1,
      reservationHoldMinutes: 15,
    },
    erpConfig: {
      latencyMs: 50,
      maxTps: 200,
      errorRate: 0,
      forcedOutage: false,
      requestTimeoutMs: 2000,
    },
    backpressureConfig: {
      queueName: "orders:process",
      physicalQueueName: "orders-process",
      orderProcessConcurrency: 5,
      retryPolicy: { maxAttempts: 4, initialBackoffMs: 500 },
      drainTimeoutSeconds: 300,
      pendingPersistenceRetryAfterSeconds: 30,
      circuitBreakerFailureThreshold: 5,
      circuitBreakerResetTimeoutMs: 10_000,
    },
  },
};

describe("load-orchestrator configuration", () => {
  it.each([
    undefined,
    "  ",
    "change-me-shared-control-token",
  ])("rejects unsafe control tokens (%s)", (token) => {
    expect(() => loadLoadOrchestratorConfig({ CONTROL_SERVICE_TOKEN: token })).toThrow(
      /CONTROL_SERVICE_TOKEN/,
    );
  });

  it("accepts a deployment-specific control token", () => {
    expect(
      loadLoadOrchestratorConfig({ CONTROL_SERVICE_TOKEN: "deployment-token" }).controlServiceToken,
    ).toBe("deployment-token");
  });
});

describe("durable execution ownership", () => {
  it("migrates Task-9 completion journals with timestamp-only diagnostics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-legacy-journal-"));
    try {
      const report = new K6RunAccumulator({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        plannedRequests: 400,
        startedAt: new Date(timestamp),
        executionPlan: generateK6Script(startRequest).executionPlan,
      }).completionReport({ status: "failed", completedAt: new Date(completionTimestamp) });
      await writeFile(
        path.join(directory, "execution.json"),
        JSON.stringify({
          request: startRequest,
          state: "completion_pending",
          acceptedAt: timestamp,
          completion: {
            ...report,
            httpTimingBreakdownSummary: {},
            loadRunDiagnosticsSummary: { startedAt: timestamp, completedAt: completionTimestamp },
          },
        }),
      );
      expect(
        (await new FileExecutionStore(directory).read())?.completion?.loadRunDiagnosticsSummary,
      ).toMatchObject({
        executionPlan: generateK6Script(startRequest).executionPlan,
        stderrLines: [],
        nproc: null,
      });
      expect(
        (await new FileExecutionStore(directory).read())?.completion?.httpTimingBreakdownSummary,
      ).toEqual({
        blocked: null,
        connecting: null,
        tlsHandshaking: null,
        sending: null,
        waiting: null,
        receiving: null,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    42,
    null,
  ])("migrates the legacy runner p95-only timing shape (%s) without relabeling duration", async (legacyP95LatencyMs) => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-legacy-journal-"));
    try {
      const report = new K6RunAccumulator({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        plannedRequests: 400,
        startedAt: new Date(timestamp),
        executionPlan: generateK6Script(startRequest).executionPlan,
      }).completionReport({ status: "failed", completedAt: new Date(completionTimestamp) });
      const {
        terminalMetricSources: _terminalMetricSources,
        summaryExportWarnings: _summaryExportWarnings,
        ...legacyDiagnostics
      } = report.loadRunDiagnosticsSummary;
      await writeFile(
        path.join(directory, "execution.json"),
        JSON.stringify({
          request: startRequest,
          state: "completion_pending",
          acceptedAt: timestamp,
          completion: {
            ...report,
            httpTimingBreakdownSummary: { p95LatencyMs: legacyP95LatencyMs },
            loadRunDiagnosticsSummary: legacyDiagnostics,
          },
        }),
      );

      const migrated = (await new FileExecutionStore(directory).read())?.completion;
      expect(migrated?.httpTimingBreakdownSummary).toEqual({
        blocked: null,
        connecting: null,
        tlsHandshaking: null,
        sending: null,
        waiting: null,
        receiving: null,
      });
      expect(migrated?.loadRunDiagnosticsSummary).toMatchObject({
        terminalMetricSources: {
          emittedRequests: null,
          completedRequests: null,
        },
        summaryExportWarnings: [
          "summary_export_missing",
          "k6_outcome_counter_summary_export_unavailable",
        ],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown legacy timing shapes instead of broadening journal migration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-legacy-journal-"));
    try {
      const report = new K6RunAccumulator({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        plannedRequests: 400,
        startedAt: new Date(timestamp),
        executionPlan: generateK6Script(startRequest).executionPlan,
      }).completionReport({ status: "failed", completedAt: new Date(completionTimestamp) });
      const {
        terminalMetricSources: _terminalMetricSources,
        summaryExportWarnings: _summaryExportWarnings,
        ...legacyDiagnostics
      } = report.loadRunDiagnosticsSummary;
      await writeFile(
        path.join(directory, "execution.json"),
        JSON.stringify({
          request: startRequest,
          state: "completion_pending",
          acceptedAt: timestamp,
          completion: {
            ...report,
            httpTimingBreakdownSummary: { p95LatencyMs: 42, extra: true },
            loadRunDiagnosticsSummary: legacyDiagnostics,
          },
        }),
      );
      await expect(new FileExecutionStore(directory).read()).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not broaden legacy migration to diagnostic objects with extra fields", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-legacy-journal-"));
    try {
      const report = new K6RunAccumulator({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        plannedRequests: 400,
        startedAt: new Date(timestamp),
        executionPlan: generateK6Script(startRequest).executionPlan,
      }).completionReport({ status: "failed", completedAt: new Date(completionTimestamp) });
      await writeFile(
        path.join(directory, "execution.json"),
        JSON.stringify({
          request: startRequest,
          state: "completion_pending",
          acceptedAt: timestamp,
          completion: {
            ...report,
            loadRunDiagnosticsSummary: {
              startedAt: timestamp,
              completedAt: completionTimestamp,
              recoveryReason: "not-a-Task-9-runner-summary",
            },
          },
        }),
      );
      await expect(new FileExecutionStore(directory).read()).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers accepted state and fences a different run across store instances", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-execution-store-"));
    try {
      const first = new FileExecutionStore(directory);
      await first.accept(startRequest, new Date(timestamp));
      const recovered = await new FileExecutionStore(directory).read();
      expect(recovered).toMatchObject({
        state: "accepted",
        request: { runId: startRequest.runId },
      });
      await expect(
        first.accept(
          { ...startRequest, runId: "66666666-6666-4666-8666-666666666666" },
          new Date(timestamp),
        ),
      ).rejects.toBeInstanceOf(ExecutionConflictError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists a terminal report until it can be acknowledged", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-execution-store-"));
    try {
      const store = new FileExecutionStore(directory);
      const { execution: accepted } = await store.accept(startRequest, new Date(timestamp));
      const accumulator = new K6RunAccumulator({
        executionPlan: generateK6Script(startRequest).executionPlan,
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        plannedRequests: 1,
        startedAt: new Date(timestamp),
      });
      const report = accumulator.completionReport({
        status: "failed",
        errorMessage: "restart",
        completedAt: new Date(completionTimestamp),
      });
      await store.update(withCompletion(accepted, report));
      expect(await new FileExecutionStore(directory).read()).toMatchObject({
        state: "completion_pending",
        completion: { runId: startRequest.runId, status: "failed" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("load-orchestrator k6 mapping", () => {
  it("runs production diagnostic commands with bounded stdout/stderr and argv spawning", async () => {
    for (const target of ["stdout", "stderr"] as const) {
      const fixture = createK6ProcessFixture();
      const result = runBoundedDiagnosticCommand("tool", ["version"], {
        spawnProcess: fixture.spawnProcess,
      });
      fixture[target].write("v".repeat(2_500));
      fixture.child.emit("close", 0);
      expect(await result).toHaveLength(2_000);
      expect(fixture.spawnProcess).toHaveBeenCalledWith("tool", ["version"], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  });

  it("kills and settles a timed-out production diagnostic command once", async () => {
    const fixture = createK6ProcessFixture();
    const result = runBoundedDiagnosticCommand("tool", [], {
      spawnProcess: fixture.spawnProcess,
      timeoutMs: 1,
      reapMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fixture.child.kill).toHaveBeenCalledTimes(1);
    fixture.child.emit("close", null, "SIGKILL");
    expect(await result).toBeNull();
    fixture.child.emit("close", 0);
    expect(fixture.child.kill).toHaveBeenCalledTimes(1);
  });

  it("collects bounded diagnostics and degrades malformed facts to null", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const diagnostics = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: vi.fn(async (command, args) =>
        command === "nproc"
          ? "8\n"
          : command === "sh"
            ? "bad"
            : args[0] === "version"
              ? "k6 v1\nextra"
              : null,
      ),
      readText: vi.fn(async (file) =>
        file.endsWith("limits")
          ? "Max open files 1024 2048 files\n"
          : file.endsWith("ip_local_port_range")
            ? "32768\t60999\n"
            : file.endsWith("tcp_tw_reuse")
              ? "2"
              : "malformed",
      ),
    });
    expect(diagnostics).toEqual({
      nproc: 8,
      ulimitNofile: null,
      processMaxOpenFiles: { soft: 1024, hard: 2048 },
      networkDiagnostics: { ipLocalPortRange: "32768 60999", tcpTwReuse: 2, tcpTimestamps: null },
      k6Version: "k6 v1",
      executionPlan: plan,
    });
  });

  it("rejects partially parsed diagnostic integers and malformed port ranges", async () => {
    const plan = generateK6Script(startRequest).executionPlan;
    const diagnostics = await collectLoadRunDiagnostics("k6", plan, {
      runCommand: vi.fn(async (command) => (command === "nproc" ? "8junk" : "2 garbage")),
      readText: vi.fn(async (file) =>
        file.endsWith("limits")
          ? "Max open files 1024garbage 2048 files\n"
          : file.endsWith("ip_local_port_range")
            ? "32768 60999 trailing"
            : file.endsWith("tcp_tw_reuse")
              ? "2garbage"
              : "1 2",
      ),
    });
    expect(diagnostics).toMatchObject({
      nproc: null,
      ulimitNofile: null,
      processMaxOpenFiles: null,
      networkDiagnostics: null,
      k6Version: "2 garbage",
    });
  });

  it("frames and bounds retained stderr by logical line", () => {
    const collector = new BoundedStderrCollector();
    collector.push("split");
    collector.push("-line\nsecond\n");
    for (let index = 0; index < 50; index += 1) collector.push(`line-${index}\n`);
    collector.push("x".repeat(501));
    collector.finish();
    expect(collector.snapshot()).toMatchObject({
      stderrLineCountObserved: 53,
      stderrLineCountRetained: 50,
      stderrLineTruncatedCount: 1,
    });
    expect(collector.snapshot().stderrLines.at(-1)).toHaveLength(500);
    expect(collector.snapshot().stderrLines[0]).toBe("line-1");
    const huge = new BoundedStderrCollector();
    huge.push("z".repeat(1_000_000));
    huge.finish();
    expect(huge.snapshot()).toMatchObject({
      stderrLines: ["z".repeat(500)],
      stderrLineTruncatedCount: 1,
    });
  });

  it("frames CRLF split across chunks without retaining the carriage return", () => {
    const collector = new BoundedStderrCollector();
    collector.push("first\r");
    collector.push("\n\r");
    collector.push("\nlast\r");
    collector.finish();
    expect(collector.snapshot()).toMatchObject({
      stderrLines: ["first", "", "last\r"],
      stderrLineCountObserved: 3,
      stderrLineTruncatedCount: 0,
    });
  });
  it("generates a contract-driven buyer-spike script without shell interpolation", () => {
    const script = generateK6Script(startRequest);

    expect(script.plannedRequests).toBe(400);
    expect(script.executionPlan).toEqual({
      trafficMode: "buyer-spike",
      buyerCount: 200,
      duplicateEachBuyerAttempt: true,
      iterationsPerVu: 2,
      plannedEmittedAttempts: 400,
      startDelaySeconds: 1,
      maxDurationSeconds: 5,
    });
    expect(script.contents).toContain('"executor":"per-vu-iterations"');
    expect(script.contents).toContain('"vus":200');
    expect(script.contents).toContain('"iterations":2');
    expect(script.contents).toContain("http.post");
    expect(script.contents).toContain(
      "const expectedCheckoutStatuses = http.expectedStatuses(202, 409);",
    );
    expect(script.contents).toContain("responseCallback: expectedCheckoutStatuses");
    expect(script.contents).toContain('"discardResponseBodies":true');
    expect(script.contents).toContain(
      `const checkoutOutcomeHeaderName = "${buyOutcomeHeaderName}"`,
    );
    expect(script.contents).toContain(
      `const checkoutRejectionReasonHeaderName = "${buyRejectionReasonHeaderName}"`,
    );
    expect(script.contents).toContain(`"${correlationIdHeaderName}": correlationId`);
    expect(script.contents).not.toContain("response.json(");
    expect(script.contents).toContain('outcome === "reservation_secured"');
    expect(script.contents).toContain('outcome === "idempotent_replay"');
    expect(script.contents).toContain('outcome === "reservation_pending_persistence"');
    expect(script.contents).toContain(
      'response.status === 409 && outcome === "sold_out" && rejectionReason === "sold_out"',
    );
    expect(script.contents).toContain("key.toLowerCase() === headerName");
    expect(script.contents).toContain("run:");
    expect(script.contents).toContain(":buyer:");
    expect(script.contents).toContain("config.duplicateEachBuyerAttempt ? __VU : iteration");
    expect(script.contents).toContain(`config.correlationId}:k6:\${iteration}`);
    expect(script.contents).toContain(`"${loadRunIdHeaderName}": config.runId`);
  });

  it("generates a steady-arrival scenario with k6 VU controls", () => {
    const script = generateK6Script({
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: {
          mode: "steady-arrival-rate",
          ratePerSecond: 20,
          startDelaySeconds: 2,
          durationSeconds: 10,
          quantityPerAttempt: 1,
          k6Vus: { preAllocatedVus: 10, maxVus: 50 },
        },
      },
    });

    expect(script.plannedRequests).toBe(200);
    expect(script.contents).toContain('"executor":"constant-arrival-rate"');
    expect(script.contents).toContain('"rate":20');
    expect(script.contents).toContain('"preAllocatedVUs":10');
    expect(script.contents).toContain('"maxVUs":50');
    expect(script.contents).toContain(
      'config.trafficMode === "steady-arrival-rate" && iteration >= config.plannedRequests',
    );
    expect(script.contents.indexOf("iteration >= config.plannedRequests")).toBeLessThan(
      script.contents.indexOf("const buyerId"),
    );
    expect(script.contents.indexOf("iteration >= config.plannedRequests")).toBeLessThan(
      script.contents.indexOf("http.post"),
    );
    expect(script.executionPlan).toMatchObject({
      preAllocatedVus: 10,
      maxVus: 50,
      plannedEmittedAttempts: 200,
    });
  });

  it("sources buy quantity from traffic attempts rather than inventory checkout sizing", () => {
    const script = generateK6Script({
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: { ...startRequest.configSnapshot.trafficConfig, quantityPerAttempt: 3 },
        inventoryConfig: {
          ...startRequest.configSnapshot.inventoryConfig,
          quantityPerCheckout: 7,
        },
      },
    });

    expect(script.contents).toContain('"quantity":3');
    expect(script.contents).not.toContain('"quantity":7');
  });

  it("uses the same default steady VU values in the script and diagnostic plan", () => {
    const script = generateK6Script({
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: {
          mode: "steady-arrival-rate",
          ratePerSecond: 21,
          startDelaySeconds: 0,
          durationSeconds: 2,
          quantityPerAttempt: 1,
        },
      },
    });
    expect(script.executionPlan).toMatchObject({ preAllocatedVus: 11, maxVus: 42 });
    expect(script.contents).toContain('"preAllocatedVUs":11');
    expect(script.contents).toContain('"maxVUs":42');
  });

  it("emits a parseable k6 module using the expected public k6 APIs", async () => {
    const script = generateK6Script(startRequest);
    const workDir = await mkdtemp(path.join(tmpdir(), "checkout-surge-k6-script-check-"));
    const scriptPath = path.join(workDir, "scenario.mjs");

    try {
      await writeFile(scriptPath, script.contents, "utf8");
      const checkResult = spawnSync(process.execPath, ["--check", scriptPath], {
        encoding: "utf8",
      });

      if (checkResult.status !== 0) {
        throw new Error(
          `Generated k6 script failed Node syntax validation.\nstdout:\n${checkResult.stdout}\nstderr:\n${checkResult.stderr}`,
        );
      }

      expect(script.contents).toContain('import http from "k6/http";');
      expect(script.contents).toContain('import { check } from "k6";');
      expect(script.contents).toContain('import exec from "k6/execution";');
      expect(script.contents).toContain('import { Counter } from "k6/metrics";');
      expect(script.contents).toContain("http.expectedStatuses(202, 409)");
      expect(script.contents).toContain("exec.scenario.iterationInTest");
      expect(script.contents).toContain('new Counter("checkout_reservation_accepted")');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("keeps terminal totals independent from windowed dashboard metrics", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 2,
      startedAt: new Date(timestamp),
    });
    const lines = [
      JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } }),
      JSON.stringify({
        type: "Point",
        metric: "http_req_duration",
        data: { value: 42, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "http_req_failed",
        data: { value: 0, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      }),
      JSON.stringify({
        type: "Point",
        metric: "checkout_sold_out",
        data: { value: 1, time: timestamp },
      }),
    ];
    const liveMetrics = new K6LiveMetricAggregator();
    for (const line of lines) {
      const point = parseK6JsonLine(line);
      if (point) {
        accumulator.observe(point);
        liveMetrics.observe(point);
      }
    }
    const samples = liveMetrics.flush();

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(samples.map((sample) => sample.metricName)).toEqual([
      "traffic.scheduled_request_rate",
      "traffic.latency",
      "traffic.failure_rate",
    ]);
    expect(report.httpSummary).toMatchObject({
      plannedRequests: 2,
      emittedRequests: 1,
      acceptedResponses: 1,
      soldOutResponses: 1,
      unexpectedResponses: 0,
    });
    expect(report.trafficDeliverySummary).toMatchObject({
      requestShortfall: 1,
      trafficMode: "buyer-spike",
      plannedBuyers: 200,
    });
    expect(report.trafficDeliverySummary).not.toHaveProperty("trafficDeliveryStatus");
  });

  it("reports successful k6 execution as traffic success without terminal demo-run state", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    });

    const point = parseK6JsonLine(
      JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } }),
    );
    if (!point) {
      throw new Error("Expected k6 point fixture to parse.");
    }

    accumulator.observe(point);
    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      trafficDeliverySummary: {
        trafficMode: "buyer-spike",
        plannedBuyers: 200,
        requestShortfall: 0,
      },
    });
    expect(report).not.toHaveProperty("demoRunStatus");
    expect(report).not.toHaveProperty("finalizedAt");
  });

  it("does not count clean sold-out responses as failed HTTP summary outcomes", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 2,
      startedAt: new Date(timestamp),
    });

    [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "checkout_sold_out", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "checkout_sold_out", data: { value: 1, time: timestamp } },
    ].forEach((point) => {
      accumulator.observe(point);
    });

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report.httpSummary).toMatchObject({
      plannedRequests: 2,
      emittedRequests: 2,
      failedRequests: 0,
      acceptedResponses: 0,
      soldOutResponses: 2,
      unexpectedResponses: 0,
      failureRate: 1,
    });
    expect(report.apiRequestLifecycleSummary).toMatchObject({
      completedRequests: 2,
      failedRequests: 0,
    });
    expect(report.trafficDeliverySummary).not.toHaveProperty("trafficDeliveryStatus");
  });

  it("counts unexpected checkout responses as failed HTTP summary outcomes", () => {
    const accumulator = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    });

    [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 0, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_unexpected_response",
        data: { value: 1, time: timestamp },
      },
    ].forEach((point) => {
      accumulator.observe(point);
    });

    const report = accumulator.completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date(completionTimestamp),
    });

    expect(report.httpSummary).toMatchObject({
      plannedRequests: 1,
      emittedRequests: 1,
      failedRequests: 1,
      soldOutResponses: 0,
      unexpectedResponses: 1,
      failureRate: 0,
    });
    expect(report.apiRequestLifecycleSummary).toMatchObject({
      completedRequests: 1,
      failedRequests: 1,
    });
    expect(report.trafficDeliverySummary).toMatchObject({ requestShortfall: 0, notes: [] });
    expect(report.trafficDeliverySummary).not.toHaveProperty("trafficDeliveryStatus");
  });

  it("reports buyer-spike plan facts and derives terminal iteration diagnostics", () => {
    const executionPlan = generateK6Script(startRequest).executionPlan;
    const accumulator = new K6RunAccumulator({
      executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
      startedAt: new Date(timestamp),
    });
    accumulator.observe({ type: "Point", metric: "http_reqs", data: { value: 401 } });
    accumulator.observe({ type: "Point", metric: "iterations", data: { value: 398 } });
    accumulator.observe({ type: "Point", metric: "dropped_iterations", data: { value: 1 } });

    expect(
      accumulator.completionReport({
        status: "succeeded",
        completedAt: new Date(completionTimestamp),
      }).trafficDeliverySummary,
    ).toMatchObject({
      trafficMode: "buyer-spike",
      plannedBuyers: 200,
      scheduledRatePerSecond: null,
      configuredDurationSeconds: null,
      preAllocatedVUs: null,
      maxVUs: null,
      completedIterations: 398,
      droppedIterations: 1,
      unstartedIterations: 1,
      requestShortfall: 0,
    });
  });

  it("reports exact effective steady-arrival plan facts and null unavailable iterations", () => {
    const steadyRequest = {
      ...startRequest,
      configSnapshot: {
        ...startRequest.configSnapshot,
        trafficConfig: {
          mode: "steady-arrival-rate" as const,
          ratePerSecond: 9,
          startDelaySeconds: 0,
          durationSeconds: 7,
          quantityPerAttempt: 1,
        },
      },
    };
    const executionPlan = generateK6Script(steadyRequest).executionPlan;
    const accumulator = new K6RunAccumulator({
      executionPlan,
      runId: steadyRequest.runId,
      correlationId: steadyRequest.correlationId,
      plannedRequests: executionPlan.plannedEmittedAttempts,
      startedAt: new Date(timestamp),
    });

    expect(
      accumulator.completionReport({
        status: "succeeded",
        completedAt: new Date(completionTimestamp),
      }).trafficDeliverySummary,
    ).toMatchObject({
      trafficMode: "steady-arrival-rate",
      plannedBuyers: null,
      scheduledRatePerSecond: 9,
      configuredDurationSeconds: 7,
      preAllocatedVUs: 5,
      maxVUs: 18,
      completedIterations: null,
      unstartedIterations: null,
      requestShortfall: 63,
    });
  });
});

describe("SpawnK6Runner completion reporting", () => {
  it("waits for the authoritative summary, reuses one report across retries, then cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    let releaseSummary: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      now: createClock([timestamp, completionTimestamp]),
      readSummaryFile: async () => {
        await summaryGate;
        return JSON.stringify({
          metrics: {
            http_reqs: { count: 0 },
            checkout_reservation_accepted: { count: 0 },
            checkout_sold_out: { count: 0 },
            checkout_unexpected_response: { count: 0 },
            iterations: { count: 0 },
            dropped_iterations: { count: 0 },
            http_req_failed: { value: 0 },
            http_req_duration: { avg: 0, "p(95)": 0 },
          },
        });
      },
      completionRetry: { maxAttempts: 2, initialBackoffMs: 0, sleep: async () => undefined },
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
          if (reports.length === 1) throw new Error("transient completion failure");
        },
      },
    });

    await runner.start(startRequest);
    const workDir = path.dirname(getSingleSpawnCall(k6Process).scriptPath);
    k6Process.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 9, time: timestamp } })}\n`,
    );
    k6Process.child.emit("close", 0);
    await waitForReadline();
    expect(reports).toHaveLength(0);
    expect(await pathMissing(workDir)).toBe(false);

    releaseSummary();
    await waitForCompletionReport(reports, 2);
    await waitForCondition(() => pathMissing(workDir), "summary-owned temp directory cleanup");

    expect(reports[0]).toBe(reports[1]);
    expect(reports[1]?.httpSummary.emittedRequests).toBe(0);
    expect(reports[1]?.loadRunDiagnosticsSummary).toMatchObject({
      terminalMetricSources: {
        emittedRequests: "summary_export",
        completedRequests: "summary_export",
      },
      summaryExportWarnings: [],
    });
  });

  it.each([
    { name: "missing", warning: "summary_export_missing" as const, errorCode: "ENOENT" },
    { name: "invalid", warning: "summary_export_invalid" as const, contents: "{}" },
    {
      name: "read failure",
      warning: "summary_export_read_failed" as const,
      errorCode: "EACCES",
    },
  ])("delivers point fallback once after a $name summary is resolved", async ({
    warning,
    errorCode,
    contents,
  }) => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    let releaseSummary: () => void = () => undefined;
    let markSummaryReadStarted: () => void = () => undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summaryReadStarted = new Promise<void>((resolve) => {
      markSummaryReadStarted = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      now: createClock([timestamp, completionTimestamp]),
      readSummaryFile: async () => {
        markSummaryReadStarted();
        await summaryGate;
        if (errorCode) throw Object.assign(new Error("summary read failed"), { code: errorCode });
        return contents ?? "{}";
      },
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });

    await runner.start(startRequest);
    const workDir = path.dirname(getSingleSpawnCall(k6Process).scriptPath);
    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 2, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      },
    ]);
    k6Process.child.emit("close", 0);
    await summaryReadStarted;
    expect(reports).toHaveLength(0);
    expect(await pathMissing(workDir)).toBe(false);

    releaseSummary();
    const report = await waitForCompletionReport(reports, 1);
    await waitForCondition(() => pathMissing(workDir), "degraded summary cleanup");
    await waitForReadline();

    expect(reports).toHaveLength(1);
    expect(report.httpSummary).toMatchObject({ emittedRequests: 2, acceptedResponses: 1 });
    expect(report.loadRunDiagnosticsSummary.terminalMetricSources).toMatchObject({
      emittedRequests: "point_stream",
      completedRequests: "point_stream",
      acceptedResponses: "point_stream",
    });
    expect(report.loadRunDiagnosticsSummary.summaryExportWarnings).toEqual([
      warning,
      "k6_outcome_counter_point_stream_fallback_used",
      "k6_outcome_counter_summary_export_unavailable",
    ]);
  });

  it("cancels preparation before spawn and retains the slot until preparation settles", async () => {
    let releaseDiagnostics: () => void = () => undefined;
    const diagnosticGate = new Promise<string | null>((resolve) => {
      releaseDiagnostics = () => resolve(null);
    });
    const spawnProcess = vi.fn() as unknown as typeof spawn;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      diagnostics: {
        runCommand: async () => diagnosticGate,
        readText: async () => {
          throw new Error("missing");
        },
      },
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    const start = runner.start(startRequest);
    const cancellation = runner.abort(startRequest.runId);
    await expect(runner.start(startRequest)).rejects.toBeInstanceOf(ExecutionSlotConflictError);
    releaseDiagnostics();
    await expect(start).rejects.toThrow();
    await expect(cancellation).resolves.toBe("aborted");
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(runner.currentRunId()).toBeNull();
  });

  it("waits for a matching child to close and suppresses normal completion on cancellation", async () => {
    const k6Process = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      shutdownGraceMs: 100,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    await runner.start(startRequest);
    const cancellation = runner.abort(startRequest.runId);
    const duplicateCancellation = runner.abort(startRequest.runId);
    expect(duplicateCancellation).toBe(cancellation);
    expect(k6Process.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runner.currentRunId()).toBe(startRequest.runId);
    await expect(runner.start(startRequest)).rejects.toBeInstanceOf(ExecutionSlotConflictError);
    k6Process.child.emit("close", null, "SIGTERM");
    await cancellation;
    expect(runner.currentRunId()).toBeNull();
    expect(completions).toEqual([]);
    expect(k6Process.child.kill).toHaveBeenCalledTimes(1);
  });

  it("keeps a confirmed cancellation fenced until shutdown can durably release its journal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-cancel-release-"));
    class FailingCancellationReleaseStore extends FileExecutionStore {
      failCancellationRelease = true;

      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (
          this.failCancellationRelease &&
          execution.state === "completed" &&
          !execution.completion
        )
          throw new Error("cancellation journal unavailable");
        return super.update(execution);
      }
    }
    const store = new FailingCancellationReleaseStore(directory);
    const fixture = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      shutdownGraceMs: 20,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    try {
      await runner.start(startRequest);
      const cancellation = runner.abort(startRequest.runId);
      fixture.child.emit("close", null, "SIGTERM");
      await expect(cancellation).rejects.toThrow("cancellation journal unavailable");
      expect(runner.currentRunId()).toBe(startRequest.runId);
      await expect(
        runner.start({ ...startRequest, runId: "66666666-6666-4666-8666-666666666666" }),
      ).rejects.toBeInstanceOf(ExecutionSlotConflictError);
      await expect(runner.close()).rejects.toThrow("cancellation journal unavailable");

      store.failCancellationRelease = false;
      await expect(runner.close()).resolves.toBeUndefined();
      expect(await store.read()).toMatchObject({ state: "completed" });
      expect((await store.read())?.completion).toBeUndefined();
      expect(completions).toEqual([]);
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      expect(runner.currentRunId()).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("finishes a fenced cancellation during shutdown after an unconfirmed child closes late", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-cancel-late-close-"));
    const store = new FileExecutionStore(directory);
    const fixture = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      shutdownGraceMs: 0,
      shutdownKillWaitMs: 1,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    try {
      await runner.start(startRequest);
      await expect(runner.abort(startRequest.runId)).rejects.toBeInstanceOf(
        TrafficTerminationUnconfirmedError,
      );
      fixture.child.emit("close", null, "SIGKILL");

      await expect(runner.close()).resolves.toBeUndefined();
      expect(await store.read()).toMatchObject({ state: "completed" });
      expect((await store.read())?.completion).toBeUndefined();
      expect(completions).toEqual([]);
      expect(fixture.child.kill).toHaveBeenCalledTimes(2);
      expect(runner.currentRunId()).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares termination and journal release when shutdown races cancellation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-cancel-close-race-"));
    let releaseJournal: () => void = () => undefined;
    const journalGate = new Promise<void>((resolve) => {
      releaseJournal = resolve;
    });
    class GatedCancellationReleaseStore extends FileExecutionStore {
      cancellationReleaseCount = 0;

      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (execution.state === "completed" && !execution.completion) {
          this.cancellationReleaseCount += 1;
          await journalGate;
        }
        return super.update(execution);
      }
    }
    const store = new GatedCancellationReleaseStore(directory);
    const fixture = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      shutdownGraceMs: 20,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    try {
      await runner.start(startRequest);
      const cancellation = runner.abort(startRequest.runId);
      const closing = runner.close();
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      fixture.child.emit("close", null, "SIGTERM");
      await waitForCondition(
        () => store.cancellationReleaseCount === 1,
        "cancellation journal release",
      );
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      releaseJournal();

      await expect(Promise.all([cancellation, closing])).resolves.toEqual(["aborted", undefined]);
      expect(store.cancellationReleaseCount).toBe(1);
      expect(fixture.child.kill).toHaveBeenCalledTimes(1);
      expect((await store.read())?.completion).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not confirm cancellation while an already-active metric flush can still complete", async () => {
    const fixture = createK6ProcessFixture();
    let releaseMetrics: () => void = () => undefined;
    const metricGate = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const sendMetrics = vi.fn(async () => metricGate);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      metricBatchSize: 1,
      shutdownGraceMs: 100,
      apiClient: { sendMetrics, sendCompletion: async () => undefined },
    });
    await runner.start(startRequest);
    fixture.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } })}\n`,
    );
    fixture.stdout.write(
      `${JSON.stringify({ type: "Point", metric: "http_reqs", data: { value: 1, time: completionTimestamp } })}\n`,
    );
    await waitForCondition(() => sendMetrics.mock.calls.length === 1, "active metric flush");
    let cancellationSettled = false;
    const cancellation = runner.abort(startRequest.runId).then(() => {
      cancellationSettled = true;
    });
    fixture.child.emit("close", null, "SIGTERM");
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    releaseMetrics();
    await cancellation;
    expect(cancellationSettled).toBe(true);
    expect(sendMetrics).toHaveBeenCalledTimes(1);
  });

  it("lets natural close win before abort without suppressing or duplicating completion", async () => {
    const fixture = createK6ProcessFixture();
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    await runner.start(startRequest);
    fixture.child.emit("close", 0);
    await expect(runner.abort(startRequest.runId)).resolves.toBe("natural_completion");
    await waitForCompletionReport(completions, 1);
    expect(completions).toHaveLength(1);
    expect(fixture.child.kill).not.toHaveBeenCalled();
  });

  it("identity-fences stale child callbacks from a successor", async () => {
    const first = createK6ProcessFixture();
    const second = createK6ProcessFixture();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const completions: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          completions.push(report);
        },
      },
    });
    await runner.start(startRequest);
    first.child.emit("close", 0);
    await waitForCompletionReport(completions, 1);
    const successor = { ...startRequest, runId: "66666666-6666-4666-8666-666666666666" };
    await runner.start(successor);
    first.child.emit("error", new Error("late"));
    first.child.emit("close", 1);
    expect(runner.currentRunId()).toBe(successor.runId);
    expect(completions).toHaveLength(1);
    const cancellation = runner.abort(successor.runId);
    second.child.emit("close", null, "SIGTERM");
    await cancellation;
  });

  it("escalates cancellation once and retains the fence when reap is unconfirmed", async () => {
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      shutdownGraceMs: 0,
      shutdownKillWaitMs: 1,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    await runner.start(startRequest);
    await expect(runner.abort(startRequest.runId)).rejects.toBeInstanceOf(
      TrafficTerminationUnconfirmedError,
    );
    expect(k6Process.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(k6Process.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(k6Process.child.kill).toHaveBeenCalledTimes(2);
    expect(runner.currentRunId()).toBe(startRequest.runId);
    await expect(
      runner.start({ ...startRequest, runId: "66666666-6666-4666-8666-666666666666" }),
    ).rejects.toBeInstanceOf(ExecutionSlotConflictError);
  });

  it("retains the cancellation fence when sending a termination signal throws", async () => {
    const fixture = createK6ProcessFixture();
    vi.mocked(fixture.child.kill).mockImplementation(() => {
      throw new Error("kill unavailable");
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: fixture.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    await runner.start(startRequest);
    await expect(runner.abort(startRequest.runId)).rejects.toBeInstanceOf(
      TrafficTerminationUnconfirmedError,
    );
    expect(runner.currentRunId()).toBe(startRequest.runId);
  });

  it("shares termination when cancellation races executing-journal publication failure", async () => {
    const fixture = createK6ProcessFixture();
    let rejectExecuting: (_error: Error) => void = () => undefined;
    const executingUpdate = new Promise<never>((_resolve, reject) => {
      rejectExecuting = reject;
    });
    const accepted = { request: startRequest, state: "accepted" as const, acceptedAt: timestamp };
    const store = {
      accept: vi.fn(async () => ({ execution: accepted, created: true })),
      read: vi.fn(async () => accepted),
      update: vi.fn((value: { state: string }) =>
        value.state === "executing" ? executingUpdate : Promise.resolve(),
      ),
    } as unknown as FileExecutionStore;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      executionStore: store,
      spawnProcess: fixture.spawnProcess,
      shutdownGraceMs: 1,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    const start = runner.start(startRequest);
    await waitForCondition(
      () => vi.mocked(fixture.spawnProcess).mock.calls.length === 1,
      "spawn publication",
    );
    const cancellation = runner.abort(startRequest.runId);
    rejectExecuting(new Error("journal failed"));
    await waitForCondition(
      () => vi.mocked(fixture.child.kill).mock.calls.length >= 2,
      "kill escalation",
    );
    fixture.child.emit("close", null, "SIGKILL");
    await expect(start).rejects.toThrow("journal failed");
    await cancellation;
    expect(fixture.child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(fixture.child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(fixture.child.kill).toHaveBeenCalledTimes(2);
  });

  it("durably reports a synchronous spawn preparation failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-spawn-failure-"));
    const store = new FileExecutionStore(directory);
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      spawnProcess: vi.fn(() => {
        throw new Error("synchronous spawn failure");
      }) as unknown as typeof spawn,
    });
    try {
      await expect(runner.start(startRequest)).rejects.toThrow("synchronous spawn failure");
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: { status: "failed", errorMessage: "synchronous spawn failure" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers accepted state as a failed pending completion before delivery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-recovery-"));
    const store = new FileExecutionStore(directory);
    await store.accept(startRequest, new Date(timestamp));
    let stateDuringDelivery: string | undefined;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      retryIntervalMs: 60_000,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async () => {
          stateDuringDelivery = (await store.read())?.state;
        },
      },
    });
    try {
      await runner.initialize();
      expect(stateDuringDelivery).toBe("completion_pending");
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: {
          status: "failed",
          errorMessage: "load_orchestrator_restarted_before_k6_completion",
        },
      });
      await runner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains pending recovery delivery after failure and completes on periodic retry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-retry-"));
    const store = new FileExecutionStore(directory);
    await store.accept(startRequest, new Date(timestamp));
    let attempts = 0;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      retryIntervalMs: 5,
      logger: createSilentLogger("load-orchestrator"),
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary malformed acknowledgement");
        },
      },
    });
    try {
      await runner.initialize();
      expect(await store.read()).toMatchObject({ state: "completion_pending" });
      await waitForCondition(
        async () => (await store.read())?.state === "completed",
        "pending completion retry acknowledgement",
      );
      expect(attempts).toBeGreaterThanOrEqual(2);
      await runner.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("writes a temporary script, streams parsed metric batches, reports success, and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const metricBatches: LoadMetricIngestRequest[] = [];
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async (batch) => {
        metricBatches.push(batch);
      }),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    const start = await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);
    const script = await readFile(spawnCall.scriptPath, "utf8");

    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_duration", data: { value: 42, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 0, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_reservation_accepted",
        data: { value: 1, time: timestamp },
      },
    ]);
    const encodedStderr = Buffer.from("prefix-€\r\n", "utf8");
    k6Process.stderr.write(encodedStderr.subarray(0, 8));
    k6Process.stderr.write(encodedStderr.subarray(8));
    await waitForReadline();
    k6Process.child.emit("close", 0);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");

    expect(start).toEqual({ startedAt: new Date(timestamp), plannedRequests: 400 });
    expect(spawnCall.binary).toBe("k6");
    expect(spawnCall.args).toEqual([
      "run",
      "--quiet",
      "--summary-export",
      path.join(workDir, "summary.json"),
      "--out",
      "json=-",
      spawnCall.scriptPath,
    ]);
    expect(spawnCall.options).toEqual({
      detached: false,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(script).toContain(
      'export const options = {"discardResponseBodies":true,"scenarios":{"checkout":',
    );
    expect(script).toContain(startRequest.runId);
    expect(apiClient.sendMetrics).toHaveBeenCalledTimes(1);
    expect(metricBatches).toEqual([
      {
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [
          {
            metricName: "traffic.scheduled_request_rate",
            value: 1,
            unit: "requests_per_second",
            timestamp,
          },
          { metricName: "traffic.latency", value: 42, unit: "ms", timestamp },
          { metricName: "traffic.failure_rate", value: 0, unit: "ratio", timestamp },
        ],
        observedAt: expect.any(String),
      },
    ]);
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      completedAt: completionTimestamp,
      correlationId: startRequest.correlationId,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        failedRequests: 0,
        acceptedResponses: 1,
        unexpectedResponses: 0,
        failureRate: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        requestShortfall: 399,
      },
      loadRunDiagnosticsSummary: {
        stderrLines: ["prefix-€"],
        stderrLineCountObserved: 1,
      },
    });
  });

  it("drains split and unterminated stdout and sends the final live window before completion", async () => {
    const k6Process = createK6ProcessFixture();
    const calls: string[] = [];
    const reports: TrafficCompletionReport[] = [];
    let releaseMetrics: () => void = () => undefined;
    const metricsGate = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      now: createClock([timestamp, completionTimestamp]),
      apiClient: {
        sendMetrics: async () => {
          calls.push("metrics");
          await metricsGate;
        },
        sendCompletion: async (report) => {
          calls.push("completion");
          reports.push(report);
        },
      },
    });

    await runner.start(startRequest);
    const finalLine = JSON.stringify({
      type: "Point",
      metric: "http_reqs",
      data: { value: 2, time: timestamp },
    });
    const splitAt = Math.floor(finalLine.length / 2);
    k6Process.stdout.write("not json\n");
    k6Process.stdout.write(finalLine.slice(0, splitAt));
    k6Process.stdout.end(finalLine.slice(splitAt));
    k6Process.child.emit("close", 0);

    await waitForCondition(() => calls.includes("metrics"), "final window metric send");
    expect(calls).toEqual(["metrics"]);
    expect(reports).toEqual([]);
    releaseMetrics();
    const report = await waitForCompletionReport(reports, 1);

    expect(calls).toEqual(["metrics", "completion"]);
    expect(report.httpSummary.emittedRequests).toBe(2);
  });

  it("reports non-zero k6 exits as failed completions and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const metricBatches: LoadMetricIngestRequest[] = [];
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async (batch) => {
        metricBatches.push(batch);
      }),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);

    writeK6JsonLines(k6Process.stdout, [
      { type: "Point", metric: "http_reqs", data: { value: 1, time: timestamp } },
      { type: "Point", metric: "http_req_failed", data: { value: 1, time: timestamp } },
      {
        type: "Point",
        metric: "checkout_unexpected_response",
        data: { value: 1, time: timestamp },
      },
      { type: "Point", metric: "dropped_iterations", data: { value: 1, time: timestamp } },
    ]);
    await waitForReadline();
    k6Process.child.emit("close", 23);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");

    expect(apiClient.sendMetrics).toHaveBeenCalledTimes(1);
    expect(metricBatches[0]?.samples.map((sample) => sample.metricName)).toEqual([
      "traffic.scheduled_request_rate",
      "traffic.failure_rate",
    ]);
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "failed",
      exitCode: 23,
      errorMessage: "k6 exited with code 23.",
      completedAt: completionTimestamp,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        failedRequests: 1,
        unexpectedResponses: 1,
        failureRate: 1,
      },
      trafficDeliverySummary: {
        plannedRequests: 400,
        emittedRequests: 1,
        droppedIterations: 1,
        requestShortfall: 399,
        notes: ["k6_dropped_iterations_observed"],
      },
    });
  });

  it("reports spawn errors once even when close follows error and cleans up", async () => {
    const k6Process = createK6ProcessFixture();
    const completionReports: TrafficCompletionReport[] = [];
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async () => undefined),
      sendCompletion: vi.fn(async (report) => {
        completionReports.push(report);
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "/missing/k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: createClock([timestamp, completionTimestamp]),
      spawnProcess: k6Process.spawnProcess,
    });

    await runner.start(startRequest);
    const spawnCall = getSingleSpawnCall(k6Process);
    const workDir = path.dirname(spawnCall.scriptPath);

    k6Process.child.emit("error", new Error("spawn /missing/k6 ENOENT"));
    k6Process.child.emit("close", -2);

    const report = await waitForCompletionReport(completionReports, 1);
    await waitForCondition(() => pathMissing(workDir), "k6 temp directory cleanup");
    await waitForReadline();

    expect(apiClient.sendMetrics).not.toHaveBeenCalled();
    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(1);
    expect(report).toMatchObject({
      runId: startRequest.runId,
      status: "failed",
      errorMessage: "spawn /missing/k6 ENOENT",
      completedAt: completionTimestamp,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 0,
        failedRequests: 0,
      },
      trafficDeliverySummary: {
        plannedRequests: 400,
        emittedRequests: 0,
        requestShortfall: 400,
      },
    });
    expect(report).not.toHaveProperty("exitCode");
  });

  it("retains child ownership after error until close proves the process exited", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-owner-"));
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      executionStore: new FileExecutionStore(directory),
      completionRetry: { maxAttempts: 1 },
    });
    try {
      await runner.start(startRequest);
      await expect(runner.start(startRequest)).resolves.toMatchObject({ plannedRequests: 400 });
      expect(k6Process.spawnProcess).toHaveBeenCalledTimes(1);
      k6Process.child.emit("error", new Error("spawn error after child creation"));
      await waitForReadline();
      expect(reports).toHaveLength(0);
      await expect(
        runner.start({ ...startRequest, runId: "66666666-6666-4666-8666-666666666666" }),
      ).rejects.toThrow("still owns");
      k6Process.child.emit("close", 1);
      await waitForCompletionReport(reports, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("terminates and reaps a spawned child when executing-state publication fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-publication-failure-"));
    class FailExecutingUpdateOnceStore extends FileExecutionStore {
      private shouldFail = true;
      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (execution.state === "executing" && this.shouldFail) {
          this.shouldFail = false;
          throw new Error("executing publication unavailable");
        }
        return super.update(execution);
      }
    }
    const store = new FailExecutingUpdateOnceStore(directory);
    const first = createK6ProcessFixture();
    const second = createK6ProcessFixture();
    Object.assign(first.child, {
      kill: vi.fn((signal?: NodeJS.Signals | number) => {
        Object.assign(first.child, { killed: true });
        queueMicrotask(() => first.child.emit("close", signal === "SIGKILL" ? 137 : 143));
        return true;
      }),
    });
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(first.child)
      .mockReturnValueOnce(second.child) as unknown as typeof spawn;
    const reports: TrafficCompletionReport[] = [];
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });
    const successor = {
      ...startRequest,
      runId: "66666666-6666-4666-8666-666666666666",
    };
    try {
      await expect(runner.start(startRequest)).rejects.toThrow("executing publication unavailable");
      expect(first.child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(reports).toHaveLength(1);
      expect(await store.read()).toMatchObject({ state: "completed" });

      await expect(runner.start(successor)).resolves.toMatchObject({ plannedRequests: 400 });
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      second.child.emit("close", 0);
      await waitForCondition(async () => {
        const execution = await store.read();
        return execution?.request.runId === successor.runId && execution.state === "completed";
      }, "successor execution completion");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("joins a concurrent replay to the live preparation without spawning twice", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-concurrent-prepare-"));
    let releaseAcceptance: () => void = () => undefined;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    class GatedAcceptStore extends FileExecutionStore {
      override async accept(...args: Parameters<FileExecutionStore["accept"]>) {
        const accepted = await super.accept(...args);
        await acceptanceGate;
        return accepted;
      }
    }
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: new GatedAcceptStore(directory),
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    try {
      const first = runner.start(startRequest);
      const replay = runner.start(startRequest);
      releaseAcceptance();
      await expect(Promise.all([first, replay])).resolves.toHaveLength(2);
      expect(k6Process.spawnProcess).toHaveBeenCalledTimes(1);
      k6Process.child.emit("close", 0);
      await waitForCondition(
        async () => (await new FileExecutionStore(directory).read())?.state === "completed",
        "concurrent preparation completion",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reconciles an orphan accepted state after preparation-failure storage recovers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-prepare-replay-"));
    class FailingCompletionStore extends FileExecutionStore {
      failCompletionUpdates = true;
      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (execution.state === "completion_pending" && this.failCompletionUpdates) {
          throw new Error("completion journal unavailable");
        }
        return super.update(execution);
      }
    }
    const store = new FailingCompletionStore(directory);
    const reports: TrafficCompletionReport[] = [];
    const spawnProcess = vi.fn(() => {
      throw new Error("synchronous preparation failure");
    }) as unknown as typeof spawn;
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });
    try {
      await expect(runner.start(startRequest)).rejects.toThrow("synchronous preparation failure");
      expect(await store.read()).toMatchObject({ state: "accepted" });
      await expect(runner.start(startRequest)).rejects.toThrow("still being reconciled");
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      store.failCompletionUpdates = false;
      await expect(runner.start(startRequest)).rejects.toThrow("still being reconciled");
      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(reports).toHaveLength(1);
      expect(await store.read()).toMatchObject({
        state: "completed",
        completion: { status: "failed", errorMessage: "synchronous preparation failure" },
      });
      await expect(runner.close()).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for live preparation to persist its shutdown failure before closing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-prepare-shutdown-"));
    let releaseAcceptance: () => void = () => undefined;
    const acceptanceGate = new Promise<void>((resolve) => {
      releaseAcceptance = resolve;
    });
    class GatedAcceptStore extends FileExecutionStore {
      override async accept(...args: Parameters<FileExecutionStore["accept"]>) {
        const accepted = await super.accept(...args);
        await acceptanceGate;
        return accepted;
      }
    }
    const store = new GatedAcceptStore(directory);
    const reports: TrafficCompletionReport[] = [];
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: {
        sendMetrics: async () => undefined,
        sendCompletion: async (report) => {
          reports.push(report);
        },
      },
    });
    try {
      const start = runner.start(startRequest);
      let closed = false;
      const closing = runner.close().then(() => {
        closed = true;
      });
      await waitForReadline();
      expect(closed).toBe(false);
      releaseAcceptance();
      await expect(start).rejects.toThrow("began shutting down during preparation");
      await expect(closing).resolves.toBeUndefined();
      expect(k6Process.spawnProcess).not.toHaveBeenCalled();
      expect(reports).toHaveLength(1);
      expect(await store.read()).toMatchObject({ state: "completed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for an already-signaled child to close during shutdown", async () => {
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      shutdownGraceMs: 20,
      shutdownKillWaitMs: 20,
    });
    await runner.start(startRequest);
    k6Process.child.kill("SIGTERM");
    let closed = false;
    const closing = runner.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(closed).toBe(false);
    k6Process.child.emit("close", 1);
    await closing;
  });

  it("escalates shutdown to SIGKILL and fails when reap remains unconfirmed", async () => {
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      shutdownGraceMs: 2,
      shutdownKillWaitMs: 2,
    });
    await runner.start(startRequest);
    await expect(runner.close()).rejects.toThrow("Could not confirm");
    expect(k6Process.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(k6Process.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("completes shutdown after SIGKILL escalation is definitively reaped", async () => {
    const k6Process = createK6ProcessFixture();
    const kill = vi.fn((signal?: NodeJS.Signals | number) => {
      Object.assign(k6Process.child, { killed: true });
      if (signal === "SIGKILL") queueMicrotask(() => k6Process.child.emit("close", 137));
      return true;
    });
    Object.assign(k6Process.child, { kill });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      shutdownGraceMs: 2,
      shutdownKillWaitMs: 20,
    });
    await runner.start(startRequest);
    await expect(runner.close()).resolves.toBeUndefined();
    expect(kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("fails shutdown while completion exists only in memory and succeeds after store recovery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "checkout-surge-store-recovery-"));
    class FailingStore extends FileExecutionStore {
      failUpdates = false;
      override async update(execution: Parameters<FileExecutionStore["update"]>[0]) {
        if (this.failUpdates) throw new Error("store unavailable");
        return super.update(execution);
      }
    }
    const store = new FailingStore(directory);
    const k6Process = createK6ProcessFixture();
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      executionStore: store,
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      completionRetry: { maxAttempts: 1 },
      apiClient: { sendMetrics: async () => undefined, sendCompletion: async () => undefined },
    });
    try {
      await runner.start(startRequest);
      store.failUpdates = true;
      k6Process.child.emit("close", 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(runner.close()).rejects.toThrow("could not be made durable");
      store.failUpdates = false;
      await expect(runner.close()).resolves.toBeUndefined();
      expect(await store.read()).toMatchObject({ state: "completed" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries completion delivery when the API fails once", async () => {
    const k6Process = createK6ProcessFixture();
    const reports: TrafficCompletionReport[] = [];
    const retryDelays: number[] = [];
    let completionAccepted: () => void = () => undefined;
    const completionAcceptedPromise = new Promise<void>((resolve) => {
      completionAccepted = resolve;
    });
    const apiClient: LoadApiClient = {
      sendMetrics: vi.fn(async () => undefined),
      sendCompletion: vi.fn(async (report) => {
        reports.push(report);
        if (reports.length === 1) {
          throw new Error("API temporarily unavailable");
        }

        completionAccepted();
      }),
    };
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      apiClient,
      logger: createSilentLogger("load-orchestrator"),
      now: () => new Date(timestamp),
      spawnProcess: k6Process.spawnProcess,
      completionRetry: {
        maxAttempts: 2,
        initialBackoffMs: 25,
        sleep: async (delayMs) => {
          retryDelays.push(delayMs);
        },
      },
    });

    await runner.start(startRequest);
    k6Process.stdout.write(
      `${JSON.stringify({
        type: "Point",
        metric: "http_reqs",
        data: { value: 1, time: timestamp },
      })}\n`,
    );
    await waitForReadline();
    k6Process.child.emit("close", 0);
    await completionAcceptedPromise;

    expect(apiClient.sendCompletion).toHaveBeenCalledTimes(2);
    expect(retryDelays).toEqual([25]);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toBe(reports[0]);
    expect(reports[1]).toMatchObject({
      runId: startRequest.runId,
      status: "succeeded",
      exitCode: 0,
      httpSummary: {
        plannedRequests: 400,
        emittedRequests: 1,
      },
      trafficDeliverySummary: {
        requestShortfall: 399,
      },
    });
  });

  it("retries a timed-out completion with a fresh request signal", async () => {
    const k6Process = createK6ProcessFixture();
    const signals: AbortSignal[] = [];
    let accepted: () => void = () => undefined;
    const acceptedPromise = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) return new Promise<Response>(() => undefined);
      accepted();
      return new Response(
        JSON.stringify({
          runId: startRequest.runId,
          acknowledged: true,
          correlationId: startRequest.correlationId,
        }),
        { status: 202 },
      );
    });
    const runner = new SpawnK6Runner({
      k6Binary: "k6",
      logger: createSilentLogger("load-orchestrator"),
      spawnProcess: k6Process.spawnProcess,
      apiClient: new HttpLoadApiClient({
        apiBaseUrl: "http://api.test",
        controlServiceToken: "test-token",
        requestTimeoutMs: 5,
        fetch: fetchMock,
      }),
      completionRetry: { maxAttempts: 2, initialBackoffMs: 0, sleep: async () => undefined },
    });

    await runner.start(startRequest);
    k6Process.child.emit("close", 0);
    await acceptedPromise;
    await runner.close();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(signals[1]).not.toBe(signals[0]);
  });
});

describe("load-orchestrator API client", () => {
  it("waits for an active metric flush to quiesce when discarding cancellation data", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sendMetrics = vi.fn(async () => gate);
    const batcher = new MetricBatcher({
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      client: { sendMetrics, sendCompletion: async () => undefined },
      maxBatchSize: 1,
    });
    const add = batcher.add({
      metricName: "traffic.latency",
      value: 1,
      unit: "ms",
      timestamp,
    });
    await waitForCondition(() => sendMetrics.mock.calls.length === 1, "active metric flush");
    let discarded = false;
    const discard = batcher.discard().then(() => {
      discarded = true;
    });
    await Promise.resolve();
    expect(discarded).toBe(false);
    release();
    await Promise.all([add, discard]);
    expect(discarded).toBe(true);
  });
  it("rejects a mismatched successful completion acknowledgement", async () => {
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              runId: "66666666-6666-4666-8666-666666666666",
              acknowledged: true,
              correlationId: startRequest.correlationId,
            }),
            { status: 202 },
          ),
      ),
    });
    const report = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    }).completionReport({ status: "succeeded", completedAt: new Date(completionTimestamp) });
    await expect(client.sendCompletion(report)).rejects.toThrow("did not match");
  });

  it("bounds a hung ingestion request and preserves the abort as the cause", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
      requestTimeoutMs: 5,
      fetch: vi.fn((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    });
    try {
      const request = client.sendMetrics({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [{ metricName: "traffic.latency", value: 1, unit: "ms", timestamp }],
        observedAt: timestamp,
      });
      const rejection = expect(request).rejects.toMatchObject({
        message: "API load ingestion request failed.",
        cause: expect.objectContaining({ message: expect.stringContaining("timed out") }),
      });
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends metric and completion correlation IDs in internal API headers", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { runId?: string; correlationId?: string };
      return new Response(
        JSON.stringify(
          body.runId
            ? { runId: body.runId, acknowledged: true, correlationId: body.correlationId }
            : {},
        ),
        { status: 202 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpLoadApiClient({
      apiBaseUrl: "http://api.test",
      controlServiceToken: "test-token",
    });
    const completionReport = new K6RunAccumulator({
      executionPlan: generateK6Script(startRequest).executionPlan,
      runId: startRequest.runId,
      correlationId: startRequest.correlationId,
      plannedRequests: 1,
      startedAt: new Date(timestamp),
    }).completionReport({
      status: "succeeded",
      exitCode: 0,
      completedAt: new Date("2026-06-20T12:00:05.000Z"),
    });

    try {
      await client.sendMetrics({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [
          {
            metricName: "traffic.latency",
            value: 42,
            unit: "ms",
            timestamp,
          },
        ],
        observedAt: timestamp,
      });
      await client.sendCompletion(completionReport);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).not.toBe(fetchMock.mock.calls[1]?.[1]?.signal);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          [correlationIdHeaderName]: startRequest.correlationId,
        }),
      });
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({
          [correlationIdHeaderName]: startRequest.correlationId,
        }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clears request deadline timers after both success and fetch failure", async () => {
    vi.useFakeTimers();
    try {
      const success = new HttpLoadApiClient({
        apiBaseUrl: "http://api.test",
        controlServiceToken: "test-token",
        fetch: vi.fn(async () => new Response("{}", { status: 202 })),
      });
      await success.sendMetrics({
        runId: startRequest.runId,
        correlationId: startRequest.correlationId,
        samples: [{ metricName: "traffic.latency", value: 1, unit: "ms", timestamp }],
        observedAt: timestamp,
      });
      expect(vi.getTimerCount()).toBe(0);

      const failure = new HttpLoadApiClient({
        apiBaseUrl: "http://api.test",
        controlServiceToken: "test-token",
        fetch: vi.fn(async () => {
          throw new Error("network unavailable");
        }),
      });
      await expect(
        failure.sendMetrics({
          runId: startRequest.runId,
          correlationId: startRequest.correlationId,
          samples: [{ metricName: "traffic.latency", value: 1, unit: "ms", timestamp }],
          observedAt: timestamp,
        }),
      ).rejects.toThrow("API load ingestion request failed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("load-orchestrator readiness", () => {
  it.each([
    { event: ["close", 0, null], ok: true },
    { event: ["close", 2, null], ok: false },
    { event: ["close", null, "SIGTERM"], ok: false },
    { event: ["error", new Error("ENOENT")], ok: false },
  ])("settles direct executable probes for $event", async ({ event, ok }) => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    Object.assign(child, { kill: vi.fn() });
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const resultPromise = checkK6Executable("k6", ["version"], 100, spawnProcess);
    child.emit(event[0] as string, ...event.slice(1));
    expect(await resultPromise).toMatchObject({ ok });
    expect(spawnProcess).toHaveBeenCalledWith("k6", ["version"], { stdio: "ignore", shell: false });
  });

  it("kills a timed-out executable probe once and ignores a late close", async () => {
    const child = new EventEmitter() as ReturnType<typeof spawn>;
    const kill = vi.fn();
    Object.assign(child, { kill });
    const resultPromise = checkK6Executable(
      "k6",
      ["version"],
      1,
      vi.fn(() => child) as unknown as typeof spawn,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    child.emit("close", null, "SIGKILL");
    expect(await resultPromise).toMatchObject({
      ok: false,
      message: expect.stringContaining("timed out"),
    });
    child.emit("close", 0);
    expect(kill).toHaveBeenCalledTimes(1);
  });
  it("degrades synchronous executable spawn failures", async () => {
    await expect(
      checkK6Executable("k6", ["version"], 10, (() => {
        throw new Error("spawn failed");
      }) as typeof spawn),
    ).resolves.toMatchObject({ ok: false, message: "Configured k6 binary could not be executed." });
  });
  it("executes both PATH and explicit k6 values with the version argv", async () => {
    for (const binary of ["k6", "C:\\tools\\k6.exe"]) {
      const checkExecutable = vi.fn(async () => ({ ok: true }));
      const readiness = createLoadOrchestratorReadiness(createConfig({ k6Binary: binary }), {
        fetch: vi.fn(async () => jsonResponse(apiHealthPayload("ok"))),
        checkExecutable,
      });
      expect(readinessCheck(await readiness.checks(), "k6_binary_executable").status).toBe("ok");
      expect(checkExecutable).toHaveBeenCalledWith(binary, ["version"], 3000);
    }
  });

  it("degrades a rejected injected executable checker instead of rejecting readiness", async () => {
    const readiness = createLoadOrchestratorReadiness(createConfig(), {
      fetch: vi.fn(async () => jsonResponse(apiHealthPayload("ok"))),
      checkExecutable: vi.fn(async () => {
        throw new Error("checker failed");
      }),
    });
    await expect(readiness.checks()).resolves.toContainEqual({
      name: "k6_binary_executable",
      status: "unavailable",
      message: "Configured k6 binary could not be checked.",
    });
  });

  it("marks the API readiness dependency ok when the configured API target is reachable", async () => {
    const fetchApi = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(apiHealthPayload("ok")));
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test/" }),
      {
        fetch: fetchApi,
      },
    );

    const checks = await readiness.checks();

    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi.mock.calls[0]?.[0]).toBe("http://api.test/health/ready");
    expect(fetchApi.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({ status: "ok" });
  });

  it("marks the API readiness dependency unavailable when the API target is unreachable", async () => {
    const fetchApi = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error("getaddrinfo ENOTFOUND api"));
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test" }),
      {
        fetch: fetchApi,
      },
    );

    const checks = await readiness.checks();

    expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({
      status: "unavailable",
      message: "getaddrinfo ENOTFOUND api",
    });
  });

  it("marks the API readiness dependency unavailable when the API readiness request times out", async () => {
    vi.useFakeTimers();
    const fetchApi = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test" }),
      {
        apiReadinessTimeoutMs: 25,
        fetch: fetchApi,
      },
    );

    try {
      const checksPromise = readiness.checks();
      await vi.advanceTimersByTimeAsync(25);
      const checks = await checksPromise;

      expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({
        status: "unavailable",
        message: "API readiness check timed out after 25ms.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the API readiness dependency unavailable when the API is not ready", async () => {
    const fetchApi = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(apiHealthPayload("unavailable"), 503));
    const readiness = createLoadOrchestratorReadiness(
      createConfig({ apiBaseUrl: "http://api.test" }),
      {
        fetch: fetchApi,
      },
    );

    const checks = await readiness.checks();

    expect(readinessCheck(checks, "api_readiness_reachable")).toMatchObject({
      status: "unavailable",
      message: "API readiness returned HTTP 503.",
    });
  });
});

describe("load-orchestrator HTTP boundary", () => {
  it("exposes readiness and protects traffic starts with the shared control token", async () => {
    const runner: K6Runner = {
      start: vi.fn(async () => ({ startedAt: new Date(timestamp), plannedRequests: 400 })),
      statusSnapshot: vi.fn(async () => ({ state: "unknown" as const })),
      currentRunId: vi.fn(() => startRequest.runId),
      abort: vi.fn(async () => "aborted" as const),
      initialize: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const server = buildLoadOrchestratorServer({
      config: createConfig(),
      logger: createSilentLogger("load-orchestrator"),
      readiness: {
        checks: async () => [
          { name: "api_readiness_reachable", status: "ok" },
          { name: "preset_traffic_start_enabled", status: "ok" },
          { name: "k6_binary_executable", status: "unavailable" },
        ],
      },
      trafficExecutionService: new TrafficExecutionService(runner),
      startedAt: new Date(timestamp),
    });

    try {
      const ready = await server.inject({ method: "GET", url: "/health/ready" });
      const unauthorized = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        payload: startRequest,
      });
      const accepted = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: startRequest,
      });
      vi.mocked(runner.statusSnapshot).mockResolvedValueOnce({
        state: "executing",
        acceptedAt: timestamp,
      });
      const statusUnauthorized = await server.inject({
        method: "GET",
        url: `/traffic/status/${startRequest.runId}`,
      });
      const status = await server.inject({
        method: "GET",
        url: `/traffic/status/${startRequest.runId}`,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
      });
      const abortUnauthorized = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
      });
      const abortWrongToken = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "wrong-token" },
        payload: {},
      });
      const abortMalformed = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { reason: "x".repeat(501) },
      });
      const abortMismatch = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { runId: "66666666-6666-4666-8666-666666666666" },
      });
      const aborted = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: {
          [controlServiceTokenHeaderName]: "test-token",
          [correlationIdHeaderName]: "abort-correlation",
        },
        payload: { runId: startRequest.runId, reason: "operator reset" },
      });
      vi.mocked(runner.abort).mockRejectedValueOnce(new TrafficTerminationUnconfirmedError());
      const unconfirmed = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { runId: startRequest.runId },
      });
      vi.mocked(runner.abort).mockRejectedValueOnce(new Error("cancellation journal unavailable"));
      const cancellationJournalFailure = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: { runId: startRequest.runId },
      });
      vi.mocked(runner.currentRunId).mockReturnValueOnce(null);
      const noCurrent = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
      });
      vi.mocked(runner.currentRunId).mockReturnValueOnce(null);
      const noCurrentEmpty = await server.inject({
        method: "POST",
        url: trafficExecutionAbortPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: {},
      });
      vi.mocked(runner.start).mockRejectedValueOnce(
        new ExecutionSlotConflictError(startRequest.runId),
      );
      const startDuringCancellation = await server.inject({
        method: "POST",
        url: trafficExecutionStartPath,
        headers: { [controlServiceTokenHeaderName]: "test-token" },
        payload: startRequest,
      });

      expect(ready.statusCode).toBe(503);
      expect(healthResponseSchema.parse(ready.json()).status).toBe("unavailable");
      expect(unauthorized.statusCode).toBe(401);
      expect(accepted.statusCode).toBe(202);
      expect(statusUnauthorized.statusCode).toBe(401);
      expect(status.statusCode).toBe(200);
      expect(abortUnauthorized.statusCode).toBe(401);
      expect(abortWrongToken.statusCode).toBe(401);
      expect(abortMalformed.statusCode).toBe(400);
      expect(abortMismatch.statusCode).toBe(409);
      expect(unconfirmed.statusCode).toBe(503);
      expect(cancellationJournalFailure.statusCode).toBe(500);
      expect(cancellationJournalFailure.json()).toMatchObject({ code: "internal_error" });
      expect(cancellationJournalFailure.body).not.toContain("cancellation journal unavailable");
      expect(status.json()).toMatchObject({
        runId: startRequest.runId,
        state: "executing",
        acceptedAt: timestamp,
      });
      expect(accepted.headers[correlationIdHeaderName]).toBe(startRequest.correlationId);
      expect(trafficExecutionStartResponseSchema.parse(accepted.json())).toMatchObject({
        runId: startRequest.runId,
        status: "active",
        correlationId: startRequest.correlationId,
      });
      expect(runner.start).toHaveBeenCalledWith(startRequest);
      expect(trafficExecutionAbortResponseSchema.parse(aborted.json())).toMatchObject({
        outcome: "current_run_aborted",
        abortedRunId: startRequest.runId,
        correlationId: "abort-correlation",
      });
      expect(trafficExecutionAbortResponseSchema.parse(noCurrent.json()).outcome).toBe(
        "no_current_run",
      );
      expect(trafficExecutionAbortResponseSchema.parse(noCurrentEmpty.json()).outcome).toBe(
        "no_current_run",
      );
      expect(startDuringCancellation.statusCode).toBe(409);
      expect(runner.abort).toHaveBeenCalledWith(startRequest.runId, {
        reason: "operator reset",
        correlationId: "abort-correlation",
      });
    } finally {
      await server.close();
    }
  });
});

function createConfig(overrides: Partial<LoadOrchestratorConfig> = {}): LoadOrchestratorConfig {
  return {
    host: "127.0.0.1",
    port: 4200,
    apiBaseUrl: "http://localhost:4000",
    buyEndpointPath: "/buy",
    k6Binary: "k6",
    controlServiceToken: "test-token",
    stateDirectory: "/tmp/checkout-surge-test-state",
    ...overrides,
  };
}

function readinessCheck(checks: ReadinessCheck[], name: string): ReadinessCheck {
  const check = checks.find((entry) => entry.name === name);
  if (!check) {
    throw new Error(`Expected readiness check ${name}.`);
  }

  return check;
}

function apiHealthPayload(status: HealthStatus) {
  return {
    service: "api",
    status,
    timestamp,
    uptimeSeconds: 1,
    checks: [],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createK6ProcessFixture(): {
  child: ReturnType<typeof spawn>;
  stdout: PassThrough;
  stderr: PassThrough;
  spawnProcess: typeof spawn;
} {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(function (this: ReturnType<typeof spawn>) {
    Object.assign(this, { killed: true });
    return true;
  });

  Object.assign(child, { stdout, stderr, killed: false, kill });
  child.on("close", () => {
    stdout.end();
    stderr.end();
  });

  return {
    child,
    stdout,
    stderr,
    spawnProcess: vi.fn(() => child) as unknown as typeof spawn,
  };
}

function createClock(isoTimestamps: string[]): () => Date {
  let index = 0;
  return () => {
    const value = isoTimestamps[Math.min(index, isoTimestamps.length - 1)] ?? timestamp;
    index += 1;
    return new Date(value);
  };
}

function writeK6JsonLines(stdout: PassThrough, points: unknown[]): void {
  stdout.write(`${points.map((point) => JSON.stringify(point)).join("\n")}\n`);
}

function getSingleSpawnCall(k6Process: ReturnType<typeof createK6ProcessFixture>): {
  binary: string;
  args: string[];
  options: unknown;
  scriptPath: string;
} {
  const call = vi.mocked(k6Process.spawnProcess).mock.calls[0];
  if (!call) {
    throw new Error("Expected k6 process to be spawned.");
  }

  const binary = call[0];
  const args = call[1];
  if (typeof binary !== "string" || !Array.isArray(args)) {
    throw new Error("Expected k6 spawn call to use string binary and argument list.");
  }

  const scriptPath = args.at(-1);
  if (typeof scriptPath !== "string") {
    throw new Error("Expected k6 spawn call to include the generated script path.");
  }

  return { binary, args: [...args], options: call[2], scriptPath };
}

async function waitForCompletionReport(
  reports: TrafficCompletionReport[],
  count: number,
): Promise<TrafficCompletionReport> {
  await waitForCondition(
    () => reports.length >= count,
    `traffic completion report ${count} to be sent`,
  );

  const report = reports[count - 1];
  if (!report) {
    throw new Error(`Expected traffic completion report ${count}.`);
  }

  return report;
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function pathMissing(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return false;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }

    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function waitForReadline(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
