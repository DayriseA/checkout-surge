import type { FlyMachine, FlyMachinesClient } from "@checkout-surge/fly-machines";

/** What the gate makes of the core Machine's Fly state, before probing the core itself. */
export type CoreMachineState = "started" | "booting" | "stopped" | "updating" | "unavailable";

/**
 * The authoritative core: the started Machine with `role=core` metadata, else the newest one.
 * It is found through the app and that metadata, never a fixed Machine ID or address.
 */
export async function findCoreMachine(
  machines: Pick<FlyMachinesClient, "listMachines">,
): Promise<FlyMachine | undefined> {
  const cores = (await machines.listMachines())
    .filter((machine) => machine.config.metadata?.role === "core")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  return cores.find((machine) => machine.state === "started") ?? cores[0];
}

export function coreMachineState(machine: FlyMachine): CoreMachineState {
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
