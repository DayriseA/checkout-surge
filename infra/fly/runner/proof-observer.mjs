// Installed only by the proof Machine config; no runtime service or k6 wrapper.
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { cpus } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const intervalMs = 250;
const maximumCoveredIntervalMs = 375;
const maxLifetimeMs = 960_000;
const maxBytes = 8 * 1024 * 1024;
const minimumFreeBytes = 100 * 1024 * 1024;
const readText = (file) => {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};
const decimal = (value) => (typeof value === "string" && /^\d+$/.test(value) ? value : null);
const field = (text, name) => decimal(text?.match(new RegExp(`^${name}\\s+(\\d+)$`, "m"))?.[1]);

export function parseProcessStat(text) {
  if (!text) return null;
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).split(/\s+/);
  if (end < 0 || ![fields[11], fields[12], fields[19], fields[21]].every(decimal)) return null;
  return {
    state: fields[0],
    parentPid: Number(fields[1]),
    startTicks: fields[19],
    userTicks: fields[11],
    systemTicks: fields[12],
    rssPages: fields[21],
  };
}

export function collectResources(
  read = readText,
  list = () => readdirSync("/proc"),
  hostCores = cpus().length,
) {
  const v2 = read("/sys/fs/cgroup/cpu.stat");
  const v1 =
    read("/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage") ??
    read("/sys/fs/cgroup/cpuacct/cpuacct.usage");
  const usageUsec =
    v2 !== null
      ? field(v2, "usage_usec")
      : decimal(v1) === null
        ? null
        : String(BigInt(v1) / 1000n);
  const quota =
    v2 !== null
      ? read("/sys/fs/cgroup/cpu.max")?.split(/\s+/)
      : [
          read("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us") ??
            read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
          read("/sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us") ??
            read("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
        ];
  const unlimited = quota?.[0] === "max" || quota?.[0] === "-1";
  const finite = Number(quota?.[0]) > 0 && Number(quota?.[1]) > 0;
  const allocationCores = unlimited
    ? hostCores
    : finite
      ? Number(quota[0]) / Number(quota[1])
      : null;
  const k6 = [];
  let processScanComplete = true;
  try {
    for (const name of list()) {
      if (!/^\d+$/.test(name)) continue;
      const comm = read(`/proc/${name}/comm`);
      if (comm === null) processScanComplete = false;
      if (comm !== "k6") continue;
      const stat = parseProcessStat(read(`/proc/${name}/stat`));
      if (!stat) processScanComplete = false;
      k6.push({ pid: Number(name), ...stat });
    }
  } catch {
    processScanComplete = false;
  }
  return {
    cgroupVersion: v2 !== null ? 2 : decimal(v1) !== null ? 1 : null,
    usageUsec,
    allocationCores,
    quotaUnlimited: unlimited ? true : finite ? false : null,
    memoryBytes: decimal(
      read("/sys/fs/cgroup/memory.current") ?? read("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
    ),
    memoryLimitRaw:
      read("/sys/fs/cgroup/memory.max") ?? read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    memorySwapBytes:
      decimal(read("/sys/fs/cgroup/memory.swap.current")) ??
      field(read("/sys/fs/cgroup/memory/memory.stat"), "swap"),
    memoryEvents: read("/sys/fs/cgroup/memory.events"),
    memoryFailCount: decimal(read("/sys/fs/cgroup/memory/memory.failcnt")),
    oomControl: read("/sys/fs/cgroup/memory/memory.oom_control"),
    processScanComplete,
    k6,
  };
}

export function intervalCpuPercent(previous, current) {
  const elapsed = current.monotonicMs - (previous?.monotonicMs ?? current.monotonicMs);
  if (
    !previous ||
    elapsed <= 0 ||
    elapsed > maximumCoveredIntervalMs ||
    previous.usageUsec === null ||
    current.usageUsec === null ||
    !current.allocationCores ||
    previous.allocationCores !== current.allocationCores
  )
    return null;
  const delta = BigInt(current.usageUsec) - BigInt(previous.usageUsec);
  return delta < 0n ? null : (Number(delta) / (elapsed * 1000 * current.allocationCores)) * 100;
}

export function startObserver(
  readyPath,
  {
    base = "/var/lib/checkout-surge/load-orchestrator/proof-resources",
    read = readText,
    list = () => readdirSync("/proc"),
    hostCores = cpus().length,
    now = Date.now,
    monotonic = () => performance.now(),
    environment = process.env,
    freeBytes = () => {
      const fs = statfsSync(base);
      return Number(fs.bavail) * Number(fs.bsize);
    },
  } = {},
) {
  if (!readyPath || existsSync(readyPath))
    throw new Error("A fresh proof observer ready path is required.");
  const began = monotonic();
  const kernelBootId = read("/proc/sys/kernel/random/boot_id");
  const parentPid = process.ppid;
  const parent = parseProcessStat(read(`/proc/${parentPid}/stat`));
  const self = parseProcessStat(read(`/proc/${process.pid}/stat`));
  if (
    !kernelBootId ||
    !parent ||
    !self ||
    !environment.FLY_MACHINE_ID ||
    !environment.FLY_APP_NAME ||
    !environment.COMMIT_SHA
  )
    throw new Error("Proof observer identity is incomplete.");
  mkdirSync(base, { recursive: true });
  if (freeBytes() < minimumFreeBytes) throw new Error("Proof observer requires 100 MiB free disk.");
  const invocationId = randomUUID();
  const directory = path.join(base, `${kernelBootId}-${invocationId}`);
  mkdirSync(directory);
  const identity = {
    invocationId,
    kernelBootId,
    machineId: environment.FLY_MACHINE_ID,
    app: environment.FLY_APP_NAME,
    commit: environment.COMMIT_SHA,
    observerPid: process.pid,
    observerStartTicks: self.startTicks,
    parentPid,
    parentStartTicks: parent.startTicks,
  };
  writeFileSync(
    path.join(directory, "metadata.json"),
    JSON.stringify({
      ...identity,
      startedAt: new Date(now()).toISOString(),
      intervalMs,
      maximumCoveredIntervalMs,
      maxLifetimeMs,
      maxBytes,
      minimumFreeBytes,
      hostCores,
      scope:
        "Runner container cgroup including observer/orchestrator/k6; process ticks and RSS pages are supplementary",
    }),
  );
  let bytes = 0,
    samples = 0,
    previous = null,
    stopped = false,
    timer;

  function sample() {
    const point = {
      epochMs: now(),
      monotonicMs: monotonic(),
      ...collectResources(read, list, hostCores),
    };
    point.k6 = point.k6.filter((p) => p.parentPid === parentPid || p.startTicks === undefined);
    point.cpuPercent = intervalCpuPercent(previous, point);
    point.probeComplete =
      point.usageUsec !== null && point.allocationCores !== null && point.memoryBytes !== null;
    const line = `${JSON.stringify(point)}\n`;
    if (bytes + Buffer.byteLength(line) > maxBytes) throw new Error("sample-size-bound");
    if (freeBytes() < minimumFreeBytes) throw new Error("free-space-bound");
    appendFileSync(path.join(directory, "samples.jsonl"), line);
    bytes += Buffer.byteLength(line);
    samples++;
    previous = point;
    return point;
  }

  function stop(reason, error = null) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    const errors = error ? [String(error)] : [];
    if (reason === "SIGTERM") {
      try {
        sample();
      } catch (failure) {
        errors.push(String(failure));
      }
    }
    writeFileSync(
      path.join(directory, "finished.json"),
      JSON.stringify({ reason, epochMs: now(), monotonicMs: monotonic(), samples, bytes, errors }),
    );
    const files = {};
    for (const name of ["metadata.json", "samples.jsonl", "finished.json"]) {
      try {
        const data = readFileSync(path.join(directory, name));
        files[name] = {
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
      } catch (failure) {
        errors.push(`${name}: ${String(failure)}`);
      }
    }
    writeFileSync(
      path.join(directory, "manifest.json.tmp"),
      JSON.stringify({
        ...identity,
        status: reason === "SIGTERM" && errors.length === 0 ? "finalized" : "partial",
        reason,
        files,
        errors,
      }),
    );
    renameSync(path.join(directory, "manifest.json.tmp"), path.join(directory, "manifest.json"));
  }

  function tick() {
    if (stopped) return;
    try {
      if (monotonic() - began >= maxLifetimeMs) return stop("bounded-lifetime");
      const currentParent = parseProcessStat(read(`/proc/${parentPid}/stat`));
      if (
        !currentParent ||
        currentParent.startTicks !== parent.startTicks ||
        currentParent.state === "Z"
      )
        return stop("parent-exited");
      sample();
    } catch (error) {
      stop("probe-or-storage-failure", error);
    }
  }

  try {
    const first = sample();
    if (!first.probeComplete || first.allocationCores !== 16)
      throw new Error("No usable 16-core pre-server baseline.");
    const ready = JSON.stringify({
      ...identity,
      directory,
      baselineEpochMs: first.epochMs,
      baselineMonotonicMs: first.monotonicMs,
    });
    const pointer = path.join(base, `${invocationId}.current.tmp`);
    writeFileSync(pointer, ready, { flag: "wx" });
    renameSync(pointer, path.join(base, "current.json"));
    writeFileSync(`${readyPath}.tmp`, ready, { flag: "wx" });
    renameSync(`${readyPath}.tmp`, readyPath);
    timer = setInterval(tick, intervalMs);
  } catch (error) {
    stop("startup-failure", error);
    throw error;
  }
  return { directory, tick, stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const observer = startObserver(process.argv[2]);
    process.once("SIGTERM", () => observer.stop("SIGTERM"));
    process.once("SIGINT", () => observer.stop("SIGINT"));
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
