import { readFile } from "node:fs/promises";
import {
  classifyFlyError,
  type FlyMachine,
  type FlyMachineConfig,
  type FlyMachineMount,
  FlyMachinesApiError,
  type FlyMachinesClient,
  type FlyVolume,
} from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { setupFailed } from "./core-machine.js";
import { corePort, type ProbeResult } from "./core-status.js";

type RecoveryMachines = Pick<
  FlyMachinesClient,
  | "getMachine"
  | "createMachine"
  | "destroyMachine"
  | "createVolume"
  | "deleteVolume"
  | "refreshLease"
>;

/** `no_capacity`: Fly refused the new volume or Machine for capacity; the old core is kept. */
export type RecoveryOutcome = "recreated" | "no_capacity";

/** The core's home region first, then anywhere in Europe (docs/hosted_runtime.md, "Recovery"). */
const coreRegions = "cdg,eu";
// Covers the volume and Machine creation, image pulls on a new host and the fresh install, with a
// wide margin. The lease stays on the old core until it is destroyed.
const recoveryLeaseTtlSeconds = 600;
const healthyTimeoutMs = 300_000;
const healthPollIntervalMs = 3_000;

/**
 * The core's full config as last deployed, which the deploy script writes into the gate Machine.
 * Fly returns no full config for a Machine on a host that is down, so a recovery never copies the
 * old Machine's. Undefined when the file is missing or unreadable.
 */
export async function readDeployedCoreConfig(path: string): Promise<FlyMachineConfig | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as FlyMachineConfig;
  } catch {
    return undefined;
  }
}

/**
 * Replaces the core with a fresh, empty one: a new volume and a new Machine from the deployed
 * config, which migrates and seeds on its first boot (core data is disposable). The old core is
 * destroyed only once the new one is healthy; otherwise the new one is removed and the old one kept.
 */
export class CoreRecovery {
  constructor(
    private readonly options: {
      machines: RecoveryMachines;
      probe: (target: string) => Promise<ProbeResult>;
      logger: Pick<CheckoutSurgeLogger, "info" | "warn" | "error">;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {}

  /**
   * Runs under the old core's lease, whose `nonce` the caller holds and releases, or without one
   * when the old core's host is down (Fly grants no usable lease there). Without an old core (none
   * is listed), a core is created and nothing is retired.
   */
  async recreate(
    old: FlyMachine | undefined,
    config: FlyMachineConfig,
    nonce: string | undefined,
  ): Promise<RecoveryOutcome> {
    const { machines, logger } = this.options;
    if (old && nonce) await machines.refreshLease(old.id, nonce, recoveryLeaseTtlSeconds);
    const [mount] = config.mounts ?? [];
    if (!mount?.name || !mount.size_gb) throw new Error("The core config mounts no volume.");
    logger.warn({ machineId: old?.id }, "Recreating the core Machine.");

    let volume: FlyVolume;
    try {
      volume = await machines.createVolume({
        name: mount.name,
        region: coreRegions,
        size_gb: mount.size_gb,
        compute: config.guest,
      });
    } catch (error) {
      return this.capacityOrThrow(error);
    }
    let created: FlyMachine;
    try {
      // A volume is pinned to its region, so the new core goes where Fly placed the volume.
      created = await machines.createMachine(freshConfig(config, mount, volume.id), volume.region);
    } catch (error) {
      await this.deleteVolume(volume.id);
      return this.capacityOrThrow(error);
    }
    try {
      await this.waitUntilHealthy(created.id);
    } catch (error) {
      try {
        await machines.destroyMachine(created.id);
        await machines.deleteVolume(volume.id);
      } catch (cleanupError) {
        // A volume still attached to the new core stays with it; the guard removes both.
        logger.error(
          { err: cleanupError, machineId: created.id, volumeId: volume.id },
          "Could not remove a new core that did not become healthy.",
        );
      }
      throw error;
    }
    if (old) await this.retire(old, nonce);
    logger.warn(
      { oldMachineId: old?.id, machineId: created.id, region: created.region },
      "Recreated the core Machine.",
    );
    return "recreated";
  }

  /** The new core is healthy once its setup succeeded and its Caddy answers over 6PN. */
  private async waitUntilHealthy(machineId: string): Promise<void> {
    const deadline = this.now() + healthyTimeoutMs;
    for (;;) {
      const machine = await this.options.machines.getMachine(machineId);
      if (setupFailed(machine)) throw new Error("The new core's setup failed.");
      if (
        machine.state === "started" &&
        (await this.options.probe(`http://[${machine.private_ip}]:${corePort}`)) === "ready"
      ) {
        return;
      }
      if (this.now() >= deadline) {
        throw new Error(`The new core was not healthy within ${healthyTimeoutMs / 1000}s.`);
      }
      await this.sleep(healthPollIntervalMs);
    }
  }

  /**
   * Force-destroys the old core, even on a host that is down (404: already gone), then starts the
   * deletion of its volume without waiting: on a host that is down, Fly keeps it pending until the
   * host returns. Leftovers are the guard's; the gate never selects a core that cannot serve.
   */
  private async retire(old: FlyMachine, nonce: string | undefined): Promise<void> {
    try {
      await this.options.machines.destroyMachine(old.id, nonce);
    } catch (error) {
      if (!(error instanceof FlyMachinesApiError && error.status === 404)) {
        this.options.logger.error(
          { err: error, machineId: old.id },
          "Could not destroy the replaced core.",
        );
        return;
      }
    }
    // A partial config, on a host that is down, may not name the volume.
    const volumeId = old.config.mounts?.[0]?.volume;
    if (volumeId) void this.deleteVolume(volumeId);
    else this.options.logger.warn({ machineId: old.id }, "The replaced core's volume is unknown.");
  }

  private async deleteVolume(volumeId: string): Promise<void> {
    await this.options.machines.deleteVolume(volumeId).catch((error: unknown) => {
      this.options.logger.error(
        { err: error, volumeId },
        "Could not delete an unused core volume.",
      );
    });
  }

  private capacityOrThrow(error: unknown): RecoveryOutcome {
    if (classifyFlyError(error) !== "provider_capacity") throw error;
    this.options.logger.error({ err: error }, "No capacity in Europe to recreate the core.");
    return "no_capacity";
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** The deployed config on the new volume, without a recreation request. */
function freshConfig(
  config: FlyMachineConfig,
  mount: FlyMachineMount,
  volumeId: string,
): FlyMachineConfig {
  const { recreate: _request, ...metadata } = config.metadata ?? {};
  return { ...config, metadata, mounts: [{ ...mount, volume: volumeId }] };
}
