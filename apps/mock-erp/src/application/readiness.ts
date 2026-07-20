import type { ReadinessCheck } from "@checkout-surge/contracts";
import { createReadinessCheck } from "@checkout-surge/logger";

export const confirmationLedgerReadinessCheckName = "confirmation_ledger_reachable";

export interface ConfirmationLedgerReadinessProbe {
  check(signal: AbortSignal): Promise<void>;
}

export interface MockErpReadiness {
  checks(): Promise<ReadinessCheck[]>;
}

export function createMockErpReadiness(options: {
  ledgerProbe: ConfirmationLedgerReadinessProbe;
  timeoutMs: number;
}): MockErpReadiness {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Mock ERP readiness timeout must be a positive integer.");
  }

  return {
    checks: async () => [
      createReadinessCheck({ name: "confirmation_endpoint_ready", status: "ok" }),
      await checkConfirmationLedger(options.ledgerProbe, options.timeoutMs),
    ],
  };
}

async function checkConfirmationLedger(
  probe: ConfirmationLedgerReadinessProbe,
  timeoutMs: number,
): Promise<ReadinessCheck> {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  deadline.unref();

  try {
    await settleWithAbort(probe.check(controller.signal), controller.signal);
    return createReadinessCheck({ name: confirmationLedgerReadinessCheckName, status: "ok" });
  } catch {
    return createReadinessCheck({
      name: confirmationLedgerReadinessCheckName,
      status: "unavailable",
      message: timedOut
        ? `Confirmation ledger readiness check exceeded the ${timeoutMs}ms deadline.`
        : "Confirmation ledger is unavailable.",
    });
  } finally {
    clearTimeout(deadline);
  }
}

function settleWithAbort(operation: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
