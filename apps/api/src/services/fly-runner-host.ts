import type { FlyMachine, FlyMachineConfig, FlyMachinesClient } from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import type { RunnerHost, RunnerStopTarget } from "./runner-host.js";
import type { RunnerControlGateway } from "./traffic-execution-gateway.js";

export interface RunnerMachineSize {
  cpuKind: string;
  cpus: number;
  memoryMb: number;
}

type FlyRunnerMachines = Pick<
  FlyMachinesClient,
  | "listMachines"
  | "getMachine"
  | "updateMachine"
  | "startMachine"
  | "stopMachine"
  | "waitForState"
  | "acquireLease"
  | "releaseLease"
>;

// The TTL covers measured operations (3 to 8 s) with a wide margin, so the lease is never renewed.
// It does not cover the worst-case sum of per-call timeouts in start (about 380 s). The only other
// lease party is the deploy script.
const leaseTtlSeconds = 300;
const busyRetryWindowMs = 30_000;
const busyRetryIntervalMs = 1_000;
const shutdownWaitSeconds = 30;
const machineWaitSeconds = 60;

/**
 * The runner as one Fly Machine with no volume, stopped between runs. Each operation holds the
 * Machine lease, which coordinates with the deploy script.
 */
export class FlyRunnerHost implements RunnerHost {
  constructor(
    private readonly options: {
      machines: FlyRunnerMachines;
      control: Pick<RunnerControlGateway, "readIdentity" | "shutdown">;
      size: RunnerMachineSize;
      /** The core's address for the runner's metrics and completion reports. */
      apiBaseUrl: string;
      logger: Pick<CheckoutSurgeLogger, "info" | "warn">;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {}

  start(runId: string): Promise<{ machineId: string }> {
    return this.withLease("runner start", async (machine, nonce) => {
      if (machine.state !== "stopped") {
        // No other run is in flight, so a running runner is stale: it never serves this run.
        const identity = await this.options.control.readIdentity().catch(() => null);
        await this.stopMachine(machine, nonce, { runId, bootId: identity?.bootId ?? null }, true);
      }
      const config = this.configForNextRun(machine.config);
      if (config) {
        const updated = await this.options.machines.updateMachine(machine.id, config, nonce);
        await this.requireState(machine.id, "stopped", updated.instance_id);
      }
      await this.options.machines.startMachine(machine.id, nonce);
      await this.requireState(machine.id, "started");
      return { machineId: machine.id };
    });
  }

  stop(target: RunnerStopTarget): Promise<void> {
    return this.withLease("runner stop", (machine, nonce) =>
      this.stopMachine(machine, nonce, target, false),
    );
  }

  async isStopped(): Promise<boolean> {
    return (await this.findRunnerMachine()).state === "stopped";
  }

  /**
   * Fenced shutdown through the runner first. Fly `stop` has no fencing, so it is only the
   * fallback for a runner that cannot be asked, or that stays busy or running too long.
   */
  private async stopMachine(
    machine: FlyMachine,
    nonce: string,
    target: RunnerStopTarget,
    stopOtherBoot: boolean,
  ): Promise<void> {
    if (machine.state === "stopped") return;
    const outcome = target.bootId
      ? await this.requestShutdown({ runId: target.runId, bootId: target.bootId })
      : "unreachable";
    if (outcome === "ignored" && !stopOtherBoot) {
      this.options.logger.info(
        { ...target },
        "The runner serves another boot or run; left running.",
      );
      return;
    }
    if (
      outcome === "shutdown_requested" &&
      (await this.options.machines.waitForState(machine.id, "stopped", {
        timeoutSeconds: shutdownWaitSeconds,
      }))
    ) {
      return;
    }
    this.options.logger.warn({ ...target, outcome }, "Stopping the runner Machine through Fly.");
    await this.options.machines.stopMachine(machine.id, nonce);
    await this.requireState(machine.id, "stopped");
  }

  private async requestShutdown(target: {
    runId: string;
    bootId: string;
  }): Promise<"shutdown_requested" | "ignored" | "busy" | "unreachable"> {
    const deadline = this.now() + busyRetryWindowMs;
    for (;;) {
      let outcome: Awaited<ReturnType<RunnerControlGateway["shutdown"]>>;
      try {
        outcome = await this.options.control.shutdown(target);
      } catch {
        return "unreachable";
      }
      if (outcome === "shutdown_requested") return outcome;
      if (outcome !== "deferred_busy") return "ignored";
      // The runner may still be recording the acknowledgement of a report just persisted.
      if (this.now() >= deadline) return "busy";
      await this.sleep(busyRetryIntervalMs);
    }
  }

  /** The config with the size and API address the next run needs, or null when it has them. */
  private configForNextRun(config: FlyMachineConfig): FlyMachineConfig | null {
    const { size, apiBaseUrl } = this.options;
    if (
      config.guest.cpu_kind === size.cpuKind &&
      config.guest.cpus === size.cpus &&
      config.guest.memory_mb === size.memoryMb &&
      config.env?.API_BASE_URL === apiBaseUrl
    ) {
      return null;
    }
    return {
      ...config,
      guest: { ...config.guest, cpu_kind: size.cpuKind, cpus: size.cpus, memory_mb: size.memoryMb },
      env: { ...config.env, API_BASE_URL: apiBaseUrl },
    };
  }

  private async withLease<T>(
    description: string,
    operation: (machine: FlyMachine, nonce: string) => Promise<T>,
  ): Promise<T> {
    const machine = await this.findRunnerMachine();
    const nonce = await this.options.machines.acquireLease(
      machine.id,
      leaseTtlSeconds,
      description,
    );
    try {
      // Read again under the lease: a deploy may have replaced the config since the listing.
      return await operation(await this.options.machines.getMachine(machine.id), nonce);
    } finally {
      await this.options.machines.releaseLease(machine.id, nonce).catch((error: unknown) => {
        this.options.logger.warn({ err: error }, "Could not release the runner Machine lease.");
      });
    }
  }

  /** The runner is the app's only Machine with `role=runner` metadata, never a fixed ID. */
  private async findRunnerMachine(): Promise<FlyMachine> {
    const runners = (await this.options.machines.listMachines()).filter(
      (machine) => machine.config.metadata?.role === "runner",
    );
    const [runner] = runners;
    if (!runner || runners.length > 1) {
      throw new Error(`Expected one runner Machine, found ${runners.length}.`);
    }
    return runner;
  }

  private async requireState(
    machineId: string,
    state: "started" | "stopped",
    instanceId?: string,
  ): Promise<void> {
    const reached = await this.options.machines.waitForState(machineId, state, {
      timeoutSeconds: machineWaitSeconds,
      ...(instanceId ? { instanceId } : {}),
    });
    if (!reached) {
      throw new Error(`The runner Machine did not reach ${state} within ${machineWaitSeconds}s.`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}
