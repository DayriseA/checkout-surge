import { describe, expect, it, vi } from "vitest";
import {
  defaultGeneratorResourceSampleIntervalMs,
  startGeneratorResourceSampler,
} from "../src/application/generator-resource-sampler.js";

type SampleFiles = Record<string, string | Error>;

function samplerHarness(samples: SampleFiles[], effectiveCpuCores: number | null = 2) {
  let sampleIndex = 0;
  let intervalCallback: () => void = () => undefined;
  const unref = vi.fn();
  const clearInterval = vi.fn();
  const readText = vi.fn(async (file: string) => {
    const value = samples[sampleIndex]?.[file];
    if (value instanceof Error || value === undefined) throw value ?? new Error("missing");
    return value;
  });
  const sampler = startGeneratorResourceSampler(
    { pid: 42, effectiveCpuCores },
    {
      readText,
      nowMs: () => sampleIndex * 1_000,
      setInterval: (callback) => {
        intervalCallback = callback;
        return { unref } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval,
    },
  );
  return {
    sampler,
    readText,
    unref,
    clearInterval,
    async nextSample() {
      await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes((sampleIndex + 1) * 11));
      await new Promise<void>((resolve) => setImmediate(resolve));
      sampleIndex += 1;
      intervalCallback();
    },
    async settle() {
      await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes((sampleIndex + 1) * 11));
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function files(input: {
  rssKb?: number;
  memoryBytes?: number;
  memAvailableKb?: number;
  cpuUsageUsec?: number;
  swapBytes?: number;
  high?: number;
  max?: number;
  oomKill?: number;
}): SampleFiles {
  return {
    "/proc/42/status": `Name:\tk6\nVmRSS:\t${input.rssKb ?? 0} kB\n`,
    "/sys/fs/cgroup/memory.current": String(input.memoryBytes ?? 0),
    "/proc/meminfo": `MemAvailable: ${input.memAvailableKb ?? 0} kB\n`,
    "/sys/fs/cgroup/cpu.stat": `usage_usec ${input.cpuUsageUsec ?? 0}\n`,
    "/sys/fs/cgroup/memory.swap.current": String(input.swapBytes ?? 0),
    "/sys/fs/cgroup/memory.events": `low 0\nhigh ${input.high ?? 0}\nmax ${input.max ?? 0}\noom 0\noom_kill ${input.oomKill ?? 0}\n`,
  };
}

describe("generator resource sampler", () => {
  it("reduces peaks, minimums, final counters, and quota-normalized CPU samples", async () => {
    const harness = samplerHarness([
      files({
        rssKb: 100,
        memoryBytes: 1_000,
        memAvailableKb: 2_000,
        cpuUsageUsec: 1_000_000,
        max: 1,
      }),
      files({
        rssKb: 200,
        memoryBytes: 900,
        memAvailableKb: 1_500,
        cpuUsageUsec: 2_500_000,
        swapBytes: 10,
        high: 2,
        max: 3,
      }),
      files({
        rssKb: 150,
        memoryBytes: 1_200,
        memAvailableKb: 1_750,
        cpuUsageUsec: 3_500_000,
        swapBytes: 5,
        high: 4,
        max: 5,
        oomKill: 1,
      }),
    ]);

    await harness.nextSample();
    await harness.nextSample();
    await harness.settle();

    expect(harness.sampler.stop()).toEqual({
      peakK6RssBytes: 204_800,
      peakCgroupMemoryBytes: 1_200,
      minimumHostMemAvailableBytes: 1_536_000,
      peakCpuUtilisationPercent: 75,
      meanCpuUtilisationPercent: 62.5,
      peakCgroupSwapBytes: 10,
      finalMemoryEventsHighCount: 4,
      finalMemoryEventsMaxCount: 5,
      finalMemoryEventsOomKillCount: 1,
      sampleCount: 3,
      effectiveIntervalMs: defaultGeneratorResourceSampleIntervalMs,
    });
    expect(harness.readText).toHaveBeenCalledTimes(33);
  });

  it("falls back to the cgroup v1 layout when cgroup v2 files are absent", async () => {
    const v1Sample = (input: { usageNs: string; memoryBytes: number; failcnt: number }) => ({
      "/proc/42/status": "Name:\tk6\nVmRSS:\t0 kB\n",
      "/proc/meminfo": "MemAvailable: 0 kB\n",
      "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage": input.usageNs,
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": `${input.memoryBytes}\n`,
      "/sys/fs/cgroup/memory/memory.stat": "cache 10\nrss 20\nswap 4096\ntotal_swap 4096\n",
      "/sys/fs/cgroup/memory/memory.failcnt": `${input.failcnt}\n`,
      "/sys/fs/cgroup/memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 1\n",
    });
    const harness = samplerHarness(
      [
        v1Sample({ usageNs: "1000000000\n", memoryBytes: 500, failcnt: 0 }),
        v1Sample({ usageNs: "3000000000\n", memoryBytes: 300, failcnt: 2 }),
      ],
      4,
    );

    await harness.nextSample();
    await harness.settle();

    expect(harness.sampler.stop()).toMatchObject({
      peakCgroupMemoryBytes: 500,
      peakCpuUtilisationPercent: 50,
      meanCpuUtilisationPercent: 50,
      peakCgroupSwapBytes: 4_096,
      finalMemoryEventsHighCount: null,
      finalMemoryEventsMaxCount: 2,
      finalMemoryEventsOomKillCount: 1,
    });
  });

  it("keeps one sample distinct from zero samples and leaves CPU deltas unavailable", async () => {
    const oneSample = samplerHarness([files({})]);
    await oneSample.settle();
    expect(oneSample.sampler.stop()).toMatchObject({
      peakK6RssBytes: 0,
      peakCgroupSwapBytes: 0,
      peakCpuUtilisationPercent: null,
      meanCpuUtilisationPercent: null,
      sampleCount: 1,
    });

    const unavailable = samplerHarness([
      {
        "/proc/42/status": new Error("vanished"),
        "/sys/fs/cgroup/memory.current": new Error("unreadable"),
        "/proc/meminfo": new Error("unreadable"),
        "/sys/fs/cgroup/cpu.stat": new Error("unreadable"),
        "/sys/fs/cgroup/memory.swap.current": new Error("unreadable"),
        "/sys/fs/cgroup/memory.events": new Error("unreadable"),
      },
    ]);
    await unavailable.settle();
    expect(unavailable.sampler.stop()).toBeNull();
  });

  it("tolerates a vanished PID and unreadable cgroup files without losing other samples", async () => {
    const second = files({
      memAvailableKb: 500,
      cpuUsageUsec: 2_000_000,
      swapBytes: 7,
    });
    second["/proc/42/status"] = new Error("pid exited");
    second["/sys/fs/cgroup/memory.current"] = new Error("permission denied");
    const harness = samplerHarness([
      files({ rssKb: 10, memoryBytes: 100, memAvailableKb: 1_000, cpuUsageUsec: 1_000_000 }),
      second,
    ]);

    await harness.nextSample();
    await harness.settle();

    expect(harness.sampler.stop()).toMatchObject({
      peakK6RssBytes: 10_240,
      peakCgroupMemoryBytes: 100,
      minimumHostMemAvailableBytes: 512_000,
      peakCpuUtilisationPercent: 50,
      peakCgroupSwapBytes: 7,
      sampleCount: 2,
    });
  });

  it("unrefs and idempotently clears one timer while keeping reads bounded per interval", async () => {
    const harness = samplerHarness([files({}), files({})]);
    expect(harness.unref).toHaveBeenCalledOnce();
    await harness.nextSample();
    await harness.settle();
    expect(harness.readText).toHaveBeenCalledTimes(22);

    const first = harness.sampler.stop();
    const second = harness.sampler.stop();
    expect(second).toEqual(first);
    expect(harness.clearInterval).toHaveBeenCalledOnce();
  });

  it("reports the observed average interval when an in-flight tick is skipped", async () => {
    let intervalCallback: () => void = () => undefined;
    let nowMs = 0;
    let releaseReads: () => void = () => undefined;
    const readsReleased = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const sampleFiles = files({});
    const readText = vi.fn(async (file: string) => {
      await readsReleased;
      const value = sampleFiles[file];
      if (typeof value !== "string") throw new Error("missing");
      return value;
    });
    const sampler = startGeneratorResourceSampler(
      { pid: 42, effectiveCpuCores: 2 },
      {
        readText,
        nowMs: () => nowMs,
        setInterval: (callback) => {
          intervalCallback = callback;
          return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
      },
    );

    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(11));
    nowMs = 1_000;
    intervalCallback();
    expect(readText).toHaveBeenCalledTimes(11);
    releaseReads();
    await new Promise<void>((resolve) => setImmediate(resolve));

    nowMs = 3_000;
    intervalCallback();
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(22));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sampler.stop()).toMatchObject({ sampleCount: 2, effectiveIntervalMs: 3_000 });
  });

  it("ignores reads that resolve after stop and keeps the serialized snapshot stable", async () => {
    let intervalCallback: () => void = () => undefined;
    let readCount = 0;
    let releaseLateReads: () => void = () => undefined;
    const lateReadsReleased = new Promise<void>((resolve) => {
      releaseLateReads = resolve;
    });
    const initial = files({ rssKb: 10, memoryBytes: 100, memAvailableKb: 1_000 });
    const late = files({ rssKb: 999, memoryBytes: 999, memAvailableKb: 1 });
    const readText = vi.fn(async (file: string) => {
      readCount += 1;
      if (readCount > 11) await lateReadsReleased;
      const value = (readCount > 11 ? late : initial)[file];
      if (typeof value !== "string") throw new Error("missing");
      return value;
    });
    const sampler = startGeneratorResourceSampler(
      { pid: 42, effectiveCpuCores: 2 },
      {
        readText,
        nowMs: () => readCount,
        setInterval: (callback) => {
          intervalCallback = callback;
          return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval: vi.fn(),
      },
    );
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(11));
    await new Promise<void>((resolve) => setImmediate(resolve));

    intervalCallback();
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(22));
    const snapshot = sampler.stop();
    const serialized = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({
      peakK6RssBytes: 10_240,
      peakCgroupMemoryBytes: 100,
      sampleCount: 1,
    });

    releaseLateReads();
    await new Promise<void>((resolve) => setImmediate(resolve));
    intervalCallback();
    expect(readText).toHaveBeenCalledTimes(22);
    expect(JSON.stringify(sampler.stop())).toBe(serialized);
  });
});
