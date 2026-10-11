import type { ActiveBuyingRunContext } from "./active-buying-run-context.js";

/** Required context installation and advisory timing have different failure policies. */
export async function prepareBuyerRun(options: {
  context: Pick<ActiveBuyingRunContext, "activate">;
  runId: string;
  bootId: string;
  flush(runId: string): Promise<{ bootId: string; mergeFailureGeneration: number }>;
}) {
  await options.context.activate(options.runId);
  try {
    return {
      ...(await options.flush(options.runId)),
      activatedRunId: options.runId,
      timingAvailable: true,
    };
  } catch {
    return {
      bootId: options.bootId,
      mergeFailureGeneration: 0,
      activatedRunId: options.runId,
      timingAvailable: false,
    };
  }
}
