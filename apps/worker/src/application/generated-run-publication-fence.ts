import type { AcceptedRunConfigSnapshot } from "@checkout-surge/contracts";

export interface GeneratedRunPublicationFence {
  publish<T>(input: {
    runId: string;
    saleOfferId: string;
    operation: (snapshot: AcceptedRunConfigSnapshot) => Promise<T>;
  }): Promise<T>;
}
