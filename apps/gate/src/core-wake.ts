import {
  classifyFlyError,
  type FlyFailureClass,
  type FlyMachine,
  type FlyMachineConfig,
  FlyMachinesApiError,
  type FlyMachinesClient,
} from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import {
  coreMachineState,
  findCoreMachine,
  hostDown,
  recreationRequested,
} from "./core-machine.js";
import type { CoreRecovery } from "./core-recovery.js";

type WakeMachines = Pick<
  FlyMachinesClient,
  "listMachines" | "getMachine" | "startMachine" | "waitForState" | "acquireLease" | "releaseLease"
>;

/**
 * `starting`: the core is starting or already up; `relocating`: a recovery is recreating it. The
 * other outcomes have their own page.
 */
export type WakeOutcome = "starting" | "relocating" | "updating" | "unavailable";

/**
 * The page a recovery shows instead of the core's state: in progress (`relocating` after a
 * provider failure, `refreshing` for a fresh core an operator requested), or out of capacity.
 */
export type RecoveryPage = "relocating" | "refreshing" | "no_capacity";

// Covers the worst case of the wake's own calls under the lease, at the client's timeouts: the
// read (30 s), the wait for a stopping core (40 s), three starts (90 s) and the back-off (4 s),
// about 164 s. The lease is released right after, or extended for a recovery.
const leaseTtlSeconds = 180;
const stoppingWaitSeconds = 30;
// Three start attempts in place, with back-off between them, before the core is recreated.
const startRetryDelaysMs = [1_000, 3_000];
const retriedStartFailures = new Set<FlyFailureClass>([
  "provider_capacity",
  "host_unreachable",
  "transient",
]);
const recreatingFailures = new Set<FlyFailureClass>(["provider_capacity", "host_unreachable"]);

/**
 * Starts the core on a deliberate visitor action, under the core Machine lease. A held lease means
 * a deploy is updating the core. A core that still cannot start for capacity, or whose host is
 * down, is recreated in the background while visitors see the relocating page.
 */
export class CoreWake {
  private pending: Promise<WakeOutcome> | undefined;
  private recoveryPage: RecoveryPage | undefined;

  constructor(
    private readonly options: {
      machines: WakeMachines;
      recovery: Pick<CoreRecovery, "recreate">;
      /** The core config the deploy script wrote into the gate; undefined when missing. */
      readCoreConfig: () => Promise<FlyMachineConfig | undefined>;
      /** Called once a start is sent or a recovery ends, so the next page reads the core again. */
      onStarted: () => void;
      logger: Pick<CheckoutSurgeLogger, "info" | "warn" | "error">;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** While set, this page answers every request instead of the core. */
  recoveryState(): RecoveryPage | undefined {
    return this.recoveryPage;
  }

  /** One wake at a time: visitors who press the button together join the same one. */
  wake(): Promise<WakeOutcome> {
    if (this.recoveryPage === "relocating" || this.recoveryPage === "refreshing") {
      return Promise.resolve("relocating");
    }
    this.pending ??= this.wakeOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async wakeOnce(): Promise<WakeOutcome> {
    // A new attempt replaces an earlier "no capacity" answer.
    this.recoveryPage = undefined;
    try {
      const machine = await findCoreMachine(this.options.machines);
      // No core listed (lost its metadata on a dead host, or deleted): create one, touching no
      // Machine the gate does not recognize as the core.
      if (!machine) return await this.recover(undefined, undefined);
      // Fly grants no usable lease on a host that is down (flyctl skips it too).
      if (hostDown(machine)) return await this.recover(machine, undefined);
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
    let recovering = false;
    try {
      // Read again under the lease: the core may have changed since the listing.
      const current = await machines.getMachine(machine.id);
      // An operator's request for a fresh core, or a host that went down, skips the start.
      if (!recreationRequested(current) && !hostDown(current)) {
        if (current.state === "started" || current.state === "starting") return "starting";
        if (current.state === "stopping") {
          await machines.waitForState(machine.id, "stopped", {
            timeoutSeconds: stoppingWaitSeconds,
          });
        }
        const failure = await this.startInPlace(machine.id, nonce);
        if (failure === null) {
          this.options.onStarted();
          return "starting";
        }
        if (!recreatingFailures.has(classifyFlyError(failure))) throw failure;
      }
      const outcome = await this.recover(
        current,
        nonce,
        recreationRequested(current) ? "refreshing" : "relocating",
      );
      recovering = outcome === "relocating";
      return outcome;
    } finally {
      if (!recovering) await this.releaseLease(machine.id, nonce);
    }
  }

  /**
   * Sends `start`, retrying with back-off. Returns the last failure once the retries are spent, or
   * null when the start was accepted.
   */
  private async startInPlace(machineId: string, nonce: string): Promise<unknown | null> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.options.logger.info({ machineId }, "Starting the core Machine.");
        await this.options.machines.startMachine(machineId, nonce);
        return null;
      } catch (error) {
        const failure = classifyFlyError(error);
        this.options.logger.warn(
          { err: error, failure, attempt: attempt + 1 },
          "The core Machine did not start.",
        );
        const delayMs = startRetryDelaysMs[attempt];
        if (!retriedStartFailures.has(failure)) throw error;
        if (delayMs === undefined) return error;
        await this.sleep(delayMs);
      }
    }
  }

  /**
   * Recreates the core in the background from the deployed core config, keeping the lease, when
   * one is held, until it ends. Without that config, the core cannot be recreated.
   */
  private async recover(
    old: FlyMachine | undefined,
    nonce: string | undefined,
    page: "relocating" | "refreshing" = "relocating",
  ): Promise<WakeOutcome> {
    const config = await this.options.readCoreConfig();
    if (!config) {
      this.options.logger.error(
        { machineId: old?.id },
        "No deployed core config in the gate; the core cannot be recreated.",
      );
      return "unavailable";
    }
    this.recoveryPage = page;
    void this.options.recovery
      .recreate(old, config, nonce)
      .then(
        (outcome) => {
          this.recoveryPage = outcome === "no_capacity" ? "no_capacity" : undefined;
        },
        (error: unknown) => {
          // The old core is kept; the visitor can try again from the start page.
          this.options.logger.error({ err: error }, "Could not recreate the core Machine.");
          this.recoveryPage = undefined;
        },
      )
      .finally(async () => {
        if (old && nonce) await this.releaseLease(old.id, nonce);
        this.options.onStarted();
      });
    return "relocating";
  }

  private async releaseLease(machineId: string, nonce: string): Promise<void> {
    await this.options.machines.releaseLease(machineId, nonce).catch((error: unknown) => {
      // An expired lease, or one destroyed with its recreated Machine, is already gone.
      if (error instanceof FlyMachinesApiError && error.status === 404) return;
      this.options.logger.warn({ err: error }, "Could not release the core Machine lease.");
    });
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}
