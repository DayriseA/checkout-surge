import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TrafficExecutionStartRequest } from "@checkout-surge/contracts";
import type { BoundedStderrCollector } from "./k6-output-parser.js";
import type { generateK6Script } from "./k6-script.js";

export interface ProofK6CaptureOptions {
  directory: string;
  acknowledgementTimeoutMs: number;
}

/** Proof-only files survive supervisor cleanup; operators must export them before recreation. */
export class ProofK6Capture {
  private constructor(
    readonly directory: string,
    private readonly acknowledgementTimeoutMs: number,
    private readonly identity: Pick<TrafficExecutionStartRequest, "runId" | "expectedBootId">,
  ) {}

  static async prepare(
    options: ProofK6CaptureOptions,
    input: {
      request: TrafficExecutionStartRequest;
      script: string;
      executionPlan: ReturnType<typeof generateK6Script>["executionPlan"];
    },
  ): Promise<ProofK6Capture> {
    await mkdir(options.directory, { recursive: true });
    const directory = await mkdtemp(path.join(options.directory, `${input.request.runId}-`));
    await writeFile(path.join(directory, "scenario.js"), input.script);
    await writeFile(path.join(directory, "request.json"), JSON.stringify(input.request));
    await writeFile(
      path.join(directory, "execution-plan.json"),
      JSON.stringify(input.executionPlan),
    );
    return new ProofK6Capture(directory, options.acknowledgementTimeoutMs, {
      runId: input.request.runId,
      expectedBootId: input.request.expectedBootId,
    });
  }

  get outputPath(): string {
    return path.join(this.directory, "metrics.jsonl");
  }

  async finish(input: {
    summaryPath: string;
    stderr: ReturnType<BoundedStderrCollector["snapshot"]>;
    pid: number | null;
    argv: string[];
    closedAt: Date;
    exitCode: number | null;
    signal: AbortSignal;
  }): Promise<void> {
    const errors: string[] = [];
    await writeFile(
      path.join(this.directory, "stderr-diagnostics.json"),
      JSON.stringify(input.stderr),
    );
    try {
      await copyFile(input.summaryPath, path.join(this.directory, "summary.json"));
    } catch (error) {
      errors.push(`summary.json: ${String(error)}`);
    }
    const files: Record<string, { bytes: number; sha256: string }> = {};
    for (const name of [
      "scenario.js",
      "request.json",
      "execution-plan.json",
      "metrics.jsonl",
      "summary.json",
      "stderr-diagnostics.json",
    ]) {
      if (input.signal.aborted) break;
      try {
        const file = path.join(this.directory, name);
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(file, { signal: input.signal }))
          hash.update(chunk);
        files[name] = { bytes: (await stat(file)).size, sha256: hash.digest("hex") };
      } catch (error) {
        errors.push(`${name}: ${String(error)}`);
      }
    }
    const manifest = JSON.stringify({
      ...this.identity,
      status: input.signal.aborted ? "partial" : errors.length ? "capture_failed" : "awaiting_ack",
      pid: input.pid,
      argv: input.argv,
      closedAt: input.closedAt.toISOString(),
      exitCode: input.exitCode,
      files,
      errors,
    });
    await writeFile(path.join(this.directory, "manifest.json.tmp"), manifest);
    await rename(
      path.join(this.directory, "manifest.json.tmp"),
      path.join(this.directory, "manifest.json"),
    );
    if (input.signal.aborted) return;
    if (errors.length) throw new Error(`Proof k6 capture failed: ${this.directory}`);

    const digest = createHash("sha256").update(manifest).digest("hex");
    const deadline = Date.now() + this.acknowledgementTimeoutMs;
    while (!input.signal.aborted) {
      try {
        const acknowledgement = await readFile(path.join(this.directory, "ack.sha256"), "utf8");
        if (acknowledgement.trim() === digest) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline) {
        await writeFile(
          path.join(this.directory, "ack-timeout.json"),
          JSON.stringify({ status: "invalid" }),
        );
        throw new Error(`Proof k6 capture ACK timed out: ${this.directory}`);
      }
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal: input.signal }).catch(
        (error) => {
          if (!input.signal.aborted) throw error;
        },
      );
    }
    await writeFile(
      path.join(this.directory, "cancelled.json"),
      JSON.stringify({ status: "partial" }),
    );
  }
}
