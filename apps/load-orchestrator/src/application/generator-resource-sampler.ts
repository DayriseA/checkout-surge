import { readFile } from "node:fs/promises";
import type { GeneratorUtilisation } from "@checkout-surge/contracts";

export const defaultGeneratorResourceSampleIntervalMs = 1_000;

export interface GeneratorResourceSampler {
  stop(): GeneratorUtilisation | null;
}

export type StartGeneratorResourceSampler = (input: {
  pid: number;
  effectiveCpuCores: number | null;
}) => GeneratorResourceSampler;

type Timer = ReturnType<typeof setInterval>;

export function startGeneratorResourceSampler(
  input: {
    pid: number;
    effectiveCpuCores: number | null;
    intervalMs?: number;
  },
  dependencies: {
    readText?: (path: string) => Promise<string>;
    nowMs?: () => number;
    setInterval?: (callback: () => void, intervalMs: number) => Timer;
    clearInterval?: (timer: Timer) => void;
  } = {},
): GeneratorResourceSampler {
  const intervalMs = input.intervalMs ?? defaultGeneratorResourceSampleIntervalMs;
  const readText = dependencies.readText ?? ((file) => readFile(file, "utf8"));
  const nowMs = dependencies.nowMs ?? Date.now;
  let stopped = false;
  let sampling = false;
  let sampleCount = 0;
  let firstSuccessfulSampleAtMs: number | null = null;
  let lastSuccessfulSampleAtMs: number | null = null;
  let peakK6RssBytes: number | null = null;
  let peakCgroupMemoryBytes: number | null = null;
  let minimumHostMemAvailableBytes: number | null = null;
  let peakCpuUtilisationPercent: number | null = null;
  let accumulatedCpuUsageUsec = 0;
  let accumulatedCpuCapacityUsec = 0;
  let previousCpu: { usageUsec: bigint; observedAtMs: number } | null = null;
  let peakCgroupSwapBytes: number | null = null;
  let finalMemoryEventsHighCount: number | null = null;
  let finalMemoryEventsMaxCount: number | null = null;
  let finalMemoryEventsOomKillCount: number | null = null;

  const sample = async () => {
    if (stopped || sampling) return;
    sampling = true;
    const observedAtMs = nowMs();
    try {
      const [status, cgroupMemory, meminfo, cpuStat, cgroupSwap, memoryEvents] = await Promise.all([
        safeRead(readText, `/proc/${input.pid}/status`),
        safeRead(readText, "/sys/fs/cgroup/memory.current"),
        safeRead(readText, "/proc/meminfo"),
        safeRead(readText, "/sys/fs/cgroup/cpu.stat"),
        safeRead(readText, "/sys/fs/cgroup/memory.swap.current"),
        safeRead(readText, "/sys/fs/cgroup/memory.events"),
      ]);
      if (stopped) return;

      const k6RssBytes = parseKilobyteField(status, "VmRSS");
      const cgroupMemoryBytes = parseNonnegativeInteger(cgroupMemory);
      const hostMemAvailableBytes = parseKilobyteField(meminfo, "MemAvailable");
      const cpuUsageUsec = parseNamedBigInt(cpuStat, "usage_usec");
      const cgroupSwapBytes = parseNonnegativeInteger(cgroupSwap);
      const memoryEventsHighCount = parseNamedInteger(memoryEvents, "high");
      const memoryEventsMaxCount = parseNamedInteger(memoryEvents, "max");
      const memoryEventsOomKillCount = parseNamedInteger(memoryEvents, "oom_kill");

      const usable = [
        k6RssBytes,
        cgroupMemoryBytes,
        hostMemAvailableBytes,
        cpuUsageUsec,
        cgroupSwapBytes,
        memoryEventsHighCount,
        memoryEventsMaxCount,
        memoryEventsOomKillCount,
      ].some((value) => value !== null);
      if (usable) {
        firstSuccessfulSampleAtMs ??= observedAtMs;
        lastSuccessfulSampleAtMs = observedAtMs;
        sampleCount += 1;
      }

      peakK6RssBytes = maximum(peakK6RssBytes, k6RssBytes);
      peakCgroupMemoryBytes = maximum(peakCgroupMemoryBytes, cgroupMemoryBytes);
      minimumHostMemAvailableBytes = minimum(minimumHostMemAvailableBytes, hostMemAvailableBytes);
      peakCgroupSwapBytes = maximum(peakCgroupSwapBytes, cgroupSwapBytes);
      finalMemoryEventsHighCount = memoryEventsHighCount ?? finalMemoryEventsHighCount;
      finalMemoryEventsMaxCount = memoryEventsMaxCount ?? finalMemoryEventsMaxCount;
      finalMemoryEventsOomKillCount = memoryEventsOomKillCount ?? finalMemoryEventsOomKillCount;

      if (cpuUsageUsec !== null) {
        if (
          previousCpu &&
          cpuUsageUsec >= previousCpu.usageUsec &&
          observedAtMs > previousCpu.observedAtMs &&
          input.effectiveCpuCores !== null &&
          input.effectiveCpuCores > 0
        ) {
          const usageDeltaUsec = Number(cpuUsageUsec - previousCpu.usageUsec);
          const capacityUsec =
            (observedAtMs - previousCpu.observedAtMs) * 1_000 * input.effectiveCpuCores;
          const utilisationPercent = (usageDeltaUsec / capacityUsec) * 100;
          if (Number.isFinite(utilisationPercent)) {
            peakCpuUtilisationPercent = maximum(peakCpuUtilisationPercent, utilisationPercent);
            accumulatedCpuUsageUsec += usageDeltaUsec;
            accumulatedCpuCapacityUsec += capacityUsec;
          }
        }
        previousCpu = { usageUsec: cpuUsageUsec, observedAtMs };
      }
    } catch {
      // Diagnostics are advisory and must never affect a run.
    } finally {
      sampling = false;
    }
  };

  const timer = (dependencies.setInterval ?? setInterval)(() => void sample(), intervalMs);
  timer.unref();
  void sample();

  return {
    stop() {
      if (!stopped) {
        stopped = true;
        (dependencies.clearInterval ?? clearInterval)(timer);
      }
      if (sampleCount === 0) return null;
      const firstSampleAtMs = firstSuccessfulSampleAtMs;
      const lastSampleAtMs = lastSuccessfulSampleAtMs;
      const result: GeneratorUtilisation = {
        peakK6RssBytes,
        peakCgroupMemoryBytes,
        minimumHostMemAvailableBytes,
        peakCpuUtilisationPercent,
        meanCpuUtilisationPercent:
          accumulatedCpuCapacityUsec > 0
            ? (accumulatedCpuUsageUsec / accumulatedCpuCapacityUsec) * 100
            : null,
        peakCgroupSwapBytes,
        finalMemoryEventsHighCount,
        finalMemoryEventsMaxCount,
        finalMemoryEventsOomKillCount,
        sampleCount,
        effectiveIntervalMs:
          sampleCount > 1 &&
          firstSampleAtMs !== null &&
          lastSampleAtMs !== null &&
          lastSampleAtMs > firstSampleAtMs
            ? Math.max(1, Math.round((lastSampleAtMs - firstSampleAtMs) / (sampleCount - 1)))
            : intervalMs,
      };
      const { sampleCount: _sampleCount, effectiveIntervalMs: _interval, ...metrics } = result;
      return Object.values(metrics).every((value) => value === null) ? null : result;
    },
  };
}

async function safeRead(
  reader: (path: string) => Promise<string>,
  path: string,
): Promise<string | null> {
  try {
    return await reader(path);
  } catch {
    return null;
  }
}

function parseKilobyteField(value: string | null, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+([0-9]+)\\s+kB\\s*$`, "m").exec(value ?? "");
  if (!match) return null;
  const bytes = BigInt(match[1] ?? "") * 1_024n;
  return bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
}

function parseNonnegativeInteger(value: string | null): number | null {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9]+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseNamedInteger(value: string | null, field: string): number | null {
  const match = new RegExp(`^${field}\\s+([0-9]+)\\s*$`, "m").exec(value ?? "");
  return parseNonnegativeInteger(match?.[1] ?? null);
}

function parseNamedBigInt(value: string | null, field: string): bigint | null {
  const match = new RegExp(`^${field}\\s+([0-9]+)\\s*$`, "m").exec(value ?? "");
  return match ? BigInt(match[1] ?? "") : null;
}

function maximum(current: number | null, observed: number | null): number | null {
  return observed === null ? current : current === null ? observed : Math.max(current, observed);
}

function minimum(current: number | null, observed: number | null): number | null {
  return observed === null ? current : current === null ? observed : Math.min(current, observed);
}
