import { readFile } from "node:fs/promises";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";

/**
 * Linux caps a listener's accept queue at `net.core.somaxconn` and reports
 * nothing when it does so. The reference runtime aligns the two through the
 * `api` service `sysctls:` block, but deployments that clear it (see
 * `docker-compose.no-sysctls.yml`) fall back to the platform default, so the
 * divergence is announced at startup rather than left silent.
 */
export const kernelSomaxconnPath = "/proc/sys/net/core/somaxconn";

export function parseKernelSomaxconn(contents: string): number | undefined {
  const value = Number(contents.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export async function warnWhenListenBacklogIsCapped(input: {
  requestedBacklog: number;
  logger: CheckoutSurgeLogger;
  readKernelSomaxconn?: () => Promise<string>;
}): Promise<void> {
  const kernelSomaxconn = await readKernelSomaxconnQuietly(input.readKernelSomaxconn);
  if (kernelSomaxconn === undefined || kernelSomaxconn >= input.requestedBacklog) return;

  input.logger.warn(
    {
      requestedBacklog: input.requestedBacklog,
      kernelSomaxconn,
      effectiveBacklog: kernelSomaxconn,
      source: kernelSomaxconnPath,
    },
    "Configured API listen backlog exceeds net.core.somaxconn; the kernel will cap the accept queue. Raise the sysctl to API_LISTEN_BACKLOG or lower API_LISTEN_BACKLOG to match.",
  );
}

async function readKernelSomaxconnQuietly(
  readKernelSomaxconn?: () => Promise<string>,
): Promise<number | undefined> {
  const read = readKernelSomaxconn ?? (() => readFile(kernelSomaxconnPath, "utf8"));
  try {
    return parseKernelSomaxconn(await read());
  } catch {
    // Platforms without procfs cannot be checked; startup must not depend on it.
    return undefined;
  }
}
