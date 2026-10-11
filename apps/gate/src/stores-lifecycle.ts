import type { FlyMachinesClient } from "@checkout-surge/fly-machines";
import { findCoreMachine, hostDown } from "./core-machine.js";

type Machines = Pick<
  FlyMachinesClient,
  | "listMachines"
  | "getMachine"
  | "acquireLease"
  | "releaseLease"
  | "refreshLease"
  | "startMachine"
  | "stopMachine"
  | "waitForState"
>;
// Includes fresh organization checks before mutations, store preparation and core recovery.
export const proofLifecycleLeaseSeconds = 900;

/** One persistent stores Machine. Unavailable stores are never automatically replaced. */
export class StoresLifecycle {
  constructor(private readonly options: { core: Machines; stores: Machines }) {}

  async withStarted<T>(operation: () => Promise<T>): Promise<T> {
    const machine = await this.machine();
    const nonce = await this.options.stores.acquireLease(
      machine.id,
      proofLifecycleLeaseSeconds,
      "proof wake",
    );
    try {
      const current = await this.options.stores.getMachine(machine.id);
      if (hostDown(current))
        throw new Error(
          "The proof stores host is unavailable; explicit proof recreation is required.",
        );
      if (current.state === "stopping") await this.wait(this.options.stores, current.id, "stopped");
      if (current.state !== "started" && current.state !== "starting")
        await this.options.stores.startMachine(current.id, nonce);
      await this.wait(this.options.stores, current.id, "started");
      // Preparation may have consumed part of the lease. Core work can include confirmed
      // shutdown of the old authority followed by the full recovery health deadline.
      await this.options.stores.refreshLease(machine.id, nonce, proofLifecycleLeaseSeconds);
      return await operation();
    } finally {
      await this.options.stores.releaseLease(machine.id, nonce);
    }
  }

  /** The caller's socket may disappear after SIGINT; ownership of this operation stays here. */
  async stopCoreThenStores(coreId: string): Promise<void> {
    const core = await findCoreMachine(this.options.core);
    if (!core || core.id !== coreId || hostDown(core))
      throw new Error("Idle shutdown caller is not the current core.");
    const nonce = await this.options.core.acquireLease(
      coreId,
      proofLifecycleLeaseSeconds,
      "proof idle shutdown",
    );
    try {
      const current = await findCoreMachine(this.options.core);
      if (!current || current.id !== coreId) throw new Error("Core changed before idle shutdown.");
      if (current.state !== "stopped") {
        await this.options.core.stopMachine(coreId, nonce);
        await this.wait(this.options.core, coreId, "stopped");
      }
      await this.stopStores();
    } finally {
      await this.options.core.releaseLease(coreId, nonce);
    }
  }

  async stopStores(beforeStop?: () => Promise<boolean>): Promise<void> {
    const machine = await this.machine();
    const nonce = await this.options.stores.acquireLease(
      machine.id,
      proofLifecycleLeaseSeconds,
      "proof stores shutdown",
    );
    try {
      if (beforeStop && !(await beforeStop())) return;
      const current = await this.options.stores.getMachine(machine.id);
      if (hostDown(current)) throw new Error("Proof stores host is unavailable.");
      if (current.state === "stopped") return;
      await this.options.stores.stopMachine(machine.id, nonce);
      await this.wait(this.options.stores, machine.id, "stopped");
    } finally {
      await this.options.stores.releaseLease(machine.id, nonce);
    }
  }

  private async wait(client: Machines, machineId: string, state: "started" | "stopped") {
    if (!(await client.waitForState(machineId, state, { timeoutSeconds: 60 }))) {
      throw new Error(`Proof Machine ${machineId} did not reach ${state}.`);
    }
  }

  private async machine() {
    const machines = await this.options.stores.listMachines();
    if (
      machines.length !== 1 ||
      machines[0]?.config.metadata?.role !== "stores" ||
      machines[0].region !== "cdg"
    ) {
      throw new Error("Expected one proof stores Machine in cdg.");
    }
    return machines[0];
  }
}
