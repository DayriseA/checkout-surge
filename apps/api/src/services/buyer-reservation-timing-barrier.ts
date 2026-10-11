import {
  controlServiceTokenHeaderName,
  emptyServerReservationTimingSummary,
} from "@checkout-surge/contracts";
import type { CheckoutSurgeLogger } from "@checkout-surge/logger";
import { buyerTimingFlushPath, buyerTimingFlushResponseSchema } from "./api-peer-protocol.js";
import type { ReservationTimingLifecycle } from "./reservation-timing-observation.js";

/** Fixed buyer peers must retain their boot and flush before control fences timings. */
export class BuyerReservationTimingBarrier implements ReservationTimingLifecycle {
  // Only one run can be nonterminal. A new acceptance retires the previous run's
  // advisory state, including a run that failed before traffic started.
  private currentRun:
    | {
        runId: string;
        baseline?: Array<{ bootId: string; mergeFailureGeneration: number }>;
        complete: boolean;
        lostEvidence: boolean;
      }
    | undefined;

  constructor(
    private readonly options: {
      buyerBaseUrls: string[];
      controlServiceToken: string;
      local: ReservationTimingLifecycle;
      logger: Pick<CheckoutSurgeLogger, "warn">;
    },
  ) {}

  async captureBaseline(runId: string): Promise<void> {
    const currentRun: NonNullable<typeof this.currentRun> = {
      runId,
      complete: false,
      lostEvidence: false,
    };
    this.currentRun = currentRun;
    const peers = await this.flushPeers(runId, true);
    if (peers.every((peer) => peer.timingAvailable !== false)) {
      currentRun.baseline = peers;
    } else {
      this.options.logger.warn(
        { runId },
        "Buyer timing baseline unavailable; terminal timings will be unknown.",
      );
    }
  }

  async activate(runId: string): Promise<void> {
    await this.flushPeers(runId, true);
  }

  async prepare(runId: string): Promise<void> {
    const currentRun = this.currentRun;
    if (currentRun?.runId !== runId) return;
    let complete = false;
    try {
      const baseline = currentRun.baseline;
      const peers = await this.flushPeers(runId);
      complete =
        baseline !== undefined &&
        peers.every(
          (peer, index) =>
            peer.bootId === baseline[index]?.bootId &&
            peer.mergeFailureGeneration === baseline[index]?.mergeFailureGeneration,
        );
      // An older concurrent flush must not undo observed boot or merge loss.
      if (baseline !== undefined && !complete) currentRun.lostEvidence = true;
    } catch (error) {
      this.options.logger.warn({ err: error, runId }, "Buyer reservation timing flush failed.");
    }
    currentRun.complete = complete && !currentRun.lostEvidence;
  }

  async readAndFence(runId: string) {
    const summary = await this.options.local.readAndFence(runId);
    const complete = this.currentRun?.runId === runId && this.currentRun.complete;
    if (complete) return summary;
    this.options.logger.warn(
      { runId },
      "Buyer timing evidence is incomplete; terminal timings are unknown.",
    );
    return emptyServerReservationTimingSummary;
  }

  async clearRun(runId: string): Promise<void> {
    if (this.currentRun?.runId === runId) this.currentRun = undefined;
    await this.options.local.clearRun(runId);
  }

  private flushPeers(runId: string, activate = false) {
    return Promise.all(
      this.options.buyerBaseUrls.map(async (baseUrl) => {
        const response = await fetch(new URL(buyerTimingFlushPath, baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [controlServiceTokenHeaderName]: this.options.controlServiceToken,
          },
          body: JSON.stringify({ runId, ...(activate ? { activate: true } : {}) }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) throw new Error(`Buyer timing flush returned HTTP ${response.status}.`);
        const result = buyerTimingFlushResponseSchema.parse(await response.json());
        if (activate && result.activatedRunId !== runId) {
          throw new Error("Buyer did not acknowledge run activation.");
        }
        return result;
      }),
    );
  }
}
