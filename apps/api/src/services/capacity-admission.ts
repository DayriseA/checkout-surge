import {
  type AcceptedRunConfigSnapshot,
  type CapacityAssessment,
  type CapacityVerdict,
  capacityAssessmentSchema,
  type DeploymentHardCaps,
  k6GracefulStopSeconds,
  k6RequestTimeoutSeconds,
} from "@checkout-surge/contracts";
import { z } from "zod";
import { DemoRunValidationError } from "./demo-run-validation-error.js";

/**
 * A deployment's measured capacity per connection mode (docs/capacity_measurement.md), set in
 * the API environment. Accepted orders are never answered faster than sold-out requests, which
 * keeps every setting's effect on the model monotonic.
 */
export const deploymentCapacitySchema = z
  .object({
    /** C_s: sold-out answers per second over reused connections. */
    constantArrivalSoldOutPerSecond: z.number().positive(),
    /** C_a: accepted orders the database pool answers per second, constant arrival. */
    constantArrivalAcceptedPerSecond: z.number().positive(),
    /** k: what an accepted order costs the API, in sold-out answers, constant arrival. */
    constantArrivalAcceptedOrderCost: z.number().min(1),
    /** C′_s: sold-out buyers answered per second, one new connection each. */
    buyerSpikeSoldOutPerSecond: z.number().positive(),
    /** C′_a: accepted buyers answered per second. */
    buyerSpikeAcceptedPerSecond: z.number().positive(),
    /** Seconds one constant-arrival virtual user is busy per request: VUs = rate × budget. */
    vuLatencyBudgetSeconds: z.number().positive(),
  })
  .strict()
  .refine(
    (capacity) =>
      capacity.constantArrivalAcceptedPerSecond <= capacity.constantArrivalSoldOutPerSecond &&
      capacity.buyerSpikeAcceptedPerSecond <= capacity.buyerSpikeSoldOutPerSecond,
    "Accepted orders per second must not exceed sold-out answers per second.",
  );
export type DeploymentCapacity = z.infer<typeof deploymentCapacitySchema>;

/** Measured on a 4 vCPU cloud VM running the whole local stack. */
export const localDeploymentCapacity: DeploymentCapacity = {
  constantArrivalSoldOutPerSecond: 3_000,
  constantArrivalAcceptedPerSecond: 195,
  constantArrivalAcceptedOrderCost: 15,
  buyerSpikeSoldOutPerSecond: 1_150,
  buyerSpikeAcceptedPerSecond: 155,
  vuLatencyBudgetSeconds: 3,
};

/** Up to this share of the capacity, a run is expected to complete; up to all of it, at the limit. */
const completionShare = 0.8;
/** Constant-arrival capacity was measured with runs this long; accepted orders arrive first. */
const measuredConstantArrivalSeconds = 10;

/**
 * Pre-allocates every virtual user a constant-arrival run without explicit VUs needs, within the
 * deployment's VU caps. Applied after validation, so the public VU limits bind explicit VUs only.
 */
export function withResolvedConstantArrivalVus(
  snapshot: AcceptedRunConfigSnapshot,
  vuLatencyBudgetSeconds: number,
  caps: Pick<DeploymentHardCaps, "maxPreAllocatedVus" | "maxVus">,
): AcceptedRunConfigSnapshot {
  const traffic = snapshot.trafficConfig;
  if (traffic.mode !== "constant-arrival-rate" || traffic.k6Vus) return snapshot;
  const vus = automaticConstantArrivalVus(traffic.ratePerSecond, vuLatencyBudgetSeconds, caps);
  return {
    ...snapshot,
    trafficConfig: { ...traffic, k6Vus: { preAllocatedVus: vus, maxVus: vus } },
  };
}

/** The VUs, pre-allocated and maximum alike, a run at this rate gets without explicit VUs. */
export function automaticConstantArrivalVus(
  ratePerSecond: number,
  vuLatencyBudgetSeconds: number,
  caps: Pick<DeploymentHardCaps, "maxPreAllocatedVus" | "maxVus">,
): number {
  return Math.min(
    Math.ceil(ratePerSecond * vuLatencyBudgetSeconds),
    caps.maxPreAllocatedVus,
    caps.maxVus,
  );
}

export function assessCapacity(
  snapshot: AcceptedRunConfigSnapshot,
  capacity: DeploymentCapacity,
  /**
   * Whether the run would still be admitted with this safety cutoff. Only checked on the smallest
   * cutoff expected to complete: the duration estimate rises with the cutoff and the duration
   * limits are upper bounds, so if that cutoff is refused, every larger one is too.
   */
  admitsCutoff: (cutoffSeconds: number) => boolean,
): CapacityAssessment {
  const traffic = snapshot.trafficConfig;
  const unitsPerOrder = traffic.quantityPerAttempt;
  const stockOrders = Math.floor(snapshot.inventoryConfig.startingStock / unitsPerOrder);
  const largestStock = (orders: number | null) =>
    orders === null ? null : (orders + 1) * unitsPerOrder - 1;

  if (traffic.mode === "constant-arrival-rate") {
    const { ratePerSecond: rate, durationSeconds } = traffic;
    const run = constantArrivalRun(rate, durationSeconds, stockOrders, capacity);
    return capacityAssessmentSchema.parse({
      mode: traffic.mode,
      verdict: run.verdict,
      ratePerSecond: rate,
      durationSeconds,
      startingStock: snapshot.inventoryConfig.startingStock,
      acceptedOrders: run.acceptedOrders,
      loadPerSecond: run.loadPerSecond,
      capacityPerSecond: capacity.constantArrivalSoldOutPerSecond,
      poolOrderLimit: run.poolOrderLimit,
      ...(run.verdict === "expected_to_complete"
        ? {}
        : {
            fit: {
              ratePerSecond: largestCompleting(
                1,
                Math.ceil(capacity.constantArrivalSoldOutPerSecond),
                (candidate) =>
                  constantArrivalRun(candidate, durationSeconds, stockOrders, capacity).verdict,
              ),
              startingStock: largestStock(
                largestCompleting(
                  0,
                  run.acceptedOrders - 1,
                  (orders) => constantArrivalRun(rate, durationSeconds, orders, capacity).verdict,
                ),
              ),
            },
          }),
    });
  }

  const { buyerCount, maxDurationSeconds } = traffic;
  const requestsPerBuyer = traffic.duplicateEachBuyerAttempt ? 2 : 1;
  const spike = (buyers: number, orders: number, cutoffSeconds: number) =>
    buyerSpikeRun(buyers, requestsPerBuyer, orders, cutoffSeconds, capacity);
  const run = spike(buyerCount, stockOrders, maxDurationSeconds);
  const admittedCutoff = (cutoffSeconds: number | null) =>
    cutoffSeconds !== null && admitsCutoff(cutoffSeconds) ? cutoffSeconds : null;
  return capacityAssessmentSchema.parse({
    mode: traffic.mode,
    verdict: run.verdict,
    buyerCount,
    startingStock: snapshot.inventoryConfig.startingStock,
    acceptedOrders: run.acceptedOrders,
    timeToServeSeconds: run.timeToServeSeconds,
    windowSeconds: run.windowSeconds,
    ...(run.verdict === "expected_to_complete"
      ? {}
      : {
          fit: {
            buyerCount: largestCompleting(
              1,
              Math.ceil(k6RequestTimeoutSeconds * capacity.buyerSpikeSoldOutPerSecond),
              (buyers) => spike(buyers, stockOrders, maxDurationSeconds).verdict,
            ),
            startingStock: largestStock(
              largestCompleting(
                0,
                run.acceptedOrders - 1,
                (orders) => spike(buyerCount, orders, maxDurationSeconds).verdict,
              ),
            ),
            maxDurationSeconds: admittedCutoff(
              smallestCompletingCutoff(
                (cutoffSeconds) => spike(buyerCount, stockOrders, cutoffSeconds).verdict,
              ),
            ),
          },
        }),
  });
}

/** Public custom runs are admitted only when expected to complete; admin runs only get a warning. */
export function requireCapacityAdmission(assessment: CapacityAssessment): void {
  if (assessment.verdict === "expected_to_complete") return;
  throw new DemoRunValidationError(
    "estimated_capacity_rejected",
    "The run is not expected to complete within this deployment's capacity.",
    assessment,
  );
}

function constantArrivalRun(
  rate: number,
  durationSeconds: number,
  stockOrders: number,
  capacity: DeploymentCapacity,
) {
  const acceptedOrders = Math.min(stockOrders, rate * durationSeconds);
  const loadPerSecond =
    rate +
    ((capacity.constantArrivalAcceptedOrderCost - 1) * acceptedOrders) /
      Math.min(durationSeconds, measuredConstantArrivalSeconds);
  // Orders the pool has not answered by the end of k6's graceful stop are interrupted.
  const poolOrderLimit =
    capacity.constantArrivalAcceptedPerSecond * (durationSeconds + k6GracefulStopSeconds);
  return {
    acceptedOrders,
    loadPerSecond,
    poolOrderLimit,
    verdict:
      acceptedOrders > poolOrderLimit
        ? ("expected_to_fail" as const)
        : classify(loadPerSecond / capacity.constantArrivalSoldOutPerSecond),
  };
}

function buyerSpikeRun(
  buyers: number,
  requestsPerBuyer: number,
  stockOrders: number,
  cutoffSeconds: number,
  capacity: DeploymentCapacity,
) {
  // Duplicate attempts share an idempotency key, so only one per buyer can be accepted.
  const acceptedOrders = Math.min(stockOrders, buyers);
  const timeToServeSeconds =
    acceptedOrders / capacity.buyerSpikeAcceptedPerSecond +
    (buyers * requestsPerBuyer - acceptedOrders) / capacity.buyerSpikeSoldOutPerSecond;
  // k6's graceful stop after the cutoff is left as a reserve: the model can be optimistic.
  const windowSeconds = Math.min(cutoffSeconds, k6RequestTimeoutSeconds);
  return {
    acceptedOrders,
    timeToServeSeconds,
    windowSeconds,
    verdict: classify(timeToServeSeconds / windowSeconds),
  };
}

function classify(shareOfCapacity: number): CapacityVerdict {
  if (shareOfCapacity <= completionShare) return "expected_to_complete";
  return shareOfCapacity <= 1 ? "at_the_limit" : "expected_to_fail";
}

/** Largest value in [low, high] expected to complete, for a verdict that worsens as it grows. */
function largestCompleting(
  low: number,
  high: number,
  verdictAt: (value: number) => CapacityVerdict,
): number | null {
  if (high < low || verdictAt(low) !== "expected_to_complete") return null;
  let completing = low;
  let failing = high + 1;
  while (failing - completing > 1) {
    const middle = Math.floor((completing + failing) / 2);
    if (verdictAt(middle) === "expected_to_complete") completing = middle;
    else failing = middle;
  }
  return completing;
}

function smallestCompletingCutoff(verdictAt: (cutoffSeconds: number) => CapacityVerdict) {
  for (let cutoffSeconds = 1; cutoffSeconds <= k6RequestTimeoutSeconds; cutoffSeconds += 1) {
    if (verdictAt(cutoffSeconds) === "expected_to_complete") return cutoffSeconds;
  }
  return null;
}
