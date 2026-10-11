import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createSilentLogger } from "@checkout-surge/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { K6ChildProcessSupervisor } from "../src/application/k6-child-process-supervisor.js";
import { generateK6Script } from "../src/application/k6-script.js";
import { collectLoadRunDiagnostics } from "../src/application/load-run-diagnostics.js";
import { loadLoadOrchestratorConfig } from "../src/runtime/config.js";
import {
  trafficExecutionStartRequestFixture,
  waitForCondition,
} from "./load-orchestrator-test-helper.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(timeout = 5_000, closeOnTerm = true) {
  const root = await mkdtemp(path.join(tmpdir(), "proof-capture-test-"));
  roots.push(root);
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn((signal: NodeJS.Signals) => {
    if (closeOnTerm || signal === "SIGKILL") queueMicrotask(() => child.emit("close", null));
    return true;
  });
  Object.assign(child, { pid: 42, stdout, stderr, kill, killed: false });
  child.on("close", () => {
    stdout.end();
    stderr.end();
  });
  const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
  let clock = new Date("2026-10-11T10:00:00Z");
  const request = trafficExecutionStartRequestFixture();
  const script = generateK6Script(request);
  const diagnostics = await collectLoadRunDiagnostics("k6", script.executionPlan, {
    runCommand: async () => null,
    readText: async () => {
      throw new Error("unavailable");
    },
  });
  const sampler = vi.fn(() => ({ stop: () => null }));
  const supervisor = new K6ChildProcessSupervisor({
    k6Binary: "/usr/bin/k6",
    spawnProcess,
    logger: createSilentLogger("load-orchestrator"),
    apiClient: { sendMetrics: async () => undefined },
    startGeneratorResourceSampler: sampler,
    cancellationTimeoutMs: 40,
    proofCapture: { directory: root, acknowledgementTimeoutMs: timeout },
    now: () => clock,
  });
  const execution = await supervisor.start({
    request,
    script: script.contents,
    startedAt: clock,
    plannedRequests: script.plannedRequests,
    executionPlan: script.executionPlan,
    diagnostics,
  });
  const args = vi.mocked(spawnProcess).mock.calls[0]?.[1] as string[];
  const directory = path.join(root, (await readdir(root))[0] ?? "missing-capture");
  const summaryPath = args[args.indexOf("--summary-export") + 1] ?? "missing-summary";
  return {
    root,
    directory,
    child,
    kill,
    stderr,
    sampler,
    supervisor,
    execution,
    args,
    request,
    script,
    setClock: (value: string) => {
      clock = new Date(value);
    },
    finish: async (raw = true) => {
      await writeFile(summaryPath, "{}");
      if (raw) await writeFile(path.join(directory, "metrics.jsonl"), '{"type":"Metric"}\n');
      child.emit("close", 0);
    },
    manifest: async () => {
      const file = path.join(directory, "manifest.json");
      await waitForCondition(async () => {
        try {
          await readFile(file);
          return true;
        } catch {
          return false;
        }
      }, "capture manifest");
      return readFile(file, "utf8");
    },
  };
}

describe("proof native k6 capture", () => {
  it("keeps the real child and parser output, hashes exact files, and waits for the exact manifest ACK without extending k6 time", async () => {
    const f = await fixture();
    expect(f.args.filter((value) => value === "--out")).toHaveLength(2);
    expect(f.args).toContain("json=-");
    expect(f.args).toContain(`json=${path.join(f.directory, "metrics.jsonl")}`);
    expect(f.sampler).toHaveBeenCalledWith(expect.objectContaining({ pid: 42 }));
    f.stderr.write("retained warning\n");
    await f.finish();
    const text = await f.manifest();
    const manifest = JSON.parse(text);
    expect(manifest).toMatchObject({
      status: "awaiting_ack",
      pid: 42,
      closedAt: "2026-10-11T10:00:00.000Z",
      errors: [],
    });
    expect(Object.keys(manifest.files)).toEqual([
      "scenario.js",
      "request.json",
      "execution-plan.json",
      "metrics.jsonl",
      "summary.json",
      "stderr-diagnostics.json",
    ]);
    for (const [name, metadata] of Object.entries(manifest.files)) {
      const bytes = await readFile(path.join(f.directory, name));
      expect(metadata).toEqual({
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    expect(await readFile(path.join(f.directory, "scenario.js"), "utf8")).toBe(f.script.contents);
    expect(JSON.parse(await readFile(path.join(f.directory, "request.json"), "utf8"))).toEqual(
      f.request,
    );
    let completed = false;
    void f.execution.completion.then(() => {
      completed = true;
    });
    await writeFile(path.join(f.directory, "ack.sha256"), "wrong-manifest");
    expect(completed).toBe(false);
    f.setClock("2026-10-11T10:05:00Z");
    await writeFile(
      path.join(f.directory, "ack.sha256"),
      createHash("sha256").update(text).digest("hex"),
    );
    const result = await f.execution.completion;
    expect(result).toMatchObject({
      outcome: "completed",
      report: { completedAt: "2026-10-11T10:00:00.000Z" },
    });
    await f.supervisor.release(f.request.runId);
    expect(await readFile(path.join(f.directory, "metrics.jsonl"), "utf8")).toContain("Metric");
  });

  it("fails closed on missing raw capture, preserving partial files even with exit zero", async () => {
    const f = await fixture();
    const rejected = expect(f.execution.completion).rejects.toThrow("Proof k6 capture failed");
    await f.finish(false);
    await rejected;
    expect(JSON.parse(await f.manifest())).toMatchObject({ status: "capture_failed" });
    await f.supervisor.close();
  });

  it("times out without publishing completion and keeps the evidence available for reset", async () => {
    const f = await fixture(20);
    const rejected = expect(f.execution.completion).rejects.toThrow("ACK timed out");
    await f.finish();
    await rejected;
    expect(JSON.parse(await readFile(path.join(f.directory, "ack-timeout.json"), "utf8"))).toEqual({
      status: "invalid",
    });
    await f.supervisor.close();
  });

  it("cancels an already exited child during the ACK barrier without signalling it or waiting for ACK", async () => {
    const f = await fixture();
    await f.finish();
    await f.manifest();
    expect(await f.supervisor.cancel(f.request.runId)).toBe("aborted");
    expect(await f.execution.completion).toEqual({ outcome: "cancelled" });
    expect(f.kill).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(f.directory, "cancelled.json"), "utf8"))).toEqual({
      status: "partial",
    });
    await f.supervisor.close();
  });

  it("signals the actual running child on shutdown and retains partial capture without an ACK", async () => {
    const f = await fixture(5_000, false);
    await f.supervisor.close();
    expect(f.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(await f.execution.completion).toEqual({ outcome: "cancelled" });
    expect(JSON.parse(await f.manifest())).toMatchObject({ status: "partial", pid: 42 });
  });

  it("keeps capture opt-in and bounds the operator acknowledgement deadline", () => {
    expect(
      loadLoadOrchestratorConfig({ NODE_ENV: "test", CONTROL_SERVICE_TOKEN: "test-token" })
        .proofCapture,
    ).toBeUndefined();
    expect(
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "test-token",
        PROOF_K6_CAPTURE_DIR: "/evidence",
      }).proofCapture,
    ).toEqual({ directory: "/evidence", acknowledgementTimeoutMs: 120_000 });
    expect(() =>
      loadLoadOrchestratorConfig({
        NODE_ENV: "test",
        CONTROL_SERVICE_TOKEN: "test-token",
        PROOF_K6_CAPTURE_DIR: "/evidence",
        PROOF_K6_CAPTURE_ACK_TIMEOUT_MS: "300001",
      }),
    ).toThrow("PROOF_K6_CAPTURE_ACK_TIMEOUT_MS");
  });
});
