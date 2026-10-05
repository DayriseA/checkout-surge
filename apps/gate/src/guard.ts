import { automaticRunResetDeadlineSeconds } from "@checkout-surge/contracts";
import {
  classifyFlyError,
  type FlyMachine,
  FlyMachinesApiError,
  type FlyMachinesClient,
} from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { coreCanServe, hostDown, selectCore, setupFailed } from "./core-machine.js";
import { corePort, type ProbeResult } from "./core-status.js";

export type GuardMachines = Pick<
  FlyMachinesClient,
  | "listMachines"
  | "listVolumes"
  | "getMachine"
  | "acquireLease"
  | "releaseLease"
  | "stopMachine"
  | "destroyMachine"
  | "deleteVolume"
>;

export interface GuardThresholds {
  /** Only a bug keeps a core awake this long: its own idle stop failed. */
  coreMaxAwakeSeconds: number;
  /** A core started more recently is not probed: it may still be booting, or be a recovery's. */
  coreStartupGraceSeconds: number;
  /** A runner started longer ago has outlived its own maximum-lifetime timer. */
  runnerMaxStartedSeconds: number;
  /** Younger leftovers may belong to a recovery or a replacement still in progress. */
  leftoverGraceSeconds: number;
}

export const defaultGuardThresholds: GuardThresholds = {
  coreMaxAwakeSeconds: 3 * 3600,
  // A recovery waits up to 5 minutes for its new core to become healthy.
  coreStartupGraceSeconds: 600,
  // The runner exits 30 s past the automatic-reset deadline, counted from its boot; the rest
  // covers the boot and the graceful exit.
  runnerMaxStartedSeconds: automaticRunResetDeadlineSeconds + 300,
  // A recovery holds the old core's lease for up to 10 minutes.
  leftoverGraceSeconds: 900,
};

// Several probes a few minutes apart, so a core saturated by a burst is not taken for a dead one.
const probeAttempts = 3;
const probeIntervalMs = 120_000;
const leaseTtlSeconds = 60;

type App = "core" | "runner";
type StopReason = "setup_failed" | "unreachable" | "awake_too_long" | "overdue";

type GuardAction =
  | { kind: "stop"; app: App; machine: FlyMachine; reason: StopReason }
  | { kind: "destroy"; app: App; machine: FlyMachine; reason: "surplus" | "unknown" }
  | { kind: "delete_volume"; app: App; volumeId: string; reason: "orphan" };

/**
 * The hourly safety net: stops a core or a runner left awake by a bug, and removes leftover
 * Machines and volumes in the core and runner apps. It cleans up accidents; anyone holding a
 * deploy token can set the same metadata.
 */
export class Guard {
  constructor(
    private readonly options: {
      core: GuardMachines;
      runner: GuardMachines;
      probe: (target: string) => Promise<ProbeResult>;
      thresholds: GuardThresholds;
      /** Logs the actions without taking them. */
      dryRun: boolean;
      logger: Pick<CheckoutSurgeLogger, "info" | "warn" | "error">;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** One pass over both apps. Resolves false when a listing or an action failed. */
  async run(): Promise<boolean> {
    const core = await this.guardApp("core", () => this.planCore());
    const runner = await this.guardApp("runner", () => this.planRunner());
    return core && runner;
  }

  private async guardApp(app: App, plan: () => Promise<GuardAction[]>): Promise<boolean> {
    const { logger, dryRun } = this.options;
    let actions: GuardAction[];
    try {
      actions = await plan();
    } catch (error) {
      logger.error({ err: error, app }, "The guard could not read the app.");
      return false;
    }
    let succeeded = true;
    for (const action of actions) {
      if (dryRun) logger.info(actionFields(action), "The guard would act (dry run).");
      else succeeded = (await this.execute(action)) && succeeded;
    }
    logger.info({ app, actions: actions.length, dryRun }, "The guard checked the app.");
    return succeeded;
  }

  private async planCore(): Promise<GuardAction[]> {
    const { core } = this.options;
    const listed = await core.listMachines();
    const unreachable = await this.unreachableCores(
      listed.filter((machine) => isRole(machine, "core") && this.probeDue(machine)),
    );
    // Probing can take minutes, during which a core may stop or be woken again.
    const [machines, volumes] = await Promise.all([
      unreachable.size > 0 ? core.listMachines() : listed,
      core.listVolumes(),
    ]);
    const silent = (machine: FlyMachine) => unreachable.get(machine.id) === startedAt(machine);
    const kept = selectCore(machines, (machine) => coreCanServe(machine) && !silent(machine));
    const actions: GuardAction[] = [];
    for (const machine of machines) {
      if (!isRole(machine, "core")) {
        actions.push(...this.unknown("core", machine));
      } else if (machine !== kept && this.pastGrace(machine.created_at)) {
        actions.push({ kind: "destroy", app: "core", machine, reason: "surplus" });
      } else {
        const reason = this.coreStopReason(machine, silent(machine));
        if (reason) actions.push({ kind: "stop", app: "core", machine, reason });
      }
    }
    const machineIds = new Set(machines.map((machine) => machine.id));
    for (const volume of volumes) {
      const attached = volume.attached_machine_id && machineIds.has(volume.attached_machine_id);
      // Other states are transitional, or a deletion Fly already accepted.
      if (!attached && volume.state === "created" && this.pastGrace(volume.created_at)) {
        actions.push({ kind: "delete_volume", app: "core", volumeId: volume.id, reason: "orphan" });
      }
    }
    return actions;
  }

  private async planRunner(): Promise<GuardAction[]> {
    const machines = await this.options.runner.listMachines();
    // The API uses the newest runner, so the others are surplus.
    const [kept] = machines
      .filter((machine) => isRole(machine, "runner"))
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    const actions: GuardAction[] = [];
    for (const machine of machines) {
      if (!isRole(machine, "runner")) {
        actions.push(...this.unknown("runner", machine));
      } else if (machine !== kept && this.pastGrace(machine.created_at)) {
        actions.push({ kind: "destroy", app: "runner", machine, reason: "surplus" });
      } else if (
        awake(machine) &&
        this.olderThan(startedAt(machine), this.options.thresholds.runnerMaxStartedSeconds)
      ) {
        actions.push({ kind: "stop", app: "runner", machine, reason: "overdue" });
      }
    }
    return actions;
  }

  /**
   * A Machine without the app's role is destroyed after the grace period, unless its host is not
   * ok: Fly then reports only a partial config, which may have lost the role of a real Machine.
   */
  private unknown(app: App, machine: FlyMachine): GuardAction[] {
    if (hostDown(machine)) {
      this.options.logger.warn(
        { app, machineId: machine.id, hostStatus: machine.host_status },
        "A Machine without a known role sits on a host that is not ok; the guard leaves it.",
      );
      return [];
    }
    return this.pastGrace(machine.created_at)
      ? [{ kind: "destroy", app, machine, reason: "unknown" }]
      : [];
  }

  private coreStopReason(machine: FlyMachine, silent: boolean): StopReason | undefined {
    if (!awake(machine)) return undefined;
    if (setupFailed(machine)) return "setup_failed";
    if (silent) return "unreachable";
    if (this.olderThan(startedAt(machine), this.options.thresholds.coreMaxAwakeSeconds)) {
      return "awake_too_long";
    }
    return undefined;
  }

  private probeDue(machine: FlyMachine): boolean {
    return (
      awake(machine) &&
      coreCanServe(machine) &&
      this.olderThan(startedAt(machine), this.options.thresholds.coreStartupGraceSeconds)
    );
  }

  /** The cores that never answered the readiness probe, with the start they were probed in. */
  private async unreachableCores(cores: FlyMachine[]): Promise<Map<string, number>> {
    let silent = cores;
    for (let attempt = 1; attempt <= probeAttempts && silent.length > 0; attempt += 1) {
      if (attempt > 1) await this.sleep(probeIntervalMs);
      const answers = await Promise.all(silent.map((machine) => this.probe(machine, attempt)));
      silent = silent.filter((_, index) => answers[index] !== "ready");
    }
    return new Map(silent.map((machine) => [machine.id, startedAt(machine)]));
  }

  private async probe(machine: FlyMachine, attempt: number): Promise<ProbeResult> {
    const startedMs = this.now();
    const answer = await this.options.probe(`http://[${machine.private_ip}]:${corePort}`);
    this.options.logger.info(
      { app: "core", machineId: machine.id, attempt, answer, durationMs: this.now() - startedMs },
      "The guard probed the core.",
    );
    return answer;
  }

  private async execute(action: GuardAction): Promise<boolean> {
    const { logger } = this.options;
    const machines = this.options[action.app];
    try {
      const done =
        action.kind === "delete_volume"
          ? await machines.deleteVolume(action.volumeId).then(() => true)
          : action.kind === "stop"
            ? await this.actOnPlanned(machines, action.machine, (nonce) =>
                machines.stopMachine(action.machine.id, nonce),
              )
            : await this.destroy(machines, action.machine);
      if (done) logger.warn(actionFields(action), "The guard acted.");
      else
        logger.warn(
          actionFields(action),
          "Leased or changed since the plan; the guard skipped it.",
        );
      return true;
    } catch (error) {
      logger.error({ ...actionFields(action), err: error }, "The guard could not act.");
      return false;
    }
  }

  /** Force-destroys the Machine, then deletes its volume. */
  private async destroy(machines: GuardMachines, machine: FlyMachine): Promise<boolean> {
    const destroyed = await this.actOnPlanned(machines, machine, (nonce) =>
      destroyUnlessGone(machines, machine.id, nonce),
    );
    if (!destroyed) return false;
    // On a host that is down, Fly keeps the volume pending until the host returns.
    const volumeId = machine.config.mounts?.[0]?.volume;
    if (volumeId) await machines.deleteVolume(volumeId);
    return true;
  }

  /**
   * Acts only on a Machine unchanged since the plan, read again under its lease. Fly grants no
   * usable lease on a host that is not ok, so such a Machine is read again just before acting,
   * without one, as flyctl does. False when the lease is held or the Machine changed.
   */
  private actOnPlanned(
    machines: GuardMachines,
    planned: FlyMachine,
    act: (nonce?: string) => Promise<void>,
  ): Promise<boolean> {
    const actIfUnchanged = async (nonce?: string) => {
      if (!(await unchanged(machines, planned))) return false;
      await act(nonce);
      return true;
    };
    return hostDown(planned)
      ? actIfUnchanged()
      : this.withLease(machines, planned.id, actIfUnchanged);
  }

  /**
   * Runs `operation` under the Machine's lease, so the guard never acts on a Machine that a wake,
   * a recovery, a deploy or a runner operation is working on. False when the lease is held.
   */
  private async withLease(
    machines: GuardMachines,
    machineId: string,
    operation: (nonce: string) => Promise<boolean>,
  ): Promise<boolean> {
    let nonce: string;
    try {
      nonce = await machines.acquireLease(machineId, leaseTtlSeconds, "guard");
    } catch (error) {
      if (classifyFlyError(error) === "conflict") return false;
      throw error;
    }
    try {
      return await operation(nonce);
    } finally {
      // A destroyed Machine has no lease left to release.
      await machines.releaseLease(machineId, nonce).catch(() => undefined);
    }
  }

  private pastGrace(createdAt: string): boolean {
    return this.olderThan(Date.parse(createdAt), this.options.thresholds.leftoverGraceSeconds);
  }

  private olderThan(timestamp: number, seconds: number): boolean {
    return this.now() - timestamp > seconds * 1000;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function isRole(machine: FlyMachine, role: App): boolean {
  return machine.config.metadata?.role === role;
}

/** Started on a host that answers: a Machine on a host that is down is never stopped. */
function awake(machine: FlyMachine): boolean {
  return machine.state === "started" && !hostDown(machine);
}

/**
 * When the Machine last started. Fly lists a Machine's events newest first, since its last
 * config update; if the start is no longer listed, the oldest listed event bounds it.
 */
function startedAt(machine: FlyMachine): number {
  const events = machine.events ?? [];
  const start = events.find((event) => event.type === "start") ?? events.at(-1);
  return start?.timestamp ?? Date.parse(machine.created_at);
}

/** Whether the Machine kept its state, host and latest start since the plan; false once gone. */
async function unchanged(machines: GuardMachines, planned: FlyMachine): Promise<boolean> {
  let current: FlyMachine;
  try {
    current = await machines.getMachine(planned.id);
  } catch (error) {
    if (error instanceof FlyMachinesApiError && error.status === 404) return false;
    throw error;
  }
  return (
    current.state === planned.state &&
    hostDown(current) === hostDown(planned) &&
    startedAt(current) === startedAt(planned)
  );
}

async function destroyUnlessGone(
  machines: GuardMachines,
  machineId: string,
  nonce?: string,
): Promise<void> {
  try {
    await machines.destroyMachine(machineId, nonce);
  } catch (error) {
    if (!(error instanceof FlyMachinesApiError && error.status === 404)) throw error;
  }
}

function actionFields(action: GuardAction): Record<string, string> {
  return {
    app: action.app,
    action: action.kind,
    reason: action.reason,
    ...(action.kind === "delete_volume"
      ? { volumeId: action.volumeId }
      : { machineId: action.machine.id }),
  };
}
