import type { FlyMachine, FlyMachinesClient } from "@checkout-surge/fly-machines";

/** What the gate makes of the core Machine's Fly state, before probing the core itself. */
export type CoreMachineState = "started" | "booting" | "stopped" | "updating" | "unavailable";

/**
 * The authoritative core: among the Machines with `role=core` metadata that can serve, the started
 * one, else the newest. It is found through the app and that metadata, never a fixed Machine ID or
 * address. Several cores exist only during or after a recovery; one left on a dead host or with a
 * failed setup must not hide the core that can serve. A single core is kept whatever its state, so
 * its own page shows.
 */
export async function findCoreMachine(
  machines: Pick<FlyMachinesClient, "listMachines">,
): Promise<FlyMachine | undefined> {
  return selectCore(await machines.listMachines(), coreCanServe);
}

/**
 * The core rule of `findCoreMachine` over listed Machines. The guard narrows `canServe` further,
 * so the core it keeps is the one the gate would use.
 */
export function selectCore(
  machines: FlyMachine[],
  canServe: (machine: FlyMachine) => boolean,
): FlyMachine | undefined {
  const cores = machines
    .filter((machine) => machine.config.metadata?.role === "core")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const usable = cores.filter(canServe);
  const pool = usable.length > 0 ? usable : cores;
  return pool.find((machine) => machine.state === "started") ?? pool[0];
}

/** A core on a host that is down, or whose setup failed, cannot serve. */
export function coreCanServe(machine: FlyMachine): boolean {
  return !hostDown(machine) && !setupFailed(machine);
}

export function coreMachineState(machine: FlyMachine): CoreMachineState {
  // A core on a host that is down never answers; the start button lets a visitor recreate it.
  if (hostDown(machine)) return "stopped";
  switch (machine.state) {
    case "started":
      return "started";
    case "starting":
      return "booting";
    case "stopped":
    case "stopping":
      return "stopped";
    // A deploy is creating or replacing the Machine's config.
    case "created":
    case "replacing":
      return "updating";
    default:
      return "unavailable";
  }
}

/**
 * Whether setup (migrations and seed) exited non-zero since the Machine last started. Its
 * dependents then never start, while the Machine itself stays `started`.
 */
export function setupFailed(machine: FlyMachine): boolean {
  const startedAt = machine.events?.find((event) => event.type === "start")?.timestamp ?? 0;
  const setup = machine.containers?.find((container) => container.name === "setup");
  return (
    setup?.events?.some(
      (event) =>
        event.type === "exited" && (event.exit_code ?? 0) !== 0 && event.timestamp >= startedAt,
    ) ?? false
  );
}

/**
 * Whether the core's host is not `ok`. Fly then returns no full config and grants no usable lease,
 * so the core is recreated without either, as flyctl does (`internal/machine/lease.go`).
 */
export function hostDown(machine: FlyMachine): boolean {
  return machine.host_status !== "ok";
}

/**
 * Whether the core is marked for recreation (`recreate=requested` in the core Machine's metadata),
 * by an operator or by a deploy: the next wake then recreates the core instead of starting it.
 */
export function recreationRequested(machine: FlyMachine): boolean {
  return machine.config.metadata?.recreate === "requested";
}

/**
 * Whether the deploy marked the core because its host refused or reverted the update
 * (`recreate_reason=capacity`, set with the mark), rather than an operator asking for a fresh core.
 */
export function recreationForCapacity(machine: FlyMachine): boolean {
  return machine.config.metadata?.recreate_reason === "capacity";
}
