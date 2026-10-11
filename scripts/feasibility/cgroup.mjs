import { readFile } from "node:fs/promises";

/** The same v1 controller mounts observed by the production resource sampler on Fly. */
export async function readCgroupSample(readText = (path) => readFile(path, "utf8")) {
  const first = async (paths) => {
    for (const path of paths) {
      try {
        return { path, text: await readText(path) };
      } catch {}
    }
    throw new Error(`Cgroup measurement unavailable: ${paths.join(", ")}`);
  };
  const cpu = await first([
    "/sys/fs/cgroup/cpu.stat",
    "/sys/fs/cgroup/cpu,cpuacct/cpuacct.usage",
    "/sys/fs/cgroup/cpuacct/cpuacct.usage",
  ]);
  const memory = await first([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]);
  const v2 = cpu.path.endsWith("cpu.stat");
  const usageUsec = v2
    ? Number(cpu.text.match(/^usage_usec\s+(\d+)$/m)?.[1])
    : Number(BigInt(cpu.text.trim()) / 1000n);
  const memoryBytes = Number(memory.text.trim());
  if (!Number.isFinite(usageUsec) || !Number.isFinite(memoryBytes))
    throw new Error("Invalid cgroup measurement.");
  return { cgroupVersion: v2 ? 2 : 1, cgroup: `usage_usec ${usageUsec}\n`, usageUsec, memoryBytes };
}
