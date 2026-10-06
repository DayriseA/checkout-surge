import { type FlyMachine, FlyMachinesApiError } from "./client.js";

/**
 * Best-effort classification of Fly failures (HD-16, docs/decisions/hosted_deployment.md). Fly
 * has no error contract, so the signals below are maintained over time. It holds no business
 * rule: callers decide whether to retry, recreate or give up.
 */
export type FlyFailureClass =
  | "provider_capacity"
  | "host_unreachable"
  | "transient"
  | "conflict"
  | "unclassified_provider_error"
  | "own_error";

const capacityStatuses = new Set(["insufficient_capacity", "volume_placement_capacity"]);

const capacityPhrases = [
  "insufficient cpus available",
  "insufficient memory available",
  "insufficient ips available",
  "insufficient resources available",
  "could not reserve resource for machine",
  "governor policy blocked start",
  "deploys to this host are temporarily disabled",
];

/** Classifies a failed Machines API call. Anything that is not an API answer is unclassified. */
export function classifyFlyError(error: unknown): FlyFailureClass {
  if (!(error instanceof FlyMachinesApiError)) return "unclassified_provider_error";
  const body = parseBody(error.body);
  if (capacityStatuses.has(body.status ?? "")) return "provider_capacity";
  if (error.status === 409 && hasCapacityPhrase(body.message)) return "provider_capacity";
  if (error.status === 408 || body.hostStatus === "unreachable") return "host_unreachable";
  if (error.status === 429 || error.status >= 500) return "transient";
  if (error.status === 409) return "conflict";
  if (error.status >= 400 && error.status < 500) return "own_error";
  return "unclassified_provider_error";
}

/**
 * Classifies the state Fly reports for a Machine: a dead host, or a non-zero exit that nobody
 * requested. Null when neither applies.
 */
export function classifyFlyMachine(
  machine: Pick<FlyMachine, "host_status" | "events">,
): FlyFailureClass | null {
  if (machine.host_status === "unreachable") return "host_unreachable";
  const [latest] = machine.events ?? [];
  const exit = latest?.type === "exit" ? latest.request?.exit_event : undefined;
  if (exit?.exit_code && !exit.requested_stop) return "own_error";
  return null;
}

function hasCapacityPhrase(message: string): boolean {
  const text = message.trim().toLowerCase();
  return capacityPhrases.some((phrase) => text.includes(phrase)) || text.endsWith("no capacity");
}

function parseBody(text: string): { status?: string; hostStatus?: string; message: string } {
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object") {
      const { status, host_status: hostStatus, error } = body as Record<string, unknown>;
      return {
        ...(typeof status === "string" ? { status } : {}),
        ...(typeof hostStatus === "string" ? { hostStatus } : {}),
        message: typeof error === "string" ? error : text,
      };
    }
  } catch {
    // A plain-text body is matched as is.
  }
  return { message: text };
}
