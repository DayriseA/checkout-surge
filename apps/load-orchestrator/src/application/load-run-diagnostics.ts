import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { LoadExecutionPlan, LoadRunDiagnosticsSummary } from "@checkout-surge/contracts";

export type InitialLoadRunDiagnostics = Omit<
  LoadRunDiagnosticsSummary,
  | "startedAt"
  | "completedAt"
  | "stderrLines"
  | "stderrLineCountObserved"
  | "stderrLineCountRetained"
  | "stderrRetainedLineLimit"
  | "stderrLineTruncationLength"
  | "stderrLineTruncatedCount"
>;

export interface DiagnosticsDependencies {
  runCommand?: (command: string, args: string[]) => Promise<string | null>;
  readText?: (path: string) => Promise<string>;
}

export async function collectLoadRunDiagnostics(
  k6Binary: string,
  executionPlan: LoadExecutionPlan,
  dependencies: DiagnosticsDependencies = {},
): Promise<InitialLoadRunDiagnostics> {
  const command = dependencies.runCommand ?? boundedCommand;
  const reader = dependencies.readText ?? ((file) => readFile(file, "utf8"));
  const [nprocText, nofileText, limits, portRange, twReuse, timestamps, version] =
    await Promise.all([
      safeCommand(command, "nproc", []),
      safeCommand(command, "sh", ["-lc", "ulimit -n"]),
      safeRead(reader, "/proc/1/limits"),
      safeRead(reader, "/proc/sys/net/ipv4/ip_local_port_range"),
      safeRead(reader, "/proc/sys/net/ipv4/tcp_tw_reuse"),
      safeRead(reader, "/proc/sys/net/ipv4/tcp_timestamps"),
      safeCommand(command, k6Binary, ["version"]),
    ]);
  const network = {
    ipLocalPortRange: parsePortRange(portRange),
    tcpTwReuse: parseNonnegative(twReuse),
    tcpTimestamps: parseNonnegative(timestamps),
  };
  return {
    nproc: parsePositive(nprocText),
    ulimitNofile: parsePositive(nofileText),
    processMaxOpenFiles: parseOpenFiles(limits),
    networkDiagnostics: Object.values(network).every((value) => value === null) ? null : network,
    k6Version: firstLine(version),
    executionPlan,
  };
}

export function runBoundedDiagnosticCommand(
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          timeout: options.timeoutMs ?? 1_000,
          killSignal: "SIGKILL",
          shell: false,
          encoding: "utf8",
          maxBuffer: 16 * 1_024,
        },
        (error, stdout, stderr) => resolve(error ? null : (stdout || stderr).slice(0, 2_000)),
      );
    } catch {
      resolve(null);
    }
  });
}

const boundedCommand = runBoundedDiagnosticCommand;
async function safeRead(reader: (path: string) => Promise<string>, path: string) {
  try {
    return await reader(path);
  } catch {
    return null;
  }
}
async function safeCommand(
  command: (command: string, args: string[]) => Promise<string | null>,
  binary: string,
  args: string[],
) {
  try {
    return await command(binary, args);
  } catch {
    return null;
  }
}
function parsePositive(value: string | null) {
  const parsed = parseInteger(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}
function parseNonnegative(value: string | null) {
  const parsed = parseInteger(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
function parseInteger(value: string | null): number | null {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9]+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function parsePortRange(value: string | null): string | null {
  const parts = value?.trim().split(/\s+/) ?? [];
  if (parts.length !== 2) return null;
  const start = parsePositive(parts[0] ?? null);
  const end = parsePositive(parts[1] ?? null);
  if (start === null || end === null || start > end || end > 65_535) return null;
  return `${start} ${end}`;
}
function firstLine(value: string | null) {
  return (
    value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}
function parseOpenFiles(value: string | null) {
  const line = value?.split(/\r?\n/).find((entry) => entry.startsWith("Max open files"));
  if (!line) return null;
  const match = /^Max open files\s+([0-9]+)\s+([0-9]+)\s+files\s*$/.exec(line);
  if (!match) return null;
  const soft = parsePositive(match[1] ?? null);
  const hard = parsePositive(match[2] ?? null);
  return soft !== null && hard !== null ? { soft, hard } : null;
}
