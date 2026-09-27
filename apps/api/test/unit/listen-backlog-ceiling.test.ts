import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { describe, expect, it, vi } from "vitest";
import {
  parseKernelSomaxconn,
  warnWhenListenBacklogIsCapped,
} from "../../src/runtime/listen-backlog-ceiling.js";

function warningCapturingLogger(): { logger: CheckoutSurgeLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn } as unknown as CheckoutSurgeLogger, warn };
}

describe("listen backlog ceiling", () => {
  it("parses only positive integer somaxconn readings", () => {
    expect(parseKernelSomaxconn("4096\n")).toBe(4096);
    expect(parseKernelSomaxconn("")).toBeUndefined();
    expect(parseKernelSomaxconn("0")).toBeUndefined();
  });

  it("warns with both values when the kernel caps the configured backlog", async () => {
    const { logger, warn } = warningCapturingLogger();

    await warnWhenListenBacklogIsCapped({
      requestedBacklog: 8192,
      logger,
      readKernelSomaxconn: async () => "4096\n",
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      requestedBacklog: 8192,
      kernelSomaxconn: 4096,
      effectiveBacklog: 4096,
    });
  });

  it("stays silent when the kernel honours the configured backlog", async () => {
    const { logger, warn } = warningCapturingLogger();

    await warnWhenListenBacklogIsCapped({
      requestedBacklog: 8192,
      logger,
      readKernelSomaxconn: async () => "8192\n",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent and does not throw when the sysctl cannot be read", async () => {
    const { logger, warn } = warningCapturingLogger();

    await expect(
      warnWhenListenBacklogIsCapped({
        requestedBacklog: 8192,
        logger,
        readKernelSomaxconn: async () => {
          throw new Error("ENOENT");
        },
      }),
    ).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
  });
});
