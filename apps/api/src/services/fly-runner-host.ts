import {
  classifyFlyError,
  classifyFlyMachine,
  type FlyFailureClass,
  type FlyMachine,
  type FlyMachineConfig,
  FlyMachinesApiError,
  type FlyMachinesClient,
} from "@checkout-surge/fly-machines";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { ApiHttpError } from "../runtime/errors.js";
import {
  RunnerCapacityUnavailableError,
  type RunnerHost,
  type RunnerPlacement,
  type RunnerStartHooks,
  type RunnerStopTarget,
} from "./runner-host.js";
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
  | "createMachine"
  | "destroyMachine"
  | "updateMachine"
  | "startMachine"
  | "stopMachine"
  | "waitForState"
  | "acquireLease"
  | "releaseLease"
>;

// The TTL covers measured operations (3 to 8 s) with a wide margin, so the lease is never renewed.
// It covers a start, which its deadline bounds (RunnerOperations), plus one call in flight past
// it. The only other lease party is the deploy script.
const leaseTtlSeconds = 300;
const busyRetryWindowMs = 30_000;
const busyRetryIntervalMs = 1_000;
const shutdownWaitSeconds = 30;
const machineWaitSeconds = 60;
// Three start attempts in place, with back-off between them, before the runner is recreated.
const startRetryDelaysMs = [1_000, 3_000];
const retriedStartFailures = new Set<FlyFailureClass>([
  "provider_capacity",
  "host_unreachable",
  "transient",
]);
const relocatingFailures = new Set<FlyFailureClass>(["provider_capacity", "host_unreachable"]);
/**
 * Where a recreated runner may go after the core's own region
 * (HD-36, docs/decisions/hosted_deployment.md).
 */
const fallbackRegion = "eu";

/** One start: its deadline, and whether it has met a capacity shortage so far. */
interface StartAttempt {
  /** Milliseconds since the epoch. */
  deadlineAt: number;
  capacityShortage: boolean;
}

/**
 * The runner as one Fly Machine with no volume, stopped between runs. Each operation holds the
 * Machine lease, which coordinates with the deploy script, except on a host that is not ok, where
 * Fly grants no usable lease.
 */
export class FlyRunnerHost implements RunnerHost {
  constructor(
    private readonly options: {
      machines: FlyRunnerMachines;
      control: Pick<RunnerControlGateway, "readIdentity" | "shutdown">;
      size: RunnerMachineSize;
      /** The core's address for the runner's metrics and completion reports. */
      apiBaseUrl: string;
      /** The core's current region, where a recreated runner goes first. */
      coreRegion: string;
      /**
       * The runner config the deploy script last sent, which a recreated runner is built from: Fly
       * returns no full config for a Machine on a host that is not ok.
       */
      readDeployedConfig: () => Promise<FlyMachineConfig>;
      logger: Pick<CheckoutSurgeLogger, "info" | "warn" | "error">;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {}

  /**
   * Starts the runner where it is, retrying with back-off. When the provider still has no
   * capacity, or the host is unreachable, the runner is recreated elsewhere; a host that refuses
   * the run's settings recreates it at once. A runner outside the core's region, because the core
   * was relocated, is recreated to follow it.
   *
   * Past `deadlineAt`, no further step begins and Fly waits end: the start fails, as a capacity
   * failure when it met a shortage. A recreated runner that did not start is destroyed; a runner
   * started in place is stopped by the caller's cleanup of a failed boot.
   */
  start(runId: string, hooks: RunnerStartHooks, deadlineAt: number): Promise<RunnerPlacement> {
    const attempt: StartAttempt = { deadlineAt, capacityShortage: false };
    return this.withLease("runner start", async (machine, nonce) => {
      // Without a lease, the host is not ok: the runner is recreated at once.
      if (nonce) {
        if (machine.state !== "stopped") {
          // No other run is in flight, so a running runner is stale: it never serves this run,
          // even when it is about to be replaced.
          const identity = await this.options.control.readIdentity().catch(() => null);
          await this.stopMachine(machine, nonce, { runId, bootId: identity?.bootId ?? null }, true);
        }
        if (
          machine.region === this.options.coreRegion &&
          (await this.startInPlace(machine, nonce, attempt)) === "started"
        ) {
          return { machineId: machine.id, region: machine.region };
        }
      }
      this.requireTimeLeft(attempt);
      await hooks.onRelocating();
      return this.replace(machine, nonce, attempt);
    });
  }

  stop(target: RunnerStopTarget): Promise<void> {
    return this.withLease("runner stop", async (machine, nonce) => {
      if (!nonce) {
        // A stop could hang on a dead host; the next start recreates the runner instead.
        this.options.logger.warn({ ...target }, "The runner's host is not ok; not stopping it.");
        return;
      }
      await this.stopMachine(machine, nonce, target, false);
    });
  }

  async isStopped(): Promise<boolean> {
    return (await this.findRunnerMachine()).state === "stopped";
  }

  async isLost(): Promise<boolean> {
    const machine = await this.findRunnerMachine();
    return machine.state === "stopped" || classifyFlyMachine(machine) === "host_unreachable";
  }

  /** Replaces the stopped runner with a fresh one, left stopped. Refused while it runs. */
  recreate(): Promise<RunnerPlacement> {
    return this.withLease("runner recreate", async (machine, nonce) => {
      if (machine.state !== "stopped") {
        throw new ApiHttpError({
          statusCode: 409,
          code: "run_conflict",
          message: "The load generator is running; recreate it between runs.",
        });
      }
      const placement = await this.replace(machine, nonce, {
        deadlineAt: Number.POSITIVE_INFINITY,
        capacityShortage: false,
      });
      if (placement.machineId) {
        await this.options.machines.stopMachine(placement.machineId);
        await this.requireState(placement.machineId, "stopped");
      }
      return placement;
    });
  }

  /**
   * Brings the stopped Machine up in place. Returns "relocate" when its host refuses the run's
   * settings, or still has no capacity or is unreachable once the retries are spent; throws any
   * other failure.
   */
  private async startInPlace(
    machine: FlyMachine,
    nonce: string,
    attempt: StartAttempt,
  ): Promise<"started" | "relocate"> {
    this.requireTimeLeft(attempt);
    if (
      !this.hasRunSettings(machine.config) &&
      !(await this.applyRunSettings(machine, nonce, attempt))
    ) {
      return "relocate";
    }
    this.requireTimeLeft(attempt);
    for (let tries = 0; ; tries += 1) {
      try {
        await this.options.machines.startMachine(machine.id, nonce);
        break;
      } catch (error) {
        const failure = classifyFlyError(error);
        this.options.logger.warn(
          { err: error, failure, attempt: tries + 1 },
          "The runner Machine did not start.",
        );
        if (failure === "provider_capacity") attempt.capacityShortage = true;
        const delayMs = startRetryDelaysMs[tries];
        if (!retriedStartFailures.has(failure)) throw error;
        if (delayMs === undefined) {
          if (relocatingFailures.has(failure)) return "relocate";
          throw error;
        }
        this.requireTimeLeft(attempt, delayMs);
        await this.sleep(delayMs);
      }
    }
    // Accepted risk HD-19 (docs/decisions/hosted_deployment.md)
    // (a failed wait fails the run before any traffic; the next start heals the runner).
    await this.requireState(machine.id, "started", attempt);
    return "started";
  }

  /**
   * Updates the stopped Machine to the run's size and API address. Returns false when its host
   * refuses them for capacity or is dead, either at once or by reverting the update; the runner is
   * then recreated without retrying in place. Throws any other failure.
   */
  private async applyRunSettings(
    machine: FlyMachine,
    nonce: string,
    attempt: StartAttempt,
  ): Promise<boolean> {
    let updated: FlyMachine;
    try {
      updated = await this.options.machines.updateMachine(
        machine.id,
        this.withRunSettings(machine.config),
        nonce,
      );
    } catch (error) {
      const failure = classifyFlyError(error);
      if (!relocatingFailures.has(failure)) throw error;
      if (failure === "provider_capacity") attempt.capacityShortage = true;
      this.options.logger.warn({ err: error }, "The runner's host refused the run's settings.");
      return false;
    }
    try {
      await this.requireState(machine.id, "stopped", attempt, updated.instance_id);
    } catch (error) {
      const failure = classifyFlyMachine(await this.options.machines.getMachine(machine.id));
      if (failure === null || !relocatingFailures.has(failure)) throw error;
      if (failure === "provider_capacity") attempt.capacityShortage = true;
      this.options.logger.warn(
        { err: error, failure },
        "The runner's host reverted the run's settings.",
      );
      return false;
    }
    // The wait can also succeed on the reverted Machine, so the settings are read back.
    if (this.hasRunSettings((await this.options.machines.getMachine(machine.id)).config)) {
      return true;
    }
    attempt.capacityShortage = true;
    this.options.logger.warn("The runner's host reverted the run's settings.");
    return false;
  }

  /**
   * Creates a fresh runner from the deployed config, in the core's region or else in Europe,
   * waits for it to start, then retires the old one. The old one stays when no new one starts.
   */
  private async replace(
    old: FlyMachine,
    nonce: string | undefined,
    attempt: StartAttempt,
  ): Promise<RunnerPlacement> {
    const config = this.withRunSettings(await this.options.readDeployedConfig());
    this.requireTimeLeft(attempt);
    let created: FlyMachine;
    try {
      created = await this.options.machines.createMachine(
        config,
        `${this.options.coreRegion},${fallbackRegion}`,
      );
    } catch (error) {
      if (classifyFlyError(error) === "provider_capacity") {
        this.options.logger.error({ err: error }, "No capacity to recreate the runner.");
        throw new RunnerCapacityUnavailableError();
      }
      throw error;
    }
    try {
      await this.requireState(created.id, "started", attempt);
    } catch (error) {
      await this.options.machines.destroyMachine(created.id).catch((destroyError: unknown) => {
        this.options.logger.error(
          { err: destroyError, machineId: created.id },
          "Could not destroy a recreated runner that did not start.",
        );
      });
      throw error;
    }
    await this.options.machines.destroyMachine(old.id, nonce).catch((error: unknown) => {
      // Already gone, as Fly's own tooling counts it on a dead host.
      if (error instanceof FlyMachinesApiError && error.status === 404) return;
      // Two runner Machines now exist; the newest is used and the guard removes the old one.
      this.options.logger.error(
        { err: error, machineId: old.id },
        "Could not destroy the replaced runner Machine.",
      );
    });
    this.options.logger.warn(
      { oldMachineId: old.id, machineId: created.id, region: created.region },
      "Recreated the runner Machine.",
    );
    return { machineId: created.id, region: created.region };
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

  /**
   * Fails the start when its deadline has passed, or would pass within `neededMs`: as a capacity
   * failure when it met a shortage, otherwise as a start that ran out of time.
   */
  private requireTimeLeft(attempt: StartAttempt, neededMs = 0): void {
    if (this.now() + neededMs < attempt.deadlineAt) return;
    this.options.logger.warn(
      { capacityShortage: attempt.capacityShortage },
      "The runner start ran out of time.",
    );
    if (attempt.capacityShortage) throw new RunnerCapacityUnavailableError();
    throw new Error("The runner did not start before its deadline.");
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

  /** Whether the config already has the size and API address the next run needs. */
  private hasRunSettings(config: FlyMachineConfig): boolean {
    const { size, apiBaseUrl } = this.options;
    return (
      config.guest.cpu_kind === size.cpuKind &&
      config.guest.cpus === size.cpus &&
      config.guest.memory_mb === size.memoryMb &&
      config.env?.API_BASE_URL === apiBaseUrl
    );
  }

  private withRunSettings(config: FlyMachineConfig): FlyMachineConfig {
    const { size, apiBaseUrl } = this.options;
    return {
      ...config,
      guest: { ...config.guest, cpu_kind: size.cpuKind, cpus: size.cpus, memory_mb: size.memoryMb },
      env: { ...config.env, API_BASE_URL: apiBaseUrl },
    };
  }

  /**
   * Runs `operation` under the runner's lease. On a host that is not ok, Fly grants no usable lease
   * (flyctl skips leasing such Machines), so `operation` runs without one and gets no nonce.
   */
  private async withLease<T>(
    description: string,
    operation: (machine: FlyMachine, nonce: string | undefined) => Promise<T>,
  ): Promise<T> {
    const machine = await this.findRunnerMachine();
    if (machine.host_status !== "ok") {
      this.options.logger.warn(
        { machineId: machine.id, hostStatus: machine.host_status },
        "The runner's host is not ok; acting without its lease.",
      );
      return operation(machine, undefined);
    }
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
        // A recreation destroys the leased Machine, and its lease with it.
        if (error instanceof FlyMachinesApiError && error.status === 404) return;
        this.options.logger.warn({ err: error }, "Could not release the runner Machine lease.");
      });
    }
  }

  /**
   * The runner is the newest Machine with `role=runner` metadata, never a fixed ID. Several exist
   * only after a failed retirement or a lost create response; the guard removes the older ones.
   */
  private async findRunnerMachine(): Promise<FlyMachine> {
    const runners = (await this.options.machines.listMachines())
      .filter((machine) => machine.config.metadata?.role === "runner")
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
    const [runner] = runners;
    if (!runner) throw new Error("Expected a runner Machine, found none.");
    if (runners.length > 1) {
      this.options.logger.warn(
        { machineIds: runners.map((machine) => machine.id) },
        "Several runner Machines exist; using the newest.",
      );
    }
    return runner;
  }

  /** Waits for `state`, at most until the start's deadline when one is given. */
  private async requireState(
    machineId: string,
    state: "started" | "stopped",
    attempt?: StartAttempt,
    instanceId?: string,
  ): Promise<void> {
    const timeoutSeconds = attempt
      ? Math.max(
          1,
          Math.min(machineWaitSeconds, Math.ceil((attempt.deadlineAt - this.now()) / 1000)),
        )
      : machineWaitSeconds;
    const reached = await this.options.machines.waitForState(machineId, state, {
      timeoutSeconds,
      ...(instanceId ? { instanceId } : {}),
    });
    if (!reached) {
      // A wait cut by the deadline fails as the start's deadline does.
      if (attempt) this.requireTimeLeft(attempt);
      throw new Error(`The runner Machine did not reach ${state} within ${timeoutSeconds}s.`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }
}
