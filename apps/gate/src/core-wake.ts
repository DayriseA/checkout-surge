import {
  classifyFlyError,
  type FlyMachine,
  FlyMachinesApiError,
  type FlyMachinesClient,
} from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { coreMachineState, findCoreMachine } from "./core-machine.js";

type WakeMachines = Pick<
  FlyMachinesClient,
  "listMachines" | "getMachine" | "startMachine" | "waitForState" | "acquireLease" | "releaseLease"
>;

/** `starting`: the core is starting or already up; the other outcomes have their own page. */
export type WakeOutcome = "starting" | "updating" | "unavailable";

// Covers waiting for a stopping core (30 s) and the start call; the lease is released right after.
const leaseTtlSeconds = 60;
const stoppingWaitSeconds = 30;

/**
 * Starts the core on a deliberate visitor action, under the core Machine lease. A held lease means
 * a deploy is updating the core.
 */
export class CoreWake {
  private pending: Promise<WakeOutcome> | undefined;

  constructor(
    private readonly options: {
      machines: WakeMachines;
      /** Called once the start is sent, so the next page shows the booting core. */
      onStarted: () => void;
      logger: Pick<CheckoutSurgeLogger, "info" | "warn" | "error">;
    },
  ) {}

  /** One wake at a time: visitors who press the button together join the same one. */
  wake(): Promise<WakeOutcome> {
    this.pending ??= this.wakeOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async wakeOnce(): Promise<WakeOutcome> {
    try {
      const machine = await findCoreMachine(this.options.machines);
      if (!machine) throw new Error("Expected a core Machine, found none.");
      const state = coreMachineState(machine);
      if (state === "stopped") return await this.startUnderLease(machine);
      if (state === "updating" || state === "unavailable") return state;
      return "starting";
    } catch (error) {
      this.options.logger.error({ err: error }, "Could not start the core Machine.");
      return "unavailable";
    }
  }

  private async startUnderLease(machine: FlyMachine): Promise<WakeOutcome> {
    const { machines } = this.options;
    let nonce: string;
    try {
      nonce = await machines.acquireLease(machine.id, leaseTtlSeconds, "gate wake");
    } catch (error) {
      if (classifyFlyError(error) !== "conflict") throw error;
      this.options.logger.info({ err: error }, "The core Machine lease is held; not starting it.");
      return "updating";
    }
    try {
      // Read again under the lease: the core may have changed since the listing.
      const current = await machines.getMachine(machine.id);
      if (current.state === "started" || current.state === "starting") return "starting";
      if (current.state === "stopping") {
        await machines.waitForState(machine.id, "stopped", { timeoutSeconds: stoppingWaitSeconds });
      }
      this.options.logger.info({ machineId: machine.id }, "Starting the core Machine.");
      await machines.startMachine(machine.id, nonce);
      this.options.onStarted();
      return "starting";
    } finally {
      await machines.releaseLease(machine.id, nonce).catch((error: unknown) => {
        // An expired lease is already gone.
        if (error instanceof FlyMachinesApiError && error.status === 404) return;
        this.options.logger.warn({ err: error }, "Could not release the core Machine lease.");
      });
    }
  }
}
