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
  | "generatorUtilisation"
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
  const [
    nprocText,
    nofileText,
    limits,
    meminfo,
    v2MemoryLimit,
    v2CpuQuota,
    v1MemoryLimit,
    v1CpuQuota,
    v1CpuPeriod,
    v1CombinedCpuQuota,
    v1CombinedCpuPeriod,
    portRange,
    twReuse,
    timestamps,
    version,
  ] = await Promise.all([
    safeCommand(command, "nproc", []),
    safeCommand(command, "sh", ["-lc", "ulimit -n"]),
    // This process's limits, which k6 inherits. It is not PID 1 on every host (Fly runs its own init).
    safeRead(reader, "/proc/self/limits"),
    safeRead(reader, "/proc/meminfo"),
    safeRead(reader, "/sys/fs/cgroup/memory.max"),
    safeRead(reader, "/sys/fs/cgroup/cpu.max"),
    safeRead(reader, "/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    safeRead(reader, "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    safeRead(reader, "/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
    // Some cgroup v1 hosts (Fly Machines) mount the controller only as `cpu,cpuacct`, without a `cpu` alias.
    safeRead(reader, "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us"),
    safeRead(reader, "/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us"),
    safeRead(reader, "/proc/sys/net/ipv4/ip_local_port_range"),
    safeRead(reader, "/proc/sys/net/ipv4/tcp_tw_reuse"),
    safeRead(reader, "/proc/sys/net/ipv4/tcp_timestamps"),
    safeCommand(command, k6Binary, ["version"]),
  ]);
  const memory = parseMeminfo(meminfo);
  const memoryLimit = parseV2MemoryLimit(v2MemoryLimit) ??
    parseV1MemoryLimit(v1MemoryLimit) ?? { value: null, unlimited: null };
  const cpuQuota = parseV2CpuQuota(v2CpuQuota) ??
    parseV1CpuQuota(v1CpuQuota, v1CpuPeriod) ??
    parseV1CpuQuota(v1CombinedCpuQuota, v1CombinedCpuPeriod) ?? { value: null, unlimited: null };
  const capacity = {
    ...memory,
    cgroupMemoryLimitBytes: memoryLimit.value,
    cgroupMemoryLimitUnlimited: memoryLimit.unlimited,
    cgroupCpuQuota: cpuQuota.value,
    cgroupCpuQuotaUnlimited: cpuQuota.unlimited,
  };
  const network = {
    ipLocalPortRange: parsePortRange(portRange),
    tcpTwReuse: parseNonnegative(twReuse),
    tcpTimestamps: parseNonnegative(timestamps),
  };
  return {
    nproc: parsePositive(nprocText),
    ulimitNofile: parsePositive(nofileText),
    processMaxOpenFiles: parseOpenFiles(limits),
    generatorCapacity: Object.values(capacity).every((value) => value === null) ? null : capacity,
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
function parseMeminfo(value: string | null) {
  return {
    memTotalBytes: parseMeminfoBytes(value, "MemTotal", false),
    memAvailableBytes: parseMeminfoBytes(value, "MemAvailable", false),
    swapTotalBytes: parseMeminfoBytes(value, "SwapTotal", true),
  };
}
function parseMeminfoBytes(value: string | null, field: string, allowZero: boolean) {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s+kB\\s*$`, "m").exec(value ?? "");
  if (!match) return null;
  const bytes = BigInt(match[1] ?? "") * 1_024n;
  if ((!allowZero && bytes === 0n) || bytes > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(bytes);
}
type CgroupValue = { value: number | null; unlimited: boolean };
function parseV2MemoryLimit(value: string | null): CgroupValue | null {
  if (value?.trim() === "max") return { value: null, unlimited: true };
  const parsed = parsePositive(value);
  return parsed === null ? null : { value: parsed, unlimited: false };
}
// cgroup v1 reports an unlimited limit near signed 64-bit max; 1 EiB is beyond a real limit.
const v1UnlimitedMemoryThreshold = 1n << 60n;
function parseV1MemoryLimit(value: string | null): CgroupValue | null {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9]+$/.test(normalized)) return null;
  const parsed = BigInt(normalized);
  if (parsed >= v1UnlimitedMemoryThreshold) return { value: null, unlimited: true };
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { value: Number(parsed), unlimited: false };
}
function parseV2CpuQuota(value: string | null): CgroupValue | null {
  const parts = value?.trim().split(/\s+/) ?? [];
  if (parts.length !== 2 || parsePositive(parts[1] ?? null) === null) return null;
  if (parts[0] === "max") return { value: null, unlimited: true };
  return parseCpuQuota(parts[0] ?? null, parts[1] ?? null);
}
function parseV1CpuQuota(quota: string | null, period: string | null): CgroupValue | null {
  if (parsePositive(period) === null) return null;
  if (quota?.trim() === "-1") return { value: null, unlimited: true };
  return parseCpuQuota(quota, period);
}
function parseCpuQuota(quota: string | null, period: string | null): CgroupValue | null {
  const parsedQuota = parsePositive(quota);
  const parsedPeriod = parsePositive(period);
  if (parsedQuota === null || parsedPeriod === null) return null;
  const value = parsedQuota / parsedPeriod;
  return Number.isFinite(value) && value > 0 ? { value, unlimited: false } : null;
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
