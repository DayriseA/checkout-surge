import type { IncomingMessage, ServerResponse } from "node:http";

export class OperationDeadlineExceededError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Operation exceeded its ${timeoutMs}ms deadline.`);
    this.name = "OperationDeadlineExceededError";
  }
}

export class ClientDisconnectedError extends Error {
  constructor() {
    super("The client disconnected before the operation completed.");
    this.name = "ClientDisconnectedError";
  }
}

export interface OperationLifecycle {
  signal: AbortSignal;
  dispose(): void;
}

export function createHttpOperationLifecycle(input: {
  request: IncomingMessage;
  response: ServerResponse;
  timeoutMs: number;
}): OperationLifecycle {
  const controller = new AbortController();
  const abortForDisconnect = () => {
    if (!controller.signal.aborted) controller.abort(new ClientDisconnectedError());
  };
  const deadline = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new OperationDeadlineExceededError(input.timeoutMs));
    }
  }, input.timeoutMs);
  deadline.unref();

  input.request.once("aborted", abortForDisconnect);
  input.response.once("close", abortForDisconnect);

  if (input.request.aborted || input.response.destroyed) abortForDisconnect();

  let disposed = false;
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(deadline);
      input.request.off("aborted", abortForDisconnect);
      input.response.off("close", abortForDisconnect);
    },
  };
}

/**
 * Makes an operation settle with its abort reason even when a test double or
 * third-party dependency does not observe AbortSignal itself. Real adapters
 * must still cancel their underlying work when the signal aborts.
 */
export async function settleWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Operation aborted.");
}
