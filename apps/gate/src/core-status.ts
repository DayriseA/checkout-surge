import type { FlyMachinesClient } from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { coreMachineState, findCoreMachine, setupFailed } from "./core-machine.js";

/** The core's Caddy listens on this port, on its 6PN address. */
export const corePort = 8080;

export type GatePageState = "stopped" | "booting" | "updating" | "setup_failed" | "unavailable";

/** Either a relay target on the core's Caddy, or the gate page to show instead. */
export type CoreStatus = { state: "ready"; target: string } | { state: GatePageState };

/** `no_answer` is a transport failure or a timeout; `not_ready` is an answer that is not OK. */
export type ProbeResult = "ready" | "not_ready" | "no_answer";

const probeTimeoutMs = 2_000;
// A ready core is re-read rarely, because a failed relay invalidates it at once. Any other state
// is re-read often, so the booting page turns into the demo soon after the core is ready.
const readyTtlMs = 10_000;
const otherTtlMs = 2_000;

/**
 * Reads the core status from the Machines API and the readiness probe. `previous` is the last
 * status read: a core that was ready and gives no answer at all stays ready, so a probe lost on
 * the network does not take the demo down; a core that answers "not ready" is booting.
 */
export async function readCoreStatus(options: {
  machines: Pick<FlyMachinesClient, "listMachines">;
  probe: (target: string) => Promise<ProbeResult>;
  previous?: CoreStatus | undefined;
}): Promise<CoreStatus> {
  const machine = await findCoreMachine(options.machines);
  if (!machine) return { state: "unavailable" };
  const state = coreMachineState(machine);
  if (state !== "started") return { state };
  if (setupFailed(machine)) return { state: "setup_failed" };
  const target = `http://[${machine.private_ip}]:${corePort}`;
  const probe = await options.probe(target);
  if (probe === "ready") return { state: "ready", target };
  const { previous } = options;
  if (probe === "no_answer" && previous?.state === "ready" && previous.target === target) {
    return previous;
  }
  return { state: "booting" };
}

/**
 * Readiness probe through the core's Caddy. `/health` is never counted as visitor activity, so
 * probing does not keep the core awake.
 */
export async function probeCore(target: string): Promise<ProbeResult> {
  try {
    const response = await fetch(`${target}/health`, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    await response.body?.cancel();
    return response.ok ? "ready" : "not_ready";
  } catch {
    return "no_answer";
  }
}

/** Caches the core status so relayed requests do not each call the Machines API. */
export class CoreStatusCache {
  private cached: { status: CoreStatus; expiresAt: number } | undefined;
  private pending: Promise<CoreStatus> | undefined;
  private generation = 0;

  constructor(
    private readonly options: {
      read: (previous: CoreStatus | undefined) => Promise<CoreStatus>;
      logger: Pick<CheckoutSurgeLogger, "warn">;
      now?: () => number;
    },
  ) {}

  current(): Promise<CoreStatus> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return Promise.resolve(this.cached.status);
    }
    this.pending ??= this.refresh();
    return this.pending;
  }

  /** Forgets the status, including a read in flight, which may predate the change. */
  invalidate(): void {
    this.generation += 1;
    this.cached = undefined;
    this.pending = undefined;
  }

  private async refresh(): Promise<CoreStatus> {
    const generation = this.generation;
    const previous = this.cached?.status;
    let status: CoreStatus;
    try {
      status = await this.options.read(previous);
    } catch (error) {
      // The Machines API has no SLA: a core that was ready stays relayed to, and the read is
      // retried on the next cycle. A failed relay drops `previous` first (invalidate).
      this.options.logger.warn({ err: error }, "Could not read the core status.");
      status = previous?.state === "ready" ? previous : { state: "unavailable" };
    }
    if (generation === this.generation) {
      const ttlMs = status.state === "ready" ? readyTtlMs : otherTtlMs;
      this.cached = { status, expiresAt: this.now() + ttlMs };
      this.pending = undefined;
    }
    return status;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
