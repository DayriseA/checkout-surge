import type { RunExecutionMode } from "@checkout-surge/contracts";
import { type CheckoutSurgeDatabase, demoRunSaleContexts, demoRuns } from "@checkout-surge/db";
import { and, eq, inArray } from "drizzle-orm";
import type { ReserveOrderService } from "./reserve-order-service.js";

export interface BuyingRunContext {
  runId: string;
  saleOfferId: string;
  executionMode: RunExecutionMode;
}

export interface BuyingRunContextReader {
  readCurrent(): Promise<BuyingRunContext | null>;
}

export class PostgresBuyingRunContextReader implements BuyingRunContextReader {
  constructor(private readonly db: CheckoutSurgeDatabase) {}

  async readCurrent(): Promise<BuyingRunContext | null> {
    const [run] = await this.db
      .select({
        runId: demoRuns.id,
        saleOfferId: demoRunSaleContexts.saleOfferId,
        executionMode: demoRuns.executionMode,
      })
      .from(demoRuns)
      .innerJoin(
        demoRunSaleContexts,
        and(
          eq(demoRunSaleContexts.runId, demoRuns.id),
          eq(demoRunSaleContexts.saleOfferId, demoRuns.saleOfferId),
        ),
      )
      .where(inArray(demoRuns.status, ["starting", "active", "draining"]))
      .limit(1);
    return run ?? null;
  }
}

/** One authoritative generated-run slot; request IDs never trigger database reads. */
export class ActiveBuyingRunContext {
  private current: BuyingRunContext | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      reader: BuyingRunContextReader;
      services: Partial<Record<RunExecutionMode, Pick<ReserveOrderService, "reserve">>> & {
        demo: Pick<ReserveOrderService, "reserve">;
      };
    },
  ) {}

  hydrate(): Promise<void> {
    return this.install();
  }
  activate(runId: string): Promise<void> {
    return this.install(runId);
  }

  reserve(input: Parameters<ReserveOrderService["reserve"]>[0]) {
    const current = this.current;
    const mode =
      current?.runId === input.request.runId && current.saleOfferId === input.request.saleOfferId
        ? current.executionMode
        : "demo";
    // Unmatched requests retain Redis's existing missing/closed inventory vocabulary.
    const service = this.options.services[mode];
    if (!service) throw new Error("Buyer execution mode is not supported.");
    return service.reserve(input);
  }

  private install(runId?: string): Promise<void> {
    const operation = this.pending
      .catch(() => undefined)
      .then(async () => {
        const context = await this.options.reader.readCurrent();
        if (runId !== undefined && context?.runId !== runId) {
          throw new Error("Buyer activation requires the current generated run.");
        }
        this.current = context;
        if (context && !this.options.services[context.executionMode]) {
          throw new Error("Buyer execution mode is not supported.");
        }
      });
    this.pending = operation;
    return operation;
  }
}
